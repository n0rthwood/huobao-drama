/**
 * 分镜设计卡（Issue #57）纯函数：
 * - `normalizeDesignCard`：白名单 + 钳制 + 「解析不到的引用保留并标 unresolved」；**绝不读 combo**；
 * - `validateDesignCard`：六个阻断码与五个警告码逐条；
 * - `storyboardCountCap` / `scriptParagraphs`：镜头数硬上限公式。
 * 纯函数，用仓库自带 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import {
      normalizeDesignCard, validateDesignCard, estimateCardBudget, storyboardCountCap,
      parseDesignCard, serializeDesignCard, referenceAssetRefs,
      hasLayerSegment, hasGenSegment, lockedGenSlot, toCombo,
    } from './src/services/design-card.ts'
    import { scriptParagraphs } from './src/services/narration-first.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** 本集资产：一张带语义标注的地图 + 一个角色 */
const CTX = `
  const ctx = { assets: [
    { kind: 'prop', id: 39, name: '西伯利亚舆图', faithful: true, semantics: [
      { id: 'pt-1', name: '托博尔斯克', group: 'point' },
      { id: 'ln-1', name: '额尔齐斯河', group: 'line' },
    ] },
    { kind: 'character', id: 25, name: '利哈列夫' },
  ] }
`

const FULL_CARD = `
  const raw = {
    version: 2,
    info_points: [
      { id: 'ip1', text: '1716 年近卫团从托博尔斯克出发', via: 'layer' },
      { text: '队列涉过冰河', via: 'generated' },
    ],
    budget: { layer_s: 6, gen_s: 5 },
    layer_plan: {
      base: { kind: 'asset', asset_kind: 'prop', asset_id: 39, version_task_id: 501 },
      must_mark: [
        { asset_id: 39, semantic_id: '托博尔斯克' },
        { asset_id: 39, semantic_id: 'ln-1' },
      ],
      planned_layers: [
        { type: 'marker', anchor: { asset_id: 39, semantic_id: 'pt-1' }, text: '托博尔斯克', at_s: 1 },
        { type: 'polyline', anchor: { asset_id: 39, semantic_id: 'ln-1' }, at_s: 2.5 },
      ],
    },
    gen_plan: { reference_assets: [{ kind: 'character', id: 25 }], last: '远望乌拉尔群山' },
    rationale: '先以舆图交代出发地与年份，再切入行军实景',
    suggested_combo: 'C',
    combo: 'A',
  }
`

test('规范化：按名称写的语义条目被补成稳定 id，suggested_combo 保留，模型给的 combo 被忽略', () => {
  const got = run(`${CTX}${FULL_CARD}
    const card = normalizeDesignCard(raw, ctx)
    out({ card, hasComboKey: 'combo' in card, roundTrip: JSON.parse(serializeDesignCard(card)) })
  `)
  assert.equal(got.card.version, 2)
  assert.equal(got.hasComboKey, false, '设计卡 JSON 里不存在 combo —— 段组合只存在列上，由人选')
  assert.equal(got.card.suggested_combo, 'C')
  assert.equal(got.card.info_points.length, 2)
  assert.equal(got.card.info_points[1].id, 'ip2', '没写 id 的信息点补一个稳定 id')
  assert.deepEqual(got.card.layer_plan.must_mark[0], { asset_id: 39, semantic_id: 'pt-1', name: '托博尔斯克' },
    '按名称写的条目被解析成稳定 id')
  assert.equal(got.card.layer_plan.base.version_task_id, 501)
  assert.deepEqual(got.card.layer_plan.planned_layers.map(l => l.at_s), [1, 2.5], '计划图层按时刻升序')
  assert.equal(got.card.gen_plan.reference_assets[0].name, '利哈列夫', '资产名读时补全')
  assert.equal(got.roundTrip.issues, undefined, '落库的 JSON 不含读时重算的 issues')
})

test('规范化：解析不到的引用保留并标 unresolved，不被静默删掉', () => {
  const got = run(`${CTX}
    const card = normalizeDesignCard({
      info_points: [], budget: {},
      layer_plan: {
        base: { kind: 'asset', asset_kind: 'prop', asset_id: 999 },
        must_mark: [{ asset_id: 39, semantic_id: '不存在的地名' }],
        planned_layers: [{ type: 'marker', anchor: { asset_id: 39, semantic_id: '也不存在' }, at_s: 1 }],
      },
      gen_plan: { reference_assets: [{ kind: 'character', id: 777 }] },
    }, ctx)
    out({
      base: card.layer_plan.base,
      mustMark: card.layer_plan.must_mark,
      anchor: card.layer_plan.planned_layers[0].anchor,
      ref: card.gen_plan.reference_assets[0],
      issues: validateDesignCard({ card, combo: 'C' }).map(i => i.code),
    })
  `)
  assert.equal(got.base.unresolved, true)
  assert.equal(got.mustMark.length, 1, '解析不到的必须标注条目保留')
  assert.equal(got.mustMark[0].unresolved, true)
  assert.equal(got.anchor.unresolved, true)
  assert.equal(got.ref.unresolved, true)
  assert.equal(got.issues.filter(code => code === 'unresolved_ref').length, 4, '四条引用各报一条 unresolved_ref')
})

test('规范化：非法组合与非法图层类型一律丢弃，绝不回落默认值', () => {
  const got = run(`${CTX}
    out({
      combos: [toCombo('A'), toCombo('a'), toCombo('E'), toCombo(''), toCombo(null), toCombo('replace')],
      suggested: normalizeDesignCard({ suggested_combo: 'E' }, ctx).suggested_combo,
      layers: normalizeDesignCard({ layer_plan: { planned_layers: [
        { type: 'marker', at_s: 1 }, { type: 'hologram', at_s: 2 },
      ] } }, ctx).layer_plan.planned_layers.map(l => l.type),
      empty: normalizeDesignCard('not an object', ctx),
      parsed: parseDesignCard('{ broken json', ctx),
    })
  `)
  assert.deepEqual(got.combos, ['A', 'A', null, null, null, null], '认不出的 combo 一律 null，没有默认值')
  assert.equal(got.suggested, null)
  assert.deepEqual(got.layers, ['marker'], '白名单外的图层类型被丢弃')
  assert.equal(got.empty, null)
  assert.equal(got.parsed, null, '坏 JSON 不抛错')
})

test('校验阻断码：未选组合 / 预算超限 / 装不下旁白 / 缺底图 / 缺生成段槽位', () => {
  const got = run(`${CTX}${FULL_CARD}
    const card = normalizeDesignCard(raw, ctx)
    const codes = (combo, over = {}, shot = {}) => validateDesignCard({
      card: { ...card, ...over }, combo, ...shot,
    }).filter(i => i.severity === 'block').map(i => i.code)
    out({
      noCombo: codes(null),
      overLayer: codes('C', { budget: { layer_s: 31, gen_s: 5 } }),
      overGen: codes('C', { budget: { layer_s: 6, gen_s: 16 } }),
      underNarration: codes('C', { budget: { layer_s: 2, gen_s: 2 } }, { narrationText: '一七一六年，近卫团从托博尔斯克出发，溯额尔齐斯河而上。' }),
      measuredWins: codes('C', { budget: { layer_s: 2, gen_s: 2 } }, { narrationText: '一七一六年，近卫团从托博尔斯克出发，溯额尔齐斯河而上。', measuredSeconds: 3.5 }),
      noBase: codes('A', { layer_plan: { ...card.layer_plan, base: null } }),
      genSlotsB: codes('B', { gen_plan: { reference_assets: [] } }),
      genSlotsC: codes('C', { gen_plan: { reference_assets: [], first: '' } }),
      genSlotsD: codes('D', { gen_plan: { reference_assets: [], last: '' } }),
      ok: codes('C'),
    })
  `)
  assert.deepEqual(got.noCombo, ['combo_missing'])
  assert.ok(got.overLayer.includes('budget_over_layer'))
  assert.ok(got.overGen.includes('budget_over_gen'))
  assert.ok(got.underNarration.includes('budget_under_narration'), '旁白估 ≈6.0s，总时长 4.0s 装不下')
  assert.ok(!got.measuredWins.includes('budget_under_narration'), '配音实测 3.5s 时 4.0s 装得下')
  assert.ok(got.noBase.includes('missing_base'))
  assert.equal(got.genSlotsB.filter(c => c === 'gen_slot_missing').length, 2, '组合 B 首尾两槽都要描述')
  assert.equal(got.genSlotsC.filter(c => c === 'gen_slot_missing').length, 1, '组合 C 首帧由衔接帧锁定，只缺尾帧')
  assert.equal(got.genSlotsD.filter(c => c === 'gen_slot_missing').length, 1, '组合 D 尾帧由衔接帧锁定，只缺首帧')
  assert.deepEqual(got.ok, [], '完整的 C 卡没有阻断')
})

test('校验警告码：信息点无归属 / 必须标注未被计划图层锚定 / 参考素材未被 @ / 余量偏紧', () => {
  const got = run(`${CTX}${FULL_CARD}
    const card = normalizeDesignCard(raw, ctx)
    const warn = (combo, over = {}, shot = {}) => validateDesignCard({
      card: { ...card, ...over }, combo, ...shot,
    }).filter(i => i.severity === 'warn').map(i => i.code)
    out({
      // 组合 A 没有生成段，但有信息点声明 via=generated
      unassigned: warn('A', { gen_plan: undefined, budget: { layer_s: 11, gen_s: null } }),
      notPlanned: warn('C', { layer_plan: { ...card.layer_plan, planned_layers: [] } }),
      refMissing: warn('C', {}, { mentioned: [] }),
      refOk: warn('C', {}, { mentioned: [{ kind: 'character', id: 25 }] }),
      tight: warn('C', { budget: { layer_s: 2, gen_s: 2.1 } }, { narrationText: '一七一六年近卫团从托博尔斯克出发。' }),
    })
  `)
  assert.ok(got.unassigned.includes('info_point_unassigned'))
  assert.equal(got.notPlanned.filter(c => c === 'must_mark_not_planned').length, 2, '两条必须标注都没有计划图层锚定')
  assert.ok(got.refMissing.includes('reference_not_mentioned'))
  assert.ok(!got.refOk.includes('reference_not_mentioned'), '提示词里 @ 到了就不再提醒')
  assert.ok(got.tight.includes('budget_tight'))
})

test('段组合语义：哪一段存在、哪一个槽位被衔接帧锁定', () => {
  const got = run(`
    out({
      layer: ['A','B','C','D',null].map(hasLayerSegment),
      gen: ['A','B','C','D',null].map(hasGenSegment),
      locked: ['A','B','C','D',null].map(lockedGenSlot),
    })
  `)
  assert.deepEqual(got.layer, [true, false, true, true, false])
  assert.deepEqual(got.gen, [false, true, true, true, false])
  assert.deepEqual(got.locked, [null, null, 'first', 'last', null])
})

test('预算与旁白：配音前用估算，配音后用实测，budget 本身不被改写', () => {
  const got = run(`${CTX}${FULL_CARD}
    const card = normalizeDesignCard(raw, ctx)
    const before = estimateCardBudget(card, '一七一六年近卫团从托博尔斯克出发。')
    const after = estimateCardBudget(card, '一七一六年近卫团从托博尔斯克出发。', 4.1)
    out({ before, after, budget: card.budget })
  `)
  assert.equal(got.before.total_s, 11)
  assert.equal(got.before.measured, false)
  assert.ok(got.before.narration_s > 0)
  assert.equal(got.after.measured, true)
  assert.equal(got.after.narration_s, 4.1)
  assert.deepEqual(got.budget, { layer_s: 6, gen_s: 5 }, '实测值只重算问题，不回写 budget')
})

test('镜头数硬上限兼顾短稿防过拆与逐段旁白字数下限', () => {
  const got = run(`
    const script = '【开场】第一段。\\n\\n第二段。\\n\\n\\n第三段。\\n   \\n第四段。\\n\\n第五段。'
    out({
      paragraphs: scriptParagraphs(script).length,
      caps: [1, 2, 3, 4, 5, 6, 10, 20, 40].map(n => storyboardCountCap(Array(n).fill('短段。'))),
      empty: [storyboardCountCap([]), storyboardCountCap(scriptParagraphs('')), storyboardCountCap(scriptParagraphs('【开场】\\n\\n'))],
      yinxu: storyboardCountCap(scriptParagraphs(script)),
      long: storyboardCountCap(['甲'.repeat(900), '乙'.repeat(900)]),
      mixed: storyboardCountCap(['甲'.repeat(900), ...Array(4).fill('短段。')]),
      marked: storyboardCountCap(['[[重庆|chong2 qing4]][[停顿|1.5]][[语气|sigh]]'.repeat(40)]),
    })
  `)
  assert.equal(got.paragraphs, 5, '节拍标记不单独成段，空白段不计')
  // ceil(n×1.5) vs n+3：n ≤ 6 时前者小，n ≥ 7 时后者小
  assert.deepEqual(got.caps, [2, 3, 5, 6, 8, 9, 13, 23, 43])
  assert.deepEqual(got.empty, [0, 0, 0], '没有剧本就不设限')
  assert.equal(got.yinxu, 8, '殷墟 5 段剧本最多 8 镜')
  assert.equal(got.long, 24, '两段各900字，逐段ceil(900/80)后相加')
  assert.equal(got.mixed, 16, '一段900字加四短段，不得先合并总字数再ceil')
  assert.equal(got.marked, 2, '注音语法、停顿和语气不虚增朗读字数')
})

test('生成段参考素材：只有启用了生成段的镜头才要求提示词 @ 到，解析不到的条目不参与', () => {
  const got = run(`${CTX}${FULL_CARD}
    const card = normalizeDesignCard(raw, ctx)
    const broken = normalizeDesignCard({ ...raw, gen_plan: { reference_assets: [{ kind: 'character', id: 777 }] } }, ctx)
    out({
      a: referenceAssetRefs(card, 'A'),
      c: referenceAssetRefs(card, 'C'),
      none: referenceAssetRefs(card, null),
      unresolved: referenceAssetRefs(broken, 'B'),
    })
  `)
  assert.deepEqual(got.a, [], '组合 A 没有生成段')
  assert.deepEqual(got.c, [{ kind: 'character', id: 25 }])
  assert.deepEqual(got.none, [])
  assert.deepEqual(got.unresolved, [], '解析不到的参考素材不会变成一条永远修不好的阻断')
})
