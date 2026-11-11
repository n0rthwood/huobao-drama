import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)

test('角色定妆照固定 16:9：尺寸表不随项目画幅变化', () => {
  // 尺寸的唯一来源是 assetImageSizeFor（Issue #94 把常量从 routes 搬进 asset-image-size.ts）
  const script = `
    import { assetImageSizeFor } from './src/services/asset-image-size.ts'
    console.log('@@' + JSON.stringify(['16:9', '9:16', '1:1'].map(a => assetImageSizeFor('character', a))))
  `
  const dir = mkdtempSync(join(tmpdir(), 'huobao-character-size-'))
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    assert.deepEqual(JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2)), ['1920x1080', '1920x1080', '1920x1080'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
