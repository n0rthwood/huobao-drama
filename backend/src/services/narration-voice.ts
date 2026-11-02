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
import { NARRATION_SUBDIR, fetchCharAlign, synthesizeNarration } from './tts.js'
import { buildSubtitleCues, renderSrt } from './subtitle.js'
import { parseFitRecord } from './narration-fit.js'
import {
  DEFAULT_SUBTITLE_TIMING,
  DEFAULT_TAIL_PAD_SECONDS,
  MAX_NARRATION_CHARS,
  durationFromAudio,
  narrationCharCount,
  narrationIssues,
  parseNarrationMeta,
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
export async function generateShotVoice(storyboardId: number): Promise<VoiceResult> {
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
  logTaskStart('Narration', 'voice', { storyboardId, episodeId: sb.episodeId, chars })

  const synthesis = await synthesizeNarration(config, text)

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

/** 批量配音：sys_task(type='text', kind='narration_tts')，串行（TTS 服务是单 GPU 队列） */
export async function startVoiceBatch(
  episodeId: number,
  dramaId: number,
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'narration_tts')) return { started: false, total: -1 }

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无法生成配音')

  const sbs = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt)

  const pending = (storyboardIds?.length ? sbs.filter(sb => storyboardIds.includes(sb.id)) : sbs)
    .filter(sb => sb.narrationEnabled !== false && (sb.narrationText || '').trim())
    .filter((sb) => {
      // 已配音且文本没改过的镜头跳过（显式指定镜头时强制重配）
      if (storyboardIds?.length) return true
      const meta = parseNarrationMeta(sb.narrationMeta)
      return !meta.audio || meta.audio.text_sha256 !== sha256((sb.narrationText || '').trim())
    })
    // 超长镜头不浪费一次 GPU 合成，直接排除并计入失败
    .filter(sb => !narrationIssues({
      episodeNarrationEnabled: true,
      shotNarrationEnabled: sb.narrationEnabled !== false,
      narrationText: sb.narrationText,
      meta: parseNarrationMeta(sb.narrationMeta),
    }).some(issue => issue.code === 'narration_too_long'))

  if (!pending.length) return { started: false, total: 0 }

  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'narration_tts',
    episodeId,
    dramaId,
    prompt: `为 ${pending.length} 个分镜生成旁白配音`,
    progress,
    storyboardIds: pending.map(sb => sb.id),
  })

  logTaskStart('Narration', 'voice-batch', { episodeId, total: pending.length })

  ;(async () => {
    for (const sb of pending) {
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      try {
        await generateShotVoice(sb.id)
        progress.completed++
      } catch (err) {
        progress.failed++
        logTaskError('Narration', 'voice-batch-shot', {
          storyboardId: sb.id,
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
