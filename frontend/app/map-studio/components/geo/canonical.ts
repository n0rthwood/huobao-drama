/**
 * 顶点行深链的几何版本指纹（设计 03 §5.3/§11.2/§12.5，Issue #126）。
 *
 * `msggeorev` 的唯一含义是「该要素**已保存**几何坐标序列的 canonical hash」，不是 task revision：
 * - 只取坐标（名称、verification、task 状态变化都不改变它），保留数组顺序与全部精度；
 * - 不因闭合几何等价而擅自归并，不舍入、不重排；
 * - 插点、删点或改坐标必然改变 hash，即使行号仍合法也要退回要素级。
 *
 * 算法：JSON.stringify 的数值表示是 64 位 double 的最短往返形式（确定、无损），
 * 再取 FNV-1a 32 位；浏览器无同步 SHA-256，这里用纯函数保证恢复与生成两侧一致。
 */

export type CoordinatePoint = [number, number]

/** 要素坐标序列的 canonical JSON：只含坐标本身 */
export function canonicalCoordinates(points: ReadonlyArray<CoordinatePoint>): string {
  return JSON.stringify(points.map(point => [point[0], point[1]]))
}

/** FNV-1a 32 位，返回 8 位十六进制 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 已保存坐标序列的内容指纹；点数用于诊断，不声称非密码学 hash 没有碰撞。 */
export function coordinateHash(points: ReadonlyArray<CoordinatePoint>): string {
  const canonical = canonicalCoordinates(points)
  return `fnv1a32:${fnv1a(canonical)}:${points.length}`
}

/** 要素（地点用单点坐标）的已保存几何 hash；坐标缺失/非有限返回 null */
export function featureGeometryHash(feature: { lon?: number; lat?: number; points?: ReadonlyArray<CoordinatePoint> }): string | null {
  if (feature.points) {
    if (!feature.points.length || feature.points.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return null
    return coordinateHash(feature.points)
  }
  if (typeof feature.lon !== 'number' || typeof feature.lat !== 'number') return null
  if (!Number.isFinite(feature.lon) || !Number.isFinite(feature.lat)) return null
  return coordinateHash([[feature.lon, feature.lat]])
}
