/**
 * 地图资产底图的图层段复用资产自己的图层（Issue #117）。
 * 纯函数（资产文档 → 展开层、写时转换）+ 真实 SQLite 临时库（读时展开、PUT 忽略资产层、存量迁移、缺底图）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(script, root) {
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static') },
  })
  return JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
}

// 资产图层文档：一个要素（路线）两层（线 + 标注）、一个地点、两个未锚定层（标题、河名文字）
const ASSET_DOC = {
  version: 1,
  theme: 'archival',
  base: { path: 'static/map-bg.png', width: 3840, height: 2160 },
  layers: [
    { id: 'l_title', type: 'label', z: 9, box: { x: 0.03, y: 0.03, w: 0.5, h: 0.06 }, text: '图题' },
    { id: 'l_route', type: 'polyline', z: 2, points: [[0.1, 0.5], [0.3, 0.6], [0.6, 0.55]], anchor: { semantic_id: 'r_route', semantic_name: '路线' }, style: { stroke: '#b23a1f', dash: 'none' } },
    { id: 'l_ridge', type: 'polyline', z: 1, points: [[0.4, 0.1], [0.42, 0.9]], anchor: { semantic_id: 'r_ridge' }, style: { stroke: '#8a6f4e', dash: 'dot' } },
    { id: 'l_route_label', type: 'label', z: 3, box: { x: 0.3, y: 0.62, w: 0.2, h: 0.05 }, text: '远征路线', anchor: { semantic_id: 'r_route' } },
    { id: 'm_camp', type: 'marker', z: 4, at: [0.35, 0.8], text: '冬营地', anchor: { semantic_id: 'p_camp' }, style: { color: '#7a1f12' } },
    { id: 'T_river', type: 'label', z: 5, box: { x: 0.7, y: 0.2, w: 0.1, h: 0.04 }, text: '额尔齐斯河' },
  ],
}

test('资产文档展开：只带锚定要素层、样式按资产主题烘焙、只读标记、超 240 点不截断、按 layer_options 平滑', () => {
  const root = mkdtempSync(join(tmpdir(), 'map-asset-layers-pure-'))
  try {
    const result = run(`
      import { buildMapAssetLayers, mapLayerIdsBySemantic, expandMapAssetLayers, adoptMapAssetLayers } from './src/services/map-asset-layers.ts'
      import { normalizeLayerDoc } from './src/services/layer-doc.ts'
      import { withoutText } from './src/services/layer-segment-render.ts'
      const assetDoc = ${JSON.stringify(ASSET_DOC)}
      const dense = Array.from({ length: 600 }, (_, i) => [i / 600, 0.3 + 0.1 * Math.sin(i / 40)])
      assetDoc.layers.push({ id: 'feature-r_dense', type: 'polyline', z: 6, points: dense, anchor: { semantic_id: 'r_dense' } })
      assetDoc.layers.push({ id: 'feature-r_smooth', type: 'polyline', z: 7, points: [[0.1, 0.1], [0.2, 0.3], [0.3, 0.1], [0.4, 0.3]], anchor: { semantic_id: 'r_smooth' } })
      const asset = buildMapAssetLayers({ asset_id: 259, asset_name: '地图', version_task_id: 3044, doc: assetDoc, options: { 'feature-r_smooth': { smooth: 1 } } })
      const ids = asset.layers.map(layer => layer.id)
      const route = asset.layers.find(layer => layer.id === 'map:l_route')
      const ridge = asset.layers.find(layer => layer.id === 'map:l_ridge')
      const groups = Object.fromEntries(mapLayerIdsBySemantic(asset))
      // 段：自己的模板文本框 + 旧的按语义重画层（锚定底图资产）+ 解除锚点的人工层 + 资产里不存在的要素
      const seg = normalizeLayerDoc({ base: { path: 'static/faithful.png', width: 960, height: 544, filter: { paper: 0.16, tint: 'sepia' } }, theme: 'archival', layers: [
        { id: 'L1', type: 'text', role: 'date', fields: { main: '1581年' }, z: 1 },
        { id: 'L2', type: 'polyline', z: 2, points: [[0, 0], [1, 1]], anchor: { asset_id: 259, semantic_id: 'r_route' }, style: { arrow_end: true } },
        { id: 'L3', type: 'marker', z: 3, at: [0.2, 0.2], anchor: { asset_id: 259, semantic_id: 'p_camp' } },
        { id: 'L4', type: 'marker', z: 4, at: [0.5, 0.5], anchor: { asset_id: 259, semantic_id: 'p_gone' } },
        { id: 'L5', type: 'marker', z: 5, at: [0.6, 0.6], anchor: { asset_id: 259, semantic_id: 'p_camp', detached: true } },
        { id: 'map:l_route', type: 'polyline', z: 6, points: [[0, 0], [0.9, 0.9]], style: { stroke: '#00ff00' } },
      ] })
      const timeline = { fps: 25, keyframes: [
        { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] },
        { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1', 'L2'] },
        { t: 2, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1', 'L2', 'L3', 'L4', 'map:l_gone'] },
      ] }
      const adopted = adoptMapAssetLayers(seg, timeline, asset)
      const expanded = expandMapAssetLayers(adopted.doc, asset)
      const junction = withoutText(expanded)
      console.log('@@' + JSON.stringify({
        ids, groups,
        routeStyle: route.style, ridgeStyle: { dash: ridge.style.dash, width: ridge.style.width },
        routeMeta: { locked: route.locked, from_asset: route.from_asset, anchor: route.anchor },
        densePoints: asset.layers.find(layer => layer.id === 'map:feature-r_dense').points.length,
        smoothPoints: asset.layers.find(layer => layer.id === 'map:feature-r_smooth').points.length,
        replaced: adopted.replaced, unmatched: adopted.unmatched,
        keptIds: adopted.doc.layers.map(layer => layer.id),
        visible: adopted.timeline.keyframes.map(frame => frame.visible),
        expandedBase: expanded.base,
        expandedIds: expanded.layers.map(layer => layer.id),
        junctionTypes: junction.layers.map(layer => layer.type + ':' + (layer.text ?? '')),
      }))
    `, root)
    assert.deepEqual(result.ids, ['map:l_ridge', 'map:l_route', 'map:l_route_label', 'map:m_camp', 'map:feature-r_dense', 'map:feature-r_smooth'], '未锚定的标题、河名文字不展开；按资产 z 排序')
    assert.deepEqual(result.groups.r_route, ['map:l_route', 'map:l_route_label'], '一个要素的线与标注一起显现')
    assert.equal(result.routeStyle.stroke, '#b23a1f')
    assert.equal(result.routeStyle.arrow_end, false, '资产没箭头，段里也不能有箭头')
    assert.equal(result.ridgeStyle.dash, 'dot')
    assert.ok(result.ridgeStyle.width > 0, '主题缺省值被烘焙进样式')
    assert.deepEqual(result.routeMeta, { locked: true, from_asset: { asset_id: 259, layer_id: 'l_route' }, anchor: { semantic_id: 'r_route', semantic_name: '路线', asset_id: 259 } })
    assert.equal(result.densePoints, 600, '地图数据集几何不按 240 点截断')
    assert.ok(result.smoothPoints > 4, '按 layer_options 平滑后的渲染副本')
    assert.deepEqual(result.replaced, ['L2', 'L3'])
    assert.deepEqual(result.unmatched, [{ id: 'L4', semantic_id: 'p_gone' }], '资产里没有的要素：旧层保留不删')
    assert.deepEqual(result.keptIds, ['L1', 'L4', 'L5'], '客户端回传的 map: 层被丢弃；解除锚点的人工层保留')
    assert.deepEqual(result.visible, [[], ['L1', 'map:l_route', 'map:l_route_label'], ['L1', 'map:l_route', 'map:l_route_label', 'map:m_camp', 'L4']])
    assert.equal(result.expandedBase.path, 'static/map-bg.png')
    assert.equal(result.expandedBase.filter, undefined, '资产底图不加段滤镜')
    assert.equal(result.expandedBase.width, 960)
    assert.deepEqual(result.expandedIds.slice(0, 6), ['map:l_ridge', 'map:l_route', 'map:l_route_label', 'map:m_camp', 'map:feature-r_dense', 'map:feature-r_smooth'])
    assert.deepEqual(result.expandedIds.slice(6), ['L1', 'L4', 'L5'], '段自己的层画在资产层之上')
    assert.ok(!result.junctionTypes.some(item => item.startsWith('label') || item.startsWith('text')), '衔接帧隐藏资产标注与文本框')
    assert.ok(result.junctionTypes.includes('marker:'), '衔接帧里资产地点只画点不画字')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('真实库：读时展开、PUT 忽略资产层、存量迁移幂等、地图工作室成图优先、文档底图缺失不回退重画', () => {
  const root = mkdtempSync(join(tmpdir(), 'map-asset-layers-db-'))
  try {
    const result = run(`
      import fs from 'node:fs'
      import path from 'node:path'
      import sharp from 'sharp'
      import { db, schema, sqlite } from './src/db/index.ts'
      import { getLayerSegment, saveLayerSegment, migrateMapAssetSegments, layerSegmentSignatureOf } from './src/services/layer-segment.ts'
      const storage = process.env.STORAGE_PATH
      fs.mkdirSync(storage, { recursive: true })
      for (const name of ['map-bg.png', 'faithful.png', 'studio-bg.png']) {
        await sharp({ create: { width: 384, height: 216, channels: 3, background: '#c9b48a' } }).png().toFile(path.join(storage, name))
      }
      const at = '2026-01-01T00:00:00.000Z'
      await db.insert(schema.dramas).values({ id: 1, title: 'doc', projectType: 'documentary', aspectRatio: '16:9', createdAt: at, updatedAt: at })
      await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', createdAt: at, updatedAt: at })
      for (const id of [1, 2, 3]) {
        await db.insert(schema.storyboards).values({ id, episodeId: 1, storyboardNumber: id, combo: 'A', continuityBoundary: 'cut', designCardStatus: 'confirmed', createdAt: at, updatedAt: at })
      }
      // 旧地图工作流资产：图层文档在 map_workflow.outputs，且属于当前成图
      const workflow = { outputs: { layer_doc: ${JSON.stringify(ASSET_DOC)}, final_image: { path: 'static/final.png', task_id: 30 } } }
      await db.insert(schema.props).values({ id: 259, dramaId: 1, name: '据点网络图', assetType: 'map', localPath: 'static/final.png', imageUrl: 'static/final.png', mapWorkflow: JSON.stringify(workflow), createdAt: at, updatedAt: at })
      // 地图工作室资产：editable_source 在当前成图版本行上
      await db.insert(schema.props).values({ id: 283, dramaId: 1, name: '区位图', assetType: 'map', localPath: 'static/studio-final.png', imageUrl: 'static/studio-final.png', createdAt: at, updatedAt: at })
      sqlite.prepare("INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at) VALUES ('image', 283, 1, 'map-workflow', 'map-layer-doc', 'x', ?, 'static/studio-final.png', 'static/studio-final.png', 'completed', ?, ?)")
        .run(JSON.stringify({ source: 'map-studio', editable_source: { version: 1, layer_doc: { ...${JSON.stringify(ASSET_DOC)}, base: { path: 'static/studio-bg.png', width: 3840, height: 2160 }, theme: 'ink' }, layer_options: {} } }), at, at)
      const legacyDoc = { base: { path: 'static/faithful.png', width: 960, height: 544, filter: { paper: 0.16, tint: 'sepia' } }, theme: 'archival', layers: [
        { id: 'L1', type: 'text', role: 'date', fields: { main: '1581年' }, z: 1 },
        { id: 'L2', type: 'polyline', z: 2, points: [[0, 0], [1, 1]], anchor: { asset_id: 259, semantic_id: 'r_route' }, style: { arrow_end: true } },
      ] }
      const timeline = { fps: 25, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }, { t: 1, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1', 'L2'] }] }
      const baseRef = (id) => JSON.stringify({ kind: 'asset', asset_kind: 'prop', asset_id: id, version_task_id: null })
      await db.insert(schema.storyboardLayerSegments).values({ id: 1, storyboardId: 1, layerDoc: JSON.stringify(legacyDoc), timeline: JSON.stringify(timeline), duration: 2, baseRef: baseRef(259), status: 'ready', staleReasons: '[]', createdAt: at, updatedAt: at })
      await db.insert(schema.storyboardLayerSegments).values({ id: 2, storyboardId: 2, layerDoc: JSON.stringify({ ...legacyDoc, layers: [legacyDoc.layers[0]] }), timeline: JSON.stringify({ ...timeline, keyframes: [timeline.keyframes[0], { ...timeline.keyframes[1], visible: ['L1', 'map:l_route'] }] }), duration: 2, baseRef: baseRef(283), status: 'ready', staleReasons: '[]', createdAt: at, updatedAt: at })
      const spec = { width: 960, height: 544, fps: 25 }

      const read = await getLayerSegment(1)
      const signatureBefore = layerSegmentSignatureOf(read, spec, 'A')
      const migrated = await migrateMapAssetSegments()
      const again = await migrateMapAssetSegments()
      const stored = JSON.parse(db.select().from(schema.storyboardLayerSegments).all().find(row => row.id === 1).layerDoc)
      const afterMigration = await getLayerSegment(1)

      // 编辑器回传：改了资产层样式、删掉一个资产层、改了自己的文本框
      const submitted = JSON.parse(JSON.stringify(afterMigration.layer_doc))
      submitted.layers = submitted.layers.filter(layer => layer.id !== 'map:m_camp').map(layer => layer.id === 'map:l_route' ? { ...layer, style: { stroke: '#00ff00' } } : layer)
      submitted.layers.find(layer => layer.id === 'L1').fields.main = '1582年'
      const saved = await saveLayerSegment(1, { layer_doc: submitted })
      const storedAfterPut = JSON.parse(db.select().from(schema.storyboardLayerSegments).all().find(row => row.id === 1).layerDoc)

      const studio = await getLayerSegment(2)
      fs.rmSync(path.join(storage, 'studio-bg.png'))
      sqlite.prepare("UPDATE props SET updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 283").run()
      const missingBase = await getLayerSegment(2)
      console.log('@@' + JSON.stringify({
        read: { ids: read.layer_doc.layers.map(layer => layer.id), base: read.layer_doc.base.path, visible: read.timeline.keyframes[1].visible, map_source: read.map_source },
        migrated, again,
        storedIds: stored.layers.map(layer => layer.id), storedVisible: JSON.parse(db.select().from(schema.storyboardLayerSegments).all().find(row => row.id === 1).timeline).keyframes[1].visible,
        signatureStable: layerSegmentSignatureOf(afterMigration, spec, 'A') === signatureBefore,
        savedRoute: saved.layer_doc.layers.find(layer => layer.id === 'map:l_route').style.stroke,
        savedCamp: saved.layer_doc.layers.some(layer => layer.id === 'map:m_camp'),
        savedText: saved.layer_doc.layers.find(layer => layer.id === 'L1').fields.main,
        storedAfterPutIds: storedAfterPut.layers.map(layer => layer.id),
        studio: { base: studio.layer_doc.base.path, first: studio.layer_doc.layers[0].id, map_source: studio.map_source },
        missingBase: { map_source: missingBase.map_source, ids: missingBase.layer_doc.layers.map(layer => layer.id) },
      }))
    `, root)
    assert.deepEqual(result.read.ids, ['map:l_ridge', 'map:l_route', 'map:l_route_label', 'map:m_camp', 'L1'], '未迁移的存量段读时就已规范化：旧重画层换成资产层')
    assert.equal(result.read.base, 'static/map-bg.png')
    assert.deepEqual(result.read.visible, ['L1', 'map:l_route', 'map:l_route_label'])
    assert.deepEqual(result.read.map_source, { asset_id: 259, asset_name: '据点网络图', layer_count: 4 })
    assert.deepEqual(result.migrated, { converted: 1, replaced: 1, unmatched: [] })
    assert.deepEqual(result.again, { converted: 0, replaced: 0, unmatched: [] }, '迁移幂等')
    assert.deepEqual(result.storedIds, ['L1'], '库里只存段自己的层')
    assert.deepEqual(result.storedVisible, ['L1', 'map:l_route', 'map:l_route_label'])
    assert.equal(result.signatureStable, true, '迁移只是落库读时规范形，签名不变')
    assert.equal(result.savedRoute, '#b23a1f', 'PUT 改资产层样式被忽略')
    assert.equal(result.savedCamp, true, 'PUT 删资产层被忽略')
    assert.equal(result.savedText, '1582年', '段自己的层照常保存')
    assert.deepEqual(result.storedAfterPutIds, ['L1'])
    assert.deepEqual(result.studio, { base: 'static/studio-bg.png', first: 'map:l_ridge', map_source: { asset_id: 283, asset_name: '区位图', layer_count: 4 } })
    assert.deepEqual(result.missingBase, { map_source: null, ids: ['L1'] }, '文档底图缺失：不展开、不回退重画')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
