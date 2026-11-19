/**
 * 地图资产底图的图层段复用资产自己的图层（Issue #117）。
 *
 * 以地图资产（`props.asset_type='map'`）为底图的图层段**不再按语义重画点线**：
 * - 段在库里只存自己的层（模板文本框、画中画图片等）+ 时间线；
 * - 读取时由 `expandMapAssetLayers` 把资产图层文档里**锚定到语义要素**的层展开进文档
 *   （id 前缀 `map:`、只读 `locked`、带 `from_asset`，样式按资产主题烘焙），底图换成资产文档的底图；
 * - 保存时由 `adoptMapAssetLayers` 剥掉 `map:` 层，并把旧的「锚定到底图资产的重画层」换成
 *   该要素在资产里的全部 `map:` 层（时间线 visible 同步映射）；找不到对应资产层的旧层原样保留（无损）。
 *
 * 资产图层文档来源（`mapAssetLayersOf`，同步读库 + 缓存）：
 * 1. 钉选版本（`version_task_id`）是带 `params.editable_source.layer_doc` 的地图成图 → 用它；
 * 2. 否则取资产当前成图（`props.local_path`）对应的地图成图版本的 `editable_source`（地图工作室交付，按 `layer_options` 平滑）；
 *    版本查询接受 `provider IN ('map-workflow','map-render')`（Issue #127）：PiP 细节版本的产物是
 *    `provider='map-render', model='map-studio-detail'`，交付/补算后也带投影后的 `editable_source`；
 *    底图版本 `model='map-studio-base'` 没有 `editable_source`，不会命中；
 * 3. 旧地图工作流资产：`props.map_workflow.outputs.layer_doc`，且其 `final_image.path` 等于当前图；
 * 4. 都没有 / 资产文档底图文件缺失 → `null`（调用方按非地图资产处理或标 `source_unresolved`，绝不回退重画）。
 *
 * 缓存键 = 资产 id + 钉选版本 + `props.updated_at` + 当前图；只补写版本 params 而不同步 touch 资产
 * `updated_at` 时旧结果会继续命中 —— 补算脚本（`scripts/backfill-pip-layer-docs.ts`）负责 touch。
 */
import fs from 'fs'
import { sqlite } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { renderCopyWithSmoothing, type MapLayerOptions } from '../modules/map-studio/contract.js'
import { LAYER_MAX_POINTS, normalizeLayerDoc, type Layer, type LayerDoc, type LayerTheme } from './layer-doc.js'
import { THEME_PRESETS } from './layer-svg.js'
import type { SegmentTimeline } from './segment-timeline.js'

/** 展开层 id 前缀：段文档里一律以此识别「来自资产、只读」的层 */
export const MAP_LAYER_PREFIX = 'map:'

export interface MapAssetLayers {
  asset_id: number
  asset_name: string
  /** 图层文档来源版本（地图成图的 sys_task id；旧工作流资产为当前成图版本，查不到为 null） */
  version_task_id: number | null
  theme: LayerTheme
  base: { path: string; width: number; height: number }
  /** 已展开：只含锚定到语义要素的层，id 带前缀、locked、from_asset、样式烘焙 */
  layers: Layer[]
}

export interface MapSourceInfo {
  asset_id: number
  asset_name: string
  layer_count: number
}

export function isMapAssetLayer(layer: Pick<Layer, 'id'>): boolean {
  return layer.id.startsWith(MAP_LAYER_PREFIX)
}

// ─── 纯函数 ───────────────────────────────────────────────────

function finitePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n))
}

/**
 * 资产图层文档 → 展开层（纯函数）。逐层走 `normalizeLayerDoc` 的字段白名单；
 * 超过 240 点的线/面先用前 240 点校验其余字段，再还原完整点序列（地图数据集几何可达上千点）。
 * 未锚定语义要素的层（标题、副标题、图例、说明、图题卡、未锚定的河名文字）一律不展开。
 */
export function buildMapAssetLayers(input: {
  asset_id: number
  asset_name: string
  version_task_id: number | null
  doc: unknown
  options?: MapLayerOptions | null
}): MapAssetLayers | null {
  const raw = input.doc && typeof input.doc === 'object' ? input.doc as Record<string, unknown> : null
  if (!raw || !Array.isArray(raw.layers)) return null
  const shell = normalizeLayerDoc({ ...raw, layers: [] })
  if (!shell.base.path) return null
  const theme = shell.theme
  const layers: Array<{ layer: Layer; z: number; index: number }> = []
  raw.layers.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const source = item as Record<string, unknown>
    const points = Array.isArray(source.points) ? source.points : null
    const dense = points && points.length > LAYER_MAX_POINTS && points.every(finitePair) ? points as [number, number][] : null
    const shadow = dense ? { ...source, points: dense.slice(0, LAYER_MAX_POINTS) } : source
    const [layer] = normalizeLayerDoc({ base: shell.base, theme, layers: [shadow] }).layers
    if (!layer || layer.type === 'text' || layer.type === 'image' || layer.type === 'card') return
    const semanticId = layer.anchor?.semantic_id
    if (!semanticId || layer.anchor?.detached) return
    if (dense && (layer.type === 'polygon' || layer.type === 'polyline')) layer.points = dense
    layers.push({ layer, z: layer.z, index })
  })
  layers.sort((a, b) => (a.z - b.z) || (a.index - b.index))
  // 平滑只作用于渲染副本，参数按资产原层 id 索引
  const smoothed = input.options && Object.keys(input.options).length
    ? renderCopyWithSmoothing({ ...shell, layers: layers.map(entry => entry.layer) }, input.options).layers
    : layers.map(entry => entry.layer)
  const presets = THEME_PRESETS[theme]
  return {
    asset_id: input.asset_id,
    asset_name: input.asset_name,
    version_task_id: input.version_task_id,
    theme,
    base: { path: shell.base.path, width: shell.base.width, height: shell.base.height },
    layers: smoothed.map((layer, index) => {
      // 样式按资产主题烘焙：段文档的主题与资产不同也必须画得一模一样
      const style: Record<string, unknown> = { ...presets[layer.type] }
      for (const [key, value] of Object.entries(('style' in layer ? layer.style : {}) || {})) {
        if (value !== undefined && value !== null && value !== '') style[key] = value
      }
      return {
        ...layer,
        id: `${MAP_LAYER_PREFIX}${layer.id}`,
        z: index,
        locked: true,
        anchor: { ...layer.anchor, asset_id: input.asset_id },
        from_asset: { asset_id: input.asset_id, layer_id: layer.id },
        style,
      } as Layer
    }),
  }
}

/** 语义要素 id → 资产里锚定它的全部展开层 id（一个要素可以有线 + 标注多层） */
export function mapLayerIdsBySemantic(asset: Pick<MapAssetLayers, 'layers'>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const layer of asset.layers) {
    const key = layer.anchor?.semantic_id
    if (!key) continue
    const list = out.get(key) || []
    list.push(layer.id)
    out.set(key, list)
  }
  return out
}

/**
 * 段文档（已剥离 `map:` 层）+ 资产 → 读时文档（纯函数）。
 * 底图取资产文档的底图（无段滤镜），段自己的裁切保留；资产层在下、段自己的层在上。
 */
export function expandMapAssetLayers(doc: LayerDoc, asset: MapAssetLayers): LayerDoc {
  const own = doc.layers.filter(layer => !isMapAssetLayer(layer))
  const { filter: _filter, ...base } = doc.base
  return {
    ...doc,
    base: {
      ...base,
      path: asset.base.path,
      source_width: asset.base.width,
      source_height: asset.base.height,
    },
    layers: [
      ...asset.layers.map(layer => ({ ...layer })),
      ...own.map((layer, index) => ({ ...layer, z: asset.layers.length + index })),
    ],
  }
}

export interface AdoptResult {
  doc: LayerDoc
  timeline: SegmentTimeline
  /** 被换成资产层的旧重画层 id */
  replaced: string[]
  /** 找不到对应资产层、原样保留的旧重画层（id + 语义 id） */
  unmatched: Array<{ id: string; semantic_id: string | null }>
}

/**
 * 写时转换（纯函数，草稿 / PUT / 迁移共用）：
 * - 去掉所有 `map:` 层（客户端对资产层的改动一律忽略）；
 * - 段里锚定到底图资产、未解除锚点的非图片层 = 旧的按语义重画层：删除，时间线 visible 中的这个 id
 *   换成该要素在资产里的全部 `map:` 层 id；资产里没有该要素的层 → 原样保留（无损）。
 */
export function adoptMapAssetLayers(doc: LayerDoc, timeline: SegmentTimeline, asset: MapAssetLayers): AdoptResult {
  const groups = mapLayerIdsBySemantic(asset)
  const mapping = new Map<string, string[]>()
  const unmatched: AdoptResult['unmatched'] = []
  const kept: Layer[] = []
  for (const layer of doc.layers) {
    if (isMapAssetLayer(layer)) continue
    const anchor = layer.anchor
    const redraw = layer.type !== 'image' && layer.type !== 'text' && anchor?.asset_id === asset.asset_id && !anchor.detached
    if (!redraw) {
      kept.push(layer)
      continue
    }
    const ids = anchor?.semantic_id ? groups.get(anchor.semantic_id) : undefined
    if (!ids?.length) {
      unmatched.push({ id: layer.id, semantic_id: anchor?.semantic_id ?? null })
      kept.push(layer)
      continue
    }
    mapping.set(layer.id, ids)
  }
  const known = new Set(asset.layers.map(layer => layer.id))
  const keyframes = timeline.keyframes.map(frame => {
    const visible: string[] = []
    for (const id of frame.visible) {
      const targets = mapping.get(id) ?? (id.startsWith(MAP_LAYER_PREFIX) && !known.has(id) ? [] : [id])
      for (const target of targets) if (!visible.includes(target)) visible.push(target)
    }
    return { ...frame, visible }
  })
  return {
    doc: { ...doc, layers: kept },
    timeline: { ...timeline, keyframes },
    replaced: [...mapping.keys()],
    unmatched,
  }
}

/** 原始（未规范化）文档里去掉 `map:` 层：必须在 normalizeLayerDoc 之前做，否则 60 层上限会挤掉段自己的层 */
export function stripRawMapLayers(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('layers' in raw) || !Array.isArray(raw.layers)) return raw
  const layers: unknown[] = raw.layers
  return {
    ...raw,
    layers: layers.filter(item => !(item && typeof item === 'object' && 'id' in item
      && typeof item.id === 'string' && item.id.startsWith(MAP_LAYER_PREFIX))),
  }
}

// ─── 读库（同步） ─────────────────────────────────────────────

interface PropRow {
  id: number
  name: string
  asset_type: string | null
  local_path: string | null
  image_url: string | null
  updated_at: string | null
  map_workflow: string | null
  deleted_at: string | null
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function editableSourceOf(params: unknown): { doc: unknown; options: MapLayerOptions | null } | null {
  const source = params && typeof params === 'object' ? (params as Record<string, unknown>).editable_source : null
  if (!source || typeof source !== 'object') return null
  const value = source as Record<string, unknown>
  if (!value.layer_doc || typeof value.layer_doc !== 'object') return null
  const options = value.layer_options && typeof value.layer_options === 'object' ? value.layer_options as MapLayerOptions : null
  return { doc: value.layer_doc, options }
}

const cache = new Map<string, MapAssetLayers | null>()

/** 解析地图资产自己的图层文档；非地图资产 / 没有图层文档 / 底图文件缺失 → null */
export function mapAssetLayersOf(propId: number, versionTaskId: number | null = null): MapAssetLayers | null {
  const prop = sqlite.prepare('SELECT id, name, asset_type, local_path, image_url, updated_at, map_workflow, deleted_at FROM props WHERE id = ?')
    .get(propId) as PropRow | undefined
  if (!prop || prop.deleted_at || prop.asset_type !== 'map') return null
  const current = prop.local_path || prop.image_url || ''
  const key = `${propId}:${versionTaskId ?? ''}:${prop.updated_at ?? ''}:${current}`
  let resolved = cache.get(key)
  if (resolved === undefined) {
    resolved = resolveFromDb(prop, current, versionTaskId)
    if (cache.size > 200) cache.clear()
    cache.set(key, resolved)
  }
  if (resolved && !fs.existsSync(getAbsolutePath(resolved.base.path))) return null
  return resolved
}

function resolveFromDb(prop: PropRow, current: string, versionTaskId: number | null): MapAssetLayers | null {
  const build = (versionId: number | null, doc: unknown, options: MapLayerOptions | null) =>
    buildMapAssetLayers({ asset_id: prop.id, asset_name: prop.name, version_task_id: versionId, doc, options })
  if (versionTaskId) {
    const row = sqlite.prepare("SELECT id, params FROM sys_task WHERE id = ? AND prop_id = ? AND status = 'completed'")
      .get(versionTaskId, prop.id) as { id: number; params: string | null } | undefined
    const pinned = row ? editableSourceOf(parseJson(row.params)) : null
    if (pinned) return build(row!.id, pinned.doc, pinned.options)
  }
  if (!current) return null
  // #127：PiP 细节版本保持 provider='map-render'，带 `editable_source.layer_doc` 时也参与解析
  // （底图版本 model=map-studio-base 没有 editable_source，天然不命中）。只有这两处写 map-render。
  const rows = sqlite.prepare(`SELECT id, params FROM sys_task WHERE prop_id = ? AND provider IN ('map-workflow', 'map-render') AND status = 'completed'
    AND (local_path = ? OR result_url = ?) ORDER BY id DESC`).all(prop.id, current, current) as Array<{ id: number; params: string | null }>
  for (const row of rows) {
    const source = editableSourceOf(parseJson(row.params))
    if (source) return build(row.id, source.doc, source.options)
  }
  // 旧地图工作流资产：图层文档只在只读历史列里，且必须属于当前成图
  const workflow = parseJson(prop.map_workflow)
  const outputs = workflow && typeof workflow === 'object' && 'outputs' in workflow && workflow.outputs && typeof workflow.outputs === 'object'
    ? workflow.outputs : null
  if (!outputs || !('layer_doc' in outputs) || !outputs.layer_doc || !('final_image' in outputs)) return null
  const finalImage = outputs.final_image && typeof outputs.final_image === 'object' ? outputs.final_image : null
  if (!finalImage || !('path' in finalImage) || finalImage.path !== current) return null
  const finalTaskId = 'task_id' in finalImage && Number.isInteger(finalImage.task_id) ? Number(finalImage.task_id) : null
  const legacyOptions = 'layer_options' in outputs && outputs.layer_options && typeof outputs.layer_options === 'object'
    ? outputs.layer_options as MapLayerOptions : null
  return build(finalTaskId, outputs.layer_doc, legacyOptions)
}
