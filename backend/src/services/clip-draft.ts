/**
 * 表达设计（#49 的 `intent.overlay_plan`）→ 图层文档 + 时间线草稿（Issue #50）。
 *
 * 纯函数：不读库、不读文件。调用方（`storyboard-clips.ts`）负责把资产、语义标注、
 * 忠实原图路径装配成 `ClipDraftContext`，这里只做三件事：
 * 1. 选底图 —— `map_anim`/`archival` 用**忠实原件**（`faithful_source` 指向的上传原图，
 *    不是扩散美化版；父 Issue #44 诊断 2 就是美化版把额尔齐斯河画丢了）；
 *    `card` 用人物肖像 / 资产当前图。
 * 2. 语义标注（**原图像素坐标**，#47 契约）→ 归一化 0–1 的图层（#48 契约）。
 * 3. `reveal_at` → 关键状态；最后补一个「推近到已显现几何的外接框 ×1.3」的状态。
 *
 * 草稿是**可被人工覆盖**的起点：生成后存进 `storyboard_clips`，之后以库里的为准。
 */
import type {
  AssetSemantics,
  SemanticLabel,
  SemanticLine,
  SemanticPoint,
  SemanticRegion,
} from './asset-semantics.js'
import type { LayerDoc } from './layer-doc.js'
import { normalizeLayerDoc } from './layer-doc.js'
import type { ClipPosition, OverlayPlanItem, ShotIntent } from './shot-intent.js'
import {
  CLIP_DEFAULT_FADE_MS,
  CLIP_DEFAULT_FPS,
  CLIP_MIN_SECONDS,
  FULL_VIEWPORT,
  MAX_CLIP_SECONDS,
  clampClipDuration,
  normalizeTimeline,
  normalizeViewport,
  viewportFromPoints,
  type ClipState,
  type ClipTimeline,
  type ClipViewport,
} from './clip-timeline.js'

/** 夹在模型视频前后的片段默认时长（秒）：年份卡 / 地点卡这类过渡 */
export const CLIP_PRE_POST_DEFAULT_SECONDS = 2
/** 推近取景框相对几何外接框的放大倍数（Issue #50「区域外接框 ×1.3」） */
export const CLIP_PUSH_IN_PAD = 1.3

export interface ClipDraftAsset {
  kind: 'character' | 'scene' | 'prop'
  id: number
  name: string
  /** 可作底图/图片图层的本地相对路径（忠实原件优先，由调用方决定） */
  image_path: string | null
  /** 该图在磁盘上的像素尺寸，用来把语义坐标归一化；缺省回落到 semantics.image */
  image_width?: number
  image_height?: number
  semantics?: AssetSemantics | null
}

export interface ClipDraftContext {
  assets: ClipDraftAsset[]
  /** 本镜内容时长（秒），`replace` 片段默认取它 */
  duration: number
  /** 成片画幅，写进 layer_doc.base */
  width: number
  height: number
  fps?: number
}

export interface ClipDraft {
  position: ClipPosition
  duration: number
  layer_doc: LayerDoc
  timeline: ClipTimeline
  /** 草稿生成过程中被跳过/降级的条目，原样展示给人修 */
  warnings: string[]
}

/** 命中的语义条目（判别联合：group 一确定，entry 的几何字段就是确定的） */
type SemanticHit =
  | { group: 'labels'; entry: SemanticLabel }
  | { group: 'points'; entry: SemanticPoint }
  | { group: 'regions'; entry: SemanticRegion }
  | { group: 'lines'; entry: SemanticLine }

function assetOf(ctx: ClipDraftContext, id: unknown): ClipDraftAsset | null {
  if (typeof id !== 'number') return null
  return ctx.assets.find(asset => asset.id === id) ?? null
}

/** 语义条目：按稳定 id 命中，命中不了按名称匹配（#49 写入时允许写名称而不是 id） */
function findSemantic(asset: ClipDraftAsset | null, key: string | undefined): SemanticHit | null {
  const semantics = asset?.semantics
  if (!semantics || !key) return null
  const needle = key.trim().toLowerCase()
  if (!needle) return null
  const hits: SemanticHit[] = [
    ...semantics.regions.map((entry): SemanticHit => ({ group: 'regions', entry })),
    ...semantics.lines.map((entry): SemanticHit => ({ group: 'lines', entry })),
    ...semantics.points.map((entry): SemanticHit => ({ group: 'points', entry })),
    ...semantics.labels.map((entry): SemanticHit => ({ group: 'labels', entry })),
  ]
  return hits.find(hit => hit.entry.id.toLowerCase() === needle)
    ?? hits.find(hit => nameOfSemantic(hit).toLowerCase() === needle)
    ?? null
}

/** 条目的人类可读名：labels 用 `text`，其余用 `name` */
function nameOfSemantic(hit: SemanticHit): string {
  return (hit.group === 'labels' ? hit.entry.text : hit.entry.name).trim()
}

function imageSizeOf(asset: ClipDraftAsset): { width: number; height: number } {
  const width = asset.image_width || asset.semantics?.image.width || 0
  const height = asset.image_height || asset.semantics?.image.height || 0
  return { width: width > 0 ? width : 1, height: height > 0 ? height : 1 }
}

/**
 * 底图：`map_anim`/`archival` 取被引用的那张图（必须是忠实原件，由调用方填 `image_path`），
 * `card`/再现类取肖像或资产当前图。找不到任何可用图时返回 null，由调用方报错。
 */
function pickBaseAsset(intent: ShotIntent, ctx: ClipDraftContext): ClipDraftAsset | null {
  const anchors: unknown[] = [
    ...intent.overlay_plan.map(item => item.anchor?.asset_id),
    ...intent.must_show.map(item => item.asset_id),
  ]
  if (intent.device === 'card') {
    const portrait = intent.must_show.find(item => item.kind === 'portrait')
    const portraitAsset = assetOf(ctx, portrait?.asset_id)
    if (portraitAsset?.image_path) return portraitAsset
  }
  for (const id of anchors) {
    const asset = assetOf(ctx, id)
    if (asset?.image_path && (asset.semantics?.labels.length || asset.semantics?.regions.length || asset.semantics?.lines.length || asset.semantics?.points.length)) {
      return asset
    }
  }
  for (const id of anchors) {
    const asset = assetOf(ctx, id)
    if (asset?.image_path) return asset
  }
  return ctx.assets.find(asset => asset.image_path) ?? null
}

interface DraftedLayer {
  layer: Record<string, unknown>
  /** 该层在底图上的归一化坐标点，用于算推近取景框 */
  points: Array<[number, number]>
}

function layerFromOverlayItem(
  item: OverlayPlanItem,
  index: number,
  ctx: ClipDraftContext,
  base: ClipDraftAsset | null,
  warnings: string[],
): DraftedLayer | null {
  const id = `L${index + 1}`
  const anchorAsset = assetOf(ctx, item.anchor?.asset_id) ?? base
  const semantic = findSemantic(anchorAsset, item.anchor?.semantic_id || item.anchor?.semantic)
  const size = anchorAsset ? imageSizeOf(anchorAsset) : { width: 1, height: 1 }
  // 语义坐标是**原图像素**（#47 契约），图层坐标是归一化 0–1（#48 契约）
  const toNorm = (point: readonly number[]): [number, number] | null => {
    if (point.length < 2) return null
    const x = point[0] / size.width
    const y = point[1] / size.height
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
  }
  const entryName = semantic ? nameOfSemantic(semantic) : ''
  const label = item.text || entryName || item.note || ''
  const semanticId = semantic?.entry.id || item.anchor?.semantic_id || ''
  const anchor = item.anchor?.asset_id
    ? { asset_id: item.anchor.asset_id, semantic_id: semanticId }
    : undefined

  if (item.layer === 'polygon' || item.layer === 'polyline') {
    const geometry = semantic && (semantic.group === 'regions' || semantic.group === 'lines')
      ? semantic.entry.points
      : []
    const points = geometry.map(toNorm).filter((point): point is [number, number] => point !== null)
    if (points.length < 2) {
      warnings.push(`第 ${index + 1} 层（${item.layer}）缺少可用的几何坐标，已跳过：${label || '未命名'}`)
      return null
    }
    const style: Record<string, unknown> = {}
    // polyline 的箭头与描边色在 #48 白名单里分别叫 arrow_end / stroke，写错键会被静默丢弃
    if (semantic?.group === 'lines' && semantic.entry.color) style.stroke = semantic.entry.color
    if (item.layer === 'polyline') style.arrow_end = true
    return {
      layer: {
        id, type: item.layer, name: label || `图层 ${index + 1}`, z: index + 1,
        points, style, anchor,
      },
      points,
    }
  }

  if (item.layer === 'marker') {
    const at = semantic?.group === 'points' ? toNorm(semantic.entry.at) : null
    if (!at) {
      warnings.push(`第 ${index + 1} 层（marker）缺少坐标，已跳过：${label || '未命名'}`)
      return null
    }
    return {
      layer: { id, type: 'marker', name: label || `标记 ${index + 1}`, z: index + 1, at, text: label, anchor },
      points: [at],
    }
  }

  if (item.layer === 'label') {
    if (!label) {
      warnings.push(`第 ${index + 1} 层（label）没有文字，已跳过`)
      return null
    }
    let box = { x: 0.06, y: 0.08 + index * 0.1, w: 0.3, h: 0.09 }
    const points: Array<[number, number]> = []
    const bbox = semantic?.group === 'labels' ? semantic.entry.bbox : null
    if (bbox) {
      const topLeft = toNorm([bbox[0], bbox[1]])
      const bottomRight = toNorm([bbox[2], bbox[3]])
      if (topLeft && bottomRight) {
        // 语义标签框只框住原图上的小字，叠加层要比它大一点才放得下中文字号
        const w = Math.max(0.12, bottomRight[0] - topLeft[0])
        const h = Math.max(0.05, bottomRight[1] - topLeft[1])
        box = { x: Math.min(topLeft[0], 1 - w), y: Math.min(topLeft[1], 1 - h), w, h }
        points.push(topLeft, bottomRight)
      }
    }
    return {
      layer: { id, type: 'label', name: label, z: index + 1, box, text: label, anchor },
      points,
    }
  }

  if (item.layer === 'card') {
    const fields = item.fields || {}
    const title = fields.title || item.text || entryName || (anchorAsset?.name ?? '')
    if (!title) {
      warnings.push(`第 ${index + 1} 层（card）没有标题文字，已跳过`)
      return null
    }
    const box = { x: 0.06, y: 0.72, w: 0.46, h: 0.18 }
    return {
      layer: {
        id, type: 'card', name: title, z: index + 1, box,
        template: item.template || 'name',
        fields: { title, sub: fields.sub || '', meta: fields.meta || '' },
      },
      points: [],
    }
  }

  // image：肖像 / 档案件插图
  const source = anchorAsset?.image_path
  if (!source) {
    warnings.push(`第 ${index + 1} 层（image）找不到可用的图片资产，已跳过`)
    return null
  }
  const box = { x: 0.62, y: 0.1, w: 0.3, h: 0.44 }
  return {
    layer: {
      id, type: 'image', name: anchorAsset?.name || `图片 ${index + 1}`, z: index + 1, box,
      src: { path: source }, fit: 'cover',
      anchor: anchorAsset ? { asset_id: anchorAsset.id } : undefined,
    },
    points: [],
  }
}

/**
 * 按 `overlay_plan` 生成片段草稿。`null` = 本镜不该有确定性片段（`deterministic=none`）
 * 或找不到任何可用底图。
 */
export function draftClip(intent: ShotIntent, ctx: ClipDraftContext): ClipDraft | null {
  if (intent.deterministic === 'none') return null
  const warnings: string[] = []
  const base = pickBaseAsset(intent, ctx)
  if (!base?.image_path) return null

  const drafted: DraftedLayer[] = []
  for (const [index, item] of intent.overlay_plan.entries()) {
    const layer = layerFromOverlayItem(item, index, ctx, base, warnings)
    if (layer) drafted.push(layer)
  }

  const position = intent.deterministic
  const duration = clampClipDuration(
    position === 'replace' ? Math.max(ctx.duration, CLIP_MIN_SECONDS) : CLIP_PRE_POST_DEFAULT_SECONDS,
    position === 'replace' ? MAX_CLIP_SECONDS : 15,
  )

  const layerDoc = normalizeLayerDoc({
    version: 1,
    theme: 'archival',
    base: {
      path: base.image_path,
      width: ctx.width,
      height: ctx.height,
      filter: { paper: 0.16, tint: 'sepia', tint_strength: 0.18, vignette: 0.28 },
    },
    layers: drafted.map(entry => entry.layer),
  })

  // 关键状态：t=0 干净底图 → 按 reveal_at 逐层显现 → 推近到已显现几何的外接框
  const revealed: string[] = []
  const states: ClipState[] = [{ t: 0, viewport: { ...FULL_VIEWPORT }, visible: [] }]
  const slots = drafted.length || 1
  for (const [index, entry] of drafted.entries()) {
    const item = intent.overlay_plan[Number(String(entry.layer.id).slice(1)) - 1]
    const fallback = ((index + 1) / (slots + 1)) * duration
    const t = Math.min(
      duration - 0.4,
      Math.max(0.2, Number.isFinite(item?.reveal_at) ? Number(item!.reveal_at) : fallback),
    )
    revealed.push(String(entry.layer.id))
    const viewport: ClipViewport = item?.viewport
      ? normalizeViewport(item.viewport)
      : { ...FULL_VIEWPORT }
    states.push({ t: Math.round(t * 100) / 100, viewport, visible: [...revealed] })
  }

  const geometry = drafted.flatMap(entry => entry.points)
  if (geometry.length >= 2 && duration > 2) {
    states.push({
      t: Math.round(Math.max(0.6, duration * 0.8) * 100) / 100,
      viewport: viewportFromPoints(geometry, CLIP_PUSH_IN_PAD),
      visible: [...revealed],
    })
  }

  return {
    position,
    duration,
    layer_doc: layerDoc,
    timeline: normalizeTimeline({
      fps: ctx.fps || CLIP_DEFAULT_FPS,
      ease: 'inout',
      fade_ms: CLIP_DEFAULT_FADE_MS,
      states,
    }),
    warnings,
  }
}
