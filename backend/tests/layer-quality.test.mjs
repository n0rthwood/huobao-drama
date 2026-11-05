import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as front from '../../frontend/app/utils/layerQuality.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
function backend(cases) {
  const script = `
    import * as quality from './src/services/layer-quality.ts'
    const cases = JSON.parse(process.env.QUALITY_CASES)
    console.log('@@' + JSON.stringify(cases.map(([name, args]) => quality[name](...args))))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8', env: { ...process.env, QUALITY_CASES: JSON.stringify(cases) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const full = { x: 0, y: 0, w: 1, h: 1 }
const crop = { x: 0, y: 0.125, w: 1, h: 0.75 }
const base = { path: 'static/base.png', width: 4000, height: 3000, source_width: 4000, source_height: 3000, crop }
const frame = (viewport, t = 0) => ({ t, viewport, visible: [] })
const spec = { width: 1920, height: 1080 }
const timeline = { fps: 25, ease: 'linear', fade_ms: 0, keyframes: [frame({ x: 0.25, y: 0.25, w: 0.5, h: 0.375 }), frame(full, 2)] }
const cases = [
  ...[null, {}, full, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: -1, h: 1 }, { x: -3, y: 0.123456, w: 9, h: 2 }, { x: 0.8, y: 0.9, w: 0.8, h: 0.8 }, { x: 9, y: 9, w: 1, h: 1 }].map(value => ['normalizeCrop', [value]]),
  ['effectivePixelsAt', [base, { x: 0.25, y: 0.25, w: 0.5, h: 0.375 }]],
  ['qualityWarningsOf', [{ base }, [frame({ x: 0, y: 0.125, w: 0.48, h: 0.36 }), frame({ x: 0, y: 0.125, w: 1919 / 4000, h: 0.36 }, 1)], spec]],
  ['baseAspectIssue', [base, spec]],
  ['baseAspectIssue', [{ ...base, crop: undefined }, spec]],
  ['cropRectOf', [{ crop: { x: 0.9999, y: 0.9999, w: 0.0001, h: 0.0001 } }, 7, 3]],
  ['cropRectOf', [{ crop }, 4001, 3001]],
  ['clampViewportToCrop', [timeline.keyframes[0].viewport, crop]],
  ['clampViewportToCrop', [full, crop]],
  ['clampTimelineToCrop', [timeline, crop]],
]
const results = backend(cases)

test('quality helpers have identical frontend/backend results', () => {
  cases.forEach(([name, args], i) => assert.deepEqual(front[name](...args), results[i], `${name} case ${i}`))
})

test('crop normalization omits no dimensions and never overflows after rounding', () => {
  assert.deepEqual(results[0], full)
  assert.deepEqual(results[1], full)
  assert.deepEqual(results[3], full)
  assert.deepEqual(results[4], full)
  for (const value of results.slice(0, 8)) {
    assert.ok(value.w > 0 && value.h > 0)
    assert.ok(value.x >= 0 && value.y >= 0)
    assert.ok(value.x + value.w <= 1 + 1e-12 && value.y + value.h <= 1 + 1e-12)
  }
  assert.deepEqual(results[6], { x: 0.8, y: 0.9, w: 0.2, h: 0.1 })
})

test('effective pixels use WHOLE-image viewport once, never multiply crop again', () => {
  assert.deepEqual(results[8], { w: 2000, h: 1125 })
  const warnings = results[9]
  assert.equal(warnings.length, 1, 'exact output resolution is sufficient; one pixel short warns')
  assert.equal(warnings[0].frame_index, 1)
  assert.equal(warnings[0].effective_w, 1919)
  assert.equal(warnings[0].spec_w, 1920)
  assert.equal(warnings[0].output_h, 1080)
})

test('aspect warning uses crop and real dimensions; extraction integer rounding stays in bounds', () => {
  assert.equal(results[10], null)
  assert.ok(results[11].aspect)
  assert.deepEqual(results[12], { left: 6, top: 2, width: 1, height: 1 })
  const rect = results[13]
  assert.ok(rect.left + rect.width <= 4001 && rect.top + rect.height <= 3001)
})

test('crop application preserves representable framing and explicitly reports forced changes', () => {
  assert.equal(results[14].changed, false)
  assert.deepEqual(results[14].viewport, timeline.keyframes[0].viewport)
  assert.equal(results[15].changed, true)
  assert.deepEqual(results[15].viewport, crop, 'old full frame becomes the full 16:9 crop, never a centre square')
  assert.equal(results[16].changed, true)
  assert.deepEqual(results[16].timeline.keyframes[0], timeline.keyframes[0])
  assert.deepEqual(results[16].timeline.keyframes[1].viewport, results[15].viewport)
  const contained = { ...timeline, keyframes: [timeline.keyframes[0]] }
  assert.equal(front.clampTimelineToCrop(contained, crop).timeline, contained, 'no-op retains timeline identity')
})
