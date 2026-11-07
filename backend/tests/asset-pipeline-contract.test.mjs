/**
 * 流水线启动/续跑契约（Issue #73）—— 纯函数，不读库不发网络
 *
 * 对应两条产品硬约束：
 * - 打回重修默认**继续当前用途**，人可以显式改用途；轮次块数与美化轮上限写死，不靠提示词。
 * - 精确轮的参考图必须是启动时人选定的 1–3 条本资产素材；0 条、超 3 条、已排除、
 *   不属于该资产、没有文件的一律拒绝——绝不退化成「零参考图照样画」。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import { planNextRound, selectPrecisionSources, MAX_PIPELINE_REFERENCES } from './src/services/asset-pipeline/contract.ts'

  const capture = (fn) => {
    try {
      return { ok: true, value: fn() }
    } catch (err) {
      return { ok: false, name: err.constructor.name, message: err.message }
    }
  }

  const sources = [
    { id: 11, role: 'generation_reference', local_path: 'static/fixtures/one.png' },
    { id: 12, role: 'shape_only', local_path: 'static/fixtures/two.png' },
    { id: 13, role: 'generation_reference', local_path: 'static/fixtures/three.png' },
    { id: 14, role: 'rejected', local_path: 'static/fixtures/four.png' },
    { id: 15, role: 'generation_reference', local_path: 'static/fixtures/five.png' },
    { id: 16, role: 'generation_reference', local_path: 'static/fixtures/six.png' },
    { id: 17, role: 'generation_reference', local_path: '' },
  ]

  const plans = {
    // 默认沿用本轮用途：精确轮打回重修继续精确轮
    defaultPrecision: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 0, beautifyDone: 0, maxRounds: 3 })),
    defaultBeautify: capture(() => planNextRound({ currentPurpose: 'beautify', currentRoundNo: 0, beautifyDone: 1, maxRounds: 2 })),
    // 人显式改用途
    explicitBeautify: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 0, requested: 'beautify', beautifyDone: 0, maxRounds: 3 })),
    explicitPrecision: capture(() => planNextRound({ currentPurpose: 'beautify', currentRoundNo: 0, requested: 'precision', beautifyDone: 1, maxRounds: 3 })),
    // 精确轮可以连着跑满三块
    precisionThird: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 1, beautifyDone: 0, maxRounds: 3 })),
    // 块数用满
    overLimitPrecision: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 2, beautifyDone: 0, maxRounds: 3 })),
    overLimitBeautifyRun: capture(() => planNextRound({ currentPurpose: 'beautify', currentRoundNo: 1, beautifyDone: 1, maxRounds: 2 })),
    // 美化轮上限（块数还有，但美化已用满两轮）
    beautifyCap: capture(() => planNextRound({ currentPurpose: 'beautify', currentRoundNo: 1, beautifyDone: 2, maxRounds: 3 })),
    beautifyCapRequested: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 1, requested: 'beautify', beautifyDone: 2, maxRounds: 3 })),
    // 美化用满后仍可以继续精确轮
    precisionAfterBeautifyCap: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 1, requested: 'precision', beautifyDone: 2, maxRounds: 3 })),
    badPurpose: capture(() => planNextRound({ currentPurpose: 'precision', currentRoundNo: 0, requested: 'refine', beautifyDone: 0, maxRounds: 3 })),
  }

  const picks = {
    ordered: capture(() => selectPrecisionSources(sources, [13, 11]).map(item => item.id)),
    three: capture(() => selectPrecisionSources(sources, [15, 11, 13]).map(item => item.id)),
    shapeOnlyAllowed: capture(() => selectPrecisionSources(sources, [12]).map(item => item.id)),
    zero: capture(() => selectPrecisionSources(sources, [])),
    overThree: capture(() => selectPrecisionSources(sources, [11, 13, 15, 16])),
    rejected: capture(() => selectPrecisionSources(sources, [11, 14])),
    crossAsset: capture(() => selectPrecisionSources(sources, [11, 999])),
    duplicated: capture(() => selectPrecisionSources(sources, [11, 11])),
    noFile: capture(() => selectPrecisionSources(sources, [17])),
    legacy: capture(() => selectPrecisionSources(sources, undefined).map(item => item.id)),
    legacyNone: capture(() => selectPrecisionSources([{ id: 14, role: 'rejected', local_path: 'static/fixtures/four.png' }], undefined)),
    legacyEmpty: capture(() => selectPrecisionSources([], undefined)),
  }

  process.stdout.write(JSON.stringify({ plans, picks, max: MAX_PIPELINE_REFERENCES }))
`

const { plans, picks, max } = JSON.parse(
  execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' }),
)

test('打回重修默认继续本轮用途，人可显式改用途', () => {
  assert.deepEqual(plans.defaultPrecision.value, { purpose: 'precision', index: 1 })
  assert.deepEqual(plans.defaultBeautify.value, { purpose: 'beautify', index: 1 })
  assert.deepEqual(plans.explicitBeautify.value, { purpose: 'beautify', index: 1 })
  assert.deepEqual(plans.explicitPrecision.value, { purpose: 'precision', index: 1 })
  assert.deepEqual(plans.precisionThird.value, { purpose: 'precision', index: 2 })
  assert.equal(plans.badPurpose.ok, false)
  assert.equal(plans.badPurpose.name, 'RoundPlanError')
})

test('轮次块数用满 → RoundPlanError（精确起步 3 块、美化起步 2 块）', () => {
  assert.equal(plans.overLimitPrecision.ok, false)
  assert.equal(plans.overLimitPrecision.name, 'RoundPlanError')
  assert.match(plans.overLimitPrecision.message, /最多 3 轮/)
  assert.equal(plans.overLimitBeautifyRun.ok, false)
  assert.match(plans.overLimitBeautifyRun.message, /最多 2 轮/)
})

test('美化轮累计上限 2，但不挡继续跑精确轮', () => {
  assert.equal(plans.beautifyCap.ok, false)
  assert.equal(plans.beautifyCap.name, 'RoundPlanError')
  assert.match(plans.beautifyCap.message, /美化轮已用满 2 轮/)
  assert.equal(plans.beautifyCapRequested.ok, false)
  assert.deepEqual(plans.precisionAfterBeautifyCap.value, { purpose: 'precision', index: 2 })
})

test('精确轮参考图按人选顺序取，最多 3 张', () => {
  assert.equal(max, 3)
  assert.deepEqual(picks.ordered.value, [13, 11])
  assert.deepEqual(picks.three.value, [15, 11, 13])
  assert.deepEqual(picks.shapeOnlyAllowed.value, [12])
})

test('0 张 / 超 3 张 / 已排除 / 不属于该资产 / 重复 / 无文件 → ReferenceSelectionError', () => {
  for (const key of ['zero', 'overThree', 'rejected', 'crossAsset', 'duplicated', 'noFile']) {
    assert.equal(picks[key].ok, false, key)
    assert.equal(picks[key].name, 'ReferenceSelectionError', key)
  }
  assert.match(picks.zero.message, /1–3/)
  assert.match(picks.overThree.message, /最多 3 张/)
  assert.match(picks.rejected.message, /#14/)
  assert.match(picks.crossAsset.message, /#999/)
  assert.match(picks.noFile.message, /#17/)
})

test('老 run 没有记录选择时退回前 3 条生成参考图；一条都没有仍然报错', () => {
  assert.deepEqual(picks.legacy.value, [11, 13, 15])
  assert.equal(picks.legacyNone.ok, false)
  assert.equal(picks.legacyNone.name, 'ReferenceSelectionError')
  assert.match(picks.legacyNone.message, /请用新启动流程选择参考/)
  assert.equal(picks.legacyEmpty.ok, false)
})
