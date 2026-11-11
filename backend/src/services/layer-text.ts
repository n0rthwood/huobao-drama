/**
 * 模板文本框排版引擎（Issue #96）。**前后端同源**：本文件与
 * `frontend/app/utils/layerText.js` 必须逐行等价，行为由 `backend/tests/layer-text.test.mjs`
 * 逐例对照。规范数据只有一份：`backend/src/config/layer-text-spec.json`（前端经
 * `GET /api/v1/layer-docs/text-spec` 取得后调用 `setLayerTextSpec`）。
 *
 * 模型：
 * - 文本框 = 类型（role）× 成套位置（layout）。一套里每个类型恰好一个槽位，所以图层只存
 *   `role`，位置由文档级 `text_layout` 决定；同 `zone` 的槽位互为替代，同一时刻只能出现一个。
 * - 文本框是**画面坐标**：不随取景框推拉缩放、不可拖动、不可旋转（安全区按成片画面定义）。
 * - 单位：字号/内边距/线宽 = 成片高度 H 的比例；框宽与 x = 成片宽度 W 的比例；y = H 的比例。
 * - 度量沿用 layer-svg 的固定 em 模型（全角 1 / 空格 .33 / 其它 .55），数字与紧随单位不拆行，
 *   `phrase` 断行优先在标点处断，字段里的 `\n` 永远是手动断行。
 * - 超长：先按 5% 步进缩到本类型 `min_scale`（警告「建议改短」），仍放不下即错误。
 */
import specJson from '../config/layer-text-spec.json'
import type { LayerDoc, LayerVariables, TextLayer } from './layer-doc.js'
import { BASELINE_EM, LINE_HEIGHT_EM, charWidthEm } from './layer-svg.js'

export type TextFamily = '16:9' | '9:16'
export type TextMedium = 'video' | 'poster'
export type TextFieldValue = string | string[]

export interface TextFieldDef { key: string; label: string; optional?: boolean; pattern?: string; pattern_hint?: string }
export interface TextRowDef {
  type?: 'text' | 'list' | 'rule'
  field?: string
  font?: string
  weight?: number
  size: number
  color?: string
  tracking?: number
  max_lines?: number
  gap_after?: number
  align?: 'left' | 'center' | 'right'
  wrap?: 'greedy' | 'phrase'
  drop_break_punct?: boolean
  shadow?: boolean
  shadow_blur?: number
  shadow_opacity?: number
  stroke?: string
  stroke_width?: number
  opacity?: number
  line_height?: number
  thickness?: number
  length?: number
  gap?: number
  marker?: string
  marker_color?: string
  max_items?: number
  item_max_lines?: number
  item_gap?: number
}
export interface TextPlateDef {
  kind: 'none' | 'solid' | 'gradient' | 'scrim'
  color?: string
  opacity?: number
  radius?: number
  fit?: 'content' | 'box'
  direction?: 'left' | 'right' | 'up' | 'down'
  extend?: number | number[]
  solid_from?: number
  feather?: number
}
export interface TextDecorDef { kind: 'bar'; side?: 'left' | 'right' | 'top' | 'bottom'; thickness?: number; color?: string; gap?: number; length?: number; inset?: number }
export interface TextStyleDef {
  width: number
  padding?: number[]
  plate?: TextPlateDef
  decor?: TextDecorDef[]
  min_scale?: number
  rows: TextRowDef[]
}
export interface TextRoleDef {
  name: string
  category: string
  purpose: string
  extract: string
  fields: TextFieldDef[]
  styles: Record<string, TextStyleDef>
}
export interface TextSlotDef {
  id: string
  role: string
  x: number
  y: number
  w?: number
  anchor?: string
  align?: 'left' | 'center' | 'right'
  zone?: string
}
export interface TextLayoutDef { id: string; name: string; slots: TextSlotDef[] }
export interface TextSafeDef { x0: number; y0: number; x1: number; y1: number; avoid?: Array<{ name: string; x0: number; y0: number; x1: number; y1: number }> }
export interface TextSpec {
  version: number
  fonts: Record<string, string>
  palette: Record<string, string>
  min_gap: number
  safe: Record<string, TextSafeDef>
  roles: Record<string, TextRoleDef>
  layouts: Record<string, TextLayoutDef[]>
}

export interface TextRect { x: number; y: number; w: number; h: number }
export type TextProblemLevel = 'error' | 'warning'
export interface TextProblem {
  code: string
  level: TextProblemLevel
  layer_id?: string
  field?: string
  message: string
}

export const TEXT_SPEC: TextSpec = specJson as unknown as TextSpec
export const TEXT_ROLE_IDS: string[] = Object.keys(TEXT_SPEC.roles)
/** 视频（图层段）只用前七类；Poster 专用三类只在 Poster 版式里出现。 */
export const POSTER_ONLY_ROLES = ['poster_project', 'poster_title', 'poster_details']
/** 字段长度硬上限（规范化用，远大于任何槽位容量；真正的容量由排版判定）。 */
export const TEXT_FIELD_MAX = 200
export const TEXT_LIST_MAX = 6

const NO_LINE_START = '，。、；：？！）》」』”’%,.;:?!)]}…—·'
const PHRASE_END = '，、：；。！？…—·）」』”’ '
const UNIT_GLUE = '年月日号时分秒世纪代万亿千百十石斤两里米吨岁人艘座辆个次%℃'
const UNIT_TAIL = '年月日号时分秒世纪代万亿千百十石斤两里米吨岁人艘座辆个次'
const EPS = 1e-9
const SCALE_STEP = 0.05

/** 画幅家族：宽 ≥ 高（16:9 / 4:3 / 1:1）用横版规范，否则用竖版规范。 */
export function textFamilyOf(width: number, height: number): TextFamily {
  return width >= height ? '16:9' : '9:16'
}

/** 套 id → 所属规范键（`16:9/video` 等）、家族、媒介与定义；未知 id 返回 null。 */
export function textLayoutById(id: string | undefined | null): { key: string; family: TextFamily; medium: TextMedium; layout: TextLayoutDef } | null {
  if (!id) return null
  for (const key of Object.keys(TEXT_SPEC.layouts)) {
    const layout = TEXT_SPEC.layouts[key].find(item => item.id === id)
    if (layout) {
      const [family, medium] = key.split('/') as [TextFamily, TextMedium]
      return { key, family, medium, layout }
    }
  }
  return null
}

export function textLayoutsFor(family: TextFamily, medium: TextMedium): TextLayoutDef[] {
  return TEXT_SPEC.layouts[`${family}/${medium}`] || []
}

/** 媒介可用的类型：视频 = 通用七类；Poster = 版式里出现的全部类型。 */
export function textRolesFor(medium: TextMedium): string[] {
  return medium === 'poster' ? TEXT_ROLE_IDS.slice() : TEXT_ROLE_IDS.filter(id => POSTER_ONLY_ROLES.indexOf(id) === -1)
}

function roleStyle(roleId: string, key: string): TextStyleDef | null {
  const role = TEXT_SPEC.roles[roleId]
  if (!role) return null
  const family = key.split('/')[0]
  return role.styles[key] || role.styles[family] || null
}

// ---------- 度量与断行 ----------

export function measureTextWidthEm(text: string, tracking = 0): number {
  let width = 0
  for (const ch of String(text ?? '')) width += charWidthEm(ch) + tracking
  return width
}

function isWide(ch: string): boolean {
  return charWidthEm(ch) === 1
}

function textTokens(paragraph: string): string[] {
  const out: string[] = []
  let buffer = ''
  for (const ch of paragraph) {
    if (buffer && /[0-9]$/.test(buffer) && UNIT_GLUE.indexOf(ch) !== -1) { buffer += ch; continue }
    if (buffer && /[0-9]/.test(buffer) && UNIT_TAIL.indexOf(buffer[buffer.length - 1]) !== -1 && UNIT_GLUE.indexOf(ch) !== -1) { buffer += ch; continue }
    if (ch === ' ' || isWide(ch)) {
      if (buffer) { out.push(buffer); buffer = '' }
      out.push(ch)
    } else buffer += ch
  }
  if (buffer) out.push(buffer)
  return out
}

function wrapParagraphGreedy(paragraph: string, maxEm: number, tracking: number): string[] {
  const lines: string[] = []
  let line = ''
  let width = 0
  for (const token of textTokens(paragraph)) {
    const tokenWidth = measureTextWidthEm(token, tracking)
    const forbidden = token.length === 1 && NO_LINE_START.indexOf(token) !== -1
    if (width > 0 && width + tokenWidth > maxEm + EPS && !forbidden) {
      lines.push(line.replace(/\s+$/, ''))
      line = ''
      width = 0
      if (token === ' ') continue
    }
    if (tokenWidth > maxEm + EPS && Array.from(token).length > 1) {
      for (const ch of token) {
        const chWidth = charWidthEm(ch) + tracking
        if (width > 0 && width + chWidth > maxEm + EPS) {
          lines.push(line)
          line = ''
          width = 0
        }
        line += ch
        width += chWidth
      }
      continue
    }
    line += token
    width += tokenWidth
  }
  lines.push(line)
  return lines
}

/** 均衡断行：行数不变时把行宽收到最窄，避免末行孤字。 */
function wrapParagraphBalanced(paragraph: string, maxEm: number, tracking: number): string[] {
  const base = wrapParagraphGreedy(paragraph, maxEm, tracking)
  if (base.length < 2) return base
  let lo = 1
  let hi = maxEm
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (wrapParagraphGreedy(paragraph, mid, tracking).length <= base.length) hi = mid
    else lo = mid
  }
  return wrapParagraphGreedy(paragraph, hi, tracking)
}

/** 短语优先断行：在标点/空格后断；行数不多于均衡断行时采用，否则退回均衡断行。 */
function wrapParagraphPhrase(paragraph: string, maxEm: number, tracking: number): string[] {
  const phrases: string[] = []
  let current = ''
  for (const ch of paragraph) {
    current += ch
    if (PHRASE_END.indexOf(ch) !== -1) { phrases.push(current); current = '' }
  }
  if (current) phrases.push(current)
  const lines: string[] = []
  let line = ''
  for (const phrase of phrases) {
    if (!line || measureTextWidthEm(line + phrase, tracking) <= maxEm + EPS) { line += phrase; continue }
    lines.push(line.replace(/\s+$/, ''))
    line = phrase.replace(/^\s+/, '')
  }
  if (line) lines.push(line)
  const fits = lines.every(item => measureTextWidthEm(item, tracking) <= maxEm + EPS)
  const balanced = wrapParagraphBalanced(paragraph, maxEm, tracking)
  return fits && lines.length <= balanced.length ? lines : balanced
}

/** 模板文本框断行：`\n` 为手动断行；`greedy` 贪心、`phrase` 标点短语优先。 */
export function wrapTemplateText(text: string, maxEm: number, tracking = 0, mode: 'greedy' | 'phrase' = 'greedy'): string[] {
  const out: string[] = []
  for (const paragraph of String(text ?? '').split('\n')) {
    const lines = mode === 'phrase'
      ? wrapParagraphPhrase(paragraph, maxEm, tracking)
      : wrapParagraphGreedy(paragraph, maxEm, tracking)
    for (const line of lines) out.push(line)
  }
  return out
}

// ---------- SVG 片段 ----------

function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function paint(value: string | undefined): string {
  if (!value) return '#000000'
  return value.charAt(0) === '$' ? (TEXT_SPEC.palette[value.slice(1)] || '#000000') : value
}

function fontFamily(font: string | undefined): string {
  const name = TEXT_SPEC.fonts[font || 'serif'] || TEXT_SPEC.fonts.serif
  return `'${name}'`
}

interface DrawContext { H: number; defs: string[] }

function drawLines(row: TextRowDef, lines: string[], x: number, y: number, w: number, size: number, lineHeight: number, ctx: DrawContext, idPrefix: string): string {
  const align = row.align || 'left'
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
  const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x
  const spacing = row.tracking ? ` letter-spacing="${fmt(row.tracking * size)}"` : ''
  const common = `font-family="${esc(fontFamily(row.font))}" font-size="${fmt(size)}" font-weight="${row.weight || 400}" text-anchor="${anchor}"${spacing} xml:space="preserve"`
  let shadow = ''
  if (row.shadow) {
    const id = `${idPrefix}-sh`
    ctx.defs.push(`<filter id="${esc(id)}" x="-20%" y="-30%" width="140%" height="160%"><feDropShadow dx="0" dy="${fmt(size * 0.04)}"`
      + ` stdDeviation="${fmt(size * (row.shadow_blur ?? 0.12))}" flood-color="#000000" flood-opacity="${fmt(row.shadow_opacity ?? 0.6)}"/></filter>`)
    shadow = ` filter="url(#${esc(id)})"`
  }
  let out = ''
  lines.forEach((line, index) => {
    const baseline = y + size * BASELINE_EM + index * lineHeight
    const span = `<tspan x="${fmt(tx)}" y="${fmt(baseline)}">${esc(line)}</tspan>`
    if (row.stroke && row.stroke_width) {
      out += `<text ${common} fill="${esc(paint(row.stroke))}" stroke="${esc(paint(row.stroke))}" stroke-width="${fmt(row.stroke_width * ctx.H * 2)}"`
        + ` stroke-linejoin="round">${span}</text>`
    }
    out += `<text ${common} fill="${esc(paint(row.color))}"${row.opacity != null ? ` fill-opacity="${fmt(row.opacity)}"` : ''}${shadow}>${span}</text>`
  })
  return out
}

interface RowLayout { height: number; widthUsed: number; draw: (x: number, y: number, w: number) => string }

interface TextRowResult { lines: string[]; height: number; widthUsed: number; draw: (x: number, y: number, w: number) => string }

function layoutTextRow(row: TextRowDef, text: string, contentWidth: number, scale: number, ctx: DrawContext, idPrefix: string): TextRowResult {
  const size = row.size * ctx.H * scale
  const tracking = row.tracking || 0
  const wrapped = wrapTemplateText(text, contentWidth / size, tracking, row.wrap === 'phrase' ? 'phrase' : 'greedy')
  const lines = row.drop_break_punct
    ? wrapped.map((line, index) => (index < wrapped.length - 1 ? line.replace(/[，、,]$/, '') : line))
    : wrapped
  const lineHeight = size * (row.line_height || LINE_HEIGHT_EM)
  const height = lines.length ? size * BASELINE_EM + (lines.length - 1) * lineHeight + size * 0.22 : 0
  let widthUsed = 0
  for (const line of lines) widthUsed = Math.max(widthUsed, measureTextWidthEm(line, tracking) * size)
  return { lines, height, widthUsed, draw: (x, y, w) => drawLines(row, lines, x, y, w, size, lineHeight, ctx, idPrefix) }
}

/** 字段的实际值：Poster 变量绑定优先（`field_vars`），否则取 `fields`。 */
export function textFieldValue(layer: TextLayer, key: string, variables?: LayerVariables): TextFieldValue {
  const bound = layer.field_vars ? layer.field_vars[key] : undefined
  if (bound) return variables ? String(variables[bound] || '') : ''
  const value = layer.fields ? layer.fields[key] : undefined
  if (Array.isArray(value)) return value.map(item => String(item ?? '')).filter(item => item.trim() !== '')
  return value == null ? '' : String(value)
}

function isEmptyValue(value: TextFieldValue): boolean {
  return Array.isArray(value) ? value.length === 0 : value.trim() === ''
}

export interface TextBoxLayout {
  role: string
  slot: TextSlotDef
  zone: string
  /** 像素矩形（成片坐标，不含柔光外扩与装饰线） */
  rect: TextRect
  scale: number
  /** 底板 SVG（含 defs），合成时先画所有底板再画所有文字 */
  bg: string
  fg: string
  problems: TextProblem[]
}

interface Overflow { field: string; message: string }

/**
 * 在给定套/成片尺寸下排一个文本框。`worst=true` 用「每行写满、每条写满」的内容排版，
 * 用于版式自检与容量估计。
 */
export function layoutTextBox(
  roleId: string,
  layoutId: string,
  size: { width: number; height: number },
  values: Record<string, TextFieldValue>,
  options: { idPrefix?: string; worst?: boolean; layerId?: string } = {},
): TextBoxLayout | null {
  const located = textLayoutById(layoutId)
  if (!located) return null
  const slot = located.layout.slots.find(item => item.role === roleId)
  const style = roleStyle(roleId, located.key)
  const role = TEXT_SPEC.roles[roleId]
  if (!slot || !style || !role) return null
  const W = size.width
  const H = size.height
  const ctx: DrawContext = { H, defs: [] }
  const idPrefix = options.idPrefix || `t-${roleId}`
  const problems: TextProblem[] = []
  const layerId = options.layerId
  const boxWidth = (slot.w ?? style.width) * W
  const padding = style.padding || [0, 0, 0, 0]
  const pt = padding[0] * H
  const pr = padding[1] * H
  const pb = padding[2] * H
  const pl = padding[3] * H
  const contentWidth = Math.max(1, boxWidth - pl - pr)
  const minScale = style.min_scale ?? 1

  if (!options.worst) {
    for (const field of role.fields) {
      const value = values[field.key] ?? ''
      const empty = isEmptyValue(value)
      if (!field.optional && empty) {
        problems.push({ code: 'text_field_missing', level: 'error', layer_id: layerId, field: field.key, message: `「${role.name}」缺少必填字段「${field.label}」` })
      }
      if (field.pattern && !empty) {
        const joined = Array.isArray(value) ? value.join('') : value
        if (!new RegExp(field.pattern).test(joined)) {
          problems.push({ code: 'text_field_pattern', level: 'error', layer_id: layerId, field: field.key, message: `「${role.name}」的「${field.label}」不符合要求：${field.pattern_hint || '格式不符'}` })
        }
      }
    }
  }

  const attempt = (scale: number): { rows: RowLayout[]; overflow: Overflow[] } => {
    const rows: RowLayout[] = []
    const overflow: Overflow[] = []
    style.rows.forEach((rawRow, rowIndex) => {
      const row: TextRowDef = slot.align ? { ...rawRow, align: slot.align } : rawRow
      const kind = row.type || 'text'
      if (kind === 'rule') {
        const thickness = (row.thickness || 0) * H
        const gap = (row.gap ?? 0.006) * H
        const length = row.length ?? 1
        rows.push({
          height: thickness + gap * 2,
          widthUsed: length <= 1 ? length * contentWidth : length * H,
          draw: (x, y, w) => {
            const len = length <= 1 ? length * w : length * H
            const rx = row.align === 'center' ? x + (w - len) / 2 : row.align === 'right' ? x + w - len : x
            return `<rect x="${fmt(rx)}" y="${fmt(y + gap)}" width="${fmt(len)}" height="${fmt(thickness)}" fill="${esc(paint(row.color))}"`
              + `${row.opacity != null ? ` fill-opacity="${fmt(row.opacity)}"` : ''}/>`
          },
        })
        return
      }
      const field = row.field || ''
      const value = values[field] ?? ''
      if (!options.worst && isEmptyValue(value)) return
      const gapAfter = (row.gap_after || 0) * H
      const fontSize = row.size * H * scale
      const tracking = row.tracking || 0
      if (kind === 'text') {
        const maxLines = row.max_lines || 1
        const perLine = Math.floor(contentWidth / fontSize / (1 + tracking) + EPS)
        const text = options.worst ? '国'.repeat(Math.max(1, perLine) * maxLines) : (Array.isArray(value) ? value.join('') : value)
        const result = layoutTextRow(row, text, contentWidth, scale, ctx, `${idPrefix}-${rowIndex}`)
        if (result.lines.length > maxLines) overflow.push({ field, message: `${result.lines.length} 行，超过 ${maxLines} 行` })
        rows.push({ height: result.height + gapAfter, widthUsed: result.widthUsed, draw: result.draw })
        return
      }
      // list
      const maxItems = row.max_items || 3
      const itemMaxLines = row.item_max_lines ?? 2
      const indent = 1.2 * fontSize
      const itemGap = (row.item_gap ?? 0.006) * H
      const perLine = Math.floor((contentWidth - indent) / fontSize / (1 + tracking) + EPS)
      const items: string[] = options.worst
        ? new Array(maxItems).fill('国'.repeat(Math.max(1, perLine) * itemMaxLines))
        : (Array.isArray(value) ? value : [value])
      if (items.length > maxItems) overflow.push({ field, message: `${items.length} 条，超过 ${maxItems} 条` })
      const parts: Array<{ height: number; widthUsed: number; draw: (x: number, y: number, w: number) => string }> = []
      items.slice(0, maxItems).forEach((item, itemIndex) => {
        const result = layoutTextRow({ ...row, align: 'left' }, item, contentWidth - indent, scale, ctx, `${idPrefix}-${rowIndex}-${itemIndex}`)
        if (result.lines.length > itemMaxLines) overflow.push({ field, message: `第 ${itemIndex + 1} 条 ${result.lines.length} 行，超过 ${itemMaxLines} 行` })
        parts.push({
          height: result.height,
          widthUsed: indent + result.widthUsed,
          draw: (x, y, w) => {
            const square = fontSize * 0.32
            const marker = `<rect x="${fmt(x + fontSize * 0.1)}" y="${fmt(y + fontSize * 0.5 - square / 2 + fontSize * 0.06)}"`
              + ` width="${fmt(square)}" height="${fmt(square)}" fill="${esc(paint(row.marker_color || row.color))}"/>`
            return marker + result.draw(x + indent, y, w - indent)
          },
        })
      })
      let height = 0
      let widthUsed = 0
      parts.forEach((part, index) => {
        height += part.height + (index > 0 ? itemGap : 0)
        widthUsed = Math.max(widthUsed, part.widthUsed)
      })
      rows.push({
        height: height + gapAfter,
        widthUsed,
        draw: (x, y, w) => {
          let cursor = y
          let out = ''
          for (const part of parts) {
            out += part.draw(x, cursor, w)
            cursor += part.height + itemGap
          }
          return out
        },
      })
    })
    return { rows, overflow }
  }

  let scale = 1
  let result = attempt(1)
  if (result.overflow.length && !options.worst) {
    const steps = Math.round((1 - minScale) / SCALE_STEP + EPS)
    for (let step = 1; step <= steps; step++) {
      ctx.defs.length = 0
      scale = Math.round((1 - step * SCALE_STEP) * 100) / 100
      result = attempt(scale)
      if (!result.overflow.length) break
    }
    if (result.overflow.length) {
      for (const item of result.overflow) {
        const label = role.fields.find(field => field.key === item.field)?.label || item.field
        problems.push({ code: 'text_overflow', level: 'error', layer_id: layerId, field: item.field, message: `「${role.name}」的「${label}」放不下（已缩到 ${Math.round(scale * 100)}%）：${item.message}，请改短` })
      }
    } else {
      problems.push({ code: 'text_scaled', level: 'warning', layer_id: layerId, message: `「${role.name}」已自动缩小到 ${Math.round(scale * 100)}%，建议改短` })
    }
  }

  let contentHeight = 0
  let widestRow = 0
  for (const row of result.rows) {
    contentHeight += row.height
    widestRow = Math.max(widestRow, row.widthUsed)
  }
  const plate: TextPlateDef = style.plate || { kind: 'none' }
  const contentW = plate.fit === 'content' ? Math.min(contentWidth, widestRow) : contentWidth
  const bw = contentW + pl + pr
  const bh = contentHeight + pt + pb
  const anchor = slot.anchor || 'top-left'
  const ax = slot.x * W
  const ay = slot.y * H
  let bx = anchor.endsWith('right') ? ax - boxWidth : anchor.endsWith('center') ? ax - boxWidth / 2 : ax
  const by = anchor.startsWith('bottom') ? ay - bh : anchor.startsWith('middle') ? ay - bh / 2 : ay
  const firstTextRow = style.rows.find(row => row.type !== 'rule')
  const align = slot.align || (firstTextRow && firstTextRow.align) || 'left'
  if (bw < boxWidth) {
    if (align === 'right') bx += boxWidth - bw
    else if (align === 'center') bx += (boxWidth - bw) / 2
  }

  let bg = ''
  if (plate.kind === 'solid') {
    bg += `<rect x="${fmt(bx)}" y="${fmt(by)}" width="${fmt(bw)}" height="${fmt(bh)}" rx="${fmt((plate.radius || 0) * H)}"`
      + ` fill="${esc(paint(plate.color))}" fill-opacity="${fmt(plate.opacity ?? 0.7)}"/>`
  } else if (plate.kind === 'gradient') {
    const id = `${idPrefix}-grad`
    const dir = plate.direction || 'left'
    const ext = (typeof plate.extend === 'number' ? plate.extend : 0.1) * H
    const vector = dir === 'left' ? 'x1="1" y1="0" x2="0" y2="0"' : dir === 'right' ? 'x1="0" y1="0" x2="1" y2="0"' : dir === 'up' ? 'x1="0" y1="1" x2="0" y2="0"' : 'x1="0" y1="0" x2="0" y2="1"'
    const colour = esc(paint(plate.color))
    const opacity = fmt(plate.opacity ?? 0.6)
    ctx.defs.push(`<linearGradient id="${esc(id)}" ${vector}><stop offset="0" stop-color="${colour}" stop-opacity="0"/>`
      + `<stop offset="${fmt(plate.solid_from ?? 0.45)}" stop-color="${colour}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${colour}" stop-opacity="${opacity}"/></linearGradient>`)
    bg += `<rect x="${fmt(bx - ext)}" y="${fmt(by - ext)}" width="${fmt(bw + ext * 2)}" height="${fmt(bh + ext * 2)}" fill="url(#${esc(id)})"/>`
  } else if (plate.kind === 'scrim') {
    const raw = Array.isArray(plate.extend) ? plate.extend : [plate.extend ?? 0.03, plate.extend ?? 0.03, plate.extend ?? 0.03, plate.extend ?? 0.03]
    const et = raw[0] * H
    const er = raw[1] * H
    const eb = raw[2] * H
    const el = raw[3] * H
    const id = `${idPrefix}-scrim`
    const blur = (plate.feather ?? 0.03) * H
    const rx = bx - el
    const ry = by - et
    const rw = bw + el + er
    const rh = bh + et + eb
    ctx.defs.push(`<filter id="${esc(id)}" filterUnits="userSpaceOnUse" x="${fmt(rx - blur * 3)}" y="${fmt(ry - blur * 3)}"`
      + ` width="${fmt(rw + blur * 6)}" height="${fmt(rh + blur * 6)}"><feGaussianBlur stdDeviation="${fmt(blur)}"/></filter>`)
    bg += `<rect x="${fmt(rx)}" y="${fmt(ry)}" width="${fmt(rw)}" height="${fmt(rh)}" fill="${esc(paint(plate.color))}"`
      + ` fill-opacity="${fmt(plate.opacity ?? 0.5)}" filter="url(#${esc(id)})"/>`
  }

  let fg = ''
  for (const decor of style.decor || []) {
    const thickness = (decor.thickness ?? 0.003) * H
    const colour = esc(paint(decor.color))
    const gap = (decor.gap || 0) * H
    const inset = (decor.inset || 0) * H
    const side = decor.side || 'left'
    if (side === 'left') fg += `<rect x="${fmt(bx - gap - thickness)}" y="${fmt(by + inset)}" width="${fmt(thickness)}" height="${fmt(bh - 2 * inset)}" fill="${colour}"/>`
    else if (side === 'right') fg += `<rect x="${fmt(bx + bw + gap)}" y="${fmt(by + inset)}" width="${fmt(thickness)}" height="${fmt(bh - 2 * inset)}" fill="${colour}"/>`
    else {
      const len = decor.length ? decor.length * H : bw
      const lx = align === 'center' ? bx + (bw - len) / 2 : align === 'right' ? bx + bw - len : bx
      const ly = side === 'top' ? by - gap - thickness : by + bh + gap
      fg += `<rect x="${fmt(lx)}" y="${fmt(ly)}" width="${fmt(len)}" height="${fmt(thickness)}" fill="${colour}"/>`
    }
  }
  let cursor = by + pt
  for (const row of result.rows) {
    fg += row.draw(bx + pl, cursor, contentW)
    cursor += row.height
  }
  const defs = ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : ''
  return {
    role: roleId,
    slot,
    zone: slot.zone || slot.id,
    rect: { x: bx, y: by, w: bw, h: bh },
    scale,
    bg: defs + bg,
    fg,
    problems,
  }
}

/** 文本层在给定成片尺寸下的排版（套由文档级 `text_layout` 决定）。 */
export function layoutTextLayer(
  doc: Pick<LayerDoc, 'text_layout'>,
  layer: TextLayer,
  size: { width: number; height: number },
  variables?: LayerVariables,
): TextBoxLayout | null {
  const values: Record<string, TextFieldValue> = {}
  const role = TEXT_SPEC.roles[layer.role]
  if (!role) return null
  for (const field of role.fields) values[field.key] = textFieldValue(layer, field.key, variables)
  return layoutTextBox(layer.role, doc.text_layout || '', size, values, { idPrefix: `t-${layer.id}`, layerId: layer.id })
}

/**
 * 文档里可见文本层的 SVG（画面坐标）：先输出全部底板再输出全部文字，
 * 这样后出现的框的柔光不会压暗先出现的框的文字。返回空串表示没有文本层可画。
 */
export function textLayersSvg(
  doc: LayerDoc,
  size: { width: number; height: number },
  options: { visibleIds?: string[]; opacity?: Record<string, number>; variables?: LayerVariables } = {},
): string {
  const backs: string[] = []
  const fronts: string[] = []
  for (const layer of doc.layers) {
    if (layer.type !== 'text' || !layer.visible) continue
    if (options.visibleIds && options.visibleIds.indexOf(layer.id) === -1) continue
    const override = options.opacity ? options.opacity[layer.id] : undefined
    const alpha = layer.opacity * (override === undefined ? 1 : Math.min(1, Math.max(0, override)))
    if (alpha <= 0) continue
    const box = layoutTextLayer(doc, layer, size, options.variables)
    if (!box) continue
    const opacity = alpha < 1 ? ` opacity="${fmt(alpha)}"` : ''
    backs.push(`<g data-layer="${esc(layer.id)}" data-part="bg"${opacity}>${box.bg}</g>`)
    fronts.push(`<g data-layer="${esc(layer.id)}"${opacity}>${box.fg}</g>`)
  }
  return backs.join('') + fronts.join('')
}

/** 文本层的画面矩形（归一化到成片宽高），供编辑器命中测试与混排重叠检查。 */
export function textLayerRects(
  doc: LayerDoc,
  size: { width: number; height: number },
  variables?: LayerVariables,
): Record<string, TextRect> {
  const out: Record<string, TextRect> = {}
  for (const layer of doc.layers) {
    if (layer.type !== 'text') continue
    const box = layoutTextLayer(doc, layer, size, variables)
    if (!box) continue
    out[layer.id] = { x: box.rect.x / size.width, y: box.rect.y / size.height, w: box.rect.w / size.width, h: box.rect.h / size.height }
  }
  return out
}

// ---------- 容量 ----------

export interface TextFieldCapacity {
  field: string
  label: string
  kind: 'text' | 'list'
  /** 基准字号（该成片尺寸下的像素） */
  size_px: number
  chars_per_line: number
  max_lines: number
  max_items?: number
  /** 基准容量（写作红线）：每行字数 × 行数（列表为单条） */
  max_chars: number
  /** 缩到下限时每行字数（只作兜底，不当常规容量） */
  chars_per_line_at_min: number
  optional: boolean
}

/** 规范键对应的标准成片尺寸（容量表口径）。 */
export const TEXT_CANONICAL_SIZES: Record<string, { width: number; height: number }> = {
  '16:9/video': { width: 1920, height: 1080 },
  '9:16/video': { width: 1080, height: 1920 },
  '16:9/poster': { width: 1920, height: 1097 },
  '9:16/poster': { width: 1080, height: 1890 },
}

/** 某套某类型每个字段的容量（按汉字计）；`size` 缺省用该套的标准成片尺寸。 */
export function textCapacity(layoutId: string, roleId: string, size?: { width: number; height: number }): TextFieldCapacity[] {
  const located = textLayoutById(layoutId)
  if (!located) return []
  const slot = located.layout.slots.find(item => item.role === roleId)
  const style = roleStyle(roleId, located.key)
  const role = TEXT_SPEC.roles[roleId]
  if (!slot || !style || !role) return []
  const frame = size || TEXT_CANONICAL_SIZES[located.key]
  const W = frame.width
  const H = frame.height
  const padding = style.padding || [0, 0, 0, 0]
  const contentWidth = (slot.w ?? style.width) * W - padding[1] * H - padding[3] * H
  const out: TextFieldCapacity[] = []
  for (const row of style.rows) {
    if (row.type === 'rule' || !row.field) continue
    const def = role.fields.find(field => field.key === row.field)
    const fontSize = row.size * H
    const tracking = row.tracking || 0
    const available = row.type === 'list' ? contentWidth - 1.2 * fontSize : contentWidth
    const perLine = Math.floor(available / fontSize / (1 + tracking) + EPS)
    const atMin = Math.floor(available / (fontSize * (style.min_scale ?? 1)) / (1 + tracking) + EPS)
    const lines = row.type === 'list' ? (row.item_max_lines ?? 2) : (row.max_lines || 1)
    const capacity: TextFieldCapacity = {
      field: row.field,
      label: def ? def.label : row.field,
      kind: row.type === 'list' ? 'list' : 'text',
      size_px: Math.round(row.size * H),
      chars_per_line: perLine,
      max_lines: lines,
      max_chars: perLine * lines,
      chars_per_line_at_min: atMin,
      optional: Boolean(def && def.optional),
    }
    if (row.type === 'list') capacity.max_items = row.max_items || 3
    out.push(capacity)
  }
  return out
}

// ---------- 文档级检查 ----------

function rectsOverlap(a: TextRect, b: TextRect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
}

/** 两段文字最长公共连续子串长度（按字）。 */
function sharedRun(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  let best = 0
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) {
      let k = 0
      while (i + k < left.length && j + k < right.length && left[i + k] === right[j + k]) k++
      if (k > best) best = k
    }
  }
  return best
}

const DUPLICATE_RUN = 6

/** 文本层实际要画的文字（变量已解析），供缺字检查与重复判定。 */
export function textLayerTexts(layer: TextLayer, variables?: LayerVariables): string[] {
  const role = TEXT_SPEC.roles[layer.role]
  if (!role) return []
  const out: string[] = []
  for (const field of role.fields) {
    const value = textFieldValue(layer, field.key, variables)
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = item.trim()
      if (text) out.push(text)
    }
  }
  return out
}

function isDuplicate(a: string, b: string): boolean {
  return a === b || sharedRun(a, b) >= DUPLICATE_RUN
}

/**
 * 模板文本框的问题清单。`beats` = 依次出现的「同一时刻可见的图层 id 集合」
 * （图层段由时间线关键帧给出；Poster 只有一拍 = 全部可见图层）。缺省 = 一拍、全部可见。
 *
 * 阻断（error）：缺套 / 未知套 / 套与画幅不符 / 未知类型 / 类型不在本媒介 / 缺必填字段 /
 * 字段格式 / 缩到下限仍溢出 / 同拍同 zone / 同拍文字重复。
 * 警告（warning）：自动缩小 / 相邻拍文字重复 / 与锚定标注或旧文字层重叠。
 */
export function textLayerProblems(
  doc: LayerDoc,
  size: { width: number; height: number },
  options: { beats?: string[][]; variables?: LayerVariables; otherBounds?: Record<string, TextRect> } = {},
): TextProblem[] {
  const textLayers = doc.layers.filter((layer): layer is TextLayer => layer.type === 'text')
  if (!textLayers.length) return []
  const problems: TextProblem[] = []
  const located = textLayoutById(doc.text_layout)
  if (!doc.text_layout) {
    return [{ code: 'text_layout_missing', level: 'error', message: '有模板文本框但没有选择成套位置（版式套）' }]
  }
  if (!located) {
    return [{ code: 'text_layout_unknown', level: 'error', message: `未知的版式套「${doc.text_layout}」` }]
  }
  if (located.family !== textFamilyOf(size.width, size.height)) {
    problems.push({ code: 'text_layout_aspect_mismatch', level: 'error', message: `版式套「${located.layout.name}」属于 ${located.family} 规范，与成片画幅不符，请换套` })
  }
  const allowed = textRolesFor(located.medium)
  const boxes: Record<string, TextBoxLayout> = {}
  for (const layer of textLayers) {
    if (!TEXT_SPEC.roles[layer.role]) {
      problems.push({ code: 'text_role_unknown', level: 'error', layer_id: layer.id, message: `未知的文本框类型「${layer.role}」` })
      continue
    }
    if (allowed.indexOf(layer.role) === -1) {
      problems.push({ code: 'text_role_medium', level: 'error', layer_id: layer.id, message: `「${TEXT_SPEC.roles[layer.role].name}」只能用于 Poster` })
      continue
    }
    const box = layoutTextLayer(doc, layer, size, options.variables)
    if (!box) {
      problems.push({ code: 'text_role_unknown', level: 'error', layer_id: layer.id, message: `版式套「${located.layout.name}」没有「${TEXT_SPEC.roles[layer.role].name}」的位置` })
      continue
    }
    boxes[layer.id] = box
    if (layer.visible) for (const problem of box.problems) problems.push(problem)
  }

  const visibleText = textLayers.filter(layer => layer.visible && boxes[layer.id])
  const beats = options.beats && options.beats.length ? options.beats : [doc.layers.map(layer => layer.id)]
  let previous: Array<{ id: string; text: string }> = []
  beats.forEach((beat, beatIndex) => {
    const here = visibleText.filter(layer => beat.indexOf(layer.id) !== -1)
    const label = beats.length > 1 ? `第 ${beatIndex + 1} 拍` : '同屏'
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        const a = boxes[here[i].id]
        const b = boxes[here[j].id]
        if (a.zone === b.zone) {
          problems.push({ code: 'text_zone_conflict', level: 'error', layer_id: here[j].id, message: `${label}：「${here[i].name}」与「${here[j].name}」在同一位置区，不能同时出现` })
        }
      }
    }
    const texts: Array<{ id: string; text: string }> = []
    for (const layer of here) for (const text of textLayerTexts(layer, options.variables)) texts.push({ id: layer.id, text })
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        if (texts[i].id !== texts[j].id && isDuplicate(texts[i].text, texts[j].text)) {
          problems.push({ code: 'text_duplicate_same_beat', level: 'error', layer_id: texts[j].id, message: `${label}：「${texts[i].text}」与「${texts[j].text}」重复` })
        }
      }
    }
    for (const current of texts) {
      const hit = previous.find(item => item.id !== current.id && isDuplicate(item.text, current.text))
      if (hit) problems.push({ code: 'text_duplicate_adjacent', level: 'warning', layer_id: current.id, message: `${label}：「${current.text}」与上一拍「${hit.text}」重复，建议换成新信息` })
    }
    previous = texts
    if (options.otherBounds) {
      for (const layer of here) {
        const rect = boxes[layer.id].rect
        const norm = { x: rect.x / size.width, y: rect.y / size.height, w: rect.w / size.width, h: rect.h / size.height }
        for (const otherId of Object.keys(options.otherBounds)) {
          if (beat.indexOf(otherId) === -1) continue
          if (rectsOverlap(norm, options.otherBounds[otherId])) {
            const other = doc.layers.find(item => item.id === otherId)
            problems.push({ code: 'text_overlaps_layer', level: 'warning', layer_id: layer.id, message: `${label}：「${layer.name}」与「${other ? other.name : otherId}」重叠` })
          }
        }
      }
    }
  })
  const seen = new Set<string>()
  return problems.filter(problem => {
    const key = `${problem.code}|${problem.layer_id || ''}|${problem.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export class TextLayerError extends Error {
  problems: TextProblem[]
  constructor(problems: TextProblem[]) {
    super(`模板文本框有问题，不能出成品：${problems.map(problem => problem.message).join('；')}`)
    this.problems = problems
  }
}

/** 成品渲染前的闸门：有阻断级问题即抛 TextLayerError（警告不拦）。 */
export function assertTextLayersRenderable(
  doc: LayerDoc,
  size: { width: number; height: number },
  options: { beats?: string[][]; variables?: LayerVariables } = {},
): void {
  const errors = textLayerProblems(doc, size, options).filter(problem => problem.level === 'error')
  if (errors.length) throw new TextLayerError(errors)
}

/** 版式自检：每个槽位按最坏内容排版，检查安全区、避让区与不同 zone 之间的最小间距。 */
export function textLayoutSelfCheck(layoutId: string): string[] {
  const located = textLayoutById(layoutId)
  if (!located) return [`未知版式套 ${layoutId}`]
  const size = TEXT_CANONICAL_SIZES[located.key]
  const safe = TEXT_SPEC.safe[located.key]
  const errors: string[] = []
  const rects: Array<{ slot: TextSlotDef; rect: TextRect }> = []
  for (const slot of located.layout.slots) {
    const box = layoutTextBox(slot.role, layoutId, size, {}, { worst: true })
    if (!box) { errors.push(`${slot.id}: 无样式`); continue }
    rects.push({ slot, rect: box.rect })
    if (safe) {
      const R = box.rect
      if (R.x < safe.x0 * size.width - 0.5 || R.y < safe.y0 * size.height - 0.5 || R.x + R.w > safe.x1 * size.width + 0.5 || R.y + R.h > safe.y1 * size.height + 0.5) {
        errors.push(`${slot.id} 最坏尺寸越出安全区`)
      }
      for (const zone of safe.avoid || []) {
        const zr = { x: zone.x0 * size.width, y: zone.y0 * size.height, w: (zone.x1 - zone.x0) * size.width, h: (zone.y1 - zone.y0) * size.height }
        if (rectsOverlap(R, zr)) errors.push(`${slot.id} 最坏尺寸压到避让区「${zone.name}」`)
      }
    }
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      if ((a.slot.zone || a.slot.id) === (b.slot.zone || b.slot.id)) continue
      if (rectsOverlap(a.rect, b.rect, TEXT_SPEC.min_gap * size.height)) errors.push(`${a.slot.id} 与 ${b.slot.id} 最坏尺寸重叠/间距不足`)
    }
  }
  return errors
}
