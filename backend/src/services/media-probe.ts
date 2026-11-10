/**
 * 媒体文件实测事实的缓存读取（Issue #42）。
 *
 * 合成状态要对整集每一镜给出实测计划与阻断原因，而分镜列表每隔几秒就会刷新一次：
 * 每次刷新都对 74 镜的视频 + 配音重跑 ffprobe 不可接受。
 *
 * 缓存键 = 绝对路径 + 字节数 + mtime(ms)：
 * - 文件被替换/重新生成/截断 → 键变化，缓存自动失效；
 * - 文件被删除 → `statMedia` 返回 null，调用方拿到「文件不存在」，缓存不会把它掩盖成就绪。
 * 因此缓存只省重复探测，不会让状态谎报新鲜度。
 */
import fs from 'fs'
import { ffmpeg } from '../utils/ffmpeg.js'

export interface MediaStat {
  size: number
  mtimeMs: number
}

/** 一次 ffprobe 能同时回答的两个事实：时长与是否带音轨 */
export interface MediaFacts {
  durationMs: number
  hasAudio: boolean
}

const cache = new Map<string, MediaFacts>()
/** 同一文件的并发探测合并成一次 ffprobe（整集首次加载时 74 镜会同时命中同一批文件） */
const inflight = new Map<string, Promise<MediaFacts | null>>()

/** 缓存键：路径 + 字节数 + mtime(ms)，文件一变键就变 */
const keyOf = (absPath: string, stat: MediaStat) => `${absPath}\u0000${stat.size}\u0000${stat.mtimeMs}`

/** 文件存在时返回大小与 mtime，不存在（或不是普通文件）返回 null */
export function statMedia(absPath: string): MediaStat | null {
  try {
    const st = fs.statSync(absPath)
    if (!st.isFile()) return null
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function runProbe(absPath: string): Promise<MediaFacts | null> {
  // 本仓 tsconfig 的 lib 低于 es2024，没有 Promise.withResolvers
  return new Promise<MediaFacts | null>((resolve) => {
    ffmpeg.ffprobe(absPath, (err, data) => {
      if (err) return resolve(null)
      const seconds = Number(data?.format?.duration)
      if (!Number.isFinite(seconds)) return resolve(null)
      resolve({
        durationMs: Math.round(seconds * 1000),
        hasAudio: (data?.streams || []).some(s => s.codec_type === 'audio'),
      })
    })
  })
}

/**
 * 读取媒体事实；文件不存在或无法解析时返回 null（调用方据此阻断，不得当作 0 秒成功）。
 */
export async function mediaFacts(absPath: string): Promise<MediaFacts | null> {
  const stat = statMedia(absPath)
  if (!stat) {
    return null
  }
  const key = keyOf(absPath, stat)
  const hit = cache.get(key)
  if (hit) return hit

  let pending = inflight.get(key)
  if (!pending) {
    pending = runProbe(absPath).then((facts) => {
      // 探测期间文件又被改写时不写缓存：下次按新的 size/mtime 重新探测
      if (facts && keyOf(absPath, statMedia(absPath) ?? stat) === key) cache.set(key, facts)
      return facts
    }).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

/** 并发上限下批量读取媒体事实（整集首次加载时避免一次 spawn 上百个 ffprobe） */
export async function mediaFactsAll(absPaths: string[], concurrency = 8): Promise<Map<string, MediaFacts | null>> {
  const unique = [...new Set(absPaths)]
  const out = new Map<string, MediaFacts | null>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= unique.length) return
      const abs = unique[index]
      out.set(abs, await mediaFacts(abs))
    }
  })
  await Promise.all(workers)
  return out
}

/** 画面规格（Issue #50 的确定性片段要与成片同规格） */
export interface VideoSpec {
  width: number
  height: number
  fps: number
}

const specCache = new Map<string, VideoSpec>()

/**
 * 读取视频的画幅与帧率；文件不存在、不是视频或尺寸缺失时返回 null
 * （调用方按画幅默认兜底，绝不猜尺寸）。
 * 与 `mediaFacts` 同一套缓存键（路径 + 大小 + mtime），整集逐镜调用不会反复 ffprobe。
 */
export async function probeVideoSpec(absPath: string): Promise<VideoSpec | null> {
  const stat = statMedia(absPath)
  if (!stat) return null
  const key = keyOf(absPath, stat)
  const cached = specCache.get(key)
  if (cached) return cached
  const spec = await new Promise<VideoSpec | null>((resolve) => {
    ffmpeg.ffprobe(absPath, (err, data) => {
      if (err) return resolve(null)
      const video = (data?.streams || []).find(stream => stream.codec_type === 'video')
      if (!video?.width || !video?.height) return resolve(null)
      const raw = String(video.avg_frame_rate || video.r_frame_rate || '')
      const [num, den] = raw.split('/').map(Number)
      const fps = den ? num / den : Number(raw)
      resolve({ width: video.width, height: video.height, fps: Number.isFinite(fps) && fps > 0 ? fps : 25 })
    })
  })
  if (spec) specCache.set(key, spec)
  return spec
}
