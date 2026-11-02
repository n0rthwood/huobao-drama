<template>
  <div ref="stageEl" class="poster-stage" :style="{ aspectRatio: size.replace('x', ' / ') }" @click.self="emit('select', null)">
    <canvas ref="canvasEl" class="poster-stage-canvas" @click="emit('select', null)" />
    <div v-if="!imageSrc" class="poster-stage-empty">{{ t('poster.stage.empty') }}</div>
    <button
      v-for="box in layout.texts" :key="box.id" type="button"
      :aria-label="resolveBoxText(box, variables)" :aria-pressed="box.id === selectedId"
      :class="['poster-text-box', { selected: box.id === selectedId }]"
      :style="{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.fontSize * 125}%` }"
      @pointerdown.stop.prevent="startDrag(box, $event)"
      @keydown.left.prevent="nudge(box, -0.005, 0)" @keydown.right.prevent="nudge(box, 0.005, 0)"
      @keydown.up.prevent="nudge(box, 0, -0.005)" @keydown.down.prevent="nudge(box, 0, 0.005)"
    ><span v-if="box.id === selectedId" class="poster-box-check">✓</span></button>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolveBoxText } from '~/utils/posterLayout'
import { drawPoster, loadImage } from '~/utils/posterCanvas'

const props = defineProps({
  imageSrc: { type: String, default: '' },
  layout: { type: Object, required: true },
  variables: { type: Object, required: true },
  size: { type: String, default: '1344x768' },
  selectedId: { type: String, default: null },
})
const emit = defineEmits(['select', 'move'])
const { t } = useI18n()
const stageEl = ref(null)
const canvasEl = ref(null)
let drag = null
let renderToken = 0
let source = ''
let image = null

async function render() {
  const token = ++renderToken
  await document.fonts.ready
  if (props.imageSrc !== source) {
    const loaded = props.imageSrc ? await loadImage(props.imageSrc) : null
    if (token !== renderToken) return
    image = loaded
    source = props.imageSrc
  }
  if (token !== renderToken || !canvasEl.value) return
  const [width, height] = props.size.split('x').map(Number)
  drawPoster(canvasEl.value, image || { width, height }, props.layout, props.variables, { transparent: !image, size: props.size })
}

function nudge(box, dx, dy) {
  emit('select', box.id)
  emit('move', { id: box.id, x: Math.min(1 - box.width, Math.max(0, box.x + dx)), y: Math.min(0.96, Math.max(0, box.y + dy)) })
}

function onMove(event) {
  if (!drag) return
  const dx = (event.clientX - drag.startX) / drag.width
  const dy = (event.clientY - drag.startY) / drag.height
  emit('move', { id: drag.id, x: Math.min(1 - drag.boxWidth, Math.max(0, drag.x + dx)), y: Math.min(0.96, Math.max(0, drag.y + dy)) })
}

function stopDrag() {
  drag = null
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

function startDrag(box, event) {
  emit('select', box.id)
  const rect = stageEl.value.getBoundingClientRect()
  drag = { id: box.id, startX: event.clientX, startY: event.clientY, x: box.x, y: box.y, boxWidth: box.width, width: rect.width, height: rect.height }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', stopDrag, { once: true })
  window.addEventListener('pointercancel', stopDrag, { once: true })
}

watch(() => [props.imageSrc, props.size, props.layout, props.variables], () => { void render() }, { deep: true })
onMounted(render)
onBeforeUnmount(() => { renderToken++; stopDrag() })
</script>

<style scoped>
.poster-stage { position: relative; width: 100%; background: var(--surface-base); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; user-select: none; touch-action: none; }
.poster-stage-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.poster-stage-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 12px; pointer-events: none; }
.poster-text-box { position: absolute; padding: 0; cursor: move; background: transparent; border: 1px dashed transparent; min-height: 18px; }
.poster-text-box.selected { border-color: var(--accent); }
.poster-box-check { position: absolute; right: 0; top: 0; background: var(--header-bg); color: var(--text-1); font-size: 11px; }
</style>
