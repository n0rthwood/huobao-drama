import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))

test('native HTTP fit preview and PUT share documentary submission budgets, with actual media taking precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-fit-budget-'))
  try {
    const script = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from './src/db/index.ts'
import storyboards from './src/routes/storyboards.ts'
import { generatedSegmentSeconds } from './src/services/shot-duration.ts'
const storage = process.env.STORAGE_PATH
fs.mkdirSync(storage, { recursive:true })
for (const seconds of [4,8]) execFileSync(ffmpeg, ['-y','-f','lavfi','-i','color=c=blue:s=64x64:r=25','-t',String(seconds),'-c:v','libx264','-pix_fmt','yuv420p',path.join(storage,seconds+'.mp4')],{stdio:'ignore'})
fs.writeFileSync(path.join(storage,'broken.mp4'),'not media')
const at = new Date().toISOString()
for (const [id, projectType] of [[1,'documentary'],[2,'drama']]) {
 await db.insert(schema.dramas).values({id,title:projectType,projectType,createdAt:at,updatedAt:at})
 await db.insert(schema.episodes).values({id,dramaId:id,episodeNumber:1,title:'fit budget',narrationEnabled:false,createdAt:at,updatedAt:at})
}
// Empty provider table: the route must never submit any AI/GPU work.
await db.delete(schema.aiServiceConfigs)
const cases = [
 {name:'C missing raw',combo:'C',gen:6,expected:10},
 {name:'D missing raw',combo:'D',gen:6,expected:10},
 {name:'C measured raw wins',combo:'C',gen:6,raw:'static/8.mp4',expected:12},
 {name:'D measured raw wins',combo:'D',gen:6,raw:'static/8.mp4',expected:12},
 {name:'C unprobeable raw',combo:'C',gen:5,raw:'static/broken.mp4',expected:9},
 {name:'D nonexistent raw',combo:'D',gen:5,raw:'static/missing.mp4',expected:9},
 {name:'A measured layer only',combo:'A',gen:6,raw:'static/8.mp4',expected:4},
 {name:'B normal budget',combo:'B',gen:10,expected:10},
 {name:'B mismatched legacy duration',combo:'B',gen:8,expected:8},
 {name:'B measured raw wins',combo:'B',gen:6,raw:'static/8.mp4',expected:8},
 {name:'non-documentary unchanged',combo:'C',gen:6,episode:2,expected:10},
 {name:'C planned layer',combo:'C',gen:6,planned:true,expected:10},
 {name:'D legacy card',combo:'D',legacy:true,expected:14},
 {name:'C zero budget preserved',combo:'C',gen:0,expected:4},
 {name:'C nonnumeric budget existing fallback',combo:'C',gen:'bad',expected:14},
 {name:'C null budget existing fallback',combo:'C',gen:null,expected:14},
]
const app = new Hono().route('/api/v1/storyboards',storyboards)
const server = serve({fetch:app.fetch,hostname:'127.0.0.1',port:0})
await new Promise(resolve => server.listening ? resolve() : server.once('listening',resolve))
const base = 'http://127.0.0.1:'+server.address().port+'/api/v1/storyboards/'
const results=[]
try {
 for (const [index,row] of cases.entries()) {
  const id=index+1
  const card=row.legacy ? null : JSON.stringify({version:2,budget:{layer_s:4,gen_s:row.gen}})
  await db.insert(schema.storyboards).values({id,episodeId:row.episode||1,storyboardNumber:id,combo:row.combo,duration:10,designCard:card,videoUrl:row.raw||null,createdAt:at,updatedAt:at})
  if (row.combo!=='B') db.run(sql\`INSERT INTO storyboard_layer_segments (storyboard_id,layer_doc,timeline,duration,render_path,created_at,updated_at) VALUES (\${id},'{}','{}',4,\${row.planned?null:'static/4.mp4'},\${at},\${at})\`)
  const before=(await db.select().from(schema.storyboards).where(eq(schema.storyboards.id,id)))[0]
  const previewResponse=await fetch(base+id+'/narration-fit/preview')
  assert.equal(previewResponse.status,200,row.name)
  const preview=(await previewResponse.json()).data
  const putResponse=await fetch(base+id+'/narration-fit',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'pad',pad_ms:0,pad_position:'tail',audio_mix_mode:'replace'})})
  assert.equal(putResponse.status,200,row.name)
  const saved=(await putResponse.json()).data
  const reread=(await (await fetch(base+id+'/narration-fit/preview')).json()).data
  for (const value of [preview,saved,reread]) {
   assert.equal(value.plan.dv,row.expected,row.name+' dv')
   assert.equal(value.plan.d,row.expected,row.name+' d')
   assert.equal(value.plan.blocked,false,row.name+' blocked')
  }
  const after=(await db.select().from(schema.storyboards).where(eq(schema.storyboards.id,id)))[0]
  for(const field of Object.keys(before).filter(field=>!['narrationFit','updatedAt'].includes(field))) assert.deepEqual(after[field],before[field],row.name+' preserved '+field)
  results.push({name:row.name,preview:preview.plan.dv,put:saved.plan.dv,reread:reread.plan.dv})
 }
 assert.equal(generatedSegmentSeconds(null,null),10)
 assert.equal(generatedSegmentSeconds(null,0),0)
 assert.ok(Number.isNaN(generatedSegmentSeconds(null,NaN)))
 console.log('@@'+JSON.stringify(results))
} finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())) }
`
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backend, encoding: 'utf8', timeout: 90000,
      env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static'), MYSQL_HOST: '' },
    })
    const rows = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.equal(rows.length, 16)
    console.log('Native HTTP/SQLite fit evidence: '+JSON.stringify(rows))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
