/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { completionStamp } from './media-time.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite, writeSilentWav } from '../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { composeStatesForEpisode, type ComposeStateItem } from './compose-state.js'
import type { FfprobeData } from 'fluent-ffmpeg'

// promisify loses the result type of fluent-ffmpeg's overloaded callback API.
const probeFile = promisify(ffmpeg.ffprobe) as (file: string) => Promise<FfprobeData>

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

/**
 * 导出被阻断：带逐镜原因，路由渲染成 400 + `blocked` 数组。
 * 「所选镜头里只要有一条不可用就拒绝」——不静默少镜，也不拿过期成片凑成功。
 */
export class MergeBlockedError extends Error {
  readonly blocked: { storyboard_id: number; storyboard_number: number; status: string; reason: string }[]

  constructor(blocked: MergeBlockedError['blocked']) {
    super(`以下镜头还不能拼接：${blocked.map(b => `#${b.storyboard_number}（${b.reason}）`).join('；')}`)
    this.name = 'MergeBlockedError'
    this.blocked = blocked
  }
}

/** 融合状态 → 导出时的阻断原因（状态自带原因就用它，保证两处口径一致） */
function exportBlockReason(state: ComposeStateItem): string {
  if (state.reason) return state.reason
  if (state.status === 'missing') return '尚未合成带旁白字幕的版本'
  if (state.status === 'changed') {
    return `融合成片已过期：${state.change_reasons.join('、') || '输入已变化'}，请重新融合后再导出`
  }
  if (state.status === 'unknown') return '旧版合成记录无法核验，请重新融合后再导出'
  return '当前不可用于导出'
}

/**
 * 拼接一集的镜头视频。
 *
 * - 旁白开关关闭：沿用既有口径（视频生成产物优先，兼容历史 composedVideoUrl）。
 * - 旁白开关打开：只取**签名匹配且依赖就绪**的融合成片（compose_state.exportable），
 *   过期/未融合/文件丢失一律不进成片。
 * - 未传 storyboard_ids 表示选择整集；显式数组表示用户所选范围。
 *   该范围只要有一条不可用就整单拒绝（400 + 逐镜原因），不静默少镜；
 *   用户要做部分导出必须明确缩小选择。
 * - 软删除的镜头一律不参与。
 */
export interface MergeIntro {
  /** static/ 相对路径 */
  imagePath: string
  duration: number
}

export async function mergeEpisodeVideos(
  episodeId: number,
  dramaId: number,
  storyboardIds?: number[],
  intro?: MergeIntro,
): Promise<{ mergeId: number; skipped: { storyboard_number: number; reason: string }[] }> {
  const live = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))

  // undefined = 整集范围；显式数组（含空数组）= 用户明确选择，不得扩大
  const explicit = storyboardIds !== undefined
  if (explicit && !storyboardIds.length) throw new Error('没有选择任何镜头，无法拼接')
  const storyboards = explicit
    ? live.filter(sb => storyboardIds.includes(sb.id))
    : live
  if (explicit) {
    const unknownIds = storyboardIds.filter(id => !storyboards.some(sb => sb.id === id))
    if (unknownIds.length) throw new Error(`以下镜头不属于本集或已删除，无法拼接：${unknownIds.join('、')}`)
  }

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const narrationEnabled = episode?.narrationEnabled === true

  const skipped: { storyboard_number: number; reason: string }[] = []
  const blocked: MergeBlockedError['blocked'] = []
  const clips: { sb: typeof live[number]; url: string }[] = []

  if (narrationEnabled) {
    // 开关打开时只认「与当前输入一致」的融合成片：不静默混入原始视频，也不用过期成片
    const states = await composeStatesForEpisode(episodeId, {
      storyboardIds: storyboards.map(sb => sb.id),
      rows: live,
      episode,
    })
    const stateById = new Map(states.map(state => [state.storyboard_id, state]))
    for (const sb of storyboards) {
      const state = stateById.get(sb.id)
      if (state?.exportable && sb.composedVideoUrl) {
        clips.push({ sb, url: sb.composedVideoUrl })
        continue
      }
      const reason = state ? exportBlockReason(state) : '无法判断融合状态'
      blocked.push({
        storyboard_id: sb.id,
        storyboard_number: sb.storyboardNumber,
        status: state?.status ?? 'blocked',
        reason,
      })
    }
  } else {
    for (const sb of storyboards) {
      const url = sb.videoUrl || sb.composedVideoUrl
      if (url) {
        clips.push({ sb, url })
        continue
      }
      blocked.push({
        storyboard_id: sb.id,
        storyboard_number: sb.storyboardNumber,
        status: 'missing',
        reason: '尚未生成视频',
      })
    }
  }

  if (blocked.length) throw new MergeBlockedError(blocked)
  if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
  // 这里提前拦截并给出可操作的修复指引（路由层会作为 400 返回前端）
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频（常见于 node_modules 跨平台拷贝或 ffmpeg-static 下载损坏）。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务')
  }

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => `S${c.sb.storyboardNumber}`).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  const videos = clips.map(c => c.url)

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const res = await db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    introImage: intro?.imagePath ?? null,
    introDuration: intro?.duration ?? null,
    createdAt: ts,
  })
  const mergeId = getInsertId(res)

  // 异步执行
  doMerge(mergeId, episodeId, videos, intro).catch(async err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    await db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId))
  })

  return { mergeId, skipped }
}

interface IntroSpec {
  width: number
  height: number
  fps: number
  sampleRate: number
  channels: number
}

/** 按首个片段探测片头需要匹配的流参数；尺寸不可读时直接报错，不猜测画幅。 */
async function probeIntroSpec(firstClip: string): Promise<IntroSpec> {
  const metadata = await probeFile(toAbsPath(firstClip))
  const video = metadata.streams.find(stream => stream.codec_type === 'video')
  if (!video?.width || !video?.height) throw new Error('首个视频片段没有有效的画面尺寸')
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio')
  const fpsRaw = String(video.avg_frame_rate || video.r_frame_rate || '30/1')
  const [num, den] = fpsRaw.split('/').map(Number)
  const fps = den ? num / den : Number(fpsRaw)
  return {
    width: video.width,
    height: video.height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    sampleRate: Number(audio?.sample_rate) || 48000,
    channels: Number(audio?.channels) === 1 ? 1 : 2,
  }
}

/**
 * 静态 Poster 片头：循环图片 + 静音音轨，缩放到片段分辨率（保持比例、居中留边），
 * 帧率/采样率/声道与首个片段一致，保证 concat demuxer 不因参数不一致花屏。
 */
async function createIntroSegment(imagePath: string, duration: number, spec: IntroSpec, dir: string): Promise<string> {
  const segmentPath = path.join(dir, `${uuid()}-intro.mp4`)
  const silentPath = path.join(dir, `${uuid()}-silence.wav`)
  writeSilentWav(silentPath, spec.sampleRate, spec.channels, duration)
  const filter = [
    `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease`,
    `pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${spec.fps}`,
    'format=yuv420p',
  ].join(',')
  const command = ffmpeg()
    .input(toAbsPath(imagePath))
    .inputOptions(['-loop', '1', '-framerate', String(spec.fps), '-t', String(duration)])
    .input(silentPath)
    .outputOptions([
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ar', String(spec.sampleRate),
      '-ac', String(spec.channels),
      '-b:a', '192k',
      '-t', String(duration),
      '-shortest',
      '-movflags', '+faststart',
    ])
    .output(segmentPath)
  const finished = once(command, 'end')
  try {
    command.run()
    await finished
    return segmentPath
  } finally {
    fs.rmSync(silentPath, { force: true })
  }
}

async function doMerge(mergeId: number, episodeId: number, videos: string[], intro?: MergeIntro) {
  // 生成 concat 列表文件
  const listDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)

  const introPath = intro
    ? await createIntroSegment(intro.imagePath, intro.duration, await probeIntroSpec(videos[0]!), listDir)
    : null

  const listContent = [
    ...(introPath ? [`file '${introPath}'`] : []),
    ...videos.map(v => `file '${toAbsPath(v)}'`),
  ].join('\n')
  fs.writeFileSync(listPath, listContent, 'utf-8')

  // 输出文件
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  try {
    const command = ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-fflags', '+genpts',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
    const finished = once(command, 'end')
    command.run()
    await finished
  } finally {
    fs.rmSync(listPath, { force: true })
    if (introPath) fs.rmSync(introPath, { force: true })
  }

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 成片海报帧（导出页封面用）
  await extractVideoPoster(mergedRelative)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, ...completionStamp() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', {
    mergeId,
    episodeId,
    output: mergedRelative,
    duration,
    clips: videos.length,
    intro: intro ? { image: intro.imagePath, duration: intro.duration } : null,
  })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}
