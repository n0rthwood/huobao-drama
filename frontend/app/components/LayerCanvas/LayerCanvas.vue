<template>
  <div ref="rootEl" class="layer-canvas" tabindex="0" @keydown="onKeydown">
    <div class="lc-toolbar">
      <button v-for="tool in tools" :key="tool.key" type="button" class="btn-ghost lc-icon"
        :title="t(`layerCanvas.toolbar.${tool.key}`)" :aria-label="t(`layerCanvas.toolbar.${tool.key}`)"
        :aria-pressed="mode === tool.key" :disabled="tool.key === 'crop' && (cropLocked || !sourceKnown) || tool.key === 'frame' && !frameViewport"
        @click="setMode(tool.key)"><component :is="tool.icon" :size="16" /></button>
      <span class="lc-divider" />
      <button type="button" class="btn-ghost lc-icon" :title="t('layerCanvas.toolbar.undo')" :aria-label="t('layerCanvas.toolbar.undo')" :disabled="!canUndo" @click="emit('undo')"><Undo2 :size="16" /></button>
      <button type="button" class="btn-ghost lc-icon" :title="t('layerCanvas.toolbar.redo')" :aria-label="t('layerCanvas.toolbar.redo')" :disabled="!canRedo" @click="emit('redo')"><Redo2 :size="16" /></button>
      <button type="button" class="btn-ghost lc-icon" :title="t('layerCanvas.toolbar.snap')" :aria-label="t('layerCanvas.toolbar.snap')" :aria-pressed="snapOn" @click="snapOn = !snapOn"><Magnet :size="16" /></button>
      <span class="lc-spacer" />
      <button type="button" class="btn-ghost lc-icon" :title="t('layerCanvas.toolbar.zoomOut')" :aria-label="t('layerCanvas.toolbar.zoomOut')" @click="setZoom(zoom / 1.25)"><ZoomOut :size="16" /></button>
      <span class="lc-percent">{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="btn-ghost lc-icon" :title="t('layerCanvas.toolbar.zoomIn')" :aria-label="t('layerCanvas.toolbar.zoomIn')" @click="setZoom(zoom * 1.25)"><ZoomIn :size="16" /></button>
      <button type="button" class="btn-ghost lc-icon" :title="t('layerCanvas.toolbar.fit')" :aria-label="t('layerCanvas.toolbar.fit')" @click="resetView"><Maximize2 :size="16" /></button>
      <slot name="toolbar-extra" :missing-glyphs="missingGlyphs" />
    </div>
    <div v-if="aspectIssue" class="lc-banner">
      <TriangleAlert :size="14" />{{ t('layerCanvas.base.aspectBanner', { aspect: aspectIssue.aspect }) }}
      <button type="button" class="btn-ghost" :disabled="cropLocked || !sourceKnown" @click="startCrop">{{ t('layerCanvas.base.cropTo169') }}</button>
    </div>
    <div v-if="mode === 'crop'" class="lc-banner">
      <Crop :size="14" />{{ t('layerCanvas.base.cropHelp') }}
      <button type="button" class="btn-ghost" @click="applyCrop">{{ t('layerCanvas.base.applyCrop') }}</button>
      <button type="button" class="btn-ghost" @click="mode = 'select'">{{ t('layerCanvas.base.cancelCrop') }}</button>
    </div>
    <div v-if="baseImageError || !baseSrc" class="lc-banner"><TriangleAlert :size="14" />{{ t('layerCanvas.base.loadError') }}</div>
    <div ref="viewportEl" class="lc-viewport" @wheel.prevent="onWheel" @pointerdown="onViewportDown">
      <div class="lc-stage" :style="stageStyle">
        <div class="lc-base-surface">
          <div class="lc-source" :style="sourceStyle">
            <img v-if="baseSrc && !baseImageError" class="lc-base" :src="baseSrc" alt="" draggable="false" @load="onBaseLoad" @error="baseImageError = true">
            <div v-for="filter in filterLayers" :key="filter.id" class="lc-filter" :style="filterStyle(filter)" />
          </div>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- 与后端同源的 layerDocToSvg 输出，内容已转义 -->
        <div class="lc-overlay" v-html="svgMarkup" />
        <svg class="lc-ui" :viewBox="uiViewBox" preserveAspectRatio="none">
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
          <g v-if="selectionBox && mode === 'select'" :transform="selectionTransform">
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
          <template v-if="editingRect">
            <path v-if="mode === 'crop'" class="lc-crop-shade" fill-rule="evenodd"
              :d="`M0 0H${docWidth}V${docHeight}H0Z M${editingRect.x * docWidth} ${editingRect.y * docHeight}h${editingRect.w * docWidth}v${editingRect.h * docHeight}h${-editingRect.w * docWidth}Z`" />
            <rect class="lc-frame" :x="editingRect.x * docWidth" :y="editingRect.y * docHeight"
              :width="editingRect.w * docWidth" :height="editingRect.h * docHeight" :stroke-width="uiScale * 2"
              @pointerdown.stop="startRectDrag(false, $event)" />
            <rect class="lc-handle" :x="(editingRect.x + editingRect.w) * docWidth - uiScale * 6"
              :y="(editingRect.y + editingRect.h) * docHeight - uiScale * 6" :width="uiScale * 12" :height="uiScale * 12"
              @pointerdown.stop="startRectDrag(true, $event)" />
          </template>
        </svg>
      </div>
      <span v-if="quality" class="lc-quality"><TriangleAlert :size="14" />{{ t('layerCanvas.quality.badge', { w: quality.effective_w, h: quality.effective_h, sw: quality.spec_w, sh: quality.spec_h }) }}</span>
      <span v-if="missingGlyphs.length" class="lc-glyphs" :title="t('layerCanvas.style.missingChars', { chars: missingGlyphs.join(' ') })"><TriangleAlert :size="14" />{{ missingGlyphs.join(' ') }}</span>
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
import { MousePointer2, Hand, Frame, Crop, Undo2, Redo2, Magnet, ZoomIn, ZoomOut, Maximize2, TriangleAlert } from 'lucide-vue-next'
import { baseFilterLayers, layerBounds, layerDocToSvg } from '~/utils/layerSvg'
import { normalizeCrop } from '~/utils/layerQuality'
import { apiBase, mediaUrl } from '~/utils/url'

const props = defineProps({
  doc: { type: Object, required: true },
  selectedIds: { type: Array, default: () => [] },
  baseSrc: { type: String, default: '' },
  quality: { type: Object, default: null },
  aspectIssue: { type: Object, default: null },
  missingGlyphs: { type: Array, default: () => [] },
  anchorNames: { type: Object, default: () => ({}) },
  canUndo: { type: Boolean, default: true },
  canRedo: { type: Boolean, default: true },
  cropLocked: { type: Boolean, default: false },
  viewport: { type: Object, default: null },
})
const emit = defineEmits(['select', 'history', 'patch', 'delete', 'duplicate', 'undo', 'redo', 'crop', 'detach', 'viewport'])
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
const sourceSize = ref({ width: 0, height: 0 })
const baseImageError = ref(false)
// Public contract: crop/viewport emit whole-image normalized rectangles; parent owns compound history.
// #toolbar-extra receives missingGlyphs so injected render controls can expose/disable unsupported text.
const mode = ref('select')
const cropDraft = ref(null)
const tools = [
  { key: 'select', icon: MousePointer2 }, { key: 'pan', icon: Hand },
  { key: 'frame', icon: Frame }, { key: 'crop', icon: Crop },
]
const frameViewport = computed(() => props.viewport)
const editingRect = computed(() => mode.value === 'crop' ? cropDraft.value : mode.value === 'frame' ? frameViewport.value : null)

function setMode(next) {
  if (next === 'crop') { if (mode.value === 'crop') mode.value = 'select'; else startCrop(); return }
  mode.value = next
}

function startCrop() {
  if (props.cropLocked || !sourceKnown.value) return
  const ratio = (16 / 9) / (sourceDimensions.value.width / sourceDimensions.value.height)
  const w = Math.min(1, ratio)
  const h = w / ratio
  cropDraft.value = props.doc.base.crop ? { ...props.doc.base.crop } : { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
  mode.value = 'crop'
}

function applyCrop() {
  if (cropDraft.value) emit('crop', { ...cropDraft.value })
  mode.value = 'select'
}

function onBaseLoad(event) {
  sourceSize.value = { width: event.target.naturalWidth, height: event.target.naturalHeight }
  syncScale()
}

function startRectDrag(resize, event) {
  if (!editingRect.value) return
  if (mode.value === 'frame') emit('history')
  drag = { mode: 'rect', crop: mode.value === 'crop', resize, start: pointFromEvent(event), origin: { ...editingRect.value } }
  bindPointer(event)
}

function confirmGeometry(layers) {
  const anchored = layers.filter(layer => layer.anchor?.semantic_id && !layer.anchor.detached)
  if (!anchored.length) { emit('history'); return true }
  const name = anchored.map(layer => props.anchorNames[layer.id] || layer.name || layer.anchor.semantic_id).join(', ')
  if (!window.confirm(t('layerCanvas.anchor.detachConfirm', { name }))) return false
  emit('history')
  emit('detach', anchored.map(layer => layer.id))
  return true
}

// Native rendering fills the output surface unless an explicit crop opts into source geometry.
// Loading an image supplies local display metadata only; saving probes source pixels server-side.
const outputDimensions = computed(() => ({
  width: props.doc.base.width || 1344,
  height: props.doc.base.height || 768,
}))
const sourceKnown = computed(() => !!((props.doc.base.source_width || sourceSize.value.width) && (props.doc.base.source_height || sourceSize.value.height)))
const sourceDimensions = computed(() => ({
  width: props.doc.base.source_width || sourceSize.value.width || outputDimensions.value.width,
  height: props.doc.base.source_height || sourceSize.value.height || outputDimensions.value.height,
}))
const canvasDimensions = computed(() => mode.value === 'crop' ? sourceDimensions.value : outputDimensions.value)
const sourceGeometry = computed(() => mode.value === 'crop' || !!props.doc.base.crop)
const worldDimensions = computed(() => sourceGeometry.value ? sourceDimensions.value : outputDimensions.value)
const docWidth = computed(() => worldDimensions.value.width)
const docHeight = computed(() => worldDimensions.value.height)
const aspect = computed(() => docWidth.value / docHeight.value)
const renderDoc = computed(() => sourceGeometry.value ? {
  ...props.doc,
  base: { ...props.doc.base, source_width: sourceDimensions.value.width, source_height: sourceDimensions.value.height,
    crop: props.doc.base.crop || { x: 0, y: 0, w: 1, h: 1 } },
} : props.doc)
// Frame mode edits a rectangle on the crop surface; applying the rectangle itself here
// would rebase pointer coordinates during its drag. Preview/render apply that viewport.
const activeViewport = computed(() => normalizeCrop(mode.value === 'crop' ? null : props.doc.base.crop))
const uiViewBox = computed(() => {
  const view = activeViewport.value
  return `${view.x * docWidth.value} ${view.y * docHeight.value} ${view.w * docWidth.value} ${view.h * docHeight.value}`
})
const sourceStyle = computed(() => {
  const view = activeViewport.value
  return { width: `${100 / view.w}%`, height: `${100 / view.h}%`, left: `${-100 * view.x / view.w}%`, top: `${-100 * view.y / view.h}%` }
})
const uiScale = computed(() => activeViewport.value.w * docWidth.value / Math.max(1, stageWidth.value))

const svgMarkup = computed(() => layerDocToSvg(renderDoc.value, canvasDimensions.value, {
  viewport: activeViewport.value,
  resolveImage: path => mediaUrl(path),
}))
const filterLayers = computed(() => baseFilterLayers(props.doc.base.filter, canvasDimensions.value))

/**
 * 画布尺寸自己算，不交给 CSS：grid/flex 容器里 `aspect-ratio + max-width:100%`
 * 会按内容宽度解析，窄视口（1280 工作台）下画布会超出中栏被裁掉。
 */
const stageStyle = computed(() => {
  const fit = Math.max(
    0,
    Math.min(viewport.value.width / canvasDimensions.value.width, viewport.value.height / canvasDimensions.value.height),
  )
  return {
    width: `${Math.round(canvasDimensions.value.width * fit)}px`,
    height: `${Math.round(canvasDimensions.value.height * fit)}px`,
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
  const view = activeViewport.value
  return { x: view.x + (event.clientX - rect.left) / rect.width * view.w, y: view.y + (event.clientY - rect.top) / rect.height * view.h }
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
  if (mode.value !== 'select') { onViewportDown(event); return }
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
  if (!confirmGeometry(targets)) return
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
  if (!confirmGeometry([layer])) return
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
  if (!confirmGeometry([layer])) return
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
  if (mode.value === 'pan' || event.button === 1 || event.altKey) {
    drag = { mode: 'pan', start: { x: event.clientX, y: event.clientY }, origin: { ...pan.value } }
    bindPointer(event)
    return
  }
  if (event.button !== 0) return
  if (mode.value === 'crop' || mode.value === 'frame') return
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
  if (drag.mode === 'rect') {
    const origin = drag.origin
    const bounds = drag.crop ? { x: 0, y: 0, w: 1, h: 1 } : (props.doc.base.crop || { x: 0, y: 0, w: 1, h: 1 })
    let next
    if (drag.resize) {
      const targetAspect = drag.crop ? 16 / 9 : outputDimensions.value.width / outputDimensions.value.height
      const ratio = targetAspect / aspect.value
      const w = Math.max(0.01, Math.min(point.x - origin.x, (point.y - origin.y) * ratio,
        bounds.x + bounds.w - origin.x, (bounds.y + bounds.h - origin.y) * ratio))
      next = { ...origin, w, h: w / ratio }
    } else {
      next = { ...origin,
        x: Math.max(bounds.x, Math.min(bounds.x + bounds.w - origin.w, origin.x + point.x - drag.start.x)),
        y: Math.max(bounds.y, Math.min(bounds.y + bounds.h - origin.h, origin.y + point.y - drag.start.y)) }
    }
    if (drag.crop) cropDraft.value = next
    else emit('viewport', next)
    return
  }
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
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName)) return
  if (event.key === 'Escape') { mode.value = 'select'; endPointer(); return }
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
  const targets = selected.value.filter(layer => !layer.locked)
  if (!confirmGeometry(targets)) return
  drag = { targets: targets.map(layer => ({ id: layer.id, geometry: geometryOf(layer) })) }
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
watch(() => [canvasDimensions.value.width, canvasDimensions.value.height], () => requestAnimationFrame(syncScale))
watch(() => props.baseSrc, () => { sourceSize.value = { width: 0, height: 0 }; baseImageError.value = false })

defineExpose({
  focus: () => rootEl.value?.focus(),
  startCrop,
  startViewport: () => { if (props.viewport) mode.value = 'frame' },
})
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
.lc-base-surface { position: absolute; inset: 0; overflow: hidden; }
.lc-source { position: absolute; }
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
.lc-toolbar { gap: 3px; flex-wrap: wrap; }
.lc-icon { display: inline-flex; align-items: center; justify-content: center; padding: 6px; border-radius: 4px; }
.lc-icon[aria-pressed="true"] { background: var(--surface-active); color: var(--accent); outline: 1px solid var(--accent); }
.lc-icon:disabled { opacity: .4; cursor: not-allowed; }
.lc-spacer { flex: 1; }
.lc-divider { height: 20px; border-left: 1px solid var(--border); margin: 0 4px; }
.lc-percent { font-size: 11px; min-width: 36px; text-align: center; }
.lc-banner { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 12px; color: var(--warning, #b7791f); background: var(--surface-card); }
.lc-crop-shade { fill: rgba(0, 0, 0, .5); pointer-events: none; }
.lc-frame { fill: transparent; stroke: var(--accent); cursor: move; }
.lc-quality, .lc-glyphs { position: absolute; bottom: 10px; left: 10px; display: flex; align-items: center; gap: 4px; padding: 5px 7px; font-size: 11px; background: var(--surface-card); color: var(--warning, #b7791f); border: 1px solid currentColor; border-radius: 4px; pointer-events: none; }
.lc-glyphs { left: auto; right: 10px; color: var(--danger, #c0472e); }
</style>
