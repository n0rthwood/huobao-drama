/**
 * 一次性启动迁移（Issue #58，契约 §7）：`storyboard_clips` → `storyboard_layer_segments`。
 *
 * 覆盖验收 1 与裁决 M3 的全部可观察事实：
 * - 行数 = **去重后**镜数（同镜多条 clip 只转一条）；
 * - 同镜多行按 `replace > pre > post` 取，`stale_reasons` 记 `migrated_multi_clip`；
 * - 有 clip 行但 `storyboards.combo` 为空 → `stale_reasons` 记 `combo_missing`；
 * - `layer_doc` 与迁移前字节一致（这里比对规范化后的 JSON）；
 * - `render_signature` 按新口径（`seg-v1`）重算；
 * - 迁完 `DROP TABLE storyboard_clips`，再跑一次是空操作（幂等）；
 * - 孤儿 clip（storyboard 已不存在）跳过。
 *
 * 用临时 SQLite 跑真实 DDL + 迁移（与 task-center.test.mjs 同法：独立进程 + SQLITE_PATH）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

function run(body, env = {}) {
  const script = `
    import { db, initDb, schema } from './src/db/index.ts'
    import { sql } from 'drizzle-orm'
    import { now } from './src/utils/response.ts'
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    const out = (value) => console.log('@@' + JSON.stringify(value))
    ${body}
  `
  const text = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return JSON.parse(text.slice(text.lastIndexOf('@@') + 2))
}

/** 造一个「#50 时代」的库：只建 storyboard_clips，再插 drama/episode/storyboard/clips */
const SEED = `
  const ts = now()
  const drama = db.insert(schema.dramas).values({ title: '纪录片测试', aspectRatio: '16:9', projectType: 'documentary', createdAt: ts, updatedAt: ts }).run()
  const dramaId = Number(drama.lastInsertRowid)
  const episode = db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E1', createdAt: ts, updatedAt: ts }).run()
  const episodeId = Number(episode.lastInsertRowid)
  const insertSb = (number, combo) => Number(db.insert(schema.storyboards).values({
    episodeId, storyboardNumber: number, combo, title: 'S' + number, createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  const sbA = insertSb(1, 'A')          // 单条 clip
  const sbMulti = insertSb(2, 'C')      // pre + replace 两条 → 取 replace
  const sbNoCombo = insertSb(3, null)   // combo 为空 → combo_missing
  const layerDoc = JSON.stringify({
    version: 1, theme: 'archival',
    base: { path: 'static/uploads/map.png', width: 960, height: 544 },
    layers: [{ id: 'L1', type: 'marker', at: [0.5, 0.5], text: 'x' }],
  })
  const timeline = (t) => JSON.stringify({ fps: 25, ease: 'inout', fade_ms: 400, states: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }, { t, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: ['L1'] }] })
  db.run(sql\`CREATE TABLE IF NOT EXISTS storyboard_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, storyboard_id INTEGER NOT NULL, position TEXT NOT NULL,
    layer_doc TEXT NOT NULL, timeline TEXT NOT NULL, duration REAL NOT NULL,
    render_path TEXT, render_signature TEXT, rendered_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)\`)
  const insertClip = (sbId, position, duration) => db.run(sql\`INSERT INTO storyboard_clips
    (storyboard_id, position, layer_doc, timeline, duration, render_path, render_signature, rendered_at, status, created_at, updated_at)
    VALUES (\${sbId}, \${position}, \${layerDoc}, \${timeline(duration)}, \${duration}, \${'static/clips/' + position + '.mp4'}, 'clip-v1-old', \${ts}, 'ready', \${ts}, \${ts})\`)
  insertClip(sbA, 'replace', 6)
  insertClip(sbMulti, 'pre', 2)
  insertClip(sbMulti, 'replace', 5)
  insertClip(sbNoCombo, 'post', 2)
  insertClip(99999, 'replace', 2)   // 孤儿：分镜不存在
  out({ dramaId, episodeId, sbA, sbMulti, sbNoCombo, clipRows: db.all(sql\`SELECT COUNT(*) AS n FROM storyboard_clips\`)[0].n })
`

test('迁移：去重后镜数、多 clip 取 replace、combo_missing、层文档字节一致、旧表删除、幂等', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-migrate-'))
  const dbPath = path.join(dir, 'migrate.sqlite3')
  try {
    const env = { SQLITE_PATH: dbPath, HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    const seeded = run(SEED, env)
    assert.equal(seeded.clipRows, 5, '种子：5 条 clip（含 1 条孤儿）')

    const result = run(`
      const { migrateClipsToLayerSegments } = await import('./src/services/layer-segment-migration.ts')
      const before = db.all(sql\`SELECT storyboard_id, position, layer_doc, timeline FROM storyboard_clips ORDER BY storyboard_id, position\`)
      const migrated = await migrateClipsToLayerSegments()
      const rows = db.all(sql\`SELECT * FROM storyboard_layer_segments ORDER BY storyboard_id\`)
      const tables = db.all(sql\`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storyboard_clips'\`)
      const again = await migrateClipsToLayerSegments()
      out({
        migrated, again,
        storyboardIds: rows.map(r => r.storyboard_id),
        reasons: rows.map(r => JSON.parse(r.stale_reasons)),
        statuses: rows.map(r => r.status),
        signatures: rows.map(r => r.render_signature?.slice(0, 6)),
        junctions: rows.map(r => [r.junction_path, r.junction_hash]),
        legacyTable: tables.length,
        // 迁移必须原样搬运层文档 JSON 字节（不做规范化）；读入时才规范化
        beforeDoc: before.find(b => b.storyboard_id === 1).layer_doc,
        afterDoc: JSON.stringify(JSON.parse(rows[0].layer_doc)),
        durations: rows.map(r => r.duration),
      })
    `, env)
    assert.equal(result.migrated, 3, '3 镜迁移；孤儿跳过；同镜两条只转一条')
    assert.equal(result.again, 0, '幂等：旧表已不存在，再跑是空操作')
    assert.deepEqual(result.storyboardIds.sort(), [seeded.sbA, seeded.sbMulti, seeded.sbNoCombo].sort(), '行数 = 去重后镜数')
    assert.equal(result.legacyTable, 0, 'storyboard_clips 已删除')
    // 多 clip 的那一镜取 replace（duration 5），并记 migrated_multi_clip
    const multiIndex = result.storyboardIds.indexOf(seeded.sbMulti)
    assert.equal(result.durations[multiIndex], 5, '同镜多行取 replace（不是 pre 的 2 秒）')
    assert.deepEqual(result.reasons[multiIndex].sort(), ['base_ref_unresolved', 'migrated_multi_clip'],
      '多 clip + 底图反查不到（种子没有资产）两条原因同时记录')
    // 单 clip 的那一镜：只有底图反查不到（种子没有资产），没有 migrated_multi_clip
    const singleIndex = result.storyboardIds.indexOf(seeded.sbA)
    assert.deepEqual(result.reasons[singleIndex], ['base_ref_unresolved'])
    // combo 为空的那一镜
    const noComboIndex = result.storyboardIds.indexOf(seeded.sbNoCombo)
    assert.deepEqual(result.reasons[noComboIndex].sort(), ['base_ref_unresolved', 'combo_missing'])
    // 全部判草稿（旧签名作废，需重渲染）
    assert.deepEqual(result.statuses, ['draft', 'draft', 'draft'], '旧渲染一律判草稿（签名重算后需重渲染）')
    assert.deepEqual(result.junctions, [[null, null], [null, null], [null, null]])
    // 签名按新口径重算（'seg-v1' 的 sha256 十六进制），不是旧的 'clip-v1-old'
    for (const sig of result.signatures) assert.match(sig, /^[0-9a-f]{6}$/)
    // 层文档内容与迁移前一致（规范化后的 JSON）
    assert.equal(result.afterDoc, result.beforeDoc, '迁移后库里的 layer_doc 与迁移前逐字节一致')
    assert.equal(result.afterDoc.includes('marker'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移把 base_ref 反查到资产版本；反查不到则记 base_ref_unresolved', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seg-migrate-'))
  try {
    const env = { SQLITE_PATH: path.join(dir, 'm.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') }
    run(`
      const ts = now()
      const dramaId = Number(db.insert(schema.dramas).values({ title: 'D', aspectRatio: '16:9', projectType: 'documentary', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'E', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      const sbKnown = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, combo: 'A', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      const sbUnknown = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 2, combo: 'A', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      const prop = db.insert(schema.props).values({ dramaId, name: '地图', type: 'map', localPath: 'static/uploads/known.png', faithful: 1, createdAt: ts, updatedAt: ts }).run()
      db.run(sql\`CREATE TABLE IF NOT EXISTS storyboard_clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT, storyboard_id INTEGER NOT NULL, position TEXT NOT NULL,
        layer_doc TEXT NOT NULL, timeline TEXT NOT NULL, duration REAL NOT NULL,
        render_path TEXT, render_signature TEXT, rendered_at TEXT,
        status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)\`)
      const insert = (sbId, basePath) => db.run(sql\`INSERT INTO storyboard_clips
        (storyboard_id, position, layer_doc, timeline, duration, status, created_at, updated_at)
        VALUES (\${sbId}, 'replace', \${JSON.stringify({ version: 1, theme: 'archival', base: { path: basePath, width: 960, height: 544 }, layers: [] })},
          \${JSON.stringify({ fps: 25, ease: 'inout', fade_ms: 400, states: [] })}, 4, 'draft', \${ts}, \${ts})\`)
      insert(sbKnown, 'static/uploads/known.png')
      insert(sbUnknown, 'static/uploads/nobody.png')
      out({ propId: Number(prop.lastInsertRowid), sbKnown, sbUnknown })
    `, env)
    const got = run(`
      const { migrateClipsToLayerSegments } = await import('./src/services/layer-segment-migration.ts')
      await migrateClipsToLayerSegments()
      const rows = db.all(sql\`SELECT storyboard_id, base_ref, stale_reasons FROM storyboard_layer_segments ORDER BY storyboard_id\`)
      out({ rows: rows.map(r => ({ id: r.storyboard_id, base: r.base_ref ? JSON.parse(r.base_ref) : null, reasons: JSON.parse(r.stale_reasons) })) })
    `, env)
    const known = got.rows[0]
    const unknown = got.rows[1]
    assert.equal(known.base.kind, 'asset')
    assert.equal(known.base.asset_kind, 'prop')
    assert.deepEqual(known.reasons, [], '反查成功不记 stale')
    assert.equal(unknown.base, null, '反查不到就写 null')
    assert.deepEqual(unknown.reasons, ['base_ref_unresolved'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
