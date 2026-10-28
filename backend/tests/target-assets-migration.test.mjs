/**
 * 生成目标级素材绑定的存量迁移（Issue #18）+ 角色默认图（Issue #15 造型版本）。
 * 真跑一次库：先按旧结构（storyboards 带 asset_version_selection、没有 storyboard_target_assets）
 * 造一个临时 SQLite，再走正式的启动建表流程，验证
 * 「4 个目标都继承分镜绑定、人工选版照抄、与造型图相同的自动选版迁成默认、旧列被删、迁移只跑一次」。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'target-assets-')), 'test.sqlite3')

function run() {
  const script = `
    import Database from 'better-sqlite3'
    import { sqliteSchemaStatements } from './src/db/sqlite-schema.ts'
    const ts = new Date().toISOString()
    const old = new Database(process.env.SQLITE_PATH)
    for (const statement of sqliteSchemaStatements) old.exec(statement)
    old.exec('DROP TABLE storyboard_target_assets')
    old.exec('ALTER TABLE storyboards ADD COLUMN asset_version_selection TEXT')
    const costume = JSON.stringify({ name: '度假装', description: '', image_path: 'static/images/costume.png' })
    old.prepare('INSERT INTO scenes (id, drama_id, location, time, prompt, image_url, created_at, updated_at) VALUES (8, 1, ?, ?, ?, ?, ?, ?)').run('客厅', '午后', '', 'static/images/room.png', ts, ts)
    for (const [id, name] of [[6, '鼠妈妈'], [7, '猴宝宝']]) {
      old.prepare('INSERT INTO characters (id, drama_id, name, image_url, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)').run(id, name, 'static/images/' + id + '.png', ts, ts)
    }
    old.prepare('INSERT INTO props (id, drama_id, name, image_url, created_at, updated_at) VALUES (17, 1, ?, ?, ?, ?)').run('墨镜', 'static/images/glasses.png', ts, ts)
    old.prepare('INSERT INTO episode_scenes (episode_id, scene_id, created_at) VALUES (3, 8, ?)').run(ts)
    old.prepare('INSERT INTO episode_characters (episode_id, character_id, styling_version, created_at) VALUES (3, 6, NULL, ?)').run(ts)
    old.prepare('INSERT INTO episode_characters (episode_id, character_id, styling_version, created_at) VALUES (3, 7, ?, ?)').run(costume, ts)
    old.prepare('INSERT INTO episode_props (episode_id, prop_id, created_at) VALUES (3, 17, ?)').run(ts)
    const selection = JSON.stringify({ 'character:7': 'static/images/costume.png', 'character:6': 'static/images/6-v1.png' })
    // 承接上一镜的首帧没有自有提示词；中间帧 / 尾帧 / 视频都有
    old.prepare('INSERT INTO storyboards (id, episode_id, scene_id, storyboard_number, first_frame_prompt, mid_frame_prompt, last_frame_prompt, video_prompt, asset_version_selection, created_at, updated_at) VALUES (24, 3, 8, 2, ?, ?, ?, ?, ?, ?, ?)')
      .run('', '@客厅 @猴宝宝 扶正帽檐', '@猴宝宝 照镜子', '0-3秒：@猴宝宝 跑向镜子', selection, ts, ts)
    for (const id of [6, 7]) old.prepare('INSERT INTO storyboard_characters (storyboard_id, character_id) VALUES (24, ?)').run(id)
    old.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (24, 17)').run()
    old.close()

    const { initDb } = await import('./src/db/index.ts')
    initDb()
    const { loadEpisodeAssets, loadTargetBindings } = await import('./src/services/storyboard-assets.ts')
    const firstRun = await loadTargetBindings(24)
    // 用户改了中间帧提示词后的状态：再次启动不能重新继承
    const check = new Database(process.env.SQLITE_PATH)
    check.prepare("DELETE FROM storyboard_target_assets WHERE target = 'mid'").run()
    const columns = check.prepare('PRAGMA table_info(storyboards)').all().map(col => col.name)
    check.close()
    initDb()
    const secondRun = await loadTargetBindings(24)
    const assets = await loadEpisodeAssets(3)
    process.stdout.write('@@' + JSON.stringify({ firstRun, secondRun, columns, assets }))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const result = run()

test('every target with its own prompt inherits the storyboard binding; manual picks are kept and costume autofill becomes default (Issue #18)', () => {
  const expected = [
    { kind: 'scene', assetId: 8, selectedImage: null },
    { kind: 'character', assetId: 6, selectedImage: 'static/images/6-v1.png' },
    { kind: 'character', assetId: 7, selectedImage: null },
    { kind: 'prop', assetId: 17, selectedImage: null },
  ]
  const sort = list => [...list].sort((a, b) => `${a.kind}${a.assetId}`.localeCompare(`${b.kind}${b.assetId}`))
  for (const target of ['mid', 'last', 'video']) {
    assert.deepEqual(sort(result.firstRun[target]), sort(expected), target)
  }
  // 首帧没有自有提示词，不会被生成，也就不继承
  assert.deepEqual(result.firstRun.first, [])
  assert.equal(result.columns.includes('asset_version_selection'), false)
})

test('the migration runs once: a cleared target is not re-inherited on the next start', () => {
  assert.deepEqual(result.secondRun.mid, [])
  assert.equal(result.secondRun.last.length, 4)
})

test('a character defaults to its episode costume image, others to their current image (Issue #15)', () => {
  const byName = Object.fromEntries(result.assets.map(asset => [asset.name, asset.defaultImage]))
  assert.equal(byName['猴宝宝'], 'static/images/costume.png')
  assert.equal(byName['鼠妈妈'], 'static/images/6.png')
  assert.equal(byName['客厅'], 'static/images/room.png')
})
