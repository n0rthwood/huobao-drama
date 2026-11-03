<template>
  <div class="ct-panel">
    <!-- 时刻滑杆：拖动即驱动中栏预览（与后端 frameStateAt 同一口径） -->
    <div class="ct-block">
      <div class="ct-row">
        <span class="ct-label">{{ t('episode.clip.time') }}</span>
        <span class="mono ct-time">{{ time.toFixed(2) }}s / {{ duration.toFixed(2) }}s</span>
      </div>
      <input
        class="ct-slider" type="range" min="0" :max="duration" step="0.02"
        :value="time" @input="$emit('update:time', Number($event.target.value))"
      >
      <div class="ct-ticks">
        <button
          v-for="(state, index) in timeline.states" :key="`tick-${index}`"
          type="button" class="ct-tick" :class="{ on: index === selectedIndex }"
          :style="{ left: `${pct(state.t)}%` }"
          :title="t('episode.clip.stateAt', { t: state.t.toFixed(2) })"
          @click="pickState(index)"
        />
      </div>
    </div>

    <!-- 片段参数：时长 / 缓动 / 淡入淡出；fps 是派生值，只读 -->
    <div class="ct-block ct-params">
      <label class="ct-field">
        <span class="ct-label">{{ t('episode.clip.duration') }}</span>
        <input
          class="input ct-input" type="number" :min="minSeconds" :max="maxSeconds" step="0.5"
          :value="duration" @change="onDuration($event.target.value)"
        >
        <span class="ct-unit">{{ t('episode.clip.seconds', { max: maxSeconds }) }}</span>
      </label>
      <label class="ct-field">
        <span class="ct-label">{{ t('episode.clip.ease') }}</span>
        <select class="input ct-input" :value="timeline.ease" @change="patchTimeline({ ease: $event.target.value })">
          <option value="inout">{{ t('episode.clip.easeInout') }}</option>
          <option value="linear">{{ t('episode.clip.easeLinear') }}</option>
        </select>
      </label>
      <label class="ct-field">
        <span class="ct-label">{{ t('episode.clip.fade') }}</span>
        <input
          class="input ct-input" type="number" min="0" max="3000" step="50"
          :value="timeline.fade_ms" @change="patchTimeline({ fade_ms: Math.max(0, Math.min(3000, Number($event.target.value) || 0)) })"
        >
        <span class="ct-unit">ms</span>
      </label>
      <div class="ct-field">
        <span class="ct-label">{{ t('episode.clip.fps') }}</span>
        <span class="mono ct-readonly">{{ timeline.fps }}</span>
        <span class="ct-unit">{{ t('episode.clip.fpsDerived') }}</span>
      </div>
    </div>

    <!-- 关键状态列表 -->
    <div class="ct-block">
      <div class="ct-row">
        <span class="ct-label">{{ t('episode.clip.states') }}</span>
        <span class="tag mono">{{ timeline.states.length }}</span>
        <span class="ml-auto" />
        <button type="button" class="btn btn-sm" :disabled="timeline.states.length >= maxStates" @click="addState">
          {{ t('episode.clip.addState') }}
        </button>
      </div>
      <div class="ct-state-list">
        <div
          v-for="(state, index) in timeline.states" :key="`state-${index}`"
          :class="['ct-state', { on: index === selectedIndex }]"
          role="button" tabindex="0"
          @click="pickState(index)" @keydown.enter.prevent="pickState(index)"
        >
          <span class="ct-state-no">{{ index + 1 }}</span>
          <input
            class="input ct-state-time" type="number" min="0" :max="duration" step="0.1"
            :value="state.t" @click.stop @change="setStateTime(index, $event.target.value)"
          >
          <span class="ct-state-sum">{{ t('episode.clip.visibleCount', { n: state.visible.length }) }}</span>
          <button
            type="button" class="ct-state-del" :title="t('episode.clip.removeState')"
            :disabled="timeline.states.length <= 1" @click.stop="removeState(index)"
          >×</button>
        </div>
      </div>
    </div>

    <!-- 当前状态：取景框（正方形归一化框，可拖可缩）+ 图层可见勾选 -->
    <div v-if="current" class="ct-block">
      <div class="ct-row">
        <span class="ct-label">{{ t('episode.clip.viewport') }}</span>
        <span class="mono ct-time">{{ t('episode.clip.viewportValue', { x: current.viewport.x.toFixed(2), y: current.viewport.y.toFixed(2), s: current.viewport.w.toFixed(2) }) }}</span>
      </div>
      <div ref="stageEl" class="ct-stage" :style="{ aspectRatio: `${spec.width} / ${spec.height}` }">
        <img v-if="baseSrc" class="ct-stage-base" :src="baseSrc" alt="" draggable="false">
        <div v-for="filter in baseFilters" :key="filter.id" class="ct-stage-filter" :style="filterStyle(filter)" />
        <!-- eslint-disable-next-line vue/no-v-html -- 与后端同源的 layerDocToSvg 输出，内容已转义 -->
        <div class="ct-stage-svg" v-html="stateSvg" />
        <div class="ct-frame" :style="frameStyle" @pointerdown.prevent="startDrag($event, 'move')">
          <span class="ct-frame-handle" @pointerdown.stop.prevent="startDrag($event, 'size')" />
        </div>
      </div>
      <div class="ct-params">
        <label class="ct-field">
          <span class="ct-label">X</span>
          <input class="input ct-input" type="number" min="0" max="1" step="0.01" :value="current.viewport.x" @change="setViewport({ x: Number($event.target.value) })">
        </label>
        <label class="ct-field">
          <span class="ct-label">Y</span>
          <input class="input ct-input" type="number" min="0" max="1" step="0.01" :value="current.viewport.y" @change="setViewport({ y: Number($event.target.value) })">
        </label>
        <label class="ct-field">
          <span class="ct-label">{{ t('episode.clip.viewportSize') }}</span>
          <input class="input ct-input" type="number" :min="minViewport" max="1" step="0.01" :value="current.viewport.w" @change="setViewport({ w: Number($event.target.value), h: Number($event.target.value) })">
        </label>
      </div>
      <div class="ct-row ct-visible-head">
        <span class="ct-label">{{ t('episode.clip.visibleLayers') }}</span>
        <span class="ml-auto" />
        <button type="button" class="btn btn-sm" @click="setAllVisible(true)">{{ t('episode.clip.showAll') }}</button>
        <button type="button" class="btn btn-sm" @click="setAllVisible(false)">{{ t('episode.clip.hideAll') }}</button>
      </div>
      <div class="ct-visible-list">
        <label v-for="layer in doc.layers" :key="layer.id" class="ct-visible-item">
          <input type="checkbox" :checked="current.visible.includes(layer.id)" @change="toggleVisible(layer.id, $event.target.checked)">
          <span class="truncate">{{ layer.name || layer.id }}</span>
        </label>
        <div v-if="!doc.layers.length" class="ct-empty">{{ t('episode.clip.noLayers') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 片段时间线编辑（Issue #50）：关键状态增删改、取景框（正方形归一化框）拖拽、
 * 每状态图层可见勾选、时刻滑杆与片段参数。数值口径与 `utils/clipTimeline.js`
 * （= 后端 clip-timeline.ts）一致，fps 只读。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { baseFilterLayers, layerDocToSvg } from '~/utils/layerSvg'
import { mediaUrl } from '~/utils/url'
import {
  CLIP_MAX_STATES, CLIP_MIN_SECONDS, CLIP_MIN_VIEWPORT,
  clampClipDuration, maxClipSeconds, normalizeViewport,
} from '~/utils/clipTimeline'

const props = defineProps({
  doc: { type: Object, required: true },
  timeline: { type: Object, required: true },
  duration: { type: Number, default: 8 },
  position: { type: String, default: 'replace' },
  spec: { type: Object, default: () => ({ width: 960, height: 544, fps: 25 }) },
  time: { type: Number, default: 0 },
  selectedIndex: { type: Number, default: 0 },
})
const emit = defineEmits(['update:timeline', 'update:duration', 'update:time', 'update:selectedIndex'])
const { t } = useI18n()

const minSeconds = CLIP_MIN_SECONDS
const minViewport = CLIP_MIN_VIEWPORT
const maxStates = CLIP_MAX_STATES
const maxSeconds = computed(() => maxClipSeconds(props.position))
const current = computed(() => props.timeline.states[props.selectedIndex] || null)

const stageEl = ref(null)

/** 小图只画「该状态可见的图层」，不套取景框——取景框要在整幅上拖 */
const stateSvg = computed(() => {
  const visible = current.value?.visible || []
  const opacity = {}
  for (const layer of props.doc.layers) opacity[layer.id] = visible.includes(layer.id) ? 1 : 0.12
  return layerDocToSvg(props.doc, { width: props.spec.width, height: props.spec.height }, {
    opacity,
    resolveImage: path => mediaUrl(path),
  })
})
const baseSrc = computed(() => mediaUrl(props.doc.base.path))
const baseFilters = computed(() => baseFilterLayers(props.doc.base.filter, { width: props.spec.width, height: props.spec.height }))
function filterStyle(filter) {
  return { backgroundImage: `url("data:image/svg+xml;charset=utf8,${encodeURIComponent(filter.svg)}")` }
}

const frameStyle = computed(() => {
  const vp = current.value?.viewport || { x: 0, y: 0, w: 1, h: 1 }
  return {
    left: `${vp.x * 100}%`,
    top: `${vp.y * 100}%`,
    width: `${vp.w * 100}%`,
    height: `${vp.h * 100}%`,
  }
})

function pct(value) {
  return props.duration > 0 ? Math.min(100, Math.max(0, (value / props.duration) * 100)) : 0
}

function patchTimeline(patch) {
  emit('update:timeline', { ...props.timeline, ...patch })
}
function patchStates(states) {
  patchTimeline({ states })
}

function pickState(index) {
  emit('update:selectedIndex', index)
  const state = props.timeline.states[index]
  if (state) emit('update:time', state.t)
}

function sortStates(states, keepIndex) {
  const marked = states.map((state, index) => ({ state, index }))
  marked.sort((a, b) => (a.state.t - b.state.t) || (a.index - b.index))
  const next = marked.map(item => item.state)
  const moved = marked.findIndex(item => item.index === keepIndex)
  return { states: next, index: moved < 0 ? 0 : moved }
}

function addState() {
  if (props.timeline.states.length >= CLIP_MAX_STATES) return
  const base = current.value || { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }
  const at = Math.min(props.duration, Math.round((props.time + Number.EPSILON) * 100) / 100)
  const states = [...props.timeline.states, {
    t: at,
    viewport: { ...base.viewport },
    visible: [...base.visible],
  }]
  const sorted = sortStates(states, states.length - 1)
  patchStates(sorted.states)
  emit('update:selectedIndex', sorted.index)
  emit('update:time', at)
}

function removeState(index) {
  if (props.timeline.states.length <= 1) return
  const states = props.timeline.states.filter((_, i) => i !== index)
  patchStates(states)
  emit('update:selectedIndex', Math.max(0, Math.min(index, states.length - 1)))
}

function setStateTime(index, raw) {
  const at = Math.max(0, Math.min(props.duration, Number(raw) || 0))
  const states = props.timeline.states.map((state, i) => (i === index ? { ...state, t: Math.round(at * 100) / 100 } : state))
  const sorted = sortStates(states, index)
  patchStates(sorted.states)
  emit('update:selectedIndex', sorted.index)
  emit('update:time', at)
}

function setViewport(patch) {
  if (!current.value) return
  const viewport = normalizeViewport({ ...current.value.viewport, ...patch })
  const states = props.timeline.states.map((state, i) => (i === props.selectedIndex ? { ...state, viewport } : state))
  patchStates(states)
}

function toggleVisible(layerId, on) {
  if (!current.value) return
  const visible = on
    ? [...current.value.visible.filter(id => id !== layerId), layerId]
    : current.value.visible.filter(id => id !== layerId)
  const states = props.timeline.states.map((state, i) => (i === props.selectedIndex ? { ...state, visible } : state))
  patchStates(states)
}

function setAllVisible(on) {
  if (!current.value) return
  const visible = on ? props.doc.layers.map(layer => layer.id) : []
  const states = props.timeline.states.map((state, i) => (i === props.selectedIndex ? { ...state, visible } : state))
  patchStates(states)
}

function onDuration(raw) {
  const next = clampClipDuration(raw, maxSeconds.value)
  emit('update:duration', next)
  // 时长变短：越界的状态时刻一起收回，避免保存后状态落在片段之外
  const states = props.timeline.states.map(state => (state.t > next ? { ...state, t: next } : state))
  if (states.some((state, i) => state.t !== props.timeline.states[i].t)) patchStates(states)
  if (props.time > next) emit('update:time', next)
}

// ===== 取景框拖拽：整体平移 / 右下角等比缩放（w === h 恒成立） =====
let drag = null
function startDrag(event, mode) {
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect || !current.value) return
  drag = { mode, rect, startX: event.clientX, startY: event.clientY, origin: { ...current.value.viewport } }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
}
function onDragMove(event) {
  if (!drag) return
  const dx = (event.clientX - drag.startX) / drag.rect.width
  const dy = (event.clientY - drag.startY) / drag.rect.height
  if (drag.mode === 'move') {
    setViewport({ x: drag.origin.x + dx, y: drag.origin.y + dy })
  } else {
    const size = Math.max(drag.origin.w + dx, drag.origin.h + dy)
    setViewport({ w: size, h: size })
  }
}
function endDrag() {
  drag = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
}
onBeforeUnmount(endDrag)
</script>

<style scoped>
.ct-panel { display: flex; flex-direction: column; gap: 12px; padding: 10px; overflow: auto; min-height: 0; }
.ct-block { display: flex; flex-direction: column; gap: 6px; position: relative; }
.ct-row { display: flex; align-items: center; gap: 6px; }
.ct-label { font-size: 12px; color: var(--text-2); }
.ct-time { font-size: 11px; color: var(--text-3); }
.ct-slider { width: 100%; }
.ct-ticks { position: relative; height: 10px; }
.ct-tick { position: absolute; top: 0; width: 8px; height: 8px; margin-left: -4px; padding: 0; border: 1px solid var(--border); border-radius: 50%; background: var(--surface-card); cursor: pointer; }
.ct-tick.on { background: var(--accent); border-color: var(--accent); }
.ct-params { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.ct-field { display: flex; align-items: center; gap: 4px; min-width: 0; }
.ct-input { flex: 1; min-width: 0; font-size: 12px; }
.ct-unit, .ct-readonly { font-size: 11px; color: var(--text-3); }
.ct-state-list { display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
.ct-state { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.ct-state.on { border-color: var(--accent); }
.ct-state-no { font-size: 11px; color: var(--text-3); width: 16px; }
.ct-state-time { width: 72px; font-size: 12px; }
.ct-state-sum { font-size: 11px; color: var(--text-3); flex: 1; min-width: 0; }
.ct-state-del { border: none; background: none; color: var(--text-3); cursor: pointer; font-size: 14px; }
.ct-state-del:disabled { opacity: 0.4; cursor: not-allowed; }
.ct-stage { position: relative; width: 100%; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--surface-base); touch-action: none; }
.ct-stage-base { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; user-select: none; }
.ct-stage-filter { position: absolute; inset: 0; background-size: 100% 100%; pointer-events: none; }
.ct-stage-svg { position: absolute; inset: 0; }
.ct-stage-svg :deep(svg) { width: 100%; height: 100%; display: block; }
.ct-frame { position: absolute; border: 2px solid var(--accent); background: rgba(47, 123, 214, 0.08); cursor: move; }
.ct-frame-handle { position: absolute; right: -5px; bottom: -5px; width: 10px; height: 10px; background: var(--surface-card, #fff); border: 1px solid var(--accent); cursor: nwse-resize; }
.ct-visible-head { margin-top: 2px; }
.ct-visible-list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; }
.ct-visible-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-1); }
.ct-empty { font-size: 12px; color: var(--text-3); }
</style>
