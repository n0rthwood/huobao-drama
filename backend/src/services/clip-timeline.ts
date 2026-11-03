/**
 * 确定性片段的时间线（Issue #50）——纯函数：schema / 规范化 / 逐帧插值。
 *
 * 时间线只描述「什么时候、画面取哪一块、哪些图层可见」：
 * - `states[]` 是**关键状态**（不是关键帧），数量不限（父 Issue 评审采纳：关键帧不止 2–3 张）；
 * - 两个状态之间的取景框按 `ease` 线性/缓动插值（Ken Burns）；
 * - 图层的出现/消失在状态时刻起算，用 `fade_ms` 做淡入淡出，不做位移动画。
 *
 * 不读库、不碰 ffmpeg / sharp：渲染器（`clip-render.ts`）只消费这里算出的
 * `FrameState`，所以同一份时间线在单测、服务端渲染、前端预览里必然一致。
 */
import { z } from 'zod'

/** 取景框：归一化 0–1，相对图层文档坐标系（= 成片画幅） */
export interface ClipViewport {
  x: number
  y: number
  w: number
  h: number
}

/** 关键状态：某一时刻的取景框 + 该时刻起可见的图层集合 */
export interface ClipState {
  /** 相对片段开头的秒数 */
  t: number
  viewport: ClipViewport
  /** 此刻起可见的图层 id（全量集合，不是增量） */
  visible: string[]
}

export type ClipEase = 'linear' | 'inout'

export interface ClipTimeline {
  fps: number
  ease: ClipEase
  /** 图层出现/消失的淡入淡出时长（毫秒） */
  fade_ms: number
  states: ClipState[]
}

/** 某一帧真正要渲染的东西：取景框 + 每个图层的不透明度（0 = 不画） */
export interface FrameState {
  viewport: ClipViewport
  opacity: Record<string, number>
}

export const CLIP_FPS_MIN = 1
export const CLIP_FPS_MAX = 60
export const CLIP_DEFAULT_FPS = 25
export const CLIP_DEFAULT_FADE_MS = 400
export const CLIP_MAX_STATES = 60
/** 取景框最小边长（归一化）：再小就是放大到糊 */
export const CLIP_MIN_VIEWPORT = 0.2
/** 片段最短时长（秒） */
export const CLIP_MIN_SECONDS = 1
/**
 * `replace` 片段的时长上限（秒，父 Issue #44 Q5 ✅）。
 * 含模型视频的镜头仍走 `MAX_SHOT_SECONDS=15`，这个上限只对整镜替代的确定性片段生效。
 */
export const MAX_CLIP_SECONDS = 30

export const FULL_VIEWPORT: ClipViewport = { x: 0, y: 0, w: 1, h: 1 }

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

const viewportIn = z.preprocess(
  value => {
    if (Array.isArray(value)) return { x: value[0], y: value[1], w: value[2], h: value[3] }
    return value && typeof value === 'object' ? value : {}
  },
  z.object({ x: numberIn, y: numberIn, w: numberIn, h: numberIn }),
)

const stateIn = z.object({
  t: numberIn,
  // zod 4 里裸 z.unknown() 在对象里是**必填**的：缺 viewport 的状态会整条被丢掉
  viewport: z.unknown().optional(),
  visible: z.preprocess(
    value => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []),
    z.array(z.string()),
  ),
})

const timelineIn = z.object({
  fps: numberIn,
  ease: z.preprocess(value => (value === 'linear' ? 'linear' : 'inout'), z.enum(['linear', 'inout'])),
  fade_ms: numberIn,
  states: z.preprocess(value => (Array.isArray(value) ? value : []), z.array(z.unknown())),
})

/**
 * 取景框规范化：钳进画面内、保证最小边长，并把宽高**按归一化等值**对齐。
 * 归一化坐标系里 `w === h` 才等于「与整幅同比例」（像素上就是 w·W : h·H = W : H），
 * 不等就会把画面拉伸，所以这里以较大的一边为准放大另一边，宁可多框一点也不变形。
 */
export function normalizeViewport(raw: unknown): ClipViewport {
  const parsed = viewportIn.safeParse(raw)
  const box = parsed.success ? parsed.data : {}
  const x0 = box.x ?? 0
  const y0 = box.y ?? 0
  const w0 = box.w ?? 1
  const h0 = box.h ?? 1
  const size = clamp(Math.max(w0, h0), CLIP_MIN_VIEWPORT, 1)
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
export function viewportFromPoints(points: Array<[number, number]>, pad = 1.3): ClipViewport {
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

function normalizeState(raw: unknown): ClipState | null {
  const parsed = stateIn.safeParse(raw)
  if (!parsed.success) return null
  return {
    t: Math.max(0, round(parsed.data.t ?? 0, 3)),
    viewport: normalizeViewport(parsed.data.viewport),
    visible: [...new Set(parsed.data.visible)],
  }
}

/**
 * 规范化时间线：钳 fps / fade、状态按时刻稳定排序、同一时刻只留最后一条。
 * 结构非法时退化为「单状态全图、无可见图层」，渲染器永远拿得到可用输入。
 */
export function normalizeTimeline(raw: unknown): ClipTimeline {
  const parsed = timelineIn.safeParse(raw)
  const input = parsed.success ? parsed.data : { fps: undefined, ease: 'inout' as const, fade_ms: undefined, states: [] }
  const states = input.states
    .map(normalizeState)
    .filter((state): state is ClipState => state !== null)
    .map((state, index) => ({ state, index }))
    .sort((a, b) => (a.state.t - b.state.t) || (a.index - b.index))
    .map(entry => entry.state)
    .slice(0, CLIP_MAX_STATES)
  const deduped: ClipState[] = []
  for (const state of states) {
    const last = deduped[deduped.length - 1]
    if (last && Math.abs(last.t - state.t) < 1e-6) deduped[deduped.length - 1] = state
    else deduped.push(state)
  }
  if (!deduped.length) deduped.push({ t: 0, viewport: { ...FULL_VIEWPORT }, visible: [] })
  return {
    fps: Math.round(clamp(input.fps ?? CLIP_DEFAULT_FPS, CLIP_FPS_MIN, CLIP_FPS_MAX)),
    ease: input.ease,
    fade_ms: Math.round(clamp(input.fade_ms ?? CLIP_DEFAULT_FADE_MS, 0, 5000)),
    states: deduped,
  }
}

/** 时间线里出现过的全部图层 id（按首次出现的时刻排序） */
export function timelineLayerIds(timeline: ClipTimeline): string[] {
  const out: string[] = []
  for (const state of timeline.states) {
    for (const id of state.visible) if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 某一时刻的帧状态。
 *
 * 取景框：在包夹该时刻的两个状态之间按 `ease` 插值；首个状态之前 / 末个状态之后保持不变。
 * 图层：以**该时刻所处的状态**为目标值、前一个状态为起点，自状态时刻起用 `fade_ms` 过渡。
 * 首个状态之前一律不可见——片段开头先给观众看干净的底图，再逐层显现。
 */
export function frameStateAt(timeline: ClipTimeline, t: number): FrameState {
  const { states } = timeline
  const time = Math.max(0, t)

  let index = -1
  for (let i = 0; i < states.length; i++) {
    if (states[i].t <= time + 1e-9) index = i
    else break
  }

  // 取景框
  let viewport: ClipViewport
  if (index < 0) viewport = { ...states[0].viewport }
  else if (index >= states.length - 1) viewport = { ...states[index].viewport }
  else {
    const from = states[index]
    const to = states[index + 1]
    const span = to.t - from.t
    const raw = span > 1e-9 ? clamp((time - from.t) / span, 0, 1) : 1
    // smoothstep：起止都减速，Ken Burns 推近不会在两端出现突兀的速度跳变
    const p = timeline.ease === 'linear' ? raw : raw * raw * (3 - 2 * raw)
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
  const fade = timeline.fade_ms / 1000
  const target = index < 0 ? null : states[index]
  const previous = index <= 0 ? null : states[index - 1]
  const progress = target ? (fade > 1e-6 ? clamp((time - target.t) / fade, 0, 1) : 1) : 0
  for (const id of ids) {
    const to = target && target.visible.includes(id) ? 1 : 0
    const from = previous && previous.visible.includes(id) ? 1 : 0
    opacity[id] = round(from + (to - from) * progress, 3)
  }
  return { viewport, opacity }
}

/** 帧数：按 fps 与时长取整，至少 1 帧 */
export function frameCount(timeline: ClipTimeline, duration: number): number {
  return Math.max(1, Math.round(Math.max(CLIP_MIN_SECONDS, duration) * timeline.fps))
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
export function minViewportSize(timeline: ClipTimeline): number {
  let min = 1
  for (const state of timeline.states) min = Math.min(min, state.viewport.w, state.viewport.h)
  return clamp(min, CLIP_MIN_VIEWPORT, 1)
}

/** 片段时长钳制：`replace` 用 30 秒上限，其余（夹在模型视频前后的）用传入的上限 */
export function clampClipDuration(seconds: number, maxSeconds: number): number {
  const value = Number.isFinite(seconds) ? seconds : CLIP_MIN_SECONDS
  return round(clamp(value, CLIP_MIN_SECONDS, maxSeconds), 3)
}
