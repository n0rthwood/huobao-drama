import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { nextTick } from 'vue'
import { normalizeMapLayerDoc } from '../app/map-studio/utils/mapLayerDoc.js'
import { renderCopyWithSmoothing } from '../app/map-studio/utils/smooth.js'
import {
  mapControlPointsThroughCanvas,
  optionKeyForLayer,
  remapCanvasPatch,
  smoothingOf,
} from '../app/map-studio/utils/mapSmoothEdit.js'

// Issue #99 阶段 ③ 前端行为：平滑/标签编辑与密集数据集几何。
// api.ts 转译口径与 frontend/tests/map-studio-api.test.mjs 一致（只替换部署前缀依赖）。
const source = readFileSync(new URL('../app/map-studio/api.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(
  source.replace("import { apiBase } from '~/utils/url'", "const apiBase = () => '/huobao/api/v1'"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText
const { mapStudioAPI, mapLayerDocProblemsOf, mapLayerProblemLayerId } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
)

// Same runtime alias resolution as layer-editor-behavior: execute the real load composable, not a replica.
const app = new URL('../app/', import.meta.url)
function runtimeModule(path, aliases = {}) {
  let source = readFileSync(new URL(path, app), 'utf8')
  for (const [name, url] of Object.entries({
    vue: import.meta.resolve('vue'),
    '~/utils/layerSvg': new URL('utils/layerSvg.js', app).href,
    '~/utils/layerText': new URL('utils/layerText.js', app).href,
    ...aliases,
  })) source = source.replaceAll(`from '${name}'`, `from '${url}'`)
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}
const glyphRuntime = runtimeModule('composables/useMissingGlyphs.ts')
const { useLayerDoc } = await import(runtimeModule('composables/useLayerDoc.ts', { '~/composables/useMissingGlyphs': glyphRuntime }))

async function capture(run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined })
    return Response.json({ code: 200, data: {} })
  }
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
  return calls
}

test('几何区把 layer_options 与 map_spec 放进同一次 CAS 保存', async () => {
  const calls = await capture(() => mapStudioAPI.save(7, {
    expected_revision: 12,
    map_spec: { version: 1, places: [], routes: [], regions: [] },
    layer_options: { 'chelik': { smooth: 0.6 } },
  }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/huobao/api/v1/map-studio/tasks/7')
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(calls[0].body.expected_revision, 12)
  assert.deepEqual(calls[0].body.layer_options, { 'chelik': { smooth: 0.6 } })
  assert.equal(calls[0].body.map_spec.version, 1)
})

test('layer-doc 保存只在给值时发送 layer_options，绝不注入默认值', async () => {
  const without = await capture(() => mapStudioAPI.saveLayerDoc(7, { version: 1, layers: [] }, 3))
  assert.equal(without[0].url, '/huobao/api/v1/map-studio/tasks/7/layer-doc')
  assert.equal(without[0].init.method, 'PUT')
  assert.equal(without[0].body.expected_revision, 3)
  assert.equal('layer_options' in without[0].body, false)

  const withOptions = await capture(() => mapStudioAPI.saveLayerDoc(7, { version: 1, layers: [] }, 3, { L1: { smooth: 1 } }))
  assert.deepEqual(withOptions[0].body.layer_options, { L1: { smooth: 1 } })
})

test('只读检查与自动排布走模块端点，正文文档原样提交', async () => {
  const doc = { version: 1, base: { path: 'b.png', width: 10, height: 10 }, theme: 'archival', layers: [] }
  const checked = await capture(() => mapStudioAPI.checkLayerDoc(9, doc))
  assert.equal(checked[0].url, '/huobao/api/v1/map-studio/tasks/9/layer-doc/check')
  assert.equal(checked[0].init.method, 'POST')
  assert.deepEqual(checked[0].body.layer_doc, doc)
  assert.equal('layer_options' in checked[0].body, false)

  const laid = await capture(() => mapStudioAPI.autoLayoutLayerDoc(9, doc, { L1: { smooth: 0 } }))
  assert.equal(laid[0].url, '/huobao/api/v1/map-studio/tasks/9/layer-doc/auto-layout')
  assert.deepEqual(laid[0].body.layer_options, { L1: { smooth: 0 } })
})

test('标签问题保留 code / layer_id，点击可定位到真实图层', () => {
  const error = {
    status: 400,
    body: {
      error: 'layer_doc_invalid',
      message: '不合法',
      problems: [
        { path: 'layers[1]', message: 'label_overlap：与图层 b 重叠', code: 'label_overlap', layer_id: 'b' },
        { path: 'layers[0].points[2]', message: '坐标越界' },
        { path: 'base', message: '底图缺失' },
      ],
    },
  }
  const parsed = mapLayerDocProblemsOf(error)
  assert.equal(parsed.problems.length, 3)
  assert.equal(parsed.problems[0].code, 'label_overlap')
  assert.equal(parsed.problems[0].layer_id, 'b')
  const layers = [{ id: 'a' }, { id: 'b' }]
  assert.equal(mapLayerProblemLayerId(parsed.problems[0], layers), 'b')
  // 没有 layer_id 时按 layers[N] 路径取当前文档里的图层
  assert.equal(mapLayerProblemLayerId(parsed.problems[1], layers), 'a')
  // 文档整体问题不硬指某个图层
  assert.equal(mapLayerProblemLayerId(parsed.problems[2], layers), null)
  assert.equal(mapLayerDocProblemsOf({ status: 400, body: { error: 'other' } }), null)
})

test('600 点数据集折线与 300 点面在真实 composable load→API save 路径上一点不少', async () => {
  const polyline = Array.from({ length: 600 }, (_, index) => [Number((index / 599).toFixed(6)), Number((0.5 + Math.sin(index / 12) * 0.2).toFixed(6))])
  const polygon = Array.from({ length: 300 }, (_, index) => {
    const angle = (index / 300) * Math.PI * 2
    return [Number((0.5 + Math.cos(angle) * 0.3).toFixed(6)), Number((0.5 + Math.sin(angle) * 0.3).toFixed(6))]
  })
  const doc = {
    version: 1,
    base: { path: 'static/map-drawings/base.png', width: 1920, height: 1080 },
    theme: 'archival',
    layers: [
      { id: 'coast-600', type: 'polyline', name: '海岸线', visible: true, locked: false, z: 0, opacity: 1, rotation: 0, points: polyline, style: {} },
      { id: 'sea-300', type: 'polygon', name: '海域', visible: true, locked: false, z: 1, opacity: 1, rotation: 0, points: polygon, style: {} },
    ],
  }
  const editor = useLayerDoc()
  editor.load(doc)
  await nextTick()
  const saved = normalizeMapLayerDoc(JSON.parse(JSON.stringify(editor.doc.value)))
  const calls = await capture(() => mapStudioAPI.saveLayerDoc(7, saved, 1))
  assert.deepEqual(calls[0].body.layer_doc.layers[0].points, polyline)
  assert.deepEqual(calls[0].body.layer_doc.layers[1].points, polygon)
  assert.equal(saved.layers[0].points.length, 600)
  assert.equal(saved.layers[1].points.length, 300)
  assert.deepEqual(saved.layers[0].points, polyline)
  assert.deepEqual(saved.layers[1].points, polygon)

  // 渲染副本也不能吞点：数据集默认关闭平滑时原样保留 600 个投影点；
  // 即使显式开启平滑，曲线也必须经过全部控制点（欠采样降密度也绝不删控制点）。
  const off = renderCopyWithSmoothing(doc, { 'coast-600': { smooth: 0 }, 'sea-300': { smooth: 0 } })
  assert.deepEqual(off.layers[0].points, polyline)
  assert.deepEqual(off.layers[1].points, polygon)
  const on = renderCopyWithSmoothing(doc, { 'coast-600': { smooth: 1 } })
  const dense = on.layers[0].points
  assert.ok(dense.length >= polyline.length)
  const present = new Set(dense.map(point => `${point[0]},${point[1]}`))
  for (const point of polyline) assert.ok(present.has(`${point[0]},${point[1]}`), `曲线应保留控制点 ${point}`)
})

/** 模拟 smooth.js 的渲染副本：控制点之间加密采样，点数远大于控制点 */
function densify(points, perSegment = 3) {
  const out = []
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    out.push([current[0], current[1]])
    for (let step = 1; step < perSegment; step += 1) {
      const t = step / perSegment
      out.push([current[0] + (next[0] - current[0]) * t, current[1] + (next[1] - current[1]) * t])
    }
  }
  return out
}

test('拖动平滑图层写回控制点：采样点一个都不进文档', () => {
  const controlPoints = Array.from({ length: 600 }, (_, index) => [index / 599, 0.5])
  const controlLayer = { id: 'coast-600', type: 'polyline', points: controlPoints, style: {} }
  const renderedLayer = { id: 'coast-600', type: 'polyline', points: densify(controlPoints), style: {} }
  assert.ok(renderedLayer.points.length > controlPoints.length)

  const dx = 0.01
  const dy = -0.02
  const patch = { points: renderedLayer.points.map(([x, y]) => [x + dx, y + dy]) }
  const remapped = remapCanvasPatch(patch, controlLayer, renderedLayer, { 'coast-600': { smooth: 1 } })
  assert.equal(remapped.points.length, 600)
  for (let index = 0; index < 600; index += 1) {
    assert.ok(Math.abs(remapped.points[index][0] - (controlPoints[index][0] + dx)) < 1e-9)
    assert.ok(Math.abs(remapped.points[index][1] - (controlPoints[index][1] + dy)) < 1e-9)
  }
  // 控制点数组本身没有被就地修改
  assert.deepEqual(controlLayer.points, controlPoints)
})

test('缩放平滑图层按同一仿射写回控制点，仍未写入采样点', () => {
  const controlPoints = [[0.2, 0.2], [0.4, 0.5], [0.6, 0.3], [0.8, 0.6]]
  const controlLayer = { id: 'region-1', type: 'polygon', points: controlPoints, style: {} }
  const renderedLayer = { id: 'region-1', type: 'polygon', points: densify(controlPoints), style: {} }
  const patch = { points: renderedLayer.points.map(([x, y]) => [x * 0.5, y * 0.5]) }
  const remapped = remapCanvasPatch(patch, controlLayer, renderedLayer, { 'region-1': { smooth: 1 } })
  assert.equal(remapped.points.length, controlPoints.length)
  remapped.points.forEach((point, index) => {
    assert.ok(Math.abs(point[0] - controlPoints[index][0] * 0.5) < 1e-9)
    assert.ok(Math.abs(point[1] - controlPoints[index][1] * 0.5) < 1e-9)
  })
})

test('未开启平滑时画布回调原样提交；无控制点的图元不做几何反解', () => {
  const controlLayer = { id: 'L1', type: 'polyline', points: [[0.1, 0.1], [0.2, 0.2]], style: {} }
  const renderedLayer = { id: 'L1', type: 'polyline', points: [[0.1, 0.1], [0.2, 0.2]], style: {} }
  const patch = { points: [[0.15, 0.15], [0.25, 0.25]] }
  assert.equal(remapCanvasPatch(patch, controlLayer, renderedLayer, {}), patch)

  const marker = { id: 'M1', type: 'marker', at: [0.4, 0.4], style: {} }
  const markerPatch = { at: [0.5, 0.5] }
  assert.equal(remapCanvasPatch(markerPatch, marker, marker, { M1: { smooth: 1 } }), markerPatch)
})

test('平滑参数按稳定图层/要素键解析；非法强度拒绝而不钳制', () => {
  const layer = { id: 'layer-7', anchor: { semantic_id: 'feat-ash' } }
  assert.equal(optionKeyForLayer(layer, { 'layer-7': { smooth: 1 } }), 'layer-7')
  assert.equal(optionKeyForLayer(layer, { 'feat-ash': { smooth: 0.4 } }), 'feat-ash')
  assert.equal(smoothingOf(layer, { 'feat-ash': { smooth: 0.4 } }), 0.4)
  assert.equal(smoothingOf(layer, { 'layer-7': { smooth: 2 } }), null)
  assert.equal(smoothingOf(layer, { 'layer-7': { smooth: -1 } }), null)
  assert.equal(smoothingOf(layer, {}), 0)
})

test('采样点的非仿射编辑被明确拒绝，不改写原始控制点', () => {
  const control = [[0.2, 0.2], [0.4, 0.5], [0.6, 0.3]]
  const rendered = densify(control)
  const next = rendered.map(p => [...p])
  next[2][0] += 0.1
  assert.equal(mapControlPointsThroughCanvas(control, rendered, next), null)
})

test('仿射反解不改变控制点数量，退化几何按平移兜底而不是覆盖', () => {
  const control = [[0.2, 0.5], [0.6, 0.5]]
  const rendered = densify(control)
  const next = rendered.map(([x, y]) => [x + 0.05, y])
  const mapped = mapControlPointsThroughCanvas(control, rendered, next)
  assert.equal(mapped.length, control.length)
  // 横线在 y 轴退化：y 保持原值，x 仍是控制点 + 平移
  assert.deepEqual(mapped.map(point => point[1]), [0.5, 0.5])
  assert.ok(Math.abs(mapped[0][0] - 0.25) < 1e-9)
})

test('平滑只改渲染副本：控制点一个不动、全部过曲线；拖动写回仍是原控制点数', () => {
  const controlPoints = [
    [0.18, 0.30], [0.35, 0.18], [0.55, 0.24], [0.72, 0.38],
    [0.66, 0.60], [0.40, 0.70], [0.22, 0.52],
  ]
  const doc = {
    version: 1,
    base: { path: 'static/map-drawings/base.png', width: 1920, height: 1080 },
    theme: 'archival',
    layers: [{ id: 'region-ash', type: 'polygon', name: '灰烬区', visible: true, locked: false, z: 0, opacity: 1, rotation: 0, points: controlPoints, style: {} }],
  }
  const snapshot = JSON.stringify(doc)
  const rendered = renderCopyWithSmoothing(doc, { 'region-ash': { smooth: 1 } })
  assert.equal(JSON.stringify(doc), snapshot, '渲染副本不得改动控制文档')
  const renderedPoints = rendered.layers[0].points
  assert.ok(renderedPoints.length > controlPoints.length)
  // 验收口径：曲线经过全部控制点（归一化坐标逐值命中）
  for (const point of controlPoints) {
    assert.ok(renderedPoints.some(candidate => candidate[0] === point[0] && candidate[1] === point[1]), `曲线应经过控制点 ${point}`)
  }
  // 关闭强度时点不变
  const off = renderCopyWithSmoothing(doc, { 'region-ash': { smooth: 0 } })
  assert.deepEqual(off.layers[0].points, controlPoints)

  // 画布拖动回调（采样点 + 平移）经适配器写回控制点：长度与控制点一致，不落采样点
  const patch = { points: renderedPoints.map(([x, y]) => [x + 0.01, y]) }
  const remapped = remapCanvasPatch(patch, doc.layers[0], { ...doc.layers[0], points: renderedPoints }, { 'region-ash': { smooth: 1 } })
  assert.equal(remapped.points.length, controlPoints.length)
  remapped.points.forEach((point, index) => {
    assert.ok(Math.abs(point[0] - (controlPoints[index][0] + 0.01)) < 1e-9)
    assert.ok(Math.abs(point[1] - controlPoints[index][1]) < 1e-9)
  })
})

test('画布与文档点数不一致时明确拒绝写入，不静默丢弃也不写采样点', () => {
  const controlLayer = { id: 'L1', type: 'polyline', points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]], style: {} }
  const renderedLayer = { id: 'L1', type: 'polyline', points: densify(controlLayer.points), style: {} }
  const mismatched = { points: [[0.15, 0.15], [0.25, 0.25]] }
  assert.equal(remapCanvasPatch(mismatched, controlLayer, renderedLayer, { L1: { smooth: 1 } }), null)
  // 找不到对应图层也拒绝，而不是把回调当控制点提交
  assert.equal(remapCanvasPatch(mismatched, undefined, renderedLayer, { L1: { smooth: 1 } }), null)
})

test('按主题重设作为真实编辑器的一条历史，撤销/重做不改变原几何或文字', async () => {
  const originalFetch = globalThis.fetch
  const before = {
    version: 1, base: { path: 'static/map-drawings/base.png', width: 1920, height: 1080 }, theme: 'archival',
    layers: [{ id: 'river', type: 'polyline', name: '河流', visible: true, locked: false, z: 0, opacity: 1, rotation: 0, anchor: { semantic_id: 'r' }, points: [[.2, .3], [.7, .5]], style: { stroke: '#112233', width: .006 } }],
  }
  const after = { ...before, theme: 'clean', layers: before.layers.map(layer => ({ ...layer, style: { stroke: '#488ba7', width: .002 } })) }
  globalThis.fetch = async () => Response.json({ code: 200, data: { layer_doc: after, map_style: 'modern-clean', problems: [] } })
  try {
    const editor = useLayerDoc()
    editor.load(before)
    await nextTick()
    const result = await mapStudioAPI.restyleLayerDoc(8, normalizeMapLayerDoc(editor.doc.value))
    editor.pushHistory()
    editor.doc.value = JSON.parse(JSON.stringify(result.layer_doc))
    await nextTick()
    assert.deepEqual(editor.doc.value.layers[0].points, before.layers[0].points)
    assert.equal(editor.canUndo.value, true)
    editor.undo(); await nextTick()
    assert.deepEqual(editor.doc.value, before)
    editor.redo(); await nextTick()
    assert.deepEqual(editor.doc.value, after)
  } finally { globalThis.fetch = originalFetch }
})
