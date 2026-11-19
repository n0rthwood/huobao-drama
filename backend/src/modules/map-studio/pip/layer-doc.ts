/**
 * 画中画细节图接入 #117 图层复用：投影图层文档 + 底图渲染快照（Issue #127）。
 *
 * 细节图过去只有烧录 PNG（程序底图 + pipLabels 注记 + 区域 0.16 色块），细节资产的图层段因此
 * 退回「烧录底图 + 语义重画」。这里把同一份全览图层文档投影到细节取景：
 *
 * - **底图**：`renderReliefBase` 的程序底图（不含 any 注记）+ 角标定位图，内容寻址落盘
 *   `static/map-bases/pip-detail{no}-<render_key>.png`；同一个 `render_key`
 *   （取景框 + 像素尺寸 + 渲染器版本 + map_spec 指纹）同时记进细节版本 params。
 * - **几何**：锚定到语义要素的面/线/点按 `mapProjectionFor` 的 mercator 口径投影（与
 *   `projectDetailSemantics` 同源，像素坐标 = 画布 3840×2160）；**保留完整几何不裁剪**，
 *   只保留「质心或任一顶点落在画布内」的要素（与 `pipLabels` 的可见性判据一致）。
 * - **文字**：烧录 PNG 上的注记来自 `pipLabels`（确定性排布）；展开后段不再烧录文字，改由
 *   投影文档里的 label 层承载 —— `pipLabels` 的 placed 注记逐条转成锚定到语义要素的 label 层
 *   （位置、字号、对齐与烧录版一致）。全览自己的锚定 label 层**不重复带入**（否则同一要素出现
 *   两次文字）。
 * - **样式**：几何层沿用全览图层自己的 style，`layer_options`（平滑等）原样沿用 —— 展开时
 *   `buildMapAssetLayers` 按原图层 id 应用平滑、按主题烘焙样式，所以 id 不改。
 *
 * 未锚定层（标题/副标题/图例/说明/图题卡/图片/模板文本框）一律不带，与 #117 读路径一致。
 */
import crypto from 'crypto'
import {
  LAYER_MAX_COUNT, normalizeLayerDoc,
  type Layer, type LayerDoc, type PolygonLayer, type PolylineLayer, type MarkerLayer,
} from '../../../services/layer-doc.js'
import { mapProjectionFor, normalizeMapSpec, type MapSpec } from '../geo/base-render.js'
import type { PipNote } from './labels.js'
import { pipLabels } from './labels.js'

type Point = [number, number]

/** 细节底图渲染器版本：改了底图渲染口径就让旧快照失配（新文件名、旧文件成为孤儿） */
export const PIP_DETAIL_BASE_RENDERER = 'pip-detail-base:1'

/** 内容寻址的细节底图：path 是 `static/map-bases/...`；render_key 与版本 params 同值 */
export interface PipDetailBase {
  path: string
  width: number
  height: number
  sha256: string
  render_key: string
}

/** 细节版本的 `params.editable_source`：与全览成图版本同键（layer_doc + layer_options），另记渲染快照 */
export interface PipDetailEditableSource {
  version: 1
  source: 'pip-detail'
  /** 底图/文档/版本三者共享的渲染快照身份 */
  render_key: string
  frame_no: number
  frame_bbox: [number, number, number, number]
  base_image: { path: string; width: number; height: number; sha256: string }
  layer_doc: LayerDoc
  layer_options: Record<string, { smooth: number }> | null
}

export interface DetailLayerDocStats {
  geometry_kept: number
  geometry_dropped: number
  labels: number
  truncated: boolean
}

export interface ProjectedDetailLayerDoc {
  layer_doc: LayerDoc
  stats: DetailLayerDocStats
}

interface Feature { kind: 'place' | 'route' | 'region'; coords: Point[] }

const round4 = (value: number): number => Math.round(value * 10000) / 10000

function featureById(spec: MapSpec): Map<string, Feature> {
  const map = new Map<string, Feature>()
  for (const place of spec.places) map.set(place.id, { kind: 'place', coords: [[place.lon, place.lat]] })
  for (const route of spec.routes) map.set(route.id, { kind: 'route', coords: route.points })
  for (const region of spec.regions ?? []) map.set(region.id, { kind: 'region', coords: region.points })
  return map
}

/**
 * 细节渲染快照身份：取景框 + 像素尺寸 + 渲染器版本 + map_spec 指纹。
 * spec 先规范化再逐键序列化（`normalizeMapSpec` 的键序固定），同输入必然同 key。
 */
export function pipDetailRenderKey(specRaw: unknown, bbox: readonly number[], size: { width: number; height: number }): string {
  const spec = normalizeMapSpec(specRaw)
  return crypto.createHash('sha256').update(JSON.stringify({
    renderer: PIP_DETAIL_BASE_RENDERER,
    bbox: bbox.map(value => round4(value)),
    width: size.width,
    height: size.height,
    spec: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
  }), 'utf8').digest('hex')
}

/** 内容寻址文件名（`static/map-bases/` 下）；同 render_key 同编号必然同名 */
export function pipDetailBaseName(no: number, renderKey: string): string {
  return `pip-detail${no}-${renderKey.slice(0, 32)}.png`
}

export interface DetailLabelPlan {
  under: string
  over: string
  notes: PipNote[]
}

export interface DetailLocatorBox {
  margin: number
  width: number
  height: number
  /** 定位图占位矩形（pipLabels 的 reserved，防注记压到角标上） */
  rect: [number, number, number, number]
}

/** 角标定位图的位置与尺寸（渲染合成与注记排布共用，唯一的几何口径） */
export function detailLocatorBox(size: { width: number; height: number }, locatorWidth: number): DetailLocatorBox {
  const k = Math.max(size.width, size.height) / 3840
  const width = Math.round(locatorWidth)
  const height = Math.round(locatorWidth * 9 / 16)
  const margin = Math.round(40 * k)
  return {
    margin,
    width,
    height,
    rect: [margin - 14, size.height - margin - height - 14, margin + width + 14, size.height - margin + 14],
  }
}

/**
 * 细节图的注记排布（唯一实现）：渲染（烧录 PNG）、交付（转 label 层）与补算脚本共用。
 * 几何口径与 `renderDetail` 完全一致 —— 角标定位图占位、字号缩放都从这里来。
 */
export function detailLabelPlan(
  spec: MapSpec,
  frameBbox: readonly number[],
  size: { width: number; height: number },
  tier: 'full' | 'reduced' | 'focus_only',
  locatorWidth: number,
  withLocator: boolean,
): DetailLabelPlan {
  const projectionSpec: MapSpec = { ...spec, bbox: [frameBbox[0]!, frameBbox[1]!, frameBbox[2]!, frameBbox[3]!], detail_level: 'regional' }
  const projection = mapProjectionFor(projectionSpec, size)
  const locRect = detailLocatorBox(size, locatorWidth).rect
  const fontScale = Math.min(1, Math.max(0.8, Math.min(size.width, size.height) / 1400))
  const labels = pipLabels(spec, projection, size, { tier, fontScale, reserved: withLocator ? [locRect] : [] })
  return { under: labels.under, over: labels.over, notes: labels.notes }
}

function noteLayer(note: PipNote, index: number, size: { width: number; height: number }): Layer | null {
  const [x0, y0, x1, y1] = note.rect
  if (!note.name || !note.semantic_id) return null
  // 文字框留一点余量：`wrapTextEm` 按「字符 em 宽度」断行，pipLabels 的 textWidth 估算与之仅近似，
  // 恰好等宽时会被断成两行（注记上移一整行）。没有背景框，加宽不改变视觉起点/中心。
  const slack = note.font * 0.24
  const w = Math.max(0.005, (x1 - x0 + slack) / size.width)
  const h = Math.max(0.005, (y1 - y0 + slack) / size.height)
  // label 层文字基线 = box.y + pad + size·BASELINE_EM(0.88)；pipLabels 的 rect 顶边 = 基线 − font，
  // 所以把 box.y 抬高 0.12·font，展开后的文字与烧录版落在同一行。
  const top = (y0 + note.font * (1 - 0.88)) / size.height
  const left = (note.align === 'center' ? x0 - slack / 2 : x0) / size.width
  return {
    id: `pip-label-${note.semantic_id}-${index + 1}`,
    type: 'label',
    name: note.name.slice(0, 60),
    visible: true,
    locked: false,
    z: 0,
    opacity: 1,
    rotation: 0,
    box: { x: round4(left), y: round4(top), w: round4(w), h: round4(h) },
    text: note.name.slice(0, 400),
    anchor: { semantic_id: note.semantic_id, semantic_name: note.name.slice(0, 60) },
    style: {
      size: Math.min(0.5, Math.max(0.005, round4(note.font / size.height))),
      align: note.align,
      bold: note.bold,
      italic: note.italic,
    },
  } as Layer
}

/**
 * 全览图层文档 → 细节投影文档（纯函数）。
 *
 * - 几何层（polygon/polyline/marker）：按 `anchor.semantic_id` 取 map_spec 的地理几何，用细节取景
 *   投影到画布像素再归一化；**不裁剪**（渲染按画布裁切）；质心或任一顶点不在画布内 → 不带。
 * - marker 只保留圆点（`text: ''`）：名称由注记 label 层承载，避免同一要素两处文字。
 * - label 层来自 `notes`（`pipLabels` 的 placed 注记），一条注记一个锚定 label 层。
 * - 未锚定 / detached / text / image / card 层不带。
 * - 图层上限 `LAYER_MAX_COUNT`：几何优先、注记随后，超出计数记 `truncated`。
 */
export function projectDetailLayerDoc(input: {
  layer_doc: unknown
  spec: MapSpec
  frameBbox: readonly number[]
  size: { width: number; height: number }
  base: Pick<PipDetailBase, 'path' | 'width' | 'height'>
  notes: readonly PipNote[]
}): ProjectedDetailLayerDoc | null {
  const shell = normalizeLayerDoc(input.layer_doc)
  if (!shell.base.path) return null
  const { width, height } = input.size
  const projectionSpec: MapSpec = { ...input.spec, bbox: [input.frameBbox[0]!, input.frameBbox[1]!, input.frameBbox[2]!, input.frameBbox[3]!], detail_level: 'regional' }
  const projection = mapProjectionFor(projectionSpec, input.size)
  const features = featureById(input.spec)
  const toPx = (coord: Point): Point | null => {
    const projected = projection(coord)
    return projected ? [projected[0], projected[1]] : null
  }
  const inside = (p: Point): boolean => p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height
  const geometry: Layer[] = []
  let dropped = 0
  for (const layer of shell.layers) {
    if (layer.type === 'text' || layer.type === 'image' || layer.type === 'card' || layer.type === 'label') continue
    const semanticId = layer.anchor?.semantic_id
    if (!semanticId || layer.anchor?.detached) { dropped++; continue }
    const feature = features.get(semanticId)
    if (!feature) { dropped++; continue }
    const pixels = feature.coords.map(toPx).filter((p): p is Point => p !== null)
    if (!pixels.length) { dropped++; continue }
    const centroid: Point = [pixels.reduce((sum, p) => sum + p[0], 0) / pixels.length, pixels.reduce((sum, p) => sum + p[1], 0) / pixels.length]
    if (!inside(centroid) && !pixels.some(inside)) { dropped++; continue }
    if (layer.type === 'marker') {
      const at: Point = pixels[0]!
      geometry.push({ ...(layer as MarkerLayer), at: [round4(at[0] / width), round4(at[1] / height)], text: '' })
      continue
    }
    // 数据集几何可达上千点：完整点序列照存（读路径 `buildMapAssetLayers` 对 >240 点走 dense 还原，不截断）
    geometry.push({ ...(layer as PolygonLayer | PolylineLayer), points: pixels.map(([x, y]): Point => [round4(x / width), round4(y / height)]) })
  }
  const seen = new Set<string>()
  const labels: Layer[] = []
  let truncated = false
  for (let index = 0; index < input.notes.length; index++) {
    const note = input.notes[index]!
    const key = `${note.semantic_id}\u0000${note.name}`
    if (seen.has(key)) continue
    seen.add(key)
    if (geometry.length + labels.length >= LAYER_MAX_COUNT) { truncated = true; break }
    const layer = noteLayer(note, index, input.size)
    if (layer) labels.push(layer)
  }
  const layers = [...geometry, ...labels].map((layer, index) => ({ ...layer, z: index }))
  return {
    layer_doc: {
      version: 1,
      base: { path: input.base.path, width: input.base.width, height: input.base.height, source_width: input.base.width, source_height: input.base.height },
      theme: shell.theme,
      layers,
    },
    stats: { geometry_kept: geometry.length, geometry_dropped: dropped, labels: labels.length, truncated },
  }
}

export interface DetailEditableInput {
  spec: unknown
  layer_doc: unknown
  layer_options?: unknown
  frame: { no: number; bbox: readonly number[] }
  size: { width: number; height: number }
  base: PipDetailBase
  tier: 'full' | 'reduced' | 'focus_only'
  locatorWidth: number
  withLocator: boolean
}

/**
 * 交付/补算的唯一入口：注记排布 + 投影文档 + 渲染快照 → 细节版本的 `editable_source`。
 * 全览文档解析不到（没有 base）→ null（调用方按「未接入」处理，不编造文档）。
 */
export function buildDetailEditableSource(input: DetailEditableInput): PipDetailEditableSource | null {
  const spec = normalizeMapSpec(input.spec)
  const plan = detailLabelPlan(spec, input.frame.bbox, input.size, input.tier, input.locatorWidth, input.withLocator)
  const projected = projectDetailLayerDoc({ layer_doc: input.layer_doc, spec, frameBbox: input.frame.bbox, size: input.size, base: input.base, notes: plan.notes })
  if (!projected) return null
  const options = input.layer_options && typeof input.layer_options === 'object' ? input.layer_options as Record<string, { smooth: number }> : null
  return {
    version: 1,
    source: 'pip-detail',
    render_key: input.base.render_key,
    frame_no: input.frame.no,
    frame_bbox: [input.frame.bbox[0]!, input.frame.bbox[1]!, input.frame.bbox[2]!, input.frame.bbox[3]!],
    base_image: { path: input.base.path, width: input.base.width, height: input.base.height, sha256: input.base.sha256 },
    layer_doc: projected.layer_doc,
    layer_options: options,
  }
}
