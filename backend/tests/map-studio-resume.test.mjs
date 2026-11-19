import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('..', import.meta.url))
function probe(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-resume-'))
  const file = path.join(dir, 'probe.mts')
  writeFileSync(file, `
    import assert from 'node:assert/strict'
    import { db, schema, getInsertId } from 'file://${backend}src/db/index.ts'
    import { now } from 'file://${backend}src/utils/response.ts'
    import { emptyBrief } from 'file://${backend}src/modules/map-studio/types.ts'
    import { researchStepBudget, mapResearchIO } from 'file://${backend}src/modules/map-studio/research.ts'
    import { initMapStudio, createStandaloneTask } from 'file://${backend}src/modules/map-studio/tasks.ts'
    import { loadTask, mutateTask, serializeDetail } from 'file://${backend}src/modules/map-studio/store.ts'
    import { startMapWorkflow, rollbackMapWorkflow, saveMapWorkflowDraft } from 'file://${backend}src/modules/map-studio/run.ts'
    import { mapStudioRoutes } from 'file://${backend}src/modules/map-studio/routes.ts'
    import { startMockOpenAIChat, toolResults, userText } from 'file://${backend}tests/fixtures/mock-openai-chat.mjs'
    ${body}
  `)
  try {
    execFileSync('node_modules/.bin/tsx', [file], { cwd: backend, encoding: 'utf8', timeout: 120000, env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('research budget counts distinct geographic candidates, falls back and caps', () => {
  probe(`
    const b = { ...emptyBrief(), subject: '', location: '', purpose: '', notes: '' }
    assert.deepEqual([researchStepBudget({...b, detail_level:'site'}, null).targets, researchStepBudget({...b, detail_level:'regional'}, null).targets, researchStepBudget({...b, detail_level:'overview'}, null).targets], [4,6,8])
    const one = researchStepBudget({...b, subject:'长江、长江'}, null)
    const two = researchStepBudget({...b, subject:'长江、黄河'}, null)
    assert.equal(one.targets, 1); assert.equal(one.steps, 46)
    assert.equal(two.targets, 2); assert.equal(two.steps, 52)
    assert.equal(researchStepBudget({...b, subject: Array.from({length: 12}, (_,i) => '地名'+i+'河').join('、')}, null).steps, 100)
    assert.equal(researchStepBudget({...b, subject:'长江'}, {last_failure:{kind:'rejected'}}).steps, one.steps)
  `)
})

test('failed research is persisted, resumed only for the same brief, and cleared on acceptance or explicit action', () => {
  probe(`
    const platform = { async submitImage() { throw Error('unexpected image') }, async pollImage() { throw Error('unexpected image') } }
    await initMapStudio(platform)
    const adapters = ['wikipedia-zh','wikipedia-en','europeana','smithsonian']
    mapResearchIO.search = async (adapter, query) => [{ adapter, title: adapter, url: 'https://example.org/'+adapter, image: null, license: 'CC BY-SA', institution: adapter, date: '', tier: 'B', snippet: '摘要' }]
    mapResearchIO.fetchText = async () => '扬州在东经119.42度北纬32.39度，历史资料全文。'
    let mode = 'fail'
    let firstResume = null
    let freshRequest = null
    let repeatedState = null
    const place = { kind:'place', name:'扬州', lon:119.42, lat:32.39, category:'settlement', geometry_source:'model', coordinate_basis:'well_known', source_ids:['S1'], basis:'现代地名公认位置', uncertainty:'medium' }
    const mock = await startMockOpenAIChat(async body => {
      const text = userText(body)
      if (mode === 'resume') { firstResume ??= text; return { toolCalls:[{name:'submit_features',args:{features:[place],extent:[118,31,121,34]}}] } }
      if (mode === 'fresh') { freshRequest ??= text; return { text:'结束' } }
      if (!toolResults(body,'search_sources').length) return {toolCalls:adapters.map(adapter => ({name:'search_sources',args:{adapter,query:'扬州'}}))}
      if (!toolResults(body,'search_dataset').length) return {toolCalls:Array.from({length:3}, () => ({name:'search_dataset',args:{layer:'place',query:'Yangzhou'}}))}
      if (!toolResults(body,'read_source').length) { repeatedState ??= text; return {toolCalls:[{name:'read_source',args:{source_id:'S1'}}]} }
      if (!toolResults(body,'submit_features').length) return {toolCalls:[{name:'submit_features',args:{features:[],extent:[118,31,121,34],uncertainties:['河道尚待核实']}}]}
      return {text:'结束'}
    })
    const ts = now()
    const config = getInsertId(await db.insert(schema.aiServiceConfigs).values({serviceType:'text', provider:'openai', name:'resume mock', baseUrl:mock.baseUrl, apiKey:'test', model:'["mock-agent"]', isActive:true, vision:true, createdAt:ts, updatedAt:ts}))
    const created = await createStandaloneTask({title:'扬州地图',brief:{subject:'扬州地图',era:'清代',location:'江苏',purpose:'地图'}})
    const id = created.task_id
    await mutateTask(id,{action:'test_research',actor:'manual',mutate:ctx => {ctx.state.stage='research'}})
    const settle = async () => { for (let i=0;i<1200;i++) { const row=await loadTask(id); if(row.state.status!=='running') return row; await new Promise(r=>setTimeout(r,50)) } throw Error('run timed out') }
    await startMapWorkflow(id,{mode:'manual',textConfigId:config})
    let row=await settle()
    assert.equal(row.state.status,'failed')
    const historyLine = repeatedState.split('\\n').find(line => line.startsWith('dataset 查询历史：'))
    assert.ok(historyLine); assert.equal(historyLine.split('place「Yangzhou」').length - 1, 1); assert.match(historyLine, /×3 次/)
    const progress=row.state.research_progress
    assert.ok(progress); assert.match(progress.sources[0].excerpt,/历史资料全文/); assert.equal(progress.hits.S1.title,'wikipedia-zh')
    assert.ok(progress.dataset_queries.length); assert.ok(progress.dataset_queries[0].refs.length); assert.ok(progress.uncertainties.includes('河道尚待核实'))
    assert.equal(row.state.research, null)
    const view=serializeDetail(row); assert.equal(view.research_progress_summary.available,true); assert.equal('research_progress' in view,false)
    await rollbackMapWorkflow(id,'research')
    row=await loadTask(id); assert.deepEqual(row.state.research_progress,progress)
    mode='resume'
    await startMapWorkflow(id,{mode:'manual',textConfigId:config})
    row=await settle()
    assert.match(firstResume,/续跑/); assert.match(firstResume,/已读正文/); assert.ok(firstResume.includes(progress.dataset_queries[0].refs[0])); assert.match(firstResume,/河道尚待核实/)
    assert.equal(row.state.stage,'base', row.state.error); assert.equal(row.state.research_progress,null)
    // 保留一份失败工作集，修改 brief 后，下一次 research 不能载入旧来源。
    await mutateTask(id,{action:'test_old_progress',actor:'manual',mutate:ctx=>{ctx.state.research_progress=progress;ctx.state.stage='research'}})
    await saveMapWorkflowDraft(id,{brief:{notes:'需求已经变化'}})
    await mutateTask(id,{action:'test_research_again',actor:'manual',mutate:ctx=>{ctx.state.stage='research'}})
    assert.equal(serializeDetail(await loadTask(id)).research_progress_summary.available,false)
    mode='fresh'; await startMapWorkflow(id,{mode:'manual',textConfigId:config}); row=await settle()
    assert.doesNotMatch(freshRequest,/续跑：已登记/)
    const response=await mapStudioRoutes.request('/tasks/'+id+'/research-progress/clear',{method:'POST'})
    assert.equal(response.status,200); row=await loadTask(id); assert.equal(row.state.research_progress,null)
    await mock.close()
  `)
})
