import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUDGET_SLACK_SECONDS, GEN_MAX_SECONDS, fitBudgetToNarration, formatSeconds, roundUpHalf } from '../app/utils/designCardBudget.js'

// Issue #110：图层段不设上限，只有生成段受 15 s 限制。一键「延长图层段」与服务端 AI 写入
// 必须算同一个数：差额进图层段、向上取整到 0.5 s、只加不减。

test('formatSeconds collapses float noise to at most two decimals', () => {
  assert.equal(formatSeconds(0.20000000298023224), '0.2')
  assert.equal(formatSeconds(0.1 + 0.2), '0.3')
  assert.equal(formatSeconds(8), '8')
  assert.equal(formatSeconds(8.5), '8.5')
  assert.equal(formatSeconds(13.567), '13.57')
  assert.equal(formatSeconds(null), '')
  assert.equal(formatSeconds(Number.NaN), '')
})

test('roundUpHalf rounds up to the next half second', () => {
  assert.equal(roundUpHalf(1.1), 1.5)
  assert.equal(roundUpHalf(1), 1)
  assert.equal(roundUpHalf(0), 0)
  assert.equal(roundUpHalf(8.0001), 8.5)
})

test('C combo: the shortfall goes into the layer segment, rounded up to 0.5 s', () => {
  const result = fitBudgetToNarration({ layer_s: 8, gen_s: 6 }, 'C', 14)
  assert.equal(result.changed, true)
  assert.equal(result.reason, 'layer')
  assert.equal(result.from, 8)
  assert.equal(result.to, 8.5)
  assert.deepEqual(result.budget, { layer_s: 8.5, gen_s: 6 })
  // 实测 + 0.5 s 余量才是目标：8.5 + 6 = 14.5 = 14 + 0.5
  assert.equal(result.to + 6, 14 + BUDGET_SLACK_SECONDS)
})

test('budget that already has 0.5 s headroom is left alone', () => {
  assert.equal(fitBudgetToNarration({ layer_s: 9, gen_s: 6 }, 'C', 14).changed, false)
  assert.equal(fitBudgetToNarration({ layer_s: 9, gen_s: 6 }, 'C', 14.5).changed, false)
})

test('only increases: a shortfall smaller than half a second still moves one step', () => {
  const result = fitBudgetToNarration({ layer_s: 10, gen_s: 6 }, 'C', 16)
  assert.equal(result.changed, true)
  assert.equal(result.to, 10.5)
})

test('A combo has no generated segment: gen_s null counts as zero', () => {
  const result = fitBudgetToNarration({ layer_s: 5, gen_s: null }, 'A', 6.2)
  assert.equal(result.changed, true)
  assert.equal(result.budget.layer_s, 7)
  assert.equal(result.budget.gen_s, null)
})

test('an unfilled generated segment counts as zero, like the backend rule', () => {
  const result = fitBudgetToNarration({ layer_s: 5, gen_s: null }, 'C', 12)
  assert.equal(result.changed, true)
  assert.equal(result.budget.layer_s, 12.5)
  assert.equal(result.budget.gen_s, null)
  // 图层段没填就没有可加的基数：不凭空生成
  assert.equal(fitBudgetToNarration({ layer_s: null, gen_s: 5 }, 'D', 12).changed, false)
})

test('B combo raises the generated segment up to the 15 s model limit', () => {
  const result = fitBudgetToNarration({ layer_s: null, gen_s: 12 }, 'B', 14.9)
  assert.equal(result.changed, true)
  assert.equal(result.reason, 'gen')
  assert.equal(result.to, GEN_MAX_SECONDS)
  assert.equal(result.budget.layer_s, null)
})

test('B combo narration over 15 s tops out at the model limit and stops', () => {
  // 生成段还没顶满：补到 15 s；顶满之后继续装不下由服务端阻断（改用 C/D），不再有别的本地状态
  const raised = fitBudgetToNarration({ layer_s: null, gen_s: 12 }, 'B', 16.2)
  assert.equal(raised.changed, true)
  assert.equal(raised.budget.gen_s, GEN_MAX_SECONDS)
  const capped = fitBudgetToNarration({ layer_s: null, gen_s: 15 }, 'B', 16.2)
  assert.equal(capped.changed, false)
  assert.equal(capped.reason, '')
})

test('missing measured narration or unknown combo never invents a budget', () => {
  assert.equal(fitBudgetToNarration({ layer_s: 5, gen_s: 5 }, 'C', null).changed, false)
  assert.equal(fitBudgetToNarration({ layer_s: 5, gen_s: 5 }, 'C', 0).changed, false)
  assert.equal(fitBudgetToNarration({ layer_s: 5, gen_s: 5 }, null, 20).changed, false)
})

test('fit never mutates the input budget object', () => {
  const budget = { layer_s: 8, gen_s: 6 }
  fitBudgetToNarration(budget, 'C', 14)
  assert.deepEqual(budget, { layer_s: 8, gen_s: 6 })
})
