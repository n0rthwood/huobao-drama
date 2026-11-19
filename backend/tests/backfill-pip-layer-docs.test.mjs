/**
 * 存量 PiP 细节补算脚本（Issue #127）：dry-run 计数、apply 写入 + 备份、幂等第二次 0 写入、
 * 来源不可证明列为不可迁移；以及「首次展开 → 签名过期 → 重渲 → 新鲜」的段闭环。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const backend = fileURLToPath(new URL('..', import.meta.url))

const seed = `
  import fs from 'node:fs'
  import path from 'node:path'
  import sharp from 'sharp'
  import { sqlite, db, schema, getInsertId } from './src/db/index.ts'
  import { now } from './src/utils/response.ts'
  import { STORAGE_ROOT } from './src/utils/paths.ts'

  const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#efe6d0' } }).png().toBuffer()
  const write = async (rel, w = 64, h = 36) => { const abs = path.join(STORAGE_ROOT, rel.replace(/^static\\//, '')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, await png(w, h)) }
  const ts = now()
  const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '补算', createdAt: ts, updatedAt: ts }))
  const prop = async (name, localPath, mapPip) => getInsertId(await db.insert(schema.props).values({ dramaId, name, type: '地图细节图', assetType: 'map', faithful: 1, localPath, imageUrl: localPath, mapPip, createdAt: ts, updatedAt: ts }))
  const task = (propId, provider, model, params, localPath) => Number(sqlite.prepare(\`INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at, completed_at, generated_at)
    VALUES ('image', ?, ?, ?, ?, 'x', ?, ?, ?, 'completed', ?, ?, ?, 1)\`).run(propId, dramaId, provider, model, JSON.stringify(params), localPath, localPath, ts, ts, ts).lastInsertRowid)

  const OVERVIEW_LOCAL = 'static/map-drawings/overview.png'
  const OVERVIEW_BASE = 'static/map-bases/overview-bg.png'
  await write(OVERVIEW_LOCAL, 3840, 2160)
  await write(OVERVIEW_BASE, 3840, 2160)
  const frame = { no: 1, label: '乌格拉河口', role: 'primary', reason: '旁白强调', bbox: [32, 53, 40.5, 56.1], focus_bbox: [33, 53.5, 39.5, 55.6], storyboard_numbers: [3] }
  const layout = { id: 'L2b-B', family: 'B', canvas: { width: 3840, height: 2160 }, slots: [], locator: { width: 768, height: 432, margin: 40 }, label_tier: 'full', min_slot_short_side: 900 }
  const spec = {
    version: 1, projection: { type: 'mercator' }, bbox: [20, 42, 85, 64],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: false },
    places: [{ id: 'p_moscow', name: '莫斯科', lon: 37.6, lat: 55.75 }],
    routes: [],
    regions: [{ id: 'g_big', name: '莫斯科公国', points: [[33, 53.2], [40, 53.2], [40, 55.8], [33, 55.8], [33, 53.2]] }],
    style: { theme: 'clean' },
  }
  const overviewDoc = {
    version: 1, theme: 'clean', base: { path: OVERVIEW_BASE, width: 3840, height: 2160 },
    layers: [{ id: 'feature-g_big', type: 'polygon', name: '莫斯科公国', anchor: { semantic_id: 'g_big' }, points: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]], style: { fill_opacity: 0.23, feather: 0.023 } }],
  }
  const parentOverview = await prop('全览', OVERVIEW_LOCAL, JSON.stringify({ version: 1, role: 'overview', layout, overview_bbox: [20, 42, 85, 64], frames: [frame], composite_path: null, usage: '全览' }))
  const parentVersion = task(parentOverview, 'map-workflow', 'map-layer-doc', { source: 'map-studio', editable_source: { version: 1, map_spec: spec, layer_doc: overviewDoc, layer_options: null } }, OVERVIEW_LOCAL)

  const DETAIL_LOCAL = 'static/map-drawings/detail1.png'
  await write(DETAIL_LOCAL, 3840, 2160)
  const detailProp = await prop('全览 · 细节1（乌格拉河口）', DETAIL_LOCAL, JSON.stringify({ version: 1, role: 'detail', parent_prop_id: parentOverview, parent_name: '全览', frame, overview_bbox: [20, 42, 85, 64], usage: '细节' }))
  const detailVersion = task(detailProp, 'map-render', 'map-studio-detail', { source: 'map-studio', role: 'detail', parent_prop_id: parentOverview, frame, png_sha256: 'abc' }, DETAIL_LOCAL)

  // 来源不可证明 ①：全览版本有图层文档但没有 map_spec（无法证明几何来源）
  const legacyParent = await prop('旧全览', OVERVIEW_LOCAL, JSON.stringify({ version: 1, role: 'overview', layout: { locator: null }, frames: [] }))
  task(legacyParent, 'map-workflow', 'map-layer-doc', { source: 'map-studio', editable_source: { layer_doc: overviewDoc } }, OVERVIEW_LOCAL)
  const legacyDetail = await prop('旧全览 · 细节1', DETAIL_LOCAL, JSON.stringify({ version: 1, role: 'detail', parent_prop_id: legacyParent, parent_name: '旧全览', frame, overview_bbox: [20, 42, 85, 64], usage: '细节' }))
  task(legacyDetail, 'map-render', 'map-studio-detail', { source: 'map-studio', role: 'detail', frame, png_sha256: 'def' }, DETAIL_LOCAL)
  // 来源不可证明 ②：旧地图工作流资产（完全没有 editable_source）
  const plainParent = await prop('无文档全览', OVERVIEW_LOCAL, JSON.stringify({ version: 1, role: 'overview', layout: { locator: null }, frames: [] }))
  task(plainParent, 'map-workflow', 'map-layer-doc', { source: 'map-studio' }, OVERVIEW_LOCAL)
  const plainDetail = await prop('无文档全览 · 细节1', DETAIL_LOCAL, JSON.stringify({ version: 1, role: 'detail', parent_prop_id: plainParent, parent_name: '无文档全览', frame, overview_bbox: [20, 42, 85, 64], usage: '细节' }))
  task(plainDetail, 'map-render', 'map-studio-detail', { source: 'map-studio', role: 'detail', frame, png_sha256: 'hij' }, DETAIL_LOCAL)

  console.log('@@' + JSON.stringify({ parentVersion, detailProp, detailVersion, legacyDetail, plainDetail }))
`

function runScript(args, dir) {
  return execFileSync('node', ['--import', 'tsx', 'scripts/backfill-pip-layer-docs.ts', ...args], {
    cwd: backend, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
  })
}

function jsonOf(stdout) {
  const line = stdout.trim().split('\n').reverse().find(line => line.startsWith('{'))
  return JSON.parse(stdout.slice(stdout.indexOf(line)))
}

test('存量补算：dry-run 计数 → apply 落库 + 备份 + touch → 幂等第二次 0 写入 + 读路径生效', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'backfill-pip-'))
  try {
    const seeded = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', seed], {
      cwd: backend, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    const ids = JSON.parse(seeded.slice(seeded.lastIndexOf('@@') + 2))

    // dry-run：只报告，不写库、不落盘
    const dry = jsonOf(runScript(['--dry-run', '--json'], dir))
    assert.deepEqual(dry.counts, { details: 3, already: 0, migratable: 1, unmigratable: 2, rendered_base: 0, reused_base: 0, written: 0, failed: 0 })
    const migratable = dry.entries.find(entry => entry.status === 'migratable')
    const unmigratable = dry.entries.filter(entry => entry.status === 'unmigratable')
    assert.equal(migratable.prop_id, ids.detailProp)
    assert.equal(migratable.base_exists, false, 'dry-run 不渲染底图')
    assert.deepEqual(unmigratable.map(entry => [entry.prop_id, entry.reason]), [
      [ids.legacyDetail, 'parent_spec_missing'],
      [ids.plainDetail, 'parent_source_unavailable'],
    ], '来源不可证明的细节列为不可迁移，不编造')
    assert.match(migratable.base_path, /^static\/map-bases\/pip-detail1-[0-9a-f]{32}\.png$/)

    // 预先落底图（真实 apply 会渲染；测试里避免跨网络抓 DEM 瓦片）
    const baseAbs = path.join(dir, migratable.base_path.replace(/^static\//, 'static/'))
    mkdirSync(path.dirname(baseAbs), { recursive: true })
    writeFileSync(baseAbs, await sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#d8cfae' } }).png().toBuffer())

    const apply = jsonOf(runScript(['--apply', '--json'], dir))
    assert.equal(apply.counts.written, 1)
    assert.equal(apply.counts.reused_base, 1)
    assert.ok(apply.backup && existsSync(apply.backup), 'apply 默认先备份数据库')

    const inspect = `
      import fs from 'node:fs'
      import { sqlite } from './src/db/index.ts'
      import { mapAssetLayersOf } from './src/services/map-asset-layers.ts'
      const version = sqlite.prepare('SELECT id, params, updated_at FROM sys_task WHERE id = ?').get(${ids.detailVersion})
      const params = JSON.parse(version.params)
      const prop = sqlite.prepare('SELECT updated_at FROM props WHERE id = ?').get(${ids.detailProp})
      const asset = mapAssetLayersOf(${ids.detailProp})
      const out = {
        editable: params.editable_source ? {
          source: params.editable_source.source,
          render_key: params.editable_source.render_key,
          base: params.editable_source.base_image,
          doc_base: params.editable_source.layer_doc.base,
          layers: params.editable_source.layer_doc.layers.map(layer => ({ type: layer.type, id: layer.id, anchor: layer.anchor?.semantic_id ?? null, text: layer.text ?? null, fill: layer.style?.fill_opacity ?? null })),
          options: params.editable_source.layer_options,
        } : null,
        propUpdated: prop.updated_at,
        resolved: asset ? { version: asset.version_task_id, base: asset.base.path, layers: asset.layers.map(layer => layer.id) } : null,
      }
      console.log('@@' + JSON.stringify(out))
    `
    const read = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', inspect], {
      cwd: backend, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    const out = JSON.parse(read.slice(read.lastIndexOf('@@') + 2))
    assert.ok(out.editable, '细节版本 params 带 editable_source')
    assert.equal(out.editable.source, 'pip-detail')
    assert.match(out.editable.render_key, /^[0-9a-f]{64}$/)
    assert.equal(out.editable.base.path, migratable.base_path)
    assert.ok(migratable.base_path.includes(out.editable.render_key.slice(0, 32)), '底图文件名与版本 render_key 同源（同一渲染快照）')
    assert.equal(out.editable.doc_base.path, migratable.base_path, '投影文档底图 = 细节底图')
    const polygon = out.editable.layers.find(layer => layer.type === 'polygon')
    assert.equal(polygon.anchor, 'g_big')
    assert.equal(polygon.fill, 0.23, '区域画法沿用全览（0.23）')
    const label = out.editable.layers.find(layer => layer.type === 'label')
    assert.ok(label && label.text === '莫斯科公国' && label.anchor === 'g_big', '烧录注记转成锚定 label 层')
    assert.notEqual(out.propUpdated, '1970-01-01T00:00:00.000Z')
    assert.ok(out.resolved, '补算后 #117 读路径能解析细节资产')
    assert.equal(out.resolved.base, migratable.base_path)
    assert.deepEqual(out.resolved.layers, ['map:feature-g_big', 'map:pip-label-g_big-1', 'map:pip-label-p_moscow-2'], '展开层带 map: 前缀，几何 + 注记（区域名、地点名）都进入段文档')

    // 幂等：第二次 apply 0 写入
    const again = jsonOf(runScript(['--apply', '--json'], dir))
    assert.equal(again.counts.already, 1)
    assert.equal(again.counts.migratable, 0)
    assert.equal(again.counts.written, 0)
    assert.equal(again.backup, null, '没有可迁移项时不备份')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('细节段闭环：首次展开使旧签名过期，重渲后恢复新鲜', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pip-segment-fresh-'))
  try {
    mkdirSync(path.join(dir, 'static', 'layer-segments'), { recursive: true })
    mkdirSync(path.join(dir, 'static', 'map-bases'), { recursive: true })
    writeFileSync(path.join(dir, 'static', 'layer-segments', 'seg.png'), Buffer.from('png'))
    writeFileSync(path.join(dir, 'static', 'map-bases', 'pip-detail1-x.png'), Buffer.from('base-1'))
    const script = `
      import assert from 'node:assert/strict'
      import fs from 'node:fs'
      import path from 'node:path'
      import { layerSegmentIsFresh, layerSegmentSignatureOf } from './src/services/layer-segment.ts'
      import { STORAGE_ROOT } from './src/utils/paths.ts'

      const spec = { width: 1920, height: 1080, fps: 24 }
      const timeline = { fps: 24, ease: 'linear', fade_ms: 400, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['feature-g_big'] }] }
      const oldDoc = {
        version: 1, theme: 'clean', base: { path: 'static/map-drawings/detail1.png', width: 640, height: 360 },
        layers: [{ id: 'feature-g_big', type: 'polygon', name: '莫斯科公国', anchor: { asset_id: 900, semantic_id: 'g_big' }, points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.1]], style: { fill_opacity: 0.16 } }],
      }
      const expandedDoc = {
        version: 1, theme: 'clean', base: { path: 'static/map-bases/pip-detail1-x.png', width: 640, height: 360 },
        layers: [
          { id: 'map:feature-g_big', type: 'polygon', name: '莫斯科公国', locked: true, from_asset: { asset_id: 900, layer_id: 'feature-g_big' }, anchor: { asset_id: 900, semantic_id: 'g_big' }, points: [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]], style: { fill_opacity: 0.23, feather: 0.023 } },
          { id: 'map:pip-label-g_big-1', type: 'label', name: '莫斯科公国', locked: true, from_asset: { asset_id: 900, layer_id: 'pip-label-g_big-1' }, anchor: { asset_id: 900, semantic_id: 'g_big' }, box: { x: 0.3, y: 0.3, w: 0.2, h: 0.06 }, text: '莫斯科公国', style: { size: 0.023 } },
        ],
      }
      const seg = (doc) => ({ layer_doc: doc, timeline, duration: 3, render_path: 'static/layer-segments/seg.png', render_signature: null, stale_reasons: [] })
      const out = {}
      const before = layerSegmentSignatureOf(seg(oldDoc), spec)
      const after = layerSegmentSignatureOf(seg(expandedDoc), spec)
      out.changed = before !== after
      const stale = { ...seg(expandedDoc), render_signature: before }
      out.staleFresh = layerSegmentIsFresh(stale, spec)
      const fresh = { ...seg(expandedDoc), render_signature: after }
      out.freshFresh = layerSegmentIsFresh(fresh, spec)
      // 底图字节变化同样让签名失效（内容寻址底图换了就重渲）
      const baseAbs = path.join(STORAGE_ROOT, 'map-bases/pip-detail1-x.png')
      fs.writeFileSync(baseAbs, Buffer.from('base-2'))
      out.afterBaseChange = layerSegmentSignatureOf(seg(expandedDoc), spec)
      out.baseChanged = out.afterBaseChange !== after
      console.log('@@' + JSON.stringify(out))
    `
    const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backend, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static'), SQLITE_PATH: path.join(dir, 'test.sqlite3') },
    })
    const out = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.equal(out.changed, true, '展开后内容/底图变化 → 签名升档')
    assert.equal(out.staleFresh, false, '旧渲染签名 → 过期')
    assert.equal(out.freshFresh, true, '重渲后签名一致 → 新鲜')
    assert.equal(out.baseChanged, true, '底图内容变化同样让签名过期')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
