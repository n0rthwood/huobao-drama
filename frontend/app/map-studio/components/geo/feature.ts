/**
 * 要素层面的纯规则（Issue #126 阶段 2）：点数、待核对口径、几何中点、坐标输入校验。
 *
 * 待核对数量必须与后端 `accuracy.ts:88-95` 的 geometryUnverified 同口径：
 * dataset_missing 一律计入；其余为 proposed===true 且非 manual/verified/confirmed。
 * 单独统计 proposed 时只能叫「AI 候选数 / AI candidate count」，不能冒充待核对。
 */

export type FeatureKind = 'place' | 'route' | 'region'
export type LinearKind = 'route' | 'region'

export interface FeatureGeometry {
  id: string
  name: string
  origin?: string
  proposed?: boolean
  verification?: { status?: string; reasons?: string[] }
  dataset_ref?: { ref?: string; clip_bbox?: unknown }
  lon?: number
  lat?: number
  points?: Array<[number, number]>
}

export const LINE_MIN_VERTICES = 2
export const REGION_MIN_VERTICES = 3
export const LON_RANGE: [number, number] = [-180, 180]
export const LAT_RANGE: [number, number] = [-90, 90]

/** 闭合面存储里首尾可以重复：重复的收尾点不单独计为一个顶点 */
export function vertexCount(kind: FeatureKind, points: Array<[number, number]>): number {
  if (kind !== 'region' || points.length < 2) return points.length
  const first = points[0]!
  const last = points[points.length - 1]!
  return first[0] === last[0] && first[1] === last[1] ? points.length - 1 : points.length
}

export function minVertices(kind: LinearKind): number {
  return kind === 'region' ? REGION_MIN_VERTICES : LINE_MIN_VERTICES
}

export function isDatasetMissing(feature: FeatureGeometry): boolean {
  return feature.verification?.reasons?.some(reason => reason.includes('dataset_missing')) === true
}

/** 与后端 geometryUnverified 同口径 */
export function isGeometryUnverified(feature: FeatureGeometry): boolean {
  if (isDatasetMissing(feature)) return true
  if (feature.proposed !== true) return false
  const status = feature.verification?.status
  return feature.origin !== 'manual' && status !== 'verified' && status !== 'confirmed'
}

export function isConfirmed(feature: FeatureGeometry): boolean {
  return feature.verification?.status === 'confirmed'
}

export function isManualGeometry(feature: FeatureGeometry): boolean {
  return feature.origin === 'manual'
}

/** 面的开放环是否带重复收尾点 */
export function isClosedRing(kind: FeatureKind, points: Array<[number, number]>): boolean {
  return kind === 'region' && points.length > 1 && points[0]![0] === points[points.length - 1]![0] && points[0]![1] === points[points.length - 1]![1]
}

/** 相邻两点经纬度中点（设计 §3.2：插入顶点默认取相邻经纬度中点，不做投影曲线中点猜测） */
export function coordinateMidpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

export function segmentCount(kind: LinearKind, points: Array<[number, number]>): number {
  const count = vertexCount(kind, points)
  if (count < 2) return 0
  return kind === 'region' ? count : count - 1
}

/** 有限数 + 经纬度范围校验；返回 null 表示还不该写草稿（保留输入缓冲） */
export function parseCoordinate(axis: 'lon' | 'lat', raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  const [min, max] = axis === 'lon' ? LON_RANGE : LAT_RANGE
  return value >= min && value <= max ? value : null
}

/** 坐标数值的展示：保留原精度，不用固定小数位截断 */
export function formatCoordinate(value: number): string {
  return String(value)
}

/** 要素坐标序列（地点为单点），用于深链 hash 与草稿比较 */
export function featureCoordinates(feature: FeatureGeometry): Array<[number, number]> {
  if (feature.points) return feature.points.map(point => [point[0], point[1]])
  if (typeof feature.lon === 'number' && typeof feature.lat === 'number') return [[feature.lon, feature.lat]]
  return []
}
