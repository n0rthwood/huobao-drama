/**
 * 每镜融合（视频 + 旁白 + 烧录字幕）的**唯一输入事实来源**（Issue #42）。
 *
 * 这里组装一次输入，四条链路共用同一份结果：
 * 1. 真正执行合成（`shot-compose.ts`）；
 * 2. 分镜列表的 `compose_state`；
 * 3. 批量融合预览与执行前复查；
 * 4. 最终拼接导出的就绪校验。
 *
 * 口径要点：
 * - 签名带格式版本。版本对不上的旧记录只能判「无法比较（unknown）」，
 *   绝不能无条件回填成「最新」，也不能靠删 warning 绕过。
 * - 快照只收录**真正影响产出**的输入：媒体身份（uuid 文件名）、烧录状态、
 *   旁白文本哈希、生效的匹配参数、生效的转场偏移 T。
 *   纯画面镜头不混旁白也不做偏移，于是文本/音频/字幕/T 都不进它的快照——
 *   改这些不该让一条纯画面成片凭空过期。
 * - 转场 T 取**当前采用的那条视频**对应任务里的 T，而不是「最近一次视频任务」：
 *   新建或失败的视频任务不改变已采用画面里烧进去的转场，不应让成片失效。
 * - 依赖检查一律看真实文件：URL 有值不等于文件在、字幕文件存在不等于里面有字幕。
 */
import fs from 'fs'
import path from 'path'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { mediaFacts, mediaFactsAll, statMedia } from './media-probe.js'
import { parseTransitionReview } from './transition.js'
import { parseSrt } from './subtitle.js'
import {
  ComposeBlockedError,
  planCompose,
  resolveComposeFit,
  type ComposeFit,
  type ComposePlan,
  type FitMode,
} from './narration-fit.js'
import {
  narrationStatus,
  parseNarrationMeta,
  sha256,
  type ComposeClipPart,
  type ComposeInputParts,
  type NarrationMeta,
  type NarrationStatus,
} from './narration.js'
import {
  getLayerSegment,
  layerSegmentIsFresh,
  resolveEpisodeSegmentSpec,
  segmentPositionOfCombo,
  segmentsByStoryboard,
  type LayerSegment,
  type SegmentSpec,
} from './layer-segment.js'
import { findActiveTextTask, parseTextTaskParams } from './text-task.js'
import { shotMaxSeconds } from './shot-duration.js'
import { resolveDramaProjectType } from './project-type.js'
import { toCombo } from './design-card.js'
import { junctionFrameOf } from './junction-frame.js'
import { GateBlockedError } from './workflow-gates.js'

export type StoryboardRow = typeof schema.storyboards.$inferSelect
export type EpisodeRow = typeof schema.episodes.$inferSelect

/**
 * 输入快照格式版本。
 * 1 = #30/#31 的无版本签名（不含生效 T，匹配参数键口径也不同）→ 一律判 unknown。
 * 2 = #42：video/audio/subtitle/burned/text/fit/T。
 * 3 = #50：旧确定性片段快照（读取比较时自然判过期，不迁移/回填）。
 * 4 = #60：显式段组合、图层段、生成版本、衔接帧；无 combo 的剧情镜仍为 v2。
 */
export const COMPOSE_SIGNATURE_VERSION = 4

export type ComposeStateStatus =
  | 'disabled'
  | 'missing'
  | 'changed'
  | 'unchanged'
  | 'unknown'
  | 'blocked'
  | 'skipped'
  | 'excluded'

/** 依赖是否**真的可用**（文件在、字幕有内容），不是 URL 有没有值 */
export interface ComposeInputAvailability {
  video: boolean
  audio: boolean
  subtitle: boolean
  pure_visual: boolean
}

export interface ComposeStateItem {
  storyboard_id: number
  storyboard_number: number
  title: string
  status: ComposeStateStatus
  /** 批量预览里可否勾选（阻断/进行中不可勾） */
  selectable: boolean
  /** 默认勾选：未合成、输入已变化 */
  checked: boolean
  /** 可直接用于最终拼接：当前成片与当前输入一致且文件在 */
  exportable: boolean
  reason: string | null
  change_reasons: string[]
  /** 当前输入算出的签名；无法组装（阻断）或本集关闭旁白时为 null */
  signature: string | null
  plan: ComposePlan | null
  inputs: ComposeInputAvailability
  composed_video_url: string | null
}

export function toAbsPath(relativePath: string): string {
  const resolved = path.resolve(path.isAbsolute(relativePath) ? relativePath : relativePath.startsWith('static/') ? path.join(DATA_ROOT, relativePath) : path.join(STORAGE_ROOT, relativePath))
  const roots = [path.resolve(DATA_ROOT), path.resolve(STORAGE_ROOT)]
  if (!roots.some(root => resolved.startsWith(root + path.sep))) throw new Error('媒体路径必须位于本项目数据目录内')
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved)
    if (!roots.some(root => fs.existsSync(root) && real.startsWith(fs.realpathSync(root) + path.sep))) throw new Error('媒体路径不能指向项目数据目录之外')
  }
  return resolved
}

/** 片段分项的稳定串：没有片段为空串，有片段时路径与渲染签名都参与 */
function clipKey(part: ComposeClipPart | null | undefined): string {
  return part ? `${part.src}@${part.signature}` : ''
}

/** Documentary combos use v4; legacy drama keeps its byte-identical v2 digest. */
export function composeSignatureVersionOf(parts: ComposeInputParts): number {
  return parts.combo ? COMPOSE_SIGNATURE_VERSION : 2
}

export function composeSignatureOf(parts: ComposeInputParts): string {
  const version = composeSignatureVersionOf(parts)
  const fields = [
    `v${version}`,
    parts.video_src,
    parts.audio_src || '',
    parts.subtitle_src || '',
    parts.burned ? '1' : '0',
    parts.text_sha256,
    parts.fit_key,
    parts.transition_t.toFixed(3),
  ]
  // v2 的摘要输入必须一个字节都不变：多拼三个空串也会换摘要
  if (version === 4) fields.push(parts.combo!, clipKey(parts.layer_segment), parts.junction_hash || '', String(parts.video_task_id ?? ''))
  return sha256(fields.join('\u0000'))
}

/** 逐项对比两份快照，给出人能看懂的变化原因 */
export function describeComposeDiff(current: ComposeInputParts, previous: ComposeInputParts): string[] {
  const reasons: string[] = []
  if (current.combo !== previous.combo) reasons.push('段组合已更改')
  if (clipKey(current.layer_segment) !== clipKey(previous.layer_segment)) reasons.push('图层段已重新渲染')
  if (current.junction_hash !== previous.junction_hash) reasons.push('衔接帧已变化')
  if (current.video_task_id !== previous.video_task_id) reasons.push('生成视频版本已变化')
  if (current.video_src !== previous.video_src) reasons.push('画面视频已更换或重新生成')
  if (current.audio_src !== previous.audio_src) {
    if (!previous.audio_src) reasons.push('本镜新增了旁白配音')
    else if (!current.audio_src) reasons.push('本镜已改为纯画面，不再混入旁白')
    else reasons.push('旁白音频已重新生成')
  }
  if (current.subtitle_src !== previous.subtitle_src) reasons.push('字幕文件已更换')
  if (current.burned !== previous.burned) reasons.push(current.burned ? '改为烧录字幕' : '改为不烧录字幕')
  if (current.text_sha256 !== previous.text_sha256) reasons.push('旁白文本已修改')
  if (current.fit_key !== previous.fit_key) reasons.push('匹配参数已调整（留白 / 倍速 / 音轨模式 / 底音增益）')
  if (Math.abs(current.transition_t - previous.transition_t) > 1e-3) {
    reasons.push(`生效的转场偏移已变化（${previous.transition_t} 秒 → ${current.transition_t} 秒）`)
  }
  if (!reasons.length) reasons.push('输入快照与上次合成不一致')
  return reasons
}

// ─── 转场偏移 T ──────────────────────────────────────────────

type VideoTaskRow = typeof schema.sysTask.$inferSelect

export interface TransitionT {
  t: number
  source: 'task' | 'review' | 'none'
}

/**
 * 本镜生效的 T：优先取**产出当前采用画面**的那条视频任务里的 T。
 * 之后新建/失败的任务不会改变已采用视频里烧进去的转场，所以不参与判定。
 */
function pickTransitionT(
  tasks: VideoTaskRow[],
  videoUrl: string | null | undefined,
  transitionReviewRaw: string | null | undefined,
): TransitionT {
  const adopted = videoUrl ? tasks.find(task => (task.localPath || task.resultUrl) === videoUrl) : null
  if (adopted?.params) {
    try {
      const t = JSON.parse(adopted.params)?.transition?.T
      if (Number.isFinite(t) && Number(t) > 0) return { t: Number(t), source: 'task' }
    } catch { /* 任务参数损坏时继续回落 */ }
  }
  const review = parseTransitionReview(transitionReviewRaw)
  if (review && Number.isFinite(review.seconds) && Number(review.seconds) > 0) {
    return { t: Number(review.seconds), source: 'review' }
  }
  return { t: 0, source: 'none' }
}

export async function resolveTransitionT(
  storyboardId: number,
  transitionReviewRaw: string | null | undefined,
  videoUrl: string | null | undefined,
): Promise<TransitionT> {
  const tasks = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.storyboardId, storyboardId), eq(schema.sysTask.type, 'video')))
    .orderBy(desc(schema.sysTask.id))
  return pickTransitionT(tasks, videoUrl, transitionReviewRaw)
}

/** 整集一次查完视频任务，避免逐镜各发一次查询 */
async function resolveTransitionTs(rows: StoryboardRow[]): Promise<Map<number, TransitionT>> {
  const out = new Map<number, TransitionT>()
  if (!rows.length) return out
  const tasks = await db.select().from(schema.sysTask)
    .where(and(inArray(schema.sysTask.storyboardId, rows.map(r => r.id)), eq(schema.sysTask.type, 'video')))
    .orderBy(desc(schema.sysTask.id))
  for (const row of rows) {
    out.set(row.id, pickTransitionT(tasks.filter(t => t.storyboardId === row.id), row.videoUrl, row.transitionReview))
  }
  return out
}

// ─── 同镜互斥 ────────────────────────────────────────────────

/** 进程内正在跑 ffmpeg 的镜头：单镜与批量共用，同一镜不会被同时合成两次 */
const composing = new Set<number>()

export function tryAcquireComposeLock(storyboardId: number): boolean {
  if (composing.has(storyboardId)) return false
  composing.add(storyboardId)
  return true
}

export function releaseComposeLock(storyboardId: number): void {
  composing.delete(storyboardId)
}

export function isComposing(storyboardId: number): boolean {
  return composing.has(storyboardId)
}

/**
 * 运行中批量任务**已经占下**的镜头（落盘的 pending/processing 行）。
 * 与进程内锁分开：单镜提交必须被这些预约挡住，哪怕那一镜的 runner 还没开始跑。
 * `excludeTaskId` 只排除批量自己那条任务——它刚把当前镜标成 processing，不算冲突。
 */
export async function persistedComposeReservations(
  episodeId: number,
  excludeTaskId?: number,
): Promise<Map<number, string>> {
  const reserved = new Map<number, string>()
  const task = await findActiveTextTask(episodeId, 'shot_compose')
  if (!task || task.id === excludeTaskId) return reserved
  for (const item of parseTextTaskParams(task.params)?.progress?.items ?? []) {
    if (item.state === 'pending') reserved.set(item.storyboard_id, '已排在正在运行的批量融合里')
    if (item.state === 'processing') reserved.set(item.storyboard_id, '正在批量融合中')
  }
  return reserved
}

/** 本集此刻不能重复提交的镜头：落盘预约 + 进程内正在跑 ffmpeg 的 */
export async function activeComposeStoryboardIds(episodeId: number): Promise<Map<number, string>> {
  const active = await persistedComposeReservations(episodeId)
  for (const id of composing) active.set(id, '正在合成中')
  return active
}

// ─── 输入组装 ────────────────────────────────────────────────

export interface ComposeAssembly {
  sb: StoryboardRow
  ep: EpisodeRow
  /** 本镜是否混入旁白（纯画面镜头为 false） */
  wantsNarration: boolean
  /**
   * 真正进滤镜链的画面：`replace` 镜头是片段文件，其余是模型视频。
   * 有 pre/post 片段时 `shot-compose` 会先把三段 concat 成「全镜视频」再走滤镜链。
   */
  videoAbs: string
  /** 模型视频之前 / 之后的确定性片段（绝对路径）；没有为 null */
  preClipAbs: string | null
  postClipAbs: string | null
  audioAbs: string | null
  subtitleAbs: string | null
  dv: number
  da: number | null
  layerDuration: number
  generatedDuration: number
  junctionSeconds: number | null
  t: number
  tSource: TransitionT['source']
  fit: ComposeFit & { mode: FitMode }
  plan: ComposePlan
  parts: ComposeInputParts
  signature: string
}

export type ComposeInspection =
  | { ok: true; assembly: ComposeAssembly; inputs: ComposeInputAvailability }
  | { ok: false; reason: string; blocked: ComposeBlockedError | null; inputs: ComposeInputAvailability }

/** 字幕文件里的字幕条数；文件不存在或读不出来返回 null */
function subtitleCueCount(absPath: string): number | null {
  try {
    return parseSrt(fs.readFileSync(absPath, 'utf8')).length
  } catch {
    return null
  }
}

/** 一镜的确定性片段现状：三个位置各一条 + 各自「渲染产物是否仍对得上当前输入」 */
export interface ClipComposeContext {
  clips: { replace: LayerSegment | null; pre: LayerSegment | null; post: LayerSegment | null }
  fresh: { replace: boolean; pre: boolean; post: boolean }
}

const EMPTY_CLIP_CONTEXT: ClipComposeContext = {
  clips: { replace: null, pre: null, post: null },
  fresh: { replace: false, pre: false, post: false },
}

/** Assembly positions are derived from the explicit combo; only one layer row may participate. */
function clipContextOf(segment: LayerSegment | undefined, combo: string | null | undefined, spec: SegmentSpec): ClipComposeContext {
  const context: ClipComposeContext = {
    clips: { replace: null, pre: null, post: null },
    fresh: { replace: false, pre: false, post: false },
  }
  if (!segment) return context
  const position = segmentPositionOfCombo(combo)
  if (position === 'none') return context
  context.clips[position] = segment
  context.fresh[position] = !segment.stale_reasons.length && layerSegmentIsFresh(segment, spec)
  return context
}

/** 单镜（单镜合成/提交走这条） */
export async function loadClipComposeContext(sb: StoryboardRow): Promise<ClipComposeContext> {
  const segment = await getLayerSegment(sb.id)
  if (!segment) return EMPTY_CLIP_CONTEXT
  return clipContextOf(segment, sb.combo, await resolveEpisodeSegmentSpec(sb.episodeId))
}

/** 整集一次查完：批量预览不能每镜各发一次查询 */
export async function loadClipComposeContexts(
  episodeId: number,
  rows: StoryboardRow[],
): Promise<Map<number, ClipComposeContext>> {
  const byStoryboard = await segmentsByStoryboard(rows.map(row => row.id))
  const out = new Map<number, ClipComposeContext>()
  if (!byStoryboard.size) return out
  const spec = await resolveEpisodeSegmentSpec(episodeId)
  for (const row of rows) {
    const segment = byStoryboard.get(row.id)
    if (!segment) continue
    const context = clipContextOf(segment, row.combo, spec)
    // combo=B / 未选：段存在但不参与，与「没有段」等价
    if (!context.clips.replace && !context.clips.pre && !context.clips.post) continue
    out.set(row.id, context)
  }
  return out
}

/**
 * 组装一镜的合成输入并逐项校验依赖。失败时返回可直接展示的中文原因，
 * 时长规则不满足时额外带上结构化的 ComposeBlockedError（路由原样透出字段）。
 *
 * 确定性片段（#50）：`replace` 的片段**取代**模型视频（本镜可以根本没有模型视频），
 * `pre`/`post` 夹在模型视频前后、`dv` = 三段之和。片段必须已渲染且渲染签名与当前
 * 图层/时间线一致，否则阻断并提示重渲染——绝不拿过期的片段去合成。
 */
export async function inspectComposeInputs(
  sb: StoryboardRow,
  ep: EpisodeRow,
  transition: TransitionT,
  clipContext?: ClipComposeContext,
): Promise<ComposeInspection> {
  const shot = `分镜 #${sb.storyboardNumber}`
  const documentary = resolveDramaProjectType(ep.dramaId) === 'documentary'
  const combo = documentary ? toCombo(sb.combo) : null
  const wantsNarration = ep.narrationEnabled === true && sb.narrationEnabled !== false
  const text = (sb.narrationText || '').trim()
  const meta: NarrationMeta = parseNarrationMeta(sb.narrationMeta)

  const context = clipContext ?? await loadClipComposeContext(sb)
  const replaceClip = context.clips.replace
  const preClip = context.clips.pre
  const postClip = context.clips.post

  const modelVideoAbs = sb.videoUrl ? toAbsPath(sb.videoUrl) : null
  const modelFacts = modelVideoAbs ? await mediaFacts(modelVideoAbs) : null
  const replaceAbs = replaceClip?.render_path ? toAbsPath(replaceClip.render_path) : null
  const replaceFacts = replaceAbs ? await mediaFacts(replaceAbs) : null
  const preAbs = preClip?.render_path ? toAbsPath(preClip.render_path) : null
  const preFacts = preAbs ? await mediaFacts(preAbs) : null
  const postAbs = postClip?.render_path ? toAbsPath(postClip.render_path) : null
  const postFacts = postAbs ? await mediaFacts(postAbs) : null

  const audioAbs = wantsNarration && sb.narrationAudioUrl ? toAbsPath(sb.narrationAudioUrl) : null
  const audioFacts = audioAbs ? await mediaFacts(audioAbs) : null
  const subtitleAbs = wantsNarration && sb.subtitleUrl ? toAbsPath(sb.subtitleUrl) : null
  const cues = subtitleAbs ? subtitleCueCount(subtitleAbs) : null

  const inputs: ComposeInputAvailability = {
    video: Boolean(replaceClip ? replaceFacts : modelFacts),
    audio: Boolean(audioFacts),
    subtitle: Boolean(cues),
    pure_visual: !wantsNarration,
  }
  const fail = (reason: string, blocked: ComposeBlockedError | null = null): ComposeInspection =>
    ({ ok: false, reason, blocked, inputs })
  if (documentary && (!combo || sb.designCardStatus !== 'confirmed')) return fail('设计卡未确认')
  if (documentary && (combo === 'A' || combo === 'C' || combo === 'D') && !replaceClip && !preClip && !postClip) {
    return fail(`${shot} 的图层段尚未渲染`)
  }
  let junctionHash: string | null = null
  if (documentary && (combo === 'C' || combo === 'D')) {
    const junction = await junctionFrameOf(sb.id)
    junctionHash = junction.hash
    if (junction.stale || !junction.hash) return fail(`${shot} 的衔接帧已过期，请重新渲染图层段`)
    if (sb.keyframesJunctionHash !== junction.hash || !sb.keyframesConfirmed) return fail(`${shot} 的衔接帧已变化，请重新确认故事关键帧并生成视频`)
  }
  if (documentary && combo !== 'A' && !sb.keyframesConfirmed) return fail(`${shot} 的故事关键帧未确认`)
  if (documentary && combo !== 'A' && modelFacts && modelFacts.durationMs > 15000 + 1) return fail(`${shot} 的生成段实测超过 15 秒`)
  for (const facts of [replaceFacts, preFacts, postFacts]) {
    if (documentary && facts && facts.durationMs > 30000 + 1) return fail(`${shot} 的图层段实测超过 30 秒`)
  }

  if (replaceClip) {
    if (!replaceClip.render_path) return fail(`${shot} 的确定性片段还没有渲染，请先渲染片段`)
    if (!replaceFacts) return fail(`${shot} 的片段文件不存在或无法读取：${replaceClip.render_path}`)
    if (!context.fresh.replace) return fail(`${shot} 的图层或时间线改过了，请重新渲染片段`)
  } else {
    if (!sb.videoUrl) return fail(`${shot} 还没有生成视频`)
    if (!modelFacts) return fail(`${shot} 的视频文件不存在或无法读取：${sb.videoUrl}`)
  }
  for (const [clip, facts, fresh, label] of [
    [preClip, preFacts, context.fresh.pre, '片头'] as const,
    [postClip, postFacts, context.fresh.post, '片尾'] as const,
  ]) {
    if (!clip) continue
    if (!clip.render_path) return fail(`${shot} 的${label}确定性片段还没有渲染，请先渲染片段`)
    if (!facts) return fail(`${shot} 的${label}片段文件不存在或无法读取：${clip.render_path}`)
    if (!fresh) return fail(`${shot} 的${label}片段图层或时间线改过了，请重新渲染片段`)
  }

  if (wantsNarration) {
    if (!text) return fail(`${shot} 还没有写旁白：请先写旁白，或把本镜明确标记为纯画面`)
    if (!sb.narrationAudioUrl || !meta.audio) return fail(`${shot} 还没有生成配音，无法合成`)
    if (meta.audio.text_sha256 !== sha256(text)) return fail(`${shot} 的旁白文本已修改，请先重新生成配音`)
    if (!audioFacts) return fail(`${shot} 的配音文件不存在或无法读取：${sb.narrationAudioUrl}`)
    if (!sb.subtitleUrl) return fail(`${shot} 缺少字幕文件：请重新生成配音或单独生成字幕`)
    if (cues === null) return fail(`${shot} 的字幕文件不存在或无法读取：${sb.subtitleUrl}`)
    if (cues === 0) return fail(`${shot} 的字幕文件里没有任何字幕行：请重新生成字幕`)
  }

  // dv：replace = 片段时长；否则 = 片头 + 模型视频 + 片尾（实测相加，concat 后与此一致）
  const mainFacts = replaceClip ? replaceFacts! : modelFacts!
  const dv = (mainFacts.durationMs + (preFacts?.durationMs ?? 0) + (postFacts?.durationMs ?? 0)) / 1000
  const da = audioFacts ? audioFacts.durationMs / 1000 : null
  // 纯画面镜头不做偏移（planCompose 的无旁白分支原样输出画面），T 对产出无影响
  const t = wantsNarration && combo !== 'A' ? transition.t : 0
  const maxSeconds = shotMaxSeconds(combo)
  if (documentary && dv > maxSeconds + 1e-3) return fail(`${shot} 的实测总时长 ${dv.toFixed(3)} 秒超过 ${maxSeconds} 秒上限`)
  const fit = resolveComposeFit({
    episodeDefault: ep.narrationFitDefault,
    shotFit: sb.narrationFit,
    episodeMixMode: ep.audioMixMode,
    episodeBedGainDb: ep.audioBedGainDb,
    da,
    availSeconds: Math.max(0, Math.min(dv, maxSeconds) - t),
    videoHasAudio: Boolean(mainFacts.hasAudio),
  })
  const plan = planCompose({ dv, da, t, fit, maxSeconds })
  if (plan.blocked) {
    const blocked = new ComposeBlockedError(plan, sb.storyboardNumber)
    return fail(blocked.message, blocked)
  }

  const clipPart = (clip: LayerSegment | null): ComposeClipPart | null =>
    (clip?.render_path && clip.render_signature
      ? { src: clip.render_path, signature: clip.render_signature }
      : null)
  const parts: ComposeInputParts = {
    video_src: replaceClip?.render_path ?? sb.videoUrl!,
    audio_src: audioAbs ? sb.narrationAudioUrl : null,
    subtitle_src: wantsNarration ? sb.subtitleUrl : null,
    burned: wantsNarration,
    text_sha256: sha256(wantsNarration ? text : ''),
    fit_key: fit.key,
    transition_t: Math.round(t * 1000) / 1000,
  }
  if (documentary && combo) {
    parts.combo = combo
    parts.layer_segment = clipPart(replaceClip ?? preClip ?? postClip)
    parts.junction_hash = junctionHash
    const tasks = await db.select().from(schema.sysTask)
      .where(and(eq(schema.sysTask.storyboardId, sb.id), eq(schema.sysTask.type, 'video')))
      .orderBy(desc(schema.sysTask.id))
    const adopted = tasks.find(task => task.status === 'completed' && (task.localPath || task.resultUrl) === sb.videoUrl)
    parts.video_task_id = combo === 'A' ? null : adopted?.id ?? null
    if ((combo === 'C' || combo === 'D') && !adopted) return fail(`${shot} 的生成视频没有可核验的衔接帧记录，请重新生成视频`)
    if ((combo === 'C' || combo === 'D') && adopted) {
      let snapshot: Record<string, unknown> = {}
      try { snapshot = JSON.parse(adopted.params || '{}') } catch { /* Invalid snapshot is stale. */ }
      if (snapshot.junction_hash !== junctionHash) return fail(`${shot} 的生成视频使用了旧衔接帧，请重新生成视频`)
    }
    // Documentary composition preserves both complete segments; narration never truncates a segment.
    plan.d = Math.max(plan.d, dv)
    plan.trim = false
    plan.freezeSeconds = Math.max(0, plan.d - dv)
  }

  return {
    ok: true,
    inputs,
    assembly: {
      sb,
      ep,
      wantsNarration,
      videoAbs: replaceClip ? replaceAbs! : modelVideoAbs!,
      preClipAbs: preAbs,
      postClipAbs: postAbs,
      audioAbs,
      subtitleAbs,
      dv,
      da,
      layerDuration: ((replaceFacts?.durationMs ?? 0) + (preFacts?.durationMs ?? 0) + (postFacts?.durationMs ?? 0)) / 1000,
      generatedDuration: combo === 'A' ? 0 : (modelFacts?.durationMs ?? 0) / 1000,
      junctionSeconds: combo === 'C' ? (preFacts?.durationMs ?? 0) / 1000 : combo === 'D' ? (modelFacts?.durationMs ?? 0) / 1000 : null,
      t,
      tSource: wantsNarration ? transition.source : 'none',
      fit,
      plan,
      parts,
      signature: composeSignatureOf(parts),
    },
  }
}

/** 单镜组装（真正执行合成走这条）；依赖不满足直接抛，错误文案与状态里看到的一致 */
export async function assembleComposeInput(storyboardId: number): Promise<ComposeAssembly> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  if (sb.deletedAt) throw new Error('镜头已删除')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (ep.narrationEnabled !== true && resolveDramaProjectType(ep.dramaId) !== 'documentary') throw new Error('本集未开启旁白，无需合成')
  if (resolveDramaProjectType(ep.dramaId) === 'documentary' && (!toCombo(sb.combo) || sb.designCardStatus !== 'confirmed')) {
    throw new GateBlockedError('final', '设计卡未确认')
  }

  const transition = await resolveTransitionT(storyboardId, sb.transitionReview, sb.videoUrl)
  const inspection = await inspectComposeInputs(sb, ep, transition)
  if (!inspection.ok) {
    if (inspection.blocked) throw inspection.blocked
    throw new Error(inspection.reason)
  }
  return inspection.assembly
}

// ─── 状态计算 ────────────────────────────────────────────────

function disabledState(sb: StoryboardRow): ComposeStateItem {
  return {
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    title: sb.title || '',
    status: 'disabled',
    selectable: false,
    checked: false,
    exportable: false,
    reason: '本集未开启旁白，拼接直接使用原始视频',
    change_reasons: [],
    signature: null,
    plan: null,
    inputs: {
      video: Boolean(sb.videoUrl && statMedia(toAbsPath(sb.videoUrl))),
      audio: Boolean(sb.narrationAudioUrl && statMedia(toAbsPath(sb.narrationAudioUrl))),
      subtitle: Boolean(sb.subtitleUrl && subtitleCueCount(toAbsPath(sb.subtitleUrl))),
      pure_visual: sb.narrationEnabled === false,
    },
    composed_video_url: sb.composedVideoUrl,
  }
}

function deriveComposeState(
  sb: StoryboardRow,
  inspection: ComposeInspection,
  activeReason: string | null,
): ComposeStateItem {
  const base = {
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    title: sb.title || '',
    inputs: inspection.inputs,
    composed_video_url: sb.composedVideoUrl,
  }

  if (activeReason) {
    return {
      ...base,
      status: 'skipped',
      selectable: false,
      checked: false,
      exportable: false,
      reason: activeReason,
      change_reasons: [],
      signature: inspection.ok ? inspection.assembly.signature : null,
      plan: inspection.ok ? inspection.assembly.plan : null,
    }
  }

  if (!inspection.ok) {
    return {
      ...base,
      status: !inspection.blocked && (sb.combo || inspection.reason === '设计卡未确认') ? 'excluded' : 'blocked',
      selectable: false,
      checked: false,
      exportable: false,
      reason: inspection.reason,
      change_reasons: [],
      signature: null,
      plan: null,
    }
  }

  const { signature, plan, parts } = inspection.assembly
  const composed = parseNarrationMeta(sb.narrationMeta).composed
  const ready = { ...base, selectable: true, plan, signature }

  if (!sb.composedVideoUrl || !composed) {
    return { ...ready, status: 'missing', checked: true, exportable: false, reason: null, change_reasons: [] }
  }
  if (!statMedia(toAbsPath(sb.composedVideoUrl))) {
    return {
      ...ready,
      status: 'missing',
      checked: true,
      exportable: false,
      reason: `上次的融合成片文件已丢失：${sb.composedVideoUrl}`,
      change_reasons: [],
    }
  }
  if (!composed.inputs) {
    // v1（#30/#31）根本没存分项，无从比较
    return {
      ...ready,
      status: 'unknown',
      checked: false,
      exportable: false,
      reason: '这条成片由旧版本合成（没有输入快照），无法与当前输入逐项比较：请重新合成以确认最新',
      change_reasons: [],
    }
  }
  // 版本号不再单独做闸门：签名本身已经带 `v<生效版本>`，而生效版本随「本镜有没有片段」
  // 变化（无片段恒为 v2）。所以无片段的存量成片升级到 #50 之后签名完全不变，仍判 unchanged；
  // 真的挂上片段的那一镜才会因为版本与片段分项一起变而判 changed。
  if (composed.signature_version !== undefined && composed.signature_version < 2) {
    return {
      ...ready,
      status: 'unknown',
      checked: false,
      exportable: false,
      reason: '这条成片由旧版本合成（输入快照格式已升级），无法与当前输入逐项比较：请重新合成以确认最新',
      change_reasons: [],
    }
  }
  if (composed.signature === signature) {
    return { ...ready, status: 'unchanged', checked: false, exportable: true, reason: null, change_reasons: [] }
  }
  return {
    ...ready,
    status: 'changed',
    checked: true,
    exportable: false,
    reason: null,
    change_reasons: describeComposeDiff(parts, composed.inputs),
  }
}

export interface ComposeStatesOptions {
  /** 只算这些镜头（手动选镜只缩小范围，不改变各自的分类与默认勾选） */
  storyboardIds?: number[]
  /** 已经查好的分镜行（分镜列表接口复用，避免二次查询） */
  rows?: StoryboardRow[]
  episode?: EpisodeRow
}

/**
 * 整集逐镜的融合状态。媒体实测走 media-probe 的缓存（键含文件大小与 mtime），
 * 所以 3 秒一次的列表刷新不会反复 ffprobe 整集。
 */
export async function composeStatesForEpisode(
  episodeId: number,
  opts: ComposeStatesOptions = {},
): Promise<ComposeStateItem[]> {
  const episode = opts.episode ?? (await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)))[0]
  if (!episode) throw new Error('剧集不存在')

  const all = opts.rows ?? await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
  const live = all.filter(sb => !sb.deletedAt)
  // 显式传空数组表示「没有选中任何镜头」，绝不能扩大成整集
  const rows = opts.storyboardIds === undefined
    ? live
    : live.filter(sb => opts.storyboardIds!.includes(sb.id))

  if (episode.narrationEnabled !== true && resolveDramaProjectType(episode.dramaId) !== 'documentary') return rows.map(disabledState)

  // 冷缓存时一次性并发预热，避免逐镜串行 ffprobe
  await mediaFactsAll(rows.flatMap(sb => [
    sb.videoUrl ? toAbsPath(sb.videoUrl) : null,
    sb.narrationEnabled !== false && sb.narrationAudioUrl ? toAbsPath(sb.narrationAudioUrl) : null,
  ]).filter((p): p is string => Boolean(p)))

  const transitions = await resolveTransitionTs(rows)
  const active = await activeComposeStoryboardIds(episodeId)
  const clipContexts = await loadClipComposeContexts(episodeId, rows)

  const items: ComposeStateItem[] = []
  for (const sb of rows) {
    const inspection = await inspectComposeInputs(
      sb,
      episode,
      transitions.get(sb.id) ?? { t: 0, source: 'none' },
      clipContexts.get(sb.id) ?? EMPTY_CLIP_CONTEXT,
    )
    items.push(deriveComposeState(sb, inspection, active.get(sb.id) ?? null))
  }
  return items
}

/** 分镜列表接口用：按分镜 id 取状态 */
export async function composeStateMap(
  episodeId: number,
  opts: ComposeStatesOptions = {},
): Promise<Map<number, ComposeStateItem>> {
  const items = await composeStatesForEpisode(episodeId, opts)
  return new Map(items.map(item => [item.storyboard_id, item]))
}

/**
 * 对外的旁白链路状态：配音侧状态 + 融合新鲜度。
 * 「最新」只来自输入快照一致，不再由接口各自拼签名（#42 修「刚合成就过期」的根因）。
 */
export function narrationStatusFor(
  row: Pick<StoryboardRow, 'narrationEnabled' | 'narrationText' | 'narrationAudioUrl' | 'narrationMeta'>,
  episodeNarrationEnabled: boolean,
  state: ComposeStateItem | undefined,
): NarrationStatus {
  const voice = narrationStatus({
    episodeNarrationEnabled,
    shotNarrationEnabled: row.narrationEnabled !== false,
    narrationText: row.narrationText,
    narrationAudioUrl: row.narrationAudioUrl,
    meta: parseNarrationMeta(row.narrationMeta),
  })
  if (!state) return voice
  if (state.status === 'unchanged') return 'composed'
  if (state.status === 'changed' || state.status === 'unknown') return 'compose_stale'
  return voice
}
