/**
 * 字幕切分与时间码（Issue #30）—— 纯函数，可单测，不碰数据库与 ffmpeg。
 *
 * 切分规则：每行 ≤20 个字、每条 ≤2 行、按标点优先断句、不丢字不改字。
 * 时间码（用户确认 Q10）两种模式，都基于**整镜一次合成**的配音：
 *   - `sentence`（默认）：一句一条，句子起止取自 TTS 句级/逐字对齐；单句超长时在本句时间窗内按字数比例再拆，不跨句
 *   - `char`：逐字对齐，按标点切条，起止精确到字
 * 取不到对齐数据时两种模式都回落「按实测总时长与字数比例分配」，并在结果里标注 `proportional_fallback`。
 */
import type { AlignItem } from './tts.js'
import type { SubtitleTiming } from './narration.js'

/** 每行最多字数（全角计 1）；横屏默认，也是上限 */
export const SUBTITLE_MAX_CHARS_PER_LINE = 20
/** 每条字幕最多行数（20 字/行的旧口径，决定每条 40 字上限） */
export const SUBTITLE_MAX_LINES = 2
/** 窄画面按输出宽度重排时允许的最大行数（Issue #91） */
export const SUBTITLE_WRAP_MAX_LINES = 4
/** 一条字幕最多字数 */
export const SUBTITLE_MAX_CHARS_PER_CUE = SUBTITLE_MAX_CHARS_PER_LINE * SUBTITLE_MAX_LINES

/**
 * 烧录字幕在给定输出画面下每行能放多少个全角字（Issue #91）。
 *
 * 标定前提（改动任何一项都要重新实测）：
 * - 烧录样式固定为 `FontSize=18,Outline=1,Shadow=0,MarginV=28`（`shot-compose.ts`），不指定 `FontName`，
 *   生产 `ffmpeg-static` 的 fontconfig 命中 `Noto Sans CJK JP Regular`；
 * - SRT 没有 PlayRes，libass 按脚本坐标（PlayResY=288 / PlayResX=384）缩放，单个全角字的步进实测
 *   ≈ 0.0425 × 输出高（544×960=40.8px、960×544=23.2px、768×768=32.6px）；
 * - 可用宽度要**扣掉 libass 默认左右边距**（各 10 个脚本单位，按 W/384 缩放），样式里只覆盖了 MarginV。
 *
 * 结果以旧值 20 为上限：横屏/方形仍是 20 字/行，既有成片不受影响。
 */
export function subtitleCharsPerLine(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return SUBTITLE_MAX_CHARS_PER_LINE
  }
  const sideMargins = 2 * 10 * (width / 384)
  const glyph = 0.0425 * height
  const fit = Math.floor((width - sideMargins) / glyph)
  return Math.max(1, Math.min(SUBTITLE_MAX_CHARS_PER_LINE, fit))
}

/** 句末标点（切句用） */
const SENTENCE_END = '。！？；!?;'
/** 句内可断点（长句再切用） */
const CLAUSE_BREAK = '，、：,:—…'

export interface SubtitleCue {
  startMs: number
  endMs: number
  /** 展示文本（可能含一个换行） */
  text: string
}

export interface SubtitleResult {
  cues: SubtitleCue[]
  source: 'sentence' | 'char' | 'proportional_fallback'
  timing: SubtitleTiming
}

/** 文本切句：句末标点归属前一句；没有句末标点时整段作一句 */
export function splitSentences(text: string): string[] {
  const normalized = (text || '').replace(/\s+/g, '')
  const sentences: string[] = []
  let buffer = ''
  for (const ch of normalized) {
    buffer += ch
    if (SENTENCE_END.includes(ch)) {
      sentences.push(buffer)
      buffer = ''
    }
  }
  if (buffer) sentences.push(buffer)
  return sentences
}

/**
 * 把一段文本切成满足「每条 ≤40 字」的若干块，优先在句内标点处断开。
 * 不丢字不改字：返回块按顺序拼接等于输入。
 */
export function splitChunks(text: string, maxChars = SUBTITLE_MAX_CHARS_PER_CUE): string[] {
  if (text.length <= maxChars) return text ? [text] : []
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    // 在 [maxChars/2, maxChars] 窗口内找最靠后的可断点，找不到就硬切
    let cut = -1
    for (let i = maxChars - 1; i >= Math.floor(maxChars / 2); i--) {
      if (CLAUSE_BREAK.includes(rest[i]) || SENTENCE_END.includes(rest[i])) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) cut = maxChars
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * 一条字幕的展示文本：超过单行上限时按可断点优先折行（Issue #91 起行宽随输出画面变化）。
 *
 * 行预算只剩最后一行时，剩余文本整行输出（可能超过 `charsPerLine`）——这正是旧实现的行为，
 * 所以 `charsPerLine = 20`（默认行预算 2 行）时输出与旧实现逐字节一致，既有横屏成片不受影响。
 */
export function layoutCueText(
  chunk: string,
  charsPerLine = SUBTITLE_MAX_CHARS_PER_LINE,
  maxLines = charsPerLine >= SUBTITLE_MAX_CHARS_PER_LINE ? SUBTITLE_MAX_LINES : SUBTITLE_WRAP_MAX_LINES,
): string {
  const lines: string[] = []
  let rest = chunk
  while (lines.length < maxLines - 1 && rest.length > charsPerLine) {
    // 在 [charsPerLine/2, charsPerLine] 窗口内找最靠后的可断点，找不到就硬切
    let cut = -1
    for (let i = charsPerLine - 1; i >= Math.floor(charsPerLine / 2); i--) {
      if (CLAUSE_BREAK.includes(rest[i]) || SENTENCE_END.includes(rest[i])) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) cut = charsPerLine
    lines.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  lines.push(rest)
  return lines.join('\n')
}

/** 按字数比例把 [startMs, endMs] 分给各块 */
function proportionalSpans(chunks: string[], startMs: number, endMs: number): SubtitleCue[] {
  const total = chunks.reduce((sum, c) => sum + c.length, 0) || 1
  const span = Math.max(0, endMs - startMs)
  const cues: SubtitleCue[] = []
  let consumed = 0
  for (let i = 0; i < chunks.length; i++) {
    consumed += chunks[i].length
    const cueStart = i === 0 ? startMs : cues[i - 1].endMs
    const cueEnd = i === chunks.length - 1 ? endMs : startMs + Math.round((consumed / total) * span)
    cues.push({ startMs: cueStart, endMs: Math.max(cueEnd, cueStart + 1), text: layoutCueText(chunks[i]) })
  }
  return cues
}

/**
 * 按字数比例分配整段时长（回退路径，永不失败）。
 */
export function proportionalCues(text: string, durationMs: number): SubtitleCue[] {
  const chunks = splitSentences(text).flatMap(s => splitChunks(s))
  if (!chunks.length) return []
  return proportionalSpans(chunks, 0, durationMs)
}

/** 把对齐条目序列对齐到归一化文本的逐字索引（对齐返回的字符可能含空白/标点差异） */
function charSpansFrom(items: AlignItem[], normalized: string): { startMs: number; endMs: number }[] | null {
  const spans: { startMs: number; endMs: number }[] = []
  let cursor = 0
  for (const item of items) {
    const itemText = (item.text || '').replace(/\s+/g, '')
    if (!itemText) continue
    // 对齐条目按顺序消费归一化文本；对不上（服务端做了规整）时放弃，交给回退
    if (normalized.slice(cursor, cursor + itemText.length) !== itemText) {
      const found = normalized.indexOf(itemText, cursor)
      if (found < 0) return null
      // 跳过的字符（多为被服务端吞掉的标点）平均摊给上一条
      for (let i = cursor; i < found; i++) {
        spans.push(spans.length
          ? { startMs: spans[spans.length - 1].endMs, endMs: spans[spans.length - 1].endMs }
          : { startMs: Math.round(item.start * 1000), endMs: Math.round(item.start * 1000) })
      }
      cursor = found
    }
    const startMs = Math.round(item.start * 1000)
    const endMs = Math.round(item.end * 1000)
    const per = itemText.length
    for (let i = 0; i < per; i++) {
      spans.push({
        startMs: startMs + Math.round(((endMs - startMs) * i) / per),
        endMs: startMs + Math.round(((endMs - startMs) * (i + 1)) / per),
      })
    }
    cursor += per
  }
  // 尾部未覆盖的字符补到最后一个 span 的结束时间
  while (spans.length < normalized.length && spans.length) {
    const last = spans[spans.length - 1]
    spans.push({ startMs: last.endMs, endMs: last.endMs })
  }
  if (spans.length < normalized.length) return null
  return spans.slice(0, normalized.length)
}

export interface BuildSubtitleInput {
  text: string
  durationMs: number
  timing: SubtitleTiming
  /** 逐字对齐数据（两种模式唯一的对齐数据源；TTS 服务不支持 level=sentence） */
  charItems?: AlignItem[] | null
  /**
   * TTS 实际念的文字（#38：同音字替换后），与 text 去空白后逐字等长；对齐时间戳用它、字幕文字仍用 text。
   * 不传或长度不等时直接用 text 对齐。
   */
  alignText?: string
}

/**
 * 生成字幕条目。两种模式共用一次整镜合成的音频，对齐数据都来自逐字时间戳：
 * - sentence：逐字时间戳按句聚合，一句一条（句内超长再按字数比例拆，不跨句）
 * - char：逐字时间戳，按标点切条
 */
export function buildSubtitleCues(input: BuildSubtitleInput): SubtitleResult {
  const normalized = (input.text || '').replace(/\s+/g, '')
  if (!normalized) return { cues: [], source: 'proportional_fallback', timing: input.timing }
  const alignNormalized = (input.alignText || '').replace(/\s+/g, '')
  const alignBase = alignNormalized.length === normalized.length ? alignNormalized : normalized

  const sentences = splitSentences(normalized)

  if (input.timing === 'sentence') {
    // 逐字对齐按句聚合（服务端 level=sentence 返回 400，没有句级对齐可用）
    const spans = input.charItems?.length ? charSpansFrom(input.charItems, alignBase) : null
    if (spans) {
      const cues: SubtitleCue[] = []
      let offset = 0
      for (const sentence of sentences) {
        const startMs = spans[offset].startMs
        const endMs = Math.max(spans[offset + sentence.length - 1].endMs, startMs + 1)
        cues.push(...proportionalSpans(splitChunks(sentence), startMs, endMs))
        offset += sentence.length
      }
      return { cues, source: 'sentence', timing: 'sentence' }
    }
    return { cues: proportionalCues(normalized, input.durationMs), source: 'proportional_fallback', timing: 'sentence' }
  }

  // char 模式：逐字时间戳，按标点切条
  const spans = input.charItems?.length ? charSpansFrom(input.charItems, alignBase) : null
  if (!spans) {
    return { cues: proportionalCues(normalized, input.durationMs), source: 'proportional_fallback', timing: 'char' }
  }
  const chunks = sentences.flatMap(s => splitChunks(s))
  const cues: SubtitleCue[] = []
  let offset = 0
  for (const chunk of chunks) {
    const startMs = spans[offset].startMs
    const endMs = Math.max(spans[offset + chunk.length - 1].endMs, startMs + 1)
    cues.push({ startMs, endMs, text: layoutCueText(chunk) })
    offset += chunk.length
  }
  return { cues, source: 'char', timing: 'char' }
}

/** 整体平移（转场偏移 T）与变速（#31 的 atempo）后的时间码 */
export function transformCues(cues: SubtitleCue[], opts: { shiftMs?: number; tempo?: number }): SubtitleCue[] {
  const tempo = opts.tempo && opts.tempo > 0 ? opts.tempo : 1
  const shift = opts.shiftMs || 0
  return cues.map(cue => ({
    text: cue.text,
    startMs: Math.round(cue.startMs / tempo) + shift,
    endMs: Math.round(cue.endMs / tempo) + shift,
  }))
}

function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const h = Math.floor(clamped / 3_600_000)
  const m = Math.floor((clamped % 3_600_000) / 60_000)
  const s = Math.floor((clamped % 60_000) / 1000)
  const msPart = clamped % 1000
  const pad = (v: number, len = 2) => String(v).padStart(len, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msPart, 3)}`
}

export function renderSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, idx) => `${idx + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${cue.text}\n`)
    .join('\n')
}

/**
 * 解析 SRT（只取时间码与文本，用于平移/缩放后重写，以及校验字幕文件是否真的有内容）。
 * 解析不出任何一条就是空字幕：调用方据此阻断，不得当作「没有字幕可烧」静默成功。
 */
export function parseSrt(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim())
    if (lines.length < 2) continue
    const timeLine = lines.find(l => l.includes('-->'))
    if (!timeLine) continue
    const [startRaw, endRaw] = timeLine.split('-->').map(s => s.trim())
    const toMs = (v: string) => {
      const m = v.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
      if (!m) return 0
      return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4])
    }
    const textLines = lines.slice(lines.indexOf(timeLine) + 1)
    if (!textLines.length) continue
    cues.push({ startMs: toMs(startRaw), endMs: toMs(endRaw), text: textLines.join('\n') })
  }
  return cues
}
