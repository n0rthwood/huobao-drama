<template>
  <div class="geo">
    <div class="geo-bar">
      <strong class="geo-title">{{ t('episode.documentary.map.editor.title') }}</strong>
      <div class="geo-tools">
        <button
          v-for="tool in TOOLS"
          :key="tool"
          type="button"
          class="geo-tool"
          :class="{ 'is-on': mode === tool }"
          :aria-pressed="mode === tool"
          :disabled="disabled || (tool !== 'select' && !registration)"
          @click="setMode(tool)"
        >
          {{ t(`episode.documentary.map.editor.tool.${tool}`) }}
        </button>
        <button v-if="draft" type="button" class="geo-tool" :disabled="draft.points.length < minPoints" @click="commitDraft">
          {{ t('episode.documentary.map.editor.finishShape', { n: draft.points.length }) }}
        </button>
        <button v-if="draft" type="button" class="geo-tool" @click="draft = null">
          {{ t('episode.documentary.map.editor.cancelShape') }}
        </button>
      </div>
      <span v-if="cursorGeo" class="geo-cursor">{{ t('episode.documentary.map.editor.cursor', { lon: cursorGeo[0].toFixed(4), lat: cursorGeo[1].toFixed(4) }) }}</span>
    </div>

    <p class="geo-hint">{{ modeHint }}</p>
    <p v-if="registration" class="geo-hint dim">{{ t('episode.documentary.map.editor.registration', { mode: t(`episode.documentary.map.baseMode.${registration.mode}`), detail: registrationSummary(registration) }) }}</p>
    <p v-else class="geo-warn">{{ t('episode.documentary.map.editor.noRegistration') }}</p>

    <div v-if="baseUrl" class="geo-stage" :class="{ 'is-drawing': mode !== 'select' }">
      <img :src="baseUrl" class="geo-base" :alt="t('episode.documentary.map.editor.title')" @load="onBaseLoad" />
      <svg
        v-if="viewWidth > 0"
        ref="svgEl"
        class="geo-overlay"
        :viewBox="`0 0 ${viewWidth} ${viewHeight}`"
        preserveAspectRatio="xMidYMid meet"
        @pointerdown="onStagePointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="onPointerUp"
      >
        <g v-for="region in regionShapes" :key="`rg-${region.id}`">
          <polygon
            :points="region.attr"
            :class="['geo-region', { 'is-active': selected?.kind === 'region' && selected.id === region.id }]"
            :stroke-width="unit * 1.2"
          ><title>{{ region.name }}</title></polygon>
          <circle
            v-for="(pt, i) in region.pixels"
            :key="`rgv-${region.id}-${i}`"
            :cx="pt[0]"
            :cy="pt[1]"
            :r="unit * 2.4"
            class="geo-vertex"
            @pointerdown.stop="startDrag('region', region.id, i, $event)"
            @dblclick.stop="removeVertex('region', region.id, i)"
          />
          <text v-if="region.pixels[0] && selected?.kind === 'region' && selected.id === region.id" :x="region.pixels[0][0] + unit * 3" :y="region.pixels[0][1] - unit * 2" :font-size="unit * 4" class="geo-text">{{ region.name }}</text>
        </g>

        <g v-for="route in routeShapes" :key="`rt-${route.id}`">
          <polyline
            :points="route.attr"
            :class="['geo-route', { 'is-active': selected?.kind === 'route' && selected.id === route.id }]"
            :stroke-width="unit * 1.8"
          ><title>{{ route.name }}</title></polyline>
          <circle
            v-for="(pt, i) in route.pixels"
            :key="`rtv-${route.id}-${i}`"
            :cx="pt[0]"
            :cy="pt[1]"
            :r="unit * 2.4"
            class="geo-vertex"
            @pointerdown.stop="startDrag('route', route.id, i, $event)"
            @dblclick.stop="removeVertex('route', route.id, i)"
          />
          <text v-if="route.pixels[0] && selected?.kind === 'route' && selected.id === route.id" :x="route.pixels[0][0] + unit * 3" :y="route.pixels[0][1] - unit * 2" :font-size="unit * 4" class="geo-text">{{ route.name }}</text>
        </g>

        <g v-for="place in placeShapes" :key="`pl-${place.id}`">
          <circle
            :cx="place.at[0]"
            :cy="place.at[1]"
            :r="unit * 3"
            :class="['geo-place', { 'is-active': selected?.kind === 'place' && selected.id === place.id, 'is-proposed': place.proposed }]"
            @pointerdown.stop="startDrag('place', place.id, 0, $event)"
          ><title>{{ place.name }}</title></circle>
          <text v-if="selected?.kind === 'place' && selected.id === place.id" :x="place.at[0] + unit * 4" :y="place.at[1] + unit * 3" :font-size="unit * 4" class="geo-text">{{ place.name }}</text>
        </g>

        <g v-if="draftPixels.length">
          <polyline :points="draftAttr" class="geo-draft" :stroke-width="unit * 1.6" />
          <circle v-for="(pt, i) in draftPixels" :key="`dv-${i}`" :cx="pt[0]" :cy="pt[1]" :r="unit * 2.4" class="geo-draft-vertex" />
        </g>
      </svg>
    </div>
    <p v-else class="geo-empty dim">{{ t('episode.documentary.map.editor.noBase') }}</p>

    <p v-if="offscreenCount" class="geo-warn">{{ t('episode.documentary.map.editor.offscreen', { n: offscreenCount }) }}</p>

    <div class="geo-lists">
      <section class="geo-list">
        <header class="geo-list-head">
          <strong>{{ t('episode.documentary.map.editor.placesTitle', { n: spec.places.length }) }}</strong>
          <button type="button" class="geo-tool" :disabled="disabled || !registration" @click="setMode('place')">{{ t('episode.documentary.map.editor.tool.place') }}</button>
        </header>
        <p v-if="!spec.places.length" class="geo-empty dim">{{ t('episode.documentary.map.editor.empty') }}</p>
        <ul v-else class="geo-items">
          <li
            v-for="(place, index) in spec.places"
            :key="place.id"
            class="geo-item"
            :class="{ 'is-active': selected?.kind === 'place' && selected.id === place.id }"
            @click="selected = { kind: 'place', id: place.id }"
          >
            <input class="input geo-name" :value="place.name" :disabled="disabled" :placeholder="t('episode.documentary.map.editor.name')" @input="setName('place', index, $event)" />
            <label class="geo-num"><span>{{ t('episode.documentary.map.editor.lon') }}</span>
              <input class="input" type="number" step="0.0001" :value="place.lon" :disabled="disabled" @input="setPlaceCoord(index, 'lon', $event)" />
            </label>
            <label class="geo-num"><span>{{ t('episode.documentary.map.editor.lat') }}</span>
              <input class="input" type="number" step="0.0001" :value="place.lat" :disabled="disabled" @input="setPlaceCoord(index, 'lat', $event)" />
            </label>
            <span v-if="place.proposed" class="geo-badge">{{ t('episode.documentary.map.editor.proposed') }}</span>
            <button v-if="place.proposed" type="button" class="geo-tool" :disabled="disabled" @click.stop="accept('place', index)">{{ t('episode.documentary.map.editor.accept') }}</button>
            <button type="button" class="geo-del" :disabled="disabled" :aria-label="t('episode.documentary.map.editor.remove')" @click.stop="removeFeature('place', index)">
              <X :size="12" />
            </button>
          </li>
        </ul>
      </section>

      <section v-for="section in linearSections" :key="section.kind" class="geo-list">
        <header class="geo-list-head">
          <strong>{{ t(`episode.documentary.map.editor.${section.kind}sTitle`, { n: section.items.length }) }}</strong>
          <button type="button" class="geo-tool" :disabled="disabled || !registration" @click="setMode(section.kind)">{{ t(`episode.documentary.map.editor.tool.${section.kind}`) }}</button>
        </header>
        <p v-if="!section.items.length" class="geo-empty dim">{{ t('episode.documentary.map.editor.empty') }}</p>
        <ul v-else class="geo-items">
          <li
            v-for="(shape, index) in section.items"
            :key="shape.id"
            class="geo-item"
            :class="{ 'is-active': selected?.kind === section.kind && selected.id === shape.id }"
            @click="selected = { kind: section.kind, id: shape.id }"
          >
            <input class="input geo-name" :value="shape.name" :disabled="disabled" :placeholder="t('episode.documentary.map.editor.name')" @input="setName(section.kind, index, $event)" />
            <span class="geo-count">{{ t('episode.documentary.map.editor.pointCount', { n: vertexCount(section.kind, shape.points) }) }}</span>
            <span v-if="shape.proposed" class="geo-badge">{{ t('episode.documentary.map.editor.proposed') }}</span>
            <button v-if="shape.proposed" type="button" class="geo-tool" :disabled="disabled" @click.stop="accept(section.kind, index)">{{ t('episode.documentary.map.editor.accept') }}</button>
            <button type="button" class="geo-tool" :disabled="disabled || !registration" @click.stop="continueShape(section.kind, shape.id)">{{ t('episode.documentary.map.editor.continueShape') }}</button>
            <button type="button" class="geo-del" :disabled="disabled" :aria-label="t('episode.documentary.map.editor.remove')" @click.stop="removeFeature(section.kind, index)">
              <X :size="12" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图几何直接编辑器（Issue #84）。
 *
 * 几何真值是 map_spec 里的经纬度，画布只是某一张底图的投影视图：拖点、加线、加面都先把像素按该底图的
 * registration 反投影成经纬度再写回 spec，所以换底图（程序投影 / Earth 相机 / 外部标定图）后同一份几何仍然对得上。
 * 没有 registration 就只允许按数值编辑，绝不按 bbox 线性猜一个像素映射。
 */
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'
import type { MapRegion, MapRoute, MapSpec } from '~/composables/useApi'
import { geoToPixel, pixelToGeo, registrationSummary, type MapRegistration } from '~/utils/mapRegistration'
import { mediaUrl } from '~/utils/url'

const { t } = useI18n()

const props = defineProps<{
  spec: MapSpec
  persistedSpec: MapSpec | null
  registration: MapRegistration | null
  baseImage: { path: string; width: number; height: number } | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', spec: MapSpec): void
  (e: 'base-size', size: { width: number; height: number }): void
}>()

type LinearKind = 'route' | 'region'
type FeatureKind = 'place' | LinearKind
type ToolMode = 'select' | FeatureKind

const TOOLS: ToolMode[] = ['select', 'place', 'route', 'region']

const mode = ref<ToolMode>('select')
const selected = ref<{ kind: FeatureKind; id: string } | null>(null)
const cursorGeo = ref<[number, number] | null>(null)
const draft = ref<{ kind: LinearKind; id: string | null; points: Array<[number, number]> } | null>(null)
const dragging = ref<{ kind: FeatureKind; id: string; index: number } | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const naturalSize = ref({ width: 0, height: 0 })

const link = useDeeplink('mapGeometry', DEEPLINK_KEYS.mapGeometry)
function hasFeature(spec: MapSpec | null, feature: { kind: FeatureKind; id: string }): boolean {
  const list = feature.kind === 'place' ? spec?.places : feature.kind === 'route' ? spec?.routes : spec?.regions
  return !!list?.some(item => item.id === feature.id)
}
const initialFocus = link.initial('mfocus')
if (initialFocus) {
  const match = /^(place|route|region):(.+)$/.exec(initialFocus)
  const kind = match?.[1]
  const id = match?.[2]
  if ((kind === 'place' || kind === 'route' || kind === 'region') && id && hasFeature(props.persistedSpec, { kind, id })) {
    selected.value = { kind, id }
  } else {
    toast.warning(t('deeplink.missing'))
  }
}
let focusOnLoad = Boolean(initialFocus && selected.value)
watch([selected, () => props.spec, () => props.persistedSpec], () => {
  const feature = selected.value
  if (feature && !hasFeature(props.spec, feature)) {
    selected.value = null
    link.set({})
    return
  }
  link.set({ mfocus: feature && hasFeature(props.persistedSpec, feature) ? `${feature.kind}:${feature.id}` : '' })
}, { immediate: true })

const baseUrl = computed(() => (props.baseImage?.path ? mediaUrl(props.baseImage.path) : ''))
const viewWidth = computed(() => props.registration?.width || props.baseImage?.width || naturalSize.value.width)
const viewHeight = computed(() => props.registration?.height || props.baseImage?.height || naturalSize.value.height)
// 笔画粗细随底图尺寸走，1920 宽和 960 宽上看起来一样
const unit = computed(() => Math.max(viewWidth.value, viewHeight.value) / 400)
const minPoints = computed(() => (draft.value?.kind === 'region' ? 3 : 2))

const modeHint = computed(() => {
  if (!props.registration) return t('episode.documentary.map.editor.hintNumbersOnly')
  if (mode.value === 'select') return t('episode.documentary.map.editor.hintSelect')
  if (mode.value === 'place') return t('episode.documentary.map.editor.hintPlace')
  return t('episode.documentary.map.editor.hintShape')
})

function pixelOf(lon: number, lat: number): [number, number] | null {
  return geoToPixel(props.registration, lon, lat)
}

const placeShapes = computed(() => props.spec.places.flatMap((place) => {
  const at = pixelOf(place.lon, place.lat)
  return at ? [{ id: place.id, name: place.name, at, proposed: !!place.proposed }] : []
}))

function vertexCount(kind: LinearKind, points: Array<[number, number]>): number {
  const first = points[0], last = points[points.length - 1]
  return points.length - (kind === 'region' && points.length > 1 && first && last && first[0] === last[0] && first[1] === last[1] ? 1 : 0)
}

function shapesOf(list: Array<MapRoute | MapRegion>, kind: LinearKind) {
  return list.map((shape) => {
    const pixels: Array<[number, number]> = []
    const count = vertexCount(kind, shape.points)
    for (let index = 0; index < count; index++) {
      const point = shape.points[index]!
      const pixel = pixelOf(point[0], point[1])
      if (pixel) pixels.push(pixel)
    }
    return { id: shape.id, name: shape.name, pixels, attr: pixels.map(pt => `${pt[0]},${pt[1]}`).join(' ') }
  }).filter(shape => shape.pixels.length >= 2)
}

const routeShapes = computed(() => shapesOf(props.spec.routes, 'route'))
const regionShapes = computed(() => shapesOf(props.spec.regions, 'region'))
const linearSections = computed(() => [
  { kind: 'route' as LinearKind, items: props.spec.routes },
  { kind: 'region' as LinearKind, items: props.spec.regions },
])
const draftPixels = computed(() => (draft.value?.points ?? []).map(pt => pixelOf(pt[0], pt[1])).filter((pt): pt is [number, number] => !!pt))
const draftAttr = computed(() => draftPixels.value.map(pt => `${pt[0]},${pt[1]}`).join(' '))

/** 视野外的要素必须明说：Earth 底图里地球背面的点根本投不出来，不能悄悄吞掉 */
const offscreenCount = computed(() => {
  if (!props.registration) return 0
  let missing = props.spec.places.length - placeShapes.value.length
  missing += props.spec.routes.length - routeShapes.value.length
  missing += props.spec.regions.length - regionShapes.value.length
  return Math.max(0, missing)
})

function onBaseLoad(event: Event) {
  const img = event.target
  if (!(img instanceof HTMLImageElement)) return
  naturalSize.value = { width: img.naturalWidth, height: img.naturalHeight }
  // 外部原件还没经后端出图时，控制点配准要用这张图的真实像素尺寸
  emit('base-size', { width: img.naturalWidth, height: img.naturalHeight })
  if (focusOnLoad && link.initial('mfocus')) {
    focusOnLoad = false
    void nextTick(() => svgEl.value?.scrollIntoView({ block: 'center' }))
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function cloneSpec(): MapSpec {
  return {
    ...props.spec,
    places: props.spec.places.map(place => ({ ...place })),
    routes: props.spec.routes.map(route => ({ ...route, points: route.points.map(pt => [pt[0], pt[1]] as [number, number]) })),
    regions: props.spec.regions.map(region => ({ ...region, points: region.points.map(pt => [pt[0], pt[1]] as [number, number]) })),
  }
}

function setMode(next: ToolMode) {
  mode.value = next
  if (next === 'select' || next === 'place') draft.value = null
  else if (!draft.value || draft.value.kind !== next) draft.value = { kind: next, id: null, points: [] }
}

/** 把已有线/面接着画下去：点进来的那条进草稿，收尾时写回同一个 id */
function continueShape(kind: LinearKind, id: string) {
  const list = kind === 'route' ? props.spec.routes : props.spec.regions
  const shape = list.find(item => item.id === id)
  if (!shape) return
  mode.value = kind
  selected.value = { kind, id }
  const points: Array<[number, number]> = []
  const count = vertexCount(kind, shape.points)
  for (let index = 0; index < count; index++) {
    const point = shape.points[index]!
    points.push([point[0], point[1]])
  }
  draft.value = { kind, id, points }
}

function eventGeo(event: PointerEvent | MouseEvent): [number, number] | null {
  const svg = svgEl.value
  if (!svg || !props.registration) return null
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  // preserveAspectRatio=meet：viewBox 等比居中，先还原出信箱边距再换算像素
  const scale = Math.min(rect.width / viewWidth.value, rect.height / viewHeight.value)
  const offsetX = (rect.width - viewWidth.value * scale) / 2
  const offsetY = (rect.height - viewHeight.value * scale) / 2
  const x = (event.clientX - rect.left - offsetX) / scale
  const y = (event.clientY - rect.top - offsetY) / scale
  return pixelToGeo(props.registration, x, y)
}

function onStagePointerDown(event: PointerEvent) {
  if (props.disabled || mode.value === 'select') return
  const geo = eventGeo(event)
  if (!geo) return
  if (mode.value === 'place') {
    const next = cloneSpec()
    const place = { id: newId('place'), name: '', lon: Number(geo[0].toFixed(5)), lat: Number(geo[1].toFixed(5)) }
    next.places.push(place)
    selected.value = { kind: 'place', id: place.id }
    emit('update', next)
    return
  }
  if (!draft.value || draft.value.kind !== mode.value) draft.value = { kind: mode.value, id: null, points: [] }
  draft.value.points.push([Number(geo[0].toFixed(5)), Number(geo[1].toFixed(5))])
}

function commitDraft() {
  const current = draft.value
  if (!current || current.points.length < (current.kind === 'region' ? 3 : 2)) return
  const next = cloneSpec()
  const list = current.kind === 'route' ? next.routes : next.regions
  const existing = current.id ? list.find(item => item.id === current.id) : null
  if (existing) existing.points = current.points
  else {
    const shape = { id: newId(current.kind), name: '', points: current.points }
    list.push(shape)
    selected.value = { kind: current.kind, id: shape.id }
  }
  draft.value = null
  mode.value = 'select'
  emit('update', next)
}

function startDrag(kind: FeatureKind, id: string, index: number, event: PointerEvent) {
  if (props.disabled || mode.value !== 'select') return
  selected.value = { kind, id }
  dragging.value = { kind, id, index }
  const target = event.target
  if (target instanceof Element && target.setPointerCapture) target.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const geo = eventGeo(event)
  cursorGeo.value = geo
  const drag = dragging.value
  if (!drag || !geo || props.disabled) return
  const next = cloneSpec()
  const lon = Number(geo[0].toFixed(5))
  const lat = Number(geo[1].toFixed(5))
  if (drag.kind === 'place') {
    const place = next.places.find(item => item.id === drag.id)
    if (!place) return
    place.lon = lon
    place.lat = lat
  } else {
    const list = drag.kind === 'route' ? next.routes : next.regions
    const shape = list.find(item => item.id === drag.id)
    const point = shape?.points[drag.index]
    if (!shape || !point) return
    const closed = drag.kind === 'region' && vertexCount('region', shape.points) < shape.points.length
    point[0] = lon
    point[1] = lat
    if (closed && drag.index === 0) {
      const last = shape.points[shape.points.length - 1]!
      last[0] = lon
      last[1] = lat
    }
  }
  emit('update', next)
}

function onPointerUp() {
  dragging.value = null
}

function removeVertex(kind: LinearKind, id: string, index: number) {
  if (props.disabled) return
  const next = cloneSpec()
  const list = kind === 'route' ? next.routes : next.regions
  const shape = list.find(item => item.id === id)
  if (!shape) return
  const count = vertexCount(kind, shape.points)
  if (count <= (kind === 'region' ? 3 : 2)) return
  const closed = kind === 'region' && count < shape.points.length
  shape.points.splice(index, 1)
  if (closed) {
    const first = shape.points[0]!, last = shape.points[shape.points.length - 1]!
    last[0] = first[0]
    last[1] = first[1]
  }
  emit('update', next)
}

function removeFeature(kind: FeatureKind, index: number) {
  if (props.disabled) return
  const next = cloneSpec()
  if (kind === 'place') next.places.splice(index, 1)
  else if (kind === 'route') next.routes.splice(index, 1)
  else next.regions.splice(index, 1)
  emit('update', next)
}

/** 采纳 AI 候选：去掉 proposed 标记就是人工背书，之后它和手画的几何一视同仁 */
function accept(kind: FeatureKind, index: number) {
  const next = cloneSpec()
  const item = kind === 'place' ? next.places[index] : kind === 'route' ? next.routes[index] : next.regions[index]
  if (!item) return
  delete item.proposed
  emit('update', next)
}

function setName(kind: FeatureKind, index: number, event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const next = cloneSpec()
  const item = kind === 'place' ? next.places[index] : kind === 'route' ? next.routes[index] : next.regions[index]
  if (!item) return
  item.name = target.value
  emit('update', next)
}

function setPlaceCoord(index: number, axis: 'lon' | 'lat', event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const value = Number(target.value)
  if (!Number.isFinite(value)) return
  const next = cloneSpec()
  const place = next.places[index]
  if (!place) return
  place[axis] = value
  emit('update', next)
}
</script>

<style scoped>
.geo { display: flex; flex-direction: column; gap: 8px; }
.geo-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.geo-title { font: 600 12px var(--font-body); color: var(--text-1); }
.geo-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.geo-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.geo-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.geo-tool.is-on { color: var(--accent-text); border-color: var(--accent-text); background: var(--accent-soft, transparent); }
.geo-tool:disabled { opacity: 0.5; cursor: not-allowed; }
.geo-cursor { margin-left: auto; font: 500 10.5px var(--font-mono, var(--font-body)); color: var(--text-2); }
.geo-hint { margin: 0; font-size: 10.5px; color: var(--text-2); }
.geo-warn {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.geo-empty { margin: 0; font-size: 10.5px; }
.geo-stage {
  position: relative;
  width: 100%;
  min-width: 360px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.geo-stage.is-drawing { cursor: crosshair; }
.geo-base { display: block; width: 100%; height: auto; }
.geo-overlay { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.geo-region { fill: var(--accent-text); fill-opacity: 0.14; stroke: var(--accent-text); }
.geo-region.is-active { fill-opacity: 0.26; }
.geo-route { fill: none; stroke: #e2703a; stroke-linecap: round; stroke-linejoin: round; }
.geo-route.is-active { stroke: var(--accent-text); }
.geo-place { fill: #4fc3f7; cursor: grab; }
.geo-place.is-proposed { fill: #ffb74d; }
.geo-place.is-active { stroke: var(--text-1); stroke-width: 1.5; }
.geo-vertex { fill: var(--surface); stroke: var(--text-1); stroke-width: 1; cursor: grab; }
.geo-draft { fill: none; stroke: var(--accent-text); stroke-dasharray: 6 4; }
.geo-draft-vertex { fill: var(--accent-text); }
.geo-text { fill: var(--text-1); paint-order: stroke; stroke: var(--surface); stroke-width: 2; pointer-events: none; }
.geo-lists {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 10px;
}
.geo-list { display: flex; flex-direction: column; gap: 5px; }
.geo-list-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--text-1); }
.geo-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.geo-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  font-size: 10.5px;
  cursor: pointer;
}
.geo-item.is-active { border-color: var(--accent-text); }
.geo-name { flex: 1 1 140px; min-width: 120px; }
.geo-num { display: inline-flex; align-items: center; gap: 3px; }
.geo-num .input { width: 92px; }
.geo-count { color: var(--text-2); }
.geo-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font-weight: 600;
}
.geo-del {
  flex: none;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.geo-del:hover:not(:disabled) { background: var(--action-danger); color: #fff; }
</style>
