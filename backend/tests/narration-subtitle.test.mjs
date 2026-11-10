import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  buildSubtitleCues,
  layoutCueText,
  proportionalCues,
  renderSrt,
  splitChunks,
  splitSentences,
  subtitleCharsPerLine,
  transformCues,
  SUBTITLE_MAX_CHARS_PER_LINE,
  SUBTITLE_MAX_CHARS_PER_CUE,
  SUBTITLE_WRAP_MAX_LINES,
} = await import('../src/services/subtitle.ts')

/** Issue #91 之前的实现，原样保留用于逐字节对比 */
function legacyLayoutCueText(chunk) {
  const CLAUSE_BREAK = '，、：,:—…'
  const SENTENCE_END = '。！？；!?;'
  if (chunk.length <= 20) return chunk
  let cut = -1
  for (let i = 19; i >= 10; i--) {
    if (CLAUSE_BREAK.includes(chunk[i]) || SENTENCE_END.includes(chunk[i])) {
      cut = i + 1
      break
    }
  }
  if (cut <= 0) cut = 20
  return `${chunk.slice(0, cut)}\n${chunk.slice(cut)}`
}

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

test('subtitleCharsPerLine 按输出画面决定行宽（生产 ffmpeg 实测标定）', () => {
  assert.equal(subtitleCharsPerLine(960, 544), 20)
  assert.equal(subtitleCharsPerLine(544, 960), 12)
  assert.equal(subtitleCharsPerLine(768, 768), 20)
  // 竖屏介于两者之间、永远不超过旧上限；尺寸不可用时回落默认
  assert.ok(subtitleCharsPerLine(720, 1280) >= 12 && subtitleCharsPerLine(720, 1280) <= 20)
  assert.equal(subtitleCharsPerLine(0, 0), 20)
})

test('layoutCueText 在 20 字/行时与旧实现逐字节一致', () => {
  const cases = [
    '甲'.repeat(25),
    '甲'.repeat(40),
    '短句',
    '甲'.repeat(16) + '，' + '乙'.repeat(23), // 断点落在 [10,19] 窗口内，旧实现第二行超过 20 字
    '一七二〇年，清、准、俄三方，都在这片草原上押下重注，同一张棋盘上两场远征同时开局。',
    '前十个字就断，' + '丙'.repeat(33),
  ]
  for (const chunk of cases) {
    assert.equal(layoutCueText(chunk), legacyLayoutCueText(chunk), chunk)
    assert.equal(layoutCueText(chunk, SUBTITLE_MAX_CHARS_PER_LINE), legacyLayoutCueText(chunk), chunk)
    assert.equal(layoutCueText(chunk, SUBTITLE_MAX_CHARS_PER_LINE, SUBTITLE_WRAP_MAX_LINES), legacyLayoutCueText(chunk), chunk)
  }
})

test('layoutCueText 窄画面折成 ≤4 行，不丢字不改字，优先在标点处断行', () => {
  const chunk = '一七二〇年，清、准、俄三方，都在这片草原上押下重注，两场远征同时开局。'
  const lines = layoutCueText(chunk, 12).split('\n')
  assert.ok(lines.length >= 3 && lines.length <= SUBTITLE_WRAP_MAX_LINES)
  assert.equal(lines.join(''), chunk)
  for (const line of lines) assert.ok(line.length <= 12, line)
  // 40 字满条在 12 字/行下仍放得进 4 行
  const full = layoutCueText('甲'.repeat(SUBTITLE_MAX_CHARS_PER_CUE), 12).split('\n')
  assert.equal(full.length, SUBTITLE_WRAP_MAX_LINES)
  assert.equal(full.join(''), '甲'.repeat(SUBTITLE_MAX_CHARS_PER_CUE))
  for (const line of full) assert.ok(line.length <= 12)
  // 断点优先级：窗口内最靠后的标点
  assert.deepEqual(layoutCueText('一二三四五六，七八九十甲乙丙丁戊己', 12).split('\n'), ['一二三四五六，', '七八九十甲乙丙丁戊己'])
})

test('layoutCueText 窄画面：靠前的标点断点不得挤爆最后一行', () => {
  const chunk = ('甲'.repeat(6) + '，').repeat(3) + '乙'.repeat(19)
  assert.equal(chunk.length, SUBTITLE_MAX_CHARS_PER_CUE)
  const lines = layoutCueText(chunk, 12).split('\n')
  assert.ok(lines.length <= SUBTITLE_WRAP_MAX_LINES)
  assert.equal(lines.join(''), chunk)
  for (const line of lines) assert.ok(line.length <= 12, `${line.length}: ${line}`)
})

test('layoutCueText 窄画面：下一行不得以标点开头（避头点）', () => {
  // drama 14 / episode 20 实测：硬切把「。」「，」甩到行首
  for (const chunk of ['赵高果然亲自来到斋宫问病。', '那个只建立了十几年的帝国，在这一天结束。', '这年冬天，楚军到了霸上——咸阳的门槛外。']) {
    const lines = layoutCueText(chunk, 12).split('\n')
    assert.equal(lines.join(''), chunk)
    assert.ok(lines.length <= SUBTITLE_WRAP_MAX_LINES)
    for (const line of lines) {
      assert.ok(line.length <= 12, line)
      assert.ok(!/^[，。、；：！？）」』》〉”’…—,.;:!?)]/.test(line), `行首标点: ${JSON.stringify(lines)}`)
    }
  }
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
