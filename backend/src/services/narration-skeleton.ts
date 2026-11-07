import { isFirstAgentFailureSafe, runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-autoretry.js'

/**
 * 逐镜旁白骨架（Issue #70）—— 纪录片「最终剧本 → 骨架 → 人工确认 → 批量配音 → 实测时长填设计卡」里的第一步。
 *
 * 骨架只管三件事：**顺序、逐字边界、标题**。它不产出任何视觉设计（设计卡、画面描述、提示词都不在这一步），
 * 因为设计必须建立在配音的实测时长之上。
 *
 * 不变量：
 * - 骨架是对最终剧本正文的一次**有序、连续、不重不漏**的分配：各镜旁白按顺序拼接后逐字等于剧本正文；
 * - 每镜旁白非空且 ≤80 个朗读字（TTS 单段硬上限）；
 * - `revision` 由「剧本正文 + 各镜 id/标题/旁白」算出：剧本或骨架任一处变化，确认即失效；
 * - 确认绑定当时的 revision（`episodes.narration_skeleton_revision`），只有相等才算「当前已确认」；
 * - 编辑骨架时**不碰无关镜**：未变化的行连同它们的音频、关键帧、图层段原样保留；
 *   只有文本变化的镜与结构变化（拆/并/删）相邻的镜的设计卡被置为过期；
 * - 存量纪录片集不会被启动迁移改写：只有显式的骨架生成/编辑/确认才会写库。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { consumeStoryboardStopReason } from '../agents/tools/storyboard-tools.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { resolveStageModel } from './ai-stages.js'
import { createTextTask, findActiveTextTask, finishTextTask } from './text-task.js'
import {
  MAX_NARRATION_CHARS,
  narrationCharCount,
  parseNarrationMeta,
  sha256,
} from './narration.js'
import { spokenText } from './narration-markup.js'
import {
  describeNarrationGaps,
  narrationCoverage,
  narrationMatchKey,
  scriptMatchKey,
} from './narration-first.js'
import {
  episodeNarrationCoverage,
  renumberStoryboardsByScript,
} from './storyboard-fill-gaps.js'
import { episodeTtsValidity, type ShotTtsValidity } from './narration-tts-gate.js'
import { toDesignCardStatus, type DesignCardStatus } from './design-card.js'
import { markStale } from './staleness.js'
import { resolveDramaProjectType } from './project-type.js'
import { assertGate } from './workflow-gates.js'

type EpisodeRow = typeof schema.episodes.$inferSelect
type StoryboardRow = typeof schema.storyboards.$inferSelect

export interface SkeletonShot {
  storyboard_id: number
  storyboard_number: number
  title: string | null
  narration_text: string
  narration_chars: number
  tts: { valid: boolean; reason: string | null; message: string | null; duration_ms: number | null }
  design_card_status: DesignCardStatus
  /** 设计卡已确认且当前配音有效 = 本镜可以进入制作 */
  design_ready: boolean
  /** 当前可以填设计卡（有当前有效配音） */
  design_fillable: boolean
  blocked_reason: string | null
}

export interface SkeletonCoverage {
  script_chars: number
  covered_chars: number
  uncovered_chars: number
  gaps: Array<{ start: number; end: number; chars: number; excerpt: string }>
  in_order: boolean
  /** 不是剧本原文的镜头数（改写过的旁白）：>0 时骨架不可确认 */
  not_in_script: number
  complete: boolean
}

export interface SkeletonState {
  episode_id: number
  project_type: 'drama' | 'documentary'
  /** 非纪录片项目没有这一步：enabled=false，其余字段为空壳 */
  enabled: boolean
  confirmed: boolean
  revision: string
  confirmed_revision: string | null
  confirmed_at: string | null
  script_confirmed: boolean
  confirmable: boolean
  blocked_reason: string | null
  coverage: SkeletonCoverage
  tts: { valid: number; invalid: number; total: number }
  shots: SkeletonShot[]
}

export type SkeletonProblemCode =
  | 'empty'
  | 'too_long'
  | 'not_verbatim'
  | 'out_of_order'
  | 'gap'
  | 'unknown_id'
  | 'duplicate_id'
  | 'script_missing'
  | 'no_shots'

export interface SkeletonProblem {
  index: number
  code: SkeletonProblemCode
  message: string
}

export interface SkeletonShotInput {
  id?: number | null
  narration_text: string
  title?: string | null
}

export class SkeletonInvalidError extends Error {
  readonly problems: SkeletonProblem[]
  constructor(problems: SkeletonProblem[]) {
    super(problems[0]?.message || '旁白骨架不合法')
    this.name = 'SkeletonInvalidError'
    this.problems = problems
  }
}

export class SkeletonConflictError extends Error {
  readonly revision: string
  constructor(revision: string) {
    super('旁白骨架已被其他操作改动，请刷新后重试')
    this.name = 'SkeletonConflictError'
    this.revision = revision
  }
}

export class SkeletonNotConfirmedError extends Error {
  constructor(message = '旁白骨架尚未确认（或确认后又发生了变更）：请先在「旁白骨架」里确认当前骨架') {
    super(message)
    this.name = 'SkeletonNotConfirmedError'
  }
}

/** 骨架指纹：剧本正文 + 各镜 id/标题/旁白。任一处变化都会换一个 revision。 */
export function skeletonRevision(script: string | null | undefined, rows: Array<Pick<StoryboardRow, 'id' | 'title' | 'narrationText'>>): string {
  const body = rows
    .map(row => `${row.id}\u0001${row.title || ''}\u0001${narrationMatchKey(spokenText(row.narrationText || ''))}`)
    .join('\u0000')
  return sha256(`${scriptMatchKey(script)}\u0002${body}`).slice(0, 16)
}

async function liveStoryboards(episodeId: number): Promise<StoryboardRow[]> {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
}

const EMPTY_COVERAGE: SkeletonCoverage = {
  script_chars: 0,
  covered_chars: 0,
  uncovered_chars: 0,
  gaps: [],
  in_order: true,
  not_in_script: 0,
  complete: false,
}

/** 本集骨架的完整状态（GET / PUT / confirm / unconfirm / generate 共用同一份返回） */
export async function narrationSkeletonState(episodeId: number): Promise<SkeletonState> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const projectType = resolveDramaProjectType(ep.dramaId)
  if (projectType !== 'documentary') {
    return {
      episode_id: episodeId,
      project_type: projectType,
      enabled: false,
      confirmed: false,
      revision: '',
      confirmed_revision: null,
      confirmed_at: null,
      script_confirmed: true,
      confirmable: false,
      blocked_reason: null,
      coverage: EMPTY_COVERAGE,
      tts: { valid: 0, invalid: 0, total: 0 },
      shots: [],
    }
  }

  const rows = await liveStoryboards(episodeId)
  const script = ep.scriptContent || ep.content
  const raw = narrationCoverage(script, rows.map(sb => sb.narrationText))
  // 覆盖完整性以**严格分配**为准：narrationCoverage 为了容忍标点差异会忽略 8 字以内的缝隙，
  // 确认骨架不能吃这个容差——漏掉一个词同样是漏。
  const strict = validateSkeletonAllocation(script, rows.map(sb => ({ id: sb.id, narration_text: sb.narrationText || '' })))
  const coverage: SkeletonCoverage = {
    script_chars: raw.script_chars,
    covered_chars: raw.covered_chars,
    uncovered_chars: raw.uncovered_chars,
    gaps: raw.gaps,
    in_order: raw.in_order,
    not_in_script: raw.not_in_script.length,
    complete: raw.script_chars > 0 && strict.problems.length === 0,
  }
  const revision = skeletonRevision(script, rows)
  const confirmedRevision = ep.narrationSkeletonRevision ?? null
  // 「当前已确认」= 确认过的 revision 仍是当前 revision，而且最终旁白稿仍处于已确认状态、
  // 分配仍然严格成立。撤销剧本确认（即使正文字节没变）同样要收回骨架确认。
  const confirmed = Boolean(confirmedRevision)
    && confirmedRevision === revision
    && Boolean(ep.scriptConfirmedAt)
    && coverage.complete

  const validity = await episodeTtsValidity(episodeId, { rows, episode: ep })
  let valid = 0
  const shots: SkeletonShot[] = rows.map((sb) => {
    const tts: ShotTtsValidity | undefined = validity.get(sb.id)
    if (tts?.valid) valid++
    const status = toDesignCardStatus(sb.designCardStatus)
    return {
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      title: sb.title ?? null,
      narration_text: sb.narrationText || '',
      narration_chars: narrationCharCount(sb.narrationText),
      tts: {
        valid: tts?.valid === true,
        reason: tts?.reason ?? null,
        message: tts?.message ?? null,
        duration_ms: tts?.duration_ms ?? null,
      },
      design_card_status: status,
      design_ready: status === 'confirmed' && tts?.valid === true,
      design_fillable: tts?.valid === true,
      blocked_reason: tts?.valid === true ? null : (tts?.message ?? '本镜还没有当前有效配音'),
    }
  })

  const blocked = skeletonBlockReason(ep, rows, coverage, strict.problems)
  return {
    episode_id: episodeId,
    project_type: projectType,
    enabled: true,
    confirmed,
    revision,
    confirmed_revision: confirmedRevision,
    confirmed_at: ep.narrationSkeletonConfirmedAt ?? null,
    script_confirmed: Boolean(ep.scriptConfirmedAt),
    confirmable: blocked === null,
    blocked_reason: blocked,
    coverage,
    tts: { valid, invalid: shots.length - valid, total: shots.length },
    shots,
  }
}

/**
 * 拆镜/补镜任务的验收口径（#70）：与「能否确认骨架」同一套严格分配校验——
 * 缺口、重复领取、顺序颠倒、改写原文都算不合法。非纪录片项目恒为空。
 * 只判定，不回滚：已拆出来的行保留，让人按问题清单显式修边界。
 */
export async function skeletonAcceptanceProblems(episodeId: number): Promise<SkeletonProblem[]> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || resolveDramaProjectType(ep.dramaId) !== 'documentary') return []
  const rows = await liveStoryboards(episodeId)
  if (!rows.length) return [{ index: 0, code: 'no_shots', message: '本次拆分没有产出任何分镜' }]
  return validateSkeletonAllocation(
    ep.scriptContent || ep.content,
    rows.map(sb => ({ id: sb.id, narration_text: sb.narrationText || '' })),
  ).problems
}

/** 可以确认骨架吗？不能就返回具体原因 */
function skeletonBlockReason(
  ep: EpisodeRow,
  rows: StoryboardRow[],
  coverage: SkeletonCoverage,
  problems: SkeletonProblem[],
): string | null {
  if (!ep.scriptConfirmedAt) return '最终旁白稿尚未确认：请先在「剧本」步骤确认旁白稿'
  if (!rows.length) return '本集还没有任何分镜旁白：请先生成旁白骨架'
  const empty = rows.find(sb => !(sb.narrationText || '').trim())
  if (empty) return `#${String(empty.storyboardNumber).padStart(2, '0')} 还没有旁白文本：纪录片每一镜都必须承载一段旁白`
  const tooLong = rows.find(sb => narrationCharCount(sb.narrationText) > MAX_NARRATION_CHARS)
  if (tooLong) return `#${String(tooLong.storyboardNumber).padStart(2, '0')} 的旁白 ${narrationCharCount(tooLong.narrationText)} 字，超过语音合成单段上限 ${MAX_NARRATION_CHARS} 字：请拆成相邻两镜`
  if (coverage.not_in_script > 0) return `有 ${coverage.not_in_script} 镜的旁白不是剧本正文里的原文（被改写过）：骨架只能切分，不能改字，请改回原文再确认`
  if (!coverage.in_order) return '各镜旁白的顺序与剧本正文不一致：请调整边界，让骨架按剧本顺序逐字覆盖'
  if (coverage.uncovered_chars > 0) return `剧本还有 ${coverage.uncovered_chars} 字没有被任何一镜领走（${describeNarrationGaps(coverage.gaps)}）：请补齐后再确认`
  // 严格分配剩下的问题（含 8 字以内的短缺口）：原样报给人，不吞容差
  if (problems.length) return problems[0]!.message
  return null
}

/** 确认骨架：绑定当前 revision。覆盖不全 / 有空镜 / 超长镜 / 剧本未确认一律拒绝。 */
export async function confirmNarrationSkeleton(episodeId: number, revision: string): Promise<SkeletonState> {
  const state = await narrationSkeletonState(episodeId)
  if (!state.enabled) throw new Error('只有纪录片项目有旁白骨架这一步')
  if (revision !== state.revision) throw new SkeletonConflictError(state.revision)
  if (state.blocked_reason) throw new Error(state.blocked_reason)
  await db.update(schema.episodes).set({
    narrationSkeletonRevision: state.revision,
    narrationSkeletonConfirmedAt: now(),
    updatedAt: now(),
  }).where(eq(schema.episodes.id, episodeId))
  return narrationSkeletonState(episodeId)
}

/** 撤销确认：批量配音与设计卡填写随即被挡住（已有的音频与卡不动） */
export async function unconfirmNarrationSkeleton(episodeId: number): Promise<SkeletonState> {
  await db.update(schema.episodes).set({
    narrationSkeletonRevision: null,
    narrationSkeletonConfirmedAt: null,
    updatedAt: now(),
  }).where(eq(schema.episodes.id, episodeId))
  return narrationSkeletonState(episodeId)
}

/**
 * 批量配音 / 设计卡填写的硬前置：本集骨架必须是**当前**已确认状态。
 * 剧情项目不受影响。
 */
export async function requireConfirmedSkeleton(episodeId: number): Promise<void> {
  const state = await narrationSkeletonState(episodeId)
  if (!state.enabled || state.confirmed) return
  throw new SkeletonNotConfirmedError(
    state.confirmed_revision
      ? '旁白骨架在确认之后又被改动：请重新确认骨架，再继续配音/填设计卡'
      : '旁白骨架尚未确认：请先在「旁白骨架」里确认当前骨架，再继续配音/填设计卡',
  )
}

interface AllocationSpan {
  index: number
  start: number
  end: number
}

/** 纯函数：一组有序旁白是不是对剧本正文的「不重不漏、顺序一致」分配 */
export function validateSkeletonAllocation(script: string | null | undefined, shots: SkeletonShotInput[]): { problems: SkeletonProblem[]; spans: AllocationSpan[] } {
  const problems: SkeletonProblem[] = []
  const spans: AllocationSpan[] = []
  const scriptKey = scriptMatchKey(script)
  if (!scriptKey) {
    problems.push({ index: 0, code: 'script_missing', message: '本集还没有剧本正文：无法校验旁白骨架' })
    return { problems, spans }
  }
  if (!shots.length) {
    problems.push({ index: 0, code: 'no_shots', message: '旁白骨架至少要有一镜' })
    return { problems, spans }
  }

  let cursor = 0
  shots.forEach((shot, index) => {
    const label = `第 ${index + 1} 镜`
    const text = (shot.narration_text || '').trim()
    if (!text) {
      problems.push({ index, code: 'empty', message: `${label} 的旁白为空：纪录片每一镜都必须承载一段旁白` })
      return
    }
    const chars = narrationCharCount(text)
    if (chars > MAX_NARRATION_CHARS) {
      problems.push({ index, code: 'too_long', message: `${label} 的旁白 ${chars} 字，超过语音合成单段上限 ${MAX_NARRATION_CHARS} 字：请在句界处拆成两镜` })
      return
    }
    const key = narrationMatchKey(spokenText(text))
    const found = scriptKey.indexOf(key, cursor)
    if (found < 0) {
      problems.push(scriptKey.includes(key)
        ? { index, code: 'out_of_order', message: `${label} 的旁白在剧本里出现在前一镜之前：骨架必须按剧本顺序排列` }
        : { index, code: 'not_verbatim', message: `${label} 的旁白不是剧本正文里的原文：骨架只能切分，不能改写文字` })
      return
    }
    if (found > cursor) {
      problems.push({
        index,
        code: 'gap',
        message: `${label} 之前有 ${found - cursor} 字剧本正文没有被任何一镜领走：${scriptKey.slice(cursor, Math.min(found, cursor + 40))}`,
      })
      return
    }
    spans.push({ index, start: found, end: found + key.length })
    cursor = found + key.length
  })

  if (!problems.length && cursor < scriptKey.length) {
    problems.push({
      index: shots.length - 1,
      code: 'gap',
      message: `剧本末尾还有 ${scriptKey.length - cursor} 字没有被任何一镜领走：${scriptKey.slice(cursor, cursor + 40)}`,
    })
  }
  return { problems, spans }
}

/**
 * 保存骨架：按**有序、连续、逐字**的分配重写各镜旁白边界。
 *
 * - 带 `id` = 沿用这一镜（文本没变就一个字段都不写，音频/关键帧/图层段原样保留）；
 * - 不带 `id` = 新镜（拆分产生的那一半）；
 * - 原有的镜没有出现在列表里 = 被合并掉，软删除归档（媒体不删）。
 */
export async function saveNarrationSkeleton(episodeId: number, revision: string, shots: SkeletonShotInput[]): Promise<SkeletonState> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') throw new Error('只有纪录片项目有旁白骨架这一步')

  const rows = await liveStoryboards(episodeId)
  const current = skeletonRevision(ep.scriptContent || ep.content, rows)
  if (revision !== current) throw new SkeletonConflictError(current)

  const byId: Record<number, StoryboardRow> = {}
  for (const row of rows) byId[row.id] = row

  const problems: SkeletonProblem[] = []
  const seen = new Set<number>()
  shots.forEach((shot, index) => {
    const id = shot.id ?? null
    if (id === null || id === undefined) return
    if (!byId[id]) {
      problems.push({ index, code: 'unknown_id', message: `第 ${index + 1} 镜引用的分镜 ${id} 不属于本集（或已被删除）` })
      return
    }
    if (seen.has(id)) {
      problems.push({ index, code: 'duplicate_id', message: `分镜 ${id} 在骨架里出现了两次` })
      return
    }
    seen.add(id)
  })
  const allocation = validateSkeletonAllocation(ep.scriptContent || ep.content, shots)
  problems.push(...allocation.problems)
  // AI 正在写卡的镜不能同时被改边界：否则它会把卡写到一段已经不存在的旁白上
  const busy = rows.filter(sb => seen.has(sb.id) && toDesignCardStatus(sb.designCardStatus) === 'ai_filling')
  if (busy.length) {
    problems.push({
      index: 0,
      code: 'unknown_id',
      message: `#${busy.map(sb => String(sb.storyboardNumber).padStart(2, '0')).join('、')} 的设计卡正在由 AI 填写：请等它结束再调整骨架`,
    })
  }
  if (problems.length) throw new SkeletonInvalidError(problems)

  const ts = now()
  const removed = rows.filter(sb => !seen.has(sb.id))
  const textChanged: number[] = []
  const structural = removed.length > 0
  let maxNumber = rows.reduce((max, sb) => Math.max(max, sb.storyboardNumber), 0)
  const keptOrder: Array<{ id: number; isNew: boolean }> = []

  for (const shot of shots) {
    const text = shot.narration_text.trim()
    const title = shot.title === undefined ? undefined : (shot.title || null)
    const existing = shot.id ? byId[shot.id] : undefined
    if (existing) {
      const changed = (existing.narrationText || '') !== text
      const titleChanged = title !== undefined && (existing.title ?? null) !== title
      if (changed || titleChanged) {
        const meta = parseNarrationMeta(existing.narrationMeta)
        if (changed) meta.text_sha256 = sha256(text)
        await db.update(schema.storyboards).set({
          ...(changed ? { narrationText: text, narrationEnabled: true, narrationMeta: JSON.stringify(meta) } : {}),
          ...(titleChanged ? { title } : {}),
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, existing.id))
      }
      if (changed) textChanged.push(existing.id)
      keptOrder.push({ id: existing.id, isNew: false })
      continue
    }
    maxNumber += 1
    const inserted = await db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: maxNumber,
      title: title ?? null,
      narrationText: text,
      narrationEnabled: true,
      narrationMeta: JSON.stringify({ text_sha256: sha256(text) }),
      continuityBoundary: 'cut',
      duration: 0,
      createdAt: ts,
      updatedAt: ts,
    })
    keptOrder.push({ id: getInsertId(inserted), isNew: true })
  }

  if (removed.length) {
    for (const sb of removed) {
      await db.update(schema.storyboards).set({ deletedAt: ts, updatedAt: ts })
        .where(eq(schema.storyboards.id, sb.id))
    }
  }

  // 受影响范围：文本变了的镜 + 结构变化（拆/并/删）处的相邻镜。无关镜一个字段都不动。
  const affected = new Set<number>(textChanged)
  const inserts = keptOrder.filter(item => item.isNew).map(item => item.id)
  if (inserts.length || structural) {
    keptOrder.forEach((item, index) => {
      if (!item.isNew && !inserts.includes(item.id)) return
      const prev = keptOrder[index - 1]
      const next = keptOrder[index + 1]
      if (prev) affected.add(prev.id)
      if (next) affected.add(next.id)
    })
    for (const sb of removed) {
      const at = rows.findIndex(row => row.id === sb.id)
      const prev = rows[at - 1]
      const next = rows[at + 1]
      if (prev && seen.has(prev.id)) affected.add(prev.id)
      if (next && seen.has(next.id)) affected.add(next.id)
    }
  }
  for (const id of inserts) affected.add(id)
  if (affected.size) {
    await markStale('design_card', [...affected], '旁白骨架的镜头边界已调整：本镜（或相邻衔接）的设计必须按新旁白重审')
  }

  // 编号按剧本位置归位；骨架改动后确认自动失效（revision 变了，confirmed 读出来就是 false）
  await renumberStoryboardsByScript(episodeId)
  return narrationSkeletonState(episodeId)
}

export interface SkeletonGenerateResult {
  started: boolean
  task_id?: number
  reason?: 'not_documentary' | 'running' | 'script_missing'
}

function skeletonPrompt(script: string): string {
  return `请把本集最终剧本正文拆成**逐镜旁白骨架**，只做文本切分，不做任何视觉设计。

规则：
1. 逐字照抄：按剧本顺序把正文切成连续片段，原样写进 narration_text，不改写、不润色、不补字、不丢字。
2. 按句切：只能在句号 / 问号 / 感叹号 / 分号之后切开；每镜 ≤${MAX_NARRATION_CHARS} 个朗读字。
3. 不重不漏：全集 narration_text 顺序拼接后必须逐字等于剧本正文；save_storyboards 返回的 script_coverage.gaps 还有内容就继续补，直到为空。
4. title 写一句话，说明这一镜的主信息点。
5. **本阶段只写 shot_number / narration_text / title / continuity 四项**：设计卡、画面描述、关键帧与视频提示词都属于后面的「按实测配音时长填设计卡」阶段，现在一个字都不要写。

剧本正文：
${script}`
}

/**
 * 发起骨架生成（只拆旁白，不填设计卡）。异步：返回 task_id，进度走任务中心。
 */
export async function startSkeletonGeneration(
  episodeId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<SkeletonGenerateResult> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') return { started: false, reason: 'not_documentary' }
  // 门禁与旧的「拆分分镜」逐字一致（#54 的七步链不变）：旁白稿已确认 + 资产审核清单已通过
  await assertGate(episodeId, 'design')
  const script = (ep.scriptContent || ep.content || '').trim()
  if (!script) return { started: false, reason: 'script_missing' }
  if (await findActiveTextTask(episodeId, 'storyboard_breaker', opts.retryOf)
    || await findActiveTextTask(episodeId, 'storyboard_fill_gaps', opts.retryOf)) {
    return { started: false, reason: 'running' }
  }

  const agent = mastra.getAgent('storyboard_breaker')
  if (!agent) throw new Error('分镜 Agent 不可用')
  const resolved = await resolveStageModel('storyboard_breaker_documentary', opts)
  const message = skeletonPrompt(script)
  const taskId = await createTextTask({
    kind: 'storyboard_breaker',
    episodeId,
    dramaId: ep.dramaId,
    prompt: message,
    stageModel: resolved,
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'storyboard_breaker', args: { episodeId, opts } },
  })
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId: ep.dramaId,
    textTaskId: taskId,
    modelOverride: resolved.model,
    textConfigId: resolved.configId ?? undefined,
    narrationEnabled: ep.narrationEnabled === true,
  })
  const sink = createReasoningSink(taskId)
  logTaskStart('NarrationSkeleton', 'generate', { episodeId, taskId })

  // 骨架是纯文本工作：不附证据图（证据素材属于设计卡阶段）
  void runWithTextTask(taskId, () => runAgent(agent, [{ role: 'user', content: message }], { maxSteps: 20, requestContext }, sink))
    .then(async (result) => {
      await renumberStoryboardsByScript(episodeId)
      // 镜头数硬上限的止损（#57）：连续两批整批被拒就不再让模型重试
      const stop = consumeStoryboardStopReason(episodeId)
      if (stop) {
        await finishTextTask(taskId, 'failed', { errorMsg: stop, outputText: result.text || '' })
        logTaskError('NarrationSkeleton', 'generate', { episodeId, taskId, error: stop })
        return
      }
      // 验收口径与「能否确认骨架」完全一致（#70）：不只看缺口，重复领取、顺序颠倒、
      // 改写原文同样判失败。已拆出来的行保留，让人按问题清单显式修边界。
      const problems = await skeletonAcceptanceProblems(episodeId)
      if (problems.length) {
        const detail = `旁白骨架不合法：${problems.slice(0, 3).map(p => p.message).join('；')}${problems.length > 3 ? `（共 ${problems.length} 处）` : ''}。分镜已保留，请在「旁白骨架」里调整边界或重新生成。`
        await finishTextTask(taskId, 'failed', { errorMsg: detail, outputText: result.text || '' })
        logTaskError('NarrationSkeleton', 'generate', { episodeId, taskId, error: detail })
        return
      }
      await finishTextTask(taskId, 'completed', { outputText: result.text || '' })
      logTaskSuccess('NarrationSkeleton', 'generate', { episodeId, taskId })
    })
    .catch(async (err: unknown) => {
      const detail = err instanceof Error ? err.message : '旁白骨架生成失败'
      await finishTextTask(taskId, 'failed', { errorMsg: detail })
      await requeueFirstModelFailure(taskId, err, isFirstAgentFailureSafe(err))
      logTaskError('NarrationSkeleton', 'generate', { episodeId, taskId, error: detail })
    })

  return { started: true, task_id: taskId }
}
