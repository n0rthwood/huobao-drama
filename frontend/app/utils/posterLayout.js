/**
 * Poster 文字图层（Issue #39）前端纯函数：与后端 poster-layout.ts 同口径的
 * 归一化、变量渲染、字体栈与字号自适应。坐标/字号都是图片尺寸比例。
 */

export const POSTER_VARIABLE_KINDS = ['project_title', 'episode_title', 'episode_no']
export const POSTER_MAX_BOXES = 40

export const POSTER_FONT_KEYS = ['sans', 'serif', 'kai', 'hand']

export const POSTER_FONT_STACKS = {
  sans: '"Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  kai: '"Kaiti SC", KaiTi, STKaiti, serif',
  hand: '"Yuanti SC", "Hiragino Sans GB", "Segoe Print", cursive',
}

const DEFAULTS = {
  text: '',
  x: 0.1,
  y: 0.1,
  width: 0.8,
  fontSize: 0.08,
  fontFamily: 'sans',
  color: '#ffffff',
  bold: true,
  italic: false,
  strokeColor: '#000000',
  strokeWidth: 0.03,
  shadow: true,
  align: 'center',
}

const TEXT_MAX = 300
const COLOR_MAX = 32

function clamp(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function clipped(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.slice(0, max).trim() || fallback
}

function variableKind(value) {
  return typeof value === 'string' && POSTER_VARIABLE_KINDS.includes(value) ? value : 'text'
}

/** 解析 JSON / 对象；非法输入退化为空布局。 */
export function parsePosterLayout(raw) {
  if (typeof raw === 'string') {
    try {
      return parsePosterLayout(JSON.parse(raw))
    } catch {
      return { texts: [] }
    }
  }
  return normalizePosterLayout(raw)
}

/** 归一化：字段白名单 + 范围裁剪；变量框内容清空，只保留 kind。 */
export function normalizePosterLayout(raw) {
  if (typeof raw === 'string') return parsePosterLayout(raw)
  if (!raw || typeof raw !== 'object') return { texts: [] }
  const input = Array.isArray(raw.texts) ? raw.texts : []
  const texts = []
  input.slice(0, POSTER_MAX_BOXES).forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const kind = variableKind(item.kind)
    texts.push({
      id: clipped(item.id, 64) || `box-${index + 1}`,
      kind,
      text: kind === 'text' ? clipped(item.text, TEXT_MAX) : '',
      x: clamp(item.x, 0, 1, DEFAULTS.x),
      y: clamp(item.y, 0, 1, DEFAULTS.y),
      width: clamp(item.width, 0.05, 1, DEFAULTS.width),
      fontSize: clamp(item.fontSize, 0.02, 0.4, DEFAULTS.fontSize),
      fontFamily: POSTER_FONT_KEYS.includes(item.fontFamily) ? item.fontFamily : DEFAULTS.fontFamily,
      color: clipped(item.color, COLOR_MAX, DEFAULTS.color),
      bold: typeof item.bold === 'boolean' ? item.bold : DEFAULTS.bold,
      italic: typeof item.italic === 'boolean' ? item.italic : DEFAULTS.italic,
      strokeColor: clipped(item.strokeColor, COLOR_MAX, DEFAULTS.strokeColor),
      strokeWidth: clamp(item.strokeWidth, 0, 0.12, DEFAULTS.strokeWidth),
      shadow: typeof item.shadow === 'boolean' ? item.shadow : DEFAULTS.shadow,
      align: ['left', 'center', 'right'].includes(item.align) ? item.align : DEFAULTS.align,
    })
  })
  return { texts }
}

/** 变量框内容由剧集数据现场渲染；普通文本用自身内容。 */
export function resolveBoxText(box, vars) {
  return box.kind === 'text' ? box.text : vars[box.kind] || ''
}

/** 布局内所有非空文本。 */
export function resolveTexts(layout, vars) {
  return layout.texts.map(box => resolveBoxText(box, vars).trim()).filter(Boolean)
}

/** 字体栈：缺失字体时浏览器回退，排版仍可用。 */
export function fontStackOf(key) {
  return POSTER_FONT_STACKS[key] || POSTER_FONT_STACKS.sans
}

/** 按测量宽度收缩字号（最低到设定字号的 40%），避免长标题溢出画面。 */
export function fitFontSize(measure, text, fontSizePx, maxWidth) {
  let size = fontSizePx
  const floor = fontSizePx * 0.4
  while (size > floor && measure(text, size) > maxWidth) {
    size = Math.max(floor, size - Math.max(1, fontSizePx * 0.04))
  }
  return size
}
