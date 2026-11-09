import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createRenderer, nextTick } from 'vue'
import ts from 'typescript'
import { deeplinkRuntimeModule } from './sfc-deeplink-runtime.mjs'

const app = new URL('../app/', import.meta.url)
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const vue = import.meta.resolve('vue')
globalThis.useRuntimeConfig = () => ({ public: { basePath: '/huobao/' } })
const urlSource = readFileSync(new URL('utils/url.ts', app), 'utf8')
const { mediaUrl } = await import(dataModule(ts.transpileModule(urlSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText))

test('media conversion is idempotent across thumbnails, fallback and original viewer at prefix boundaries', () => {
  for (const raw of ['static/layer-frames/a.png', '/static/layer-frames/a.png', '/huobao/static/layer-frames/a.png']) {
    const shown = mediaUrl(raw)
    assert.equal(shown, '/huobao/static/layer-frames/a.png')
    assert.equal(mediaUrl(shown), shown)
    assert.equal(mediaUrl(shown.replace('.png', '_thumb.webp')), '/huobao/static/layer-frames/a_thumb.webp')
  }
  for (const raw of ['https://host/huobao/a.png', 'http://host/a.png', '//host/a.png', 'data:image/png;base64,AAAA', 'blob:http://host/id']) assert.equal(mediaUrl(raw), raw)
  assert.equal(mediaUrl('/static/huobao/a.png'), '/huobao/static/huobao/a.png')
  assert.equal(mediaUrl('/huobaobook/a.png'), '/huobao/huobaobook/a.png')
  assert.equal(mediaUrl(''), '')
  globalThis.useRuntimeConfig = () => ({public:{basePath:'/'}})
  assert.equal(mediaUrl('/static/a.png'), '/static/a.png')
  assert.equal(mediaUrl('static/a.png'), '/static/a.png')
})

// Execute the real compiled Vue setup; stub only network/child presentation boundaries.
const pending = []
globalThis.__productionUiApi = {
  layerSegmentAPI: { get: id => new Promise(resolve => pending.push({id,resolve})) },
  episodeAPI: { keyframeBatch: async () => null, keyframePromptsStatus: async () => null },
}
const modules = {
  'vue': vue,
  'vue-i18n': dataModule('export const useI18n=()=>({t:key=>key})'),
  'vue-sonner': dataModule('export const toast={warning(){},success(){},info(){}}'),
  'lucide-vue-next': dataModule('export const Loader2={render:()=>null}'),
  '~/composables/useApi': dataModule('export const {episodeAPI,layerSegmentAPI}=globalThis.__productionUiApi'),
  '~/composables/useToast': dataModule('export const toastError=()=>{},toastServerMessage=()=>{}'),
  '~/composables/useTaskProgress': dataModule('export const isActiveBatchItemState=()=>false'),
  '~/composables/useQuerySync': deeplinkRuntimeModule,
}
const { descriptor } = parse(readFileSync(new URL('components/ShotProductionPanel.vue', app), 'utf8'))
let source = compileScript(descriptor, {id:'production-contract'}).content
source = source.replace(/from (['"])([^'"]+)\1/g, (match, quote, path) => `from '${modules[path] || dataModule('export default {render:()=>null}')}'`)
const Component = (await import(dataModule(source))).default
Component.render = () => null
const renderer = createRenderer({createElement:tag=>({tag,children:[]}),createText:text=>({text}),createComment:text=>({text}),setText(){},setElementText(){},parentNode(){},nextSibling(){},patchProp(){},insert(){},remove(){}})
const settle = async () => { await Promise.resolve(); await nextTick() }

test('row summaries stay independent of selection and late same-ID or other-ID responses cannot overwrite current editor', async () => {
  pending.length=0
  const rows = [186,188].map(id=>({id,combo:'A',design_card_status:'confirmed',layer_segment:{status:'ready',render_path:`static/${id}.mp4`,fresh:true}}))
  const app = renderer.createApp(Component,{episodeId:14,dramaId:8,storyboards:rows})
  const state=app.mount({}).$.setupState
  assert.equal(state.layerStatusOf(rows[0]),'ready')
  assert.equal(state.layerStatusOf({...rows[0],layer_segment:undefined}),'unknown')
  assert.equal(state.layerStatusOf({...rows[0],layer_segment:{status:'draft',exists:false,fresh:false,render_path:null}}),'unknown')
  assert.equal(state.layerStatusOf({...rows[0],layer_segment:{status:'failed',render_path:'static/old.mp4',fresh:true}}),'failed')
  assert.equal(state.layerStatusOf({...rows[0],layer_segment:{status:'ready',render_path:'static/old.mp4',fresh:false}}),'stale')
  state.selectShot(state.shots[1])
  assert.equal(state.state,null)
  state.selectShot(state.shots[0])
  const old186=pending[0], old188=pending[1], current186=pending[2]
  current186.resolve({combo:'A',segment:{storyboard_id:186,revision:'current'}})
  await settle()
  old188.resolve({combo:'A',segment:{storyboard_id:188,revision:'wrong-shot'}})
  old186.resolve({combo:'A',segment:{storyboard_id:186,revision:'old-same-shot'}})
  await settle()
  assert.equal(state.state.segment.revision,'current')
  assert.deepEqual(state.shots.map(row=>row.layerStatus),['ready','ready'])
  state.onLayerChanged(188,{segment:{storyboard_id:188,revision:'late-save'},issues:[]})
  assert.equal(state.state.segment.revision,'current')
  app.unmount()
})

const confirmations = []
globalThis.__productionUiApi.storyboardAPI = {
  keyframeVersions: async () => [],
  confirmKeyframes: async (id, confirmed) => { confirmations.push({id,confirmed}) },
}
modules['~/composables/useApi'] = dataModule('export const {episodeAPI,storyboardAPI}=globalThis.__productionUiApi; export const taskAPI={},imageQueueAPI={}')
modules['~/utils/mediaTime'] = dataModule('export const mediaTimeLabel=()=>null,mediaTimeOfPath=()=>null')
modules['~/composables/useTaskProgress'] = dataModule(`import {ref} from '${vue}'; export const useNowTicker=()=>ref(0),ringPropsFromTask=()=>null,ringPropsFromBatchItem=()=>null,isActiveTaskStatus=()=>false,isActiveBatchItemState=()=>false,formatSeconds=()=>''`)
modules['~/composables/useTasks'] = dataModule('export const useTasks=()=>({latestKeyframeTask:()=>null,registerTask(){},refreshTasks(){},onTaskFinished(){}})')
modules['~/composables/useToast'] = dataModule('export const toastError=()=>{},toastServerMessage=()=>{},mapError=()=>null')
const keyframeDescriptor = parse(readFileSync(new URL('components/StoryboardKeyframes.vue',app),'utf8')).descriptor
let keyframeSource = compileScript(keyframeDescriptor,{id:'keyframe-confirmation-contract'}).content
keyframeSource = keyframeSource.replace(/from (['"])([^'"]+)\1/g, (match,quote,path)=>`from '${modules[path] || dataModule('export default {render:()=>null}')}'`)
const Keyframes = (await import(dataModule(keyframeSource))).default
Keyframes.render=()=>null

test('current confirmation truth updates on refresh and stale recorded approval remains cancellable without becoming ready',async()=>{
  confirmations.length=0
  const shot={id:186,keyframes_confirmed:true,keyframes:{ready:true,confirmed:true}}
  const instance=renderer.createApp(Keyframes,{storyboards:[shot],embedded:true})
  const state=instance.mount({}).$.setupState
  assert.equal(state.kf(shot).confirmed,true)
  assert.equal(state.confirmationSet(shot),true)
  await state.toggleConfirm(shot)
  assert.deepEqual(confirmations.pop(),{id:186,confirmed:false})
  const unconfirmed={...shot,keyframes_confirmed:false,keyframes:{ready:true,confirmed:false}}
  assert.equal(state.confirmationSet(unconfirmed),false)
  await state.toggleConfirm(unconfirmed)
  assert.deepEqual(confirmations.pop(),{id:186,confirmed:true})
  const stale={...shot,keyframes:{ready:false,confirmed:false,stale_reason:'junction_updated'}}
  assert.equal(state.kf(stale).ready,false)
  assert.equal(state.kf(stale).confirmed,false)
  assert.equal(state.confirmationSet(stale),true)
  await state.toggleConfirm(stale)
  assert.deepEqual(confirmations.pop(),{id:186,confirmed:false})
  await state.toggleConfirm({...stale,keyframes_confirmed:false})
  assert.equal(confirmations.length,0)
  instance.unmount()
})
