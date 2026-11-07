import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
function isolated(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'text-task-queue-'))
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', body], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2).split('\n')[0])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('queued text tasks start only once and recovery dispatches persisted arguments', () => {
  const result = isolated(`
    import { eq } from 'drizzle-orm'
    import { db, schema } from './src/db/index.ts'
    import { createTextTask, markTextTaskStarted } from './src/services/text-task.ts'
    import { resumeQueuedTextTasks } from './src/services/text-task-restart.ts'
    const started = await createTextTask({kind:'asset_review', episodeId:1, queued:true})
    await markTextTaskStarted(started)
    const queued = await createTextTask({kind:'asset_review', episodeId:1, queued:true, restart:{kind:'asset_review',args:{episodeId:1}}})
    const transient = await createTextTask({kind:'storyboard_breaker', episodeId:1, queued:true})
    const calls = []
    await resumeQueuedTextTasks(async (restart, retryOf) => { calls.push({restart,retryOf}) })
    await markTextTaskStarted(transient)
    const rows = await db.select().from(schema.sysTask)
    console.log('@@'+JSON.stringify({started,queued,transient,calls,rows:rows.map(r=>({id:r.id,status:r.status}))}))
  `)
  assert.equal(result.rows.find(r => r.id === result.started).status, 'processing')
  assert.equal(result.rows.find(r => r.id === result.queued).status, 'cancelled')
  assert.equal(result.rows.find(r => r.id === result.transient).status, 'cancelled')
  assert.deepEqual(result.calls, [{ restart: { kind: 'asset_review', args: { episodeId: 1 } }, retryOf: result.queued }])
})

test('same episode and extraction type are serialized until post-processing completes', () => {
  const result = isolated(`
    import { withExtractionLock } from './src/services/extraction.ts'
    const events = []
    let release
    const gate = new Promise(resolve => { release = resolve })
    const first = withExtractionLock('episode:1:extract_props', async () => { events.push('first-start'); await gate; events.push('first-end') })
    const second = withExtractionLock('episode:1:extract_props', async () => { events.push('second-start') })
    const other = withExtractionLock('episode:1:extract_scenes', async () => { events.push('other') })
    await other
    release()
    await Promise.all([first, second])
    console.log('@@'+JSON.stringify(events))
  `)
  assert.ok(result.indexOf('other') < result.indexOf('first-end'))
  assert.ok(result.indexOf('first-end') < result.indexOf('second-start'))
})
