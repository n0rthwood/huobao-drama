<template>
  <div class="ct-panel">
    <!-- 时刻滑杆：拖动即驱动中栏预览（与后端 frameStateAt 同一口径） -->
    <div class="ct-block">
      <div class="ct-row">
        <span class="ct-label">{{ t('episode.segment.time') }}</span>
        <span class="mono ct-time">{{ time.toFixed(2) }}s / {{ duration.toFixed(2) }}s</span>
      </div>
      <input
        class="ct-slider" type="range" min="0" :max="duration" step="0.02"
        :value="time" @input="$emit('update:time', Number($event.target.value))"
      >
      <div class="ct-ticks">
        <button
          v-for="(keyframe, index) in timeline.keyframes" :key="`tick-${index}`"
          type="button" class="ct-tick" :class="{ on: index === selectedIndex }"
          :style="{ left: `${pct(keyframe.t)}%` }"
          :title="t('episode.segment.keyframeAt', { t: keyframe.t.toFixed(2) })"
          @click="pickKeyframe(index)"
        />
      </div>
    </div>

    <!-- 段参数：时长 / 缓动 / 淡入淡出；fps 是派生值，只读 -->
    <div class="ct-block ct-params">
      <label class="ct-field">
        <span class="ct-label">{{ t('episode.segment.duration') }}</span>
        <input
          class="input ct-input" type="number" :min="minSeconds" :max="maxSeconds" step="0.5"
          :value="duration" @change="onDuration($event.target.value)"
        >
        <span class="ct-unit">{{ t('episode.segment.seconds', { max: maxSeconds }) }}</span>
      </label>
      <label class="ct-field">
        <span class="ct-label">{{ t('episode.segment.ease') }}</span>
        <select class="input ct-input" :value="timeline.ease" @change="patchTimeline({ ease: $event.target.value })">
          <option value="inout">{{ t('episode.segment.easeInout') }}</option>
          <option value="linear">{{ t('episode.segment.easeLinear') }}</option>
        </select>
      </label>
      <label class="ct-field">
        <span class="ct-label">{{ t('episode.segment.fade') }}</span>
        <input
          class="input ct-input" type="number" min="0" max="3000" step="50"
          :value="timeline.fade_ms" @change="patchTimeline({ fade_ms: Math.max(0, Math.min(3000, Number($event.target.value) || 0)) })"
        >
        <span class="ct-unit">ms</span>
      </label>
      <div class="ct-field">
        <span class="ct-label">{{ t('episode.segment.endHold') }}</span>
        <span class="mono ct-readonly">{{ endHold.toFixed(2) }}s</span>
        <span class="ct-unit">{{ t('episode.segment.endHoldDerived') }}</span>
      </div>
    </div>

    <!-- 精确关键帧列表 -->
    <div class="ct-block">
      <div class="ct-row">
        <span class="ct-label">{{ t('episode.segment.keyframes') }}</span>
        <span class="tag mono">{{ timeline.keyframes.length }}</span>
        <span class="ml-auto" />
        <button type="button" class="btn btn-sm" :disabled="timeline.keyframes.length >= maxKeyframes" @click="addKeyframe">
          {{ t('episode.segment.addKeyframe') }}
        </button>
      </div>
      <div class="ct-state-list">
        <div
          v-for="(keyframe, index) in timeline.keyframes" :key="`keyframe-${index}`"
          :class="['ct-state', { on: index === selectedIndex }]"
          role="button" tabindex="0"
          @click="pickKeyframe(index)" @keydown.enter.prevent="pickKeyframe(index)"
        >
          <span class="ct-state-no">{{ index + 1 }}</span>
          <input
            class="input ct-state-time" type="number" min="0" :max="duration" step="0.1"
            :value="keyframe.t" @click.stop @change="setKeyframeTime(index, $event.target.value)"
          >
          <span class="ct-state-sum">{{ t('episode.segment.visibleCount', { n: keyframe.visible.length }) }}</span>
          <button
            type="button" class="ct-state-del" :title="t('episode.segment.removeKeyframe')"
            :disabled="timeline.keyframes.length <= 1" @click.stop="removeKeyframe(index)"
          >×</button>
        </div>
      </div>
    </div>

    <!-- 当前关键帧：取景框（正方形归一化框，可拖可缩）+ 图层可见勾选 + 逐帧覆盖 -->
    <div v-if="current" class="ct-block">
      <div class="ct-row">
        <span class="ct-label">{{ t('episode.segment.viewport') }}</span>
        <span class="mono ct-time">{{ t('episode.segment.viewportValue', { x: current.viewport.x.toFixed(2), y: current.viewport.y.toFixed(2), s: current.viewport.w.toFixed(2) }) }}</span>
      </div>
      <div ref="stageEl" class="ct-stage" :style="{ aspectRatio: `${spec.width} / ${spec.height}` }">
        <img v-if="baseSrc" class="ct-stage-base" :src="baseSrc" alt="" draggable="false">
        <div v-for="filter in baseFilters" :key="filter.id" class="ct-stage-filter" :style="filterStyle(filter)" />
        <!-- eslint-disable-next-line vue/no-v-html -- 与后端同源的 layerDocToSvg 输出，内容已转义 -->
        <div class="ct-stage-svg" v-html="keyframeSvg" />
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
          <span class="ct-label">{{ t('episode.segment.viewportSize') }}</span>
          <input class="input ct-input" type="number" :min="minViewport" max="1" step="0.01" :value="current.viewport.w" @change="setViewport({ w: Number($event.target.value), h: Number($event.target.value) })">
        </label>
      </div>
      <div class="ct-params">
        <label class="ct-field">
          <span class="ct-label">{{ t('episode.segment.frameEase') }}</span>
          <select class="input ct-input" :value="current.ease || ''" @change="setOverride({ ease: $event.target.value || undefined })">
            <option value="">{{ t('episode.segment.inherit') }}</option>
            <option value="inout">{{ t('episode.segment.easeInout') }}</option>
            <option value="linear">{{ t('episode.segment.easeLinear') }}</option>
          </select>
        </label>
        <label class="ct-field">
          <span class="ct-label">{{ t('episode.segment.frameFade') }}</span>
          <input
            class="input ct-input" type="number" min="0" max="3000" step="50"
            :value="current.fade_ms ?? ''" :placeholder="t('episode.segment.inherit')"
            @change="setOverride({ fade_ms: $event.target.value === '' ? undefined : Math.max(0, Math.min(3000, Number($event.target.value) || 0)) })"
          >
          <span class="ct-unit">ms</span>
        </label>
      </div>
      <div class="ct-row ct-visible-head">
        <span class="ct-label">{{ t('episode.segment.visibleLayers') }}</span>
        <span class="ml-auto" />
        <button type="button" class="btn btn-sm" @click="setAllVisible(true)">{{ t('episode.segment.showAll') }}</button>
        <button type="button" class="btn btn-sm" @click="setAllVisible(false)">{{ t('episode.segment.hideAll') }}</button>
      </div>
      <div class="ct-visible-list">
        <label v-for="layer in doc.layers" :key="layer.id" class="ct-visible-item">
          <input type="checkbox" :checked="current.visible.includes(layer.id)" @change="toggleVisible(layer.id, $event.target.checked)">
          <span class="truncate">{{ layer.name || layer.id }}</span>
        </label>
        <div v-if="!doc.layers.length" class="ct-empty">{{ t('episode.segment.noLayers') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 精确关键帧面板（Issue #58，由旧片段时间线面板迁入）：
 * 关键帧增删改、取景框（正方形归一化框）拖拽、每帧图层可见勾选、时刻滑杆与段参数，
 * 外加逐帧 ease / fade_ms 覆盖。数值口径与 `utils/segmentTimeline.js`
 * （= 后端 segment-timeline.ts）一致，fps 由服务端派生，这里不暴露。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { baseFilterLayers, layerDocToSvg } from '~/utils/layerSvg'
import { mediaUrl } from '~/utils/url'
import {
  SEGMENT_MAX_KEYFRAMES, SEGMENT_MAX_SECONDS, SEGMENT_MIN_SECONDS, SEGMENT_MIN_VIEWPORT,
  clampSegmentDuration, endHoldOf, normalizeViewport,
} from '~/utils/segmentTimeline'

const props = defineProps({
  doc: { type: Object, required: true },
  timeline: { type: Object, required: true },
  duration: { type: Number, default: 8 },
  spec: { type: Object, default: () => ({ width: 960, height: 544, fps: 25 }) },
  time: { type: Number, default: 0 },
  selectedIndex: { type: Number, default: 0 },
})
const emit = defineEmits(['update:timeline', 'update:duration', 'update:time', 'update:selectedIndex'])
const { t } = useI18n()

const minSeconds = SEGMENT_MIN_SECONDS
const minViewport = SEGMENT_MIN_VIEWPORT
const maxKeyframes = SEGMENT_MAX_KEYFRAMES
const maxSeconds = SEGMENT_MAX_SECONDS
const current = computed(() => props.timeline.keyframes[props.selectedIndex] || null)
const endHold = computed(() => endHoldOf(props.timeline, props.duration))

const stageEl = ref(null)

/** 小图只画「该帧可见的图层」，不套取景框——取景框要在整幅上拖 */
const keyframeSvg = computed(() => {
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
function patchKeyframes(keyframes) {
  patchTimeline({ keyframes })
}

function pickKeyframe(index) {
  emit('update:selectedIndex', index)
  const keyframe = props.timeline.keyframes[index]
  if (keyframe) emit('update:time', keyframe.t)
}

function sortKeyframes(keyframes, keepIndex) {
  const marked = keyframes.map((keyframe, index) => ({ keyframe, index }))
  marked.sort((a, b) => (a.keyframe.t - b.keyframe.t) || (a.index - b.index))
  const next = marked.map(item => item.keyframe)
  const moved = marked.findIndex(item => item.index === keepIndex)
  return { keyframes: next, index: moved < 0 ? 0 : moved }
}

function addKeyframe() {
  if (props.timeline.keyframes.length >= SEGMENT_MAX_KEYFRAMES) return
  const base = current.value || { t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }
  const at = Math.min(props.duration, Math.round((props.time + Number.EPSILON) * 100) / 100)
  const keyframes = [...props.timeline.keyframes, {
    t: at,
    viewport: { ...base.viewport },
    visible: [...base.visible],
  }]
  const sorted = sortKeyframes(keyframes, keyframes.length - 1)
  patchKeyframes(sorted.keyframes)
  emit('update:selectedIndex', sorted.index)
  emit('update:time', at)
}

function removeKeyframe(index) {
  if (props.timeline.keyframes.length <= 1) return
  const keyframes = props.timeline.keyframes.filter((_, i) => i !== index)
  patchKeyframes(keyframes)
  emit('update:selectedIndex', Math.max(0, Math.min(index, keyframes.length - 1)))
}

function setKeyframeTime(index, raw) {
  const at = Math.max(0, Math.min(props.duration, Number(raw) || 0))
  const keyframes = props.timeline.keyframes.map((keyframe, i) => (i === index ? { ...keyframe, t: Math.round(at * 100) / 100 } : keyframe))
  const sorted = sortKeyframes(keyframes, index)
  patchKeyframes(sorted.keyframes)
  emit('update:selectedIndex', sorted.index)
  emit('update:time', at)
}

function patchCurrent(patch) {
  if (!current.value) return
  const keyframes = props.timeline.keyframes.map((keyframe, i) => (i === props.selectedIndex ? { ...keyframe, ...patch } : keyframe))
  patchKeyframes(keyframes)
}

function setViewport(patch) {
  if (!current.value) return
  patchCurrent({ viewport: normalizeViewport({ ...current.value.viewport, ...patch }) })
}

/** 逐帧覆盖：undefined = 跟随 timeline 级设置（键整个去掉，保持与后端一致） */
function setOverride(patch) {
  if (!current.value) return
  const next = { ...current.value, ...patch }
  for (const key of ['ease', 'fade_ms']) {
    if (next[key] === undefined) delete next[key]
  }
  const keyframes = props.timeline.keyframes.map((keyframe, i) => (i === props.selectedIndex ? next : keyframe))
  patchKeyframes(keyframes)
}

function toggleVisible(layerId, on) {
  if (!current.value) return
  const visible = on
    ? [...current.value.visible.filter(id => id !== layerId), layerId]
    : current.value.visible.filter(id => id !== layerId)
  patchCurrent({ visible })
}

function setAllVisible(on) {
  if (!current.value) return
  patchCurrent({ visible: on ? props.doc.layers.map(layer => layer.id) : [] })
}

function onDuration(raw) {
  const next = clampSegmentDuration(raw, maxSeconds)
  emit('update:duration', next)
  // 时长变短：越界的关键帧时刻一起收回，避免保存后关键帧落在段之外
  const keyframes = props.timeline.keyframes.map(keyframe => (keyframe.t > next ? { ...keyframe, t: next } : keyframe))
  if (keyframes.some((keyframe, i) => keyframe.t !== props.timeline.keyframes[i].t)) patchKeyframes(keyframes)
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
