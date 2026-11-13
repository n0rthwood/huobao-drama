/** 渲染期平滑的真实行为 + 后端/前端同源对照（Issue #99 阶段③ §1）。 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backend = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-smoothing-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const script = `
import assert from 'node:assert/strict'
import * as ts from './src/modules/map-studio/render/smooth.ts'
import * as js from '../frontend/app/map-studio/utils/smooth.js'

// 1920×1080 画布上的固定夹具：7 点与 14 点面（像素空间均匀分布，强度 1 也必须在口径内）。
const P7 = [[0.69903,0.60945],[0.57596,0.84488],[0.39569,0.8206],[0.29397,0.55491],[0.34739,0.24787],[0.51574,0.13069],[0.67223,0.29161]]
const P14 = [[0.69903,0.60945],[0.65261,0.75213],[0.57596,0.84488],[0.48426,0.86931],[0.39569,0.8206],[0.32777,0.70839],[0.29397,0.55491],[0.30097,0.39055],[0.34739,0.24787],[0.42404,0.15512],[0.51574,0.13069],[0.60431,0.1794],[0.67223,0.29161],[0.70603,0.44509]]
const ROUTE = [[0.15,0.55],[0.4,0.42],[0.62,0.5],[0.85,0.36]]
// 短边夹在两条长边之间：强度 1 时第 3 段必然超出口径
const SHORT_EDGE = [[0.1,0.45],[0.55,0.4],[0.9,0.46],[0.9,0.53],[0.5,0.62]]
const CANVAS = { width: 1920, height: 1080 }
const out = {}

const ordered = (points, control) => {
  let cursor = 0
  for (const expected of control) {
    while (cursor < points.length && (points[cursor][0] !== expected[0] || points[cursor][1] !== expected[1])) cursor++
    if (cursor === points.length) return false
    cursor++
  }
  return true
}

// 1. 7 / 14 顶点面：经过全部控制点、精确闭合、偏离在口径内
for (const [name, control] of [['p7', P7], ['p14', P14]]) {
  const points = ts.smoothPoints(control, { closed: true, strength: 1, ...CANVAS })
  assert.ok(points.length > control.length, name + ' 需要细分')
  assert.ok(ordered(points, control), name + ' 必须经过全部控制点')
  assert.deepEqual(points[0], control[0], name + ' 从首点开始')
  assert.deepEqual(points[points.length - 1], control[0], name + ' 闭合环末端回到首个控制点')
  assert.deepEqual(ts.deviationProblems(control, { closed: true, strength: 1, ...CANVAS }), [], name + ' 偏离必须在上限内')
  out[name] = points.length
}

// 2. 关闭：点原样返回且是拷贝
const off = ts.smoothPoints(P7, { closed: true, strength: 0, ...CANVAS })
assert.deepEqual(off, P7)
assert.notEqual(off, P7)
assert.notEqual(off[0], P7[0])

// 3. 开放折线：首尾端点不外推，整条曲线留在控制点包围盒内
const routeCurve = ts.smoothPoints(ROUTE, { closed: false, strength: 1, ...CANVAS })
assert.deepEqual(routeCurve[0], ROUTE[0])
assert.deepEqual(routeCurve[routeCurve.length - 1], ROUTE[ROUTE.length - 1])
const xs = ROUTE.map(point => point[0])
const ys = ROUTE.map(point => point[1])
for (const point of routeCurve) {
  assert.ok(point[0] >= Math.min(...xs) - 1e-12 && point[0] <= Math.max(...xs) + 1e-12)
  assert.ok(point[1] >= Math.min(...ys) - 1e-12 && point[1] <= Math.max(...ys) + 1e-12)
}

// 4. 细分密度随输出像素长度走，不跟点索引走
const wide = ts.smoothPoints(P14, { closed: true, strength: 1, width: 1920, height: 1080 })
const small = ts.smoothPoints(P14, { closed: true, strength: 1, width: 480, height: 270 })
assert.ok(wide.length > small.length, '同一份归一化几何，大画布要更多采样')
out.density = [wide.length, small.length]

// 5. 越过 normalizeLayerDoc 的 240 点上限也不会被截断（渲染副本只防极端分配）
const dense = Array.from({ length: 6000 }, (_, i) => [0.5 + 400 * Math.cos(2 * Math.PI * i / 6000) / 1920, 0.5 + 400 * Math.sin(2 * Math.PI * i / 6000) / 1080])
const denseCurve = ts.smoothPoints(dense, { closed: true, strength: 1, ...CANVAS })
assert.ok(denseCurve.length >= dense.length, '控制点一个都不能丢')
assert.ok(denseCurve.length <= 20000, '极端输入也不产生无意义海量点')
assert.ok(ordered(denseCurve, dense), '6000 个控制点全部按序保留')
out.dense = denseCurve.length

const sine = Array.from({ length: 300 }, (_, i) => [0.2 + 0.6 * i / 300, 0.4 + 0.1 * Math.sin(i / 300 * Math.PI * 2)])
const sineCurve = ts.smoothPoints(sine, { closed: false, strength: 1, ...CANVAS })
assert.ok(sineCurve.length > 240, '300 点图层不平滑也会超过 240，但渲染副本不截断')
assert.ok(ordered(sineCurve, sine))

// 6. 图层文档：缺省强度、显式优先、渲染副本不改存储
const layer = (id, type, points, extra = {}) => ({ id, type, name: id, visible: true, locked: false, z: 0, opacity: 1, rotation: 0, points, style: {}, ...extra })
const doc = {
  version: 1,
  base: { path: 'static/base.png', width: 1920, height: 1080 },
  theme: 'archival',
  layers: [
    layer('L-region', 'polygon', SHORT_EDGE, { anchor: { semantic_id: 'm-ural' } }),
    layer('L-route', 'polyline', ROUTE, { anchor: { semantic_id: 'r-volga' } }),
    layer('L-frame', 'polygon', [[0.05,0.05],[0.95,0.05],[0.95,0.95],[0.05,0.95]]),
    { id: 'L-pin', type: 'marker', name: 'pin', visible: true, locked: false, z: 3, opacity: 1, rotation: 0, at: [0.5,0.5], text: '点', style: {} },
  ],
}
const features = [{ id: 'm-ural', origin: 'dataset' }, { id: 'r-volga', origin: 'model' }]
const defaults = ts.defaultLayerOptions(doc, features)
assert.deepEqual(defaults, { 'L-region': { smooth: 0 }, 'L-route': { smooth: 1 }, 'L-frame': { smooth: 0 } })
assert.equal('L-pin' in defaults, false)

const snapshot = JSON.stringify(doc)
const rendered = ts.renderCopyWithSmoothing(doc, defaults)
assert.equal(JSON.stringify(doc), snapshot, '渲染副本不得改动传入文档')
assert.equal(rendered.layers[0], doc.layers[0], '数据集缺省 0：图层对象保持同一引用')
assert.equal(rendered.layers[2], doc.layers[2], '装饰画框缺省 0')
assert.equal(rendered.layers[3], doc.layers[3], '点标记原样')
assert.ok(rendered.layers[1].points.length > doc.layers[1].points.length)
const explicit = ts.renderCopyWithSmoothing(doc, { 'L-region': { smooth: 1 } })
assert.ok(explicit.layers[0].points.length > doc.layers[0].points.length, '显式打开的数据集要素仍然平滑')

// 7. 偏离拒收：机器码、路径、段号、上限与可行强度；按建议降强度即通过
const problems = ts.smoothingProblems(doc, { 'L-region': { smooth: 1 }, 'L-route': { smooth: 1 } })
assert.equal(problems.length, 1)
assert.equal(problems[0].code, 'smoothing_deviation')
assert.equal(problems[0].path, 'layer_options.L-region.smooth')
assert.equal(problems[0].layer_id, 'L-region')
assert.match(problems[0].message, /第 3 段/)
assert.match(problems[0].message, /上限 [0-9.]+px/)
assert.match(problems[0].message, /代码不会自动改强度/)
const suggested = ts.deviationProblems(SHORT_EDGE, { closed: true, strength: 1, ...CANVAS })[0].suggested
assert.ok(suggested > 0 && suggested < 1, '必须给出可用的强度而不是自动改')
assert.equal(problems[0].message.includes(String(suggested)), true, '消息里带上可行强度')
assert.deepEqual(ts.smoothingProblems(doc, { 'L-region': { smooth: suggested }, 'L-route': { smooth: 1 } }), [])
assert.deepEqual(ts.smoothingProblems(doc, defaults), [], '缺省配置不应有偏离问题')

// 8. layer_options 严格校验：不钳制、不补默认、不多收字段
assert.deepEqual(ts.validateLayerOptions({ L: { smooth: 0.4 } }), { options: { L: { smooth: 0.4 } }, problems: [] })
assert.deepEqual(ts.validateLayerOptions(undefined), { options: {}, problems: [] })
for (const raw of [
  { L: { smooth: 1.5 } }, { L: { smooth: -0.1 } }, { L: { smooth: '0.5' } }, { L: { smooth: Number.NaN } },
  { L: {} }, { L: { smooth: 0.5, extra: 1 } }, { L: 0.5 }, { L: [0.5] }, { ' L': { smooth: 1 } }, { ['x'.repeat(65)]: { smooth: 1 } },
]) {
  const parsed = ts.validateLayerOptions(raw)
  assert.ok(parsed.problems.length > 0, '必须拒收 ' + JSON.stringify(raw))
  assert.equal(parsed.problems[0].code, 'smoothing_invalid')
  assert.deepEqual(parsed.options, {})
}
assert.equal(ts.validateLayerOptions('nope').problems.length > 0, true)
const markerKey = ts.validateLayerOptions({ 'L-pin': { smooth: 1 } }, doc)
assert.equal(markerKey.problems.length, 1)
assert.match(markerKey.problems[0].message, /只有 polygon\\/polyline/)
assert.deepEqual(ts.validateLayerOptions({ 'm-ural': { smooth: 0 } }, doc), { options: { 'L-region': { smooth: 0 } }, problems: [] })
assert.ok(ts.validateLayerOptions({ unknown: { smooth: 1 } }, doc).problems.length > 0)
assert.ok(ts.validateLayerOptions({ 'L-region': { smooth: 1 }, 'm-ural': { smooth: 0 } }, doc).problems.length > 0)
const labelsFirst = { ...doc, layers: [{ ...doc.layers[3], id: 'lake-label', anchor: { semantic_id: 'm-ural' } }, ...doc.layers] }
assert.deepEqual(ts.validateLayerOptions({ 'm-ural': { smooth: 0.4 } }, labelsFirst), { options: { 'L-region': { smooth: 0.4 } }, problems: [] })
for (const raw of [null, new Date(), JSON.parse('{"__proto__":{"smooth":1}}')]) {
  const parsed = ts.validateLayerOptions(raw)
  assert.ok(parsed.problems.length > 0)
  assert.deepEqual(js.validateLayerOptions(raw), parsed)
}
assert.deepEqual(js.validateLayerOptions({ 'm-ural': { smooth: 0.4 } }, labelsFirst), ts.validateLayerOptions({ 'm-ural': { smooth: 0.4 } }, labelsFirst))

// 9. 前后端同源：逐函数对照（浮点结果要求逐字节一致）
for (const control of [P7, P14, ROUTE, SHORT_EDGE, sine]) {
  for (const closed of [true, false]) {
    for (const strength of [0, 0.35, 1]) {
      const options = { closed, strength, width: 1920, height: 1080 }
      assert.equal(JSON.stringify(js.smoothPoints(control, options)), JSON.stringify(ts.smoothPoints(control, options)), 'smoothPoints 对照')
      assert.equal(JSON.stringify(js.deviationProblems(control, options)), JSON.stringify(ts.deviationProblems(control, options)), 'deviationProblems 对照')
      assert.equal(JSON.stringify(js.ringPoints(control, closed)), JSON.stringify(ts.ringPoints(control, closed)), 'ringPoints 对照')
    }
  }
}
assert.equal(JSON.stringify(js.smoothPoints(dense, { closed: true, strength: 1, ...CANVAS })), JSON.stringify(denseCurve), '密集几何对照')
assert.deepEqual(js.defaultLayerOptions(doc, features), ts.defaultLayerOptions(doc, features))
const options = { 'L-region': { smooth: 1 }, 'L-route': { smooth: 0.5 } }
assert.equal(JSON.stringify(js.renderCopyWithSmoothing(doc, options)), JSON.stringify(ts.renderCopyWithSmoothing(doc, options)), 'renderCopyWithSmoothing 对照')
assert.deepEqual(js.smoothingProblems(doc, options), ts.smoothingProblems(doc, options), 'smoothingProblems 对照')
const raw = { 'L-region': { smooth: 0.5 }, 'L-pin': { smooth: 1 }, bad: { smooth: 2 }, weird: { smooth: 'x' } }
assert.deepEqual(js.validateLayerOptions(raw, doc), ts.validateLayerOptions(raw, doc), 'validateLayerOptions 对照')
assert.deepEqual(js.SMOOTHING_LIMITS, ts.SMOOTHING_LIMITS)
out.parity = true
console.log(JSON.stringify(out))
`

const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backend, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
})
const result = JSON.parse(stdout.trim().split('\n').at(-1))

test('7 与 14 顶点面经过全部控制点、闭合、偏离在口径内', () => {
  assert.ok(result.p7 > 7)
  assert.ok(result.p14 > 14)
})

test('细分密度随输出像素长度自适应，密集几何不截断且不无限膨胀', () => {
  assert.ok(result.density[0] > result.density[1])
  assert.ok(result.dense >= 6000)
  assert.ok(result.dense <= 20000)
})

test('缺省强度、偏离拒收、严格校验与前后端同源都通过', () => {
  assert.equal(result.parity, true)
})
