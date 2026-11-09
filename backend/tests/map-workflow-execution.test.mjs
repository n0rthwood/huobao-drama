import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Real service/database/render path. The inert text config supplies task metadata only:
// resuming a deterministic stage must not invoke a model or restart brief/research.
test('地图继续当前阶段：原件与成图原子采用，几何编辑复用底图且不重新计费', () => {
  const backend = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'map-execution-'))
  const script = `
    import assert from 'node:assert/strict'
    import {db,schema,getInsertId} from 'file://${backend}src/db/index.ts'
    import {now} from 'file://${backend}src/utils/response.ts'
    import {loadWorkflow,serializeDetail,mutateWorkflow,briefHash,getProp} from 'file://${backend}src/services/map-workflow/store.ts'
    import {emptyBrief} from 'file://${backend}src/services/map-workflow/types.ts'
    import {startMapWorkflow,advanceMapWorkflow,saveMapWorkflowDraft,failInterruptedMapWorkflows,rollbackMapWorkflow} from 'file://${backend}src/services/map-workflow/run.ts'
    import {normalizeMapSpec} from 'file://${backend}src/services/map-base-render.ts'
    import {importAsset} from 'file://${backend}src/services/asset-library.ts'
    const ts=now()
    const dramaId=getInsertId(await db.insert(schema.dramas).values({title:'地图执行回归',createdAt:ts,updatedAt:ts}))
    const configId=getInsertId(await db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'Inert metadata fixture',baseUrl:'http://127.0.0.1:1',apiKey:'not-a-credential',model:'["inert-model"]',isActive:true,createdAt:ts,updatedAt:ts}))
    const propId=getInsertId(await db.insert(schema.props).values({dramaId,name:'测试区位图',description:'原始资产说明',assetType:'map',createdAt:ts,updatedAt:ts}))
    let loaded=await loadWorkflow(propId)
    assert.equal(serializeDetail(loaded).brief.subject,'测试区位图')
    await saveMapWorkflowDraft(propId,{expectedRevision:0,brief:{era:'明代'}})
    loaded=await loadWorkflow(propId)
    assert.equal(loaded.state.brief.subject,'测试区位图')
    assert.equal(loaded.state.brief.notes,'原始资产说明')
    const spec=normalizeMapSpec({bbox:[113,35.2,115.6,36.8],places:[{id:'a',name:'安阳',lon:114.39,lat:36.09}]})
    await mutateWorkflow(propId,{action:'fixture_geometry',actor:'system',requireIdle:true,mutate:ctx=>{
      ctx.mapSpec=spec
      ctx.state.brief={...emptyBrief(),subject:'测试区位图',era:'明代',location:'安阳',purpose:'位置示意'}
      ctx.state.brief_hash=briefHash(ctx.state.brief)
      ctx.state.stage='base';ctx.state.status='idle'
    }})
    const settle=async(id=propId)=>{
      const deadline=Date.now()+20000
      for(;;){
        const row=await loadWorkflow(id)
        if(row.state.status!=='running')return serializeDetail(row)
        if(Date.now()>deadline)throw Error('Map deterministic stage did not finish')
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
    assert.equal(state.status,'completed',state.error||'auto must resume drawing without new model work')
    const prop=await getProp(propId)
    assert.equal(prop.imageUrl,state.outputs.final_image.path)
    assert.equal(prop.faithfulSource,base.task_id)
    assert.equal(JSON.parse(prop.semantics).image.source_task_id,state.outputs.final_image.task_id)
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
    assert.equal(state.outputs.base_image.task_id,base.task_id)
    assert.equal(state.outputs.texture_image,null)
    const completedRevision=state.revision
    const completedFinal=state.outputs.final_image.path
    await failInterruptedMapWorkflows()
    state=serializeDetail(await loadWorkflow(propId))
    assert.equal(state.revision,completedRevision,'historical running entries must not trigger recovery or a revision bump')
    assert.equal(state.status,'completed')
    await mutateWorkflow(propId,{action:'fixture_interruption',actor:'system',mutate:ctx=>{
      ctx.state.status='running'
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
    const interruptedId=getInsertId(await db.insert(schema.sysTask).values({
      type:'text',dramaId,propId,provider:'openai',model:'inert-model',
      params:JSON.stringify({kind:'map_workflow',map_prop_id:propId,map_texture_task_id:imageId,map_texture_theme:'archival'}),
      status:'failed',createdAt:ts,updatedAt:ts,
    }))
    await mutateWorkflow(propId,{action:'fixture_texture_interruption',actor:'system',mutate:ctx=>{
      ctx.state.stage='style';ctx.state.status='running';ctx.state.task_id=interruptedId
      ctx.state.steps.find(step=>step.id==='style').status='running'
    }})
    await failInterruptedMapWorkflows()
    loaded=await loadWorkflow(propId)
    await startMapWorkflow(propId,{mode:'auto',expectedRevision:loaded.state.revision,textConfigId:configId})
    state=await settle()
    assert.equal(state.status,'completed',state.error)
    assert.equal(state.outputs.texture_image.task_id,imageId,'restart must reuse the paid texture task')
    assert.equal((await getProp(propId)).imageUrl,state.outputs.final_image.path)
    assert.equal(JSON.parse((await getProp(propId)).semantics).image.source_task_id,state.outputs.final_image.task_id)
    const texturedBase=state.outputs.base_image.task_id
    await rollbackMapWorkflow(propId,'drawing',state.revision)
    loaded=await loadWorkflow(propId)
    assert.equal(loaded.state.outputs.texture_image.task_id,imageId,'rolling back drawing must preserve completed upstream texture')
    await startMapWorkflow(propId,{mode:'auto',expectedRevision:loaded.state.revision,textConfigId:configId})
    state=await settle()
    assert.equal(state.status,'completed',state.error)
    assert.equal(state.outputs.texture_image.task_id,imageId)
    assert.equal(state.outputs.base_image.task_id,texturedBase)
    // Full-copy semantics: redraw must still work after the source files disappear.
    const targetDramaId=getInsertId(await db.insert(schema.dramas).values({title:'地图导入目标',createdAt:ts,updatedAt:ts}))
    const imported=await importAsset({targetDramaId,kind:'prop',sourceId:propId})
    let cloned=serializeDetail(await loadWorkflow(imported.id))
    const clonedProp=await getProp(imported.id)
    assert.equal(clonedProp.faithfulSource,cloned.outputs.base_image.task_id)
    assert.equal(JSON.parse(clonedProp.semantics).image.source_task_id,cloned.outputs.final_image.task_id)
    for(const key of ['base_image','texture_image','final_image']){
      const original=state.outputs[key],copied=cloned.outputs[key]
      assert.notEqual(copied.path,original.path,'Imported media must be independent files')
      assert.deepEqual(readFileSync(process.env.HUOBAO_DATA_DIR+'/'+copied.path),readFileSync(process.env.HUOBAO_DATA_DIR+'/'+original.path))
      unlinkSync(process.env.HUOBAO_DATA_DIR+'/'+original.path)
    }
    const versions=await db.select().from(schema.sysTask)
    for(const key of ['base_image','final_image']){
      assert.equal(versions.find(row=>row.id===cloned.outputs[key].task_id).propId,imported.id)
    }
    cloned.map_spec.places[0].lon+=0.01
    cloned=await saveMapWorkflowDraft(imported.id,{expectedRevision:cloned.revision,mapSpec:cloned.map_spec})
    await startMapWorkflow(imported.id,{mode:'auto',expectedRevision:cloned.revision,textConfigId:configId})
    cloned=await settle(imported.id)
    assert.equal(cloned.status,'completed',cloned.error)
    assert.equal((await getProp(imported.id)).imageUrl,cloned.outputs.final_image.path)
    const {eq}=createRequire('file://${backend}package.json')('drizzle-orm')
    await db.update(schema.props).set({assetType:'prop'}).where(eq(schema.props.id,imported.id))
    const dormant=await importAsset({targetDramaId,kind:'prop',sourceId:imported.id,name:'保留历史地图数据'})
    const dormantProp=await getProp(dormant.id)
    assert.equal(dormantProp.assetType,'prop','Import must not reactivate a map explicitly changed to an ordinary prop')
    assert.deepEqual(JSON.parse(dormantProp.mapSpec),cloned.map_spec)
    assert.ok(JSON.parse(dormantProp.mapWorkflow).outputs.base_image.task_id,'Changing category must not erase recoverable map history')
    console.log('MAP_EXECUTION_OK')
  `
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, script)
  try {
    const result = execFileSync('node_modules/.bin/tsx', [probe], {
      cwd: backend, encoding: 'utf8', timeout: 45000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    assert.match(result, /MAP_EXECUTION_OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
