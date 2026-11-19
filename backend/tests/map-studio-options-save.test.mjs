import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Issue #126 G6：几何区的层选项保存只持久化并标成图过期，不借道重渲/交付（旧分支 run.ts:444-449）。
test('地图层选项保存：仅持久化并标图过期，不渲染不交付，保留图层文档与人工交付入口', () => {
  const backend = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'map-options-save-'))
  const probeBody = `
    import assert from 'node:assert/strict'
    import {db,schema,getInsertId} from 'file://${backend}src/db/index.ts'
    import {now} from 'file://${backend}src/utils/response.ts'
    import {loadTask as loadWorkflow,mutateTask as mutateWorkflow,briefHash,serializeDetail} from 'file://${backend}src/modules/map-studio/store.ts'
    import {emptyBrief} from 'file://${backend}src/modules/map-studio/types.ts'
    import {saveMapWorkflowDraft} from 'file://${backend}src/modules/map-studio/run.ts'
    import {normalizeMapSpec} from 'file://${backend}src/modules/map-studio/geo/base-render.ts'
    import {initMapStudio,registerMapStudioHost,openHostTask} from 'file://${backend}src/modules/map-studio/index.ts'
    import {huobaoMapStudioHost} from 'file://${backend}src/services/map-studio-host.ts'
    import {selectRunsByTask} from 'file://${backend}src/modules/map-studio/db.ts'
    import {eq} from 'file://${backend}node_modules/drizzle-orm/index.js'
    const platform={async submitImage(){throw Error('no image generation in this test')},async pollImage(){return{status:'missing',path:null,error:'missing'}}}
    registerMapStudioHost(huobaoMapStudioHost)
    await initMapStudio(platform)
    const ts=now()
    const dramaId=getInsertId(await db.insert(schema.dramas).values({title:'层选项保存回归',createdAt:ts,updatedAt:ts}))
    const propId=getInsertId(await db.insert(schema.props).values({dramaId,name:'层选项地图',description:'',assetType:'map',createdAt:ts,updatedAt:ts}))
    const taskId=(await openHostTask({host:'huobao',ref:'prop:'+propId})).task_id
    const spec=normalizeMapSpec({bbox:[113,35.2,115.6,36.8],routes:[{id:'river',name:'河',points:[[114,35.6],[114.6,36.1]],category:'river',origin:'dataset'}]})
    const layerDoc={version:1,base:{path:'map-bases/fixture.png',width:1280,height:720},theme:'archival',layers:[
      {id:'feature-river',type:'polyline',name:'河',visible:true,locked:false,z:1,opacity:1,rotation:0,points:[[.1,.2],[.3,.4]],anchor:{semantic_id:'river',semantic_name:'河'},style:{stroke:'#123456',width:.002,dash:'none'}},
    ]}
    const finalRef={path:'map-drawings/final.png',width:1280,height:720,source:'map-drawing',run_id:7,provenance:{background:'map-bases/fixture.png'}}
    await mutateWorkflow(taskId,{action:'fixture_finished',actor:'system',requireIdle:true,mutate:ctx=>{
      ctx.mapSpec=spec
      ctx.brief={...emptyBrief(),subject:'层选项地图',era:'明代',location:'安阳',purpose:'位置示意'}
      ctx.state.brief_hash=briefHash(ctx.brief)
      ctx.state.stage='complete';ctx.state.status='awaiting_review'
      for(const step of ctx.state.steps)step.status='completed'
      ctx.state.outputs.base_image={path:'map-bases/fixture.png',width:1280,height:720,source:'map-base:program',run_id:6,provenance:{registration:{mode:'program'}}}
      ctx.state.outputs.final_image=finalRef
      ctx.state.outputs.layer_doc=layerDoc
      ctx.state.outputs.layer_options={river:{smooth:1}}
    }})
    const runsBefore=selectRunsByTask(taskId).length
    let state=serializeDetail(await loadWorkflow(taskId))
    const before=state.revision

    // 只改层选项：持久化 + 标图过期，不重渲、不交付、不新建 run。
    state=await saveMapWorkflowDraft(taskId,{expectedRevision:before,layerOptions:{river:{smooth:.4}}})
    assert.equal(state.revision,before+1,'一次 CAS 保存')
    assert.equal(state.outputs.layer_options.river.smooth,.4)
    assert.equal(state.outputs.final_image,null,'成图标为过期')
    assert.deepEqual(state.outputs.layer_doc,layerDoc,'图层文档不被重渲改写')
    assert.equal(state.stage,'drawing','需要重新渲染')
    assert.equal(state.status,'idle')
    assert.equal(state.steps.find(step=>step.id==='drawing').status,'pending')
    assert.equal(state.steps.find(step=>step.id==='complete').status,'pending')
    assert.ok(state.issues.some(issue=>issue.code==='layer_options_changed'),'提示图层设置已变更')
    assert.equal(state.deliveries.length,0,'不产生交付')
    assert.equal(selectRunsByTask(taskId).length,runsBefore,'不创建运行')
    const prop=db.select().from(schema.props).where(eq(schema.props.id,propId)).get()
    assert.equal(prop.imageUrl,null,'未重渲就不改写宿主当前图')

    // 再次保存同一份选项：不再改写任何产物，提示不重复堆叠。
    state=await saveMapWorkflowDraft(taskId,{expectedRevision:state.revision,layerOptions:{river:{smooth:.4}}})
    assert.equal(state.outputs.final_image,null)
    assert.deepEqual(state.outputs.layer_doc,layerDoc)
    assert.equal(state.issues.filter(issue=>issue.code==='layer_options_changed').length,1)

    // 选项未变时，已有成图保持有效（不做伪失效）。
    await mutateWorkflow(taskId,{action:'fixture_restore',actor:'system',requireIdle:true,mutate:ctx=>{ctx.state.outputs.final_image=finalRef;ctx.state.stage='complete';ctx.state.status='awaiting_review'}})
    state=serializeDetail(await loadWorkflow(taskId))
    state=await saveMapWorkflowDraft(taskId,{expectedRevision:state.revision,layerOptions:{river:{smooth:.4}}})
    assert.equal(state.outputs.final_image?.path,finalRef.path,'未变的选项不失效成图')
    assert.equal(state.stage,'complete')

    // 人工图层文档的高级通道仍保留重渲+交付副作用：它只在显式 PUT /layer-doc 上发生。
    const source=await import('file://${backend}src/modules/map-studio/run.ts')
    assert.equal(typeof source.saveMapLayerDoc,'function')
    console.log('MAP_OPTIONS_SAVE_OK')
  `
  const probe = path.join(dir, 'probe.mts')
  writeFileSync(probe, probeBody)
  try {
    const result = execFileSync('node_modules/.bin/tsx', [probe], {
      cwd: backend, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
    })
    assert.match(result, /MAP_OPTIONS_SAVE_OK/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
