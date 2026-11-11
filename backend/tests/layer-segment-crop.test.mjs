import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

test('R6 real metadata, persisted quality, stable legacy signature, and crop rendering stay whole-image', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'layer-crop-'))
  try {
    const script = `
      import fs from 'fs'
      import path from 'path'
      import crypto from 'crypto'
      import sharp from 'sharp'
      import { db, schema } from './src/db/index.ts'
      import { sql } from 'drizzle-orm'
      import { now } from './src/utils/response.ts'
      import { normalizeLayerDoc } from './src/services/layer-doc.ts'
      import { normalizeTimeline } from './src/services/segment-timeline.ts'
      import { saveLayerSegment, getLayerSegment, layerSegmentSignatureOf, withBaseSourceSize } from './src/services/layer-segment.ts'
      import { renderSegmentFrame } from './src/services/layer-segment-render.ts'
      import { renderLayerDoc } from './src/services/layer-render.ts'
      import { layerDocToSvg } from './src/services/layer-svg.ts'
      const staticDir = path.join(process.env.HUOBAO_DATA_DIR, 'static')
      fs.mkdirSync(staticDir, { recursive: true })
      const source = path.join(staticDir, 'base.png')
      const art = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="160" height="240" fill="#ff0000"/><rect x="160" width="160" height="240" fill="#0000ff"/><rect width="320" height="60" fill="#ffff00"/></svg>'
      await sharp(Buffer.from(art)).png().toFile(source)
      const hash = () => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')
      const initialHash = hash()
      const ts = now()
      const dramaId = Number(db.insert(schema.dramas).values({ title: 'Crop regression', aspectRatio: '4:3', projectType: 'documentary', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E1', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      const storyboardId = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, combo: 'A', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      // 签名口径按 4:3（= 源图比例）：比例一致的底图是 cover，签名不因量到源图尺寸而变
      const spec = { width: 1600, height: 1200, fps: 25 }
      const legacy = normalizeLayerDoc({ base: { path: 'static/base.png', width: 320, height: 240 }, layers: [] })
      const timeline = normalizeTimeline({ fade_ms: 0, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }] })
      const before = layerSegmentSignatureOf({ layer_doc: legacy, timeline, duration: 6 }, spec)
      const saved = await saveLayerSegment(storyboardId, { layer_doc: { ...legacy, base: { ...legacy.base, crop: { x: 0, y: 0, w: 1, h: 1 } } }, timeline, duration: 6 })
      const after = layerSegmentSignatureOf(saved, spec)
      const repeated = await saveLayerSegment(storyboardId, { layer_doc: saved.layer_doc, timeline: saved.timeline, duration: 6 })
      const crop = { x: 0.25, y: 0.125, w: 0.5, h: 0.375 }
      const cropped = await saveLayerSegment(storyboardId, {
        layer_doc: { ...legacy, base: { ...legacy.base, crop, source_width: 9999, source_height: 9999, ref: { asset_kind: 'prop', asset_id: 39, version_task_id: 21 } }, layers: [{ id: 'point', type: 'marker', at: [0.5, 0.3125], text: '', style: { color: '#00ff00', dot_radius: 0.03 } }] },
        timeline: { fade_ms: 0, keyframes: [{ t: 0, viewport: crop, visible: ['point'] }, { t: 5.6, viewport: crop, visible: ['point'] }] }, duration: 6,
      })
      const loaded = await getLayerSegment(storyboardId)
      const row = db.get(sql\`SELECT layer_doc, quality_warnings FROM storyboard_layer_segments WHERE storyboard_id = \${storyboardId}\`)
      const output = { width: 160, height: 90, fps: 25 }
      const segment = await renderSegmentFrame(cropped, output, 0)
      const still = await renderLayerDoc(cropped.layer_doc, output)
      const probes = async buffer => {
        const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        return [[10, 10], [10, 70], [150, 70], [80, 45]].map(([x, y]) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)])
      }
      const provenanceOnly = { ...saved, layer_doc: { ...saved.layer_doc, base: { ...saved.layer_doc.base, ref: { asset_kind: 'scene', asset_id: 8, version_task_id: 10 } } } }
      const imageLegacy = normalizeLayerDoc({ base: legacy.base, layers: [{ type: 'image', box: { x: 0, y: 0, w: 0.2, h: 0.2 }, src: { path: 'static/base.png' } }] })
      const imageRef = normalizeLayerDoc({ ...imageLegacy, layers: [{ ...imageLegacy.layers[0], src: { path: 'static/base.png', asset_kind: 'character', asset_id: 5, version_task_id: 9 } }] })
      const imageSignature = doc => layerSegmentSignatureOf({ layer_doc: doc, timeline, duration: 6 }, spec)
      await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ffffff' } }).png().toFile(path.join(staticDir, 'new.png'))
      const changedBase = await withBaseSourceSize({ ...saved.layer_doc, base: { ...saved.layer_doc.base, path: 'static/new.png' } })
      const clamped = await saveLayerSegment(storyboardId, { timeline: { fade_ms: 0, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['point'] }] } })
      console.log('@@' + JSON.stringify({
        stable: before === after && after === layerSegmentSignatureOf(repeated, spec),
        omitted: !('crop' in saved.layer_doc.base),
        metadata: [cropped.layer_doc.base.source_width, cropped.layer_doc.base.source_height],
        refreshed: [changedBase.base.source_width, changedBase.base.source_height],
        provenanceStable: after === layerSegmentSignatureOf(provenanceOnly, spec),
        imageProvenanceStable: imageSignature(imageLegacy) === imageSignature(imageRef),
        cropChangesSignature: after !== layerSegmentSignatureOf(cropped, spec),
        storedDoc: JSON.parse(row.layer_doc), storedWarnings: JSON.parse(row.quality_warnings),
        clampedViewport: clamped.timeline.keyframes[0].viewport,
        loaded, segmentPixels: await probes(segment), stillPixels: await probes(still.buffer),
        unchanged: initialHash === hash(),
        svg: layerDocToSvg(cropped.layer_doc, output),
        fullSvg: layerDocToSvg(cropped.layer_doc, { width: 320, height: 240 }, { viewport: { x: 0, y: 0, w: 1, h: 1 } }),
      }))
    `
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HUOBAO_DATA_DIR: dir, SQLITE_PATH: path.join(dir, 'crop.sqlite3'), STORAGE_PATH: path.join(dir, 'static') },
    })
    const result = JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
    assert.equal(result.stable, true, 'saving old uncropped docs with measured source dimensions must not alter signatures')
    assert.equal(result.omitted, true)
    assert.deepEqual(result.metadata, [320, 240], 'sharp metadata overrides supplied dimensions')
    assert.deepEqual(result.refreshed, [640, 480], 'base replacement refreshes even previously populated dimensions')
    assert.equal(result.provenanceStable, true)
    assert.equal(result.imageProvenanceStable, true)
    assert.equal(result.cropChangesSignature, true)
    assert.deepEqual(result.storedDoc.base.crop, { x: 0.25, y: 0.125, w: 0.5, h: 0.375 })
    // 读时只按裁切边界清洗（权威归一在保存/渲染/编辑器加载时按成片规格做）
    assert.deepEqual(result.loaded.timeline.keyframes[0].viewport, result.storedDoc.base.crop)
    assert.deepEqual(result.clampedViewport, { x: 0.25, y: 0.0625, w: 0.5, h: 0.5 }, 'saving old full-frame viewport under a new crop keeps the entire crop plus its letterbox band, not a centre square')
    assert.equal(result.loaded.end_hold, 0.4)
    assert.equal(result.storedWarnings.length, 2)
    assert.equal(result.loaded.quality_warnings[1].frame_index, 1)
    assert.equal(result.storedWarnings[0].effective_w, 160, 'crop must not multiply viewport resolution twice')
    assert.equal(result.storedWarnings[0].effective_h, 90)
    assert.equal(result.unchanged, true, 'crop never modifies source bytes')
    const expected = [[255, 255, 0], [255, 0, 0], [0, 0, 255], [0, 255, 0]]
    for (const pixels of [result.segmentPixels, result.stillPixels]) {
      pixels.forEach((color, i) => color.forEach((channel, axis) => assert.ok(Math.abs(channel - expected[i][axis]) < 24, `probe ${i}: ${color}`)))
    }
    assert.match(result.svg, /viewBox="80 30 160 90"/)
    assert.ok(!result.svg.includes('preserveAspectRatio="none"'), '#94：取景与成片同比例，矢量等比缩放')
    assert.match(result.fullSvg, /viewBox="0 0 320 240"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
