/**
 * 设计卡的解析上下文（Issue #57）— 把本集资产与 #47 的语义标注摘要装配成
 * `design-card.ts` 需要的 `DesignCardContext`，并提供「读库 → 规范化 → 问题列表」的统一入口。
 *
 * 语义标注这里**只取名称与稳定 id**，不带坐标：设计卡是导演层的决定（要让观众看到哪一项），
 * 几何交给图层段（R5/R6）。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { parseSemantics, resolveSemanticsBase } from './asset-semantics.js'
import {
  normalizeDesignCard,
  parseDesignCard,
  toCombo,
  validateDesignCard,
  type CardIssue,
  type Combo,
  type DesignCard,
  type DesignCardAssetEntry,
  type DesignCardContext,
  type DesignCardSemanticEntry,
} from './design-card.js'
import { parseNarrationMeta } from './narration.js'

/** 某张证据素材的语义条目摘要（名称 + 稳定 id + 组别） */
export function semanticEntries(semanticsJson: string | null | undefined): DesignCardSemanticEntry[] {
  const doc = parseSemantics(semanticsJson)
  if (!doc) return []
  return [
    ...doc.labels.map(item => ({ id: item.id, name: item.text, group: 'label' as const })),
    ...doc.points.map(item => ({ id: item.id, name: item.name, group: 'point' as const })),
    ...doc.regions.map(item => ({ id: item.id, name: item.name, group: 'region' as const })),
    ...doc.lines.map(item => ({ id: item.id, name: item.name, group: 'line' as const })),
  ]
}

/**
 * 本集可被设计卡引用的全部资产（角色 / 场景 / 道具）+ 道具的语义条目。
 * **同步**实现：一致性检查会在 `syncStoryboardBindingsFromPrompts` 的同步事务里调用，
 * 中途 await 会让并发的提示词保存丢更新（#43 的教训）。底图候选是异步的，
 * 单独走 `listBaseCandidates`，绝不进这个同步上下文。
 */
export function loadDesignCardContext(episodeId: number): DesignCardContext {
  const charIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(link => link.characterId)
  const sceneIds = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(link => link.sceneId)
  const propIds = db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId)).all().map(link => link.propId)

  const assets: DesignCardAssetEntry[] = []
  for (const row of db.select().from(schema.characters).all()) {
    if (row.deletedAt || !charIds.includes(row.id)) continue
    assets.push({
      kind: 'character', id: row.id, name: row.name,
      exposition: Number(row.exposition) === 1,
      image: row.localPath || row.imageUrl || null,
    })
  }
  for (const row of db.select().from(schema.scenes).all()) {
    if (row.deletedAt || !sceneIds.includes(row.id)) continue
    assets.push({
      kind: 'scene', id: row.id, name: row.location,
      exposition: Number(row.exposition) === 1,
      image: row.localPath || row.imageUrl || null,
    })
  }
  for (const row of db.select().from(schema.props).all()) {
    if (row.deletedAt || !propIds.includes(row.id)) continue
    assets.push({
      kind: 'prop',
      id: row.id,
      name: row.name,
      exposition: Number(row.exposition) === 1,
      faithful: Number(row.faithful) === 1,
      image: row.localPath || row.imageUrl || null,
      semantics: semanticEntries(row.semantics),
    })
  }
  return { assets }
}

export interface BaseCandidate {
  asset_kind: 'character' | 'scene' | 'prop'
  asset_id: number
  name: string
  version_task_id: number | null
  path: string
  width: number
  height: number
  /** 忠实原件（`faithful=1` 且有原件版本）= 已核验 */
  verified: boolean
}

/**
 * 图层段底图候选（契约 §6.2）。R3 的美化流水线合并后由它提供同签名实现；
 * 在此之前按同一口径本地实现：忠实原件优先，其余资产退当前生效图。
 */
export async function listBaseCandidates(episodeId: number): Promise<BaseCandidate[]> {
  const ctx = loadDesignCardContext(episodeId)
  const candidates: BaseCandidate[] = []
  const propIds = ctx.assets.filter(a => a.kind === 'prop').map(a => a.id)
  if (propIds.length) {
    const props = await db.select().from(schema.props).where(inArray(schema.props.id, propIds))
    for (const prop of props) {
      const base = await resolveSemanticsBase(prop)
      if (!base.path) continue
      const semantics = parseSemantics(prop.semantics)
      candidates.push({
        asset_kind: 'prop',
        asset_id: prop.id,
        name: prop.name,
        version_task_id: base.taskId,
        path: base.path,
        width: semantics?.image.width ?? 0,
        height: semantics?.image.height ?? 0,
        verified: Number(prop.faithful) === 1 && !!prop.faithfulSource,
      })
    }
  }
  for (const asset of ctx.assets) {
    if (asset.kind === 'prop' || !asset.image) continue
    candidates.push({
      asset_kind: asset.kind,
      asset_id: asset.id,
      name: asset.name,
      version_task_id: null,
      path: asset.image,
      width: 0,
      height: 0,
      verified: false,
    })
  }
  return candidates
}

/** 设计卡校验要用到的本镜事实 */
export interface DesignCardShotRow {
  id: number
  storyboardNumber: number
  combo: string | null
  designCard: string | null
  narrationText: string | null
  narrationMeta?: string | null
  description?: string | null
}

export interface ResolvedDesignCard {
  combo: Combo | null
  card: DesignCard | null
  issues: CardIssue[]
}

/** 配音实测秒数（没配音返回 null）；预算校验与界面展示共用同一口径 */
export function measuredNarrationSeconds(row: { narrationMeta?: string | null }): number | null {
  const meta = parseNarrationMeta(row.narrationMeta)
  const ms = meta.audio?.duration_ms
  return typeof ms === 'number' && ms > 0 ? Math.round(ms / 100) / 10 : null
}

/**
 * 库里的设计卡按**当前**上下文重新解析：语义标注被改过之后，原来可解析的条目
 * 可能已经失效，所以 `unresolved` 与 `issues` 永远是读时重算的结论，不吃库里的旧值。
 *
 * `measuredSeconds`：纪录片的写入/确认路径必须传 `narration-tts-gate` 实测出的秒数
 * （`undefined` = 沿用 `narration_meta` 里的旧值，只供展示与存量数据；`null` = 明确没有实测）。
 */
export function resolveDesignCard(
  row: DesignCardShotRow,
  ctx: DesignCardContext,
  mentioned?: Array<{ kind: 'character' | 'scene' | 'prop'; id: number }> | null,
  measuredSeconds?: number | null,
): ResolvedDesignCard {
  const combo = toCombo(row.combo)
  const card = parseDesignCard(row.designCard, ctx)
  const issues = validateDesignCard({
    card,
    combo,
    narrationText: row.narrationText,
    measuredSeconds: measuredSeconds === undefined ? measuredNarrationSeconds(row) : measuredSeconds,
    mentioned: mentioned ?? null,
  })
  if (card) card.issues = issues
  return { combo, card, issues }
}

/** 直接从原始对象算一份（保存路径用：先规范化再校验） */
export function resolveDesignCardFrom(
  raw: unknown,
  combo: Combo | null,
  ctx: DesignCardContext,
  shot: { narrationText?: string | null; narrationMeta?: string | null },
  measuredSeconds?: number | null,
): ResolvedDesignCard {
  const card = normalizeDesignCard(raw, ctx)
  const issues = validateDesignCard({
    card,
    combo,
    narrationText: shot.narrationText,
    measuredSeconds: measuredSeconds === undefined ? measuredNarrationSeconds(shot) : measuredSeconds,
  })
  if (card) card.issues = issues
  return { combo, card, issues }
}

/** 一镜设计卡的中文摘要（供提示词批量的 message 用；没有卡返回空串） */
function describeDesignCard(combo: Combo | null, card: DesignCard | null): string {
  if (!card) return ''
  const segments = combo
    ? `组合=${combo}（${[
      card.budget.layer_s != null ? `▣${card.budget.layer_s}s` : '',
      card.budget.gen_s != null ? `▶${card.budget.gen_s}s` : '',
    ].filter(Boolean).join('→')}）`
    : '组合=未选'
  const mustMark = (card.layer_plan?.must_mark || []).map(ref => ref.name || ref.semantic_id)
  const references = (card.gen_plan?.reference_assets || []).map(ref => `@${ref.name}`)
  return [
    segments,
    card.info_points.length ? `信息点=${card.info_points.map(point => point.text).join('；')}` : '',
    mustMark.length ? `必须标注=${mustMark.join('、')}` : '',
    references.length ? `参考素材=${references.join('、')}` : '',
    card.rationale ? `理由=${card.rationale}` : '',
  ].filter(Boolean).join('｜')
}

export interface DesignCardBrief {
  /** 本镜 + 前后镜设计卡的中文摘要段（已含结尾换行）；没有任何设计卡时为空串 */
  text: string
  combo: Combo | null
  card: DesignCard | null
}

/**
 * 逐镜装配「本镜设计卡 + 前后镜设计卡/description」的提示词片段（替换 #49 的 `buildIntentBriefs`）。
 * 关键帧/视频提示词批量把它插进 message，模型才知道这一镜必须让观众看到什么、
 * 以及上一镜已经讲到哪儿了。
 */
export function buildDesignCardBriefs(
  rows: DesignCardShotRow[],
  ctx: DesignCardContext,
): Map<number, DesignCardBrief> {
  const ordered = [...rows].sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const resolved = ordered.map(row => resolveDesignCard(row, ctx))
  const briefs = new Map<number, DesignCardBrief>()
  ordered.forEach((row, index) => {
    const own = resolved[index]!
    const lines: string[] = []
    if (own.card) lines.push(`本镜设计卡（必须全部落到提示词里）：${describeDesignCard(own.combo, own.card)}`)
    const prev = ordered[index - 1]
    const next = ordered[index + 1]
    if (prev) {
      const summary = describeDesignCard(resolved[index - 1]!.combo, resolved[index - 1]!.card)
      lines.push(`上一镜 #${prev.storyboardNumber}：${summary || '（无设计卡）'}｜画面：${(prev.description || '').slice(0, 120)}`)
    }
    if (next) {
      const summary = describeDesignCard(resolved[index + 1]!.combo, resolved[index + 1]!.card)
      lines.push(`下一镜 #${next.storyboardNumber}：${summary || '（无设计卡）'}｜画面：${(next.description || '').slice(0, 120)}`)
    }
    briefs.set(row.id, { text: lines.length ? `${lines.join('\n')}\n` : '', combo: own.combo, card: own.card })
  })
  return briefs
}

/** 本集存活分镜（按镜号），设计卡相关列齐全 */
export async function loadDesignCardRows(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
}
