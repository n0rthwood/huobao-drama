<template>
  <section class="pk-bar" :aria-label="t('layerCanvas.keyframeBar.title')">
    <aside v-if="teaching" class="pk-teach"><Info :size="16" />{{ t('layerCanvas.keyframeBar.teach') }}<button class="btn btn-sm" @click="dismissTeaching"><X :size="14" /></button></aside>
    <header class="pk-controls">
      <strong>{{ t('layerCanvas.keyframeBar.title') }}</strong>
      <button class="btn btn-sm" :title="t('layerCanvas.keyframeBar.add')" :disabled="timeline.keyframes.length >= SEGMENT_MAX_KEYFRAMES" @click="addFrame(false)"><DiamondPlus :size="16" /></button>
      <button class="btn btn-sm" :title="t('layerCanvas.keyframeBar.copyPrev')" :disabled="!current || timeline.keyframes.length >= SEGMENT_MAX_KEYFRAMES" @click="addFrame(true)"><Copy :size="16" /></button>
      <button class="btn btn-sm" :title="t('layerCanvas.keyframeBar.remove')" :disabled="selectedIndex === 0 || !current" @click="removeFrame"><Trash2 :size="16" /></button>
      <label>{{ t('layerCanvas.keyframeBar.duration') }} <input :aria-label="t('layerCanvas.keyframeBar.duration')" type="number" min="1" max="30" step="0.1" :value="duration" @change="changeDuration($event.target.value)">s</label>
      <span>{{ t('layerCanvas.keyframeBar.endHold') }} <b>{{ endHold.toFixed(2) }}s</b></span>
    </header>
    <input class="pk-scrub" :aria-label="t('episode.segment.time')" type="range" min="0" :max="duration" step="0.02" :value="time" @input="emit('update:time', Number($event.target.value))">
    <div class="pk-track">
      <button v-for="(frame, index) in timeline.keyframes" :key="index" class="pk-frame" :class="{selected:index === selectedIndex, junction:isJunction(index)}" :aria-pressed="index === selectedIndex" :title="`${frame.t.toFixed(2)}s · ${frame.ease || timeline.ease} · ${frame.fade_ms ?? timeline.fade_ms}ms`" @click="selectFrame(index)">
        <div class="pk-thumbnail"><div :style="thumbnailStyle(frame)"><img v-if="baseSrc && !baseFailed" :src="baseSrc" alt="" draggable="false" @error="baseFailed = true"><div v-html="thumbnailSvg(frame)" /></div></div>
        <span class="pk-diamond"><Diamond :size="18" /><Lock v-if="isJunction(index)" :size="11" /><i v-if="quality.some(q => q.frame_index === index)" class="pk-low" /></span>
        <span>{{ frame.t.toFixed(2) }}s</span><small v-if="isJunction(index)">{{ t('layerCanvas.keyframeBar.junction') }}</small>
      </button>
      <span class="pk-end">{{ duration.toFixed(2) }}s</span>
    </div>
    <p v-if="junctionTextCount" class="pk-warning"><TriangleAlert :size="14" />{{ t('layerCanvas.keyframeBar.junctionTextWarn', {n:junctionTextCount}) }}</p>
    <div v-if="current" class="pk-inspector">
      <label>{{ t('episode.segment.time') }}<input :aria-label="t('episode.segment.time')" type="number" min="0" :max="duration" step="0.1" :disabled="selectedIndex === 0" :value="current.t" @change="setTime($event.target.value)"></label>
      <fieldset><legend><button type="button" class="btn btn-sm" @click="emit('viewport-pick')">{{ t('layerCanvas.keyframeBar.viewportPick') }}</button></legend><label v-for="key in ['x','y','w','h']" :key="key">{{ key }}<input :aria-label="`${t('layerCanvas.keyframeBar.viewportPick')} ${key}`" type="number" min="0" max="1" step="0.01" :value="current.viewport[key]" @change="setViewport(key, Number($event.target.value))"></label></fieldset>
      <fieldset class="pk-visible"><legend>{{ t('layerCanvas.keyframeBar.visible') }}</legend><label v-for="layer in doc.layers" :key="layer.id"><input type="checkbox" :checked="current.visible.includes(layer.id)" @change="toggleVisible(layer.id, $event.target.checked)">{{ layer.name || layer.id }}</label></fieldset>
      <fieldset><legend>{{ t('layerCanvas.keyframeBar.ease') }}</legend><select :value="current.ease || ''" @change="patchFrame({ease:$event.target.value || undefined})"><option value="">{{ t('episode.segment.inherit') }}</option><option value="linear">{{ t('episode.segment.easeLinear') }}</option><option value="inout">{{ t('episode.segment.easeInout') }}</option></select><label>{{ t('layerCanvas.keyframeBar.fade') }}<input :aria-label="t('layerCanvas.keyframeBar.fade')" type="number" min="0" max="3000" step="50" :value="current.fade_ms ?? timeline.fade_ms" @change="patchFrame({fade_ms:Math.max(0,Math.min(3000,Number($event.target.value)))})">ms</label></fieldset>
    </div>
  </section>
</template>
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Diamond, DiamondPlus, Info, Lock, Trash2, TriangleAlert, X } from 'lucide-vue-next'
import { layerDocToSvg } from '~/utils/layerSvg'
import { endHoldOf, clampSegmentDuration, normalizeViewport, SEGMENT_MAX_KEYFRAMES } from '~/utils/segmentTimeline'
import { mediaUrl } from '~/utils/url'
const props = defineProps({timeline:{type:Object,required:true}, duration:{type:Number,required:true}, doc:{type:Object,required:true}, spec:{type:Object,required:true}, junction:{type:Object,default:null}, quality:{type:Array,default:()=>[]}, selectedIndex:{type:Number,default:0}, time:{type:Number,default:0}})
const emit = defineEmits(['update:timeline','update:duration','update:time','update:selectedIndex','select-frame','history','viewport-pick'])
const {t}=useI18n()
const teaching=ref(false)
const baseFailed=ref(false)
onMounted(()=>{teaching.value=localStorage.getItem('huobao.layerKeyframeTip') !== 'dismissed'})
function dismissTeaching(){ teaching.value=false;localStorage.setItem('huobao.layerKeyframeTip','dismissed') }
const current=computed(()=>props.timeline.keyframes[props.selectedIndex])
const endHold=computed(()=>endHoldOf(props.timeline,props.duration))
const baseSrc=computed(()=>props.doc.base.path ? mediaUrl(props.doc.base.path) : '')
watch(baseSrc,()=>{baseFailed.value=false})
function isJunction(index){return !!props.junction && index === (props.junction.slot === 'last' ? props.timeline.keyframes.length-1 : 0)}
const junctionTextCount=computed(()=>{if(!props.junction)return 0;const f=props.timeline.keyframes[props.junction.slot==='last'?props.timeline.keyframes.length-1:0];return props.doc.layers.filter(l=>f?.visible.includes(l.id)&&(['label','card'].includes(l.type)||(l.type==='marker'&&l.text))).length})
function selectFrame(index){emit('update:selectedIndex',index);emit('select-frame',index);emit('update:time',props.timeline.keyframes[index].t)}
function updateFrames(keyframes, selected){emit('history');const target=keyframes[selected];keyframes.sort((a,b)=>a.t-b.t);emit('update:timeline',{...props.timeline,keyframes});if(target){emit('update:selectedIndex',keyframes.indexOf(target));emit('update:time',target.t)}}
function addFrame(copy){const previous=copy ? props.timeline.keyframes[Math.max(0,props.selectedIndex-1)] : current.value;const frame=JSON.parse(JSON.stringify(previous||{viewport:{x:0,y:0,w:1,h:1},visible:[]}));frame.t=Math.max(0,Math.min(props.duration,props.time));const frames=[...props.timeline.keyframes,frame];updateFrames(frames,frames.length-1)}
function removeFrame(){if(props.selectedIndex===0)return;const frames=props.timeline.keyframes.filter((_,i)=>i!==props.selectedIndex);updateFrames(frames,Math.max(0,props.selectedIndex-1))}
function patchFrame(patch){if(!current.value)return;const frame={...current.value,...patch};for(const k of ['ease','fade_ms'])if(frame[k]===undefined)delete frame[k];updateFrames(props.timeline.keyframes.map((f,i)=>i===props.selectedIndex?frame:f),props.selectedIndex)}
function setTime(raw){patchFrame({t:Math.max(0,Math.min(props.duration,Number(raw)||0))})}
function setViewport(key, value) {
  const viewport = {...current.value.viewport, [key]:value}
  const crop = props.doc.base.crop || {w:1,h:1}
  if (key === 'w') viewport.h = value * crop.h / crop.w
  if (key === 'h') viewport.w = value * crop.w / crop.h
  patchFrame({viewport:normalizeViewport(viewport,props.doc.base.crop)})
}
function toggleVisible(id,on){patchFrame({visible:on?[...current.value.visible.filter(v=>v!==id),id]:current.value.visible.filter(v=>v!==id)})}
function changeDuration(raw){const duration=clampSegmentDuration(raw,30);emit('history');emit('update:duration',duration);emit('update:timeline',{...props.timeline,keyframes:props.timeline.keyframes.map(f=>({...f,t:Math.min(f.t,duration)}))})}
function thumbnailStyle(frame){const v=frame.viewport;return{position:'absolute',width:`${100/v.w}%`,height:`${100/v.h}%`,left:`${-100*v.x/v.w}%`,top:`${-100*v.y/v.h}%`}}
function thumbnailSvg(frame){return layerDocToSvg(props.doc,props.spec,{viewport:{x:0,y:0,w:1,h:1},visibleIds:frame.visible,resolveImage:mediaUrl})}
</script>
<style scoped>
.pk-bar{border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--bg-2);min-width:0}.pk-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pk-controls label{margin-left:auto}.pk-bar input[type=number]{width:64px;background:var(--bg-1);border:1px solid var(--border);border-radius:4px;padding:4px;color:var(--text-1)}.pk-scrub{width:100%;margin:14px 0}.pk-track{display:flex;align-items:flex-end;gap:16px;overflow-x:auto;padding:4px 4px 12px;border-bottom:1px solid var(--border)}.pk-frame{display:flex;flex:none;flex-direction:column;align-items:center;gap:4px;width:90px;border:1px solid transparent;border-radius:6px;padding:5px;color:var(--text-2);background:transparent}.pk-frame.selected{border-color:var(--accent);background:var(--bg-3)}.pk-frame.junction .pk-diamond{outline:2px solid var(--accent);border-radius:50%}.pk-thumbnail{height:48px;width:80px;position:relative;overflow:hidden;background:var(--bg-1)}.pk-thumbnail img,.pk-thumbnail :deep(svg),.pk-thumbnail>div>div{position:absolute;width:100%;height:100%;inset:0}.pk-thumbnail img{object-fit:fill}.pk-diamond{position:relative;display:flex;align-items:center;gap:2px}.pk-low{width:7px;height:7px;border-radius:50%;background:#d69b29;position:absolute;right:-5px;top:0}.pk-end{margin-left:auto;align-self:center;white-space:nowrap}.pk-inspector{display:grid;grid-template-columns:90px 1fr 1fr 1fr;gap:12px;padding-top:12px}.pk-inspector fieldset{border:1px solid var(--border);border-radius:5px;display:flex;gap:5px;flex-wrap:wrap;min-width:0}.pk-inspector label{display:flex;gap:4px;align-items:center;flex-wrap:wrap;font-size:11px}.pk-inspector legend{font-size:11px;color:var(--text-3)}.pk-visible{max-height:110px;overflow:auto}.pk-teach,.pk-warning{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.6;padding:8px;background:var(--bg-3);border-radius:5px;margin-bottom:10px}.pk-warning{color:var(--warning)}.pk-teach .btn{margin-left:auto;flex:none}
</style>
