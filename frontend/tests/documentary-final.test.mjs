import test from 'node:test'
import assert from 'node:assert/strict'
import {
  zonesOf, junctionSecondsOf, junctionPercentOf, budgetOf, measuredSecondsOf, isFreshExport, batchScopeOf,
  taskDurationOf, composedSecondsOf, displaySecondsOf,
} from '../app/utils/documentaryFinal.js'

test('documentary zones follow explicit combo; no combo never falls through to drama generation', () => {
  assert.deepEqual(zonesOf('A'), { layer: true, generated: false, final: true })
  assert.deepEqual(zonesOf('B'), { layer: false, generated: true, final: true })
  for (const combo of ['C', 'D']) assert.deepEqual(zonesOf(combo), { layer: true, generated: true, final: true })
  for (const combo of [null, undefined, '', 'replace']) assert.deepEqual(zonesOf(combo), { layer: false, generated: false, final: false })
})
test('junction tick uses measured segment durations and measured composite duration', () => {
  assert.equal(junctionSecondsOf('C', 6.4, 5.2), 6.4)
  assert.equal(junctionSecondsOf('D', 6.4, 5.2), 5.2)
  assert.equal(junctionPercentOf('C', 6, 5, 12), 50)
  assert.equal(junctionPercentOf('D', 6, 5, 12), 5 / 12 * 100)
  assert.equal(junctionPercentOf('A', 6, 0, 6), null)
  assert.equal(junctionPercentOf('B', 0, 5, 5), null)
  assert.equal(junctionPercentOf('C', 6, 5, 0), null)
})
test('measured narration does not mutate approved budget', () => {
  const shot = { design_card: { budget: { layer_s: 20, gen_s: 5 } }, narration_meta: { audio: { duration_ms: 29000 } } }
  const before = structuredClone(shot)
  assert.equal(measuredSecondsOf(shot), 29)
  assert.deepEqual(budgetOf(shot), { layer_s: 20, gen_s: 5 })
  assert.deepEqual(shot, before)
  assert.deepEqual(budgetOf({ design_card: JSON.stringify(shot.design_card) }), shot.design_card.budget)
})
test('export only accepts server exportability, not mere presence of old composite', () => {
  assert.equal(isFreshExport({ composed_video_url: '/old.mp4' }), false)
  assert.equal(isFreshExport({ compose_state: { status: 'changed', exportable: false } }), false)
  assert.equal(isFreshExport({ compose_state: { status: 'unchanged', exportable: true } }), true)
})
test('task center displays persisted scope without recomputing eligibility', () => {
  const scope = { included: [3], excluded: [{ storyboard_id: 4, reason: 'unchanged' }] }
  assert.equal(batchScopeOf({ scope }), scope)
  assert.deepEqual(batchScopeOf({ options: JSON.stringify({ scope }) }), scope)
  assert.deepEqual(batchScopeOf({ params: { scope: JSON.stringify(scope) } }), scope)
  assert.equal(batchScopeOf({ params: '{broken' }), null)
  assert.equal(batchScopeOf({ scope: { included: [] } }), null)
})

test('segment durations come from stored server data; only played metadata overrides them', () => {
  // sys_task.params 序列化后是 JSON 字符串（后端 toSnakeCase 原样下发），JSON 解析失败按「没有数据」处理
  assert.equal(taskDurationOf({ params: '{"duration":8.5,"resolution":"720p"}' }), 8.5)
  assert.equal(taskDurationOf({ params: { duration: 7 } }), 7)
  assert.equal(taskDurationOf({ params: '{"duration":0}' }), 0)
  assert.equal(taskDurationOf({ params: '{broken' }), 0)
  assert.equal(taskDurationOf(null), 0)
  assert.equal(composedSecondsOf({ narration_meta: { composed: { duration_ms: 25030 } } }), 25.03)
  assert.equal(composedSecondsOf({ narrationMeta: { composed: { duration_ms: 0 } } }), 0)
  assert.equal(composedSecondsOf({}), 0)
  assert.equal(displaySecondsOf(9.2, 8.5), 9.2, 'loadedmetadata 的实测时长覆盖请求时长')
  assert.equal(displaySecondsOf(0, 8.5), 8.5, '没播放过就用服务端已存的时长')
  assert.equal(displaySecondsOf(NaN, 0), 0, '两边都没有时长时显示「—」')
})
