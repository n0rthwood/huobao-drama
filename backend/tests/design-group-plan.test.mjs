/**
 * 组级视觉规划的硬校验（Issue #109）：规则回给模型，不合格不落卡。
 * 回切 = 上一镜不是以同一张图的图层收尾、本镜却以已出现过的底图开场；
 * 回切须有新增条目或满足再入豁免（距上次出现 ≥3 镜），同一底图连续回切 ≤2（跨组计数）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { validateGroupPlan, normalizeGroupPlan, groupPlanSignature, groupPlanDeviation } from './src/services/design-group-plan.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const MAP = { asset_kind: 'prop', asset_id: 259 }
    const ART = { asset_kind: 'prop', asset_id: 269 }
    const input = (shots, history = []) => ({
      group_no: 1,
      shots: shots.map(([id, measured, locked]) => ({ storyboard_id: id, storyboard_number: id, narration: 'x', measured_s: measured, locked: locked ?? null })),
      assets: [
        { kind: 'prop', id: 259, name: '路线图', has_image: true, is_map: true },
        { kind: 'prop', id: 269, name: '船队版画', has_image: true, is_map: false },
        { kind: 'prop', id: 300, name: '无图资产', has_image: false, is_map: false },
      ],
      history: history.map(([id, combo, base]) => ({ storyboard_id: id, storyboard_number: id, combo, base })),
    })
    const shot = (id, combo, base, mode = combo === 'B' ? 'no_layer' : 'new_items', pip = []) => ({ storyboard_id: id, combo, base, pip, mode, task: 't' })
    const plan = (shots, geo = []) => ({ task: '记住路线', geo_additions: geo, asset_roles: [], shots, junction: '' })
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'group-plan-')), 'test.sqlite3') },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

test('合格规划：首次建立、纯事件镜用 B、带新增条目的回切、D 收尾都通过', () => {
  const errors = run(`out(validateGroupPlan(
    plan([shot(1, 'C', MAP), shot(2, 'B', null), shot(3, 'C', MAP), shot(4, 'D', MAP)],
      [{ text: '翻山路线', storyboard_id: 1 }, { text: '南下段', storyboard_id: 3 }]),
    input([[1, 14], [2, 10.9], [3, 19], [4, 16]])))`)
  assert.deepEqual(errors, [])
})

test('没有新增条目、刚出现过的底图又满幅开场 = 回切违规；隔 ≥3 镜的再入放行', () => {
  const result = run(`out({
    recut: validateGroupPlan(plan([shot(1, 'C', MAP), shot(2, 'B', null), shot(3, 'C', MAP, 'carry_only')], [{ text: '路线', storyboard_id: 1 }]),
      input([[1, 10], [2, 10], [3, 10]])),
    reentry: validateGroupPlan(plan([shot(5, 'C', MAP, 'carry_only')]),
      input([[5, 10]], [[1, 'C', MAP], [2, 'B', null], [3, 'B', null], [4, 'B', null]])),
  })`)
  assert.equal(result.recut.length, 1)
  assert.match(result.recut[0], /#3 .*回切/)
  assert.deepEqual(result.reentry, [])
})

test('同一底图连续回切开场超过 2 镜即违规，跨组计入前面的镜；连续图层戏（A→A 同底图）不算回切', () => {
  const result = run(`out({
    third: validateGroupPlan(plan([shot(3, 'C', MAP)], [{ text: '交汇点', storyboard_id: 3 }]),
      input([[3, 10]], [[0, 'C', MAP], [1, 'C', MAP], [2, 'C', MAP]])),
    continuous: validateGroupPlan(plan([shot(1, 'A', MAP), shot(2, 'A', MAP, 'carry_only'), shot(3, 'A', MAP, 'carry_only')], [{ text: '范围', storyboard_id: 1 }]),
      input([[1, 8], [2, 8], [3, 8]])),
  })`)
  assert.equal(result.third.length, 1)
  assert.match(result.third[0], /连续第 3 次/)
  assert.deepEqual(result.continuous, [])
})

test('时长、底图、锁定镜与新增条目的硬约束逐条报出', () => {
  const errors = run(`out(validateGroupPlan(
    plan([shot(1, 'B', null), shot(2, 'C', { asset_kind: 'prop', asset_id: 300 }), shot(3, 'C', ART)],
      [{ text: '城名', storyboard_id: 1 }]),
    input([[1, 15.7], [2, 10], [3, 10, { combo: 'A', base: MAP }], [4, 9]])))`)
  const text = errors.join('\n')
  assert.match(text, /#1 实测配音 15.7 秒，组合 B 最多 15 秒/)
  assert.match(text, /「无图资产」还没有图/)
  assert.match(text, /#3 已有人工\/已确认的设计/)
  assert.match(text, /新增条目「城名」指派给了 #1，但该镜是组合 B/)
  assert.match(text, /shots 漏了 #4/)
})

test('长旁白不再是「任何组合都装不下」：46 秒的镜用 C/D 的图层段承载', () => {
  const errors = run(`out(validateGroupPlan(
    plan([shot(1, 'C', MAP)], [{ text: '沿途', storyboard_id: 1 }]),
    input([[1, 46]])))`)
  assert.deepEqual(errors, [], '图层段没有上限，46 秒的 C 镜合法')
})

test('结构不合法的输出不猜默认值，原样报错', () => {
  const result = run(`out(normalizeGroupPlan({ task: '', shots: [{ storyboard_id: 1, combo: 'E', base: null, mode: 'no_layer' }] }))`)
  assert.equal(result.plan, null)
  assert.ok(result.errors.some(e => e.includes('task')))
  assert.ok(result.errors.some(e => e.includes('combo 必须是 A/B/C/D')))
})

test('签名按 0.5 秒分桶：同文本重配音的细微抖动不让规划过期', () => {
  const result = run(`out({
    same: groupPlanSignature('段落', [{ storyboard_id: 1, narration: '甲。', measured_s: 10.1 }]) === groupPlanSignature('段落', [{ storyboard_id: 1, narration: '甲。', measured_s: 10.2 }]),
    diff: groupPlanSignature('段落', [{ storyboard_id: 1, narration: '甲。', measured_s: 10.0 }]) === groupPlanSignature('段落', [{ storyboard_id: 1, narration: '甲。', measured_s: 10.6 }]),
  })`)
  assert.deepEqual(result, { same: true, diff: false })
})

test('卡的组合或底图与规划不一致给出偏离说明，一致返回 null', () => {
  const result = run(`
    const card = (asset_id) => ({ layer_plan: { base: { kind: 'asset', asset_kind: 'prop', asset_id, version_task_id: null } } })
    out({
      same: groupPlanDeviation(shot(1, 'C', MAP), 'C', card(259)),
      combo: groupPlanDeviation(shot(1, 'B', null), 'C', card(259)),
      base: groupPlanDeviation(shot(1, 'C', MAP), 'C', card(269)),
    })`)
  assert.equal(result.same, null)
  assert.match(result.combo, /组合是 C，组规划为 B/)
  assert.match(result.base, /底图是 prop#269，组规划为 prop#259/)
})
