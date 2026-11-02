/**
 * 旁白发音标记（Issue #38）前端实现 —— 与后端 `backend/src/services/narration-markup.ts` 同口径，
 * 行为测试 `backend/tests/narration-markup.test.mjs` 逐例对照两边结果。
 *
 *   [[重庆|chong2 qing4]]  注音·拼音   [[单于|蝉于]] 注音·同音字
 *   [[停顿|1.5]]           精确停顿     [[语气|sigh]] 语气
 */

export const TONE_TAGS = [
  { tag: 'laughing', label: '笑声' },
  { tag: 'sigh', label: '叹气' },
  { tag: 'Uhm', label: '嗯…（思考）' },
  { tag: 'Shh', label: '嘘' },
  { tag: 'Question-ah', label: '啊？' },
  { tag: 'Question-ei', label: '诶？' },
  { tag: 'Question-en', label: '嗯？' },
  { tag: 'Question-oh', label: '哦？' },
  { tag: 'Surprise-wa', label: '哇（惊讶）' },
  { tag: 'Surprise-yo', label: '哟（惊讶）' },
  { tag: 'Dissatisfaction-hnn', label: '哼（不满）' },
]

export const PAUSE_MIN_SECONDS = 0.1
export const PAUSE_MAX_SECONDS = 10

const CJK = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/
export const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const TONE_MARKS = {}
for (const [base, marks] of [['a', 'āáǎà'], ['e', 'ēéěè'], ['i', 'īíǐì'], ['o', 'ōóǒò'], ['u', 'ūúǔù'], ['v', 'ǖǘǚǜ']]) {
  ;[...marks].forEach((ch, i) => { TONE_MARKS[ch] = [base, i + 1] })
}
const PINYIN_RE = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ueng|iao|ian|ing|uai|uan|van|ang|eng|ong|ai|ei|ao|ou|an|en|er|ia|ie|iu|in|ua|uo|ui|un|ue|ve|vn|io|a|o|e|i|u|v|ng|n|m)$/
const MARKER_RE = /\[\[([^[\]|\n]*)\|([^[\]|\n]*)\]\]/g

/** 'zhòng' / 'zhong4' / 'lü4' → { value: 'zhong4' }；不合法 → { error } */
export function normalizeSyllable(raw) {
  let tone = null
  let letters = ''
  for (const ch of String(raw).trim().toLowerCase()) {
    const mark = TONE_MARKS[ch]
    if (mark) { letters += mark[0]; tone = mark[1] } else letters += ch
  }
  letters = letters.replace(/u:/g, 'v').replace(/ü/g, 'v')
  const m = /^([a-z]+)([0-9])?$/.exec(letters)
  if (!m) return { error: `「${raw}」不是拼音` }
  if (m[2] !== undefined && tone !== null) return { error: `「${raw}」声调符号和数字只能二选一` }
  const t = m[2] !== undefined ? Number(m[2]) : tone
  if (t === null || t === 0 || t === 5) return { error: `「${raw}」缺声调或是轻声（模型只认 1–4 声，轻声请改用同音字）` }
  if (t > 4) return { error: `「${raw}」声调只能是 1–4` }
  if (!PINYIN_RE.test(m[1])) return { error: `「${raw}」不是有效的拼音音节` }
  return { value: `${m[1]}${t}` }
}

function parseMarker(base, reading) {
  if (base === '停顿' && /^\d+(\.\d+)?$/.test(reading)) {
    const seconds = Number(reading)
    if (seconds < PAUSE_MIN_SECONDS || seconds > PAUSE_MAX_SECONDS) {
      return { error: `停顿 ${reading} 秒超出范围（${PAUSE_MIN_SECONDS}–${PAUSE_MAX_SECONDS} 秒）` }
    }
    return { ok: { type: 'pause', seconds } }
  }
  if (base === '语气' && /^[A-Za-z][A-Za-z-]*$/.test(reading)) {
    if (!TONE_TAGS.some(t => t.tag === reading)) return { error: `未知的语气「${reading}」` }
    return { ok: { type: 'tone', tag: reading } }
  }
  if (!base) return { error: '注音缺少原文' }
  if (!reading) return { error: `「${base}」的注音为空` }
  if (!CJK.test(base)) return { error: `「${base}」只能给汉字注音` }
  const chars = [...base]
  if (CJK.test(reading)) {
    if ([...reading].length !== chars.length) {
      return { error: `同音字「${reading}」必须与「${base}」字数相同（${chars.length} 个字）` }
    }
    return { ok: { type: 'ruby', base, kind: 'homophone', reading } }
  }
  const units = []
  for (const tok of reading.trim().split(/\s+/)) {
    const r = normalizeSyllable(tok)
    if (r.error) return { error: r.error }
    units.push(r.value)
  }
  if (units.length !== chars.length) {
    return { error: `「${base}」有 ${chars.length} 个字，但拼音「${reading}」有 ${units.length} 个音节` }
  }
  return { ok: { type: 'ruby', base, kind: 'pinyin', reading: units.join(' ') } }
}

/** → { segments: [{type, start, end, ...}], errors: [{start, end, message}] } */
export function parseNarrationMarkup(source) {
  const src = source || ''
  const segments = []
  const errors = []
  let pos = 0
  const pushText = (from, to) => {
    if (to <= from) return
    const text = src.slice(from, to)
    segments.push({ type: 'text', start: from, end: to, text })
    const open = text.indexOf('[[')
    if (open >= 0) errors.push({ start: from + open, end: to, message: '标记「[[」没有闭合（应为 [[原文|读音]]）' })
  }
  for (const m of src.matchAll(MARKER_RE)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    pushText(pos, start)
    pos = end
    const base = m[1].trim()
    const reading = m[2].trim()
    const r = parseMarker(base, reading)
    if (r.error) {
      segments.push({ type: 'invalid', start, end, raw: m[0], base, error: r.error })
      errors.push({ start, end, message: r.error })
    } else {
      segments.push({ ...r.ok, start, end, raw: m[0] })
    }
  }
  pushText(pos, src.length)
  return { segments, errors }
}

/** 字幕 / 字数用的纯旁白文字 */
export function spokenText(source) {
  return parseNarrationMarkup(source).segments.map((s) => {
    if (s.type === 'text') return s.text
    if (s.type === 'ruby' || s.type === 'invalid') return s.base
    return ''
  }).join('')
}

export function pauseSeconds(source) {
  return parseNarrationMarkup(source).segments.reduce((sum, s) => sum + (s.type === 'pause' ? s.seconds : 0), 0)
}

/** 编辑器插入用的源写法 */
export function rubyMarker(base, reading) {
  return `[[${base}|${reading}]]`
}
export function pauseMarker(seconds) {
  return `[[停顿|${Number(seconds)}]]`
}
export function toneMarker(tag) {
  return `[[语气|${tag}]]`
}

/** 光标所在（或紧贴）的标记段；没有返回 null */
export function markerAt(source, caret) {
  return parseNarrationMarkup(source).segments.find(s => s.type !== 'text' && caret > s.start && caret < s.end) || null
}
