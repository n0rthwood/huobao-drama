import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

// Exercise the real Hono route, builder and persistence in an isolated database.
// No generation worker starts: requests persist through the real createTask boundary.
function run(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'task-video-security-'))
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `${seed}\n${body}`], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { ...process.env, SQLITE_PATH: path.join(dir, 'test.sqlite3'), STORAGE_PATH: path.join(dir, 'static'), HUOBAO_DATA_DIR: dir },
    })
    return JSON.parse(output.slice(output.lastIndexOf('@@') + 2).split('\n')[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const seed = `
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { db, schema } from './src/db/index.ts'
import app from './src/routes/tasks.ts'
import { buildStoryboardVideoRequest } from './src/services/storyboard-video.ts'
import { saveLayerSegment, markSegmentRendered, layerSegmentSignatureOf, resolveEpisodeSegmentSpec } from './src/services/layer-segment.ts'
import { GateBlockedError } from './src/services/workflow-gates.ts'
app.onError((error, c) => {
  if (error instanceof GateBlockedError) return c.json({ code:400, error:'gate_blocked', gate:error.gate, reason:error.reason, message:error.reason }, 400)
  throw error
})
const ts = new Date().toISOString()
const configId = Number(db.insert(schema.aiServiceConfigs).values({ serviceType:'video', provider:'comfyui', name:'offline fixture', baseUrl:'http://invalid.test', apiKey:'', model:JSON.stringify(['MiniMax-H3-test']), isActive:true, createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const alternateConfigId = Number(db.insert(schema.aiServiceConfigs).values({ serviceType:'video', provider:'comfyui', name:'explicit offline fixture', baseUrl:'http://invalid.test', apiKey:'', model:JSON.stringify(['MiniMax-H3-alternate']), isActive:true, createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const dramaId = Number(db.insert(schema.dramas).values({ title:'documentary', projectType:'documentary', aspectRatio:'16:9', createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const dramaOnlyId = Number(db.insert(schema.dramas).values({ title:'drama', projectType:'drama', aspectRatio:'9:16', createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber:1, title:'E1', videoConfigId:configId, resolution:'480p', createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const dramaEpisodeId = Number(db.insert(schema.episodes).values({ dramaId:dramaOnlyId, episodeNumber:1, title:'drama E1', videoConfigId:configId, resolution:'720p', createdAt:ts, updatedAt:ts }).run().lastInsertRowid)
const png = await sharp({create:{width:32,height:32,channels:3,background:'#456789'}}).png().toBuffer()
for (const folder of ['images','layer-frames','layer-segments']) mkdirSync(path.join(process.env.STORAGE_PATH,folder),{recursive:true})
for (const name of ['first','mid','last']) writeFileSync(path.join(process.env.STORAGE_PATH,'images',name+'.png'),png)
// #70：纪录片逐镜制作要求本镜有当前有效配音；这里只补事实，门禁不放松。
// 带 episodeId 覆盖的是剧情集（没有这条链路），不补。
const {giveShotsValidVoice} = await import('./tests/fixtures/documentary-voice.mjs')
async function shot(number, combo, changes={}) {
  const id = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber:number, combo, designCardStatus:'confirmed', designCard:JSON.stringify({version:2,budget:{layer_s:2,gen_s:4}}), videoPrompt:'server-owned video prompt', firstFrameImage:'static/images/first.png', midFrameImage:'static/images/mid.png', midFramePrompt:'server middle', midFrameTime:2, lastFrameImage:'static/images/last.png', keyframesConfirmed:true, continuityBoundary:'cut', createdAt:ts, updatedAt:ts, ...changes }).run().lastInsertRowid)
  if (!changes.episodeId) await giveShotsValidVoice({episodeId,storyboardIds:[id],confirmSkeleton:false,seconds:2})
  return id
}
async function post(body) {
  const response = await app.request('/', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'video',...body}) })
  return {status:response.status,body:await response.json()}
}
const forged = { prompt:'client video prompt', drama_id:dramaOnlyId, episode_id:dramaEpisodeId, image_url:'/etc/passwd', first_frame_url:'https://untrusted.test/first.png', mid_frame_url:'https://untrusted.test/mid.png', mid_frame_time:99, last_frame_url:'https://untrusted.test/last.png', reference_image_urls:['https://untrusted.test/ref.png'], reference_video_urls:['https://untrusted.test/ref.mp4'], reference_audio_urls:['https://untrusted.test/ref.wav'], duration:99, aspect_ratio:'1:1', resolution:'1080p', generate_audio:false, junction_hash:'f'.repeat(64), junction_slot:'first', seed:123, prompt_extend:false, watermark:true }
`

test('generic video tasks cannot bypass documentary design, enabled-segment or keyframe gates with client guides', () => {
  const result = run(`
    const cases = [
      await shot(1,null),
      await shot(2,'B',{designCardStatus:'pending'}),
      await shot(3,'B',{designCardStatus:'stale'}),
      await shot(4,'A'),
      await shot(5,'B',{keyframesConfirmed:false}),
      await shot(6,'B',{lastFrameImage:'static/images/missing.png'}),
      await shot(7,'C'),
      await shot(8,'D'),
    ]
    const responses=[]
    for(const id of cases) responses.push(await post({...forged,storyboard_id:id}))
    console.log('@@'+JSON.stringify({responses,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.deepEqual(result.responses.map(response => response.status), Array(8).fill(400))
  for (const response of result.responses.slice(0, 3)) assert.match(response.body.message, /设计卡未确认/)
  assert.match(result.responses[3].body.message, /未启用生成段/)
  for (const response of result.responses.slice(4)) assert.match(response.body.message, /关键帧|衔接帧/)
  assert.deepEqual(result.tasks, [])
})

test('documentary B uses canonical saved inputs and ownership, accepting a minimal request and ignoring all client media', () => {
  const result = run(`
    const id=await shot(1,'B')
    const expected=await buildStoryboardVideoRequest(id,{configId:alternateConfigId,model:'MiniMax-H3-explicit'})
    const minimal=await post({storyboard_id:id,config_id:alternateConfigId,model:'MiniMax-H3-explicit'})
    // This client guide combination would fail the manual schema; it is not an input to owned video generation.
    const attacked=await post({...forged,storyboard_id:String(id),config_id:alternateConfigId,model:'MiniMax-H3-explicit',mid_frame_time:undefined,reference_image_urls:[],reference_video_urls:[]})
    console.log('@@'+JSON.stringify({minimal,attacked,expected,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.equal(result.minimal.status, 201)
  assert.equal(result.attacked.status, 201)
  const [minimal, attacked] = result.tasks
  assert.equal(minimal.prompt, result.expected.params.prompt)
  assert.equal(attacked.prompt, minimal.prompt)
  assert.equal(attacked.dramaId, result.expected.dramaId)
  assert.equal(attacked.episodeId, result.expected.episodeId)
  assert.equal(attacked.storyboardId, result.expected.storyboardId)
  assert.equal(attacked.model, 'MiniMax-H3-explicit')
  const params = JSON.parse(attacked.params)
  assert.deepEqual(params, JSON.parse(minimal.params))
  for (const key of ['firstFrameUrl','midFrameUrl','midFrameTime','lastFrameUrl','referenceImageUrls','duration','aspectRatio','resolution']) {
    assert.deepEqual(params[key], result.expected.params[key], key)
  }
  assert.equal(params.generateAudio, 1)
  for (const key of ['imageUrl','referenceVideoUrls','referenceAudioUrls','junction_hash','junction_slot','seed','promptExtend','watermark']) {
    assert.equal(params[key], undefined, key)
  }
})

test('documentary C/D persist server junction guides and reject stale or missing saved junctions', () => {
  const result = run(`
    const responses=[]
    const expected=[]
    const stale=[]
    for (const [number,combo] of [[1,'C'],[2,'D']]) {
      const id=await shot(number,combo)
      const segment=await saveLayerSegment(id,{layer_doc:{version:1,theme:'archival',base:{path:'static/images/first.png',width:1,height:1},layers:[]},timeline:{fps:25,keyframes:[{t:0,viewport:{x:0,y:0,w:1,h:1},visible:[]}]},duration:2})
      const spec=await resolveEpisodeSegmentSpec(episodeId)
      const hash=createHash('sha256').update(png).digest('hex')
      const junctionPath='static/layer-frames/'+segment.id+'-'+hash+'.png'
      writeFileSync(path.join(process.env.HUOBAO_DATA_DIR,junctionPath),png)
      const renderPath='static/layer-segments/'+segment.id+'.mp4'
      execFileSync(ffmpeg,['-v','error','-y','-loop','1','-i',path.join(process.env.STORAGE_PATH,'images','first.png'),'-vf','scale=32:32','-t','0.2','-r','25','-c:v','libx264','-pix_fmt','yuv420p',path.join(process.env.HUOBAO_DATA_DIR,renderPath)])
      await markSegmentRendered(segment.id,{render_path:renderPath,render_signature:layerSegmentSignatureOf(segment,spec,combo),status:'ready',junction_path:junctionPath,junction_hash:hash})
      await db.update(schema.storyboards).set({keyframesConfirmed:true,keyframesJunctionHash:hash}).where(eq(schema.storyboards.id,id))
      expected.push({id,combo,hash,junctionPath})
      responses.push(await post({...forged,storyboard_id:id,junction_slot:combo==='C'?'last':'first'}))
      if(combo==='C') await db.update(schema.storyboardLayerSegments).set({staleReasons:JSON.stringify(['base_version_changed'])}).where(eq(schema.storyboardLayerSegments.id,segment.id))
      else unlinkSync(path.join(process.env.HUOBAO_DATA_DIR,junctionPath))
      stale.push(await post({...forged,storyboard_id:id}))
    }
    console.log('@@'+JSON.stringify({responses,expected,stale,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.deepEqual(result.responses.map(response => response.status), [201, 201])
  assert.deepEqual(result.stale.map(response => response.status), [400, 400])
  assert.equal(result.tasks.length, 2)
  for (const expected of result.expected) {
    const params = JSON.parse(result.tasks.find(task => task.storyboardId === expected.id).params)
    const slot = expected.combo === 'C' ? 'first' : 'last'
    assert.equal(params.junction_hash, expected.hash)
    assert.equal(params.junction_slot, slot)
    assert.equal(params[slot === 'first' ? 'firstFrameUrl' : 'lastFrameUrl'], expected.junctionPath)
    assert.equal(params.referenceImageUrls[0], params.firstFrameUrl)
    assert.equal(params.duration, 4)
  }
})

test('manual/unowned and drama-owned videos retain client inputs and the existing validation', () => {
  const result = run(`
    const id=await shot(1,null,{episodeId:dramaEpisodeId,designCardStatus:'pending',keyframesConfirmed:false})
    const manual=await post({...forged,drama_id:dramaId,episode_id:episodeId})
    const drama=await post({...forged,drama_id:dramaOnlyId,episode_id:dramaEpisodeId,storyboard_id:id})
    const invalid=await post({prompt:'manual',mid_frame_url:'static/images/mid.png'})
    console.log('@@'+JSON.stringify({manual,drama,invalid,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.equal(result.manual.status, 201)
  assert.equal(result.drama.status, 201)
  assert.equal(result.invalid.status, 400)
  assert.match(result.invalid.body.message, /中间关键帧及其时间必须同时提供/)
  assert.equal(result.tasks.length, 2)
  for (const [index, task] of result.tasks.entries()) {
    const params = JSON.parse(task.params)
    assert.equal(params.firstFrameUrl, 'https://untrusted.test/first.png')
    assert.equal(params.lastFrameUrl, 'https://untrusted.test/last.png')
    assert.equal(params.midFrameTime, 99)
    assert.equal(params.duration, 99)
    assert.equal(params.aspectRatio, '1:1')
    assert.equal(params.resolution, index === 0 ? '1080p' : '720p')
    assert.deepEqual(params.referenceVideoUrls, ['https://untrusted.test/ref.mp4'])
    assert.deepEqual(params.referenceAudioUrls, ['https://untrusted.test/ref.wav'])
    assert.equal(params.generateAudio, 0)
    assert.equal(params.junction_hash, undefined)
    assert.equal(params.junction_slot, undefined)
    assert.equal(params.seed, 123)
  }
  assert.equal(result.tasks[0].storyboardId, null)
  assert.ok(result.tasks[1].storyboardId)
})

test('documentary explicit disabled config is rejected rather than silently charging a different active service', () => {
  const result = run(`
    const id=await shot(1,'B')
    await db.update(schema.aiServiceConfigs).set({isActive:false}).where(eq(schema.aiServiceConfigs.id,alternateConfigId))
    const response=await post({storyboard_id:id,config_id:alternateConfigId})
    console.log('@@'+JSON.stringify({response,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.equal(result.response.status,400)
  assert.match(result.response.body.message,/不会自动切换/)
  assert.equal(result.tasks.length,0)
})

test('documentary explicit config stays on its selected local HTTP target; invalid selections reach no remote endpoint across callers', () => {
  const result=run(`
    const {createServer}=await import('node:http')
    const {once}=await import('node:events')
    const calls=[]
    const server=createServer((req,res)=>{calls.push(req.url);res.writeHead(503);res.end('deliberate local transport failure')})
    server.listen(0,'127.0.0.1');await once(server,'listening')
    const url='http://127.0.0.1:'+server.address().port
    await db.update(schema.aiServiceConfigs).set({baseUrl:url+'/default'}).where(eq(schema.aiServiceConfigs.id,configId))
    await db.update(schema.aiServiceConfigs).set({baseUrl:url+'/selected'}).where(eq(schema.aiServiceConfigs.id,alternateConfigId))
    const id=await shot(1,'B',{videoPrompt:'integrated_multimodal_description: [Shot 1] The camera remains fixed. overall_soundscape: quiet room. non_diegetic_music: N/A'})
    const selected=await post({storyboard_id:id,config_id:alternateConfigId})
    const taskId=selected.body.data.id
    const deadline=Date.now()+5000
    while((await db.select().from(schema.sysTask).where(eq(schema.sysTask.id,taskId)))[0].status!=='failed'){
      if(Date.now()>deadline)throw new Error('Local HTTP failure did not settle')
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    const selectedCalls=[...calls];calls.length=0
    await db.update(schema.aiServiceConfigs).set({isActive:false}).where(eq(schema.aiServiceConfigs.id,alternateConfigId))
    const wrongType=Number(db.insert(schema.aiServiceConfigs).values({serviceType:'image',provider:'comfyui',name:'wrong type',baseUrl:url+'/wrong',apiKey:'',model:'[]',isActive:true,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
    const {default:storyboardApp}=await import('./src/routes/storyboards.ts')
    const {default:episodeApp}=await import('./src/routes/episodes.ts')
    const {generateVideo}=await import('./src/services/generation.ts')
    const responses=[]
    const jsonPost=async(target,route,body)=>{const res=await target.request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()}}
    const retrySaved=await jsonPost(app,'/'+taskId+'/retry',{})
    for(const bad of [999999,alternateConfigId,wrongType]){
      responses.push(await post({storyboard_id:id,config_id:bad}))
      responses.push(await jsonPost(storyboardApp,'/'+id+'/generate-video',{config_id:bad}))
      responses.push(await jsonPost(app,'/'+taskId+'/retry',{config_id:bad}))
      responses.push(await jsonPost(episodeApp,'/'+episodeId+'/video-batch',{config_id:bad,storyboard_ids:[id]}))
      try{await generateVideo({storyboardId:id,prompt:'direct persistence boundary',configId:bad});throw new Error('invalid config accepted')}catch(error){if(!error.message.includes('不会自动切换'))throw error}
    }
    await new Promise(resolve=>server.close(resolve))
    console.log('@@'+JSON.stringify({selected,selectedCalls,retrySaved,responses,rejectedCalls:calls,tasks:db.select().from(schema.sysTask).all()}))
  `)
  assert.equal(result.selected.status,201)
  assert.ok(result.selectedCalls.length>0,JSON.stringify(result))
  assert.ok(result.selectedCalls.every(url=>url.startsWith('/selected/')),JSON.stringify(result.selectedCalls))
  assert.ok(result.responses.every(response=>response.status===400),JSON.stringify(result.responses))
  assert.equal(result.retrySaved.status,400)
  assert.deepEqual(result.rejectedCalls,[])
  assert.equal(result.tasks.length,1)
})
