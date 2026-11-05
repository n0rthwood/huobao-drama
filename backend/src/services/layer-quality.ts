/** Crop and quality geometry. Keep frontend/app/utils/layerQuality.js in sync.
 * All rectangles stay normalized to the WHOLE source image; crop is a bound, not a second coordinate system.
 */
import type { LayerDoc, LayerDocBase, LayerBox } from './layer-doc.js'
import type { PreciseKeyframe, SegmentTimeline } from './segment-timeline.js'

export const QUALITY_MIN_RATIO = 1.0
const FULL = { x: 0, y: 0, w: 1, h: 1 }
const round = (n: number) => Math.round(n * 10000) / 10000
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const finite = (n: unknown, fallback: number): number => typeof n === 'number' && Number.isFinite(n) ? n : fallback

/** Invalid/empty rectangles mean full frame; valid overflow is clamped, to four decimal places. */
export function normalizeCrop(raw: unknown): LayerBox {
  if (!raw || typeof raw !== 'object') return { ...FULL }
  const r = raw as Record<string, unknown>
  if (![r.x, r.y, r.w, r.h].every(n => typeof n === 'number' && Number.isFinite(n)) || Number(r.w) <= 0 || Number(r.h) <= 0) return { ...FULL }
  const x = round(clamp(Number(r.x), 0, 0.9999))
  const y = round(clamp(Number(r.y), 0, 0.9999))
  return { x, y, w: round(clamp(Number(r.w), 0.0001, 1 - x)), h: round(clamp(Number(r.h), 0.0001, 1 - y)) }
}

/** Preserve representable framing. Match the crop's native aspect, cover the old view if possible, then fit inside bounds; changed requires a UI warning. */
export function clampViewportToCrop(viewport: unknown, crop?: unknown): { viewport: LayerBox; changed: boolean } {
  const bounds = normalizeCrop(crop)
  const r = viewport && typeof viewport === 'object' ? viewport as Record<string, unknown> : bounds
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
  return { viewport: changed ? result : r as unknown as LayerBox, changed }
}

export function clampTimelineToCrop(timeline: SegmentTimeline, crop?: unknown): { timeline: SegmentTimeline; changed: boolean } {
  let changed = false
  const keyframes = timeline.keyframes.map(frame => {
    const next = clampViewportToCrop(frame.viewport, crop)
    changed ||= next.changed
    return next.changed ? { ...frame, viewport: next.viewport } : frame
  })
  return { timeline: changed ? { ...timeline, keyframes } : timeline, changed }
}

/** Integer extraction bounds; one extract of the whole-image viewport, never crop then viewport. */
export function cropRectOf(base: Pick<LayerDocBase, 'crop'>, imageWidth: number, imageHeight: number): { left: number; top: number; width: number; height: number } {
  const crop = normalizeCrop(base.crop)
  const width = Math.max(1, Math.trunc(imageWidth))
  const height = Math.max(1, Math.trunc(imageHeight))
  const left = clamp(Math.round(crop.x * width), 0, width - 1)
  const top = clamp(Math.round(crop.y * height), 0, height - 1)
  return { left, top, width: clamp(Math.round(crop.w * width), 1, width - left), height: clamp(Math.round(crop.h * height), 1, height - top) }
}

export function effectivePixelsAt(base: LayerDocBase, viewport: LayerBox): { w: number; h: number } {
  const width = finite(base.source_width, 0)
  const height = finite(base.source_height, 0)
  return { w: Math.round(clamp(finite(viewport.w, 1), 0, 1) * width), h: Math.round(clamp(finite(viewport.h, 1), 0, 1) * height) }
}

export interface LayerQualityWarning {
  frame_index: number
  t: number
  effective_w: number
  effective_h: number
  spec_w: number
  spec_h: number
  output_w: number
  output_h: number
}

export function qualityWarningsOf(doc: LayerDoc, keyframes: PreciseKeyframe[], spec: { width: number; height: number }): LayerQualityWarning[] {
  if (!doc.base.source_width || !doc.base.source_height) return []
  const warnings: LayerQualityWarning[] = []
  keyframes.forEach((frame, frame_index) => {
    const effective = effectivePixelsAt(doc.base, frame.viewport)
    if (effective.w >= spec.width * QUALITY_MIN_RATIO && effective.h >= spec.height * QUALITY_MIN_RATIO) return
    warnings.push({ frame_index, t: frame.t, effective_w: effective.w, effective_h: effective.h, spec_w: spec.width, spec_h: spec.height, output_w: spec.width, output_h: spec.height })
  })
  return warnings
}

export function baseAspectIssue(base: LayerDocBase, spec: { width: number; height: number }): null | { aspect: string } {
  if (!base.source_width || !base.source_height) return null
  const crop = normalizeCrop(base.crop)
  const ratio = crop.w * base.source_width / (crop.h * base.source_height)
  if (Math.abs(ratio / (spec.width / spec.height) - 1) <= 0.01) return null
  const width = Math.max(1, Math.round(crop.w * base.source_width))
  const height = Math.max(1, Math.round(crop.h * base.source_height))
  let divisor = width
  let remainder = height
  while (remainder) {
    const next = divisor % remainder
    divisor = remainder
    remainder = next
  }
  return { aspect: `${width / divisor}:${height / divisor}` }
}
