/**
 * 桥句阶段的结构契约（Issue #70 §4 / 验收 13–15）：
 * - N 个正文段落必须得到 N−1 条边界决策，缺失、错位、重复一律不产生有效版本；
 * - `needed_but_unsafe` 与 `no_bridge` 必须可区分（弃答不能伪装成「不需要」）；
 * - 每个边界最多一句是硬限制；桥句不得带回来源/许可/链接；
 * - 产出全文 = 前驱逐字节 + 已申报桥句，正文不被改写、删除或重排。
 * 纯函数，用仓库自带 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { parseBlocks, paragraphsAndBoundaries, validateBridgeDecisions, composeBridged, BridgeContractError } from './src/services/script-rewrite/bridge.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const prep = (text) => {
      const blocks = parseBlocks(text)
      return { blocks, ...paragraphsAndBoundaries(text, blocks) }
    }
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

const SCRIPT = [
  '【开场】',
  '殷墟位于河南安阳，是商代晚期的都城遗址。',
  '',
  '考古队在这里发掘出大量甲骨。',
  '',
  '甲骨上的刻辞记录了商王的占卜。',
].join('\n')

const DECISIONS = (overrides = '[]') => `
  const base = [
    { boundary_id: 'B01', left_paragraph: 'P01', right_paragraph: 'P02', relation: '现象→材料', decision: 'no_bridge', reason: '两段之间是自然的时间推进' },
    { boundary_id: 'B02', left_paragraph: 'P02', right_paragraph: 'P03', relation: '材料→内容', decision: 'inserted', reason: '左段只讲出土，右段直接跳到刻辞内容', bridge_text: '这些甲骨本身会说话。', placement: 'start_of_right', shot_attribution: 'next_head' },
  ]
  const decisions = JSON.parse(JSON.stringify(base))
  for (const patch of ${overrides}) Object.assign(decisions[patch.at], patch.set)
`

test('节拍标记不计入段落，N 段得到 N−1 个边界', () => {
  const result = run(`
    const { paragraphs, boundaries } = prep(${JSON.stringify(SCRIPT)})
    out({ paragraphs: paragraphs.map(p => p.id), boundaries: boundaries.map(b => [b.boundary_id, b.left_paragraph, b.right_paragraph]) })
  `)
  assert.deepEqual(result.paragraphs, ['P01', 'P02', 'P03'])
  assert.deepEqual(result.boundaries, [['B01', 'P01', 'P02'], ['B02', 'P02', 'P03']])
})

test('合法决策：产出 = 前驱逐字节 + 申报的桥句，报告区分补写与不补', () => {
  const result = run(`
    ${DECISIONS()}
    const { paragraphs, boundaries } = prep(${JSON.stringify(SCRIPT)})
    const report = validateBridgeDecisions(paragraphs, boundaries, { boundaries: decisions })
    const composed = composeBridged(${JSON.stringify(SCRIPT)}, paragraphs, report.decisions)
    out({ report, composed })
  `)
  assert.equal(result.report.boundary_count, 2)
  assert.equal(result.report.inserted_count, 1)
  assert.equal(result.report.needed_but_unsafe_count, 0)
  assert.equal(result.composed.replace('这些甲骨本身会说话。', ''), SCRIPT, '除桥句外必须逐字节相同')
  assert.ok(result.composed.includes('这些甲骨本身会说话。甲骨上的刻辞'), '桥句应插在右段段首')
})

test('边界数量不符 / 顺序错位 / 重复都不产生有效版本', () => {
  const result = run(`
    ${DECISIONS()}
    const { paragraphs, boundaries } = prep(${JSON.stringify(SCRIPT)})
    const attempt = (value) => {
      try { validateBridgeDecisions(paragraphs, boundaries, value); return null }
      catch (err) { return { contract: err instanceof BridgeContractError, message: err.message } }
    }
    out({
      missing: attempt({ boundaries: [decisions[0]] }),
      misordered: attempt({ boundaries: [decisions[1], decisions[0]] }),
      noId: attempt({ boundaries: [{ ...decisions[0], boundary_id: '' }, decisions[1]] }),
    })
  `)
  for (const key of ['missing', 'misordered', 'noId']) {
    assert.ok(result[key], `${key} 应当失败`)
    assert.equal(result[key].contract, true, `${key} 应当是契约错误：${result[key].message}`)
  }
})

test('一个边界最多一句；桥句不得带回来源/链接；缺理由不接受', () => {
  const result = run(`
    ${DECISIONS()}
    const { paragraphs, boundaries } = prep(${JSON.stringify(SCRIPT)})
    const attempt = (patch) => {
      const list = JSON.parse(JSON.stringify(decisions))
      Object.assign(list[1], patch)
      try { validateBridgeDecisions(paragraphs, boundaries, { boundaries: list }); return null }
      catch (err) { return { contract: err instanceof BridgeContractError, message: err.message } }
    }
    out({
      twoSentences: attempt({ bridge_text: '这些甲骨本身会说话。刻辞是它们的声音。' }),
      twoEnglishSentences: attempt({ bridge_text: 'That explains it. Now consider this.' }),
      noRelation: attempt({ relation: '' }),
      withLink: attempt({ bridge_text: '详见https://example.org/a。' }),
      noReason: attempt({ reason: '' }),
      emptyBridge: attempt({ bridge_text: '' }),
    })
  `)
  for (const key of ['twoSentences', 'twoEnglishSentences', 'noRelation', 'withLink', 'noReason', 'emptyBridge']) {
    assert.ok(result[key], `${key} 应当失败`)
    assert.equal(result[key].contract, true, `${key} 应当是契约错误：${result[key].message}`)
  }
})

test('needed_but_unsafe 被保留为独立结论，且不插入任何文字', () => {
  const result = run(`
    ${DECISIONS(`[{ at: 1, set: { decision: 'needed_but_unsafe', bridge_text: null, placement: null, reason: '确有关系缺口，但零新增事实下无法可靠表达' } }]`)}
    const { paragraphs, boundaries } = prep(${JSON.stringify(SCRIPT)})
    const report = validateBridgeDecisions(paragraphs, boundaries, { boundaries: decisions })
    const composed = composeBridged(${JSON.stringify(SCRIPT)}, paragraphs, report.decisions)
    out({ report, same: composed === ${JSON.stringify(SCRIPT)} })
  `)
  assert.equal(result.report.needed_but_unsafe_count, 1)
  assert.equal(result.report.inserted_count, 0)
  assert.equal(result.report.decisions[1].decision, 'needed_but_unsafe')
  assert.equal(result.report.decisions[1].bridge_text, null)
  assert.equal(result.same, true, '弃答不得改动正文')
})

test('并入会超过 80 字时改为独立段落，并在报告里说明', () => {
  const long = `${'甲'.repeat(78)}。`
  const result = run(`
    const text = ${JSON.stringify(`${'甲'.repeat(78)}。\n\n第二段的内容在这里。`)}
    const { paragraphs, boundaries } = prep(text)
    const decisions = [{
      boundary_id: 'B01', left_paragraph: 'P01', right_paragraph: 'P02', relation: '总结',
      decision: 'inserted', reason: '左段收束需要一句承接', bridge_text: '这一点随后被证实。',
      placement: 'end_of_left', shot_attribution: 'previous_tail',
    }]
    const report = validateBridgeDecisions(paragraphs, boundaries, { boundaries: decisions })
    out({ report, composed: composeBridged(text, paragraphs, report.decisions) })
  `)
  assert.equal(result.report.decisions[0].placement, 'standalone')
  assert.equal(result.report.decisions[0].placement_adjusted, true)
  assert.ok(result.report.warnings.some(w => w.includes('独立段落')), '报告要说明调整原因')
  assert.ok(result.composed.includes(`${long}\n\n这一点随后被证实。`), `实际：${result.composed}`)
})

// 内容语言可以是 en/ja/ko：桥句里的空格是词边界，删掉就把整句粘成一个词。
test('非中日文正文：桥句保留词间空格，拼接处不粘词', () => {
  const text = [
    'The expedition left Tobolsk in the spring of 1715.',
    '',
    'Ten thousand men followed the river upstream.',
  ].join('\n')
  const result = run(`
    const text = ${JSON.stringify(text)}
    const { paragraphs, boundaries } = prep(text)
    const decisions = [{
      boundary_id: 'B01', left_paragraph: 'P01', right_paragraph: 'P02', relation: 'departure to march',
      decision: 'inserted', reason: 'the march needs a lead-in',
      bridge_text: '  That   night, the expedition pressed on.  ',
      placement: 'start_of_right', shot_attribution: 'next_head',
    }]
    const report = validateBridgeDecisions(paragraphs, boundaries, { boundaries: decisions })
    out({ report, composed: composeBridged(text, paragraphs, report.decisions) })
  `)
  assert.equal(result.report.decisions[0].bridge_text, 'That night, the expedition pressed on.',
    '桥句只做空白归一化，不得删掉词间空格')
  assert.ok(result.composed.includes('That night, the expedition pressed on. Ten thousand men followed'),
    `拼接处要留词边界，实际：${result.composed}`)
  assert.ok(result.composed.startsWith('The expedition left Tobolsk in the spring of 1715.'), '前驱正文逐字保留')
})

test('中文正文：桥句照旧紧接，不多出空格', () => {
  const result = run(`
    ${DECISIONS()}
    const { paragraphs, boundaries } = prep(${JSON.stringify(SCRIPT)})
    const report = validateBridgeDecisions(paragraphs, boundaries, { boundaries: decisions })
    out({ composed: composeBridged(${JSON.stringify(SCRIPT)}, paragraphs, report.decisions) })
  `)
  assert.ok(result.composed.includes('这些甲骨本身会说话。甲骨上的刻辞记录了商王的占卜。'),
    `中文拼接处不得插入空格，实际：${result.composed}`)
})
