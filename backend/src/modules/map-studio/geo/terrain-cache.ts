/**
 * 高程瓦片本地缓存（Issue #107 阶段 1）
 *
 * 为什么必须预取：底图的山影、设色、雪线全靠高程。渲染阶段**只读本地缓存**，
 * 缺瓦片时给出可读错误 + 预取命令，绝不在出图路径里静默联网（否则一次 4K 全览会
 * 额外拉几百张瓦片，任务超时且结果不可复现）。
 *
 * 数据：AWS Terrain Tiles（terrarium PNG，公开、无需密钥，源自 SRTM / GMTED2010 / ETOP0I1）。
 * terrarium 编码：h = R*256 + G + B/256 - 32768（米）。瓦片是标准 Web Mercator 256×256。
 *
 * 缓存位置：`DATA_ROOT/map-data/dem/<z>/<x>/<y>.png`，同目录 `manifest.json` 记录每张瓦片的
 * 来源 URL、sha256 与抓取时间——出处与完整性都留在磁盘上，provenance 里记 manifest 指纹。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import type { GeoProjection } from 'd3-geo'
import { DATA_ROOT } from '../../../utils/paths.js'

export const DEM_TILE_SIZE = 256
/** terrarium：高程 = (R*256 + G + B/256) - 32768 米 */
const TERRARIUM_OFFSET = 32768
const RAD = Math.PI / 180
/** mercator 在两极发散：瓦片网格按 Web 地图惯例截到 ±85° */
const MERCATOR_LAT_LIMIT = 85
/** 单帧瓦片上界：超过就降 zoom，而不是失败 */
const MAX_FRAME_TILES = 1600

export const DEM_SOURCE = {
  name: 'AWS Terrain Tiles（terrarium PNG）',
  url_template: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  license: 'Public domain（SRTM / GMTED2010 / ETOPO1）',
  attribution: 'Terrain data: AWS Terrain Tiles, SRTM / GMTED2010 / ETOPO1 (public domain)',
} as const

export class DemCacheError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemCacheError'
  }
}

export type DemTileFetcher = (zoom: number, x: number, y: number) => Promise<Buffer>

export interface DemTile { zoom: number; x: number; y: number; url: string; file: string }

export interface DemManifestEntry { url: string; sha256: string; fetched_at: string; bytes: number }
export interface DemManifest {
  version: 1
  source: { name: string; url_template: string; license: string }
  /** 键为 `<z>/<x>/<y>` */
  tiles: Record<string, DemManifestEntry>
}

export function demTileUrl(zoom: number, x: number, y: number): string {
  return DEM_SOURCE.url_template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y))
}

/** 默认数据目录；测试与外部工具可显式传入别的目录 */
export function demCacheDir(override?: string): string {
  return override ?? path.join(DATA_ROOT, 'map-data', 'dem')
}

function tileFile(cacheDir: string, zoom: number, x: number, y: number): string {
  return path.join(cacheDir, String(zoom), String(x), `${y}.png`)
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

function worldSize(zoom: number): number {
  return DEM_TILE_SIZE * 2 ** zoom
}

function lonToWorldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * worldSize(zoom)
}

function latToWorldY(lat: number, zoom: number): number {
  const clamped = clamp(lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT)
  const mercator = Math.log(Math.tan(Math.PI / 4 + (clamped * RAD) / 2))
  return ((1 - mercator / Math.PI) / 2) * worldSize(zoom)
}

/**
 * 帧所需的瓦片范围。**必须**和 loadDemGrid 用同一个算法：fitExtent 在画幅与 bbox
 * 比例不一致时会留边，画布四角反算出的经纬度会超出 bbox，靠 bbox 估范围会漏瓦片。
 * 例外：正反变换两端都靠 d3 的同一个投影实例，所以两边口径天然一致。
 */
export function frameTileRange(
  projection: GeoProjection,
  width: number,
  height: number,
  zoom: number,
): { x0: number; x1: number; y0: number; y1: number; tiles: DemTile[]; cacheDirHint: string } {
  if (!projection.invert) throw new DemCacheError('高程采样需要可反算的墨卡托/等距圆柱投影，当前投影没有 invert')
  const corners: Array<[number, number]> = [[0, 0], [width, height], [width, 0], [0, height]]
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [x, y] of corners) {
    const geo = projection.invert([x, y])
    if (!geo || !Number.isFinite(geo[0]) || !Number.isFinite(geo[1])) {
      throw new DemCacheError(`高程采样无法反算画布角点 [${x}, ${y}] 的经纬度；请检查投影与 bbox`)
    }
    minLon = Math.min(minLon, geo[0]); maxLon = Math.max(maxLon, geo[0])
    minLat = Math.min(minLat, geo[1]); maxLat = Math.max(maxLat, geo[1])
  }
  const maxTileX = 2 ** zoom - 1
  const maxTileY = 2 ** zoom - 1
  const rawX0 = Math.floor(lonToWorldX(minLon, zoom) / DEM_TILE_SIZE) - 1
  const rawX1 = Math.floor(lonToWorldX(maxLon, zoom) / DEM_TILE_SIZE) + 1
  const rawY0 = Math.floor(latToWorldY(maxLat, zoom) / DEM_TILE_SIZE) - 1
  const rawY1 = Math.floor(latToWorldY(minLat, zoom) / DEM_TILE_SIZE) + 1
  const x0 = clamp(rawX0, 0, maxTileX)
  const x1 = clamp(rawX1, 0, maxTileX)
  const y0 = clamp(rawY0, 0, maxTileY)
  const y1 = clamp(rawY1, 0, maxTileY)
  const tiles: DemTile[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles.push({ zoom, x, y, url: demTileUrl(zoom, x, y), file: tileFile('', zoom, x, y) })
    }
  }
  return {
    x0, x1, y0, y1, tiles,
    cacheDirHint: `${minLon.toFixed(2)},${minLat.toFixed(2)},${maxLon.toFixed(2)},${maxLat.toFixed(2)}`,
  }
}

/**
 * zoom 档位选择：把输出宽度除以 bbox 经度跨度，得到「整幅画布大约需要多少瓦片像素」，
 * 再按用途封顶——全览最多 z7（45° 宽的帧正好落在 7 档），细节最多 z8（细节帧范围小，
 * 再高的档位只会拉入海量瓦片而不增加成图上看得见的起伏）。
 * 大范围只会降档（瓦片数超上界就减一档），**绝不因为范围大而失败**。
 */
export function chooseDemZoom(
  bbox: [number, number, number, number],
  size: { width: number; height: number },
  role: 'overview' | 'detail' = 'overview',
): number {
  const [west, south, east, north] = bbox
  const spanLon = Math.max(east - west, 1e-4)
  const ideal = Math.log2((size.width * 360) / (DEM_TILE_SIZE * spanLon))
  const cap = role === 'detail' ? 8 : 7
  const floor = role === 'detail' ? 5 : 3
  // 向上取整：宁可多取一点高程细节（山脊形状来自 DEM，取低了山会变钝），再用 cap 兜住
  let zoom = Math.ceil(ideal)
  zoom = clamp(zoom, floor, cap)
  const tileCount = (z: number): number => {
    const spanX = lonToWorldX(east, z) - lonToWorldX(west, z)
    const spanY = latToWorldY(south, z) - latToWorldY(north, z)
    return (Math.ceil(Math.abs(spanX) / DEM_TILE_SIZE) + 2) * (Math.ceil(Math.abs(spanY) / DEM_TILE_SIZE) + 2)
  }
  while (zoom > 1 && tileCount(zoom) > MAX_FRAME_TILES) zoom -= 1
  return zoom
}

function readManifest(cacheDir: string): DemManifest {
  const file = path.join(cacheDir, 'manifest.json')
  if (!fs.existsSync(file)) return { version: 1, source: { name: DEM_SOURCE.name, url_template: DEM_SOURCE.url_template, license: DEM_SOURCE.license }, tiles: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DemManifest
    return { version: 1, source: parsed.source ?? { name: DEM_SOURCE.name, url_template: DEM_SOURCE.url_template, license: DEM_SOURCE.license }, tiles: parsed.tiles ?? {} }
  } catch {
    // 坏 manifest 不能让已有瓦片变成不可用：重建索引，缺的时间戳下次预取补齐
    return { version: 1, source: { name: DEM_SOURCE.name, url_template: DEM_SOURCE.url_template, license: DEM_SOURCE.license }, tiles: {} }
  }
}

/** 键排序 + 两空格缩进：同一批瓦片写出的 manifest 逐字节稳定，provenance 指纹才有意义 */
function serializeManifest(manifest: DemManifest): string {
  const keys = Object.keys(manifest.tiles).sort()
  const tiles = keys.map(key => `    ${JSON.stringify(key)}: ${JSON.stringify(manifest.tiles[key])}`)
  return `{\n  "version": 1,\n  "source": ${JSON.stringify(manifest.source)},\n  "tiles": {\n${tiles.join(',\n')}\n  }\n}\n`
}

/** manifest 指纹：provenance 用它证明「这批高程瓦片就是这次出图用的那批」 */
export function demManifestSha256(cacheDir?: string): string | null {
  const file = path.join(demCacheDir(cacheDir), 'manifest.json')
  if (!fs.existsSync(file)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function defaultFetchTile(zoom: number, x: number, y: number): Promise<Buffer> {
  const response = await fetch(demTileUrl(zoom, x, y))
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 一次性预取：只下载缺失瓦片（并发 8、失败重试），并登记 manifest。
 * 已存在的瓦片只做 stat，不重新下载——重复调用是幂等的。
 */
export async function ensureDemTiles(options: {
  projection: GeoProjection
  width: number
  height: number
  zoom: number
  cacheDir?: string
  fetchTile?: DemTileFetcher
  concurrency?: number
  retries?: number
  maxTiles?: number
}): Promise<{ zoom: number; cache_dir: string; tiles: number; downloaded: number; reused: number; manifest_sha256: string | null }> {
  const cacheDir = demCacheDir(options.cacheDir)
  const range = frameTileRange(options.projection, options.width, options.height, options.zoom)
  const limit = options.maxTiles ?? MAX_FRAME_TILES
  if (range.tiles.length > limit) {
    throw new DemCacheError(
      `高程预取范围过大：z${options.zoom} 需要 ${range.tiles.length} 张瓦片（上限 ${limit}）。`
      + `请缩小 bbox 或降低 DEM 档位（当前取景反算范围 ${range.cacheDirHint}）。`,
    )
  }
  const concurrency = Math.max(1, options.concurrency ?? 8)
  const retries = Math.max(0, options.retries ?? 2)
  const fetchTile = options.fetchTile ?? defaultFetchTile
  fs.mkdirSync(cacheDir, { recursive: true })
  const manifest = readManifest(cacheDir)

  const jobs = range.tiles.map(tile => ({ ...tile, file: tileFile(cacheDir, tile.zoom, tile.x, tile.y) }))
  let downloaded = 0, reused = 0, cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const tile = jobs[cursor++]!
      if (fs.existsSync(tile.file)) { reused++; continue }
      let lastError: unknown = null
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const buffer = await fetchTile(tile.zoom, tile.x, tile.y)
          const meta = await sharp(buffer).metadata()
          if (meta.width !== DEM_TILE_SIZE || meta.height !== DEM_TILE_SIZE) {
            throw new Error(`瓦片尺寸 ${meta.width}×${meta.height}，应为 ${DEM_TILE_SIZE}×${DEM_TILE_SIZE}`)
          }
          fs.mkdirSync(path.dirname(tile.file), { recursive: true })
          const tmp = `${tile.file}.part`
          fs.writeFileSync(tmp, buffer)
          fs.renameSync(tmp, tile.file)
          manifest.tiles[`${tile.zoom}/${tile.x}/${tile.y}`] = {
            url: tile.url,
            sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            fetched_at: new Date().toISOString(),
            bytes: buffer.length,
          }
          downloaded++
          lastError = null
          break
        } catch (err) {
          lastError = err
          if (attempt < retries) {
            const delay = Promise.withResolvers<void>()
            setTimeout(delay.resolve, 400 * 2 ** attempt)
            await delay.promise
          }
        }
      }
      if (lastError) {
        throw new DemCacheError(`高程瓦片下载失败 z${tile.zoom}/${tile.x}/${tile.y}：${lastError instanceof Error ? lastError.message : String(lastError)}。`
          + `请检查网络后重跑预取：node --import tsx scripts/prefetch-map-data.ts --bbox ${range.cacheDirHint}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
  fs.writeFileSync(path.join(cacheDir, 'manifest.json'), serializeManifest(manifest))
  return {
    zoom: options.zoom,
    cache_dir: cacheDir,
    tiles: jobs.length,
    downloaded,
    reused,
    manifest_sha256: crypto.createHash('sha256').update(serializeManifest(manifest)).digest('hex'),
  }
}

export interface DemGrid {
  zoom: number
  tiles: number
  width: number
  height: number
  /** 输出网格的高程（米），行优先 */
  data: Float32Array
}

/**
 * 只读缓存，绝不下载。缺瓦片 → 可读错误点名缺的那张 + 预取命令。
 * 双线性重采样到输出网格：`projection.invert` 逐列/逐行算一次（d3 的 mercator /
 * equirectangular 都是 x↔lon、y↔lat 可分离的，逐像素算两次三角函数没有必要）。
 */
export async function loadDemGrid(
  projection: GeoProjection,
  width: number,
  height: number,
  zoom: number,
  options: { cacheDir?: string } = {},
): Promise<DemGrid> {
  const cacheDir = demCacheDir(options.cacheDir)
  const range = frameTileRange(projection, width, height, zoom)
  const tiles = range.tiles.map(tile => ({ ...tile, file: tileFile(cacheDir, tile.zoom, tile.x, tile.y) }))
  const missing = tiles.filter(tile => !fs.existsSync(tile.file))
  if (missing.length) {
    const names = missing.slice(0, 4).map(tile => `${tile.zoom}/${tile.x}/${tile.y}`).join('、')
    throw new DemCacheError(
      `高程瓦片缺失：${names}${missing.length > 4 ? ` 等 ${missing.length} 张` : ''}（缓存目录 ${cacheDir}）。`
      + `请先预取该范围的高程：node --import tsx scripts/prefetch-map-data.ts --bbox ${range.cacheDirHint}`
      + ' （渲染阶段只读本地缓存，不会静默联网下载）。',
    )
  }

  const mosaicWidth = (range.x1 - range.x0 + 1) * DEM_TILE_SIZE
  const mosaicHeight = (range.y1 - range.y0 + 1) * DEM_TILE_SIZE
  const mosaic = new Float32Array(mosaicWidth * mosaicHeight)
  let cursor = 0
  const workers = Array.from({ length: Math.min(8, tiles.length) }, async () => {
    while (cursor < tiles.length) {
      const tile = tiles[cursor++]!
      const { data } = await sharp(tile.file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const baseX = (tile.x - range.x0) * DEM_TILE_SIZE
      const baseY = (tile.y - range.y0) * DEM_TILE_SIZE
      for (let row = 0; row < DEM_TILE_SIZE; row++) {
        const src = row * DEM_TILE_SIZE * 3
        const dst = (baseY + row) * mosaicWidth + baseX
        for (let col = 0; col < DEM_TILE_SIZE; col++) {
          const offset = src + col * 3
          mosaic[dst + col] = data[offset]! * 256 + data[offset + 1]! + data[offset + 2]! / 256 - TERRARIUM_OFFSET
        }
      }
    }
  })
  await Promise.all(workers)

  // 可分离反算：列 → lon → 世界像素 x；行 → lat → 世界像素 y
  const worldX = new Float64Array(width)
  const worldY = new Float64Array(height)
  for (let x = 0; x < width; x++) {
    const geo = projection.invert!([x + 0.5, height / 2])
    worldX[x] = lonToWorldX(geo ? geo[0] : 0, zoom)
  }
  for (let y = 0; y < height; y++) {
    const geo = projection.invert!([width / 2, y + 0.5])
    worldY[y] = latToWorldY(geo ? geo[1] : 0, zoom)
  }

  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const fy = worldY[y]! - range.y0 * DEM_TILE_SIZE - 0.5
    const y0 = clamp(Math.floor(fy), 0, mosaicHeight - 2)
    const ay = clamp(fy - y0, 0, 1)
    const rowA = y0 * mosaicWidth
    const rowB = (y0 + 1) * mosaicWidth
    for (let x = 0; x < width; x++) {
      const fx = worldX[x]! - range.x0 * DEM_TILE_SIZE - 0.5
      const x0 = clamp(Math.floor(fx), 0, mosaicWidth - 2)
      const ax = clamp(fx - x0, 0, 1)
      const a = mosaic[rowA + x0]!
      const b = mosaic[rowA + x0 + 1]!
      const c = mosaic[rowB + x0]!
      const d = mosaic[rowB + x0 + 1]!
      out[y * width + x] = (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay
    }
  }
  return { zoom, tiles: tiles.length, width, height, data: out }
}
