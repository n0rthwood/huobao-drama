/**
 * 画中画细节图的语义投影（Issue #110）。
 *
 * 细节图是**同一份 map_spec** 按细节取景框确定性渲染出来的整屏图：全览上标出的点/线/面
 * 在细节图上的位置可以用同一个投影算出来。这里把全览语义的要素投影到细节图像素坐标，
 * 裁到画内，`id`/`name` 与全览语义完全一致——设计卡因此能在细节底图上 anchor / must_mark，
 * 而不是只能把细节图当一张没有标注的底图。
 *
 * 模块边界（#99）：这里只用模块内的地图几何与投影，不认识道具/剧集/语义规范；
 * 宿主拿到像素几何后自己交给 `normalizeSemantics` 落库。
 */
import { mapProjectionFor, normalizeMapSpec, type MapSpec } from '../geo/base-render.js'
import type { MapBbox } from './frames.js'

type Point = [number, number]
type Rect = [number, number, number, number]

/** 细节图上的语义几何（像素坐标，原点左上角；与 delivery.semantics 同口径） */
export interface PipDetailGeometry {
  width: number
  height: number
  points: Array<{ id: string; name: string; at: Point }>
  lines: Array<{ id: string; name: string; kind: 'river' | 'route'; points: Point[] }>
  regions: Array<{ id: string; name: string; points: Point[] }>
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000

/** Liang–Barsky：把一段线裁进矩形，返回两端点或 null */
function clipSegment(a: Point, b: Point, rect: Rect): [Point, Point] | null {
  const [x0, y0, x1, y1] = rect
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as const) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return null
  }
  const at = (t: number): Point => [a[0] + dx * t, a[1] + dy * t]
  return [at(t0), at(t1)]
}

/** 折线裁进矩形：只保留最长的一段可见连续折线（细节图是局部取景，断开的部分不属于这一帧） */
function clipPolyline(points: Point[], rect: Rect): Point[] | null {
  const runs: Point[][] = []
  let current: Point[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const clipped = clipSegment(points[i]!, points[i + 1]!, rect)
    if (!clipped) { if (current.length >= 2) runs.push(current); current = []; continue }
    const [start, end] = clipped
    if (!current.length) current.push(start)
    else if (Math.abs(current[current.length - 1]![0] - start[0]) > 1e-6 || Math.abs(current[current.length - 1]![1] - start[1]) > 1e-6) {
      if (current.length >= 2) runs.push(current)
      current = [start]
    }
    current.push(end)
  }
  if (current.length >= 2) runs.push(current)
  if (!runs.length) return null
  return runs.reduce((best, run) => (run.length > best.length ? run : best))
}

/** Sutherland–Hodgman：多边形裁进矩形 */
function clipPolygon(points: Point[], rect: Rect): Point[] {
  const [x0, y0, x1, y1] = rect
  const edges: Array<{ inside: (p: Point) => boolean; at: (a: Point, b: Point) => Point }> = [
    { inside: p => p[0] >= x0, at: (a, b) => [x0, a[1] + (b[1] - a[1]) * ((x0 - a[0]) / (b[0] - a[0]))] },
    { inside: p => p[0] <= x1, at: (a, b) => [x1, a[1] + (b[1] - a[1]) * ((x1 - a[0]) / (b[0] - a[0]))] },
    { inside: p => p[1] >= y0, at: (a, b) => [a[0] + (b[0] - a[0]) * ((y0 - a[1]) / (b[1] - a[1])), y0] },
    { inside: p => p[1] <= y1, at: (a, b) => [a[0] + (b[0] - a[0]) * ((y1 - a[1]) / (b[1] - a[1])), y1] },
  ]
  let output = points
  for (const edge of edges) {
    const input = output
    output = []
    if (!input.length) break
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!
      const b = input[(i + 1) % input.length]!
      const aIn = edge.inside(a)
      const bIn = edge.inside(b)
      if (aIn && bIn) output.push(b)
      else if (aIn && !bIn) output.push(edge.at(a, b))
      else if (!aIn && bIn) output.push(edge.at(a, b), b)
    }
  }
  return output
}

function featureById(spec: MapSpec): Map<string, { kind: 'place' | 'route' | 'region'; name: string; coords: Point[]; category?: string; hasDataset?: boolean }> {
  const map = new Map<string, { kind: 'place' | 'route' | 'region'; name: string; coords: Point[]; category?: string; hasDataset?: boolean }>()
  for (const place of spec.places) map.set(place.id, { kind: 'place', name: place.name, coords: [[place.lon, place.lat]] })
  for (const route of spec.routes) map.set(route.id, { kind: 'route', name: route.name, coords: route.points, category: route.category, hasDataset: !!route.dataset_ref })
  for (const region of spec.regions ?? []) map.set(region.id, { kind: 'region', name: region.name, coords: region.points })
  return map
}

/**
 * 把全览语义要素投影到细节图。`ids` 是**全览语义里的要素 id**（细节与全览共用同一 id）；
 * 只投影这些要素，保证细节图上能 anchor 的条目与全览语义清单逐条对应。
 */
export function projectDetailSemantics(
  specRaw: unknown,
  bboxRaw: unknown,
  size: { width: number; height: number },
  ids: readonly string[],
): PipDetailGeometry {
  const spec = normalizeMapSpec(specRaw)
  const bbox = bboxRaw as MapBbox
  const projectionSpec: MapSpec = { ...spec, bbox, detail_level: 'regional' }
  const projection = mapProjectionFor(projectionSpec, size)
  const rect: Rect = [0, 0, size.width, size.height]
  const features = featureById(spec)
  const out: PipDetailGeometry = { width: size.width, height: size.height, points: [], lines: [], regions: [] }
  const toPx = (coord: Point): Point | null => {
    const projected = projection(coord)
    return projected ? [round4(projected[0]), round4(projected[1])] : null
  }
  for (const id of ids) {
    const feature = features.get(id)
    if (!feature) continue
    if (feature.kind === 'place') {
      const at = toPx(feature.coords[0]!)
      if (!at || at[0] < 0 || at[0] > size.width || at[1] < 0 || at[1] > size.height) continue
      out.points.push({ id, name: feature.name, at })
      continue
    }
    const pixels = feature.coords.map(toPx).filter((p): p is Point => p !== null)
    if (pixels.length < 2) continue
    if (feature.kind === 'route') {
      const clipped = clipPolyline(pixels, rect)
      if (!clipped) continue
      out.lines.push({
        id, name: feature.name,
        kind: feature.category === 'river' || feature.hasDataset ? 'river' : 'route',
        points: clipped.map(([x, y]) => [round4(x), round4(y)]),
      })
      continue
    }
    const clipped = clipPolygon(pixels, rect)
    if (clipped.length < 3) continue
    out.regions.push({ id, name: feature.name, points: clipped.map(([x, y]) => [round4(x), round4(y)]) })
  }
  return out
}
