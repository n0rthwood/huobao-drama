import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Issue #123：草稿状态机与并发/取消/重启守卫。用 registry 注入可控 Host/Platform 替身
// （不打外网、不计费）；LLM 展开本身由隔离 QA 与生产验收证明。
const backendRoot = fileURLToPath(new URL('..', import.meta.url))
function isolated(script) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-draft-'))
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: join(dir, 'db.sqlite3'), HUOBAO_DATA_DIR: dir },
      timeout: 60000,
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2).split('\n')[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BOOT = `
  import fs from 'node:fs'
  import { db, schema, sqlite } from './src/db/index.ts'
  import { initAssetStudio, registerAssetStudioHost } from './src/modules/asset-studio/index.ts'
  import { setAssetStudioPlatform } from './src/modules/asset-studio/registry.ts'
  import { createDraft, editDraft, retryDraft, generateFromDraft, getDraft, listDrafts } from './src/modules/asset-studio/drafts.ts'
  import { cancelRun, resumeAssetStudioRuns, findActiveRun } from './src/modules/asset-studio/run.ts'
  import { getRun, parseParams } from './src/modules/asset-studio/db.ts'
  import { listRounds, patchRound } from './src/modules/asset-studio/store.ts'
  import { addAssetSource, syncUserReferences, removeUserReferenceSource } from './src/modules/asset-studio/sources.ts'
  await initAssetStudio({ researchKeys: async () => ({}) })
  import { getAbsolutePath } from './src/utils/storage.ts'
  import sharp from 'sharp'
  const fakePng = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#aabbcc' } }).png().toBuffer()
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({ title: 'T', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const assetId = Number(db.insert(schema.props).values({ name: 'P', dramaId, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  fs.mkdirSync(getAbsolutePath('static/images'), { recursive: true })
  fs.writeFileSync(getAbsolutePath('static/images/v1.png'), fakePng)
  fs.writeFileSync(getAbsolutePath('static/images/v2.png'), fakePng)
  const versionId = Number(db.insert(schema.sysTask).values({ type: 'image', propId: assetId, dramaId, provider: 'upload', localPath: 'static/images/v1.png', resultUrl: 'static/images/v1.png', status: 'completed', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  db.update(schema.props).set({ imageUrl: 'static/images/v1.png', localPath: 'static/images/v1.png' }).run()
  sqlite.prepare("INSERT INTO asset_studio_task (id, host_ref, title, created_at, updated_at) VALUES (1, 'prop:" + assetId + "', 'P', ?, ?)").run(ts, ts)
  const snapshot = { kind: 'prop', id: assetId, dramaId, episodeId: null, name: 'P', description: '测试道具', appearance: null, styling: null, prompt: null, lighting: null, subtype: null, finalPrompt: null, imageUrl: 'static/images/v1.png', faithful: false, isMap: false, referenceImages: [], fingerprint: 'fp1' }
  registerAssetStudioHost({
    id: 'huobao',
    describe: async () => ({ title: 'P', subtitle: null, return_path: null }),
    readAsset: async () => snapshot,
    adoptOriginal: async () => ({ adopted: false }),
    deliver: async () => ({ versionId: null, message: '' }),
    invalidateFinalPrompt: async () => {},
    semanticsContext: async () => ({ labels: [], expected: [] }),
    listVersions: async () => [{ id: versionId, url: 'static/images/v1.png', is_current: true }, { id: versionId + 1, url: 'static/images/v2.png', is_current: false }],
    addReferenceImage: async () => [],
    removeReferenceImage: async () => [],
  })
  const calls = { submitted: [], cancelled: [] }
  let pollStatus = 'pending'
  let pollPath = null
  setAssetStudioPlatform({
    submitImage: async (input) => { calls.submitted.push(input); return { taskId: 9000 + calls.submitted.length } },
    pollImage: async () => ({ status: pollStatus, path: pollPath, error: pollStatus === 'failed' ? 'fixture fail' : null }),
    imageInputs: async () => ({}),
    cancelImage: async (id) => { calls.cancelled.push(id) },
    adoptOrphanImage: async () => null,
    stylePrompt: async () => null,
    sceneSize: async () => '1344x768',
    researchKeys: async () => ({}),
    imageSelection: async (input) => ({ configId: input.configId ?? 7, model: input.model ?? 'fixture-image', generator: 'fixture:fixture-image' }),
    modelOptions: async () => [],
    checkSemantics: async () => ({ status: 'not_applicable', detail: '' }),
  })
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const readyBeautify = async () => {
    const draft = await createDraft(1, { tab: 'beautify', inputs: { version_task_id: versionId, notes: '提升质感' } })
    // 替身无 LLM：展开会 failed；等展开落定后置 ready（模拟展开完成），冻结 prompt/配置
    for (let i = 0; i < 100 && getDraft(draft.id).status === 'drafting'; i++) await sleep(20)
    sqlite.prepare("UPDATE asset_studio_draft SET status='ready', prompt='beautify prompt', image_config_id=7, image_model='fixture-image', error_msg=NULL WHERE id=?").run(draft.id)
    return getDraft(draft.id)
  }
`

test('generate 原子认领：并发双击只有一个成功，另一个 409', () => {
  const out = isolated(`
    ${BOOT}
    const draft = await readyBeautify()
    // 让第一次生图停在 pending poll：草稿稳定在 generating，第二次提交必 409
    const first = await generateFromDraft(draft.id)
    for (let i = 0; i < 100 && !calls.submitted.length; i++) await sleep(30)
    let secondError = null
    try { await generateFromDraft(draft.id) } catch (err) { secondError = err.constructor.name }
    console.log('@@' + JSON.stringify({
      firstRunId: first.runId,
      secondError,
      submitted: calls.submitted.length,
      draftStatus: getDraft(draft.id).status,
    }))
    process.exit(0)
  `)
  assert.ok(out.firstRunId > 0)
  assert.ok(['PipelineConflictError', 'PipelineStateError'].includes(out.secondError), 'second submit rejected while first is generating')
  assert.equal(out.submitted, 1)
  assert.equal(out.draftStatus, 'generating')
})

test('取消后迟到写回被挡：run 不复活，草稿可编辑重试', () => {
  const out = isolated(`
    ${BOOT}
    const draft = await readyBeautify()
    const { runId } = await generateFromDraft(draft.id)
    // 等执行体下单并落 image_task_id（避免与 cancel 竞态）
    let rounds = await listRounds(runId)
    for (let i = 0; i < 100 && !rounds[0]?.image_task_id; i++) { await sleep(20); rounds = await listRounds(runId) }
    await cancelRun(runId)
    // 模拟迟到的完成回调：poll 变 completed，但执行体已在 assertRunning 处中止
    pollStatus = 'completed'; pollPath = 'static/images/v2.png'
    await sleep(100)
    const run = getRun(runId)
    const round = (await listRounds(runId))[0]
    // consumed/ready 可 edit；这里草稿被取消后停在 consumed（error），edit 复活
    sqlite.prepare("UPDATE asset_studio_draft SET status='consumed' WHERE id=?").run(draft.id)
    const edited = editDraft(draft.id, { prompt: 'retry prompt' })
    console.log('@@' + JSON.stringify({ runStatus: run.status, roundStatus: round.status, cancelled: calls.cancelled, editedStatus: edited.status, editedPrompt: edited.prompt }))
    process.exit(0)
  `)
  assert.equal(out.runStatus, 'cancelled')
  assert.equal(out.roundStatus, 'discarded')
  assert.deepEqual(out.cancelled, [9001])
  assert.equal(out.editedStatus, 'ready')
  assert.equal(out.editedPrompt, 'retry prompt')
})

test('QC 失败不污染出图成功：run completed + qc_error，草稿 consumed', () => {
  const out = isolated(`
    ${BOOT}
    // 精确草稿：有 notes 即可（0 图合法）；spec 步会因无 LLM 失败，直接造 ready + spec_id
    const specId = Number(sqlite.prepare("INSERT INTO asset_studio_spec (asset_kind, asset_id, version, summary, must_have, forbidden, tolerances, uncertainties, sources, created_by_stage, created_at) VALUES ('prop', ?, 1, 's', '[]', '[]', '[]', '[]', '[]', 'fixture', ?)").run(assetId, ts).lastInsertRowid)
    const draft = await createDraft(1, { tab: 'precision', inputs: { source_ids: [], research: [], notes: '画一只猞猁' } })
    for (let i = 0; i < 100 && getDraft(draft.id).status === 'drafting'; i++) await sleep(20)
    sqlite.prepare("UPDATE asset_studio_draft SET status='ready', prompt='precision prompt', spec_id=?, image_config_id=7, image_model='fixture-image' WHERE id=?").run(specId, draft.id)
    pollStatus = 'completed'; pollPath = 'static/images/v2.png'
    const { runId } = await generateFromDraft(draft.id)
    // runQc 会因 resolveStageModel('asset_qc') 无配置抛错 → 顾问性失败只记 qc_error
    for (let i = 0; i < 100 && getRun(runId).status === 'running'; i++) await sleep(50)
    const run = getRun(runId)
    const params = parseParams(run.params)
    console.log('@@' + JSON.stringify({ runStatus: run.status, qcError: Boolean(params.qc_error), draftStatus: getDraft(draft.id).status, roundStatus: (await listRounds(runId))[0].status }))
  `)
  assert.equal(out.runStatus, 'completed')
  assert.equal(out.qcError, true)
  assert.equal(out.draftStatus, 'consumed')
  assert.equal(out.roundStatus, 'generated')
})

test('failed 草稿只能 retry 重新展开，不能 edit；ready/consumed 可 edit', () => {
  const out = isolated(`
    ${BOOT}
    const draft = await createDraft(1, { tab: 'beautify', inputs: { version_task_id: versionId, notes: '' } })
    for (let i = 0; i < 100 && getDraft(draft.id).status === 'drafting'; i++) await sleep(50)
    const failed = getDraft(draft.id)
    let editError = null
    try { editDraft(draft.id, { prompt: 'x' }) } catch (err) { editError = err.constructor.name }
    const retried = await retryDraft(draft.id)
    let retryAgainError = null
    try { await retryDraft(draft.id) } catch (err) { retryAgainError = err.constructor.name }
    console.log('@@' + JSON.stringify({ failedStatus: failed.status, hasError: Boolean(failed.error_msg), editError, retriedStatus: retried.status, retryAgainError }))
  `)
  assert.equal(out.failedStatus, 'failed')
  assert.equal(out.hasError, true)
  assert.equal(out.editError, 'PipelineStateError')
  assert.equal(out.retriedStatus, 'drafting')
  assert.equal(out.retryAgainError, 'PipelineStateError')
})

test('输入漂移：版本图文件缺失 → generate 400 要求重新展开', () => {
  const out = isolated(`
    ${BOOT}
    const draft = await readyBeautify()
    fs.unlinkSync(getAbsolutePath('static/images/v1.png'))
    let error = null
    try { await generateFromDraft(draft.id) } catch (err) { error = { name: err.constructor.name, message: err.message } }
    console.log('@@' + JSON.stringify({ error, draftStatus: getDraft(draft.id).status }))
  `)
  assert.equal(out.error.name, 'DraftInputError')
  assert.match(out.error.message, /重新选择版本/)
  assert.equal(out.draftStatus, 'ready')
})

test('expected_updated_at 不匹配 → 409（防确认新稿生成旧稿）', () => {
  const out = isolated(`
    ${BOOT}
    const draft = await readyBeautify()
    let error = null
    try { await generateFromDraft(draft.id, { expected_updated_at: '1999-01-01T00:00:00.000Z' }) } catch (err) { error = err.constructor.name }
    console.log('@@' + JSON.stringify({ error, submitted: calls.submitted.length }))
  `)
  assert.equal(out.error, 'PipelineConflictError')
  assert.equal(out.submitted, 0)
})

test('重启矩阵：running/suspended run → interrupted；drafting → failed；research running → failed', () => {
  const out = isolated(`
    ${BOOT}
    sqlite.prepare("INSERT INTO asset_studio_task (id, host_ref, title, created_at, updated_at) VALUES (2, 'prop:" + (assetId + 1) + "', 'P2', ?, ?)").run(ts, ts)
    sqlite.prepare("INSERT INTO asset_studio_run (id, task_id, status, purpose, params, created_at, updated_at) VALUES (50, 1, 'running', 'precision', '{}', ?, ?)").run(ts, ts)
    sqlite.prepare("INSERT INTO asset_studio_run (id, task_id, status, purpose, params, created_at, updated_at) VALUES (51, 2, 'suspended', 'beautify', '{}', ?, ?)").run(ts, ts)
    sqlite.prepare("INSERT INTO asset_studio_draft (task_id, asset_kind, asset_id, tab, status, inputs, created_at, updated_at) VALUES (1, 'prop', ?, 'beautify', 'drafting', '{}', ?, ?)").run(assetId, ts, ts)
    sqlite.prepare("INSERT INTO asset_studio_research (host_ref, status, step, created_at, updated_at) VALUES ('prop:" + assetId + "', 'running', 'plan', ?, ?)").run(ts, ts)
    await resumeAssetStudioRuns()
    console.log('@@' + JSON.stringify({
      run50: getRun(50).status, run51: getRun(51).status,
      draft: sqlite.prepare('SELECT status FROM asset_studio_draft WHERE task_id=1').get().status,
      research: sqlite.prepare('SELECT status FROM asset_studio_research').get().status,
      active: await findActiveRun('prop', assetId),
    }))
  `)
  assert.equal(out.run50, 'interrupted')
  assert.equal(out.run51, 'interrupted')
  assert.equal(out.draft, 'failed')
  assert.equal(out.research, 'failed')
  assert.equal(out.active, null)
})

test('同 sha 多来源合并：sync 不覆盖已入库检索素材的 origin/role；删用户参考图只删 user_reference 行', () => {
  const out = isolated(`
    ${BOOT}
    fs.mkdirSync(getAbsolutePath('static/uploads/reference_images/prop/' + assetId), { recursive: true })
    const refPath = 'static/uploads/reference_images/prop/' + assetId + '/ref.png'
    fs.writeFileSync(getAbsolutePath(refPath), 'same-bytes')
    // 先以 research 入库同内容
    const research = await addAssetSource({ assetKind: 'prop', assetId, localPath: refPath, license: 'CC BY-SA 4.0', role: 'original', origin: 'research', title: '检索原件' })
    // 资产参考图指向同内容 → sync 不应改写 origin/role/license
    snapshot.referenceImages = [{ path: refPath }]
    await syncUserReferences(1)
    const afterSync = sqlite.prepare('SELECT origin, role, license, title FROM asset_studio_source WHERE id=?').get(research.id)
    // 删除用户参考图关系：research 行不受影响
    removeUserReferenceSource('prop', assetId, refPath)
    const afterRemove = sqlite.prepare('SELECT origin FROM asset_studio_source WHERE id=?').get(research.id)
    // 反向：先 user_reference 入库，再 research 入库同内容 → 保留 user_reference
    fs.writeFileSync(getAbsolutePath('static/images/another.png'), 'other-bytes')
    const user = await addAssetSource({ assetKind: 'prop', assetId, localPath: 'static/images/another.png', license: '用户参考图', role: 'generation_reference', origin: 'user_reference' })
    await addAssetSource({ assetKind: 'prop', assetId, localPath: 'static/images/another.png', license: 'CC0', role: 'shape_only', origin: 'research' })
    const userAfter = sqlite.prepare('SELECT origin, role FROM asset_studio_source WHERE id=?').get(user.id)
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM asset_studio_source WHERE asset_id=?').get(assetId).n
    console.log('@@' + JSON.stringify({ afterSync, afterRemove: afterRemove.origin, userAfter, count }))
  `)
  assert.deepEqual(out.afterSync, { origin: 'research', role: 'original', license: 'CC BY-SA 4.0', title: '检索原件' })
  assert.equal(out.afterRemove, 'research')
  assert.deepEqual(out.userAfter, { origin: 'user_reference', role: 'generation_reference' })
  assert.equal(out.count, 2)
})