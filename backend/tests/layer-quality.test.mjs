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
const uncropped = { ...base, crop: undefined }
const unknown = { path: 'static/base.png', width: 4000, height: 3000 }
const frame = (viewport, t = 0) => ({ t, viewport, visible: [] })
const spec = { width: 1920, height: 1080 }
const portrait = { width: 544, height: 960 }
const containFrame = { x: 0, y: -0.6765, w: 1, h: 2.3529 }
const timeline = { fps: 25, ease: 'linear', fade_ms: 0, keyframes: [frame({ x: 0.25, y: 0.25, w: 0.5, h: 0.375 }), frame(full, 2)] }
const cases = [
  ...[null, {}, full, { x: 0, y: 0, w: 0, h: 1 }, { x: 0, y: 0, w: -1, h: 1 }, { x: -3, y: 0.123456, w: 9, h: 2 }, { x: 0.8, y: 0.9, w: 0.8, h: 0.8 }, { x: 9, y: 9, w: 1, h: 1 }].map(value => ['normalizeCrop', [value]]),
  ['effectivePixelsAt', [base, { x: 0.25, y: 0.25, w: 0.5, h: 0.375 }]],
  ['qualityWarningsOf', [{ base }, [frame({ x: 0, y: 0.125, w: 0.48, h: 0.36 }), frame({ x: 0, y: 0.125, w: 1919 / 4000, h: 0.36 }, 1)], spec]],
  ['baseAspectIssue', [base, spec]],
  ['baseAspectIssue', [uncropped, spec]],
  ['cropRectOf', [{ crop: { x: 0.9999, y: 0.9999, w: 0.0001, h: 0.0001 } }, 7, 3]],
  ['cropRectOf', [{ crop }, 4001, 3001]],
  ['clampViewportToFrame', [timeline.keyframes[0].viewport, base, spec]],
  ['clampViewportToFrame', [full, base, spec]],
  ['clampTimelineToFrame', [timeline, base, spec]],
  ['baseFrameOf', [base, spec]],
  ['baseFrameOf', [uncropped, portrait]],
  ['baseFrameOf', [unknown, portrait]],
  ['clampViewportToFrame', [full, uncropped, portrait]],
  ['clampViewportToFrame', [{ x: 0.3, y: 0.3, w: 0.4, h: 0.4 }, uncropped, portrait]],
  ['frameRectOf', [containFrame, containFrame, 544, 960]],
  ['frameRectOf', [{ x: 0, y: -0.3382, w: 0.5, h: 1.1765 }, containFrame, 544, 960]],
  ['normalizeFrameBox', [{ x: -1.2345678, y: -2, w: 1, h: 3 }]],
  ['normalizeFrameBox', [{ x: 0, y: 0, w: 0, h: 1 }]],
  ['effectivePixelsAt', [uncropped, containFrame]],
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
  assert.deepEqual(results[26], { w: 4000, h: 3000 }, 'letterbox bands are not resolution: effective pixels clip to the image')
})

test('aspect mismatch now means contain letterboxing, never stretching', () => {
  assert.equal(results[10], null)
  assert.equal(results[11].aspect, '4:3')
  assert.equal(results[11].mode, 'contain')
  assert.deepEqual(results[12], { left: 6, top: 2, width: 1, height: 1 })
  const rect = results[13]
  assert.ok(rect.left + rect.width <= 4001 && rect.top + rect.height <= 3001)
})

test('frame expands the base bounds to the output aspect, never shrinks it', () => {
  assert.equal(results[17].mode, 'cover', '16:9 crop in a 16:9 project stays cover')
  assert.deepEqual(results[17].frame, results[17].bounds)
  const contain = results[18]
  assert.equal(contain.mode, 'contain')
  assert.deepEqual(contain.bounds, full)
  assert.equal(contain.frame.w, 1, 'a 4:3 source in a 9:16 project grows along the short axis only')
  assert.ok(Math.abs(contain.frame.h - 2.3529) < 1e-3, `frame height ${contain.frame.h}`)
  assert.ok(Math.abs(contain.frame.y + contain.frame.h / 2 - 0.5) < 1e-3, 'frame stays centred on the bounds')
  const pixelAspect = (contain.frame.w * 4000) / (contain.frame.h * 3000)
  assert.ok(Math.abs(pixelAspect / (544 / 960) - 1) < 0.01, `frame pixel aspect ${pixelAspect}`)
  assert.equal(results[19].mode, 'cover', 'unknown source dimensions cannot be judged: stay cover')
  assert.deepEqual(results[19].frame, full)
})

test('viewports are normalized to the output aspect inside the frame', () => {
  assert.equal(results[14].changed, false)
  assert.deepEqual(results[14].viewport, timeline.keyframes[0].viewport)
  assert.equal(results[15].changed, true)
  assert.deepEqual(results[15].viewport, crop, 'old full frame becomes the full 16:9 crop, never a centre square')
  assert.equal(results[16].changed, true)
  assert.deepEqual(results[16].timeline.keyframes[0], timeline.keyframes[0])
  assert.deepEqual(results[16].timeline.keyframes[1].viewport, results[15].viewport)
  const contained = { ...timeline, keyframes: [timeline.keyframes[0]] }
  assert.equal(front.clampTimelineToFrame(contained, base, spec).timeline, contained, 'no-op retains timeline identity')
  // 竖版项目里旧的全幅取景被归一成整个取景框（含留白带），不是源图方框
  assert.deepEqual(results[20].viewport, results[18].frame)
  const pushedIn = results[21].viewport
  assert.ok(Math.abs((pushedIn.w * 4000) / (pushedIn.h * 3000) / (544 / 960) - 1) < 0.01, 'push-in keeps the output aspect')
  assert.ok(pushedIn.w <= results[18].frame.w + 1e-9 && pushedIn.h <= results[18].frame.h + 1e-9)
})

test('frame extraction maps the viewport onto the frame canvas', () => {
  assert.deepEqual(results[22], { left: 0, top: 0, width: 544, height: 960 }, 'the whole frame is the whole canvas')
  const pushedIn = results[23]
  assert.deepEqual(pushedIn, { left: 0, top: 138, width: 272, height: 480 }, '推近取景按比例映射到取景框画布')
  assert.ok(Math.abs((pushedIn.width / pushedIn.height) / (544 / 960) - 1) < 0.01, '取整后仍与成片同比例')
  assert.deepEqual(results[24], { x: -1.2346, y: -2, w: 1, h: 3 }, 'frame boxes keep negative coordinates')
  assert.deepEqual(results[25], full, 'degenerate boxes fall back to the full image')
})
