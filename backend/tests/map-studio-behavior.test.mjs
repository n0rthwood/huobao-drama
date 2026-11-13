import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const backend = fileURLToPath(new URL('..', import.meta.url))

test('Map Studio host delivery/import, fresh brief reads, scoped observations, settings masking and standalone downloads', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-behavior-'))
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import sharp from 'sharp'
    import { db, schema, sqlite, getInsertId, initDb } from './src/db/index.ts'
    import { eq } from 'drizzle-orm'
    import { initMapStudio, registerMapStudioHost, openHostTask, mapStudioRoutes } from './src/modules/map-studio/index.ts'
    import { loadTask, mutateTask, briefHash, MapStudioStaleError } from './src/modules/map-studio/store.ts'
    import { createStandaloneTask } from './src/modules/map-studio/tasks.ts'
    import { huobaoMapStudioHost } from './src/services/map-studio-host.ts'
    import { importAsset } from './src/services/asset-library.ts'
    import { normalizeMapSpec } from './src/modules/map-studio/geo/base-render.ts'
    import { emptyBrief } from './src/modules/map-studio/types.ts'
    import { runObservedWork, observeTextCall, listObservedWork, listObservedCalls, listObservedMessages, getObservedCall, countObservedMessages } from './src/services/task-observability.ts'
    const platform = { async submitImage() { throw Error('No image generation permitted') }, async pollImage() { return { status:'missing',path:null,error:'missing' } }, async legacyResearchKeys() { return { europeana:'legacy-long-key-1234', smithsonian:'tiny' } } }
    await initMapStudio(platform)
    const json = async (route, method = 'GET', payload) => {
      const response = await mapStudioRoutes.request(route, { method, ...(payload === undefined ? {} : { headers:{'content-type':'application/json'},body:JSON.stringify(payload) }) })
      const body = await response.json()
      return { status:response.status,body }
    }
    let settings = (await json('/settings')).body.data
    assert.deepEqual(settings.research_keys.map(k => [k.id,k.configured,k.last4]), [['europeana',true,'1234'],['smithsonian',true,null]])
    assert.ok(!JSON.stringify(settings).includes('legacy-long-key'))
    await json('/settings','PUT',{research_keys:{europeana:null,smithsonian:'abcdefghijkl5678'}})
    await initMapStudio(platform)
    settings = (await json('/settings')).body.data
    assert.equal(settings.research_keys[0].configured,false,'cleared key must not be seeded again')
    assert.equal(settings.research_keys[1].last4,'5678')
    assert.ok(!JSON.stringify(settings).includes('abcdefghijkl'))
    const stamp = new Date().toISOString()
    const textId = getInsertId(await db.insert(schema.aiServiceConfigs).values({ serviceType:'text',provider:'openai',name:'Choices',model:'["first","second"]',baseUrl:'https://never-contact.invalid',apiKey:'never-return-key',vision:true,isActive:true,createdAt:stamp,updatedAt:stamp }))
    const options = (await json('/model-options')).body.data
    assert.deepEqual(options.text.find(c=>c.config_id===textId),{config_id:textId,name:'Choices',models:['first','second'],vision:true})
    assert.ok(!JSON.stringify(options).includes('never-return-key'))
    assert.ok(!JSON.stringify(options).includes('never-contact'))

    let currentBrief = {...emptyBrief(),subject:'Host map',era:'First era'}
    let reads = 0
    registerMapStudioHost({ id:'test-host',async describe(){return {title:'Host map',subtitle:null,return_path:'/host'}},async readBrief(){reads++;return structuredClone(currentBrief)},async writeBrief(ref,brief){currentBrief=structuredClone(brief)},async deliver(){throw Error('Not used')} })
    const opened = await openHostTask({host:'test-host',ref:'target:1'})
    assert.equal((await openHostTask({host:'test-host',ref:'target:1',existingTaskId:opened.task_id})).task_id,opened.task_id)
    const before = await loadTask(opened.task_id)
    const priorHash = briefHash(before.brief)
    currentBrief.era = 'Externally changed era'
    const fresh = await loadTask(opened.task_id)
    assert.equal(fresh.brief.era,currentBrief.era)
    assert.equal(fresh.state.stage,'brief')
    assert.ok(fresh.state.history.some(entry=>entry.action==='brief_changed_externally'))
    assert.ok(reads>=3,'every read must consult host')
    await assert.rejects(mutateTask(opened.task_id,{expectedBriefHash:priorHash,action:'late_result',actor:'auto',mutate(){throw Error('must not apply stale result')}}),MapStudioStaleError)
    const changed = await mutateTask(opened.task_id,{expectedRevision:fresh.state.revision,action:'edit_brief',actor:'manual',mutate(ctx){ctx.brief.notes='Saved through host'}})
    assert.equal(currentBrief.notes,'Saved through host')
    assert.equal(changed.brief.notes,currentBrief.notes)

    await runObservedWork({taskId:777,scope:'map_studio',stage:'map_studio',sourceChars:4,sampleKey:'scope-test'},async()=>{
      const observed = observeTextCall({kind:'llm',configId:null,model:'fake'},async()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'persisted answer'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}}))
      const response = await observed('https://no-network.invalid/chat',{method:'POST',body:JSON.stringify({messages:[{role:'system',content:'full system'},{role:'user',content:'full user'}]})})
      await response.text()
    })
    assert.deepEqual(listObservedWork(777),[])
    assert.deepEqual(listObservedCalls(777),[])
    const works = listObservedWork(777,'map_studio')
    assert.equal(works.length,1)
    const calls = listObservedCalls(777,{scope:'map_studio'})
    assert.equal(calls.length,1)
    assert.equal(getObservedCall(calls[0].id),null)
    assert.deepEqual(listObservedMessages(calls[0].id),[])
    assert.equal(countObservedMessages(calls[0].id),0)
    assert.ok(listObservedMessages(calls[0].id,{scope:'map_studio'}).some(m=>m.body.includes('full system')))
    assert.ok(countObservedMessages(calls[0].id,'map_studio')>0)

    const dramaId = getInsertId(await db.insert(schema.dramas).values({title:'Host delivery',createdAt:stamp,updatedAt:stamp}))
    const propId = getInsertId(await db.insert(schema.props).values({dramaId,name:'Delivered map',assetType:'map',mapBrief:JSON.stringify({...emptyBrief(),subject:'Delivered map',era:'Ming era'}),createdAt:stamp,updatedAt:stamp}))
    registerMapStudioHost(huobaoMapStudioHost)
    const mapTask = await openHostTask({host:'huobao',ref:'prop:'+propId})
    assert.equal((await openHostTask({host:'huobao',ref:'prop:'+propId})).task_id,mapTask.task_id)
    const media='static/map-tests/image.png'
    fs.mkdirSync(path.join(process.env.HUOBAO_DATA_DIR,'static/map-tests'),{recursive:true})
    await sharp({create:{width:32,height:18,channels:3,background:'#eeeecc'}}).png().toFile(path.join(process.env.HUOBAO_DATA_DIR,media))
    const deliverable={task_id:mapTask.task_id,final_image:{path:media,width:32,height:18,sha256:'same-sha'},base_image:{path:media,width:32,height:18,mode:'program',provenance:{renderer:'test'}},texture_image:null,
      semantics:{width:32,height:18,points:[{id:'p1',name:'A',at:[10,10]}],lines:[],regions:[],labels:[]},features:[],sources:[],kmz:null,editable_source:{version:1,map_spec:{},layer_doc:{}},manual_edit:false,summary:'1 point'}
    const result = await huobaoMapStudioHost.deliver('prop:'+propId,deliverable)
    const repeated = await huobaoMapStudioHost.deliver('prop:'+propId,deliverable)
    assert.deepEqual(repeated.version_ids,result.version_ids)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sys_task WHERE prop_id=?').get(propId).n,2)
    const prop = db.select().from(schema.props).where(eq(schema.props.id,propId)).get()
    assert.equal(prop.faithfulSource,result.version_ids[0])
    assert.equal(prop.imageUrl,media)
    assert.equal(JSON.parse(prop.semantics).image.source_task_id,result.version_ids[1])
    await db.update(schema.props).set({mapStudioTaskId:mapTask.task_id,mapSpec:'{"legacy":true}',mapWorkflow:'{"brief":{"subject":"Legacy"}}'}).where(eq(schema.props.id,propId))
    const targetId = getInsertId(await db.insert(schema.dramas).values({title:'Imported target',createdAt:stamp,updatedAt:stamp}))
    const imported = await importAsset({targetDramaId:targetId,kind:'prop',sourceId:propId})
    const clone = db.select().from(schema.props).where(eq(schema.props.id,imported.id)).get()
    assert.equal(clone.mapBrief,prop.mapBrief)
    assert.equal(clone.mapStudioTaskId,null)
    assert.equal(clone.mapWorkflow,null)
    assert.equal(clone.mapSpec,null)
    const versions = sqlite.prepare('SELECT id,local_path FROM sys_task WHERE prop_id=? ORDER BY id').all(imported.id)
    assert.equal(versions.length,2)
    assert.ok(versions.every(v=>fs.existsSync(path.join(process.env.HUOBAO_DATA_DIR,v.local_path))))
    assert.ok(!versions.some(v=>result.version_ids.includes(v.id)))
    assert.equal(JSON.parse(clone.semantics).points[0].name,'A')
    assert.ok(versions.some(v=>v.id===JSON.parse(clone.semantics).image.source_task_id))
    assert.ok(versions.some(v=>v.id===clone.faithfulSource))

    // The only allowed old-workflow read: an idempotent one-time brief copy.
    const legacy='{"brief":{"subject":"Only brief","era":"old"},"stage":"drawing"}'
    const legacyId=getInsertId(await db.insert(schema.props).values({dramaId,name:'Legacy',assetType:'map',mapWorkflow:legacy,createdAt:stamp,updatedAt:stamp}))
    initDb()
    let migrated=db.select().from(schema.props).where(eq(schema.props.id,legacyId)).get()
    assert.equal(JSON.parse(migrated.mapBrief).subject,'Only brief')
    assert.equal(migrated.mapWorkflow,legacy)
    await db.update(schema.props).set({mapBrief:'{"subject":"Human edited"}'}).where(eq(schema.props.id,legacyId))
    initDb()
    migrated=db.select().from(schema.props).where(eq(schema.props.id,legacyId)).get()
    assert.equal(JSON.parse(migrated.mapBrief).subject,'Human edited')

    const standalone=await createStandaloneTask({title:'Standalone'})
    const { selectTask, updateTask } = await import('./src/modules/map-studio/db.ts')
    const beforeCas = selectTask(standalone.task_id)
    sqlite.prepare("UPDATE map_studio_task SET map_spec = '' WHERE id = ?").run(standalone.task_id)
    assert.equal(updateTask(standalone.task_id, {
      expectedState: beforeCas.state, expectedMapSpec: null, expectedBrief: beforeCas.brief,
      state: beforeCas.state, mapSpec: null, brief: beforeCas.brief, updatedAt: stamp,
    }), 0, 'CAS must distinguish SQL NULL from empty text instead of coalescing distinct originals')
    assert.equal(selectTask(standalone.task_id).map_spec, '')
    const spec=normalizeMapSpec({bbox:[110,30,120,40],places:[{id:'p1',name:'A',lon:115,lat:35}]})
    await mutateTask(standalone.task_id,{action:'fixture',actor:'system',mutate(ctx){
      ctx.mapSpec=spec
      const image={path:media,width:32,height:18,source:'fixture',run_id:null,provenance:null}
      ctx.state.outputs={base_image:image,texture_image:null,final_image:image,kmz:null,layer_doc:{version:1,base:{path:media,width:32,height:18},theme:'archival',layers:[]}}
      ctx.state.status='completed';ctx.state.stage='complete'
    }})
    const download=await mapStudioRoutes.request('/tasks/'+standalone.task_id+'/download/source')
    assert.equal(download.status,200)
    assert.ok(download.headers.get('content-disposition').includes('attachment'))
    assert.deepEqual((await download.json()).map_spec,spec)
    assert.equal((await json('/tasks/'+standalone.task_id+'/deliver','POST')).body.error,'standalone_task')
    console.log('MAP_STUDIO_BEHAVIOR_OK')
  `
  try {
    const output=execFileSync('node',['--import','tsx','--input-type=module','--eval',script],{cwd:backend,encoding:'utf8',timeout:120000,env:{...process.env,SQLITE_PATH:path.join(dir,'test.sqlite3'),HUOBAO_DATA_DIR:dir,STORAGE_PATH:path.join(dir,'static')}})
    assert.match(output,/MAP_STUDIO_BEHAVIOR_OK/)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
