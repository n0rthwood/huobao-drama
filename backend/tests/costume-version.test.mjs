/**
 * 角色造型版本自动选版（Issue #15）。
 * 真跑一次库：临时 SQLite + 仓库自带 tsx 子进程，验证
 * 「本镜绑定的角色有造型图才写入、人工已选不覆盖、未绑定的角色不写」。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const sqlitePath = path.join(mkdtempSync(path.join(tmpdir(), 'costume-')), 'test.sqlite3')

function run() {
  const script = `
    import { db, schema } from './src/db/index.ts'
    import { autofillCostumeSelection } from './src/services/storyboard-assets.ts'
    const ts = new Date().toISOString()
    const version = (name, image) => JSON.stringify({ name, description: '', image_path: image })
    // 两个角色关联到同一集：7 有造型图，8 没有
    await db.insert(schema.episodeCharacters).values({ episodeId: 90, characterId: 7, stylingVersion: version('度假装', 'static/images/costume.png'), createdAt: ts })
    await db.insert(schema.episodeCharacters).values({ episodeId: 90, characterId: 8, stylingVersion: version('常服', ''), createdAt: ts })
    const insertSb = async (id, selection) => {
      await db.insert(schema.storyboards).values({
        id, episodeId: 90, storyboardNumber: id, duration: 9,
        assetVersionSelection: selection, createdAt: ts, updatedAt: ts,
      })
    }
    await insertSb(901, null)                                                   // 空选择 → 自动填
    await insertSb(902, JSON.stringify({ 'character:7': 'static/images/manual.png' })) // 人工已选 → 不覆盖
    await insertSb(903, null)                                                   // 角色未绑定 → 不写
    const out = {
      autofilled: await autofillCostumeSelection(901, [7, 8]),
      manual: await autofillCostumeSelection(902, [7]),
      unbound: await autofillCostumeSelection(903, []),
    }
    process.stdout.write('@@' + JSON.stringify(out))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SQLITE_PATH: sqlitePath },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

test('costume autofill writes only bound characters with an image, never overriding manual picks (Issue #15)', () => {
  const result = run()
  assert.deepEqual(result.autofilled, { 'character:7': 'static/images/costume.png' })
  assert.deepEqual(result.manual, { 'character:7': 'static/images/manual.png' })
  assert.deepEqual(result.unbound, {})
})
