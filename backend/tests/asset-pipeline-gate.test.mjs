/**
 * 资产流水线程序闸门（Issue #56 验收 3）—— 纯函数，不读库不发网络
 *
 * 每条用例都对应资产实验里被模型「说宽」的一次真实教训：
 * 模型自判 pass 却留着 violation、清单漏答、把可数事实降级成 minor、
 * 自创容差、画面里留着文字、地标不足却照样给位置结论。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import { decideRound, evaluateGate } from './src/services/asset-pipeline/gate.ts'

  const spec = {
    must_have: [
      { id: 'mh1', element: '两个多辐木轮', why: '', check: '', metric: 'count' },
      { id: 'mh2', element: '单辕', why: '', check: '', metric: 'arrangement' },
      { id: 'mh3', element: '青铜构件绿锈', why: '', check: '', metric: 'color' },
      { id: 'mh4', element: '矩形小舆', why: '', check: '', metric: 'shape' },
    ],
    forbidden: [
      { id: 'fb1', error: '四轮车', why: '' },
      { id: 'fb2', error: '马镫', why: '' },
    ],
    tolerances: ['允许遗迹态或复原态两种呈现'],
    locate_targets: [{ id: 'yinxu', name: '殷墟' }],
    locate_anchors: [{ id: 'anyang', name: '安阳' }, { id: 'huanhe', name: '洹河口' }],
  }
  const specNoLocate = { ...spec, locate_targets: [], locate_anchors: [] }

  const ok = (id) => ({ id, verdict: 'ok', evidence: '看到了' })
  const clean = (id) => ({ id, detected: false, evidence: '没看到' })
  const baseQc = {
    must_have: spec.must_have.map(item => ok(item.id)),
    forbidden: spec.forbidden.map(item => clean(item.id)),
    text_in_image: { present: false, overlay: false, evidence: '全图无文字' },
    overall: 'pass',
  }

  const results = {}
  results.allOk = evaluateGate(specNoLocate, baseQc)

  // 模型说 pass，但有一条 violation
  results.modelPassWithViolation = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [
      { id: 'mh1', verdict: 'violation', evidence: '只有一个轮子' },
      ok('mh2'), ok('mh3'), ok('mh4'),
    ],
    overall: 'pass',
  })

  // 漏答一条 must_have
  results.missingItem = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [ok('mh1'), ok('mh2'), ok('mh3')],
  })

  // 重复回答
  results.duplicated = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [ok('mh1'), ok('mh1'), ok('mh2'), ok('mh3'), ok('mh4')],
  })

  // 可数事实给 minor → 升级成 violation
  results.minorUpgraded = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [
      { id: 'mh1', verdict: 'minor', evidence: '辐条数偏少' },
      ok('mh2'), ok('mh3'), ok('mh4'),
    ],
  })

  // 形状类给 minor → 保持 minor，不升级
  results.minorKept = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [ok('mh1'), ok('mh2'), ok('mh3'), { id: 'mh4', verdict: 'minor', evidence: '比例略长' }],
  })

  // 自创 tolerance
  results.inventedTolerance = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [
      { id: 'mh1', verdict: 'ok', evidence: '', tolerance: '允许轮辐数量自由发挥' },
      ok('mh2'), ok('mh3'), ok('mh4'),
    ],
  })

  // 引用白名单内的 tolerance → 合法
  results.allowedTolerance = evaluateGate(specNoLocate, {
    ...baseQc,
    must_have: [
      { id: 'mh1', verdict: 'ok', evidence: '', tolerance: '允许遗迹态或复原态两种呈现' },
      ok('mh2'), ok('mh3'), ok('mh4'),
    ],
  })

  // 器物自身的铭文：有字但不是额外标注 → 不判 FAIL（Issue #73）
  results.textPresent = evaluateGate(specNoLocate, {
    ...baseQc,
    text_in_image: { present: true, overlay: false, evidence: '舆侧有铸造铭文，属器物本身' },
  })

  // 生成器加上去的标注 → FAIL
  results.textOverlay = evaluateGate(specNoLocate, {
    ...baseQc,
    text_in_image: { present: true, overlay: true, evidence: '右下角有展牌说明文字' },
  })

  // text_in_image.present 缺布尔
  results.textMissing = evaluateGate(specNoLocate, {
    ...baseQc,
    text_in_image: { overlay: false, evidence: '没看清' },
  })

  // text_in_image.overlay 缺布尔（老口径的 QC 回答）→ 清单不完整，不是 PASS
  results.overlayMissing = evaluateGate(specNoLocate, {
    ...baseQc,
    text_in_image: { present: true, evidence: '有字，但没说是不是额外标注' },
  })

  // 禁止项命中
  results.forbiddenHit = evaluateGate(specNoLocate, {
    ...baseQc,
    forbidden: [{ id: 'fb1', detected: true, evidence: '画了四个轮子' }, clean('fb2')],
  })

  // 禁止项 detected 不是布尔
  results.forbiddenNotBoolean = evaluateGate(specNoLocate, {
    ...baseQc,
    forbidden: [{ id: 'fb1', detected: '否', evidence: '' }, clean('fb2')],
  })

  const expected = [
    { id: 'yinxu', name: '殷墟', at: [0.50, 0.50] },
    { id: 'anyang', name: '安阳', at: [0.40, 0.60] },
    { id: 'huanhe', name: '洹河口', at: [0.70, 0.30] },
  ]

  // 地标只报到 1 个 → not_comparable 且 FAIL
  results.oneAnchor = evaluateGate(spec, {
    ...baseQc,
    locate: [
      { id: 'yinxu', at: [0.5, 0.5] },
      { id: 'anyang', at: [0.4, 0.6] },
    ],
  }, { expected })

  // 两个地标 + 目标点位置正确（整体平移缩放）→ ok
  const shift = ([x, y]) => [x * 0.5 + 0.2, y * 0.5 + 0.1]
  results.locateOk = evaluateGate(spec, {
    ...baseQc,
    locate: expected.map(item => ({ id: item.id, at: shift(item.at) })),
  }, { expected })

  // 目标点被挪远 → off 且 FAIL
  results.locateOff = evaluateGate(spec, {
    ...baseQc,
    locate: [
      { id: 'yinxu', at: [0.9, 0.05] },
      { id: 'anyang', at: shift(expected[1].at) },
      { id: 'huanhe', at: shift(expected[2].at) },
    ],
  }, { expected })

  // 保形核验失败 → FAIL
  results.semanticsFail = evaluateGate(specNoLocate, baseQc, {
    semanticsPreserved: { status: 'fail', detail: '线条「洹河」覆盖率 31%' },
  })
  results.semanticsNa = evaluateGate(specNoLocate, baseQc, {
    semanticsPreserved: { status: 'not_applicable', detail: '无标注' },
  })

  const decisions = {
    pass: decideRound([{ round_no: 0, purpose: 'precision', gate_pass: true, human_verdict: null, status: 'generated' }]),
    revise: decideRound([{ round_no: 0, purpose: 'precision', gate_pass: false, human_verdict: null, status: 'generated' }]),
    rollback: decideRound([
      { round_no: 0, purpose: 'precision', gate_pass: true, human_verdict: null, status: 'generated' },
      { round_no: 1, purpose: 'beautify', gate_pass: false, human_verdict: null, status: 'generated' },
      { round_no: 2, purpose: 'beautify', gate_pass: false, human_verdict: null, status: 'generated' },
    ]),
    abort: decideRound([
      { round_no: 0, purpose: 'beautify', gate_pass: false, human_verdict: null, status: 'generated' },
      { round_no: 1, purpose: 'beautify', gate_pass: false, human_verdict: null, status: 'generated' },
    ]),
  }

  process.stdout.write(JSON.stringify({ results, decisions }))
`

const { results, decisions } = JSON.parse(
  execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' }),
)

test('清单全 ok 且无文字 → PASS，覆盖率 1', () => {
  assert.equal(results.allOk.pass, true)
  assert.equal(results.allOk.coverage, 1)
  assert.deepEqual(results.allOk.invalid, [])
  assert.equal(results.allOk.semantics_preserved.status, 'not_applicable')
})

test('模型 overall=pass 但存在 violation → pass=false（不采信模型结论）', () => {
  assert.equal(results.modelPassWithViolation.pass, false)
  assert.equal(results.modelPassWithViolation.model_overall, 'pass')
  assert.equal(results.modelPassWithViolation.violations.length, 1)
  assert.equal(results.modelPassWithViolation.violations[0].id, 'mh1')
})

test('缺一条 must_have → invalid 非空且 pass=false', () => {
  assert.equal(results.missingItem.pass, false)
  assert.ok(results.missingItem.invalid.some(text => text.includes('mh4')))
  assert.ok(results.missingItem.coverage < 1)
})

test('重复回答同一条 → invalid', () => {
  assert.equal(results.duplicated.pass, false)
  assert.ok(results.duplicated.invalid.some(text => text.includes('重复')))
})

test('metric=count 的条目给 minor → 记为 violation', () => {
  assert.equal(results.minorUpgraded.pass, false)
  assert.equal(results.minorUpgraded.violations.length, 1)
  assert.match(results.minorUpgraded.violations[0].evidence, /升级为 violation/)
})

test('metric=shape 的条目给 minor → 保持 minor，不判 FAIL', () => {
  assert.equal(results.minorKept.pass, true)
  assert.equal(results.minorKept.violations.length, 0)
})

test('QC 引用 spec 之外的 tolerance → invalid；引用白名单内的合法', () => {
  assert.equal(results.inventedTolerance.pass, false)
  assert.ok(results.inventedTolerance.invalid.some(text => text.includes('容差')))
  assert.equal(results.allowedTolerance.pass, true)
})

test('器物自身铭文（overlay=false）→ 不判 FAIL；额外标注 overlay=true → FAIL；两个布尔缺一 → invalid', () => {
  assert.equal(results.textPresent.pass, true)
  assert.equal(results.textPresent.text_in_image.present, true)
  assert.equal(results.textPresent.text_in_image.overlay, false)
  assert.equal(results.textOverlay.pass, false)
  assert.equal(results.textOverlay.text_in_image.overlay, true)
  assert.equal(results.textMissing.pass, false)
  assert.equal(results.textMissing.text_in_image.present, null)
  assert.ok(results.textMissing.invalid.some(text => text.includes('text_in_image.present')))
  assert.equal(results.overlayMissing.pass, false)
  assert.equal(results.overlayMissing.text_in_image.overlay, null)
  assert.ok(results.overlayMissing.invalid.some(text => text.includes('text_in_image.overlay')))
})

test('禁止项命中 → FAIL；detected 不是布尔 → invalid', () => {
  assert.equal(results.forbiddenHit.pass, false)
  assert.equal(results.forbiddenHit.forbidden_hits.length, 1)
  assert.equal(results.forbiddenNotBoolean.pass, false)
  assert.ok(results.forbiddenNotBoolean.invalid.some(text => text.includes('布尔')))
})

test('地标只报到 1 个 → locate_checks[].status=not_comparable 且 FAIL', () => {
  assert.equal(results.oneAnchor.pass, false)
  assert.equal(results.oneAnchor.locate_checks.length, 1)
  assert.equal(results.oneAnchor.locate_checks[0].status, 'not_comparable')
  assert.equal(results.oneAnchor.locate_checks[0].distance, null)
})

test('两地标归一化后目标点在容差内 → ok；挪远 → off 且 FAIL', () => {
  assert.equal(results.locateOk.pass, true)
  assert.equal(results.locateOk.locate_checks[0].status, 'ok')
  assert.ok(results.locateOk.locate_checks[0].distance <= 0.12)
  assert.equal(results.locateOff.pass, false)
  assert.equal(results.locateOff.locate_checks[0].status, 'off')
})

test('保形核验 fail → FAIL；not_applicable 不影响结论', () => {
  assert.equal(results.semanticsFail.pass, false)
  assert.equal(results.semanticsFail.semantics_preserved.status, 'fail')
  assert.equal(results.semanticsNa.pass, true)
})

test('decideRound 只给建议：通过 / 打回 / 回退最后 PASS 轮 / 终止', () => {
  assert.equal(decisions.pass.action, 'pass')
  assert.equal(decisions.revise.action, 'revise')
  assert.equal(decisions.revise.target_round_no, 1)
  assert.equal(decisions.rollback.action, 'rollback')
  assert.equal(decisions.rollback.target_round_no, 0)
  assert.equal(decisions.abort.action, 'abort')
})
