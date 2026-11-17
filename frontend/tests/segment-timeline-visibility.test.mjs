import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JUNCTION_HIDDEN_TYPES, STAGED_LAYER_TYPES, clampSegmentDuration, frameStateAt,
  junctionHiddenLayerIds, stagedLayerIds,
} from '../app/utils/segmentTimeline.js'

// Issue #110：画中画 image 层与模板文本框同口径——先出后进、衔接帧不含它；
// 图层段不再有 30 s 上限（只有扩散生成段受 15 s 限制）。

const layers = [
  { id: 'text-a', type: 'text' },
  { id: 'text-b', type: 'text' },
  { id: 'pip', type: 'image' },
  { id: 'region', type: 'polygon' },
  { id: 'pin', type: 'marker' },
  { id: 'card', type: 'card' },
]

test('staged layers are template text boxes plus picture-in-picture images', () => {
  assert.deepEqual(STAGED_LAYER_TYPES, ['text', 'image'])
  assert.deepEqual(stagedLayerIds(layers), ['text-a', 'text-b', 'pip'])
  assert.deepEqual(stagedLayerIds(null), [])
})

test('staged image layers fade out in the first half and in in the second half, like text', () => {
  // t=2 整组消失、t=4 整组回来：每帧的 fade_ms 只管「到达这一帧」的那一段过渡
  const timeline = {
    ease: 'linear',
    fade_ms: 1000,
    keyframes: [
      { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['pip'] },
      { t: 2, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
      { t: 4, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['pip'] },
    ],
  }
  const staged = stagedLayerIds(layers)
  // 淡出只占前半段：2.25 s 已经减半，2.75 s 彻底不见
  assert.equal(frameStateAt(timeline, 2.25, staged).opacity.pip, 0.5)
  assert.equal(frameStateAt(timeline, 2.75, staged).opacity.pip, 0)
  // 淡入只占后半段：4.25 s 还没出现，4.75 s 露出一半，5 s 到位
  assert.equal(frameStateAt(timeline, 4.25, staged).opacity.pip, 0)
  assert.equal(frameStateAt(timeline, 4.75, staged).opacity.pip, 0.5)
  assert.equal(frameStateAt(timeline, 5, staged).opacity.pip, 1)
  // 不传 staged 时按普通图层线性淡入：过渡刚开始就露出一半比例，可能与上一份内容叠着
  assert.equal(frameStateAt(timeline, 4.25, []).opacity.pip, 0.25)
})

test('junction hides text layers and picture-in-picture images', () => {
  assert.deepEqual(JUNCTION_HIDDEN_TYPES, ['text', 'label', 'card', 'image'])
  assert.deepEqual(junctionHiddenLayerIds(layers, 'C').sort(), ['card', 'pip', 'text-a', 'text-b'])
  assert.deepEqual(junctionHiddenLayerIds(layers, 'D').sort(), ['card', 'pip', 'text-a', 'text-b'])
  // A 只用图层、B 只用生成：都没有衔接帧
  assert.deepEqual(junctionHiddenLayerIds(layers, 'A'), [])
  assert.deepEqual(junctionHiddenLayerIds(layers, 'B'), [])
})

test('layer segment duration has a 1 s floor and no upper limit', () => {
  assert.equal(clampSegmentDuration(42), 42)
  assert.equal(clampSegmentDuration(90.25), 90.25)
  assert.equal(clampSegmentDuration(0.1), 1)
  assert.equal(clampSegmentDuration(-5), 1)
  assert.equal(clampSegmentDuration(Number.NaN), 1)
  // 三位小数与后端同口径
  assert.equal(clampSegmentDuration(6.4), 6.4)
  assert.equal(clampSegmentDuration(6.4444), 6.444)
})
