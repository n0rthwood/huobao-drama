/**
 * 地图底图数据预取（Issue #107 阶段 1/2 运维脚本）
 *
 * 用法：
 *   node --import tsx scripts/prefetch-map-data.ts --bbox 19.4,42,85.6,63.8
 *   node --import tsx scripts/prefetch-map-data.ts --bbox 19.4,42,85.6,63.8 --size 3840x2160 --role both
 *   node --import tsx scripts/prefetch-map-data.ts --bbox 19.4,42,85.6,63.8 --rivers Ugra=乌格拉河,Akhtuba=阿赫图巴河
 *
 * 干什么：
 *   - 高程：按 bbox/画幅选出 overview 与 detail 两个 zoom 档，把该帧需要的 AWS Terrain 瓦片
 *     下载进数据目录 `map-data/dem/<z>/<x>/<y>.png`（只下缺失的），并登记 manifest（URL/sha256/时间）。
 *   - 河流：把 Natural Earth 缺失的小河按名字从 OSM Overpass 抓下来，**写进仓库包**
 *     `backend/assets/geo/osm-rivers/`（带来源、抓取时间、sha256、ODbL 署名）。
 *
 * 运行期（地图任务）不会联网：高程只读本地缓存，河流只读仓库包。缺数据时渲染器会直接报错
 * 并点名缺哪张瓦片 + 这条预取命令。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { normalizeMapSpec, canvasForAspect, mapProjectionFor, type MapSpec } from '../src/modules/map-studio/geo/base-render.js'
import { chooseDemZoom, ensureDemTiles, demCacheDir } from '../src/modules/map-studio/geo/terrain-cache.js'
import { namedRiverPackPath, readNamedRiverManifest, type NamedRiverPack } from '../src/modules/map-studio/geo/named-rivers.js'
import { resolveGeoDir } from '../src/modules/map-studio/geo/datasets.js'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
/** 主站被限流时退到镜像；两个都失败才报错 */
const OVERPASS_MIRRORS = [OVERPASS_URL, 'https://overpass.kumi.systems/api/interpreter']
/** Overpass 没有自定义 User-Agent 会直接 406；这不是可选项 */
const USER_AGENT = 'huobao-drama-map-studio/1.0 (offline map data prefetch; +https://github.com/n0rthwood/huobao-drama)'

interface Args {
  bbox: [number, number, number, number] | null
  width: number
  height: number
  roles: Array<'overview' | 'detail'>
  /** names = 规范名 + 别名（当地语言名必须一起给：OSM 的 name 是当地语言，英文名常常查不到整条河） */
  rivers: Array<{ name: string; nameZh: string | null; names: string[] }>
}

function usage(message: string): never {
  console.error(`${message}\n\n用法：node --import tsx scripts/prefetch-map-data.ts --bbox w,s,e,n [--size 3840x2160 | --aspect 9:16]`
    + ' [--role overview|detail|both] [--rivers "Name=中文名|当地语言别名,Name2"]\n'
    + '例：--rivers "Akhtuba=阿赫图巴河|Ахтуба,Kazanka=卡赞卡河|Казанка"')
  process.exit(2)
}

function parseArgs(argv: string[]): Args {
  const args: Args = { bbox: null, width: 3840, height: 2160, roles: ['overview', 'detail'], rivers: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--bbox') {
      if (!value) usage('--bbox 缺少取值')
      const parts = value.split(',').map(Number)
      if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) usage(`--bbox 必须是 w,s,e,n 四个数字，收到 ${value}`)
      args.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
      i++
    } else if (flag === '--size') {
      if (!value) usage('--size 缺少取值')
      const match = /^(\d+)x(\d+)$/.exec(value)
      if (!match) usage(`--size 必须是 WxH（例如 3840x2160），收到 ${value}`)
      args.width = Number(match[1]); args.height = Number(match[2])
      i++
    } else if (flag === '--role') {
      if (value === 'both') args.roles = ['overview', 'detail']
      else if (value === 'overview' || value === 'detail') args.roles = [value]
      else usage(`--role 只能是 overview / detail / both，收到 ${String(value)}`)
      i++
    } else if (flag === '--rivers') {
      if (!value) usage('--rivers 缺少取值')
      for (const item of value.split(',')) {
        const [name, detail] = item.split('=').map(part => part.trim())
        if (!name) usage(`--rivers 里有空河名：${value}`)
        const parts = (detail ?? '').split('|').map(part => part.trim())
        const nameZh = parts[0] && parts[0].length ? parts[0] : null
        const aliases = parts.slice(1).filter(alias => alias.length)
        args.rivers.push({ name, nameZh, names: [name, ...aliases] })
      }
      i++
    } else if (flag === '--aspect') {
      if (!value) usage('--aspect 缺少取值')
      const canvas = canvasForAspect(value as '16:9' | '9:16' | '4:3' | '3:4' | '1:1', Math.max(args.width, args.height))
      args.width = canvas.width; args.height = canvas.height
      i++
    } else {
      usage(`未知参数 ${flag}`)
    }
  }
  if (!args.bbox) usage('必须提供 --bbox w,s,e,n')
  return args
}

async function prefetchDem(args: Args, spec: MapSpec): Promise<void> {
  const size = { width: args.width, height: args.height }
  const projection = mapProjectionFor(spec, size)
  const cacheDir = demCacheDir()
  for (const role of args.roles) {
    const zoom = chooseDemZoom(spec.bbox, size, role)
    const started = Date.now()
    const result = await ensureDemTiles({ projection, width: size.width, height: size.height, zoom })
    console.log(`[dem/${role}] z${zoom} ${size.width}x${size.height}：${result.tiles} 张瓦片（新下载 ${result.downloaded}，已缓存 ${result.reused}）`
      + ` ${((Date.now() - started) / 1000).toFixed(1)}s → ${cacheDir}，manifest ${result.manifest_sha256 ?? '-'}`)
  }
}

function overpassQuery(names: readonly string[], bbox: [number, number, number, number]): string {
  const [west, south, east, north] = bbox
  // 名可能是俄文/中文（OSM 的 name 是当地语言）：规范名与别名都要查 name / name:en / name:ru / name:zh，
  // 否则「Ахтуба」这种河用英文名只会抓到一个孤零零的路段
  const tags = ['name', 'name:en', 'name:ru', 'name:zh']
  const clauses = names.flatMap(name => {
    const escaped = name.replace(/["\\]/g, '\\$&')
    return tags.map(tag => `way["waterway"="river"]["${tag}"~"^${escaped}$",i](${south},${west},${north},${east});`)
  })
  return `[out:json][timeout:120];(\n${clauses.join('\n')}\n);out geom;`
}

interface OverpassElement {
  type: string
  id: number
  geometry?: Array<{ lat: number; lon: number }>
  tags?: Record<string, string>
}

async function fetchOverpass(query: string): Promise<OverpassElement[]> {
  let lastError: unknown = null
  for (const endpoint of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        const payload = await response.json() as { elements?: OverpassElement[]; remark?: string }
        // Overpass 超时/限流也是 HTTP 200，用 remark 说明原因：绝不能把它当成「这条河不存在」
        if (payload.remark) throw new Error(`Overpass remark：${payload.remark}`)
        return payload.elements ?? []
      } catch (err) {
        lastError = err
        const delay = Promise.withResolvers<void>()
        setTimeout(delay.resolve, 3000 * (attempt + 1))
        await delay.promise
      }
    }
  }
  throw new Error(`Overpass 查询失败（已尝试主站与镜像）：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function slug(name: string): string {
  return name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'river'
}

async function prefetchRivers(args: Args): Promise<void> {
  if (!args.rivers.length) return
  const packDir = namedRiverPackPath()
  fs.mkdirSync(packDir, { recursive: true })
  const manifest: NamedRiverPack = readNamedRiverManifest()
    ?? { version: 1, license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors, ODbL 1.0', rivers: [] }
  const missing: string[] = []
  for (const { name, nameZh, names } of args.rivers) {
    const query = overpassQuery(names, args.bbox!)
    const elements = (await fetchOverpass(query)).filter(element => element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
    if (!elements.length) {
      missing.push(name)
      continue
    }
    const lines = elements.map(element => element.geometry!.map(point => [point.lon, point.lat] as [number, number]))
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (const line of lines) for (const [lon, lat] of line) {
      west = Math.min(west, lon); east = Math.max(east, lon)
      south = Math.min(south, lat); north = Math.max(north, lat)
    }
    const zhFromData = elements.map(element => element.tags?.['name:zh']).find(value => value && value.trim())
    const payload = {
      name,
      name_zh: nameZh ?? zhFromData ?? name,
      source_url: OVERPASS_URL,
      query,
      fetched_at: new Date().toISOString(),
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors, ODbL 1.0',
      ways: lines.length,
      bbox: [west, south, east, north],
      lines,
    }
    const file = `${slug(name)}.json`
    const body = `${JSON.stringify(payload, null, 2)}\n`
    const sha256 = crypto.createHash('sha256').update(body).digest('hex')
    fs.writeFileSync(path.join(packDir, file), body)
    const entry = {
      name, name_zh: payload.name_zh, file, ways: lines.length,
      fetched_at: payload.fetched_at, source_url: OVERPASS_URL, sha256,
      bbox: [west, south, east, north] as [number, number, number, number],
    }
    const existing = manifest.rivers.findIndex(item => item.name.toLowerCase() === name.toLowerCase())
    if (existing >= 0) manifest.rivers[existing] = entry
    else manifest.rivers.push(entry)
    console.log(`[river/${name}] ${lines.length} 条 way，${payload.name_zh} → ${path.join(packDir, file)}（sha256 ${sha256.slice(0, 12)}）`)
  }
  manifest.rivers.sort((a, b) => a.name.localeCompare(b.name))
  fs.writeFileSync(path.join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (missing.length) {
    // 静默跳过会让「故事河」在上线后凭空缺席：必须让运维当场决定是换名字还是扩大 bbox
    throw new Error(`Overpass 在 ${args.bbox!.join(',')} 内没找到以下河名：${missing.join('、')}。`
      + '请确认河名（可用当地语言/俄文/中文名），或扩大 --bbox 后重跑。')
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const spec = normalizeMapSpec({ bbox: args.bbox })
  console.log(`预取范围 ${spec.bbox.join(',')}，画幅 ${args.width}x${args.height}，地理数据目录 ${resolveGeoDir()}`)
  await prefetchDem(args, spec)
  await prefetchRivers(args)
  console.log('完成。渲染阶段只读本地缓存与仓库包；若仍报缺瓦片，按错误里的文件名补跑这条命令。')
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
