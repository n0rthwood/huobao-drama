/**
 * 成图版本身份与图层查看器的只读模型（Issue #126 阶段 1）。
 *
 * 数据只取「已记录的、可证明同源」的证据：
 * - 当前成图：detail.outputs.final_image；
 * - 历史成图：history 条目里的 snapshot.outputs.final_image（history 只作审计窗口，不冒充永久快照）；
 * - 发布 revision：快照第一次出现在 history 里的 revision 减一（快照保存的是变更前状态），
 *   无法证明时就是 null，显示「未记录 / Not recorded」，绝不拿当前 task revision 拼一个。
 *
 * durable pinned 载荷与快照读取接口是后续阶段（G2）；这里不新增保存路径，也不从当前语义补旧图。
 * 图层描述消费 #125 字段（description/keywords/manual/name_manual/source），缺失时降级几何摘要。
 */
import type {
  MapFeatureMetadata,
  MapImageRef,
  MapResearch,
  MapResearchFeature,
  MapSpec,
  MapStudioDetail,
  MapStudioOutputs,
} from '~/map-studio/api'
import { mediaUrl } from '~/utils/url'

export type MapVersionKind = 'final' | 'previous' | 'base'

export interface MapSnapshotPayload {
  /** 发布 revision（可证明时）；null = 未记录 */
  revision: number | null
  outputs: MapStudioOutputs
  spec: MapSpec | null
  research: MapResearch | null
  origin: 'current' | 'history'
}

export interface MapImageVersion {
  /** task_id + published_revision + artifact_kind；revision 未记录时用 unrecorded 明确标出 */
  snapshotId: string
  kind: MapVersionKind
  path: string
  url: string
  width: number
  height: number
  runId: number | null
  source: string
  publishedRevision: number | null
  payload: MapSnapshotPayload
}

export interface MapImageState {
  /** 当前成图在前，其余按发布 revision 降序；空 = 没有可验证成图 */
  versions: MapImageVersion[]
  current: MapImageVersion | null
  previous: MapImageVersion | null
  base: MapImageVersion | null
  /** 默认选择：本轮成图 > 上一版 > 底图 > null */
  defaultSelection: string | null
}

function versionOf(detail: MapStudioDetail, image: MapImageRef, kind: MapVersionKind, revision: number | null, payload: MapSnapshotPayload): MapImageVersion {
  return {
    snapshotId: `${detail.task_id}:${revision ?? 'unrecorded'}:${kind === 'previous' ? 'final' : kind}`,
    kind,
    path: image.path,
    url: mediaUrl(image.path),
    width: image.width,
    height: image.height,
    runId: image.run_id,
    source: image.source,
    publishedRevision: revision,
    payload,
  }
}

/**
 * 版本清单。发布 revision 的推导只用 history 的记录事实：
 * 快照保存的是这次变更 **之前** 的状态，因此某张成图第一次出现在 revision R 的快照里，
 * 说明它是在 R-1 那次变更里发布的；R-1 <= 0 或没有记录时保持 null。
 */
export function mapImageState(detail: MapStudioDetail): MapImageState {
  const ascending = [...detail.history].sort((a, b) => a.revision - b.revision)
  const firstSeen = new Map<string, number>()
  const historyFinals: MapImageVersion[] = []
  for (const entry of ascending) {
    const image = entry.snapshot?.outputs?.final_image
    if (!image) continue
    if (!firstSeen.has(image.path)) firstSeen.set(image.path, entry.revision)
    if (historyFinals.some(version => version.path === image.path)) continue
    const revision = entry.revision > 1 ? entry.revision - 1 : null
    historyFinals.push(versionOf(detail, image, 'final', revision, {
      revision,
      outputs: entry.snapshot!.outputs,
      spec: entry.snapshot!.map_spec ?? null,
      research: entry.snapshot!.research ?? null,
      origin: 'history',
    }))
  }
  historyFinals.sort((a, b) => (b.publishedRevision ?? -1) - (a.publishedRevision ?? -1))

  const currentImage = detail.outputs.final_image
  const current = currentImage
    ? versionOf(detail, currentImage, 'final', firstSeen.has(currentImage.path) ? (firstSeen.get(currentImage.path)! > 1 ? firstSeen.get(currentImage.path)! - 1 : null) : detail.revision, {
      revision: firstSeen.has(currentImage.path) ? (firstSeen.get(currentImage.path)! > 1 ? firstSeen.get(currentImage.path)! - 1 : null) : detail.revision,
      outputs: detail.outputs,
      spec: detail.map_spec,
      research: detail.research,
      origin: 'current',
    })
    : null

  const previous = historyFinals.find(version => version.path !== current?.path) ?? null
  const versions = [...(current ? [current] : []), ...historyFinals.filter(version => version.path !== current?.path)]
  if (previous) previous.kind = 'previous'
  const baseImage = detail.outputs.base_image
  const base = !current && !previous && baseImage
    ? versionOf(detail, baseImage, 'base', detail.revision, { revision: detail.revision, outputs: detail.outputs, spec: detail.map_spec, research: detail.research, origin: 'current' })
    : null
  return {
    versions,
    current,
    previous,
    base,
    defaultSelection: current?.snapshotId ?? previous?.snapshotId ?? base?.snapshotId ?? null,
  }
}

/** 是不是「图与当前几何不一致」：版本 payload 的 spec 与当前 spec 的几何指纹不同（只比较几何，不比较样式记录） */
export function mapVersionGeometryChanged(detail: MapStudioDetail, version: MapImageVersion | null): boolean {
  if (!version) return false
  const snapshot = version.payload.spec
  if (!snapshot) return false
  const geometry = (spec: MapSpec | null) => spec
    ? JSON.stringify({
      bbox: spec.bbox,
      projection: spec.projection,
      places: spec.places.map(item => [item.id, item.name, item.lon, item.lat]),
      routes: spec.routes.map(item => [item.id, item.name, item.points]),
      regions: spec.regions.map(item => [item.id, item.name, item.points]),
    })
    : ''
  return geometry(snapshot) !== geometry(detail.map_spec)
}

/** 从深链值恢复所选版本：只认清单里的 snapshotId；失效给出提示 key，绝不强行选一个陌生版本 */
export function restoreMapSelection(raw: string | null | undefined, state: MapImageState): { snapshotId: string | null; warning: 'invalid' | 'missing' | null } {
  if (!raw) return { snapshotId: state.defaultSelection, warning: null }
  const hit = state.versions.some(version => version.snapshotId === raw) || state.base?.snapshotId === raw
  return hit ? { snapshotId: raw, warning: null } : { snapshotId: state.defaultSelection, warning: 'missing' }
}

export type MapLayerGeometry =
  | { kind: 'point'; lon: number | null; lat: number | null }
  | { kind: 'vertices'; count: number }
  | { kind: 'text'; text: string }
  | { kind: 'unknown' }

export interface MapLayerRow {
  id: string
  type: string
  name: string
  anchorId: string | null
  geometry: MapLayerGeometry
  featureName: string | null
  category: string | null
  /** #125 冻结描述/关键词与所有权；null/空数组 = 该快照未记录 */
  description: string | null
  keywords: string[]
  manual: boolean
  nameManual: boolean
  source: string | null
  /** 研究出处（只解释，不生成内容） */
  basis: string | null
  coordinateBasis: string | null
  excerpt: string | null
  sourceTitles: string[]
  /** 该快照中找不到锚定的语义要素 */
  anchorMissing: boolean
  /** 当前几何已变更：查看器不伪装「定位到当前编辑器」可用 */
  geometryChanged: boolean
}

export interface MapLayerViewerModel {
  /** 无同源 layer_doc：此版本未保存图层数据 */
  available: boolean
  layers: MapLayerRow[]
}

interface LayerLike {
  id: string
  type: string
  name?: string
  text?: string
  at?: [number, number]
  points?: Array<[number, number]>
  anchor?: { semantic_id?: string; semantic_name?: string }
}

function featureOf(payload: MapSnapshotPayload, id: string): (MapFeatureMetadata & { id: string; name: string; lon?: number; lat?: number; points?: Array<[number, number]> }) | null {
  const spec = payload.spec
  if (!spec) return null
  return [...spec.places, ...spec.routes, ...spec.regions].find(item => item.id === id) ?? null
}

function researchFeatureOf(payload: MapSnapshotPayload, id: string): MapResearchFeature | null {
  return payload.research?.features.find(feature => feature.id === id) ?? null
}

/**
 * 层 → 要素映射：只用快照里的 `anchor.semantic_id` 精确匹配（不按名称、不跨类别猜测）。
 * 多层共用同一要素时各自显示同一份冻结描述；没有锚定层只显示自身摘要。
 */
export function mapLayerViewerModel(payload: MapSnapshotPayload, currentSpec: MapSpec | null): MapLayerViewerModel {
  const doc = payload.outputs.layer_doc as { layers?: unknown } | null
  const rawLayers = Array.isArray(doc?.layers) ? doc!.layers as LayerLike[] : []
  if (!rawLayers.length) return { available: false, layers: [] }
  const layers = rawLayers.map((layer): MapLayerRow => {
    const anchorId = layer.anchor?.semantic_id ?? null
    const feature = anchorId ? featureOf(payload, anchorId) : null
    const evidence = anchorId ? researchFeatureOf(payload, anchorId) : null
    const currentFeature = anchorId && currentSpec ? [...currentSpec.places, ...currentSpec.routes, ...currentSpec.regions].find(item => item.id === anchorId) ?? null : null
    const coords = (item: typeof feature) => item
      ? 'lon' in item && typeof item.lon === 'number' ? JSON.stringify([item.lon, item.lat]) : JSON.stringify(item.points ?? [])
      : ''
    const geometry: MapLayerGeometry = layer.type === 'marker' || (layer.at && !layer.points)
      ? { kind: 'point', lon: feature && 'lon' in feature && typeof feature.lon === 'number' ? feature.lon : null, lat: feature && 'lat' in feature && typeof feature.lat === 'number' ? feature.lat : null }
      : layer.type === 'polyline' || layer.type === 'polygon'
        ? { kind: 'vertices', count: feature && 'points' in feature ? feature.points?.length ?? 0 : layer.points?.length ?? 0 }
        : layer.type === 'label' ? { kind: 'text', text: layer.text ?? layer.name ?? '' } : { kind: 'unknown' }
    return {
      id: layer.id,
      type: layer.type,
      name: layer.name ?? feature?.name ?? layer.id,
      anchorId,
      geometry,
      featureName: feature?.name ?? null,
      category: feature?.category ?? null,
      description: typeof feature?.description === 'string' && feature.description.trim() ? feature.description : null,
      keywords: Array.isArray(feature?.keywords) ? feature!.keywords!.filter(item => typeof item === 'string' && item) : [],
      manual: feature?.manual === true,
      nameManual: feature?.name_manual === true,
      source: typeof feature?.source === 'string' ? feature!.source! : null,
      basis: evidence?.basis ?? null,
      coordinateBasis: evidence?.coordinate_basis ?? null,
      excerpt: evidence?.supporting_excerpt ?? null,
      sourceTitles: (evidence?.source_ids ?? []).map(id => payload.research?.sources.find(source => source.id === id)?.title ?? id).filter(Boolean),
      anchorMissing: !!anchorId && !feature,
      geometryChanged: !!anchorId && coords(feature) !== coords(currentFeature),
    }
  })
  return { available: true, layers }
}
