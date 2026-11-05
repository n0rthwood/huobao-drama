/**
 * 语义标注的几何部分（Issue #47）— 纯 CV，不调模型
 *
 * 实测结论（#44 正文）：视觉模型能可靠地回答「什么在哪里」（地名、像素框），
 * 但**不能描摹几何**——直接要折线会给一条直线，要多边形会错位，加坐标网格再问会
 * 退化成重复坐标直到截断。所以这里把几何全部交给确定性算法：
 *
 * - 线条：按模型先报出的颜色做色域阈值 → 沿长轴分箱取中位数 → Douglas–Peucker 简化；
 * - 区域：深色线膨胀闭合虚线边界 → 从模型给的标签种子泛洪 → Moore 边界追踪 → 简化；
 * - 标签：模型给的框只当种子，向最近的墨迹连通块吸附（实测小字号标签系统性偏上一个字高）。
 *
 * 全部函数对「光栅 + 纯数组」工作，不碰数据库、不碰网络，可直接用合成图单测。
 */
import sharp from 'sharp'

/** RGB 光栅：data 为 3 通道紧排（行优先），length = width * height * 3 */
export interface RgbRaster {
  width: number
  height: number
  data: Uint8Array
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export type Point = [number, number]

/** 分析用的长边上限：再大只是算力，地图上的河道宽度在 1600px 下仍有 3–6 像素 */
export const GEOMETRY_MAX_SIDE = 1600
/** 深色线阈值（灰度）：地图的国界是粗黑实线/黑虚线，灰色海岸线在 150 以上 */
const DARK_LINE_GRAY = 90
/** 虚线闭合的膨胀直径：实测 9px（MaxFilter(9)）刚好接上准噶尔边界的黑色虚线 */
export const DASH_CLOSE_DIAMETER = 9
/** 泛洪占满整图说明边界有缺口，结果不可用 */
const FLOOD_LEAK_RATIO = 0.55

// ─── 光栅读取 ────────────────────────────────────────────────

export interface LoadedRaster {
  raster: RgbRaster
  /** 原图像素 → 分析光栅的缩放比（坐标回算用 1 / scale） */
  scale: number
  sourceWidth: number
  sourceHeight: number
}

/** 本地图片 → 缩放后的 RGB 光栅（alpha 合成到白底，与模型看到的 JPEG 同口径） */
export async function loadRaster(absPath: string, maxSide = GEOMETRY_MAX_SIDE): Promise<LoadedRaster> {
  const meta = await sharp(absPath).metadata()
  const sourceWidth = meta.width || 0
  const sourceHeight = meta.height || 0
  if (!sourceWidth || !sourceHeight) throw new Error('无法读取图片尺寸')
  const { data, info } = await sharp(absPath)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const raster: RgbRaster = {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  }
  return { raster, scale: info.width / sourceWidth, sourceWidth, sourceHeight }
}

/** `#rrggbb` → 通道值；非法格式返回 null（调用方据此记 warning，不猜颜色） */
export function parseHexColor(hex: unknown): Rgb | null {
  if (typeof hex !== 'string') return null
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

// ─── 掩膜 ────────────────────────────────────────────────────

/** hueOnly 下的最小彩度：低于此值是灰阶（道路、注记、阴影），通道序没有意义 */
export const HUE_ONLY_MIN_CHROMA = 24

/**
 * 色域掩膜。单纯的欧氏距离会把灰白纸底也算进浅蓝，所以再加一条**色相方向**判据：
 * 目标色有明显偏色时（最大通道 − 最小通道 ≥ 40），像素必须在同一个通道上同样偏色。
 * 这是实测里「蓝通道 > 150 且 b−r > 60 且 b−g > 30」那条规则的通用化写法。
 *
 * `hueOnly`（Issue #56，**只用于上传截图路径**）：Google Earth 这类屏幕截图上，同一条
 * 水体沿程因地形阴影与水深会从 rgb(80,144,224) 一路压到 rgb(16,48,96)——欧氏距离 172、
 * 偏色幅度 48，被上面两条判据同时判掉，实测命中率为 0（契约 §8 的遗留缺陷）。
 * 这种图里真正稳定的是**通道序**（蓝 > 绿 > 红），不是绝对色值。所以 hueOnly 改判：
 * 通道序与目标一致且本身有足够彩度即算命中，亮度差异一律放行。
 * 扫描印刷图保持原判据不变——那里颜色是平涂的，放宽只会把别的墨色吃进来。
 */
export function colorMask(
  raster: RgbRaster,
  target: Rgb,
  tolerance = 90,
  opts: { hueOnly?: boolean } = {},
): Uint8Array {
  const { width, height, data } = raster
  const mask = new Uint8Array(width * height)
  const channels = [target.r, target.g, target.b]
  const dominant = channels.indexOf(Math.max(...channels))
  const weakest = channels.indexOf(Math.min(...channels))
  const chroma = Math.max(...channels) - Math.min(...channels)
  const chromatic = chroma >= 40
  // 偏色幅度放宽一半：原图的印刷色比模型报的「蓝」淡，卡得太死会抽不出线
  const minBias = chroma / 2
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    const r = data[p]!
    const g = data[p + 1]!
    const b = data[p + 2]!
    if (opts.hueOnly) {
      // 逐像素判断，不分配任何临时数组（分析光栅有 200 万像素量级）
      const pixelMax = r >= g ? (r >= b ? 0 : 2) : (g >= b ? 1 : 2)
      const pixelMin = r <= g ? (r <= b ? 0 : 2) : (g <= b ? 1 : 2)
      if (Math.max(r, g, b) - Math.min(r, g, b) < HUE_ONLY_MIN_CHROMA) continue
      if (pixelMax !== dominant || pixelMin !== weakest) continue
      mask[i] = 1
      continue
    }
    const dr = r - target.r
    const dg = g - target.g
    const db = b - target.b
    if (dr * dr + dg * dg + db * db > tolerance * tolerance) continue
    if (chromatic) {
      const pixel = [r, g, b]
      const others = pixel.filter((_, idx) => idx !== dominant)
      if (pixel[dominant]! - Math.max(...others) < minBias) continue
    }
    mask[i] = 1
  }
  return mask
}

/**
 * 这个颜色能不能用来抽线（开图核对 2026-11-03 发现的坑）。
 *
 * 资产 39 上模型把三条国界报成 `#000000`。黑色色域会把**全图的墨迹**——每一个地名、
 * 每一条海岸线、每一条河——一起选中，分箱取中位数后得到的是一条横跨全图的锯齿线：
 * 坐标是程序算的，却完全不是那条国界。这正是 Issue 明令禁止的「伪造几何」。
 *
 * 判据：色相要足够（chroma ≥ 40），且不能是接近纯黑/纯白的无彩色。
 * 不合格时调用方必须记 warning 并留空，交给人工标注。
 *
 * Issue #56 放宽（只影响上传截图）：Google Earth 的深水是 rgb(16,48,96) 这种
 * **又暗又蓝**的色——亮度 53 贴着下限、稍深一点就被 `luma >= 50` 判掉，于是整条洹河
 * 一个像素都抽不出来。深蓝本身是极可靠的水体标志，所以 `b−r>60 且 b−g>20` 时
 * 跳过亮度下限。纯黑（b−r=0）与纯白仍然返回 false，既有用例不变。
 */
export function isExtractableLineColor(color: Rgb): boolean {
  const channels = [color.r, color.g, color.b]
  const max = Math.max(...channels)
  const min = Math.min(...channels)
  if (max - min < 40) return false
  const luma = (color.r + color.g + color.b) / 3
  if (luma > 235) return false
  if (luma >= 50) return true
  return color.b - color.r > 60 && color.b - color.g > 20
}

/**
 * 色域掩膜像不像**一条线**（开图核对 2026-11-03 发现的第二个坑）。
 *
 * 资产 41 是一张**色块填充**的地图：模型报的路线色 `#e31a1c` 同时命中了图例文字、
 * 红色地名和大片填充，分箱中位数于是在整张图上来回跳，画出来是一条锯齿——
 * 坐标仍然是程序算的，却不是那条路线。必须在写库前把这种结果判掉。
 *
 * 两条判据，都按图幅长边归一化：
 * - **粗细**：线状要素在每个分箱里的横向跨度很小（河道/箭头几像素到十几像素），
 *   色块填充动辄占图幅的几十分之一以上；
 * - **连续性**：相邻采样点之间不该出现大跳（跳变说明中位数在两个互不相连的色块间摆动）。
 */
export function lineMaskQuality(
  mask: Uint8Array,
  width: number,
  points: Point[],
  opts: { bin?: number } = {},
): { thickness: number; jump: number } {
  const bin = opts.bin ?? 12
  const height = Math.ceil(mask.length / width)
  const longSide = Math.max(width, height)
  if (points.length < 2) return { thickness: 1, jump: 1 }
  const alongY = Math.abs(points[points.length - 1]![1] - points[0]![1])
    >= Math.abs(points[points.length - 1]![0] - points[0]![0])

  const spreads: number[] = []
  for (const [px, py] of points) {
    const major = alongY ? py : px
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue
      const x = i % width
      const y = (i - x) / width
      const m = alongY ? y : x
      if (m < major - bin / 2 || m > major + bin / 2) continue
      const minor = alongY ? x : y
      if (minor < min) min = minor
      if (minor > max) max = minor
    }
    if (max >= min) spreads.push(max - min)
  }
  spreads.sort((a, b) => a - b)
  const thickness = spreads.length ? spreads[Math.floor(spreads.length / 2)]! / longSide : 1

  let jump = 0
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]) / longSide
    if (d > jump) jump = d
  }
  return { thickness, jump }
}

/** 粗细上限：超过图幅长边的 6% 就不是线而是色块 */
export const MAX_LINE_THICKNESS = 0.06
/** 跳变上限：相邻采样点超过图幅长边的 12% 说明中位数在互不相连的区域间摆动 */
export const MAX_LINE_JUMP = 0.12

/** 深色线掩膜（国界/虚线/文字都算墨迹） */
export function darkMask(raster: RgbRaster, threshold = DARK_LINE_GRAY): Uint8Array {
  const { width, height, data } = raster
  const mask = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    if ((data[p]! + data[p + 1]! + data[p + 2]!) / 3 < threshold) mask[i] = 1
  }
  return mask
}

/** 方形最大值膨胀（可分离：先横后纵），diameter 为奇数直径 */
export function dilateMask(mask: Uint8Array, width: number, height: number, diameter: number): Uint8Array {
  const radius = Math.max(0, Math.floor(diameter / 2))
  if (!radius) return mask.slice()
  const horizontal = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const from = Math.max(0, x - radius)
      const to = Math.min(width - 1, x + radius)
      let hit = 0
      for (let k = from; k <= to; k++) {
        if (mask[row + k]) { hit = 1; break }
      }
      horizontal[row + x] = hit
    }
  }
  const out = new Uint8Array(mask.length)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const from = Math.max(0, y - radius)
      const to = Math.min(height - 1, y + radius)
      let hit = 0
      for (let k = from; k <= to; k++) {
        if (horizontal[k * width + x]) { hit = 1; break }
      }
      out[y * width + x] = hit
    }
  }
  return out
}

// ─── 线条 ────────────────────────────────────────────────────

/**
 * 掩膜 → 折线：沿**长轴**分箱，每箱取另一坐标的中位数。
 * 河道/路线在图上是细长的连通带，中位数对孤立噪点与分叉都稳健；
 * 分叉严重时结果会在两支之间摆动，这正是要留给人工修正的情形。
 */
export function maskToPolyline(
  mask: Uint8Array,
  width: number,
  opts: { bin?: number; minPixelsPerBin?: number } = {},
): Point[] {
  const bin = opts.bin ?? 12
  const minPixels = opts.minPixelsPerBin ?? 5
  // 掩膜像素可能有几十万个：扩展运算符（Math.max(...xs)）会在这个量级上爆栈，只能用循环
  const xs: number[] = []
  const ys: number[] = []
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const x = i % width
    const y = (i - x) / width
    xs.push(x)
    ys.push(y)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (xs.length < minPixels) return []
  const alongY = maxY - minY >= maxX - minX
  const major = alongY ? ys : xs
  const minor = alongY ? xs : ys
  const start = alongY ? minY : minX
  const end = alongY ? maxY : maxX

  const points: Point[] = []
  for (let edge = start; edge <= end; edge += bin) {
    const bucket: number[] = []
    for (let i = 0; i < major.length; i++) {
      const value = major[i]!
      if (value >= edge && value < edge + bin) bucket.push(minor[i]!)
    }
    if (bucket.length < minPixels) continue
    bucket.sort((a, b) => a - b)
    const median = bucket[Math.floor(bucket.length / 2)]!
    const center = Math.min(edge + Math.floor(bin / 2), end)
    points.push(alongY ? [median, center] : [center, median])
  }
  return points
}

/** 点到线段的垂距（Douglas–Peucker 的距离项） */
function perpendicularDistance(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - from[0], point[1] - from[1])
  const cross = Math.abs(dy * point[0] - dx * point[1] + to[0] * from[1] - to[1] * from[0])
  return cross / Math.hypot(dx, dy)
}

/** Douglas–Peucker 简化；epsilon 为允许的最大偏离像素 */
export function simplifyPolyline(points: Point[], epsilon = 3): Point[] {
  if (points.length <= 2 || epsilon <= 0) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()!
    let farthest = -1
    let maxDistance = epsilon
    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularDistance(points[i]!, points[first]!, points[last]!)
      if (distance > maxDistance) {
        maxDistance = distance
        farthest = i
      }
    }
    if (farthest < 0) continue
    keep[farthest] = 1
    stack.push([first, farthest], [farthest, last])
  }
  return points.filter((_, index) => keep[index])
}

/** 一条线的「颜色仍在」覆盖率：沿折线采样，看附近有没有该色像素（保真核验用） */
export function lineColorCoverage(
  raster: RgbRaster,
  points: Point[],
  target: Rgb,
  opts: { tolerance?: number; radius?: number; hueOnly?: boolean } = {},
): number {
  if (points.length < 2) return 0
  const tolerance = opts.tolerance ?? 110
  const radius = opts.radius ?? 6
  const mask = colorMask(raster, target, tolerance, { hueOnly: opts.hueOnly })
  let samples = 0
  let hits = 0
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!
    const [x1, y1] = points[i]!
    const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 4))
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps)
      const y = Math.round(y0 + ((y1 - y0) * s) / steps)
      samples++
      if (maskHasNear(mask, raster.width, raster.height, x, y, radius)) hits++
    }
  }
  return samples ? hits / samples : 0
}

function maskHasNear(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy
    if (yy < 0 || yy >= height) continue
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx
      if (xx < 0 || xx >= width) continue
      if (mask[yy * width + xx]) return true
    }
  }
  return false
}

// ─── 区域 ────────────────────────────────────────────────────

export interface FloodResult {
  /** 外轮廓多边形（已简化）；泛洪泄漏或种子落在墙上时为 null */
  polygon: Point[] | null
  /** 填充像素占全图比例，诊断用 */
  ratio: number
  reason?: string
}

/**
 * 从种子点泛洪出一个闭合区域。
 * 墙 = 深色线膨胀后的掩膜（膨胀是为了把虚线国界接成连续墙），
 * 种子通常取地名标签正下方一点——标签文字本身也是墙，落在字上会直接失败。
 */
export function floodRegion(
  raster: RgbRaster,
  seed: Point,
  opts: { dashClose?: number; simplifyEpsilon?: number } = {},
): FloodResult {
  const { width, height } = raster
  const wall = dilateMask(darkMask(raster), width, height, opts.dashClose ?? DASH_CLOSE_DIAMETER)
  const [sx, sy] = [Math.round(seed[0]), Math.round(seed[1])]
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
    return { polygon: null, ratio: 0, reason: '种子点在图片之外' }
  }
  if (wall[sy * width + sx]) {
    return { polygon: null, ratio: 0, reason: '种子点落在边界线或文字上' }
  }

  const filled = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0
  queue[tail++] = sy * width + sx
  filled[sy * width + sx] = 1
  let count = 0
  while (head < tail) {
    const index = queue[head++]!
    count++
    const x = index % width
    const y = (index - x) / width
    if (x + 1 < width && !filled[index + 1] && !wall[index + 1]) { filled[index + 1] = 1; queue[tail++] = index + 1 }
    if (x > 0 && !filled[index - 1] && !wall[index - 1]) { filled[index - 1] = 1; queue[tail++] = index - 1 }
    if (y + 1 < height && !filled[index + width] && !wall[index + width]) { filled[index + width] = 1; queue[tail++] = index + width }
    if (y > 0 && !filled[index - width] && !wall[index - width]) { filled[index - width] = 1; queue[tail++] = index - width }
  }
  const ratio = count / (width * height)
  if (ratio > FLOOD_LEAK_RATIO) {
    return { polygon: null, ratio, reason: '边界有缺口，填充泄漏到整张图' }
  }
  const outline = traceOuterBoundary(filled, width, height)
  if (outline.length < 3) return { polygon: null, ratio, reason: '填充区域太小，取不到轮廓' }
  const polygon = simplifyPolyline(outline, opts.simplifyEpsilon ?? 6)
  return { polygon: polygon.length >= 3 ? polygon : null, ratio, reason: polygon.length >= 3 ? undefined : '轮廓简化后不足三点' }
}

/** Moore 邻域的 8 个方向（顺时针，从正右开始） */
const MOORE: ReadonlyArray<Point> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

/**
 * Moore 邻域边界追踪：返回填充块的外轮廓像素序列（闭合，不含孔洞）。
 * 用 Jacob 停止准则（回到起点且进入方向相同），并加步数上限兜底。
 */
export function traceOuterBoundary(filled: Uint8Array, width: number, height: number): Point[] {
  let start = -1
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]) { start = i; break }
  }
  if (start < 0) return []
  const startX = start % width
  const startY = (start - startX) / width

  const contour: Point[] = []
  let x = startX
  let y = startY
  // 起点是行优先第一个填充点，它的左邻必为空：从左侧开始绕
  let direction = 4
  const maxSteps = width * height * 4
  for (let step = 0; step < maxSteps; step++) {
    contour.push([x, y])
    let moved = false
    // `direction` 存的是「回头方向」（上一步从哪儿来）；从它的下一个方向起顺时针扫一圈
    for (let k = 1; k <= 8; k++) {
      const dir = (direction + k) % 8
      const [dx, dy] = MOORE[dir]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      if (!filled[ny * width + nx]) continue
      direction = (dir + 4) % 8
      x = nx
      y = ny
      moved = true
      break
    }
    if (!moved) break
    if (x === startX && y === startY) break
  }
  return contour
}

// ─── 标签吸附 ────────────────────────────────────────────────

export type Bbox = [number, number, number, number]

/**
 * 把视觉模型给的标签框吸附到最近的墨迹连通块上。
 * 实测：大标签的框落在字上，小标签（斋桑湖/西宁/成都/拉萨）系统性偏上约一个字高——
 * 直接存会让 #48 的图层锚点整体偏移，所以 VLM 框只当种子，最终坐标以墨迹为准。
 *
 * 做法：在种子框向外扩 `search` 像素的范围内取深色像素的连通块，
 * 选中心离种子中心最近、且尺寸像一行文字的块，返回它的紧致框。
 * 找不到合适的块就返回 null（调用方保留 VLM 框并把 source 记为 'vlm'）。
 */
export function snapBoxToInk(
  raster: RgbRaster,
  bbox: Bbox,
  opts: { search?: number; gray?: number } = {},
): Bbox | null {
  const { width, height } = raster
  const search = opts.search ?? Math.max(24, Math.round((bbox[3] - bbox[1]) * 1.5))
  const x0 = Math.max(0, Math.round(bbox[0]) - search)
  const y0 = Math.max(0, Math.round(bbox[1]) - search)
  const x1 = Math.min(width - 1, Math.round(bbox[2]) + search)
  const y1 = Math.min(height - 1, Math.round(bbox[3]) + search)
  if (x1 <= x0 || y1 <= y0) return null

  const ink = darkMask(raster, opts.gray ?? 140)
  // 字与字之间要连起来才算「一行文字」：横向膨胀比纵向大
  const windowWidth = x1 - x0 + 1
  const windowHeight = y1 - y0 + 1
  const windowMask = new Uint8Array(windowWidth * windowHeight)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      windowMask[(y - y0) * windowWidth + (x - x0)] = ink[y * width + x]!
    }
  }
  const closed = dilateMask(windowMask, windowWidth, windowHeight, 7)

  const seen = new Uint8Array(closed.length)
  const queue = new Int32Array(closed.length)
  const centerX = (bbox[0] + bbox[2]) / 2 - x0
  const centerY = (bbox[1] + bbox[3]) / 2 - y0
  let best: { box: Bbox; distance: number } | null = null
  for (let i = 0; i < closed.length; i++) {
    if (!closed[i] || seen[i]) continue
    let head = 0
    let tail = 0
    queue[tail++] = i
    seen[i] = 1
    let minX = windowWidth
    let minY = windowHeight
    let maxX = 0
    let maxY = 0
    let area = 0
    while (head < tail) {
      const index = queue[head++]!
      const x = index % windowWidth
      const y = (index - x) / windowWidth
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x + 1 < windowWidth && closed[index + 1] && !seen[index + 1]) { seen[index + 1] = 1; queue[tail++] = index + 1 }
      if (x > 0 && closed[index - 1] && !seen[index - 1]) { seen[index - 1] = 1; queue[tail++] = index - 1 }
      if (y + 1 < windowHeight && closed[index + windowWidth] && !seen[index + windowWidth]) { seen[index + windowWidth] = 1; queue[tail++] = index + windowWidth }
      if (y > 0 && closed[index - windowWidth] && !seen[index - windowWidth]) { seen[index - windowWidth] = 1; queue[tail++] = index - windowWidth }
    }
    const blobWidth = maxX - minX + 1
    const blobHeight = maxY - minY + 1
    // 整条国界线也是深色连通块：高到占满搜索窗的块不是文字
    if (area < 12 || blobHeight > windowHeight * 0.8 || blobWidth > windowWidth * 0.95) continue
    const distance = Math.hypot((minX + maxX) / 2 - centerX, (minY + maxY) / 2 - centerY)
    if (!best || distance < best.distance) {
      best = { box: [x0 + minX, y0 + minY, x0 + maxX, y0 + maxY], distance }
    }
  }
  return best ? best.box : null
}
