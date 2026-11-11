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
import textSpec from '../config/layer-text-spec.json'
import { normalizeCrop } from './layer-quality.js'

export const LAYER_DOC_VERSION = 1

export const LAYER_THEMES = ['archival', 'clean', 'ink'] as const
export type LayerTheme = (typeof LAYER_THEMES)[number]

export const LAYER_TYPES = ['polygon', 'polyline', 'marker', 'label', 'card', 'image', 'text'] as const
export type LayerType = (typeof LAYER_TYPES)[number]

export const CARD_TEMPLATES = ['name', 'year', 'chapter'] as const
export type CardTemplate = (typeof CARD_TEMPLATES)[number]

export const LAYER_FONTS = ['sans', 'serif', 'kai', 'hand'] as const
export type LayerFont = (typeof LAYER_FONTS)[number]

/** Poster 固定文本变量（Issue #72）：变量层文本只读，渲染时按剧集数据现场解析。 */
export const LAYER_VARIABLES = ['project_title', 'episode_title', 'episode_no'] as const
export type LayerVariable = (typeof LAYER_VARIABLES)[number]
export interface LayerVariables {
  project_title: string
  episode_title: string
  episode_no: string
}

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
// 跨 Issue 契约（#44 handoff §3）：坐标归一化到整张源图；contain 留白（#94）时取景框会超出
// 源图（1920×1088 底图配 9:16 成片的取景框是 y∈[-1.06, 2.06]），留白带里也要能放文字，
// 所以钳制放宽到 [-3, 4]，仍然拦得住脏数据。
const COORD_MIN = -3
const COORD_MAX = 4

export interface LayerAnchor {
  asset_id?: number
  semantic_id?: string
  /** Source label snapshot, independent of editable layer.name; used to detect renamed semantic entries. */
  semantic_name?: string
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
  /** 固定文本绑定（Issue #72）：有值时渲染用变量值，`text` 仅作占位/显示快照 */
  variable?: LayerVariable
  style: LayerStyle
}
export interface CardLayer extends LayerBase {
  type: 'card'
  box: LayerBox
  template: CardTemplate
  /** 卡片字段契约（Issue #58）：`years` = 年代/年份行（「1700–1721」），独立于副标题与右下角注 */
  fields: { title: string; sub: string; meta: string; years: string }
  style: LayerStyle
}
export interface LayerAssetRef {
  asset_kind: 'prop' | 'scene' | 'character'
  asset_id: number
  version_task_id: number | null
}

export interface ImageSrc {
  path: string
  asset_kind?: LayerAssetRef['asset_kind']
  asset_id?: number
  version_task_id?: number | null
}

export interface ImageLayer extends LayerBase {
  type: 'image'
  box: LayerBox
  src: ImageSrc
  fit: (typeof IMAGE_FITS)[number]
  style: LayerStyle
}

/**
 * 模板文本框（Issue #96）：只存类型与字段，位置/样式由规范按文档级 `text_layout`（成套位置）
 * 计算（`services/layer-text.ts`）。画面坐标、不可拖动、不可旋转、不锚定。
 */
export interface TextLayer extends LayerBase {
  type: 'text'
  /** 规范里的类型 id（date / heading / statement / …） */
  role: string
  /** 字段值：普通字段为字符串，列表字段（items）为字符串数组 */
  fields: Record<string, string | string[]>
  /** Poster 变量绑定：字段 → 变量（如 poster_project.main → project_title） */
  field_vars?: Record<string, LayerVariable>
}

export type Layer = PolygonLayer | PolylineLayer | MarkerLayer | LabelLayer | CardLayer | ImageLayer | TextLayer

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
  /** Non-destructive bounds, normalized to the whole source image. Full frame is omitted. */
  crop?: LayerBox
  ref?: LayerAssetRef
  /**
   * 底图原件的真实像素（Issue #58，契约 §3.2 / §10 R6）：裁切与清晰度判定的真源。
   * 旧文档没有这两个字段，读入时补探测，缺省即「未测量」。
   */
  source_width?: number
  source_height?: number
}

export interface LayerDoc {
  version: number
  base: LayerDocBase
  theme: LayerTheme
  layers: Layer[]
  /** 模板文本框的成套位置 id（Issue #96）；没有 text 层时可缺省 */
  text_layout?: string
}

interface TextSpecShape {
  roles: Record<string, { name: string; fields: Array<{ key: string }>; styles: Record<string, { rows: Array<{ type?: string; field?: string }> }> }>
  layouts: Record<string, Array<{ id: string }>>
}
const TEXT_SPEC_SHAPE = textSpec as unknown as TextSpecShape
const TEXT_LAYOUT_IDS: string[] = Object.values(TEXT_SPEC_SHAPE.layouts).flatMap(list => list.map(item => item.id))
const TEXT_FIELD_MAX = 200
const TEXT_LIST_MAX = 6

/** 字段是否列表：规范任一样式里该字段的行类型为 list。 */
function textFieldIsList(role: string, key: string): boolean {
  const styles = TEXT_SPEC_SHAPE.roles[role]?.styles || {}
  return Object.values(styles).some(style => style.rows.some(row => row.field === key && row.type === 'list'))
}

function cleanTextValue(value: unknown): string {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  return raw.replace(/\r\n?/g, '\n').slice(0, TEXT_FIELD_MAX).trim()
}

function normalizeTextFields(role: string, raw: unknown): Record<string, string | string[]> {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, string | string[]> = {}
  for (const field of TEXT_SPEC_SHAPE.roles[role].fields) {
    const value = source[field.key]
    if (textFieldIsList(role, field.key)) {
      const items = (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [])
        .map(cleanTextValue)
        .filter(item => item !== '')
        .slice(0, TEXT_LIST_MAX)
      if (items.length) out[field.key] = items
    } else {
      const text = cleanTextValue(value)
      if (text) out[field.key] = text
    }
  }
  return out
}

function normalizeFieldVars(role: string, raw: unknown): Record<string, LayerVariable> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const out: Record<string, LayerVariable> = {}
  for (const field of TEXT_SPEC_SHAPE.roles[role].fields) {
    const value = source[field.key]
    if (typeof value === 'string' && (LAYER_VARIABLES as readonly string[]).includes(value) && !textFieldIsList(role, field.key)) {
      out[field.key] = value as LayerVariable
    }
  }
  return Object.keys(out).length ? out : undefined
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
    w: num(0.005, 7, 0.3),
    h: num(0.005, 7, 0.12),
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
      semantic_name: z.preprocess(
        v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, NAME_MAX) : undefined),
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
    label_dx: num(-0.5, 0.5, 0.016),
    label_dy: num(-0.5, 0.5, -0.012),
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
    italic: bool(false),
    shadow: bool(false),
  },
  card: {
    font: enumWith(LAYER_FONTS, 'sans'),
    scale: num(0.4, 2.5, 1),
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
  text: {},
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
  if (type === 'text') {
    const role = typeof source.role === 'string' ? source.role.trim() : ''
    if (!TEXT_SPEC_SHAPE.roles[role]) return null
    const layer: TextLayer = {
      ...base,
      type,
      rotation: 0,
      name: trimmedText(NAME_MAX, TEXT_SPEC_SHAPE.roles[role].name).parse(source.name),
      role,
      fields: normalizeTextFields(role, source.fields),
    }
    delete layer.anchor
    const vars = normalizeFieldVars(role, source.field_vars)
    if (vars) layer.field_vars = vars
    return layer
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
    const variable = typeof source.variable === 'string' && (LAYER_VARIABLES as readonly string[]).includes(source.variable)
      ? source.variable as LayerVariable
      : undefined
    const label: LabelLayer = { ...base, type, box, text: text(TEXT_MAX).parse(source.text), style }
    if (variable) label.variable = variable
    return label
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
        years: trimmedText(NAME_MAX).parse(fields.years),
      },
      style,
    }
  }
  const src = source.src && typeof source.src === 'object' ? (source.src as Record<string, unknown>) : {}
  const path = trimmedText(PATH_MAX).parse(src.path)
  if (!path) return null
  const imageSrc: ImageSrc = { path }
  const ref = normalizeAssetRef(src)
  if (ref) Object.assign(imageSrc, ref)
  return {
    ...base,
    type,
    box,
    src: imageSrc,
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
    text: '文本框',
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

function normalizeAssetRef(raw: unknown): LayerAssetRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (!['prop', 'scene', 'character'].includes(String(value.asset_kind))) return undefined
  const id = Number(value.asset_id)
  if (!Number.isSafeInteger(id) || id <= 0) return undefined
  const task = Number(value.version_task_id)
  return {
    asset_kind: value.asset_kind as LayerAssetRef['asset_kind'],
    asset_id: id,
    version_task_id: value.version_task_id != null && Number.isSafeInteger(task) && task > 0 ? task : null,
  }
}

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
  // #58：底图真实像素（R6 的裁切真源）；旧文档没有就留空，由保存时补探测
  const sourceWidth = Math.trunc(num(1, Number.MAX_SAFE_INTEGER, 0).parse(baseSource.source_width ?? baseSource.sourceWidth))
  const sourceHeight = Math.trunc(num(1, Number.MAX_SAFE_INTEGER, 0).parse(baseSource.source_height ?? baseSource.sourceHeight))
  if (sourceWidth > 0 && sourceHeight > 0) {
    base.source_width = sourceWidth
    base.source_height = sourceHeight
  }
  const crop = normalizeCrop(baseSource.crop)
  if (crop.x !== 0 || crop.y !== 0 || crop.w !== 1 || crop.h !== 1) base.crop = crop
  const ref = normalizeAssetRef(baseSource.ref)
  if (ref) base.ref = ref
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

  const doc: LayerDoc = {
    version: LAYER_DOC_VERSION,
    base,
    theme: enumWith(LAYER_THEMES, 'archival').parse(source.theme) as LayerTheme,
    layers,
  }
  if (typeof source.text_layout === 'string' && TEXT_LAYOUT_IDS.includes(source.text_layout)) doc.text_layout = source.text_layout
  return doc
}

export interface LayerDocProblem {
  /** 出问题的字段路径，如 `layers[3].style.width` */
  path: string
  message: string
}

const STRICT_PROBLEM_LIMIT = 40

function describeValue(value: unknown): string {
  const json = JSON.stringify(value)
  return json === undefined ? 'undefined' : json.length > 80 ? `${json.slice(0, 77)}...` : json
}

/** 实际值与规范化结果逐字段对照：哪里会被补、丢、钳、改，就在哪里报出来 */
function diffAgainstNormalized(actual: unknown, expected: unknown, path: string, out: LayerDocProblem[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, message: `必须是数组，当前是 ${describeValue(actual)}` })
      return
    }
    if (actual.length !== expected.length) {
      out.push({ path, message: `元素个数 ${actual.length} 会被规范化成 ${expected.length}（越界、非法或超上限的元素会被丢弃）` })
      return
    }
    expected.forEach((item, index) => diffAgainstNormalized(actual[index], item, `${path}[${index}]`, out))
    return
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push({ path, message: `必须是对象，当前是 ${describeValue(actual)}` })
      return
    }
    const actualRecord = actual as Record<string, unknown>
    const expectedRecord = expected as Record<string, unknown>
    for (const [key, value] of Object.entries(expectedRecord)) {
      const child = path ? `${path}.${key}` : key
      if (!(key in actualRecord)) out.push({ path: child, message: `缺少该字段；请显式写出 ${describeValue(value)}` })
      else diffAgainstNormalized(actualRecord[key], value, child, out)
    }
    for (const key of Object.keys(actualRecord)) {
      if (!(key in expectedRecord)) {
        out.push({ path: path ? `${path}.${key}` : key, message: `不支持该字段或取值非法（${describeValue(actualRecord[key])}），规范化会把它丢掉；请删除或改成合法值` })
      }
    }
    return
  }
  if (actual !== expected) {
    out.push({ path, message: `值 ${describeValue(actual)} 会被规范化成 ${describeValue(expected)}（超出允许范围、类型不对或缺省回落）；请直接写成合法值` })
  }
}

/** 键序无关的等值比较（严格校验的最终判据） */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * 地图文档的坐标必须落在整幅底图内（[0,1]）：地图的语义坐标直接按像素外发，出血会把
 * 「扬州」画到图片外面。#94 把通用坐标范围放宽到 [-3,4] 是为了 contain 留白带里的文字，
 * 地图路径不走留白，这里收回严格口径。
 */
function clampMapLayer(layer: Layer): Layer {
  const unit = (n: number) => Math.min(1, Math.max(0, n))
  if (layer.type === 'polygon' || layer.type === 'polyline') {
    return { ...layer, points: layer.points.map(([x, y]) => [unit(x), unit(y)] as [number, number]) }
  }
  if (layer.type === 'marker') return { ...layer, at: [unit(layer.at[0]), unit(layer.at[1])] as [number, number] }
  if (layer.type === 'text') return layer
  return { ...layer, box: { ...layer.box, x: unit(layer.box.x), y: unit(layer.box.y), w: Math.min(2, layer.box.w), h: Math.min(2, layer.box.h) } }
}

function clampMapCoords(doc: LayerDoc): LayerDoc {
  return { ...doc, layers: doc.layers.map(clampMapLayer) }
}

/**
 * 严格校验（Issue #90，地图工作流专用）：文档必须**原样**就是规范化结果。
 *
 * 判据唯一：`normalizeLayerDoc(doc)` 与 doc 深等。规则仍只有 normalizeLayerDoc 一份，
 * 这里只负责把「规范化会改动的地方」逐字段指出来——钳制、补缺省、丢字段、排序、id 去重
 * 都是静默修正，地图路径一律拒收，由提交方（模型或编辑器）自己改成合法值。
 */
export function strictLayerDocProblems(raw: unknown): { doc: LayerDoc; problems: LayerDocProblem[] } {
  const doc = clampMapCoords(normalizeLayerDoc(raw))
  const problems: LayerDocProblem[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { doc, problems: [{ path: '', message: '图层文档必须是 JSON 对象' }] }
  }
  const source = raw as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!['version', 'base', 'theme', 'layers'].includes(key)) problems.push({ path: key, message: '不支持的顶层字段，规范化会把它丢掉；请删除' })
  }
  diffAgainstNormalized(source.version, doc.version, 'version', problems)
  diffAgainstNormalized(source.theme, doc.theme, 'theme', problems)
  diffAgainstNormalized(source.base, doc.base, 'base', problems)

  const rawLayers: unknown[] = Array.isArray(source.layers) ? source.layers : []
  if (!Array.isArray(source.layers)) problems.push({ path: 'layers', message: '必须是图层数组' })
  if (rawLayers.length > LAYER_MAX_COUNT) {
    problems.push({ path: 'layers', message: `图层数 ${rawLayers.length} 超过上限 ${LAYER_MAX_COUNT}，多出的会被丢掉；请合并或删减图层` })
  }
  const kept: Layer[] = []
  rawLayers.slice(0, LAYER_MAX_COUNT).forEach((item, index) => {
    const normalized = normalizeLayer(item, index)
    const layer = normalized ? clampMapLayer(normalized) : normalized
    const path = `layers[${index}]`
    if (!layer) {
      const type = item && typeof item === 'object' ? (item as Record<string, unknown>).type : undefined
      problems.push({
        path,
        message: `该图层会被整体丢弃：type=${describeValue(type)}；type 必须是 ${LAYER_TYPES.join('/')}，`
          + 'polygon 至少 3 个合法点、polyline 至少 2 个、marker 需要合法 at、image 需要 src.path',
      })
      return
    }
    if (layer.type === 'text') {
      problems.push({ path, message: '地图不使用模板文本框（text）；地名与标注请用锚定的 label / marker 图层' })
      return
    }
    diffAgainstNormalized(item, layer, path, problems)
    kept.push(layer)
  })
  const ids = kept.map(layer => layer.id)
  const duplicate = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicate.length) {
    problems.push({ path: 'layers', message: `图层 id 重复：${[...new Set(duplicate)].join('、')}；规范化会给重复者加后缀，请自己改成唯一 id` })
  }
  const zs = kept.map(layer => layer.z)
  if (zs.some((z, index) => index > 0 && z < zs[index - 1]!)) {
    problems.push({ path: 'layers', message: `图层必须按 z 从小到大排列（当前 z 序列 ${describeValue(zs)}）；规范化会重排，请自己按 z 排好` })
  }
  if (!problems.length && canonicalJson(source) !== canonicalJson(doc)) {
    problems.push({ path: '', message: '图层文档与规范化结果不一致；请按 schema 写出完整、合法的文档' })
  }
  const overflow = problems.length - STRICT_PROBLEM_LIMIT
  return {
    doc,
    problems: overflow > 0
      ? [...problems.slice(0, STRICT_PROBLEM_LIMIT), { path: '', message: `……另有 ${overflow} 处同类问题未列出` }]
      : problems,
  }
}
