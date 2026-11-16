/**
 * 忠实改写阶段的保真契约（Issue #70 §4 / 阶段 1，Issue #109 改为句子级）：
 * - 基线是**自动过滤后的正文**，两侧都排除 `【节拍】` 标记（它不是朗读内容）；
 * - 自然段不限长度：一个自然段就是一个逻辑组，拆碎会让相邻镜头来回改画面；
 * - 超出 ±5% 或任一句超过 80 字 = 阶段失败，不产生正式版本（下游与采用都不会发生）；
 * - 合格时报告里带可核对的计量数据（段数、原文段数、超限句清单）。
 * 纯函数，用仓库自带 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { evaluateFidelity, FidelityContractError, FIDELITY_TOLERANCE } from './src/services/script-rewrite/stages.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const attempt = (prepared, content) => {
      try { return { ok: true, report: evaluateFidelity(prepared, content) } }
      catch (err) { return { ok: false, contract: err instanceof FidelityContractError, message: err.message, report: err.report ?? null } }
    }
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** n 个汉字的一段（单句） */
const para = (n, ch = '甲') => `${ch.repeat(n - 1)}。`
/** chars 字一句的段内句子 */
const sentence = (chars, ch = '甲') => `${ch.repeat(chars - 1)}。`

test('节拍标记不计入内容量：只加标记不改字不算超标', () => {
  const prepared = [para(60), para(60, '乙')].join('\n\n')
  const content = ['【开场】', para(60), '', '【转折】', para(60, '乙')].join('\n')
  const result = run(`out(attempt(${JSON.stringify(prepared)}, ${JSON.stringify(content)}))`)
  assert.equal(result.ok, true, `应当通过，实际：${result.message}`)
  assert.equal(result.report.baseline_chars, result.report.output_chars, '节拍标记必须从两侧计量中排除')
  assert.equal(result.report.delta_ratio, 0)
  assert.equal(result.report.paragraphs, 2, '节拍标记不是自然段')
  assert.equal(result.report.paragraphs_source, 2)
})

test('±5% 边界：刚好 5% 通过，刚过 5% 判阶段失败', () => {
  const prepared = Array.from({ length: 5 }, () => para(40)).join('\n\n') // 200 字
  const result = run(`
    const prepared = ${JSON.stringify(prepared)}
    const grow = (n) => prepared + '\\n\\n' + '乙'.repeat(n - 1) + '。'
    out({ edge: attempt(prepared, grow(10)), over: attempt(prepared, grow(11)), shrink: attempt(prepared, prepared.split('\\n\\n').slice(0, 4).join('\\n\\n')) })
  `)
  assert.equal(result.edge.ok, true, `+5% 应当通过，实际：${result.edge.message}`)
  assert.equal(result.edge.report.within_tolerance, true)
  assert.equal(result.over.ok, false, '+5.5% 应当失败')
  assert.equal(result.over.contract, true)
  assert.match(result.over.message, /超过 ±5%/)
  assert.equal(result.shrink.ok, false, '少写 20% 事实同样失败')
})

test('长自然段是合法的：只要每句都短，200 字的段照样通过且段数不变', () => {
  // 一个 200 字的自然段 = 10 句 × 20 字：这是原作者的分段，改写不得拆碎
  const long = Array.from({ length: 10 }, (_, i) => sentence(20, '甲乙丙丁戊己庚辛壬癸'[i])).join('')
  const text = [para(60), long].join('\n\n')
  const result = run(`out(attempt(${JSON.stringify(text)}, ${JSON.stringify(text)}))`)
  assert.equal(result.ok, true, `长段落 + 短句子应当通过，实际：${result.message}`)
  assert.equal(result.report.paragraphs, 2, '不得把长段拆成多段')
  assert.equal(result.report.paragraphs_source, result.report.paragraphs, '段数要与原文一致（一个自然段 = 一个逻辑组）')
  assert.deepEqual(result.report.over_limit_sentences, [])
  assert.equal(result.report.within_tolerance, true)
})

test('单句 80 字是硬上限：81 字判阶段失败并指出是第几段第几句', () => {
  const prepared = [para(40), sentence(20, '乙') + sentence(81, '丙')].join('\n\n')
  const result = run(`out(attempt(${JSON.stringify(prepared)}, ${JSON.stringify(prepared)}))`)
  assert.equal(result.ok, false, '超长句子必须判失败')
  assert.equal(result.contract, true)
  assert.match(result.message, /第 2 段第 2 句 81 字，超过单句 80 字上限/)
  assert.deepEqual(result.report.over_limit_sentences, [
    { paragraph: 2, sentence: 2, chars: 81, excerpt: '丙'.repeat(20) },
  ])
})

test('80 字单句通过，报告带可核对的计量', () => {
  const text = [para(80), para(60, '乙')].join('\n\n')
  const result = run(`out(attempt(${JSON.stringify(text)}, ${JSON.stringify(text)}))`)
  assert.equal(result.ok, true, `应当通过，实际：${result.message}`)
  assert.equal(result.report.paragraphs, 2)
  assert.equal(result.report.paragraphs_source, 2)
  assert.deepEqual(result.report.over_limit_sentences, [])
  assert.equal(result.report.within_tolerance, true)
})
