/**
 * 地图确定性底图渲染（Issue #56 / R3）
 *
 * 为什么不用扩散模型画地图：资产实验室实测（~/projects/huobao-asset-lab/report.md）
 * 扩散模型会重绘海岸线与河道、把地名锚点挪到几百公里外，地图几何不可用。
 * 所以地图走「确定性底图」：Natural Earth 50m 矢量 + d3-geo 投影 → SVG → sharp 栅格化，
 * 风格化只允许在这张底图之上做低去噪/结构受控的二次处理。
 *
 * 本模块**绝不渲染任何文字**（地名、图例、刻度全都没有）：地图上的文字一律由叠加图层系统
 * （backend/src/services/layer-render.ts）在确定性图层里排版，这样文字永远可编辑、永远不糊。
 * renderMapBase 只回传每个地点/路线投影后的像素坐标，供图层编辑器放标注。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { geoEquirectangular, geoMercator, geoPath, type GeoProjection } from 'd3-geo'
import sharp from 'sharp'
import { z } from 'zod'
import { STORAGE_ROOT } from '../../../utils/paths.js'

export const MAP_BASE_WIDTH = 3840
export const MAP_BASE_HEIGHT = 2160
/** 路线/河流在底图上的渲染色：必须是有彩色（后续图层/风格化会按颜色提取线条） */
export const MAP_ROUTE_COLOR = '#1f6fd0'
/**
 * 区域（势力范围/行政区/战役范围）在底图上的填充色（Issue #84）。
 * 与路线色分开：风格化/抽色时面与线必须可区分，二者混色会让下游把边界当路线。
 */
export const MAP_REGION_COLOR = '#b4573c'

/** 水体固定冷蓝，比路线色浅，避免风格化后把海洋误当路线 */
const MAP_WATER_COLOR = '#8fc1e8'

export class MapSpecValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MapSpecValidationError'
  }
}

export interface MapPlace { id: string; name: string; lon: number; lat: number; proposed?: boolean }
export interface MapRoute { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
/** 面要素：外环（首尾点由 normalizeMapSpec 自动闭合），经纬度与 routes 同口径 */
export interface MapRegion { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
export interface MapSpec {
  version: 1
  projection: { type: 'mercator' | 'equirectangular' }
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  layers: { land: boolean; coastline: boolean; rivers: boolean; lakes: boolean; countries: boolean }
  places: MapPlace[]
  routes: MapRoute[]
  /** Issue #84：面几何。老 map_spec 没有这个字段，规范化后为 []，渲染签名与改动前逐字节一致。 */
  regions: MapRegion[]
  style: { theme: 'archival' | 'clean' | 'ink' }
}

export interface MapCanvasSize { width: number; height: number }

export interface MapProjectedPoint { id: string; name: string; at: [number, number] }
export interface MapProjectedRoute { id: string; name: string; points: Array<[number, number]>; color: string }
export interface MapProjectedRegion { id: string; name: string; points: Array<[number, number]>; color: string }
export interface MapContextCoverage {
  disclaimer: string
  boundary_features: number
  city_points: number
  warnings: string[]
}
export interface MapRenderResult {
  /** `static/map-bases/<signature>.png`（STORAGE_ROOT 下的相对路径，getAbsolutePath 口径） */
  path: string
  width: number
  height: number
  sha256: string
  points: MapProjectedPoint[]
  routes: MapProjectedRoute[]
  regions: MapProjectedRegion[]
  /** 现代定位背景，不进入用户审核的 places/routes 语义。 */
  context: MapContextCoverage
  /** 该签名的文件此前已存在（本次未重新栅格化） */
  reused: boolean
}

// ---------------------------------------------------------------- 校验

const MAX_PLACES = 200
const MAX_ROUTES = 50
const MAX_ROUTE_POINTS = 5000
const MAX_REGIONS = 30
const MAX_REGION_POINTS = 2000
/** mercator 在两极发散，纬度按 Web 地图惯例截到 ±85 */
const MERCATOR_LAT_LIMIT = 85

const finiteNumber = z.number().finite()

const lonLatTuple = z.tuple([finiteNumber, finiteNumber])

const specSchema = z.object({
  version: z.literal(1).optional(),
  projection: z.object({ type: z.enum(['mercator', 'equirectangular']) }).optional(),
  bbox: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]),
  layers: z.object({
    land: z.boolean().optional(),
    coastline: z.boolean().optional(),
    rivers: z.boolean().optional(),
    lakes: z.boolean().optional(),
    countries: z.boolean().optional(),
  }).optional(),
  places: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    lon: finiteNumber,
    lat: finiteNumber,
    proposed: z.boolean().optional(),
  })).optional(),
  routes: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    points: z.array(lonLatTuple),
    proposed: z.boolean().optional(),
  })).optional(),
  regions: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    points: z.array(lonLatTuple),
    proposed: z.boolean().optional(),
  })).optional(),
  style: z.object({ theme: z.enum(['archival', 'clean', 'ink']) }).optional(),
})

function fail(message: string): never {
  throw new MapSpecValidationError(message)
}

/** 外环首尾闭合（GeoJSON 惯例）；已闭合则原样返回 */
function closeRing(points: Array<[number, number]>): Array<[number, number]> {
  const first = points[0]
  const last = points[points.length - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) return [...points, [first[0], first[1]]]
  return points
}

/**
 * 纯函数校验 + 规范化；非法抛 MapSpecValidationError（消息里必须点名出错字段，
 * 因为这是直接回给前端地图编辑器的提示）。
 */
export function normalizeMapSpec(raw: unknown): MapSpec {
  const parsed = specSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path?.length ? issue.path.join('.') : 'map_spec'
    fail(`地图配置字段 ${field} 非法：${issue?.message ?? '结构不符合要求'}`)
  }
  const data = parsed.data

  const [west, south, east, north] = data.bbox
  for (const [name, value] of [['bbox.west', west], ['bbox.east', east]] as const) {
    if (value < -180 || value > 180) fail(`地图配置字段 ${name} 非法：经度必须在 -180~180 之间，当前 ${value}`)
  }
  const projectionType = data.projection?.type ?? 'mercator'
  const latLimit = projectionType === 'mercator' ? MERCATOR_LAT_LIMIT : 90
  for (const [name, value] of [['bbox.south', south], ['bbox.north', north]] as const) {
    if (value < -latLimit || value > latLimit) {
      fail(`地图配置字段 ${name} 非法：${projectionType} 投影纬度必须在 -${latLimit}~${latLimit} 之间，当前 ${value}`)
    }
  }
  if (!(west < east)) fail(`地图配置字段 bbox 非法：要求 west < east，当前 west=${west} east=${east}`)
  if (!(south < north)) fail(`地图配置字段 bbox 非法：要求 south < north，当前 south=${south} north=${north}`)

  const places = data.places ?? []
  if (places.length > MAX_PLACES) fail(`地图配置字段 places 非法：地点最多 ${MAX_PLACES} 个，当前 ${places.length} 个`)
  for (const place of places) {
    if (place.lon < -180 || place.lon > 180) fail(`地图配置字段 places[${place.id}].lon 非法：必须在 -180~180 之间`)
    if (place.lat < -90 || place.lat > 90) fail(`地图配置字段 places[${place.id}].lat 非法：必须在 -90~90 之间`)
  }

  const routes = data.routes ?? []
  if (routes.length > MAX_ROUTES) fail(`地图配置字段 routes 非法：路线最多 ${MAX_ROUTES} 条，当前 ${routes.length} 条`)
  for (const route of routes) {
    if (route.points.length > MAX_ROUTE_POINTS) {
      fail(`地图配置字段 routes[${route.id}].points 非法：单条路线最多 ${MAX_ROUTE_POINTS} 个点，当前 ${route.points.length} 个`)
    }
    for (const [lon, lat] of route.points) {
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        fail(`地图配置字段 routes[${route.id}].points 非法：经度需在 -180~180、纬度需在 -90~90 之间`)
      }
    }
  }

  const regions = data.regions ?? []
  if (regions.length > MAX_REGIONS) fail(`地图配置字段 regions 非法：区域最多 ${MAX_REGIONS} 个，当前 ${regions.length} 个`)
  for (const region of regions) {
    if (region.points.length < 3) {
      fail(`地图配置字段 regions[${region.id}].points 非法：面至少需要 3 个点，当前 ${region.points.length} 个`)
    }
    if (region.points.length > MAX_REGION_POINTS) {
      fail(`地图配置字段 regions[${region.id}].points 非法：单个面最多 ${MAX_REGION_POINTS} 个点，当前 ${region.points.length} 个`)
    }
    for (const [lon, lat] of region.points) {
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        fail(`地图配置字段 regions[${region.id}].points 非法：经度需在 -180~180、纬度需在 -90~90 之间`)
      }
    }
    // 退化面（所有点同一位置/同一条线）会被画成不可见的一道线，几何上也不是「范围」。
    // 只数不同点不够：三个共线的不同点仍然围不出面积，必须真算面积。
    const unique = new Set(region.points.map(([lon, lat]) => `${lon},${lat}`))
    if (unique.size < 3) {
      fail(`地图配置字段 regions[${region.id}].points 非法：至少要有 3 个不同的点，当前只有 ${unique.size} 个`)
    }
    const ring = closeRing(region.points.map(([lon, lat]) => [lon, lat] as [number, number]))
    // 先平移到首点附近，避免大经纬度相乘再相减吞掉窄运河/走廊真正存在的面积。
    const [originLon, originLat] = ring[0]
    let twiceArea = 0
    let coordinateScale = 0
    for (let i = 0; i < ring.length - 1; i++) {
      const x1 = ring[i][0] - originLon
      const y1 = ring[i][1] - originLat
      const x2 = ring[i + 1][0] - originLon
      const y2 = ring[i + 1][1] - originLat
      twiceArea += x1 * y2 - x2 * y1
      coordinateScale = Math.max(coordinateScale, Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2))
    }
    // 只拒绝数值退化，不按形状的宽窄比设门槛：合法的运河带可以很长很窄。
    const areaEpsilon = coordinateScale * coordinateScale * 1e-12
    if (Math.abs(twiceArea) <= areaEpsilon) {
      fail(`地图配置字段 regions[${region.id}].points 非法：这些点共线或面积数值退化，围不出有面积的范围（请改用折线 routes）`)
    }
  }

  return {
    version: 1,
    projection: { type: projectionType },
    bbox: [west, south, east, north],
    layers: {
      land: data.layers?.land ?? true,
      coastline: data.layers?.coastline ?? true,
      rivers: data.layers?.rivers ?? true,
      lakes: data.layers?.lakes ?? true,
      countries: data.layers?.countries ?? true,
    },
    places: places.map(item => ({
      id: item.id,
      name: item.name,
      lon: item.lon,
      lat: item.lat,
      ...(item.proposed ? { proposed: true as const } : {}),
    })),
    routes: routes.map(item => ({
      id: item.id,
      name: item.name,
      points: item.points.map(([lon, lat]) => [lon, lat] as [number, number]),
      ...(item.proposed ? { proposed: true as const } : {}),
    })),
    // 外环按 GeoJSON 惯例闭合：首尾同点，重复点不计入上限校验
    regions: regions.map(item => ({
      id: item.id,
      name: item.name,
      points: closeRing(item.points.map(([lon, lat]) => [lon, lat] as [number, number])),
      ...(item.proposed ? { proposed: true as const } : {}),
    })),
    style: { theme: data.style?.theme ?? 'archival' },
  }
}

/** 库里 JSON 文本 → MapSpec；非法/空返回 null（读路径不抛，坏数据不能让详情接口 500） */
export function parseMapSpec(raw: string | null | undefined): MapSpec | null {
  if (!raw) return null
  try {
    return normalizeMapSpec(JSON.parse(raw))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 投影

/** 画布强制 16:9（宽为准），最小 1280×720。导出：地图登记件要按同一口径复算画布。 */
export function normalizeMapCanvas(size: Partial<MapCanvasSize> | undefined): MapCanvasSize {
  const rawWidth = Math.trunc(size?.width ?? MAP_BASE_WIDTH)
  const width = Math.max(1280, Math.min(7680, Number.isFinite(rawWidth) ? rawWidth : MAP_BASE_WIDTH))
  // 宽为准推 16:9；偶数宽保证高度整数化后比例误差 < 1px
  const height = Math.max(720, Math.round(width * 9 / 16))
  return { width, height }
}

/**
 * bbox 矩形环。**必须顺时针**（[w,s]→[w,n]→[e,n]→[e,s]）：d3-geo 按球面语义解释多边形，
 * 逆时针小环表示「整个地球减去这个矩形」，fitExtent 会去拟合全球，豫北 bbox 实测会塌成
 * 1280×720 画布上 5px 宽的一小团（见 tests/map-base-render.test.mjs 的跨度断言）。
 */
function bboxPolygon(spec: Pick<MapSpec, 'bbox'>) {
  const [w, s, e, n] = spec.bbox
  return {
    type: 'Polygon' as const,
    coordinates: [[[w, s], [w, n], [e, n], [e, s], [w, s]]],
  }
}
/**
 * 渲染与坐标换算共用同一个投影实例口径，否则标注会和底图错位。
 * 导出给 map-geometry：登记件（registration）里只存 projection + bbox + 画布尺寸，
 * 复原投影必须走这个唯一实现，绝不允许第二份 fitExtent 写法。
 */
export function mapProjectionFor(spec: Pick<MapSpec, 'projection' | 'bbox'>, size: MapCanvasSize): GeoProjection {
  const projection = spec.projection.type === 'mercator' ? geoMercator() : geoEquirectangular()
  // fitExtent 自身保持纵横比并居中，16:9 画幅下允许上下/左右留边
  projection.fitExtent([[0, 0], [size.width, size.height]], bboxPolygon(spec))
  return projection
}

export function projectLonLat(spec: MapSpec, size: MapCanvasSize, lonlat: [number, number]): [number, number] {
  const projected = mapProjectionFor(spec, normalizeMapCanvas(size))(lonlat)
  if (!projected) throw new MapSpecValidationError(`坐标 [${lonlat[0]}, ${lonlat[1]}] 无法投影到当前地图`)
  return [projected[0], projected[1]]
}

export function unprojectPixel(spec: MapSpec, size: MapCanvasSize, px: [number, number]): [number, number] {
  const projection = mapProjectionFor(spec, normalizeMapCanvas(size))
  const inverted = projection.invert?.(px)
  if (!inverted) throw new MapSpecValidationError(`像素 [${px[0]}, ${px[1]}] 无法反算经纬度`)
  return [inverted[0], inverted[1]]
}

// ---------------------------------------------------------------- 数据

type GeoLayerName = 'land' | 'coastline' | 'rivers' | 'lakes' | 'countries' | 'admin1' | 'cities'

const GEO_FILES: Record<GeoLayerName, string> = {
  land: 'ne_50m_land.geojson',
  coastline: 'ne_50m_coastline.geojson',
  rivers: 'ne_50m_rivers_lake_centerlines.geojson',
  lakes: 'ne_50m_lakes.geojson',
  countries: 'ne_50m_admin_0_countries.geojson',
  admin1: 'ne_50m_admin_1_states_provinces_lines.geojson',
  cities: 'ne_50m_populated_places.geojson',
}

/** geojson 单文件最大 3 MB 级别，解析一次常驻；绝不每次渲染都重读 */
const geoCache = new Map<GeoLayerName, unknown>()

function resolveGeoDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.HUOBAO_GEO_DIR,
    // dev / tsx：src/modules/map-studio/geo → backend/assets/geo（通用资产路径，模块只读）
    path.resolve(here, '../../../../assets/geo'),
    // 桌面版 esbuild bundle：build/backend.mjs 旁边的 assets/geo
    path.resolve(here, 'assets/geo'),
    path.resolve(process.cwd(), 'assets/geo'),
  ].filter((item): item is string => Boolean(item))
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, GEO_FILES.land))) return dir
  }
  throw new Error(
    `地图底图数据缺失：在 ${candidates.join(' / ')} 都没找到 ${GEO_FILES.land}；`
    + '请确认 backend/assets/geo 已随代码发布，或用 HUOBAO_GEO_DIR 指向数据目录。',
  )
}

/** 缺某一层只跳过该层（底图仍可用），缺整个目录才抛 */
function loadGeoLayer(name: GeoLayerName): unknown | null {
  if (geoCache.has(name)) return geoCache.get(name) ?? null
  const file = path.join(resolveGeoDir(), GEO_FILES[name])
  if (!fs.existsSync(file)) {
    geoCache.set(name, null)
    return null
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  geoCache.set(name, parsed)
  return parsed
}

/** 背景数据和语义目标使用相同投影；只裁背景，不修改用户指定的坐标或路线。 */
function projectContext(spec: MapSpec, size: MapCanvasSize) {
  const projection = mapProjectionFor(spec, size)
  const [west, south, east, north] = spec.bbox
  const sw = projection([west, south])!
  const ne = projection([east, north])!
  projection.clipExtent([[sw[0], ne[1]], [ne[0], sw[1]]])
  const pathGen = geoPath(projection).digits(3)
  const boundaries = loadGeoLayer('admin1') as { features: Parameters<typeof pathGen>[0][] } | null
  const boundaryPaths = (boundaries?.features ?? []).map(feature => pathGen(feature)).filter((d): d is string => Boolean(d))
  const cities = loadGeoLayer('cities') as { features: Array<{ geometry: { type: string; coordinates: [number, number] } }> } | null
  const cityPoints: Array<[number, number]> = []
  for (const feature of cities?.features ?? []) {
    if (feature.geometry.type !== 'Point') continue
    const [lon, lat] = feature.geometry.coordinates
    if (lon < west || lon > east || lat < south || lat > north) continue
    const point = projection([lon, lat])
    if (point) cityPoints.push([point[0], point[1]])
  }
  const warnings: string[] = []
  if (!boundaryPaths.length) warnings.push('Natural Earth 50m 在当前范围未覆盖省界；不能提供该层地理上下文。')
  if (!cityPoints.length) warnings.push('Natural Earth 50m 在当前范围未覆盖城市点；未补造城市细节。')
  const coverage: MapContextCoverage = {
    disclaimer: '省界与城市背景点仅为 Natural Earth 50m 现代定位参照，不表示古代疆界或已审核的历史地点。',
    boundary_features: boundaryPaths.length,
    city_points: cityPoints.length,
    warnings,
  }
  return { boundaryPaths, cityPoints, coverage }
}

// ---------------------------------------------------------------- 配色与 SVG

interface MapTheme { background: string; land: string; landStroke: string; countryStroke: string }

const THEMES: Record<MapSpec['style']['theme'], MapTheme> = {
  // 米黄纸底 + 棕灰陆地：档案风
  archival: { background: '#efe4cc', land: '#cdbfa4', landStroke: '#8a7c62', countryStroke: '#9c8f76' },
  clean: { background: '#ffffff', land: '#e6e6e6', landStroke: '#9a9a9a', countryStroke: '#b4b4b4' },
  ink: { background: '#e8e8e8', land: '#4a4a4a', landStroke: '#2a2a2a', countryStroke: '#6a6a6a' },
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 生成底图 SVG。导出只为测试断言「不含任何 <text 元素」。
 * 注意：这里一个字都不能写——地图文字由叠加图层负责。
 */
export function buildMapSvg(spec: MapSpec, size: MapCanvasSize): string {
  const theme = THEMES[spec.style.theme]
  const projection = mapProjectionFor(spec, size)
  // digits 固定小数位：同 spec 必定生成同一串 path，保证字节级确定性
  const pathGen = geoPath(projection).digits?.(3) ?? geoPath(projection)

  const parts: string[] = []
  parts.push(`<rect x="0" y="0" width="${size.width}" height="${size.height}" fill="${theme.background}"/>`)

  const dotRadius = Math.max(6, size.height / 180)
  const strokeWidth = Math.max(4, size.height / 360)
  const hair = Math.max(1, size.height / 1080)

  const draw = (name: GeoLayerName, attrs: string) => {
    const data = loadGeoLayer(name) as { features?: unknown[] } | null
    if (!data?.features) return
    const d = pathGen({ type: 'FeatureCollection', features: data.features } as never)
    if (d) parts.push(`<path d="${d}" ${attrs}/>`)
  }

  if (spec.layers.land) draw('land', `fill="${theme.land}" stroke="none"`)
  if (spec.layers.lakes) draw('lakes', `fill="${MAP_WATER_COLOR}" stroke="none"`)
  if (spec.layers.rivers) {
    draw('rivers', `fill="none" stroke="${MAP_WATER_COLOR}" stroke-width="${round(hair * 2)}" stroke-linejoin="round" stroke-linecap="round"`)
  }
  if (spec.layers.countries) {
    draw('countries', `fill="none" stroke="${theme.countryStroke}" stroke-width="${round(hair * 1.5)}" stroke-dasharray="${round(hair * 8)} ${round(hair * 6)}"`)
  }
  if (spec.layers.coastline) {
    draw('coastline', `fill="none" stroke="${theme.landStroke}" stroke-width="${round(hair * 2)}" stroke-linejoin="round"`)
  }

  const context = projectContext(spec, size)
  // 低对比、无文字；背景小点不同于蓝色已指定地点，不能混入 points 语义结果。
  parts.push(`<g data-context="admin1" fill="none" stroke="${theme.countryStroke}" stroke-opacity="0.65" stroke-width="${round(hair)}">`)
  for (const d of context.boundaryPaths) parts.push(`<path d="${d}"/>`)
  parts.push('</g>')
  parts.push(`<g data-context="cities" fill="${theme.landStroke}" fill-opacity="0.65">`)
  for (const point of context.cityPoints) {
    parts.push(`<circle cx="${round(point[0])}" cy="${round(point[1])}" r="${round(Math.max(1.5, hair * 2))}"/>`)
  }
  parts.push('</g>')

  // 面在线和点之下：范围是背景语义，绝不能盖住路线与地点。
  // 逐点投影后画 <polygon>，不走 geoPath：d3 的球面多边形语义对环绕方向敏感（见 bboxPolygon 注释），
  // 用户画的环方向不受控，按球面解释会把「一个省」变成「整个地球减去这个省」。
  for (const region of spec.regions) {
    const pts = region.points
      .map(point => projection(point))
      .filter((point): point is [number, number] => Array.isArray(point))
      .map(point => `${round(point[0])},${round(point[1])}`)
    if (pts.length < 3) continue
    parts.push(
      `<polygon points="${pts.join(' ')}" fill="${MAP_REGION_COLOR}" fill-opacity="0.28"`
      + ` stroke="${MAP_REGION_COLOR}" stroke-width="${round(strokeWidth * 0.7)}" stroke-linejoin="round"`
      + ` data-region="${escapeAttr(region.id)}"/>`,
    )
  }

  for (const route of spec.routes) {
    const pts = route.points
      .map(point => projection(point))
      .filter((point): point is [number, number] => Array.isArray(point))
      .map(point => `${round(point[0])},${round(point[1])}`)
    if (pts.length < 2) continue
    parts.push(
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${MAP_ROUTE_COLOR}"`
      + ` stroke-width="${round(strokeWidth)}" stroke-linejoin="round" stroke-linecap="round" data-route="${escapeAttr(route.id)}"/>`,
    )
  }

  for (const place of spec.places) {
    const point = projection([place.lon, place.lat])
    if (!point) continue
    parts.push(
      `<circle cx="${round(point[0])}" cy="${round(point[1])}" r="${round(dotRadius)}"`
      + ` fill="${MAP_ROUTE_COLOR}" stroke="#ffffff" stroke-width="${round(dotRadius / 3)}" data-place="${escapeAttr(place.id)}"/>`,
    )
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"`
    + ` viewBox="0 0 ${size.width} ${size.height}">${parts.join('')}</svg>`
}

// ---------------------------------------------------------------- 渲染

/** 同 spec + 同尺寸 → 同签名（用于复用已渲染文件与断言确定性） */
export function mapBaseSignature(spec: MapSpec, size: MapCanvasSize): string {
  const canvas = normalizeMapCanvas(size)
  // 字段顺序固定，避免对象字面量书写顺序影响签名
  const canonical = JSON.stringify({
    v: spec.version,
    renderer: 2,
    p: spec.projection.type,
    b: spec.bbox,
    l: [spec.layers.land, spec.layers.coastline, spec.layers.rivers, spec.layers.lakes, spec.layers.countries],
    pl: spec.places.map(item => [item.id, item.name, item.lon, item.lat, item.proposed === true]),
    rt: spec.routes.map(item => [item.id, item.name, item.points, item.proposed === true]),
    // 没有面的 spec 不写这个键：Issue #84 之前落盘的底图签名保持逐字节不变，不会被整批作废重渲
    ...(spec.regions.length
      ? { rg: spec.regions.map(item => [item.id, item.name, item.points, item.proposed === true]) }
      : {}),
    s: spec.style.theme,
    w: canvas.width,
    h: canvas.height,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** 渲染底图并落盘。默认 3840×2160（16:9）。**绝不渲染任何文字**（地名/图例/刻度一律没有）。 */
export async function renderMapBase(spec: MapSpec, opts?: Partial<MapCanvasSize>): Promise<MapRenderResult> {
  const size = normalizeMapCanvas(opts)
  const signature = mapBaseSignature(spec, size)
  const dir = path.join(STORAGE_ROOT, 'map-bases')
  const filename = `${signature}.png`
  const absolute = path.join(dir, filename)

  let reused = false
  let buffer: Buffer
  if (fs.existsSync(absolute)) {
    reused = true
    buffer = fs.readFileSync(absolute)
  } else {
    const svg = buildMapSvg(spec, size)
    buffer = await sharp({
      create: {
        width: size.width,
        height: size.height,
        channels: 4,
        background: THEMES[spec.style.theme].background,
      },
    })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(absolute, buffer)
  }

  const projection = mapProjectionFor(spec, size)
  const points: MapProjectedPoint[] = []
  for (const place of spec.places) {
    const at = projection([place.lon, place.lat])
    if (!at) continue
    points.push({ id: place.id, name: place.name, at: [at[0], at[1]] })
  }
  const routes: MapProjectedRoute[] = spec.routes.map(route => ({
    id: route.id,
    name: route.name,
    points: route.points
      .map(point => projection(point))
      .filter((point): point is [number, number] => Array.isArray(point))
      .map(point => [point[0], point[1]] as [number, number]),
    color: MAP_ROUTE_COLOR,
  }))
  const regions: MapProjectedRegion[] = spec.regions.map(region => ({
    id: region.id,
    name: region.name,
    points: region.points
      .map(point => projection(point))
      .filter((point): point is [number, number] => Array.isArray(point))
      .map(point => [point[0], point[1]] as [number, number]),
    color: MAP_REGION_COLOR,
  }))

  return {
    path: `static/map-bases/${filename}`,
    width: size.width,
    height: size.height,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    points,
    routes,
    regions,
    context: projectContext(spec, size).coverage,
    reused,
  }
}
