import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
function isolated(script) {
  const dir = mkdtempSync(join(tmpdir(), 'huobao-pipeline-approval-'))
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2).split('\n')[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('only a current active approval suspension is waiting', () => {
  const result = isolated(`
    import { pipelineExecutionFromSnapshot as summary } from './src/services/asset-pipeline/execution.ts'
    const suspended = { status: 'suspended', suspendedPaths: { approval_0: [2] }, steps: { approval_0: { suspendPayload: { round_id: 4, round_no: 0 } } } }
    const get = (status, snapshot) => summary(status, 'prop', 100, snapshot)
    console.log('@@' + JSON.stringify({
      waiting: get('processing', suspended), running: get('processing', { status: 'running' }),
      resumed: get('processing', { status: 'success' }), terminal: get('completed', suspended),
      failed: get('failed', suspended), cancelled: get('cancelled', suspended),
      missing: get('processing', null), malformed: get('processing', { ...suspended, steps: {} }),
      other: get('processing', { ...suspended, suspendedPaths: { research: [0] } }),
    }))
  `)
  assert.deepEqual(result.waiting, { state: 'waiting_approval', awaiting: { round_id: 4, round_no: 0 }, asset_kind: 'prop', asset_id: 100 })
  assert.equal(result.running.state, 'running')
  for (const key of ['resumed', 'missing', 'malformed', 'other']) {
    assert.equal(result[key].state, 'unknown')
    assert.equal(result[key].awaiting, null)
  }
  for (const key of ['terminal', 'failed', 'cancelled']) assert.equal(result[key].awaiting, null)
  assert.equal(result.terminal.state, 'completed')
  assert.equal(result.failed.state, 'failed')
  assert.equal(result.cancelled.state, 'cancelled')
})

test('stored computed gates survive persistence; historical gates report unknown semantics', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { evaluateGate } from './src/services/asset-pipeline/gate.ts'
    import { insertQcRecord, latestQcByRound } from './src/services/asset-pipeline/store.ts'
    import { serializeQcGate } from './src/services/asset-pipeline/gate-serialization.ts'
    const spec = { must_have: [{ id: 'm1', element: '两个轮子', why: '', check: '', metric: 'count' }], forbidden: [], tolerances: [], locate_targets: [], locate_anchors: [] }
    const verdicts = { must_have: [{ id: 'm1', verdict: 'minor', evidence: '只有一个' }], forbidden: [], text_in_image: { present: false, evidence: '无文字' }, overall: 'pass' }
    const gate = evaluateGate(spec, verdicts, { semanticsPreserved: { status: 'fail', detail: '标注丢失' } })
    const created = await insertQcRecord({ roundId: 1, assetKind: 'prop', assetId: 100, modelConfigId: null, verdicts, gate, fidelityScore: null, beautyScore: null, suggestions: [] })
    db.insert(schema.assetQcRecord).values({ roundId: 2, assetKind: 'prop', assetId: 100, gatePass: 1, verdicts: JSON.stringify(verdicts), humanVerdict: 'approve', humanNotes: '已审', createdAt: new Date().toISOString() }).run()
    const rows = await latestQcByRound([1, 2])
    const historical = rows.get(2)
    console.log('@@' + JSON.stringify({ gate, saved: serializeQcGate(rows.get(1), spec), created, historical, oldGate: serializeQcGate(historical, spec) }))
  `)
  assert.deepEqual(result.saved, result.gate)
  assert.equal(result.saved.violations[0].id, 'm1')
  assert.equal(result.saved.semantics_preserved.status, 'fail')
  assert.equal(result.oldGate.pass, true)
  assert.deepEqual(result.oldGate.semantics_preserved, { status: 'unknown', detail: '历史记录未保存此项核验结果' })
  assert.equal(result.historical.human_verdict, 'approve')
  assert.equal(result.historical.human_notes, '已审')
})

test('task center exposes pipeline state without trusting stale approval progress', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { createTextTask, patchTextTaskParams } from './src/services/text-task.ts'
    import { enrichTask, listTaskCenter, listActiveTasks } from './src/services/task-center.ts'
    const ts = new Date().toISOString()
    const dramaId = Number(db.insert(schema.dramas).values({ title: 'Test', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Test', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
    const id = await createTextTask({ kind: 'asset_pipeline', episodeId, dramaId, prompt: 'test', provider: 'mastra', model: 'asset-pipeline' })
    await patchTextTaskParams(id, { asset_kind: 'prop', asset_id: 100, progress: { step: 'approval', completed: 0, total: 0, failed: 0 } })
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    const detail = await enrichTask(row)
    const center = await listTaskCenter({ scope: 'all' })
    const active = await listActiveTasks()
    console.log('@@' + JSON.stringify({ id, detail, center, active }))
  `)
  const expected = { state: 'unknown', awaiting: null, asset_kind: 'prop', asset_id: 100 }
  assert.deepEqual(result.detail.pipeline, expected)
  assert.deepEqual(result.center.items.find(row => row.id === result.id && row.row_type === 'task').pipeline, expected)
  assert.deepEqual(result.active.items.find(row => row.id === result.id).pipeline, expected)
})
