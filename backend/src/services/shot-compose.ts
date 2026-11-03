/**
 * 每镜合成（Issue #30 / #31 / #42）：生成视频 + 旁白音轨 + 烧录字幕 → 该镜成片版本。
 *
 * 口径要点：
 * - 输入组装、依赖校验、签名快照全部来自 `compose-state.ts`，与状态/预览/导出校验同源；
 *   这里只负责「真的跑 ffmpeg」和把产物写回。
 * - 转场偏移一律取 **T**（画面上转场固定占 0–T 秒），由当前采用的那条视频任务决定。
 * - 目标时长 `D = min(T + max(Da + pad, 4), 15)`；无旁白镜头 `D = Dv`，不做偏移。
 * - 画面不足冻结末帧（`tpad`），超出裁尾（`-t`）；**旁白音轨永不被裁剪**。
 * - 响度统一 `loudnorm I=-16:TP=-1.5:LRA=11`（EBU R128，用户确认 Q8）。
 * - 编码参数与 `ffmpeg-merge.ts` 完全一致，避免拼接时二次转码漂移。
 * - 产物落库时只合并 `narration_meta.composed` 这一个键，并用合成**开始时**签好的
 *   不可变快照：ffmpeg 期间用户若改了文本/配音/匹配参数，产物不会冒充新输入的最新成片，
 *   也不会把这期间的配音/字幕元数据覆盖掉。
 */
import fs from 'fs'
import path from 'path'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { ffmpeg, checkFfmpegSuite, writeSilentWav } from '../utils/ffmpeg.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { renderSrt, parseSrt, transformCues } from './subtitle.js'
import { mediaFacts, probeVideoSpec } from './media-probe.js'
import type { ComposeFit, ComposePlan } from './narration-fit.js'
import { parseNarrationMeta, type NarrationMeta } from './narration.js'
import {
  persistedComposeReservations,
  assembleComposeInput,
  composeStatesForEpisode,
  composeSignatureVersionOf,
  inspectComposeInputs,
  isComposing,
  releaseComposeLock,
  resolveTransitionT,
  tryAcquireComposeLock,
  type ComposeStateItem,
} from './compose-state.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  parseTextTaskParams,
  textTaskOutcome,
  updateTextTaskProgress,
  type TextTaskProgress,
  type TextTaskProgressItem,
} from './text-task.js'

/** 旁白响度标准（EBU R128，用户确认 Q8） */
export const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

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
 *
 * 同镜互斥两层：进程内单镜锁（正在跑 ffmpeg）+ 运行中批量任务里的 pending/processing 行。
 * 批量自己调用时传 `batchTaskId`，这样它不会把自己刚写下的 processing 行当成冲突。
 */
export async function composeShot(
  storyboardId: number,
  opts: { batchTaskId?: number } = {},
): Promise<ComposeResult> {
  if (!tryAcquireComposeLock(storyboardId)) {
    throw new Error('该镜头正在合成中，请等待本次合成结束')
  }
  try {
    return await runComposeShot(storyboardId, opts.batchTaskId)
  } finally {
    releaseComposeLock(storyboardId)
  }
}

async function runComposeShot(storyboardId: number, batchTaskId?: number): Promise<ComposeResult> {
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法合成分镜视频。请删除 node_modules 后在本机重新安装依赖，或设置 FFMPEG_BIN/FFPROBE_BIN 后重启服务')
  }

  const input = await assembleComposeInput(storyboardId)
  const { sb, plan, fit } = input

  // 落盘预约优先于进程内锁：批量里还没轮到的镜头也不允许被单镜提交插队重复合成
  const reserved = (await persistedComposeReservations(sb.episodeId, batchTaskId)).get(storyboardId)
  if (reserved) throw new Error(`该镜头${reserved}，不能重复提交`)

  // 字幕：时间码按 tempo 缩放、按旁白起播点平移，写成临时 SRT 供 ffmpeg 烧录
  const tempDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(tempDir, { recursive: true })
  let burnSrtAbs: string | null = null
  if (input.subtitleAbs) {
    const cues = parseSrt(fs.readFileSync(input.subtitleAbs, 'utf8'))
    const shifted = transformCues(cues, { shiftMs: Math.round(plan.narrationStart * 1000), tempo: fit.tempo })
    burnSrtAbs = path.join(tempDir, `${uuid()}.srt`)
    fs.writeFileSync(burnSrtAbs, renderSrt(shifted), 'utf8')
  }
  // 无旁白且不混底音时仍要有一条等长静音轨，保证 concat 时音轨布局一致
  const silenceAbs = !input.audioAbs && fit.audioMixMode !== 'mix'
    ? path.join(tempDir, `${uuid()}-silence.wav`)
    : null
  if (silenceAbs) writeSilentWav(silenceAbs, 48000, 2, plan.d)

  const outputDir = path.join(STORAGE_ROOT, 'composed')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputName = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputName)

  logTaskStart('ShotCompose', 'compose', {
    storyboardId,
    episodeId: sb.episodeId,
    dv: input.dv.toFixed(2),
    da: input.da === null ? 'none' : input.da.toFixed(2),
    t: String(input.t),
    d: plan.d.toFixed(2),
    mixMode: fit.audioMixMode,
    burned: burnSrtAbs ? 'yes' : 'no',
  })

  // 有片头/片尾确定性片段时先拼成「全镜视频」，再原样走既有滤镜链：
  // 这样冻结末帧 / 裁尾 / 字幕烧录 / 混音的口径与纯模型视频镜头完全一致。
  let fullShotAbs: string | null = null
  try {
    if (input.preClipAbs || input.postClipAbs) {
      fullShotAbs = path.join(tempDir, `${uuid()}-fullshot.mp4`)
      await concatShotSegments(
        [input.preClipAbs, input.videoAbs, input.postClipAbs].filter((p): p is string => Boolean(p)),
        fullShotAbs,
        tempDir,
      )
    }
    await runCompose({
      videoAbs: fullShotAbs ?? input.videoAbs,
      audioAbs: input.audioAbs,
      silenceAbs,
      burnSrtAbs,
      plan,
      fit,
      outputPath,
    })
  } finally {
    if (burnSrtAbs) fs.rmSync(burnSrtAbs, { force: true })
    if (silenceAbs) fs.rmSync(silenceAbs, { force: true })
    if (fullShotAbs) fs.rmSync(fullShotAbs, { force: true })
  }

  const produced = await mediaFacts(outputPath)
  if (!produced) throw new Error('合成产物无法读取时长，可能写盘失败')
  const composedVideoUrl = `static/composed/${outputName}`
  const ts = now()

  // 合成期间用户可能改了旁白/配音/匹配参数：重新读当前行，只写 composed 这一个键，
  // 其它元数据保持数据库里的最新值（不拿合成开始时的快照覆盖）。
  const [latest] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const meta: NarrationMeta = parseNarrationMeta(latest?.narrationMeta ?? sb.narrationMeta)
  meta.composed = {
    video_src: input.parts.video_src,
    audio_src: input.parts.audio_src,
    subtitle_src: input.parts.subtitle_src,
    burned: Boolean(burnSrtAbs),
    duration_ms: produced.durationMs,
    // 签名来自合成开始时签好的不可变快照：输入在 ffmpeg 期间变过，这条成片就会被判 changed
    signature: input.signature,
    // 生效版本随「本镜有没有确定性片段」变化：无片段仍写 2，签名与 #50 之前一致
    signature_version: composeSignatureVersionOf(input.parts),
    inputs: input.parts,
    composed_at: ts,
    transition_t: input.t,
    transition_t_source: input.tSource,
  }

  await db.update(schema.storyboards).set({
    composedVideoUrl,
    narrationMeta: JSON.stringify(meta),
    updatedAt: ts,
  }).where(eq(schema.storyboards.id, storyboardId))

  logTaskSuccess('ShotCompose', 'compose', { storyboardId, composedVideoUrl, durationMs: produced.durationMs })
  return { storyboardId, composedVideoUrl, durationMs: produced.durationMs, plan, burned: Boolean(burnSrtAbs) }
}

/**
 * 把片头/模型视频/片尾拼成一段「全镜视频」（Issue #50）。
 *
 * 不用 concat demuxer：确定性片段是 25 fps，H3 模型视频是 24 fps，直接 demuxer 拼接
 * 会得到时间基混乱的 VFR 流。这里用 concat **滤镜**，先把每段统一到首段的画幅/帧率/
 * 采样率再拼，输出编码参数与 `runCompose` 完全一致，后续滤镜链感知不到它是拼出来的。
 */
async function concatShotSegments(segments: string[], outputPath: string, tempDir: string): Promise<void> {
  if (segments.length < 2) throw new Error('拼接全镜视频至少需要两段')
  const probed = await probeVideoSpec(segments[0])
  if (!probed) throw new Error(`无法读取片段规格：${segments[0]}`)
  const { width, height, fps } = probed
  const command = ffmpeg()
  const filters: string[] = []
  const audioLabels: string[] = []
  const silences: string[] = []
  for (const [index, segment] of segments.entries()) {
    command.input(segment)
    filters.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps.toFixed(5)},format=yuv420p,setpts=PTS-STARTPTS[v${index}]`,
    )
    const facts = await mediaFacts(segment)
    if (facts?.hasAudio) {
      audioLabels.push(`${index}:a`)
    } else {
      // 没有音轨的段落补一条等长静音：少一路音频 concat 会直接报错
      const silence = path.join(tempDir, `${uuid()}-concat-silence.wav`)
      writeSilentWav(silence, 48000, 2, (facts?.durationMs ?? 0) / 1000 || 0.04)
      silences.push(silence)
      audioLabels.push(`${segments.length + silences.length - 1}:a`)
    }
  }
  for (const silence of silences) command.input(silence)
  for (const [index, label] of audioLabels.entries()) {
    filters.push(`[${label}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`)
  }
  const pairs = segments.map((_, index) => `[v${index}][a${index}]`).join('')
  filters.push(`${pairs}concat=n=${segments.length}:v=1:a=1[vout][aout]`)

  // 本仓 tsconfig 的 lib 低于 es2024，没有 Promise.withResolvers
  try {
    await new Promise<void>((resolve, reject) => {
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
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(new Error(`确定性片段与模型视频拼接失败：${err.message}`)))
        .run()
    })
  } finally {
    for (const silence of silences) fs.rmSync(silence, { force: true })
  }
}

/** ffmpeg 的字幕滤镜路径转义（Windows 盘符冒号与单引号） */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

interface RunComposeInput {
  videoAbs: string
  audioAbs: string | null
  /** 无旁白且不混底音时的静音轨（真实 WAV 文件，不用 lavfi） */
  silenceAbs: string | null
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
  if (input.silenceAbs) command.input(input.silenceAbs)

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

// ─── 批量融合 ────────────────────────────────────────────────

/** 批量预览：逐镜分类（未合成 / 已变化 / 未变化 / 无法比较 / 阻断 / 进行中）与原因 */
export async function previewComposeBatch(
  episodeId: number,
  storyboardIds?: number[],
): Promise<ComposeStateItem[]> {
  return composeStatesForEpisode(episodeId, { storyboardIds })
}

export interface ComposeBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  skipped: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
  items: TextTaskProgressItem[]
}

export async function getComposeBatchStatus(episodeId: number): Promise<ComposeBatchStatus | null> {
  const row = await findLatestTextTask(episodeId, 'shot_compose')
  if (!row) return null
  const progress = parseTextTaskParams(row.params)?.progress
  return {
    status: textTaskOutcome(row.status),
    total: progress?.total ?? 0,
    completed: progress?.completed ?? 0,
    failed: progress?.failed ?? 0,
    skipped: progress?.skipped ?? 0,
    current_storyboard_id: progress?.current_storyboard_id,
    started_at: row.createdAt,
    finished_at: row.completedAt || undefined,
    error: row.errorMsg || undefined,
    items: progress?.items ?? [],
  }
}

const startingBatches = new Set<number>()

/**
 * 启动批量融合：目标必须是预览里明确勾选的分镜 id（显式空选一律拒绝，绝不扩大成整集）。
 * 勾选「未变化」的镜头视为强制重做；执行时逐镜复查依赖与签名，
 * 阻断/正在跑的镜头标记 skipped 并写明原因，不静默吞掉。
 */
export async function startComposeBatch(
  episodeId: number,
  dramaId: number,
  storyboardIds: number[],
): Promise<{ started: boolean; total: number }> {
  if (startingBatches.has(episodeId)) throw new Error('正在创建本集的批量融合任务，请稍后查看状态')
  startingBatches.add(episodeId)
  try {
    return await createComposeBatch(episodeId, dramaId, storyboardIds)
  } finally {
    startingBatches.delete(episodeId)
  }
}

async function createComposeBatch(
  episodeId: number,
  dramaId: number,
  storyboardIds: number[],
): Promise<{ started: boolean; total: number }> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  if (ep.narrationEnabled !== true) throw new Error('本集未开启旁白，无需合成')
  if (!storyboardIds.length) throw new Error('请先在预览清单里勾选要融合的镜头')

  const live = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
  const selected = live.filter(sb => storyboardIds.includes(sb.id))
  const unknownIds = storyboardIds.filter(id => !selected.some(sb => sb.id === id))
  if (unknownIds.length) {
    throw new Error(`以下镜头不属于本集或已删除，无法融合：${unknownIds.join('、')}`)
  }
  if (await findActiveTextTask(episodeId, 'shot_compose')) return { started: false, total: -1 }

  const items: TextTaskProgressItem[] = selected.map(sb => ({
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    state: 'pending',
    reason: null,
  }))
  const progress: TextTaskProgress = { completed: 0, failed: 0, skipped: 0, total: items.length, items }
  const taskId = await createTextTask({
    kind: 'shot_compose',
    episodeId,
    dramaId,
    prompt: `合成 ${items.length} 个分镜`,
    progress,
    storyboardIds: selected.map(sb => sb.id),
  })

  logTaskStart('ShotCompose', 'batch', { episodeId, total: items.length })

  void (async () => {
    for (const item of items) {
      progress.current_storyboard_id = item.storyboard_id
      item.state = 'processing'
      await updateTextTaskProgress(taskId, progress)

      // 预览之后输入可能又变了：执行前按当前库里的事实复查，变成阻断的不硬跑
      const recheck = await recheckBeforeCompose(item.storyboard_id)
      if (recheck) {
        item.state = 'skipped'
        item.reason = recheck
        progress.skipped = (progress.skipped ?? 0) + 1
        await updateTextTaskProgress(taskId, progress)
        continue
      }

      try {
        await composeShot(item.storyboard_id, { batchTaskId: taskId })
        item.state = 'completed'
        item.reason = null
        progress.completed++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        item.state = 'failed'
        item.reason = message
        progress.failed++
        logTaskError('ShotCompose', 'batch-shot', { storyboardId: item.storyboard_id, error: message })
      }
      await updateTextTaskProgress(taskId, progress)
    }
    progress.current_storyboard_id = undefined
  })()
    .then(async () => {
      await finishTextTask(taskId, progress.failed && !progress.completed ? 'failed' : 'completed', {
        progress,
        errorMsg: progress.failed ? `${progress.failed} 个镜头合成失败` : null,
      })
      logTaskProgress('ShotCompose', 'batch-done', {
        episodeId,
        completed: progress.completed,
        failed: progress.failed,
        skipped: progress.skipped ?? 0,
      })
    })
    .catch(async (err: unknown) => {
      await finishTextTask(taskId, 'failed', { progress, errorMsg: err instanceof Error ? err.message : String(err) })
    })

  return { started: true, total: items.length }
}

/** 执行前复查：返回跳过原因，可以合成时返回 null */
async function recheckBeforeCompose(storyboardId: number): Promise<string | null> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb || sb.deletedAt) return '镜头已删除'
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep || ep.narrationEnabled !== true) return '本集已关闭旁白，无需合成'
  // 本批次刚把自己标成 processing，所以这里只看进程内的单镜锁（别的批次/单镜正在跑）
  if (isComposing(storyboardId)) return '该镜头正在被另一次合成占用'

  const transition = await resolveTransitionT(storyboardId, sb.transitionReview, sb.videoUrl)
  const inspection = await inspectComposeInputs(sb, ep, transition)
  return inspection.ok ? null : inspection.reason
}
