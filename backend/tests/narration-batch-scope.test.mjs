import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('..', import.meta.url))
function run(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'narration-scope-'))
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), STORAGE_PATH: path.join(dir, 'static'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const seed = `
import { db, schema } from './src/db/index.ts'
import { eq } from 'drizzle-orm'
const ts = new Date().toISOString()
const dramaId = Number(db.insert(schema.dramas).values({title:'Scope',projectType:'documentary',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'Scope',narrationEnabled:true,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
for(const [id,combo,status] of [[1,'A','confirmed'],[2,'B','confirmed'],[3,null,'pending']]) {
  db.insert(schema.storyboards).values({id,episodeId,storyboardNumber:id,combo,designCardStatus:status,narrationText:'测试旁白。',createdAt:ts,updatedAt:ts}).run()
}
db.insert(schema.aiServiceConfigs).values({serviceType:'tts',provider:'voxcpm',name:'Test',baseUrl:'http://tts.invalid',isActive:true,createdAt:ts,updatedAt:ts}).run()
const settings={voice:'Test voice',inference_timesteps:10,cfg_value:2,seed:7,instructions:'',normalize:true}
globalThis.fetch=async (url)=>String(url).endsWith('/api/voices')
  ? Response.json({items:[{name:'Test voice'}]})
  : new Response('Deliberate transport failure before synthesis',{status:503})
const {default:app}=await import('./src/routes/episodes.ts')
async function post(route,body){const res=await app.request('/'+episodeId+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()}}
const {getVoiceBatchStatus}=await import('./src/services/narration-voice.ts')
async function settled(){for(let n=0;n<200;n++){const status=await getVoiceBatchStatus(episodeId);if(status?.status!=='running')return status;await new Promise(r=>setTimeout(r,1))}throw new Error('Voice batch did not settle')}
`

test('explicit empty keyframe scope stays empty rather than expanding to the episode', () => {
  const result = run(`${seed}
    const {batchScopeOf}=await import('./src/services/batch-scope.ts')
    console.log('@@'+JSON.stringify({empty:await batchScopeOf(episodeId,'keyframes',[]),all:await batchScopeOf(episodeId,'keyframes')}))
  `)
  assert.deepEqual(result.empty, { included: [], excluded: [] })
  assert.deepEqual(result.all.included.map(item => item.storyboard_id), [2])
  assert.equal(result.all.excluded.length, 2)
})

test('voice preview excludes episode-disabled narration and execution creates no task', () => {
  const result = run(`${seed}
    db.update(schema.episodes).set({narrationEnabled:false}).where(eq(schema.episodes.id,episodeId)).run()
    const preview=await post('/narration/voice-batch/preview',{settings,storyboard_ids:[1]})
    const started=await post('/narration/voice-batch',{settings,storyboard_ids:[1]})
    console.log('@@'+JSON.stringify({preview,started,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.equal(result.preview.status, 200)
  assert.deepEqual(result.preview.body.data.scope.included, [])
  assert.ok(result.preview.body.data.items.every(item => !item.selectable && !item.checked))
  assert.ok(result.preview.body.data.scope.excluded.every(item => /本集未开启旁白/.test(item.reason)))
  assert.equal(result.started.status, 400)
  assert.equal(result.tasks.length, 0)
})

test('voice HTTP preview, execution, status and task-center retain one exact selected scope', () => {
  const result = run(`${seed}
    const preview=await post('/narration/voice-batch/preview',{settings,storyboard_ids:[1]})
    const started=await post('/narration/voice-batch',{settings,storyboard_ids:[1]})
    const status=await settled()
    const {listTaskCenter}=await import('./src/services/task-center.ts')
    const center=await listTaskCenter({episodeId,scope:'all'})
    console.log('@@'+JSON.stringify({preview,started,status,center:center.items.find(row=>row.row_type==='task'&&row.id===started.body.data.task_id)}))
  `)
  const scope = result.preview.body.data.scope
  assert.deepEqual(scope.included.map(item => item.storyboard_id), [1])
  assert.deepEqual(result.started.body.data.scope, scope)
  assert.deepEqual(result.status.scope, scope)
  assert.deepEqual(result.center.params.scope, scope)
  assert.deepEqual(result.center.params.storyboardIds, [1])
  assert.deepEqual(result.status.items.map(item => [item.storyboard_id, item.state]), [[1, 'failed']])
})

test('failed-only voice retry uses original settings with fresh gates and persists the fresh preview scope', () => {
  const result = run(`${seed}
    const started=await post('/narration/voice-batch',{settings,storyboard_ids:[1,2]})
    await settled()
    db.update(schema.storyboards).set({narrationEnabled:false}).where(eq(schema.storyboards.id,2)).run()
    db.update(schema.episodes).set({ttsSettings:JSON.stringify({...settings,seed:99})}).where(eq(schema.episodes.id,episodeId)).run()
    const preview=await post('/narration/voice-batch/preview',{retry_failed:true})
    const retried=await post('/narration/voice-batch/retry-failed',{})
    const status=await settled()
    const {listTaskCenter}=await import('./src/services/task-center.ts')
    const center=await listTaskCenter({episodeId,scope:'all'})
    const rows=db.select().from(schema.sysTask).all().map(row=>({id:row.id,params:JSON.parse(row.params)}))
    console.log('@@'+JSON.stringify({started,preview,retried,status,rows,center:center.items.find(row=>row.row_type==='task'&&row.id===retried.body.data.task_id)}))
  `)
  const scope = result.preview.body.data.scope
  assert.deepEqual(scope.included.map(item => item.storyboard_id), [1])
  assert.equal(result.preview.body.data.items.find(item => item.storyboard_id === 2).checked, false)
  assert.deepEqual(result.retried.body.data.scope, scope)
  assert.deepEqual(result.status.scope, scope)
  assert.deepEqual(result.rows[1].params.scope, scope)
  assert.deepEqual(result.center.params.scope, scope)
  assert.deepEqual(result.rows[1].params.storyboardIds, [1])
  assert.equal(result.rows[1].params.retry_of, result.started.body.data.task_id)
  assert.equal(result.rows[1].params.voice_settings.seed, 7)
  assert.deepEqual(result.status.items.map(item => item.storyboard_id), [1])
})
