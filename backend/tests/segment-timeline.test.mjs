/**
 * 图层段精确关键帧时间线（Issue #58，原 clip-timeline.test.mjs）纯函数：
 * 规范化、取景框不变量、逐帧插值、帧缓存键、`keyframes[]` 改名、`end_hold` 派生、逐帧 ease/fade 覆盖。
 * 纯 TS 模块，用仓库自带 tsx 子进程跑并以 JSON 回传（与 layer-svg.test.mjs 同法）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as frontTimeline from '../../frontend/app/utils/segmentTimeline.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import {
      normalizeTimeline, normalizeViewport, viewportFromPoints, frameStateAt, frameCount,
      frameKeyOf, minViewportSize, timelineLayerIds, clampSegmentDuration, MAX_LAYER_SEGMENT_SECONDS, endHoldOf,
    } from './src/services/segment-timeline.ts'
    const MAX_LAYER_SEGMENT_MAX = MAX_LAYER_SEGMENT_SECONDS
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const S01 = `
  const timeline = normalizeTimeline({
    fps: 25, ease: 'linear', fade_ms: 400,
    keyframes: [
      { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
      { t: 3, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['rg'] },
      { t: 6, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['rg', 'south'] },
      { t: 9, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['rg', 'south', 'north'] },
      { t: 12, viewport: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, visible: ['rg', 'south', 'north'] },
    ],
  })
`

test('规范化：fps/fade 钳制、状态按时刻排序、同刻去重、空输入兜底', () => {
  const got = run(`
    const sorted = normalizeTimeline({
      fps: 999, fade_ms: -5, ease: 'nope',
      keyframes: [{ t: 5, visible: ['b'] }, { t: 1, visible: ['a'] }, { t: 5, visible: ['c'] }],
    })
    const empty = normalizeTimeline(null)
    out({
      fps: sorted.fps, fade: sorted.fade_ms, ease: sorted.ease,
      times: sorted.keyframes.map(s => s.t),
      lastVisible: sorted.keyframes[sorted.keyframes.length - 1].visible,
      emptyStates: empty.keyframes.length,
      emptyViewport: empty.keyframes[0].viewport,
      emptyVisible: empty.keyframes[0].visible,
    })
  `)
  assert.equal(got.fps, 60, 'fps 钳到上限 60')
  assert.equal(got.fade, 0, '负 fade 钳到 0')
  assert.equal(got.ease, 'inout', '非法 ease 回落 inout')
  assert.deepEqual(got.times, [1, 5], '按时刻排序且同刻只留最后一条')
  assert.deepEqual(got.lastVisible, ['c'], '同刻保留后写入的那条')
  assert.equal(got.emptyStates, 1)
  assert.deepEqual(got.emptyViewport, { x: 0, y: 0, w: 1, h: 1 })
  assert.deepEqual(got.emptyVisible, [])
})

test('FPS 保留分数计划与既有整数，仍沿用 1–60 的规范化边界', () => {
  const got = run(`
    out([0.5, 1, 24, 25, 29.97, 60, 120].map(fps => normalizeTimeline({ fps }).fps))
  `)
  assert.deepEqual(got, [1, 1, 24, 25, 29.97, 60, 60])
})

test('取景框不变量：归一化 w === h（像素比例才与整幅一致），越界钳回画面内', () => {
  const got = run(`
    out({
      stretched: normalizeViewport({ x: 0.1, y: 0.1, w: 0.8, h: 0.3 }),
      tuple: normalizeViewport([0.2, 0.2, 0.6, 0.6]),
      overflow: normalizeViewport({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }),
      tooSmall: normalizeViewport({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 }),
      garbage: normalizeViewport('nope'),
    })
  `)
  // 归一化坐标系里 w·W : h·H = W : H 当且仅当 w === h；按较大的一边补齐，宁可多框不变形
  assert.equal(got.stretched.w, got.stretched.h)
  assert.equal(got.stretched.w, 0.8)
  assert.deepEqual(got.tuple, { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, '支持 #49 的 [x,y,w,h] 数组写法')
  assert.equal(got.overflow.x + got.overflow.w <= 1, true, '越界取景框被整体挪回画面内')
  assert.equal(got.overflow.y + got.overflow.h <= 1, true)
  assert.equal(got.tooSmall.w, 0.2, '最小边长 0.2，避免放大到糊')
  assert.deepEqual(got.garbage, { x: 0, y: 0, w: 1, h: 1 }, '非法输入退化为全图')
})

test('外接框 ×1.3 推近：包住所有点并保持同比例', () => {
  const got = run(`out(viewportFromPoints([[0.3, 0.4], [0.5, 0.5], [0.45, 0.42]], 1.3))`)
  assert.equal(got.w, got.h)
  assert.equal(got.x <= 0.3 && got.x + got.w >= 0.5, true, '外接框包住所有点')
  assert.equal(got.y <= 0.4 && got.y + got.h >= 0.5, true)
})

test('S01 逐层显现：0/3/6/9 秒各多一层，fade 结束后是整数不透明度', () => {
  const got = run(`${S01}
    const at = t => frameStateAt(timeline, t)
    out({
      ids: timelineLayerIds(timeline),
      t0: at(0).opacity,
      t2: at(2).opacity,
      t3_2: at(3.2).opacity,
      t3_4: at(3.4).opacity,
      t6_4: at(6.4).opacity,
      t9_4: at(9.4).opacity,
      frames: frameCount(timeline.fps, 15),
    })
  `)
  assert.deepEqual(got.ids, ['rg', 'south', 'north'], '图层按首次出现排序')
  assert.deepEqual(got.t0, { rg: 0, south: 0, north: 0 }, '开头先给干净底图')
  assert.deepEqual(got.t2, { rg: 0, south: 0, north: 0 })
  assert.equal(got.t3_2.rg, 0.5, '3 s 起 400 ms 淡入，3.2 s 正好一半')
  assert.deepEqual(got.t3_4, { rg: 1, south: 0, north: 0 })
  assert.deepEqual(got.t6_4, { rg: 1, south: 1, north: 0 })
  assert.deepEqual(got.t9_4, { rg: 1, south: 1, north: 1 })
  assert.equal(got.frames, 375, '15 s @25fps = 375 帧')
})

test('Ken Burns：9→12 秒线性推近，12 秒后保持末状态；inout 两端更慢', () => {
  const got = run(`${S01}
    const easeIn = normalizeTimeline({ ...timeline, ease: 'inout' })
    out({
      t9: frameStateAt(timeline, 9).viewport,
      t10_5: frameStateAt(timeline, 10.5).viewport,
      t12: frameStateAt(timeline, 12).viewport,
      t14: frameStateAt(timeline, 14).viewport,
      inout10_5: frameStateAt(easeIn, 10.5).viewport,
      minViewport: minViewportSize(timeline),
    })
  `)
  assert.deepEqual(got.t9, { x: 0, y: 0, w: 1, h: 1 })
  assert.deepEqual(got.t10_5, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, '线性插值取中点')
  assert.deepEqual(got.t12, { x: 0.2, y: 0.2, w: 0.6, h: 0.6 })
  assert.deepEqual(got.t14, { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, '末状态之后保持不动')
  assert.deepEqual(got.inout10_5, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 'smoothstep 中点与线性同值')
  assert.equal(got.minViewport, 0.6, '最小取景框决定底图预放大倍数')
})

test('帧缓存键：静止段相邻帧同键，推近段逐帧不同', () => {
  const got = run(`${S01}
    const key = t => frameKeyOf(frameStateAt(timeline, t))
    const pushIn = []
    for (let i = 0; i < 5; i++) pushIn.push(key(9 + i / 25))
    out({
      still: [key(7), key(7.04), key(7.08)],
      pushIn,
      distinctStill: new Set([key(7), key(7.04), key(7.08)]).size,
      distinctPushIn: new Set(pushIn).size,
    })
  `)
  assert.equal(got.distinctStill, 1, '静止段三帧同键 → 渲染器复用像素')
  assert.equal(got.distinctPushIn, 5, '推近段每帧取景框都不同')
})

test('时长钳制：图层段上限恒为 30 秒（与组合无关）', () => {
  const got = run(`out({
    max: MAX_LAYER_SEGMENT_MAX,
    long: clampSegmentDuration(42),
    short: clampSegmentDuration(0.1),
    nan: clampSegmentDuration(Number.NaN),
    rounded: clampSegmentDuration(6.4, MAX_LAYER_SEGMENT_MAX),
  })`)
  assert.equal(got.max, 30)
  assert.equal(got.long, 30)
  assert.equal(got.short, 1)
  assert.equal(got.nan, 1)
  assert.equal(got.rounded, 6.4)
})

test('末尾停留 end_hold 是派生值：duration − 末个关键帧 t（不设列）', () => {
  const got = run(`
    const timeline = normalizeTimeline({
      fps: 25,
      keyframes: [
        { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
        { t: 5.6, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['a'] },
      ],
    })
    out({
      hold: endHoldOf(timeline, 6),
      zero: endHoldOf(timeline, 5.6),
      beforeLast: endHoldOf(timeline, 4),
      atDuration: frameStateAt(timeline, 6).opacity,
      afterDuration: frameStateAt(timeline, 9).opacity,
    })
  `)
  assert.equal(got.hold, 0.4)
  assert.equal(got.zero, 0)
  assert.equal(got.beforeLast, 0, 'duration 比末帧还短时钳到 0')
  assert.deepEqual(got.atDuration, { a: 1 }, 'C 衔接帧取 t=duration 时是末尾停留的最终画面')
  assert.deepEqual(got.afterDuration, { a: 1 }, '超出段尾仍保持最终画面')
})

test('旧键名 states 兼容读入（一次性迁移与存量 JSON 列）', () => {
  const got = run(`
    const legacy = normalizeTimeline({ fps: 25, ease: 'linear', fade_ms: 400,
      states: [{ t: 0, visible: [] }, { t: 2, visible: ['x'] }] })
    out({ times: legacy.keyframes.map(f => f.t), visible: legacy.keyframes[1].visible, hasStates: 'states' in legacy })
  `)
  assert.deepEqual(got.times, [0, 2])
  assert.deepEqual(got.visible, ['x'])
  assert.equal(got.hasStates, false, '规范化输出只有 keyframes')
})

test('逐帧 ease / fade_ms 覆盖时间线级默认（契约 §3.2 PreciseKeyframe）', () => {
  const got = run(`
    const timeline = normalizeTimeline({
      fps: 25, ease: 'inout', fade_ms: 400,
      keyframes: [
        { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
        { t: 2, viewport: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, visible: ['a'], ease: 'linear', fade_ms: 0 },
      ],
    })
    out({
      mid: frameStateAt(timeline, 1).viewport,
      after: frameStateAt(timeline, 2).opacity,
      kept: timeline.keyframes[1].ease,
    })
  `)
  assert.deepEqual(got.mid, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, '该帧 ease=linear → 中点即线性中点')
  assert.deepEqual(got.after, { a: 1 }, 'fade_ms=0 → 到达时刻立刻全不透明')
  assert.equal(got.kept, 'linear')
})

test('cropped timelines keep rectangular WHOLE-image viewports while uncropped legacy frames remain square', () => {
  const got = run(`
    const crop = { x: 0, y: 0.125, w: 1, h: 0.75 }
    const viewport = { x: 0.2, y: 0.2, w: 0.4, h: 0.3 }
    const timeline = normalizeTimeline({ keyframes: [{ t: 0, viewport, visible: [] }, { t: 2, viewport: crop, visible: [] }] }, crop)
    out({
      rectangular: normalizeViewport(viewport, crop),
      legacy: normalizeViewport(viewport),
      frames: timeline.keyframes,
      held: frameStateAt(timeline, 8).viewport,
      hold: endHoldOf(timeline, 6),
    })
  `)
  assert.deepEqual(got.rectangular, { x: 0.2, y: 0.2, w: 0.4, h: 0.3 })
  assert.equal(got.legacy.w, got.legacy.h)
  assert.deepEqual(got.held, { x: 0, y: 0.125, w: 1, h: 0.75 })
  assert.equal(got.hold, 4)
})

test('frontend crop normalization and rectangular frame interpolation match backend', () => {
  const crop = { x: 0, y: 0.125, w: 1, h: 0.75 }
  const viewports = [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0.2, y: 0.2, w: 0.4, h: 0.3 },
    { x: 0.9, y: 0.9, w: 0.6, h: 0.45 },
    { x: 0.1, y: 0.1, w: 0.8, h: 0.3 },
    [0.2, 0.2, 0.6, 0.6],
    null,
  ]
  const got = run(`
    const crop = ${JSON.stringify(crop)}
    const viewports = ${JSON.stringify(viewports)}
    const timeline = normalizeTimeline({ fps: 25, ease: 'linear', fade_ms: 400, keyframes: [
      { t: 0, viewport: crop, visible: ['a'] },
      { t: 4, viewport: { x: 0.2, y: 0.275, w: 0.6, h: 0.45 }, visible: ['a', 'b'] },
    ] }, crop)
    out({
      cropped: viewports.map(viewport => normalizeViewport(viewport, crop)),
      legacy: viewports.map(viewport => normalizeViewport(viewport)),
      timeline,
      states: [-1, 0, 0.2, 2, 4, 4.2, 8].map(t => frameStateAt(timeline, t)),
    })
  `)
  viewports.forEach((viewport, i) => {
    assert.deepEqual(frontTimeline.normalizeViewport(viewport, crop), got.cropped[i], `cropped viewport ${i}`)
    assert.deepEqual(frontTimeline.normalizeViewport(viewport), got.legacy[i], `legacy viewport ${i}`)
  })
  ;[-1, 0, 0.2, 2, 4, 4.2, 8].forEach((t, i) => {
    assert.deepEqual(frontTimeline.frameStateAt(got.timeline, t), got.states[i], `rectangular interpolation at ${t}`)
  })
  assert.deepEqual(got.cropped[0], crop, 'full frame uses complete crop, not a centre square')
  assert.notEqual(got.states[3].viewport.w, got.states[3].viewport.h, 'midpoint remains rectangular')
})
