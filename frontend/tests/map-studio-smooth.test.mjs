import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultLayerOptions,
  deviationProblems,
  insertVertex,
  renderCopyWithSmoothing,
  ringPoints,
  smoothKeyFor,
  smoothPoints,
  smoothingProblems,
  validateLayerOptions,
} from '../app/map-studio/utils/smooth.js'

// 固定夹具（1920×1080 画布）：两个「逐点地图」形状 —— 7 点与 14 点面，控制点均匀分布在像素空间的圆上，
// 转向角 <= 360°/7，正好是强度 1 也必须在口径内的边界情形。
const P7 = [[0.69903, 0.60945], [0.57596, 0.84488], [0.39569, 0.8206], [0.29397, 0.55491], [0.34739, 0.24787], [0.51574, 0.13069], [0.67223, 0.29161]]
const P14 = [[0.69903, 0.60945], [0.65261, 0.75213], [0.57596, 0.84488], [0.48426, 0.86931], [0.39569, 0.8206], [0.32777, 0.70839], [0.29397, 0.55491], [0.30097, 0.39055], [0.34739, 0.24787], [0.42404, 0.15512], [0.51574, 0.13069], [0.60431, 0.1794], [0.67223, 0.29161], [0.70603, 0.44509]]
// 一条开放路线：首尾端点是最容易「外推」的地方
const ROUTE = [[0.15, 0.55], [0.4, 0.42], [0.62, 0.5], [0.85, 0.36]]
// 一个短边夹在两条长边之间的五边形：强度 1 时第 3 段必然超出口径，降到 0.6 才过
const SHORT_EDGE = [[0.1, 0.45], [0.55, 0.4], [0.9, 0.46], [0.9, 0.53], [0.5, 0.62]]
const CANVAS = { width: 1920, height: 1080 }

/** 输出按控制点顺序逐个出现（值完全相等，不做四舍五入） */
function passesThroughEveryControlPoint(points, control) {
  let cursor = 0
  for (const expected of control) {
    while (cursor < points.length && (points[cursor][0] !== expected[0] || points[cursor][1] !== expected[1])) cursor++
    if (cursor === points.length) return false
    cursor++
  }
  return true
}

const layer = (id, type, points, extra = {}) => ({ id, type, name: id, visible: true, locked: false, z: 0, opacity: 1, rotation: 0, points, style: {}, ...extra })
const DOC = {
  version: 1,
  base: { path: 'static/base.png', width: 1920, height: 1080 },
  theme: 'archival',
  layers: [
    layer('L-region', 'polygon', SHORT_EDGE, { anchor: { semantic_id: 'm-ural' } }),
    layer('L-route', 'polyline', ROUTE, { anchor: { semantic_id: 'r-volga' } }),
    layer('L-frame', 'polygon', [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]]),
    { id: 'L-pin', type: 'marker', name: 'pin', visible: true, locked: false, z: 3, opacity: 1, rotation: 0, at: [0.5, 0.5], text: '点', style: {} },
  ],
}
const FEATURES = [{ id: 'm-ural', origin: 'dataset' }, { id: 'r-volga', origin: 'model' }]

test('7 与 14 顶点面平滑后经过全部控制点、闭合、偏离在口径内', () => {
  for (const [name, control] of [['7', P7], ['14', P14]]) {
    const points = smoothPoints(control, { closed: true, strength: 1, ...CANVAS })
    assert.ok(points.length > control.length, `${name} 点面必须被细分`)
    assert.ok(passesThroughEveryControlPoint(points, control), `${name} 点面必须经过全部控制点`)
    assert.deepEqual(points[0], control[0], `${name} 点面从首点开始`)
    assert.deepEqual(points[points.length - 1], control[0], `${name} 点面末端精确闭合到首个控制点`)
    assert.deepEqual(deviationProblems(control, { closed: true, strength: 1, ...CANVAS }), [], `${name} 点面偏离在口径内`)
  }
})

test('强度 0 关闭平滑：点原样返回，而且返回的是拷贝', () => {
  const off = smoothPoints(P7, { closed: true, strength: 0, ...CANVAS })
  assert.deepEqual(off, P7)
  assert.notEqual(off, P7)
  assert.notEqual(off[0], P7[0])
  // 非法显式强度必须拒绝，不能悄悄关闭或钳制。
  for (const strength of [Number.NaN, -0.1, 1.1]) assert.throws(() => smoothPoints(P7, { closed: true, strength, ...CANVAS }), /smooth/)
})

test('开放折线首尾不外推，整条曲线不跑出控制点包围盒', () => {
  const curve = smoothPoints(ROUTE, { closed: false, strength: 1, ...CANVAS })
  assert.deepEqual(curve[0], ROUTE[0], '首点必须就是原控制点')
  assert.deepEqual(curve[curve.length - 1], ROUTE[ROUTE.length - 1], '末点必须就是原控制点')
  const xs = ROUTE.map(point => point[0])
  const ys = ROUTE.map(point => point[1])
  for (const [x, y] of curve) {
    assert.ok(x >= Math.min(...xs) - 1e-12 && x <= Math.max(...xs) + 1e-12, `x=${x} 跑出包围盒`)
    assert.ok(y >= Math.min(...ys) - 1e-12 && y <= Math.max(...ys) + 1e-12, `y=${y} 跑出包围盒`)
  }
  assert.deepEqual(deviationProblems(ROUTE, { closed: false, strength: 1, ...CANVAS }), [])
})

test('缺省强度：数据集要素关、无要素锚定的装饰线面关、锚定到逐点要素的线面开', () => {
  const defaults = defaultLayerOptions(DOC, FEATURES)
  assert.deepEqual(defaults, { 'L-region': { smooth: 0 }, 'L-route': { smooth: 1 }, 'L-frame': { smooth: 0 } })
  assert.equal('L-pin' in defaults, false, '点标记没有可平滑的点')
})

test('渲染副本：只改显式开启的线面、不改传入文档、数据集的点保持同一引用', () => {
  const snapshot = JSON.stringify(DOC)
  const rendered = renderCopyWithSmoothing(DOC, defaultLayerOptions(DOC, FEATURES))
  assert.equal(JSON.stringify(DOC), snapshot)
  assert.equal(rendered.layers[0], DOC.layers[0], '数据集要素缺省 0，图层对象保持同一引用')
  assert.equal(rendered.layers[2], DOC.layers[2], '装饰画框缺省 0')
  assert.equal(rendered.layers[3], DOC.layers[3], '点标记原样')
  assert.notEqual(rendered.layers[1], DOC.layers[1], '路线被换成平滑副本')
  assert.ok(rendered.layers[1].points.length > DOC.layers[1].points.length)
  assert.equal(rendered.layers[1].points[0][0], DOC.layers[1].points[0][0], '渲染点不改归一化口径')
})

test('显式打开的数据集要素仍然平滑：显式选择优先于缺省', () => {
  const rendered = renderCopyWithSmoothing(DOC, { 'L-region': { smooth: 1 } })
  assert.ok(rendered.layers[0].points.length > DOC.layers[0].points.length)
  assert.ok(passesThroughEveryControlPoint(rendered.layers[0].points, SHORT_EDGE))
})

test('偏离超限：给出段号、上限与可行强度；降到该强度就通过', () => {
  const problems = deviationProblems(SHORT_EDGE, { closed: true, strength: 1, ...CANVAS })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].segment, 3)
  assert.ok(problems[0].deviation > problems[0].limit)
  assert.ok(problems[0].suggested > 0 && problems[0].suggested < 1)
  assert.deepEqual(deviationProblems(SHORT_EDGE, { closed: true, strength: problems[0].suggested, ...CANVAS }), [])
})

test('smoothingProblems 只检查显式开启的线面图层，路径与机器码稳定', () => {
  assert.deepEqual(smoothingProblems(DOC, defaultLayerOptions(DOC, FEATURES)), [])
  const problems = smoothingProblems(DOC, { 'L-region': { smooth: 1 } })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, 'layer_options.L-region.smooth')
  assert.equal(problems[0].code, 'smoothing_deviation')
  assert.equal(problems[0].layer_id, 'L-region')
  assert.match(problems[0].message, /第 3 段/)
  assert.match(problems[0].message, /代码不会自动改强度/)
  assert.deepEqual(smoothingProblems(DOC, { 'L-pin': { smooth: 1 } }), [], '点标记被忽略，不会被假装平滑')
})

test('layer_options 严格校验：不钳制、不补默认、不多收字段', () => {
  assert.deepEqual(validateLayerOptions({ L: { smooth: 0.4 } }), { options: { L: { smooth: 0.4 } }, problems: [] })
  assert.deepEqual(validateLayerOptions(undefined), { options: {}, problems: [] })
  for (const raw of [
    null,
    new Date(),
    JSON.parse('{"__proto__":{"smooth":1}}'),
    { L: { smooth: 1.5 } },
    { L: { smooth: -0.1 } },
    { L: { smooth: '0.5' } },
    { L: { smooth: Number.NaN } },
    { L: {} },
    { L: { smooth: 0.5, extra: 1 } },
    { L: 0.5 },
    { L: [0.5] },
    { ' L': { smooth: 1 } },
    { ['x'.repeat(65)]: { smooth: 1 } },
  ]) {
    const parsed = validateLayerOptions(raw)
    assert.ok(parsed.problems.length > 0, `必须拒收 ${JSON.stringify(raw)}`)
    assert.equal(parsed.problems[0].code, 'smoothing_invalid')
    assert.deepEqual(parsed.options, {}, '被拒的键不能留在结果里（更不钳制）')
  }
  assert.ok(validateLayerOptions('nope').problems.length > 0)
  const withDoc = validateLayerOptions({ 'L-pin': { smooth: 1 } }, DOC)
  assert.equal(withDoc.problems.length, 1)
  assert.match(withDoc.problems[0].message, /只有 polygon\/polyline/)
  assert.deepEqual(validateLayerOptions({ 'm-ural': { smooth: 0 } }, DOC), { options: { 'L-region': { smooth: 0 } }, problems: [] })
  assert.ok(validateLayerOptions({ unknown: { smooth: 1 } }, DOC).problems.length > 0)
  assert.ok(validateLayerOptions({ 'L-region': { smooth: 1 }, 'm-ural': { smooth: 0 } }, DOC).problems.length > 0)
  const labelsFirst = { ...DOC, layers: [
    { ...DOC.layers[3], id: 'lake-label', anchor: { semantic_id: 'm-ural' } },
    ...DOC.layers,
  ] }
  assert.deepEqual(validateLayerOptions({ 'm-ural': { smooth: 0.4 } }, labelsFirst), { options: { 'L-region': { smooth: 0.4 } }, problems: [] })
})

test('中点插入：控制点数 +1、原点一个不动、闭合环重复的收尾点仍留在最后', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 0]]
  const snapshot = JSON.stringify(ring)
  const inserted = insertVertex(ring, 2, [0.5, 1], true)
  assert.equal(inserted.length, ring.length + 1)
  assert.deepEqual(inserted, [[0, 0], [1, 0], [1, 1], [0.5, 1], [0, 0]])
  assert.equal(JSON.stringify(ring), snapshot, '原控制点数组不被改动')
  assert.deepEqual(ringPoints(inserted, true), [[0, 0], [1, 0], [1, 1], [0.5, 1]])

  const open = [[0, 0], [1, 0], [2, 1]]
  assert.deepEqual(insertVertex(open, 0, [0.5, 0], false), [[0, 0], [0.5, 0], [1, 0], [2, 1]])
  assert.deepEqual(insertVertex(open, 1, [1.5, 0.5], false), [[0, 0], [1, 0], [1.5, 0.5], [2, 1]])
  assert.throws(() => insertVertex(open, 2, [0, 0], false), /段序号/)
  assert.throws(() => insertVertex(open, -1, [0, 0], false), /段序号/)
})

test('平滑键：有落地锚定图层时用图层 id，还没画出来时用要素 id 暂存', () => {
  assert.equal(smoothKeyFor(DOC, 'm-ural'), 'L-region')
  assert.equal(smoothKeyFor(DOC, 'r-volga'), 'L-route')
  assert.equal(smoothKeyFor(DOC, 'not-drawn-yet'), 'not-drawn-yet')
  assert.equal(smoothKeyFor(null, 'feature-1'), 'feature-1')
})
