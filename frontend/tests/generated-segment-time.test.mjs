import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generatedSegmentSecondsOf, midFrameTimeOutOfRange, midFrameTimeRange } from '../app/utils/generatedSegment.js'

// Issue #110：中间帧时间的区间按**生成段**算，不按整镜时长（整镜还含确定性渲染的图层段）。
// ep30 #01：生成段 5 s、存量 mid_frame_time = 8 —— 已越界，界面要当错误显示。

test('generated segment seconds prefer the API field, then the design card budget, then duration', () => {
  assert.equal(generatedSegmentSecondsOf({ generated_segment_s: 5, duration: 20 }), 5)
  assert.equal(generatedSegmentSecondsOf({ generatedSegmentS: 7, duration: 20 }), 7)
  assert.equal(generatedSegmentSecondsOf({ generated_segment_s: null, design_card: { budget: { gen_s: 6 } }, duration: 20 }), 6)
  assert.equal(generatedSegmentSecondsOf({ designCard: { budget: { gen_s: 9 } }, duration: 20 }), 9)
  assert.equal(generatedSegmentSecondsOf({ duration: 12 }), 12)
  assert.equal(generatedSegmentSecondsOf({}), null)
  assert.equal(generatedSegmentSecondsOf(null), null)
  // 0 / 负数不是有效时长：继续往下一级兜底，而不是算出 0.5 s 的区间
  assert.equal(generatedSegmentSecondsOf({ generated_segment_s: 0, design_card: { budget: { gen_s: 4 } } }), 4)
})

test('mid frame range is the open interval (0.5, generated segment - 0.5)', () => {
  assert.deepEqual(midFrameTimeRange({ generated_segment_s: 5 }), { min: 0.5, max: 4.5, seconds: 5 })
  assert.deepEqual(midFrameTimeRange({ generated_segment_s: 15 }), { min: 0.5, max: 14.5, seconds: 15 })
  // 生成段不到 1 s：没有合法的中间帧时刻
  assert.equal(midFrameTimeRange({ generated_segment_s: 1 }), null)
  assert.equal(midFrameTimeRange({ generated_segment_s: 0.9 }), null)
  // 完全取不到时长时按调用方的兜底时长（默认 10 s，与旧界面一致）
  assert.deepEqual(midFrameTimeRange({}, 10), { min: 0.5, max: 9.5, seconds: 10 })
})

test('ep30 #01 shape: gen_s 5 with mid_frame_time 8 is out of range', () => {
  const shot = { generated_segment_s: 5, duration: 10, design_card: { budget: { layer_s: 10, gen_s: 5 } } }
  assert.equal(midFrameTimeOutOfRange(8, shot), true)
  assert.equal(midFrameTimeOutOfRange(4.4, shot), false)
  assert.equal(midFrameTimeOutOfRange(4.5, shot), true, '上限是开区间')
  assert.equal(midFrameTimeOutOfRange(0.5, shot), true, '下限是开区间')
  assert.equal(midFrameTimeOutOfRange(null, shot), false, '中间帧是可选的')
  assert.equal(midFrameTimeOutOfRange('', shot), false)
  assert.equal(midFrameTimeOutOfRange('abc', shot), true)
})
