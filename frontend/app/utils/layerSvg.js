/**
 * 图层文档 → SVG（Issue #48，前端同源实现）。
 * 与 `backend/src/services/layer-svg.ts` 必须逐行等价，任何改动两边一起改；
 * 行为由 `backend/tests/layer-svg.test.mjs` 逐例对照（口径同 assetName.js /
 * narrationMarkup.js）。编辑器直接把本函数的输出插进画布，服务端把同一份输出
 * 交给 sharp 合成，所以「所见即所得」是结构保证。
 */

export const LINE_HEIGHT_EM = 1.35
export const BASELINE_EM = 0.88
/** 行首禁则：这些字符不另起一行，宁可让本行略微超宽。 */
const NO_LINE_START = '，。、；：？！）》」』”’%,.;:?!)]}…—'
const EPS = 1e-9

export const FONT_FAMILIES = {
  sans: "'Noto Sans SC', sans-serif",
  serif: "'Noto Serif SC', serif",
  // Issue #72：四族打包字体。kai/hand 的字表比 Noto 小，缺字由 serif/sans 别名回退到打包的
  // Noto（fontconfig 只认识本目录），所以不会出现豆腐块；字表交集仍按 FONT_CHAR_RANGES 检查。
  kai: "'LXGW WenKai', serif",
  hand: "'Ma Shan Zheng', sans-serif",
}

/** 主题预设：样式字段缺省时的兜底值（纪录片档案风 / 干净 / 水墨）。 */
export const THEME_PRESETS = {
  archival: {
    polygon: { fill: '#c0472e', fill_opacity: 0.28, stroke: '#8f2f1c', stroke_width: 0.004, dash: 'none' },
    polyline: { stroke: '#1f5f8b', width: 0.006, dash: 'none', arrow_end: false, arrow_start: false },
    marker: { dot_radius: 0.012, color: '#8f2f1c', text_color: '#2b2118', stroke: '#f4ecd8', size: 0.034, font: 'serif', bold: true, label_offset: [0.016, -0.012] },
    label: { font: 'serif', size: 0.045, color: '#2b2118', stroke: '#f4ecd8', stroke_width: 0.004, bg: '#f4ecd8', bg_opacity: 0, align: 'left', bold: false },
    card: { font: 'serif', bg: '#2b2118', bg_opacity: 0.84, color: '#f4ecd8', accent: '#c0472e', align: 'left' },
    image: { border: '#f4ecd8', border_width: 0.005, radius: 0.006, shadow: true },
  },
  clean: {
    polygon: { fill: '#2f7bd6', fill_opacity: 0.25, stroke: '#1b4f8f', stroke_width: 0.003, dash: 'none' },
    polyline: { stroke: '#d64545', width: 0.005, dash: 'none', arrow_end: false, arrow_start: false },
    marker: { dot_radius: 0.01, color: '#d64545', text_color: '#16202c', stroke: '#ffffff', size: 0.032, font: 'sans', bold: true, label_offset: [0.014, -0.01] },
    label: { font: 'sans', size: 0.042, color: '#16202c', stroke: '#ffffff', stroke_width: 0.004, bg: '#ffffff', bg_opacity: 0, align: 'left', bold: false },
    card: { font: 'sans', bg: '#16202c', bg_opacity: 0.8, color: '#ffffff', accent: '#2f7bd6', align: 'left' },
    image: { border: '#ffffff', border_width: 0.004, radius: 0.01, shadow: true },
  },
  ink: {
    polygon: { fill: '#3b3b3b', fill_opacity: 0.22, stroke: '#1a1a1a', stroke_width: 0.004, dash: 'dash' },
    polyline: { stroke: '#1a1a1a', width: 0.006, dash: 'none', arrow_end: false, arrow_start: false },
    marker: { dot_radius: 0.011, color: '#1a1a1a', text_color: '#1a1a1a', stroke: '#f2f0ea', size: 0.034, font: 'serif', bold: false, label_offset: [0.015, -0.011] },
    label: { font: 'serif', size: 0.044, color: '#1a1a1a', stroke: '#f2f0ea', stroke_width: 0.005, bg: '#f2f0ea', bg_opacity: 0, align: 'left', bold: false },
    card: { font: 'serif', bg: '#f2f0ea', bg_opacity: 0.9, color: '#1a1a1a', accent: '#8a1f1f', align: 'left' },
    image: { border: '#1a1a1a', border_width: 0.003, radius: 0, shadow: false },
  },
}

/** 底图风格化的偏色预设（与 `LayerDoc.base.filter.tint` 对应）。 */
export const TINT_COLORS = {
  sepia: '#d9c49b',
  cool: '#a9bdd6',
  warm: '#e8c49a',
}

/**
 * 打包字体**实际**覆盖的码位（四件字体 cmap 的交集，不是子集化时申请的区间——
 * fontTools 只保留源字体里存在的字形，申请区间里有大量符号/箭头根本不存在）。
 * 由 `backend/assets/fonts/README.md` 的生成命令产出；超出这些码位的字符服务端
 * 直接报错，不输出豆腐块。
 */
export const FONT_CHAR_RANGES = [
  [0x0020, 0x007e],
  [0x00a0, 0x00ff],
  [0x2002, 0x2003],
  [0x2010, 0x2016],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2020, 0x2022],
  [0x2025, 0x2027],
  [0x2030, 0x2030],
  [0x2032, 0x2033],
  [0x2035, 0x2035],
  [0x2039, 0x203c],
  [0x2042, 0x2042],
  [0x2047, 0x2049],
  [0x2051, 0x2051],
  [0x2190, 0x2199],
  [0x21b8, 0x21b9],
  [0x21c4, 0x21c6],
  [0x21cb, 0x21cc],
  [0x21d0, 0x21d0],
  [0x21d2, 0x21d2],
  [0x21d4, 0x21d4],
  [0x21e6, 0x21e9],
  [0x21f5, 0x21f5],
  [0x2460, 0x24ff],
  [0x25a0, 0x25ab],
  [0x25b1, 0x25b3],
  [0x25b6, 0x25b7],
  [0x25bc, 0x25bd],
  [0x25c0, 0x25c1],
  [0x25c6, 0x25c7],
  [0x25c9, 0x25cc],
  [0x25ce, 0x25d3],
  [0x25e2, 0x25e6],
  [0x25ef, 0x25ef],
  [0x3000, 0x303f],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x4e00, 0x9fef],
  [0xff01, 0xff9f],
  [0xffa1, 0xffbe],
  [0xffc2, 0xffc7],
  [0xffca, 0xffcf],
  [0xffd2, 0xffd7],
  [0xffda, 0xffdc],
  [0xffe0, 0xffe6],
  [0xffe8, 0xffee],
]

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
]

function inRanges(code, ranges) {
  for (const [lo, hi] of ranges) {
    if (code >= lo && code <= hi) return true
  }
  return false
}

/** 文本里超出打包字体覆盖范围的字符（去重，保持出现顺序）。 */
export function unsupportedChars(text) {
  const out = []
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)
    if (code === 0x0a || code === 0x09) continue
    if (inRanges(code, FONT_CHAR_RANGES)) continue
    if (out.indexOf(ch) === -1) out.push(ch)
  }
  return out
}

/** 单字符宽度（em）：全角 1.0 / 空格 0.33 / 其它 0.55。 */
export function charWidthEm(ch) {
  if (ch === ' ' || ch === '\t') return 0.33
  const code = ch.codePointAt(0)
  return inRanges(code, WIDE_RANGES) ? 1 : 0.55
}

export function measureTextEm(text) {
  let width = 0
  for (const ch of String(text ?? '')) width += charWidthEm(ch)
  return width
}

function tokensOf(paragraph) {
  const tokens = []
  let buffer = ''
  for (const ch of paragraph) {
    if (ch === ' ' || ch === '\t' || inRanges(ch.codePointAt(0), WIDE_RANGES)) {
      if (buffer) {
        tokens.push(buffer)
        buffer = ''
      }
      tokens.push(ch)
    } else {
      buffer += ch
    }
  }
  if (buffer) tokens.push(buffer)
  return tokens
}

/**
 * 贪心换行：全角逐字断，拉丁词整词断（超长词硬切），行首禁则字符不换行。
 * `maxEm` 为行宽（em）；返回的行数组保留空段落（空行）。
 */
export function wrapTextEm(text, maxEm) {
  const limit = Math.max(1, maxEm)
  const lines = []
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = ''
    let width = 0
    for (const token of tokensOf(paragraph)) {
      const tokenWidth = measureTextEm(token)
      const forbidden = token.length === 1 && NO_LINE_START.indexOf(token) !== -1
      if (width > 0 && width + tokenWidth > limit + EPS && !forbidden) {
        lines.push(line)
        line = ''
        width = 0
        if (token === ' ' || token === '\t') continue
      }
      if (tokenWidth > limit + EPS && token.length > 1) {
        for (const ch of token) {
          const chWidth = charWidthEm(ch)
          if (width > 0 && width + chWidth > limit + EPS) {
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
  }
  return lines
}

function fmt(value) {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function styleOf(layer, theme, key) {
  const own = layer.style || {}
  if (own[key] !== undefined && own[key] !== null && own[key] !== '') return own[key]
  return THEME_PRESETS[theme][layer.type][key]
}

function dashArray(kind, strokeWidth) {
  if (kind === 'dash') return `${fmt(strokeWidth * 3)} ${fmt(strokeWidth * 2)}`
  if (kind === 'dot') return `${fmt(strokeWidth * 0.1)} ${fmt(strokeWidth * 1.9)}`
  return ''
}

/**
 * 图层的归一化包围盒：编辑器选择框、旋转中心、吸附参考线共用同一口径。
 * marker 把标签文字算进去（选择框要能框住文字）。
 */
export function layerBounds(layer, theme, aspect = 16 / 9, variables) {
  if (layer.type === 'polygon' || layer.type === 'polyline') {
    const xs = layer.points.map(p => p[0])
    const ys = layer.points.map(p => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (layer.type === 'marker') {
    const radius = styleOf(layer, theme, 'dot_radius')
    const size = styleOf(layer, theme, 'size')
    const legacyOffset = styleOf(layer, theme, 'label_offset')
    const offset = [Number(layer.style.label_dx ?? legacyOffset[0]), Number(layer.style.label_dy ?? legacyOffset[1])]
    const [cx, cy] = layer.at
    const textWidth = (measureTextEm(resolvedText(layer, variables)) * size) / aspect
    const textX = offset[0] >= 0 ? cx + offset[0] : cx + offset[0] - textWidth
    const left = Math.min(cx - radius / aspect, textX)
    const right = Math.max(cx + radius / aspect, textX + textWidth)
    const top = Math.min(cy - radius, cy + offset[1] - size * BASELINE_EM)
    const bottom = Math.max(cy + radius, cy + offset[1] + size * (LINE_HEIGHT_EM - BASELINE_EM))
    return { x: left, y: top, w: right - left, h: bottom - top }
  }
  return { ...layer.box }
}

/** 变量层的实际文本：Poster 固定文本按剧集数据现场解析；普通图层用自身文本。 */
export function resolvedText(layer, variables) {
  if (layer.type === 'label' && layer.variable) return variables?.[layer.variable] || ''
  return 'text' in layer ? String(layer.text || '') : ''
}

function textBlock(lines, options) {
  if (!lines.length) return ''
  const anchor = options.align === 'center' ? 'middle' : options.align === 'right' ? 'end' : 'start'
  const common = `font-family="${FONT_FAMILIES[options.font] || FONT_FAMILIES.sans}" font-size="${fmt(options.size)}"`
    + `${options.bold ? ' font-weight="700"' : ''} text-anchor="${anchor}" xml:space="preserve"`
  const strokeWidth = options.strokeWidth || 0
  const shadow = options.shadow && options.shadowFilterId ? ` filter="url(#${esc(options.shadowFilterId)})"` : ''
  // 斜体用绕基线 skewX 合成：CJK 字体没有 italic 字面，浏览器与 librsvg 对 font-style 的处理不一致，
  // 显式变换才能保证两端看到同一种倾斜角度。
  return lines.map((line, index) => {
    const y = options.top + options.size * BASELINE_EM + index * options.size * LINE_HEIGHT_EM
    const transform = options.italic
      ? ` transform="translate(0 ${fmt(y)}) skewX(-12) translate(0 ${fmt(-y)})"`
      : ''
    const span = `<tspan x="${fmt(options.x)}" y="${fmt(y)}">${esc(line)}</tspan>`
    const halo = options.stroke && strokeWidth > 0
      ? `<text ${common} fill="${esc(options.stroke)}" stroke="${esc(options.stroke)}" stroke-width="${fmt(strokeWidth * 2)}"`
        + ` stroke-linejoin="round" stroke-linecap="round"${transform}>${span}</text>`
      : ''
    return `${halo}<text ${common} fill="${esc(options.color)}"${shadow}${transform}>${span}</text>`
  }).join('')
}

function arrowHead(from, to, width, color) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.sqrt(dx * dx + dy * dy)
  if (length < EPS) return ''
  const ux = dx / length
  const uy = dy / length
  const head = width * 3.6
  const half = width * 1.7
  const baseX = to[0] - ux * head
  const baseY = to[1] - uy * head
  const points = [
    `${fmt(to[0])},${fmt(to[1])}`,
    `${fmt(baseX - uy * half)},${fmt(baseY + ux * half)}`,
    `${fmt(baseX + uy * half)},${fmt(baseY - ux * half)}`,
  ].join(' ')
  return `<polygon points="${points}" fill="${esc(color)}"/>`
}

function emitPolygon(layer, ctx) {
  const points = layer.points.map(p => `${fmt(p[0] * ctx.width)},${fmt(p[1] * ctx.height)}`).join(' ')
  const strokeWidth = styleOf(layer, ctx.theme, 'stroke_width') * ctx.height
  const dash = dashArray(styleOf(layer, ctx.theme, 'dash'), strokeWidth)
  const stroke = strokeWidth > 0
    ? ` stroke="${esc(styleOf(layer, ctx.theme, 'stroke'))}" stroke-width="${fmt(strokeWidth)}" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}`
    : ''
  return `<polygon points="${points}" fill="${esc(styleOf(layer, ctx.theme, 'fill'))}"`
    + ` fill-opacity="${fmt(styleOf(layer, ctx.theme, 'fill_opacity'))}"${stroke}/>`
}

function emitPolyline(layer, ctx) {
  const pixels = layer.points.map(p => [p[0] * ctx.width, p[1] * ctx.height])
  const points = pixels.map(p => `${fmt(p[0])},${fmt(p[1])}`).join(' ')
  const width = styleOf(layer, ctx.theme, 'width') * ctx.height
  const color = styleOf(layer, ctx.theme, 'stroke')
  const dash = dashArray(styleOf(layer, ctx.theme, 'dash'), width)
  let out = `<polyline points="${points}" fill="none" stroke="${esc(color)}" stroke-width="${fmt(width)}"`
    + ` stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  if (styleOf(layer, ctx.theme, 'arrow_end')) {
    out += arrowHead(pixels[pixels.length - 2], pixels[pixels.length - 1], width, color)
  }
  if (styleOf(layer, ctx.theme, 'arrow_start')) {
    out += arrowHead(pixels[1], pixels[0], width, color)
  }
  return out
}

function emitMarker(layer, ctx) {
  const cx = layer.at[0] * ctx.width
  const cy = layer.at[1] * ctx.height
  const radius = styleOf(layer, ctx.theme, 'dot_radius') * ctx.height
  const color = styleOf(layer, ctx.theme, 'color')
  const stroke = styleOf(layer, ctx.theme, 'stroke')
  const size = styleOf(layer, ctx.theme, 'size') * ctx.height
  const legacyOffset = styleOf(layer, ctx.theme, 'label_offset')
  const offset = [Number(layer.style.label_dx ?? legacyOffset[0]), Number(layer.style.label_dy ?? legacyOffset[1])]
  let out = `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}" fill="${esc(color)}"`
    + ` stroke="${esc(stroke)}" stroke-width="${fmt(radius * 0.35)}"/>`
  if (layer.text) {
    out += textBlock([resolvedText(layer, ctx.variables)], {
      x: cx + offset[0] * ctx.width,
      top: cy + offset[1] * ctx.height - size * BASELINE_EM,
      size,
      font: styleOf(layer, ctx.theme, 'font'),
      bold: Boolean(styleOf(layer, ctx.theme, 'bold')),
      color: styleOf(layer, ctx.theme, 'text_color'),
      align: offset[0] >= 0 ? 'left' : 'right',
      stroke,
      strokeWidth: size * 0.08,
    })
  }
  return out
}

function emitLabel(layer, ctx) {
  const box = layer.box
  const x = box.x * ctx.width
  const y = box.y * ctx.height
  const w = box.w * ctx.width
  const h = box.h * ctx.height
  const size = styleOf(layer, ctx.theme, 'size') * ctx.height
  const bgOpacity = styleOf(layer, ctx.theme, 'bg_opacity')
  const pad = bgOpacity > 0 ? size * 0.3 : 0
  const align = styleOf(layer, ctx.theme, 'align')
  const lines = wrapTextEm(resolvedText(layer, ctx.variables), Math.max(1, (w - pad * 2) / size))
  const textX = align === 'center' ? x + w / 2 : align === 'right' ? x + w - pad : x + pad
  const bg = bgOpacity > 0
    ? `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(size * 0.18)}"`
      + ` fill="${esc(styleOf(layer, ctx.theme, 'bg'))}" fill-opacity="${fmt(bgOpacity)}"/>`
    : ''
  const shadow = Boolean(styleOf(layer, ctx.theme, 'shadow'))
  const shadowFilterId = `text-shadow-${layer.id}`
  if (shadow) {
    ctx.defs.push(
      `<filter id="${esc(shadowFilterId)}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feDropShadow dx="0" dy="${fmt(size * 0.05)}" stdDeviation="${fmt(size * 0.18)}" flood-color="#000000" flood-opacity="0.65"/></filter>`,
    )
  }
  return bg + textBlock(lines, {
    x: textX,
    top: y + pad,
    size,
    font: styleOf(layer, ctx.theme, 'font'),
    bold: Boolean(styleOf(layer, ctx.theme, 'bold')),
    color: styleOf(layer, ctx.theme, 'color'),
    align,
    stroke: styleOf(layer, ctx.theme, 'stroke'),
    strokeWidth: styleOf(layer, ctx.theme, 'stroke_width') * ctx.height,
    italic: Boolean(styleOf(layer, ctx.theme, 'italic')),
    shadow,
    shadowFilterId,
  })
}

function emitCard(layer, ctx) {
  const x = layer.box.x * ctx.width
  const y = layer.box.y * ctx.height
  const w = layer.box.w * ctx.width
  const h = layer.box.h * ctx.height
  const font = styleOf(layer, ctx.theme, 'font')
  const color = styleOf(layer, ctx.theme, 'color')
  const accent = styleOf(layer, ctx.theme, 'accent')
  const scale = Number(styleOf(layer, ctx.theme, 'scale') || 1)
  const bg = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"`
    + ` fill="${esc(styleOf(layer, ctx.theme, 'bg'))}" fill-opacity="${fmt(styleOf(layer, ctx.theme, 'bg_opacity'))}"/>`
  // `years`（#58 卡片字段契约）统一渲染为「标题下方的一行强调色年代」；为空时输出与 #48 逐字节相同
  const { title, sub, meta, years } = layer.fields

  if (layer.template === 'year') {
    const titleSize = h * 0.5 * scale
    const subSize = h * 0.18 * scale
    return bg
      + `<rect x="${fmt(x)}" y="${fmt(y + h - h * 0.06)}" width="${fmt(w)}" height="${fmt(h * 0.06)}" fill="${esc(accent)}"/>`
      + textBlock([title], { x: x + w / 2, top: y + h * 0.12, size: titleSize, font, bold: true, color, align: 'center' })
      + (years ? textBlock([years], { x: x + w / 2, top: y + h * 0.62, size: subSize, font, bold: false, color: accent, align: 'center' }) : '')
      + (sub ? textBlock([sub], { x: x + w / 2, top: y + h * 0.72, size: subSize, font, bold: false, color, align: 'center' }) : '')
  }
  if (layer.template === 'chapter') {
    const titleSize = h * 0.4 * scale
    const subSize = h * 0.17 * scale
    return bg
      + textBlock([title], { x: x + w / 2, top: y + h * 0.14, size: titleSize, font, bold: true, color, align: 'center' })
      + (years ? textBlock([years], { x: x + w / 2, top: y + h * 0.56, size: subSize, font, bold: false, color: accent, align: 'center' }) : '')
      + `<rect x="${fmt(x + w * 0.35)}" y="${fmt(y + h * 0.66)}" width="${fmt(w * 0.3)}" height="${fmt(Math.max(1, h * 0.02))}" fill="${esc(accent)}"/>`
      + (sub ? textBlock([sub], { x: x + w / 2, top: y + h * 0.74, size: subSize, font, bold: false, color, align: 'center' }) : '')
  }
  const stripe = Math.max(2, w * 0.012)
  const pad = h * 0.14
  const titleSize = h * 0.38 * scale
  const subSize = h * 0.2 * scale
  const metaSize = h * 0.16 * scale
  // 标题下方逐行往下排：先 years（强调色），再 sub
  const yearsTop = y + pad + titleSize * LINE_HEIGHT_EM
  const subTop = yearsTop + (years ? subSize * LINE_HEIGHT_EM : 0)
  return bg
    + `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(stripe)}" height="${fmt(h)}" fill="${esc(accent)}"/>`
    + textBlock([title], { x: x + stripe + pad, top: y + pad, size: titleSize, font, bold: true, color, align: 'left' })
    + (years ? textBlock([years], { x: x + stripe + pad, top: yearsTop, size: subSize, font, bold: false, color: accent, align: 'left' }) : '')
    + (sub ? textBlock([sub], { x: x + stripe + pad, top: subTop, size: subSize, font, bold: false, color, align: 'left' }) : '')
    + (meta ? textBlock([meta], { x: x + w - pad, top: y + h - pad - metaSize * LINE_HEIGHT_EM, size: metaSize, font, bold: false, color, align: 'right' }) : '')
}

function emitImage(layer, ctx) {
  const x = layer.box.x * ctx.width
  const y = layer.box.y * ctx.height
  const w = layer.box.w * ctx.width
  const h = layer.box.h * ctx.height
  const radius = styleOf(layer, ctx.theme, 'radius') * ctx.height
  const borderWidth = styleOf(layer, ctx.theme, 'border_width') * ctx.height
  const clipId = `clip-${layer.id}`
  ctx.defs.push(
    `<clipPath id="${esc(clipId)}"><rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(radius)}"/></clipPath>`,
  )
  let filter = ''
  if (styleOf(layer, ctx.theme, 'shadow')) {
    const shadowId = `shadow-${layer.id}`
    ctx.defs.push(
      `<filter id="${esc(shadowId)}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feDropShadow dx="0" dy="${fmt(ctx.height * 0.006)}" stdDeviation="${fmt(ctx.height * 0.006)}" flood-color="#000000" flood-opacity="0.45"/></filter>`,
    )
    filter = ` filter="url(#${esc(shadowId)})"`
  }
  const href = ctx.resolveImage(layer.src.path)
  const aspect = layer.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'
  const border = borderWidth > 0
    ? `<rect x="${fmt(x + borderWidth / 2)}" y="${fmt(y + borderWidth / 2)}" width="${fmt(Math.max(0, w - borderWidth))}"`
      + ` height="${fmt(Math.max(0, h - borderWidth))}" rx="${fmt(radius)}" fill="none"`
      + ` stroke="${esc(styleOf(layer, ctx.theme, 'border'))}" stroke-width="${fmt(borderWidth)}"/>`
    : ''
  return `<g${filter}><image x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}"`
    + ` preserveAspectRatio="${aspect}" clip-path="url(#${esc(clipId)})" href="${esc(href)}"/>${border}</g>`
}

/**
 * 底图确定性风格化（偏色/纸纹/暗角）→ 若干张**纯 alpha** 覆盖层，按返回顺序叠在底图上。
 *
 * 故意不用混合模式：实测 libvips 的 multiply/soft-light 对半透明源的结果与浏览器
 * mix-blend-mode 差异明显（白底 + 30% sepia 乘算，sharp 得到 198,196,192，浏览器是
 * 244,237,225），服务端与编辑器会一眼看出两种色调。普通 alpha 合成（over）在
 * librsvg/sharp 与浏览器里是同一套公式，所以两端必然一致。
 */
export function baseFilterLayers(filter, size) {
  if (!filter) return []
  const { width, height } = size
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  const out = []
  const tint = filter.tint && filter.tint !== 'none' ? TINT_COLORS[filter.tint] : ''
  const tintStrength = Math.round((filter.tint_strength ?? 0) * 100) / 100
  const paper = Math.round((filter.paper ?? 0) * 100) / 100
  const vignette = Math.round((filter.vignette ?? 0) * 100) / 100
  if (tint && tintStrength > 0) {
    out.push({
      id: 'tint',
      svg: `${head}<rect width="${width}" height="${height}" fill="${tint}" fill-opacity="${tintStrength}"/></svg>`,
      opacity: tintStrength,
    })
  }
  if (paper > 0) {
    out.push({
      id: 'paper',
      svg: `${head}<filter id="paper" x="0" y="0" width="100%" height="100%">`
        + '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="17" stitchTiles="stitch"/>'
        + '<feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.17 0.17 0.17 0 0"/></filter>'
        + `<g opacity="${paper}"><rect width="${width}" height="${height}" filter="url(#paper)"/></g></svg>`,
      opacity: paper,
    })
  }
  if (vignette > 0) {
    out.push({
      id: 'vignette',
      svg: `${head}<radialGradient id="vig" cx="0.5" cy="0.5" r="0.72">`
        + `<stop offset="0.45" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="${vignette}"/></radialGradient>`
        + `<rect width="${width}" height="${height}" fill="url(#vig)"/></svg>`,
      opacity: vignette,
    })
  }
  return out
}

/**
 * 文档 → 叠加层 SVG（不含底图；底图由服务端 sharp 或编辑器的 <img> 承载）。
 * `visibleIds` 只渲染给定图层；`opacity` 按图层 id 叠乘不透明度（淡入淡出）；
 * `viewport`（归一化 0–1）把取景框搬进 viewBox——Ken Burns 推近时图层与底图同步放大（#50）。
 */
export function layerDocToSvg(doc, size, options = {}) {
  // Cropped documents live in native whole-image geometry; output size is only the SVG surface.
  const worldWidth = doc.base.crop ? (doc.base.source_width || doc.base.width) : size.width
  const worldHeight = doc.base.crop ? (doc.base.source_height || doc.base.height) : size.height
  const ctx = {
    width: worldWidth,
    height: worldHeight,
    theme: doc.theme,
    defs: [],
    resolveImage: options.resolveImage || (path => path),
    variables: options.variables,
  }
  const aspect = worldWidth / worldHeight
  const body = []
  for (const layer of doc.layers) {
    if (!layer.visible) continue
    if (options.visibleIds && options.visibleIds.indexOf(layer.id) === -1) continue
    const override = options.opacity ? options.opacity[layer.id] : undefined
    const alpha = layer.opacity * (override === undefined ? 1 : Math.min(1, Math.max(0, override)))
    if (alpha <= 0) continue
    let inner = ''
    if (layer.type === 'polygon') inner = emitPolygon(layer, ctx)
    else if (layer.type === 'polyline') inner = emitPolyline(layer, ctx)
    else if (layer.type === 'marker') inner = emitMarker(layer, ctx)
    else if (layer.type === 'label') inner = emitLabel(layer, ctx)
    else if (layer.type === 'card') inner = emitCard(layer, ctx)
    else if (layer.type === 'image') inner = emitImage(layer, ctx)
    if (!inner) continue
    const bounds = layerBounds(layer, doc.theme, aspect, options.variables)
    const cx = (bounds.x + bounds.w / 2) * worldWidth
    const cy = (bounds.y + bounds.h / 2) * worldHeight
    const transform = layer.rotation ? ` transform="rotate(${fmt(layer.rotation)} ${fmt(cx)} ${fmt(cy)})"` : ''
    const opacity = alpha < 1 ? ` opacity="${fmt(alpha)}"` : ''
    body.push(`<g data-layer="${esc(layer.id)}"${opacity}${transform}>${inner}</g>`)
  }
  const defs = ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>` : ''
  const view = options.viewport || doc.base.crop
  const viewBox = view
    ? `${fmt(view.x * worldWidth)} ${fmt(view.y * worldHeight)} ${fmt(view.w * worldWidth)} ${fmt(view.h * worldHeight)}`
    : `0 0 ${worldWidth} ${worldHeight}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"`
    + ` viewBox="${viewBox}"${doc.base.crop || (view && view.w !== view.h) ? ' preserveAspectRatio="none"' : ''}>${defs}${body.join('')}</svg>`
}
