/**
 * 图层文档 schema（Issue #48）：白名单、钳制、按 z 排序、非法条目丢弃。
 * 规则在 TS 里，用仓库自带的 tsx 子进程跑并以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function normalize(docs) {
  const script = `
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    const docs = JSON.parse(process.env.DOC_INPUT)
    process.stdout.write('@@' + JSON.stringify(docs.map(normalizeLayerDoc)))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, DOC_INPUT: JSON.stringify(docs) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('normalizeLayerDoc: base/theme fall back and sizes become integers', () => {
  const [empty, custom] = normalize([
    null,
    { base: { path: ' static/uploads/a.png ', width: '1920.6', height: 1080, filter: { paper: 2, tint: 'nope', vignette: -1 } }, theme: 'ink', layers: [] },
  ])
  assert.deepEqual(empty, { version: 1, base: { path: '', width: 1344, height: 768 }, theme: 'archival', layers: [] })
  assert.equal(custom.base.path, 'static/uploads/a.png')
  assert.equal(custom.base.width, 1920)
  assert.equal(custom.theme, 'ink')
  assert.deepEqual(custom.base.filter, { paper: 1, tint: 'none', tint_strength: 0.35, vignette: 0 })
})

test('normalizeLayerDoc: layers sort by z, keep input order on ties and get unique ids', () => {
  const [doc] = normalize([{
    layers: [
      { id: 'a', type: 'marker', at: [0.5, 0.5], z: 5 },
      { id: 'a', type: 'marker', at: [0.4, 0.4], z: 1 },
      { type: 'marker', at: [0.3, 0.3], z: 1 },
    ],
  }])
  assert.deepEqual(doc.layers.map(l => [l.id, l.z]), [['a', 1], ['layer-3', 1], ['a-3', 5]])
})

test('normalizeLayerDoc: invalid layers are dropped, not repaired', () => {
  const [doc] = normalize([{
    layers: [
      { type: 'polygon', points: [[0, 0], [1, 1]] },            // 少于 3 点
      { type: 'polyline', points: [[0, 0]] },                   // 少于 2 点
      { type: 'image', box: { x: 0, y: 0, w: 0.2, h: 0.2 } },   // 没有 src.path
      { type: 'nope', box: {} },                                // 未知类型
      null,
      { type: 'label', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, text: '保留' },
    ],
  }])
  assert.deepEqual(doc.layers.map(l => l.type), ['label'])
  assert.equal(doc.layers[0].text, '保留')
})

test('normalizeLayerDoc: coordinates are clamped to the 0–1 contract, boxes keep a minimum size', () => {
  const [doc] = normalize([{
    layers: [
      { type: 'polygon', points: [[-9, 0.2], [0.5, 9], [0.8, 0.8], 'nope'] },
      { type: 'label', box: { x: 3, y: -3, w: 0, h: 99 }, text: 'x' },
    ],
  }])
  assert.deepEqual(doc.layers[0].points, [[0, 0.2], [0.5, 1], [0.8, 0.8]])
  assert.deepEqual(doc.layers[1].box, { x: 1, y: 0, w: 0.005, h: 2 })
})

test('normalizeLayerDoc: id dedup never lands on an id that already exists', () => {
  const [doc] = normalize([{
    layers: [
      { id: 'a', type: 'marker', at: [0.1, 0.1] },
      { id: 'a-3', type: 'marker', at: [0.2, 0.2] },
      { id: 'a', type: 'marker', at: [0.3, 0.3] },
      { id: 'a', type: 'marker', at: [0.4, 0.4] },
    ],
  }])
  const ids = doc.layers.map(l => l.id)
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.join(',')}`)
  assert.deepEqual(ids, ['a', 'a-3', 'a-4', 'a-5'])
})

test('normalizeLayerDoc: style keys outside the per-type whitelist are dropped and ranges clamped', () => {
  const [doc] = normalize([{
    layers: [
      {
        type: 'polygon',
        points: [[0, 0], [1, 0], [1, 1]],
        style: { fill: '#ff0000', fill_opacity: 9, dash: 'wavy', evil: 'x', stroke_width: 'abc', size: 0.5 },
      },
    ],
  }])
  assert.deepEqual(doc.layers[0].style, { fill: '#ff0000', fill_opacity: 1, dash: 'none', stroke_width: 0.004 })
})

test('normalizeLayerDoc: anchor is kept only with a real reference, detached only when true', () => {
  const [doc] = normalize([{
    layers: [
      { id: 'a', type: 'marker', at: [0.5, 0.5], anchor: { asset_id: 39, semantic_id: 'zaysan', detached: true } },
      { id: 'b', type: 'marker', at: [0.5, 0.5], anchor: { detached: false } },
      { id: 'c', type: 'marker', at: [0.5, 0.5] },
    ],
  }])
  assert.deepEqual(doc.layers[0].anchor, { asset_id: 39, semantic_id: 'zaysan', detached: true })
  assert.equal(doc.layers[1].anchor, undefined)
  assert.equal(doc.layers[2].anchor, undefined)
})

test('normalizeLayerDoc: layer count is capped', () => {
  const layers = Array.from({ length: 70 }, (_, i) => ({ type: 'marker', at: [0.5, 0.5], z: i }))
  const [doc] = normalize([{ layers }])
  assert.equal(doc.layers.length, 60)
})

test('R6 optional crop/source/provenance fields survive normalization, full crop stays omitted', () => {
  const ref = { asset_kind: 'prop', asset_id: 39, version_task_id: 210 }
  const [legacy, full, cropped] = normalize([
    { base: { path: 'static/base.png', width: 320, height: 240 } },
    { base: { path: 'static/base.png', width: 320, height: 240, crop: { x: 0, y: 0, w: 1, h: 1 } } },
    {
      base: { path: 'static/base.png', width: 320, height: 240, source_width: 32000, source_height: 24000, crop: { x: 0, y: 0.125, w: 1, h: 0.75 }, ref },
      layers: [
        { type: 'image', box: {}, src: { path: 'static/portrait.png', ...ref } },
        { type: 'marker', at: [0.5, 0.5], style: { label_dx: 2, label_dy: -2 } },
      ],
    },
  ])
  assert.deepEqual(legacy, full, 'explicit full crop must not drift old JSON/signatures')
  assert.equal('crop' in legacy.base, false)
  assert.deepEqual(cropped.base.crop, { x: 0, y: 0.125, w: 1, h: 0.75 })
  assert.deepEqual(cropped.base.ref, ref)
  assert.equal(cropped.base.source_width, 32000, 'source metadata is not limited by editor output size')
  assert.deepEqual(cropped.layers[0].src, { path: 'static/portrait.png', ...ref })
  assert.deepEqual(cropped.layers[1].at, [0.5, 0.5], 'offsets do not move the anchored point')
  assert.deepEqual(cropped.layers[1].style, { label_dx: 0.5, label_dy: -0.5 })
})

test('anchor source-name snapshot is optional and does not follow editable layer.name', () => {
  const [doc] = normalize([{ layers: [
    { type: 'marker', name: '自定义图层名', at: [0.5, 0.5], anchor: { asset_id: 39, semantic_id: 'lake', semantic_name: '  斋桑湖  ' } },
  ] }])
  assert.equal(doc.layers[0].name, '自定义图层名')
  assert.equal(doc.layers[0].anchor.semantic_name, '斋桑湖')
})
