/**
 * 资产审核清单（Issue #55）— 纪录片「资产」步的强门禁，唯一读写口
 *
 * AI 逐段对照旁白稿列「信息点 → 需要的素材 → 有 / 缺」，每条清单项必须被处置成
 * `have | added | ignored | not_needed` 之一；只要还有 `missing`，`episodes.asset_review_status`
 * 就停在 `pending`，R1 的 `workflow-gates.ts` 据此把「分镜设计」步锁死。
 *
 * 重新对照（续跑而不是重来）：条目身份 = `fingerprint = sha256(归一化信息点 + need_kind)`，
 * **不含段号**——剧本中间插一段不会让后面所有条目重新来过。指纹没命中时再按归一化
 * 信息点文本做包含匹配兜底（模型措辞轻微漂移），仍没命中才算新增 / 删除。
 *
 * 资产库变更（关联 / 取消关联 / 新版本登记 / 语义变更）只写 `episodes.asset_review_stale_reasons`
 * 做横幅提示，**不回退 `passed`**（契约 §6.1）；已绑定资产消失才是硬退化 → 条目回 `missing`。
 *
 * 剧情项目（`project_type='drama'`）永不写这两列，接口一律 400 `not_documentary`。
 */
import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db, schema } from '../db/index.js'
import { loadSkillDoc } from '../agents/skills.js'
import { getContentLanguage } from './app-settings.js'
import { resolveStageModel, type StageModel } from './ai-stages.js'
import { normalizeAssetName, normalizeNearName } from './asset-name.js'
import { parseSemantics, type AssetSemantics } from './asset-semantics.js'
import type { ExtractTarget } from './extraction.js'
import { resolveDramaProjectType } from './project-type.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  parseTextTaskParams,
  patchTextTaskParams,
  textTaskOutcome,
  updateTextTaskProgress,
} from './text-task.js'
import { callTextChat } from './vision-chat.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { now } from '../utils/response.js'

export const NEED_KINDS = ['character', 'scene', 'prop', 'prop_faithful', 'exposition', 'none'] as const
export type NeedKind = typeof NEED_KINDS[number]

export const REVIEW_ITEM_STATUSES = ['missing', 'have', 'added', 'ignored', 'not_needed'] as const
export type ReviewItemStatus = typeof REVIEW_ITEM_STATUSES[number]

/** 资产库变更事件名（写进 `episodes.asset_review_stale_reasons`，只做横幅） */
export const STALE_REASONS = ['asset_linked', 'asset_unlinked', 'version_registered', 'semantics_changed'] as const
export type StaleReason = typeof STALE_REASONS[number]

export type AssetReviewStatus = 'none' | 'running' | 'pending' | 'passed'

type AssetKind = 'character' | 'scene' | 'prop'
type ReviewItemRow = typeof schema.assetReviewItems.$inferSelect

/** 处置理由的最短长度（`ignored` 必填） */
const MIN_REASON_CHARS = 5
/** 段落摘录的展示长度上限 */
const EXCERPT_CHARS = 120
/** 自动分段兜底时，一段最多多少字 */
const AUTO_SEGMENT_CHARS = 200
/**
 * 单段对照的输出预算：GLM-5.x **始终思考**（`AI_DISABLE_THINKING` 对它无效，官方端点传
 * disabled 直接 400），推理过程同样吃 `max_tokens`——给 4096 时实测 content 为空串。
 * 与 Agent 侧 `AI_MAX_TOKENS` 同源，默认 16384（实测一段 ~3000 completion tokens）。
 */
const SEGMENT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16384)
/** 单段超时：含思考的一次调用实测 30–60 s */
const SEGMENT_TIMEOUT_MS = 300_000

export class AssetReviewError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = 'AssetReviewError'
  }
}

// ─── 纯函数：分段 / 指纹 / 状态机 ────────────────────────────────

/**
 * 旁白稿分段：空行或 `##` 标题起一段。
 * 整篇没有空行时按句末标点聚合成 ≤200 字一段（`auto` 为真，界面标「自动分段」）。
 */
export function splitNarrationSegments(script: string | null | undefined): { texts: string[]; auto: boolean } {
  const raw = (script || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return { texts: [], auto: false }

  const blocks: string[] = []
  let current: string[] = []
  for (const line of raw.split('\n')) {
    if (/^\s*$/.test(line)) {
      if (current.length) { blocks.push(current.join('\n')); current = [] }
      continue
    }
    if (/^\s*#{1,6}\s/.test(line) && current.length) {
      blocks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length) blocks.push(current.join('\n'))

  const texts = blocks.map(b => b.trim()).filter(Boolean)
  if (texts.length > 1) return { texts, auto: false }

  // 一整块无空行的文本：按句末标点聚合，避免整集退化成一条粗粒度清单
  const single = texts[0] || ''
  if (single.length <= AUTO_SEGMENT_CHARS) return { texts: single ? [single] : [], auto: false }
  const sentences = single.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [single]
  const chunks: string[] = []
  let buf = ''
  for (const sentence of sentences) {
    if (buf && (buf + sentence).length > AUTO_SEGMENT_CHARS) { chunks.push(buf); buf = '' }
    buf += sentence
  }
  if (buf.trim()) chunks.push(buf)
  return { texts: chunks.map(c => c.trim()).filter(Boolean), auto: true }
}

/**
 * 信息点的比较键：去掉空白与中英文标点、转小写。
 * 指纹与「包含匹配」兜底都用它，所以模型把「出发地·托博尔斯克」写成「出发地 托博尔斯克」
 * 不会让一条已处置的清单项被当成新条目。
 */
export function infoPointKey(text: string | null | undefined): string {
  return (text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・、，,。.；;：:！!？?「」『』（）()《》<>【】\[\]"'`~—\-_/\\|]+/g, '')
    .toLowerCase()
}

/** 条目身份（契约 §6.1 + 评审裁决）：`sha256(归一化信息点 + need_kind)`，不含段号 */
export function fingerprintOf(infoPoint: string, needKind: string): string {
  return createHash('sha256').update(`${infoPointKey(infoPoint)}${needKind}`).digest('hex')
}

/** 归一化信息点的二元字组集合（相似度用） */
function bigrams(key: string): Set<string> {
  const out = new Set<string>()
  if (key.length === 1) out.add(key)
  for (let i = 0; i + 1 < key.length; i++) out.add(key.slice(i, i + 2))
  return out
}

/**
 * 两个信息点的措辞相似度（Dice 系数，0–1）。
 * 重跑时模型会把「河南安阳·地理区位」改写成「河南安阳的地理位置」：纯包含匹配认不出来，
 * 旧行就会被删、用户的处置全丢。相似度兜底按同一 `need_kind` 找回最像的那一行。
 */
export function infoPointSimilarity(a: string, b: string): number {
  const ka = infoPointKey(a)
  const kb = infoPointKey(b)
  if (!ka || !kb) return 0
  if (ka === kb) return 1
  if (ka.includes(kb) || kb.includes(ka)) return 1
  const A = bigrams(ka)
  const B = bigrams(kb)
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return (2 * hit) / (A.size + B.size)
}

/** 相似度兜底的下限：实测同一信息点的改写落在 0.53–0.9，不同信息点落在 0.0–0.35 */
export const INFO_POINT_MATCH_MIN = 0.5

/**
 * 处置状态机（Issue #55「状态机」节）：
 * - `missing` → 任意处置态；
 * - 已处置的 `have/added/not_needed` 只能**撤销**回 `missing`（清空绑定）再重新处置，
 *   这样「改主意」一定经过一次显式撤销，不会出现绑着旧资产的 `ignored` 行；
 * - `ignored` → 任意（忽略只是一句理由，没有绑定要清）。
 */
const ALLOWED_TRANSITIONS: Record<ReviewItemStatus, ReviewItemStatus[]> = {
  missing: ['have', 'added', 'ignored', 'not_needed'],
  ignored: ['missing', 'have', 'added', 'not_needed'],
  have: ['missing'],
  added: ['missing'],
  not_needed: ['missing'],
}

export function canTransitionStatus(from: ReviewItemStatus, to: ReviewItemStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to)
}

/**
 * 状态优先级（评审裁决·疑问 9）：running > pending(有 missing) > passed > none。
 * `incomplete` = 最近一次对照有段落失败：那几段的信息点根本没被列出来，
 * 「没有 missing」只是因为没问过，绝不能据此解锁分镜设计——一律按 pending 上锁，
 * 直到重新对照完整跑完一次。
 */
export function computeReviewStatus(facts: {
  running: boolean
  total: number
  missing: number
  incomplete?: boolean
}): AssetReviewStatus {
  if (facts.running) return 'running'
  if (facts.incomplete) return 'pending'
  if (facts.total === 0) return 'none'
  return facts.missing > 0 ? 'pending' : 'passed'
}

/** R1 门禁文案的唯一来源（评审裁决·建议 8）：`workflow-gates.ts` 直接消费 */
export function assetReviewGateReason(status: AssetReviewStatus, missingCount: number): string {
  switch (status) {
    case 'passed': return ''
    case 'running': return '资产审核清单正在对照中：等本次对照跑完再处置剩余条目'
    // 缺失为 0 还停在 pending，只可能是上次对照有失败段（清单不完整），说「还有 0 项未处置」是假信息
    case 'pending': return missingCount > 0
      ? `资产审核清单还有 ${missingCount} 项缺失未处置：请在「资产 · 审核清单」里逐条处置`
      : '资产审核清单不完整：上次对照有失败的段落，请重新对照剧本'
    default: return '资产审核清单尚未生成：请在「资产 · 审核清单」点「AI 对照剧本生成清单」'
  }
}

/** `need_kind` → 可绑定的资产类别（`none` 不绑定任何资产） */
export function assetKindForNeed(needKind: string): AssetKind | null {
  switch (needKind) {
    case 'character': return 'character'
    case 'scene': return 'scene'
    case 'prop': case 'prop_faithful': return 'prop'
    // exposition 三类资产都可能承担（人物/组织/事件的说明画面）
    case 'exposition': return null
    default: return null
  }
}

// ─── 本集资产（带证据素材 / 说明素材标记与语义条目） ───────────────

interface ReviewAsset {
  kind: AssetKind
  id: number
  name: string
  faithful: boolean
  exposition: boolean
  semantics: AssetSemantics | null
}

function loadReviewAssets(episodeId: number): ReviewAsset[] {
  const out: ReviewAsset[] = []

  const sceneIds = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(l => l.sceneId)
  for (const row of db.select().from(schema.scenes).all()) {
    if (!sceneIds.includes(row.id) || row.deletedAt) continue
    out.push({
      kind: 'scene', id: row.id, name: (row.location || '').trim(),
      faithful: false, exposition: Number(row.exposition) === 1, semantics: null,
    })
  }

  const charIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(l => l.characterId)
  for (const row of db.select().from(schema.characters).all()) {
    if (!charIds.includes(row.id) || row.deletedAt) continue
    out.push({
      kind: 'character', id: row.id, name: (row.name || '').trim(),
      faithful: false, exposition: Number(row.exposition) === 1, semantics: null,
    })
  }

  const propIds = db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId)).all().map(l => l.propId)
  for (const row of db.select().from(schema.props).all()) {
    if (!propIds.includes(row.id) || row.deletedAt) continue
    out.push({
      kind: 'prop', id: row.id, name: (row.name || '').trim(),
      faithful: Number(row.faithful) === 1, exposition: Number(row.exposition) === 1,
      semantics: parseSemantics(row.semantics),
    })
  }
  return out.filter(a => !!a.name)
}

/** 语义条目名（建议 5）：`points/regions/lines[].name` 与 `labels[].text` */
function semanticEntries(doc: AssetSemantics | null): { id: string; name: string; needsReview: boolean }[] {
  if (!doc) return []
  const out: { id: string; name: string; needsReview: boolean }[] = []
  for (const item of doc.labels || []) out.push({ id: item.id, name: item.text, needsReview: !!item.needs_review })
  for (const group of [doc.points || [], doc.regions || [], doc.lines || []]) {
    for (const item of group as { id: string; name: string; needs_review?: boolean }[]) {
      out.push({ id: item.id, name: item.name, needsReview: !!item.needs_review })
    }
  }
  return out.filter(e => !!e.id && !!e.name)
}

function needKindAccepts(needKind: string, asset: ReviewAsset): boolean {
  if (needKind === 'prop_faithful') return asset.kind === 'prop' && asset.faithful
  if (needKind === 'exposition') return asset.exposition
  const wanted = assetKindForNeed(needKind)
  return wanted ? asset.kind === wanted : false
}

/** 模型给的素材名 → 本集真实资产（名称归一 + 近名归一；类别不相容不认） */
function resolveAssetByName(assets: ReviewAsset[], rawName: string, needKind: string): ReviewAsset | null {
  const name = String(rawName || '').trim()
  if (!name) return null
  const candidates = assets.filter(a => needKindAccepts(needKind, a))
  const normalized = normalizeAssetName(name)
  const exact = candidates.find(a => normalizeAssetName(a.name) === normalized)
  if (exact) return exact
  const near = normalizeNearName(name)
  return near ? candidates.find(a => normalizeNearName(a.name) === near) ?? null : null
}

// ─── 模型输出 ───────────────────────────────────────────────

const modelItemSchema = z.object({
  info_point: z.string().min(1),
  need_kind: z.enum(NEED_KINDS),
  need_desc: z.string().default(''),
  match_name: z.string().nullish(),
  match_semantic_name: z.string().nullish(),
  not_needed: z.boolean().nullish(),
  not_needed_reason: z.string().nullish(),
})
const modelReplySchema = z.object({
  segment_no: z.number().int().nullish(),
  items: z.array(modelItemSchema).default([]),
})

/** 模型回复里抠出 JSON 对象（容忍 ```json 围栏与前后寒暄） */
function parseModelReply(text: string): z.infer<typeof modelReplySchema> {
  const body = text.replace(/```json/gi, '```').split('```').map(s => s.trim()).filter(Boolean)
  const candidates = [...body, text]
  for (const chunk of candidates) {
    const start = chunk.indexOf('{')
    const end = chunk.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      const parsed = modelReplySchema.safeParse(JSON.parse(chunk.slice(start, end + 1)))
      if (parsed.success) return parsed.data
    } catch { /* 下一个候选 */ }
  }
  throw new Error('模型未返回可解析的 JSON 清单')
}

export interface DraftItem {
  segmentNo: number
  narrationExcerpt: string
  infoPoint: string
  needKind: NeedKind
  needDesc: string
  status: ReviewItemStatus
  assetKind: AssetKind | null
  assetId: number | null
  semanticId: string | null
  reason: string | null
  fingerprint: string
}

/** 模型条目 + 本集资产 → 落库草稿（状态由服务端判，模型不写 status / id） */
function toDraftItems(
  segmentNo: number,
  excerpt: string,
  items: z.infer<typeof modelItemSchema>[],
  assets: ReviewAsset[],
): DraftItem[] {
  const drafts: DraftItem[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const infoPoint = raw.info_point.trim()
    if (!infoPoint) continue
    const fingerprint = fingerprintOf(infoPoint, raw.need_kind)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)

    const draft: DraftItem = {
      segmentNo,
      narrationExcerpt: excerpt,
      infoPoint,
      needKind: raw.need_kind,
      needDesc: (raw.need_desc || '').trim(),
      status: 'missing',
      assetKind: null,
      assetId: null,
      semanticId: null,
      reason: null,
      fingerprint,
    }
    if (raw.not_needed === true) {
      draft.status = 'not_needed'
      draft.reason = (raw.not_needed_reason || '由图层卡片表达').trim()
    } else {
      const asset = resolveAssetByName(assets, raw.match_name || '', raw.need_kind)
      if (asset) {
        draft.status = 'have'
        draft.assetKind = asset.kind
        draft.assetId = asset.id
        const wantedName = (raw.match_semantic_name || '').trim()
        if (wantedName) {
          const hit = semanticEntries(asset.semantics)
            .find(e => normalizeNearName(e.name) === normalizeNearName(wantedName))
          // 解析不到就只留资产级绑定，绝不编造条目 id
          draft.semanticId = hit?.id ?? null
        }
      }
    }
    drafts.push(draft)
  }
  return drafts
}

// ─── 落库：按指纹保留处置 ────────────────────────────────────

export interface ReviewRunDiff {
  kept: number
  added: number
  removed: number
  /** R4 据此把引用了这些条目的设计卡置 stale（新增 / 删除 / 需求描述变化的条目） */
  changed_item_ids: number[]
}

/**
 * 把本次对照的结果合并进库：
 * 1. 指纹命中 → 只刷新 run_id / 段号 / 摘录 / 需求描述，**保留处置结果**；
 * 2. 未命中 → 先在「本次没被认领、且已处置」的旧行里按归一化信息点做包含匹配（措辞漂移兜底），
 *    命中就把那行改指纹迁过来，处置照样保留；
 * 3. 仍未命中 → 新建行；本次完全没认领的旧行删除。
 */
export function mergeDraftItems(
  episodeId: number,
  runId: number,
  rawDrafts: DraftItem[],
  opts: { keepUnmatched?: boolean } = {},
): ReviewRunDiff {
  const ts = now()
  // 全集去重：同一「信息点 + need_kind」跨段重复时只留第一条（指纹不含段号，
  // 留两条会直接撞 UNIQUE(episode_id, fingerprint)）
  const byDraftFingerprint = new Map<string, DraftItem>()
  for (const draft of rawDrafts) {
    if (!byDraftFingerprint.has(draft.fingerprint)) byDraftFingerprint.set(draft.fingerprint, draft)
  }
  const drafts = [...byDraftFingerprint.values()]
  const existing = db.select().from(schema.assetReviewItems)
    .where(eq(schema.assetReviewItems.episodeId, episodeId)).all()
  const byFingerprint = new Map(existing.map(row => [row.fingerprint, row]))
  const claimed = new Set<number>()
  const diff: ReviewRunDiff = { kept: 0, added: 0, removed: 0, changed_item_ids: [] }

  for (const draft of drafts) {
    const hit = byFingerprint.get(draft.fingerprint)
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id)
      diff.kept++
      if ((hit.needDesc || '') !== draft.needDesc) diff.changed_item_ids.push(hit.id)
      db.update(schema.assetReviewItems).set({
        runId,
        segmentNo: draft.segmentNo,
        narrationExcerpt: draft.narrationExcerpt,
        needDesc: draft.needDesc,
        updatedAt: ts,
      }).where(eq(schema.assetReviewItems.id, hit.id)).run()
      continue
    }

    // 措辞漂移兜底：同一 need_kind 的旧「已处置」行里挑措辞最像的一条迁过来。
    // 只比包含关系不够——重跑时模型常整句改写（「河南安阳·地理区位」→「河南安阳的地理位置」），
    // 认不出来就会删旧行，用户上一轮的忽略/理由全部白做。
    let fallback: typeof existing[number] | null = null
    let best = INFO_POINT_MATCH_MIN
    for (const row of existing) {
      if (claimed.has(row.id)) continue
      if (row.status === 'missing') continue
      if (row.needKind !== draft.needKind) continue
      if (drafts.some(d => d.fingerprint === row.fingerprint)) continue
      const score = infoPointSimilarity(row.infoPoint, draft.infoPoint)
      if (score >= best) { best = score; fallback = row }
    }
    if (fallback) {
      claimed.add(fallback.id)
      diff.kept++
      db.update(schema.assetReviewItems).set({
        runId,
        segmentNo: draft.segmentNo,
        narrationExcerpt: draft.narrationExcerpt,
        infoPoint: draft.infoPoint,
        needDesc: draft.needDesc,
        fingerprint: draft.fingerprint,
        updatedAt: ts,
      }).where(eq(schema.assetReviewItems.id, fallback.id)).run()
      continue
    }

    const res = db.insert(schema.assetReviewItems).values({
      episodeId,
      runId,
      segmentNo: draft.segmentNo,
      narrationExcerpt: draft.narrationExcerpt,
      infoPoint: draft.infoPoint,
      needKind: draft.needKind,
      needDesc: draft.needDesc,
      status: draft.status,
      assetKind: draft.assetKind,
      assetId: draft.assetId,
      semanticId: draft.semanticId,
      reason: draft.reason,
      decidedAt: draft.status === 'missing' ? null : ts,
      fingerprint: draft.fingerprint,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    diff.added++
    diff.changed_item_ids.push(Number(res.lastInsertRowid))
  }

  // 本次有段落失败时 `keepUnmatched`：失败段的条目不在 drafts 里，删掉就等于把「还缺素材」
  // 悄悄抹平，强门禁会被错误解锁。宁可留下陈旧条目，也不能凭一次残缺的对照放行。
  if (!opts.keepUnmatched) {
    for (const row of existing) {
      if (claimed.has(row.id)) continue
      db.delete(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, row.id)).run()
      diff.removed++
      diff.changed_item_ids.push(row.id)
    }
  }
  return diff
}

// ─── 状态重算 / 失效事件 ─────────────────────────────────────

function isDocumentaryEpisode(episodeId: number): { ok: boolean; dramaId: number } {
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!ep) return { ok: false, dramaId: 0 }
  return { ok: resolveDramaProjectType(ep.dramaId) === 'documentary', dramaId: ep.dramaId }
}

export function assetReviewCounts(episodeId: number): Record<ReviewItemStatus | 'total', number> {
  const rows = db.select().from(schema.assetReviewItems)
    .where(eq(schema.assetReviewItems.episodeId, episodeId)).all()
  const counts = { total: rows.length, missing: 0, have: 0, added: 0, ignored: 0, not_needed: 0 }
  for (const row of rows) {
    const key = row.status as ReviewItemStatus
    if (key in counts) counts[key]++
  }
  return counts
}

/** 写 `episodes.asset_review_status`（剧情项目恒不写）；返回落库后的状态 */
export async function recomputeAssetReviewStatus(episodeId: number): Promise<AssetReviewStatus> {
  if (!isDocumentaryEpisode(episodeId).ok) return 'none'
  const counts = assetReviewCounts(episodeId)
  const running = !!await findActiveTextTask(episodeId, 'asset_review')
  const latest = await findLatestTextTask(episodeId, 'asset_review')
  const progress = parseTextTaskParams(latest?.params)?.progress
  const status = computeReviewStatus({
    running,
    total: counts.total,
    missing: counts.missing,
    // 最近一次对照有失败段 → 清单不完整，门禁保持上锁（处置剩余条目也解不开）
    incomplete: !!latest && Number(progress?.failed || 0) > 0,
  })
  await db.update(schema.episodes)
    .set({ assetReviewStatus: status, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
  return status
}

export function readStaleReasons(raw: string | null | undefined): StaleReason[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is StaleReason => (STALE_REASONS as readonly string[]).includes(String(x)))
      : []
  } catch { return [] }
}

/**
 * 资产库变更的统一入口：只追加 `asset_review_stale_reasons`（去重），**不动 status**。
 * 清单还没通过（`none`/`running`/`pending`）时不记——那时横幅没有意义，门禁本来就锁着。
 */
export async function markAssetReviewStale(episodeId: number, reason: StaleReason): Promise<void> {
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!ep || resolveDramaProjectType(ep.dramaId) !== 'documentary') return
  if (ep.assetReviewStatus !== 'passed') return
  const reasons = readStaleReasons(ep.assetReviewStaleReasons)
  if (reasons.includes(reason)) return
  await db.update(schema.episodes)
    .set({ assetReviewStaleReasons: JSON.stringify([...reasons, reason]), updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
}

async function clearStaleReasons(episodeId: number): Promise<void> {
  await db.update(schema.episodes)
    .set({ assetReviewStaleReasons: null, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
}

/**
 * 绑定目标消失是**硬退化**，不是提示：资产被软删 / 取消关联 / `faithful` 被关掉 /
 * 语义条目被删，相关条目一律回 `missing` 并清空绑定，门禁随之重新上锁。
 */
export async function revalidateAssetReviewBindings(episodeId: number): Promise<number> {
  const rows = db.select().from(schema.assetReviewItems)
    .where(eq(schema.assetReviewItems.episodeId, episodeId)).all()
    .filter(row => row.assetId && (row.status === 'have' || row.status === 'added'))
  if (!rows.length) return 0

  const assets = loadReviewAssets(episodeId)
  let degraded = 0
  for (const row of rows) {
    const asset = assets.find(a => a.kind === row.assetKind && a.id === row.assetId)
    const stillValid = !!asset && needKindAccepts(row.needKind, asset)
    const semanticValid = !row.semanticId || !asset
      || semanticEntries(asset.semantics).some(e => e.id === row.semanticId)
    if (stillValid && semanticValid) continue
    if (stillValid && !semanticValid) {
      // 资产还在、只是那条语义条目没了：降为资产级绑定，不整条退化
      db.update(schema.assetReviewItems).set({ semanticId: null, updatedAt: now() })
        .where(eq(schema.assetReviewItems.id, row.id)).run()
      continue
    }
    db.update(schema.assetReviewItems).set({
      status: 'missing', assetKind: null, assetId: null, semanticId: null,
      reason: null, decidedAt: null, updatedAt: now(),
    }).where(eq(schema.assetReviewItems.id, row.id)).run()
    degraded++
  }
  if (degraded) await recomputeAssetReviewStatus(episodeId)
  return degraded
}

/** 某个资产涉及的全部剧集：本集关联表 ∪ 已把它绑进清单的剧集（删资产时关联表可能先被清） */
function episodesTouchingAsset(kind: AssetKind, assetId: number): number[] {
  const linked = kind === 'character'
    ? db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.characterId, assetId)).all().map(r => r.episodeId)
    : kind === 'scene'
      ? db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.sceneId, assetId)).all().map(r => r.episodeId)
      : db.select().from(schema.episodeProps).where(eq(schema.episodeProps.propId, assetId)).all().map(r => r.episodeId)
  const bound = db.select().from(schema.assetReviewItems)
    .where(and(eq(schema.assetReviewItems.assetKind, kind), eq(schema.assetReviewItems.assetId, assetId)))
    .all().map(r => r.episodeId)
  return [...new Set([...linked, ...bound])]
}

/**
 * 资产级事件的统一出口（建议 4）：按关联表反查全部剧集，逐集先校验绑定再记失效理由。
 * 关联 / 取消关联这类本集事件由调用方直接给 episodeId。
 */
export async function onAssetLibraryChanged(kind: AssetKind, assetId: number, reason: StaleReason): Promise<void> {
  for (const episodeId of episodesTouchingAsset(kind, assetId)) {
    if (!isDocumentaryEpisode(episodeId).ok) continue
    await revalidateAssetReviewBindings(episodeId)
    await markAssetReviewStale(episodeId, reason)
  }
}

/** 本集资产关联 / 取消关联：先校验绑定（取消关联会让绑定失效），再记横幅理由 */
export async function onEpisodeAssetLinkChanged(episodeId: number, reason: StaleReason): Promise<void> {
  if (!isDocumentaryEpisode(episodeId).ok) return
  await revalidateAssetReviewBindings(episodeId)
  await markAssetReviewStale(episodeId, reason)
}

/**
 * 资产被软删 / 证据标记被关掉：绑定目标没了属于**硬退化**，不记横幅理由
 * （横幅是「已通过但资产变了」的提示，这里是直接把门禁重新锁上）。
 */
export async function onAssetRemoved(kind: AssetKind, assetId: number): Promise<void> {
  for (const episodeId of episodesTouchingAsset(kind, assetId)) {
    if (isDocumentaryEpisode(episodeId).ok) await revalidateAssetReviewBindings(episodeId)
  }
}

// ─── 对照任务 ───────────────────────────────────────────────

export interface StartAssetReviewResult {
  started: boolean
  reason?: 'not_documentary' | 'running' | 'empty_script'
  taskId?: number
}

export async function startAssetReview(
  episodeId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<StartAssetReviewResult> {
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!ep) throw new AssetReviewError('not_found', '剧集不存在', 404)
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') {
    return { started: false, reason: 'not_documentary' }
  }
  if (await findActiveTextTask(episodeId, 'asset_review')) return { started: false, reason: 'running' }

  const { texts, auto } = splitNarrationSegments(ep.scriptContent || ep.content)
  if (!texts.length) return { started: false, reason: 'empty_script' }

  const stage = await resolveStageModel('asset_review', opts)
  const taskId = await createTextTask({
    kind: 'asset_review',
    episodeId,
    dramaId: ep.dramaId,
    prompt: `对照旁白稿清点本集素材（${texts.length} 段）`,
    stageModel: stage,
    progress: { completed: 0, failed: 0, total: texts.length },
    retryOf: opts.retryOf,
  })
  await patchTextTaskParams(taskId, { auto_segmented: auto })
  await recomputeAssetReviewStatus(episodeId)

  logTaskStart('AssetReview', 'run', { episodeId, segments: texts.length, model: stage.model })
  void runAssetReview(taskId, episodeId, texts, stage)
  return { started: true, taskId }
}

/** 重跑时交给模型的旧条目（让它复用同一措辞，指纹才命中、处置才保得住） */
interface PriorPoint { infoPoint: string; needKind: string }

function buildSegmentPrompt(args: {
  segmentNo: number
  total: number
  text: string
  assets: ReviewAsset[]
  prior: PriorPoint[]
}): string {
  const kindLabel = { character: '角色', scene: '场景', prop: '道具' }
  const lines = args.assets.map((a) => {
    const marks = [kindLabel[a.kind]]
    if (a.faithful) marks.push('证据素材')
    if (a.exposition) marks.push('说明素材')
    const entries = semanticEntries(a.semantics).map(e => e.name)
    const semantics = entries.length ? `；语义条目：${entries.join('、')}` : ''
    return `- ${a.name}（${marks.join(' · ')}${semantics}）`
  })
  // 上一轮清单：条目身份 = 归一化信息点 + need_kind，措辞一改旧行就被判成新条目，
  // 用户上一轮的「已忽略 / 无需素材 / 已绑定」会全部丢失，所以这里要求逐字沿用。
  const prior = args.prior.map(p => `- ${p.infoPoint}（${p.needKind}）`)
  return [
    `# 本集已有素材清单（${args.assets.length} 项，match_name 只能从这里逐字照抄）`,
    lines.length ? lines.join('\n') : '（本集目前没有任何素材）',
    '',
    ...(prior.length
      ? [
        `# 上一轮清单的信息点（${prior.length} 条，全集范围）`,
        prior.join('\n'),
        '',
        '本段如果仍然覆盖上表中的同一个信息点，`info_point` 必须逐字照抄上表的旧措辞'
        + '（即使你认为可以写得更准确），`need_kind` 也保持一致；否则用户上一轮的处置会全部作废。'
        + '只有上表没有的新信息点才写新措辞。',
        '',
      ]
      : []),
    `# 第 ${args.segmentNo} 段旁白（共 ${args.total} 段）`,
    args.text,
    '',
    `只输出这一段的 JSON，segment_no 填 ${args.segmentNo}。`,
  ].join('\n')
}

async function runAssetReview(taskId: number, episodeId: number, texts: string[], stage: StageModel): Promise<void> {
  const progress = { completed: 0, failed: 0, total: texts.length }
  const errors: string[] = []
  const drafts: DraftItem[] = []
  try {
    const skill = await loadSkillDoc('documentary/asset-review', getContentLanguage())
    const assets = loadReviewAssets(episodeId)
    // 合并发生在所有段跑完之后，这里读到的就是「上一轮」的清单
    const prior: PriorPoint[] = db.select().from(schema.assetReviewItems)
      .where(eq(schema.assetReviewItems.episodeId, episodeId)).all()
      .map(row => ({ infoPoint: row.infoPoint, needKind: row.needKind }))

    for (let i = 0; i < texts.length; i++) {
      const segmentNo = i + 1
      const text = texts[i]!
      try {
        const { text: reply } = await callTextChat(stage, buildSegmentPrompt({
          segmentNo, total: texts.length, text, assets, prior,
        }), {
          systemPrompt: skill,
          temperature: 0.2,
          maxTokens: SEGMENT_MAX_TOKENS,
          timeoutMs: SEGMENT_TIMEOUT_MS,
        })
        const parsed = parseModelReply(reply)
        drafts.push(...toDraftItems(segmentNo, text.slice(0, EXCERPT_CHARS), parsed.items, assets))
        progress.completed++
      } catch (err) {
        progress.failed++
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`第 ${segmentNo} 段：${message}`)
        logTaskError('AssetReview', 'segment', { episodeId, segmentNo, error: message })
      }
      await updateTextTaskProgress(taskId, { ...progress })
      logTaskProgress('AssetReview', 'segment', { episodeId, segmentNo, items: drafts.length })
    }

    // 有任何一段失败 = 这次对照不完整：既不删旧条目，也不算 completed，
    // 否则「少了几段」会被当成「这几段没有缺口」而解锁分镜设计。
    const partial = progress.failed > 0
    const diff = mergeDraftItems(episodeId, taskId, drafts, { keepUnmatched: partial })
    await patchTextTaskParams(taskId, { review_diff: diff })
    // 完整跑完才作废旧的「资产库有变更」横幅理由
    if (!partial) await clearStaleReasons(episodeId)
    await finishTextTask(taskId, partial ? 'failed' : 'completed', {
      progress: { ...progress },
      outputText: JSON.stringify(diff),
      errorMsg: errors.length ? errors.join('；').slice(0, 500) : null,
    })
    await recomputeAssetReviewStatus(episodeId)
    logTaskSuccess('AssetReview', 'run', { episodeId, ...diff, failed: progress.failed })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishTextTask(taskId, 'failed', { errorMsg: `资产审核清单失败：${message}`, progress: { ...progress } })
    await recomputeAssetReviewStatus(episodeId)
    logTaskError('AssetReview', 'run', { episodeId, error: message })
  }
}

// ─── 读接口 ─────────────────────────────────────────────────

export interface AssetReviewItemView {
  id: number
  segment_no: number
  info_point: string
  need_kind: NeedKind
  need_desc: string
  status: ReviewItemStatus
  asset_kind: AssetKind | null
  asset_id: number | null
  asset_name: string | null
  semantic_id: string | null
  semantic_name: string | null
  semantics_needs_review: boolean
  reason: string | null
  decided_at: string | null
}

export interface AssetReviewView {
  status: AssetReviewStatus
  auto_segmented: boolean
  /** 最近一次对照任务；`diff` = 那次重新对照保留/新增/删除了多少（任务跑完才有） */
  run: {
    task_id: number
    status: 'running' | 'done' | 'error'
    progress: unknown
    error: string | null
    diff: ReviewRunDiff | null
  } | null
  counts: Record<ReviewItemStatus | 'total', number>
  stale: { stale: boolean; reasons: StaleReason[] }
  segments: {
    segment_no: number
    narration_excerpt: string
    counts: { total: number; missing: number; needs_review: number }
    items: AssetReviewItemView[]
  }[]
}

function itemView(row: ReviewItemRow, assets: ReviewAsset[]): AssetReviewItemView {
  const asset = row.assetId ? assets.find(a => a.kind === row.assetKind && a.id === row.assetId) ?? null : null
  const entries = asset ? semanticEntries(asset.semantics) : []
  const entry = row.semanticId ? entries.find(e => e.id === row.semanticId) ?? null : null
  return {
    id: row.id,
    segment_no: row.segmentNo,
    info_point: row.infoPoint,
    need_kind: row.needKind as NeedKind,
    need_desc: row.needDesc,
    status: row.status as ReviewItemStatus,
    asset_kind: (row.assetKind as AssetKind | null) ?? null,
    asset_id: row.assetId ?? null,
    asset_name: asset?.name ?? null,
    semantic_id: row.semanticId ?? null,
    semantic_name: entry?.name ?? null,
    // 绑到具体条目就看那条；只绑到资产则看整张图还有没有待修正条目
    semantics_needs_review: entry ? entry.needsReview : entries.some(e => e.needsReview),
    reason: row.reason ?? null,
    decided_at: row.decidedAt ?? null,
  }
}

export async function getAssetReview(episodeId: number): Promise<AssetReviewView> {
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!ep) throw new AssetReviewError('not_found', '剧集不存在', 404)
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') {
    throw new AssetReviewError('not_documentary', '资产审核清单只用于纪录片项目')
  }

  const rows = db.select().from(schema.assetReviewItems)
    .where(eq(schema.assetReviewItems.episodeId, episodeId))
    .orderBy(asc(schema.assetReviewItems.segmentNo), asc(schema.assetReviewItems.id)).all()
  const assets = loadReviewAssets(episodeId)
  const task = await findLatestTextTask(episodeId, 'asset_review')
  const params = task ? parseTextTaskParams(task.params) : null

  const segments: AssetReviewView['segments'] = []
  for (const row of rows) {
    const view = itemView(row, assets)
    let group = segments.find(s => s.segment_no === row.segmentNo)
    if (!group) {
      group = {
        segment_no: row.segmentNo,
        narration_excerpt: row.narrationExcerpt,
        counts: { total: 0, missing: 0, needs_review: 0 },
        items: [],
      }
      segments.push(group)
    }
    group.items.push(view)
    group.counts.total++
    if (view.status === 'missing') group.counts.missing++
    if (view.semantics_needs_review && view.asset_id) group.counts.needs_review++
  }

  const reasons = readStaleReasons(ep.assetReviewStaleReasons)
  return {
    status: (ep.assetReviewStatus as AssetReviewStatus) || 'none',
    auto_segmented: params?.auto_segmented === true,
    run: task
      ? {
        task_id: task.id,
        status: textTaskOutcome(task.status),
        progress: params?.progress ?? null,
        error: task.errorMsg ?? null,
        diff: (params?.review_diff as ReviewRunDiff | undefined) ?? null,
      }
      : null,
    counts: assetReviewCounts(episodeId),
    stale: { stale: reasons.length > 0, reasons },
    segments,
  }
}

// ─── 处置 ───────────────────────────────────────────────────

export interface UpdateItemPatch {
  status: ReviewItemStatus
  asset_kind?: string | null
  asset_id?: number | null
  semantic_id?: string | null
  reason?: string | null
}

export async function updateAssetReviewItem(itemId: number, patch: UpdateItemPatch): Promise<AssetReviewItemView> {
  const row = db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, itemId)).get()
  if (!row) throw new AssetReviewError('not_found', '清单条目不存在', 404)
  const status = patch.status
  if (!(REVIEW_ITEM_STATUSES as readonly string[]).includes(status)) {
    throw new AssetReviewError('bad_status', `status 必须是 ${REVIEW_ITEM_STATUSES.join(' / ')}`)
  }
  if (!canTransitionStatus(row.status as ReviewItemStatus, status)) {
    throw new AssetReviewError('bad_transition', `不能从 ${row.status} 改成 ${status}`)
  }

  const ts = now()
  const next: Partial<ReviewItemRow> = {
    status, assetKind: null, assetId: null, semanticId: null, reason: null,
    decidedAt: status === 'missing' ? null : ts, updatedAt: ts,
  }

  if (status === 'have' || status === 'added') {
    const kind = String(patch.asset_kind || '')
    const assetId = Number(patch.asset_id)
    if (!['character', 'scene', 'prop'].includes(kind) || !Number.isInteger(assetId) || assetId <= 0) {
      throw new AssetReviewError('asset_required', '已有 / 已补必须绑定一个本集资产（asset_kind + asset_id）')
    }
    const assets = loadReviewAssets(row.episodeId)
    const asset = assets.find(a => a.kind === kind && a.id === assetId)
    if (!asset) throw new AssetReviewError('asset_not_found', '该资产不存在或未关联到本集')
    if (!needKindAccepts(row.needKind, asset)) {
      throw new AssetReviewError('asset_kind_mismatch', row.needKind === 'prop_faithful'
        ? '该条目需要证据素材：请绑定已标记「忠实原件」的道具'
        : '该资产的类别与条目需要的素材类别不符')
    }
    const semanticId = (patch.semantic_id || '').trim()
    if (semanticId && !semanticEntries(asset.semantics).some(e => e.id === semanticId)) {
      throw new AssetReviewError('semantic_not_found', '该语义条目不存在于所绑定的素材上')
    }
    next.assetKind = asset.kind
    next.assetId = asset.id
    next.semanticId = semanticId || null
  } else if (status === 'ignored') {
    const reason = (patch.reason || '').trim()
    if (reason.length < MIN_REASON_CHARS) {
      throw new AssetReviewError('reason_required', `忽略必须写明理由（至少 ${MIN_REASON_CHARS} 个字）`)
    }
    next.reason = reason
  } else if (status === 'not_needed') {
    next.reason = (patch.reason || '').trim() || '由图层卡片表达'
  }

  db.update(schema.assetReviewItems).set(next).where(eq(schema.assetReviewItems.id, itemId)).run()
  await recomputeAssetReviewStatus(row.episodeId)
  const updated = db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, itemId)).get()!
  return itemView(updated, loadReviewAssets(row.episodeId))
}

// ─── 补齐路径：补提取 / 新建资产回链 ──────────────────────────

const EXTRACT_TARGET_OF: Record<AssetKind, ExtractTarget> = {
  character: 'characters',
  scene: 'scenes',
  prop: 'props',
}

/** 条目 → 补提取时指名道姓的资产名（取 need_desc 的第一个短语，退回信息点原文） */
function extractionNameOf(row: Pick<ReviewItemRow, 'needDesc' | 'infoPoint'>): string {
  const head = row.needDesc.split(/[，,。；;（(]/)[0] || row.infoPoint
  return normalizeAssetName(head) || row.infoPoint
}

export interface ReviewExtractionPlan {
  episodeId: number
  dramaId: number
  target: ExtractTarget
  assetName: string
}

/**
 * 「补提取」的参数（路由据此调 `startSingleAssetExtraction`）。
 * 提取本身不在这里发起：依赖方向只能是 extraction → asset-review（回链钩子），反过来会成环。
 */
export function reviewExtractionPlan(itemId: number): ReviewExtractionPlan {
  const row = db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, itemId)).get()
  if (!row) throw new AssetReviewError('not_found', '清单条目不存在', 404)
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId)).get()
  if (!ep) throw new AssetReviewError('not_found', '剧集不存在', 404)
  return {
    episodeId: row.episodeId,
    dramaId: ep.dramaId,
    target: EXTRACT_TARGET_OF[assetKindForNeed(row.needKind) ?? 'prop'],
    assetName: extractionNameOf(row),
  }
}

/**
 * 提取任务结束后的回链（extraction.ts 在任务成功后调用）：
 * 按条目期望的名字在本集资产里找，找到即 `added` + 绑定；找不到保持 `missing`（界面提示提取未产出）。
 */
export async function onReviewExtractionFinished(itemId: number): Promise<void> {
  const row = db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, itemId)).get()
  if (!row || row.status !== 'missing') return
  const asset = resolveAssetByName(loadReviewAssets(row.episodeId), extractionNameOf(row), row.needKind)
  if (!asset) return
  db.update(schema.assetReviewItems).set({
    status: 'added', assetKind: asset.kind, assetId: asset.id, decidedAt: now(), updatedAt: now(),
  }).where(eq(schema.assetReviewItems.id, itemId)).run()
  await recomputeAssetReviewStatus(row.episodeId)
}

/**
 * 新建资产抽屉带着 `asset_review_item_id` 保存时的自动回链（评审裁决·必须改 3）：
 * 新资产保存成功 → 条目直接置 `added` 并绑定，无需人再点一次。
 */
export async function bindCreatedAssetToReviewItem(itemId: number, kind: AssetKind, assetId: number): Promise<void> {
  const row = db.select().from(schema.assetReviewItems).where(eq(schema.assetReviewItems.id, itemId)).get()
  if (!row) return
  const assets = loadReviewAssets(row.episodeId)
  const asset = assets.find(a => a.kind === kind && a.id === assetId)
  if (!asset) return
  db.update(schema.assetReviewItems).set({
    status: 'added', assetKind: kind, assetId, semanticId: null, reason: null,
    decidedAt: now(), updatedAt: now(),
  }).where(eq(schema.assetReviewItems.id, itemId)).run()
  await recomputeAssetReviewStatus(row.episodeId)
}
