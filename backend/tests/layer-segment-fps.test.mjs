import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const backend = fileURLToPath(new URL('..', import.meta.url))

// Only local CPU media fixtures: no provider configuration, model submissions, or production data.
test('stored layer FPS survives first raw video, cache, process restart and native mixed-FPS composition', { timeout: 180000 }, () => {
  const evidence = process.env.ISSUE_69_EVIDENCE_DIR
  if (evidence) mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(path.join(evidence || tmpdir(), evidence ? 'fixture-' : 'layer-fps-'))
  const env = { ...process.env, NODE_ENV: 'production', HUOBAO_DATA_DIR: root, STORAGE_PATH: path.join(root, 'static'), SQLITE_PATH: path.join(root, 'db.sqlite3') }
  const run = script => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: backend, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 150000 })
    if (evidence) writeFileSync(path.join(evidence, 'native-http.log'), out, { flag: 'a' })
    return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
  }
  const shared = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import { eq } from 'drizzle-orm'
import { db, schema } from './src/db/index.ts'
import { resolveEpisodeSegmentSpec, invalidateSegmentSpec, getLayerSegment, saveLayerSegment, layerSegmentSignatureOf, layerSegmentIsFresh } from './src/services/layer-segment.ts'
import { default as layers } from './src/routes/layer-segments.ts'
import { default as storyboards } from './src/routes/storyboards.ts'
import { default as episodes } from './src/routes/episodes.ts'
const root = process.env.HUOBAO_DATA_DIR
const abs = p => path.join(root, p)
const sha = p => createHash('sha256').update(fs.readFileSync(abs(p))).digest('hex')
const app = new Hono().route('/api/v1/layer-segments', layers).route('/api/v1/storyboards', storyboards).route('/api/v1/episodes', episodes)
const api = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.ISSUE_69_PORT || 0) })
if (!api.listening) await once(api, 'listening')
const origin = 'http://127.0.0.1:' + api.address().port
let outsideRequests = 0
const originalFetch = globalThis.fetch
globalThis.fetch = (url, init) => {
 if (new URL(url).origin !== origin) { outsideRequests++; throw new Error('outside request forbidden: ' + url) }
 return originalFetch(url, init)
}
async function request(method, route, body) {
 const response = await fetch(origin + '/api/v1' + route, {method, headers: {'content-type':'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})})
 const payload = await response.json()
 assert.equal(response.status, 200, JSON.stringify(payload))
 return payload.data
}
const segmentUrl = id => '/layer-segments/storyboards/' + id
const stored = () => ({ layers: db.select().from(schema.storyboardLayerSegments).all(), shots: db.select().from(schema.storyboards).all(), tasks: db.select().from(schema.sysTask).all() })
const probe = p => JSON.parse(execFileSync(ffprobe.path, ['-v','error','-show_streams','-show_format','-of','json',abs(p)], {encoding:'utf8'}))
`
  try {
    const result = run(shared + `
fs.mkdirSync(abs('static'), {recursive:true})
await sharp({create:{width:960,height:544,channels:3,background:'#355b7d'}}).png().toFile(abs('static/base.png'))
const ts = new Date().toISOString()
const dramaId = Number(db.insert(schema.dramas).values({title:'FPS local fixture',projectType:'documentary',aspectRatio:'16:9',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const episodeId = Number(db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'FPS fixture',scriptConfirmedAt:ts,assetReviewStatus:'passed',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const ids = []
for (const [index,combo] of ['C','A','A','A'].entries()) {
 ids.push(Number(db.insert(schema.storyboards).values({episodeId,storyboardNumber:index+1,combo,designCardStatus:'confirmed',continuityBoundary:'cut',lastFrameImage:'static/base.png',narrationFit:JSON.stringify({audio_mix_mode:'mix'}),createdAt:ts,updatedAt:ts}).run().lastInsertRowid))
}
// #70：纪录片逐镜制作要求本镜有当前有效配音。配音用静音 wav，保证混音后的信号归属可判定。
const {giveShotsValidVoice} = await import('./tests/fixtures/documentary-voice.mjs')
await giveShotsValidVoice({episodeId,storyboardIds:ids,confirmSkeleton:false,seconds:1})
for (const id of ids) {
 await request('PUT',segmentUrl(id),{layer_doc:{version:1,base:{path:'static/base.png',width:960,height:544},theme:'clean',layers:[{id:'m',type:'marker',at:[.4,.5],text:'',style:{dot_radius:.03}}]},timeline:{fps:25,fade_ms:0,keyframes:[{t:0,viewport:{x:0,y:0,w:1,h:1},visible:['m']},{t:.8,viewport:{x:.05,y:.05,w:.9,h:.9},visible:['m']}]},duration:1})
 const rendered = await request('POST',segmentUrl(id)+'/render',{})
 assert.equal(rendered.segment.fresh,true)
 assert.equal(rendered.spec.fps,25)
}
const confirmed = await request('POST','/storyboards/'+ids[0]+'/confirm-keyframes',{confirmed:true})
const before = await request('GET',segmentUrl(ids[0]))
const originalLayers = stored().layers
const media = originalLayers.flatMap(r => [r.renderPath,r.junctionPath].filter(Boolean))
const hashes = Object.fromEntries(media.map(p => [p,sha(p)]))
const signature = before.segment.render_signature
// Genuine 24fps source with a real audio stream, produced after every layer/guide exists.
execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=c=red:s=960x544:r=24:d=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',abs('static/raw24.mp4')])
assert.equal(probe('static/raw24.mp4').streams.find(s=>s.codec_type==='video').r_frame_rate,'24/1')
// Install a completed local source fact through native content HTTP, never submit a model.
await request('PUT','/storyboards/'+ids[0],{video_url:'static/raw24.mp4'})
const taskId = Number(db.insert(schema.sysTask).values({type:'video',storyboardId:ids[0],episodeId,dramaId,provider:'local-fixture',status:'completed',localPath:'static/raw24.mp4',params:JSON.stringify({junction_hash:before.junction.hash,junction_slot:'first',firstFrameUrl:before.junction.path}),createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const afterArrival = stored()
const rawHash = sha('static/raw24.mp4')
const after = await request('GET',segmentUrl(ids[0]))
assert.equal(after.spec.fps,25)
assert.equal(after.spec.source,'video','dimensions still follow the unchanged video policy')
assert.equal(after.segment.render_signature,signature)
assert.equal(after.segment.fresh,true)
const detail = (await request('GET','/episodes/'+episodeId+'/storyboards')).find(s=>s.id===ids[0])
assert.equal(detail.keyframes.confirmed,true)
assert.equal(detail.keyframes.locked.stale,false)
assert.equal(detail.keyframes.first_image,before.junction.path)
const preview = await request('POST','/episodes/'+episodeId+'/compose-batch/preview',{})
assert.deepEqual(preview.items.map(i=>i.selectable),[true,true,true,true],JSON.stringify(preview))
assert.deepEqual(stored(),afterArrival,'GET and preview never rewrite approvals, task snapshots, or layer rows')
assert.deepEqual(stored().layers,originalLayers)
assert.deepEqual(Object.fromEntries(media.map(p=>[p,sha(p)])),hashes)
assert.equal(sha('static/raw24.mp4'),rawHash)
invalidateSegmentSpec(episodeId)
assert.equal((await resolveEpisodeSegmentSpec(episodeId)).fps,25)
// A historical bug could derive stale from the 24fps source without changing any bytes.
assert.equal(layerSegmentIsFresh(await getLayerSegment(ids[0]),{...after.spec,fps:24},'C'),false)
const composed = await request('POST','/storyboards/'+ids[0]+'/compose',{})
const output = composed.composedVideoUrl
execFileSync(ffmpeg,['-v','error','-i',abs(output),'-map','0:v:0','-map','0:a:0','-f','null','-'])
const facts = probe(output)
const video = facts.streams.find(s=>s.codec_type==='video'), audio = facts.streams.find(s=>s.codec_type==='audio')
assert.equal(video.r_frame_rate,'25/1')
assert.equal(video.avg_frame_rate,'25/1')
assert.equal(audio.sample_rate,'48000')
assert.equal(audio.channels,2)
// 成片总长由图层段 + 画面 + 旁白适配共同决定（#70 之后本镜带旁白），这里不钉死秒数：
// 要的是「音画等长、且长于单独的图层段」这两条原生合成不变量。
assert.ok(Math.abs(Number(video.duration)-Number(audio.duration))<.085,JSON.stringify(facts))
assert.ok(Number(video.duration)>1,JSON.stringify(facts))
const pcm = execFileSync(ffmpeg,['-v','error','-i',abs(output),'-map','0:a:0','-f','f32le','-ac','1','-ar','48000','pipe:1'])
let firstEnergy=0,lastEnergy=0;for(let i=0;i<pcm.length;i+=4){const x=pcm.readFloatLE(i);if(i<48000*4*.8)firstEnergy+=x*x;if(i>48000*4*1.2)lastEnergy+=x*x}
assert.ok(lastEnergy>1 && lastEnergy>firstEnergy*5,'raw sine audio survives after the silent layer segment')
assert.deepEqual(stored().layers,originalLayers)
assert.deepEqual(Object.fromEntries(media.map(p=>[p,sha(p)])),hashes)
assert.equal(sha('static/raw24.mp4'),rawHash)
const cleanSegment = await getLayerSegment(ids[0])
const staleChecks = {}
for(const [name,change] of [
 ['content',{layer_doc:{...cleanSegment.layer_doc,layers:[]}}],
 ['viewport',{timeline:{...cleanSegment.timeline,keyframes:cleanSegment.timeline.keyframes.map((f,i)=>i?f:{...f,viewport:{x:.1,y:.1,w:.8,h:.8}})}}],
 ['timeline',{timeline:{...cleanSegment.timeline,fade_ms:100}}],
 ['duration',{duration:2}],
]) {
 await request('PUT',segmentUrl(ids[0]),change)
 staleChecks[name] = !(await request('GET',segmentUrl(ids[0]))).segment.fresh
 await request('PUT',segmentUrl(ids[0]),{layer_doc:cleanSegment.layer_doc,timeline:cleanSegment.timeline,duration:cleanSegment.duration})
}
const baseBytes = fs.readFileSync(abs('static/base.png'))
await sharp({create:{width:960,height:544,channels:3,background:'#12ab87'}}).png().toFile(abs('static/base.png'))
staleChecks.assetBytes = !(await request('GET',segmentUrl(ids[0]))).segment.fresh
fs.writeFileSync(abs('static/base.png'),baseBytes)
// No-video aspect change is still a real target-dimension change, not masked by pinned FPS.
await request('PUT','/storyboards/'+ids[0],{video_url:null})
db.update(schema.dramas).set({aspectRatio:'9:16'}).where(eq(schema.dramas.id,dramaId)).run()
invalidateSegmentSpec(episodeId)
staleChecks.aspect = !(await request('GET',segmentUrl(ids[0]))).segment.fresh
db.update(schema.dramas).set({aspectRatio:'16:9'}).where(eq(schema.dramas.id,dramaId)).run()
await request('PUT','/storyboards/'+ids[0],{video_url:'static/raw24.mp4'})
invalidateSegmentSpec(episodeId)
assert.ok(Object.values(staleChecks).every(Boolean),JSON.stringify(staleChecks))
// No-combo historical signatures are byte-identical to the existing v1 field contract.
const legacySegment = await getLayerSegment(ids[1])
const {source_width,source_height,ref,...legacyBase} = legacySegment.layer_doc.base
const legacyFields = ['seg-v1',JSON.stringify({...legacySegment.layer_doc,base:legacyBase}),JSON.stringify(legacySegment.timeline),legacySegment.duration.toFixed(3),legacySegment.end_hold.toFixed(3),'960x544@25','static/base.png@'+sha('static/base.png')]
assert.equal(layerSegmentSignatureOf(legacySegment,after.spec),createHash('sha256').update(legacyFields.join('\\u0000'),'utf8').digest('hex'))
assert.equal(outsideRequests,0)
const report = {episodeId,dramaId,ids,taskId,before,after,detailKeyframes:detail.keyframes,preview,originalLayers,hashes,rawHash,signature,output,outputFacts:facts,staleChecks,outsideRequests}
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2))
console.log('@@'+JSON.stringify({episodeId,ids,signature,hashes,rawHash,output,staleChecks,outsideRequests}))
api.close();process.exit(0)
`)
    assert.equal(result.outsideRequests, 0)
    const restarted = run(shared + `
const report = JSON.parse(fs.readFileSync(path.join(root,'report.json'),'utf8'))
const snapshot = stored()
for(const id of report.ids){const payload=await request('GET',segmentUrl(id));assert.equal(payload.spec.fps,25);assert.equal(payload.segment.fresh,true)}
const detail = (await request('GET','/episodes/'+report.episodeId+'/storyboards')).find(s=>s.id===report.ids[0])
assert.equal(detail.keyframes.confirmed,true)
assert.equal(detail.keyframes.locked.stale,false)
assert.deepEqual(stored(),snapshot)
assert.deepEqual(Object.fromEntries(Object.keys(report.hashes).map(p=>[p,sha(p)])),report.hashes)
assert.equal(sha('static/raw24.mp4'),report.rawHash)
const ts = new Date().toISOString()
const fallbackEpisode = Number(db.insert(schema.episodes).values({dramaId:report.dramaId,episodeNumber:2,title:'selection boundaries',createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
assert.deepEqual(await resolveEpisodeSegmentSpec(fallbackEpisode),{width:960,height:544,fps:25,source:'default'})
const shot = (number,combo='A',deletedAt=null) => Number(db.insert(schema.storyboards).values({episodeId:fallbackEpisode,storyboardNumber:number,combo,deletedAt,createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
const first=shot(2),second=shot(2),earlier=shot(1),inactive=shot(0,'B'),deleted=shot(0,'A',ts)
await request('PUT','/storyboards/'+first,{video_url:'static/raw24.mp4'})
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,24,'no layer retains video fallback and cache')
execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=c=blue:s=960x544:r=30:d=1','-c:v','libx264','-pix_fmt','yuv420p',abs('static/raw30.mp4')])
await request('PUT','/storyboards/'+first,{video_url:'static/raw30.mp4'})
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,30,'native replacement invalidates cached source without a manual clear')
await request('PUT','/storyboards/'+first,{video_url:null})
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,25,'removing the last raw restores the unchanged default fallback')
await request('PUT','/storyboards/'+first,{video_url:'static/raw24.mp4'})
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,24)
const plan = (id,raw) => db.insert(schema.storyboardLayerSegments).values({storyboardId:id,layerDoc:JSON.stringify(report.before.segment.layer_doc),timeline:raw,duration:1,status:'failed',staleReasons:'["base_version_changed"]',renderPath:'static/missing.mp4',createdAt:ts,updatedAt:ts}).run()
plan(second,JSON.stringify({...report.before.segment.timeline,fps:24}))
plan(first,JSON.stringify({...report.before.segment.timeline,fps:29.97}))
plan(earlier,'{"keyframes":[]}')
plan(inactive,'{"fps":10}')
plan(deleted,'{"fps":12}')
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,29.97,'cached raw video cannot override the first active stored plan, regardless of freshness or render existence')
assert.equal((await getLayerSegment(first)).timeline.fps,29.97)
const newShot=shot(3)
const saved = await saveLayerSegment(newShot,{layer_doc:report.before.segment.layer_doc,duration:1})
assert.equal(saved.timeline.fps,29.97,'new plans inherit the exact fractional target')
assert.equal((await getLayerSegment(newShot)).timeline.fps,29.97)
// Render a fractional plan for real, then only GET/reparse it: exact FPS, signature and bytes survive.
db.update(schema.storyboards).set({designCardStatus:'confirmed'}).where(eq(schema.storyboards.id,newShot)).run()
await (await import('./tests/fixtures/documentary-voice.mjs')).giveShotsValidVoice({episodeId:fallbackEpisode,storyboardIds:[newShot],confirmSkeleton:false,seconds:1})
const fractional = await request('POST',segmentUrl(newShot)+'/render',{})
assert.equal(fractional.segment.timeline.fps,29.97)
assert.equal(fractional.segment.fresh,true)
const fractionalVideo = probe(fractional.segment.render_path).streams.find(s=>s.codec_type==='video')
const [fpsN,fpsD] = fractionalVideo.r_frame_rate.split('/').map(Number)
assert.ok(Math.abs(fpsN/fpsD-29.97)<.0001,JSON.stringify(fractionalVideo))
execFileSync(ffmpeg,['-v','error','-i',abs(fractional.segment.render_path),'-f','null','-'])
const fractionalRows = stored().layers
const fractionalHash = sha(fractional.segment.render_path)
invalidateSegmentSpec(fallbackEpisode)
const fractionalRead = await request('GET',segmentUrl(newShot))
assert.equal(fractionalRead.segment.fresh,true)
assert.equal(fractionalRead.segment.render_signature,fractional.segment.render_signature)
assert.equal(sha(fractional.segment.render_path),fractionalHash)
assert.deepEqual(stored().layers,fractionalRows)
for(const raw of ['null','{"fps":null}','{"fps":0}','{"fps":-1}','{"fps":0.5}','{"fps":120}','{"fps":"25"}','{"fps":1e999}','not-json']){
 db.update(schema.storyboardLayerSegments).set({timeline:raw}).where(eq(schema.storyboardLayerSegments.storyboardId,earlier)).run()
 assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,29.97,raw)
}
db.update(schema.storyboardLayerSegments).set({timeline:'{"fps":24}'}).where(eq(schema.storyboardLayerSegments.storyboardId,earlier)).run()
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,24,'earlier storyboard beats lower row id')
invalidateSegmentSpec(fallbackEpisode)
assert.equal((await resolveEpisodeSegmentSpec(fallbackEpisode)).fps,24)
const another=shot(4)
assert.equal((await saveLayerSegment(another,{layer_doc:report.before.segment.layer_doc,duration:1})).timeline.fps,24)
db.update(schema.storyboards).set({designCardStatus:'confirmed'}).where(eq(schema.storyboards.id,another)).run()
await (await import('./tests/fixtures/documentary-voice.mjs')).giveShotsValidVoice({episodeId:fallbackEpisode,storyboardIds:[another],confirmSkeleton:false,seconds:1})
const old24 = await request('POST',segmentUrl(another)+'/render',{})
assert.equal(old24.segment.fresh,true)
assert.equal(old24.segment.timeline.fps,24)
invalidateSegmentSpec(fallbackEpisode)
assert.equal((await request('GET',segmentUrl(another))).segment.render_signature,old24.segment.render_signature)
assert.equal((await request('GET',segmentUrl(another))).segment.fresh,true)
assert.equal(outsideRequests,0)
console.log('@@'+JSON.stringify({restartFresh:true,confirmed:true,retainedFps:[24,29.97],fractionalOutputFps:fpsN/fpsD,invalidPlansSkipped:true,noLayerFallback:true,sourceReplacementInvalidatesCache:true,firstPlanBeatsCache:true,outsideRequests}))
api.close();process.exit(0)
`)
    assert.equal(restarted.restartFresh, true)
    if (evidence) {
      writeFileSync(path.join(evidence, 'restart-and-selection.json'), JSON.stringify({ ...restarted, fixtureRoot: root }, null, 2))
      copyFileSync(path.join(root, 'report.json'), path.join(evidence, 'native-report.json'))
    }
  } finally {
    if (!evidence) rmSync(root, { recursive: true, force: true })
  }
})
