/**
 * 旁白配音（Issue #30）—— 单镜同步合成 + 集级批量任务。
 *
 * 配音成功后：落盘 wav、写 narration_audio_url / narration_meta.audio、按实测时长回写
 * storyboards.duration（内容段，不含转场），并生成该镜字幕 SRT。
 */
import path from 'path'
import fs from 'fs'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { type AIConfig } from './ai.js'
import { NARRATION_SUBDIR, fetchCharAlign, fetchMarkupCatalog, fetchVoiceItems, parseTtsSettings, previewMarkup, synthesizeNarration } from './tts.js'
import {
  VOXCPM_CFG,
  VOXCPM_STEPS,
  VOXCPM_STEP_PRESETS,
  classifyVoiceShot,
  episodeSettingsOf,
  groupVoices,
  sanitizeVoiceSettings,
  type VoiceOption,
  type VoiceParams,
  type VoicePlanStatus,
} from './narration-voice-params.js'
import { buildSubtitleCues, renderSrt } from './subtitle.js'
import {
  PAUSE_MAX_SECONDS,
  PAUSE_MIN_SECONDS,
  TONE_TAGS,
  engineSpokenText,
  parseNarrationMarkup,
  spokenText,
  toVoxcpmText,
} from './narration-markup.js'
import { parseFitRecord } from './narration-fit.js'
import { observeTaskOperation, runObservedWork } from './task-observability.js'
import { buildSampleKey, buildWorkPlan, stageEstimateOf, type StageWorkEstimate } from './task-estimate.js'
import {
  DEFAULT_SUBTITLE_TIMING,
  DEFAULT_TAIL_PAD_SECONDS,
  MAX_NARRATION_CHARS,
  NARRATION_CHARS_PER_SECOND,
  durationFromAudio,
  estimateNarrationSeconds,
  narrationCharCount,
  narrationIssues,
  parseNarrationMeta,
  resolveNarrationNormalize,
  sha256,
  type NarrationMeta,
  type SubtitleTiming,
} from './narration.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  promptBatchStatusFrom,
  updateTextTaskProgress,
  type PromptBatchStatus,
  type TextTaskProgress,
} from './text-task.js'
import { scopeFromPreview, type BatchScope } from './batch-scope.js'
import { resolveDramaProjectType } from './project-type.js'
import { parseTextTaskParams, patchTextTaskParams } from './text-task.js'
import { effectiveVoiceParams, episodeTtsValidity, resolveTtsConfig } from './narration-tts-gate.js'
import { requireConfirmedSkeleton } from './narration-skeleton.js'

// 生效 TTS 配置与生效配音参数都由 narration-tts-gate 统一提供（#70）：
// 「当前配音是否有效」与「这次该用什么参数合成」必须是同一份口径。
export { resolveTtsConfig }

/** 本镜生效的字幕时间码模式：镜级覆盖优先，其次集级，再次默认 sentence */
export function resolveSubtitleTiming(
  episodeTiming: string | null | undefined,
  shotTiming: string | null | undefined,
): SubtitleTiming {
  const candidate = (shotTiming || episodeTiming || '').trim()
  return candidate === 'char' || candidate === 'sentence' ? candidate : DEFAULT_SUBTITLE_TIMING
}

type EpisodeRow = typeof schema.episodes.$inferSelect
type StoryboardRow = typeof schema.storyboards.$inferSelect



function requireVoxcpm(config: AIConfig) {
  if ((config.provider || '').toLowerCase() !== 'voxcpm') {
    throw new Error(`不支持的语音合成服务：${config.provider || '(未配置)'}（配音参数弹窗只支持 voxcpm）`)
  }
}

/** 弹窗提交的参数 → 校验（音色必须在服务当前列表里）后的完整参数 */
async function validatedVoiceParams(raw: unknown, config: AIConfig): Promise<VoiceParams> {
  requireVoxcpm(config)
  const items = await fetchVoiceItems(config.baseUrl, config.apiKey)
  return sanitizeVoiceSettings(raw, items.map(v => v.name))
}

/**
 * 弹窗确定 = 保存为本集默认（#37 Q2=B）。规范化写到当前生效的那一层：
 * 单镜且该镜有镜级覆盖 → 改镜级；否则改集级（批量一律改集级，带镜级覆盖的镜头仍按各自设置）。
 */
async function saveVoiceDefaults(ep: EpisodeRow, params: VoiceParams, shot?: StoryboardRow) {
  const ts = now()
  const shotOverride = shot && (shot.narrationNormalize === true || shot.narrationNormalize === false)
  await db.update(schema.episodes).set({
    ttsSettings: JSON.stringify(episodeSettingsOf(params)),
    ...(shotOverride ? {} : { narrationNormalize: params.normalize }),
    updatedAt: ts,
  }).where(eq(schema.episodes.id, ep.id))
  if (shot && shotOverride) {
    await db.update(schema.storyboards).set({ narrationNormalize: params.normalize, updatedAt: ts })
      .where(eq(schema.storyboards.id, shot.id))
  }
}

export interface TtsOptions {
  config_id: number | null
  config_name: string
  voices: VoiceOption[]
  steps: { min: number; max: number; default: number; presets: { steps: number; rtf: number }[] }
  cfg: { min: number; max: number; default: number }
  /** 预计音频时长用的语速（字/秒），与 estimateNarrationSeconds 同口径 */
  chars_per_second: number
  /** 弹窗预填值 = 本集（或本镜）当前生效参数 */
  current: VoiceParams
}

/**
 * 旁白编辑器的标记目录（#38）：语气只给火宝支持的那 11 个（名称/分组以 Studio 为准，取不到就用内置名），
 * 多音字候选取 Studio 的常见多音字表；停顿范围与解析器一致。
 */
export async function getMarkupCatalog(episodeId: number) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const config = await resolveTtsConfig(ep)
  requireVoxcpm(config)
  const studio = await fetchMarkupCatalog(config)
  return {
    tones: TONE_TAGS.map((t) => {
      const s = studio.tags.find(x => x.tag === t.tag)
      return { tag: t.tag, label: s?.label || t.label, group: s?.group || '' }
    }),
    polyphones: studio.polyphones,
    pause: { min: PAUSE_MIN_SECONDS, max: PAUSE_MAX_SECONDS, presets: [0.3, 0.5, 1, 2] },
  }
}

/** 配音弹窗的选项与预填值（#37）：选项实时取自本集生效的 VoxCPM 服务 */
export async function getTtsOptions(episodeId: number, storyboardId?: number): Promise<TtsOptions> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  let shotNormalize: boolean | null = null
  if (storyboardId) {
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
    if (!sb || sb.episodeId !== episodeId) throw new Error('镜头不存在')
    shotNormalize = sb.narrationNormalize ?? null
  }
  const config = await resolveTtsConfig(ep)
  requireVoxcpm(config)
  const items = await fetchVoiceItems(config.baseUrl, config.apiKey)
  const [row] = config.id ? await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, config.id)) : []
  return {
    config_id: config.id ?? null,
    config_name: row?.name || config.provider,
    voices: groupVoices(items),
    steps: { ...VOXCPM_STEPS, presets: VOXCPM_STEP_PRESETS.map(p => ({ ...p })) },
    cfg: { ...VOXCPM_CFG },
    chars_per_second: NARRATION_CHARS_PER_SECOND,
    current: effectiveVoiceParams(ep, shotNormalize, config),
  }
}

export interface VoiceResult {
  storyboardId: number
  audioUrl: string
  subtitleUrl: string
  durationMs: number
  duration: number
  cues: number
  subtitleSource: string
  jobId: string | null
}

/** 一次单镜合成的已解析上下文（校验/参数解析之后、真正开工之前） */
interface ShotVoiceContext {
  sb: typeof schema.storyboards.$inferSelect
  ep: typeof schema.episodes.$inferSelect
  documentary: boolean
  text: string
  chars: number
  config: AIConfig
  params: VoiceParams
}

/**
 * 为一个镜头生成配音 + 字幕。整镜一次合成（不按句分段）。
 *
 * 计量（#87 §D）：批量由 `startVoiceBatch` 开好工作项后用 `observed` 传进来；
 * 单镜重配自己开一条 `narration_tts` 任务，这样真实合成用时与源字数同样落库，
 * 批量 ETA 也能用这些同参数样本。音频长度不是合成耗时，两者分开记录。
 */
export async function generateShotVoice(
  storyboardId: number,
  /** 弹窗提交的原始参数（#37）：校验后保存为本集默认再合成；不传 = 用当前生效参数 */
  rawSettings?: unknown,
  /** 批量已解析好的参数（跳过校验与保存） */
  presetParams?: VoiceParams,
  /** 批量调用：调用方已经开了观测工作项，这里不再另起任务 */
  observed?: { taskId: number; sampleKey: string },
): Promise<VoiceResult> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无法生成配音')
  const documentary = resolveDramaProjectType(ep.dramaId) === 'documentary'
  // 新顺序（#70）：骨架确认 → 批量配音 → 按实测时长填设计卡。
  // 配音绝不再等设计卡，否则就是「卡等音频、音频等卡」的死循环。
  if (documentary) await requireConfirmedSkeleton(ep.id)
  if (sb.narrationEnabled === false) throw new Error(`分镜 #${sb.storyboardNumber} 已标记为纯画面镜头，没有旁白可配音`)

  const text = (sb.narrationText || '').trim()
  if (!text) throw new Error(`分镜 #${sb.storyboardNumber} 还没有旁白文本`)
  const chars = narrationCharCount(text)
  if (chars > MAX_NARRATION_CHARS) {
    throw new Error(`分镜 #${sb.storyboardNumber} 的旁白 ${chars} 字，超过语音合成单段上限 ${MAX_NARRATION_CHARS} 字：请先改写精简`)
  }
  const markupErrors = parseNarrationMarkup(text).errors
  if (markupErrors.length) {
    throw new Error(`分镜 #${sb.storyboardNumber} 的发音标记有误：${markupErrors.map(e => e.message).join('；')}`)
  }

  const config = await resolveTtsConfig(ep)
  let params = presetParams
  if (!params && rawSettings !== undefined) {
    params = await validatedVoiceParams(rawSettings, config)
    await saveVoiceDefaults(ep, params, sb)
  }
  params ??= effectiveVoiceParams(ep, sb.narrationNormalize, config)
  logTaskStart('Narration', 'voice', { storyboardId, episodeId: sb.episodeId, chars })

  const ctx: ShotVoiceContext = { sb, ep, documentary, text, chars, config, params }
  if (observed) return runShotSynthesis(ctx)

  // 单镜重配也归一条任务：没有任务就没有地方落「真实合成用时 / 源字数 / 失败原因」
  const sampleKey = buildSampleKey({ stage: 'voice', configId: config.id ?? null, model: config.model, voice: params })
  const progress: TextTaskProgress = {
    completed: 0, failed: 0, total: 1,
    items: [{ storyboard_id: storyboardId, storyboard_number: sb.storyboardNumber, state: 'processing', reason: null }],
  }
  const taskId = await createTextTask({
    kind: 'narration_tts',
    episodeId: sb.episodeId,
    dramaId: ep.dramaId,
    storyboardId,
    prompt: `为分镜 #${sb.storyboardNumber} 生成旁白配音`,
    progress,
    storyboardIds: [storyboardId],
  })
  await patchTextTaskParams(taskId, {
    voice_settings: params,
    work_plan: buildWorkPlan({
      stage: 'voice',
      unit: 'shot',
      sampleKey,
      items: [{ storyboard_id: storyboardId, storyboard_number: sb.storyboardNumber, source_chars: chars }],
    }),
  })
  try {
    const result = await runObservedWork({
      taskId, stage: 'voice', sourceChars: chars, sampleKey,
      storyboardId, storyboardNumber: sb.storyboardNumber,
    }, () => runShotSynthesis(ctx))
    progress.completed = 1
    progress.items![0]!.state = 'completed'
    await finishTextTask(taskId, 'completed', { progress })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    progress.failed = 1
    progress.items![0]!.state = 'failed'
    progress.items![0]!.reason = message
    await finishTextTask(taskId, 'failed', { progress, errorMsg: message })
    throw err
  }
}

async function runShotSynthesis(ctx: ShotVoiceContext): Promise<VoiceResult> {
  const { sb, ep, documentary, text, chars, config, params } = ctx
  const storyboardId = sb.id

  // 发音标记（#38）：源文本 → VoxCPM 语法；先让 Studio 按它自己的规则解析一遍，
  // 它认出的「念出来的字」必须与我们的 engineSpokenText 一致，否则不合成（字幕对不上）
  const engineText = toVoxcpmText(text)
  const expectedSpoken = engineSpokenText(text)
  const preview = await previewMarkup(config, engineText)
  if (preview.errors.length) throw new Error(`语音服务无法解析本镜的发音标记：${preview.errors.join('；')}`)
  if (preview.spoken.replace(/\s+/g, '') !== expectedSpoken.replace(/\s+/g, '')) {
    throw new Error(`语音服务解析出的朗读文字与旁白不一致，已停止合成：服务端「${preview.spoken}」/ 期望「${expectedSpoken}」`)
  }
  // 真实合成用时由观测层按「请求发出 → 响应结束」记录；audio.duration_ms 是媒体长度，不是耗时
  const synthesis = await observeTaskOperation({
    kind: 'tts',
    configId: config.id ?? null,
    configName: config.name,
    provider: config.provider,
    model: config.model,
    request: { text: engineText, chars, engine_chars: engineText.length, params },
  }, () => synthesizeNarration(config, engineText, params))

  // 字幕：两种时间码模式都基于这一次整镜合成的音频，对齐数据统一取逐字时间戳
  // （TTS 服务只支持 level=word|char，sentence 模式由 buildSubtitleCues 按句聚合）。
  // 字幕文字只用去掉标记的纯旁白；对齐用 VoxCPM 实际念的字（同音字等长替换）
  const timing = resolveSubtitleTiming(ep.subtitleTiming, sb.subtitleTiming)
  const charItems = synthesis.jobId ? await fetchCharAlign(config, synthesis.jobId) : null
  const subtitle = buildSubtitleCues({
    text: spokenText(text),
    alignText: expectedSpoken,
    durationMs: synthesis.durationMs,
    timing,
    charItems,
  })

  const srtDir = path.join(STORAGE_ROOT, NARRATION_SUBDIR)
  fs.mkdirSync(srtDir, { recursive: true })
  const srtName = `${uuid()}.srt`
  fs.writeFileSync(path.join(srtDir, srtName), renderSrt(subtitle.cues), 'utf8')
  const subtitleUrl = `static/${NARRATION_SUBDIR}/${srtName}`

  const ts = now()
  const meta: NarrationMeta = parseNarrationMeta(sb.narrationMeta)
  meta.text_sha256 = sha256(text)
  meta.audio = {
    duration_ms: synthesis.durationMs,
    chars,
    voice: synthesis.voice,
    seed: synthesis.seed,
    job_id: synthesis.jobId,
    provider: synthesis.provider,
    config_id: config.id ?? null,
    generated_at: ts,
    text_sha256: meta.text_sha256,
    params,
  }
  meta.subtitle = {
    cues: subtitle.cues.length,
    source: subtitle.source,
    timing,
    generated_at: ts,
  }

  // 内容段时长（不含转场）：提交视频时 planTransitionTiming() 才会加一次 T
  const duration = durationFromAudio(synthesis.durationMs, DEFAULT_TAIL_PAD_SECONDS)

  // 重新配音后手调的倍率失效（#31 Q3：倍率默认不持久化，重配即按新时长重算）
  const fitRecord = parseFitRecord(sb.narrationFit)
  const clearedFit = fitRecord?.tempo_override !== undefined
    ? JSON.stringify({ ...fitRecord, tempo_override: undefined, updated_at: ts })
    : undefined

  await db.update(schema.storyboards).set({
    narrationAudioUrl: synthesis.wavPath,
    subtitleUrl,
    narrationMeta: JSON.stringify(meta),
    ...(!documentary ? { duration } : {}),
    ...(clearedFit ? { narrationFit: clearedFit } : {}),
    updatedAt: ts,
  }).where(eq(schema.storyboards.id, storyboardId))

  logTaskSuccess('Narration', 'voice', {
    storyboardId,
    durationMs: synthesis.durationMs,
    duration,
    cues: subtitle.cues.length,
    subtitleSource: subtitle.source,
  })

  return {
    storyboardId,
    audioUrl: synthesis.wavPath,
    subtitleUrl,
    durationMs: synthesis.durationMs,
    duration,
    cues: subtitle.cues.length,
    subtitleSource: subtitle.source,
    jobId: synthesis.jobId,
  }
}

export interface VoicePlanItem {
  storyboard_id: number
  storyboard_number: number
  status: VoicePlanStatus
  selectable: boolean
  checked: boolean
  reason?: string
  /** 预计音频秒数（未配音按字数估算，已配音取实测） */
  audio_seconds: number
}

/** 批量配音的逐镜分类（preview 与执行共用，#37）：本次参数 = desired，镜级规范化覆盖仍然生效 */
async function planVoiceBatch(ep: EpisodeRow, desired: VoiceParams, config: AIConfig, storyboardIds?: number[]) {
  const configSettings = parseTtsSettings(config.settings)
  const documentary = resolveDramaProjectType(ep.dramaId) === 'documentary'
  // 纪录片批量配音的唯一前置（#70）：当前骨架已确认。预览与执行共用同一句原因文案。
  let skeletonGate: string | null = null
  if (documentary) {
    try {
      await requireConfirmedSkeleton(ep.id)
    } catch (err) {
      skeletonGate = err instanceof Error ? err.message : '旁白骨架尚未确认'
    }
  }
  const sbs = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, ep.id))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt)
    .filter(sb => storyboardIds === undefined || storyboardIds.includes(sb.id))
  // 文件级事实（#70）：元数据对得上但音频文件丢失/读不出时长的镜头必须重配，
  // 不能按「未变化」跳过——制作门禁认的是文件实测，预览与执行必须用同一份口径。
  const validity = await episodeTtsValidity(ep.id, { rows: sbs, episode: ep })
  return sbs.map((sb) => {
    const meta = parseNarrationMeta(sb.narrationMeta)
    const text = sb.narrationText || ''
    const shotParams: VoiceParams = { ...desired, normalize: resolveNarrationNormalize(desired.normalize, sb.narrationNormalize) }
    const gate = ep.narrationEnabled !== true ? '本集未开启旁白，无法生成配音'
      : skeletonGate
    const fileBroken = validity.get(sb.id)?.reason
    const classified = classifyVoiceShot({
      narrationEnabled: sb.narrationEnabled !== false,
      text,
      // 字数超单段上限、发音标记写错的镜头不浪费一次 GPU 合成；
      // 「实测配音 + 留白超 15 秒」不挡——换音色/参数重配正是解决它的办法之一
      blocked: !!gate || narrationCharCount(text) > MAX_NARRATION_CHARS || parseNarrationMarkup(text).errors.length > 0,
      audio: meta.audio,
      desired: shotParams,
      configSettings,
    })
    const broken = classified === 'unchanged'
      && (fileBroken === 'audio_file_missing' || fileBroken === 'duration_invalid' || fileBroken === 'audio_no_stream')
    const status = broken ? 'changed' : classified
    const item: VoicePlanItem = {
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      status,
      selectable: status === 'missing' || status === 'changed' || status === 'unchanged',
      checked: status === 'missing' || status === 'changed',
      reason: gate
        || (broken ? '配音文件已丢失或读不出时长，需要重配' : undefined)
        || (status === 'unchanged' ? 'unchanged' : status === 'skipped' ? '旁白已禁用、为空或格式不符合配音要求' : undefined),
      // 实测秒数只认文件；文件不可用时退回字数估算（仅用于预览展示）
      audio_seconds: validity.get(sb.id)?.duration_s ?? estimateNarrationSeconds(text),
    }
    // source_chars = 去标记后的源旁白字数：ETA 按它缩放（不是提示词、更不是音频长度）
    return { item, params: shotParams, source_chars: narrationCharCount(text) }
  })
}

/**
 * 配音「开始前」的字数与历史 ETA（#87 §D）：按本次弹窗参数挑出会合成的镜，
 * 逐镜源字数求和，再用同配置/同音色/同步数的历史成功样本给出预计耗时。
 * 预计耗时是**合成服务调用耗时**，不是音频总长度。
 */
export async function voiceWorkEstimate(
  episodeId: number,
  rawSettings?: unknown,
  storyboardIds?: number[],
): Promise<StageWorkEstimate> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const config = await resolveTtsConfig(ep)
  const desired = rawSettings === undefined
    ? effectiveVoiceParams(ep, null, config)
    : await validatedVoiceParams(rawSettings, config)
  const plan = await planVoiceBatch(ep, desired, config)
  const scope = scopeFromPreview(plan.map(p => p.item), storyboardIds)
  const requested = storyboardIds === undefined ? null : new Set(storyboardIds)
  const included = new Set(scope.included.map(item => item.storyboard_id))
  const pending = plan.filter(p => included.has(p.item.storyboard_id) && p.item.selectable)
  const workPlan = buildWorkPlan({
    stage: 'voice',
    unit: 'shot',
    sampleKey: buildSampleKey({ stage: 'voice', configId: config.id ?? null, model: config.model, voice: desired }),
    items: pending.map(p => ({
      storyboard_id: p.item.storyboard_id,
      storyboard_number: p.item.storyboard_number,
      source_chars: p.source_chars,
      // 逐镜生效参数（normalize 是镜级覆盖）才是分组依据，不能都按弹窗参数算
      sample_key: buildSampleKey({ stage: 'voice', configId: config.id ?? null, model: config.model, voice: p.params }),
    })),
  })
  return {
    ...stageEstimateOf(workPlan, config.id ?? null, config.model),
    blocked_units: plan.filter(p => !p.item.selectable && (!requested || requested.has(p.item.storyboard_id))).length,
  }
}

/** 批量配音预览：按弹窗参数把镜头分成缺失 / 已变化 / 未变化 / 跳过 */
export async function previewVoiceBatch(episodeId: number, rawSettings: unknown, storyboardIds?: number[]): Promise<VoicePlanItem[]> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const config = await resolveTtsConfig(ep)
  const desired = await validatedVoiceParams(rawSettings, config)
  return (await planVoiceBatch(ep, desired, config, storyboardIds)).map(p => p.item)
}

/**
 * 批量配音：sys_task(type='text', kind='narration_tts')，串行（TTS 服务是单 GPU 队列）。
 * 只配「缺失 + 已变化」（#37 统一口径）；手动选镜只缩小范围。传了弹窗参数就先保存为本集默认。
 */
export async function startVoiceBatch(
  episodeId: number,
  dramaId: number,
  storyboardIds?: number[],
  rawSettings?: unknown,
  retry?: { desired: VoiceParams; retryOf: number },
): Promise<{ started: boolean; total: number; task_id?: number; scope?: BatchScope }> {
  if (await findActiveTextTask(episodeId, 'narration_tts')) return { started: false, total: -1 }

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无法生成配音')
  // 纪录片批量配音的硬前置（#70）：当前骨架必须是已确认状态
  if (resolveDramaProjectType(ep.dramaId) === 'documentary') await requireConfirmedSkeleton(episodeId)

  const config = await resolveTtsConfig(ep)
  let desired: VoiceParams
  if (retry) {
    desired = retry.desired
  } else if (rawSettings !== undefined) {
    desired = await validatedVoiceParams(rawSettings, config)
    await saveVoiceDefaults(ep, desired)
  } else {
    desired = effectiveVoiceParams(ep, null, config)
  }
  const plan = await planVoiceBatch(ep, desired, config)
  const scope = scopeFromPreview(plan.map(p => p.item), storyboardIds)
  const included = new Set(scope.included.map(item => item.storyboard_id))
  const pending = plan.filter(p => included.has(p.item.storyboard_id)
    && (!retry || storyboardIds?.includes(p.item.storyboard_id))
    && p.item.selectable)

  if (!pending.length) return { started: false, total: 0, scope }

  const progress: TextTaskProgress = {
    completed: 0, failed: 0, total: pending.length,
    items: pending.map(p => ({ storyboard_id: p.item.storyboard_id, storyboard_number: p.item.storyboard_number, state: 'pending', reason: null })),
  }
  const taskId = await createTextTask({
    kind: 'narration_tts',
    episodeId,
    dramaId,
    prompt: `为 ${pending.length} 个分镜生成旁白配音`,
    progress,
    storyboardIds: pending.map(p => p.item.storyboard_id),
    scope,
    retryOf: retry?.retryOf,
  })
  // 开跑前落计划：总镜数、逐镜源字数、逐镜生效的分组口径
  //（同配置/音色/步数/cfg/规范化/指令/种子模式才同池；normalize 可被镜级覆盖，故逐项落键）
  const sampleKey = buildSampleKey({ stage: 'voice', configId: config.id ?? null, model: config.model, voice: desired })
  const sampleKeyOf = (params: VoiceParams) =>
    buildSampleKey({ stage: 'voice', configId: config.id ?? null, model: config.model, voice: params })
  await patchTextTaskParams(taskId, {
    voice_settings: desired,
    work_plan: buildWorkPlan({
      stage: 'voice',
      unit: 'shot',
      sampleKey,
      items: pending.map(p => ({
        storyboard_id: p.item.storyboard_id,
        storyboard_number: p.item.storyboard_number,
        source_chars: p.source_chars,
        sample_key: sampleKeyOf(p.params),
      })),
    }),
  })

  logTaskStart('Narration', 'voice-batch', { episodeId, total: pending.length, voice: desired.voice })

  ;(async () => {
    for (const p of pending) {
      progress.current_storyboard_id = p.item.storyboard_id
      const item = progress.items!.find(item => item.storyboard_id === p.item.storyboard_id)!
      item.state = 'processing'
      await updateTextTaskProgress(taskId, progress)
      try {
        await runObservedWork({
          taskId,
          stage: 'voice',
          sourceChars: p.source_chars,
          sampleKey: sampleKeyOf(p.params),
          storyboardId: p.item.storyboard_id,
          storyboardNumber: p.item.storyboard_number,
        }, () => generateShotVoice(p.item.storyboard_id, undefined, p.params, { taskId, sampleKey: sampleKeyOf(p.params) }))
        progress.completed++
        item.state = 'completed'
      } catch (err) {
        progress.failed++
        item.state = 'failed'
        item.reason = err instanceof Error ? err.message : String(err)
        logTaskError('Narration', 'voice-batch-shot', {
          storyboardId: p.item.storyboard_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      await updateTextTaskProgress(taskId, progress)
    }
    delete progress.current_storyboard_id
    await updateTextTaskProgress(taskId, progress)
  })()
    .then(async () => {
      await finishTextTask(taskId, progress.failed && !progress.completed ? 'failed' : 'completed', {
        progress,
        errorMsg: progress.failed ? `${progress.failed} 个镜头配音失败` : null,
      })
      logTaskSuccess('Narration', 'voice-batch', { episodeId, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      await finishTextTask(taskId, 'failed', { progress, errorMsg: err instanceof Error ? err.message : String(err) })
    })

  return { started: true, total: pending.length, task_id: taskId, scope }
}

export async function getVoiceBatchStatus(episodeId: number) {
  const row = await findLatestTextTask(episodeId, 'narration_tts')
  const status = promptBatchStatusFrom(row)
  const params = parseTextTaskParams(row?.params)
  return status ? { ...status, task_id: row!.id, scope: params?.scope, items: params?.progress?.items ?? [] } : null
}

export async function retryFailedVoiceBatch(episodeId: number, dramaId: number, sourceTaskId?: number) {
  const row = sourceTaskId
    ? (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, sourceTaskId)))[0]
    : await findLatestTextTask(episodeId, 'narration_tts')
  const params = parseTextTaskParams(row?.params)
  if (!row || row.episodeId !== episodeId || params?.kind !== 'narration_tts' || !params.scope || !params.voice_settings) throw new Error('没有可重试的配音范围快照')
  const ids = params.progress?.items?.filter(item => item.state === 'failed' || item.state === 'processing' || item.state === 'pending').map(item => item.storyboard_id) ?? []
  if (!ids.length) throw new Error('没有失败项可重试')
  return startVoiceBatch(episodeId, dramaId, ids, undefined, {
    desired: params.voice_settings, retryOf: row.id,
  })
}

/** Retry preview uses the original voice settings and current gates, exactly like execution. */
export async function previewFailedVoiceBatch(episodeId: number) {
  const row = await findLatestTextTask(episodeId, 'narration_tts')
  const params = parseTextTaskParams(row?.params)
  if (!params?.scope || !params.voice_settings) throw new Error('没有可重试的配音范围快照')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const failed = params.progress?.items?.filter(item => ['failed', 'pending', 'processing'].includes(item.state)).map(item => item.storyboard_id) ?? []
  const items = (await planVoiceBatch(ep, params.voice_settings, await resolveTtsConfig(ep))).map(p => p.item)
  const scope = scopeFromPreview(items, failed)
  const included = new Set(scope.included.map(item => item.storyboard_id))
  return { items: items.map(item => ({ ...item, checked: included.has(item.storyboard_id) })), scope }
}

/** 重新生成某镜字幕（切换时间码模式后不必重跑 TTS） */
export async function regenerateShotSubtitle(storyboardId: number): Promise<{ subtitleUrl: string; cues: number; source: string }> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')
  const meta = parseNarrationMeta(sb.narrationMeta)
  if (!meta.audio) throw new Error(`分镜 #${sb.storyboardNumber} 还没有配音，无法生成字幕`)

  const text = (sb.narrationText || '').trim()
  const config = await resolveTtsConfig(ep)
  const timing = resolveSubtitleTiming(ep.subtitleTiming, sb.subtitleTiming)

  const charItems = meta.audio.job_id ? await fetchCharAlign(config, meta.audio.job_id) : null
  const subtitle = buildSubtitleCues({
    text: spokenText(text),
    alignText: engineSpokenText(text),
    durationMs: meta.audio.duration_ms,
    timing,
    charItems,
  })

  const srtDir = path.join(STORAGE_ROOT, NARRATION_SUBDIR)
  fs.mkdirSync(srtDir, { recursive: true })
  const srtName = `${uuid()}.srt`
  fs.writeFileSync(path.join(srtDir, srtName), renderSrt(subtitle.cues), 'utf8')
  const subtitleUrl = `static/${NARRATION_SUBDIR}/${srtName}`

  const ts = now()
  meta.subtitle = { cues: subtitle.cues.length, source: subtitle.source, timing, generated_at: ts }
  await db.update(schema.storyboards).set({
    subtitleUrl,
    narrationMeta: JSON.stringify(meta),
    updatedAt: ts,
  }).where(eq(schema.storyboards.id, storyboardId))

  logTaskProgress('Narration', 'subtitle-regenerated', { storyboardId, timing, source: subtitle.source })
  return { subtitleUrl, cues: subtitle.cues.length, source: subtitle.source }
}
