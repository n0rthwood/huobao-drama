/**
 * 确定性片段时间线（Issue #50）纯函数：规范化、取景框不变量、逐帧插值、帧缓存键。
 * 纯 TS 模块，用仓库自带 tsx 子进程跑并以 JSON 回传（与 layer-svg.test.mjs 同法）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import {
      normalizeTimeline, normalizeViewport, viewportFromPoints, frameStateAt, frameCount,
      frameKeyOf, minViewportSize, timelineLayerIds, clampClipDuration, MAX_CLIP_SECONDS,
    } from './src/services/clip-timeline.ts'
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
    states: [
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
      states: [{ t: 5, visible: ['b'] }, { t: 1, visible: ['a'] }, { t: 5, visible: ['c'] }],
    })
    const empty = normalizeTimeline(null)
    out({
      fps: sorted.fps, fade: sorted.fade_ms, ease: sorted.ease,
      times: sorted.states.map(s => s.t),
      lastVisible: sorted.states[sorted.states.length - 1].visible,
      emptyStates: empty.states.length,
      emptyViewport: empty.states[0].viewport,
      emptyVisible: empty.states[0].visible,
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
      frames: frameCount(timeline, 15),
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

test('时长钳制：replace 上限 30 秒，含模型视频的镜头仍是 15 秒', () => {
  const got = run(`out({
    max: MAX_CLIP_SECONDS,
    replace: clampClipDuration(42, MAX_CLIP_SECONDS),
    prePost: clampClipDuration(42, 15),
    tooShort: clampClipDuration(0.1, MAX_CLIP_SECONDS),
    nan: clampClipDuration(Number.NaN, MAX_CLIP_SECONDS),
  })`)
  assert.equal(got.max, 30)
  assert.equal(got.replace, 30)
  assert.equal(got.prePost, 15)
  assert.equal(got.tooShort, 1)
  assert.equal(got.nan, 1)
})
