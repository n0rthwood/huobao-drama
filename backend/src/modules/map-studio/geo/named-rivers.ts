/**
 * 命名河流补充包（OSM 预取，Issue #107 阶段 2）
 *
 * Natural Earth 10m 缺乌格拉河（Ugra）、阿赫图巴（Akhtuba）、卡赞卡（Kazanka）这类
 * 叙事关键小河——1480 年乌格拉河对峙就发生在 NE 完全没有的一条河上。这些河按名字
 * 从 OSM（Overpass API）**预先**抓取入仓：每条带来源、抓取时间、sha256 与 ODbL 署名。
 * 任务运行期只读本地包，绝不联网拉取（Overpass 还要求自定义 User-Agent，否则 406）。
 *
 * 数据位置：`backend/assets/geo/osm-rivers/<slug>.json` + `manifest.json`。
 * 写入只有 `backend/scripts/prefetch-map-data.ts --rivers` 一处；读路径在 datasets 的
 * 同一个 geo 目录下解析（HUOBAO_GEO_DIR 覆盖同样生效）。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { resolveGeoDir } from './datasets.js'
import { loadRegionRiverPack, regionRiverPackAvailable } from './river-region-store.js'
import { foldRiverName } from './river-region.js'

export class NamedRiverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NamedRiverError'
  }
}

export interface NamedRiverPackEntry {
  name: string
  name_zh: string
  file: string
  ways: number
  fetched_at: string
  source_url: string
  sha256: string
  bbox: [number, number, number, number]
}

export interface NamedRiverPack {
  version: 1
  license: string
  attribution: string
  rivers: NamedRiverPackEntry[]
}

export interface NamedRiver {
  name: string
  name_zh: string
  ways: number
  license: string
  attribution: string
  /** 每条 way 一个坐标链；坐标是 [lon, lat]，与 MapSpec 同口径 */
  lines: Array<Array<[number, number]>>
}

const packCache = new Map<string, NamedRiver>()

export function namedRiverPackPath(): string {
  return path.join(resolveGeoDir(), 'osm-rivers')
}

export function readNamedRiverManifest(): NamedRiverPack | null {
  const file = path.join(namedRiverPackPath(), 'manifest.json')
  if (!fs.existsSync(file)) return null
  let parsed: Omit<NamedRiverPack, 'version'> & { version?: number }
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<NamedRiverPack, 'version'> & { version?: number }
  } catch (err) {
    throw new NamedRiverError(`命名河流包 manifest 损坏（${file}）：${err instanceof Error ? err.message : String(err)}`)
  }
  // v2 区域包（#112）没有逐河文件清单：按名取河走 loadRegionRiverPack，这里只服务旧 v1 包。
  if (parsed.version === 2) return null
  if (!Array.isArray(parsed.rivers)) throw new NamedRiverError(`命名河流包 manifest 损坏（${file}）：missing rivers`)
  return parsed as NamedRiverPack
}

export function namedRiverNames(): string[] {
  // v2 区域包（#112）：名字来自区域索引（首名）；旧 v1 逐河文件仍可用，两者合并去重。
  const names = new Set<string>()
  if (regionRiverPackAvailable()) for (const river of loadRegionRiverPack().rivers) if (!river.retired) names.add(river.names[0] ?? river.id)
  for (const entry of readNamedRiverManifest()?.rivers ?? []) names.add(entry.name)
  for (const file of LEGACY_RIVER_FILES) {
    const abs = path.join(namedRiverPackPath(), file)
    if (!fs.existsSync(abs)) continue
    try { const payload = JSON.parse(fs.readFileSync(abs, 'utf8')) as { name?: string }; if (payload.name) names.add(payload.name) } catch { /* 损坏文件由 loadNamedRiver 报 */ }
  }
  return [...names]
}

const LEGACY_RIVER_FILES = ['ugra.json', 'akhtuba.json', 'kazanka.json']
/** v1 逐河文件直读；v2 manifest 不再列它们，但文件仍在仓库里。 */
function loadLegacyRiverFile(nameOrZh: string): NamedRiver | null {
  const key = nameOrZh.trim().toLowerCase()
  for (const file of LEGACY_RIVER_FILES) {
    const abs = path.join(namedRiverPackPath(), file)
    if (!fs.existsSync(abs)) continue
    let payload: { name?: string; name_zh?: string; lines?: unknown; ways?: number; license?: string; attribution?: string }
    try { payload = JSON.parse(fs.readFileSync(abs, 'utf8')) } catch { continue }
    if ((payload.name ?? '').toLowerCase() !== key && payload.name_zh !== nameOrZh.trim()) continue
    if (!Array.isArray(payload.lines)) continue
    const river: NamedRiver = {
      name: payload.name ?? file, name_zh: payload.name_zh ?? payload.name ?? file,
      ways: payload.ways ?? payload.lines.length, license: payload.license ?? 'ODbL-1.0',
      attribution: payload.attribution ?? '© OpenStreetMap contributors, ODbL 1.0',
      lines: payload.lines as [number, number][][],
    }
    packCache.set(key, river)
    return river
  }
  return null
}

/** 按英文名或中文名取一条预取河；不在包里返回 null（调用方决定是否算错误） */
export function loadNamedRiver(nameOrZh: string): NamedRiver | null {
  if (nameOrZh.startsWith('osm:')) {
    const { manifest, byId } = loadRegionRiverPack()
    const river = byId.get(nameOrZh.slice(4))
    return river ? { name: river.names[0] ?? nameOrZh, name_zh: river.names[0] ?? nameOrZh,
      ways: river.way_ids.length, license: manifest.license, attribution: manifest.attribution, lines: river.lines } : null
  }
  const key = nameOrZh.trim()
  if (!key) return null
  const cached = packCache.get(key.toLowerCase())
  if (cached) return cached
  // v2 区域包：按名字（含多语言别名）在区域索引里找，找到后按 osm: id 取几何。
  if (regionRiverPackAvailable()) {
    const { rivers } = loadRegionRiverPack()
    const folded = foldRiverName(key)
    const hit = rivers.find(river => !river.retired && river.names.some(name => foldRiverName(name) === folded))
    if (hit) return loadNamedRiver(`osm:${hit.id}`)
  }
  // 旧 v1 逐河文件（乌格拉/阿赫图巴/卡赞卡）仍随仓库发布：v2 manifest 取代清单后按已知文件直读。
  const legacy = loadLegacyRiverFile(key)
  if (legacy) return legacy
  const manifest = readNamedRiverManifest()
  const entry = manifest?.rivers.find(item => item.name.toLowerCase() === key.toLowerCase() || item.name_zh === key)
  if (!manifest || !entry) return null
  const file = path.join(namedRiverPackPath(), entry.file)
  if (!fs.existsSync(file)) throw new NamedRiverError(`命名河流包缺文件：${entry.file}（${entry.name}）；请重新运行预取，不要手工改包。`)
  const buffer = fs.readFileSync(file)
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== entry.sha256) {
    throw new NamedRiverError(`命名河流 ${entry.name} 的 sha256 不符：manifest ${entry.sha256}，文件 ${sha256}；请恢复原始包或重新预取。`)
  }
  let payload: { name?: string; name_zh?: string; lines?: unknown; ways?: number }
  try {
    payload = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new NamedRiverError(`命名河流包 ${entry.file} 不是有效 JSON；请重新预取。`)
  }
  if (!Array.isArray(payload.lines)) throw new NamedRiverError(`命名河流包 ${entry.file} 缺少 lines 数组`)
  const lines = payload.lines.map((line, index) => {
    if (!Array.isArray(line)) throw new NamedRiverError(`命名河流包 ${entry.file} 第 ${index} 条线不是坐标数组`)
    return line.map((point, pointIndex) => {
      if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new NamedRiverError(`命名河流包 ${entry.file} 第 ${index} 条第 ${pointIndex} 点坐标非法`)
      }
      return [point[0], point[1]] as [number, number]
    })
  })
  const river: NamedRiver = {
    name: payload.name ?? entry.name,
    name_zh: payload.name_zh ?? entry.name_zh,
    ways: payload.ways ?? entry.ways,
    license: manifest.license,
    attribution: manifest.attribution,
    lines,
  }
  packCache.set(key.toLowerCase(), river)
  packCache.set(river.name.toLowerCase(), river)
  return river
}

/** 渲染器批量取用；未预取的河名点出来，便于报错说清「哪些河不在包里」 */
export function loadNamedRivers(names: readonly string[]): { rivers: NamedRiver[]; missing: string[] } {
  const rivers: NamedRiver[] = []
  const missing: string[] = []
  for (const name of names) {
    const river = loadNamedRiver(name)
    if (river) rivers.push(river)
    else missing.push(name)
  }
  return { rivers, missing }
}
