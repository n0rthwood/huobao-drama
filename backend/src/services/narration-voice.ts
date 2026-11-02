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
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { NARRATION_SUBDIR, fetchCharAlign, fetchVoiceItems, parseTtsSettings, synthesizeNarration } from './tts.js'
import {
  VOXCPM_CFG,
  VOXCPM_STEPS,
  VOXCPM_STEP_PRESETS,
  classifyVoiceShot,
  episodeSettingsOf,
  groupVoices,
  parseEpisodeVoiceSettings,
  resolveVoiceParams,
  sanitizeVoiceSettings,
  type VoiceOption,
  type VoiceParams,
  type VoicePlanStatus,
} from './narration-voice-params.js'
import { buildSubtitleCues, renderSrt } from './subtitle.js'
import { parseFitRecord } from './narration-fit.js'
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

/** 本集生效的 TTS 配置：集锁定优先，其次当前启用的最高优先级配置 */
export async function resolveTtsConfig(episode: { ttsConfigId?: number | null }): Promise<AIConfig> {
  const locked = episode.ttsConfigId ? await getConfigById(episode.ttsConfigId) : null
  const config = locked || await getActiveConfig('tts')
  if (!config) {
    throw new Error('未配置语音合成（TTS）服务：请到「设置」页添加并启用一个语音合成配置后重试')
  }
  return config
}

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

/** 本镜生效的配音参数：集级 tts_settings → TTS 配置 → VoxCPM 默认；normalize 镜级覆盖 → 集级（#37） */
function effectiveVoiceParams(ep: EpisodeRow, shotNormalize: boolean | null | undefined, config: AIConfig): VoiceParams {
  return resolveVoiceParams({
    episodeSettings: parseEpisodeVoiceSettings(ep.ttsSettings),
    configSettings: parseTtsSettings(config.settings),
    episodeNormalize: ep.narrationNormalize,
    shotNormalize,
  })
}

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

/**
 * 为一个镜头生成配音 + 字幕。整镜一次合成（不按句分段）。
 */
export async function generateShotVoice(
  storyboardId: number,
  /** 弹窗提交的原始参数（#37）：校验后保存为本集默认再合成；不传 = 用当前生效参数 */
  rawSettings?: unknown,
  /** 批量已解析好的参数（跳过校验与保存） */
  presetParams?: VoiceParams,
): Promise<VoiceResult> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无法生成配音')
  if (sb.narrationEnabled === false) throw new Error(`分镜 #${sb.storyboardNumber} 已标记为纯画面镜头，没有旁白可配音`)

  const text = (sb.narrationText || '').trim()
  if (!text) throw new Error(`分镜 #${sb.storyboardNumber} 还没有旁白文本`)
  const chars = narrationCharCount(text)
  if (chars > MAX_NARRATION_CHARS) {
    throw new Error(`分镜 #${sb.storyboardNumber} 的旁白 ${chars} 字，超过语音合成单段上限 ${MAX_NARRATION_CHARS} 字：请先改写精简`)
  }

  const config = await resolveTtsConfig(ep)
  let params = presetParams
  if (!params && rawSettings !== undefined) {
    params = await validatedVoiceParams(rawSettings, config)
    await saveVoiceDefaults(ep, params, sb)
  }
  params ??= effectiveVoiceParams(ep, sb.narrationNormalize, config)
  logTaskStart('Narration', 'voice', { storyboardId, episodeId: sb.episodeId, chars })

  // 字幕仍然只用 narration_text，不产生第二份措辞
  const synthesis = await synthesizeNarration(config, text, params)

  // 字幕：两种时间码模式都基于这一次整镜合成的音频，对齐数据统一取逐字时间戳
  // （TTS 服务只支持 level=word|char，sentence 模式由 buildSubtitleCues 按句聚合）
  const timing = resolveSubtitleTiming(ep.subtitleTiming, sb.subtitleTiming)
  const charItems = synthesis.jobId ? await fetchCharAlign(config, synthesis.jobId) : null
  const subtitle = buildSubtitleCues({
    text,
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
    duration,
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
  /** 预计音频秒数（未配音按字数估算，已配音取实测） */
  audio_seconds: number
}

/** 批量配音的逐镜分类（preview 与执行共用，#37）：本次参数 = desired，镜级规范化覆盖仍然生效 */
async function planVoiceBatch(ep: EpisodeRow, desired: VoiceParams, config: AIConfig, storyboardIds?: number[]) {
  const configSettings = parseTtsSettings(config.settings)
  const sbs = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, ep.id))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt)
    .filter(sb => !storyboardIds?.length || storyboardIds.includes(sb.id))
  return sbs.map((sb) => {
    const meta = parseNarrationMeta(sb.narrationMeta)
    const text = sb.narrationText || ''
    const shotParams: VoiceParams = { ...desired, normalize: resolveNarrationNormalize(desired.normalize, sb.narrationNormalize) }
    const status = classifyVoiceShot({
      narrationEnabled: sb.narrationEnabled !== false,
      text,
      // 超长镜头不浪费一次 GPU 合成
      blocked: narrationIssues({
        episodeNarrationEnabled: true,
        shotNarrationEnabled: sb.narrationEnabled !== false,
        narrationText: sb.narrationText,
        meta,
      }).some(issue => issue.code === 'narration_too_long'),
      audio: meta.audio,
      desired: shotParams,
      configSettings,
    })
    const item: VoicePlanItem = {
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      status,
      audio_seconds: meta.audio?.duration_ms ? meta.audio.duration_ms / 1000 : estimateNarrationSeconds(text),
    }
    return { item, params: shotParams }
  })
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
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'narration_tts')) return { started: false, total: -1 }

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无法生成配音')

  const config = await resolveTtsConfig(ep)
  let desired: VoiceParams
  if (rawSettings !== undefined) {
    desired = await validatedVoiceParams(rawSettings, config)
    await saveVoiceDefaults(ep, desired)
  } else {
    desired = effectiveVoiceParams(ep, null, config)
  }
  const pending = (await planVoiceBatch(ep, desired, config, storyboardIds))
    .filter(p => p.item.status === 'missing' || p.item.status === 'changed')

  if (!pending.length) return { started: false, total: 0 }

  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'narration_tts',
    episodeId,
    dramaId,
    prompt: `为 ${pending.length} 个分镜生成旁白配音`,
    progress,
    storyboardIds: pending.map(p => p.item.storyboard_id),
  })

  logTaskStart('Narration', 'voice-batch', { episodeId, total: pending.length, voice: desired.voice })

  ;(async () => {
    for (const p of pending) {
      progress.current_storyboard_id = p.item.storyboard_id
      await updateTextTaskProgress(taskId, progress)
      try {
        await generateShotVoice(p.item.storyboard_id, undefined, p.params)
        progress.completed++
      } catch (err) {
        progress.failed++
        logTaskError('Narration', 'voice-batch-shot', {
          storyboardId: p.item.storyboard_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
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

  return { started: true, total: pending.length }
}

export async function getVoiceBatchStatus(episodeId: number): Promise<PromptBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'narration_tts'))
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
  const subtitle = buildSubtitleCues({ text, durationMs: meta.audio.duration_ms, timing, charItems })

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
