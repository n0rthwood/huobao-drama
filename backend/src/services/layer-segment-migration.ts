/**
 * 一次性启动迁移（Issue #58，契约 §7）：`storyboard_clips` → `storyboard_layer_segments`。
 *
 * **按行驱动**：生产库里有指向已不存在分镜的孤儿 clip（storyboard 125），按 clip 条数断言会错；
 * 这里只转「分镜还在」的行。同一镜出现多条 clip（#50 的 replace/pre/post 各自一行）时按
 * `replace > pre > post` 取一条，其余丢弃并在 `stale_reasons` 记 `migrated_multi_clip`。
 *
 * 迁移后所有段的 `render_signature` 按新口径（`'seg-v1'`，去掉 position）重算——
 * 旧渲染一律判 stale（重渲染秒级，发布说明里写明 drama 6 的 10 镜需重渲染）。
 *
 * 「是否参与」由 `storyboards.combo` 决定（R4 的迁移负责回填 combo，本迁移在它之后跑）：
 * 有 clip 行但 combo 为空 → `stale_reasons` 记 `combo_missing`（契约 §10 裁决 12）。
 * 底图引用由 `layer_doc.base.path` 反查资产版本（`props/characters/scenes` 的原图或版本图）；
 * 查不到就写 null 并记 `base_ref_unresolved`。
 *
 * 幂等：旧表已经不存在就直接返回（迁移只在第一次建表后执行一次）。
 */
import { sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { normalizeLayerDoc, type LayerDoc } from './layer-doc.js'
import { normalizeTimeline } from './segment-timeline.js'
import {
  layerSegmentSignatureOf,
  resolveEpisodeSegmentSpec,
  SEGMENT_STALE_REASONS,
  withBaseSourceSize,
  type LayerSegment,
} from './layer-segment.js'
import { toCombo, type BaseRef } from './design-card.js'

const POSITION_PRIORITY: Record<string, number> = { replace: 0, pre: 1, post: 2 }

interface LegacyClipRow {
  id: number
  storyboard_id: number
  position: string
  layer_doc: string
  timeline: string
  duration: number
  render_path: string | null
  render_signature: string | null
  rendered_at: string | null
  status: string
  created_at: string
  updated_at: string
}

function tableExists(name: string): boolean {
  const rows = db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`) as Array<{ name: string }>
  return rows.length > 0
}

function columnExists(table: string, column: string): boolean {
  const columns = db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>
  return columns.some(col => col.name === column)
}

/** `layer_doc.base.path` → BaseRef：优先 props（带语义的忠实原件），其次角色/场景 */
async function resolveBaseRefFromPath(path: string | null): Promise<BaseRef | null> {
  if (!path) return null
  const props = await db.select().from(schema.props)
  const prop = props.find(item => item.localPath === path || item.imageUrl === path)
  if (prop) {
    return {
      kind: 'asset',
      asset_kind: 'prop',
      asset_id: prop.id,
      version_task_id: prop.faithfulSource ?? null,
    }
  }
  const characters = await db.select().from(schema.characters)
  const character = characters.find(item => item.localPath === path || item.imageUrl === path)
  if (character) return { kind: 'asset', asset_kind: 'character', asset_id: character.id, version_task_id: null }
  const scenes = await db.select().from(schema.scenes)
  const scene = scenes.find(item => item.localPath === path || item.imageUrl === path)
  if (scene) return { kind: 'asset', asset_kind: 'scene', asset_id: scene.id, version_task_id: null }
  // 版本图（生成结果）也认：路径等于某条 sys_task 的 localPath/resultUrl
  const tasks = await db.select().from(schema.sysTask)
  const task = tasks.find(item => item.localPath === path || item.resultUrl === path)
  if (task) {
    if (task.propId) return { kind: 'asset', asset_kind: 'prop', asset_id: task.propId, version_task_id: task.id }
    if (task.characterId) return { kind: 'asset', asset_kind: 'character', asset_id: task.characterId, version_task_id: task.id }
    if (task.sceneId) return { kind: 'asset', asset_kind: 'scene', asset_id: task.sceneId, version_task_id: task.id }
  }
  return null
}

export async function migrateClipsToLayerSegments(): Promise<number> {
  if (!tableExists('storyboard_clips')) return 0
  // 目标表由 sqlite-schema 的 DDL 建好；这里只搬行
  if (!tableExists('storyboard_layer_segments')) {
    throw new Error('storyboard_layer_segments 不存在：DDL 未执行，不能迁移 storyboard_clips')
  }

  const clips = db.all(sql`SELECT * FROM storyboard_clips`) as LegacyClipRow[]
  const storyboards = await db.select().from(schema.storyboards)
  const byId = new Map(storyboards.map(row => [row.id, row]))

  // 同镜多行：按 replace > pre > post 取一条
  const chosen = new Map<number, LegacyClipRow[]>()
  for (const clip of clips) {
    const list = chosen.get(clip.storyboard_id)
    if (list) list.push(clip)
    else chosen.set(clip.storyboard_id, [clip])
  }

  let migrated = 0
  let skippedOrphans = 0
  let droppedMulti = 0
  for (const [storyboardId, rows] of chosen) {
    const sb = byId.get(storyboardId)
    if (!sb) {
      skippedOrphans++
      continue
    }
    const ordered = [...rows].sort((a, b) => (POSITION_PRIORITY[a.position] ?? 9) - (POSITION_PRIORITY[b.position] ?? 9))
    const clip = ordered[0]
    // 这一镜是否真的有多条 clip（累计计数只用于最终日志，不能拿它当本镜的判定）
    const multiClip = ordered.length > 1
    if (multiClip) droppedMulti += ordered.length - 1

    let parsedDoc: unknown = null
    try {
      parsedDoc = JSON.parse(clip.layer_doc)
    } catch {
      parsedDoc = null
    }
    let parsedTimeline: unknown = null
    try {
      parsedTimeline = JSON.parse(clip.timeline)
    } catch {
      parsedTimeline = null
    }
    // 原始 JSON 能解析就**原样搬**（契约：`layer_doc` 与迁移前字节一致）；
    // 只有坏 JSON 才退化为规范化结果，规范化本身在服务读入时再做
    const layerDoc = parsedDoc && typeof parsedDoc === 'object'
      ? await withBaseSourceSize(parsedDoc as LayerDoc)
      : normalizeLayerDoc(parsedDoc)
    const timeline = normalizeTimeline(parsedTimeline)
    const baseRef = await resolveBaseRefFromPath(layerDoc.base.path)
    const reasons: string[] = []
    if (multiClip) reasons.push(SEGMENT_STALE_REASONS.migratedMultiClip)
    if (!baseRef && layerDoc.base.path) reasons.push(SEGMENT_STALE_REASONS.baseRefUnresolved)
    const combo = toCombo(sb.combo)
    // combo 由 R4 的迁移回填；这里只认它是否为空（契约 §10 裁决 12）
    if (!combo) reasons.push(SEGMENT_STALE_REASONS.comboMissing)

    const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
    const signature = layerSegmentSignatureOf({ layer_doc: layerDoc, timeline, duration: clip.duration }, spec)
    const ts = now()
    const exists = db.all(sql`SELECT id FROM storyboard_layer_segments WHERE storyboard_id = ${storyboardId}`) as Array<{ id: number }>
    if (exists.length) {
      db.run(sql`UPDATE storyboard_layer_segments SET
        layer_doc = ${JSON.stringify(layerDoc)},
        timeline = ${JSON.stringify(timeline)},
        duration = ${clip.duration},
        base_ref = ${baseRef ? JSON.stringify(baseRef) : null},
        render_path = ${clip.render_path},
        render_signature = ${signature},
        rendered_at = ${clip.rendered_at},
        junction_path = NULL,
        junction_hash = NULL,
        status = 'draft',
        stale_reasons = ${JSON.stringify(reasons)},
        updated_at = ${ts}
        WHERE storyboard_id = ${storyboardId}`)
    } else {
      db.run(sql`INSERT INTO storyboard_layer_segments (
        storyboard_id, layer_doc, timeline, duration, base_ref, quality_warnings,
        render_path, render_signature, rendered_at, junction_path, junction_hash,
        status, stale_reasons, created_at, updated_at
      ) VALUES (
        ${storyboardId}, ${JSON.stringify(layerDoc)}, ${JSON.stringify(timeline)}, ${clip.duration},
        ${baseRef ? JSON.stringify(baseRef) : null}, ${JSON.stringify([])},
        ${clip.render_path}, ${signature}, ${clip.rendered_at}, NULL, NULL,
        'draft', ${JSON.stringify(reasons)}, ${ts}, ${ts}
      )`)
    }
    migrated++
  }

  // 迁移完成后删旧表（drizzle 定义与 DDL 已同步删除）
  db.run(sql`DROP TABLE IF EXISTS storyboard_clips`)
  if (columnExists('storyboard_clips', 'position')) {
    console.warn('⚠️ storyboard_clips 仍未删除：请检查迁移脚本')
  }
  console.log(`🎞️ storyboard_clips → storyboard_layer_segments：迁移 ${migrated} 镜`
    + `${droppedMulti ? `（同镜多 clip 丢弃 ${droppedMulti} 条，记 migrated_multi_clip）` : ''}`
    + `${skippedOrphans ? `，跳过 ${skippedOrphans} 条孤儿 clip` : ''}，旧表已删除`)
  return migrated
}
