import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Real service/database/render path. Base and drawing are model stages since #90, so a local scripted
// OpenAI-compatible model frames the base from the current map_spec bbox and draws the anchored layers;
// resuming must still continue the current stage instead of restarting brief/research.
test('地图继续当前阶段：原件与成图原子采用，几何编辑复用底图且不重新计费', () => {
  const backend = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'map-execution-'))
  const script = `
    import assert from 'node:assert/strict'
    import {db,schema,getInsertId} from 'file://${backend}src/db/index.ts'
    import {now} from 'file://${backend}src/utils/response.ts'
    import {loadTask as loadWorkflow,serializeDetail,mutateTask as mutateWorkflow,briefHash} from 'file://${backend}src/modules/map-studio/store.ts'
    import {emptyBrief} from 'file://${backend}src/modules/map-studio/types.ts'
    import {startMapWorkflow,advanceMapWorkflow,saveMapWorkflowDraft,rollbackMapWorkflow} from 'file://${backend}src/modules/map-studio/run.ts'
    import {normalizeMapSpec} from 'file://${backend}src/modules/map-studio/geo/base-render.ts'
    import {importAsset,AssetLibraryError} from 'file://${backend}src/services/asset-library.ts'
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

    import { initMapStudio, registerMapStudioHost, openHostTask } from 'file://${backend}src/modules/map-studio/index.ts'
    import { huobaoMapStudioHost } from 'file://${backend}src/services/map-studio-host.ts'
    import { insertRun, readRunParams, patchRunParams, selectRun } from 'file://${backend}src/modules/map-studio/db.ts'
    const platform = {
      async submitImage() { throw Error('Unexpected billed texture submission in test') },
      async pollImage(ref) {
        const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(ref))).get()
        return row ? { status: row.status === 'completed' ? 'completed' : 'pending', path: row.localPath, error: row.errorMsg } : { status: 'missing', path: null, error: 'missing' }
      },
    }
    registerMapStudioHost(huobaoMapStudioHost)
    await initMapStudio(platform)
    const createMap = async (dramaId, name, description = '') => {
      const id = getInsertId(await db.insert(schema.props).values({ dramaId, name, description, assetType: 'map', createdAt: now(), updatedAt: now() }))
      return (await openHostTask({ host: 'huobao', ref: 'prop:' + id })).task_id
    }
    const getProp = async taskId => {
      const loaded = await loadWorkflow(taskId)
      return db.select().from(schema.props).where(eq(schema.props.id, Number(loaded.row.host_ref.split(':')[1]))).get()
    }
    const failInterruptedMapWorkflows = async () => initMapStudio(platform)

    const ts=now()
    const dramaId=getInsertId(await db.insert(schema.dramas).values({title:'地图执行回归',createdAt:ts,updatedAt:ts}))
    const configId=getInsertId(await db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'Scripted map model',baseUrl:mock.baseUrl,apiKey:'not-a-credential',model:'["mock-agent"]',isActive:true,vision:true,createdAt:ts,updatedAt:ts}))
    const propId=await createMap(dramaId,'测试区位图','原始资产说明')
    let loaded=await loadWorkflow(propId)
    assert.equal(serializeDetail(loaded).brief.subject,'测试区位图')
    await saveMapWorkflowDraft(propId,{expectedRevision:0,brief:{era:'明代'}})
    loaded=await loadWorkflow(propId)
    assert.equal(loaded.state.brief.subject,'测试区位图')
    assert.equal(loaded.state.brief.notes,'原始资产说明')
    const spec=normalizeMapSpec({bbox:[113,35.2,115.6,36.8],places:[{id:'a',name:'安阳',lon:114.39,lat:36.09}]})
    await mutateWorkflow(propId,{action:'fixture_geometry',actor:'system',requireIdle:true,mutate:ctx=>{
      ctx.mapSpec=spec
      ctx.brief={...emptyBrief(),subject:'测试区位图',era:'明代',location:'安阳',purpose:'位置示意'}
      ctx.state.brief_hash=briefHash(ctx.brief)
      ctx.state.stage='base';ctx.state.status='idle'
    }})
    const settle=async(id=propId)=>{
      const deadline=Date.now()+60000
      for(;;){
        const row=await loadWorkflow(id)
        if(row.state.status!=='running')return serializeDetail(row)
        if(Date.now()>deadline)throw Error('Map stage did not finish')
        await new Promise(resolve=>setTimeout(resolve,20))
      }
    }
    loaded=await loadWorkflow(propId)
    await startMapWorkflow(propId,{mode:'manual',expectedRevision:loaded.state.revision,textConfigId:configId})
    let state=await settle()
    assert.equal(state.stage,'style',state.error||'run must resume base, not restart brief')
    assert.equal(state.status,'awaiting_review')
    assert.equal((await getProp(propId)).imageUrl,null,'unreviewed base must not replace current asset')
    const base=state.outputs.base_image
    await advanceMapWorkflow(propId,{expectedRevision:state.revision,skip:true})
    state=serializeDetail(await loadWorkflow(propId))
    assert.equal(state.stage,'drawing')
    await startMapWorkflow(propId,{mode:'auto',expectedRevision:state.revision,textConfigId:configId})
    state=await settle()
    assert.equal(state.status,'completed',state.error||'auto must resume drawing, not restart brief/research')
    const prop=await getProp(propId)
    assert.equal(prop.imageUrl,state.outputs.final_image.path)
    assert.equal(prop.faithfulSource,state.deliveries[0].version_ids[0])
    assert.equal(JSON.parse(prop.semantics).image.source_task_id,state.deliveries[0].version_ids[1])
    assert.equal(state.outputs.texture_image,null)
    const priorFinal=state.outputs.final_image.path
    state=await saveMapWorkflowDraft(propId,{expectedRevision:state.revision,mapSpec:state.map_spec})
    assert.equal(state.status,'completed','unchanged save must not invalidate current map')
    assert.equal(state.outputs.final_image.path,priorFinal)
    state.map_spec.places[0].lon+=0.05
    state=await saveMapWorkflowDraft(propId,{expectedRevision:state.revision,mapSpec:state.map_spec})
    assert.equal(state.stage,'drawing')
    assert.equal(state.outputs.base_image.path,base.path)
    assert.equal(state.outputs.final_image,null)
    assert.equal((await getProp(propId)).imageUrl,priorFinal,'old current image remains paired with its old semantics until new adoption')
    await startMapWorkflow(propId,{mode:'auto',expectedRevision:state.revision,textConfigId:configId})
    state=await settle()
    assert.equal(state.status,'completed',state.error)
    assert.notEqual(state.outputs.final_image.path,priorFinal)
    assert.equal(state.outputs.base_image.path,base.path)
    assert.equal(state.outputs.texture_image,null)
    const completedRevision=state.revision
    const completedFinal=state.outputs.final_image.path
    await failInterruptedMapWorkflows()
    state=serializeDetail(await loadWorkflow(propId))
    assert.equal(state.revision,completedRevision,'historical running entries must not trigger recovery or a revision bump')
    assert.equal(state.status,'completed')
    const interruptedFirst=insertRun({taskId:propId,mode:'manual',startStage:'drawing',stage:'drawing',textConfigId:configId,imageConfigId:null,imageModel:null,params:{}})
    await mutateWorkflow(propId,{action:'fixture_interruption',actor:'system',mutate:ctx=>{
      ctx.state.status='running';ctx.state.run_id=interruptedFirst
      ctx.state.steps.find(step=>step.id==='drawing').status='running'
    }})
    await failInterruptedMapWorkflows()
    state=serializeDetail(await loadWorkflow(propId))
    assert.equal(state.status,'failed')
    assert.equal(state.steps.find(step=>step.id==='drawing').status,'failed')
    assert.equal(state.outputs.final_image.path,completedFinal,'restart preserves already-produced media')
    // A paid texture may finish while the map runner is down. Resume must adopt
    // that image, not submit another billable task or lose its origin.
    const {createRequire}=await import('node:module')
    const {mkdirSync,readFileSync,unlinkSync}=await import('node:fs')
    const sharp=createRequire('file://${backend}package.json')('sharp')
    mkdirSync(process.env.STORAGE_PATH+'/map-textures',{recursive:true})
    const texturePath='static/map-textures/recovered.png'
    await sharp({create:{width:16,height:16,channels:3,background:'#e2d5ba'}}).png().toFile(process.env.HUOBAO_DATA_DIR+'/'+texturePath)
    const imageId=getInsertId(await db.insert(schema.sysTask).values({
      type:'image',dramaId,provider:'qwen-jobs',model:'fixture-image',
      params:JSON.stringify({map_texture:{prop_id:propId,prop_name:'测试区位图'}}),
      status:'completed',localPath:texturePath,createdAt:ts,updatedAt:ts,
    }))
    const interruptedId=insertRun({taskId:propId,mode:'auto',startStage:'style',stage:'style',textConfigId:configId,imageConfigId:null,imageModel:null,params:{map_texture_ref:String(imageId),map_texture_theme:'archival'}})
    await mutateWorkflow(propId,{action:'fixture_texture_interruption',actor:'system',mutate:ctx=>{
      ctx.state.stage='style';ctx.state.status='running';ctx.state.run_id=interruptedId
      ctx.state.steps.find(step=>step.id==='style').status='running'
    }})
    await failInterruptedMapWorkflows()
    loaded=await loadWorkflow(propId)
    await startMapWorkflow(propId,{mode:'auto',expectedRevision:loaded.state.revision,textConfigId:configId})
    state=await settle()
    assert.equal(state.status,'completed',state.error)
    assert.equal(state.outputs.texture_image.path,texturePath,'restart must reuse the paid texture task')
    assert.equal((await getProp(propId)).imageUrl,state.outputs.final_image.path)
    assert.equal(JSON.parse((await getProp(propId)).semantics).image.source_task_id,state.deliveries[0].version_ids[1])
    const texturedBase=state.outputs.base_image.run_id
    await rollbackMapWorkflow(propId,'drawing',state.revision)
    loaded=await loadWorkflow(propId)
    assert.equal(loaded.state.outputs.texture_image.path,texturePath,'rolling back drawing must preserve completed upstream texture')
    await startMapWorkflow(propId,{mode:'auto',expectedRevision:loaded.state.revision,textConfigId:configId})
    state=await settle()
    assert.equal(state.status,'completed',state.error)
    assert.equal(state.outputs.texture_image.path,texturePath)
    assert.equal(state.outputs.base_image.run_id,texturedBase)
    await mock.close()
    console.log('MAP_EXECUTION_OK')
  `
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, script)
  try {
    const result = execFileSync('node_modules/.bin/tsx', [probe], {
      cwd: backend, encoding: 'utf8', timeout: 180000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    assert.match(result, /MAP_EXECUTION_OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
