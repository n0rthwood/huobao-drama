import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #123：资产版本删除四守卫 + 三类资产参数化（角色/场景/道具同一实现）。
const backendRoot = fileURLToPath(new URL('..', import.meta.url))
function isolated(script) {
  const dir = mkdtempSync(join(tmpdir(), 'asset-version-'))
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2).split('\n')[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 每类资产：建资产 + 3 个 completed image 版本（current / faithful_source / deletable）+ 1 个 processing 行。
// 返回 Hono app 请求结果与文件存在性。
function scenario(kind) {
  const table = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props'
  const nameField = kind === 'scene' ? "location: '测试场景', time: '日', prompt: '测试描述'," : "name: '测试资产',"
  const ownerField = kind === 'character' ? 'characterId' : kind === 'scene' ? 'sceneId' : 'propId'
  return `
    import fs from 'node:fs'
    import { Hono } from 'hono'
    import { eq } from 'drizzle-orm'
    import { db, schema, sqlite } from './src/db/index.ts'
    import { initAssetStudio } from './src/modules/asset-studio/index.ts'
    import { mountImageVersionRoutes } from './src/routes/asset-image-version.ts'
    import { getAbsolutePath } from './src/utils/storage.ts'
    await initAssetStudio({ researchKeys: async () => ({}) })
    const ts = new Date().toISOString()
    const dramaId = Number(db.insert(schema.dramas).values({ title: 'T', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const assetId = Number(db.insert(schema.${table}).values({ ${nameField} dramaId, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const mkVersion = (file, status = 'completed') => {
      const rel = 'static/images/' + file
      fs.mkdirSync(getAbsolutePath('static/images'), { recursive: true })
      fs.writeFileSync(getAbsolutePath(rel), 'png-' + file)
      return Number(db.insert(schema.sysTask).values({ type: 'image', ${ownerField}: assetId, dramaId, provider: 'upload', model: 'manual-upload', localPath: rel, resultUrl: rel, status, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    }
    const faithfulId = mkVersion('faithful.png')
    const currentId = mkVersion('current.png')
    const deletableId = mkVersion('deletable.png')
    const processingId = mkVersion('processing.png', 'processing')
    db.update(schema.${table}).set({ faithful: 1, faithfulSource: faithfulId, imageUrl: 'static/images/current.png', localPath: 'static/images/current.png' }).where(eq(schema.${table}.id, assetId)).run()
    const app = new Hono()
    mountImageVersionRoutes(app, '${kind}')
    const del = async (taskId) => {
      const res = await app.request('/' + assetId + '/image-versions/' + taskId, { method: 'DELETE' })
      return { status: res.status, body: await res.json() }
    }
    const out = {}
    out.current = await del(currentId)
    out.faithful = await del(faithfulId)
    out.processing = await del(processingId)
    out.foreign = await del(999999)
    // 图层段钉住 deletable 版本 → 400
    const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const sbId = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    sqlite.prepare('INSERT INTO storyboard_layer_segments (storyboard_id, layer_doc, timeline, duration, base_ref, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sbId, JSON.stringify({ base: { path: 'x' }, layers: [] }), '[]', 1, JSON.stringify({ kind: 'asset', asset_kind: '${kind}', asset_id: assetId, version_task_id: deletableId }), 'draft', ts, ts)
    out.pinned = await del(deletableId)
    // 解除钉选（base_ref 置 null）→ 成功删除，文件消失
    sqlite.prepare('UPDATE storyboard_layer_segments SET base_ref=NULL WHERE storyboard_id=?').run(sbId)
    out.ok = await del(deletableId)
    out.fileGone = !fs.existsSync(getAbsolutePath('static/images/deletable.png'))
    out.rowGone = !sqlite.prepare('SELECT 1 FROM sys_task WHERE id=?').get(deletableId)
    // 活跃草稿冻结该版本为输入 → 拒删（用 current 版本造草稿；current 本身已被当前图守卫挡，改用新删行验证草稿守卫需独立版本）
    const draftVersionId = mkVersion('draft-input.png')
    sqlite.prepare("INSERT INTO asset_studio_draft (task_id, asset_kind, asset_id, tab, status, inputs, created_at, updated_at) VALUES (1, '${kind}', ?, 'beautify', 'ready', ?, ?, ?)")
      .run(assetId, JSON.stringify({ version_task_id: draftVersionId, notes: '' }), ts, ts)
    out.draftPinned = await del(draftVersionId)
    console.log('@@' + JSON.stringify(out))
  `
}

for (const kind of ['character', 'scene', 'prop']) {
  test(`image version delete guards and success path (${kind})`, () => {
    const out = isolated(scenario(kind))
    assert.equal(out.current.status, 400)
    assert.match(out.current.body.message, /当前生效版本/)
    assert.equal(out.faithful.status, 400)
    assert.match(out.faithful.body.message, /受保护原件/)
    assert.equal(out.processing.status, 404)
    assert.equal(out.foreign.status, 404)
    assert.equal(out.pinned.status, 400)
    assert.match(out.pinned.body.message, /分镜\/图层引用/)
    assert.equal(out.ok.status, 200)
    assert.equal(out.ok.body.data.deleted, true)
    assert.equal(out.ok.body.data.files_removed, true)
    assert.equal(out.fileGone, true)
    assert.equal(out.rowGone, true)
    assert.equal(out.draftPinned.status, 400)
    assert.match(out.draftPinned.body.message, /草稿/)
  })
}

test('design_card base_ref pin blocks deletion; delivery pointer nulled on delete', () => {
  const out = isolated(`
    import fs from 'node:fs'
    import { Hono } from 'hono'
    import { db, schema, sqlite } from './src/db/index.ts'
    import { initAssetStudio } from './src/modules/asset-studio/index.ts'
    import { mountImageVersionRoutes } from './src/routes/asset-image-version.ts'
    import { getAbsolutePath } from './src/utils/storage.ts'
    await initAssetStudio({ researchKeys: async () => ({}) })
    const ts = new Date().toISOString()
    const dramaId = Number(db.insert(schema.dramas).values({ title: 'T', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const assetId = Number(db.insert(schema.props).values({ name: 'P', dramaId, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const rel = 'static/images/v.png'
    fs.mkdirSync(getAbsolutePath('static/images'), { recursive: true })
    fs.writeFileSync(getAbsolutePath(rel), 'png')
    const versionId = Number(db.insert(schema.sysTask).values({ type: 'image', propId: assetId, dramaId, provider: 'upload', localPath: rel, resultUrl: rel, status: 'completed', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const sbId = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, designCard: JSON.stringify({ base_ref: { kind: 'asset', asset_kind: 'prop', asset_id: assetId, version_task_id: versionId } }), createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    sqlite.prepare("INSERT INTO asset_studio_run (task_id, status, purpose, params, created_at, updated_at) VALUES (1, 'completed', 'precision', '{}', ?, ?)").run(ts, ts)
    const runId = Number(sqlite.prepare('SELECT MAX(id) AS id FROM asset_studio_run').get().id)
    sqlite.prepare('INSERT INTO asset_studio_delivery (run_id, round_id, image_sha256, version_id, set_as_current, created_at) VALUES (?,1,?,?,0,?)').run(runId, 'sha', versionId, ts)
    const app = new Hono()
    mountImageVersionRoutes(app, 'prop')
    const del = async () => { const res = await app.request('/' + assetId + '/image-versions/' + versionId, { method: 'DELETE' }); return { status: res.status, body: await res.json() } }
    const pinned = await del()
    sqlite.prepare('UPDATE storyboards SET design_card=NULL WHERE id=?').run(sbId)
    const ok = await del()
    const delivery = sqlite.prepare('SELECT version_id FROM asset_studio_delivery WHERE run_id=?').get(runId)
    console.log('@@' + JSON.stringify({ pinned, ok, delivery }))
  `)
  assert.equal(out.pinned.status, 400)
  assert.equal(out.ok.status, 200)
  assert.equal(out.delivery.version_id, null)
})