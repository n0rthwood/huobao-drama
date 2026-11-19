/**
 * 地图确定性底图渲染（Issue #56 / R3；Issue #107 阶段 1 换管线）
 *
 * 为什么不用扩散模型画地图：资产实验室实测（~/projects/huobao-asset-lab/report.md）
 * 扩散模型会重绘海岸线与河道、把地名锚点挪到几百公里外，地图几何不可用。
 * 所以地图走「确定性底图」：Natural Earth 矢量 + AWS Terrain 高程 + d3-geo 投影 →
 * 局部相对起伏晕渲 + 分级水系，风格化只允许在这张底图之上做低去噪/结构受控的二次处理。
 *
 * 具体渲染口径全部在 geo/relief-render.ts；本文件只管 spec 校验、投影、签名、落盘与复用。
 *
 * 本模块**绝不渲染任何文字**（地名、图例、刻度全都没有）：地图上的文字一律由叠加图层系统
 * （backend/src/services/layer-render.ts）在确定性图层里排版，这样文字永远可编辑、永远不糊。
 * renderMapBase 只回传每个地点/路线投影后的像素坐标，供图层编辑器放标注。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { geoEquirectangular, geoMercator, type GeoProjection } from 'd3-geo'
import { z } from 'zod'
import { STORAGE_ROOT } from '../../../utils/paths.js'
import { generateImageThumb } from '../../../utils/storage.js'
import { datasetFileInfo, riverScaleForRef, type DatasetScale } from './datasets.js'
import { MAP_STYLE_FAMILY_IDS, mapStyleFamily } from '../styles/index.js'
import { renderReliefBase, type ReliefParams, type ReliefRenderSummary, type ReliefRole } from './relief-render.js'
import { chooseDemZoom, demManifestSha256, ensureDemTiles, type DemTileFetcher } from './terrain-cache.js'

export const MAP_BASE_WIDTH = 3840
export const MAP_BASE_HEIGHT = 2160
/** 路线/河流在底图上的渲染色：必须是有彩色（后续图层/风格化会按颜色提取线条） */
export const MAP_ROUTE_COLOR = '#1f6fd0'
/**
 * 区域（势力范围/行政区/战役范围）在底图上的填充色（Issue #84）。
 * 与路线色分开：风格化/抽色时面与线必须可区分，二者混色会让下游把边界当路线。
 */
export const MAP_REGION_COLOR = '#b4573c'

export class MapSpecValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MapSpecValidationError'
  }
}

/** Local metadata contract: types.ts imports MapSpec, so never import it back here. */
export interface MapFeatureMetadata {
  category?: 'river' | 'lake' | 'coast' | 'mountain' | 'settlement' | 'route' | 'territory' | 'other'
  origin?: 'dataset' | 'source' | 'model' | 'manual'
  verification?: { status: 'verified' | 'unverified' | 'conflict' | 'needs_user' | 'confirmed'; reasons: string[] }
  dataset_ref?: { ref: string; clip_bbox?: [number, number, number, number] }
  relations?: unknown[]
}
export interface MapPlace extends MapFeatureMetadata { id: string; name: string; lon: number; lat: number; proposed?: boolean }
export interface MapRoute extends MapFeatureMetadata { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
/** 面要素：外环（首尾点由 normalizeMapSpec 自动闭合），经纬度与 routes 同口径 */
export interface MapRegion extends MapFeatureMetadata { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
export interface MapSpec {
  version: 1
  /** Absent legacy specs keep 50m; regional/site use 10m rivers. */
  detail_level?: 'overview' | 'regional' | 'site'
  projection: { type: 'mercator' | 'equirectangular' }
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  layers: { land: boolean; coastline: boolean; rivers: boolean; lakes: boolean; countries: boolean }
  places: MapPlace[]
  routes: MapRoute[]
  /** Issue #84：面几何。老 map_spec 没有这个字段，规范化后为 []，渲染签名与改动前逐字节一致。 */
  regions: MapRegion[]
  style: { theme: 'archival' | 'clean' | 'ink'; map_style?: string }
}

export interface MapCanvasSize { width: number; height: number }

export interface MapRiverSourceInfo {
  scale: DatasetScale
  reason: 'dataset_ref' | 'detail_level' | 'overview'
  file_id: string
  filename: string
  sha256: string
}
/** Dataset adoption overrides overview so highlighted river and background cannot diverge. */
export function riverSourceScale(spec: Pick<MapSpec, 'detail_level' | 'routes'>): DatasetScale {
  const refs = spec.routes.flatMap(route => route.dataset_ref ? [{ route, scale: riverScaleForRef(route.dataset_ref.ref) }] : [])
  const scale = refs.some(item => item.scale === '10m') || spec.detail_level === 'regional' || spec.detail_level === 'site' ? '10m' : '50m'
  const mismatched = refs.filter(item => item.scale !== null && item.scale !== scale)
  if (mismatched.length) throw new MapSpecValidationError(
    `底图河道来源不一致：当前选择 ${scale}，但 ${mismatched.map(({ route }) => `「${route.name || route.id}」(${route.dataset_ref!.ref})`).join('、')} 来自 50m。`
    + '请改用同名 10m 数据集引用；若没有任何 10m 引用且确需 50m，请将 detail_level 改为 overview。不能静默换源或混画两套河道。',
  )
  return scale
}
export function resolveRiverSource(spec: Pick<MapSpec, 'detail_level' | 'routes'>): MapRiverSourceInfo {
  const scale = riverSourceScale(spec)
  const file = datasetFileInfo(`${scale}_rivers_lake_centerlines`)
  const fromDataset = spec.routes.some(route => route.dataset_ref && riverScaleForRef(route.dataset_ref.ref) === '10m')
  return { scale, reason: fromDataset ? 'dataset_ref' : scale === '10m' ? 'detail_level' : 'overview', file_id: file.fileId, filename: file.filename, sha256: file.sha256 }
}

export interface MapProjectedPoint { id: string; name: string; at: [number, number] }
export interface MapProjectedRoute { id: string; name: string; points: Array<[number, number]>; color: string }
export interface MapProjectedRegion { id: string; name: string; points: Array<[number, number]>; color: string }
export interface MapRenderResult {
  /** `static/map-bases/<signature>.png`（STORAGE_ROOT 下的相对路径，getAbsolutePath 口径） */
  path: string
  width: number
  height: number
  sha256: string
  river_source: MapRiverSourceInfo
  points: MapProjectedPoint[]
  routes: MapProjectedRoute[]
  regions: MapProjectedRegion[]
  /** 高程档位、瓦片数与水系/符号统计；provenance 直接引用，写清「这张图用了哪批高程」 */
  relief: ReliefRenderSummary
  dem: { zoom: number; manifest_sha256: string | null }
  warnings: string[]
  /** 该签名的文件此前已存在（本次未重新栅格化） */
  reused: boolean
}

// ---------------------------------------------------------------- 校验

export const MAX_PLACES = 200
export const MAX_ROUTES = 50
export const MAX_ROUTE_POINTS = 5000
export const MAX_REGIONS = 30
export const MAX_REGION_POINTS = 2000
/** mercator 在两极发散，纬度按 Web 地图惯例截到 ±85 */
const MERCATOR_LAT_LIMIT = 85

const finiteNumber = z.number().finite()

const lonLatTuple = z.tuple([finiteNumber, finiteNumber])

const metadataSchema = z.object({
  category: z.enum(['river', 'lake', 'coast', 'mountain', 'settlement', 'route', 'territory', 'other']).optional(),
  origin: z.enum(['dataset', 'source', 'model', 'manual']).optional(),
  verification: z.object({ status: z.enum(['verified', 'unverified', 'conflict', 'needs_user', 'confirmed']), reasons: z.array(z.string()) }).optional(),
  dataset_ref: z.object({ ref: z.string().min(1), clip_bbox: z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]).optional() }).optional(),
  relations: z.array(z.object({}).passthrough()).optional(),
})

/** Shared by all three feature kinds so normalization never strips research evidence. */
function featureMetadata(item: MapFeatureMetadata): MapFeatureMetadata {
  return {
    ...(item.category !== undefined ? { category: item.category } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
    ...(item.verification !== undefined ? { verification: { status: item.verification.status, reasons: [...item.verification.reasons] } } : {}),
    ...(item.dataset_ref !== undefined ? { dataset_ref: { ref: item.dataset_ref.ref, ...(item.dataset_ref.clip_bbox ? { clip_bbox: [...item.dataset_ref.clip_bbox] as [number, number, number, number] } : {}) } } : {}),
    ...(item.relations !== undefined ? { relations: structuredClone(item.relations) } : {}),
  }
}

const specSchema = z.object({
  version: z.literal(1).optional(),
  detail_level: z.enum(['overview', 'regional', 'site']).optional(),
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
    ...metadataSchema.shape,
  })).optional(),
  routes: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    points: z.array(lonLatTuple),
    proposed: z.boolean().optional(),
    ...metadataSchema.shape,
  })).optional(),
  regions: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    points: z.array(lonLatTuple),
    proposed: z.boolean().optional(),
    ...metadataSchema.shape,
  })).optional(),
  style: z.object({ theme: z.enum(['archival', 'clean', 'ink']).optional(), map_style: z.enum(MAP_STYLE_FAMILY_IDS).optional() }).optional(),
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
    ...(data.detail_level ? { detail_level: data.detail_level } : {}),
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
      ...featureMetadata(item),
    })),
    routes: routes.map(item => ({
      id: item.id,
      name: item.name,
      points: item.points.map(([lon, lat]) => [lon, lat] as [number, number]),
      ...(item.proposed ? { proposed: true as const } : {}),
      ...featureMetadata(item),
    })),
    // 外环按 GeoJSON 惯例闭合：首尾同点，重复点不计入上限校验
    regions: regions.map(item => ({
      id: item.id,
      name: item.name,
      points: closeRing(item.points.map(([lon, lat]) => [lon, lat] as [number, number])),
      ...(item.proposed ? { proposed: true as const } : {}),
      ...featureMetadata(item),
    })),
    style: data.style?.map_style
      ? { theme: mapStyleFamily(data.style.map_style).theme_mapping, map_style: data.style.map_style }
      : { theme: data.style?.theme ?? 'archival' },
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

export type MapAspect = '16:9' | '9:16' | '4:3' | '3:4' | '1:1'
const MAP_ASPECT_RATIOS: Record<MapAspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3, '3:4': 3 / 4, '1:1': 1 }
const MIN_CANVAS_WIDTH = 1280
const MIN_CANVAS_HEIGHT = 720
const MAX_CANVAS_SIDE = 7680

/**
 * 画布归一化。只给 width 时按 16:9 推高度；width 与 height 都给且比例落在
 * 0.4..2.5（9:16 0.5625、3:4 0.75、1:1、4:3 1.33 都合法）就保留该比例；
 * 越界说明尺寸写错了，退回 16:9 而不是画出一张 40:1 的怪画布。
 * 导出：地图登记件要按同一口径复算画布。
 */
export function normalizeMapCanvas(size: Partial<MapCanvasSize> | undefined): MapCanvasSize {
  const rawWidth = Math.trunc(size?.width ?? MAP_BASE_WIDTH)
  const width = Math.max(MIN_CANVAS_WIDTH, Math.min(MAX_CANVAS_SIDE, Number.isFinite(rawWidth) ? rawWidth : MAP_BASE_WIDTH))
  const rawHeight = size?.height
  if (rawHeight !== undefined && Number.isFinite(rawHeight)) {
    const height = Math.max(MIN_CANVAS_HEIGHT, Math.min(MAX_CANVAS_SIDE, Math.trunc(rawHeight)))
    const aspect = width / height
    if (aspect >= 0.4 && aspect <= 2.5) return { width, height }
  }
  // 宽为准推 16:9；偶数宽保证高度整数化后比例误差 < 1px
  return { width, height: Math.max(MIN_CANVAS_HEIGHT, Math.round(width * 9 / 16)) }
}

/** 项目画幅 → 画布尺寸（长边 = longSide）；竖版横幅都用这一个入口，别各自估算比例 */
export function canvasForAspect(aspect: MapAspect, longSide: number = MAP_BASE_WIDTH): MapCanvasSize {
  const ratio = MAP_ASPECT_RATIOS[aspect]
  if (ratio === undefined) {
    throw new MapSpecValidationError(`未知画幅「${String(aspect)}」；可用：16:9 / 9:16 / 4:3 / 3:4 / 1:1`)
  }
  const long = Math.max(MIN_CANVAS_WIDTH, Math.min(MAX_CANVAS_SIDE, Math.trunc(Number.isFinite(longSide) ? longSide : MAP_BASE_WIDTH)))
  const toEven = (value: number): number => Math.max(MIN_CANVAS_HEIGHT, Math.round(value / 2) * 2)
  return ratio >= 1
    ? { width: toEven(long), height: toEven(long / ratio) }
    : { width: toEven(long * ratio), height: toEven(long) }
}

/**
 * bbox 矩形环。**必须顺时针**（[w,s]→[w,n]→[e,n]→[e,s]）：d3-geo 按球面语义解释多边形，
 * 逆时针小环表示「整个地球减去这个矩形」，fitExtent 会去拟合全球，豫北 bbox 实测会塌成
 * 1280×720 画布上 5px 宽的一小团（见 tests/map-studio-base-render.test.mjs 的跨度断言）。
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
 * 导出给 geo/geometry：登记件（registration）里只存 projection + bbox + 画布尺寸，
 * 复原投影必须走这个唯一实现，绝不允许第二份 fitExtent 写法。
 */
export function mapProjectionFor(spec: Pick<MapSpec, 'projection' | 'bbox'>, size: MapCanvasSize): GeoProjection {
  const projection = spec.projection.type === 'mercator' ? geoMercator() : geoEquirectangular()
  // fitExtent 自身保持纵横比并居中：画幅与 bbox 比例不一致时允许上下/左右留边
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

// ---------------------------------------------------------------- 渲染

/** 透传给 relief-render 的渲染口径（尺寸走 normalizeMapCanvas，不在这里重复） */
export interface MapRenderOptions {
  riverSource?: MapRiverSourceInfo
  /** 'detail' 用细节帧参数（本帧拉伸设色 + 河谷强调）；默认按 spec.detail_level 判断 */
  role?: ReliefRole
  /** 继承全览设色锚点（细节帧保持同一色调族）；null = 按本帧拉伸 */
  anchors?: { p2: number; p98: number } | null
  /** NE 河名的叙事豁免：分镜/设计卡提到的河永远画出，不按 scalerank 隐掉 */
  exemptRivers?: string[]
  /** 预取命名河流包（OSM）里的河名；运行时只读本地包，不联网 */
  namedRivers?: string[]
  params?: Partial<ReliefParams>
  maxRank?: number
  lakeRank?: number
  lineScale?: number
  /** 像素坐标的 SVG 钩子：画中画的取景框/角标交给调用方拼进来 */
  underSvg?: string
  overSvg?: string
  /** 高程缓存目录与瓦片下载器（预取复用/测试注入）；生产默认 DATA_ROOT/map-data/dem */
  dem?: { cacheDir?: string; fetchTile?: DemTileFetcher }
}

/** 与 PNG 同名的 sidecar：缓存命中时不重新渲染也能还原 provenance（高程档位、水系统计） */
interface MapBaseSidecar {
  relief: ReliefRenderSummary
  warnings: string[]
  dem_manifest_sha256: string | null
}

/**
 * 会改变像素的渲染口径（不含高程缓存/下载器与尺寸）。
 * 它必须进签名：叙事豁免河、预取命名河流、设色锚点、画中画钩子都会改图，
 * 不进签名就会把「不带乌格拉河」的那张图当成「带乌格拉河」的复用回来。
 */
export interface ReliefSignature {
  role?: ReliefRole
  anchors?: { p2: number; p98: number } | null
  exemptRivers?: string[]
  namedRivers?: string[]
  maxRank?: number
  lakeRank?: number
  lineScale?: number
  params?: Partial<ReliefParams>
  underSvg?: string
  overSvg?: string
}

/** 键/河名排序后再序列化：同一套豁免写法无论顺序都得到同一个签名 */
function canonicalReliefOptions(relief: ReliefSignature): string {
  const names = (values?: string[]): string[] | null => values ? [...values].map(name => name.toLowerCase()).sort() : null
  return JSON.stringify({
    role: relief.role ?? null,
    anchors: relief.anchors ? [relief.anchors.p2, relief.anchors.p98] : null,
    exempt: names(relief.exemptRivers),
    named: names(relief.namedRivers),
    maxRank: relief.maxRank ?? null,
    lakeRank: relief.lakeRank ?? null,
    lineScale: relief.lineScale ?? null,
    params: relief.params ? Object.keys(relief.params).sort().map(key => [key, String(relief.params![key as keyof ReliefParams])]) : null,
    under: relief.underSvg ?? null,
    over: relief.overSvg ?? null,
  })
}

/** 同 spec + 同尺寸 + 同渲染口径 → 同签名（用于复用已渲染文件与断言确定性） */
export function mapBaseSignature(
  spec: MapSpec,
  size: MapCanvasSize,
  riverSource: DatasetScale = riverSourceScale(spec),
  relief?: ReliefSignature,
): string {
  const canvas = normalizeMapCanvas(size)
  // 字段顺序固定，避免对象字面量书写顺序影响签名
  const canonical = JSON.stringify({
    v: spec.version,
    // 3 = 高程晕渲 + 分级水系管线（Issue #107 阶段 1）：2 号渲染器落盘的平涂底图一律不复用
    renderer: 3,
    // Keep all legacy/overview signatures byte-identical; only 10m adds a source key.
    ...(riverSource === '10m' ? { rv: '10m' } : {}),
    ...(relief ? { ru: canonicalReliefOptions(relief) } : {}),
    p: spec.projection.type,
    b: spec.bbox,
    l: [spec.layers.land, spec.layers.coastline, spec.layers.rivers, spec.layers.lakes, spec.layers.countries],
    pl: spec.places.map(item => [item.id, item.name, item.lon, item.lat, item.proposed === true]),
    rt: spec.routes.map(item => [item.id, item.name, item.points, item.proposed === true]),
    // 没有面的 spec 不写这个键：Issue #84 之前落盘的底图签名保持逐字节不变，不会被整批作废重渲
    ...(spec.regions.length
      ? { rg: spec.regions.map(item => [item.id, item.name, item.points, item.proposed === true]) }
      : {}),
    // 主题/样式不参与底图像素（Issue #126 主题简化）：底图色板固定，历史 theme/family 记录不产生伪失效。
    w: canvas.width,
    h: canvas.height,
  })
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/**
 * 渲染底图并落盘。默认 3840×2160（16:9），竖版/方图由 canvasForAspect 给出宽高后传入。
 * 渲染前先确保该帧的高程瓦片在本地（只下载缺的那几张）；渲染阶段只读缓存。
 * **绝不渲染任何文字**（地名/图例/刻度一律没有）。
 */
export async function renderMapBase(
  spec: MapSpec,
  opts?: Partial<MapCanvasSize> & MapRenderOptions,
): Promise<MapRenderResult> {
  const size = normalizeMapCanvas(opts)
  const riverSource = opts?.riverSource ?? resolveRiverSource(spec)
  const role: ReliefRole = opts?.role ?? (spec.detail_level === 'regional' || spec.detail_level === 'site' ? 'detail' : 'overview')
  const reliefSignature: ReliefSignature = {
    role,
    anchors: opts?.anchors ?? null,
    ...(opts?.exemptRivers ? { exemptRivers: opts.exemptRivers } : {}),
    ...(opts?.namedRivers ? { namedRivers: opts.namedRivers } : {}),
    ...(opts?.maxRank !== undefined ? { maxRank: opts.maxRank } : {}),
    ...(opts?.lakeRank !== undefined ? { lakeRank: opts.lakeRank } : {}),
    ...(opts?.lineScale !== undefined ? { lineScale: opts.lineScale } : {}),
    ...(opts?.params ? { params: opts.params } : {}),
    ...(opts?.underSvg ? { underSvg: opts.underSvg } : {}),
    ...(opts?.overSvg ? { overSvg: opts.overSvg } : {}),
  }
  const signature = mapBaseSignature(spec, size, riverSource.scale, reliefSignature)
  const dir = path.join(STORAGE_ROOT, 'map-bases')
  const filename = `${signature}.png`
  const absolute = path.join(dir, filename)
  const sidecarFile = path.join(dir, `${signature}.json`)
  const projection = mapProjectionFor(spec, size)

  let cached: { buffer: Buffer; sidecar: MapBaseSidecar } | null = null
  if (fs.existsSync(absolute) && fs.existsSync(sidecarFile)) {
    try {
      cached = { buffer: fs.readFileSync(absolute), sidecar: JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as MapBaseSidecar }
    } catch {
      // sidecar 读坏了当缓存未命中重渲：宁可多花一次渲染，也不复用出处不明的图
      cached = null
    }
  }

  let buffer: Buffer
  let sidecar: MapBaseSidecar
  let reused = false
  if (cached) {
    buffer = cached.buffer
    sidecar = cached.sidecar
    reused = true
  } else {
    const zoom = chooseDemZoom(spec.bbox, size, role)
    // 预取（只下载缺失瓦片）必须先于渲染：渲染器本身只读缓存，缺瓦片会直接报错
    const prefetch = await ensureDemTiles({
      projection, width: size.width, height: size.height, zoom,
      cacheDir: opts?.dem?.cacheDir, fetchTile: opts?.dem?.fetchTile,
    })
    const relief = await renderReliefBase(spec, size, {
      role,
      anchors: opts?.anchors ?? null,
      params: opts?.params,
      demZoom: zoom,
      demCacheDir: opts?.dem?.cacheDir,
      exemptRivers: opts?.exemptRivers,
      namedRivers: opts?.namedRivers,
      maxRank: opts?.maxRank,
      lakeRank: opts?.lakeRank,
      lineScale: opts?.lineScale,
      underSvg: opts?.underSvg,
      overSvg: opts?.overSvg,
    })
    buffer = relief.buffer
    sidecar = {
      relief: relief.summary,
      warnings: relief.warnings,
      dem_manifest_sha256: prefetch.manifest_sha256 ?? demManifestSha256(opts?.dem?.cacheDir),
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(absolute, buffer)
    fs.writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2))
    // 底图选择/结果画廊用缩略图（Issue #106）；失败只记日志，不影响渲染
    await generateImageThumb(`static/map-bases/${filename}`)
  }

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
    river_source: riverSource,
    points,
    routes,
    regions,
    relief: sidecar.relief,
    dem: { zoom: sidecar.relief.dem_zoom, manifest_sha256: sidecar.dem_manifest_sha256 },
    warnings: sidecar.warnings,
    reused,
  }
}
