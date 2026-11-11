/**
 * 图层段的精确关键帧时间线（Issue #58，原 `clip-timeline.ts`）——纯函数：schema / 规范化 / 逐帧插值。
 *
 * 时间线只描述「什么时候、画面取哪一块、哪些图层可见」：
 * - `keyframes[]` 是**精确关键帧**（#50 时期叫 `states[]`，迁移时兼容读入），数量不限；
 * - 两个关键帧之间的取景框按 `ease` 插值（Ken Burns），逐帧可用 `ease` 覆盖本区间的缓动；
 * - 图层的出现/消失在关键帧时刻起算，用 `fade_ms` 做淡入淡出（逐帧可覆盖），不做位移动画。
 *
 * 不读库、不碰 ffmpeg / sharp：渲染器（`layer-segment-render.ts`）只消费这里算出的
 * `FrameState`，所以同一份时间线在单测、服务端渲染、前端预览里必然一致。
 */
import { z } from 'zod'
import { clampViewportToBox, normalizeFrameBox } from './layer-quality.js'

/** 取景框：归一化 0–1，相对图层文档坐标系（= 成片画幅） */
export interface SegmentViewport {
  x: number
  y: number
  w: number
  h: number
}

export type SegmentEase = 'linear' | 'inout'

/** 精确关键帧：某一时刻的取景框 + 该时刻起可见的图层集合 */
export interface PreciseKeyframe {
  /** 相对图层段开头的秒数 */
  t: number
  viewport: SegmentViewport
  /** 此刻起可见的图层 id（全量集合，不是增量） */
  visible: string[]
  /** 本帧到下一帧的缓动（缺省沿用时间线级 `ease`） */
  ease?: SegmentEase
  /** 本帧触发的淡入淡出时长（毫秒，缺省沿用时间线级 `fade_ms`） */
  fade_ms?: number
}

export interface SegmentTimeline {
  fps: number
  ease: SegmentEase
  /** 图层出现/消失的淡入淡出时长（毫秒） */
  fade_ms: number
  keyframes: PreciseKeyframe[]
}

/** 某一帧真正要渲染的东西：取景框 + 每个图层的不透明度（0 = 不画） */
export interface FrameState {
  viewport: SegmentViewport
  opacity: Record<string, number>
}

export const SEGMENT_FPS_MIN = 1
export const SEGMENT_FPS_MAX = 60
export const SEGMENT_DEFAULT_FPS = 25
export const SEGMENT_DEFAULT_FADE_MS = 400
export const SEGMENT_MAX_KEYFRAMES = 60
/** 取景框最小边长（归一化）：再小就是放大到糊 */
export const SEGMENT_MIN_VIEWPORT = 0.2
/** 图层段最短时长（秒） */
export const SEGMENT_MIN_SECONDS = 1
/**
 * 图层段时长上限（秒，用户确认 #44 Q5 / 二轮 C·D 组合 30+15）。
 * 与 position 无关：一镜只有一个图层段，上限恒为 30 秒。
 */
export const MAX_LAYER_SEGMENT_SECONDS = 30

export const FULL_VIEWPORT: SegmentViewport = { x: 0, y: 0, w: 1, h: 1 }

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 外部输入（库里的 JSON 列、编辑器 PUT 的 body）一律先过 schema 再读字段——
 * 与 `layer-doc.ts` 同一套口径：宽容解析 + 范围钳制，绝不因为一个坏字段整段失效。
 */
const numberIn = z.preprocess(value => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}, z.number().optional())

const easeIn = z.preprocess(
  value => (value === 'linear' ? 'linear' : value === 'inout' ? 'inout' : undefined),
  z.enum(['linear', 'inout']).optional(),
)

const viewportIn = z.preprocess(
  value => {
    if (Array.isArray(value)) return { x: value[0], y: value[1], w: value[2], h: value[3] }
    return value && typeof value === 'object' ? value : {}
  },
  z.object({ x: numberIn, y: numberIn, w: numberIn, h: numberIn }),
)

const keyframeIn = z.object({
  t: numberIn,
  // zod 4 里裸 z.unknown() 在对象里是**必填**的：缺 viewport 的关键帧会整条被丢掉
  viewport: z.unknown().optional(),
  visible: z.preprocess(
    value => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []),
    z.array(z.string()),
  ),
  ease: easeIn,
  fade_ms: numberIn,
})

const timelineIn = z.object({
  fps: numberIn,
  ease: z.preprocess(value => (value === 'linear' ? 'linear' : 'inout'), z.enum(['linear', 'inout'])),
  fade_ms: numberIn,
  // 旧键名 `states`（#50）在 normalizeTimeline 里先归一到 `keyframes`，这里只收数组
  keyframes: z.preprocess(value => (Array.isArray(value) ? value : []), z.array(z.unknown())),
})

/**
 * 取景框规范化：钳进取景框内、保证最小边长。给定 `frame`（底图取景框，可超出 [0,1]）时
 * 按取景框的比例归一；没有取景框信息时退回「整幅同比例」口径——归一化坐标系里 `w === h`
 * 才等于与整幅同比例（像素上就是 w·W : h·H = W : H），以较大的一边为准放大另一边。
 */
export function normalizeViewport(raw: unknown, frame?: unknown): SegmentViewport {
  const bounds = normalizeFrameBox(frame)
  if (bounds.x !== 0 || bounds.y !== 0 || bounds.w !== 1 || bounds.h !== 1) {
    return clampViewportToBox(raw, bounds).viewport
  }
  const parsed = viewportIn.safeParse(raw)
  const box = parsed.success ? parsed.data : {}
  const x0 = box.x ?? 0
  const y0 = box.y ?? 0
  const w0 = box.w ?? 1
  const h0 = box.h ?? 1
  // 超出整图的取景只可能来自 contain 留白（#94）：原样清洗保留，别把留白带squash掉；
  // 权威归一（按成片比例）在保存、渲染与编辑器加载时用真实成片规格做。
  if (w0 > 1 || h0 > 1 || x0 < 0 || y0 < 0) return normalizeFrameBox({ x: x0, y: y0, w: w0, h: h0 })
  const size = clamp(Math.max(w0, h0), SEGMENT_MIN_VIEWPORT, 1)
  const cx = clamp(x0 + w0 / 2, 0, 1)
  const cy = clamp(y0 + h0 / 2, 0, 1)
  return {
    x: round(clamp(cx - size / 2, 0, 1 - size)),
    y: round(clamp(cy - size / 2, 0, 1 - size)),
    w: round(size),
    h: round(size),
  }
}

/** 把若干归一化点的外接框按 `pad` 倍放大成取景框（`pad=1.3` 即四周各留 15%） */
export function viewportFromPoints(points: Array<[number, number]>, pad = 1.3): SegmentViewport {
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const [px, py] of points) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue
    minX = Math.min(minX, px)
    minY = Math.min(minY, py)
    maxX = Math.max(maxX, px)
    maxY = Math.max(maxY, py)
  }
  if (minX > maxX || minY > maxY) return { ...FULL_VIEWPORT }
  const w = (maxX - minX) * pad
  const h = (maxY - minY) * pad
  return normalizeViewport({ x: minX - (w - (maxX - minX)) / 2, y: minY - (h - (maxY - minY)) / 2, w, h })
}

function normalizeKeyframe(raw: unknown, crop?: unknown): PreciseKeyframe | null {
  const parsed = keyframeIn.safeParse(raw)
  if (!parsed.success) return null
  const frame: PreciseKeyframe = {
    t: Math.max(0, round(parsed.data.t ?? 0, 3)),
    viewport: normalizeViewport(parsed.data.viewport, crop),
    visible: [...new Set(parsed.data.visible)],
  }
  if (parsed.data.ease) frame.ease = parsed.data.ease
  if (parsed.data.fade_ms !== undefined) frame.fade_ms = Math.round(clamp(parsed.data.fade_ms, 0, 5000))
  return frame
}

/**
 * 规范化时间线：钳 fps / fade、关键帧按时刻稳定排序、同一时刻只留最后一条。
 * 结构非法时退化为「单帧全图、无可见图层」，渲染器永远拿得到可用输入。
 * 读入时兼容 #50 的旧键名 `states`（一次性迁移与存量 JSON 列）。
 */
export function normalizeTimeline(raw: unknown, crop?: unknown): SegmentTimeline {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const input = { ...source, keyframes: Array.isArray(source.keyframes) ? source.keyframes : source.states }
  const parsed = timelineIn.safeParse(input)
  const data = parsed.success
    ? parsed.data
    : { fps: undefined, ease: 'inout' as const, fade_ms: undefined, keyframes: [] as unknown[] }
  const frames = data.keyframes
    .map(frame => normalizeKeyframe(frame, crop))
    .filter((frame): frame is PreciseKeyframe => frame !== null)
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => (a.frame.t - b.frame.t) || (a.index - b.index))
    .map(entry => entry.frame)
    .slice(0, SEGMENT_MAX_KEYFRAMES)
  const deduped: PreciseKeyframe[] = []
  for (const frame of frames) {
    const last = deduped[deduped.length - 1]
    if (last && Math.abs(last.t - frame.t) < 1e-6) deduped[deduped.length - 1] = frame
    else deduped.push(frame)
  }
  if (!deduped.length) deduped.push({ t: 0, viewport: normalizeViewport(undefined, crop), visible: [] })
  return {
    fps: clamp(data.fps ?? SEGMENT_DEFAULT_FPS, SEGMENT_FPS_MIN, SEGMENT_FPS_MAX),
    ease: data.ease,
    fade_ms: Math.round(clamp(data.fade_ms ?? SEGMENT_DEFAULT_FADE_MS, 0, 5000)),
    keyframes: deduped,
  }
}

/** 时间线里出现过的全部图层 id（按首次出现的时刻排序） */
export function timelineLayerIds(timeline: SegmentTimeline): string[] {
  const out: string[] = []
  for (const frame of timeline.keyframes) {
    for (const id of frame.visible) if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 某一时刻的帧状态。
 *
 * 取景框：在包夹该时刻的两个关键帧之间按 `ease` 插值；首帧之前 / 末帧之后保持不变。
 * 图层：以**该时刻所处的关键帧**为目标值、前一个关键帧为起点，自关键帧时刻起用 `fade_ms` 过渡。
 * 首个关键帧之前一律不可见——图层段开头先给观众看干净的底图，再逐层显现。
 *
 * `staged`（Issue #96，模板文本框 id）：这些图层「先出后进」——淡出在过渡前半段完成、淡入在后半段才开始，
 * 同一位置区的框互相替换时不会在过渡中叠在一起（交叉淡化会让两块底板与两段文字同时半透明重叠）。
 */
export function frameStateAt(timeline: SegmentTimeline, t: number, staged: string[] = []): FrameState {
  const frames = timeline.keyframes
  const time = Math.max(0, t)

  let index = -1
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].t <= time + 1e-9) index = i
    else break
  }

  // 取景框
  let viewport: SegmentViewport
  if (index < 0) viewport = { ...frames[0].viewport }
  else if (index >= frames.length - 1) viewport = { ...frames[index].viewport }
  else {
    const from = frames[index]
    const to = frames[index + 1]
    const span = to.t - from.t
    const raw = span > 1e-9 ? clamp((time - from.t) / span, 0, 1) : 1
    // smoothstep：起止都减速，Ken Burns 推近不会在两端出现突兀的速度跳变
    const ease = from.ease ?? timeline.ease
    const p = ease === 'linear' ? raw : raw * raw * (3 - 2 * raw)
    viewport = {
      x: round(from.viewport.x + (to.viewport.x - from.viewport.x) * p),
      y: round(from.viewport.y + (to.viewport.y - from.viewport.y) * p),
      w: round(from.viewport.w + (to.viewport.w - from.viewport.w) * p),
      h: round(from.viewport.h + (to.viewport.h - from.viewport.h) * p),
    }
  }

  // 图层不透明度
  const opacity: Record<string, number> = {}
  const ids = timelineLayerIds(timeline)
  const target = index < 0 ? null : frames[index]
  const previous = index <= 0 ? null : frames[index - 1]
  const fade = (target?.fade_ms ?? timeline.fade_ms) / 1000
  const progress = target ? (fade > 1e-6 ? clamp((time - target.t) / fade, 0, 1) : 1) : 0
  for (const id of ids) {
    const to = target && target.visible.includes(id) ? 1 : 0
    const from = previous && previous.visible.includes(id) ? 1 : 0
    const step = staged.includes(id)
      ? (to > from ? clamp(progress * 2 - 1, 0, 1) : to < from ? clamp(progress * 2, 0, 1) : progress)
      : progress
    opacity[id] = round(from + (to - from) * step, 3)
  }
  return { viewport, opacity }
}

/**
 * 帧数：按 fps 与时长取整，至少 1 帧。
 * fps 由**本集成片规格**决定（协调者裁决：与 probeIntroSpec 同口径），不是时间线里的用户选项；
 * `timeline.fps` 只是保存时同步下来的派生值。
 */
export function frameCount(fps: number, duration: number): number {
  return Math.max(1, Math.round(Math.max(SEGMENT_MIN_SECONDS, duration) * fps))
}

/**
 * 帧缓存键：取景框取 4 位小数、不透明度取 3 位小数。
 * 静止段（取景框不动、无淡入）相邻帧的键相同，渲染器直接复用上一帧的像素。
 */
export function frameKeyOf(frame: FrameState): string {
  const ids = Object.keys(frame.opacity).sort()
  return [
    frame.viewport.x.toFixed(4),
    frame.viewport.y.toFixed(4),
    frame.viewport.w.toFixed(4),
    frame.viewport.h.toFixed(4),
    ...ids.map(id => `${id}:${frame.opacity[id].toFixed(3)}`),
  ].join('|')
}

/** 时间线里取景框最小的那一边（归一化）：渲染器据此决定底图要预放大到多少 */
export function minViewportSize(timeline: SegmentTimeline): number {
  let min = 1
  for (const frame of timeline.keyframes) min = Math.min(min, frame.viewport.w, frame.viewport.h)
  return clamp(min, SEGMENT_MIN_VIEWPORT, 1)
}

/** 图层段时长钳制：下限 1 秒、上限 30 秒（`MAX_LAYER_SEGMENT_SECONDS`） */
export function clampSegmentDuration(seconds: number, maxSeconds = MAX_LAYER_SEGMENT_SECONDS): number {
  const value = Number.isFinite(seconds) ? seconds : SEGMENT_MIN_SECONDS
  return round(clamp(value, SEGMENT_MIN_SECONDS, maxSeconds), 3)
}

/**
 * 末尾停留（派生值，契约 §3.2 裁决 1）：`duration − 末个精确关键帧 t`。
 * 不设列，`duration` 是权威；编辑器只展示。
 */
export function clampEndHold(seconds: number): number {
  return Number.isFinite(seconds) ? round(Math.max(0, seconds), 3) : 0
}

export function endHoldOf(timeline: SegmentTimeline, duration: number): number {
  let last = 0
  for (const frame of timeline.keyframes) last = Math.max(last, frame.t)
  return clampEndHold(duration - last)
}
