import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { DATA_ROOT } from '../src/utils/paths.js'
import { assembleRegionRivers, type RegionRiver, type RiverWay } from '../src/modules/map-studio/geo/river-region.js'
import { resolveGeoDir } from '../src/modules/map-studio/geo/datasets.js'

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
const USER_AGENT = 'huobao-drama-map-studio/1.0 (offline map data prefetch; +https://github.com/n0rthwood/huobao-drama)'
// 0.0001° is about 11 m at the equator, substantially below a pixel even for a
// 4K detail spanning one degree. Preserve original endpoints to keep connectivity.
const TOLERANCE = 0.0001
const FULL_REGION = [20, 40, 100, 70] as const
const sample = process.argv[2] === '--sample'
const completedOnly = sample && process.argv.includes('--report-completed')
const parsed = sample ? process.argv[3]?.split(',').map(Number) : [...FULL_REGION]
if (!parsed || parsed.length !== 4 || parsed.some(n => !Number.isInteger(n)) ||
  parsed[0]! < 20 || parsed[1]! < 40 || parsed[2]! > 100 || parsed[3]! > 70 ||
  parsed[0]! >= parsed[2]! || parsed[1]! >= parsed[3]!) {
  throw new Error('用法：--sample west,south,east,north；范围须为区域内整数度方块')
}
const REGION = parsed as [number, number, number, number]
const STEP = 1
const sha = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex')
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
const dataDir = path.join(DATA_ROOT, 'map-data', sample ? `osm-rivers-sample-${REGION.join('-')}` : 'osm-rivers')
const progressDir = path.join(dataDir, 'chunks')

async function fetchChunk(w: number, s: number): Promise<RiverWay[]> {
  const query = `[out:json][timeout:120];way["waterway"="river"]["name"](${s},${w},${s + STEP},${w + STEP});out geom;`
  let error: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(ENDPOINTS[attempt % ENDPOINTS.length]!, {
        method: 'POST', headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(150_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      const body = await response.json() as { elements?: RiverWay[]; remark?: string }
      if (body.remark) throw new Error(`Overpass remark: ${body.remark}`)
      if (!Array.isArray(body.elements)) throw new Error('Overpass response missing elements')
      return body.elements
    } catch (err) {
      error = err
      if (attempt < 3) {
        console.error(`块 ${w},${s} 第 ${attempt + 1} 次失败：${err instanceof Error ? err.message : String(err)}；退避 ${30 * 2 ** attempt} 秒`)
        await sleep(30_000 * 2 ** attempt)
      }
    }
  }
  throw new Error(`Overpass chunk ${w},${s} failed: ${error instanceof Error ? error.message : String(error)}`)
}

async function main(): Promise<void> {
  fs.mkdirSync(progressDir, { recursive: true })
  const progressPath = path.join(dataDir, 'manifest.progress.json')
  const progress: { region: number[]; chunks: Record<string, { sha256: string; fetched_at: string; ways: number }>; failed?: { chunk: string; at: string; error: string } } =
    fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf8')) : { region: REGION, chunks: {} }
  const ways = new Map<number, RiverWay>()
  for (let s = REGION[1]; s < REGION[3]; s += STEP) for (let w = REGION[0]; w < REGION[2]; w += STEP) {
    const file = path.join(progressDir, `${w}-${s}.json`)
    if (completedOnly && !fs.existsSync(file)) continue
    let elements: RiverWay[]
    if (fs.existsSync(file)) {
      const contents = fs.readFileSync(file)
      const entry = progress.chunks[`${w},${s}`]
      if (entry && entry.sha256 !== sha(contents)) throw new Error(`块 ${w},${s} 的进度校验失败；请人工检查 ${file}`)
      elements = JSON.parse(contents.toString('utf8')) as RiverWay[]
      if (!entry) {
        progress.chunks[`${w},${s}`] = { sha256: sha(contents), fetched_at: new Date(fs.statSync(file).mtimeMs).toISOString(), ways: elements.length }
        fs.writeFileSync(`${progressPath}.tmp`, JSON.stringify(progress, null, 2)); fs.renameSync(`${progressPath}.tmp`, progressPath)
      }
    }
    else {
      try { elements = await fetchChunk(w, s) } catch (err) {
        progress.failed = { chunk: `${w},${s}`, at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }
        fs.writeFileSync(`${progressPath}.tmp`, JSON.stringify(progress, null, 2)); fs.renameSync(`${progressPath}.tmp`, progressPath)
        throw err
      }
      delete progress.failed
      const temp = `${file}.tmp`, contents = JSON.stringify(elements)
      fs.writeFileSync(temp, contents); fs.renameSync(temp, file)
      progress.chunks[`${w},${s}`] = { sha256: sha(contents), fetched_at: new Date().toISOString(), ways: elements.length }
      fs.writeFileSync(`${progressPath}.tmp`, JSON.stringify(progress, null, 2)); fs.renameSync(`${progressPath}.tmp`, progressPath)
      console.log(`[${w},${s}] ${elements.length} ways`)
      await sleep(5000)
    }
    for (const element of elements) ways.set(element.id, element)
  }
  const rivers = assembleRegionRivers([...ways.values()], TOLERANCE)
  // Previously published refs remain resolvable even if OSM later changes the way set.
  const oldFile = [path.join(dataDir, 'rivers.json'), ...(!sample ? [path.join(resolveGeoDir(), 'osm-rivers', 'rivers.json')] : [])].find(file => fs.existsSync(file))
  if (oldFile) {
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf8')) as { rivers: RegionRiver[] }
    const current = new Set(rivers.map(river => river.id))
    for (const river of old.rivers) if (!current.has(river.id)) rivers.push({ ...river, retired: true })
  }
  const body = Buffer.from(JSON.stringify({ rivers }))
  const output = path.join(dataDir, 'rivers.json')
  fs.writeFileSync(`${output}.tmp`, body); fs.renameSync(`${output}.tmp`, output)
  const manifest = {
    version: 2, source_url: ENDPOINTS[0], fetched_at: new Date().toISOString(), region: REGION,
    ...(sample ? { sample: true, completed_chunks: Object.keys(progress.chunks).sort() } : {}),
    license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors, ODbL 1.0',
    simplification_tolerance_degrees: TOLERANCE, file: 'rivers.json', sha256: sha(body),
    simplification_assessment: { sample_chunks: ['60,56', '61,56'], projection: 'd3 Mercator fitExtent', bbox: [55, 51, 68, 61], canvas: [3840, 2160], max_error_px: 0.02128, note: 'Sample-specific; finer framing can increase pixel error.' },
    rivers: rivers.length, ways: ways.size, bytes: body.length, gzip_bytes: zlib.gzipSync(body).length,
  }
  const target = path.join(dataDir, 'manifest.json')
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`
  fs.writeFileSync(`${target}.tmp`, manifestBody); fs.renameSync(`${target}.tmp`, target)
  if (!sample) {
    const bundled = path.join(resolveGeoDir(), 'osm-rivers')
    fs.mkdirSync(bundled, { recursive: true })
    if (body.length <= 50 * 1024 * 1024) fs.copyFileSync(output, path.join(bundled, 'rivers.json'))
    fs.writeFileSync(path.join(bundled, 'manifest.json'), manifestBody)
    console.log(JSON.stringify({ directory: body.length <= 50 * 1024 * 1024 ? bundled : dataDir, ...manifest }, null, 2))
  } else console.log(JSON.stringify({ directory: dataDir, sample: true, ...manifest }, null, 2))
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
