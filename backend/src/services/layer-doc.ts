/**
 * 叠加图层文档（Issue #48）：唯一 schema / 规范化 / 钳制。
 *
 * 口径（跨 Issue 契约，#49 #50 消费）：
 * - 坐标与尺寸全部归一化：x 对输出宽度、y 对输出高度；**所有标量尺寸**
 *   （字号、线宽、点半径、圆角、边框）都是输出**高度**的比例（与 Poster 的
 *   fontSize 口径一致），渲染时按输出尺寸换算，换尺寸不改文档。
 * - 坐标允许轻微出血（[-0.25, 1.25]），便于把图层拖到画面边缘外一点点。
 * - `anchor` 记录图层来自哪条语义标注（#47），人工移动后 `detached=true`。
 * - 规范化只做白名单 + 钳制 + 排序，**不注入主题默认值**：样式缺省由
 *   `layer-svg.ts` 的 THEME_PRESETS 在渲染时兜底（前后端同源）。
 */
import { z } from 'zod'

export const LAYER_DOC_VERSION = 1

export const LAYER_THEMES = ['archival', 'clean', 'ink'] as const
export type LayerTheme = (typeof LAYER_THEMES)[number]

export const LAYER_TYPES = ['polygon', 'polyline', 'marker', 'label', 'card', 'image'] as const
export type LayerType = (typeof LAYER_TYPES)[number]

export const CARD_TEMPLATES = ['name', 'year', 'chapter'] as const
export type CardTemplate = (typeof CARD_TEMPLATES)[number]

export const LAYER_FONTS = ['sans', 'serif'] as const
export type LayerFont = (typeof LAYER_FONTS)[number]

export const LAYER_ALIGNS = ['left', 'center', 'right'] as const
export const LAYER_DASHES = ['none', 'dash', 'dot'] as const
export const IMAGE_FITS = ['contain', 'cover'] as const
export const BASE_TINTS = ['none', 'sepia', 'cool', 'warm'] as const
export type BaseTint = (typeof BASE_TINTS)[number]

/** 单文档图层上限：超出部分直接丢弃（渲染一张帧不需要更多）。 */
export const LAYER_MAX_COUNT = 60
/** 单个 polygon/polyline 的点数上限。 */
export const LAYER_MAX_POINTS = 240
const TEXT_MAX = 400
const NAME_MAX = 60
const COLOR_MAX = 32
const PATH_MAX = 512
// 跨 Issue 契约（#44 handoff §3）：坐标归一化 0–1，越界一律钳回画面内
const COORD_MIN = 0
const COORD_MAX = 1

export interface LayerAnchor {
  asset_id?: number
  semantic_id?: string
  detached?: boolean
}

export interface LayerBase {
  id: string
  type: LayerType
  name: string
  visible: boolean
  locked: boolean
  z: number
  opacity: number
  rotation: number
  anchor?: LayerAnchor
}

export type LayerStyle = Record<string, unknown>

export interface PolygonLayer extends LayerBase {
  type: 'polygon'
  points: [number, number][]
  style: LayerStyle
}
export interface PolylineLayer extends LayerBase {
  type: 'polyline'
  points: [number, number][]
  style: LayerStyle
}
export interface MarkerLayer extends LayerBase {
  type: 'marker'
  at: [number, number]
  text: string
  style: LayerStyle
}
export interface LayerBox {
  x: number
  y: number
  w: number
  h: number
}
export interface LabelLayer extends LayerBase {
  type: 'label'
  box: LayerBox
  text: string
  style: LayerStyle
}
export interface CardLayer extends LayerBase {
  type: 'card'
  box: LayerBox
  template: CardTemplate
  fields: { title: string; sub: string; meta: string }
  style: LayerStyle
}
export interface ImageLayer extends LayerBase {
  type: 'image'
  box: LayerBox
  src: { path: string }
  fit: (typeof IMAGE_FITS)[number]
  style: LayerStyle
}

export type Layer = PolygonLayer | PolylineLayer | MarkerLayer | LabelLayer | CardLayer | ImageLayer

export interface BaseFilter {
  paper: number
  tint: BaseTint
  tint_strength: number
  vignette: number
}

export interface LayerDocBase {
  path: string
  width: number
  height: number
  filter?: BaseFilter
}

export interface LayerDoc {
  version: number
  base: LayerDocBase
  theme: LayerTheme
  layers: Layer[]
}

const num = (min: number, max: number, fallback: number) =>
  z.preprocess(value => {
    const n = typeof value === 'string' ? Number(value) : value
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }, z.number())

const text = (max: number, fallback = '') =>
  z.preprocess(
    value => (typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' ? String(value) : fallback),
    z.string(),
  )

const trimmedText = (max: number, fallback = '') =>
  z.preprocess(
    value => (typeof value === 'string' ? value.slice(0, max).trim() || fallback : fallback),
    z.string(),
  )

const bool = (fallback: boolean) =>
  z.preprocess(value => (typeof value === 'boolean' ? value : fallback), z.boolean())

const enumWith = <T extends readonly string[]>(values: T, fallback: T[number]) =>
  z.preprocess(
    value => (typeof value === 'string' && (values as readonly string[]).includes(value) ? value : fallback),
    z.string(),
  )

const coord = () => num(COORD_MIN, COORD_MAX, 0)

const pointSchema = z.preprocess(value => {
  if (!Array.isArray(value) || value.length < 2) return null
  const [x, y] = value
  const nx = typeof x === 'string' ? Number(x) : x
  const ny = typeof y === 'string' ? Number(y) : y
  if (typeof nx !== 'number' || typeof ny !== 'number' || !Number.isFinite(nx) || !Number.isFinite(ny)) return null
  return [
    Math.min(COORD_MAX, Math.max(COORD_MIN, nx)),
    Math.min(COORD_MAX, Math.max(COORD_MIN, ny)),
  ]
}, z.array(z.number()).length(2).nullable())

const boxSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : {}),
  z.object({
    x: coord(),
    y: coord(),
    w: num(0.005, 2, 0.3),
    h: num(0.005, 2, 0.12),
  }),
)

const anchorSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : undefined),
  z
    .object({
      asset_id: z.preprocess(
        v => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined),
        z.number().optional(),
      ),
      semantic_id: z.preprocess(
        v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : undefined),
        z.string().optional(),
      ),
      detached: z.preprocess(v => (v === true ? true : undefined), z.boolean().optional()),
    })
    .optional(),
)

/** 样式白名单：按类型列出允许的键与各自的解析器。 */
const STYLE_FIELDS: Record<LayerType, Record<string, z.ZodTypeAny>> = {
  polygon: {
    fill: trimmedText(COLOR_MAX),
    fill_opacity: num(0, 1, 0.35),
    stroke: trimmedText(COLOR_MAX),
    stroke_width: num(0, 0.05, 0.004),
    dash: enumWith(LAYER_DASHES, 'none'),
  },
  polyline: {
    stroke: trimmedText(COLOR_MAX),
    width: num(0, 0.05, 0.006),
    dash: enumWith(LAYER_DASHES, 'none'),
    arrow_end: bool(false),
    arrow_start: bool(false),
  },
  marker: {
    dot_radius: num(0, 0.1, 0.012),
    color: trimmedText(COLOR_MAX),
    text_color: trimmedText(COLOR_MAX),
    stroke: trimmedText(COLOR_MAX),
    size: num(0.005, 0.5, 0.034),
    font: enumWith(LAYER_FONTS, 'sans'),
    bold: bool(false),
    label_offset: z.preprocess(value => {
      if (!Array.isArray(value) || value.length < 2) return [0.016, -0.012]
      const [dx, dy] = value.map(v =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(0.5, Math.max(-0.5, v)) : 0,
      )
      return [dx, dy]
    }, z.array(z.number()).length(2)),
  },
  label: {
    font: enumWith(LAYER_FONTS, 'sans'),
    size: num(0.005, 0.5, 0.045),
    color: trimmedText(COLOR_MAX),
    stroke: trimmedText(COLOR_MAX),
    stroke_width: num(0, 0.03, 0),
    bg: trimmedText(COLOR_MAX),
    bg_opacity: num(0, 1, 0),
    align: enumWith(LAYER_ALIGNS, 'left'),
    bold: bool(false),
  },
  card: {
    font: enumWith(LAYER_FONTS, 'sans'),
    bg: trimmedText(COLOR_MAX),
    bg_opacity: num(0, 1, 0.82),
    color: trimmedText(COLOR_MAX),
    accent: trimmedText(COLOR_MAX),
    align: enumWith(LAYER_ALIGNS, 'left'),
  },
  image: {
    border: trimmedText(COLOR_MAX),
    border_width: num(0, 0.05, 0),
    radius: num(0, 0.5, 0),
    shadow: bool(false),
  },
}

function normalizeStyle(type: LayerType, raw: unknown): LayerStyle {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: LayerStyle = {}
  for (const [key, schema] of Object.entries(STYLE_FIELDS[type])) {
    if (!(key in source) || source[key] === null || source[key] === undefined) continue
    const parsed = schema.safeParse(source[key])
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

function normalizePoints(raw: unknown, min: number): [number, number][] | null {
  if (!Array.isArray(raw)) return null
  const points: [number, number][] = []
  for (const item of raw.slice(0, LAYER_MAX_POINTS)) {
    const parsed = pointSchema.safeParse(item)
    if (parsed.success && parsed.data) points.push(parsed.data as [number, number])
  }
  return points.length >= min ? points : null
}

function normalizeLayer(raw: unknown, index: number): Layer | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const type = typeof source.type === 'string' && (LAYER_TYPES as readonly string[]).includes(source.type)
    ? (source.type as LayerType)
    : null
  if (!type) return null

  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 64) : `layer-${index + 1}`
  const base: LayerBase = {
    id,
    type,
    name: trimmedText(NAME_MAX, defaultLayerName(type)).parse(source.name),
    visible: bool(true).parse(source.visible),
    locked: bool(false).parse(source.locked),
    z: Math.trunc(num(0, 9999, index).parse(source.z)),
    opacity: num(0, 1, 1).parse(source.opacity),
    rotation: num(-360, 360, 0).parse(source.rotation),
  }
  const anchor = anchorSchema.safeParse(source.anchor)
  if (anchor.success && anchor.data && (anchor.data.asset_id !== undefined || anchor.data.semantic_id !== undefined)) {
    base.anchor = anchor.data as LayerAnchor
  }
  const style = normalizeStyle(type, source.style)

  if (type === 'polygon' || type === 'polyline') {
    const points = normalizePoints(source.points, type === 'polygon' ? 3 : 2)
    if (!points) return null
    return { ...base, type, points, style } as PolygonLayer | PolylineLayer
  }
  if (type === 'marker') {
    const at = normalizePoints([source.at], 1)
    if (!at) return null
    return { ...base, type, at: at[0], text: trimmedText(TEXT_MAX).parse(source.text), style }
  }
  const box = boxSchema.parse(source.box) as LayerBox
  if (type === 'label') {
    return { ...base, type, box, text: text(TEXT_MAX).parse(source.text), style }
  }
  if (type === 'card') {
    const fields = source.fields && typeof source.fields === 'object' ? (source.fields as Record<string, unknown>) : {}
    return {
      ...base,
      type,
      box,
      template: enumWith(CARD_TEMPLATES, 'name').parse(source.template) as CardTemplate,
      fields: {
        title: trimmedText(NAME_MAX).parse(fields.title),
        sub: trimmedText(NAME_MAX).parse(fields.sub),
        meta: trimmedText(NAME_MAX).parse(fields.meta),
      },
      style,
    }
  }
  const src = source.src && typeof source.src === 'object' ? (source.src as Record<string, unknown>) : {}
  const path = trimmedText(PATH_MAX).parse(src.path)
  if (!path) return null
  return {
    ...base,
    type,
    box,
    src: { path },
    fit: enumWith(IMAGE_FITS, 'cover').parse(source.fit) as 'contain' | 'cover',
    style,
  }
}

export function defaultLayerName(type: LayerType): string {
  const names: Record<LayerType, string> = {
    polygon: '区域',
    polyline: '路线',
    marker: '地点',
    label: '文字',
    card: '卡片',
    image: '图片',
  }
  return names[type]
}

const baseFilterSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : undefined),
  z
    .object({
      paper: num(0, 1, 0),
      tint: enumWith(BASE_TINTS, 'none'),
      tint_strength: num(0, 1, 0.35),
      vignette: num(0, 1, 0),
    })
    .optional(),
)

/**
 * 解析并规范化图层文档：字段白名单 + 范围钳制 + 按 z 稳定排序（z 相同按原序）。
 * 非法图层单独丢弃；整体非法时退化为空文档（base.path 为空）。
 */
export function normalizeLayerDoc(raw: unknown): LayerDoc {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const baseSource = source.base && typeof source.base === 'object' ? (source.base as Record<string, unknown>) : {}
  const base: LayerDocBase = {
    path: trimmedText(PATH_MAX).parse(baseSource.path),
    width: Math.trunc(num(1, 16384, 1344).parse(baseSource.width)),
    height: Math.trunc(num(1, 16384, 768).parse(baseSource.height)),
  }
  const filter = baseFilterSchema.safeParse(baseSource.filter)
  if (filter.success && filter.data) base.filter = filter.data as BaseFilter

  const rawLayers = Array.isArray(source.layers) ? source.layers.slice(0, LAYER_MAX_COUNT) : []
  const layers = rawLayers
    .map((item, index) => normalizeLayer(item, index))
    .filter((item): item is Layer => Boolean(item))
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => (a.layer.z - b.layer.z) || (a.index - b.index))
    .map(({ layer }) => layer)

  const seen = new Set<string>()
  layers.forEach((layer, index) => {
    if (!seen.has(layer.id)) {
      seen.add(layer.id)
      return
    }
    let suffix = index + 1
    let candidate = `${layer.id}-${suffix}`
    while (seen.has(candidate)) candidate = `${layer.id}-${++suffix}`
    layer.id = candidate
    seen.add(candidate)
  })

  return {
    version: LAYER_DOC_VERSION,
    base,
    theme: enumWith(LAYER_THEMES, 'archival').parse(source.theme) as LayerTheme,
    layers,
  }
}
