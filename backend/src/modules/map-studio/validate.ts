/**
 * 地图工作流的交付校验（Issue #90）——纯函数，不读库、不调模型。
 *
 * 口径：校验只判「收 / 拒」，**绝不修正**模型的交付物（不降级、不退化、不钳制、不补默认值）。
 * 每条拒收原因都写成可以直接照改的说明（哪个要素、哪个字段、当前值、合法范围或期望值），
 * 由调用方原样回给模型；轮次与回退由 agent-loop 管。
 */
import { forwardFor, type MapRegistration } from './geo/geometry.js'
import type { MapSpec } from './geo/base-render.js'
import { THEME_PRESETS } from '../../services/layer-svg.js'
import type { Layer, LayerDoc } from '../../services/layer-doc.js'
import { extractDatasetGeometry, type ExtractedDatasetGeometry } from './geo/datasets.js'
import { extentProblems, validExtent, computeRelation, excerptSupportsPoint } from './accuracy.js'
import { labelProblems, type LabelFeature } from './layout/labels.js'
import { renderCopyWithSmoothing, type LayerOptions } from './render/smooth.js'
import type { MapDatasetQuery, MapFeatureCategory, MapFeatureOrigin, MapRelation } from './types.js'
import type {
  MapBrief,
  MapCoordinateBasis,
  MapFeatureConflict,
  MapFeatureKind,
  MapResearchFeature,
  MapResearchSource,
} from './types.js'

const FEATURE_KINDS: MapFeatureKind[] = ['place', 'route', 'region']
const BASES: MapCoordinateBasis[] = ['excerpt', 'well_known', 'approximate_schematic']
const UNCERTAINTIES = ['high', 'medium', 'low'] as const
const MAX_FEATURES = 80

/** 离群判定：与其余坐标中位点的距离超过 max(8°, 6×中位距离) 即视为离群（需模型修正或说明） */
const OUTLIER_MIN_DEG = 8
const OUTLIER_MAD_FACTOR = 6
/** 取景：顶点必须落在画面内并离边至少 2%；全部要素外包框的最大边至少占画面 30% */
export const FRAME_MARGIN = 0.02
export const FRAME_MIN_EXTENT = 0.3
/** 锚定几何与要素投影位置的容差：max(6px, 长边 0.4%)（3840 宽约 15px） */
const GEOMETRY_TOLERANCE_MIN_PX = 6
const GEOMETRY_TOLERANCE_RATIO = 0.004
/** 底图必须看得见：有效不透明度 ≥0.5 的填充面合计盖住画面超过 30% 即拒收 */
const OPAQUE_FILL_ALPHA = 0.5
export const OPAQUE_COVER_LIMIT = 0.3
const COVER_GRID_X = 64
const COVER_GRID_Y = 36

/** 比对用的归一化：去空白与常见标点差异，避免「逐字核对」被空格打败 */
export function matchKey(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，,。.、；;：:！!？?「」『』“”"'（）()]/g, '')
}

function describe(value: unknown): string {
  const json = JSON.stringify(value)
  return json === undefined ? 'undefined' : json.length > 60 ? `${json.slice(0, 57)}...` : json
}

/** 严格读坐标：不是有限数字、越出经纬度范围、或 (0,0) 占位一律给出原因，不做任何修正 */
function readLonLat(raw: unknown): { point: [number, number] } | { problem: string } {
  if (!Array.isArray(raw) || raw.length !== 2) return { problem: `坐标必须是 [经度, 纬度] 两个数字，当前是 ${describe(raw)}` }
  const [lon, lat] = raw
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { problem: `坐标必须是数字（不是字符串或占位符），当前是 ${describe(raw)}` }
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return { problem: `坐标 ${describe(raw)} 超出经度 [-180,180] / 纬度 [-90,90]` }
  if (lon === 0 && lat === 0) return { problem: '坐标是 (0,0)：这是占位值而不是真实位置，请给出该要素的真实 WGS84 经纬度' }
  return { point: [lon, lat] }
}

function distinctCount(points: Array<[number, number]>): number {
  return new Set(points.map(point => `${point[0]},${point[1]}`)).size
}

function polygonArea(points: Array<[number, number]>): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[(i + 1) % points.length]!
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

/** 近似球面距离（度）：经度差按纬度余弦缩放，足以判断「离群几十度」 */
function degreeDistance(a: [number, number], b: [number, number]): number {
  const cos = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180)
  return Math.hypot((a[0] - b[0]) * cos, a[1] - b[1])
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export interface FeatureSubmissionContext {
  brief: MapBrief
  /** 本阶段已登记的来源（S1…），摘录是模型实际读到的正文/摘要 */
  sources: MapResearchSource[]
  /** 本阶段真正问过的检索适配器 */
  searchedAdapters: string[]
  requiredAdapters: string[]
  /** 已由人工确认（非 proposed）的几何：模型不能改写 */
  confirmed: MapSpec | null
  extent?: unknown
  relations?: unknown
  datasetQueries?: MapDatasetQuery[]
}

/**
 * 校验模型提交的地理要素。任何一处不合格整批拒收，并逐条说明。
 * 合格时返回落库形状（MapResearchFeature），字段原样取自提交，不做降级或补齐。
 */
function validateFeatureGeometry(raw: unknown, ctx: FeatureSubmissionContext): { features: MapResearchFeature[]; problems: string[] } {
  const problems: string[] = []
  const missingAdapters = ctx.requiredAdapters.filter(adapter => !ctx.searchedAdapters.includes(adapter))
  if (missingAdapters.length) {
    problems.push(`这些检索来源本阶段还没有真正检索过：${missingAdapters.join('、')}。每个来源至少用 search_sources 检索一次（零命中也要检索）`)
  }
  if (!Array.isArray(raw) || !raw.length) {
    problems.push('features 必须是非空数组：至少提交一个有资料依据的地理要素')
    return { features: [], problems }
  }
  if (raw.length > MAX_FEATURES) problems.push(`要素数 ${raw.length} 超过上限 ${MAX_FEATURES}，请合并或删减`)

  const byId = new Map(ctx.sources.map(source => [source.id, source]))
  const confirmedNames = new Map<string, MapFeatureKind>()
  for (const place of ctx.confirmed?.places ?? []) if (place.proposed !== true) confirmedNames.set(place.name, 'place')
  for (const route of ctx.confirmed?.routes ?? []) if (route.proposed !== true) confirmedNames.set(route.name, 'route')
  for (const region of ctx.confirmed?.regions ?? []) if (region.proposed !== true) confirmedNames.set(region.name, 'region')

  const features: MapResearchFeature[] = []
  const coords: Array<{ index: number; point: [number, number] }> = []
  const farReason = new Map<number, string>()
  const seenNames = new Set<string>()

  raw.slice(0, MAX_FEATURES).forEach((item, index) => {
    const label = `features[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${label} 必须是对象`)
      return
    }
    const record = item as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const tag = name ? `${label}「${name}」` : label
    const local: string[] = []
    if (!name) local.push('name 必填')
    const kind = record.kind as MapFeatureKind
    if (!FEATURE_KINDS.includes(kind)) local.push(`kind 必须是 place / route / region，当前是 ${describe(record.kind)}`)
    if (name && FEATURE_KINDS.includes(kind)) {
      const key = `${kind}:${name}`
      if (seenNames.has(key)) local.push('与前面的要素同名同类，请合并成一条')
      seenNames.add(key)
      if (confirmedNames.has(name)) {
        local.push('这个要素已由人工确认，模型不能改写；请从提交中删去（人工确认的几何会自动保留在地图里）')
      }
    }

    const sourceIds = Array.isArray(record.source_ids) ? record.source_ids.map(String) : []
    const unknownIds = sourceIds.filter(id => !byId.has(id))
    if (!sourceIds.length && record.geometry_source !== 'dataset') local.push('source_ids 必须至少引用一条本阶段检索到的来源（如 ["S3"]）')
    if (unknownIds.length) local.push(`source_ids 引用了不存在的来源 ${unknownIds.join('、')}；可用来源是 ${[...byId.keys()].join('、') || '（尚无，请先检索）'}`)

    const basis = record.coordinate_basis as MapCoordinateBasis
    if (!BASES.includes(basis)) local.push(`coordinate_basis 必须是 excerpt / well_known / approximate_schematic，当前是 ${describe(record.coordinate_basis)}`)
    const uncertainty = record.uncertainty as MapResearchFeature['uncertainty']
    if (!(UNCERTAINTIES as readonly string[]).includes(String(uncertainty))) local.push(`uncertainty 必须是 high / medium / low，当前是 ${describe(record.uncertainty)}`)
    const basisText = typeof record.basis === 'string' ? record.basis.trim() : ''
    if (!basisText) local.push('basis 必填：用一句话说明坐标是怎么来的')
    const supporting = typeof record.supporting_excerpt === 'string' ? record.supporting_excerpt.trim() : ''
    let verified = false
    if (basis === 'excerpt') {
      const key = matchKey(supporting)
      verified = key.length >= 6 && sourceIds.some(id => matchKey(byId.get(id)?.excerpt ?? '').includes(key))
      if (!verified) {
        local.push('coordinate_basis=excerpt 时 supporting_excerpt 必须逐字复制自所引来源的正文（至少 6 个字）；'
          + '当前原句在所引来源里查不到。请用 read_source 读正文后逐字复制，或如实改成 well_known / approximate_schematic')
      }
    }

    let lon: number | null = null
    let lat: number | null = null
    let points: Array<[number, number]> = []
    if (kind === 'place') {
      const read = readLonLat([record.lon, record.lat])
      if ('problem' in read) local.push(`lon/lat：${read.problem}`)
      else {
        [lon, lat] = read.point
        coords.push({ index, point: read.point })
      }
      if (record.points !== undefined && record.points !== null && !(Array.isArray(record.points) && !record.points.length)) {
        local.push('place 只用 lon/lat，不要写 points')
      }
    } else if (kind === 'route' || kind === 'region') {
      if (record.lon !== undefined && record.lon !== null || record.lat !== undefined && record.lat !== null) {
        local.push(`${kind} 不使用 lon/lat（当前 lon=${describe(record.lon)} lat=${describe(record.lat)}），请删除这两个字段或写 null`)
      }
      const rawPoints = Array.isArray(record.points) ? record.points : []
      rawPoints.forEach((point, pointIndex) => {
        const read = readLonLat(point)
        if ('problem' in read) local.push(`points[${pointIndex}]：${read.problem}`)
        else {
          points.push(read.point)
          coords.push({ index, point: read.point })
        }
      })
      if (kind === 'route' && distinctCount(points) < 2) local.push('route 的 points 至少要有 2 个不同的合法顶点')
      if (kind === 'region') {
        if (!ctx.brief.schematic && record.geometry_source !== 'dataset') {
          local.push('当前需求没有开启示意图模式，不能提交面状范围（region）：请改成 place（给出能代表它的经纬度及依据）或删掉该要素')
        } else if (distinctCount(points) < 3 || polygonArea(points) < 1e-9) {
          local.push('region 的 points 至少要有 3 个不同且不共线的顶点')
        }
      }
    }
    const far = typeof record.far_from_others_reason === 'string' ? record.far_from_others_reason.trim() : ''
    if (far) farReason.set(index, far)

    const conflicts: MapFeatureConflict[] = Array.isArray(record.conflicts)
      ? record.conflicts.flatMap((conflict): MapFeatureConflict[] => {
        if (!conflict || typeof conflict !== 'object') return []
        const c = conflict as Record<string, unknown>
        return [{
          source_id: String(c.source_id ?? ''),
          lon: typeof c.lon === 'number' && Number.isFinite(c.lon) ? c.lon : null,
          lat: typeof c.lat === 'number' && Number.isFinite(c.lat) ? c.lat : null,
          note: String(c.note ?? ''),
        }]
      })
      : []

    if (local.length) {
      problems.push(`${tag}：${local.join('；')}`)
      return
    }
    const primary = byId.get(sourceIds[0]!)
    features.push({
      id: `F${features.length + 1}`,
      kind,
      name,
      lon,
      lat,
      points: kind === 'place' ? [] : points,
      coordinate_basis: basis,
      basis: basisText.slice(0, 1000),
      supporting_excerpt: supporting.slice(0, 1000),
      excerpt_verified: verified,
      source_ids: sourceIds,
      source_url: primary?.url ?? null,
      source_title: primary?.title ?? '',
      uncertainty,
      approximate: record.approximate === true || basis === 'approximate_schematic',
      conflicts,
    })
  })

  // 离群：坐标与全体中位点相距过远（例如抄了模板占位、填错半球）。模型确认无误时写 far_from_others_reason。
  if (coords.length >= 4) {
    const centre: [number, number] = [median(coords.map(c => c.point[0])), median(coords.map(c => c.point[1]))]
    const distances = coords.map(c => degreeDistance(c.point, centre))
    const limit = Math.max(OUTLIER_MIN_DEG, OUTLIER_MAD_FACTOR * median(distances))
    const flagged = new Map<number, Array<[number, number]>>()
    coords.forEach((c, i) => {
      if (distances[i]! <= limit || farReason.has(c.index)) return
      flagged.set(c.index, [...(flagged.get(c.index) ?? []), c.point])
    })
    for (const [index, pts] of flagged) {
      const name = (raw[index] as Record<string, unknown>)?.name
      problems.push(`features[${index}]「${String(name ?? '')}」的坐标 ${pts.map(p => `(${p[0]}, ${p[1]})`).join('、')} `
        + `距其余要素的中位点 (${centre[0].toFixed(2)}, ${centre[1].toFixed(2)}) 超过 ${limit.toFixed(1)}°，明显离群；`
        + '请核对是否填错或抄了占位值；确属远处要素时在该要素上写 far_from_others_reason 说明依据')
    }
  }
  return { features: problems.length ? [] : features, problems }
}

/** Research accuracy contract: resolve trusted geometry, reject hard errors, then evaluate evidence. */
export function validateFeatureSubmission(raw: unknown, ctx: FeatureSubmissionContext): { features: MapResearchFeature[]; problems: string[]; relations: MapRelation[] } {
  const problems: string[] = []
  const relations: MapRelation[] = []
  if (!validExtent(ctx.extent)) problems.push('extent 必填，必须为合法 [west,south,east,north] 且 west<east、south<north')
  if (validExtent(ctx.extent) && ctx.confirmed) {
    for (const feature of specFeatures(ctx.confirmed)) {
      const item = [...ctx.confirmed.places, ...ctx.confirmed.routes, ...ctx.confirmed.regions].find(item => item.id === feature.id)
      if (item?.proposed !== true) problems.push(...extentProblems(feature.coords, ctx.extent, { dataset: item?.origin === 'dataset' }).map(message => `已确认要素「${feature.name}」：${message}`))
    }
  }
  if (!Array.isArray(raw)) return { features: [], problems: [...problems, 'features 必须是数组'], relations }
  const records = raw.map(item => item && typeof item === 'object' && !Array.isArray(item) ? { ...item } as Record<string, unknown> : {})
  const geometries = new Map<number, ExtractedDatasetGeometry>()
  const missing = new Set<number>()
  const categories = ['river', 'lake', 'coast', 'mountain', 'settlement', 'route', 'territory', 'other']
  records.forEach((record, index) => {
    const tag = `features[${index}]「${String(record.name ?? '')}」`
    if (!categories.includes(String(record.category))) problems.push(`${tag} category 必须为 ${categories.join(' / ')}`)
    if (!['dataset', 'source', 'model'].includes(String(record.geometry_source))) problems.push(`${tag} geometry_source 必须为 dataset / source / model`)
    const natural = ['river', 'lake', 'coast', 'mountain'].includes(String(record.category))
    if (record.geometry_source === 'dataset') {
      if (['points', 'lon', 'lat', 'parts'].some(key => record[key] !== undefined)) problems.push(`${tag} dataset 不得手写 points/lon/lat/parts，只提交 dataset_ref`)
      const ref = record.dataset_ref as { ref?: string; clip_bbox?: [number, number, number, number] } | undefined
      if (!ref?.ref) { problems.push(`${tag} dataset_ref.ref 必填`); return }
      if (ref.clip_bbox !== undefined && !validExtent(ref.clip_bbox)) { problems.push(`${tag} clip_bbox 非法`); return }
      try {
        const geometry = extractDatasetGeometry(ref.ref, ref.clip_bbox)
        geometries.set(index, geometry)
        if (record.kind !== geometry.kind) problems.push(`${tag} dataset 几何为 ${geometry.kind}，请修正 kind`)
        if (natural && geometry.layer !== record.category) problems.push(`${tag} category=${String(record.category)} 与 dataset 图层 ${geometry.layer} 不符`)
        if (geometry.kind === 'place') { record.lon = geometry.lon; record.lat = geometry.lat }
        else record.points = geometry.parts[0]
      } catch (err) { problems.push(`${tag}：${err instanceof Error ? err.message : String(err)}`) }
    } else if (natural) {
      const claim = record.dataset_missing as { queries?: unknown; reason?: unknown } | undefined
      const queries = Array.isArray(claim?.queries) ? claim.queries : []
      const searched = queries.length > 0 && queries.every(query => {
        if (typeof query !== 'string') return false
        const attempts = ctx.datasetQueries?.filter(q => q.layer === record.category && q.query === query) ?? []
        if (!attempts.length) return false
        const keys = [query, String(record.name ?? '')].map(name => matchKey(name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()).replace(/[-_]/g, ''))
        return attempts.every(attempt => {
          if (attempt.error) return false
          if (!attempt.hits) return true
          if (!attempt.refs?.length) return false
          try {
            return attempt.refs.every(ref => extractDatasetGeometry(ref).names.every(name => !keys.includes(matchKey(name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()).replace(/[-_]/g, ''))))
          } catch { return false }
        })
      })
      if (!searched || typeof claim?.reason !== 'string' || !claim.reason.trim()) problems.push(`${tag} 自然要素必须取自 dataset；dataset_missing 必须引用本阶段 search_dataset 真正查过、没有同名候选的 query，并说明原因`)
      else missing.add(index)
    }
  })
  const base = validateFeatureGeometry(records, ctx)
  problems.push(...base.problems)
  if (problems.length) return { features: [], problems, relations }
  const features = base.features
  const acknowledgements = new Map<string, Set<string>>()
  features.forEach((feature, index) => {
    const record = records[index]!
    const geometry = geometries.get(index)
    feature.category = record.category as MapFeatureCategory
    feature.origin = record.geometry_source as MapFeatureOrigin
    feature.parts = geometry?.kind !== 'place' ? geometry?.parts : undefined
    if (geometry) feature.dataset_ref = record.dataset_ref as NonNullable<MapResearchFeature['dataset_ref']>
    const points = geometry ? geometry.kind === 'place' ? [[geometry.lon!, geometry.lat!] as [number, number]] : geometry.parts.flat() : feature.kind === 'place' ? [[feature.lon!, feature.lat!] as [number, number]] : feature.points
    if (validExtent(ctx.extent)) problems.push(...extentProblems(points, ctx.extent, { dataset: record.geometry_source === 'dataset' }).map(message => `「${feature.name}」：${message}`))
    const ack = new Set<string>()
    for (const item of Array.isArray(record.acknowledge) ? record.acknowledge : []) {
      if (item && typeof item === 'object' && typeof item.code === 'string' && typeof item.reason === 'string' && item.reason.trim()) ack.add(item.code)
    }
    acknowledgements.set(feature.name, ack)
    const verified = feature.origin === 'dataset' || !feature.approximate && feature.kind === 'place' && feature.excerpt_verified && excerptSupportsPoint(feature.supporting_excerpt, [feature.lon!, feature.lat!])
    const missingClaim = record.dataset_missing
    const missingReason = missingClaim && typeof missingClaim === 'object' && 'reason' in missingClaim ? String(missingClaim.reason) : ''
    const missingQueries = missingClaim && typeof missingClaim === 'object' && 'queries' in missingClaim ? missingClaim.queries : []
    feature.verification = missing.has(index) ? { status: 'needs_user', reasons: [`dataset_missing：${missingReason}；检索 ${JSON.stringify(missingQueries)}，请人工裁决`] }
      : verified ? { status: 'verified', reasons: [feature.origin === 'dataset' ? `数据集 ${feature.dataset_ref?.ref}` : '来源正文中的经纬度与该点相差不超过 0.1°'] }
        : { status: 'unverified', reasons: ['坐标尚无可核验的原文经纬度或相对位置证据'] }
    if (feature.origin !== 'dataset' && feature.kind === 'place' && Math.abs(feature.lon! - feature.lat!) < 0.25) {
      const message = `lon_lat_similar：「${feature.name}」经度与纬度相差小于 0.25°，疑似抄错`
      if (!ack.has('lon_lat_similar')) problems.push(message)
      feature.verification = { status: 'conflict', reasons: [...feature.verification.reasons, message, ...(Array.isArray(record.acknowledge) ? record.acknowledge.filter(a => a?.code === 'lon_lat_similar').map(a => String(a.reason)) : [])] }
    }
  })
  const named = new Map<string, { point: [number, number]; parts: Array<Array<[number, number]>>; verified: boolean; datasetRiver: boolean; feature?: MapResearchFeature }>(
    features.map(f => [f.name, { point: (f.kind === 'place' ? [f.lon!, f.lat!] : f.points[0]!) as [number, number], parts: f.parts ?? [f.points], verified: f.verification?.status === 'verified', datasetRiver: f.category === 'river' && f.origin === 'dataset', feature: f }]))
  for (const f of [...ctx.confirmed?.places ?? [], ...ctx.confirmed?.routes ?? [], ...ctx.confirmed?.regions ?? []]) {
    if (!named.has(f.name) && (f.proposed !== true || f.verification?.status === 'verified')) named.set(f.name, { point: ('lon' in f ? [f.lon, f.lat] : f.points[0]!) as [number, number], parts: 'points' in f ? [f.points] : [], verified: true, datasetRiver: f.category === 'river' && f.origin === 'dataset' })
  }
  const relationNames = [...features, ...[...ctx.confirmed?.places ?? [], ...ctx.confirmed?.routes ?? [], ...ctx.confirmed?.regions ?? []].filter(f => !features.some(feature => feature.name === f.name) && (f.proposed !== true || f.verification?.status === 'verified'))]
  if (ctx.relations !== undefined && !Array.isArray(ctx.relations)) problems.push('relations 必须为数组')
  for (const item of Array.isArray(ctx.relations) ? ctx.relations : []) {
    const r = item as Omit<MapRelation, 'computed' | 'message'>
    const subject = named.get(r?.subject), object = named.get(r?.object)
    const source = ctx.sources.find(s => s.id === r?.source_id)
    if (r && [r.subject, r.object].some(name => relationNames.filter(f => f.name === name).length > 1)) {
      problems.push(`relations ${String(r.id)} 引用重名要素，名称不能唯一定位；请区分名称后重交`); continue
    }
    if (!r || !r.id || !subject || !object || !['distance_km', 'east_of', 'west_of', 'north_of', 'south_of', 'near_river'].includes(r.relation)
      || typeof r.excerpt !== 'string' || matchKey(r.excerpt).length < 6 || !matchKey(source?.excerpt ?? '').includes(matchKey(r.excerpt))
      || r.relation === 'distance_km' && !(typeof r.value_km === 'number' && Number.isFinite(r.value_km) && r.value_km >= 0)
      || r.tolerance_km !== undefined && !(typeof r.tolerance_km === 'number' && Number.isFinite(r.tolerance_km) && r.tolerance_km >= 0)) {
      problems.push(`relations ${String(r?.id ?? '')} 非法：subject/object 必须指向本批或已核验要素，excerpt 必须逐字引用 source_id 正文，距离及容差必须为非负数字`); continue
    }
    if (r.relation === 'near_river' && !object.datasetRiver) { problems.push(`relations ${r.id} near_river 必须指向数据集河流`); continue }
    const computed = computeRelation(r, subject.point, object.point, object.parts)
    relations.push(computed)
    for (const name of [r.subject, r.object]) {
      const feature = named.get(name)?.feature
      if (!feature) continue
      feature.relations = [...feature.relations ?? [], computed]
      if (!computed.computed.consistent && name === r.subject) {
        const message = `relation_conflict：${computed.message}`
        if (!acknowledgements.get(name)?.has('relation_conflict')) problems.push(message)
        const record = records.find(item => item.name === name)
        const reasons = (Array.isArray(record?.acknowledge) ? record.acknowledge : []).filter(a => a?.code === 'relation_conflict').map(a => String(a.reason))
        feature.verification = { status: 'conflict', reasons: [...feature.verification?.reasons ?? [], message, ...reasons] }
        named.get(name)!.verified = false
      }
    }
  }
  // Only consistent relations anchored to independently verified/confirmed geometry can verify another point.
  for (let pass = 0; pass < features.length; pass++) for (const relation of relations) {
    if (!relation.computed.consistent) continue
    for (const [name, other] of [[relation.subject, relation.object], [relation.object, relation.subject]]) {
      const entry = named.get(name!), anchor = named.get(other!)
      if (!entry?.feature || !anchor?.verified || entry.feature.approximate || entry.feature.verification?.status !== 'unverified') continue
      entry.verified = true
      entry.feature.verification = { status: 'verified', reasons: [`关系证据一致：${relation.message}`] }
    }
  }
  return { features: problems.length ? [] : features, problems, relations }
}

// ───────────────────────────── 取景 ─────────────────────────────

export interface SpecFeature {
  id: string
  kind: MapFeatureKind
  name: string
  /** place 为单点；route/region 为顶点序列 */
  coords: Array<[number, number]>
  origin?: MapFeatureOrigin
}

export function specFeatures(spec: MapSpec): SpecFeature[] {
  return [
    ...spec.places.map((place): SpecFeature => ({ id: place.id, kind: 'place', name: place.name, origin: place.origin, coords: [[place.lon, place.lat]] })),
    ...spec.routes.map((route): SpecFeature => ({ id: route.id, kind: 'route', name: route.name, origin: route.origin, coords: route.points })),
    ...(spec.regions ?? []).map((region): SpecFeature => ({ id: region.id, kind: 'region', name: region.name, origin: region.origin, coords: region.points })),
  ]
}

/** Project the actual feature, so detached/moved geometry cannot disguise a far-away label. */
export function projectedLabelFeatures(features: SpecFeature[], registration: MapRegistration): LabelFeature[] {
  const forward = forwardFor(registration)
  return features.map(feature => ({
    id: feature.id, kind: feature.kind,
    points: feature.coords.flatMap(coord => {
      const pixel = forward(coord)
      return pixel ? [[pixel[0] / registration.width, pixel[1] / registration.height] as [number, number]] : []
    }),
  }))
}

export interface FrameFeature {
  id: string
  kind: MapFeatureKind
  name: string
  /** 每个顶点的归一化坐标（x 对宽、y 对高）；不可见为 null */
  normalized: Array<[number, number] | null>
}

export interface FrameReport {
  features: FrameFeature[]
  /** 全部可见顶点外包框占画面的宽 / 高比例 */
  extent: { w: number; h: number } | null
  problems: string[]
}

const round4 = (value: number) => Math.round(value * 10000) / 10000

/** 底图取景校验：每个要素都必须在画内（留边距），且要素整体占画面主体 */
export function frameReport(features: SpecFeature[], registration: MapRegistration): FrameReport {
  const forward = forwardFor(registration)
  const problems: string[] = []
  const all: Array<[number, number]> = []
  const report = features.map((feature): FrameFeature => {
    const normalized = feature.coords.map((coord) => {
      const px = forward(coord)
      if (!px) return null
      const n: [number, number] = [round4(px[0] / registration.width), round4(px[1] / registration.height)]
      all.push(n)
      return n
    })
    const label = `要素「${feature.name}」(id ${feature.id})`
    if (normalized.some(item => item === null)) problems.push(`${label} 在当前取景下不可见（地平线之后）`)
    const outside = normalized.filter((n): n is [number, number] => !!n
      && (n[0] < FRAME_MARGIN || n[1] < FRAME_MARGIN || n[0] > 1 - FRAME_MARGIN || n[1] > 1 - FRAME_MARGIN))
    if (outside.length) {
      problems.push(`${label} 有 ${outside.length} 个顶点落在画外或贴边，例如归一化坐标 (${outside[0]![0]}, ${outside[0]![1]})；`
        + `所有顶点都必须落在 [${FRAME_MARGIN}, ${1 - FRAME_MARGIN}] 内，请调整 bbox`)
    }
    return { id: feature.id, kind: feature.kind, name: feature.name, normalized }
  })
  let extent: FrameReport['extent'] = null
  if (all.length) {
    const xs = all.map(p => p[0])
    const ys = all.map(p => p[1])
    extent = { w: round4(Math.max(...xs) - Math.min(...xs)), h: round4(Math.max(...ys) - Math.min(...ys)) }
    if (distinctCount(all) >= 2 && Math.max(extent.w, extent.h) < FRAME_MIN_EXTENT) {
      problems.push(`全部要素只占画面宽 ${(extent.w * 100).toFixed(1)}%、高 ${(extent.h * 100).toFixed(1)}%，`
        + `最大边不足画面的 ${FRAME_MIN_EXTENT * 100}%：取景过大，主题挤在画面一小块里；请收小 bbox 让要素占画面主体`)
    }
  }
  if (!features.length) problems.push('地图几何里没有任何要素，无法判断取景；请回退到资料检索补充要素')
  return { features: report, extent, problems }
}

// ───────────────────────────── 图层作图 ─────────────────────────────

const GEOMETRY_TYPE: Record<MapFeatureKind, Layer['type']> = { place: 'marker', route: 'polyline', region: 'polygon' }

const GEOMETRY_LAYER_TYPES: Layer['type'][] = ['marker', 'polyline', 'polygon']

function layerPoints(layer: Layer): Array<[number, number]> {
  if (layer.type === 'marker') return [layer.at]
  if (layer.type === 'polyline' || layer.type === 'polygon') return layer.points
  return []
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function polylineDistance(p: [number, number], line: Array<[number, number]>, closed: boolean): number {
  if (line.length === 1) return Math.hypot(p[0] - line[0]![0], p[1] - line[0]![1])
  let best = Infinity
  const count = closed ? line.length : line.length - 1
  for (let i = 0; i < count; i++) best = Math.min(best, segmentDistance(p, line[i]!, line[(i + 1) % line.length]!))
  return best
}

/** 非零环绕规则（与 SVG polygon 默认 fill-rule 一致）判断点是否被面覆盖 */
function windingContains(polygon: Array<[number, number]>, p: [number, number]): boolean {
  let winding = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!
    const [x2, y2] = polygon[(i + 1) % polygon.length]!
    const cross = (x2 - x1) * (p[1] - y1) - (p[0] - x1) * (y2 - y1)
    if (y1 <= p[1]) {
      if (y2 > p[1] && cross > 0) winding++
    } else if (y2 <= p[1] && cross < 0) winding--
  }
  return winding !== 0
}

/**
 * 不透明填充面对底图的遮盖：按网格采样（非零环绕，与渲染同口径），返回总覆盖比例与逐层比例。
 * 地图的意义在于底图上的真实地理；大面积不透明填充会把它整片盖掉（例如把画框画成实心面）。
 */
export function opaqueFillCoverage(doc: LayerDoc): { total: number; layers: Array<{ id: string; ratio: number }> } {
  const preset = THEME_PRESETS[doc.theme].polygon
  const opaque = doc.layers.filter((layer): layer is Extract<Layer, { type: 'polygon' }> => {
    if (layer.type !== 'polygon' || !layer.visible) return false
    const fillOpacity = typeof layer.style.fill_opacity === 'number' ? layer.style.fill_opacity : Number(preset.fill_opacity)
    return layer.opacity * fillOpacity >= OPAQUE_FILL_ALPHA && layer.style.fill !== 'none'
  })
  const hits = new Map<string, number>()
  let covered = 0
  for (let gy = 0; gy < COVER_GRID_Y; gy++) {
    for (let gx = 0; gx < COVER_GRID_X; gx++) {
      const p: [number, number] = [(gx + 0.5) / COVER_GRID_X, (gy + 0.5) / COVER_GRID_Y]
      let any = false
      for (const layer of opaque) {
        if (!windingContains(layer.points, p)) continue
        any = true
        hits.set(layer.id, (hits.get(layer.id) ?? 0) + 1)
      }
      if (any) covered++
    }
  }
  const cells = COVER_GRID_X * COVER_GRID_Y
  return {
    total: covered / cells,
    layers: [...hits].map(([id, count]) => ({ id, ratio: count / cells })).sort((a, b) => b.ratio - a.ratio),
  }
}

export interface OmittedFeature {
  feature_id: string
  reason: string
}

/**
 * 作图交付校验：每个要素都有锚定（anchor.semantic_id = 要素 id）的几何图层，或被显式省略并说明理由；
 * 几何图层的位置与该要素经登记件投影的位置一致（容差内）。
 */
export function drawingProblems(input: {
  doc: LayerDoc
  features: SpecFeature[]
  registration: MapRegistration
  omitted: unknown
  layerOptions?: LayerOptions
}): { problems: string[]; omitted: OmittedFeature[] } {
  const { doc, features, registration } = input
  const rendered = renderCopyWithSmoothing(doc, input.layerOptions)
  const problems: string[] = labelProblems(rendered, doc.base, projectedLabelFeatures(features, registration)).map(problem => problem.message)
  const forward = forwardFor(registration)
  const width = registration.width
  const height = registration.height
  const tolerance = Math.max(GEOMETRY_TOLERANCE_MIN_PX, GEOMETRY_TOLERANCE_RATIO * Math.max(width, height))
  const known = new Map(features.map(feature => [feature.id, feature]))

  const omitted: OmittedFeature[] = []
  if (input.omitted !== undefined && input.omitted !== null && !Array.isArray(input.omitted)) {
    problems.push('omitted 必须是数组：[{ "feature_id": "...", "reason": "..." }]')
  }
  for (const [index, item] of (Array.isArray(input.omitted) ? input.omitted : []).entries()) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const id = String(record.feature_id ?? '')
    const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
    if (!known.has(id)) problems.push(`omitted[${index}].feature_id=${describe(record.feature_id)} 不是本图的要素 id；可用 id：${[...known.keys()].join('、')}`)
    else if (!reason) problems.push(`omitted[${index}]（${id}）必须写明省略理由`)
    else omitted.push({ feature_id: id, reason })
  }
  const omittedIds = new Set(omitted.map(item => item.feature_id))

  const byFeature = new Map<string, Layer[]>()
  for (const layer of doc.layers) {
    if (!GEOMETRY_LAYER_TYPES.includes(layer.type)) continue
    const id = layer.anchor?.semantic_id
    if (!id) continue
    if (!known.has(id)) {
      problems.push(`图层 ${layer.id} 的 anchor.semantic_id=${describe(id)} 不是本图的要素 id；可用 id：${[...known.keys()].join('、')}`)
      continue
    }
    byFeature.set(id, [...(byFeature.get(id) ?? []), layer])
  }

  for (const feature of features) {
    const label = `要素「${feature.name}」(id ${feature.id})`
    const layers = byFeature.get(feature.id) ?? []
    if (omittedIds.has(feature.id)) {
      if (layers.length) problems.push(`${label} 同时出现在 omitted 和锚定图层里，二选一`)
      continue
    }
    const expectedType = GEOMETRY_TYPE[feature.kind]
    if (!layers.length) {
      problems.push(`${label} 没有锚定的几何图层：需要一个 type=${expectedType} 且 anchor.semantic_id="${feature.id}" 的图层；确实不画时写进 omitted 并说明理由`)
      continue
    }
    if (layers.length > 1) {
      problems.push(`${label} 有 ${layers.length} 个锚定的几何图层（${layers.map(l => l.id).join('、')}），只能有一个；文字标签用 label 图层另行锚定`)
      continue
    }
    const layer = layers[0]!
    if (layer.type !== expectedType) {
      problems.push(`${label} 是 ${feature.kind}，锚定图层 ${layer.id} 必须是 type=${expectedType}，当前是 ${layer.type}`)
      continue
    }
    if (!layer.visible) problems.push(`${label} 的锚定图层 ${layer.id} 是隐藏的（visible=false），成图里看不到`)
    const expected = feature.coords.map(coord => forward(coord))
    if (expected.some(px => px === null)) {
      problems.push(`${label} 在当前底图下不可见，无法绘制；请回退到底图阶段调整取景`)
      continue
    }
    const expectedPx = expected as Array<[number, number]>
    const drawnPx = layerPoints(layer).map((p): [number, number] => [p[0] * width, p[1] * height])
    const closed = feature.kind === 'region'
    const fmt = (p: [number, number]) => `(${round4(p[0] / width)}, ${round4(p[1] / height)})`
    const missed = expectedPx.filter(px => polylineDistance(px, drawnPx, closed) > tolerance)
    if (missed.length) {
      problems.push(`${label} 的图层 ${layer.id} 偏离了要素的投影位置（容差 ${tolerance.toFixed(0)}px）：`
        + `应经过归一化坐标 ${missed.slice(0, 4).map(fmt).join('、')}${missed.length > 4 ? ` 等 ${missed.length} 处` : ''}；`
        + '请用 geo_to_pixel 换算后照写')
      continue
    }
    const stray = drawnPx.filter(px => polylineDistance(px, expectedPx, closed) > tolerance)
    if (stray.length) {
      problems.push(`${label} 的图层 ${layer.id} 有 ${stray.length} 个点离开了要素本身的走向（例如 ${fmt(stray[0]!)}），几何必须贴合要素`)
    }
  }
  const coverage = opaqueFillCoverage(rendered)
  if (coverage.total > OPAQUE_COVER_LIMIT) {
    problems.push(`不透明的填充面盖住了画面的 ${(coverage.total * 100).toFixed(0)}%（上限 ${OPAQUE_COVER_LIMIT * 100}%），底图上的地理会被遮掉：`
      + coverage.layers.map(item => `${item.id} 约 ${(item.ratio * 100).toFixed(0)}%`).join('、')
      + '。画框/边框请用 polyline 或空心描边（fill_opacity 设为 0），大范围示意面请把 fill_opacity 调到 0.5 以下')
  }
  return { problems, omitted }
}

export interface DrawnGeometry {
  width: number
  height: number
  points: Array<{ id: string; name: string; at: [number, number] }>
  routes: Array<{ id: string; name: string; points: Array<[number, number]>; color: string }>
  regions: Array<{ id: string; name: string; points: Array<[number, number]> }>
}

/**
 * 从成图的 LayerDoc 导出语义几何（像素坐标）：锚定的 marker/polyline/polygon 就是语义条目，
 * 与成图同源。没有锚定、或锚定到未知要素的图层不进语义。
 */
export function drawnGeometryOf(doc: LayerDoc, features: SpecFeature[]): DrawnGeometry {
  const width = doc.base.width
  const height = doc.base.height
  const known = new Map(features.map(feature => [feature.id, feature]))
  const px = (p: [number, number]): [number, number] => [round4(p[0] * width), round4(p[1] * height)]
  const result: DrawnGeometry = { width, height, points: [], routes: [], regions: [] }
  for (const layer of doc.layers) {
    if (!GEOMETRY_LAYER_TYPES.includes(layer.type)) continue
    const id = layer.anchor?.semantic_id
    const feature = id ? known.get(id) : undefined
    if (!id || !feature || !layer.visible) continue
    const name = feature.name || layer.anchor?.semantic_name || id
    if (layer.type === 'marker') result.points.push({ id, name, at: px(layer.at) })
    else if (layer.type === 'polyline') {
      const color = typeof layer.style.stroke === 'string' && layer.style.stroke
        ? layer.style.stroke
        : String(THEME_PRESETS[doc.theme].polyline.stroke)
      result.routes.push({ id, name, points: layer.points.map(px), color })
    } else if (layer.type === 'polygon') result.regions.push({ id, name, points: layer.points.map(px) })
  }
  return result
}
