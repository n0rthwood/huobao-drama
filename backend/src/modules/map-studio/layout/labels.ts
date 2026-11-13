import { strictLayerDocProblems, type Layer, type LayerDoc, type LayerDocProblem } from '../../../services/layer-doc.js'
import { BASELINE_EM, LINE_HEIGHT_EM, THEME_PRESETS, layerBounds, measureTextEm, resolvedText, svgWorldOf, wrapTextEm } from '../../../services/layer-svg.js'
import { labelOverflowProblems } from '../accuracy.js'

type Point = [number, number]
export interface LabelFeature { id: string; kind: 'place' | 'route' | 'region'; points: Point[] }
export interface LabelProblem extends LayerDocProblem { code: string; layer_id: string }
export interface TextRect { layer_id: string; feature_id?: string; x: number; y: number; w: number; h: number }
export interface LabelSize { width: number; height: number }
const EPS = 1e-7
const styleOf = (layer: Layer, doc: LayerDoc, key: string): unknown => {
  const own = 'style' in layer ? layer.style[key] : undefined
  return own !== undefined && own !== null && own !== '' ? own : THEME_PRESETS[doc.theme][layer.type][key]
}

/** Normalized rendered geometry, not an invented centroid for a line or a region. */
export function labelFeaturesOf(doc: LayerDoc): LabelFeature[] {
  return doc.layers.flatMap<LabelFeature>(layer => {
    const id = layer.anchor?.semantic_id
    if (!id || !layer.visible || layer.opacity <= 0) return []
    if (layer.type === 'marker') return [{ id, kind: 'place' as const, points: [layer.at] }]
    if (layer.type === 'polyline' || layer.type === 'polygon') return [{ id, kind: layer.type === 'polygon' ? 'region' as const : 'route' as const, points: layer.points }]
    return []
  })
}

/** Same font-independent advances, wrapping, baseline and card blocks as layer-svg. Pixel boxes include text halos. */
export function textRectsOf(doc: LayerDoc, size: LabelSize = doc.base): TextRect[] {
  const world = svgWorldOf(doc, size)
  const { width, height, unit } = world
  const out: TextRect[] = []
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue
    const s = (key: string) => styleOf(layer, doc, key)
    const bounds = layerBounds(layer, doc.theme, width / height, undefined, unit / height)
    const cx = (bounds.x + bounds.w / 2) * width, cy = (bounds.y + bounds.h / 2) * height
    const block = (text: string, x: number, top: number, fontSize: number, align: string, lines = [text], halo = 0, italic = false) => {
      if (!text || !lines.some(Boolean)) return
      const w = Math.max(...lines.map(measureTextEm)) * fontSize
      const h = lines.length * fontSize * LINE_HEIGHT_EM
      let left = x - (align === 'center' ? w / 2 : align === 'right' ? w : 0)
      let right = left + w
      // emitLabel's synthetic italic skews about each baseline by -12 degrees.
      if (italic) { left -= Math.tan(12 * Math.PI / 180) * fontSize * (LINE_HEIGHT_EM - BASELINE_EM); right += Math.tan(12 * Math.PI / 180) * fontSize * BASELINE_EM }
      const angle = layer.rotation * Math.PI / 180
      const corners = [[left - halo, top - halo], [right + halo, top - halo], [right + halo, top + h + halo], [left - halo, top + h + halo]].map(([x, y]) => [cx + (x! - cx) * Math.cos(angle) - (y! - cy) * Math.sin(angle), cy + (x! - cx) * Math.sin(angle) + (y! - cy) * Math.cos(angle)])
      const xs = corners.map(p => p[0]!), ys = corners.map(p => p[1]!)
      out.push({ layer_id: layer.id, feature_id: layer.anchor?.semantic_id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) })
    }
    if (layer.type === 'marker') {
      const fontSize = Number(s('size')) * unit
      const legacy = s('label_offset') as number[]
      const dx = Number(layer.style.label_dx ?? legacy[0]), dy = Number(layer.style.label_dy ?? legacy[1])
      block(resolvedText(layer), (layer.at[0] + dx) * width, (layer.at[1] + dy) * height - fontSize * BASELINE_EM, fontSize, dx >= 0 ? 'left' : 'right', undefined, fontSize * 0.08)
    } else if (layer.type === 'label') {
      const b = layer.box, fontSize = Number(s('size')) * unit
      const pad = Number(s('bg_opacity')) > 0 ? fontSize * 0.3 : 0
      const align = String(s('align')), text = resolvedText(layer)
      const lines = wrapTextEm(text, Math.max(1, (b.w * width - pad * 2) / fontSize))
      block(text, b.x * width + (align === 'center' ? b.w * width / 2 : align === 'right' ? b.w * width - pad : pad), b.y * height + pad, fontSize, align, lines, Number(s('stroke_width')) * unit, Boolean(s('italic')))
    } else if (layer.type === 'card') {
      const x = layer.box.x * width, y = layer.box.y * height, w = layer.box.w * width, h = layer.box.h * height
      const scale = Number(s('scale') || 1), f = layer.fields
      if (layer.template === 'year' || layer.template === 'chapter') {
        const year = layer.template === 'year', subSize = h * (year ? 0.18 : 0.17) * scale
        block(f.title, x + w / 2, y + h * (year ? 0.12 : 0.14), h * (year ? 0.5 : 0.4) * scale, 'center')
        block(f.years, x + w / 2, y + h * (year ? 0.62 : 0.56), subSize, 'center')
        block(f.sub, x + w / 2, y + h * (year ? 0.72 : 0.74), subSize, 'center')
      } else {
        const pad = h * 0.14, stripe = Math.max(2, w * 0.012), titleSize = h * 0.38 * scale, subSize = h * 0.2 * scale, metaSize = h * 0.16 * scale
        const yearsTop = y + pad + titleSize * LINE_HEIGHT_EM
        block(f.title, x + stripe + pad, y + pad, titleSize, 'left')
        block(f.years, x + stripe + pad, yearsTop, subSize, 'left')
        block(f.sub, x + stripe + pad, yearsTop + (f.years ? subSize * LINE_HEIGHT_EM : 0), subSize, 'left')
        block(f.meta, x + w - pad, y + h - pad - metaSize * LINE_HEIGHT_EM, metaSize, 'right')
      }
    }
  }
  return out
}

const overlaps = (a: TextRect, b: TextRect) => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS
const pointRectDistance = (p: Point, r: TextRect) => Math.hypot(Math.max(r.x - p[0], 0, p[0] - r.x - r.w), Math.max(r.y - p[1], 0, p[1] - r.y - r.h))
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
function inside(p: Point, points: Point[]): boolean {
  let winding = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])
    if (a[1] <= p[1] && b[1] > p[1] && cross > 0) winding++
    else if (a[1] > p[1] && b[1] <= p[1] && cross < 0) winding--
  }
  return winding !== 0
}
function segmentHitsRect(a: Point, b: Point, r: TextRect): boolean {
  let lo = 0, hi = 1
  for (const [p, delta, min, max] of [[a[0], b[0] - a[0], r.x, r.x + r.w], [a[1], b[1] - a[1], r.y, r.y + r.h]]) {
    if (Math.abs(delta!) < EPS) { if (p! < min! || p! > max!) return false; continue }
    const t1 = (min! - p!) / delta!, t2 = (max! - p!) / delta!
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2))
    if (lo > hi) return false
  }
  return true
}
function featureDistance(r: TextRect, feature: LabelFeature, size: LabelSize): number {
  const points = feature.points.map(([x, y]): Point => [x * size.width, y * size.height])
  if (!points.length) return Infinity
  if (feature.kind === 'place') return pointRectDistance(points[0]!, r)
  const corners: Point[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]
  if (feature.kind === 'region' && corners.some(p => inside(p, points))) return 0
  let best = Infinity
  const count = feature.kind === 'region' ? points.length : points.length - 1
  for (let i = 0; i < count; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!
    if (segmentHitsRect(a, b, r)) return 0
    best = Math.min(best, pointRectDistance(a, r), pointRectDistance(b, r), ...corners.map(p => segmentDistance(p, a, b)))
  }
  return best
}

/** All five label gates. Pure, deterministic, and shared by drawing, manual save and editor API. */
export function labelProblems(doc: LayerDoc, size: LabelSize = doc.base, features: LabelFeature[] = labelFeaturesOf(doc)): LabelProblem[] {
  const rects = textRectsOf(doc, size)
  const out: LabelProblem[] = []
  const add = (code: string, id: string, message: string) => out.push({ code, layer_id: id, path: `layers[${doc.layers.findIndex(l => l.id === id)}]`, message: `${code}：图层 ${id} ${message}` })
  for (const problem of labelOverflowProblems(doc)) {
    const index = Number(/layers\[(\d+)\]/.exec(problem.path)?.[1])
    out.push({ ...problem, code: 'label_overflow', layer_id: doc.layers[index]?.id ?? '' })
  }
  const world = svgWorldOf(doc, size), marginX = world.width * 0.01, marginY = world.height * 0.01
  const markers = doc.layers.filter((l): l is Extract<Layer, { type: 'marker' }> => l.type === 'marker' && l.visible && l.opacity > 0)
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!
    for (let j = i + 1; j < rects.length; j++) {
      const other = rects[j]!
      if (!overlaps(r, other)) continue
      add('label_overlap', r.layer_id, `文字与图层 ${other.layer_id} 的文字重叠；请移动标签或调用 auto_layout_labels`)
      if (other.layer_id !== r.layer_id) add('label_overlap', other.layer_id, `文字与图层 ${r.layer_id} 的文字重叠；请移动标签或调用 auto_layout_labels`)
    }
    if (r.x < marginX - EPS || r.y < marginY - EPS || r.x + r.w > world.width - marginX + EPS || r.y + r.h > world.height - marginY + EPS) add('label_out_of_frame', r.layer_id, '文字越出画面或 1% 安全边，请移回画内')
    for (const marker of markers) {
      if (marker.id === r.layer_id || r.feature_id && marker.anchor?.semantic_id === r.feature_id) continue
      const radius = Number(styleOf(marker, doc, 'dot_radius')) * world.unit
      if (pointRectDistance([marker.at[0] * world.width, marker.at[1] * world.height], r) < radius - EPS) add('label_marker_overlap', r.layer_id, `文字盖住其他要素的点标记 ${marker.id}，请移动标签`)
    }
    const feature = features.find(f => f.id === r.feature_id)
    if (feature && featureDistance(r, feature, world) > Math.hypot(world.width, world.height) * 0.06 + EPS) add('label_far_from_feature', r.layer_id, `文字离锚定要素 ${feature.id} 超过画面对角线 6%，请移到该要素附近`)
  }
  return out
}

/** Approximate the pole of inaccessibility with deterministic coarse-to-fine grid refinement. */
function areaCandidates(points: Point[]): Point[] {
  if (points.length < 3) return []
  let x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]))
  let w = Math.max(...points.map(p => p[0])) - x, h = Math.max(...points.map(p => p[1])) - y
  const candidates: Array<{ p: Point; clearance: number }> = []
  for (let pass = 0; pass < 4; pass++) {
    const batch: Array<{ p: Point; clearance: number }> = []
    for (let ix = 0; ix <= 12; ix++) for (let iy = 0; iy <= 12; iy++) {
      const p: Point = [x + w * ix / 12, y + h * iy / 12]
      if (!inside(p, points)) continue
      batch.push({ p, clearance: Math.min(...points.map((a, i) => segmentDistance(p, a, points[(i + 1) % points.length]!))) })
    }
    batch.sort((a, b) => b.clearance - a.clearance)
    candidates.push(...batch)
    const best = batch[0]
    if (!best) break
    w /= 3; h /= 3; x = best.p[0] - w / 2; y = best.p[1] - h / 2
  }
  return candidates.sort((a, b) => b.clearance - a.clearance).map(c => c.p)
}

/** Greedy placement: keeps every layer, text, font size and box dimensions. Never persists. */
export function autoPlaceLabels(doc: LayerDoc, size: LabelSize = doc.base, features: LabelFeature[] = labelFeaturesOf(doc)): { doc: LayerDoc; unresolved: Array<{ layer_id: string; message: string }> } {
  const result: LayerDoc = { ...doc, layers: doc.layers.map(layer => ({ ...layer })) }
  const world = svgWorldOf(doc, size)
  const movable = result.layers.filter(layer => !layer.locked && ((layer.type === 'marker' && !!layer.text) || layer.type === 'label' && features.some(f => f.id === layer.anchor?.semantic_id)))
  const pending = new Set(movable.map(l => l.id))
  const unresolved: Array<{ layer_id: string; message: string }> = []
  for (const layer of movable) {
    pending.delete(layer.id)
    const feature = features.find(f => f.id === layer.anchor?.semantic_id) ?? (layer.type === 'marker' ? { id: layer.id, kind: 'place' as const, points: [layer.at] } : undefined)
    const originalRect = textRectsOf(result, size).find(r => r.layer_id === layer.id)
    if (!feature || !originalRect) continue
    const gap = world.height * 0.012
    const candidates: Layer[] = []
    const move = (left: number, top: number) => {
      if (layer.type === 'label') candidates.push({ ...layer, box: { ...layer.box, x: layer.box.x + (left - originalRect.x) / world.width, y: layer.box.y + (top - originalRect.y) / world.height } })
      else if (layer.type === 'marker') {
        const fontSize = Number(styleOf(layer, result, 'size')) * world.unit, halo = fontSize * 0.08
        const textWidth = measureTextEm(resolvedText(layer)) * fontSize
        const cx = layer.at[0] * world.width
        const leftText = left + halo
        const rightAligned = leftText + textWidth < cx
        const dx = (leftText + (rightAligned ? textWidth : 0) - cx) / world.width
        // N/S text starts at the point because marker SVG only supports left/right alignment.
        if (!rightAligned && dx < 0) return
        candidates.push({ ...layer, style: { ...layer.style, label_dx: dx, label_dy: (top + halo + fontSize * BASELINE_EM - layer.at[1] * world.height) / world.height } })
      }
    }
    if (feature.kind === 'place') {
      const [nx, ny] = feature.points[0]!, x = nx * world.width, y = ny * world.height
      const marker = result.layers.find(l => l.type === 'marker' && (l.id === layer.id || l.anchor?.semantic_id === feature.id))
      const radius = marker ? Number(styleOf(marker, result, 'dot_radius')) * world.unit : 0
      const d = gap + radius, w = originalRect.w, h = originalRect.h
      // E, NE, SE, W, NW, SW, N, S, in that priority order.
      for (const [left, top] of [[x + d, y - h / 2], [x + d, y - d - h], [x + d, y + d], [x - d - w, y - h / 2], [x - d - w, y - d - h], [x - d - w, y + d], [layer.type === 'marker' ? x + EPS : x - w / 2, y - d - h], [layer.type === 'marker' ? x + EPS : x - w / 2, y + d]]) move(left!, top!)
    } else if (feature.kind === 'route') {
      const points = feature.points.map(([x, y]): Point => [x * world.width, y * world.height])
      const segments = points.slice(1).map((b, i) => ({ a: points[i]!, b, length: Math.hypot(b[0] - points[i]![0], b[1] - points[i]![1]) })).sort((a, b) => b.length - a.length)
      for (const { a, b, length } of segments) {
        if (!length) continue
        const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2
        for (const sign of [-1, 1]) move(x - originalRect.w / 2 + sign * (b[1] - a[1]) / length * (originalRect.w / 2 + gap), y - originalRect.h / 2 - sign * (b[0] - a[0]) / length * (originalRect.h / 2 + gap))
      }
    } else {
      for (const p of areaCandidates(feature.points.map(([x, y]): Point => [x * world.width, y * world.height]))) move(p[0] - originalRect.w / 2, p[1] - originalRect.h / 2)
    }
    const index = result.layers.findIndex(l => l.id === layer.id)
    let accepted = false
    for (const candidate of candidates) {
      result.layers[index] = candidate
      const checkDoc = { ...result, layers: result.layers.flatMap(l => !pending.has(l.id) ? [l] : l.type === 'marker' ? [{ ...l, text: '' }] : []) }
      if (strictLayerDocProblems({ ...result, layers: [candidate] }).problems.length || labelProblems(checkDoc, size, features).some(p => p.layer_id === layer.id)) continue
      accepted = true; break
    }
    if (!accepted) {
      result.layers[index] = layer
      unresolved.push({ layer_id: layer.id, message: '没有无冲突的候选位置；标签、字号及 box 已保留，请人工调整' })
    }
  }
  // Fixed titles/cards/locked labels are never moved; report every remaining hard problem too.
  for (const p of labelProblems(result, size, features)) if (!unresolved.some(u => u.layer_id === p.layer_id)) unresolved.push({ layer_id: p.layer_id, message: p.message })
  return { doc: result, unresolved }
}
