<template>
  <div ref="rootEl" class="layer-canvas" tabindex="0" @keydown="onKeydown">
    <div class="lc-toolbar">
      <span class="lc-hint">{{ t('layerCanvas.canvas.hint') }}</span>
      <label class="lc-check">
        <input type="checkbox" :checked="snapOn" @change="snapOn = $event.target.checked">
        {{ t('layerCanvas.canvas.snap') }}
      </label>
      <div class="lc-zoom">
        <button type="button" class="btn-ghost" :title="t('layerCanvas.canvas.zoomOut')" @click="setZoom(zoom / 1.25)">−</button>
        <button type="button" class="btn-ghost" @click="resetView">{{ Math.round(zoom * 100) }}%</button>
        <button type="button" class="btn-ghost" :title="t('layerCanvas.canvas.zoomIn')" @click="setZoom(zoom * 1.25)">+</button>
      </div>
    </div>
    <div ref="viewportEl" class="lc-viewport" @wheel.prevent="onWheel" @pointerdown="onViewportDown">
      <div class="lc-stage" :style="stageStyle">
        <img v-if="baseSrc" class="lc-base" :src="baseSrc" alt="" draggable="false" @load="syncScale">
        <div v-for="filter in filterLayers" :key="filter.id" class="lc-filter" :style="filterStyle(filter)" />
        <!-- eslint-disable-next-line vue/no-v-html -- 与后端同源的 layerDocToSvg 输出，内容已转义 -->
        <div class="lc-overlay" v-html="svgMarkup" />
        <svg class="lc-ui" :viewBox="`0 0 ${docWidth} ${docHeight}`" preserveAspectRatio="none">
          <rect
            v-for="hit in hitShapes" :key="hit.id"
            class="lc-hit" :class="{ locked: hit.locked }"
            :x="hit.x" :y="hit.y" :width="hit.w" :height="hit.h"
            :transform="hit.transform"
            @pointerdown.stop="onLayerDown(hit.id, $event)"
          />
          <line
            v-for="(guide, index) in guides" :key="`g${index}`" class="lc-guide"
            :x1="guide.x1" :y1="guide.y1" :x2="guide.x2" :y2="guide.y2" :stroke-width="uiScale"
          />
          <g v-if="selectionBox" :transform="selectionTransform">
            <rect
              class="lc-select" :x="selectionBox.x" :y="selectionBox.y"
              :width="selectionBox.w" :height="selectionBox.h" :stroke-width="uiScale * 1.5"
            />
            <template v-if="singleSelection">
              <line
                class="lc-select" :x1="selectionBox.x + selectionBox.w / 2" :y1="selectionBox.y"
                :x2="selectionBox.x + selectionBox.w / 2" :y2="selectionBox.y - uiScale * 24" :stroke-width="uiScale * 1.5"
              />
              <circle
                class="lc-handle lc-rotate" data-handle="rotate"
                :cx="selectionBox.x + selectionBox.w / 2" :cy="selectionBox.y - uiScale * 24" :r="uiScale * 6"
                @pointerdown.stop="startRotate($event)"
              />
              <rect
                v-for="handle in handlePoints" :key="handle.key" class="lc-handle"
                :data-handle="handle.key"
                :x="handle.x - uiScale * 5" :y="handle.y - uiScale * 5"
                :width="uiScale * 10" :height="uiScale * 10"
                @pointerdown.stop="startResize(handle.key, $event)"
              />
            </template>
          </g>
          <rect
            v-if="marquee" class="lc-marquee" :x="marquee.x" :y="marquee.y"
            :width="marquee.w" :height="marquee.h" :stroke-width="uiScale"
          />
        </svg>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * Canva-lite 图层画布（Issue #48）：选择/框选、拖动、8 向缩放、旋转、吸附、
 * 键盘微调/删除/复制、视口缩放平移。画面本身由与后端同源的 layerDocToSvg 生成，
 * 本组件只在其上叠一层交互 SVG（命中框 + 手柄 + 吸附参考线）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { baseFilterLayers, layerBounds, layerDocToSvg } from '~/utils/layerSvg'
import { apiBase, mediaUrl } from '~/utils/url'

const props = defineProps({
  doc: { type: Object, required: true },
  selectedIds: { type: Array, default: () => [] },
  baseSrc: { type: String, default: '' },
})
const emit = defineEmits(['select', 'history', 'patch', 'delete', 'duplicate', 'undo', 'redo'])
const { t } = useI18n()

const HANDLE_KEYS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const SNAP_PX = 6
const MIN_SIZE = 0.01

const rootEl = ref(null)
const viewportEl = ref(null)
const zoom = ref(1)
const pan = ref({ x: 0, y: 0 })
const snapOn = ref(true)
const guides = ref([])
const marquee = ref(null)
const stageWidth = ref(1)
const viewport = ref({ width: 1344, height: 768 })
let drag = null

const docWidth = computed(() => props.doc.base.width || 1344)
const docHeight = computed(() => props.doc.base.height || 768)
const aspect = computed(() => docWidth.value / docHeight.value)
const uiScale = computed(() => docWidth.value / Math.max(1, stageWidth.value))

const svgMarkup = computed(() => layerDocToSvg(props.doc, { width: docWidth.value, height: docHeight.value }, {
  resolveImage: path => mediaUrl(path),
}))
const filterLayers = computed(() => baseFilterLayers(props.doc.base.filter, { width: docWidth.value, height: docHeight.value }))

/**
 * 画布尺寸自己算，不交给 CSS：grid/flex 容器里 `aspect-ratio + max-width:100%`
 * 会按内容宽度解析，窄视口（1280 工作台）下画布会超出中栏被裁掉。
 */
const stageStyle = computed(() => {
  const fit = Math.max(
    0,
    Math.min(viewport.value.width / docWidth.value, viewport.value.height / docHeight.value),
  )
  return {
    width: `${Math.round(docWidth.value * fit)}px`,
    height: `${Math.round(docHeight.value * fit)}px`,
    transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`,
  }
})

const selected = computed(() => props.doc.layers.filter(layer => props.selectedIds.includes(layer.id)))
const singleSelection = computed(() => selected.value.length === 1 && !selected.value[0].locked)

const hitShapes = computed(() => props.doc.layers
  .filter(layer => layer.visible)
  .map((layer) => {
    const box = layerBounds(layer, props.doc.theme, aspect.value)
    const x = box.x * docWidth.value
    const y = box.y * docHeight.value
    const w = Math.max(box.w * docWidth.value, uiScale.value * 8)
    const h = Math.max(box.h * docHeight.value, uiScale.value * 8)
    return {
      id: layer.id,
      locked: layer.locked,
      x, y, w, h,
      transform: layer.rotation ? `rotate(${layer.rotation} ${x + w / 2} ${y + h / 2})` : null,
    }
  }))

const selectionBox = computed(() => {
  if (!selected.value.length) return null
  if (singleSelection.value) {
    const box = layerBounds(selected.value[0], props.doc.theme, aspect.value)
    return { x: box.x * docWidth.value, y: box.y * docHeight.value, w: box.w * docWidth.value, h: box.h * docHeight.value }
  }
  const boxes = selected.value.map(layer => layerBounds(layer, props.doc.theme, aspect.value))
  const x = Math.min(...boxes.map(b => b.x)) * docWidth.value
  const y = Math.min(...boxes.map(b => b.y)) * docHeight.value
  const right = Math.max(...boxes.map(b => b.x + b.w)) * docWidth.value
  const bottom = Math.max(...boxes.map(b => b.y + b.h)) * docHeight.value
  return { x, y, w: right - x, h: bottom - y }
})

const selectionTransform = computed(() => {
  if (!singleSelection.value || !selected.value[0].rotation || !selectionBox.value) return null
  const box = selectionBox.value
  return `rotate(${selected.value[0].rotation} ${box.x + box.w / 2} ${box.y + box.h / 2})`
})

const handlePoints = computed(() => {
  const box = selectionBox.value
  if (!box) return []
  const xs = { w: box.x, n: box.x + box.w / 2, e: box.x + box.w }
  return [
    { key: 'nw', x: box.x, y: box.y },
    { key: 'n', x: xs.n, y: box.y },
    { key: 'ne', x: box.x + box.w, y: box.y },
    { key: 'e', x: box.x + box.w, y: box.y + box.h / 2 },
    { key: 'se', x: box.x + box.w, y: box.y + box.h },
    { key: 's', x: xs.n, y: box.y + box.h },
    { key: 'sw', x: box.x, y: box.y + box.h },
    { key: 'w', x: box.x, y: box.y + box.h / 2 },
  ]
})

function filterStyle(filter) {
  return { backgroundImage: `url("data:image/svg+xml;charset=utf8,${encodeURIComponent(filter.svg)}")` }
}

function stageRect() {
  const stage = viewportEl.value?.querySelector('.lc-stage')
  return stage ? stage.getBoundingClientRect() : null
}

function syncScale() {
  const box = viewportEl.value?.getBoundingClientRect()
  if (box) {
    // 视口内边距 12px（见 .lc-viewport），留给阴影与手柄
    viewport.value = { width: Math.max(1, box.width - 24), height: Math.max(1, box.height - 24) }
  }
  const rect = stageRect()
  if (rect) stageWidth.value = rect.width
}

function pointFromEvent(event) {
  const rect = stageRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
}

function geometryOf(layer) {
  return JSON.parse(JSON.stringify({ points: layer.points, at: layer.at, box: layer.box, style: layer.style, rotation: layer.rotation }))
}

/** 吸附：画面三等分线与其它图层的边/中心，阈值 6 屏幕像素。 */
function snapDelta(box, dx, dy) {
  const result = { dx, dy, guides: [] }
  if (!snapOn.value) return result
  const threshold = (SNAP_PX * uiScale.value) / docWidth.value
  const others = props.doc.layers
    .filter(layer => layer.visible && !props.selectedIds.includes(layer.id))
    .map(layer => layerBounds(layer, props.doc.theme, aspect.value))
  const xTargets = [0, 0.5, 1, ...others.flatMap(b => [b.x, b.x + b.w / 2, b.x + b.w])]
  const yTargets = [0, 0.5, 1, ...others.flatMap(b => [b.y, b.y + b.h / 2, b.y + b.h])]
  const candidates = [
    { key: 'dx', edges: [box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx], targets: xTargets },
    { key: 'dy', edges: [box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy], targets: yTargets },
  ]
  for (const candidate of candidates) {
    let best = null
    for (const edge of candidate.edges) {
      for (const target of candidate.targets) {
        const diff = target - edge
        if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, target }
      }
    }
    if (!best) continue
    result[candidate.key] += best.diff
    if (candidate.key === 'dx') {
      result.guides.push({ x1: best.target * docWidth.value, y1: 0, x2: best.target * docWidth.value, y2: docHeight.value })
    } else {
      result.guides.push({ x1: 0, y1: best.target * docHeight.value, x2: docWidth.value, y2: best.target * docHeight.value })
    }
  }
  return result
}

function onLayerDown(id, event) {
  const layer = props.doc.layers.find(item => item.id === id)
  if (!layer) return
  if (event.shiftKey) {
    const next = props.selectedIds.includes(id) ? props.selectedIds.filter(item => item !== id) : [...props.selectedIds, id]
    emit('select', next)
    return
  }
  if (!props.selectedIds.includes(id)) emit('select', [id])
  if (layer.locked) return
  const targets = (props.selectedIds.includes(id) ? selected.value : [layer]).filter(item => !item.locked)
  emit('history')
  drag = {
    mode: 'move',
    start: pointFromEvent(event),
    targets: targets.map(item => ({ id: item.id, geometry: geometryOf(item) })),
    box: unionBounds(targets),
  }
  bindPointer(event)
}

function unionBounds(layers) {
  const boxes = layers.map(layer => layerBounds(layer, props.doc.theme, aspect.value))
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...boxes.map(b => b.x))
  const y = Math.min(...boxes.map(b => b.y))
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y }
}

function startResize(handle, event) {
  const layer = selected.value[0]
  if (!layer || layer.locked) return
  emit('history')
  drag = {
    mode: 'resize',
    handle,
    start: pointFromEvent(event),
    layer: layer.id,
    geometry: geometryOf(layer),
    box: layerBounds(layer, props.doc.theme, aspect.value),
  }
  bindPointer(event)
}

function startRotate(event) {
  const layer = selected.value[0]
  if (!layer || layer.locked) return
  const box = layerBounds(layer, props.doc.theme, aspect.value)
  const center = { x: (box.x + box.w / 2) * docWidth.value, y: (box.y + box.h / 2) * docHeight.value }
  const start = pointFromEvent(event)
  emit('history')
  drag = {
    mode: 'rotate',
    layer: layer.id,
    center,
    startAngle: Math.atan2(start.y * docHeight.value - center.y, start.x * docWidth.value - center.x),
    rotation: layer.rotation || 0,
  }
  bindPointer(event)
}

function onViewportDown(event) {
  rootEl.value?.focus()
  if (event.button === 1 || event.altKey) {
    drag = { mode: 'pan', start: { x: event.clientX, y: event.clientY }, origin: { ...pan.value } }
    bindPointer(event)
    return
  }
  if (event.button !== 0) return
  const start = pointFromEvent(event)
  if (!event.shiftKey) emit('select', [])
  drag = { mode: 'marquee', start, additive: event.shiftKey, base: [...props.selectedIds] }
  marquee.value = { x: start.x * docWidth.value, y: start.y * docHeight.value, w: 0, h: 0 }
  bindPointer(event)
}

function bindPointer(event) {
  event.target.setPointerCapture?.(event.pointerId)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', endPointer, { once: true })
  window.addEventListener('pointercancel', endPointer, { once: true })
}

function applyMove(dx, dy) {
  for (const target of drag.targets) {
    const geometry = target.geometry
    if (geometry.points) emit('patch', { id: target.id, patch: { points: geometry.points.map(([x, y]) => [x + dx, y + dy]) } })
    else if (geometry.at) emit('patch', { id: target.id, patch: { at: [geometry.at[0] + dx, geometry.at[1] + dy] } })
    else if (geometry.box) emit('patch', { id: target.id, patch: { box: { ...geometry.box, x: geometry.box.x + dx, y: geometry.box.y + dy } } })
  }
}

function applyResize(point) {
  const { handle, box, geometry, layer: id } = drag
  const layer = props.doc.layers.find(item => item.id === id)
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  let local = point
  if (layer?.rotation) {
    const radians = (-layer.rotation * Math.PI) / 180
    const dx = (point.x - center.x) * aspect.value
    const dy = point.y - center.y
    local = {
      x: center.x + (dx * Math.cos(radians) - dy * Math.sin(radians)) / aspect.value,
      y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    }
  }
  let { x, y, w, h } = box
  if (handle.includes('w')) {
    const right = box.x + box.w
    x = Math.min(local.x, right - MIN_SIZE)
    w = right - x
  }
  if (handle.includes('e')) w = Math.max(MIN_SIZE, local.x - box.x)
  if (handle.includes('n')) {
    const bottom = box.y + box.h
    y = Math.min(local.y, bottom - MIN_SIZE)
    h = bottom - y
  }
  if (handle.includes('s')) h = Math.max(MIN_SIZE, local.y - box.y)

  const scaleX = box.w > 0 ? w / box.w : 1
  const scaleY = box.h > 0 ? h / box.h : 1
  if (geometry.points) {
    emit('patch', {
      id,
      patch: { points: geometry.points.map(([px, py]) => [x + (px - box.x) * scaleX, y + (py - box.y) * scaleY]) },
    })
  } else if (geometry.at) {
    const scale = Math.max(0.1, Math.min(scaleX, scaleY))
    emit('patch', {
      id,
      patch: {
        at: [x + (geometry.at[0] - box.x) * scaleX, y + (geometry.at[1] - box.y) * scaleY],
        style: {
          ...geometry.style,
          dot_radius: (geometry.style.dot_radius ?? 0.012) * scale,
          size: (geometry.style.size ?? 0.034) * scale,
        },
      },
    })
  } else if (geometry.box) {
    emit('patch', { id, patch: { box: { x, y, w, h } } })
  }
}

function onPointerMove(event) {
  if (!drag) return
  if (drag.mode === 'pan') {
    pan.value = { x: drag.origin.x + (event.clientX - drag.start.x), y: drag.origin.y + (event.clientY - drag.start.y) }
    return
  }
  const point = pointFromEvent(event)
  if (drag.mode === 'move') {
    const snapped = snapDelta(drag.box, point.x - drag.start.x, point.y - drag.start.y)
    guides.value = snapped.guides
    applyMove(snapped.dx, snapped.dy)
    return
  }
  if (drag.mode === 'resize') {
    applyResize(point)
    return
  }
  if (drag.mode === 'rotate') {
    const angle = Math.atan2(point.y * docHeight.value - drag.center.y, point.x * docWidth.value - drag.center.x)
    let degrees = drag.rotation + ((angle - drag.startAngle) * 180) / Math.PI
    if (event.shiftKey) degrees = Math.round(degrees / 15) * 15
    emit('patch', { id: drag.layer, patch: { rotation: Math.round(degrees * 10) / 10 } })
    return
  }
  if (drag.mode === 'marquee') {
    marquee.value = {
      x: Math.min(drag.start.x, point.x) * docWidth.value,
      y: Math.min(drag.start.y, point.y) * docHeight.value,
      w: Math.abs(point.x - drag.start.x) * docWidth.value,
      h: Math.abs(point.y - drag.start.y) * docHeight.value,
    }
  }
}

function endPointer() {
  if (drag?.mode === 'marquee' && marquee.value) {
    const box = {
      x: marquee.value.x / docWidth.value,
      y: marquee.value.y / docHeight.value,
      w: marquee.value.w / docWidth.value,
      h: marquee.value.h / docHeight.value,
    }
    if (box.w > 0.005 || box.h > 0.005) {
      const hits = props.doc.layers.filter((layer) => {
        if (!layer.visible) return false
        const bounds = layerBounds(layer, props.doc.theme, aspect.value)
        return bounds.x < box.x + box.w && bounds.x + bounds.w > box.x && bounds.y < box.y + box.h && bounds.y + bounds.h > box.y
      }).map(layer => layer.id)
      emit('select', drag.additive ? [...new Set([...drag.base, ...hits])] : hits)
    }
  }
  drag = null
  marquee.value = null
  guides.value = []
  window.removeEventListener('pointermove', onPointerMove)
}

function onKeydown(event) {
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault()
    emit(event.shiftKey ? 'redo' : 'undo')
    return
  }
  if ((event.ctrlKey || event.metaKey) && key === 'y') {
    event.preventDefault()
    emit('redo')
    return
  }
  if ((event.ctrlKey || event.metaKey) && key === 'd') {
    event.preventDefault()
    emit('duplicate')
    return
  }
  if (key === 'delete' || key === 'backspace') {
    event.preventDefault()
    emit('delete')
    return
  }
  const step = event.shiftKey ? 0.01 : 0.002
  const moves = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }
  const move = moves[key]
  if (!move || !selected.value.length) return
  event.preventDefault()
  emit('history')
  drag = { targets: selected.value.filter(layer => !layer.locked).map(layer => ({ id: layer.id, geometry: geometryOf(layer) })) }
  applyMove(move[0], move[1])
  drag = null
}

function setZoom(next) {
  zoom.value = Math.max(0.25, Math.min(4, next))
  requestAnimationFrame(syncScale)
}

function resetView() {
  zoom.value = 1
  pan.value = { x: 0, y: 0 }
  requestAnimationFrame(syncScale)
}

function onWheel(event) {
  setZoom(zoom.value * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
}

/**
 * 用后端打包的 Noto Sans/Serif SC 渲染画布文字：浏览器按需只下载真正用到的字重，
 * 这样编辑器与服务端 librsvg 用的是同一批字形，不是「本机凑合的回退字体」。
 */
function ensureBundledFonts() {
  if (typeof document === 'undefined' || document.getElementById('layer-canvas-fonts')) return
  const faces = [
    ['Noto Sans SC', 400, 'NotoSansSC-Regular.otf'],
    ['Noto Sans SC', 700, 'NotoSansSC-Bold.otf'],
    ['Noto Serif SC', 400, 'NotoSerifSC-Regular.otf'],
    ['Noto Serif SC', 700, 'NotoSerifSC-Bold.otf'],
  ]
  const style = document.createElement('style')
  style.id = 'layer-canvas-fonts'
  style.textContent = faces
    .map(([family, weight, file]) => `@font-face{font-family:'${family}';font-weight:${weight};font-display:swap;`
      + `src:url('${apiBase()}/layer-docs/fonts/${file}') format('opentype');}`)
    .join('\n')
  document.head.appendChild(style)
}

let observer = null
onMounted(() => {
  ensureBundledFonts()
  syncScale()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(syncScale)
    if (viewportEl.value) observer.observe(viewportEl.value)
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointermove', onPointerMove)
})
watch(() => [docWidth.value, docHeight.value], () => requestAnimationFrame(syncScale))

defineExpose({ focus: () => rootEl.value?.focus() })
</script>

<style scoped>
.layer-canvas { display: flex; flex-direction: column; min-width: 0; min-height: 0; outline: none; }
.lc-toolbar { display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-2); }
.lc-hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc-check { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.lc-zoom { display: inline-flex; align-items: center; gap: 2px; }
.lc-viewport { position: relative; flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; background: var(--surface-base); padding: 12px; touch-action: none; }
/* 尺寸由 stageStyle 按视口实测算出（见 script），这里只管定位与投影 */
.lc-stage { position: relative; transform-origin: center center; box-shadow: 0 2px 18px rgba(0, 0, 0, 0.18); }
.lc-base { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; user-select: none; }
.lc-filter { position: absolute; inset: 0; background-size: 100% 100%; pointer-events: none; }
.lc-overlay { position: absolute; inset: 0; pointer-events: none; }
.lc-overlay :deep(svg) { width: 100%; height: 100%; display: block; }
.lc-ui { position: absolute; inset: 0; width: 100%; height: 100%; }
.lc-hit { fill: transparent; cursor: move; }
.lc-hit.locked { cursor: not-allowed; }
.lc-select { fill: none; stroke: var(--accent); stroke-dasharray: none; }
.lc-handle { fill: var(--surface-card, #fff); stroke: var(--accent); stroke-width: 1; cursor: nwse-resize; }
.lc-rotate { cursor: grab; }
.lc-guide { stroke: #e0467c; stroke-dasharray: 4 4; }
.lc-marquee { fill: rgba(47, 123, 214, 0.12); stroke: var(--accent); stroke-dasharray: 4 3; }
</style>
