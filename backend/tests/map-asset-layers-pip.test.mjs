/**
 * 地图资产图层解析接入 PiP 细节版本（Issue #127）。
 * 真实 SQLite（临时库）+ 真实服务代码：`provider IN ('map-workflow','map-render')` 的扩展、
 * 钉选版本优先、`props.updated_at` 缓存失效（补算脚本 touch 的依据）、缺底图不冒充接入。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backend = fileURLToPath(new URL('..', import.meta.url))

test('细节（map-render）版本带 editable_source 时参与 #117 解析；钉选优先、缓存按 updated_at 失效', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-asset-layers-pip-'))
  const staticDir = path.join(dir, 'static')
  mkdirSync(path.join(staticDir, 'map-bases'), { recursive: true })
  mkdirSync(path.join(staticDir, 'map-drawings'), { recursive: true })
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import sharp from 'sharp'
    import { sqlite, db, schema, getInsertId } from './src/db/index.ts'
    import { now } from './src/utils/response.ts'
    import { mapAssetLayersOf, expandMapAssetLayers } from './src/services/map-asset-layers.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { STORAGE_ROOT } from './src/utils/paths.ts'

    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#efe6d0' } }).png().toBuffer()
    const write = (rel) => { const abs = path.join(STORAGE_ROOT, rel.replace(/^static\\//, '')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, png) }
    const BASE = 'static/map-bases/pip-detail1-abc.png'
    const BASE2 = 'static/map-bases/pip-detail1-def.png'
    const DETAIL = 'static/map-drawings/detail1.png'
    write(BASE); write(DETAIL)

    const ts = now()
    const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '细节复用', createdAt: ts, updatedAt: ts }))
    const propOf = async (name, localPath) => getInsertId(await db.insert(schema.props).values({ dramaId, name, type: '地图细节图', assetType: 'map', faithful: 1, localPath, imageUrl: localPath, createdAt: ts, updatedAt: ts }))
    const propId = await propOf('细节1', DETAIL)
    const taskOf = (prop, provider, model, params, localPath) => Number(sqlite.prepare(\`INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at, completed_at, generated_at)
      VALUES ('image', ?, ?, ?, ?, 'x', ?, ?, ?, 'completed', ?, ?, ?, 1)\`).run(prop, dramaId, provider, model, JSON.stringify(params), localPath, localPath, ts, ts, ts).lastInsertRowid)

    const doc = (fill, basePath) => ({
      version: 1, theme: 'clean',
      base: { path: basePath, width: 3840, height: 2160 },
      layers: [
        { id: 'feature-g1', type: 'polygon', name: '莫斯科公国', anchor: { semantic_id: 'g1' }, points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]], style: { fill_opacity: fill, feather: 0.023 } },
        { id: 'title', type: 'label', name: '标题', text: '细节标题', box: { x: 0.05, y: 0.05, w: 0.3, h: 0.1 }, style: {} },
      ],
    })
    // 1) 只有底图版本（map-studio-base，无 editable_source）→ 不命中
    const baseOnlyProp = await propOf('底图only', DETAIL)
    taskOf(baseOnlyProp, 'map-render', 'map-studio-base', { source: 'map-studio' }, DETAIL)

    // 2) 细节版本（map-render + editable_source）→ 命中
    const detailVersion = taskOf(propId, 'map-render', 'map-studio-detail', { role: 'detail', editable_source: { layer_doc: doc(0.23, BASE), layer_options: null } }, DETAIL)

    const out = {}
    out.baseOnly = mapAssetLayersOf(baseOnlyProp)
    const asset = mapAssetLayersOf(propId)
    out.layers = asset.layers.map(layer => ({ id: layer.id, anchor: layer.anchor.semantic_id, fill: layer.style.fill_opacity, locked: layer.locked }))
    out.basePath = asset.base.path
    out.version = asset.version_task_id
    out.versionId = detailVersion

    // 3) 钉选版本优先：当前图换成不带 editable_source 的旧成图，钉选仍取细节版本
    const pinProp = await propOf('细节钉选', DETAIL)
    taskOf(pinProp, 'map-workflow', 'map-layer-doc', { source: 'map-studio' }, DETAIL) // 最新但没文档
    const pinnedVersion = taskOf(pinProp, 'map-render', 'map-studio-detail', { editable_source: { layer_doc: doc(0.27, BASE), layer_options: null } }, DETAIL)
    out.pinned = mapAssetLayersOf(pinProp, pinnedVersion)?.layers.map(layer => layer.style.fill_opacity)

    // 4) 缓存：只改 params 不 touch updated_at → 命中旧缓存；touch 后读到新文档
    out.cacheBefore = mapAssetLayersOf(propId).layers[0].style.fill_opacity
    sqlite.prepare('UPDATE sys_task SET params = ? WHERE id = ?').run(JSON.stringify({ editable_source: { layer_doc: doc(0.31, BASE), layer_options: null } }), detailVersion)
    out.cacheStale = mapAssetLayersOf(propId).layers[0].style.fill_opacity
    sqlite.prepare('UPDATE props SET updated_at = ? WHERE id = ?').run('2026-11-19T10:00:00.000Z', propId)
    out.cacheFresh = mapAssetLayersOf(propId).layers[0].style.fill_opacity

    // 5) 底图文件缺失 → null（不冒充接入）
    const missingProp = await propOf('底图缺失', DETAIL)
    sqlite.prepare('UPDATE props SET updated_at = ? WHERE id = ?').run('2026-11-19T10:00:01.000Z', missingProp)
    taskOf(missingProp, 'map-render', 'map-studio-detail', { editable_source: { layer_doc: doc(0.23, BASE2) } }, DETAIL)
    out.missingBase = mapAssetLayersOf(missingProp)

    // 6) 展开：底图换成细节底图，资产层带 map: 前缀、未锚定标题不带
    const expanded = expandMapAssetLayers(normalizeLayerDoc({ version: 1, theme: 'clean', base: { path: DETAIL, width: 3840, height: 2160 }, layers: [] }), asset)
    out.expanded = { base: expanded.base.path, ids: expanded.layers.map(layer => layer.id) }
    console.log('@@' + JSON.stringify(out))
  `
  try {
    const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backend, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: staticDir },
    })
    const out = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.equal(out.baseOnly, null, '底图版本没有 editable_source，不命中')
    assert.deepEqual(out.layers, [{ id: 'map:feature-g1', anchor: 'g1', fill: 0.23, locked: true }])
    assert.equal(out.basePath, 'static/map-bases/pip-detail1-abc.png')
    assert.equal(out.version, out.versionId, '版本 id 指向带 editable_source 的细节版本')
    assert.deepEqual(out.pinned, [0.27], '钉选版本优先于当前图版本')
    assert.equal(out.cacheBefore, 0.23)
    assert.equal(out.cacheStale, 0.23, '只改 params 不 touch updated_at：缓存继续命中（补算脚本必须 touch）')
    assert.equal(out.cacheFresh, 0.31, 'touch updated_at 后读到新文档')
    assert.equal(out.missingBase, null, '底图缺失不冒充接入')
    assert.equal(out.expanded.base, 'static/map-bases/pip-detail1-abc.png', '展开后底图换成细节底图')
    assert.deepEqual(out.expanded.ids, ['map:feature-g1'], '未锚定的标题层不展开，资产层带前缀')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
