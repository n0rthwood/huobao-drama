import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #122：QC 闸门持久化与历史只读语义迁到资产工作室模块后的行为回归。
// 旧「任务中心内嵌审批状态」测试随内嵌审批删除而移除；审批状态现由模块 runView 推导（routes.ts）。
const backendRoot = fileURLToPath(new URL('..', import.meta.url))
function isolated(script) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-approval-'))
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2).split('\n')[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('stored computed gates survive persistence; historical gates report unknown semantics', () => {
  const result = isolated(`
    import { sqlite } from './src/db/index.ts'
    import { initAssetStudio } from './src/modules/asset-studio/index.ts'
    import { evaluateGate } from './src/modules/asset-studio/gate.ts'
    import { insertQcRecord, latestQcByRound } from './src/modules/asset-studio/store.ts'
    import { serializeQcGate } from './src/modules/asset-studio/gate-serialization.ts'
    await initAssetStudio({ researchKeys: async () => ({}) })
    const spec = { must_have: [{ id: 'm1', element: '两个轮子', why: '', check: '', metric: 'count' }], forbidden: [], tolerances: [], locate_targets: [], locate_anchors: [] }
    const verdicts = { must_have: [{ id: 'm1', verdict: 'minor', evidence: '只有一个' }], forbidden: [], text_in_image: { present: false, evidence: '无文字' }, overall: 'pass' }
    const gate = evaluateGate(spec, verdicts, { semanticsPreserved: { status: 'fail', detail: '标注丢失' } })
    const created = await insertQcRecord({ roundId: 1, assetKind: 'prop', assetId: 100, modelConfigId: null, verdicts, gate, fidelityScore: null, beautyScore: null, suggestions: [] })
    // 历史行：只有 gate_pass，没有完整 gate_result（旧记录）
    sqlite.prepare("INSERT INTO asset_studio_qc_record (round_id, asset_kind, asset_id, gate_pass, verdicts, human_verdict, human_notes, created_at) VALUES (2, 'prop', 100, 1, ?, 'approve', '已审', ?)").run(JSON.stringify(verdicts), new Date().toISOString())
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

test('legacy asset_pipeline task rows stay readable in task center without inline approval', () => {
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
  // #122：旧父行只读保留，但不再推导内嵌审批状态（pipeline 字段已删）
  assert.equal(result.detail.pipeline, undefined)
  const centerRow = result.center.items.find(row => row.id === result.id && row.row_type === 'task')
  assert.ok(centerRow, 'legacy row still listed')
  assert.equal(centerRow.pipeline, undefined)
  assert.ok(result.active.items.find(row => row.id === result.id), 'legacy active row still listed')
})