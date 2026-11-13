import type { MapSpec } from './geo/base-render.js'
import type { MapRelation, MapVerification } from './types.js'
import type { LayerDoc } from '../../services/layer-doc.js'
import { THEME_PRESETS, LINE_HEIGHT_EM, wrapTextEm, measureTextEm, resolvedText } from '../../services/layer-svg.js'

export type Point = [number, number]
export type Extent = [number, number, number, number]
export function validExtent(raw: unknown): raw is Extent {
  return Array.isArray(raw) && raw.length === 4 && raw.every(n => typeof n === 'number' && Number.isFinite(n))
    && raw[0] >= -180 && raw[2] <= 180 && raw[1] >= -90 && raw[3] <= 90
    && raw[0] < raw[2] && raw[1] < raw[3] && raw[2] - raw[0] <= 360 && raw[3] - raw[1] <= 180
}
export function extentProblems(points: Point[], extent: Extent): string[] {
  const inside = ([x, y]: Point, margin: number) => x >= extent[0] + margin * (extent[2] - extent[0])
    && x <= extent[2] - margin * (extent[2] - extent[0]) && y >= extent[1] + margin * (extent[3] - extent[1])
    && y <= extent[3] - margin * (extent[3] - extent[1])
  const problems: string[] = []
  for (const point of points) {
    if (inside(point, 0.02)) continue
    problems.push(!inside(point, 0) && inside([point[1], point[0]], 0)
      ? `疑似经纬度互换：(${point.join(', ')}) 不在 extent 内，而 (${point[1]}, ${point[0]}) 在范围内`
      : `坐标 (${point.join(', ')}) 超出 extent 或其 2% 留边；请核对坐标或空间范围`)
    if (problems.length >= 5) break
  }
  return problems
}
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2
  return 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}
export function nearestRiverKm(point: Point, parts: Point[][]): number {
  let best = Infinity
  const cos = Math.cos(point[1] * Math.PI / 180)
  for (const line of parts) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!
    const dx = (b[0] - a[0]) * cos, dy = b[1] - a[1]
    const t = dx || dy ? Math.max(0, Math.min(1, (((point[0] - a[0]) * cos) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0
    best = Math.min(best, distanceKm(point, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]))
  }
  return best
}
export function computeRelation(raw: Omit<MapRelation, 'computed' | 'message'>, subject: Point, object: Point, river?: Point[][]): MapRelation {
  let actual: number | undefined, consistent: boolean
  if (raw.relation === 'distance_km') {
    actual = distanceKm(subject, object)
    consistent = Math.abs(actual - raw.value_km!) <= Math.max(raw.tolerance_km ?? 0, raw.value_km! * 0.3, 5)
  } else if (raw.relation === 'near_river') {
    actual = nearestRiverKm(subject, river ?? [])
    consistent = actual <= Math.max(raw.tolerance_km ?? 0, 15)
  } else {
    consistent = raw.relation === 'east_of' ? subject[0] > object[0] : raw.relation === 'west_of' ? subject[0] < object[0]
      : raw.relation === 'north_of' ? subject[1] > object[1] : subject[1] < object[1]
  }
  return { ...raw, computed: { ...(actual !== undefined ? { value_km: actual } : {}), consistent },
    message: `${raw.subject} / ${raw.object}：声明 ${raw.relation}${raw.value_km !== undefined ? ` ${raw.value_km} km` : ''}；按坐标计算 ${actual !== undefined ? `${actual.toFixed(2)} km` : consistent ? '方向一致' : '方向相反'}` }
}
/** Coordinate claims must actually contain a coordinate pair, not just mention the place. */
export function excerptSupportsPoint(text: string, point: Point): boolean {
  const decimal = [...text.matchAll(/(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([NSEW北南东西])/gi)].map(m => ({
    value: Number(m[1]) * (/^[SW南西]$/i.test(m[2]!) ? -1 : 1), lat: /^[NS北南]$/i.test(m[2]!),
  }))
  const dms = [...text.matchAll(/(\d{1,3})[°度]\s*(\d{1,2})[′'分]\s*(?:(\d{1,2}(?:\.\d+)?)[″"秒])?\s*([NSEW北南东西])/gi)].map(m => ({
    value: (Number(m[1]) + Number(m[2]) / 60 + Number(m[3] ?? 0) / 3600) * (/^[SW南西]$/i.test(m[4]!) ? -1 : 1), lat: /^[NS北南]$/i.test(m[4]!),
  }))
  const prefix = [...text.matchAll(/([东西]经|[南北]纬)\s*(\d{1,3}(?:\.\d+)?)\s*[°度]?(?:\s*(\d{1,2})[′'分](?:\s*(\d{1,2}(?:\.\d+)?)[″"秒])?)?/g)].map(m => ({
    value: (Number(m[2]) + Number(m[3] ?? 0) / 60 + Number(m[4] ?? 0) / 3600) * (/^[西南]/.test(m[1]!) ? -1 : 1), lat: /纬$/.test(m[1]!),
  }))
  const coords = [...decimal, ...dms, ...prefix]
  if (coords.some(c => !c.lat && Math.abs(c.value - point[0]) <= 0.1) && coords.some(c => c.lat && Math.abs(c.value - point[1]) <= 0.1)) return true
  const labelled = /(?:经度|longitude|lon)\s*[:：=]?\s*(-?\d+(?:\.\d+)?)[\s\S]{0,40}?(?:纬度|latitude|lat)\s*[:：=]?\s*(-?\d+(?:\.\d+)?)/gi
  return [...text.matchAll(labelled)].some(m => Math.abs(Number(m[1]) - point[0]) <= 0.1 && Math.abs(Number(m[2]) - point[1]) <= 0.1)
}
export function geometryUnverified(spec: MapSpec | null): Array<{ id: string; name: string; reasons: string[] }> {
  if (!spec) return [{ id: '', name: '地图几何', reasons: ['尚无几何'] }]
  return [...spec.places, ...spec.routes, ...spec.regions].flatMap(feature => {
    if (feature.proposed !== true || feature.origin === 'manual') return []
    if (feature.verification?.status === 'verified' && feature.origin !== undefined) return []
    return [{ id: feature.id, name: feature.name, reasons: feature.verification?.reasons?.length ? feature.verification.reasons : ['AI 提议的坐标缺少可核验依据，请人工确认'] }]
  })
}
export function confirmedVerification(): MapVerification { return { status: 'confirmed', reasons: ['人工确认或编辑'] } }

/** Match the shared SVG renderer's typography; report rather than resize or truncate. */
export function labelOverflowProblems(doc: LayerDoc): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = []
  const width = doc.base.width, height = doc.base.height
  doc.layers.forEach((layer, index) => {
    if (!layer.visible || (layer.type !== 'label' && layer.type !== 'card')) return
    const b = layer.box, w = b.w * width, h = b.h * height
    const preset = THEME_PRESETS[doc.theme][layer.type]
    const style = (key: string) => layer.style[key] ?? preset[key]
    let lines = 0, need = 0, tooWide = false
    if (layer.type === 'label') {
      const size = Number(style('size')) * height
      const pad = Number(style('bg_opacity')) > 0 ? size * 0.3 : 0
      const wrapped = wrapTextEm(resolvedText(layer), Math.max(1, (w - 2 * pad) / size))
      lines = wrapped.length; need = lines * size * LINE_HEIGHT_EM + 2 * pad
      tooWide = wrapped.some(text => measureTextEm(text) * size > w - 2 * pad + 0.01)
    } else {
      const scale = Number(style('scale') || 1), f = layer.fields
      const blocks: Array<{ text: string; size: number; top: number; available: number }> = []
      if (layer.template === 'year' || layer.template === 'chapter') {
        const year = layer.template === 'year'
        blocks.push({ text: f.title, size: h * (year ? 0.5 : 0.4) * scale, top: h * (year ? 0.12 : 0.14), available: w })
        if (f.years) blocks.push({ text: f.years, size: h * (year ? 0.18 : 0.17) * scale, top: h * (year ? 0.62 : 0.56), available: w })
        if (f.sub) blocks.push({ text: f.sub, size: h * (year ? 0.18 : 0.17) * scale, top: h * (year ? 0.72 : 0.74), available: w })
      } else {
        const pad = h * 0.14, available = w - Math.max(2, w * 0.012) - 2 * pad
        const titleSize = h * 0.38 * scale, subSize = h * 0.2 * scale
        blocks.push({ text: f.title, size: titleSize, top: pad, available })
        if (f.years) blocks.push({ text: f.years, size: subSize, top: pad + titleSize * LINE_HEIGHT_EM, available })
        if (f.sub) blocks.push({ text: f.sub, size: subSize, top: pad + titleSize * LINE_HEIGHT_EM + (f.years ? subSize * LINE_HEIGHT_EM : 0), available })
        if (f.meta) blocks.push({ text: f.meta, size: h * 0.16 * scale, top: h - pad - h * 0.16 * scale * LINE_HEIGHT_EM, available: w - 2 * pad })
      }
      for (const block of blocks) {
        const count = wrapTextEm(block.text, Math.max(1, block.available / block.size)).length
        lines += count; need = Math.max(need, block.top + count * block.size * LINE_HEIGHT_EM)
        if (measureTextEm(block.text) * block.size > block.available) tooWide = true
      }
    }
    // Include rotated boxes when checking the canvas bounds.
    const angle = layer.rotation * Math.PI / 180
    const rw = Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle))
    const rh = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle))
    const cx = (b.x + b.w / 2) * width, cy = (b.y + b.h / 2) * height
    if (need > h + 0.01 || tooWide || cx - rw / 2 < -0.01 || cy - rh / 2 < -0.01 || cx + rw / 2 > width + 0.01 || cy + rh / 2 > height + 0.01) {
      out.push({ path: `layers[${index}]`, message: `label_overflow：图层 ${layer.id} 需要 ${lines} 行 / ${need.toFixed(1)}px，高度为 ${h.toFixed(1)}px${tooWide ? '，文字超出可用宽度' : ''}；文本及 box 必须完整落在画内，请调整 box 或字号` })
    }
  })
  return out
}
