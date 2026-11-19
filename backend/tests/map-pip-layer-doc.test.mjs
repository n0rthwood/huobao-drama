/**
 * 画中画细节图的图层文档投影（Issue #127）。
 * 纯函数在 tsx 子进程里跑（与其它 map-studio 测试同口径）：可见性判据、几何不裁剪、注记转 label 层、
 * 渲染快照 render_key/文件名、以及投影文档能被 #117 读路径（buildMapAssetLayers）完整展开。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import {
    buildDetailEditableSource, detailLabelPlan, detailLocatorBox, pipDetailBaseName, pipDetailRenderKey, projectDetailLayerDoc,
  } from './src/modules/map-studio/pip/layer-doc.ts'
  import { buildMapAssetLayers, expandMapAssetLayers } from './src/services/map-asset-layers.ts'
  import { textRectsOf } from './src/modules/map-studio/layout/labels.ts'
  import { normalizeLayerDoc } from './src/services/layer-doc.ts'

  const SIZE = { width: 3840, height: 2160 }
  const FRAME = [32, 53, 40.5, 56.1]
  const dense = []
  for (let i = 0; i < 300; i++) dense.push([33 + i * 0.02, 54 + Math.sin(i / 4) * 0.04])
  const spec = {
    version: 1, projection: { type: 'mercator' }, bbox: [20, 42, 85, 64],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: false },
    places: [
      { id: 'p_moscow', name: '莫斯科', lon: 37.6, lat: 55.75 },
      { id: 'p_kazan', name: '喀山', lon: 49.1, lat: 55.8 },
    ],
    routes: [
      { id: 'r_oka', name: '奥卡河', points: [[34, 54.2], [36.5, 54.7], [39, 54.9]], dataset_ref: { ref: 'ne-group:10m_rivers_lake_centerlines:oka' } },
      { id: 'r_far', name: '远河', points: [[60, 50], [61, 51], [62, 51.5]], dataset_ref: { ref: 'ne-group:10m_rivers_lake_centerlines:far' } },
      { id: 'r_dense', name: '密集河', points: dense, category: 'river' },
      { id: 'r_cross', name: '穿越路线', points: [[30, 54], [33, 54.3], [36, 54.6], [42, 55]] },
    ],
    regions: [
      { id: 'g_big', name: '莫斯科公国', points: [[33, 53.2], [40, 53.2], [40, 55.8], [33, 55.8], [33, 53.2]] },
      { id: 'g_far', name: '喀山汗国', points: [[47, 54.5], [52, 54.5], [52, 56.5], [47, 56.5], [47, 54.5]] },
    ],
    style: { theme: 'clean' },
  }
  const base = { path: 'static/map-bases/pip-detail1-test.png', width: SIZE.width, height: SIZE.height, sha256: 'sha-base', render_key: 'rk' }
  const layerDoc = {
    version: 1, theme: 'clean',
    base: { path: 'static/map-bases/overview-bg.png', width: 3840, height: 2160 },
    layers: [
      { id: 'feature-r_oka', type: 'polyline', name: '奥卡河', anchor: { semantic_id: 'r_oka' }, points: [[0.1, 0.2], [0.3, 0.25]], style: { stroke: '#1f5f8b', width: 0.008 } },
      { id: 'feature-g_big', type: 'polygon', name: '莫斯科公国', anchor: { semantic_id: 'g_big' }, points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]], style: { fill_opacity: 0.23, feather: 0.023 } },
      { id: 'feature-p_moscow', type: 'marker', name: '莫斯科', anchor: { semantic_id: 'p_moscow' }, at: [0.5, 0.5], text: '莫斯科', style: { size: 0.0276 } },
      { id: 'feature-p_kazan', type: 'marker', name: '喀山', anchor: { semantic_id: 'p_kazan' }, at: [0.8, 0.2], text: '喀山', style: { size: 0.024 } },
      { id: 'feature-r_dense', type: 'polyline', name: '密集河', anchor: { semantic_id: 'r_dense' }, points: dense.slice(0, 240).map(([x, y]) => [(x - 20) / 65, (y - 42) / 22]), style: { width: 0.006 } },
      { id: 'feature-r_cross', type: 'polyline', name: '穿越路线', anchor: { semantic_id: 'r_cross' }, points: [[0.2, 0.5], [0.3, 0.5]], style: { dash: 'dash' } },
      { id: 'feature-unknown', type: 'polyline', name: '没有要素', anchor: { semantic_id: 'r_missing' }, points: [[0.2, 0.3], [0.3, 0.4]], style: {} },
      { id: 'detached-region', type: 'polygon', name: '人工解绑面', anchor: { semantic_id: 'g_big', detached: true }, points: [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3]], style: {} },
      { id: 'title', type: 'label', name: '标题', text: '金帐汗国分裂', box: { x: 0.05, y: 0.05, w: 0.3, h: 0.1 }, style: {} },
      { id: 'img', type: 'image', name: '配图', box: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, src: { path: 'static/x.png' }, fit: 'cover', style: {} },
      { id: 'card', type: 'card', name: '卡片', box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, template: 'year', fields: { title: '1480', sub: '', meta: '', years: '' }, style: {} },
      { id: 'tl', type: 'text', name: '模板文本', role: 'heading', fields: { title: '标题' } },
    ],
  }
  const plan = detailLabelPlan(spec, FRAME, SIZE, 'full', 768, true)
  const projected = projectDetailLayerDoc({ layer_doc: layerDoc, spec, frameBbox: FRAME, size: SIZE, base, notes: plan.notes })
  const doc = projected.layer_doc
  const byId = new Map(doc.layers.map(layer => [layer.id, layer]))

  const out = {}
  out.keptIds = doc.layers.map(layer => layer.id)
  out.stats = projected.stats
  out.base = doc.base
  out.theme = doc.theme

  // 几何不裁剪：密集河的 300 个点原样投影（归一化后可能越界）
  const denseLayer = byId.get('feature-r_dense')
  out.densePoints = denseLayer.points.length
  out.denseInFrame = denseLayer.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)
  // 穿越路线：四点到齐，首末点越界也被保留
  const cross = byId.get('feature-r_cross')
  out.crossPoints = cross.points.length
  out.crossOutOfFrame = cross.points.some(([x]) => x > 1)
  // 面：样式沿用（0.23 / 0.023）
  out.regionStyle = byId.get('feature-g_big').style
  // marker：只留圆点，名称交给 label 层
  const moscow = byId.get('feature-p_moscow')
  out.markerText = moscow.text
  out.markerAt = moscow.at
  // 注记 → 锚定 label 层
  const labels = doc.layers.filter(layer => layer.type === 'label')
  out.labelTexts = labels.map(layer => layer.text)
  out.labelAnchors = labels.map(layer => layer.anchor.semantic_id)
  out.labelSizes = labels.map(layer => Number(layer.style.size.toFixed(4)))
  out.notes = plan.notes.map(note => ({ id: note.semantic_id, name: note.name, kind: note.kind }))

  // 文字位置与烧录版一致：label 层渲染出的文字包围盒中心 ≈ pipLabels 的 rect 中心
  const rects = textRectsOf(normalizeLayerDoc(doc), SIZE)
  const rectById = new Map(rects.map(rect => [rect.layer_id, rect]))
  out.labelRects = labels.map(layer => ({ id: layer.id, text: layer.text, box: layer.box, size: layer.style.size, align: layer.style.align, rect: rectById.get(layer.id), note: plan.notes.find(note => note.semantic_id === layer.anchor.semantic_id && note.name === layer.text)?.rect }))
  out.labelDeltas = labels.map(layer => {
    const note = plan.notes.find(note => note.semantic_id === layer.anchor.semantic_id && note.name === layer.text)
    if (!note) return null
    const rect = rectById.get(layer.id)
    if (!rect) return null
    const dx = Math.abs((rect.x + rect.w / 2) - (note.rect[0] + note.rect[2]) / 2)
    const dy = Math.abs((rect.y + rect.h / 2) - (note.rect[1] + note.rect[3]) / 2)
    return { dx: Math.round(dx), dy: Math.round(dy), font: note.font }
  })

  // 渲染快照身份
  const key = pipDetailRenderKey(spec, FRAME, SIZE)
  out.keyStable = key === pipDetailRenderKey(JSON.parse(JSON.stringify(spec)), FRAME, SIZE)
  out.keySize = pipDetailRenderKey(spec, FRAME, { width: 1920, height: 1080 }) !== key
  out.keyBbox = pipDetailRenderKey(spec, [32, 53, 40.6, 56.1], SIZE) !== key
  out.keySpec = pipDetailRenderKey({ ...spec, places: [{ id: 'p_moscow', name: '莫斯科城', lon: 37.6, lat: 55.75 }] }, FRAME, SIZE) !== key
  out.baseName = pipDetailBaseName(1, key)
  out.baseNameAgain = pipDetailBaseName(1, key)
  out.baseNameOther = pipDetailBaseName(2, key)
  out.locator = detailLocatorBox(SIZE, 768)

  // #117 读路径完整展开：map: 前缀、锚定 id、样式烘焙、>240 点不截断
  const asset = buildMapAssetLayers({ asset_id: 99, asset_name: '细节1', version_task_id: 5, doc, options: null })
  out.expanded = asset.layers.map(layer => ({ id: layer.id, type: layer.type, anchor: layer.anchor.semantic_id, points: layer.points ? layer.points.length : 0, fill: layer.style.fill_opacity, locked: layer.locked, from: layer.from_asset.layer_id }))
  const expandedDoc = expandMapAssetLayers(normalizeLayerDoc({ ...doc, layers: [] }), asset)
  out.expandedBase = expandedDoc.base.path

  // 60 层上限：几何优先、注记随后
  const manyNotes = Array.from({ length: 70 }, (_, i) => ({ semantic_id: 'n' + i, name: '注记' + i, kind: 'place', rect: [10 + i, 10, 110 + i, 50], font: 36, bold: false, italic: false, align: 'left' }))
  const capped = projectDetailLayerDoc({ layer_doc: layerDoc, spec, frameBbox: FRAME, size: SIZE, base, notes: manyNotes })
  out.cap = { layers: capped.layer_doc.layers.length, labels: capped.stats.labels, truncated: capped.stats.truncated }

  // 交付入口：editable_source 三件套共享同一 render_key
  const editable = buildDetailEditableSource({ spec, layer_doc: layerDoc, layer_options: { 'feature-g_big': { smooth: 0 } }, frame: { no: 1, bbox: FRAME }, size: SIZE, base: { ...base, render_key: key }, tier: 'full', locatorWidth: 768, withLocator: true })
  out.editable = { key: editable.render_key, base: editable.base_image, options: editable.layer_options, layers: editable.layer_doc.layers.length, source: editable.source, frame: editable.frame_no }
  out.editableBasePath = editable.layer_doc.base.path
  console.log('@@' + JSON.stringify(out))
`

test('细节投影：可见性判据、几何不裁剪、注记转锚定 label 层、渲染快照与 #117 展开', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-pip-layer-doc-'))
  try {
    const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', timeout: 120000, env: { ...process.env, HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    const out = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    // 保留：三个锚定几何层 + 注记 label 层；丢弃：框外地点/河流/面、没有要素的层、解绑层、未锚定文字/图片/卡片/模板文本
    assert.deepEqual(out.keptIds.filter(id => !id.startsWith('pip-label-')), ['feature-r_oka', 'feature-g_big', 'feature-p_moscow', 'feature-r_dense', 'feature-r_cross'])
    assert.equal(out.stats.geometry_kept, 5)
    assert.equal(out.stats.geometry_dropped, 3)
    assert.deepEqual(out.base, { path: 'static/map-bases/pip-detail1-test.png', width: 3840, height: 2160, source_width: 3840, source_height: 2160 })
    assert.equal(out.theme, 'clean')

    assert.equal(out.densePoints, 300, '几何不裁剪：数据集河的 300 个点全部保留')
    assert.equal(out.crossPoints, 4, '穿越路线首末点越界也保留')
    assert.equal(out.denseInFrame, true, '画内要素的坐标全部落在 [0,1]')
    assert.equal(out.crossOutOfFrame, true, '几何不裁剪：越界端点不被裁回画布')
    assert.deepEqual(out.regionStyle, { fill_opacity: 0.23, feather: 0.023 }, '区域画法沿用全览（0.23 / feather 0.023）')

    assert.equal(out.markerText, '', 'marker 不再写字，名称由 label 层承载')
    const at = out.markerAt
    assert.ok(at[0] > 0 && at[0] < 1 && at[1] > 0 && at[1] < 1, '莫斯科投影落在画布内')

    // 注记：框内的区域名/地点名/河名都转成锚定 label 层；框外地点没有注记
    assert.ok(out.labelTexts.includes('莫斯科公国'))
    assert.ok(out.labelTexts.includes('莫斯科'))
    assert.ok(!out.labelTexts.includes('喀山'), '框外地点不产生注记')
    assert.ok(!out.labelTexts.includes('远河'), '框外河流不产生注记')
    for (const anchor of out.labelAnchors) assert.ok(anchor && anchor.length > 0, '每条注记都锚定到语义要素')
    for (const size of out.labelSizes) assert.ok(size > 0.01 && size < 0.1, '字号是输出高度比例')
    const kinds = out.notes.map(note => note.kind)
    for (const kind of ['place', 'region', 'river']) assert.ok(kinds.includes(kind), `注记含 ${kind}`)

    // 展开后的文字位置 ≈ 烧录版（偏差在半个字高内）
    for (const delta of out.labelDeltas) {
      assert.ok(delta, '每条注记都有渲染矩形')
      assert.ok(delta.dx <= delta.font * 0.5 + 2, `横向偏差 ${delta.dx}px ≤ 半字高`)
      assert.ok(delta.dy <= delta.font * 0.5 + 2, `纵向偏差 ${delta.dy}px ≤ 半字高`)
    }

    // 渲染快照：同输入同 key；尺寸/取景/几何变化都换 key；文件名内容寻址
    assert.equal(out.keyStable, true)
    assert.equal(out.keySize, true)
    assert.equal(out.keyBbox, true)
    assert.equal(out.keySpec, true)
    assert.match(out.baseName, /^pip-detail1-[0-9a-f]{32}\.png$/)
    assert.equal(out.baseName, out.baseNameAgain)
    assert.notEqual(out.baseName, out.baseNameOther)
    assert.deepEqual(out.locator, { margin: 40, width: 768, height: 432, rect: [26, 1674, 822, 2134] })

    // #117 读路径：全部层带 map: 前缀、只读、锚定 id 保留、样式按主题烘焙、300 点不截断
    const expandedDense = out.expanded.find(layer => layer.from === 'feature-r_dense')
    assert.equal(expandedDense.points, 300)
    for (const layer of out.expanded) {
      assert.match(layer.id, /^map:/)
      assert.equal(layer.locked, true)
      assert.ok(layer.anchor)
    }
    const expandedRegion = out.expanded.find(layer => layer.from === 'feature-g_big')
    assert.equal(expandedRegion.fill, 0.23, '资产样式优先于主题预设')
    assert.equal(out.expandedBase, 'static/map-bases/pip-detail1-test.png', '展开后底图换成细节底图')

    // 60 层上限：几何优先、注记截断
    assert.equal(out.cap.layers, 60)
    assert.equal(out.cap.labels, 55)
    assert.equal(out.cap.truncated, true)

    // 交付入口：底图/文档/版本共享 render_key
    assert.equal(out.editable.source, 'pip-detail')
    assert.ok(out.baseName.startsWith(`pip-detail1-${out.editable.key.slice(0, 32)}`), 'editable_source.render_key 与底图文件名同源')
    assert.equal(out.editable.base.path, 'static/map-bases/pip-detail1-test.png')
    assert.deepEqual(out.editable.options, { 'feature-g_big': { smooth: 0 } })
    assert.equal(out.editable.frame, 1)
    assert.ok(out.editable.layers > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
