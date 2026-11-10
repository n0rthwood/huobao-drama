import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backendLayerId, dedupeLayerIds, normalizeMapLayerDoc, sortLayersByZ } from '../app/utils/mapLayerDoc.js'

// 期望值对照 backend/src/services/layer-doc.ts 的 normalizeLayerDoc：
// 稳定排序 `(a.z - b.z) || (a.index - b.index)`，重复 id 取 `${id}-${index+1}` 并在占用时递增。
const layer = (id, z) => ({ id, type: 'marker', z, at: [0.5, 0.5], style: {} })

test('z 排序稳定：z 相同的图层保持提交时的先后顺序', () => {
  const layers = [layer('a', 2), layer('b', 0), layer('c', 2), layer('d', 0), layer('e', 1)]
  assert.deepEqual(sortLayersByZ(layers).map(item => item.id), ['b', 'd', 'e', 'a', 'c'])
  // 原数组不被改动，调用方的草稿不会因为一次提交而重排
  assert.deepEqual(layers.map(item => item.id), ['a', 'b', 'c', 'd', 'e'])
})

test('z 非法或越界时按后端口径参与排序（num(0,9999,index) 的钳制与回落）', () => {
  const layers = [{ ...layer('a', 5) }, { ...layer('b'), z: undefined }, { ...layer('c', 0) }]
  assert.deepEqual(sortLayersByZ(layers).map(item => item.id), ['c', 'b', 'a'])
  // -3 钳到 0、20000 钳到 9999：按原值排序会把 neg 排到 zero 之前，钳制后两者同值按原序
  const clamped = [{ ...layer('big', 20000) }, { ...layer('neg', -3) }, { ...layer('zero', 0) }]
  assert.deepEqual(sortLayersByZ(clamped).map(item => item.id), ['neg', 'zero', 'big'])
})

test('id 取后端口径：trim 到 64 字符，空 id 回落成排序前下标的 layer-N', () => {
  assert.equal(backendLayerId({ id: '  pin  ' }, 0), 'pin')
  assert.equal(backendLayerId({ id: '' }, 2), 'layer-3')
  assert.equal(backendLayerId({}, 0), 'layer-1')
  assert.equal(backendLayerId({ id: 'x'.repeat(80) }, 0), 'x'.repeat(64))
  // 缺 id 的图层不会被当成同一个 id 互相撞车，更不会产生 undefined-2
  const out = normalizeMapLayerDoc({ layers: [{ ...layer(undefined, 1) }, { ...layer(undefined, 0) }] })
  assert.deepEqual(out.layers.map(item => item.id), ['layer-2', 'layer-1'])
})

test('重复 id 按排序后的下标加后缀，后缀被占用时继续递增', () => {
  const result = dedupeLayerIds([layer('p', 0), layer('p', 1), layer('p', 2)])
  assert.deepEqual(result.map(item => item.id), ['p', 'p-2', 'p-3'])

  const taken = dedupeLayerIds([layer('p', 0), layer('p-2', 1), layer('p', 2)])
  assert.deepEqual(taken.map(item => item.id), ['p', 'p-2', 'p-3'])

  const chained = dedupeLayerIds([layer('p', 0), layer('p-2', 1), layer('p-3', 2), layer('p', 3)])
  assert.deepEqual(chained.map(item => item.id), ['p', 'p-2', 'p-3', 'p-4'])
})

test('去重只复制被改名的图层对象，其余保持同一引用', () => {
  const first = layer('p', 0)
  const second = layer('p', 1)
  const result = dedupeLayerIds([first, second])
  assert.equal(result[0], first)
  assert.notEqual(result[1], second)
  assert.equal(second.id, 'p')
  assert.equal(result[1].id, 'p-2')
})

test('整份文档：先按 z 排序再去重，下标取排序后的位置', () => {
  const doc = {
    version: 1,
    base: { path: 'static/map-drawings/base.png', width: 1344, height: 768 },
    theme: 'archival',
    layers: [layer('dup', 3), layer('dup', 1), layer('solo', 2)],
  }
  const out = normalizeMapLayerDoc(doc)
  assert.deepEqual(out.layers.map(item => [item.id, item.z]), [['dup', 1], ['solo', 2], ['dup-3', 3]])
  // 其余字段原样保留，不补后端不会补的默认值
  assert.deepEqual(out.base, doc.base)
  assert.equal(out.theme, 'archival')
  assert.equal(out.version, 1)
  assert.deepEqual(Object.keys(out).sort(), ['base', 'layers', 'theme', 'version'])
})

test('缺少 layers 时给出空数组，不抛错', () => {
  assert.deepEqual(normalizeMapLayerDoc({ theme: 'ink' }), { theme: 'ink', layers: [] })
  assert.deepEqual(normalizeMapLayerDoc(null), { layers: [] })
})
