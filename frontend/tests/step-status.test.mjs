/** 步骤状态的统一视觉口径（Issue #105）：侧栏分区、进度条、阶段条共用的汇总规则。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)

const { STEP_STATUS_GLYPHS, isStepComplete, aggregateStepStatus, stepTextClass } = await import(
  new URL('utils/stepStatus.js', appRoot).href
)

test('完成或跳过都算这一步已走完（父步骤 done = 子步骤 ∈ {done, skipped}）', () => {
  assert.equal(isStepComplete('done'), true)
  assert.equal(isStepComplete('skipped'), true)
  for (const status of ['locked', 'available', 'in_progress', 'stale', null, undefined]) {
    assert.equal(isStepComplete(status), false, `${status} 不算完成`)
  }
})

test('分区汇总：全完成 → done，需复核优先于进行中，全锁 → locked', () => {
  assert.equal(aggregateStepStatus(['done', 'skipped']), 'done')
  assert.equal(aggregateStepStatus(['done', 'done']), 'done')
  // 有一项需复核：即便是「部分完成 + 需复核」，也先报需复核（要回头看）
  assert.equal(aggregateStepStatus(['done', 'stale']), 'stale')
  assert.equal(aggregateStepStatus(['in_progress', 'done']), 'in_progress')
  // 部分完成但没有任何一格在跑：也算进行中，而不是「可开始」
  assert.equal(aggregateStepStatus(['done', 'available']), 'in_progress')
  assert.equal(aggregateStepStatus(['locked', 'locked']), 'locked')
  assert.equal(aggregateStepStatus(['locked', 'available']), 'available')
  // roadmap 未判定时调用方传 null：汇总不得凭空造出 done
  assert.equal(aggregateStepStatus([null, null]), 'available')
  assert.equal(aggregateStepStatus([]), 'available')
})

test('标签文字色：只有完成与需复核改变颜色', () => {
  assert.equal(stepTextClass('done'), 'step-text-done')
  assert.equal(stepTextClass('stale'), 'step-text-stale')
  for (const status of ['locked', 'available', 'in_progress', 'skipped', null]) {
    assert.equal(stepTextClass(status), '', `${status} 保持中性文字色`)
  }
})

test('状态符号：done ✓ / skipped ⤼ / stale ! / available ○；进行中与锁定由组件画图标', () => {
  assert.equal(STEP_STATUS_GLYPHS.done, '✓')
  assert.equal(STEP_STATUS_GLYPHS.skipped, '⤼')
  assert.equal(STEP_STATUS_GLYPHS.stale, '!')
  assert.equal(STEP_STATUS_GLYPHS.available, '○')
  // 进行中是脉冲点、锁定是锁图标、校验中是转圈：都不靠 Unicode 符号表达
  assert.equal(STEP_STATUS_GLYPHS.in_progress, '')
  assert.equal(STEP_STATUS_GLYPHS.locked, '')
  assert.equal(STEP_STATUS_GLYPHS.checking, '')
})
