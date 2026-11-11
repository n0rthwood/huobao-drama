/**
 * 图层段时间线（Issue #58，前端同源实现）。
 * 与 `backend/src/services/segment-timeline.ts` 必须语义等价：取景框插值、图层淡入淡出、
 * 取景框归一化（未裁切 w === h，裁切后保持整图坐标与 crop 比例）、时长钳制。编辑器用 `frameStateAt` 的输出喂
 * `layerDocToSvg(doc, size, { viewport, opacity })` 做「某一时刻画面」的所见即所得，
 * 服务端用同一套规则逐帧渲染，所以预览与成片是同一口径。
 *
 * 逐帧覆盖：某关键帧的 `ease` 覆盖「本帧 → 下一帧」这一区间的插值缓动；
 * 目标帧的 `fade_ms` 覆盖到达该帧时的淡入淡出时长。两者缺省时沿用 timeline 级的值。
 */
import { clampViewportToBox, normalizeFrameBox } from './layerQuality.js'

export const SEGMENT_DEFAULT_FADE_MS = 400
export const SEGMENT_MAX_KEYFRAMES = 60
/** 取景框最小边长（归一化）：再小就是放大到糊 */
export const SEGMENT_MIN_VIEWPORT = 0.2
export const SEGMENT_MIN_SECONDS = 1
/** 图层段时长上限（秒）：一镜一段，统一 30 秒 */
export const SEGMENT_MAX_SECONDS = 30

export const FULL_VIEWPORT = { x: 0, y: 0, w: 1, h: 1 }

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function clampSegmentDuration(seconds, maxSeconds = SEGMENT_MAX_SECONDS) {
  return round(clamp(num(seconds, SEGMENT_MIN_SECONDS), SEGMENT_MIN_SECONDS, maxSeconds), 2)
}

/**
 * 给定取景框（frame，可超出 [0,1]）时按取景框比例约束取景；没有取景框信息时沿用同比例方框。
 * 与后端 normalizeViewport(raw, frame?) 同口径，不把取景转换为 crop 相对坐标。
 */
export function normalizeViewport(raw, frame) {
  const bounds = normalizeFrameBox(frame)
  if (bounds.x !== 0 || bounds.y !== 0 || bounds.w !== 1 || bounds.h !== 1) {
    return clampViewportToBox(raw, bounds).viewport
  }
  const source = Array.isArray(raw) && raw.length >= 4
    ? { x: raw[0], y: raw[1], w: raw[2], h: raw[3] }
    : raw && typeof raw === 'object' ? raw : {}
  const numberOf = (value, fallback) => typeof value === 'number' || typeof value === 'string' ? num(value, fallback) : fallback
  const x0 = numberOf(source.x, 0)
  const y0 = numberOf(source.y, 0)
  const w0 = numberOf(source.w, 1)
  const h0 = numberOf(source.h, 1)
  // 超出整图的取景只可能来自 contain 留白（#94）：原样清洗保留，权威归一在保存/渲染/编辑器加载时做
  if (w0 > 1 || h0 > 1 || x0 < 0 || y0 < 0) return normalizeFrameBox({ x: x0, y: y0, w: w0, h: h0 })
  const size = clamp(Math.max(w0, h0), SEGMENT_MIN_VIEWPORT, 1)
  const cx = clamp(x0 + w0 / 2, 0, 1)
  const cy = clamp(y0 + h0 / 2, 0, 1)
  return { x: round(clamp(cx - size / 2, 0, 1 - size)), y: round(clamp(cy - size / 2, 0, 1 - size)), w: round(size), h: round(size) }
}

/** 时间线里出现过的全部图层 id（按首次出现的时刻排序） */
export function timelineLayerIds(timeline) {
  const ids = []
  for (const keyframe of timeline?.keyframes || []) {
    for (const id of keyframe.visible || []) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 末尾停留：段时长 − 末帧时刻（派生只读，与后端 end_hold 同口径） */
export function endHoldOf(timeline, duration) {
  const frames = timeline?.keyframes || []
  if (!frames.length) return round(Math.max(0, num(duration, 0)), 2)
  const last = frames[frames.length - 1]
  return round(Math.max(0, num(duration, 0) - num(last?.t, 0)), 2)
}

/**
 * 某一时刻的帧状态（与后端 `frameStateAt` 逐行等价）。
 * 取景框：包夹该时刻的两个关键帧之间按 ease 插值（起始帧的 ease 覆盖 timeline 级 ease），
 * 首帧之前 / 末帧之后保持不变。
 * 图层：以所处关键帧为目标、前一帧为起点，自该帧时刻起用 fade_ms（目标帧覆盖优先）过渡；
 * 首帧之前全不可见。`staged`（#96 模板文本框 id）先出后进：淡出占前半段、淡入占后半段，避免同区替换时叠字。
 */
export function frameStateAt(timeline, t, staged = []) {
  const keyframes = timeline?.keyframes?.length
    ? timeline.keyframes
    : [{ t: 0, viewport: { ...FULL_VIEWPORT }, visible: [] }]
  const time = Math.max(0, num(t, 0))

  let index = -1
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].t <= time + 1e-9) index = i
    else break
  }

  let viewport
  if (index < 0) viewport = { ...keyframes[0].viewport }
  else if (index >= keyframes.length - 1) viewport = { ...keyframes[index].viewport }
  else {
    const from = keyframes[index]
    const to = keyframes[index + 1]
    const span = to.t - from.t
    const raw = span > 1e-9 ? clamp((time - from.t) / span, 0, 1) : 1
    const ease = from.ease || timeline?.ease
    const p = ease === 'linear' ? raw : raw * raw * (3 - 2 * raw)
    viewport = {
      x: round(from.viewport.x + (to.viewport.x - from.viewport.x) * p),
      y: round(from.viewport.y + (to.viewport.y - from.viewport.y) * p),
      w: round(from.viewport.w + (to.viewport.w - from.viewport.w) * p),
      h: round(from.viewport.h + (to.viewport.h - from.viewport.h) * p),
    }
  }

  const opacity = {}
  const ids = timelineLayerIds({ keyframes })
  const target = index < 0 ? null : keyframes[index]
  const previous = index <= 0 ? null : keyframes[index - 1]
  const fade = num(
    target && target.fade_ms !== undefined && target.fade_ms !== null ? target.fade_ms : timeline?.fade_ms,
    SEGMENT_DEFAULT_FADE_MS,
  ) / 1000
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
