import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const backendRoot=fileURLToPath(new URL('..',import.meta.url))
function run(body){
 const dir=mkdtempSync(join(tmpdir(),'huobao-voice-scope-'))
 try {
  const text=execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',`${seed}\n${body}`],{cwd:backendRoot,encoding:'utf8',env:{...process.env,SQLITE_PATH:join(dir,'db.sqlite3'),HUOBAO_DATA_DIR:dir}})
  return JSON.parse(text.slice(text.lastIndexOf('@@')+2).split('\n')[0])
 }finally{rmSync(dir,{recursive:true,force:true})}
}
const seed=`
import {db,schema} from './src/db/index.ts'
import {eq} from 'drizzle-orm'
import {batchScopeOf} from './src/services/batch-scope.ts'
const ts=new Date().toISOString()
const dramaId=Number(db.insert(schema.dramas).values({title:'Scope',projectType:'documentary',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const episodeId=Number(db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'Scope',narrationEnabled:true,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
for(const [id,combo,status] of [[1,'A','confirmed'],[2,'B','confirmed'],[3,null,'pending']])db.insert(schema.storyboards).values({id,episodeId,storyboardNumber:id,combo,designCardStatus:status,narrationText:'测试旁白。',createdAt:ts,updatedAt:ts}).run()
`
test('explicit empty scope stays empty instead of expanding to the episode',()=>{
 const result=run(`console.log('@@'+JSON.stringify({empty:await batchScopeOf(episodeId,'keyframes',[]),all:await batchScopeOf(episodeId,'keyframes')}))`)
 assert.equal(result.empty.included.length,0)
 assert.equal(result.empty.excluded.length,0)
 assert.equal(result.all.included.length,1)
})
test('voice scope is persisted verbatim and exposed by the real task-center serializer',()=>{
 const result=run(`
 const {createTextTask,parseTextTaskParams}=await import('./src/services/text-task.ts')
 const {enrichTask}=await import('./src/services/task-center.ts')
 const scope=await batchScopeOf(episodeId,'voice',[2])
 const id=await createTextTask({kind:'narration_tts',episodeId,dramaId,prompt:'scope persistence',scope,storyboardIds:scope.included.map(item=>item.storyboard_id),progress:{total:1,completed:0,failed:0,items:[{storyboard_id:2,storyboard_number:2,state:'pending'}]}})
 const [task]=await db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id))
 const center=await enrichTask(task)
 console.log('@@'+JSON.stringify({scope,stored:parseTextTaskParams(task.params).scope,center}))
 `)
 assert.deepEqual(result.stored,result.scope)
 assert.deepEqual(result.scope.included.map(row=>row.storyboard_id),[2])
 assert.deepEqual(result.center.params.scope,result.scope)
})
