import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'r7-batches-'))
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), STORAGE_PATH: path.join(dir, 'static'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const seed = `
import { db, schema } from './src/db/index.ts'
const ts = new Date().toISOString()
const dramaId = Number(db.insert(schema.dramas).values({ title:'test', projectType:'documentary', createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber:1, title:'E1', narrationEnabled:true, createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
for (const [id,combo,status] of [[1,'A','confirmed'],[2,null,'pending'],[3,'B','pending'],[4,'C','confirmed']]) {
 db.insert(schema.storyboards).values({ id, episodeId, storyboardNumber:id, combo, designCardStatus:status, narrationText:'测试旁白', createdAt:ts, updatedAt:ts }).run()
}
`

test('video scope excludes A, blocks null/unconfirmed, preserves unchanged opt-in and explicit empty selection', () => {
  const result = run(`${seed}
    const {previewEpisodeVideoBatch,videoBatchScopeOf} = await import('./src/services/video-batch.ts')
    const items = await previewEpisodeVideoBatch(episodeId)
    const fresh = {storyboard_id:5,storyboard_number:5,status:'unchanged',checked:false,selectable:true}
    console.log('@@'+JSON.stringify({items, defaults:videoBatchScopeOf([fresh]), forced:videoBatchScopeOf([...items,fresh],[5]), empty:videoBatchScopeOf([fresh],[])}))
  `)
  assert.equal(result.items[0].status, 'excluded')
  assert.equal(result.items[0].reason, 'no_generated_segment')
  assert.equal(result.items[1].status, 'blocked')
  assert.match(result.items[1].reason, /设计卡未确认/)
  assert.match(result.items[2].reason, /设计卡未确认/)
  assert.deepEqual(result.defaults.included, [])
  assert.equal(result.defaults.excluded[0].reason, 'unchanged')
  assert.deepEqual(result.forced.included.map(s => s.storyboard_id), [5])
  assert.equal(result.forced.excluded.length, 4)
  assert.deepEqual(result.empty.included, [])
})

test('layer preview gates saved segments and routes reject client media instead of rendering it', () => {
  const result = run(`${seed}
    const {previewLayerRenderBatch,startLayerRenderBatch} = await import('./src/services/layer-render-batch.ts')
    const items = await previewLayerRenderBatch(episodeId)
    let error
    try { await startLayerRenderBatch(episodeId,dramaId,[1,2,3,4]) } catch(e) { error=e.message }
    const {default:app} = await import('./src/routes/episodes.ts')
    const response = await app.request('/'+episodeId+'/layer-render-batch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyboard_ids:[1],render_path:'/etc/passwd',scope:{included:[{storyboard_id:1,storyboard_number:1}],excluded:[]}})})
    console.log('@@'+JSON.stringify({items,error,status:response.status,tasks:db.select().from(schema.sysTask).all().length}))
  `)
  assert.equal(result.items[2].status, 'excluded')
  assert.match(result.items[0].reason, /尚未制作/)
  assert.match(result.items[1].reason, /设计卡未确认/)
  assert.match(result.error, /没有可渲染/)
  assert.equal(result.status, 400)
  assert.equal(result.tasks, 0)
})

test('voice execution and failed retry persist the same server scope and per-shot outcomes', () => {
  const result = run(`${seed}
    db.insert(schema.aiServiceConfigs).values({serviceType:'tts',provider:'voxcpm',name:'test',baseUrl:'http://invalid.test',apiKey:'',isActive:true,createdAt:ts,updatedAt:ts}).run()
    globalThis.fetch = async () => { throw new Error('deliberate offline voice failure') }
    const {startVoiceBatch,getVoiceBatchStatus,retryFailedVoiceBatch,previewFailedVoiceBatch} = await import('./src/services/narration-voice.ts')
    const started = await startVoiceBatch(episodeId,dramaId,[1,4])
    let status
    for(let i=0;i<100;i++){status=await getVoiceBatchStatus(episodeId);if(status?.status!=='running')break;await new Promise(r=>setTimeout(r,1))}
    const { patchTextTaskParams } = await import('./src/services/text-task.ts')
    const progress = {completed:1,failed:1,total:2,items:status.items.map(item=>({...item,state:item.storyboard_id===4?'completed':item.state}))}
    await patchTextTaskParams(started.task_id,{progress})
    const retryPreview = await previewFailedVoiceBatch(episodeId)
    const retried = await retryFailedVoiceBatch(episodeId,dramaId)
    for(let i=0;i<100;i++){const s=await getVoiceBatchStatus(episodeId);if(s?.status!=='running')break;await new Promise(r=>setTimeout(r,1))}
    const tasks=db.select().from(schema.sysTask).all().filter(t=>t.type==='text').map(t=>JSON.parse(t.params))
    console.log('@@'+JSON.stringify({started,status,retried,retryPreview,tasks}))
  `)
  assert.deepEqual(result.started.scope.included.map(s => s.storyboard_id), [1,4])
  assert.equal(result.started.scope.excluded.length, 2)
  assert.equal(result.status.items[0].state, 'failed')
  assert.deepEqual(result.tasks[0].scope, result.started.scope)
  assert.deepEqual(result.retried.scope, result.retryPreview.scope)
  assert.deepEqual(result.tasks[1].scope, result.retryPreview.scope)
  assert.deepEqual(result.retried.scope.included.map(s => s.storyboard_id), [1])
  assert.equal(result.retried.scope.excluded.length, 3)
  assert.deepEqual(result.tasks[1].storyboardIds, [1])
})

test('layer execution and retry keep scope while recording failed render outcomes', () => {
  const result = run(`${seed}
    const { normalizeLayerDoc } = await import('./src/services/layer-doc.ts')
    const { normalizeTimeline } = await import('./src/services/segment-timeline.ts')
    db.insert(schema.storyboardLayerSegments).values({
      storyboardId:1, layerDoc:JSON.stringify(normalizeLayerDoc({version:1,theme:'archival',base:{path:'static/missing-test-base.png',width:320,height:180},layers:[]})),
      timeline:JSON.stringify(normalizeTimeline({fps:25,keyframes:[{t:0,viewport:{x:0,y:0,w:1,h:1},visible:[]}]})),
      duration:1, status:'draft', createdAt:ts, updatedAt:ts,
    }).run()
    const {startLayerRenderBatch,getLayerRenderBatchStatus,retryFailedLayerRenderBatch} = await import('./src/services/layer-render-batch.ts')
    const started=await startLayerRenderBatch(episodeId,dramaId,[1])
    let status
    for(let i=0;i<100;i++){status=await getLayerRenderBatchStatus(episodeId);if(status?.status!=='running')break;await new Promise(r=>setTimeout(r,1))}
    const retried=await retryFailedLayerRenderBatch(episodeId,dramaId)
    for(let i=0;i<100;i++){const s=await getLayerRenderBatchStatus(episodeId);if(s?.status!=='running')break;await new Promise(r=>setTimeout(r,1))}
    const params=db.select().from(schema.sysTask).all().filter(t=>t.type==='text').map(t=>JSON.parse(t.params))
    console.log('@@'+JSON.stringify({started,status,retried,params}))
  `)
  assert.equal(result.status.items[0].state, 'failed')
  assert.deepEqual(result.started.scope, result.retried.scope)
  assert.deepEqual(result.params[0].scope, result.params[1].scope)
  assert.deepEqual(result.params[1].storyboardIds, [1])
})

test('task center exposes the exact persisted scope for video parents and text batches', () => {
  const result = run(`${seed}
    const scope = {included:[{storyboard_id:4,storyboard_number:4}],excluded:[{storyboard_id:1,storyboard_number:1,reason:'no_generated_segment'}]}
    db.insert(schema.videoBatches).values({episodeId,status:'done',options:JSON.stringify({scope}),items:'[]',createdAt:ts,updatedAt:ts}).run()
    const {createTextTask,finishTextTask} = await import('./src/services/text-task.ts')
    const taskId=await createTextTask({kind:'layer_render_batch',episodeId,dramaId,scope,progress:{completed:1,failed:0,total:1}})
    await finishTextTask(taskId,'completed')
    const {listTaskCenter} = await import('./src/services/task-center.ts')
    const center=await listTaskCenter({episodeId,scope:'all'})
    console.log('@@'+JSON.stringify({scope,items:center.items}))
  `)
  const video = result.items.find(item => item.row_type === 'video_batch')
  const text = result.items.find(item => item.row_type === 'task')
  assert.deepEqual(video.scope, result.scope)
  assert.deepEqual(video.params.scope, result.scope)
  assert.deepEqual(text.params.scope, result.scope)
})
