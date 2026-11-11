/**
 * Issue #94：底图比例与成片不符时 contain 留白渲染，**任何情况下不拉伸**。
 * - 源图里的圆在成片里仍是圆（逐像素量外接框），静帧与图层段单帧都测；
 * - 留白带铺的是「同图放大模糊」，不是黑边；
 * - 比例一致、无裁切的 cover 文档与改动前逐像素一致（在测试内重算旧管线对照）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'layer-contain-'))

const script = `
  import fs from 'fs'
  import path from 'path'
  import sharp from 'sharp'
  import { renderLayerDoc } from './src/services/layer-render.ts'
  import { renderSegmentFrame, renderBaseFramePng } from './src/services/layer-segment-render.ts'
  import { normalizeLayerDoc } from './src/services/layer-doc.ts'
  import { normalizeTimeline } from './src/services/segment-timeline.ts'
  import { baseFilterLayers, layerDocToSvg } from './src/services/layer-svg.ts'

  const staticDir = path.join(process.env.HUOBAO_DATA_DIR, 'static')
  fs.mkdirSync(staticDir, { recursive: true })
  // 800×400 的横图：左红右蓝 + 左四分之一处一个绿圆（半径 100 源图像素）。
  // 圆放在偏左处，放大后的模糊垫底会把它推出画布，所以量到的绿色只可能来自清晰的底图带。
  const wide = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">'
    + '<rect width="400" height="400" fill="#ff0000"/><rect x="400" width="400" height="400" fill="#0000ff"/>'
    + '<circle cx="200" cy="200" r="100" fill="#00ff00"/></svg>'
  await sharp(Buffer.from(wide)).png().toFile(path.join(staticDir, 'wide.png'))
  const cover = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="544">'
    + '<rect width="960" height="544" fill="#884422"/><circle cx="480" cy="272" r="120" fill="#22aa66"/></svg>'
  await sharp(Buffer.from(cover)).png().toFile(path.join(staticDir, 'cover.png'))

  const spec = { width: 544, height: 960, fps: 25 }
  const containDoc = normalizeLayerDoc({
    version: 1, theme: 'clean',
    base: { path: 'static/wide.png', width: spec.width, height: spec.height, source_width: 800, source_height: 400 },
    layers: [],
  })
  const timeline = normalizeTimeline({ fps: 25, fade_ms: 0, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }] })

  const measure = async (buffer) => {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]
    let minX = info.width, maxX = -1, minY = info.height, maxY = -1
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const [r, g, b] = at(x, y)
        if (g > 140 && r < 110 && b < 110) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    return {
      size: [info.width, info.height],
      circle: { w: maxX - minX + 1, h: maxY - minY + 1, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 },
      bandLeft: at(40, 20), bandRight: at(500, 20), bandCentre: at(272, 20),
      imageLeft: at(40, 480), imageRight: at(500, 480),
    }
  }

  const still = await renderLayerDoc(containDoc, { width: spec.width, height: spec.height })
  const segmentFrame = await renderSegmentFrame({ layer_doc: containDoc, timeline, duration: 2 }, spec, 0)
  const baseFrame = await renderBaseFramePng(containDoc, spec)

  // cover 回归：改动前的管线（整图 resize + 滤镜 + 叠加层，一条 sharp 管线）在测试里重算
  const coverDoc = normalizeLayerDoc({
    version: 1, theme: 'archival',
    base: { path: 'static/cover.png', width: 960, height: 544, source_width: 960, source_height: 544,
      filter: { paper: 0.16, tint: 'sepia', tint_strength: 0.18, vignette: 0.28 } },
    layers: [{ id: 'L1', type: 'label', name: 'a', z: 1, box: { x: 0.1, y: 0.1, w: 0.4, h: 0.12 }, text: '不拉伸' }],
  })
  const size = { width: 960, height: 544 }
  const coverNew = await renderLayerDoc(coverDoc, size)
  const coverSvg = layerDocToSvg(coverDoc, size, {})
  const legacy = await sharp(path.join(staticDir, 'cover.png'))
    .resize(size.width, size.height, { fit: 'fill' })
    .composite([
      ...baseFilterLayers(coverDoc.base.filter, size).map(layer => ({ input: Buffer.from(layer.svg) })),
      { input: Buffer.from(coverSvg) },
    ])
    .png().toBuffer()
  const rawOf = async (buffer) => (await sharp(buffer).removeAlpha().raw().toBuffer()).toString('base64')

  console.log('@@' + JSON.stringify({
    still: await measure(still.buffer),
    segment: await measure(segmentFrame),
    baseFrameSize: await sharp(baseFrame).metadata().then(m => [m.width, m.height]),
    coverIdentical: (await rawOf(coverNew.buffer)) === (await rawOf(legacy)),
  }))
`

const result = (() => {
  try {
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HUOBAO_DATA_DIR: dir, SQLITE_PATH: path.join(dir, 'contain.sqlite3'), STORAGE_PATH: path.join(dir, 'static') },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

for (const [name, probe] of [['静帧', 'still'], ['图层段单帧', 'segment']]) {
  test(`${name}：800×400 底图在 544×960 成片里 contain，圆仍然是圆`, () => {
    const got = result[probe]
    assert.deepEqual(got.size, [544, 960])
    const { w, h } = got.circle
    assert.ok(w > 100 && h > 100, `圆太小或没画出来：${w}×${h}`)
    assert.ok(Math.abs(w / h - 1) < 0.03, `圆被拉伸成 ${w}×${h}`)
    assert.ok(Math.abs(got.circle.cx - 136) < 6 && Math.abs(got.circle.cy - 480) < 6, `底图等比落位：圆心 ${got.circle.cx},${got.circle.cy}`)
  })

  test(`${name}：留白带是同图放大模糊，不是黑边`, () => {
    const got = result[probe]
    const sum = c => c[0] + c[1] + c[2]
    assert.ok(sum(got.bandLeft) > 60, `留白带不能是黑边：${got.bandLeft}`)
    assert.ok(got.bandLeft[0] > got.bandLeft[2], `左侧留白承接红色半边：${got.bandLeft}`)
    assert.ok(got.bandRight[2] > got.bandRight[0], `右侧留白承接蓝色半边：${got.bandRight}`)
    assert.ok(got.bandCentre[0] > 25 && got.bandCentre[2] > 25, `红蓝交界在留白里被模糊混合：${got.bandCentre}`)
    assert.ok(got.imageLeft[0] > 180 && got.imageLeft[2] < 90, `图像带里仍是清晰的红：${got.imageLeft}`)
  })
}

test('renderBaseFramePng 输出正好是成片尺寸的无字取景框画面', () => {
  assert.deepEqual(result.baseFrameSize, [544, 960])
})

test('cover 文档（比例一致、无裁切）与改动前逐像素一致', () => {
  assert.equal(result.coverIdentical, true)
})
