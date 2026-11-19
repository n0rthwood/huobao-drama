<script setup lang="ts">
/**
 * 地图编辑器画布（设计 03 §2–§4、§9；Issue #126 阶段 2）。
 *
 * 只画当前 TAB 类的要素，底图始终是纯底图；其他类别不创建 SVG 节点、不参与命中。
 * 画布全部视图操作（滚轮、按钮、方向键、平移工具、Space+拖拽）只改本地 zoom/中心，
 * 交给宿主以 `view` 事件发布深链；几何写回只发生在：
 *   - pointerup 且与手势起点不同的顶点拖拽（emit vertex-drag-end）；
 *   - 绘制模式下的新增地点 / 追加顶点（emit add-place / append-draft）；
 *   - 双击同一顶点（emit delete-vertex）。
 * 第二触点、pointercancel、Esc、未过阈值、拖回原坐标一律零几何事件。
 * 坐标换算走 coords.ts 的三级逆变换，绝不按 bbox 猜像素映射。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MapRegistration } from '~/map-studio/utils/mapRegistration'
import { geoToPixel, pixelToGeo } from '~/map-studio/utils/mapRegistration'
import {
  DEFAULT_VIEW, PAN_STEP_PX, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  clamp, contentArea, contentToViewBox, fitBox, fittedFrame, panBy, viewBoxToScreen, viewTransform, zoomAtCenter,
  zoomAround, type GeoView,
} from './coords'
import { vertexCount, type FeatureKind, type LinearKind } from './feature'

export interface CanvasShape {
  kind: FeatureKind
  id: string
  name: string
  points: Array<[number, number]>
  /** 平滑预览的像素折线（宿主用同源 smooth.js 算好） */
  attr: string
  dataset: boolean
  pending: boolean
  /** 位置不可投影（地球背面等）时整条形状不画 */
  visible: boolean
}

export type CanvasCandidate =
  | { type: 'vertex'; kind: FeatureKind; id: string; index: number; name: string }
  | { type: 'edge'; kind: LinearKind; id: string; segment: number; name: string }
  | { type: 'body'; kind: FeatureKind; id: string; name: string }

interface Gesture {
  pointerId: number
  type: 'pan' | 'vertex' | 'draw'
  startClient: { x: number; y: number }
  startView: GeoView
  startGeo: [number, number] | null
  kind?: FeatureKind
  id?: string
  index?: number
  moved: boolean
  clampedWarned: boolean
  threshold: number
}

const props = defineProps<{
  baseUrl: string
  registration: MapRegistration | null
  size: { width: number; height: number }
  view: GeoView
  tab: FeatureKind
  tool: 'select' | 'draw' | 'pan'
  disabled: boolean
  shapes: CanvasShape[]
  draft: { kind: LinearKind; points: Array<[number, number]> } | null
  selected: { kind: FeatureKind; id: string } | null
  selectedVertex: { kind: LinearKind; id: string; index: number } | null
  selectedEdge: { kind: LinearKind; id: string; segment: number } | null
}>()

const emit = defineEmits<{
  (e: 'view', view: GeoView): void
  (e: 'base-size', size: { width: number; height: number }): void
  (e: 'select', target: { kind: FeatureKind; id: string }): void
  (e: 'select-vertex', target: { kind: LinearKind; id: string; index: number }): void
  (e: 'select-edge', target: { kind: LinearKind; id: string; segment: number } | null): void
  (e: 'clear-selection'): void
  (e: 'vertex-drag-end', target: { kind: FeatureKind; id: string; index: number; lon: number; lat: number }): void
  (e: 'delete-vertex', target: { kind: LinearKind; id: string; index: number }): void
  (e: 'append-draft', point: [number, number]): void
  (e: 'add-place', point: [number, number]): void
  (e: 'cursor', point: [number, number] | null): void
  (e: 'overlap', candidates: CanvasCandidate[]): void
  (e: 'escape'): void
}>()

const { t } = useI18n()
const svgEl = ref<SVGSVGElement | null>(null)
const focused = ref(false)
const spaceHeld = ref(false)
const gesture = ref<Gesture | null>(null)
const preview = ref<{ kind: FeatureKind; id: string; index: number; vb: [number, number] } | null>(null)
const activePointers = new Set<number>()
let suppressUntilAllUp = false
let lastDeleteClick = { key: '', at: 0, valid: false, count: 0 }

const contentSize = ref({ width: 720, height: 720 })
const handleRadius = computed(() => 6 / (Math.min(contentSize.value.width / props.size.width, contentSize.value.height / props.size.height) * props.view.zoom))
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  const measure = () => {
    const rect = layoutRect()
    if (rect) contentSize.value = { width: rect.width, height: rect.height }
  }
  measure()
  if (typeof ResizeObserver !== 'undefined' && svgEl.value) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(svgEl.value)
  }
})
onUnmounted(() => resizeObserver?.disconnect())
const unit = computed(() => Math.max(props.size.width, props.size.height) / (400 * props.view.zoom))
const activeShapes = computed(() => props.shapes.filter(shape => shape.visible && shape.kind === props.tab))

function layoutRect(): { left: number, top: number, width: number, height: number } | null {
  const svg = svgEl.value
  if (!svg || typeof svg.getBoundingClientRect !== 'function') return null
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function frameOf() {
  const rect = layoutRect()
  if (!rect) return null
  const box = contentArea(rect)
  const frame = fittedFrame(props.size, box)
  return frame ? { rect, box, frame } : null
}

function clientToViewBox(client: { x: number; y: number }): [number, number] | null {
  const geometry = frameOf()
  if (!geometry) return null
  return contentToViewBox({ x: client.x - geometry.box.left, y: client.y - geometry.box.top }, props.size, props.view, geometry.frame)
}

function insideBox(vb: [number, number]): boolean {
  return vb[0] >= 0 && vb[0] <= props.size.width && vb[1] >= 0 && vb[1] <= props.size.height
}

/** viewBox → 经纬度；图像矩形外夹到边界并告知调用方 */
function viewBoxToGeo(vb: [number, number]): { geo: [number, number]; clamped: boolean } | null {
  if (!props.registration) return null
  const x = clamp(vb[0], 0, props.size.width)
  const y = clamp(vb[1], 0, props.size.height)
  const geo = pixelToGeo(props.registration, x, y)
  if (!geo || !Number.isFinite(geo[0]) || !Number.isFinite(geo[1])) return null
  if (Math.abs(geo[0]) > 180 || Math.abs(geo[1]) > 90) return null
  return { geo: [geo[0], geo[1]], clamped: x !== vb[0] || y !== vb[1] }
}

function screenGeo(client: { x: number; y: number }): { geo: [number, number]; clamped: boolean } | null {
  const vb = clientToViewBox(client)
  return vb ? viewBoxToGeo(vb) : null
}

/** 每个可投影顶点：索引 + viewBox 像素 */
function vertexEntries(shape: CanvasShape): Array<{ index: number; vb: [number, number] }> {
  const entries: Array<{ index: number; vb: [number, number] }> = []
  shape.points.forEach((point, index) => {
    const pixel = geoToPixel(props.registration, point[0], point[1])
    if (pixel) entries.push({ index, vb: pixel })
  })
  return entries
}

function vertexScreen(shape: CanvasShape, index: number): [number, number] | null {
  const point = shape.points[index]
  if (!point) return null
  const pixel = geoToPixel(props.registration, point[0], point[1])
  const rect = layoutRect()
  return pixel && rect ? viewBoxToScreen(pixel, rect, props.size, props.view) : null
}

function edgeCandidates(client: { x: number; y: number }): CanvasCandidate[] {
  const rect = layoutRect()
  if (!rect) return []
  const hits: CanvasCandidate[] = []
  for (const shape of activeShapes.value) {
    if (shape.kind === 'place') continue
    const count = vertexCount(shape.kind, shape.points)
    const segments = shape.kind === 'region' ? count : count - 1
    for (let segment = 0; segment < segments; segment++) {
      const a = vertexScreen(shape, segment)
      const b = vertexScreen(shape, (segment + 1) % count)
      if (!a || !b) continue
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const lengthSq = dx * dx + dy * dy
      const ratio = lengthSq > 0 ? clamp(((client.x - a[0]) * dx + (client.y - a[1]) * dy) / lengthSq, 0, 1) : 0
      if (Math.hypot(client.x - (a[0] + dx * ratio), client.y - (a[1] + dy * ratio)) <= 22) {
        hits.push({ type: 'edge', kind: shape.kind as LinearKind, id: shape.id, segment, name: shape.name })
      }
    }
  }
  return hits
}

function containsPoint(shape: CanvasShape, client: { x: number; y: number }): boolean {
  const rect = layoutRect()
  if (!rect) return false
  const screen = vertexEntries(shape)
    .slice(0, vertexCount(shape.kind, shape.points))
    .map(entry => viewBoxToScreen(entry.vb, rect, props.size, props.view))
  if (screen.length < 3 || screen.some(point => !point)) return false
  let inside = false
  for (let index = 0, previous = screen.length - 1; index < screen.length; previous = index++) {
    const [xi, yi] = screen[index]!
    const [xj, yj] = screen[previous]!
    if ((yi > client.y) !== (yj > client.y) && client.x < ((xj - xi) * (client.y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside
  }
  return inside
}

function hitTargets(client: { x: number; y: number }): CanvasCandidate[] {
  const vertices: CanvasCandidate[] = []
  for (const shape of activeShapes.value) {
    if (shape.kind === 'place') continue
    for (const entry of vertexEntries(shape).slice(0, vertexCount(shape.kind, shape.points))) {
      const screen = vertexScreen(shape, entry.index)
      if (screen && Math.hypot(client.x - screen[0], client.y - screen[1]) <= 22) {
        vertices.push({ type: 'vertex', kind: shape.kind as LinearKind, id: shape.id, index: entry.index, name: shape.name })
      }
    }
  }
  if (vertices.length) return vertices
  const edges = edgeCandidates(client)
  if (edges.length) return edges
  const bodies: CanvasCandidate[] = []
  for (const shape of activeShapes.value) {
    if (shape.kind === 'place') {
      const screen = vertexScreen(shape, 0)
      if (screen && Math.hypot(client.x - screen[0], client.y - screen[1]) <= 22) {
        bodies.push({ type: 'vertex', kind: 'place', id: shape.id, index: 0, name: shape.name })
      }
    } else if (shape.kind === 'region' && containsPoint(shape, client)) {
      bodies.push({ type: 'body', kind: 'region', id: shape.id, name: shape.name })
    }
  }
  return bodies
}

function capture(pointerId: number) {
  const svg = svgEl.value
  if (svg && typeof svg.setPointerCapture === 'function') svg.setPointerCapture(pointerId)
}

function releaseCapture(pointerId: number) {
  const svg = svgEl.value
  if (svg && typeof svg.releasePointerCapture === 'function' && typeof svg.hasPointerCapture === 'function' && svg.hasPointerCapture(pointerId)) {
    svg.releasePointerCapture(pointerId)
  }
}

function cancelGesture(revertView = true) {
  const current = gesture.value
  if (!current) return
  releaseCapture(current.pointerId)
  if (revertView && current.type === 'pan' && current.moved) emit('view', current.startView)
  preview.value = null
  gesture.value = null
  if (activePointers.size === 0) suppressUntilAllUp = false
}

function startPan(event: PointerEvent, threshold: number) {
  gesture.value = {
    pointerId: event.pointerId,
    type: 'pan',
    startClient: { x: event.clientX, y: event.clientY },
    startView: { ...props.view },
    startGeo: null,
    moved: false,
    clampedWarned: false,
    threshold,
  }
  capture(event.pointerId)
}

function startPointer(event: PointerEvent) {
  if (props.disabled) return
  activePointers.add(event.pointerId)
  if (suppressUntilAllUp) return
  const threshold = event.pointerType === 'mouse' ? 4 : 8
  if (activePointers.size > 1) {
    // 第二触点：取消未提交手势并恢复起点，直到全部触点抬起前不接受新增/拖点
    const captured = gesture.value?.pointerId
    cancelGesture(true)
    suppressUntilAllUp = true
    if (captured !== undefined) releaseCapture(captured)
    return
  }
  const client = { x: event.clientX, y: event.clientY }
  if (props.tool === 'pan' || spaceHeld.value) {
    startPan(event, threshold)
    return
  }
  if (props.tool === 'draw') {
    if (!props.registration) return
    const result = screenGeo(client)
    if (!result) return
    gesture.value = { pointerId: event.pointerId, type: 'draw', startClient: client, startView: { ...props.view }, startGeo: result.geo, moved: false, clampedWarned: false, threshold }
    capture(event.pointerId)
    return
  }
  const targets = hitTargets(client)
  if (targets.length > 1) {
    emit('overlap', targets)
    return
  }
  const [target] = targets
  if (!target) {
    if (props.tool === 'select') startPan(event, threshold)
    return
  }
  emit('select', { kind: target.kind, id: target.id })
  if (target.type === 'body') return
  if (target.type === 'edge') {
    emit('select-edge', { kind: target.kind, id: target.id, segment: target.segment })
    return
  }
  if (target.kind !== 'place') emit('select-vertex', { kind: target.kind, id: target.id, index: target.index })
  if (props.tool !== 'select' || !props.registration) return
  const shape = props.shapes.find(item => item.id === target.id)
  const start = shape?.points[target.index]
  gesture.value = {
    pointerId: event.pointerId,
    type: 'vertex',
    startClient: client,
    startView: { ...props.view },
    startGeo: start ? [start[0], start[1]] : null,
    kind: target.kind,
    id: target.id,
    index: target.index,
    moved: false,
    clampedWarned: false,
    threshold,
  }
  capture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const client = { x: event.clientX, y: event.clientY }
  const vb = clientToViewBox(client)
  const cursor = vb && insideBox(vb) ? viewBoxToGeo(vb) : null
  emit('cursor', cursor && !cursor.clamped ? cursor.geo : null)
  const current = gesture.value
  if (!current || current.pointerId !== event.pointerId) return
  const dx = client.x - current.startClient.x
  const dy = client.y - current.startClient.y
  if (!current.moved && Math.hypot(dx, dy) < current.threshold) return
  current.moved = true
  if (current.type === 'pan') {
    const rect = layoutRect()
    if (rect) emit('view', panBy(dx, dy, rect, props.size, current.startView))
    return
  }
  if (!vb || !current.kind || !current.id || current.index === undefined) return
  if (!insideBox(vb) && !current.clampedWarned) {
    current.clampedWarned = true
    toast.warning(t('mapStudio.editor.clampedToImage'))
  }
  preview.value = {
    kind: current.kind,
    id: current.id,
    index: current.index,
    vb: [clamp(vb[0], 0, props.size.width), clamp(vb[1], 0, props.size.height)],
  }
}

function finishPointer(event: PointerEvent) {
  activePointers.delete(event.pointerId)
  if (suppressUntilAllUp) {
    if (activePointers.size === 0) suppressUntilAllUp = false
    return
  }
  const current = gesture.value
  if (!current || current.pointerId !== event.pointerId) return
  releaseCapture(event.pointerId)
  const client = { x: event.clientX, y: event.clientY }
  if (current.type === 'draw' && !current.moved && current.startGeo) {
    if (props.tab === 'place') emit('add-place', current.startGeo)
    else emit('append-draft', current.startGeo)
  }
  if (current.type === 'vertex' && current.kind && current.id && current.index !== undefined) {
    const key = `${current.kind}:${current.id}:${current.index}`
    const at = Date.now()
    const count = !current.moved && lastDeleteClick.key === key && at - lastDeleteClick.at < 600 ? lastDeleteClick.count + 1 : current.moved ? 0 : 1
    lastDeleteClick = { key, at, count, valid: count >= 2 }
  }
  if (current.type === 'vertex' && current.moved && current.startGeo && current.kind && current.id && current.index !== undefined) {
    const vb = clientToViewBox(client)
    const result = vb ? viewBoxToGeo(vb) : null
    if (result) {
      const returnedToStart = Math.hypot(client.x - current.startClient.x, client.y - current.startClient.y) <= 1e-7
      const shifted = result.geo[0] !== current.startGeo[0] || result.geo[1] !== current.startGeo[1]
      if (!returnedToStart && shifted) emit('vertex-drag-end', { kind: current.kind, id: current.id, index: current.index, lon: result.geo[0], lat: result.geo[1] })
    }
  } else if (current.type === 'pan' && !current.moved && props.tool === 'select') {
    emit('clear-selection')
  }
  preview.value = null
  gesture.value = null
}

function onPointerCancel(event: PointerEvent) {
  activePointers.delete(event.pointerId)
  cancelGesture(true)
  if (activePointers.size === 0) suppressUntilAllUp = false
}

function onDblClick(event: MouseEvent) {
  if (props.disabled || props.tool !== 'select' || !props.registration) return
  const targets = hitTargets({ x: event.clientX, y: event.clientY })
  const [target] = targets
  if (!target || target.type !== 'vertex' || target.kind === 'place') return
  const key = `${target.kind}:${target.id}:${target.index}`
  const now = Date.now()
  const same = lastDeleteClick.valid && lastDeleteClick.key === key && now - lastDeleteClick.at < 600
  if (!same) return
  lastDeleteClick.valid = false
  emit('delete-vertex', { kind: target.kind, id: target.id, index: target.index })
}

function onWheel(event: WheelEvent) {
  if (props.disabled) return
  const isFocused = typeof document === 'undefined' ? focused.value : document.activeElement === svgEl.value?.parentElement
  if (!isFocused) return
  event.preventDefault()
  const rect = layoutRect()
  if (!rect) return
  const next = clamp(props.view.zoom * Math.pow(ZOOM_STEP, -event.deltaY / 100), ZOOM_MIN, ZOOM_MAX)
  emit('view', zoomAround({ x: event.clientX, y: event.clientY }, rect, props.size, props.view, next))
}

function zoomCenter(nextZoom: number) {
  const rect = layoutRect()
  if (!rect || props.disabled) return
  emit('view', zoomAtCenter(rect, props.size, props.view, nextZoom))
}

function resetView() {
  if (!props.disabled) emit('view', { ...DEFAULT_VIEW })
}

function nudge(dx: number, dy: number) {
  const rect = layoutRect()
  if (!rect || props.disabled) return
  emit('view', panBy(dx, dy, rect, props.size, props.view))
}

function fitSelected() {
  const rect = layoutRect()
  if (!rect) return
  const shape = props.shapes.find(item => item.id === props.selected?.id)
  const pixels = shape ? vertexEntries(shape).map(entry => entry.vb) : []
  if (!pixels.length) {
    resetView()
    return
  }
  const xs = pixels.map(pixel => pixel[0])
  const ys = pixels.map(pixel => pixel[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  emit('view', fitBox({ x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }, rect, props.size))
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    cancelGesture(true)
    emit('escape')
    event.stopPropagation()
    return
  }
  if (event.key === ' ') {
    spaceHeld.value = true
    event.preventDefault()
    return
  }
  if (event.key === '+' || event.key === '=') return zoomCenter(props.view.zoom * ZOOM_STEP)
  if (event.key === '-' || event.key === '_') return zoomCenter(props.view.zoom / ZOOM_STEP)
  if (event.key === '0') return resetView()
  if (event.key === 'ArrowLeft') { nudge(-PAN_STEP_PX, 0); event.preventDefault(); return }
  if (event.key === 'ArrowRight') { nudge(PAN_STEP_PX, 0); event.preventDefault(); return }
  if (event.key === 'ArrowUp') { nudge(0, -PAN_STEP_PX); event.preventDefault(); return }
  if (event.key === 'ArrowDown') { nudge(0, PAN_STEP_PX); event.preventDefault(); return }
}

function onKeyup(event: KeyboardEvent) {
  if (event.key === ' ') spaceHeld.value = false
}

function onFocus() {
  focused.value = true
}

function onBlur() {
  focused.value = false
  spaceHeld.value = false
  cancelGesture(true)
}

/** 拖拽预览时被拖顶点显示在预览位置（闭合面首尾重复点一起走） */
function displayVertex(shape: CanvasShape, index: number, vb: [number, number]): [number, number] {
  if (!preview.value || preview.value.id !== shape.id) return vb
  const closed = shape.kind === 'region' && shape.points.length > vertexCount('region', shape.points)
  const lastIndex = shape.points.length - 1
  if (index === preview.value.index) return preview.value.vb
  if (closed && preview.value.index === 0 && index === lastIndex) return preview.value.vb
  if (closed && preview.value.index === lastIndex && index === 0) return preview.value.vb
  return vb
}

/** 拖拽预览的形状折线：用被拖位置串起所有可见顶点，提交后回到同源平滑曲线 */
function previewAttr(shape: CanvasShape): string {
  if (!preview.value || preview.value.id !== shape.id) return shape.attr
  return vertexEntries(shape)
    .map(entry => displayVertex(shape, entry.index, entry.vb))
    .map(point => `${point[0]},${point[1]}`)
    .join(' ')
}


function placePixel(shape: CanvasShape): [number, number] | null {
  const pixel = geoToPixel(props.registration, shape.points[0]?.[0] ?? 0, shape.points[0]?.[1] ?? 0)
  return pixel ? displayVertex(shape, 0, pixel) : null
}

const draftPixels = computed(() => (props.draft && props.draft.kind === props.tab ? props.draft.points : []).map(point => geoToPixel(props.registration, point[0], point[1])).filter((pixel): pixel is [number, number] => !!pixel))
const draftAttr = computed(() => draftPixels.value.map(point => `${point[0]},${point[1]}`).join(' '))

const selectedEdgeMidpoint = computed<[number, number] | null>(() => {
  if (!props.selectedEdge) return null
  const shape = props.shapes.find(item => item.id === props.selectedEdge!.id)
  if (!shape || shape.kind === 'place') return null
  const count = vertexCount(shape.kind, shape.points)
  const a = geoToPixel(props.registration, shape.points[props.selectedEdge.segment]?.[0] ?? 0, shape.points[props.selectedEdge.segment]?.[1] ?? 0)
  const b = geoToPixel(props.registration, shape.points[(props.selectedEdge.segment + 1) % count]?.[0] ?? 0, shape.points[(props.selectedEdge.segment + 1) % count]?.[1] ?? 0)
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null
})

const instruction = computed(() => {
  if (!props.registration) return t('mapStudio.editor.canvasNoRegistration')
  if (props.tool === 'pan') return t('mapStudio.editor.hintPan')
  if (props.tool === 'draw') return props.tab === 'place' ? t('mapStudio.editor.hintDrawPlace') : t('mapStudio.editor.hintDrawShape')
  return t('mapStudio.editor.selectHelp')
})

function onBaseLoad(event: Event) {
  const img = event.target
  if (img instanceof HTMLImageElement) emit('base-size', { width: img.naturalWidth, height: img.naturalHeight })
}
</script>

<template>
  <div class="geo-canvas" :class="[`is-tool-${tool}`, { 'is-disabled': disabled }]">
    <div class="geo-canvas-bar">
      <div class="geo-zoom" role="group" :aria-label="t('mapStudio.editor.zoomGroup')">
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.zoomIn')" @click="zoomCenter(view.zoom * 1.2)">+</button>
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.zoomOut')" @click="zoomCenter(view.zoom / 1.2)">−</button>
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.zoomReset')" @click="resetView">{{ t('mapStudio.editor.zoomResetShort') }}</button>
        <button type="button" class="geo-view-btn" :disabled="disabled || !selected" :aria-label="t('mapStudio.editor.fitSelected')" @click="fitSelected">{{ t('mapStudio.editor.fitSelectedShort') }}</button>
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.panLeft')" @click="nudge(-40, 0)">←</button>
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.panRight')" @click="nudge(40, 0)">→</button>
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.panUp')" @click="nudge(0, -40)">↑</button>
        <button type="button" class="geo-view-btn" :disabled="disabled" :aria-label="t('mapStudio.editor.panDown')" @click="nudge(0, 40)">↓</button>
        <output class="geo-zoom-value">{{ Math.round(view.zoom * 100) }}%</output>
      </div>
    </div>

    <div
      class="geo-stage"
      :style="{ aspectRatio: `${size.width} / ${size.height}`, minHeight: '320px' }"
      tabindex="0"
      role="application"
      :aria-label="t('mapStudio.editor.canvasLabel', { tool: t(`mapStudio.editor.tool.${tool}`) })"
      :aria-disabled="disabled"
      @keydown="onKeydown"
      @keyup="onKeyup"
      @focus="onFocus"
      @blur="onBlur"
      @wheel="onWheel"
    >
      <img v-if="baseUrl" :src="baseUrl" style="display:none" :alt="t('mapStudio.editor.title')" @load="onBaseLoad" />
      <svg
        ref="svgEl"
        class="geo-overlay"
        :viewBox="`0 0 ${size.width} ${size.height}`"
        preserveAspectRatio="xMidYMid meet"
        @pointerdown="startPointer"
        @pointermove="onPointerMove"
        @pointerup="finishPointer"
        @pointercancel="onPointerCancel"
        @dblclick="onDblClick"
      >
        <g :transform="viewTransform(size, view)">
          <image :href="baseUrl" :width="size.width" :height="size.height" class="geo-base" />
          <template v-for="shape in activeShapes" :key="`${shape.kind}-${shape.id}`">
            <polygon
              v-if="shape.kind === 'region'"
              :points="previewAttr(shape)"
              :class="['geo-region', { 'is-active': selected?.kind === 'region' && selected.id === shape.id, 'is-dataset': shape.dataset, 'is-pending': shape.pending }]"
              :stroke-width="unit * 1.2"
            ><title>{{ shape.name }}</title></polygon>
            <polyline
              v-if="shape.kind === 'route'"
              :points="previewAttr(shape)"
              :class="['geo-route', { 'is-active': selected?.kind === 'route' && selected.id === shape.id, 'is-dataset': shape.dataset, 'is-pending': shape.pending }]"
              :stroke-width="unit * 1.8"
            ><title>{{ shape.name }}</title></polyline>
            <circle
              v-if="shape.kind === 'place' && placePixel(shape)"
              :cx="placePixel(shape)![0]"
              :cy="placePixel(shape)![1]"
              :r="handleRadius"
              :class="['geo-place', { 'is-active': selected?.kind === 'place' && selected.id === shape.id, 'is-pending': shape.pending, 'is-dataset': shape.dataset }]"
            ><title>{{ shape.name }}</title></circle>
            <template v-if="shape.kind !== 'place'">
              <circle
                v-for="entry in vertexEntries(shape).slice(0, vertexCount(shape.kind, shape.points))"
                :key="`v-${shape.id}-${entry.index}`"
                :cx="displayVertex(shape, entry.index, entry.vb)[0]"
                :cy="displayVertex(shape, entry.index, entry.vb)[1]"
                :r="handleRadius"
                :class="['geo-vertex', { 'is-selected': selectedVertex?.kind === shape.kind && selectedVertex.id === shape.id && selectedVertex.index === entry.index }]"
              />
            </template>
            <text
              v-if="shape.kind !== 'place' && placePixel(shape) && selected?.id === shape.id"
              :x="placePixel(shape)![0] + unit * 3"
              :y="placePixel(shape)![1] - unit * 2"
              :font-size="unit * 4"
              class="geo-text"
            >{{ shape.name }}</text>
          </template>

          <g v-if="selectedEdgeMidpoint" class="geo-midpoint">
            <circle :cx="selectedEdgeMidpoint[0]" :cy="selectedEdgeMidpoint[1]" :r="handleRadius" class="geo-midpoint-ring" />
            <path :d="`M ${selectedEdgeMidpoint[0] - unit * 1.4} ${selectedEdgeMidpoint[1]} h ${unit * 2.8} M ${selectedEdgeMidpoint[0]} ${selectedEdgeMidpoint[1] - unit * 1.4} v ${unit * 2.8}`" class="geo-midpoint-cross" />
          </g>

          <g v-if="draftPixels.length">
            <polyline :points="draftAttr" class="geo-draft" :stroke-width="unit * 1.6" />
            <circle v-for="(point, index) in draftPixels" :key="`dv-${index}`" :cx="point[0]" :cy="point[1]" :r="handleRadius" class="geo-draft-vertex" />
          </g>
        </g>
      </svg>
    </div>
    <p class="geo-canvas-hint">{{ instruction }}</p>
  </div>
</template>

<style scoped>
.geo-canvas { display: flex; flex-direction: column; gap: 4px; }
.geo-canvas-bar { display: flex; flex-wrap: wrap; gap: 6px; }
.geo-zoom { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.geo-view-btn {
  min-width: 32px;
  min-height: 32px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 11px var(--font-body);
  cursor: pointer;
}
.geo-view-btn:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.geo-view-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.geo-zoom-value { margin-left: 4px; font: 500 10px var(--font-mono, var(--font-body)); color: var(--text-2); }
.geo-stage {
  position: relative;
  width: 100%;
  min-width: 320px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  outline: none;
  touch-action: none;
}
.geo-stage:focus-visible { outline: 2px solid var(--accent-text); outline-offset: -2px; }
.is-tool-draw .geo-stage, .is-tool-draw .geo-overlay { cursor: crosshair; }
.is-tool-pan .geo-stage, .is-tool-pan .geo-overlay { cursor: grab; }
.geo-base { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
.geo-overlay { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.geo-region { fill: var(--accent-text); fill-opacity: 0.14; stroke: var(--accent-text); }
.geo-region.is-active { fill-opacity: 0.26; }
.geo-region.is-dataset { fill: #8d7bd8; fill-opacity: 0.16; stroke: #8d7bd8; stroke-dasharray: 5 3; }
.geo-region.is-pending, .geo-route.is-pending { stroke: #cf3e32; stroke-dasharray: 8 5; }
.geo-route { fill: none; stroke: #e2703a; stroke-linecap: round; stroke-linejoin: round; }
.geo-route.is-active { stroke: var(--accent-text); }
.geo-route.is-dataset { stroke: #8d7bd8; stroke-dasharray: 6 3; }
.geo-place { fill: #4fc3f7; }
.geo-place.is-pending { fill: #ffb74d; }
.geo-place.is-dataset { fill: #8d7bd8; stroke: var(--bg-1); stroke-width: 1.2; stroke-dasharray: 2.5 2; }
.geo-place.is-active { stroke: var(--text-1); stroke-width: 1.5; }
.geo-vertex { fill: var(--bg-1); stroke: var(--text-1); stroke-width: 1.2; }
.geo-vertex.is-selected { fill: var(--accent-text); stroke: var(--text-1); }
.geo-draft { fill: none; stroke: var(--accent-text); stroke-dasharray: 6 4; }
.geo-draft-vertex { fill: var(--accent-text); }
.geo-midpoint-ring { fill: var(--bg-1); stroke: var(--accent-text); stroke-width: 1; }
.geo-midpoint-cross { fill: none; stroke: var(--accent-text); stroke-width: 1; pointer-events: none; }
.geo-text { fill: var(--text-1); paint-order: stroke; stroke: var(--bg-1); stroke-width: 2; pointer-events: none; }
.geo-canvas-hint { margin: 0; font-size: 10.5px; color: var(--text-2); }
</style>
