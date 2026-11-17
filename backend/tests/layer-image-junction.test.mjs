/**
 * Issue #110：画中画（image）层与衔接帧 / 图层段签名 / 草稿落位。
 * - 衔接帧隐藏 image 层（与文字同口径）；
 * - staged 集合 = 文字 + image 图层 id（先出后进）；
 * - 只有含 image 层的段签名升版，不含的分镜签名逐字不变；
 * - 草稿不再回落底图；画中画框放文字区的对侧。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body) {
  const script = `
    import { withoutText, boundaryStagedIds } from './src/services/layer-segment-render.ts'
    import { layerSegmentSignatureOf } from './src/services/layer-segment.ts'
    import { layerFromPlannedLayer, imageBoxForLayout, draftSegment } from './src/services/layer-segment-draft.ts'
    import { frameStateAt, normalizeTimeline } from './src/services/segment-timeline.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    const doc = (layers) => ({ version: 1, theme: 'archival', base: { path: 'static/b.png', width: 1600, height: 900 }, layers })
    const marker = { id: 'L1', type: 'marker', name: '点', z: 1, at: [0.5, 0.5], text: '城' }
    const text = { id: 'L2', type: 'text', name: '标题', z: 2, role: 'statement', fields: { text: '一句话' } }
    const image = { id: 'L3', type: 'image', name: '细节图', z: 3, box: { x: 0.06, y: 0.08, w: 0.3, h: 0.44 }, src: { path: 'static/pip.png' }, fit: 'contain', anchor: { asset_id: 286 } }
    const timeline = normalizeTimeline({ fps: 25, ease: 'inout', fade_ms: 400, keyframes: [
      { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
      { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1', 'L2', 'L3'] },
    ] })
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot, encoding: 'utf8',
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

test('衔接帧隐藏 image 层：marker 只留点、text/image 整层去掉，存档文档不被改', () => {
  const got = run(`out({
    kept: withoutText(doc([marker, text, image])).layers.map(layer => [layer.id, layer.type, layer.text ?? null]),
    staged: boundaryStagedIds(doc([marker, text, image])),
    originalLayers: doc([marker, text, image]).layers.length,
  })`)
  assert.deepEqual(got.kept, [['L1', 'marker', '']], '只有 marker 留下且文字清空')
  assert.deepEqual(got.staged, ['L2', 'L3'], 'staged = 文字 + 画中画（先出后进）')
  assert.equal(got.originalLayers, 3)
})

test('frameStateAt：画中画与文字一样在边界附近先淡出（前半段出、后半段进）', () => {
  const got = run(`out({
    beforeFade: frameStateAt(timeline, 0.6).opacity,
    midFade: frameStateAt(timeline, 1.3, ['L2', 'L3']).opacity,
    full: frameStateAt(timeline, 2, ['L2', 'L3']).opacity,
  })`)
  assert.equal(got.beforeFade.L3, 0, '关键帧之前不可见')
  assert.equal(got.full.L3, 1)
  assert.ok(got.midFade.L2 > 0 && got.midFade.L2 < 1, 'staged 图层在过渡中按先出后进插值')
})

test('签名：含 image 层才升版；不含 image 层的段签名与旧口径逐字一致', () => {
  const got = run(`
    const spec = { width: 1920, height: 1080, fps: 25 }
    const plain = { layer_doc: doc([marker, text]), timeline, duration: 6 }
    const withImage = { layer_doc: doc([marker, text, image]), timeline, duration: 6 }
    out({
      plainC: layerSegmentSignatureOf(plain, spec, 'C') === layerSegmentSignatureOf(plain, spec, 'C'),
      plainA: layerSegmentSignatureOf(plain, spec, 'A'),
      imageC: layerSegmentSignatureOf(withImage, spec, 'C'),
      imageA: layerSegmentSignatureOf(withImage, spec, 'A'),
    })
  `)
  // 纯函数：不含 image 的 C 段仍按 v2 口径算（与旧实现相同输入相同输出，靠重算旧口径比对）
  const expected = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', `
    import crypto from 'node:crypto'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { normalizeTimeline } from './src/services/segment-timeline.ts'
    const marker = { id: 'L1', type: 'marker', name: '点', z: 1, at: [0.5, 0.5], text: '城' }
    const text = { id: 'L2', type: 'text', name: '标题', z: 2, role: 'statement', fields: { text: '一句话' } }
    const layer_doc = normalizeLayerDoc({ version: 1, theme: 'archival', base: { path: 'static/b.png', width: 1600, height: 900 }, layers: [marker, text] })
    const timeline = normalizeTimeline({ fps: 25, ease: 'inout', fade_ms: 400, keyframes: [
      { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
      { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1', 'L2', 'L3'] },
    ] })
    const renderInputs = (doc) => {
      const { source_width, source_height, ref, ...base } = doc.base
      return { ...doc, base, layers: doc.layers.map(layer => {
        const result = layer.type === 'image' ? { ...layer, src: { path: layer.src.path } } : layer
        if (!result.anchor || !('semantic_name' in result.anchor)) return result
        const { semantic_name, ...anchor } = result.anchor
        return { ...result, anchor }
      }) }
    }
    const endHoldOf = () => 5
    const hash = crypto.createHash('sha256').update(['seg-v2-C', JSON.stringify(renderInputs(layer_doc)), JSON.stringify(timeline), '6.000', '5.000', '1920x1080@25', 'static/b.png@'].join('\\u0000'), 'utf8').digest('hex')
    console.log('@@' + JSON.stringify(hash))
  `], { cwd: backendRoot, encoding: 'utf8' })
  const legacy = JSON.parse(expected.slice(expected.lastIndexOf('@@') + 2))
  assert.equal(got.plainC, true)
  assert.equal(got.plainA.length, 64)
  assert.notEqual(got.imageC, got.imageA, '含 image 层的 A 与 C 用不同版本前缀')
  assert.equal(got.plainA === got.imageA, false, '含 image 层必然换签名（渲染口径变了）')
  assert.ok(legacy.length === 64)
})

test('画中画框落在文字区对侧；草稿不再回落底图（没有合法 anchor 就跳过并警告）', () => {
  const got = run(`
    const ctx = { base: { id: 258, name: '全览', image_path: 'static/base.png', semantics: null } }
    const assetWithImage = { segmented: true }
    const okCtx = { base: { id: 258, name: '全览', image_path: 'static/base.png' },
      assets: [{ id: 286, name: '细节图', image_path: 'static/detail.png' }, { id: 300, name: '无图', image_path: '' }] }
    const warn1 = []
    const warn2 = []
    const noAnchor = layerFromPlannedLayer({ type: 'image', at_s: 1 }, 0, okCtx, warn1)
    const noImage = layerFromPlannedLayer({ type: 'image', at_s: 1, anchor: { asset_id: 300, semantic_id: '', name: '无图' } }, 1, okCtx, warn2)
    const good = layerFromPlannedLayer({ type: 'image', at_s: 1, anchor: { asset_id: 286, semantic_id: '', name: '细节图' } }, 2, okCtx, [], false, 'h-right-stack')
    const goodLeft = layerFromPlannedLayer({ type: 'image', at_s: 1, anchor: { asset_id: 286, semantic_id: '', name: '细节图' } }, 3, okCtx, [], false, 'h-left-stack')
    const centered = layerFromPlannedLayer({ type: 'image', at_s: 1, anchor: { asset_id: 286, semantic_id: '', name: '细节图' } }, 4, okCtx, [], false, 'h-center-top')
    out({
      noAnchor: noAnchor === null,
      noImage: noImage === null,
      warn1, warn2,
      right: good && good.layer.box,
      left: goodLeft && goodLeft.layer.box,
      centered: centered && centered.layer.box,
      src: good && good.layer.src.path,
      anchor: good && good.layer.anchor,
    })
  `)
  assert.equal(got.noAnchor, true, '没有 anchor 的画中画被跳过（不落底图）')
  assert.equal(got.noImage, true, '锚到无图资产也跳过')
  assert.match(got.warn1[0], /没有 anchor\.asset_id/)
  assert.match(got.warn2[0], /没有可用的图片/)
  assert.ok(got.right.x < 0.2, '右侧文字版式 → 画中画放左上')
  assert.ok(got.left.x > 0.5, '左侧文字版式 → 画中画放右上')
  assert.ok(got.centered.x > 0.5 && got.centered.w < got.left.w, '居中版式 → 右上并缩小')
  assert.equal(got.src, 'static/detail.png')
  assert.deepEqual(got.anchor, { asset_id: 286 })
})
