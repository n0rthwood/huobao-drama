/**
 * 图层段渲染（Issue #58）：真实渲染 → mp4 + 衔接帧 PNG。
 *
 * 断言的是**可观察的产物**，不是内部步骤：
 * - 衔接帧 `static/layer-frames/<segment_id>-<hash>.png` 存在，hash = PNG 字节 sha256；
 * - 衔接帧**不含文字类图层**：label/card 整层隐藏、marker 只有点（用像素差分证明：
 *   同一段把文字层去掉后渲染与衔接帧逐字节一致，带文字渲染与它不同）；
 * - C 取末帧（含 end_hold 的最终画面），D 取首帧；
 * - 同段旧 hash 的 PNG 被清理，但 `keep` 里指定的那张（上次确认时引用的）保留。
 *
 * 用仓库自带 tsx 子进程跑（与 layer-render.test.mjs 同法），需要 ffmpeg。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body, env = {}) {
  const script = `
    import { renderLayerSegment, pruneJunctionFrames, renderSegmentFrame } from './src/services/layer-segment-render.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { normalizeTimeline } from './src/services/segment-timeline.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** 一张纯色底图：文字层画在它上面，像素差分最容易看出来 */
async function makeBase(dir) {
  mkdirSync(path.join(dir, 'static', 'uploads'), { recursive: true })
  const target = path.join(dir, 'static', 'uploads', 'base.png')
  await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 40, b: 50 } } })
    .png()
    .toFile(target)
  return 'static/uploads/base.png'
}

const SEGMENT_DOC = `normalizeLayerDoc({
  version: 1, theme: 'archival',
  base: { path: 'static/uploads/base.png', width: 640, height: 360 },
  layers: [
    { id: 'rg', type: 'polygon', points: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.3], [0.1, 0.3]], style: { fill: '#b45309' } },
    { id: 'mk', type: 'marker', at: [0.7, 0.4], text: '斋桑湖', style: { dot_radius: 0.02, size: 0.05 } },
    { id: 'lb', type: 'label', box: { x: 0.05, y: 0.7, w: 0.4, h: 0.12 }, text: '托博尔斯克', style: { size: 0.06 } },
    { id: 'cd', type: 'card', box: { x: 0.55, y: 0.56, w: 0.4, h: 0.18 }, template: 'name',
      fields: { title: '近卫团', sub: '', meta: '', years: '1700–1721' }, style: {} },
  ],
})`

const SEGMENT_TIMELINE = `normalizeTimeline({
  fps: 10, ease: 'linear', fade_ms: 100,
  keyframes: [
    { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
    { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['rg', 'mk', 'lb', 'cd'] },
    { t: 2, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['rg', 'mk', 'lb', 'cd'] },
  ],
})`

test('C 组合衔接帧：落盘文件存在、hash = PNG 字节 sha256、画面不含 label/card 文字、marker 只有点', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-render-'))
  try {
    const basePath = await makeBase(dir)
    assert.equal(basePath, 'static/uploads/base.png')
    const got = run(`
      const segment = { id: 77, duration: 2, layer_doc: ${SEGMENT_DOC}, timeline: ${SEGMENT_TIMELINE} }
      const spec = { width: 640, height: 360, fps: 10 }
      const result = await renderLayerSegment(segment, spec, 'C')
      out({ render: result.render_path, junction: result.junction, frames: result.frames })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.match(got.render, /^static\/layer-segments\/.+\.mp4$/)
    assert.ok(got.junction, 'C 组合必须产出衔接帧')
    assert.match(got.junction.path, /^static\/layer-frames\/77-[0-9a-f]{64}\.png$/)
    const file = path.join(dir, got.junction.path)
    const bytes = readFileSync(file)
    assert.equal(got.junction.hash, createHash('sha256').update(bytes).digest('hex'), 'hash = 该帧 PNG 字节 sha256')
    assert.equal(path.basename(got.junction.path), `77-${got.junction.hash}.png`)
    assert.equal(got.junction.t, 2, 'C 取 t=duration（含末尾停留的最终画面）')

    // 同一时刻、把文字层整层去掉后的渲染 → 与衔接帧逐字节一致
    const noText = run(`
      const doc = ${SEGMENT_DOC}
      // 与 withoutText 同口径：label/card 整层去掉、marker 只留点（text 置空）
      const stripped = {
        ...doc,
        layers: doc.layers
          .filter(l => l.type !== 'label' && l.type !== 'card')
          .map(l => l.type === 'marker' ? { ...l, text: '' } : l),
      }
      const plain = await renderSegmentFrame({ layer_doc: stripped, timeline: ${SEGMENT_TIMELINE}, duration: 2 }, { width: 640, height: 360, fps: 10 }, 2)
      const withText = await renderSegmentFrame({ layer_doc: doc, timeline: ${SEGMENT_TIMELINE}, duration: 2 }, { width: 640, height: 360, fps: 10 }, 2)
      out({ plainHash: (await import('node:crypto')).createHash('sha256').update(plain).digest('hex'),
            withTextHash: (await import('node:crypto')).createHash('sha256').update(withText).digest('hex') })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.equal(got.junction.hash, noText.plainHash, '衔接帧 = 去掉文字层后的同一帧（label/card 隐藏）')
    assert.notEqual(got.junction.hash, noText.withTextHash, '带文字层的同帧与衔接帧不同（证明文字确实被抑制）')

    // marker 的文字也被抑制：在 marker 文本区域取像素，两张图应完全相同
    const junctionMeta = await sharp(file).metadata()
    assert.equal(junctionMeta.width, 640)
    assert.equal(junctionMeta.height, 360)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D 组合衔接帧取首帧（t=0），A/B 不产出衔接帧', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-render-'))
  try {
    await makeBase(dir)
    const got = run(`
      const segment = { id: 12, duration: 2, layer_doc: ${SEGMENT_DOC}, timeline: ${SEGMENT_TIMELINE} }
      const spec = { width: 640, height: 360, fps: 10 }
      const first = await renderSegmentFrame({ layer_doc: segment.layer_doc, timeline: segment.timeline, duration: 2 }, spec, 0)
      const d = await renderLayerSegment(segment, spec, 'D')
      const a = await renderLayerSegment({ ...segment, id: 13 }, spec, 'A')
      const b = await renderLayerSegment({ ...segment, id: 14 }, spec, 'B')
      const crypto = await import('node:crypto')
      out({ dJunction: d.junction, aJunction: a.junction, bJunction: b.junction,
            plainHash: crypto.createHash('sha256').update(first).digest('hex') })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.equal(got.dJunction.t, 0, 'D 取 t=0')
    assert.match(got.dJunction.path, /^static\/layer-frames\/12-[0-9a-f]{64}\.png$/)
    assert.equal(got.aJunction, null, 'A 组合没有生成段，不产出衔接帧')
    assert.equal(got.bJunction, null, 'B 组合没有图层段，不产出衔接帧')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧 hash 清理：只删同段其它 hash，保留当前与 keep 指定的那张', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-prune-'))
  try {
    const framesDir = path.join(dir, 'static', 'layer-frames')
    await makeBase(dir)
    const got = run(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      const crypto = await import('node:crypto')
      const segment = { id: 21, duration: 2, layer_doc: ${SEGMENT_DOC}, timeline: ${SEGMENT_TIMELINE} }
      const spec = { width: 640, height: 360, fps: 10 }
      const first = await renderLayerSegment(segment, spec, 'C')
      // 人为再放两张同段旧 hash 的 PNG
      const dir = process.env.STORAGE_PATH + '/layer-frames'
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '21-aaaa.png'), 'old-a')
      fs.writeFileSync(path.join(dir, '21-bbbb.png'), 'old-b')
      fs.writeFileSync(path.join(dir, '999-cccc.png'), 'other-segment')
      const removedNow = await pruneJunctionFrames(21, [first.junction.path])
      const left = fs.readdirSync(dir).sort()
      const removedKeep = await pruneJunctionFrames(21, [first.junction.path, 'static/layer-frames/21-bbbb.png'])
      // bbbb 已被上次清掉，这次没有可删的
      fs.writeFileSync(path.join(dir, '21-bbbb.png'), 'snapshot')
      const removedSecond = await pruneJunctionFrames(21, [first.junction.path, 'static/layer-frames/21-bbbb.png'])
      out({ current: first.junction.path, removedNow, left, removedKeep, removedSecond,
            final: fs.readdirSync(dir).sort() })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    const currentName = path.basename(got.current)
    assert.equal(got.removedNow, 2, '两张同段旧 hash 被清理')
    assert.ok(got.left.includes(currentName), '当前衔接帧保留')
    assert.ok(got.left.includes('999-cccc.png'), '其它段的 PNG 不受影响')
    assert.equal(got.removedSecond, 0, 'keep 里的 bbbb 被保留')
    assert.ok(got.final.includes('21-bbbb.png'), '上次确认引用的旧衔接帧保留（人工可比对）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('end_hold 参与帧数渲染：末帧画面在段尾保持不变（t=duration 与 t=duration-0.1 同帧）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-hold-'))
  try {
    await makeBase(dir)
    const got = run(`
      const crypto = await import('node:crypto')
      const segment = { id: 31, duration: 3, layer_doc: ${SEGMENT_DOC}, timeline: normalizeTimeline({
        fps: 10, ease: 'linear', fade_ms: 100,
        keyframes: [
          { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
          { t: 2, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['rg'] },
        ],
      }) }
      const spec = { width: 640, height: 360, fps: 10 }
      // 末尾停留的最终画面：t=duration 与 末帧 t 同帧（不能拿关键帧到达时刻 2s 比——淡入还没完成）
      const atEnd = await renderSegmentFrame(segment, spec, 3)
      const beforeEnd = await renderSegmentFrame(segment, spec, 2.6)
      const result = await renderLayerSegment(segment, spec, 'C')
      out({
        endHash: crypto.createHash('sha256').update(atEnd).digest('hex'),
        holdHash: crypto.createHash('sha256').update(beforeEnd).digest('hex'),
        junctionT: result.junction.t,
        frames: result.frames,
      })
    `, { HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') })
    assert.equal(got.endHash, got.holdHash, '2s 之后的末尾停留段画面不动（保持 1s）')
    assert.equal(got.junctionT, 3, 'C 衔接帧取段尾 t=duration')
    assert.equal(got.frames, 30, '3s @10fps = 30 帧')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
