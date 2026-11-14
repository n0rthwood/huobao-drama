import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('../', import.meta.url))
function probe(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-beautify-'))
  const file = path.join(dir, 'probe.mts')
  writeFileSync(file, script.replaceAll('__BACKEND__', backend))
  const env = { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), HUOBAO_DATA_DIR: dir }
  delete env.STORAGE_PATH
  try { return execFileSync('node_modules/.bin/tsx', [file], { cwd: backend, env, encoding: 'utf8', timeout: 180000 }) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}
const labelFixture = `
  const common = (id, type, extra) => ({id,type,name:id,visible:true,locked:false,z:0,opacity:1,rotation:0,style:{},...extra})
  const marker = (id, feature, at) => common(id,'marker',{at,text:'',anchor:{semantic_id:feature}})
  const label = (id, feature, text, box={x:.45,y:.3,w:.16,h:.08}) => common(id,'label',{text,box,style:{size:.025},anchor:{semantic_id:feature}})
  const doc = {version:1,base:{path:'static/base.png',width:1000,height:600},theme:'archival',layers:[marker('point-k','k',[.3,.5]),marker('point-u','u',[.65,.5]),label('k-label','k','喀什里克'),label('u-label','u','乌拉尔山')]}
`

test('Map Studio QA labels: overlap, far Kashlik, marker overlap, safety edge and greedy unresolved without deletion/shrink', () => {
  assert.match(probe(`
    import assert from 'node:assert/strict'
    import {labelProblems,autoPlaceLabels,textRectsOf} from '__BACKEND__src/modules/map-studio/layout/labels.ts'
    import {normalizeBrief,emptyBrief} from '__BACKEND__src/modules/map-studio/types.ts'
    assert.equal(normalizeBrief({},emptyBrief()).map_style,null,'new briefs follow the module default')
    const explicit=normalizeBrief({map_style:'modern-clean'},emptyBrief())
    assert.equal(explicit.map_style,'modern-clean')
    assert.equal(normalizeBrief({map_style:null},explicit).map_style,null)
    ${labelFixture}
    const original=JSON.stringify(doc)
    assert.ok(labelProblems(doc).some(p=>p.code==='label_overlap'))
    assert.ok(labelProblems(doc).some(p=>p.code==='label_far_from_feature'&&p.layer_id==='k-label'))
    const placed=autoPlaceLabels(doc)
    assert.deepEqual(placed.unresolved,[])
    assert.deepEqual(labelProblems(placed.doc),[])
    assert.equal(JSON.stringify(doc),original,'pure: original draft stays untouched')
    assert.equal(placed.doc.layers.length,doc.layers.length)
    for(const layer of placed.doc.layers.filter(l=>l.type==='label')){
      const before=doc.layers.find(l=>l.id===layer.id)
      assert.equal(layer.text,before.text);assert.deepEqual(layer.style,before.style)
      assert.equal(layer.box.w,before.box.w);assert.equal(layer.box.h,before.box.h)
    }
    const covered={...doc,layers:[...doc.layers.slice(0,2),label('cover','u','喀什里克',{x:.29,y:.48,w:.16,h:.08})]}
    assert.ok(labelProblems(covered).some(p=>p.code==='label_marker_overlap'))
    const edge={...doc,layers:[label('edge','k','喀什里克',{x:.995,y:.01,w:.16,h:.08})]}
    assert.ok(labelProblems(edge).some(p=>p.code==='label_out_of_frame'))
    const impossible={...doc,layers:[doc.layers[0],label('huge','k','地名'.repeat(30),{x:.01,y:.01,w:.98,h:.98})]}
    impossible.layers[1].style.size=.5
    const unresolved=autoPlaceLabels(impossible)
    assert.ok(unresolved.unresolved.some(u=>u.layer_id==='huge'))
    assert.deepEqual(unresolved.doc.layers,impossible.layers,'cannot fit: retain original label and size')
    const markerDoc={...doc,layers:[common('m','marker',{at:[.5,.5],text:'地名',style:{size:.025}})]}
    const rect=textRectsOf(markerDoc)[0]
    assert.ok(Math.abs(rect.w-(2*15+2*15*.08))<1e-9)
    assert.ok(Math.abs(rect.h-(15*1.35+2*15*.08))<1e-9)
    const nearbyMarkers={...doc,layers:[
      common('m1','marker',{at:[.5,.5],text:'甲地',style:{size:.025}}),
      common('m2','marker',{at:[.51,.5],text:'乙地',style:{size:.025}}),
    ]}
    assert.ok(labelProblems(nearbyMarkers).some(p=>p.code==='label_overlap'))
    const markerLayout=autoPlaceLabels(nearbyMarkers)
    assert.deepEqual(markerLayout.unresolved,[])
    assert.deepEqual(labelProblems(markerLayout.doc),[])
    assert.deepEqual(markerLayout.doc.layers.map(l=>l.at),nearbyMarkers.layers.map(l=>l.at))
    const title=common('fixed-title','label',{box:{x:.05,y:.03,w:.4,h:.08},text:'历史地图',style:{size:.025}})
    const linear={...doc,layers:[
      common('line','polyline',{anchor:{semantic_id:'r'},points:[[.15,.7],[.8,.7],[.85,.8]]}),
      common('area','polygon',{anchor:{semantic_id:'g'},points:[[.2,.2],[.6,.2],[.6,.5],[.2,.5]]}),
      label('r-label','r','路线',{x:.05,y:.05,w:.16,h:.08}),
      label('g-label','g','山地',{x:.05,y:.05,w:.16,h:.08}),title,
    ]}
    const linearLayout=autoPlaceLabels(linear)
    assert.deepEqual(linearLayout.unresolved,[])
    assert.deepEqual(labelProblems(linearLayout.doc),[])
    assert.deepEqual(linearLayout.doc.layers.find(l=>l.id===title.id),title,'titles are fixed')
    console.log('LABEL_LAYOUT_OK')
  `), /LABEL_LAYOUT_OK/)
})

test('Map Studio plates: a legend plate drawn above a marker, another label or another river blocks; text drawn on the plate does not', () => {
  assert.match(probe(`
    import assert from 'node:assert/strict'
    import {labelProblems,autoPlaceLabels} from '__BACKEND__src/modules/map-studio/layout/labels.ts'
    ${labelFixture}
    const plate = (id, box) => common(id,'label',{text:'图例',box,style:{size:.025,bg_opacity:.9}})
    const river = (id, feature, points) => common(id,'polyline',{points,anchor:{semantic_id:feature}})
    const kyiv = marker('point-kyiv','kyiv',[.2,.5])
    const dnieper = river('line-dnieper','dnieper',[[.1,.2],[.2,.8]])
    // Production version 3226: the legend plate sat above 基辅 and the Dnieper.
    const covering = {...doc,layers:[kyiv,dnieper,plate('legend',{x:.02,y:.4,w:.3,h:.25})]}
    const covered = labelProblems(covering).filter(p=>p.layer_id==='legend').map(p=>p.code)
    assert.ok(covered.includes('label_marker_overlap'),'plate above a point marker blocks')
    assert.ok(labelProblems(covering).some(p=>p.layer_id==='legend'&&/line-dnieper/.test(p.message)),'plate above another river blocks')
    // Legend entries written on top of the plate are normal layout.
    const entry = common('entry','label',{text:'蓝线：河流',box:{x:.04,y:.5,w:.2,h:.05},style:{size:.02}})
    const layered = {...doc,layers:[plate('legend',{x:.6,y:.7,w:.3,h:.25}),entry]}
    layered.layers[1].box={x:.62,y:.75,w:.2,h:.05}
    assert.deepEqual(labelProblems(layered),[])
    // The same plate below the entry in draw order but above it is reported for both layers.
    const hidden = {...doc,layers:[layered.layers[1],layered.layers[0]]}
    assert.ok(labelProblems(hidden).some(p=>p.layer_id==='entry'&&p.code==='label_overlap'))
    // A label's own river under its own plate is fine.
    const ownLabel = common('dnieper-label','label',{text:'第聂伯河',box:{x:.12,y:.45,w:.12,h:.06},style:{size:.025,bg_opacity:.8},anchor:{semantic_id:'dnieper'}})
    assert.deepEqual(labelProblems({...doc,layers:[dnieper,ownLabel]}).filter(p=>/line-dnieper/.test(p.message)),[])
    // auto layout moves an anchored plate label off a foreign marker.
    const foreign = common('k-plate','label',{text:'喀什里克',box:{x:.15,y:.47,w:.12,h:.06},style:{size:.025,bg_opacity:.8},anchor:{semantic_id:'k'}})
    const placed = autoPlaceLabels({...doc,layers:[marker('point-k','k',[.3,.5]),kyiv,foreign]})
    assert.deepEqual(placed.unresolved,[])
    assert.deepEqual(labelProblems(placed.doc),[])
    console.log('PLATE_OK')
  `), /PLATE_OK/)
})

test('Map Studio manual HTTP save rejects overlapping labels; check/auto-layout are read-only and return the same layout', () => {
  assert.match(probe(`
    import assert from 'node:assert/strict'
    import {initMapStudio,mapStudioRoutes} from '__BACKEND__src/modules/map-studio/index.ts'
    import {createStandaloneTask} from '__BACKEND__src/modules/map-studio/tasks.ts'
    import {mutateTask,loadTask} from '__BACKEND__src/modules/map-studio/store.ts'
    import {normalizeMapSpec} from '__BACKEND__src/modules/map-studio/geo/base-render.ts'
    import {autoPlaceLabels} from '__BACKEND__src/modules/map-studio/layout/labels.ts'
    ${labelFixture}
    await initMapStudio({async submitImage(){throw Error('no generation')},async pollImage(){throw Error('no generation')}})
    const task=await createStandaloneTask({title:'label QA'})
    await mutateTask(task.task_id,{action:'fixture',actor:'system',mutate:ctx=>{
      ctx.mapSpec=normalizeMapSpec({bbox:[10,10,20,20],places:[{id:'k',name:'喀什里克',lon:13,lat:15},{id:'u',name:'乌拉尔山',lon:16.5,lat:15}]})
      ctx.state.outputs.layer_doc=doc
      ctx.state.outputs.base_image={path:doc.base.path,width:1000,height:600,source:'fixture',run_id:null,provenance:null}
      ctx.state.stage='drawing';ctx.state.status='awaiting_review'
    }})
    const before=await loadTask(task.task_id)
    const request=async(suffix,payload,method='POST')=>{
      const r=await mapStudioRoutes.request('/tasks/'+task.task_id+'/layer-doc'+suffix,{method,headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
      return {status:r.status,body:await r.json()}
    }
    const denied=await request('',{layer_doc:doc,expected_revision:before.state.revision},'PUT')
    assert.equal(denied.status,400)
    assert.ok(denied.body.problems.some(p=>p.code==='label_overlap'))
    const checked=await request('/check',{layer_doc:doc})
    assert.equal(checked.status,200)
    assert.ok(checked.body.data.problems.some(p=>p.code==='label_far_from_feature'))
    const placed=await request('/auto-layout',{layer_doc:doc})
    assert.equal(placed.status,200)
    assert.deepEqual(placed.body.data.layer_doc,autoPlaceLabels(doc).doc)
    assert.deepEqual(placed.body.data.unresolved,[])
    assert.deepEqual(placed.body.data.problems,[])
    assert.equal((await loadTask(task.task_id)).state.revision,before.state.revision,'editor helpers do not persist')
    console.log('LABEL_HTTP_OK')
  `), /LABEL_HTTP_OK/)
})

test('Map Studio server draft: 600-vertex dataset river and dense region survive small model tools, strict save and rendered SVG', () => {
  assert.match(probe(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import {createRequire} from 'node:module'
    import {initMapStudio,mapStudioRoutes} from '__BACKEND__src/modules/map-studio/index.ts'
    import {createStandaloneTask} from '__BACKEND__src/modules/map-studio/tasks.ts'
    import {mutateTask,loadTask} from '__BACKEND__src/modules/map-studio/store.ts'
    import {insertRun} from '__BACKEND__src/modules/map-studio/db.ts'
    import {db,schema,getInsertId} from '__BACKEND__src/db/index.ts'
    import {resolveStageModel} from '__BACKEND__src/services/ai-stages.ts'
    import {emptyBrief} from '__BACKEND__src/modules/map-studio/types.ts'
    import {normalizeMapSpec} from '__BACKEND__src/modules/map-studio/geo/base-render.ts'
    import {forwardFor} from '__BACKEND__src/modules/map-studio/geo/geometry.ts'
    import {runDrawingStage,renderMapLayerDoc} from '__BACKEND__src/modules/map-studio/drawing.ts'
    import {strictMapLayerDocProblems} from '__BACKEND__src/modules/map-studio/layer-doc.ts'
    import {specFeatures} from '__BACKEND__src/modules/map-studio/validate.ts'
    import {layerDocToSvg} from '__BACKEND__src/services/layer-svg.ts'
    import {strictLayerDocProblems} from '__BACKEND__src/services/layer-doc.ts'
    import {saveMapLayerDoc} from '__BACKEND__src/modules/map-studio/run.ts'
    import {buildDeliverable} from '__BACKEND__src/modules/map-studio/delivery.ts'
    import {startMockOpenAIChat,toolResults} from '__BACKEND__tests/fixtures/mock-openai-chat.mjs'
    const require=createRequire('file://__BACKEND__package.json'), sharp=require('sharp')
    await initMapStudio({async submitImage(){throw Error('no generation')},async pollImage(){throw Error('no generation')}})
    fs.mkdirSync(process.env.HUOBAO_DATA_DIR+'/static',{recursive:true})
    await sharp({create:{width:1000,height:600,channels:3,background:'#e2d5ba'}}).png().toFile(process.env.HUOBAO_DATA_DIR+'/static/base.png')
    const river=Array.from({length:600},(_,i)=>[12+6*i/599,14+Math.sin(i/80)*.3])
    const region=Array.from({length:350},(_,i)=>[15+Math.cos(2*Math.PI*i/350)*2,17+Math.sin(2*Math.PI*i/350)*.7])
    const spec=normalizeMapSpec({bbox:[10,10,20,20],routes:[{id:'river',name:'长河',points:river,category:'river',origin:'dataset',verification:{status:'verified',reasons:['dataset fixture']}}],regions:[{id:'mountain',name:'山地',points:region,origin:'dataset',verification:{status:'verified',reasons:['dataset fixture']}}]})
    const registration={mode:'program',width:1000,height:600,bbox:spec.bbox,program:{projection:'mercator',bbox:spec.bbox}}
    const expected=spec.routes[0].points.map(p=>{const q=forwardFor(registration)(p);return[q[0]/1000,q[1]/600]})
    const model=await startMockOpenAIChat(async body=>{
      const names=(body.tools??[]).map(t=>t.function?.name)
      assert.ok(!names.includes('render_layer_doc')&&!names.includes('submit_layer_doc'))
      if(!toolResults(body,'add_feature_layers').length)return{toolCalls:[{name:'add_feature_layers',args:{items:[{feature_id:'river',style:{}},{feature_id:'mountain',style:{}}]}}]}
      if(!toolResults(body,'update_layer').length)return{toolCalls:[{name:'update_layer',args:{layer_id:'feature-river',patch:{points:[[.1,.2],[.3,.4]]}}}]}
      assert.match(JSON.stringify(toolResults(body,'update_layer')),/不允许修改/)
      if(!toolResults(body,'get_draft').length)return{toolCalls:[{name:'get_draft',args:{include_points:false}}]}
      if(!toolResults(body,'render_draft').length)return{toolCalls:[{name:'render_draft',args:{}}]}
      return{toolCalls:[{name:'submit_draft',args:{}}]}
    })
    try{
      const stamp=new Date().toISOString()
      const configId=getInsertId(await db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'Dense draft mock',baseUrl:model.baseUrl,apiKey:'not-a-credential',model:'["mock-agent"]',isActive:true,vision:true,createdAt:stamp,updatedAt:stamp}))
      const task=await createStandaloneTask({title:'dense draft QA'})
      const runId=insertRun({taskId:task.task_id,mode:'manual',startStage:'drawing',stage:'drawing',textConfigId:configId,imageConfigId:null,imageModel:null,params:{}})
      await mutateTask(task.task_id,{action:'fixture_run',actor:'system',mutate:ctx=>{ctx.state.run_id=runId;ctx.state.status='running';ctx.state.stage='drawing';ctx.mapSpec=spec}})
      const stageModel=await resolveStageModel('read_image',{configId})
      const outcome=await runDrawingStage({taskId:task.task_id,runId,stageModel,brief:{...emptyBrief(),subject:'精确河流'},spec,background:{path:'static/base.png',width:1000,height:600,registration,warnings:[]},startRounds:0,feedback:null})
      assert.equal(outcome.kind,'accepted')
      const {doc,rendered,layerOptions}=outcome.result
      const line=doc.layers.find(l=>l.type==='polyline'),polygon=doc.layers.find(l=>l.type==='polygon')
      assert.deepEqual(line.points,expected)
      assert.equal(line.points.length,600);assert.equal(polygon.points.length,351)
      assert.equal(layerOptions[line.id].smooth,0);assert.equal(layerOptions[polygon.id].smooth,0)
      assert.deepEqual(strictMapLayerDocProblems(doc,{features:specFeatures(spec),registration}).problems,[])
      assert.ok(strictLayerDocProblems(doc).problems.length,'global 240-point rule stays unchanged')
      const tampered={...doc,layers:doc.layers.map(l=>l===line?{...l,points:l.points.map((p,i)=>i===599?[p[0]+.001,p[1]]:p)}:l)}
      assert.ok(strictMapLayerDocProblems(tampered,{features:specFeatures(spec),registration}).problems.length)
      const svg=layerDocToSvg(doc,doc.base)
      assert.equal(/<polyline points="([^"]+)"/.exec(svg)[1].trim().split(/\\s+/).length,600)
      assert.equal(/<polygon points="([^"]+)"/.exec(svg)[1].trim().split(/\\s+/).length,351)
      assert.equal((await renderMapLayerDoc(doc,layerOptions)).path,rendered.path)
      assert.equal((await sharp(process.env.HUOBAO_DATA_DIR+'/'+rendered.path).metadata()).width,1000)
      for(const request of model.requests)for(const message of request.messages??[]){
        for(const call of message.tool_calls??[])assert.ok(Buffer.byteLength(call.function.arguments)<5000)
        if(message.role==='tool')assert.ok(!JSON.stringify(message.content).includes('"points":'),'tool responses never echo feature vertices')
      }
      await mutateTask(task.task_id,{action:'fixture_completed',actor:'system',mutate:ctx=>{ctx.state.status='awaiting_review';ctx.state.stage='complete';ctx.state.outputs.layer_doc=doc;ctx.state.outputs.layer_options=layerOptions;ctx.state.outputs.base_image={path:'static/base.png',width:1000,height:600,source:'fixture',run_id:runId,provenance:{registration}};ctx.state.outputs.final_image={path:rendered.path,width:1000,height:600,source:'map-drawing',run_id:runId,provenance:{registration}}}})
      const saved=await saveMapLayerDoc(task.task_id,{layerDoc:doc,layerOptions,expectedRevision:(await loadTask(task.task_id)).state.revision})
      assert.deepEqual(saved.outputs.layer_doc.layers.find(l=>l.type==='polyline').points,expected)
      assert.equal(saved.outputs.layer_doc.layers.find(l=>l.type==='polygon').points.length,351)
      const delivery=buildDeliverable(await loadTask(task.task_id))
      assert.equal(delivery.semantics.lines[0].points.length,600)
      assert.equal(delivery.semantics.regions[0].points.length,351)
      assert.deepEqual(delivery.editable_source.layer_options,layerOptions)
      // The sparse human-confirmed control polygon stays raw, while delivery follows its actual curve.
      const sparsePoints=polygon.points.filter((_,i)=>i%50===0)
      const sparseDoc={...doc,layers:[{...polygon,points:sparsePoints}]}
      const sparseSpec=normalizeMapSpec({...spec,routes:[],regions:[{...spec.regions[0],origin:'manual',points:spec.regions[0].points.filter((_,i)=>i%50===0)}]})
      const sparseOptions={[polygon.id]:{smooth:.1}}
      const sparseRender=await renderMapLayerDoc(sparseDoc,sparseOptions)
      await mutateTask(task.task_id,{action:'fixture_sparse',actor:'system',mutate:ctx=>{
        ctx.mapSpec=sparseSpec;ctx.state.outputs.layer_doc=sparseDoc;ctx.state.outputs.layer_options=sparseOptions
        ctx.state.outputs.final_image={path:sparseRender.path,width:1000,height:600,source:'map-drawing-manual',run_id:runId,provenance:{registration}}
      }})
      const smoothDelivery=buildDeliverable(await loadTask(task.task_id))
      assert.ok(smoothDelivery.semantics.regions[0].points.length>sparsePoints.length)
      assert.deepEqual(smoothDelivery.editable_source.layer_doc.layers[0].points,sparsePoints)
      assert.deepEqual(smoothDelivery.editable_source.layer_options,sparseOptions)
      const revision=(await loadTask(task.task_id)).state.revision
      const optionsRequest=()=>mapStudioRoutes.request('/tasks/'+task.task_id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:revision,layer_options:{[polygon.id]:{smooth:.15}}})})
      const optionsSaved=await optionsRequest()
      assert.equal(optionsSaved.status,200,JSON.stringify(await optionsSaved.clone().json()))
      const optionsDetail=(await optionsSaved.json()).data
      assert.equal(optionsDetail.outputs.layer_options[polygon.id].smooth,.15)
      assert.deepEqual(optionsDetail.outputs.layer_doc.layers[0].points,sparsePoints)
      assert.equal((await optionsRequest()).status,409,'smoothing PUT honors CAS')
      console.log('DENSE_DRAFT_OK')
    }finally{await model.close()}
  `), /DENSE_DRAFT_OK/)
})
