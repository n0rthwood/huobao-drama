/** Whole-image frame/crop/quality math mirrors backend layer-quality; 比例不符一律 contain 留白，绝不拉伸。 */
export const QUALITY_MIN_RATIO = 1.0
const FULL = { x: 0, y: 0, w: 1, h: 1 }
/** 取景框可超出整图多少倍：1024² 底图配 9:16 成片也只到 1.77，留足余量后仍能拦住脏数据 */
export const FRAME_MAX = 8
const round = n => Math.round(n * 10000) / 10000
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const finite = (n, fallback) => typeof n === 'number' && Number.isFinite(n) ? n : fallback

export function normalizeCrop(raw) {
  if (!raw || typeof raw !== 'object') return { ...FULL }
  const r = raw
  if (![r.x, r.y, r.w, r.h].every(n => typeof n === 'number' && Number.isFinite(n)) || Number(r.w) <= 0 || Number(r.h) <= 0) return { ...FULL }
  const x = round(clamp(Number(r.x), 0, 0.9999))
  const y = round(clamp(Number(r.y), 0, 0.9999))
  return { x, y, w: round(clamp(Number(r.w), 0.0001, 1 - x)), h: round(clamp(Number(r.h), 0.0001, 1 - y)) }
}

/** 可超出整图的矩形（取景框/留白后的取景）：只做有限性与最小边长的清洗，不钳进 [0,1]。 */
export function normalizeFrameBox(raw, fallback = FULL) {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const r = raw
  if (finite(r.w, 0) <= 0 || finite(r.h, 0) <= 0) return { ...fallback }
  const w = round(clamp(finite(r.w, fallback.w), 0.0001, FRAME_MAX))
  const h = round(clamp(finite(r.h, fallback.h), 0.0001, FRAME_MAX))
  return { x: round(clamp(finite(r.x, fallback.x), -FRAME_MAX, FRAME_MAX)), y: round(clamp(finite(r.y, fallback.y), -FRAME_MAX, FRAME_MAX)), w, h }
}

/**
 * 取景框：边界像素比例与成片相差 ≤1% → cover（frame = bounds）；否则 contain，
 * 以 bounds 中心沿短边扩到成片比例（仍是整图归一化坐标，可超出 [0,1]）。
 * 源图尺寸未知时无法判断，按 cover 处理（与改动前一致）。
 */
export function baseFrameOf(base, spec) {
  const bounds = normalizeCrop(base?.crop)
  const sourceWidth = finite(base?.source_width, 0)
  const sourceHeight = finite(base?.source_height, 0)
  const output = spec && spec.width > 0 && spec.height > 0 ? spec.width / spec.height : 0
  if (!sourceWidth || !sourceHeight || !output) return { mode: 'cover', bounds, frame: bounds }
  const ratio = (bounds.w * sourceWidth) / (bounds.h * sourceHeight)
  if (Math.abs(ratio / output - 1) <= 0.01) return { mode: 'cover', bounds, frame: bounds }
  // 只扩不缩：太高就加宽，太宽就加高，底图始终完整落在 frame 内
  const w = ratio < output ? (bounds.h * sourceHeight * output) / sourceWidth : bounds.w
  const h = ratio < output ? bounds.h : (bounds.w * sourceWidth) / (output * sourceHeight)
  const frame = {
    x: round(bounds.x + (bounds.w - w) / 2),
    y: round(bounds.y + (bounds.h - h) / 2),
    w: round(clamp(w, 0.0001, FRAME_MAX)),
    h: round(clamp(h, 0.0001, FRAME_MAX)),
  }
  return { mode: 'contain', bounds, frame }
}

/** 保留可表达的取景：按框的比例、尽量覆盖原取景，再收进框内；changed 要给用户提示。 */
export function clampViewportToBox(viewport, box) {
  const bounds = box
  const r = viewport && typeof viewport === 'object' ? viewport : bounds
  const w = Math.max(0.0001, finite(r.w, bounds.w))
  const h = Math.max(0.0001, finite(r.h, bounds.h))
  const x = finite(r.x, bounds.x)
  const y = finite(r.y, bounds.y)
  const aspect = bounds.w / bounds.h
  const coverW = Math.max(w, h * aspect)
  const coverH = coverW / aspect
  const scale = Math.min(1, bounds.w / coverW, bounds.h / coverH)
  const nextW = Math.min(bounds.w, Math.max(0.0001, round(coverW * scale)))
  const nextH = Math.min(bounds.h, Math.max(0.0001, round(coverH * scale)))
  const result = {
    x: round(clamp(x + (w - nextW) / 2, bounds.x, bounds.x + bounds.w - nextW)),
    y: round(clamp(y + (h - nextH) / 2, bounds.y, bounds.y + bounds.h - nextH)),
    w: nextW,
    h: nextH,
  }
  const changed = result.x !== r.x || result.y !== r.y || result.w !== r.w || result.h !== r.h
  return { viewport: changed ? result : r, changed }
}

/** 取景归一到成片比例：以原取景中心为准，在取景框内放大/收回（渲染前的唯一口径）。 */
export function clampViewportToFrame(viewport, base, spec) {
  return clampViewportToBox(viewport, baseFrameOf(base, spec).frame)
}

export function clampTimelineToFrame(timeline, base, spec) {
  const frame = baseFrameOf(base, spec).frame
  let changed = false
  const keyframes = timeline.keyframes.map(entry => {
    const next = clampViewportToBox(entry.viewport, frame)
    changed ||= next.changed
    return next.changed ? { ...entry, viewport: next.viewport } : entry
  })
  return { timeline: changed ? { ...timeline, keyframes } : timeline, changed }
}

/** 取景框画布上的整数取景矩形：view 与 frame 都是整图归一化坐标。 */
export function frameRectOf(view, frame, canvasWidth, canvasHeight) {
  const width = Math.max(1, Math.trunc(canvasWidth))
  const height = Math.max(1, Math.trunc(canvasHeight))
  const left = clamp(Math.round(((view.x - frame.x) / frame.w) * width), 0, width - 1)
  const top = clamp(Math.round(((view.y - frame.y) / frame.h) * height), 0, height - 1)
  const rectWidth = clamp(Math.round((view.w / frame.w) * width), 1, width - left)
  // 取景比例 = 取景框比例 = 画布比例：高度按宽度回正，小画布上一两像素的取整漂移也不许变成形变
  const rectHeight = clamp(Math.round((rectWidth * height) / width), 1, height - top)
  return { left, top, width: clamp(Math.round((rectHeight * width) / height), 1, width - left), height: rectHeight }
}

export function cropRectOf(base, imageWidth, imageHeight) {
  const crop = normalizeCrop(base.crop)
  const width = Math.max(1, Math.trunc(imageWidth))
  const height = Math.max(1, Math.trunc(imageHeight))
  const left = clamp(Math.round(crop.x * width), 0, width - 1)
  const top = clamp(Math.round(crop.y * height), 0, height - 1)
  return { left, top, width: clamp(Math.round(crop.w * width), 1, width - left), height: clamp(Math.round(crop.h * height), 1, height - top) }
}

/** 取景真正吃到的源图像素：contain 的留白带不是分辨率，按底图边界求交。 */
export function effectivePixelsAt(base, viewport) {
  const width = finite(base.source_width, 0)
  const height = finite(base.source_height, 0)
  const bounds = normalizeCrop(base.crop)
  const x = finite(viewport.x, 0)
  const y = finite(viewport.y, 0)
  const w = Math.max(0, Math.min(x + finite(viewport.w, 1), bounds.x + bounds.w) - Math.max(x, bounds.x))
  const h = Math.max(0, Math.min(y + finite(viewport.h, 1), bounds.y + bounds.h) - Math.max(y, bounds.y))
  return { w: Math.round(w * width), h: Math.round(h * height) }
}

export function qualityWarningsOf(doc, keyframes, spec) {
  if (!doc.base.source_width || !doc.base.source_height) return []
  const warnings = []
  keyframes.forEach((frame, frame_index) => {
    const effective = effectivePixelsAt(doc.base, frame.viewport)
    if (effective.w >= spec.width * QUALITY_MIN_RATIO && effective.h >= spec.height * QUALITY_MIN_RATIO) return
    warnings.push({ frame_index, t: frame.t, effective_w: effective.w, effective_h: effective.h, spec_w: spec.width, spec_h: spec.height, output_w: spec.width, output_h: spec.height })
  })
  return warnings
}

/** 比例不符 = contain 留白渲染（永不拉伸），编辑器据此给出裁切/生成画幅版本的出路。 */
export function baseAspectIssue(base, spec) {
  if (baseFrameOf(base, spec).mode === 'cover') return null
  const crop = normalizeCrop(base.crop)
  const width = Math.max(1, Math.round(crop.w * (base.source_width || 0)))
  const height = Math.max(1, Math.round(crop.h * (base.source_height || 0)))
  let divisor = width
  let remainder = height
  while (remainder) {
    const next = divisor % remainder
    divisor = remainder
    remainder = next
  }
  return { aspect: `${width / divisor}:${height / divisor}`, mode: 'contain' }
}
