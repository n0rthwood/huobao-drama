/**
 * 视频海报帧提取 — 供 <video poster> 使用，避免列表页为显示首帧而缓冲整个视频
 */
import path from 'path'
import fs from 'fs'
import { getAbsolutePath } from './storage.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'

/** 由视频相对路径推导海报帧路径：static/videos/x.mp4 → static/videos/x_poster.jpg */
export function posterPathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_poster.jpg')
}

/**
 * 抽取视频 0.5s 处画面作为海报帧（宽 640，等比缩放，与原视频同目录）。
 * 失败返回 null，不阻断主流程。
 */
export async function extractVideoPoster(relativePath: string): Promise<string | null> {
  try {
    // ffmpeg 二进制损坏（跨平台拷贝 node_modules / 下载不完整）时静默跳过，
    // 避免 fluent-ffmpeg 延迟回调里的同步 EFTYPE 崩掉整个进程
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) return null

    const posterRel = posterPathFor(relativePath)
    const posterAbs = getAbsolutePath(posterRel)
    await new Promise<void>((resolve, reject) => {
      ffmpeg(getAbsolutePath(relativePath))
        .screenshots({
          timestamps: ['0.5'],
          filename: path.basename(posterAbs),
          folder: path.dirname(posterAbs),
          size: '640x?',
        })
        .on('end', () => resolve())
        .on('error', reject)
    })
    return posterRel
  } catch (err) {
    console.warn(`[video-poster] 海报帧提取失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}

/** 提取视频最后一个可解码画面，供后一镜首帧衔接使用。 */
export async function extractVideoTailFrame(relativePath: string): Promise<string> {
  const input = getAbsolutePath(relativePath)
  if (!fs.existsSync(input)) throw new Error('上一镜采用的视频文件不存在，请重新选择或生成上一镜视频')
  const tailRel = relativePath.replace(/\.[^./]+$/, '_tail.jpg')
  const tailAbs = getAbsolutePath(tailRel)
  if (fs.existsSync(tailAbs)) return tailRel

  const { ffmpeg: ffmpegOk, ffprobe: ffprobeOk } = await checkFfmpegSuite()
  if (!ffmpegOk || !ffprobeOk) throw new Error('本机 ffmpeg 不可用，无法提取上一镜尾帧')
  const duration = await new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(input, (err, metadata) => {
      if (err) reject(err)
      else resolve(Number(metadata.format.duration || 0))
    })
  })
  if (!duration) throw new Error('无法读取上一镜视频时长，不能提取尾帧')

  await new Promise<void>((resolve, reject) => {
    ffmpeg(input)
      .seekInput(Math.max(0, duration - 0.08))
      .outputOptions(['-frames:v', '1', '-q:v', '2'])
      .output(tailAbs)
      .on('end', () => resolve())
      .on('error', reject)
      .run()
  })
  return tailRel
}
