/**
 * 纪录片工作流门禁（Issue #54）— 步骤解锁的唯一实现
 *
 * 读：`episodeGates()` 给前端步骤栏/进度条，`assertGate()` 给服务端写端点。
 * 写：`confirmScript()` / `unconfirmScript()` / `onScriptChanged()` 是
 *     `episodes.script_confirmed_at` 的唯一写入口（改旁白稿自动取消确认）。
 *
 * 规则逐级传递：上游没解锁，下游一律锁住，不被残留状态绕过；`reasons[step]` 永远写
 * **最靠上**的那个未满足原因，这样 tooltip 的跳转落在真正的阻塞步骤上。
 *
 * 过渡口径（契约 §2，主进程裁决）：
 * - `design.confirmed` 在 R4 落地前读 `storyboards.intent_reviewed`，之后改读 `design_card_status`；
 * - `production.ready` 读 `storyboards.keyframes_confirmed`，R5 改为「本镜启用的段全部 ready」；
 * - `final.fresh` 复用 `compose-state.ts` 的 `exportable`，R7 升到签名 v4。
 *
 * 剧情项目（project_type='drama'）恒全解锁、reasons 为空：行为与 #54 之前逐字一致。
 */
import { and, eq, isNull } from 'drizzle-orm'

import { db, schema } from '../db/index.js'
import { assetReviewCounts, assetReviewGateReason } from './asset-review.js'
import { composeStatesForEpisode } from './compose-state.js'
import { resolveDramaProjectType, type ProjectType } from './project-type.js'
import { now } from '../utils/response.js'
import { markEpisodeDesignCardsStale } from './staleness.js'
import { toDesignCardStatus, type DesignCardStatus } from './design-card.js'
import { segmentsByStoryboard, resolveEpisodeSegmentSpec, layerSegmentIsFresh } from './layer-segment.js'

export const GATE_KEYS = ['assets', 'design', 'production', 'final', 'poster', 'export'] as const

/** 设计卡状态的中文名（逐镜门禁原因文案用） */
export const DESIGN_CARD_STATUS_LABELS: Record<DesignCardStatus, string> = {
  blank: '空白',
  ai_filling: 'AI 填卡中',
  pending: '待确认',
  confirmed: '已确认',
  stale: '已过期',
}
export type GateKey = typeof GATE_KEYS[number]

/** 资产审核清单状态（R2 写值；R1 只读，非 passed 一律当未通过） */
export const ASSET_REVIEW_STATUSES = ['none', 'running', 'pending', 'passed'] as const
export type AssetReviewStatus = typeof ASSET_REVIEW_STATUSES[number]

export interface GateFacts {
  projectType: ProjectType
  script: { confirmed: boolean; confirmed_at: string | null }
  /** `missing` = 还没处置的清单条目数（R2 的 `assetReviewGateReason` 用它组文案） */
  assets: { review_status: AssetReviewStatus; stale_reasons: string[]; missing: number }
  design: { confirmed: number; total: number }
  production: { ready: number; total: number }
  final: { fresh: number; total: number }
}

export interface EpisodeGates extends Omit<GateFacts, 'projectType'> {
  project_type: ProjectType
  unlocked: Record<GateKey, boolean>
  /** 未解锁步骤的中文原因（已解锁的步骤不出现在这里） */
  reasons: Partial<Record<GateKey, string>>
  /** 点锁定步骤应该跳到哪一步去解它（已解锁的步骤不出现在这里） */
  goto: Partial<Record<GateKey, 'script' | 'assets' | 'design' | 'production' | 'final'>>
}

const REASON = {
  script: '旁白稿尚未确认：请在「剧本」步骤点「确认旁白稿」',
  design: '还没有任何一镜的分镜设计被确认：请先在「分镜设计」确认至少一镜',
  production: '还没有任何一镜制作就绪：请先在「分镜制作」完成并确认至少一镜',
  final: '还没有任何一镜的成品是最新的：请先在「视频与成品」合成至少一镜',
} as const

/** 纯函数：事实 → 解锁位与原因。路由/测试都走这里，不另起第二套规则。 */
export function computeGates(facts: GateFacts): EpisodeGates {
  const { projectType, ...rest } = facts
  if (projectType !== 'documentary') {
    return {
      ...rest,
      project_type: projectType,
      unlocked: { assets: true, design: true, production: true, final: true, poster: true, export: true },
      reasons: {},
      goto: {},
    }
  }

  const reasons: EpisodeGates['reasons'] = {}
  const goto: EpisodeGates['goto'] = {}
  const unlocked = {} as Record<GateKey, boolean>

  // 链条上每一环：先看上游有没有解锁（原因与跳转直接继承上游），再看本环自身条件
  const chain: { key: Exclude<GateKey, 'poster'>; prev: GateKey | null; ok: boolean; reason: string; goto: EpisodeGates['goto'][GateKey] }[] = [
    { key: 'assets', prev: null, ok: facts.script.confirmed, reason: REASON.script, goto: 'script' },
    {
      key: 'design', prev: 'assets',
      ok: facts.assets.review_status === 'passed',
      reason: assetReviewGateReason(facts.assets.review_status, facts.assets.missing),
      goto: 'assets',
    },
    { key: 'production', prev: 'design', ok: facts.design.confirmed > 0, reason: REASON.design, goto: 'design' },
    { key: 'final', prev: 'production', ok: facts.production.ready > 0, reason: REASON.production, goto: 'production' },
    { key: 'export', prev: 'final', ok: facts.final.fresh > 0, reason: REASON.final, goto: 'final' },
  ]
  for (const step of chain) {
    const upstreamOk = step.prev === null ? true : unlocked[step.prev]
    if (!upstreamOk) {
      unlocked[step.key] = false
      reasons[step.key] = reasons[step.prev!]
      goto[step.key] = goto[step.prev!]
      continue
    }
    unlocked[step.key] = step.ok
    if (!step.ok) {
      reasons[step.key] = step.reason
      goto[step.key] = step.goto
    }
  }
  // Poster 可选、不入链：跟随资产解锁，不因后续步骤未做而锁住
  unlocked.poster = unlocked.assets
  if (!unlocked.poster) {
    reasons.poster = reasons.assets
    goto.poster = goto.assets
  }
  return { ...rest, project_type: projectType, unlocked, reasons, goto }
}

function parseStaleReasons(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function normalizeAssetReviewStatus(v: unknown): AssetReviewStatus {
  return typeof v === 'string' && (ASSET_REVIEW_STATUSES as readonly string[]).includes(v)
    ? v as AssetReviewStatus
    : 'none'
}

/** 本集的门禁事实；剧集不存在返回 null */
export async function episodeGateFacts(episodeId: number): Promise<GateFacts | null> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return null
  const projectType = resolveDramaProjectType(ep.dramaId)
  const rows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))

  let fresh = 0
  if (projectType === 'documentary' && rows.length) {
    // 成品新鲜度与导出预检同源（compose-state 的 exportable），不另算签名
    const states = await composeStatesForEpisode(episodeId, { rows, episode: ep })
    fresh = states.filter(item => item.exportable).length
  }
  let productionReady = rows.filter(sb => sb.keyframesConfirmed === true).length
  if (projectType === 'documentary') {
    const segments = await segmentsByStoryboard(rows.map(sb => sb.id))
    const spec = await resolveEpisodeSegmentSpec(episodeId)
    productionReady = rows.filter(sb => {
      if (sb.designCardStatus !== 'confirmed' || !sb.combo) return false
      const segment = segments.get(sb.id)
      const layerReady = Boolean(segment && layerSegmentIsFresh(segment, spec))
      if (sb.combo === 'A') return layerReady
      if (sb.combo === 'B') return sb.keyframesConfirmed === true
      return layerReady && sb.keyframesConfirmed === true
    }).length
  }

  return {
    projectType,
    script: { confirmed: !!ep.scriptConfirmedAt, confirmed_at: ep.scriptConfirmedAt ?? null },
    assets: {
      review_status: normalizeAssetReviewStatus(ep.assetReviewStatus),
      stale_reasons: parseStaleReasons(ep.assetReviewStaleReasons),
      missing: projectType === 'documentary' ? assetReviewCounts(episodeId).missing : 0,
    },
    design: { confirmed: rows.filter(sb => sb.designCardStatus === 'confirmed').length, total: rows.length },
    production: { ready: productionReady, total: rows.length },
    final: { fresh, total: rows.length },
  }
}

export async function episodeGates(episodeId: number): Promise<EpisodeGates | null> {
  const facts = await episodeGateFacts(episodeId)
  return facts ? computeGates(facts) : null
}

/** 门禁未通过：由 `src/index.ts` 的全局 onError 统一转成 400 `{error, gate, reason}` */
export class GateBlockedError extends Error {
  readonly gate: GateKey
  readonly reason: string
  constructor(gate: GateKey, reason: string) {
    super(reason)
    this.name = 'GateBlockedError'
    this.gate = gate
    this.reason = reason
  }
}

/** 服务端拦截入口：未解锁即抛 GateBlockedError（剧情项目恒放行） */
export async function assertGate(episodeId: number, gate: GateKey): Promise<void> {
  const gates = await episodeGates(episodeId)
  if (!gates) throw new GateBlockedError(gate, '剧集不存在')
  if (gates.unlocked[gate]) return
  throw new GateBlockedError(gate, gates.reasons[gate] || '该步骤尚未解锁')
}

/**
 * 逐镜的「分镜制作」解锁事实（Issue #58）：本镜设计卡已确认即可制作。
 * 剧情项目恒解锁（它们没有设计卡）；页面级入口仍由 `episodeGates().unlocked.production` 决定。
 * 与 `assertGate` 不同，这里**只回答本镜**，不因同集别的镜没确认而锁住。
 */
export async function productionGateReason(
  episodeId: number,
  shot: { storyboardId: number; status: DesignCardStatus; number?: number },
): Promise<{ unlocked: boolean; reason: string | null }> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return { unlocked: false, reason: '剧集不存在' }
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') return { unlocked: true, reason: null }
  if (shot.status === 'confirmed') return { unlocked: true, reason: null }
  const label = shot.number ? `#${String(shot.number).padStart(2, '0')}` : `#${shot.storyboardId}`
  return {
    unlocked: false,
    reason: `先确认 ${label} 的设计卡：本镜的设计卡状态是「${DESIGN_CARD_STATUS_LABELS[shot.status]}」，未确认前不能保存/渲染图层段或生成关键帧`,
  }
}

/** 逐镜「分镜制作」门禁：图层段保存/渲染、关键帧生成都要先过它（契约 §2） */
export async function assertShotGate(storyboardId: number, gate: GateKey = 'production'): Promise<void> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new GateBlockedError(gate, '分镜不存在')
  const shot = {
    storyboardId: sb.id,
    status: toDesignCardStatus(sb.designCardStatus),
    number: sb.storyboardNumber,
  }
  const result = await productionGateReason(sb.episodeId, shot)
  if (result.unlocked) return
  throw new GateBlockedError(gate, result.reason || '该步骤尚未解锁')
}


/**
 * 确认旁白稿；旁白稿为空返回 false（路由据此回 400）。
 * 剧情项目没有这一步：列值一律保持 NULL（它们恒全解锁，写了也只是脏数据），直接按成功返回。
 */
export async function confirmScript(episodeId: number): Promise<boolean> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return false
  const script = (ep.scriptContent || ep.content || '').trim()
  if (!script) return false
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') return true
  await db.update(schema.episodes)
    .set({ scriptConfirmedAt: now(), updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
  return true
}

export async function unconfirmScript(episodeId: number): Promise<void> {
  await db.update(schema.episodes)
    .set({ scriptConfirmedAt: null, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
}

/**
 * 旁白稿/剧本正文发生实际变化时的唯一钩子（事件名 `script_changed`）：
 * 取消剧本确认，并把本集设计卡全部置为 `stale`（#57）——旁白变了，每镜的信息点、
 * 预算与段计划都要重审。过期写入走 `services/staleness.ts` 单入口。
 */
export async function onScriptChanged(episodeId: number, reason: string): Promise<void> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || resolveDramaProjectType(ep.dramaId) !== 'documentary') return
  const staled = await markEpisodeDesignCardsStale(episodeId, 'script_changed')
  if (!ep.scriptConfirmedAt) {
    if (staled) console.log(`📝 script_changed(${episodeId})：${reason} → ${staled} 镜设计卡已置为过期`)
    return
  }
  await unconfirmScript(episodeId)
  console.log(`📝 script_changed(${episodeId})：${reason} → 旁白稿确认已自动取消${staled ? `，${staled} 镜设计卡已置为过期` : ''}`)
}

/** 一次性升级迁移的标记键（app_settings）：跑过之后永远不再回填 */
const SCRIPT_CONFIRM_BACKFILL_KEY = 'workflow_gates.script_confirm_backfilled'

/**
 * 存量纪录片集的**一次性升级迁移**（契约 §2）：升级前就已经拆出分镜的纪录片集视为旁白稿已确认，
 * 否则新门禁会把第一轮产物整个锁死。没有分镜的集保持未确认；剧情集一律不动。
 *
 * 只在首次升级时跑一次，之后由 app_settings 的标记拦住：用户随后改稿/取消确认的集
 * **绝不能**被下一次重启重新确认。
 */
export async function backfillScriptConfirmation(): Promise<number> {
  const marker = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, SCRIPT_CONFIRM_BACKFILL_KEY))
    .get()
  if (marker) return 0

  const episodes = await db.select().from(schema.episodes).where(isNull(schema.episodes.deletedAt))
  let filled = 0
  for (const ep of episodes) {
    if (ep.scriptConfirmedAt) continue
    if (resolveDramaProjectType(ep.dramaId) !== 'documentary') continue
    const rows = await db.select().from(schema.storyboards)
      .where(and(eq(schema.storyboards.episodeId, ep.id), isNull(schema.storyboards.deletedAt)))
    if (!rows.length) continue
    await db.update(schema.episodes)
      .set({ scriptConfirmedAt: ep.updatedAt || now() })
      .where(eq(schema.episodes.id, ep.id))
    filled++
  }
  db.insert(schema.appSettings)
    .values({ key: SCRIPT_CONFIRM_BACKFILL_KEY, value: now(), updatedAt: now() })
    .onConflictDoNothing()
    .run()
  if (filled > 0) console.log(`📝 已回填 ${filled} 个存量纪录片集的旁白稿确认（一次性升级迁移，已有分镜）`)
  return filled
}
