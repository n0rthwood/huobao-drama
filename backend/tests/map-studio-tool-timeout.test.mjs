/**
 * Issue #99 生产验收发现：研究阶段一个外部检索工具 34 分钟没有返回，整个阶段挂住。
 * stageTool 的墙钟上限必须把卡住的工具变成回给模型的错误，而不是让阶段无限等待。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const backend = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'map-tool-timeout-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const script = `
  import { z } from 'zod'
  import { stageTool } from './src/modules/map-studio/agent-loop.ts'
  const session = { stage: 'research', fatal: null }
  const hung = stageTool(session, { id: 'search_sources', description: 'x', inputSchema: z.object({}), timeoutMs: 50,
    execute: () => new Promise(() => {}) })
  const quick = stageTool(session, { id: 'read_source', description: 'x', inputSchema: z.object({}), timeoutMs: 1000,
    execute: async () => ({ ok: true }) })
  const started = Date.now()
  const timedOut = await hung.execute({}, {})
  const elapsed = Date.now() - started
  const fine = await quick.execute({}, {})
  console.log(JSON.stringify({ timedOut, elapsed, fine, fatal: session.fatal }))
`

test('卡住的工具在墙钟上限后以错误回给模型，阶段不被挂死；正常工具不受影响', () => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backend,
    env: { ...process.env, HUOBAO_DATA_DIR: dir, SQLITE_PATH: path.join(dir, 'test.sqlite3'), STORAGE_PATH: path.join(dir, 'static') },
    encoding: 'utf8',
  })
  const result = JSON.parse(out.trim().split('\n').pop())
  assert.match(result.timedOut.error, /search_sources 超过 \d+ 秒没有返回/)
  assert.ok(result.elapsed < 5000, `应在上限附近返回，实际 ${result.elapsed}ms`)
  assert.deepEqual(result.fine, { ok: true })
  assert.equal(result.fatal, null)
})
