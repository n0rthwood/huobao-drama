/**
 * Issue #110 的纯函数契约：画中画元数据读路径、细节语义投影、image 层校验、预算自动补时。
 * 与既有测试同风格：用仓库自带 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { projectDetailSemantics } from './src/modules/map-studio/pip/semantics.ts'
    import { pipSummary, pipAssetLine } from './src/services/map-pip-assets.ts'
    import {
      fitBudgetToNarration, normalizeDesignCard, validateDesignCard, aiAssetRuleRejections, estimateCardBudget,
    } from './src/services/design-card.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

const SPEC = `
  const spec = {
    version: 1,
    projection: { type: 'mercator' },
    bbox: [20, 40, 80, 60],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: false },
    places: [{ id: 'pt-1', name: '甲城', lon: 50, lat: 50 }, { id: 'pt-2', name: '远处的乙城', lon: 78, lat: 44 }],
    routes: [{ id: 'ln-1', name: '大河', points: [[30, 50], [70, 50]] }],
    regions: [{ id: 'rg-1', name: '河谷', points: [[35, 42], [65, 42], [65, 48], [35, 48]] }],
    style: { theme: 'archival' },
  }
`

test('细节语义投影：id 与全览一致、落在细节取景内、画外的要素被裁掉', () => {
  const got = run(`${SPEC}
    const geometry = projectDetailSemantics(spec, [40, 48, 60, 52], { width: 1920, height: 1080 }, ['pt-1', 'pt-2', 'ln-1', 'rg-1'])
    out({
      ids: [...geometry.points, ...geometry.lines, ...geometry.regions].map(item => item.id).sort(),
      size: [geometry.width, geometry.height],
      points: geometry.points,
      line: geometry.lines[0],
      region: geometry.regions[0],
      // 不在 ids 里的要素不投影
      filtered: projectDetailSemantics(spec, [40, 48, 60, 52], { width: 1920, height: 1080 }, ['pt-2']),
    })
  `)
  assert.deepEqual(got.ids, ['ln-1', 'pt-1', 'rg-1'], '画外的 pt-2 被裁掉；线面按取景裁剪后仍保留同一 id')
  assert.deepEqual(got.size, [1920, 1080])
  assert.equal(got.points.length, 1)
  assert.equal(got.points[0].name, '甲城')
  const [x, y] = got.points[0].at
  assert.ok(x >= 0 && x <= 1920 && y >= 0 && y <= 1080, '点落在细节图像素内')
  for (const segment of got.line.points) {
    assert.ok(segment[0] >= 0 && segment[0] <= 1920 && segment[1] >= 0 && segment[1] <= 1080, '折线被裁进画内')
  }
  assert.ok(got.region.points.length >= 3)
  assert.deepEqual(got.filtered.points.concat(got.filtered.lines, got.filtered.regions), [], 'ids 之外的要素一律不投影')
})

const PIP = `
  const overview = { role: 'overview', version: 1, layout: { id: 'L2b-A' },
    overview_bbox: [20, 42, 85, 64],
    frames: [{ no: 1, label: '乌格拉河', role: 'primary', bbox: [30.79, 53, 43.2, 57], focus_bbox: [33, 54, 40, 56], storyboard_numbers: [11, 12], detail_prop_id: 286 }],
    composite_path: null, usage: '全览建立位置。\\n分镜 #11、#12 用这张细节图。\\n聚焦某细节时相邻镜头用全览。' }
  const detail = { role: 'detail', version: 1, parent_prop_id: 258, parent_name: '蒙古汗国地图',
    frame: { no: 1, label: '乌格拉河', role: 'primary', bbox: [30.79, 53, 43.2, 57], focus_bbox: [33, 54, 40, 56], storyboard_numbers: [11] },
    overview_bbox: [20, 42, 85, 64], usage: '全览建立位置。\\n对应分镜 #11 的取景。' }
`

test('画中画读路径：给 label + bbox/focus_bbox + 全览范围，剔除 storyboard_numbers 与按镜号写的 usage', () => {
  const got = run(`${PIP}
    out({ overview: pipSummary(JSON.stringify(overview)), detail: pipSummary(JSON.stringify(detail)),
      lines: [pipAssetLine(JSON.stringify(overview)), pipAssetLine(JSON.stringify(detail))] })
  `)
  assert.equal(got.overview.role, 'overview')
  assert.deepEqual(got.overview.overview_bbox, [20, 42, 85, 64])
  assert.deepEqual(got.overview.details[0].bbox, [30.79, 53, 43.2, 57])
  assert.deepEqual(got.overview.details[0].focus_bbox, [33, 54, 40, 56])
  assert.equal(got.overview.details[0].asset_id, 286)
  assert.equal(got.overview.usage.includes('分镜 #'), false, '按镜号写的 usage 行被剔除')
  assert.ok(got.overview.usage.includes('全览建立位置'))
  assert.equal('storyboard_numbers' in got.overview.details[0], false, '细节不再暴露 storyboard_numbers')
  assert.equal(got.detail.role, 'detail')
  assert.equal(got.detail.label, '乌格拉河')
  assert.deepEqual(got.detail.bbox, [30.79, 53, 43.2, 57])
  assert.deepEqual(got.detail.overview_bbox, [20, 42, 85, 64])
  assert.equal('storyboard_numbers' in got.detail, false)
  assert.ok(got.lines[0].includes('全览范围'), '组规划资产清单带全览范围')
  assert.ok(got.lines[0].includes('prop#286'))
  assert.ok(got.lines[1].includes('乌格拉河'))
})

const ASSETS = `
  const assets = [
    { kind: 'prop', id: 258, name: '全览地图', is_map: true, faithful: true, image: 'static/map.png' },
    { kind: 'prop', id: 286, name: '乌格拉河细节', is_map: true, faithful: true, image: 'static/detail.png' },
    { kind: 'prop', id: 300, name: '无图档案', faithful: true, image: null },
    { kind: 'character', id: 25, name: '利哈列夫', image: 'static/char.png' },
  ]
`

test('image 层契约：缺 anchor / 锚到本集没有的资产 / 无图 / 等于底图都阻断 pip_invalid', () => {
  const got = run(`${ASSETS}
    const card = normalizeDesignCard({ budget: { layer_s: 8, gen_s: 5 }, layer_plan: {
      base: { kind: 'asset', asset_kind: 'prop', asset_id: 286 },
      planned_layers: [
        { type: 'image', at_s: 1 },
        { type: 'image', anchor: { asset_id: 300 }, at_s: 2 },
        { type: 'image', anchor: { asset_id: 999 }, at_s: 3 },
        { type: 'image', anchor: { asset_id: 286 }, at_s: 5 },
      ],
    }, gen_plan: { reference_assets: [], first: '', last: 'x' } }, { assets })
    const codes = validateDesignCard({ card, combo: 'C', narrationText: 'x', measuredSeconds: 8, assets }).filter(i => i.code === 'pip_invalid')
    out({
      anchors: card.layer_plan.planned_layers.map(layer => layer.anchor ? layer.anchor.asset_id : null),
      count: codes.length,
      indices: codes.map(i => i.index),
      messages: codes.map(i => i.message),
      rejected: aiAssetRuleRejections(card, 'C', assets).map(i => i.code),
    })
  `)
  assert.deepEqual(got.anchors, [null, 300, 999, 286])
  assert.equal(got.count, 4, '四种不合格写法各报一条')
  assert.deepEqual(got.indices, [0, 1, 2, 3])
  assert.match(got.messages[0], /没有 anchor\.asset_id/)
  assert.match(got.messages[1], /没有可用的图片/)
  assert.match(got.messages[2], /不是本集资产/)
  assert.match(got.messages[3], /就是本镜图层段的底图/)
  assert.deepEqual(got.rejected, ['pip_invalid', 'pip_invalid', 'pip_invalid', 'pip_invalid'])
})

test('合法的画中画（本集另一张有图的资产）不报 pip_invalid', () => {
  const got = run(`${ASSETS}
    const card = normalizeDesignCard({ layer_plan: {
      base: { kind: 'asset', asset_kind: 'prop', asset_id: 258 },
      planned_layers: [{ type: 'image', anchor: { asset_id: 286, semantic_id: 'rg-3' }, at_s: 1 }],
    }, budget: { layer_s: 6, gen_s: 5 }, gen_plan: { reference_assets: [] } }, { assets })
    const layer = card.layer_plan.planned_layers[0]
    out({ codes: validateDesignCard({ card, combo: 'C', measuredSeconds: 6, assets }).map(i => i.code),
      anchor: layer.anchor })
  `)
  assert.ok(!got.codes.includes('pip_invalid'))
  assert.equal(got.anchor.semantic_id, '', 'image 层锚点只留资产 id，语义条目被清掉')
})

test('忠实素材与地图不能进扩散生成：卡片阻断 faithful_in_diffusion，AI 写入拒收', () => {
  const got = run(`${ASSETS}
    const card = normalizeDesignCard({ budget: { layer_s: null, gen_s: 5 },
      gen_plan: { reference_assets: [{ kind: 'prop', id: 258 }, { kind: 'character', id: 25 }], first: '', last: 'x' } }, { assets })
    const issues = validateDesignCard({ card, combo: 'B', narrationText: 'x', measuredSeconds: 4, assets })
    out({
      codes: issues.map(i => i.code),
      message: issues.find(i => i.code === 'faithful_in_diffusion')?.message,
      rejected: aiAssetRuleRejections(card, 'B', assets).map(i => i.code),
    })
  `)
  assert.ok(got.codes.includes('faithful_in_diffusion'))
  assert.match(got.message, /忠实素材\/地图不能进扩散生成，改用图层段承载/)
  assert.deepEqual(got.rejected, ['faithful_in_diffusion'], '只拒忠实参考这一条，角色参考不拦')
})

test('预算自动补时：C/D 差额补进图层段（向上取整 0.5 秒、只加不减），B 补到 min(15, 实测+0.5)', () => {
  const got = run(`
    const c = fitBudgetToNarration({ layer_s: 8, gen_s: 6 }, 'C', 14)
    const already = fitBudgetToNarration({ layer_s: 8, gen_s: 6 }, 'C', 10)
    const b = fitBudgetToNarration({ layer_s: null, gen_s: 5 }, 'B', 9.1)
    const bOver = fitBudgetToNarration({ layer_s: null, gen_s: 5 }, 'B', 20)
    const noMeasure = fitBudgetToNarration({ layer_s: 2, gen_s: 2 }, 'C', null)
    out({ c, already, b, bOver, noMeasure,
      budget: estimateCardBudget({ budget: { layer_s: c.budget.layer_s, gen_s: c.budget.gen_s } }, 'x', 14) })
  `)
  assert.deepEqual(got.c.budget, { layer_s: 8.5, gen_s: 6 }, '14.5 − 6 = 8.5，向上取整到 0.5 秒')
  assert.equal(got.c.adjusted.from.layer_s, 8)
  assert.match(got.c.adjusted.reason, /图层段 8s → 8\.5s/)
  assert.equal(got.already.adjusted, null, '装得下就不改')
  assert.deepEqual(got.b.budget, { layer_s: null, gen_s: 10 }, '实测 9.1 + 0.5 = 9.6，向上取整到 10 秒')
  assert.deepEqual(got.bOver.budget, { layer_s: null, gen_s: 15 }, 'B 最多补到 15 秒，剩下的装不下仍阻断')
  assert.equal(got.noMeasure.adjusted, null, '没有实测秒数不改预算')
  assert.equal(got.budget.remain_s, 0.5, '补到实测 +0.5 秒余量，不再报偏紧')
})
