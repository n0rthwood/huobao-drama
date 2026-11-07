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

test('recovery refuses a queued asset batch with an already submitted image', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { createTextTask, patchTextTaskParams } from './src/services/text-task.ts'
    import { resumeQueuedTextTasks } from './src/services/text-task-restart.ts'
    const id = await createTextTask({kind:'asset_batch', episodeId:1, queued:true, restart:{kind:'asset_batch',args:{}}})
    await patchTextTaskParams(id, {asset_batch:{items:[{state:'submitted',task_id:99}]}})
    const calls = []
    await resumeQueuedTextTasks(async (...args) => { calls.push(args) })
    const [row] = await db.select().from(schema.sysTask)
    console.log('@@'+JSON.stringify({status:row.status,error:row.errorMsg,calls}))
  `)
  assert.equal(result.status, 'failed')
  assert.match(result.error, /已有图片任务/)
  assert.deepEqual(result.calls, [])
})

test('review extraction returns the new queued task while same-kind extraction is active', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { createTextTask } from './src/services/text-task.ts'
    import { withExtractionLock } from './src/services/extraction.ts'
    import { fingerprintOf } from './src/services/asset-review.ts'
    import { assetReviewItems } from './src/routes/asset-review.ts'
    const at = new Date().toISOString()
    db.insert(schema.dramas).values({id:1,title:'doc',projectType:'documentary',createdAt:at,updatedAt:at}).run()
    db.insert(schema.episodes).values({id:1,dramaId:1,episodeNumber:1,title:'E1',createdAt:at,updatedAt:at}).run()
    db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'test',baseUrl:'https://example.invalid',apiKey:'',model:JSON.stringify(['test']),isActive:true,createdAt:at,updatedAt:at}).run()
    const item = Number(db.insert(schema.assetReviewItems).values({episodeId:1,runId:1,segmentNo:1,narrationExcerpt:'x',infoPoint:'甲',needKind:'character',needDesc:'甲',status:'missing',fingerprint:fingerprintOf('甲','character'),createdAt:at,updatedAt:at}).run().lastInsertRowid)
    const active = await createTextTask({kind:'extract_characters',episodeId:1,dramaId:1})
    void withExtractionLock('episode:1:extract_characters', () => new Promise(() => {}))
    const response = await assetReviewItems.request('/items/'+item+'/extract', {method:'POST'})
    const body = await response.json()
    const rows = await db.select().from(schema.sysTask)
    console.log('@@'+JSON.stringify({status:response.status,body,active,rows:rows.map(r=>({id:r.id,status:r.status,params:JSON.parse(r.params)})),item}))
  `)
  assert.equal(result.status, 200)
  const created = result.rows.find(row => row.id === result.body.data.task_id)
  assert.ok(created)
  assert.notEqual(created.id, result.active)
  assert.equal(created.status, 'queued')
  assert.equal(created.params.assetReviewItemId, result.item)
})

test('only a safe first model failure requeues once on another endpoint', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { createTextTask, finishTextTask, parseTextTaskParams } from './src/services/text-task.ts'
    import { resolveStageModel } from './src/services/ai-stages.ts'
    import { requeueFirstModelFailure } from './src/services/text-task-restart.ts'
    import { withExtractionLock } from './src/services/extraction.ts'
    const at = new Date().toISOString()
    for (const [id,priority] of [[1,100],[2,90]]) db.insert(schema.aiServiceConfigs).values({id,serviceType:'text',provider:'openai',name:'test'+id,baseUrl:'https://example.invalid',apiKey:'',model:JSON.stringify(['model'+id]),isActive:true,priority,createdAt:at,updatedAt:at}).run()
    const stage = await resolveStageModel('extractor')
    const restart = {kind:'extract_characters',args:{episodeId:1,dramaId:1,target:'characters',opts:{}}}
    const id = await createTextTask({kind:'extract_characters',episodeId:1,dramaId:1,queued:true,stageModel:stage,restart})
    await finishTextTask(id,'failed',{errorMsg:'failure'})
    void withExtractionLock('episode:1:extract_characters', () => new Promise(() => {}))
    const unsafe = await requeueFirstModelFailure(id,{status:503},false)
    const started = await requeueFirstModelFailure(id,{status:503},true)
    const repeated = await requeueFirstModelFailure(id,{status:503},true)
    const rows = await db.select().from(schema.sysTask)
    console.log('@@'+JSON.stringify({id,unsafe,started,repeated,rows:rows.map(r=>({id:r.id,params:parseTextTaskParams(r.params)}))}))
  `)
  assert.equal(result.unsafe, false)
  assert.equal(result.started, true)
  assert.equal(result.repeated, false)
  const original = result.rows.find(row => row.id === result.id)
  const next = result.rows.find(row => row.id !== result.id)
  assert.notEqual(next.params.configId, original.params.configId)
  assert.equal(next.params.retry_of, result.id)
  assert.equal(next.params.auto_retry, 1)
})

test('attempt history records actual endpoint attribution', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { createTextTask, recordTextTaskAttempt } from './src/services/text-task.ts'
    const id = await createTextTask({kind:'asset_review',episodeId:1,queued:true})
    await recordTextTaskAttempt(id,{config_id:1,model:'first',error_class:'timeout'})
    await recordTextTaskAttempt(id,{config_id:2,model:'second',error_class:null},{configId:2,provider:'openai',model:'second',name:'second endpoint',vision:false})
    const [row] = await db.select().from(schema.sysTask)
    console.log('@@'+JSON.stringify({provider:row.provider,model:row.model,params:JSON.parse(row.params)}))
  `)
  assert.equal(result.provider, 'openai')
  assert.equal(result.model, 'second')
  assert.deepEqual(result.params.attempts.map(item => item.config_id), [1, 2])
  assert.equal(result.params.model_used.config_id, 2)
})

test('first-call requeue leaves an explicitly pinned configuration alone', () => {
  const result = isolated(`
    import { db, schema } from './src/db/index.ts'
    import { createTextTask, finishTextTask } from './src/services/text-task.ts'
    import { resolveStageModel } from './src/services/ai-stages.ts'
    import { requeueFirstModelFailure } from './src/services/text-task-restart.ts'
    const at = new Date().toISOString()
    db.insert(schema.aiServiceConfigs).values({id:1,serviceType:'text',provider:'openai',name:'test',baseUrl:'https://example.invalid',apiKey:'',model:JSON.stringify(['test']),isActive:true,createdAt:at,updatedAt:at}).run()
    const stage = await resolveStageModel('extractor',{configId:1})
    const restart = {kind:'extract_characters',args:{episodeId:1,dramaId:1,target:'characters',opts:{configId:1}}}
    const id = await createTextTask({kind:'extract_characters',episodeId:1,queued:true,stageModel:stage,restart})
    await finishTextTask(id,'failed',{errorMsg:'failure'})
    const started = await requeueFirstModelFailure(id,{status:503},true)
    const rows = await db.select().from(schema.sysTask)
    console.log('@@'+JSON.stringify({started,count:rows.length}))
  `)
  assert.deepEqual(result, {started:false,count:1})
})
