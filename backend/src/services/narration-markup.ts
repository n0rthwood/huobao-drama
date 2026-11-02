/**
 * 旁白发音标记（Issue #38）—— 源写法解析与三种派生文本的唯一实现。
 *
 * `storyboards.narration_text` 存「源」，标记一律是 `[[A|B]]`：
 *   [[重庆|chong2 qing4]]  注音·拼音（音节数 = 字数，必须带 1–4 声调）
 *   [[单于|蝉于]]           注音·同音字（字数必须相同）
 *   [[停顿|1.5]]            精确停顿（秒，0.1–10）
 *   [[语气|sigh]]           语气（VoxCPM 非语言标签）
 *
 * 派生：
 *   spokenText        字幕 / 字数 / 时长估算：注音还原原字，停顿与语气去掉
 *   engineSpokenText  VoxCPM 实际念的字（同音字替换后、正文括号换成〔〕），与 spokenText 逐字等长，用于时间戳对齐
 *   toVoxcpmText      发给 VoxCPM Studio 的文本：`重庆(chong2 qing4)` / `蝉于` / `[停顿1.5秒]` / `[sigh]`
 *
 * 前端 `frontend/app/utils/narrationMarkup.js` 是同口径实现，行为测试逐例对照（backend/tests/narration-markup.test.mjs）。
 */

/** VoxCPM 官方推荐的非语言标签（Studio `app/markup.py TAGS`），label 为编辑器显示名 */
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
] as const

export const PAUSE_MIN_SECONDS = 0.1
export const PAUSE_MAX_SECONDS = 10

export type MarkupSegment =
  | { type: 'text'; start: number; end: number; text: string }
  | { type: 'ruby'; start: number; end: number; raw: string; base: string; kind: 'pinyin' | 'homophone'; reading: string }
  | { type: 'pause'; start: number; end: number; raw: string; seconds: number }
  | { type: 'tone'; start: number; end: number; raw: string; tag: string }
  | { type: 'invalid'; start: number; end: number; raw: string; base: string; error: string }

export interface ParsedMarkup {
  segments: MarkupSegment[]
  errors: { start: number; end: number; message: string }[]
}

const CJK = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/
const TONE_MARKS: Record<string, [string, number]> = {}
for (const [base, marks] of [['a', 'āáǎà'], ['e', 'ēéěè'], ['i', 'īíǐì'], ['o', 'ōóǒò'], ['u', 'ūúǔù'], ['v', 'ǖǘǚǜ']] as const) {
  ;[...marks].forEach((ch, i) => { TONE_MARKS[ch] = [base, i + 1] })
}
// 声母 + 韵母结构校验（与 Studio `_PINYIN_RE` 一致）
const PINYIN_RE = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ueng|iao|ian|ing|uai|uan|van|ang|eng|ong|ai|ei|ao|ou|an|en|er|ia|ie|iu|in|ua|uo|ui|un|ue|ve|vn|io|a|o|e|i|u|v|ng|n|m)$/
const MARKER_RE = /\[\[([^[\]|\n]*)\|([^[\]|\n]*)\]\]/g
// 正文里会被 VoxCPM 误当标记的字符 → 一对一替换（保持逐字等长）
const ENGINE_ESCAPE: Record<string, string> = { '(': '〔', ')': '〕', '（': '〔', '）': '〕', '[': '［', ']': '］', '{': '｛', '}': '｝' }

/** 'zhòng' / 'zhong4' / 'lü4' → 'zhong4' / 'lv4'；不合法返回错误说明（与 Studio normalize_syllable 同规则） */
export function normalizeSyllable(raw: string): { value: string } | { error: string } {
  let tone: number | null = null
  let letters = ''
  for (const ch of raw.trim().toLowerCase()) {
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

type MarkerBody =
  | { type: 'ruby'; base: string; kind: 'pinyin' | 'homophone'; reading: string }
  | { type: 'pause'; seconds: number }
  | { type: 'tone'; tag: string }

function parseMarker(base: string, reading: string): { ok: MarkerBody } | { error: string } {
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
  const tokens = reading.trim().split(/\s+/)
  const units: string[] = []
  for (const tok of tokens) {
    const r = normalizeSyllable(tok)
    if ('error' in r) return { error: r.error }
    units.push(r.value)
  }
  if (units.length !== chars.length) {
    return { error: `「${base}」有 ${chars.length} 个字，但拼音「${reading}」有 ${units.length} 个音节` }
  }
  return { ok: { type: 'ruby', base, kind: 'pinyin', reading: units.join(' ') } }
}

export function parseNarrationMarkup(source: string | null | undefined): ParsedMarkup {
  const src = source || ''
  const segments: MarkupSegment[] = []
  const errors: ParsedMarkup['errors'] = []
  let pos = 0
  const pushText = (from: number, to: number) => {
    if (to <= from) return
    const text = src.slice(from, to)
    segments.push({ type: 'text', start: from, end: to, text })
    // 未闭合的 [[ 会被 VoxCPM 当普通文字，但它多半是没写完的标记
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
    if ('error' in r) {
      segments.push({ type: 'invalid', start, end, raw: m[0], base, error: r.error })
      errors.push({ start, end, message: r.error })
    } else {
      segments.push({ ...r.ok, start, end, raw: m[0] } as MarkupSegment)
    }
  }
  pushText(pos, src.length)
  return { segments, errors }
}

/** 字幕 / 字数 / 时长用的纯旁白文字 */
export function spokenText(source: string | null | undefined): string {
  return parseNarrationMarkup(source).segments.map((s) => {
    if (s.type === 'text') return s.text
    if (s.type === 'ruby' || s.type === 'invalid') return s.base
    return ''
  }).join('')
}

function escapeEngineText(text: string): string {
  return text.replace(/[()（）[\]{}]/g, ch => ENGINE_ESCAPE[ch] ?? ch)
}

/** VoxCPM 实际念的字：与 spokenText 逐字等长（同音字替换、正文括号一对一替换） */
export function engineSpokenText(source: string | null | undefined): string {
  return parseNarrationMarkup(source).segments.map((s) => {
    if (s.type === 'text') return escapeEngineText(s.text)
    if (s.type === 'ruby') return s.kind === 'homophone' ? s.reading : s.base
    if (s.type === 'invalid') return escapeEngineText(s.base)
    return ''
  }).join('')
}

/** 发给 VoxCPM Studio 的文本（调用方需先确认没有 errors） */
export function toVoxcpmText(source: string | null | undefined): string {
  return parseNarrationMarkup(source).segments.map((s) => {
    switch (s.type) {
      case 'text': return escapeEngineText(s.text)
      case 'ruby': return s.kind === 'homophone' ? s.reading : `${s.base}(${s.reading})`
      case 'pause': return `[停顿${s.seconds}秒]`
      case 'tone': return `[${s.tag}]`
      case 'invalid': return escapeEngineText(s.base)
    }
    return ''
  }).join('')
}

export function pauseSeconds(source: string | null | undefined): number {
  return parseNarrationMarkup(source).segments.reduce((sum, s) => sum + (s.type === 'pause' ? s.seconds : 0), 0)
}

/** 有拼音注音时 VoxCPM 会关闭整段的文本规范化（wetext 会改坏音素），阿拉伯数字随之按字面念 */
export function phonemeDisablesNormalize(source: string | null | undefined): boolean {
  const parsed = parseNarrationMarkup(source)
  const hasPinyin = parsed.segments.some(s => s.type === 'ruby' && s.kind === 'pinyin')
  return hasPinyin && /\d/.test(spokenText(source))
}
