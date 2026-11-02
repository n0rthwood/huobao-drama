/**
 * 每镜合成（Issue #30）：生成视频 + 旁白音轨 + 烧录字幕 → 该镜成片版本。
 *
 * 口径要点：
 * - 转场偏移一律取 **T**（`transition.seconds`，画面上转场固定占 0–T 秒），不是 E。
 *   来源优先该镜视频任务落盘的 `params.transition.T`，其次 `transition_review.seconds`，再次 0。
 * - 目标时长 `D = min(T + max(Da + pad, 4), 15)`；无旁白镜头 `D = Dv`，不做偏移。
 * - 画面不足冻结末帧（`tpad`），超出裁尾（`-t`）；**旁白音轨永不被裁剪**。
 * - 响度统一 `loudnorm I=-16:TP=-1.5:LRA=11`（EBU R128，用户确认 Q8）。
 * - 编码参数与 `ffmpeg-merge.ts` 完全一致，避免拼接时二次转码漂移。
 *
 * 留白长度/位置、倍速匹配、混音模式是 #31 的用户可选项，这里以 `ComposeFit` 入参承接，
 * 本 Issue 的默认值 = 替代模式 + 尾部留白 0.8 s。
 */
import fs from 'fs'
import path from 'path'
import { and, desc, eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { probeDurationMs } from './tts.js'
import { parseTransitionReview } from './transition.js'
import { renderSrt, transformCues, type SubtitleCue } from './subtitle.js'
import {
  DEFAULT_COMPOSE_FIT,
  planCompose,
  type ComposeFit,
  type ComposePlan,
} from './narration-fit.js'
import {
  MAX_SHOT_SECONDS,
  composeSignature,
  parseNarrationMeta,
  sha256,
  type NarrationMeta,
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

/** 旁白响度标准（EBU R128，用户确认 Q8） */
export const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

/** 源视频是否带音轨：H3 产出带 VAEDecodeAudio 音轨，但上传/历史视频可能没有 */
function hasAudioStream(absPath: string): Promise<boolean> {
  // 本仓 tsconfig 的 lib 低于 es2024，没有 Promise.withResolvers
  return new Promise<boolean>((resolve) => {
    ffmpeg.ffprobe(absPath, (err, data) => {
      if (err) return resolve(false)
      resolve((data?.streams || []).some(s => s.codec_type === 'audio'))
    })
  })
}

/** 本镜生效的转场偏移量 T（秒）与它的来源 */
export async function resolveTransitionT(storyboardId: number, transitionReviewRaw: string | null | undefined): Promise<{ t: number; source: 'task' | 'review' | 'none' }> {
  const [task] = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.storyboardId, storyboardId), eq(schema.sysTask.type, 'video')))
    .orderBy(desc(schema.sysTask.id))
    .limit(1)
  if (task?.params) {
    try {
      const t = JSON.parse(task.params)?.transition?.T
      if (Number.isFinite(t) && Number(t) > 0) return { t: Number(t), source: 'task' }
    } catch { /* 任务参数损坏时继续回落 */ }
  }
  const review = parseTransitionReview(transitionReviewRaw)
  if (review && Number.isFinite(review.seconds) && Number(review.seconds) > 0) {
    return { t: Number(review.seconds), source: 'review' }
  }
  return { t: 0, source: 'none' }
}

export interface ComposeResult {
  storyboardId: number
  composedVideoUrl: string
  durationMs: number
  plan: ComposePlan
  burned: boolean
}

/**
 * 合成一个镜头。开关打开时每一个参与拼接的镜头都要走这里：
 * 有旁白的镜头混入旁白 + 烧录字幕，纯画面镜头只做「去掉模型音轨 / 换成底音」。
 */
export async function composeShot(storyboardId: number, fitOverride?: Partial<ComposeFit>): Promise<ComposeResult> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('镜头不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无需合成')
  if (!sb.videoUrl) throw new Error(`分镜 #${sb.storyboardNumber} 还没有生成视频`)

  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法合成分镜视频。请删除 node_modules 后在本机重新安装依赖，或设置 FFMPEG_BIN/FFPROBE_BIN 后重启服务')
  }

  const fit: ComposeFit = { ...DEFAULT_COMPOSE_FIT, ...fitOverride }
  const wantsNarration = sb.narrationEnabled !== false && Boolean(sb.narrationAudioUrl)
  const meta: NarrationMeta = parseNarrationMeta(sb.narrationMeta)
  const text = (sb.narrationText || '').trim()

  if (sb.narrationEnabled !== false) {
    if (!sb.narrationAudioUrl || !meta.audio) {
      throw new Error(`分镜 #${sb.storyboardNumber} 还没有生成配音，无法合成`)
    }
    if (meta.audio.text_sha256 !== sha256(text)) {
      throw new Error(`分镜 #${sb.storyboardNumber} 的旁白文本已修改，请先重新生成配音`)
    }
  }

  const videoAbs = toAbsPath(sb.videoUrl)
  if (!fs.existsSync(videoAbs)) throw new Error(`分镜 #${sb.storyboardNumber} 的视频文件不存在：${sb.videoUrl}`)
  const audioAbs = wantsNarration ? toAbsPath(sb.narrationAudioUrl!) : null
  if (audioAbs && !fs.existsSync(audioAbs)) {
    throw new Error(`分镜 #${sb.storyboardNumber} 的配音文件不存在：${sb.narrationAudioUrl}`)
  }

  // 源视频没有音轨时混音模式无底音可混，自动降级为替代（不报错，产出等价）
  if (fit.audioMixMode === 'mix' && !await hasAudioStream(videoAbs)) {
    logTaskProgress('ShotCompose', 'mix-downgraded', { storyboardId, reason: '源视频无音轨' })
    fit.audioMixMode = 'replace'
  }

  const dv = (await probeDurationMs(videoAbs)) / 1000
  const da = audioAbs ? (await probeDurationMs(audioAbs)) / 1000 : null
  const { t, source: tSource } = await resolveTransitionT(storyboardId, sb.transitionReview)
  const plan = planCompose({ dv, da, t, fit })

  if (da !== null && plan.t + plan.daScaled + fit.padHeadSeconds > MAX_SHOT_SECONDS + 1e-6) {
    throw new Error(`分镜 #${sb.storyboardNumber} 的旁白（${plan.daScaled.toFixed(1)} 秒）加上转场 ${plan.t} 秒后超过 ${MAX_SHOT_SECONDS} 秒上限：请改写旁白文本或提高倍速匹配`)
  }

  // 字幕：时间码按 tempo 缩放、按旁白起播点平移，写成临时 SRT 供 ffmpeg 烧录
  let burnSrtAbs: string | null = null
  if (wantsNarration && sb.subtitleUrl) {
    const srcSrt = toAbsPath(sb.subtitleUrl)
    if (fs.existsSync(srcSrt)) {
      const cues = parseSrt(fs.readFileSync(srcSrt, 'utf8'))
      const shifted = transformCues(cues, { shiftMs: Math.round(plan.narrationStart * 1000), tempo: fit.tempo })
      const tempDir = path.join(STORAGE_ROOT, 'temp')
      fs.mkdirSync(tempDir, { recursive: true })
      burnSrtAbs = path.join(tempDir, `${uuid()}.srt`)
      fs.writeFileSync(burnSrtAbs, renderSrt(shifted), 'utf8')
    }
  }

  const outputDir = path.join(STORAGE_ROOT, 'composed')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputName = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputName)

  logTaskStart('ShotCompose', 'compose', {
    storyboardId,
    episodeId: sb.episodeId,
    dv: dv.toFixed(2),
    da: da === null ? 'none' : da.toFixed(2),
    t: String(t),
    d: plan.d.toFixed(2),
    mixMode: fit.audioMixMode,
    burned: burnSrtAbs ? 'yes' : 'no',
  })

  await runCompose({ videoAbs, audioAbs, burnSrtAbs, plan, fit, outputPath })

  if (burnSrtAbs) fs.unlinkSync(burnSrtAbs)

  const durationMs = await probeDurationMs(outputPath)
  const composedVideoUrl = `static/composed/${outputName}`
  const ts = now()
  meta.composed = {
    video_src: sb.videoUrl,
    audio_src: wantsNarration ? sb.narrationAudioUrl! : null,
    subtitle_src: wantsNarration ? (sb.subtitleUrl || null) : null,
    burned: Boolean(burnSrtAbs),
    duration_ms: durationMs,
    signature: composeSignature({
      videoUrl: sb.videoUrl,
      audioUrl: wantsNarration ? sb.narrationAudioUrl! : null,
      subtitleUrl: wantsNarration ? (sb.subtitleUrl || null) : null,
      burned: wantsNarration,
      textSha256: sha256(wantsNarration ? text : ''),
      fitKey: fit.key,
    }),
    composed_at: ts,
    transition_t: t,
    transition_t_source: tSource,
  }

  await db.update(schema.storyboards).set({
    composedVideoUrl,
    narrationMeta: JSON.stringify(meta),
    updatedAt: ts,
  }).where(eq(schema.storyboards.id, storyboardId))

  logTaskSuccess('ShotCompose', 'compose', { storyboardId, composedVideoUrl, durationMs })
  return { storyboardId, composedVideoUrl, durationMs, plan, burned: Boolean(burnSrtAbs) }
}

/** 解析 SRT（只需要时间码与文本，用于平移/缩放后重写） */
export function parseSrt(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim())
    if (lines.length < 2) continue
    const timeLine = lines.find(l => l.includes('-->'))
    if (!timeLine) continue
    const [startRaw, endRaw] = timeLine.split('-->').map(s => s.trim())
    const toMs = (v: string) => {
      const m = v.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
      if (!m) return 0
      return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4])
    }
    const textLines = lines.slice(lines.indexOf(timeLine) + 1)
    if (!textLines.length) continue
    cues.push({ startMs: toMs(startRaw), endMs: toMs(endRaw), text: textLines.join('\n') })
  }
  return cues
}

/** ffmpeg 的字幕滤镜路径转义（Windows 盘符冒号与单引号） */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

interface RunComposeInput {
  videoAbs: string
  audioAbs: string | null
  burnSrtAbs: string | null
  plan: ComposePlan
  fit: ComposeFit
  outputPath: string
}

function runCompose(input: RunComposeInput): Promise<void> {
  const { plan, fit } = input
  const hasNarration = Boolean(input.audioAbs)
  const mixBed = fit.audioMixMode === 'mix'

  const command = ffmpeg().input(input.videoAbs)
  if (input.audioAbs) command.input(input.audioAbs)
  // 无旁白（或替代模式下不混底音）时仍要有一条等长静音轨，保证 concat 时音轨布局一致
  if (!hasNarration) command.input('anullsrc=channel_layout=stereo:sample_rate=48000').inputOptions(['-f', 'lavfi'])

  const filters: string[] = []

  // 画面链路：不足冻结末帧、超出裁尾
  const videoSteps: string[] = []
  if (plan.freezeSeconds > 0.01) {
    videoSteps.push(`tpad=stop_mode=clone:stop_duration=${plan.freezeSeconds.toFixed(3)}`)
  }
  videoSteps.push(`trim=0:${plan.d.toFixed(3)}`, 'setpts=PTS-STARTPTS')
  if (input.burnSrtAbs) {
    videoSteps.push(`subtitles='${escapeFilterPath(input.burnSrtAbs)}':force_style='FontSize=18,Outline=1,Shadow=0,MarginV=28'`)
  }
  filters.push(`[0:v]${videoSteps.join(',')}[vout]`)

  // 音频链路
  if (hasNarration) {
    const narrationSteps: string[] = []
    if (Math.abs(fit.tempo - 1) > 1e-6) narrationSteps.push(`atempo=${fit.tempo.toFixed(4)}`)
    const delayMs = Math.round(plan.narrationStart * 1000)
    if (delayMs > 0) narrationSteps.push(`adelay=${delayMs}|${delayMs}`)
    narrationSteps.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo')
    // 旁白永不被裁剪：apad 补到目标时长，atrim 的终点等于目标时长（旁白本身已放得下）
    narrationSteps.push('apad', `atrim=0:${plan.d.toFixed(3)}`, 'asetpts=PTS-STARTPTS')
    filters.push(`[1:a]${narrationSteps.join(',')}[narr]`)

    if (mixBed) {
      // 底音与画面同步：裁尾则同步裁掉，冻结段补静音（不循环不拉伸）
      const bedSteps = [
        `atrim=0:${Math.min(plan.dv, plan.d).toFixed(3)}`,
        'asetpts=PTS-STARTPTS',
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
        `volume=${fit.bedGainDb}dB`,
        'apad',
        `atrim=0:${plan.d.toFixed(3)}`,
        'asetpts=PTS-STARTPTS',
      ]
      filters.push(`[0:a]${bedSteps.join(',')}[bed]`)
      // 旁白响时底音再压 6 dB；amix 第一路固定是旁白，normalize=0 保证旁白电平不随模式变化
      filters.push('[bed][narr]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=300:makeup=1[ducked]')
      filters.push(`[narr][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${LOUDNORM_FILTER}[aout]`)
    } else {
      filters.push(`[narr]${LOUDNORM_FILTER}[aout]`)
    }
  } else if (mixBed) {
    const bedSteps = [
      `atrim=0:${Math.min(plan.dv, plan.d).toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      `volume=${fit.bedGainDb}dB`,
      'apad',
      `atrim=0:${plan.d.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
    ]
    filters.push(`[0:a]${bedSteps.join(',')}[aout]`)
  } else {
    filters.push(`[1:a]atrim=0:${plan.d.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`)
  }

  // 本仓 tsconfig 的 lib 低于 es2024，没有 Promise.withResolvers
  return new Promise<void>((resolve, reject) => {
    command
      .complexFilter(filters)
      .outputOptions([
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-shortest',
      ])
      .output(input.outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`分镜合成失败：${err.message}`)))
      .run()
  })
}

/** 批量合成：sys_task(type='text', kind='shot_compose') */
export async function startComposeBatch(
  episodeId: number,
  dramaId: number,
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'shot_compose')) return { started: false, total: -1 }

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无需合成')

  const sbs = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt && sb.videoUrl)

  const pending = storyboardIds?.length ? sbs.filter(sb => storyboardIds.includes(sb.id)) : sbs
  if (!pending.length) return { started: false, total: 0 }

  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'shot_compose',
    episodeId,
    dramaId,
    prompt: `合成 ${pending.length} 个分镜`,
    progress,
    storyboardIds: pending.map(sb => sb.id),
  })

  logTaskStart('ShotCompose', 'batch', { episodeId, total: pending.length })

  ;(async () => {
    for (const sb of pending) {
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      try {
        await composeShot(sb.id)
        progress.completed++
      } catch (err) {
        progress.failed++
        logTaskError('ShotCompose', 'batch-shot', {
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
        errorMsg: progress.failed ? `${progress.failed} 个镜头合成失败` : null,
      })
      logTaskProgress('ShotCompose', 'batch-done', { episodeId, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      await finishTextTask(taskId, 'failed', { progress, errorMsg: err instanceof Error ? err.message : String(err) })
    })

  return { started: true, total: pending.length }
}

export async function getComposeBatchStatus(episodeId: number): Promise<PromptBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'shot_compose'))
}
