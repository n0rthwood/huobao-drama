import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

test('real SQLite + HTTP: combo eligibility survives stale selections, serial queues, retry and recovery without outside requests', { timeout: 90000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'keyframe-combo-'))
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import { db, schema } from './src/db/index.ts'
const ts = new Date().toISOString()
let outerRequests = 0, localRequests = 0, localRefs = 0, releaseFirst
const originalFetch = globalThis.fetch
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') {
    localRefs++
    // A real asynchronous reference download creates the builder → actual-submit race.
    db.update(schema.storyboards).set({combo:'A'}).where(eq(schema.storyboards.id,4)).run()
    res.setHeader('content-type','image/png')
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=','base64'))
    return
  }
  localRequests++
  for await (const chunk of req) {}
  if (localRequests === 1) await new Promise(resolve => { releaseFirst = resolve })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII='}]}))
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const upstreamPort = upstream.address().port
let apiPort
// Real loopback HTTP is permitted; every other fetch is blocked and counted before any socket opens.
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname !== '127.0.0.1' || ![String(apiPort), String(upstreamPort)].includes(url.port)) {
    outerRequests++; throw new Error('outside request forbidden: ' + url.origin)
  }
  return originalFetch(input, init)
}
const configId = Number(db.insert(schema.aiServiceConfigs).values({serviceType:'image',provider:'openai',name:'loopback image fixture',baseUrl:'http://127.0.0.1:'+upstreamPort,model:JSON.stringify(['local-image']),apiKey:'',isActive:true,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const dramaId = Number(db.insert(schema.dramas).values({title:'combo qualification',projectType:'documentary',aspectRatio:'16:9',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'E1',imageConfigId:configId,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
for (const [id, combo] of [[1,'A'],[2,'A'],[3,'A'],[4,'B'],[5,'B'],[6,'B'],[7,'C'],[8,'D'],[9,null],[10,'unknown']]) {
  db.insert(schema.storyboards).values({id,episodeId,storyboardNumber:id,combo,designCardStatus:'confirmed',continuityBoundary:'cut',firstFramePrompt:'first draft',midFramePrompt:'middle draft',lastFramePrompt:'last draft',createdAt:ts,updatedAt:ts}).run()
}
const {default:episodes} = await import('./src/routes/episodes.ts')
const {default:storyboards} = await import('./src/routes/storyboards.ts')
const {default:tasks} = await import('./src/routes/tasks.ts')
const {buildKeyframeRequest} = await import('./src/services/storyboard-keyframes.ts')
const {getEpisodeKeyframeBatch,resumeKeyframeBatches} = await import('./src/services/keyframe-batch.ts')
const {generateImage,resumeQwenJobsTask} = await import('./src/services/generation.ts')
const {getConfigById} = await import('./src/services/ai.ts')
const app = new Hono().route('/episodes',episodes).route('/storyboards',storyboards).route('/tasks',tasks)
const api = serve({fetch:app.fetch,hostname:'127.0.0.1',port:0})
if (!api.listening) await once(api,'listening')
apiPort = api.address().port
async function post(url, body={}) {
  const response = await fetch('http://127.0.0.1:'+apiPort+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  return {status:response.status,body:await response.json()}
}
async function until(fn) {
  const deadline = Date.now()+20000
  for (;;) {const result = await fn(); if(result) return result; if(Date.now()>deadline) throw new Error('condition timed out'); await new Promise(r=>setTimeout(r,15))}
}
const rowsBefore = db.select().from(schema.storyboards).all().slice(0,3)
const preview = await post('/episodes/'+episodeId+'/keyframe-batch/preview')
assert.equal(preview.status,200,JSON.stringify(preview.body))
const aItems = preview.body.data.items.filter(item=>item.storyboard_id<=3)
assert.equal(aItems.length,9)
for (const item of aItems) {assert.equal(item.status,'skipped');assert.equal(item.checked,false);assert.match(item.reason,/组合 A/)}
// Empty drafts do not obscure the actual combo reason, including the optional mid slot.
db.update(schema.storyboards).set({firstFramePrompt:'',midFramePrompt:'',lastFramePrompt:''}).where(eq(schema.storyboards.id,3)).run()
const emptyA = (await post('/episodes/'+episodeId+'/keyframe-batch/preview')).body.data.items.filter(item=>item.storyboard_id===3)
assert.equal(emptyA.length,3); assert.ok(emptyA.every(item=>item.reason.includes('组合 A')))
for (const [id,slot] of [[1,'first'],[1,'mid'],[1,'last'],[7,'first'],[8,'last']]) {
  const response = await post('/storyboards/'+id+'/keyframes/'+slot+'/generate',{prompt:'must not overwrite draft'})
  assert.equal(response.status,400)
}
assert.equal(db.select().from(schema.sysTask).all().length,0)
assert.equal(localRequests,0)
assert.deepEqual(db.select().from(schema.storyboards).all().slice(0,2),rowsBefore.slice(0,2))
const rejected = await post('/episodes/'+episodeId+'/keyframe-batch',{items:[{storyboard_id:1,slot:'first'},{storyboard_id:7,slot:'first'}]})
assert.equal(rejected.status,400); assert.match(JSON.stringify(rejected.body),/没有需要生成/)
assert.equal(db.select().from(schema.keyframeBatches).all().length,0)
// Forged/stale A and locked selections cannot stop the valid B. The first real local request
// holds the serial queue while later B shots change to A and to C's locked first slot.
const started = await post('/episodes/'+episodeId+'/keyframe-batch',{items:[{storyboard_id:1,slot:'first'},{storyboard_id:7,slot:'first'},{storyboard_id:4,slot:'first'},{storyboard_id:5,slot:'first'},{storyboard_id:6,slot:'first'}]})
assert.equal(started.status,200)
await until(()=>releaseFirst)
db.update(schema.storyboards).set({combo:'A'}).where(eq(schema.storyboards.id,5)).run()
db.update(schema.storyboards).set({combo:'C'}).where(eq(schema.storyboards.id,6)).run()
releaseFirst()
const finished = await until(async()=>{const batch=await getEpisodeKeyframeBatch(episodeId);return batch?.status==='done' && batch})
assert.deepEqual(finished.items.map(item=>item.state),['skipped','skipped','completed','skipped','skipped'])
assert.match(finished.items[3].error,/组合 A/);assert.match(finished.items[4].error,/锁定/)
assert.equal(localRequests,1)
assert.equal(db.select().from(schema.sysTask).all().length,1)
// C/D unlocked slots are real valid requests; qualification cannot enter signatures.
for (const [id,slot] of [[7,'mid'],[7,'last'],[8,'first'],[8,'mid'],[9,'first'],[10,'first']]) {
  const built = await buildKeyframeRequest(id,slot)
  const expected = createHash('sha256').update(JSON.stringify([built.prompt,[],built.size,built.provider,built.model])).digest('hex')
  assert.equal(built.signature,expected)
}
for (const [id,slot] of [[7,'last'],[8,'first']]) assert.equal((await post('/storyboards/'+id+'/keyframes/'+slot+'/generate')).status,201)
await until(()=>db.select().from(schema.sysTask).all().filter(t=>t.status==='completed').length===3)
const racedId = await generateImage({storyboardId:4,episodeId,dramaId,prompt:'stored request',frameType:'first_frame',configId,referenceImages:['http://127.0.0.1:'+upstreamPort+'/reference.png']})
const raced = await until(()=>{const task=db.select().from(schema.sysTask).where(eq(schema.sysTask.id,racedId)).get();return task.status==='cancelled' && task})
assert.equal(JSON.parse(raced.params).keyframe_skip_reason.code,'comboA')
assert.match(raced.errorMsg,/组合 A/);assert.equal(localRefs,1);assert.equal(localRequests,3)
// Task-center retry must preserve old inputs, but reject current A/locked eligibility before inserting.
for (const [id,frameType] of [[1,'first_frame'],[7,'first_frame'],[8,'last_frame']]) {
  const taskId = Number(db.insert(schema.sysTask).values({type:'image',storyboardId:id,episodeId,dramaId,provider:'openai',model:'local-image',prompt:'historical retry draft',params:JSON.stringify({frameType,size:'1344x768'}),status:'failed',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
  const count = db.select().from(schema.sysTask).all().length
  assert.equal((await post('/tasks/'+taskId+'/retry')).status,400)
  assert.equal(db.select().from(schema.sysTask).all().length,count)
}
// Unsent qwen sys_task recovery: both saved-request and full-build paths stop without any upload/POST.
const recovered = []
for (const [id,request] of [[1,undefined],[7,{prompt:'saved',mode:'text_to_image'}]]) {
  const taskId=Number(db.insert(schema.sysTask).values({type:'image',storyboardId:id,episodeId,dramaId,provider:'qwen-jobs',prompt:'saved',params:JSON.stringify({frameType:'first_frame'}),remoteState:JSON.stringify({request}),status:'queued',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
  const row=db.select().from(schema.sysTask).where(eq(schema.sysTask.id,taskId)).get()
  await resumeQwenJobsTask(row,{...(await getConfigById(configId)),provider:'qwen-jobs'})
  const skipped=db.select().from(schema.sysTask).where(eq(schema.sysTask.id,taskId)).get()
  assert.equal(skipped.status,'cancelled');assert.ok(JSON.parse(skipped.params).keyframe_skip_reason)
  recovered.push({storyboard_id:id,storyboard_number:id,slot:'first',state:'queued',task_id:taskId,error:null})
}
// Restore a persisted qwen batch pending item (formerly B, now A) and a failed retry item.
db.update(schema.aiServiceConfigs).set({provider:'qwen-jobs'}).where(eq(schema.aiServiceConfigs.id,configId)).run()
const staleBatchId=Number(db.insert(schema.keyframeBatches).values({episodeId,status:'running',items:JSON.stringify([{storyboard_id:5,storyboard_number:5,slot:'first',state:'pending',task_id:null,error:null},...recovered]),options:JSON.stringify({configId}),createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
await resumeKeyframeBatches()
await until(async()=>{const batch=await getEpisodeKeyframeBatch(episodeId);return batch?.id===staleBatchId && batch.status==='done'})
assert.equal((await getEpisodeKeyframeBatch(episodeId)).items[0].state,'skipped')
assert.ok((await getEpisodeKeyframeBatch(episodeId)).items.every(item=>item.state==='skipped' && item.error))
db.update(schema.keyframeBatches).set({items:JSON.stringify([{storyboard_id:5,storyboard_number:5,slot:'first',state:'failed',task_id:null,error:'old failure'}])}).where(eq(schema.keyframeBatches.id,staleBatchId)).run()
assert.equal((await post('/episodes/'+episodeId+'/keyframe-batch/retry-failed')).status,200)
await until(async()=>{const batch=await getEpisodeKeyframeBatch(episodeId);return batch.status==='done'})
assert.equal((await getEpisodeKeyframeBatch(episodeId)).items[0].state,'skipped')
// Legacy drama retains its old null/unknown combo behavior and exact content signature.
db.update(schema.aiServiceConfigs).set({provider:'openai'}).where(eq(schema.aiServiceConfigs.id,configId)).run()
const legacyDramaId=Number(db.insert(schema.dramas).values({title:'legacy',projectType:'drama',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const legacyEpisodeId=Number(db.insert(schema.episodes).values({dramaId:legacyDramaId,episodeNumber:1,title:'E1',imageConfigId:configId,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
for (const [id,combo] of [[11,null],[12,'A']]) db.insert(schema.storyboards).values({id,episodeId:legacyEpisodeId,storyboardNumber:id,combo,firstFramePrompt:'legacy draft',lastFramePrompt:'last draft',createdAt:ts,updatedAt:ts}).run()
const legacy = (await post('/episodes/'+legacyEpisodeId+'/keyframe-batch/preview')).body.data.items
assert.ok(legacy.every(item=>item.status==='missing' && item.checked))
const before=await buildKeyframeRequest(11,'first')
db.update(schema.storyboards).set({combo:'A'}).where(eq(schema.storyboards.id,11)).run()
assert.equal((await buildKeyframeRequest(11,'first')).signature,before.signature)
assert.equal((await post('/storyboards/11/keyframes/first/generate')).status,201)
await until(()=>db.select().from(schema.sysTask).all().filter(t=>t.status==='completed').length===4)
assert.equal(localRequests,4);assert.equal(outerRequests,0)
console.log('@@'+JSON.stringify({aSlots:aItems.length,serialStates:finished.items.map(i=>i.state),localRequests,outerRequests,legacySignature:before.signature}))
api.close();upstream.close();process.exit(0)
`], {
      cwd: root, encoding: 'utf8', timeout: 85000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), STORAGE_PATH: path.join(dir, 'static'), HUOBAO_DATA_DIR: dir },
      maxBuffer: 8 * 1024 * 1024,
    })
    const result = JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
    assert.equal(result.outerRequests, 0)
    assert.equal(result.localRequests, 4)
    assert.equal(result.aSlots, 9)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
