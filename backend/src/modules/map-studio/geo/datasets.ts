/**
 * Offline Natural Earth lookup. References are zero-based GeoJSON feature indices:
 * ne:<filename without ne_ or .geojson>:<index>. Files and vertices are never rewritten.
 *
 * Natural Earth splits one river into several features: a `River` line plus `Lake
 * Centerline` lines where the river runs through a reservoir, all carrying the same
 * name and rivernum. A group reference ne-group:<file>:<name> covers every such feature
 * so a river is clipped as one river instead of as disjoint pieces. Extraction stitches
 * those pieces by joining endpoints that are identical or at most 0.01° apart (≈1.1 km,
 * about one pixel on a 4K canvas at regional scale): the snap appends the original
 * vertices unchanged and never inserts an extra vertex, and every snapped join is
 * counted in the result so real gaps are never bridged silently.
 *
 * Clipping deliberately retains original vertex runs, INCLUDING bbox boundaries, rather
 * than inventing intersection vertices. Every retained run is returned; disconnected
 * chains remain separate and are reported with the chain count and the shortest chain
 * length. Polygon holes cannot be represented by MapSpec, so extraction rejects them
 * explicitly instead of filling them. No simplification or smoothing.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export type DatasetLayer = 'river' | 'lake' | 'coast' | 'mountain' | 'physical_region' | 'place'
export type DatasetKind = 'place' | 'route' | 'region'
export type DatasetScale = '10m' | '50m'
export type DatasetBBox = [number, number, number, number]
export type DatasetPosition = [number, number]
export const DATASET_LAYERS: readonly DatasetLayer[] = ['river', 'lake', 'coast', 'mountain', 'physical_region', 'place']

export class DatasetError extends Error {
  constructor(message: string) { super(message); this.name = 'DatasetError' }
}

interface FileDefinition {
  filename: string
  scale: DatasetScale
  layer: DatasetLayer | 'regions'
  expectedSha256?: string
}
const FILES: Record<string, FileDefinition> = {
  '10m_rivers_lake_centerlines': { filename: 'ne_10m_rivers_lake_centerlines.geojson', scale: '10m', layer: 'river', expectedSha256: 'bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a' },
  '50m_rivers_lake_centerlines': { filename: 'ne_50m_rivers_lake_centerlines.geojson', scale: '50m', layer: 'river' },
  '50m_lakes': { filename: 'ne_50m_lakes.geojson', scale: '50m', layer: 'lake' },
  '50m_coastline': { filename: 'ne_50m_coastline.geojson', scale: '50m', layer: 'coast' },
  '50m_geography_regions_polys': { filename: 'ne_50m_geography_regions_polys.geojson', scale: '50m', layer: 'regions', expectedSha256: '33396643d8f0eed408e80bf5ca43dcdb7993f790fdc4eadae311660f8b91fe76' },
  '10m_populated_places_simple': { filename: 'ne_10m_populated_places_simple.geojson', scale: '10m', layer: 'place', expectedSha256: 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f' },
  '50m_populated_places': { filename: 'ne_50m_populated_places.geojson', scale: '50m', layer: 'place' },
}
const LAYER_FILES: Record<DatasetLayer, string[]> = {
  river: ['10m_rivers_lake_centerlines', '50m_rivers_lake_centerlines'],
  lake: ['50m_lakes'], coast: ['50m_coastline'],
  mountain: ['50m_geography_regions_polys'], physical_region: ['50m_geography_regions_polys'],
  place: ['10m_populated_places_simple', '50m_populated_places'],
}

export interface DatasetSourceInfo {
  fileId: string
  filename: string
  scale: DatasetScale
  sha256: string
  license: 'Public domain'
}
/** Chain statistics of a group reference: how fragmented the extracted geometry is. */
export interface DatasetGroupInfo {
  /** Every member feature ref, in file order. */
  members: string[]
  member_classes: string[]
  /** Route chains (or region rings) left after stitching and clipping. */
  chains: number
  /** Length of the shortest chain in km (ring perimeter for regions). */
  shortest_chain_km: number
  /** Endpoint joins snapped within 0.01°; no extra vertices were inserted. */
  joined_parts: number
  /** Largest endpoint gap accepted by a snap, in degrees. */
  max_join_deg: number
  /** bbox the chain statistics were computed with; null means the whole feature group. */
  stats_bbox: DatasetBBox | null
}
export interface DatasetCandidate {
  ref: string
  names: string[]
  class: string | null
  scalerank: number | null
  bbox: DatasetBBox
  length_km?: number
  area_km2?: number
  /** Stored coordinate count, including polygon closing points. */
  vertices: number
  /** Present only on river/lake group refs that cover more than one feature. */
  group?: DatasetGroupInfo
}
export interface ExtractedDatasetGeometry {
  ref: string
  layer: DatasetLayer
  kind: DatasetKind
  names: string[]
  lon?: number
  lat?: number
  parts: DatasetPosition[][]
  bbox: DatasetBBox
  vertices: number
  length_km?: number
  area_km2?: number
  clip_bbox?: DatasetBBox
  clip_mode?: 'vertex-run'
  source: DatasetSourceInfo
  /** Present on group refs; the individual `parts` are the stitched chains. */
  group?: DatasetGroupInfo
}
interface Geometry { type: string; coordinates: unknown }
interface IndexEntry extends DatasetCandidate {
  layer: DatasetLayer
  kind: DatasetKind
  index: number
  /** Natural Earth river id; null when the file has none or leaves it at 0 (unknown). */
  rivernum: number | null
  folded: string[]
  geometry: Geometry
}
interface LoadedFile { entries: IndexEntry[]; byIndex: Map<number, IndexEntry>; count: number; source: DatasetSourceInfo }
const cache = new Map<string, LoadedFile>()
const shaCache = new Map<string, string>()

/** Same directory resolution for index and program renderer; no runtime downloads. */
export function resolveGeoDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [process.env.HUOBAO_GEO_DIR, path.resolve(here, '../../../../assets/geo'), path.resolve(here, 'assets/geo'), path.resolve(process.cwd(), 'assets/geo')]
    .filter((item): item is string => Boolean(item))
  for (const dir of candidates) if (fs.existsSync(path.join(dir, 'ne_50m_land.geojson'))) return dir
  throw new DatasetError(`地图底图数据缺失：在 ${candidates.join(' / ')} 都没找到 ne_50m_land.geojson；请发布 backend/assets/geo，或用 HUOBAO_GEO_DIR 指向数据目录。`)
}
function definition(fileId: string): FileDefinition {
  const value = Object.hasOwn(FILES, fileId) ? FILES[fileId] : undefined
  if (!value) throw new DatasetError(`未知数据集文件简名「${fileId}」；可用：${Object.keys(FILES).join(' / ')}`)
  return value
}
function readFile(fileId: string): { buffer: Buffer; sha256: string } {
  const def = definition(fileId)
  const filename = path.join(resolveGeoDir(), def.filename)
  if (!fs.existsSync(filename)) throw new DatasetError(`数据集文件缺失：${def.filename}；请将 backend/assets/geo 中该文件随版本发布。`)
  const buffer = fs.readFileSync(filename)
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  if (def.expectedSha256 && def.expectedSha256 !== sha256) throw new DatasetError(`数据集 ${def.filename} SHA-256 不符：预期 ${def.expectedSha256}，实际 ${sha256}；请恢复原始文件，不要修改几何。`)
  shaCache.set(fileId, sha256)
  return { buffer, sha256 }
}
export function datasetFileInfo(fileId: string): DatasetSourceInfo {
  const def = definition(fileId)
  const sha256 = shaCache.get(fileId) ?? readFile(fileId).sha256
  return { fileId, filename: def.filename, scale: def.scale, sha256, license: 'Public domain' }
}
export interface ParsedDatasetRef { fileId: string; index: number | null; group: string | null }
/** Single-feature refs index one GeoJSON feature; group refs name one river or lake across features. */
export function parseDatasetRef(ref: string): ParsedDatasetRef {
  const single = typeof ref === 'string' ? /^ne:([a-z0-9_]+):(0|[1-9]\d*)$/.exec(ref) : null
  if (single && Number.isSafeInteger(Number(single[2]))) { definition(single[1]!); return { fileId: single[1]!, index: Number(single[2]), group: null } }
  // Group keys are folded names with spaces replaced by '-' (foldDatasetName never emits ':' or spaces);
  // non-ASCII names (e.g. 斋桑泊) stay valid keys.
  const group = typeof ref === 'string' ? /^ne-group:([a-z0-9_]+):([^\s:]+)$/.exec(ref) : null
  if (group) { definition(group[1]!); return { fileId: group[1]!, index: null, group: group[2]! } }
  throw new DatasetError(`数据集引用「${String(ref)}」非法：格式必须为 ne:<文件简名>:<序号>（例如 ne:10m_rivers_lake_centerlines:279），或河流/湖泊组引用 ne-group:<文件简名>:<组名>（例如 ne-group:10m_rivers_lake_centerlines:volga）；请采用 search_dataset 返回的 ref。`)
}
export function datasetRefFileId(ref: string): string { return parseDatasetRef(ref).fileId }
export function datasetSourceInfo(ref: string): DatasetSourceInfo { return datasetFileInfo(parseDatasetRef(ref).fileId) }
/** Cheap source selector: parses the ref without loading geometries. */
export function riverScaleForRef(ref: string): DatasetScale | null {
  const { fileId } = parseDatasetRef(ref)
  const def = definition(fileId)
  return def.layer === 'river' ? def.scale : null
}

export function foldDatasetName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[-‐‑‒–—―_/\\.,;:!?"'’‘()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim()
}
function namesOf(properties: Record<string, unknown>): string[] {
  const keys = Object.keys(properties).filter(key => /^name(?:_?[a-z]+)?$/i.test(key))
  keys.sort((a, b) => Number(b.toLowerCase() === 'name') - Number(a.toLowerCase() === 'name') || a.localeCompare(b))
  const seen = new Set<string>()
  const names: string[] = []
  for (const key of keys) {
    const raw = properties[key]
    if (typeof raw !== 'string' || !raw.trim()) continue
    const name = raw.trim(), folded = foldDatasetName(name)
    if (seen.has(folded)) continue
    seen.add(folded); names.push(name)
  }
  return names
}
function property(properties: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(properties).find(candidate => candidate.toLowerCase() === key)
  return found ? properties[found] : undefined
}
function assertBBox(raw: unknown, field: string): DatasetBBox {
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new DatasetError(`${field} 必须是有限数字 [west,south,east,north] 四元组`)
  const [w, s, e, n] = raw as DatasetBBox
  if (!(w < e && s < n) || w < -180 || e > 180 || s < -90 || n > 90) throw new DatasetError(`${field} 非法：要求 -180≤west<east≤180，-90≤south<north≤90；收到 ${JSON.stringify(raw)}`)
  return [w, s, e, n]
}
function position(raw: unknown): DatasetPosition {
  if (!Array.isArray(raw) || raw.length < 2 || typeof raw[0] !== 'number' || typeof raw[1] !== 'number' || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) throw new DatasetError('数据集含非法坐标；请恢复原始 GeoJSON 文件。')
  return [raw[0], raw[1]]
}
function chain(raw: unknown): DatasetPosition[] {
  if (!Array.isArray(raw)) throw new DatasetError('数据集含非法坐标数组；请恢复原始 GeoJSON 文件。')
  return raw.map(position)
}
/** Extraction rejects holes. Indexing may still describe their full area and vertices. */
function rawParts(geometry: Geometry, rejectHoles: boolean, ref: string): DatasetPosition[][] {
  const coordinates = geometry.coordinates
  if (!Array.isArray(coordinates)) throw new DatasetError(`数据集 ${ref} 缺少坐标`)
  if (geometry.type === 'Point') return [[position(coordinates)]]
  if (geometry.type === 'LineString') return [chain(coordinates)]
  if (geometry.type === 'MultiLineString') return coordinates.map(chain)
  const polygons = geometry.type === 'Polygon' ? [coordinates] : geometry.type === 'MultiPolygon' ? coordinates : null
  if (!polygons) throw new DatasetError(`数据集 ${ref} 的 ${geometry.type} 几何不支持；请选择 Point、LineString 或 Polygon 要素。`)
  const parts: DatasetPosition[][] = []
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) throw new DatasetError(`数据集 ${ref} 的多边形结构非法`)
    if (rejectHoles && polygon.length > 1) throw new DatasetError(`数据集 ${ref} 含 ${polygon.length - 1} 个多边形内环（孔洞/岛屿）；MapSpec region 不能表达内环，不能静默填充或丢弃。请另选可表达的要素或人工裁定范围。`)
    for (const ring of rejectHoles ? polygon.slice(0, 1) : polygon) parts.push(chain(ring))
  }
  return parts
}
function kindOf(type: string): DatasetKind {
  if (type === 'Point') return 'place'
  if (type === 'LineString' || type === 'MultiLineString') return 'route'
  if (type === 'Polygon' || type === 'MultiPolygon') return 'region'
  throw new DatasetError(`不支持的数据集几何类型 ${type}`)
}
function bounds(parts: DatasetPosition[][]): DatasetBBox {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const part of parts) for (const [lon, lat] of part) {
    west = Math.min(west, lon); south = Math.min(south, lat); east = Math.max(east, lon); north = Math.max(north, lat)
  }
  return [west, south, east, north]
}
const R = 6371.0088, RAD = Math.PI / 180
function distance(a: DatasetPosition, b: DatasetPosition): number {
  const h = Math.sin((b[1] - a[1]) * RAD / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin((b[0] - a[0]) * RAD / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
function length(parts: DatasetPosition[][]): number {
  let sum = 0
  for (const part of parts) for (let i = 1; i < part.length; i++) sum += distance(part[i - 1]!, part[i]!)
  return Math.round(sum * 10) / 10
}
/** Spherical ring area; orientation does not affect this measurement. */
function ringArea(ring: DatasetPosition[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    let dlon = (b[0] - a[0]) * RAD
    if (dlon > Math.PI) dlon -= 2 * Math.PI
    if (dlon < -Math.PI) dlon += 2 * Math.PI
    sum += dlon * (2 + Math.sin(a[1] * RAD) + Math.sin(b[1] * RAD))
  }
  const area = Math.abs(sum * R * R / 2)
  return Math.min(area, 4 * Math.PI * R * R - area)
}
function area(parts: DatasetPosition[][]): number { return Math.round(parts.reduce((sum, ring) => sum + ringArea(ring), 0) * 10) / 10 }
function sourceArea(geometry: Geometry): number {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  let sum = 0
  for (const polygon of polygons as unknown[][]) {
    sum += polygon.reduce<number>((total, ring, index) => total + (index === 0 ? 1 : -1) * ringArea(chain(ring)), 0)
  }
  return Math.round(Math.max(0, sum) * 10) / 10
}
function load(fileId: string): LoadedFile {
  const cached = cache.get(fileId)
  if (cached) return cached
  const def = definition(fileId), { buffer, sha256 } = readFile(fileId)
  let parsed: { features?: Array<{ properties?: Record<string, unknown> | null; geometry?: Geometry | null }> }
  try { parsed = JSON.parse(buffer.toString('utf8')) } catch { throw new DatasetError(`数据集 ${def.filename} 不是有效 JSON，请恢复原始文件。`) }
  if (!Array.isArray(parsed.features)) throw new DatasetError(`数据集 ${def.filename} 缺少 features 数组`)
  const entries: IndexEntry[] = [], byIndex = new Map<number, IndexEntry>()
  parsed.features.forEach((feature, index) => {
    if (!feature.geometry) return
    const ref = `ne:${fileId}:${index}`, geometry = feature.geometry, properties = feature.properties ?? {}
    const parts = rawParts(geometry, false, ref), kind = kindOf(geometry.type)
    if (!parts.some(part => part.length)) return
    const rawClass = property(properties, 'featurecla'), rawRank = property(properties, 'scalerank'), rawRiver = property(properties, 'rivernum')
    const featureClass = typeof rawClass === 'string' ? rawClass : null
    const layer = def.layer === 'regions' ? /range|mtn/i.test(featureClass ?? '') ? 'mountain' : 'physical_region' : def.layer
    const names = namesOf(properties)
    const entry: IndexEntry = {
      ref, layer, kind, index, names, folded: names.map(foldDatasetName), class: featureClass,
      rivernum: typeof rawRiver === 'number' && Number.isFinite(rawRiver) && rawRiver > 0 ? rawRiver : null,
      scalerank: typeof rawRank === 'number' && Number.isFinite(rawRank) ? rawRank : null,
      bbox: bounds(parts), vertices: parts.reduce((sum, part) => sum + part.length, 0), geometry,
      ...(kind === 'route' ? { length_km: length(parts) } : {}),
      ...(kind === 'region' ? { area_km2: sourceArea(geometry) } : {}),
    }
    entries.push(entry); byIndex.set(index, entry)
  })
  const source: DatasetSourceInfo = { fileId, filename: def.filename, scale: def.scale, sha256, license: 'Public domain' }
  const loaded = { entries, byIndex, count: parsed.features.length, source }
  cache.set(fileId, loaded)
  return loaded
}
function lookup(ref: string): { entry: IndexEntry; file: LoadedFile } {
  const { fileId, index } = parseDatasetRef(ref), file = load(fileId), entry = index === null ? undefined : file.byIndex.get(index)
  if (!entry) throw new DatasetError(`数据集引用 ${ref} 没有可用几何；${fileId} 的有效要素序号范围是 0–${file.count - 1}。请重新 search_dataset 并使用返回的 ref。`)
  return { entry, file }
}
export function datasetRefLayer(ref: string): DatasetLayer {
  const parsed = parseDatasetRef(ref)
  return parsed.group === null ? lookup(ref).entry.layer : groupEntries(parsed.fileId, parsed.group)[0]!.layer
}
export function datasetRefKind(ref: string): DatasetKind {
  const parsed = parseDatasetRef(ref)
  return parsed.group === null ? lookup(ref).entry.kind : groupParts(groupEntries(parsed.fileId, parsed.group)).kind
}

/** Endpoint gaps up to this size are digitization noise between one river's features. */
const GROUP_JOIN_TOLERANCE_DEG = 0.01
/**
 * Members of one river/lake group: same primary name, one rivernum family, one contiguous place.
 * Same-name features can belong to different rivers (Natural Earth rivernum) or different
 * lakes; those stay ambiguous instead of being merged into one invented feature.
 */
function groupEntries(fileId: string, key: string): IndexEntry[] {
  const def = definition(fileId)
  if (def.layer !== 'river' && def.layer !== 'lake') throw new DatasetError(`组引用 ne-group:${fileId}:${key} 不受支持：组引用只用于 river / lake 图层，${fileId} 属于 ${def.layer}；请改用单个要素 ref。`)
  const members = load(fileId).entries.filter(entry => entry.layer === def.layer && entry.folded[0]?.replace(/ /g, '-') === key)
  if (!members.length) throw new DatasetError(`组引用 ne-group:${fileId}:${key} 在该文件里没有任何同名要素；请重新 search_dataset 并使用返回的 ref。`)
  const rivernums = [...new Set(members.flatMap(entry => entry.rivernum === null ? [] : [entry.rivernum]))]
  if (rivernums.length > 1) throw new DatasetError(`组引用 ne-group:${fileId}:${key} 的同名要素分属不同河湖（rivernum ${rivernums.join(' / ')}），不能当成一条河或一个湖；请改用单个要素 ref，并用 clip_bbox 裁到需要的位置。`)
  // A rivernum identifies one river even when its features sit apart; without one, the
  // same name can describe unrelated places (several "Cedar Lake"), so require them to touch.
  if (!rivernums.length) {
    const clusters: IndexEntry[][] = []
    for (const entry of members) {
      const touching = clusters.filter(cluster => cluster.some(other => intersects(other.bbox, entry.bbox)))
      for (const cluster of touching) clusters.splice(clusters.indexOf(cluster), 1)
      clusters.push([entry, ...touching.flat()])
    }
    if (clusters.length > 1) throw new DatasetError(`组引用 ne-group:${fileId}:${key} 的同名要素分成 ${clusters.length} 处互不相连的位置（${clusters.map(cluster => JSON.stringify(cluster[0]!.bbox)).join(' / ')}），不能当成一条河或一个湖；请改用单个要素 ref。`)
  }
  return members.sort((a, b) => a.index - b.index)
}
/** Stitched group geometry; translated duplicates of one feature count once. */
function groupParts(entries: IndexEntry[]): { kind: DatasetKind; parts: DatasetPosition[][]; joined: number; max_gap_deg: number } {
  const kinds = [...new Set(entries.map(entry => entry.kind))]
  if (kinds.length !== 1) throw new DatasetError(`组引用的成员几何不一致（${kinds.join(' / ')}），不能合并；请改用单个要素 ref。`)
  const kind = kinds[0]!, seen = new Set<string>(), parts: DatasetPosition[][] = []
  for (const entry of entries) for (const part of rawParts(entry.geometry, true, entry.ref)) {
    const fingerprint = JSON.stringify(part)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint); parts.push(part)
  }
  if (kind !== 'route') return { kind, parts, joined: 0, max_gap_deg: 0 }
  const stitched = stitchChains(parts, GROUP_JOIN_TOLERANCE_DEG)
  return { kind, parts: stitched.chains, joined: stitched.joined, max_gap_deg: stitched.max_gap_deg }
}
function intersects(a: DatasetBBox, b: DatasetBBox): boolean { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1] }
function score(entry: IndexEntry, query: string): number {
  const joinedQuery = query.replace(/ /g, '')
  let best = 0
  for (const name of entry.folded) {
    const joined = name.replace(/ /g, '')
    if (name === query || joined === joinedQuery) best = Math.max(best, 100)
    else if (name.startsWith(query) || joined.startsWith(joinedQuery)) best = Math.max(best, 80)
    else if (name.split(' ').some(word => word.startsWith(query))) best = Math.max(best, 60)
    else if (name.includes(query) || joined.includes(joinedQuery)) best = Math.max(best, 40)
  }
  // Natural Earth coastline has no name fields. Search its real source class,
  // preserving names=[] rather than inventing a geographic name.
  if (!entry.folded.length && entry.class && foldDatasetName(entry.class).includes(query)) best = Math.max(best, 20)
  return best
}
/** 10m first; same-name 50m results only appear when no in-bbox 10m match exists. */
export function searchDataset(layer: DatasetLayer, query: string, bbox?: DatasetBBox): DatasetCandidate[] {
  if (!DATASET_LAYERS.includes(layer)) throw new DatasetError(`未知数据集图层「${String(layer)}」；可用：${DATASET_LAYERS.join(' / ')}`)
  if (typeof query !== 'string' || !foldDatasetName(query)) throw new DatasetError('search_dataset.query 不能为空，请填写要素名称。')
  const filter = bbox === undefined ? null : assertBBox(bbox, 'bbox'), foldedQuery = foldDatasetName(query)
  const hits: Array<{ entry: IndexEntry; score: number; priority: number }> = [], claimed = new Set<string>()
  LAYER_FILES[layer].forEach((fileId, priority) => {
    const matches = load(fileId).entries.filter(entry => entry.layer === layer && (!filter || intersects(entry.bbox, filter)))
    for (const entry of matches) {
      if (priority && entry.folded.some(name => claimed.has(name))) continue
      const matchScore = score(entry, foldedQuery)
      if (matchScore) hits.push({ entry, score: matchScore, priority })
    }
    for (const entry of matches) if (score(entry, foldedQuery)) for (const name of entry.folded) claimed.add(name)
  })
  const ranked: Array<{ candidate: DatasetCandidate; score: number; priority: number; group: boolean }> = hits.map(({ entry, score: hitScore, priority }) => ({
    score: hitScore, priority, group: false,
    candidate: { ref: entry.ref, names: [...entry.names], class: entry.class, scalerank: entry.scalerank, bbox: [...entry.bbox] as DatasetBBox, vertices: entry.vertices,
      ...(entry.length_km !== undefined ? { length_km: entry.length_km } : {}), ...(entry.area_km2 !== undefined ? { area_km2: entry.area_km2 } : {}) },
  }))
  // One river is a River feature plus Lake Centerline pieces; offer the stitched group first on ties.
  if (layer === 'river' || layer === 'lake') {
    const groups = new Map<string, { fileId: string; key: string; score: number; priority: number }>()
    for (const { entry, score: hitScore, priority } of hits) {
      const fileId = parseDatasetRef(entry.ref).fileId, key = entry.folded[0]?.replace(/ /g, '-')
      if (!key) continue
      const ref = `ne-group:${fileId}:${key}`, existing = groups.get(ref)
      if (existing) { existing.score = Math.max(existing.score, hitScore); existing.priority = Math.min(existing.priority, priority) }
      else groups.set(ref, { fileId, key, score: hitScore, priority })
    }
    for (const [ref, { fileId, key, score: groupScore, priority }] of groups) {
      let candidate: DatasetCandidate | null = null
      try {
        const entries = groupEntries(fileId, key)
        // Ambiguous same-name features (different rivers/lakes) or a group whose geometry
        // cannot be expressed (polygon holes) keeps the individual refs only.
        if (entries.length > 1) candidate = groupCandidate(ref, entries, filter)
      } catch { continue }
      if (candidate) ranked.push({ candidate, score: groupScore, priority, group: true })
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.priority - b.priority || Number(b.group) - Number(a.group)
    || Number(a.candidate.class === 'Lake Centerline') - Number(b.candidate.class === 'Lake Centerline')
    || (a.candidate.scalerank ?? 99) - (b.candidate.scalerank ?? 99) || b.candidate.vertices - a.candidate.vertices || a.candidate.ref.localeCompare(b.candidate.ref))
  return ranked.slice(0, 10).map(item => item.candidate)
}
/** Group candidate: combined geometry plus the chain counts the model needs to choose a clip. */
function groupCandidate(ref: string, entries: IndexEntry[], clip: DatasetBBox | null): DatasetCandidate | null {
  const full = extractGroupGeometry(ref, entries, null)
  const parts = clip ? clipParts(full.parts, full.kind, clip) : full.parts
  if (!parts.length) return null
  return {
    ref, names: full.names, class: full.group!.member_classes.join(' + ') || null,
    scalerank: entries.reduce<number | null>((best, entry) => entry.scalerank === null ? best : best === null ? entry.scalerank : Math.min(best, entry.scalerank), null),
    bbox: full.bbox, vertices: full.vertices,
    ...(full.length_km !== undefined ? { length_km: full.length_km } : {}),
    ...(full.area_km2 !== undefined ? { area_km2: full.area_km2 } : {}),
    group: { ...full.group!, chains: parts.length, shortest_chain_km: Math.min(...parts.map(part => length([part]))), stats_bbox: clip },
  }
}
function same(a: DatasetPosition, b: DatasetPosition): boolean { return a[0] === b[0] && a[1] === b[1] }
/**
 * Join chains end to end, keeping both junction copies: no original vertex is removed and
 * none is inserted. toleranceDeg 0 means exact endpoints only (single-feature refs);
 * group refs pass GROUP_JOIN_TOLERANCE_DEG, and every snapped join is counted so the
 * caller can report that a straight segment shorter than the tolerance was introduced.
 */
function stitchChains(parts: DatasetPosition[][], toleranceDeg: number): { chains: DatasetPosition[][]; joined: number; max_gap_deg: number } {
  const chains = parts.filter(part => part.length >= 2).map(part => part.slice())
  const gapDeg = (a: DatasetPosition, b: DatasetPosition) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
  let joined = 0, maxGapDeg = 0, changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < chains.length; i++) for (let j = i + 1; j < chains.length; j++) {
      const a = chains[i]!, b = chains[j]!, af = a[0]!, al = a[a.length - 1]!, bf = b[0]!, bl = b[b.length - 1]!
      let merged: DatasetPosition[] | null = null, gap = 0
      if ((gap = gapDeg(al, bf)) <= toleranceDeg) merged = a.concat(b)
      else if ((gap = gapDeg(al, bl)) <= toleranceDeg) merged = a.concat(b.slice().reverse())
      else if ((gap = gapDeg(af, bl)) <= toleranceDeg) merged = b.concat(a)
      else if ((gap = gapDeg(af, bf)) <= toleranceDeg) merged = b.slice().reverse().concat(a)
      if (!merged) continue
      maxGapDeg = Math.max(maxGapDeg, gap); joined++
      chains[i] = merged; chains.splice(j, 1); changed = true; break outer
    }
  }
  return { chains, joined, max_gap_deg: Math.round(maxGapDeg * 1e6) / 1e6 }
}
function inside(point: DatasetPosition, bbox: DatasetBBox): boolean { return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3] }
function vertexRuns(points: DatasetPosition[], bbox: DatasetBBox): DatasetPosition[][] {
  const runs: DatasetPosition[][] = []
  let run: DatasetPosition[] = []
  for (const point of points) {
    if (inside(point, bbox)) run.push(point)
    else if (run.length) { runs.push(run); run = [] }
  }
  if (run.length) runs.push(run)
  return runs
}
function clipRing(ring: DatasetPosition[], bbox: DatasetBBox): DatasetPosition[][] {
  if (ring.every(point => inside(point, bbox))) return [ring]
  const open = ring.length > 1 && same(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring
  const runs = vertexRuns(open, bbox)
  if (runs.length > 1 && inside(open[0]!, bbox) && inside(open[open.length - 1]!, bbox)) {
    const last = runs.pop()!
    runs[0] = last.concat(runs[0]!)
  }
  return runs.filter(run => new Set(run.map(point => `${point[0]},${point[1]}`)).size >= 3)
    .map(run => same(run[0]!, run[run.length - 1]!) ? run : run.concat([run[0]!]))
}
/** Vertex-only clipping: original runs only, never invented intersection points. */
function clipParts(parts: DatasetPosition[][], kind: DatasetKind, clip: DatasetBBox): DatasetPosition[][] {
  if (kind === 'place') return parts.filter(part => part[0] && inside(part[0], clip))
  if (kind === 'route') return parts.flatMap(part => vertexRuns(part, clip).filter(run => new Set(run.map(point => `${point[0]},${point[1]}`)).size >= 2))
  return parts.flatMap(part => clipRing(part, clip))
}
function extractGroupGeometry(ref: string, entries: IndexEntry[], clip: DatasetBBox | null): ExtractedDatasetGeometry {
  const file = load(parseDatasetRef(ref).fileId)
  const { kind, parts: stitched, joined, max_gap_deg } = groupParts(entries)
  const parts = clip ? clipParts(stitched, kind, clip) : stitched
  if (!parts.length) throw new DatasetError(`组引用 ${ref} 在 clip_bbox ${JSON.stringify(clip)} 内没有足够的原始顶点，裁剪后为空；请扩大 clip_bbox 或采用不裁剪的引用。`)
  const names: string[] = [], seen = new Set<string>()
  for (const entry of entries) for (const name of entry.names) {
    const folded = foldDatasetName(name)
    if (seen.has(folded)) continue
    seen.add(folded); names.push(name)
  }
  return {
    ref, layer: entries[0]!.layer, kind, names, parts, bbox: bounds(parts), vertices: parts.reduce((sum, part) => sum + part.length, 0), source: { ...file.source },
    ...(clip ? { clip_bbox: clip, clip_mode: 'vertex-run' as const } : {}),
    ...(kind === 'route' ? { length_km: length(parts) } : { area_km2: area(parts) }),
    group: {
      members: entries.map(entry => entry.ref),
      member_classes: [...new Set(entries.map(entry => entry.class).filter((value): value is string => value !== null))],
      chains: parts.length, shortest_chain_km: Math.min(...parts.map(part => length([part]))),
      joined_parts: joined, max_join_deg: max_gap_deg, stats_bbox: clip,
    },
  }
}
/** Synchronous, actionable errors; returned arrays are caller-owned. */
export function extractDatasetGeometry(ref: string, clip_bbox?: DatasetBBox): ExtractedDatasetGeometry {
  const parsed = parseDatasetRef(ref)
  const clip = clip_bbox === undefined ? null : assertBBox(clip_bbox, 'clip_bbox')
  if (parsed.group !== null) return extractGroupGeometry(ref, groupEntries(parsed.fileId, parsed.group), clip)
  const { entry, file } = lookup(ref)
  let parts = rawParts(entry.geometry, true, ref)
  if (entry.kind === 'route') parts = stitchChains(parts, 0).chains
  if (clip) parts = clipParts(parts, entry.kind, clip)
  if (!parts.length) throw new DatasetError(`数据集 ${ref} 在 clip_bbox ${JSON.stringify(clip)} 内没有足够的原始顶点，裁剪后为空；请扩大 clip_bbox 或采用不裁剪的引用。`)
  const result: ExtractedDatasetGeometry = {
    ref: entry.ref, layer: entry.layer, kind: entry.kind, names: [...entry.names], parts, bbox: bounds(parts), vertices: parts.reduce((sum, part) => sum + part.length, 0), source: { ...file.source },
    ...(clip ? { clip_bbox: clip, clip_mode: 'vertex-run' as const } : {}),
    ...(entry.kind === 'route' ? { length_km: length(parts) } : {}), ...(entry.kind === 'region' ? { area_km2: area(parts) } : {}),
  }
  if (entry.kind === 'place') { result.lon = parts[0]![0]![0]; result.lat = parts[0]![0]![1] }
  return result
}
