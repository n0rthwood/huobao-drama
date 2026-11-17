/**
 * 程序底图：局部相对起伏晕渲 + 分级水系 + 山形/海波符号（Issue #107 阶段 1）
 *
 * 这条管线替换原来的「Natural Earth 50m 平涂色块 + 省界 + 城市点」底图。三条设计约束：
 *
 * 1. 平原也要看得见起伏：绝对高程在平原上毫无对比（50 m 与 0 m 一样平），所以用
 *    「局部相对起伏」——先减掉 ~30 km 尺度的局部均值，再用 tanh 软限幅压回合理幅度：
 *    `z' = base + tanh(rel / (g · A)) · cap`，A 有下限（周围完全平坦时不被放大成噪声）。
 *    cap 决定夸张幅度：山地起伏被放大，但不会盖住水系与标注。
 * 2. 陆海掩码必须用 Natural Earth 10m 陆地多边形，**不能用高程判 0**：里海北岸低于海平面，
 *    按高程判会把陆地画成海。NE 湖泊里 `featurecla=Reservoir` 的是现代水库（雷宾斯克等），
 *    画进 1480 年的地图就是年代错误，一律剔除。
 * 3. 几何全部走 `mapProjectionFor`（登记件用的同一个 d3 投影实例口径），像素才不会和标注错位。
 *
 * 本模块**绝不渲染任何文字**：地名/图例由叠加图层承担。山形是手绘路径、海波是路径描边，
 * 都不是文字。
 */
import fs from 'fs'
import path from 'path'
import { geoContains, geoPath, type GeoProjection } from 'd3-geo'
import sharp from 'sharp'
import { datasetFileInfo, resolveGeoDir } from './datasets.js'
import { loadNamedRivers } from './named-rivers.js'
import { chooseDemZoom, loadDemGrid } from './terrain-cache.js'
import { mapProjectionFor, type MapCanvasSize, type MapSpec } from './base-render.js'

export type ReliefRole = 'overview' | 'detail'

/** 制图色板：与主题族无关的固定地形色（地形本身不能被「档案风/墨线风」改色） */
export const RELIEF_PALETTE = {
  sea: [203, 217, 225] as [number, number, number],
  /** 低 → 高，四档低饱和高程设色 */
  hypso: [
    [238, 232, 212],
    [218, 203, 168],
    [178, 158, 122],
    [132, 112, 86],
  ] as ReadonlyArray<readonly [number, number, number]>,
  river: [34, 98, 148] as [number, number, number],
  casing: [247, 243, 230] as [number, number, number],
  lake: [160, 196, 218] as [number, number, number],
  coast: [84, 76, 66] as [number, number, number],
  shadeDark: [120, 98, 72] as [number, number, number],
  wave: [96, 132, 158] as [number, number, number],
  snow: [248, 248, 250] as [number, number, number],
  glyphFill: [228, 214, 180] as [number, number, number],
  glyphStroke: [90, 70, 52] as [number, number, number],
} as const

export interface ReliefParams {
  /** 预平滑半径：千米优先（preKm），否则像素 */
  preKm?: number
  pre?: number
  /** A（局部起伏幅度）下限，米：太小时平原噪声会被放大成指纹 */
  floorA: number
  /** 软限幅上限，米：山地形变幅度 */
  cap: number
  /** 纹理明暗混合权重 0..1 */
  tsw: number
  /** tanh 增益：越大起伏越早饱和 */
  gain: number
  /** 明暗上限 */
  kmax: number
  /** 局部均值半径，千米 */
  sigmaKm: number
  /** 河谷强调强度（0 = 关闭） */
  valley: number
  /** 河谷强调沿线宽度，千米 */
  valleyKm: number
  /** 阴影 z 夸张倍数（细节帧更大） */
  shadeZ: number
  /** 雪线：绝对高程起算（m）与满白（m） */
  snowLo: number
  snowHi: number
  /** 雪线：高出局部均值起算（m）与满值（m） */
  snowRelLo: number
  snowRelHi: number
  waves: boolean
  glyphs: boolean
}

/**
 * 用户 2026-11-16 确认的参数（实验 final_overview_v2 / final_D1_v2 / china_snow3）。
 * 细节帧（平原窗口）用「本帧高程分层设色 + 河谷强调」，设色范围按本帧拉伸（不传 anchors）。
 */
export const RELIEF_PARAMS: Record<ReliefRole, ReliefParams> = {
  overview: {
    pre: 2, floorA: 22, cap: 220, tsw: 0.25, gain: 0.5, kmax: 1,
    sigmaKm: 30, valley: 0, valleyKm: 6, shadeZ: 1,
    snowLo: 3000, snowHi: 3800, snowRelLo: 250, snowRelHi: 850, waves: true, glyphs: true,
  },
  detail: {
    preKm: 3.5, floorA: 14, cap: 120, tsw: 0.1, gain: 0.5, kmax: 1,
    sigmaKm: 14, valley: 1.5, valleyKm: 8, shadeZ: 3.5,
    snowLo: 3000, snowHi: 3800, snowRelLo: 250, snowRelHi: 850, waves: true, glyphs: true,
  },
}

/** 河谷强调与细节帧的小河道要用更细的档位；全览只到 8 档 */
const ROLE_RIVER_RANK: Record<ReliefRole, { maxRank: number; lakeRank: number }> = {
  overview: { maxRank: 8, lakeRank: 7 },
  detail: { maxRank: 10, lakeRank: 9 },
}

export interface ReliefRenderOptions {
  role?: ReliefRole
  /** 与全览一致的设色锚点（细节帧继承全览色调族时传）；null = 按本帧拉伸 */
  anchors?: { p2: number; p98: number } | null
  params?: Partial<ReliefParams>
  /** Natural Earth 河名的叙事豁免（整条河永远画出，即使 rank 很高） */
  exemptRivers?: string[]
  /** 预取命名河流包（OSM）里的河名，运行时只读本地包 */
  namedRivers?: string[]
  maxRank?: number
  lakeRank?: number
  /** 线宽倍率；默认按画布短边缩放（细节帧更细） */
  lineScale?: number
  demZoom?: number
  demCacheDir?: string
  /** 像素坐标的 SVG 钩子：under 在海岸线之上、水系之下（画中画的取景框、区域团块）；over 在最上层 */
  underSvg?: string
  overSvg?: string
}

export interface ReliefRenderSummary {
  role: ReliefRole
  params: ReliefParams
  dem_zoom: number
  dem_tiles: number
  anchors: { p2: number; p98: number }
  rivers_visible: number
  rivers_hidden: number
  exempt_drawn: string[]
  named_rivers_used: string[]
  lakes_drawn: number
  reservoirs_dropped: number
  glyphs: number
  waves: number
}

export interface ReliefRenderResult {
  buffer: Buffer
  width: number
  height: number
  /** 矢量叠加层（山形/海波/水系/钩子）；测试断言它不含 <text，画中画可复用 */
  overlaySvg: string
  summary: ReliefRenderSummary
  warnings: string[]
}

const R_EARTH = 6371008.8
const RAD = Math.PI / 180
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** 仿古山形：正置（不随脊线旋转），3 种变体；坐标为字形单位，y 向上 */
const MOUNTAIN_GLYPHS: ReadonlyArray<{ outline: string; hatches: ReadonlyArray<readonly [number, number, number, number]> }> = [
  {
    outline: 'M-1,0 L-0.55,-0.55 L-0.3,-0.38 L0.05,-1 L0.38,-0.48 L0.6,-0.66 L1,0',
    hatches: [[0.05, -1, 0.5, 0], [0.1, -0.9, 0.25, 0], [0.2, -0.72, 0.75, 0], [0.38, -0.48, 0.95, 0], [0.6, -0.66, 0.98, 0]],
  },
  {
    outline: 'M-1,0 L-0.4,-0.8 L-0.1,-0.5 L0.3,-0.95 L1,0',
    hatches: [[0.3, -0.95, 0.4, 0], [0.3, -0.95, 0.62, 0], [0.3, -0.95, 0.85, 0], [-0.4, -0.8, -0.1, 0], [-0.4, -0.8, 0.1, 0]],
  },
  {
    outline: 'M-0.9,0 L-0.25,-0.7 L0.1,-0.45 L0.45,-0.85 L1,0',
    hatches: [[0.45, -0.85, 0.55, 0], [0.45, -0.85, 0.78, 0], [0.1, -0.45, 0.3, 0], [-0.25, -0.7, 0, 0]],
  },
]

interface GeoFeature { type: string; properties: Record<string, unknown> | null; geometry: { type: string; coordinates: unknown } | null }

/** 每份底图数据只解析一次；datasetFileInfo 会按表里的 SHA-256 校验文件没有被替换 */
const featuresCache = new Map<string, GeoFeature[]>()
function loadGeoFeatures(fileId: string): GeoFeature[] {
  const cached = featuresCache.get(fileId)
  if (cached) return cached
  const info = datasetFileInfo(fileId)
  const file = path.join(resolveGeoDir(), info.filename)
  if (!fs.existsSync(file)) throw new Error(`地图底图数据缺失：${info.filename}；请随版本发布 backend/assets/geo。`)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { features?: GeoFeature[] }
  if (!Array.isArray(parsed.features)) throw new Error(`地图底图数据 ${info.filename} 缺少 features 数组；请恢复原始文件。`)
  featuresCache.set(fileId, parsed.features)
  return parsed.features
}

function property(properties: Record<string, unknown> | null, key: string): unknown {
  if (!properties) return null
  const found = Object.keys(properties).find(candidate => candidate.toLowerCase() === key)
  return found ? properties[found] : null
}

function rankOf(feature: GeoFeature, fallback: number): number {
  const raw = property(feature.properties, 'scalerank')
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

interface HydroLayer {
  paths: { t1: string[]; t2: string[]; t3: string[]; ex: string[] }
  lakes: string[]
  stats: { visible: number; hidden: number; exemptDrawn: string[]; lakesDrawn: number; reservoirsDropped: number }
}

/**
 * 水系：**整条河按名分组**显隐（组内取最小 scalerank）。
 * NE 把一条河拆成 River + Lake Centerline 多个要素，逐段按 rank 过滤会把一条河剪成碎片，
 * 于是「一条河画了一半」。分组后整条河要么全画、要么全不画；叙事豁免的河永远画出。
 */
function buildHydro(
  pathGen: (feature: unknown) => string | null,
  options: { maxRank: number; lakeRank: number; exempt: ReadonlySet<string>; rivers: boolean; lakes: boolean },
): HydroLayer {
  const groups = new Map<string, { minRank: number; features: GeoFeature[]; name: string }>()
  const rivers = loadGeoFeatures('10m_rivers_lake_centerlines')
  for (const feature of rivers) {
    if (!feature.geometry) continue
    const rawName = property(feature.properties, 'name')
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : rawName && rawName !== '' ? String(rawName) : `~${String(property(feature.properties, 'ne_id') ?? 'unnamed')}`
    const group = groups.get(name) ?? { minRank: 99, features: [], name }
    group.minRank = Math.min(group.minRank, rankOf(feature, 99))
    group.features.push(feature)
    groups.set(name, group)
  }

  const paths: HydroLayer['paths'] = { t1: [], t2: [], t3: [], ex: [] }
  let visible = 0, hidden = 0
  const exemptDrawn: string[] = []
  if (options.rivers) {
    for (const group of groups.values()) {
      const exempted = options.exempt.has(group.name.toLowerCase())
      if (!exempted && group.minRank > options.maxRank) { hidden++; continue }
      // <=3 主干、4–6 次干、>=7 支流；豁免河即使 rank 很高也用次干宽度（故事河必须看得见）
      const cls = group.minRank <= 3 ? 't1' : group.minRank <= 6 ? 't2' : 't3'
      const bucket = exempted && group.minRank > options.maxRank ? 'ex' : cls
      let drawn = false
      for (const feature of group.features) {
        // 湖中线只在河道穿过湖面时用来续上河道；高 rank 的湖中线又细又碎，跳过
        if (property(feature.properties, 'featurecla') === 'Lake Centerline' && rankOf(feature, 99) > 6) continue
        const d = pathGen(feature)
        if (!d) continue
        paths[bucket].push(d)
        drawn = true
      }
      if (drawn) {
        visible++
        if (exempted) exemptDrawn.push(group.name)
      }
    }
  }

  const lakePaths: string[] = []
  let reservoirsDropped = 0
  if (options.lakes) {
    for (const feature of loadGeoFeatures('10m_lakes')) {
      if (!feature.geometry) continue
      const d = pathGen(feature)
      if (property(feature.properties, 'featurecla') === 'Reservoir') {
        // 只统计落在画框里的现代水库：整份文件有 230 个，报全局数量会误导
        if (d) reservoirsDropped++
        continue
      }
      if (!d) continue
      if (rankOf(feature, 9) > options.lakeRank) continue
      lakePaths.push(d)
    }
  }
  return {
    paths,
    lakes: lakePaths,
    stats: { visible, hidden, exemptDrawn, lakesDrawn: lakePaths.length, reservoirsDropped },
  }
}

/** SVG 兜底掩码：d3 路径 → 0..1 覆盖度栅格（sharp 的 librsvg 在这里只做填充，不做文字） */
async function maskFromSvg(body: string, width: number, height: number): Promise<Float32Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#000"/>${body}</svg>`
  const { data } = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  const mask = new Float32Array(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = (data[i] ?? 0) / 255
  return mask
}

/** 3×3 中值：去掉 terrarium 瓦片边缘的单像素条带，同时保住湖面/平原的成片平坦 */
function median3(source: Float32Array, width: number, height: number): Float32Array {
  const out = Float32Array.from(source)
  const window = new Float32Array(9)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let k = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) window[k++] = source[(y + dy) * width + x + dx]!
      }
      window.sort()
      out[y * width + x] = window[4]!
    }
  }
  return out
}

/** 可分离箱式模糊，3 遍近似高斯；边界按就近取样（与实验脚本一致，保证同一参数同一张图） */
function boxBlur(input: Float32Array, width: number, height: number, radius: number, passes = 3): Float32Array {
  if (radius < 1) return Float32Array.from(input)
  let source = Float32Array.from(input)
  let target = new Float32Array(input.length)
  const span = 2 * radius + 1
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width
      let sum = 0
      for (let x = -radius; x <= radius; x++) sum += source[row + clamp(x, 0, width - 1)]!
      for (let x = 0; x < width; x++) {
        target[row + x] = sum / span
        sum += source[row + clamp(x + radius + 1, 0, width - 1)]! - source[row + clamp(x - radius, 0, width - 1)]!
      }
    }
    [source, target] = [target, source]
    for (let x = 0; x < width; x++) {
      let sum = 0
      for (let y = -radius; y <= radius; y++) sum += source[clamp(y, 0, height - 1) * width + x]!
      for (let y = 0; y < height; y++) {
        target[y * width + x] = sum / span
        sum += source[clamp(y + radius + 1, 0, height - 1) * width + x]! - source[clamp(y - radius, 0, height - 1) * width + x]!
      }
    }
    [source, target] = [target, source]
  }
  return source
}

function hypsoTint(t: number): [number, number, number] {
  const stops = RELIEF_PALETTE.hypso
  const scaled = clamp(t, 0, 1) * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(scaled))
  const frac = scaled - index
  const low = stops[index]!, high = stops[index + 1]!
  return [lerp(low[0], high[0], frac), lerp(low[1], high[1], frac), lerp(low[2], high[2], frac)]
}

export async function renderReliefBase(
  spec: MapSpec,
  size: MapCanvasSize,
  options: ReliefRenderOptions = {},
): Promise<ReliefRenderResult> {
  const width = size.width, height = size.height, pixels = width * height
  const role: ReliefRole = options.role
    ?? (spec.detail_level === 'regional' || spec.detail_level === 'site' ? 'detail' : 'overview')
  const params: ReliefParams = { ...RELIEF_PARAMS[role], ...(options.params ?? {}) }
  const ranks = ROLE_RIVER_RANK[role]
  const maxRank = options.maxRank ?? ranks.maxRank
  const lakeRank = options.lakeRank ?? ranks.lakeRank
  const lineScale = options.lineScale ?? Math.min(width, height) / 2160
  const warnings: string[] = ['地形为夸张表现：山影与起伏按局部相对高程放大，不能当作精确高程读图。']

  // 与登记件同一个投影口径；渲染/标注/登记三者像素一致
  const projection = mapProjectionFor(spec, size)
  const frame = projection.clipExtent?.([[0, 0], [width, height]]) ?? projection
  const pathGen = geoPath(frame).digits(3) as (feature: unknown) => string | null

  // 1) 陆海掩码（NE 10m 陆地多边形；不能用高程判 0）
  const landFeatures = loadGeoFeatures('10m_land')
  const landMask = await maskFromSvg(
    `<path d="${pathGen({ type: 'FeatureCollection', features: landFeatures }) ?? ''}" fill="#fff"/>`,
    width, height,
  )

  // 2) 高程（只读本地缓存；缺瓦片 → 可读错误 + 预取命令）
  const demZoom = options.demZoom ?? chooseDemZoom(spec.bbox, size, role)
  const dem = await loadDemGrid(projection, width, height, demZoom, { cacheDir: options.demCacheDir })

  // 3) 水系（分组显隐 + 湖泊）
  const exempt = new Set((options.exemptRivers ?? []).map(name => name.toLowerCase()))
  const hydro = buildHydro(pathGen, { maxRank, lakeRank, exempt, rivers: spec.layers.rivers, lakes: spec.layers.lakes })

  const lakeFeatures = loadGeoFeatures('10m_lakes').filter(feature => feature.geometry
    && property(feature.properties, 'featurecla') !== 'Reservoir'
    && rankOf(feature, 9) <= lakeRank)
  const lakeMask = spec.layers.lakes
    ? await maskFromSvg(`<path d="${pathGen({ type: 'FeatureCollection', features: lakeFeatures }) ?? ''}" fill="#fff"/>`, width, height)
    : new Float32Array(pixels)

  // 4) 地形：海拔 → 中值 → 局部起伏
  const elevation = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) elevation[i] = landMask[i]! > 0.5 ? Math.max(dem.data[i]!, -5) : 0
  const smoothed = median3(elevation, width, height)
  const metersPerPixel = new Float64Array(height)
  for (let y = 0; y < height; y++) {
    const geo = projection.invert!([width / 2, y + 0.5])
    const lat = geo ? geo[1] : 0
    const a = projection([0, lat])
    const b = projection([1, lat])
    const pxPerDegree = a && b ? Math.abs(b[0] - a[0]) : 1
    metersPerPixel[y] = (R_EARTH * Math.cos(lat * RAD) * RAD) / Math.max(pxPerDegree, 1e-9)
  }
  const midRow = Math.floor(height / 2)
  const sigmaPx = Math.max(2, Math.round((params.sigmaKm * 1000) / metersPerPixel[midRow]!))
  const prePx = params.preKm
    ? Math.max(1, Math.round((params.preKm * 1000) / metersPerPixel[midRow]!))
    : Math.max(1, params.pre ?? 2)

  const preBlur = boxBlur(smoothed, width, height, prePx, 3)
  const localBase = boxBlur(preBlur, width, height, sigmaPx, 3)

  let valleyMask: Float32Array | null = null
  if (params.valley > 0) {
    // 河谷强调：用全档河道（rank<=10）画一条粗线再模糊，越靠近河道起伏放大越多
    const valley = buildHydro(pathGen, { maxRank: 10, lakeRank: 9, exempt, rivers: true, lakes: false })
    const allRivers = [...valley.paths.t1, ...valley.paths.t2, ...valley.paths.t3, ...valley.paths.ex]
    if (allRivers.length) {
      const valleyPx = Math.max(2, Math.round((params.valleyKm * 1000) / metersPerPixel[midRow]!))
      const stroke = `<path d="${allRivers.join(' ')}" fill="none" stroke="#fff" stroke-width="${valleyPx}" stroke-linejoin="round" stroke-linecap="round"/>`
      valleyMask = boxBlur(await maskFromSvg(stroke, width, height), width, height, Math.max(2, Math.round(valleyPx / 3)), 3)
    }
  }

  const relative = new Float32Array(pixels)
  const magnitude = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const rel = (preBlur[i]! - localBase[i]!) * (valleyMask ? 1 + params.valley * valleyMask[i]! : 1)
    relative[i] = rel
    magnitude[i] = Math.abs(rel)
  }
  const amplitude = boxBlur(magnitude, width, height, sigmaPx, 3)
  const shaped = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) {
    const a = Math.max(amplitude[i]!, params.floorA)
    shaped[i] = localBase[i]! + Math.tanh(relative[i]! / (params.gain * a)) * params.cap
  }

  // 5) 山丘晕渲
  const shade = new Float32Array(pixels)
  const sinAltitude = Math.sin(42 * RAD)
  const azimuth = 315 * RAD
  for (let y = 1; y < height - 1; y++) {
    const metre = metersPerPixel[y]! * 2 / params.shadeZ
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const dzdx = (shaped[i + 1]! - shaped[i - 1]!) / metre
      const dzdy = (shaped[i + width]! - shaped[i - width]!) / metre
      const slope = Math.atan(Math.hypot(dzdx, dzdy))
      const aspect = Math.atan2(-dzdx, dzdy)
      shade[i] = Math.sin(42 * RAD) * Math.cos(slope) + Math.cos(42 * RAD) * Math.sin(slope) * Math.cos(azimuth - aspect)
    }
  }

  // 6) 纹理明暗近似：多尺度 DoG，按局部幅度归一（山体的「质感」来自这里）
  const fine = boxBlur(shaped, width, height, Math.max(2, Math.round(sigmaPx / 10)), 3)
  const coarse = boxBlur(shaped, width, height, Math.max(6, Math.round(sigmaPx / 3)), 3)
  const difference = new Float32Array(pixels)
  const differenceMagnitude = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) {
    difference[i] = fine[i]! - coarse[i]!
    differenceMagnitude[i] = Math.abs(difference[i]!)
  }
  const textureAmplitude = boxBlur(differenceMagnitude, width, height, sigmaPx, 3)
  const texture = new Float32Array(pixels)
  for (let i = 0; i < pixels; i++) texture[i] = Math.tanh(difference[i]! / (0.8 * Math.max(textureAmplitude[i]!, 1)))

  // 7) 设色锚点：全览给出色标族（细节帧继承），细节帧默认按本帧拉伸
  const samples: number[] = []
  for (let i = 0; i < pixels; i += 7) if (landMask[i]! > 0.5) samples.push(smoothed[i]!)
  samples.sort((a, b) => a - b)
  const p2 = options.anchors?.p2 ?? (samples.length ? samples[Math.floor(samples.length * 0.02)]! : 0)
  const p98 = options.anchors?.p98 ?? (samples.length ? samples[Math.floor(samples.length * 0.98)]! : 1)
  const stretchFloor = Math.max(p2, 0)

  const rgb = Buffer.alloc(pixels * 3)
  const sea = RELIEF_PALETTE.sea, snow = RELIEF_PALETTE.snow, shadeDark = RELIEF_PALETTE.shadeDark, lake = RELIEF_PALETTE.lake
  for (let i = 0; i < pixels; i++) {
    const offset = i * 3
    if (landMask[i]! < 0.5) {
      rgb[offset] = sea[0]; rgb[offset + 1] = sea[1]; rgb[offset + 2] = sea[2]
      continue
    }
    const tint = clamp((smoothed[i]! - stretchFloor) / (p98 - stretchFloor + 1), 0, 1) ** 0.75
    let color = hypsoTint(tint)
    // 雪线双条件：绝对高程够高，**且**高出周围 ~30 km 均值够多。只按绝对高度会把青藏高原面整片刷白。
    const snowByHeight = clamp((smoothed[i]! - params.snowLo) / (params.snowHi - params.snowLo), 0, 1)
    const snowByRelief = clamp((smoothed[i]! - localBase[i]! - params.snowRelLo) / (params.snowRelHi - params.snowRelLo), 0, 1)
    const snowAmount = snowByHeight * snowByRelief * 0.93
    if (snowAmount > 0) color = [lerp(color[0], snow[0], snowAmount), lerp(color[1], snow[1], snowAmount), lerp(color[2], snow[2], snowAmount)]
    const light = (1 - params.tsw) * (shade[i]! / sinAltitude) + params.tsw * (0.5 + 0.5 * texture[i]!)
    const k = clamp(0.42 + 0.74 * light, 0.42, params.kmax)
    for (let channel = 0; channel < 3; channel++) {
      rgb[offset + channel] = clamp(Math.round(color[channel]! * k + shadeDark[channel]! * (1 - k) * 0.35), 0, 255)
    }
    if (lakeMask[i]! > 0.5) { rgb[offset] = lake[0]; rgb[offset + 1] = lake[1]; rgb[offset + 2] = lake[2] }
  }

  // 8) 矢量叠加：海波 → 海岸线 → 山形 → under 钩子 → 湖岸 → 水系 → 命名河流 → over 钩子
  const parts: string[] = []
  let waveCount = 0
  if (params.waves) {
    const spacing = Math.round(150 * lineScale)
    const size_ = 44 * lineScale
    const offshore = Math.round(60 * lineScale)
    const isOffshoreSea = (x: number, y: number): boolean => {
      for (const [dx, dy] of [[0, 0], [offshore, 0], [-offshore, 0], [0, offshore], [0, -offshore], [offshore, offshore], [-offshore, -offshore], [offshore, -offshore], [-offshore, offshore]]) {
        const px = Math.round(x + dx), py = Math.round(y + dy)
        if (px < 0 || py < 0 || px >= width || py >= height || landMask[py * width + px]! > 0.3) return false
      }
      return true
    }
    // 固定种子的线性同余抖动：同一 spec 两次渲染的海波位置逐像素相同
    let seed = 11
    const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
    const strokes: string[] = []
    for (let y = spacing / 2, row = 0; y < height; y += spacing * 0.62, row++) {
      for (let x = (row % 2) * spacing / 2 + spacing / 3; x < width; x += spacing) {
        const px = x + (random() - 0.5) * spacing * 0.3
        const py = y + (random() - 0.5) * spacing * 0.2
        if (!isOffshoreSea(px, py)) continue
        const s = size_ * (0.8 + random() * 0.5)
        strokes.push(`<path d="M${(px - s).toFixed(1)},${py.toFixed(1)} q${(s * 0.5).toFixed(1)},${(-s * 0.45).toFixed(1)} ${s.toFixed(1)},0 t${s.toFixed(1)},0"`
          + ` fill="none" stroke="rgb(${RELIEF_PALETTE.wave.join(',')})" stroke-opacity=".62" stroke-width="${(2.6 * lineScale).toFixed(2)}" stroke-linecap="round"/>`)
        waveCount++
      }
    }
    if (strokes.length) parts.push(`<g data-waves="1">${strokes.join('')}</g>`)
  }

  if (spec.layers.coastline) {
    parts.push(`<path d="${pathGen({ type: 'FeatureCollection', features: landFeatures }) ?? ''}" fill="none"`
      + ` stroke="rgb(${RELIEF_PALETTE.coast.join(',')})" stroke-width="${(1.6 * lineScale).toFixed(2)}" stroke-linejoin="round"/>`)
  }

  let glyphCount = 0
  if (params.glyphs) {
    const glyphs = mountainGlyphs(projection, width, height, shaped, localBase, lineScale)
    glyphCount = glyphs.count
    if (glyphs.svg) parts.push(`<g data-mountains="1">${glyphs.svg}</g>`)
  }
  if (options.underSvg) parts.push(options.underSvg)

  if (hydro.lakes.length) {
    parts.push(`<path d="${hydro.lakes.join(' ')}" fill="none" stroke="rgb(${RELIEF_PALETTE.river.join(',')})" stroke-width="${(1.4 * lineScale).toFixed(2)}"/>`)
  }
  const widths: Record<'t1' | 't2' | 't3' | 'ex', number> = { t1: 7 * lineScale, t2: 4.2 * lineScale, t3: 2.4 * lineScale, ex: 4.2 * lineScale }
  for (const cls of ['t3', 't2', 'ex', 't1'] as const) {
    const paths = hydro.paths[cls]
    if (!paths.length) continue
    const joined = paths.join(' ')
    parts.push(`<path d="${joined}" fill="none" stroke="rgb(${RELIEF_PALETTE.casing.join(',')})" stroke-opacity=".85"`
      + ` stroke-width="${(widths[cls] + 3 * lineScale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    parts.push(`<path d="${joined}" fill="none" stroke="rgb(${RELIEF_PALETTE.river.join(',')})"`
      + ` stroke-width="${widths[cls].toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
  }

  const namedRiversUsed: string[] = []
  if (options.namedRivers?.length) {
    const { rivers, missing } = loadNamedRivers(options.namedRivers)
    if (missing.length) {
      warnings.push(`命名河流引用「${missing.join('、')}」不在预取包里：这些河不会被画出。`
        + '请在 backend 运行 node --import tsx scripts/prefetch-river-region.ts（运行期不联网）。')
    }
    for (const river of rivers) {
      const lines = river.lines
        .map(line => line.map(point => projection(point)).filter((point): point is [number, number] => Array.isArray(point)))
        .filter(line => line.length >= 2)
      if (!lines.length) continue
      const d = lines.map(line => `M${line.map(point => `${point[0].toFixed(1)},${point[1].toFixed(1)}`).join('L')}`).join(' ')
      parts.push(`<path d="${d}" fill="none" stroke="rgb(${RELIEF_PALETTE.casing.join(',')})" stroke-opacity=".85"`
        + ` stroke-width="${(widths.t2 + 3 * lineScale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
      parts.push(`<path d="${d}" fill="none" stroke="rgb(${RELIEF_PALETTE.river.join(',')})"`
        + ` stroke-width="${widths.t2.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
      namedRiversUsed.push(river.name)
    }
  }
  if (options.overSvg) parts.push(options.overSvg)

  const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  const buffer = await sharp(rgb, { raw: { width, height, channels: 3 } }).composite([{ input: Buffer.from(overlaySvg) }]).png().toBuffer()

  return {
    buffer,
    width,
    height,
    overlaySvg,
    summary: {
      role,
      params,
      dem_zoom: dem.zoom,
      dem_tiles: dem.tiles,
      anchors: { p2, p98 },
      rivers_visible: hydro.stats.visible,
      rivers_hidden: hydro.stats.hidden,
      exempt_drawn: hydro.stats.exemptDrawn,
      named_rivers_used: namedRiversUsed,
      lakes_drawn: hydro.stats.lakesDrawn,
      reservoirs_dropped: hydro.stats.reservoirsDropped,
      glyphs: glyphCount,
      waves: waveCount,
    },
    warnings,
  }
}

/**
 * 山形符号：只在 NE 50m 地理区域多边形里 featurecla = Range/mtn 的山脉内落点，
 * 抖动网格 + geoContains 判定（≈ Poisson 拒绝采样），大小随**局部相对高程**调制：
 * 高原面本身起伏小，只有山脊顶才画大字。
 */
function mountainGlyphs(
  projection: GeoProjection,
  width: number,
  height: number,
  shaped: Float32Array,
  localBase: Float32Array,
  lineScale: number,
): { svg: string; count: number } {
  const ranges = loadGeoFeatures('50m_geography_regions_polys').filter(feature => feature.geometry
    && /range|mtn/i.test(String(property(feature.properties, 'featurecla') ?? '')))
  if (!ranges.length) return { svg: '', count: 0 }
  // 画框的经纬度范围：多边形只在这个范围内找候选点，省掉画外的 geoContains
  const corners = [[0, 0], [width, 0], [0, height], [width, height]]
    .map(([x, y]) => projection.invert!([x!, y!]))
    .filter((geo): geo is [number, number] => Array.isArray(geo) && Number.isFinite(geo[0]) && Number.isFinite(geo[1]))
  if (!corners.length) return { svg: '', count: 0 }
  const frameWest = Math.min(...corners.map(corner => corner[0]))
  const frameEast = Math.max(...corners.map(corner => corner[0]))
  const frameSouth = Math.min(...corners.map(corner => corner[1]))
  const frameNorth = Math.max(...corners.map(corner => corner[1]))
  const pitch = 0.12
  let seed = 7
  const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const placed: Array<{ x: number; y: number; size: number }> = []
  // 字号口径照实验脚本：4K 下基准 81.6 px、最大 158.8 px（= 44/92 × 1.4 + 20/30）
  const baseSize = (44 * 1.4 + 20) * lineScale
  const maxSize = (92 * 1.4 + 30) * lineScale
  for (const range of ranges) {
    const coords = JSON.stringify(range.geometry!.coordinates).match(/-?\d+\.?\d*/g)?.map(Number) ?? []
    if (!coords.length) continue
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (let i = 0; i + 1 < coords.length; i += 2) {
      west = Math.min(west, coords[i]!); east = Math.max(east, coords[i]!)
      south = Math.min(south, coords[i + 1]!); north = Math.max(north, coords[i + 1]!)
    }
    const searchWest = Math.max(west, frameWest), searchEast = Math.min(east, frameEast)
    const searchSouth = Math.max(south, frameSouth), searchNorth = Math.min(north, frameNorth)
    if (searchWest > searchEast || searchSouth > searchNorth) continue
    const candidates: Array<{ x: number; y: number; relief: number }> = []
    for (let lat = searchSouth; lat <= searchNorth; lat += pitch) {
      const lonStep = pitch / Math.max(0.1, Math.cos(lat * RAD))
      for (let lon = searchWest; lon <= searchEast; lon += lonStep) {
        const lonJitter = lon + (random() - 0.5) * lonStep
        const latJitter = lat + (random() - 0.5) * pitch
        if (!geoContains(range as never, [lonJitter, latJitter])) continue
        const px = projection([lonJitter, latJitter])
        if (!px || px[0] < 40 || px[1] < 40 || px[0] > width - 40 || px[1] > height - 40) continue
        const index = Math.round(px[1]) * width + Math.round(px[0])
        if (index < 0 || index >= shaped.length) continue
        const relief = clamp((shaped[index]! - localBase[index]!) / 900, 0, 1)
        candidates.push({ x: px[0], y: px[1], relief })
      }
    }
    // 起伏大的优先落点；南北向按 y 排队，后画的盖住前面的（近处山挡远处山）
    candidates.sort((a, b) => b.relief - a.relief)
    for (const candidate of candidates) {
      if (placed.length >= 300) break
      const size = baseSize + (maxSize - baseSize) * candidate.relief
      if (placed.some(other => Math.hypot(other.x - candidate.x, (other.y - candidate.y) * 1.6) < (other.size + size) * 0.5 * 1.15)) continue
      placed.push({ x: candidate.x, y: candidate.y, size })
    }
  }
  placed.sort((a, b) => a.y - b.y)
  const svg: string[] = []
  for (const point of placed) {
    const glyph = MOUNTAIN_GLYPHS[Math.floor(random() * MOUNTAIN_GLYPHS.length)]!
    const scale = point.size / 2
    const glyphSvg = `<g transform="translate(${point.x.toFixed(1)},${point.y.toFixed(1)}) scale(${scale.toFixed(1)},${(scale * 0.85).toFixed(1)})" opacity=".92">`
      + `<path d="${glyph.outline} Z" fill="rgb(${RELIEF_PALETTE.glyphFill.join(',')})" fill-opacity=".8"`
      + ` stroke="rgb(${RELIEF_PALETTE.glyphStroke.join(',')})" stroke-width="${(1.7 / scale).toFixed(3)}" stroke-linejoin="round"/>`
      + glyph.hatches.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"`
        + ` stroke="rgb(${RELIEF_PALETTE.glyphStroke.join(',')})" stroke-width="${(1.1 / scale).toFixed(3)}" stroke-opacity=".7"/>`).join('')
      + '</g>'
    svg.push(glyphSvg)
  }
  return { svg: svg.join(''), count: placed.length }
}
