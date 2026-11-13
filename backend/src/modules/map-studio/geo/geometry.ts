/**
 * 地图几何总线（Issue #84）：三条底图路线 + 地理↔像素登记件 + 可编辑图层草稿
 *
 * 三条底图路线共用一件事：**底图拍完/画完之后，每个经纬度落在哪个像素必须是可计算的**。
 * 这件「登记件」（MapRegistration）是整条链路的地基——有它，后面的标注、图层编辑、语义
 * 才能和真实地理对齐；没有它，就只能靠人眼对图，等于回到扩散模型画地图的时代。
 *
 *   program：Natural Earth 50m + d3-geo（既有实现，几何真源，最确定）
 *   earth  ：真的开浏览器拍 Google Earth 影像（相机针孔投影，**不是**墨卡托，别套 bbox）
 *   image  ：外部档案图（Europeana / Smithsonian 等），人工 ≥3 个控制点拟合仿射，残差公开
 *
 * 扩散模型在这里只能做**纹理**：`renderMapDrawing` 的 texture 永远叠在底图之上、几何之下，
 * 并且几何是按登记件算出来的确定性图层，纹理无法移动或替换任何一个地理要素。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { DATA_ROOT, STORAGE_ROOT } from '../../../utils/paths.js'
import { getAbsolutePath } from '../../../utils/storage.js'
import {
  MAP_REGION_COLOR,
  MAP_ROUTE_COLOR,
  MapSpecValidationError,
  mapProjectionFor,
  renderMapBase,
  type MapContextCoverage,
  type MapSpec,
} from './base-render.js'
import { buildMapKmz, KMZ_GEOMETRY_NOTE } from './kmz.js'
import {
  captureEarthBase,
  EARTH_IMAGERY_NOTE,
  earthProject,
  earthUnproject,
  type EarthCamera,
  type EarthCrop,
  type EarthSidecar,
  type EarthWindow,
} from './earth.js'
import { applyAffine, fitAffine, type AffineForward, type AffineInverse, type ControlPoint } from './image-calibration.js'
import { ensureLayerFonts } from '../../../services/layer-fonts.js'
import { FONT_FAMILIES } from '../../../services/layer-svg.js'
import { gridGeoToNormalized, gridNormalizedToGeo } from './registration-grid.js'

export class MapGeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MapGeometryError'
  }
}

export type MapBaseMode = 'program' | 'earth' | 'image'

export interface MapReferenceImage {
  /** 仓库数据目录内的相对路径（static/...）；URL 与绝对路径一律拒绝 */
  path: string
  source_url: string
  license: string
  control_points: ControlPoint[]
}

export interface MapRegistrationGrid {
  lon_min: number
  lat_min: number
  lon_max: number
  lat_max: number
  cols: number
  rows: number
  /**
   * 行优先，纬度自北向南、经度自西向东；归一化到 [0,1] 的图像坐标。
   * 可以越界（保持双线性插值在边缘仍可用）；该节点在这张图上无定义时是 null
   * （Earth 相机下落在地平线之后），前端必须当「此处无定义」处理，不许当 0 用。
   */
  points: Array<[number, number] | null>
}

export interface MapRegistration {
  mode: MapBaseMode
  width: number
  height: number
  /** 这张图实际覆盖的地理范围 [west, south, east, north] */
  bbox: [number, number, number, number]
  program?: {
    projection: 'mercator' | 'equirectangular'
    bbox: [number, number, number, number]
    fit: 'd3.fitExtent'
    extent: [[number, number], [number, number]]
    /** 实际 d3 参数：fitExtent 会对球面边缘重采样，不能只按 bbox 四角自己估算。 */
    scale?: number
    translate?: [number, number]
  }
  image?: {
    forward: AffineForward
    inverse: AffineInverse
    residual_px: { max: number; rms: number }
    control_points: ControlPoint[]
    source_url: string
    license: string
  }
  earth?: {
    camera: EarthCamera
    window: EarthWindow
    crop: EarthCrop
    radius_m: number
    imagery_note: string
    calibrated?: boolean
    residual_px?: { max: number; rms: number }
    validation_count?: number
    calibration_image?: string
  }
  grid: MapRegistrationGrid
}

export interface MapSourceRef {
  kind: 'basemap' | 'imagery' | 'external_image' | 'vector'
  name: string
  url?: string
  license: string
  note?: string
}

export interface MapBaseProvenance {
  mode: MapBaseMode
  renderer: string
  sha256: string
  created_at: string
  registration: MapRegistration
  sources: MapSourceRef[]
  attribution: string
  reused: boolean
  warnings: string[]
  /** 完整测量点留在独立 sidecar；工作流快照只内联配准网格和校准摘要。 */
  earth?: Omit<EarthSidecar, 'calibration'> & {
    calibration: Omit<EarthSidecar['calibration'], 'controls' | 'grid'>
    sidecar_path: string
    evidence_image: string
  }
  image?: { residual_px: { max: number; rms: number }; control_points: ControlPoint[]; source_url: string; license: string }
  /** program 模式独有：Natural Earth 背景覆盖度与免责说明 */
  context?: MapContextCoverage
}

export interface MapBaseArtifact {
  path: string
  width: number
  height: number
  kmz_path?: string
  provenance: MapBaseProvenance
  registration: MapRegistration
}

const GRID_NODES = 33
/** 纹理最多这么浓：再高就会盖住地理底图的可读性（扩散只做氛围，不做地理） */
const MAX_TEXTURE_OPACITY = 0.6

// ---------------------------------------------------------------- 登记件

function gridFor(
  bbox: [number, number, number, number],
  size: { width: number; height: number },
  forward: (lonlat: [number, number]) => [number, number] | null,
): MapRegistrationGrid {
  const [west, south, east, north] = bbox
  const points: Array<[number, number] | null> = []
  for (let row = 0; row < GRID_NODES; row++) {
    const lat = north - ((north - south) * row) / (GRID_NODES - 1)
    for (let col = 0; col < GRID_NODES; col++) {
      const lon = west + ((east - west) * col) / (GRID_NODES - 1)
      const px = forward([lon, lat])
      // 不可见节点（Earth 地平线之后）必须占位，否则网格不再规则、双线性插值会错位；
      // 用 null 而不是 0：JSON 往返后仍然是「此处无定义」，不会被当成画面左上角
      points.push(px ? [px[0] / size.width, px[1] / size.height] : null)
    }
  }
  return { lon_min: west, lat_min: south, lon_max: east, lat_max: north, cols: GRID_NODES, rows: GRID_NODES, points }
}

function programRegistration(spec: MapSpec, size: { width: number; height: number }): MapRegistration {
  const projection = mapProjectionFor(spec, size)
  const base: MapRegistration = {
    mode: 'program',
    width: size.width,
    height: size.height,
    bbox: [...spec.bbox] as [number, number, number, number],
    program: {
      projection: spec.projection.type,
      bbox: [...spec.bbox] as [number, number, number, number],
      fit: 'd3.fitExtent',
      extent: [[0, 0], [size.width, size.height]],
      scale: projection.scale(),
      translate: projection.translate(),
    },
    grid: { lon_min: 0, lat_min: 0, lon_max: 0, lat_max: 0, cols: 0, rows: 0, points: [] },
  }
  base.grid = gridFor(base.bbox, size, lonlat => {
    const px = projection(lonlat)
    return px ? [px[0], px[1]] : null
  })
  return base
}

function earthRegistration(sidecar: EarthSidecar): MapRegistration {
  const size = { width: sidecar.crop.width, height: sidecar.crop.height }
  const calibration = sidecar.calibration
  if (!calibration || sidecar.capture_version !== 'pixelgrid-v2'
    || calibration.residual_px.max > 3 || !Number.isFinite(calibration.residual_px.max)) {
    throw new MapGeometryError('Earth 底图缺少通过独立留出点验收的实际像素网格，请重新生成（不复用旧相机假设）')
  }
  const grid = calibration.grid
  return {
    mode: 'earth',
    width: size.width,
    height: size.height,
    bbox: [grid.lon_min, grid.lat_min, grid.lon_max, grid.lat_max],
    earth: {
      camera: sidecar.camera_used,
      window: sidecar.window,
      crop: sidecar.crop,
      radius_m: 6_371_008.8,
      imagery_note: EARTH_IMAGERY_NOTE,
      calibrated: true,
      residual_px: calibration.residual_px,
      validation_count: calibration.validation_count,
      calibration_image: relFromStatic(calibration.screenshot),
    },
    grid,
  }
}

function imageRegistration(
  calibration: { forward: AffineForward; inverse: AffineInverse; residual_px: { max: number; rms: number }; control_points: ControlPoint[] },
  size: { width: number; height: number },
  source: { source_url: string; license: string },
): MapRegistration {
  const corners: Array<[number, number]> = [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]]
  const geo = corners.map(corner => applyAffine(calibration.inverse, corner))
  const bbox: [number, number, number, number] = [
    Math.min(...geo.map(point => point[0])),
    Math.min(...geo.map(point => point[1])),
    Math.max(...geo.map(point => point[0])),
    Math.max(...geo.map(point => point[1])),
  ]
  const registration: MapRegistration = {
    mode: 'image',
    width: size.width,
    height: size.height,
    bbox,
    image: { ...calibration, source_url: source.source_url, license: source.license },
    grid: { lon_min: 0, lat_min: 0, lon_max: 0, lat_max: 0, cols: 0, rows: 0, points: [] },
  }
  registration.grid = gridFor(bbox, size, lonlat => applyAffine(calibration.forward, lonlat))
  return registration
}

/**
 * 经纬度 → 像素 的闭包。批量换算（投影整条路线、铺网格）必须用它：
 * program 模式每次都重建 d3 投影，几千个点逐点重建会白烧掉大半个 CPU 核。
 */
export function forwardFor(reg: MapRegistration): (lonlat: [number, number]) => [number, number] | null {
  if (reg.mode === 'program' && reg.program) {
    const projection = mapProjectionFor(
      { projection: { type: reg.program.projection }, bbox: reg.program.bbox },
      { width: reg.width, height: reg.height },
    )
    if (reg.program.scale !== undefined && reg.program.translate) {
      projection.scale(reg.program.scale).translate(reg.program.translate)
    }
    return lonlat => {
      const px = projection(lonlat)
      return px ? [px[0], px[1]] : null
    }
  }
  if (reg.mode === 'earth' && reg.earth) {
    const earth = reg.earth
    if (earth.calibrated) {
      return lonlat => {
        const normalized = gridGeoToNormalized(reg.grid, lonlat)
        return normalized ? [normalized[0] * reg.width, normalized[1] * reg.height] : null
      }
    }
    return lonlat => {
      const projected = earthProject(lonlat, earth.camera, earth.window)
      if (!projected.visible) return null
      return [projected.x - earth.crop.x, projected.y - earth.crop.y]
    }
  }
  if (reg.mode === 'image' && reg.image) {
    const forward = reg.image.forward
    return lonlat => applyAffine(forward, lonlat)
  }
  throw new MapGeometryError(`地图登记件缺少 ${reg.mode} 模式所需的参数，无法做经纬度→像素换算`)
}

/** 像素 → 经纬度 的闭包（同上，批量换算走它） */
export function inverseFor(reg: MapRegistration): (px: [number, number]) => [number, number] | null {
  if (reg.mode === 'program' && reg.program) {
    const projection = mapProjectionFor(
      { projection: { type: reg.program.projection }, bbox: reg.program.bbox },
      { width: reg.width, height: reg.height },
    )
    if (reg.program.scale !== undefined && reg.program.translate) {
      projection.scale(reg.program.scale).translate(reg.program.translate)
    }
    return px => {
      const geo = projection.invert?.(px)
      return geo ? [geo[0], geo[1]] : null
    }
  }
  if (reg.mode === 'earth' && reg.earth) {
    const earth = reg.earth
    if (earth.calibrated) {
      return px => gridNormalizedToGeo(reg.grid, [px[0] / reg.width, px[1] / reg.height])
    }
    return px => earthUnproject([px[0] + earth.crop.x, px[1] + earth.crop.y], earth.camera, earth.window)
  }
  if (reg.mode === 'image' && reg.image) {
    const inverse = reg.image.inverse
    return px => applyAffine(inverse, px)
  }
  throw new MapGeometryError(`地图登记件缺少 ${reg.mode} 模式所需的参数，无法做像素→经纬度换算`)
}

/** 经纬度 → 图像像素（单点）。越界仍给值（编辑器要能把点拖回来），地平线之后给 null。 */
export function geoToPixel(reg: MapRegistration, lonlat: [number, number]): [number, number] | null {
  return forwardFor(reg)(lonlat)
}

/** 图像像素 → 经纬度（单点）；射线打不到地球时返回 null（真实情况，不外推） */
export function pixelToGeo(reg: MapRegistration, px: [number, number]): [number, number] | null {
  return inverseFor(reg)(px)
}

/** 归一化坐标 = 图层文档（layer-doc）用的 0–1 口径，前端编辑器与渲染器共用 */
export function geoToNormalized(reg: MapRegistration, lonlat: [number, number]): [number, number] | null {
  const px = geoToPixel(reg, lonlat)
  return px ? [px[0] / reg.width, px[1] / reg.height] : null
}

export function normalizedToGeo(reg: MapRegistration, point: [number, number]): [number, number] | null {
  return pixelToGeo(reg, [point[0] * reg.width, point[1] * reg.height])
}

/**
 * 换画布尺寸时的登记件换算。三种模式都是严格线性的：
 * program 的 fitExtent 随画幅等比缩放；earth 的焦距正比于窗口宽，窗口与裁切框同比缩放后
 * 投影逐像素等价；image 的仿射前乘一个缩放矩阵即可。
 */
export function rescaleRegistration(reg: MapRegistration, width: number): MapRegistration {
  if (!Number.isFinite(width) || width <= 0) throw new MapGeometryError(`目标宽度非法：${width}`)
  const factor = width / reg.width
  if (Math.abs(factor - 1) < 1e-9) return reg
  const height = Math.round(reg.height * factor)
  const next: MapRegistration = { ...reg, width, height, grid: reg.grid }
  if (reg.program) {
    next.program = {
      ...reg.program,
      extent: [[0, 0], [width, height]],
      ...(reg.program.scale !== undefined ? { scale: reg.program.scale * factor } : {}),
      ...(reg.program.translate ? {
        translate: [reg.program.translate[0] * factor, reg.program.translate[1] * factor] as [number, number],
      } : {}),
    }
  }
  if (reg.image) {
    const [a, b, c, d, e, f] = reg.image.forward
    const forward: AffineForward = [a * factor, b * factor, c * factor, d * factor, e * factor, f * factor]
    const [A, B, C, D, E, F] = reg.image.inverse
    const inverse: AffineInverse = [A / factor, B / factor, C, D / factor, E / factor, F]
    next.image = {
      ...reg.image,
      forward,
      inverse,
      control_points: reg.image.control_points.map(point => ({ ...point, x: point.x * factor, y: point.y * factor })),
    }
  }
  if (reg.earth) {
    next.earth = {
      ...reg.earth,
      window: { width: reg.earth.window.width * factor, height: reg.earth.window.height * factor },
      crop: {
        x: reg.earth.crop.x * factor,
        y: reg.earth.crop.y * factor,
        width: reg.earth.crop.width * factor,
        height: reg.earth.crop.height * factor,
      },
    }
  }
  // 归一化网格与尺度无关，直接沿用（避免重算时的取整漂移）
  return next
}

export function serializeRegistration(reg: MapRegistration): string {
  return JSON.stringify(reg)
}

/** 读路径：坏数据不许让详情接口 500，解析失败返回 null */
export function parseRegistration(raw: unknown): MapRegistration | null {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as MapRegistration
  if (candidate.mode !== 'program' && candidate.mode !== 'earth' && candidate.mode !== 'image') return null
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) return null
  if (!Array.isArray(candidate.bbox) || candidate.bbox.length !== 4) return null
  if (candidate.mode === 'program' && !candidate.program) return null
  if (candidate.mode === 'earth' && !candidate.earth) return null
  if (candidate.earth?.calibrated && (!candidate.grid
    || candidate.grid.cols < 2 || candidate.grid.rows < 2
    || !Array.isArray(candidate.grid.points)
    || candidate.grid.points.length !== candidate.grid.cols * candidate.grid.rows)) return null
  if (candidate.mode === 'image' && !candidate.image) return null
  return candidate
}

// ---------------------------------------------------------------- 出处水印

/**
 * 影像出处必须**留在成品里**：Earth 的版权 footer 在界面边缘、被裁掉了，外部档案图的许可
 * 也只在数据库里。所以干净底图落盘前，右下角烧一条出处。它不是地图文字（不参与几何），
 * 删不掉也不该删——Google 影像与各馆藏的使用条款都要求保留出处。
 */
async function burnAttribution(buffer: Buffer, size: { width: number; height: number }, text: string): Promise<Buffer> {
  await ensureLayerFonts()
  const fontSize = Math.max(12, Math.round(size.height * 0.018))
  const padding = Math.round(fontSize * 0.6)
  const stripHeight = fontSize + padding * 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">`
    + `<rect x="0" y="${size.height - stripHeight}" width="${size.width}" height="${stripHeight}" fill="#000000" fill-opacity="0.45"/>`
    + `<text x="${size.width - padding}" y="${size.height - padding - fontSize * 0.1}" text-anchor="end"`
    + ` font-family="${FONT_FAMILIES.sans}" font-size="${fontSize}" fill="#ffffff" xml:space="preserve">`
    + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    + '</text></svg>'
  return sharp(buffer).composite([{ input: Buffer.from(svg) }]).png().toBuffer()
}

// ---------------------------------------------------------------- 底图生产

function relFromStatic(absolute: string): string {
  return `static/${path.relative(STORAGE_ROOT, absolute).split(path.sep).join('/')}`
}

/**
 * 只接受数据目录内的 static 相对路径：外部图是**不可信输入**，解码路径必须可控。
 * 词法判断不够——数据目录里的一个软链可以指向 /etc/shadow，sharp 会照读不误，
 * 所以还要按 realpath 复核，并且只接受普通文件（目录/设备文件一律拒绝）。
 */
function resolveStaticImage(relativePath: string, what: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new MapGeometryError(`${what}路径为空`)
  }
  if (/^(https?:|data:|file:)/i.test(relativePath) || path.isAbsolute(relativePath)) {
    throw new MapGeometryError(`${what}只接受仓库内的 static/ 相对路径，收到：${relativePath.slice(0, 120)}`)
  }
  const absolute = path.resolve(getAbsolutePath(relativePath))
  const root = path.resolve(DATA_ROOT)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new MapGeometryError(`${what}路径越界：${relativePath}`)
  }
  if (!fs.existsSync(absolute)) throw new MapGeometryError(`${what}文件不存在：${relativePath}`)
  const real = fs.realpathSync(absolute)
  const realRoot = fs.realpathSync(root)
  if (!real.startsWith(realRoot + path.sep)) {
    throw new MapGeometryError(`${what}指向了项目数据目录之外（软链越界）：${relativePath}`)
  }
  if (!fs.statSync(real).isFile()) {
    throw new MapGeometryError(`${what}不是普通文件：${relativePath}`)
  }
  return real
}

/** 程序底图只渲染自然地理；用户点线面留给可编辑图层，避免拖动后留下烧入像素的鬼影。 */
async function createProgramBase(spec: MapSpec, width?: number): Promise<MapBaseArtifact> {
  const renderSpec: MapSpec = { ...spec, places: [], routes: [], regions: [] }
  const rendered = await renderMapBase(renderSpec, width ? { width } : undefined)
  // 登记件只取决于投影与 bbox，所以去掉要素后像素换算与带要素时逐像素一致
  const registration = programRegistration(spec, { width: rendered.width, height: rendered.height })
  return {
    path: rendered.path,
    width: rendered.width,
    height: rendered.height,
    registration,
    provenance: {
      mode: 'program',
      renderer: 'd3-geo+natural-earth-50m',
      sha256: rendered.sha256,
      created_at: new Date().toISOString(),
      registration,
      sources: [{
        kind: 'vector',
        name: 'Natural Earth 50m（land/coastline/rivers/lakes/countries/admin1/populated places）',
        url: 'https://www.naturalearthdata.com/',
        license: 'Public domain',
        note: '现代地理底图；省界与城市点仅为定位参照，不代表历史疆界。',
      }],
      attribution: 'Natural Earth（公共领域）',
      reused: rendered.reused,
      warnings: rendered.context.warnings,
      context: rendered.context,
    },
  }
}

async function createEarthBase(spec: MapSpec, width?: number): Promise<MapBaseArtifact> {
  const kmz = buildMapKmz(spec, { description: 'Issue #84 自动生成的地图底图 KMZ' })
  const kmzDir = path.join(STORAGE_ROOT, 'map-kmz')
  fs.mkdirSync(kmzDir, { recursive: true })
  const kmzAbs = path.join(kmzDir, `${kmz.sha256.slice(0, 32)}.kmz`)
  if (!fs.existsSync(kmzAbs)) fs.writeFileSync(kmzAbs, kmz.buffer)

  const longSide = Math.max(820, Math.min(4000, Math.trunc(width ?? 2000)))
  const dir = path.join(STORAGE_ROOT, 'map-bases', 'earth')
  fs.mkdirSync(dir, { recursive: true })
  const stem = `pixelgrid-v2-clean-${kmz.sha256.slice(0, 24)}-${longSide}`
  const baseAbs = path.join(dir, `${stem}.png`)
  const evidenceAbs = path.join(dir, `${stem}-kmz.png`)
  const sidecarAbs = path.join(dir, `${stem}.json`)

  let sidecar: EarthSidecar | null = null
  let reused = false
  if (fs.existsSync(baseAbs) && fs.existsSync(evidenceAbs) && fs.existsSync(sidecarAbs)) {
    // 只复用合格的干净影像，不沿用曾静默回退到 default 的缓存。
    const cached: EarthSidecar = JSON.parse(fs.readFileSync(sidecarAbs, 'utf8'))
    if (cached.basemap === 'clean (no Google labels/borders/roads)') {
      sidecar = cached
      reused = true
    }
  }
  if (!sidecar) {
    sidecar = await captureEarthBase({
      spec,
      kmzAbsPath: kmzAbs,
      kmzSha256: kmz.sha256,
      outAbsPath: baseAbs,
      evidenceAbsPath: evidenceAbs,
      longSide,
    })
    const burnt = await burnAttribution(
      fs.readFileSync(baseAbs),
      { width: sidecar.image.width, height: sidecar.image.height },
      'Imagery (C) Google, Landsat / Copernicus, SIO, NOAA, U.S. Navy, NGA, GEBCO',
    )
    fs.writeFileSync(baseAbs, burnt)
    fs.writeFileSync(sidecarAbs, JSON.stringify(sidecar, null, 2))
  }

  const registration = earthRegistration(sidecar)
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(baseAbs)).digest('hex')
  return {
    path: relFromStatic(baseAbs),
    width: registration.width,
    height: registration.height,
    kmz_path: relFromStatic(kmzAbs),
    registration,
    provenance: {
      mode: 'earth',
      renderer: 'google-earth-web',
      sha256,
      created_at: new Date().toISOString(),
      registration,
      sources: [
        {
          kind: 'imagery',
          name: 'Google Earth Web 卫星影像',
          url: 'https://earth.google.com/web/',
          license: '© Google 及其数据提供方（Landsat/Copernicus、SIO、NOAA、U.S. Navy、NGA、GEBCO）',
          note: '底图影像版权归 Google 及数据方；成品右下角已烧入出处。',
        },
        {
          kind: 'vector',
          name: `本项目生成的 KMZ（sha256 ${kmz.sha256.slice(0, 16)}，${kmz.counts.places} 点 / ${kmz.counts.routes} 线 / ${kmz.counts.regions} 面）`,
          license: '本项目所有',
          note: KMZ_GEOMETRY_NOTE,
        },
      ],
      attribution: EARTH_IMAGERY_NOTE,
      reused,
      warnings: [
        '最终底图里不含 KMZ 几何：地名/路线/范围由可编辑图层承担，载入证明见 evidence_image。',
      ],
      earth: {
        ...sidecar,
        calibration: {
          residual_px: sidecar.calibration.residual_px,
          validation_count: sidecar.calibration.validation_count,
          tolerance_px: sidecar.calibration.tolerance_px,
          camera_drift_px: sidecar.calibration.camera_drift_px,
          screenshot: relFromStatic(sidecar.calibration.screenshot),
          kmz: relFromStatic(sidecar.calibration.kmz),
          kmz_sha256: sidecar.calibration.kmz_sha256,
        },
        sidecar_path: relFromStatic(sidecarAbs),
        evidence_image: relFromStatic(evidenceAbs),
      },
    },
  }
}

async function createImageBase(spec: MapSpec, reference: MapReferenceImage | undefined, width?: number): Promise<MapBaseArtifact> {
  if (!reference) {
    throw new MapGeometryError('外部底图模式需要 reference_image（图片路径、来源链接、许可、≥3 个控制点），当前没有提供')
  }
  if (!reference.source_url?.trim()) throw new MapGeometryError('外部底图必须填写来源链接 source_url（可追溯出处）')
  if (!reference.license?.trim()) throw new MapGeometryError('外部底图必须填写许可 license（没有许可信息不能进成片）')
  const absolute = resolveStaticImage(reference.path, '外部底图')
  const meta = await sharp(absolute).metadata()
  if (!meta.width || !meta.height) throw new MapGeometryError(`外部底图无法解码尺寸：${reference.path}`)

  const sourceCalibration = fitAffine(reference.control_points, { width: meta.width, height: meta.height })

  const targetWidth = Math.max(640, Math.min(7680, Math.trunc(width ?? meta.width)))
  const scale = targetWidth / meta.width
  const targetHeight = Math.max(1, Math.round(meta.height * scale))

  const signature = crypto.createHash('sha256').update(JSON.stringify({
    file: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    control: sourceCalibration.control_points,
    width: targetWidth,
    // 出处/许可是**烧进图里**的：换了来源或许可必须重新落盘，否则复用会留着旧水印
    source_url: reference.source_url,
    license: reference.license,
  })).digest('hex').slice(0, 24)
  const dir = path.join(STORAGE_ROOT, 'map-bases', 'image')
  fs.mkdirSync(dir, { recursive: true })
  const outAbs = path.join(dir, `${signature}.png`)
  const reused = fs.existsSync(outAbs)
  if (!reused) {
    const resized = await sharp(absolute).resize(targetWidth, targetHeight, { fit: 'fill' }).png().toBuffer()
    const attribution = `来源：${reference.source_url} · 许可：${reference.license}`
    fs.writeFileSync(outAbs, await burnAttribution(resized, { width: targetWidth, height: targetHeight }, attribution))
  }

  const scaled = {
    forward: [
      sourceCalibration.forward[0] * scale, sourceCalibration.forward[1] * scale, sourceCalibration.forward[2] * scale,
      sourceCalibration.forward[3] * scale, sourceCalibration.forward[4] * scale, sourceCalibration.forward[5] * scale,
    ] as AffineForward,
    inverse: [
      sourceCalibration.inverse[0] / scale, sourceCalibration.inverse[1] / scale, sourceCalibration.inverse[2],
      sourceCalibration.inverse[3] / scale, sourceCalibration.inverse[4] / scale, sourceCalibration.inverse[5],
    ] as AffineInverse,
    residual_px: {
      max: Number((sourceCalibration.residual_px.max * scale).toFixed(3)),
      rms: Number((sourceCalibration.residual_px.rms * scale).toFixed(3)),
    },
    control_points: sourceCalibration.control_points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale })),
  }
  const registration = imageRegistration(scaled, { width: targetWidth, height: targetHeight }, reference)

  const warnings: string[] = [
    `仿射配准残差：最大 ${scaled.residual_px.max}px、均方根 ${scaled.residual_px.rms}px（${scaled.control_points.length} 个控制点）；标注精度不会好于该残差。`,
  ]
  const outside = spec.places.filter(place => {
    const px = geoToPixel(registration, [place.lon, place.lat])
    return !px || px[0] < 0 || px[1] < 0 || px[0] > targetWidth || px[1] > targetHeight
  })
  if (outside.length) {
    warnings.push(`有 ${outside.length} 个地点落在这张外部底图之外（${outside.slice(0, 5).map(place => place.name || place.id).join('、')}）：它们不会出现在画面里。`)
  }

  return {
    path: relFromStatic(outAbs),
    width: targetWidth,
    height: targetHeight,
    registration,
    provenance: {
      mode: 'image',
      renderer: 'external-image+affine',
      sha256: crypto.createHash('sha256').update(fs.readFileSync(outAbs)).digest('hex'),
      created_at: new Date().toISOString(),
      registration,
      sources: [{
        kind: 'external_image',
        name: '外部档案图像',
        url: reference.source_url,
        license: reference.license,
        note: '非测绘底图，几何对齐由人工控制点的仿射拟合给出，精度见残差。',
      }],
      attribution: `来源：${reference.source_url} · 许可：${reference.license}`,
      reused,
      warnings,
      image: {
        residual_px: scaled.residual_px,
        control_points: scaled.control_points,
        source_url: reference.source_url,
        license: reference.license,
      },
    },
  }
}

/**
 * 生产底图并给出登记件。三条路线的返回结构一致，调用方不需要分支。
 * earth 失败（依赖缺失/相机不可信）一律抛错，**绝不**退回程序底图冒充 Earth。
 */
export async function createMapBaseArtifact(
  spec: MapSpec,
  options: { mode: MapBaseMode; width?: number; referenceImage?: MapReferenceImage },
): Promise<MapBaseArtifact> {
  if (options.mode === 'program') return createProgramBase(spec, options.width)
  if (options.mode === 'earth') return createEarthBase(spec, options.width)
  if (options.mode === 'image') return createImageBase(spec, options.referenceImage, options.width)
  throw new MapGeometryError(`未知底图模式：${String(options.mode)}`)
}

// ---------------------------------------------------------------- 可编辑图层

export interface MapProjectedGeometry {
  points: Array<{ id: string; name: string; at: [number, number] }>
  routes: Array<{ id: string; name: string; points: Array<[number, number]>; color: string }>
  regions: Array<{ id: string; name: string; points: Array<[number, number]>; color: string }>
}

/**
 * 把 spec 的地理要素按登记件投到画布上。
 *
 * 看不见（Earth 地平线之后）或落在画面之外的顶点**一律报错**，不丢点也不钳边：
 * 丢掉中间一个顶点会改变折线/面的拓扑（河道改道、边界易主），钳到画边则是在画面上
 * 写一个假位置。这两种「尽力而为」在地图上都是伪造，必须让人改 bbox 或改要素。
 */
export function projectSpecGeometry(
  spec: MapSpec,
  registration: MapRegistration,
): MapProjectedGeometry {
  const result: MapProjectedGeometry = { points: [], routes: [], regions: [] }
  const forward = forwardFor(registration)
  // 以「类型:id」为键，不是显示名：两个都叫「黄河」的要素必须分别报出来，
  // 而且报错里要带 id，否则用户在 map_spec 里根本找不到是哪一条
  const invisible = new Map<string, string>()
  const outside = new Map<string, string>()
  const project = (key: string, label: string, points: Array<[number, number]>): Array<[number, number]> => {
    const projected: Array<[number, number]> = []
    for (const point of points) {
      const px = forward(point)
      if (!px) {
        invisible.set(key, label)
        continue
      }
      if (px[0] < 0 || px[1] < 0 || px[0] > registration.width || px[1] > registration.height) {
        outside.set(key, label)
      }
      projected.push(px)
    }
    return projected
  }

  for (const place of spec.places) {
    const key = `place:${place.id}`
    const label = `地点「${place.name || place.id}」(id ${place.id})`
    const projected = project(key, label, [[place.lon, place.lat]])
    if (projected.length) result.points.push({ id: place.id, name: place.name, at: projected[0] })
  }
  for (const route of spec.routes) {
    const key = `route:${route.id}`
    const label = `路线「${route.name || route.id}」(id ${route.id})`
    const projected = project(key, label, route.points)
    if (projected.length >= 2) {
      result.routes.push({ id: route.id, name: route.name, points: projected, color: MAP_ROUTE_COLOR })
    }
  }
  for (const region of spec.regions) {
    const key = `region:${region.id}`
    const label = `区域「${region.name || region.id}」(id ${region.id})`
    const projected = project(key, label, region.points)
    if (projected.length >= 3) {
      result.regions.push({ id: region.id, name: region.name, points: projected, color: MAP_REGION_COLOR })
    }
  }

  if (invisible.size) {
    throw new MapGeometryError(
      `这些要素在当前底图的相机下不可见（在地球另一面）：${[...invisible.values()].join('、')}。`
      + '请缩小视野或改用覆盖得到的底图范围；不可见的顶点不会被悄悄丢掉。',
    )
  }
  if (outside.size) {
    throw new MapGeometryError(
      `这些要素有顶点落在底图画面之外：${[...outside.values()].join('、')}。`
      + '请扩大底图 bbox（或缩小/删除这些要素）；落在画外的点不会被钳到画边假装在画里。',
    )
  }
  return result
}

export interface MapBackgroundResult {
  /** `static/map-drawings/<sig>-bg.png`：模型 LayerDoc 的 base.path */
  path: string
  width: number
  height: number
  /** 已按背景尺寸缩放的登记件：经纬度 ↔ 背景像素 */
  registration: MapRegistration
  warnings: string[]
}

/**
 * 「底图 + 可选质感底纹」确定性合成一次，作为模型作图的 LayerDoc 底图（Issue #90）。
 *
 * 纹理只合成到背景上；点线面、标签、取舍全部由模型在图层文档里画，
 * 代码不排版、不投影出图——成图只能是同一条 renderLayerDoc 渲染链的产物。
 */
export async function prepareMapBackground(options: {
  basePath: string
  registration: unknown
  width?: number
  texturePath?: string
  textureOpacity?: number
}): Promise<MapBackgroundResult> {
  const baseAbs = resolveStaticImage(options.basePath, '地图底图')
  const baseMeta = await sharp(baseAbs).metadata()
  if (!baseMeta.width || !baseMeta.height) throw new MapGeometryError(`地图底图无法解码尺寸：${options.basePath}`)
  const width = Math.max(640, Math.min(7680, Math.trunc(options.width ?? baseMeta.width)))
  const height = Math.max(1, Math.round((baseMeta.height * width) / baseMeta.width))

  const provided = parseRegistration(options.registration)
  if (!provided) throw new MapGeometryError('底图缺少合法的登记件（registration），无法把经纬度换算成像素；请重新生成底图')
  const registration = rescaleRegistration(provided, width)
  if (registration.width !== width || Math.abs(registration.height - height) > 1) {
    throw new MapGeometryError(
      `登记件尺寸 ${registration.width}×${registration.height} 与底图 ${width}×${height} 对不上，像素换算会整体错位`,
    )
  }

  const warnings: string[] = []
  const textureAbs = options.texturePath ? resolveStaticImage(options.texturePath, '地图纹理') : null
  const opacity = Math.min(MAX_TEXTURE_OPACITY, Math.max(0, options.textureOpacity ?? 0.35))
  if (textureAbs) warnings.push(`纹理以 ${(opacity * 100).toFixed(0)}% 不透明度叠加在底图之上，只影响背景质感。`)
  const signature = crypto.createHash('sha256').update(JSON.stringify({
    renderer: 'map-background-v1',
    base: options.basePath,
    texture: options.texturePath ?? null,
    opacity,
    width,
  })).digest('hex').slice(0, 32)

  const dir = path.join(STORAGE_ROOT, 'map-drawings')
  fs.mkdirSync(dir, { recursive: true })
  const backgroundAbs = path.join(dir, `${signature}-bg.png`)
  if (!fs.existsSync(backgroundAbs)) {
    let background = sharp(baseAbs).resize(width, height, { fit: 'fill' })
    if (textureAbs) {
      // removeAlpha 先去掉素材自带的透明通道：ensureAlpha 只对「没有 alpha」的图生效，
      // 否则 PNG 纹理会按自己的 alpha 全幅盖住底图
      const texture = await sharp(textureAbs)
        .resize(width, height, { fit: 'cover' })
        .removeAlpha()
        .ensureAlpha(opacity)
        .png()
        .toBuffer()
      background = sharp(await background.png().toBuffer()).composite([{ input: texture, blend: 'over' }])
    }
    fs.writeFileSync(backgroundAbs, await background.png().toBuffer())
  }
  return { path: relFromStatic(backgroundAbs), width, height, registration, warnings }
}

/** map_spec 校验错误与几何错误对外是同一类「可直接展示」的错误 */
export function isMapInputError(error: unknown): boolean {
  return error instanceof MapGeometryError || error instanceof MapSpecValidationError
}
