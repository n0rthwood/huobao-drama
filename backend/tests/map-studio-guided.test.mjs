import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Issue #126 G1：有界运行 guided + stop_at。真实服务/数据库/渲染链，模型用本地脚本化 OpenAI 兼容端点。
test('地图有界运行：guided/base 停在底图就绪，guided/drawing 停在成图待交付且不交付', () => {
  const backend = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'map-guided-'))
  const probeBody = `
    import assert from 'node:assert/strict'
    import {db,schema,getInsertId} from 'file://${backend}src/db/index.ts'
    import {now} from 'file://${backend}src/utils/response.ts'
    import {loadTask as loadWorkflow,serializeDetail,mutateTask as mutateWorkflow,briefHash,MapStudioRequestError} from 'file://${backend}src/modules/map-studio/store.ts'
    import {emptyBrief} from 'file://${backend}src/modules/map-studio/types.ts'
    import {startMapWorkflow,advanceMapWorkflow,nextStageOfRun,checkRunBoundary,checkGuidedStart} from 'file://${backend}src/modules/map-studio/run.ts'
    import {normalizeMapSpec} from 'file://${backend}src/modules/map-studio/geo/base-render.ts'
    import {initMapStudio,registerMapStudioHost,openHostTask,mapStudioRoutes} from 'file://${backend}src/modules/map-studio/index.ts'
    import {huobaoMapStudioHost} from 'file://${backend}src/services/map-studio-host.ts'
    import {readRunParams,selectRunsByTask} from 'file://${backend}src/modules/map-studio/db.ts'
    import {startMockOpenAIChat,toolResults,systemText,userText} from 'file://${backend}tests/fixtures/mock-openai-chat.mjs'
    const mock=await startMockOpenAIChat(async body=>{
      const sys=systemText(body),user=userText(body)
      if(sys.includes('地图工作流：底图')){
        const renders=toolResults(body,'render_base')
        if(!renders.length)return{toolCalls:[{name:'render_base',args:{mode:'program',bbox:JSON.parse(user.match(/bbox=(\\[[^\\]]+\\])/)[1])}}]}
        return{toolCalls:[{name:'submit_base',args:{artifact_id:renders[0].artifact_id}}]}
      }
      if(sys.includes('地图工作流：用图层文档作图')){
        const features=JSON.parse(user.match(/要素摘要（不传顶点）：\\n(.+)/)[1])
        if(!toolResults(body,'add_feature_layers').length)return{toolCalls:[{name:'add_feature_layers',args:{items:features.map(f=>({feature_id:f.feature_id,style:{}}))}}]}
        if(!toolResults(body,'auto_layout_labels').length)return{toolCalls:[{name:'auto_layout_labels',args:{}}]}
        if(!toolResults(body,'render_draft').length)return{toolCalls:[{name:'render_draft',args:{}}]}
        return{toolCalls:[{name:'submit_draft',args:{}}]}
      }
      return{text:'无事可做'}
    })
    const {eq} = await import('file://${backend}node_modules/drizzle-orm/index.js')
    const platform = {
      async submitImage() { throw Error('Unexpected billed texture submission in test') },
      async pollImage(ref) {
        const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(ref))).get()
        return row ? { status: row.status === 'completed' ? 'completed' : 'pending', path: row.localPath, error: row.errorMsg } : { status: 'missing', path: null, error: 'missing' }
      },
    }
    registerMapStudioHost(huobaoMapStudioHost)
    await initMapStudio(platform)
    const ts=now()
    const dramaId=getInsertId(await db.insert(schema.dramas).values({title:'有界运行回归',createdAt:ts,updatedAt:ts}))
    const configId=getInsertId(await db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'Scripted guided model',baseUrl:mock.baseUrl,apiKey:'not-a-credential',model:'["mock-agent"]',isActive:true,vision:true,createdAt:ts,updatedAt:ts}))
    const propId=getInsertId(await db.insert(schema.props).values({dramaId,name:'有界运行地图',description:'',assetType:'map',createdAt:ts,updatedAt:ts}))
    const taskId=(await openHostTask({host:'huobao',ref:'prop:'+propId})).task_id
    const settle=async()=>{
      const deadline=Date.now()+90000
      for(;;){
        const row=await loadWorkflow(taskId)
        if(row.state.status!=='running')return serializeDetail(row)
        if(Date.now()>deadline)throw Error('Map stage did not finish: '+row.state.stage)
        await new Promise(resolve=>setTimeout(resolve,20))
      }
    }
    const request=async(route,method='GET',body)=>{
      const response=await mapStudioRoutes.request(route,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})})
      return {status:response.status,body:await response.json()}
    }
    const runRows=()=>selectRunsByTask(taskId)

    // ── 纯契约：mode/stop_at 组合与每步继续/结束 ──
    assert.equal(checkRunBoundary('guided','base'),'base')
    assert.equal(checkRunBoundary('guided','drawing'),'drawing')
    assert.throws(()=>checkRunBoundary('guided',undefined),(err)=>err instanceof MapStudioRequestError&&err.code==='invalid_stop_at')
    assert.throws(()=>checkRunBoundary('guided','complete'),(err)=>err.code==='invalid_stop_at')
    assert.throws(()=>checkRunBoundary('manual','base'),(err)=>err.code==='invalid_stop_at')
    assert.throws(()=>checkRunBoundary('auto','drawing'),(err)=>err.code==='invalid_stop_at')
    assert.equal(checkRunBoundary('manual',undefined),null)
    checkGuidedStart('guided','base','brief');checkGuidedStart('guided','base','research');checkGuidedStart('guided','base','base')
    checkGuidedStart('guided','drawing','style');checkGuidedStart('guided','drawing','drawing')
    assert.throws(()=>checkGuidedStart('guided','base','style'),(err)=>err.code==='invalid_start_stage')
    assert.throws(()=>checkGuidedStart('guided','drawing','base'),(err)=>err.code==='invalid_start_stage')
    checkGuidedStart('manual',null,'complete')
    const plan=(mode,stopAt,stage,proceed=true,next)=>nextStageOfRun({mode,stopAt,stage,outcome:{proceed,...(next?{next}:{})}})
    assert.equal(plan('manual',null,'brief'),null,'manual 一次一个阶段')
    assert.equal(plan('auto',null,'brief'),'research')
    assert.equal(plan('auto',null,'drawing',false),null,'proceed=false 即停')
    assert.equal(plan('guided','base','brief'),'research')
    assert.equal(plan('guided','base','research'),'base')
    assert.equal(plan('guided','base','base'),null,'base 完成即停')
    assert.equal(plan('guided','base','base',true,'style'),null,'绝不越过终点')
    assert.equal(plan('guided','drawing','style'),'drawing')
    assert.equal(plan('guided','drawing','drawing'),null,'drawing 完成即停，不跑 complete')
    assert.equal(plan('guided','drawing','research'),'base','合法起点之前的连续推进')
    assert.equal(plan('guided','drawing','drawing',false),null,'执行器回退=结束本次有界运行')

    // ── 非法请求不创建 run ──
    await mutateWorkflow(taskId,{action:'fixture_geometry',actor:'system',requireIdle:true,mutate:ctx=>{
      ctx.mapSpec=normalizeMapSpec({bbox:[113,35.2,115.6,36.8],places:[{id:'a',name:'安阳',lon:114.39,lat:36.09}]})
      ctx.brief={...emptyBrief(),subject:'有界运行地图',era:'明代',location:'安阳',purpose:'位置示意'}
      ctx.state.brief_hash=briefHash(ctx.brief)
      ctx.state.stage='base';ctx.state.status='idle'
    }})
    const before=runRows().length
    let res=await request('/tasks/'+taskId+'/run','POST',{mode:'guided'})
    assert.equal(res.status,400);assert.equal(res.body.error,'invalid_stop_at')
    res=await request('/tasks/'+taskId+'/run','POST',{mode:'manual',stop_at:'base'})
    assert.equal(res.status,400);assert.equal(res.body.error,'invalid_stop_at')
    res=await request('/tasks/'+taskId+'/run','POST',{mode:'guided',stop_at:'complete'})
    assert.equal(res.status,400);assert.equal(res.body.error,'invalid_stop_at')
    res=await request('/tasks/'+taskId+'/run','POST',{mode:'guided',stop_at:'drawing'})
    assert.equal(res.status,400);assert.equal(res.body.error,'invalid_start_stage','base 起点不能跨到 drawing 终点')
    assert.equal(runRows().length,before,'非法组合不创建 run')
    const untouched=serializeDetail(await loadWorkflow(taskId))
    assert.equal(untouched.stage,'base');assert.equal(untouched.status,'idle');assert.equal(untouched.run_id,null)

    // ── guided/base：base 完成即停，不执行 style/drawing ──
    let state=await loadWorkflow(taskId)
    const first=await startMapWorkflow(taskId,{mode:'guided',stopAt:'base',expectedRevision:state.state.revision,textConfigId:configId})
    assert.equal(first.mode,'guided');assert.equal(first.stop_at,'base','启动响应即记录真实边界')
    state=await settle()
    assert.equal(state.stage,'style',state.error||'base 完成后指针前移')
    assert.equal(state.status,'awaiting_review')
    assert.equal(state.mode,'guided');assert.equal(state.stop_at,'base')
    assert.ok(state.outputs.base_image,'底图已发布')
    assert.equal(state.outputs.final_image,null,'有界 base 不进入 drawing')
    assert.equal(state.steps.find(step=>step.id==='base').status,'completed')
    assert.equal(state.steps.find(step=>step.id==='style').status,'pending','style 不执行')
    assert.equal(state.steps.find(step=>step.id==='drawing').status,'pending')
    assert.equal(state.deliveries.length,0)
    const baseRun=runRows()[0]
    assert.equal(baseRun.mode,'guided')
    assert.equal(baseRun.start_stage,'base')
    assert.equal(readRunParams(baseRun.id).stop_at,'base')
    assert.equal(runRows().length,before+1)

    // ── guided/drawing：style 跳过纸纹后作图，drawing 完成即停在 complete/awaiting_review ──
    const second=await startMapWorkflow(taskId,{mode:'guided',stopAt:'drawing',expectedRevision:state.revision,textConfigId:configId})
    assert.equal(second.mode,'guided');assert.equal(second.stop_at,'drawing')
    state=await settle()
    assert.equal(state.stage,'complete',state.error||'drawing 完成后指针前移')
    assert.equal(state.status,'awaiting_review')
    assert.equal(state.mode,'guided');assert.equal(state.stop_at,'drawing')
    assert.ok(state.outputs.final_image,'成图已发布')
    assert.equal(state.outputs.texture_image,null,'不叠纸纹')
    assert.equal(state.steps.find(step=>step.id==='style').status,'completed')
    assert.equal(state.steps.find(step=>step.id==='drawing').status,'completed')
    assert.equal(state.steps.find(step=>step.id==='complete').status,'pending','完整交付步骤不执行')
    assert.equal(state.deliveries.length,0,'有界 drawing 不交付')
    const prop=db.select().from(schema.props).where(eq(schema.props.id,propId)).get()
    assert.equal(prop.imageUrl,null,'未交付就不改写宿主当前图')
    const drawingRun=runRows()[0]
    assert.equal(drawingRun.mode,'guided');assert.equal(drawingRun.start_stage,'style')
    assert.equal(readRunParams(drawingRun.id).stop_at,'drawing')
    assert.equal(runRows().length,before+2,'两次有界请求=两条 run，无隐式串发')

    // ── 跳过 style 不是 run：不伪造/清除真实边界；manual 运行则如实记 boundaries=null ──
    await mutateWorkflow(taskId,{action:'fixture_rollback',actor:'system',requireIdle:true,mutate:ctx=>{ctx.state.stage='style';ctx.state.status='idle';for(const step of ctx.state.steps)if(['style','drawing','complete'].includes(step.id))step.status='pending'}})
    state=await loadWorkflow(taskId)
    await advanceMapWorkflow(taskId,{expectedRevision:state.state.revision,skip:true})
    state=serializeDetail(await loadWorkflow(taskId))
    assert.equal(state.stage,'drawing')
    assert.equal(state.mode,'guided','跳过 step 不新建 run，不改运行边界')
    assert.equal(state.stop_at,'drawing')
    state=await startMapWorkflow(taskId,{mode:'manual',expectedRevision:state.revision,textConfigId:configId})
    assert.equal(state.mode,'manual','manual 运行如实记录')
    assert.equal(state.stop_at,null,'manual 没有 stop_at')
    state=await settle()
    assert.equal(state.status,'awaiting_review',state.error||'单阶段 drawing 完成后停在 complete/awaiting_review')
    assert.equal(state.deliveries.length,0,'manual drawing 不交付')
    await mock.close()
    console.log('MAP_GUIDED_OK')
  `
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, probeBody)
  try {
    const result = execFileSync('node_modules/.bin/tsx', [probe], {
      cwd: backend, encoding: 'utf8', timeout: 240000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    assert.match(result, /MAP_GUIDED_OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
