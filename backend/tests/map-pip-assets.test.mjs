/**
 * 地图画中画的宿主登记（Issue #107）：细节是独立资产，联系与用法存在 props.map_pip。
 * 真实 SQLite（临时库）+ 真实服务代码；渲染不在此测（见 map-studio-pip / relief 测试）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('细节资产登记：新增→关联同剧集→重跑覆盖不重复→不再出现的标过期；全览写 map_pip', () => {
  const backend = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'map-pip-assets-'))
  const script = `
    import assert from 'node:assert/strict'
    import { sqlite, db, schema, getInsertId } from 'file://${backend}src/db/index.ts'
    import { now } from 'file://${backend}src/utils/response.ts'
    import { registerPipAssets, parsePipMeta, pipParentOf } from 'file://${backend}src/services/map-pip-assets.ts'

    const ts = now()
    const dramaId = getInsertId(await db.insert(schema.dramas).values({ title: '画中画', createdAt: ts, updatedAt: ts }))
    const epId = getInsertId(await db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E1', createdAt: ts, updatedAt: ts }))
    const parentId = getInsertId(await db.insert(schema.props).values({ dramaId, name: '东欧全览', assetType: 'map', createdAt: ts, updatedAt: ts }))
    sqlite.prepare('INSERT INTO episode_props (episode_id, prop_id, created_at) VALUES (?, ?, ?)').run(epId, parentId, ts)

    const frame = (no, label, role = 'aux') => ({ no, label, reason: '旁白强调' + label, role, focus_bbox: [30, 50, 36, 53], bbox: [29, 49.5, 37, 53.5], storyboard_numbers: [no * 10] })
    const detail = (no) => ({ no, path: 'static/map-drawings/pip-detail' + no + '.png', width: 3840, height: 2160, sha256: 'sha' + no, provenance: { attribution: '© OpenStreetMap contributors (ODbL 1.0)', sources: [{ name: 'OSM', license: 'ODbL 1.0', url: 'https://www.openstreetmap.org/', sha256: 'test-sha' }] } })
    const deliverable = (frames) => ({
      task_id: 7,
      pip: {
        version: 1, overview_bbox: [20, 42, 85, 64], aspect: '16:9', frames,
        layout: { id: 'L2b-A', family: 'A', canvas: { width: 3840, height: 2160 }, slots: [], locator: null, label_tier: 'full', min_slot_short_side: 900 },
        details: frames.map(f => detail(f.no)), composite: { path: 'static/map-drawings/pip-composite.png', width: 3840, height: 2160, sha256: 'comp' },
        usage: '全览建立位置，细节看清地理特征',
      },
    })
    const parent = { id: parentId, name: '东欧全览', drama_id: dramaId }
    const rows = () => sqlite.prepare("SELECT id, name, map_pip, image_url, faithful, asset_type, faithful_source FROM props WHERE drama_id = ? AND id <> ? AND deleted_at IS NULL ORDER BY id").all(dramaId, parentId)
    const out = {}

    registerPipAssets(parent, deliverable([frame(1, '乌格拉河口', 'primary'), frame(2, '喀山')]), ts)
    const first = rows()
    out.firstCount = first.length
    out.names = first.map(r => r.name)
    out.child1 = parsePipMeta(first[0].map_pip)
    out.childFlags = first.map(r => [r.faithful, r.asset_type, r.image_url])
    out.versionCount = sqlite.prepare("SELECT COUNT(*) AS n FROM sys_task WHERE provider = 'map-render' AND model = 'map-studio-detail'").get().n
    out.detailProvenance = JSON.parse(sqlite.prepare('SELECT params FROM sys_task WHERE id = ?').get(first[0].faithful_source).params).provenance
    out.linked = sqlite.prepare('SELECT COUNT(*) AS n FROM episode_props WHERE episode_id = ? AND prop_id IN (?, ?)').get(epId, first[0].id, first[1].id).n
    out.parentMeta = parsePipMeta(sqlite.prepare('SELECT map_pip FROM props WHERE id = ?').get(parentId).map_pip)
    out.parentOf = [pipParentOf(first[0].id), pipParentOf(parentId)]

    // 同方案重跑（同帧编号）：覆盖原资产，不新增行；版本追加
    registerPipAssets(parent, deliverable([frame(1, '乌格拉河口', 'primary'), frame(2, '喀山')]), ts)
    out.rerunCount = rows().length
    out.rerunVersions = sqlite.prepare("SELECT COUNT(*) AS n FROM sys_task WHERE provider = 'map-render' AND model = 'map-studio-detail'").get().n
    out.rerunSameIds = rows().map(r => r.id).join() === first.map(r => r.id).join()

    // 新方案只剩细节 1：细节 2 保留但标过期（分镜可能已引用，不静默删除）
    registerPipAssets(parent, deliverable([frame(1, '乌格拉河口', 'primary')]), ts)
    const after = rows()
    out.afterCount = after.length
    out.stale = after.map(r => parsePipMeta(r.map_pip).stale === true)
    out.parentFrames = parsePipMeta(sqlite.prepare('SELECT map_pip FROM props WHERE id = ?').get(parentId).map_pip).frames.length

    // 没有细节框：全览 map_pip 清空
    registerPipAssets(parent, { task_id: 7, pip: null }, ts)
    out.parentCleared = sqlite.prepare('SELECT map_pip FROM props WHERE id = ?').get(parentId).map_pip
    console.log('@@' + JSON.stringify(out))
  `
  try {
    const probe = path.join(dir, 'probe.mts')
    writeFileSync(probe, script)
    const stdout = execFileSync('node_modules/.bin/tsx', [probe], {
      cwd: backend, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    const out = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.equal(out.firstCount, 2)
    assert.deepEqual(out.names, ['东欧全览 · 细节1（乌格拉河口）', '东欧全览 · 细节2（喀山）'])
    assert.equal(out.child1.role, 'detail')
    assert.equal(out.child1.frame.no, 1)
    assert.deepEqual(out.child1.frame.bbox, [29, 49.5, 37, 53.5])
    assert.match(out.child1.usage, /细节1「乌格拉河口」.*东欧全览/s)
    assert.deepEqual(out.childFlags, [[1, 'map', 'static/map-drawings/pip-detail1.png'], [1, 'map', 'static/map-drawings/pip-detail2.png']])
    assert.equal(out.versionCount, 2)
    assert.match(out.detailProvenance.attribution, /OpenStreetMap/)
    assert.equal(out.detailProvenance.sources[0].license, 'ODbL 1.0')
    assert.equal(out.linked, 2, '细节与全览关联同一剧集')
    assert.equal(out.parentMeta.role, 'overview')
    assert.deepEqual(out.parentMeta.frames.map(f => f.detail_prop_id).length, 2)
    assert.equal(out.parentMeta.composite_path, 'static/map-drawings/pip-composite.png')
    assert.equal(out.parentOf[1], null)
    assert.equal(typeof out.parentOf[0], 'number')
    assert.equal(out.rerunCount, 2)
    assert.equal(out.rerunSameIds, true)
    assert.equal(out.rerunVersions, 4)
    assert.equal(out.afterCount, 2)
    assert.deepEqual(out.stale, [false, true])
    assert.equal(out.parentFrames, 1)
    assert.equal(out.parentCleared, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
