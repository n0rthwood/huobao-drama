import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('../', import.meta.url))

test('Map Studio adopted styles: settings, validation, HTTP rejection, theme change, defaults, restyle and five real renders', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-styles-'))
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import {createRequire} from 'node:module'
    import {initMapStudio,mapStudioRoutes} from '__BACKEND__src/modules/map-studio/index.ts'
    import {MAP_STYLE_FAMILIES,resolveMapStyle,validateMapStyleFamilies,featureStyleFor,labelStyleFor} from '__BACKEND__src/modules/map-studio/styles/index.ts'
    import {restyleMapLayers} from '__BACKEND__src/modules/map-studio/styles/restyle.ts'
    import {emptyBrief,normalizeBrief} from '__BACKEND__src/modules/map-studio/types.ts'
    import {readDefaultStyle} from '__BACKEND__src/modules/map-studio/settings.ts'
    import {judgeBrief,parseBriefVerdict} from '__BACKEND__src/modules/map-studio/brief.ts'
    import {normalizeMapSpec,buildMapSvg,mapBaseSignature} from '__BACKEND__src/modules/map-studio/geo/base-render.ts'
    import {createMapBaseArtifact,forwardFor} from '__BACKEND__src/modules/map-studio/geo/geometry.ts'
    import {searchDataset,extractDatasetGeometry} from '__BACKEND__src/modules/map-studio/geo/datasets.ts'
    import {createStandaloneTask} from '__BACKEND__src/modules/map-studio/tasks.ts'
    import {loadTask,mutateTask} from '__BACKEND__src/modules/map-studio/store.ts'
    import {insertRun} from '__BACKEND__src/modules/map-studio/db.ts'
    import {db,schema,getInsertId} from '__BACKEND__src/db/index.ts'
    import {resolveStageModel} from '__BACKEND__src/services/ai-stages.ts'
    import {runDrawingStage,renderMapLayerDoc} from '__BACKEND__src/modules/map-studio/drawing.ts'
    import {saveMapWorkflowDraft} from '__BACKEND__src/modules/map-studio/run.ts'
    import {specFeatures} from '__BACKEND__src/modules/map-studio/validate.ts'
    import {startMockOpenAIChat,toolResults} from '__BACKEND__tests/fixtures/mock-openai-chat.mjs'
    const require=createRequire('file://__BACKEND__package.json'), sharp=require('sharp')
    await initMapStudio({async submitImage(){throw Error('No image/model generation permitted')},async pollImage(){throw Error('No image/model generation permitted')}})
    const request=async(route,method='GET',body)=>{
      const response=await mapStudioRoutes.request(route,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})})
      return {status:response.status,data:await response.json()}
    }
    assert.equal(MAP_STYLE_FAMILIES.length,5)
    assert.equal(readDefaultStyle(),'atlas-tint')
    assert.equal(resolveMapStyle(emptyBrief(),{default_style:readDefaultStyle()}).id,'atlas-tint')
    const legacy={...emptyBrief(),style:'ink'};delete legacy.map_style
    assert.equal(resolveMapStyle(legacy,{default_style:'modern-clean'}),null,'legacy remains on old style')
    assert.equal((await request('/settings','PUT',{default_style:'ink-chinese'})).status,200)
    assert.equal(resolveMapStyle(emptyBrief(),{default_style:readDefaultStyle()}).id,'ink-chinese')
    assert.equal(resolveMapStyle({...emptyBrief(),map_style:'modern-clean'},{default_style:readDefaultStyle()}).id,'modern-clean')
    assert.equal((await request('/settings','PUT',{default_style:'invalid',research_keys:{europeana:'must-not-save'}})).status,400)
    assert.equal((await request('/tasks','POST',{title:'invalid theme',brief:{map_style:'invalid'}})).status,400)
    const catalogue=(await request('/styles')).data.data
    assert.equal(catalogue.families.length,5)
    for(const family of catalogue.families){
      const preview=await mapStudioRoutes.request('/styles/'+family.id+'/preview')
      assert.equal(preview.status,200);assert.match(preview.headers.get('content-type'),/image\\/jpeg/)
      assert.ok((await preview.arrayBuffer()).byteLength>1000)
    }
    assert.equal((await mapStudioRoutes.request('/styles/unknown/preview')).status,400)
    const raw=JSON.parse(fs.readFileSync('__BACKEND__src/modules/map-studio/styles/families.json','utf8'))
    assert.equal(validateMapStyleFamilies(raw).length,5)
    for(const mutate of [d=>d.families[0].palette.water='blue',d=>d.families[0].labels.city.font='Arial',d=>d.families[0].lines.coast.width=3]){
      const bad=structuredClone(raw);mutate(bad);assert.throws(()=>validateMapStyleFamilies(bad))
    }
    const verdict={inferred:[{field:'map_style',value:'historical-schematic',basis:'突出迁徙路线与分区',confidence:'high'}],ambiguous:[],missing:[],notes:[]}
    const brief={...emptyBrief(),subject:'迁徙',era:'1600',location:'欧亚',purpose:'迁徙示意图'}
    assert.equal(judgeBrief(brief,parseBriefVerdict(verdict)).brief.map_style,'historical-schematic')
    assert.equal(judgeBrief({...brief,map_style:'modern-clean'},parseBriefVerdict(verdict)).brief.map_style,'modern-clean','never override human choice')
    assert.equal(parseBriefVerdict({...verdict,inferred:[{...verdict.inferred[0],basis:''}]}),null)

    const fixture=normalizeMapSpec({bbox:[10,10,20,20],layers:{land:true,coastline:true,rivers:false,lakes:true,countries:false},
      places:[{id:'city',name:'城',lon:13,lat:14,category:'settlement'}],
      routes:[{id:'river',name:'河',points:[[12,15],[15,15],[18,15]],category:'river',origin:'dataset'},{id:'route',name:'路',points:[[12,12],[14,13]],category:'route',origin:'dataset'}],
      regions:[{id:'region',name:'区',points:[[16,17],[18,17],[18,18],[16,18]],category:'territory',origin:'dataset'}]})
    const model=await startMockOpenAIChat(async body=>{
      if(!toolResults(body,'add_feature_layers').length)return{toolCalls:[{name:'add_feature_layers',args:{items:[{feature_id:'city'},{feature_id:'river'},{feature_id:'route'},{feature_id:'region'}]}}]}
      if(!toolResults(body,'update_layer').length)return{toolCalls:[{name:'update_layer',args:{layer_id:'feature-city',patch:{text:''}}}]}
      if(!toolResults(body,'add_label').length)return{toolCalls:[{name:'add_label',args:{tier:'title',text:'主题地图',box:{x:.3,y:.06,w:.4,h:.1}}}]}
      if(!toolResults(body,'render_draft').length)return{toolCalls:[{name:'render_draft',args:{}}]}
      return{toolCalls:[{name:'submit_draft',args:{}}]}
    })
    try{
      const stamp=new Date().toISOString()
      const configId=getInsertId(await db.insert(schema.aiServiceConfigs).values({serviceType:'text',provider:'openai',name:'Deterministic theme test',baseUrl:model.baseUrl,apiKey:'not-a-credential',model:'["theme-test"]',isActive:true,vision:true,createdAt:stamp,updatedAt:stamp}))
      const stageModel=await resolveStageModel('read_image',{configId})
      const signatures=new Set()
      for(const family of MAP_STYLE_FAMILIES){
        const themedBrief={...brief,map_style:family.id}
        const spec=normalizeMapSpec({...fixture,style:{theme:'ink',map_style:family.id}})
        assert.equal(spec.style.theme,family.theme_mapping)
        const svg=buildMapSvg(spec,{width:1280,height:720})
        assert.ok(svg.includes(family.palette.background));assert.ok(svg.includes(family.palette.land))
        signatures.add(mapBaseSignature(spec,{width:1280,height:720}))
        const base=await createMapBaseArtifact(spec,{mode:'program',width:1280})
        assert.equal(base.provenance.map_style,family.id)
        const task=await createStandaloneTask({title:'Theme '+family.id,brief:themedBrief})
        const runId=insertRun({taskId:task.task_id,mode:'manual',startStage:'drawing',stage:'drawing',textConfigId:configId,imageConfigId:null,imageModel:null,params:{}})
        await mutateTask(task.task_id,{action:'fixture',actor:'system',mutate:ctx=>{ctx.state.run_id=runId;ctx.state.status='running';ctx.state.stage='drawing';ctx.mapSpec=spec}})
        const outcome=await runDrawingStage({taskId:task.task_id,runId,stageModel,brief:themedBrief,spec,background:{path:base.path,width:base.width,height:base.height,registration:base.registration,warnings:[]},startRounds:0,feedback:null})
        assert.equal(outcome.kind,'accepted')
        const doc=outcome.result.doc
        assert.equal(doc.theme,family.theme_mapping)
        assert.equal(doc.layers.find(l=>l.id==='feature-river').style.stroke,family.lines.river_major.stroke)
        assert.ok([family.lines.river_major.width,family.lines.river_minor.width].includes(doc.layers.find(l=>l.id==='feature-river').style.width))
        assert.equal(doc.layers.find(l=>l.id==='feature-route').style.stroke,family.lines.routes.stroke)
        assert.equal(doc.layers.find(l=>l.id==='feature-region').style.fill,family.lines.regions.fill)
        assert.equal(doc.layers.find(l=>l.id==='feature-city').style.dot_radius,family.markers.city.dot_radius)
        assert.deepEqual(doc.layers.find(l=>l.type==='label').style,labelStyleFor(family,'title'))
        const reset=restyleMapLayers(doc,MAP_STYLE_FAMILIES[4],specFeatures(spec))
        for(let i=0;i<doc.layers.length;i++){const {style:a,...before}=doc.layers[i],{style:b,...after}=reset.layers[i];assert.deepEqual(after,before,'reset changes style only')}
        await mutateTask(task.task_id,{action:'fixture_end',actor:'system',mutate:ctx=>{ctx.state.status='idle';ctx.state.stage='complete';for(const step of ctx.state.steps)step.status='completed';ctx.state.outputs.layer_doc=doc;ctx.state.outputs.layer_options=outcome.result.layerOptions;ctx.state.outputs.base_image={path:base.path,width:base.width,height:base.height,source:'map-base:program',run_id:runId,provenance:base.provenance}}})
        const revision=(await loadTask(task.task_id)).state.revision
        const result=await request('/tasks/'+task.task_id+'/layer-doc/restyle','POST',{layer_doc:doc})
        assert.equal(result.status,200)
        assert.equal((await loadTask(task.task_id)).state.revision,revision,'restyle never persists')
        const nextFamily=MAP_STYLE_FAMILIES[(MAP_STYLE_FAMILIES.indexOf(family)+1)%5]
        // Theme-only change after a finished base: research and geometry stay, the flow restarts at base.
        const changed=await saveMapWorkflowDraft(task.task_id,{brief:{map_style:nextFamily.id},expectedRevision:revision})
        assert.equal(changed.stage,'base');assert.equal(changed.brief.map_style,nextFamily.id)
        assert.deepEqual(changed.steps.map(s=>s.status),['completed','completed','pending','pending','pending','pending'])
        assert.ok(changed.issues.some(i=>i.code==='style_changed'))
        assert.deepEqual(changed.map_spec.routes,(await loadTask(task.task_id)).mapSpec.routes,'geometry kept')
        // Any substantive brief change still restarts at brief.
        const substantive=await saveMapWorkflowDraft(task.task_id,{brief:{era:'changed era '+family.id},expectedRevision:changed.revision})
        assert.equal(substantive.stage,'brief')
        assert.notEqual(mapBaseSignature(normalizeMapSpec({...spec,style:{map_style:nextFamily.id}}),{width:1280,height:720}),mapBaseSignature(spec,{width:1280,height:720}))
      }
      assert.equal(signatures.size,5)
    }finally{await model.close()}

    // Optional coordinator samples use actual Natural Earth river/place features, never a model or image API.
    if(process.env.I99_STYLE_SAMPLES){
      const out=process.env.I99_STYLE_SAMPLES;fs.mkdirSync(out,{recursive:true})
      const bbox=[25,44,57,62]
      const riverCandidate=searchDataset('river','Volga',bbox)[0];assert.ok(riverCandidate)
      const river=extractDatasetGeometry(riverCandidate.ref,bbox)
      const cities=['Moscow','Kazan'].map(name=>{const candidate=searchDataset('place',name,bbox)[0];assert.ok(candidate);return {name,geometry:extractDatasetGeometry(candidate.ref)}})
      for(const family of MAP_STYLE_FAMILIES){
        const spec=normalizeMapSpec({bbox,detail_level:'regional',style:{map_style:family.id},places:[],routes:[],regions:[]})
        const base=await createMapBaseArtifact(spec,{mode:'program',width:1920})
        const forward=forwardFor(base.registration),common=(id,type,style,extra)=>({id,type,name:id,visible:true,locked:false,z:1,opacity:1,rotation:0,style,...extra})
        const layers=river.parts.map((part,i)=>common('river-'+i,'polyline',featureStyleFor(family,{kind:'route',category:'river'}),{points:part.map(p=>{const q=forward(p);return[q[0]/base.width,q[1]/base.height]})}))
        for(const city of cities){const p=forward([city.geometry.lon,city.geometry.lat]);layers.push(common(city.name,'marker',featureStyleFor(family,{kind:'place',category:'settlement'}),{at:[p[0]/base.width,p[1]/base.height],text:city.name}))}
        layers.push(common('theme-title-1','label',labelStyleFor(family,'title'),{z:100,box:{x:.1,y:.04,w:.8,h:.1},text:family.name}))
        layers.push(common('theme-note-2','label',labelStyleFor(family,'note'),{z:101,box:{x:.05,y:.9,w:.9,h:.07},text:'Natural Earth · Volga / Moscow / Kazan · style sample, not a historical claim'}))
        const doc={version:1,base:{path:base.path,width:base.width,height:base.height},theme:family.theme_mapping,layers}
        const rendered=await renderMapLayerDoc(doc)
        const destination=path.join(out,family.id+'.png');fs.copyFileSync(path.join(process.env.HUOBAO_DATA_DIR,rendered.path),destination)
        assert.equal((await sharp(destination).metadata()).width,1920)
      }
      fs.writeFileSync(path.join(out,'dataset.json'),JSON.stringify({river:riverCandidate.ref,places:cities.map(c=>({name:c.name,ref:c.geometry.ref})),bbox},null,2))
    }
    console.log('MAP_STYLE_ACCEPTANCE_OK')
  `
  const file=path.join(dir,'probe.mts')
  writeFileSync(file,script.replaceAll('__BACKEND__',backend))
  const env={...process.env,SQLITE_PATH:path.join(dir,'test.sqlite3'),HUOBAO_DATA_DIR:dir}
  delete env.STORAGE_PATH
  try { assert.match(execFileSync(path.join(backend,'node_modules/.bin/tsx'),[file],{cwd:backend,env,encoding:'utf8',timeout:240000}),/MAP_STYLE_ACCEPTANCE_OK/) }
  finally { rmSync(dir,{recursive:true,force:true}) }
})
