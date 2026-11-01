import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  buildSubtitleCues,
  layoutCueText,
  proportionalCues,
  renderSrt,
  splitChunks,
  splitSentences,
  transformCues,
  SUBTITLE_MAX_CHARS_PER_LINE,
  SUBTITLE_MAX_CHARS_PER_CUE,
} = await import('../src/services/subtitle.ts')

const TEXT = '一七二〇年，清、准、俄三方，都在这片草原上押下重注。同一张棋盘上，两场远征同时开局。'

const stripPunct = (s) => s.replace(/[，。、；：？！…—\s]/g, '')

test('splitSentences 按句末标点切句且不丢字', () => {
  const sentences = splitSentences(TEXT)
  assert.equal(sentences.length, 2)
  assert.equal(sentences.join(''), TEXT.replace(/\s+/g, ''))
})

test('splitChunks 不丢字不改字，且每条不超过上限', () => {
  const long = '甲'.repeat(97)
  const chunks = splitChunks(long)
  assert.equal(chunks.join(''), long)
  for (const chunk of chunks) assert.ok(chunk.length <= SUBTITLE_MAX_CHARS_PER_CUE)
})

test('layoutCueText 超过单行上限时折成两行', () => {
  const chunk = '甲'.repeat(SUBTITLE_MAX_CHARS_PER_LINE + 5)
  const laid = layoutCueText(chunk)
  const lines = laid.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines.every(line => line.length <= SUBTITLE_MAX_CHARS_PER_LINE))
  assert.equal(laid.replace('\n', ''), chunk)
})

test('比例分配：cue 文本拼接等于原文，末条不超过配音时长', () => {
  const cues = proportionalCues(TEXT, 9000)
  assert.ok(cues.length >= 2)
  assert.equal(stripPunct(cues.map(c => c.text.replace('\n', '')).join('')), stripPunct(TEXT))
  assert.ok(cues[cues.length - 1].endMs <= 9000)
  for (const cue of cues) assert.ok(cue.endMs > cue.startMs)
})

test('sentence 模式：逐字时间戳按句聚合，一句一条且不跨句', () => {
  const normalized = TEXT.replace(/\s+/g, '')
  const sentences = splitSentences(normalized)
  const charItems = [...normalized].map((ch, i) => ({ start: i * 0.2, end: (i + 1) * 0.2, text: ch }))
  const result = buildSubtitleCues({ text: TEXT, durationMs: normalized.length * 200, timing: 'sentence', charItems })
  assert.equal(result.source, 'sentence')
  assert.equal(result.cues[0].startMs, 0)
  assert.equal(stripPunct(result.cues.map(c => c.text.replace('\n', '')).join('')), stripPunct(TEXT))
  // 每条字幕完整落在某一句内（不跨句）
  let offset = 0
  for (const sentence of sentences) {
    const windowStart = offset * 200
    const windowEnd = (offset + sentence.length) * 200
    const inside = result.cues.filter(c => c.startMs >= windowStart && c.endMs <= windowEnd)
    assert.ok(inside.length >= 1, `句「${sentence}」没有对应字幕`)
    offset += sentence.length
  }
})

test('char 模式：逐字时间戳，按标点切条', () => {
  const normalized = TEXT.replace(/\s+/g, '')
  const charItems = [...normalized].map((ch, i) => ({ start: i * 0.25, end: (i + 1) * 0.25, text: ch }))
  const result = buildSubtitleCues({ text: TEXT, durationMs: normalized.length * 250, timing: 'char', charItems })
  assert.equal(result.source, 'char')
  assert.equal(result.cues[0].startMs, 0)
  assert.equal(stripPunct(result.cues.map(c => c.text.replace('\n', '')).join('')), stripPunct(TEXT))
})

test('两种模式取不到对齐数据时都回落比例分配并标注来源', () => {
  for (const timing of ['sentence', 'char']) {
    const result = buildSubtitleCues({ text: TEXT, durationMs: 9000, timing })
    assert.equal(result.source, 'proportional_fallback')
    assert.equal(result.timing, timing)
    assert.ok(result.cues.length > 0)
  }
})

test('transformCues 按 tempo 缩放并整体平移（转场 T）', () => {
  const cues = [{ startMs: 0, endMs: 2000, text: 'a' }, { startMs: 2000, endMs: 4000, text: 'b' }]
  const shifted = transformCues(cues, { shiftMs: 3000, tempo: 1 })
  assert.deepEqual(shifted.map(c => c.startMs), [3000, 5000])
  const scaled = transformCues(cues, { shiftMs: 0, tempo: 2 })
  assert.deepEqual(scaled.map(c => [c.startMs, c.endMs]), [[0, 1000], [1000, 2000]])
})

test('renderSrt 输出标准 SRT 时间码', () => {
  const srt = renderSrt([{ startMs: 0, endMs: 1500, text: '测试' }])
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\n测试\n$/)
})
