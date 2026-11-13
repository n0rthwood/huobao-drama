/**
 * 外部图像的地理配准（Issue #84）
 *
 * 场景：用户拿来一张档案馆/博物馆的历史示意图（Europeana、Smithsonian 等），要在上面做标注。
 * 这类图**不是**按某个投影画的正规地图，没有 bbox 可言，所以绝不能假装它是「bbox 对齐的墨卡托」
 * ——那正是第一轮把殷墟点画到燕山以北的那类错误。唯一诚实的做法是让人在图上点若干控制点
 * （像素 ↔ 经纬度），用最小二乘拟合仿射变换，并**把残差报出来**：残差多大，标注就只能信到多准。
 *
 * 仿射（6 参数）足以表达平移/旋转/缩放/错切，覆盖绝大多数扫描件与示意图。更高阶的多项式/薄板样条
 * 会在控制点稀疏时剧烈外推，把误差藏起来，这里故意不做。
 */

/** 控制点：图上像素 (x, y) 对应的真实经纬度 */
export interface ControlPoint { x: number; y: number; lon: number; lat: number }

/** `x = a*lon + b*lat + c`，`y = d*lon + e*lat + f` */
export type AffineForward = [number, number, number, number, number, number]
/** `lon = A*x + B*y + C`，`lat = D*x + E*y + F` */
export type AffineInverse = [number, number, number, number, number, number]

export interface AffineCalibration {
  forward: AffineForward
  inverse: AffineInverse
  residual_px: { max: number; rms: number }
  control_points: ControlPoint[]
}

export class CalibrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalibrationError'
  }
}

/** 退化判据：控制点在经纬度或像素空间里近似共线时，仿射的一个方向完全没有约束 */
const COLLINEAR_RATIO = 1e-3

function solve3(matrix: number[][], rhs: number[]): number[] | null {
  // 高斯消元 + 部分主元；3×3 规模下直接写比引库清楚
  const a = matrix.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) { const tmp = a[pivot]; a[pivot] = a[col]; a[col] = tmp }
    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const factor = a[row][col] / a[col][col]
      for (let k = col; k < 4; k++) a[row][k] -= factor * a[col][k]
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]]
}

/** 点集相对自身跨度的「离线度」：越接近 0 越共线 */
function collinearity(points: Array<[number, number]>): number {
  let spread = 0
  let best: [number, number] = [0, 0]
  let anchor: [number, number] = points[0]
  for (const p of points) {
    for (const q of points) {
      const distance = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (distance > spread) { spread = distance; anchor = p; best = q }
    }
  }
  if (spread === 0) return 0
  const dx = (best[0] - anchor[0]) / spread
  const dy = (best[1] - anchor[1]) / spread
  let worst = 0
  for (const p of points) {
    // 到最长弦所在直线的垂距，按跨度归一
    const offset = Math.abs((p[0] - anchor[0]) * dy - (p[1] - anchor[1]) * dx) / spread
    if (offset > worst) worst = offset
  }
  return worst
}

/**
 * 最小二乘拟合仿射变换。控制点少于 3 个、近似共线、或拟合出的变换不可逆时抛
 * CalibrationError（消息里写清楚是哪一条不满足、怎么补救）。
 */
export function fitAffine(points: ControlPoint[], image: { width: number; height: number }): AffineCalibration {
  if (!Array.isArray(points) || points.length < 3) {
    throw new CalibrationError(`外部底图配准至少需要 3 个控制点，当前 ${Array.isArray(points) ? points.length : 0} 个`)
  }
  for (const [index, point] of points.entries()) {
    for (const [field, value] of [['x', point.x], ['y', point.y], ['lon', point.lon], ['lat', point.lat]] as const) {
      if (!Number.isFinite(value)) {
        throw new CalibrationError(`控制点 #${index + 1} 的 ${field} 不是有限数值：${String(value)}`)
      }
    }
    if (point.lon < -180 || point.lon > 180 || point.lat < -90 || point.lat > 90) {
      throw new CalibrationError(`控制点 #${index + 1} 的经纬度超界：lon=${point.lon} lat=${point.lat}`)
    }
    if (point.x < 0 || point.x > image.width || point.y < 0 || point.y > image.height) {
      throw new CalibrationError(
        `控制点 #${index + 1} 的像素坐标 (${point.x}, ${point.y}) 落在图像 ${image.width}×${image.height} 之外`,
      )
    }
  }

  const geoSpread = collinearity(points.map(p => [p.lon, p.lat] as [number, number]))
  if (geoSpread < COLLINEAR_RATIO) {
    throw new CalibrationError(
      '控制点的经纬度近似共线，无法确定仿射变换的第二个方向：请选取三角形分布的控制点（例如图面左上、右上、下方各一个）',
    )
  }
  const pixelSpread = collinearity(points.map(p => [p.x, p.y] as [number, number]))
  if (pixelSpread < COLLINEAR_RATIO) {
    throw new CalibrationError(
      '控制点的像素位置近似共线，无法确定仿射变换的第二个方向：请在图面上分散取点，不要都落在同一条线上',
    )
  }

  // 正规方程 NᵀN，用中心化坐标提高条件数后再还原
  const lon0 = points.reduce((sum, p) => sum + p.lon, 0) / points.length
  const lat0 = points.reduce((sum, p) => sum + p.lat, 0) / points.length
  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const rhsX = [0, 0, 0]
  const rhsY = [0, 0, 0]
  for (const point of points) {
    const row = [point.lon - lon0, point.lat - lat0, 1]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) normal[i][j] += row[i] * row[j]
      rhsX[i] += row[i] * point.x
      rhsY[i] += row[i] * point.y
    }
  }
  const sx = solve3(normal, rhsX)
  const sy = solve3(normal, rhsY)
  if (!sx || !sy) {
    throw new CalibrationError('控制点无法解出仿射变换（正规方程奇异）：请改用分布更分散的控制点')
  }
  // 中心化还原：x = a*(lon-lon0) + b*(lat-lat0) + c0 → c = c0 - a*lon0 - b*lat0
  const forward: AffineForward = [
    sx[0], sx[1], sx[2] - sx[0] * lon0 - sx[1] * lat0,
    sy[0], sy[1], sy[2] - sy[0] * lon0 - sy[1] * lat0,
  ]

  const [a, b, c, d, e, f] = forward
  const det = a * e - b * d
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(d), Math.abs(e))
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * Math.max(scale * scale, 1e-9)) {
    throw new CalibrationError('拟合出的仿射变换不可逆（控制点退化或经纬度写反了），无法做像素↔经纬度换算')
  }
  const inverse: AffineInverse = [
    e / det, -b / det, (b * f - e * c) / det,
    -d / det, a / det, (d * c - a * f) / det,
  ]

  let worst = 0
  let sumSquares = 0
  for (const point of points) {
    const px = a * point.lon + b * point.lat + c
    const py = d * point.lon + e * point.lat + f
    const error = Math.hypot(px - point.x, py - point.y)
    worst = Math.max(worst, error)
    sumSquares += error * error
  }
  const rms = Math.sqrt(sumSquares / points.length)
  const diagonal = Math.hypot(image.width, image.height)
  if (worst > diagonal * 0.05) {
    throw new CalibrationError(
      `控制点与仿射模型差得太远（最大残差 ${worst.toFixed(1)}px，约为对角线的 ${(worst / diagonal * 100).toFixed(1)}%）：`
      + '通常是某个控制点的经纬度点错了，或这张图不是可用仿射近似的（强烈变形/非测绘示意图）',
    )
  }

  return {
    forward,
    inverse,
    residual_px: { max: Number(worst.toFixed(3)), rms: Number(rms.toFixed(3)) },
    control_points: points.map(point => ({ x: point.x, y: point.y, lon: point.lon, lat: point.lat })),
  }
}

export function applyAffine(matrix: AffineForward | AffineInverse, input: [number, number]): [number, number] {
  return [
    matrix[0] * input[0] + matrix[1] * input[1] + matrix[2],
    matrix[3] * input[0] + matrix[4] * input[1] + matrix[5],
  ]
}
