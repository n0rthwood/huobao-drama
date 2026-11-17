import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { DATA_ROOT } from '../../../utils/paths.js'
import { resolveGeoDir } from './datasets.js'
import type { RegionRiver } from './river-region.js'

export interface RegionRiverManifest {
  version: 2
  source_url: string
  fetched_at: string
  license: string
  attribution: string
  file: string
  sha256: string
  aliases?: Record<string, string>
}

const PREFETCH = 'cd backend && node --import tsx scripts/prefetch-river-region.ts'
let cache: { directory: string; manifestKey: string; rivers: RegionRiver[]; byId: Map<string, RegionRiver> } | null = null
/** A legacy v1 pack remains usable for rendering, but is not a searchable regional index.
 * "Available" means the v2 manifest AND its payload resolve (bundled or DATA_ROOT): a manifest-only
 * checkout without the downloaded pack must degrade to NE-only search, not throw on every query. */
export function regionRiverPackAvailable(): boolean {
  const bundled = path.join(resolveGeoDir(), 'osm-rivers')
  const external = path.join(DATA_ROOT, 'map-data', 'osm-rivers')
  return [external, bundled].some(directory => {
    const filename = path.join(directory, 'manifest.json')
    if (!fs.existsSync(filename)) return false
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) as { version?: number; file?: string }
    if (parsed.version !== 2 || typeof parsed.file !== 'string' || path.basename(parsed.file) !== parsed.file) return false
    return fs.existsSync(path.join(directory, parsed.file)) || fs.existsSync(path.join(external, parsed.file))
  })
}

/** An explicit DATA_ROOT pack wins (deployed/test data); the bundled manifest-only deployment
 * resolves its payload from DATA_ROOT. Without this order a repo-bundled manifest would shadow
 * the deployed pack and fail its sha check. */
export function loadRegionRiverPack(): { manifest: RegionRiverManifest; rivers: RegionRiver[]; byId: Map<string, RegionRiver> } {
  const bundled = path.join(resolveGeoDir(), 'osm-rivers')
  const external = path.join(DATA_ROOT, 'map-data', 'osm-rivers')
  const candidates = [external, bundled]
  for (const directory of candidates) {
    const filename = path.join(directory, 'manifest.json')
    if (!fs.existsSync(filename)) continue
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8')) as RegionRiverManifest
    if (manifest.version !== 2) continue
    if (path.basename(manifest.file) !== manifest.file) throw new Error(`OSM 河流 manifest 文件名非法：${manifest.file}`)
    const payload = [path.join(directory, manifest.file), path.join(external, manifest.file)].find(fs.existsSync)
    if (!payload) throw new Error(`OSM 河流缓存缺失（${manifest.file}）；请运行 ${PREFETCH}`)
    // 缓存键含 manifest 内容指纹：同路径换 manifest（测试/重抓）必须重新校验，不能吃旧缓存。
    const manifestKey = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    if (!cache || cache.directory !== payload || cache.manifestKey !== manifestKey) {
      const body = fs.readFileSync(payload), digest = crypto.createHash('sha256').update(body).digest('hex')
      if (digest !== manifest.sha256) throw new Error(`OSM 河流缓存 sha256 不符：预期 ${manifest.sha256}，实际 ${digest}；请运行 ${PREFETCH}`)
      const parsed = JSON.parse(body.toString('utf8')) as { rivers: RegionRiver[] }
      if (!Array.isArray(parsed.rivers)) throw new Error('OSM 河流缓存缺少 rivers')
      const byId = new Map(parsed.rivers.map(river => [river.id, river]))
      for (const [oldId, newId] of Object.entries(manifest.aliases ?? {})) {
        const river = byId.get(newId)
        if (river) byId.set(oldId, river)
      }
      cache = { directory: payload, manifestKey, rivers: parsed.rivers, byId }
    }
    return { manifest, rivers: cache.rivers, byId: cache.byId }
  }
  throw new Error(`OSM 区域河流缓存缺失；请运行 ${PREFETCH}`)
}
