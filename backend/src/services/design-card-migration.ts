/**
 * 一次性启动迁移（Issue #57，契约 §7）：`storyboards.intent` → `combo` + `design_card`。
 *
 * 幂等：`intent` 列已经不存在就直接返回。转换完成后在**同一函数内**
 * `DROP COLUMN intent` / `DROP COLUMN intent_reviewed` —— `sqlite-schema.ts` 的
 * `columnRemovals` 在 DB 初始化阶段执行，早于本函数，拿它删列会先把数据删掉。
 *
 * **按 `storyboards` 行驱动**：生产库里有指向已不存在分镜的孤儿 intent（storyboard 125），
 * 按 intent 条数断言会错。软删行一并转换（回收站恢复后设计卡还在），但不计入统计。
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { MIN_SHOT_SECONDS } from './narration.js'
import {
  MAX_GEN_SEGMENT_SECONDS,
  MAX_LAYER_SEGMENT_SECONDS,
  hasGenSegment,
  hasLayerSegment,
  type AssetKindName,
  type AssetRef,
  type BaseRef,
  type Combo,
  type PlannedLayer,
  type PlannedLayerType,
  type SemanticRef,
} from './design-card.js'

const MIGRATED_REASON = 'migrated_from_intent'
/** 迁移产物不含读时重算的 `issues` */
type StoredCard = Record<string, unknown>

interface IntentRow {
  id: number
  duration: number | null
  deleted_at: string | null
  intent: string | null
}

function columnExists(table: string, column: string): boolean {
  const columns = db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>
  return columns.some(col => col.name === column)
}

/** §7 映射表：仅批准的 device × deterministic 可自动确定 combo。 */
function comboOf(device: unknown, deterministic: unknown): Combo | null {
  const dev = typeof device === 'string' ? device.trim().toLowerCase() : ''
  const layerDevices = ['map_anim', 'archival', 'card', 'reenact_still']
  if (!layerDevices.includes(dev) && dev !== 'reenact_video') return null
  const pos = typeof deterministic === 'string' ? deterministic.trim().toLowerCase() : ''
  if (pos === 'pre') return 'C'
  if (pos === 'post') return 'D'
  if (pos === 'none' && dev === 'reenact_video') return 'B'
  if (pos === 'replace' && layerDevices.includes(dev)) return 'A'
  return null
}

function clampSeconds(duration: number | null, max: number): number {
  const seconds = Number(duration) > 0 ? Number(duration) : MIN_SHOT_SECONDS
  return Math.min(Math.max(seconds, MIN_SHOT_SECONDS), max)
}

function assetKindOf(raw: unknown, fallback: AssetKindName): AssetKindName {
  const kind = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return kind === 'character' || kind === 'scene' || kind === 'prop' ? kind : fallback
}

/** `must_show` 拆成「语义条目（图层段标注）」与「资产级（生成段参考）」两份 */
function splitMustShow(mustShow: unknown[]): { mustMark: SemanticRef[]; references: AssetRef[] } {
  const mustMark: SemanticRef[] = []
  const references: AssetRef[] = []
  for (const entry of mustShow) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const assetId = Number.isInteger(item.asset_id) ? Number(item.asset_id) : null
    if (assetId === null) continue
    const kind = typeof item.kind === 'string' ? item.kind : ''
    if (kind === 'portrait' || kind === 'exposition') {
      references.push({
        kind: assetKindOf(item.asset_kind, kind === 'portrait' ? 'character' : 'prop'),
        id: assetId,
        name: typeof item.note === 'string' ? item.note : '',
      })
      continue
    }
    const semanticId = typeof item.semantic_id === 'string' && item.semantic_id
      ? item.semantic_id
      : typeof item.semantic === 'string' ? item.semantic : ''
    if (!semanticId) continue
    mustMark.push({
      asset_id: assetId,
      semantic_id: semanticId,
      name: typeof item.semantic_name === 'string' ? item.semantic_name : semanticId,
    })
  }
  return { mustMark, references }
}

const LAYER_TYPES: readonly string[] = ['polygon', 'polyline', 'marker', 'label', 'card', 'image']

function plannedLayersOf(overlayPlan: unknown[]): PlannedLayer[] {
  const layers: PlannedLayer[] = []
  for (const entry of overlayPlan) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const type = typeof item.layer === 'string' ? item.layer.trim().toLowerCase() : ''
    if (!LAYER_TYPES.includes(type)) continue
    const layer: PlannedLayer = {
      type: type as PlannedLayerType,
      at_s: typeof item.reveal_at === 'number' && Number.isFinite(item.reveal_at) ? Math.max(0, item.reveal_at) : 0,
    }
    const fields = item.fields && typeof item.fields === 'object' ? item.fields as Record<string, unknown> : {}
    const body = [item.text, fields.title, item.note].find(value => typeof value === 'string' && value.trim())
    if (typeof body === 'string') layer.text = body.trim()
    const anchor = item.anchor && typeof item.anchor === 'object' ? item.anchor as Record<string, unknown> : null
    if (anchor && Number.isInteger(anchor.asset_id)) {
      const semanticId = typeof anchor.semantic_id === 'string' && anchor.semantic_id
        ? anchor.semantic_id
        : typeof anchor.semantic === 'string' ? anchor.semantic : ''
      layer.anchor = { asset_id: Number(anchor.asset_id), semantic_id: semanticId, name: semanticId }
    }
    layers.push(layer)
  }
  return layers.sort((a, b) => a.at_s - b.at_s)
}

/**
 * 底图：#49 没有显式底图字段，`clip-draft.ts` 当时是从被引用的资产里挑的。
 * 迁移沿用同一口径（第一个带锚点的资产），信息不丢；挑不出就留 null，
 * 由设计卡的 `missing_base` 阻断提醒用户补。
 */
function baseRefOf(overlayPlan: unknown[], mustShow: unknown[]): BaseRef | null {
  for (const entry of overlayPlan) {
    const anchor = entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).anchor as Record<string, unknown> | undefined
      : undefined
    if (anchor && Number.isInteger(anchor.asset_id)) {
      return { kind: 'asset', asset_kind: assetKindOf(anchor.asset_kind, 'prop'), asset_id: Number(anchor.asset_id), version_task_id: null }
    }
  }
  for (const entry of mustShow) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (!Number.isInteger(item.asset_id)) continue
    if (item.kind === 'portrait' || item.kind === 'exposition') continue
    return { kind: 'asset', asset_kind: assetKindOf(item.asset_kind, 'prop'), asset_id: Number(item.asset_id), version_task_id: null }
  }
  return null
}

/** 一条 intent JSON → `{combo, card}`；仅无法解析对象时 card 为 null。 */
export function designCardFromIntent(raw: string | null, duration: number | null): { combo: Combo | null; card: StoredCard | null } {
  if (!(raw || '').trim()) return { combo: null, card: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw!)
  } catch {
    return { combo: null, card: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { combo: null, card: null }
  const intent = parsed as Record<string, unknown>
  const combo = comboOf(intent.device, intent.deterministic)

  const mustShow = Array.isArray(intent.must_show) ? intent.must_show : []
  const overlayPlan = Array.isArray(intent.overlay_plan) ? intent.overlay_plan : []
  const { mustMark, references } = splitMustShow(mustShow)
  const infoPointText = typeof intent.info_point === 'string' ? intent.info_point.trim() : ''

  const card: StoredCard = {
    version: 2,
    info_points: infoPointText
      ? [{ id: 'ip1', text: infoPointText, via: combo === null ? 'narration_only' : combo === 'B' ? 'generated' : 'layer' }]
      : [],
    budget: {
      layer_s: hasLayerSegment(combo) ? clampSeconds(duration, MAX_LAYER_SEGMENT_SECONDS) : null,
      gen_s: hasGenSegment(combo) ? clampSeconds(duration, MAX_GEN_SEGMENT_SECONDS) : null,
    },
    rationale: typeof intent.rationale === 'string' ? intent.rationale : '',
    suggested_combo: null,
  }
  if (hasLayerSegment(combo) || combo === null) {
    card.layer_plan = {
      base: baseRefOf(overlayPlan, mustShow),
      must_mark: mustMark,
      planned_layers: plannedLayersOf(overlayPlan),
    }
  }
  if (hasGenSegment(combo) || combo === null) {
    // C 的首帧 / D 的尾帧由衔接帧锁定继承，迁移时留空
    card.gen_plan = { reference_assets: references }
  }
  return { combo, card }
}

/**
 * 启动链上的一次性迁移。返回转换的镜数（存活行），`intent` 列已消失时返回 -1。
 */
export async function migrateIntentToDesignCard(): Promise<number> {
  if (!columnExists('storyboards', 'intent')) return -1

  const rows = db.all(sql.raw('SELECT id, duration, deleted_at, intent FROM storyboards')) as IntentRow[]
  const counts: Record<Combo, number> = { A: 0, B: 0, C: 0, D: 0 }
  let blanked = 0
  let unresolved = 0
  for (const row of rows) {
    const { combo, card } = designCardFromIntent(row.intent, row.duration)
    const alive = !row.deleted_at
    if (!card) {
      db.run(sql`UPDATE storyboards
        SET combo = NULL, design_card = NULL, design_card_status = 'blank',
            design_card_confirmed_at = NULL, design_card_stale_reason = NULL
        WHERE id = ${row.id}`)
      if (alive) blanked++
      continue
    }
    db.run(sql`UPDATE storyboards
      SET combo = ${combo}, design_card = ${JSON.stringify(card)}, design_card_status = 'pending',
          design_card_confirmed_at = NULL, design_card_stale_reason = ${combo ? MIGRATED_REASON : 'migration_combo_unresolved'}
      WHERE id = ${row.id}`)
    if (alive) {
      if (combo) counts[combo]++
      else unresolved++
    }
  }

  const migrated = counts.A + counts.B + counts.C + counts.D + unresolved
  console.log(`🗂️ 设计卡迁移：转换 ${migrated} 镜（A ${counts.A} / B ${counts.B} / C ${counts.C} / D ${counts.D} / 待选组合 ${unresolved}），置空 ${blanked} 镜`)

  // 删列必须在转换之后、同一函数内：columnRemovals 的执行时机早于数据迁移
  for (const column of ['intent', 'intent_reviewed']) {
    if (!columnExists('storyboards', column)) continue
    db.run(sql.raw(`ALTER TABLE storyboards DROP COLUMN ${column}`))
    console.log(`🧹 表 storyboards 删除已迁移列 ${column}`)
  }
  return migrated
}
