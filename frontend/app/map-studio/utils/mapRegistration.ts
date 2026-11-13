/**
 * 地图底图「像素 ↔ 经纬度」配准（Issue #84）。
 *
 * 几何真值永远是 map_spec 里的经纬度，画布只是投影视图：拖点、加线、加面都要先把像素换算回经纬度再写回 spec。
 * 三种底图各有自己的投影，绝不能用一套 bbox 线性映射糊弄过去：
 *   program —— 使用后端 d3 对球面边界拟合得到的精确 scale/translate，绝不从 bbox 四角近似重建；
 *   image   —— 人工标定控制点拟合的仿射（后端最小二乘，正/逆都给）；
 *   earth   —— 有实测控制点时只认实测网格；名义相机仅用于未标定的旧登记件，绝不能覆盖实测像素映射。
 * 其他模式参数缺失时也可用归一化采样网格，网格覆盖外和孔洞不得外推。
 */

export interface MapRegistrationGrid {
  lon_min: number
  lat_min: number
  lon_max: number
  lat_max: number
  cols: number
  rows: number
  /**
   * 行主序（北→南、西→东），归一化图像坐标 [nx, ny]。
   * null = 该节点在这张图上没有定义（Earth 相机下位于地平线背面），绝不能当成 0 用。
   * 越界（<0 或 >1）的节点照常给值，边缘双线性才成立。
   */
  points: Array<[number, number] | null>
}

export interface MapRegistration {
  mode: 'program' | 'earth' | 'image'
  width: number
  height: number
  bbox: [number, number, number, number]
  program?: {
    projection: 'mercator' | 'equirectangular'
    bbox: [number, number, number, number]
    fit?: string
    /** d3 对球面弧线重采样后 fitExtent 的精确参数，不能用 bbox 四角近似 */
    scale?: number
    translate?: [number, number]
  }
  image?: {
    /** x = a*lon + b*lat + c ; y = d*lon + e*lat + f */
    forward: number[]
    /** lon = A*x + B*y + C ; lat = D*x + E*y + F */
    inverse: number[]
    residual_px?: { max: number; rms: number }
    control_points?: Array<{ x: number; y: number; lon: number; lat: number }>
    source_url?: string
    license?: string
  }
  earth?: {
    /** 实测控制点配准后，以 grid 为唯一像素真值；camera 仅保留为出处。 */
    calibrated?: boolean
    residual_px?: { max: number; rms: number }
    validation_count?: number
    calibration_image?: string
    camera: { lat: number; lon: number; distance_m: number; fov_deg: number }
    window: { width: number; height: number }
    crop: { x: number; y: number; width: number; height: number }
    radius_m?: number
    imagery_note?: string
  }
  grid?: MapRegistrationGrid
}

export type GeoPoint = [number, number]
export type PixelPoint = [number, number]

const DEG = Math.PI / 180
const MERCATOR_LAT_LIMIT = 85.05112878

/**
 * 严格读数：非有限值一律当「没有」。
 * 坏掉的配准必须被整体拒绝——把 NaN 当 0 会得到一份看起来能用、实际把所有几何钉到画面左上角的假投影。
 */
function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function bboxOf(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null
  const values = raw.slice(0, 4).map(finite)
  if (values.some(value => value === null)) return null
  const [west, south, east, north] = values as number[]
  if (!(west < east) || !(south < north)) return null
  if (west < -360 || east > 360 || south < -90 || north > 90) return null
  return [west, south, east, north]
}

type RawRecord = Record<string, unknown>

/** 后端 JSON 是未校验输入：统一用 unknown 读，取不到就当字段缺失，绝不假装有值 */
function record(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawRecord) : null
}

function text(value: unknown): string | undefined {
  const str = typeof value === 'string' ? value.trim() : ''
  return str ? str : undefined
}

function coefficients(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 6) return null
  const values = value.slice(0, 6).map(finite)
  if (values.some(item => item === null)) return null
  const coef = values as number[]
  // 行列式为 0 的仿射不可逆：这种标定根本换算不回经纬度
  return Math.abs(coef[0] * coef[4] - coef[1] * coef[3]) > 1e-12 ? coef : null
}

/** 后端 provenance 里的 registration 可能缺字段/坏字段：任何关键数值不可信就整体拒绝，返回 null */
export function parseRegistration(raw: unknown): MapRegistration | null {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  const src = record(value)
  if (!src) return null
  const mode = src.mode === 'earth' || src.mode === 'image' || src.mode === 'program' ? src.mode : null
  const width = finite(src.width)
  const height = finite(src.height)
  const bbox = bboxOf(src.bbox)
  if (!mode || !bbox || !width || !height || width <= 0 || height <= 0) return null
  const reg: MapRegistration = { mode, width, height, bbox }

  const program = record(src.program)
  if (program) {
    const programBbox = bboxOf(program.bbox)
    if (!programBbox) return null
    if (program.projection !== 'mercator' && program.projection !== 'equirectangular') return null
    if (program.scale !== undefined && (finite(program.scale) === null || Number(program.scale) <= 0)) return null
    if (program.translate !== undefined && (!Array.isArray(program.translate) || finite(program.translate[0]) === null || finite(program.translate[1]) === null)) return null
    reg.program = {
      projection: program.projection === 'equirectangular' ? 'equirectangular' : 'mercator',
      bbox: programBbox,
      fit: text(program.fit),
      scale: finite(program.scale) ?? undefined,
      translate: Array.isArray(program.translate) && finite(program.translate[0]) !== null && finite(program.translate[1]) !== null
        ? [Number(program.translate[0]), Number(program.translate[1])]
        : undefined,
    }
  }

  const image = record(src.image)
  if (image) {
    const forward = coefficients(image.forward)
    const inverse = coefficients(image.inverse)
    if (!forward || !inverse) return null
    const residual = record(image.residual_px)
    const residualMax = finite(residual?.max)
    const residualRms = finite(residual?.rms)
    reg.image = {
      forward,
      inverse,
      residual_px: residualMax !== null && residualRms !== null ? { max: residualMax, rms: residualRms } : undefined,
      control_points: Array.isArray(image.control_points)
        ? image.control_points.flatMap((entry) => {
          const point = record(entry)
          const x = finite(point?.x)
          const y = finite(point?.y)
          const lon = finite(point?.lon)
          const lat = finite(point?.lat)
          return x !== null && y !== null && lon !== null && lat !== null ? [{ x, y, lon, lat }] : []
        })
        : undefined,
      source_url: text(image.source_url),
      license: text(image.license),
    }
  }

  const earth = record(src.earth)
  if (earth) {
    const camera = record(earth.camera)
    const lat = finite(camera?.lat)
    const lon = finite(camera?.lon)
    const distance = finite(camera?.distance_m)
    const fov = finite(camera?.fov_deg)
    const earthWindow = record(earth.window)
    const windowWidth = finite(earthWindow?.width)
    const windowHeight = finite(earthWindow?.height)
    const crop = record(earth.crop)
    const cropX = finite(crop?.x)
    const cropY = finite(crop?.y)
    const cropWidth = finite(crop?.width)
    const cropHeight = finite(crop?.height)
    const radius = finite(earth.radius_m)
    const valid = lat !== null && Math.abs(lat) <= 90
      && lon !== null && Math.abs(lon) <= 360
      && distance !== null && distance > 0
      && fov !== null && fov > 0 && fov < 180
      && windowWidth !== null && windowWidth > 0 && windowHeight !== null && windowHeight > 0
      && cropX !== null && cropY !== null
      && cropWidth !== null && cropWidth > 0 && cropHeight !== null && cropHeight > 0
      && (earth.radius_m === undefined || (radius !== null && radius > 0))
    if (!valid) return null
    const measured = record(earth.residual_px)
    const measuredMax = finite(measured?.max)
    const measuredRms = finite(measured?.rms)
    reg.earth = {
      calibrated: earth.calibrated === true,
      residual_px: measuredMax !== null && measuredRms !== null ? { max: measuredMax, rms: measuredRms } : undefined,
      validation_count: finite(earth.validation_count) ?? undefined,
      calibration_image: text(earth.calibration_image),
      camera: { lat, lon, distance_m: distance, fov_deg: fov },
      window: { width: windowWidth, height: windowHeight },
      crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
      radius_m: radius ?? 6371008.8,
      imagery_note: text(earth.imagery_note),
    }
  }

  const grid = record(src.grid)
  if (grid) {
    const cols = finite(grid.cols)
    const rows = finite(grid.rows)
    const bounds = bboxOf([grid.lon_min, grid.lat_min, grid.lon_max, grid.lat_max])
    const points = Array.isArray(grid.points) ? grid.points : null
    if (bounds && points && cols !== null && rows !== null && Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && points.length === cols * rows) {
      const parsed: Array<[number, number] | null> = []
      let broken = false
      for (const entry of points) {
        if (entry === null || entry === undefined) { parsed.push(null); continue }
        if (!Array.isArray(entry) || entry.length < 2) { broken = true; break }
        const nx = finite(entry[0])
        const ny = finite(entry[1])
        if (nx === null || ny === null) { broken = true; break }
        parsed.push([nx, ny])
      }
      // 网格只是兜底：坏网格丢掉即可，但模式参数也缺时就彻底没有可信投影了
      if (!broken) {
        reg.grid = {
          lon_min: bounds[0],
          lat_min: bounds[1],
          lon_max: bounds[2],
          lat_max: bounds[3],
          cols: Math.round(cols),
          rows: Math.round(rows),
          points: parsed,
        }
      }
    }
  }
  if (reg.earth?.calibrated && !reg.grid) return null

  const hasModeMath = (mode === 'program' && reg.program?.scale && reg.program.translate)
    || (mode === 'image' && reg.image) || (mode === 'earth' && reg.earth)
  if (!hasModeMath && !reg.grid) return null
  return reg
}

/** 在配准对象里找 registration：base/final 的 provenance 结构由各自生产者决定，这里统一兜一层 */
export function registrationFrom(...candidates: unknown[]): MapRegistration | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const direct = parseRegistration(candidate)
    if (direct) return direct
    const parsed = parseRegistration(record(candidate)?.registration)
    if (parsed) return parsed
  }
  return null
}

// ===== program：墨卡托 / 等距圆柱 + fitExtent =====

function rawProgram(reg: MapRegistration, lon: number, lat: number): PixelPoint {
  const projection = reg.program?.projection ?? 'mercator'
  const x = lon * DEG
  if (projection === 'equirectangular') return [x, -lat * DEG]
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
  return [x, -Math.log(Math.tan(Math.PI / 4 + clamped * DEG / 2))]
}

function rawProgramInverse(reg: MapRegistration, x: number, y: number): GeoPoint {
  const projection = reg.program?.projection ?? 'mercator'
  const rawLon = x / DEG
  // d3 的反投影会绕回标准经度域；宽画幅的左右留白可能反算出超过一周的 λ。
  // 返回裸 λ 会与服务端相差整整 360°，拖拽后还会存入超界经度。
  const lon = Math.abs(rawLon) > 180 ? rawLon - 360 * Math.round(rawLon / 360) : rawLon
  if (projection === 'equirectangular') return [lon, -y / DEG]
  return [lon, (2 * Math.atan(Math.exp(-y)) - Math.PI / 2) / DEG]
}

interface ProgramFit { k: number; tx: number; ty: number }

function programFit(reg: MapRegistration): ProgramFit | null {
  const scale = reg.program?.scale
  const translate = reg.program?.translate
  // d3 fits the resampled great-circle edges, not the four corners. Never approximate the fitted bounds.
  // Older registration documents have a sampling grid; use it when exact fitted parameters are absent.
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0 || !translate) return null
  return { k: scale, tx: translate[0], ty: translate[1] }
}

// ===== earth：真实相机透视 =====

type Vec3 = [number, number, number]

function unitVec(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

interface EarthFrame { R: number; distance: number; f: number; up: Vec3; east: Vec3; north: Vec3; win: { width: number; height: number }; crop: { x: number; y: number } }

function earthFrame(reg: MapRegistration): EarthFrame | null {
  const earth = reg.earth
  if (!earth) return null
  const R = earth.radius_m || 6371008.8
  const distance = earth.camera.distance_m
  if (!(distance > 0)) return null
  const fov = (earth.camera.fov_deg || 35) * DEG
  const f = earth.window.width / (2 * Math.tan(fov / 2))
  const lat0 = earth.camera.lat * DEG
  const lon0 = earth.camera.lon * DEG
  const up = unitVec(earth.camera.lat, earth.camera.lon)
  const east: Vec3 = [-Math.sin(lon0), Math.cos(lon0), 0]
  const north: Vec3 = [-Math.sin(lat0) * Math.cos(lon0), -Math.sin(lat0) * Math.sin(lon0), Math.cos(lat0)]
  return { R, distance, f, up, east, north, win: earth.window, crop: earth.crop }
}

function earthForward(frame: EarthFrame, lon: number, lat: number): PixelPoint | null {
  const p = unitVec(lat, lon)
  const along = dot(p, frame.up)
  // 地平线背面的点不可见：别画到画布上，否则会出现镜像的假几何
  if (along <= frame.R / (frame.R + frame.distance)) return null
  const depth = (frame.R + frame.distance) - frame.R * along
  if (!(depth > 0)) return null
  const X = frame.R * dot(p, frame.east)
  const Y = frame.R * dot(p, frame.north)
  const xWindow = frame.win.width / 2 + frame.f * X / depth
  const yWindow = frame.win.height / 2 - frame.f * Y / depth
  return [xWindow - frame.crop.x, yWindow - frame.crop.y]
}

function earthInverse(frame: EarthFrame, x: number, y: number): GeoPoint | null {
  const xWindow = x + frame.crop.x
  const yWindow = y + frame.crop.y
  // 同服务端：在窗口像素空间构造射线，归一化后再求近交点。
  const dx = xWindow - frame.win.width / 2
  const dy = frame.win.height / 2 - yWindow
  const ray: Vec3 = [
    dx * frame.east[0] + dy * frame.north[0] - frame.f * frame.up[0],
    dx * frame.east[1] + dy * frame.north[1] - frame.f * frame.up[1],
    dx * frame.east[2] + dy * frame.north[2] - frame.f * frame.up[2],
  ]
  const length = Math.hypot(...ray)
  if (!Number.isFinite(length) || length <= 0) return null
  const direction: Vec3 = [ray[0] / length, ray[1] / length, ray[2] / length]
  const camR = frame.R + frame.distance
  const eye: Vec3 = [frame.up[0] * camR, frame.up[1] * camR, frame.up[2] * camR]
  const b = dot(eye, direction)
  const c = dot(eye, eye) - frame.R * frame.R
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b - Math.sqrt(disc)
  if (!(t > 0)) return null
  const hit: Vec3 = [eye[0] + t * direction[0], eye[1] + t * direction[1], eye[2] + t * direction[2]]
  const lat = Math.asin(Math.max(-1, Math.min(1, hit[2] / frame.R))) / DEG
  const lon = Math.atan2(hit[1], hit[0]) / DEG
  return [lon, lat]
}

// ===== grid：通用兜底（模式参数缺失时） =====

function gridNode(grid: MapRegistrationGrid, row: number, col: number): PixelPoint | null {
  const point = grid.points[row * grid.cols + col]
  return point ? [point[0], point[1]] : null
}

function gridForward(reg: MapRegistration, lon: number, lat: number): PixelPoint | null {
  const grid = reg.grid
  if (!grid || !Number.isFinite(lon) || !Number.isFinite(lat)) return null
  const spanLon = grid.lon_max - grid.lon_min
  const spanLat = grid.lat_max - grid.lat_min
  if (!(spanLon > 0) || !(spanLat > 0)) return null
  const fx = (lon - grid.lon_min) / spanLon * (grid.cols - 1)
  // 行从北往南，所以纬度要反向
  const fy = (grid.lat_max - lat) / spanLat * (grid.rows - 1)
  if (fx < -1e-9 || fy < -1e-9 || fx > grid.cols - 1 + 1e-9 || fy > grid.rows - 1 + 1e-9) return null
  const col = Math.max(0, Math.min(grid.cols - 2, Math.floor(fx)))
  const row = Math.max(0, Math.min(grid.rows - 2, Math.floor(fy)))
  const tx = fx - col
  const ty = fy - row
  const p00 = gridNode(grid, row, col)
  const p10 = gridNode(grid, row, col + 1)
  const p01 = gridNode(grid, row + 1, col)
  const p11 = gridNode(grid, row + 1, col + 1)
  if (!p00 || !p10 || !p01 || !p11) return null
  const nx = (p00[0] * (1 - tx) + p10[0] * tx) * (1 - ty) + (p01[0] * (1 - tx) + p11[0] * tx) * ty
  const ny = (p00[1] * (1 - tx) + p10[1] * tx) * (1 - ty) + (p01[1] * (1 - tx) + p11[1] * tx) * ty
  return [nx * reg.width, ny * reg.height]
}

/** 在每个完整四边形单元中反解双线性 u/v；孔洞、网格覆盖外的像素不能外推成伪坐标。 */
function gridInverse(reg: MapRegistration, x: number, y: number): GeoPoint | null {
  const grid = reg.grid
  if (!grid || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const nx = x / reg.width
  const ny = y / reg.height
  for (let row = 0; row < grid.rows - 1; row++) {
    for (let col = 0; col < grid.cols - 1; col++) {
      const p00 = gridNode(grid, row, col)
      const p10 = gridNode(grid, row, col + 1)
      const p01 = gridNode(grid, row + 1, col)
      const p11 = gridNode(grid, row + 1, col + 1)
      if (!p00 || !p10 || !p01 || !p11) continue
      const minX = Math.min(p00[0], p10[0], p01[0], p11[0])
      const maxX = Math.max(p00[0], p10[0], p01[0], p11[0])
      const minY = Math.min(p00[1], p10[1], p01[1], p11[1])
      const maxY = Math.max(p00[1], p10[1], p01[1], p11[1])
      if (nx < minX - 1e-9 || nx > maxX + 1e-9 || ny < minY - 1e-9 || ny > maxY + 1e-9) continue
      const ax = p10[0] - p00[0]
      const ay = p10[1] - p00[1]
      const bx = p01[0] - p00[0]
      const by = p01[1] - p00[1]
      const cx = p11[0] - p10[0] - p01[0] + p00[0]
      const cy = p11[1] - p10[1] - p01[1] + p00[1]
      let u = 0.5
      let v = 0.5
      for (let iter = 0; iter < 20; iter++) {
        const errorX = p00[0] + ax * u + bx * v + cx * u * v - nx
        const errorY = p00[1] + ay * u + by * v + cy * u * v - ny
        if (Math.hypot(errorX, errorY) < 1e-12) break
        const j00 = ax + cx * v
        const j01 = bx + cx * u
        const j10 = ay + cy * v
        const j11 = by + cy * u
        const det = j00 * j11 - j01 * j10
        if (Math.abs(det) < 1e-16) break
        u -= (errorX * j11 - errorY * j01) / det
        v -= (j00 * errorY - j10 * errorX) / det
      }
      const residual = Math.hypot(
        p00[0] + ax * u + bx * v + cx * u * v - nx,
        p00[1] + ay * u + by * v + cy * u * v - ny,
      )
      if (u < -1e-8 || u > 1 + 1e-8 || v < -1e-8 || v > 1 + 1e-8 || residual > 1e-8) continue
      const lon = grid.lon_min + (col + Math.max(0, Math.min(1, u))) / (grid.cols - 1) * (grid.lon_max - grid.lon_min)
      const lat = grid.lat_max - (row + Math.max(0, Math.min(1, v))) / (grid.rows - 1) * (grid.lat_max - grid.lat_min)
      return [lon, lat]
    }
  }
  return null
}

// ===== 对外：经纬度 ↔ 像素 ↔ 归一化 =====

/** 经纬度 → 底图像素；点不可见（地球背面 / 范围外）时返回 null，调用方必须按 null 处理 */
export function geoToPixel(reg: MapRegistration | null, lon: number, lat: number): PixelPoint | null {
  if (!reg) return null
  if (reg.mode === 'image' && reg.image) {
    const coef = reg.image.forward
    const x = coef[0] * lon + coef[1] * lat + coef[2]
    const y = coef[3] * lon + coef[4] * lat + coef[5]
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  if (reg.mode === 'earth') {
    if (reg.earth?.calibrated) return gridForward(reg, lon, lat)
    const frame = earthFrame(reg)
    if (frame) return earthForward(frame, lon, lat)
    return gridForward(reg, lon, lat)
  }
  const fit = reg.mode === 'program' ? programFit(reg) : null
  if (fit) {
    const [rx, ry] = rawProgram(reg, lon, lat)
    return [rx * fit.k + fit.tx, ry * fit.k + fit.ty]
  }
  return gridForward(reg, lon, lat)
}

/** 底图像素 → 经纬度；视线打不到地球时返回 null */
export function pixelToGeo(reg: MapRegistration | null, x: number, y: number): GeoPoint | null {
  if (!reg) return null
  if (reg.mode === 'image' && reg.image) {
    const coef = reg.image.inverse
    const lon = coef[0] * x + coef[1] * y + coef[2]
    const lat = coef[3] * x + coef[4] * y + coef[5]
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null
  }
  if (reg.mode === 'earth') {
    if (reg.earth?.calibrated) return gridInverse(reg, x, y)
    const frame = earthFrame(reg)
    if (frame) return earthInverse(frame, x, y)
    return gridInverse(reg, x, y)
  }
  const fit = reg.mode === 'program' ? programFit(reg) : null
  if (fit) {
    const rx = (x - fit.tx) / fit.k
    const ry = (y - fit.ty) / fit.k
    return rawProgramInverse(reg, rx, ry)
  }
  return gridInverse(reg, x, y)
}

/** 归一化（0..1，与 layer_doc 同口径） → 经纬度 */
export function normalizedToGeo(reg: MapRegistration | null, nx: number, ny: number): GeoPoint | null {
  if (!reg) return null
  return pixelToGeo(reg, nx * reg.width, ny * reg.height)
}

/** 经纬度 → 归一化（0..1，与 layer_doc 同口径） */
export function geoToNormalized(reg: MapRegistration | null, lon: number, lat: number): PixelPoint | null {
  if (!reg) return null
  const px = geoToPixel(reg, lon, lat)
  return px ? [px[0] / reg.width, px[1] / reg.height] : null
}

/** 给人看的配准摘要：模式 + 关键参数，用于「这张图怎么对上地理坐标」的说明 */
export function registrationSummary(reg: MapRegistration | null): string {
  if (!reg) return ''
  if (reg.mode === 'program') {
    const [w, s, e, n] = reg.program?.bbox ?? reg.bbox
    const proj = reg.program?.projection ?? 'mercator'
    return `${proj} · ${w.toFixed(2)},${s.toFixed(2)} → ${e.toFixed(2)},${n.toFixed(2)} · ${reg.width}×${reg.height}`
  }
  if (reg.mode === 'image') {
    const residual = reg.image?.residual_px
    const points = reg.image?.control_points?.length ?? 0
    return residual
      ? `affine · ${points}pt · rms ${residual.rms.toFixed(2)}px / max ${residual.max.toFixed(2)}px`
      : `affine · ${points}pt`
  }
  const camera = reg.earth?.camera
  return camera
    ? `camera · ${camera.lat.toFixed(3)},${camera.lon.toFixed(3)} · ${Math.round(camera.distance_m)}m · fov ${camera.fov_deg}°`
    : 'camera'
}

export interface ControlPointFit {
  forward: number[]
  inverse: number[]
  residual_px: { max: number; rms: number }
}

/**
 * 控制点 → 仿射（最小二乘，正规方程 3×3）。
 *
 * 前端在标定界面即时给残差，人能当场看出点标歪了；服务端仍会自己拟合一遍并以服务端结果为准。
 * 点少于 3 个或近似共线（行列式趋零）时返回 null —— 这种标定根本不可逆，不能假装成功。
 */
export function fitControlPoints(
  points: Array<{ x: number; y: number; lon: number; lat: number }>,
  image: { width: number; height: number },
): ControlPointFit | null {
  if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) return null
  if (points.length < 3 || points.some(p =>
    ![p.x, p.y, p.lon, p.lat].every(Number.isFinite)
    || p.lon < -180 || p.lon > 180 || p.lat < -90 || p.lat > 90
    || p.x < 0 || p.x > image.width || p.y < 0 || p.y > image.height
  )) return null

  // 与后端 COLLINEAR_RATIO 同口径：相对最长弦的垂距不足千分之一，第二个方向缺少约束。
  for (const pairs of [
    points.map(p => [p.lon, p.lat] as [number, number]),
    points.map(p => [p.x, p.y] as [number, number]),
  ]) {
    let spread = 0
    let anchor = pairs[0]
    let best = pairs[0]
    for (const p of pairs) {
      for (const q of pairs) {
        const distance = Math.hypot(p[0] - q[0], p[1] - q[1])
        if (distance > spread) { spread = distance; anchor = p; best = q }
      }
    }
    if (spread === 0) return null
    const dx = (best[0] - anchor[0]) / spread
    const dy = (best[1] - anchor[1]) / spread
    let maxOffset = 0
    for (const p of pairs) {
      maxOffset = Math.max(maxOffset, Math.abs((p[0] - anchor[0]) * dy - (p[1] - anchor[1]) * dx) / spread)
    }
    if (maxOffset < 1e-3) return null
  }
  const solve = (rows: Array<[number, number, number]>, targets: number[][]): number[][] | null => {
    const size = 3
    const normal: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const rhs = targets.map(() => [0, 0, 0])
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) normal[i][j] += row[i] * row[j]
        for (let k = 0; k < targets.length; k++) rhs[k][i] += row[i] * targets[k][r]
      }
    }
    // 高斯消元（带部分主元），同时解多组右端
    const matrix = normal.map(row => row.slice())
    const solutions = rhs.map(vector => vector.slice())
    for (let col = 0; col < size; col++) {
      let pivot = col
      for (let row = col + 1; row < size; row++) {
        if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row
      }
      if (Math.abs(matrix[pivot][col]) < 1e-12) return null
      if (pivot !== col) {
        const tmp = matrix[pivot]; matrix[pivot] = matrix[col]; matrix[col] = tmp
        for (const vector of solutions) {
          const swap = vector[pivot]; vector[pivot] = vector[col]; vector[col] = swap
        }
      }
      for (let row = 0; row < size; row++) {
        if (row === col) continue
        const factor = matrix[row][col] / matrix[col][col]
        for (let k = col; k < size; k++) matrix[row][k] -= factor * matrix[col][k]
        for (const vector of solutions) vector[row] -= factor * vector[col]
      }
    }
    return solutions.map(vector => vector.map((value, i) => value / matrix[i][i]))
  }

  // 与服务端一致：中心化后求解，避免经纬度的常数部分放大正规方程的条件数。
  const lon0 = points.reduce((sum, p) => sum + p.lon, 0) / points.length
  const lat0 = points.reduce((sum, p) => sum + p.lat, 0) / points.length
  const geoRows = points.map(p => [p.lon - lon0, p.lat - lat0, 1] as [number, number, number])
  const solution = solve(geoRows, [points.map(p => p.x), points.map(p => p.y)])
  if (!solution) return null
  const [sx, sy] = solution
  const [a, b, c, d, e, f] = [
    sx[0], sx[1], sx[2] - sx[0] * lon0 - sx[1] * lat0,
    sy[0], sy[1], sy[2] - sy[0] * lon0 - sy[1] * lat0,
  ]
  const det = a * e - b * d
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(d), Math.abs(e))
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * Math.max(scale * scale, 1e-9)) return null
  const forward = [a, b, c, d, e, f]
  // 逆变换必须是已拟合 forward 的精确逆，不可另拟合一套 pixel→geo；过约束时两次拟合并不互逆。
  const inverse = [e / det, -b / det, (b * f - e * c) / det, -d / det, a / det, (d * c - a * f) / det]
  let max = 0
  let sum = 0
  for (const point of points) {
    const dx = forward[0] * point.lon + forward[1] * point.lat + forward[2] - point.x
    const dy = forward[3] * point.lon + forward[4] * point.lat + forward[5] - point.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    max = Math.max(max, dist)
    sum += dist * dist
  }
  if (max > Math.hypot(image.width, image.height) * 0.05) return null
  return { forward, inverse, residual_px: { max: Number(max.toFixed(3)), rms: Number(Math.sqrt(sum / points.length).toFixed(3)) } }
}

/** 用标定好的控制点拼一个可直接编辑的 registration（外部底图在后端返回前也能先画） */
export function registrationFromControlPoints(
  width: number,
  height: number,
  points: Array<{ x: number; y: number; lon: number; lat: number }>,
  meta: { source_url?: string; license?: string } = {},
): MapRegistration | null {
  const fit = fitControlPoints(points, { width, height })
  if (!fit || width <= 0 || height <= 0) return null
  const lons = points.map(p => p.lon)
  const lats = points.map(p => p.lat)
  return {
    mode: 'image',
    width,
    height,
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    image: {
      forward: fit.forward,
      inverse: fit.inverse,
      residual_px: fit.residual_px,
      control_points: points.map(point => ({ ...point })),
      source_url: meta.source_url,
      license: meta.license,
    },
  }
}
