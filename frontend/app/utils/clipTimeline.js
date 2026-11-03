/**
 * 确定性片段时间线（Issue #50，前端同源实现）。
 * 与 `backend/src/services/clip-timeline.ts` 必须语义等价：取景框插值、图层淡入淡出、
 * 取景框归一化（w === h）、时长钳制。编辑器用 `frameStateAt` 的输出喂
 * `layerDocToSvg(doc, size, { viewport, opacity })` 做「某一时刻画面」的所见即所得，
 * 服务端用同一套规则逐帧渲染，所以预览与成片是同一口径。
 */

export const CLIP_DEFAULT_FADE_MS = 400
export const CLIP_MAX_STATES = 60
/** 取景框最小边长（归一化）：再小就是放大到糊 */
export const CLIP_MIN_VIEWPORT = 0.2
export const CLIP_MIN_SECONDS = 1
/** `replace` 整镜替代片段的时长上限（秒）；pre/post 用镜头上限 15 秒 */
export const CLIP_MAX_SECONDS = 30
export const CLIP_PREPOST_MAX_SECONDS = 15

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

/** 某个位置的时长上限（秒） */
export function maxClipSeconds(position) {
  return position === 'replace' ? CLIP_MAX_SECONDS : CLIP_PREPOST_MAX_SECONDS
}

export function clampClipDuration(seconds, maxSeconds) {
  return round(clamp(num(seconds, CLIP_MIN_SECONDS), CLIP_MIN_SECONDS, maxSeconds), 2)
}

/**
 * 取景框规范化：钳进画面内、保证最小边长，宽高按归一化等值对齐（w === h 才是与整幅同比例）。
 * 与后端 `normalizeViewport` 同口径：以较大的一边为准放大另一边，宁可多框一点也不变形。
 */
export function normalizeViewport(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const size = clamp(Math.max(num(source.w, 1), num(source.h, 1)), CLIP_MIN_VIEWPORT, 1)
  const x = clamp(num(source.x, 0), 0, 1 - size)
  const y = clamp(num(source.y, 0), 0, 1 - size)
  return { x: round(x), y: round(y), w: round(size), h: round(size) }
}

/** 时间线里出现过的全部图层 id（按首次出现的时刻排序） */
export function timelineLayerIds(timeline) {
  const ids = []
  for (const state of timeline.states || []) {
    for (const id of state.visible || []) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * 某一时刻的帧状态（与后端 `frameStateAt` 逐行等价）。
 * 取景框：包夹该时刻的两个状态间按 ease 插值，首状态之前 / 末状态之后保持不变。
 * 图层：以所处状态为目标、前一状态为起点，自状态时刻起用 fade_ms 过渡；首状态之前全不可见。
 */
export function frameStateAt(timeline, t) {
  const states = timeline?.states?.length ? timeline.states : [{ t: 0, viewport: { ...FULL_VIEWPORT }, visible: [] }]
  const time = Math.max(0, num(t, 0))

  let index = -1
  for (let i = 0; i < states.length; i++) {
    if (states[i].t <= time + 1e-9) index = i
    else break
  }

  let viewport
  if (index < 0) viewport = { ...states[0].viewport }
  else if (index >= states.length - 1) viewport = { ...states[index].viewport }
  else {
    const from = states[index]
    const to = states[index + 1]
    const span = to.t - from.t
    const raw = span > 1e-9 ? clamp((time - from.t) / span, 0, 1) : 1
    const p = timeline.ease === 'linear' ? raw : raw * raw * (3 - 2 * raw)
    viewport = {
      x: round(from.viewport.x + (to.viewport.x - from.viewport.x) * p),
      y: round(from.viewport.y + (to.viewport.y - from.viewport.y) * p),
      w: round(from.viewport.w + (to.viewport.w - from.viewport.w) * p),
      h: round(from.viewport.h + (to.viewport.h - from.viewport.h) * p),
    }
  }

  const opacity = {}
  const ids = timelineLayerIds({ states })
  const fade = num(timeline?.fade_ms, CLIP_DEFAULT_FADE_MS) / 1000
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
