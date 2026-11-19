import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('..', import.meta.url))
test('step budgets, continuation, outcomes and round callbacks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-steps-'))
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { db, schema, getInsertId, sqlite } from 'file://${backend}src/db/index.ts'
import { now } from 'file://${backend}src/utils/response.ts'
import { MAP_STUDIO_SCHEMA, insertTask } from 'file://${backend}src/modules/map-studio/db.ts'
import { emptyWorkflow } from 'file://${backend}src/modules/map-studio/types.ts'
import { loadTask } from 'file://${backend}src/modules/map-studio/store.ts'
import { runStageAgent, stageTool } from 'file://${backend}src/modules/map-studio/agent-loop.ts'
import { startMockOpenAIChat, userText } from 'file://${backend}tests/fixtures/mock-openai-chat.mjs'
const require = createRequire('file://${backend}package.json')
const { z } = require('zod')
for (const sql of MAP_STUDIO_SCHEMA) sqlite.exec(sql)
let handler = () => ({ text: 'done' })
const mock = await startMockOpenAIChat(body => handler(body))
const ts = now()
const invoke = async (respond, budget, maxSteps=2, startRounds=0, suppressHealth=true) => {
  handler = respond
  mock.requests.length = 0
  // SDK may retry a 500 several times; keep this isolated fixture from being suspended
  // before the original provider error reaches runStageAgent.
  const configId = getInsertId(await db.insert(schema.aiServiceConfigs).values({ serviceType:'text', provider:'openai', name:'Mock', baseUrl:mock.baseUrl, apiKey:'test', model:'["mock"]', isActive:true, vision:true, consecutiveErrors:suppressHealth ? -100 : 0, createdAt:ts, updatedAt:ts }))
  const state = emptyWorkflow(); state.run_id = 1; state.status = 'running'
  const taskId = insertTask({ title:'test', host:null, hostRef:null, brief:null, state:JSON.stringify(state), mapSpec:null })
  const callbacks = []
  let result, error
  try {
    result = await runStageAgent({ taskId, runId:1, stage:'research', stageModel:{model:'mock',configId}, skill:'research', maxSteps, startRounds, initialFeedback:null, prompt:()=> '开始', state:()=> '测试状态', stepBudget:budget, onRoundEnd:async info => callbacks.push(info), tools:session => ({
      count:stageTool(session,{id:'count',description:'count',inputSchema:z.object({}),execute:async()=>({count:1})}),
      deliver:stageTool(session,{id:'deliver',description:'deliver',inputSchema:z.object({reject:z.boolean()}),execute:async input=>session.deliver(input.reject ? ['拒收测试'] : [],()=> 'ok')})
    }) })
  } catch (e) { error=e }
  return { result,error,callbacks,requests:[...mock.requests],attempts:(await loadTask(taskId)).state.agent.attempts }
}
const budget = { steps:2, extendSteps:2, warnRemaining:1, warnText:'先补齐未检索适配器再立即提交' }
const count = {toolCalls:[{name:'count',args:{}}]}
const accept = {toolCalls:[{name:'deliver',args:{reject:false}}]}
let calls=0
let r=await invoke(() => ++calls === 3 ? accept : count,budget)
assert.equal(r.result?.kind,'accepted'); assert.equal(r.callbacks.at(-1).outcome,'accepted')
assert.equal(r.attempts.filter(a=>a.outcome==='step_extension').length,1)
assert.match(userText(r.requests[2]),/耗尽 2 步.*必须提交部分结果/)
assert.match(JSON.stringify(r.requests[2].messages),/count/)
assert.match(userText(r.requests[0]),/先补齐未检索适配器/)
r=await invoke(()=>count,budget)
assert.equal(r.error?.kind,'steps_exhausted'); assert.equal(r.requests.length,12); assert.equal(r.callbacks.length,3)
assert.ok(r.error.rounds.every(x=>x.stepsUsed===4))
calls=0
r=await invoke(()=>++calls % 3 === 0 ? {text:'提前结束'} : count,budget)
assert.equal(r.error?.kind,'steps_exhausted')
assert.equal(r.requests.length,9)
assert.equal(r.callbacks.length,3)
assert.ok(r.error.rounds.every(x=>x.outcome==='steps_exhausted' && x.stepsUsed===3 && x.problems.some(p=>p.includes('追加段内模型提前收尾'))))
assert.equal(r.attempts.filter(a=>a.outcome==='steps_exhausted').length,3)
r=await invoke(()=>({text:'结束'}),budget)
assert.equal(r.error?.kind,'ended_without_delivery'); assert.equal(r.requests.length,3); assert.equal(r.callbacks.length,3)
r=await invoke(()=>{throw Error('Insufficient Balance')},budget,2,2)
assert.ok(r.requests.length > 0, 'provider error must come from the mock')
assert.equal(r.error?.kind,'call_error'); assert.match(r.error.message,/余额不足/); assert.equal(r.callbacks.length,1)
r=await invoke(()=>{throw Error('Insufficient Balance')},budget,2,0,false)
assert.ok(r.requests.length > 0, 'balance error must reach the upstream mock')
assert.equal(r.error?.kind,'call_error')
assert.match(r.error.message,/余额不足/)
assert.match(r.error.message,/Insufficient Balance/)
assert.ok(r.error.rounds.some(x=>x.problems.some(p=>p.includes('文本模型已暂停'))))
calls=0
r=await invoke(()=>++calls===1 ? {toolCalls:[{name:'deliver',args:{reject:true}}]} : count,budget)
assert.ok(r.attempts.some(a=>a.outcome==='steps_exhausted' && a.problems.includes('拒收测试')))
assert.equal(r.error.rounds.filter(x=>x.round===1).length,1)
assert.equal(r.error.rounds[0].outcome,'steps_exhausted')
assert.ok(r.error.rounds[0].problems.includes('拒收测试'))
r=await invoke(()=>count,undefined)
assert.equal(r.error?.kind,'steps_exhausted'); assert.equal(r.requests.length,6); assert.ok(!r.attempts.some(a=>a.outcome==='step_extension'))
await mock.close()
`)
  try {
    execFileSync('node_modules/.bin/tsx', [probe], { cwd: backend, encoding: 'utf8', timeout: 120000, env: { ...process.env, SQLITE_PATH:path.join(dir,'test.sqlite3'), HUOBAO_DATA_DIR:dir, STORAGE_PATH:path.join(dir,'static') } })
  } finally { rmSync(dir, { recursive:true, force:true }) }
})
