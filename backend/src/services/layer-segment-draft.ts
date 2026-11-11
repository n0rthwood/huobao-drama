/**
 * 设计卡 `layer_plan` → 图层段草稿（Issue #58，契约 §3.1/§3.2；由 #50 的 `clip-draft.ts` 改造）。
 *
 * 输入只认设计卡的 `layer_plan`（`base` / `must_mark` / `planned_layers`），
 * **不再有「随便找一张资产图当底图」的回退**（契约 §8 第 6 行）：底图由调用方解析好传进来，
 * 解析不到就是 `missing_base`，调用方不落行。
 *
 * 与 #50 的差异（本轮遗留缺陷修复，契约 §8 第 3/4 行）：
 * - 卡片字段契约扩为 `{title, sub, meta, years}`：设计卡若在卡片文案里写了年代，落到 `fields.years`；
 * - 卡片默认位置 `y=0.56, h=0.18`（底边 0.74），**不压字幕**；与字幕安全区重叠由调用方
 *   算成非阻断警告 `card_subtitle_overlap`（底边 > 0.88）。
 */
import type {
  AssetSemantics,
  SemanticLabel,
  SemanticLine,
  SemanticPoint,
  SemanticRegion,
} from './asset-semantics.js'
import type { BaseRef, Combo, DesignCard, PlannedLayer } from './design-card.js'
import { hasLayerSegment } from './design-card.js'
import { normalizeLayerDoc, type LayerBox, type LayerDoc } from './layer-doc.js'
import { TEXT_SPEC } from './layer-text.js'
import { revealBeats, textZoneOf } from './layer-text-visibility.js'
import { baseFrameOf } from './layer-quality.js'
import {
  MAX_LAYER_SEGMENT_SECONDS,
  SEGMENT_DEFAULT_FADE_MS,
  SEGMENT_DEFAULT_FPS,
  SEGMENT_MIN_SECONDS,
  clampSegmentDuration,
  normalizeTimeline,
  normalizeViewport,
  viewportFromPoints,
  type PreciseKeyframe,
  type SegmentTimeline,
} from './segment-timeline.js'

/** 卡在模型视频前后的图层段默认时长（秒）：年份卡 / 地点卡这类过渡 */
export const LAYER_SEGMENT_PRE_POST_DEFAULT_SECONDS = 2
/** 推近取景框相对几何外接框的放大倍数（Issue #50「区域外接框 ×1.3」） */
export const LAYER_SEGMENT_PUSH_IN_PAD = 1.3
/** 卡片默认位置（Issue #58 契约 §8 第 4 行 / 主进程裁决 6）：底边 0.74，避开底部约 8% 的字幕安全区 */
export const CARD_DEFAULT_BOX = { x: 0.06, y: 0.56, w: 0.46, h: 0.18 }
/** 字幕安全区上界（归一化）：1080p 下 MarginV=28px + 18pt×1.6 行高 ≈ 底部 8% → 0.88 起算 */
export const SUBTITLE_SAFE_BOTTOM = 0.88

export interface SegmentDraftAsset {
  kind: 'prop' | 'character' | 'scene'
  id: number
  name: string
  image_path: string | null
  /** 语义坐标所针对的原图像素尺寸（有语义标注才填） */
  image_width?: number
  image_height?: number
  semantics: AssetSemantics | null
}

export interface SegmentDraftContext {
  /** 设计卡引用到的资产（含底图资产） */
  assets: SegmentDraftAsset[]
  /** 已解析好的底图资产（`null` = 继承上一镜尾帧这类无资产的底图） */
  base: SegmentDraftAsset | null
  /** 底图实际使用的图片路径（调用方已按 BaseRef 解析，可能是资产版本图） */
  base_path: string
  /** 底图引用原样带回，落库进 `base_ref` */
  base_ref: BaseRef | null
  /** 本镜旁白估算/分镜时长（秒），决定 A 组合草稿的最小长度 */
  duration: number
  width: number
  height: number
  fps?: number
}

export interface SegmentDraft {
  duration: number
  layer_doc: LayerDoc
  timeline: SegmentTimeline
  /** 非阻断提示（缺坐标的图层被跳过等），前端原样展示 */
  warnings: string[]
}

export type SegmentDraftIssue = 'missing_base' | 'no_layer_segment' | 'no_design_card'

/** 命中的语义条目（判别联合：group 一确定，entry 的几何字段就是确定的） */
type SemanticHit =
  | { group: 'labels'; entry: SemanticLabel }
  | { group: 'points'; entry: SemanticPoint }
  | { group: 'regions'; entry: SemanticRegion }
  | { group: 'lines'; entry: SemanticLine }

function assetOf(ctx: SegmentDraftContext, id: unknown): SegmentDraftAsset | null {
  const key = Number(id)
  if (!Number.isInteger(key)) return null
  return ctx.assets.find(asset => asset.id === key) ?? null
}

/** 语义条目：按稳定 id 命中，命中不了按名称匹配（#49 写入时允许写名称而不是 id） */
function findSemantic(asset: SegmentDraftAsset | null, key: string | undefined): SemanticHit | null {
  if (!asset?.semantics || !key) return null
  const wanted = key.trim()
  const semantics = asset.semantics
  const label = semantics.labels.find(item => item.id === wanted || item.text === wanted)
  if (label) return { group: 'labels', entry: label }
  const point = semantics.points.find(item => item.id === wanted || item.name === wanted)
  if (point) return { group: 'points', entry: point }
  const region = semantics.regions.find(item => item.id === wanted || item.name === wanted)
  if (region) return { group: 'regions', entry: region }
  const line = semantics.lines.find(item => item.id === wanted || item.name === wanted)
  if (line) return { group: 'lines', entry: line }
  return null
}

/** 条目的人类可读名：labels 用 `text`，其余用 `name` */
function nameOfSemantic(hit: SemanticHit): string {
  return (hit.group === 'labels' ? hit.entry.text : hit.entry.name).trim()
}

function imageSizeOf(asset: SegmentDraftAsset): { width: number; height: number } {
  const width = asset.image_width || asset.semantics?.image.width || 0
  const height = asset.image_height || asset.semantics?.image.height || 0
  return { width: width > 0 ? width : 1, height: height > 0 ? height : 1 }
}

/**
 * 草稿的取景框：底图比例与成片不符时渲染是 contain 留白（#94），默认位置必须按**取景框**放，
 * 否则文字会落到模糊留白带里甚至出画。底图像素未知时退化为整图（与 #94 之前一致）。
 */
function draftFrameOf(ctx: SegmentDraftContext): LayerBox {
  const size = ctx.base ? imageSizeOf(ctx.base) : { width: 1, height: 1 }
  if (size.width <= 1 || size.height <= 1) return { x: 0, y: 0, w: 1, h: 1 }
  return baseFrameOf({ source_width: size.width, source_height: size.height }, { width: ctx.width, height: ctx.height }).frame
}

/** 取景框内的相对位置 → 整图归一化坐标（图层坐标的唯一口径） */
function inFrame(frame: LayerBox, box: { x: number; y: number; w: number; h: number }): LayerBox {
  return {
    x: Math.round((frame.x + box.x * frame.w) * 10000) / 10000,
    y: Math.round((frame.y + box.y * frame.h) * 10000) / 10000,
    w: Math.round(box.w * frame.w * 10000) / 10000,
    h: Math.round(box.h * frame.h * 10000) / 10000,
  }
}

interface DraftedLayer {
  layer: Record<string, unknown>
  /** 该层在底图上的归一化坐标点，用于算推近取景框 */
  points: Array<[number, number]>
}

/**
 * 卡片字段（契约 §8 第 3 行：`{title, sub, meta, years}`）。
 * 设计卡只带一句文案：文案里的年代（「1700」「1700–1721」「1700—1721年」）进 `years`，
 * 其余作为标题；标题缺失时用锚点/底图资产名兜底——与 #50 的行为一致，只是多出一行年代。
 */
function cardFields(item: PlannedLayer, entryName: string, base: SegmentDraftAsset | null): { title: string; years: string } {
  const raw = (item.text || entryName || '').trim()
  const years = raw.match(/\d{3,4}\s*[–—\-~至]\s*\d{3,4}\s*年?|\d{3,4}\s*年|\b(1[0-9]{3}|20[0-9]{2})\b/)?.[0]?.trim() ?? ''
  // 文案去掉年代后剩下的才是标题；只剩年代时标题留空（模板自动切 year，年代放大显示）
  const title = years ? raw.replace(years, '').replace(/^[\s·、,，:：]+|[\s·、,，:：]+$/g, '') : raw
  return {
    title: (title || (!years ? base?.name || '' : '')).trim(),
    years,
  }
}

/**
 * `modernText` = 这张卡用的是模板文本框（有计划 text 层或已选成套位置）：此时不再生成
 * 没有锚点的 label / card 屏幕排版层，屏幕文字统一走 text 层。旧卡（没有任何 text 计划）
 * 保持原来的转换行为，不做迁移。
 */
export function layerFromPlannedLayer(
  item: PlannedLayer,
  index: number,
  ctx: SegmentDraftContext,
  warnings: string[],
  modernText = false,
): DraftedLayer | null {
  const id = `L${index + 1}`
  const frame = draftFrameOf(ctx)
  const anchorAsset = assetOf(ctx, item.anchor?.asset_id) ?? ctx.base
  const semantic = findSemantic(anchorAsset, item.anchor?.semantic_id || item.anchor?.name)
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
  const label = item.text || entryName || ''
  const semanticId = semantic?.entry.id || item.anchor?.semantic_id || ''
  const anchor = item.anchor?.asset_id
    ? { asset_id: item.anchor.asset_id, semantic_id: semanticId }
    : undefined

  if (item.type === 'polygon' || item.type === 'polyline') {
    const geometry = semantic && (semantic.group === 'regions' || semantic.group === 'lines')
      ? semantic.entry.points
      : []
    const points = geometry.map(toNorm).filter((point): point is [number, number] => point !== null)
    if (points.length < 2) {
      warnings.push(`第 ${index + 1} 层（${item.type}）缺少可用的几何坐标，已跳过：${label || '未命名'}`)
      return null
    }
    const style: Record<string, unknown> = {}
    // polyline 的箭头与描边色在 #48 白名单里分别叫 arrow_end / stroke，写错键会被静默丢弃
    if (semantic?.group === 'lines' && semantic.entry.color) style.stroke = semantic.entry.color
    if (item.type === 'polyline') style.arrow_end = true
    return {
      layer: {
        id, type: item.type, name: label || `图层 ${index + 1}`, z: index + 1,
        points, style, anchor,
      },
      points,
    }
  }

  if (item.type === 'marker') {
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

  if (item.type === 'label') {
    if (!label) {
      warnings.push(`第 ${index + 1} 层（label）没有文字，已跳过`)
      return null
    }
    // 新版设计（有模板文本框或已选成套位置）只用 text 层做屏幕排版；旧卡里没有锚点的 label 不再落到新草稿
    if (!item.anchor && modernText) {
      warnings.push(`第 ${index + 1} 层（label）没有锚点：新版设计用 text 模板文本框排版，已跳过「${label}」`)
      return null
    }
    let box = inFrame(frame, { x: 0.06, y: 0.08 + index * 0.1, w: 0.3, h: 0.09 })
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

  if (item.type === 'card') {
    if (!item.anchor && modernText) {
      warnings.push(`第 ${index + 1} 层（card）没有锚点：新版设计用 text 模板文本框排版，已跳过`)
      return null
    }
    const fields = cardFields(item, entryName, ctx.base)
    if (!fields.title && !fields.years) {
      warnings.push(`第 ${index + 1} 层（card）没有可显示的标题或年代，已跳过`)
      return null
    }
    return {
      layer: {
        id, type: 'card', name: fields.title || fields.years, z: index + 1,
        box: inFrame(frame, CARD_DEFAULT_BOX),
        template: fields.years && !fields.title ? 'year' : 'name',
        fields: { title: fields.title, sub: '', meta: '', years: fields.years },
      },
      points: [],
    }
  }

  if (item.type === 'text') {
    // #96 模板文本框：只带类型与字段，位置/样式由文档级 text_layout 决定（屏幕上排版，不锚定）
    const roleName = item.role ? TEXT_SPEC.roles[item.role]?.name : ''
    if (!item.role || !roleName) {
      warnings.push(`第 ${index + 1} 层（text）缺少合法的文本框类型，已跳过`)
      return null
    }
    return {
      layer: {
        id, type: 'text', name: roleName, z: index + 1,
        role: item.role,
        fields: item.fields || {},
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
  const box = inFrame(frame, { x: 0.62, y: 0.1, w: 0.3, h: 0.44 })
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
 * 按设计卡的 `layer_plan` 生成图层段草稿。调用方必须先确保 combo 有图层段、底图已解析。
 * 时长：优先设计卡 `budget.layer_s`；A 组合至少覆盖本镜时长；C/D 没有预算时用 2 秒过渡。
 */
export function draftSegment(card: DesignCard, combo: Combo | null, ctx: SegmentDraftContext): SegmentDraft {
  if (!hasLayerSegment(combo)) throw new Error('该段组合没有图层段')
  const warnings: string[] = []
  const planned = card.layer_plan?.planned_layers || []
  const modernText = planned.some(item => item.type === 'text') || Boolean(card.layer_plan?.text_layout)
  const drafted: DraftedLayer[] = []
  for (const [index, item] of planned.entries()) {
    const layer = layerFromPlannedLayer(item, index, ctx, warnings, modernText)
    if (layer) drafted.push(layer)
  }

  const planSeconds = card.budget.layer_s
  const duration = clampSegmentDuration(
    planSeconds && planSeconds > 0
      ? planSeconds
      : combo === 'A'
        ? Math.max(ctx.duration, SEGMENT_MIN_SECONDS)
        : LAYER_SEGMENT_PRE_POST_DEFAULT_SECONDS,
    MAX_LAYER_SEGMENT_SECONDS,
  )

  const frame = draftFrameOf(ctx)
  const baseSize = ctx.base ? imageSizeOf(ctx.base) : null
  const layerDoc = normalizeLayerDoc({
    version: 1,
    theme: 'archival',
    ...(card.layer_plan?.text_layout ? { text_layout: card.layer_plan.text_layout } : {}),
    base: {
      path: ctx.base_path,
      width: ctx.width,
      height: ctx.height,
      source_width: baseSize && baseSize.width > 1 ? baseSize.width : undefined,
      source_height: baseSize && baseSize.height > 1 ? baseSize.height : undefined,
      filter: { paper: 0.16, tint: 'sepia', tint_strength: 0.18, vignette: 0.28 },
    },
    layers: drafted.map(entry => entry.layer),
  })

  // 精确关键帧：t=0 干净底图 → 按 at_s 逐层显现 → 推近到已显现几何的外接框
  const slots = drafted.length || 1
  const revealAt = drafted.map((entry, index) => {
    const item = planned[Number(String(entry.layer.id).slice(1)) - 1]
    const fallback = ((index + 1) / (slots + 1)) * duration
    const t = Math.min(
      duration - 0.4,
      Math.max(0.2, Number.isFinite(item?.at_s) ? Number(item!.at_s) : fallback),
    )
    return Math.round(t * 100) / 100
  })
  // 可见集合走同一个实现：模板文本框同 zone 后出现的替换先出现的，其余图层累计可见
  const beats = revealBeats(drafted.map((entry, index) => ({
    id: String(entry.layer.id),
    zone: entry.layer.type === 'text'
      ? textZoneOf(card.layer_plan?.text_layout, String(entry.layer.role ?? ''))
      : null,
    at: revealAt[index],
  })))
  const keyframes: PreciseKeyframe[] = [{ t: 0, viewport: { ...frame }, visible: [] }]
  for (const [index, entry] of drafted.entries()) {
    // 设计卡不带视口（它是导演层的图纸）：草稿一律取满取景框，取景由图层编辑器（R6）定
    keyframes.push({ t: revealAt[index], viewport: { ...frame }, visible: [...beats[index + 1]] })
  }
  const revealed = beats[beats.length - 1]
  const geometry = drafted.flatMap(entry => entry.points)
  if (geometry.length >= 2 && duration > 2) {
    keyframes.push({
      t: Math.round(Math.max(0.6, duration * 0.8) * 100) / 100,
      viewport: normalizeViewport(viewportFromPoints(geometry, LAYER_SEGMENT_PUSH_IN_PAD), frame),
      visible: [...revealed],
    })
  }
  // 末帧必须正好落在段尾：C 的衔接帧取 `t=duration`，没有这一帧就没有「末尾停留的最终画面」
  if (keyframes[keyframes.length - 1].t < duration - 1e-6) {
    keyframes.push({ t: duration, viewport: { ...keyframes[keyframes.length - 1].viewport }, visible: [...revealed] })
  }

  return {
    duration,
    layer_doc: layerDoc,
    timeline: normalizeTimeline({
      fps: ctx.fps || SEGMENT_DEFAULT_FPS,
      ease: 'inout',
      fade_ms: SEGMENT_DEFAULT_FADE_MS,
      keyframes,
    }, frame),
    warnings,
  }
}

/**
 * 同屏拍（#96 文本层检查用）：时间线的每个关键帧就是一段「同一时刻可见的图层 id 集合」。
 * 从未出现在任何关键帧的图层追加成最后一拍，保证它们也参与检查；只用于检查，不改文档。
 */
export function textBeatsOfTimeline(doc: LayerDoc, timeline: SegmentTimeline): string[][] {
  const beats = timeline.keyframes.map(frame => frame.visible.slice())
  const seen = new Set<string>()
  for (const beat of beats) for (const id of beat) seen.add(id)
  const absent = doc.layers.filter(layer => !seen.has(layer.id)).map(layer => layer.id)
  return absent.length ? [...beats, absent] : beats
}
