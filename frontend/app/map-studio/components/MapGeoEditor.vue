<template>
  <div class="geo">
    <div class="geo-bar">
      <strong class="geo-title">{{ t('mapStudio.editor.title') }}</strong>
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
          {{ t(`mapStudio.editor.tool.${tool}`) }}
        </button>
        <button v-if="draft" type="button" class="geo-tool" :disabled="draft.points.length < minPoints" @click="commitDraft">
          {{ t('mapStudio.editor.finishShape', { n: draft.points.length }) }}
        </button>
        <button v-if="draft" type="button" class="geo-tool" @click="draft = null">
          {{ t('mapStudio.editor.cancelShape') }}
        </button>
      </div>
      <span v-if="cursorGeo" class="geo-cursor">{{ t('mapStudio.editor.cursor', { lon: cursorGeo[0].toFixed(4), lat: cursorGeo[1].toFixed(4) }) }}</span>
    </div>

    <p class="geo-hint">{{ modeHint }}</p>
    <p v-if="registration" class="geo-hint dim">{{ t('mapStudio.editor.registration', { mode: t(`mapStudio.baseMode.${registration.mode}`), detail: registrationSummary(registration) }) }}</p>
    <p v-else class="geo-warn">{{ t('mapStudio.editor.noRegistration') }}</p>

    <div v-if="baseUrl" class="geo-stage" :class="{ 'is-drawing': mode !== 'select' }">
      <img :src="baseUrl" class="geo-base" :alt="t('mapStudio.editor.title')" @load="onBaseLoad" />
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
            :class="['geo-region', { 'is-active': selected?.kind === 'region' && selected.id === region.id, 'is-dataset': region.dataset }]"
            :stroke-width="unit * 1.2"
          ><title>{{ region.name }}</title></polygon>
          <circle
            v-for="(pt, i) in region.vertices"
            :key="`rgv-${region.id}-${i}`"
            :cx="pt[0]"
            :cy="pt[1]"
            :r="unit * 2.4"
            class="geo-vertex"
            @pointerdown.stop="startDrag('region', region.id, i, $event)"
            @dblclick.stop="removeVertex('region', region.id, i)"
          />
          <g
            v-for="handle in region.handles"
            :key="`rgm-${region.id}-${handle.segment}`"
            class="geo-midpoint"
            @pointerdown.stop="insertMidpoint('region', region.id, handle.segment)"
          >
            <title>{{ t('mapStudio.editor.midpointHint') }}</title>
            <circle :cx="handle.at[0]" :cy="handle.at[1]" :r="unit * 2.6" class="geo-midpoint-ring" />
            <path :d="`M ${handle.at[0] - unit * 1.4} ${handle.at[1]} h ${unit * 2.8} M ${handle.at[0]} ${handle.at[1] - unit * 1.4} v ${unit * 2.8}`" class="geo-midpoint-cross" />
          </g>
          <text v-if="region.pixels[0] && selected?.kind === 'region' && selected.id === region.id" :x="region.pixels[0][0] + unit * 3" :y="region.pixels[0][1] - unit * 2" :font-size="unit * 4" class="geo-text">{{ region.name }}</text>
        </g>

        <g v-for="route in routeShapes" :key="`rt-${route.id}`">
          <polyline
            :points="route.attr"
            :class="['geo-route', { 'is-active': selected?.kind === 'route' && selected.id === route.id, 'is-dataset': route.dataset }]"
            :stroke-width="unit * 1.8"
          ><title>{{ route.name }}</title></polyline>
          <circle
            v-for="(pt, i) in route.vertices"
            :key="`rtv-${route.id}-${i}`"
            :cx="pt[0]"
            :cy="pt[1]"
            :r="unit * 2.4"
            class="geo-vertex"
            @pointerdown.stop="startDrag('route', route.id, i, $event)"
            @dblclick.stop="removeVertex('route', route.id, i)"
          />
          <g
            v-for="handle in route.handles"
            :key="`rtm-${route.id}-${handle.segment}`"
            class="geo-midpoint"
            @pointerdown.stop="insertMidpoint('route', route.id, handle.segment)"
          >
            <title>{{ t('mapStudio.editor.midpointHint') }}</title>
            <circle :cx="handle.at[0]" :cy="handle.at[1]" :r="unit * 2.6" class="geo-midpoint-ring" />
            <path :d="`M ${handle.at[0] - unit * 1.4} ${handle.at[1]} h ${unit * 2.8} M ${handle.at[0]} ${handle.at[1] - unit * 1.4} v ${unit * 2.8}`" class="geo-midpoint-cross" />
          </g>
          <text v-if="route.pixels[0] && selected?.kind === 'route' && selected.id === route.id" :x="route.pixels[0][0] + unit * 3" :y="route.pixels[0][1] - unit * 2" :font-size="unit * 4" class="geo-text">{{ route.name }}</text>
        </g>

        <g v-for="place in placeShapes" :key="`pl-${place.id}`">
          <circle
            :cx="place.at[0]"
            :cy="place.at[1]"
            :r="unit * 3"
            :class="['geo-place', { 'is-active': selected?.kind === 'place' && selected.id === place.id, 'is-proposed': place.proposed, 'is-dataset': place.dataset }]"
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
    <p v-else class="geo-empty dim">{{ t('mapStudio.editor.noBase') }}</p>

    <p v-if="offscreenCount" class="geo-warn">{{ t('mapStudio.editor.offscreen', { n: offscreenCount }) }}</p>

    <div class="geo-lists">
      <section class="geo-list">
        <header class="geo-list-head">
          <strong>{{ t('mapStudio.editor.placesTitle', { n: spec.places.length }) }}</strong>
          <button type="button" class="geo-tool" :disabled="disabled || !registration" @click="setMode('place')">{{ t('mapStudio.editor.tool.place') }}</button>
        </header>
        <p v-if="!spec.places.length" class="geo-empty dim">{{ t('mapStudio.editor.empty') }}</p>
        <ul v-else class="geo-items">
          <li
            v-for="(place, index) in spec.places"
            :key="place.id"
            class="geo-item"
            :class="{ 'is-active': selected?.kind === 'place' && selected.id === place.id }"
            @click="selected = { kind: 'place', id: place.id }"
          >
            <input class="input geo-name" :value="place.name" :disabled="disabled" :placeholder="t('mapStudio.editor.name')" @input="setName('place', index, $event)" />
            <label class="geo-num"><span>{{ t('mapStudio.editor.lon') }}</span>
              <input class="input" type="number" step="0.0001" :value="place.lon" :disabled="disabled" @input="setPlaceCoord(index, 'lon', $event)" />
            </label>
            <label class="geo-num"><span>{{ t('mapStudio.editor.lat') }}</span>
              <input class="input" type="number" step="0.0001" :value="place.lat" :disabled="disabled" @input="setPlaceCoord(index, 'lat', $event)" />
            </label>
            <span v-if="place.origin === 'dataset'" class="geo-lock"><Lock :size="10" />{{ t('mapStudio.editor.datasetBadge') }}</span>
            <span v-if="place.proposed" class="geo-badge">{{ t('mapStudio.editor.proposed') }}</span>
            <button v-if="place.proposed" type="button" class="geo-tool" :disabled="disabled" @click.stop="accept('place', index)">{{ t('mapStudio.editor.accept') }}</button>
            <button type="button" class="geo-del" :disabled="disabled" :aria-label="t('mapStudio.editor.remove')" @click.stop="removeFeature('place', index)">
              <X :size="12" />
            </button>
          </li>
        </ul>
      </section>

      <section v-for="section in linearSections" :key="section.kind" class="geo-list">
        <header class="geo-list-head">
          <strong>{{ t(`mapStudio.editor.${section.kind}sTitle`, { n: section.items.length }) }}</strong>
          <button type="button" class="geo-tool" :disabled="disabled || !registration" @click="setMode(section.kind)">{{ t(`mapStudio.editor.tool.${section.kind}`) }}</button>
        </header>
        <p v-if="!section.items.length" class="geo-empty dim">{{ t('mapStudio.editor.empty') }}</p>
        <ul v-else class="geo-items">
          <li
            v-for="(shape, index) in section.items"
            :key="shape.id"
            class="geo-item"
            :class="{ 'is-active': selected?.kind === section.kind && selected.id === shape.id }"
            @click="selected = { kind: section.kind, id: shape.id }"
          >
            <input class="input geo-name" :value="shape.name" :disabled="disabled" :placeholder="t('mapStudio.editor.name')" @input="setName(section.kind, index, $event)" />
            <span class="geo-count">{{ t('mapStudio.editor.pointCount', { n: vertexCount(section.kind, shape.points) }) }}</span>
            <div class="geo-smooth">
              <span>{{ t('mapStudio.editor.smoothTitle') }}</span>
              <button
                type="button"
                class="geo-tool geo-smooth-toggle"
                :class="{ 'is-on': (section.rows.get(shape.id)?.smooth ?? 0) > 0 }"
                :aria-pressed="(section.rows.get(shape.id)?.smooth ?? 0) > 0"
                :aria-label="t('mapStudio.editor.smoothTitle')"
                :disabled="disabled"
                :title="t('mapStudio.editor.smoothHint')"
                @click.stop="setSmooth(shape, (section.rows.get(shape.id)?.smooth ?? 0) > 0 ? 0 : 1)"
              >
                {{ (section.rows.get(shape.id)?.smooth ?? 0) > 0 ? t('mapStudio.editor.smoothOn') : t('mapStudio.editor.smoothOff') }}
              </button>
              <label class="geo-smooth-range" :title="t('mapStudio.editor.smoothHint')" @click.stop>
                <span>{{ t('mapStudio.editor.smoothStrength') }}</span>
                <input
                  class="geo-smooth-slider"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  :value="section.rows.get(shape.id)?.smooth ?? 0"
                  :disabled="disabled"
                  @input="setSmoothInput(shape, $event)"
                />
                <output class="geo-smooth-value">{{ Math.round((section.rows.get(shape.id)?.smooth ?? 0) * 100) }}%</output>
              </label>
            </div>
            <p v-if="deviationWarning(section.kind, shape)" class="geo-warn geo-smooth-warn" :title="t('mapStudio.editor.smoothDeviationTitle')">
              {{ deviationWarning(section.kind, shape) }}
            </p>
            <span v-if="shape.origin === 'dataset'" class="geo-lock"><Lock :size="10" />{{ t('mapStudio.editor.datasetBadge') }}</span>
            <span v-if="shape.proposed" class="geo-badge">{{ t('mapStudio.editor.proposed') }}</span>
            <button v-if="shape.proposed" type="button" class="geo-tool" :disabled="disabled" @click.stop="accept(section.kind, index)">{{ t('mapStudio.editor.accept') }}</button>
            <button type="button" class="geo-tool" :disabled="disabled || !registration" @click.stop="continueShape(section.kind, shape.id)">{{ t('mapStudio.editor.continueShape') }}</button>
            <button type="button" class="geo-del" :disabled="disabled" :aria-label="t('mapStudio.editor.remove')" @click.stop="removeFeature(section.kind, index)">
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
 * 地图几何直接编辑器（Issue #84；平滑与中点补齐见 #99 阶段③）。
 *
 * 几何真值是 map_spec 里的经纬度，画布只是某一张底图的投影视图：拖点、加线、加面、**插入中点**都先把像素按该底图的
 * registration 反投影成经纬度再写回 spec，所以换底图（程序投影 / Earth 相机 / 外部标定图）后同一份几何仍然对得上。
 * 没有 registration 就只允许按数值编辑，绝不按 bbox 线性猜一个像素映射。
 *
 * 平滑不改存储：开关与强度滑杆只发 `layer-options` 草稿（页面随 PUT 提交），画布上的曲线用同源
 * `utils/smooth.js` 实时预览，控制点始终可见可拖；偏离验收口径时按段提示所需强度，绝不自动改强度。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Lock, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'
import type { MapFeatureMetadata, MapPlace, MapRegion, MapRoute, MapSpec } from '~/map-studio/api'
import { geoToPixel, pixelToGeo, registrationSummary, type MapRegistration } from '~/map-studio/utils/mapRegistration'
import { deviationProblems, insertVertex, smoothKeyFor, smoothPoints } from '~/map-studio/utils/smooth'
import { mediaUrl } from '~/utils/url'

type LayerOptions = Record<string, { smooth: number }>
/** 一段平滑曲线的偏离：与 utils/smooth.js 的 deviationProblems 逐字段一致 */
type LinearDeviation = { segment: number; deviation: number; limit: number; suggested: number }
interface LinearRow {
  id: string
  name: string
  pixels: Array<[number, number]>
  /** 画可拖动顶点圆的像素：选中时全画；未选中时数据集/密集形状（>60 点）不画，否则上百个把手会盖住底图 */
  vertices: Array<[number, number]>
  attr: string
  dataset: boolean
  smooth: number
  deviation: LinearDeviation | null
  handles: Array<{ segment: number; at: [number, number] }>
}

const { t } = useI18n()

const props = withDefaults(defineProps<{
  spec: MapSpec
  persistedSpec: MapSpec | null
  registration: MapRegistration | null
  baseImage: { path: string; width: number; height: number } | null
  /** 当前图层文档；线/面要素已经有锚定图层时平滑键用图层 id，还没画出来时用要素 id 暂存 */
  layerDoc?: { layers: Array<{ id: string; type: string; anchor?: { semantic_id?: string } }> } | null
  /** 平滑草稿：{ 图层 id 或要素 id: { smooth: 0..1 } }，由页面保存时随 PUT 一起提交 */
  layerOptions?: LayerOptions
  disabled?: boolean
}>(), { layerDoc: null, layerOptions: () => ({}), disabled: false })

const emit = defineEmits<{
  (e: 'update', spec: MapSpec): void
  (e: 'layer-options', options: LayerOptions): void
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

const link = useDeeplink('mapStudioGeo', DEEPLINK_KEYS.mapStudioGeo)
function hasFeature(spec: MapSpec | null, feature: { kind: FeatureKind; id: string }): boolean {
  const list = feature.kind === 'place' ? spec?.places : feature.kind === 'route' ? spec?.routes : spec?.regions
  return !!list?.some(item => item.id === feature.id)
}
const initialFocus = link.initial('msgeo')
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
  link.set({ msgeo: feature && hasFeature(props.persistedSpec, feature) ? `${feature.kind}:${feature.id}` : '' })
}, { immediate: true })

const baseUrl = computed(() => (props.baseImage?.path ? mediaUrl(props.baseImage.path) : ''))
const viewWidth = computed(() => props.registration?.width || props.baseImage?.width || naturalSize.value.width)
const viewHeight = computed(() => props.registration?.height || props.baseImage?.height || naturalSize.value.height)
// 笔画粗细随底图尺寸走，1920 宽和 960 宽上看起来一样
const unit = computed(() => Math.max(viewWidth.value, viewHeight.value) / 400)
const minPoints = computed(() => (draft.value?.kind === 'region' ? 3 : 2))

const modeHint = computed(() => {
  if (!props.registration) return t('mapStudio.editor.hintNumbersOnly')
  if (mode.value === 'select') return t('mapStudio.editor.hintSelect')
  if (mode.value === 'place') return t('mapStudio.editor.hintPlace')
  return t('mapStudio.editor.hintShape')
})

function pixelOf(lon: number, lat: number): [number, number] | null {
  return geoToPixel(props.registration, lon, lat)
}

const placeShapes = computed(() => props.spec.places.flatMap((place) => {
  const at = pixelOf(place.lon, place.lat)
  return at ? [{ id: place.id, name: place.name, at, proposed: !!place.proposed, dataset: place.origin === 'dataset' }] : []
}))

function vertexCount(kind: LinearKind, points: Array<[number, number]>): number {
  const first = points[0], last = points[points.length - 1]
  return points.length - (kind === 'region' && points.length > 1 && first && last && first[0] === last[0] && first[1] === last[1] ? 1 : 0)
}

/** 段中点把手（像素）：闭合环最后一段连回首点；只在选中的那条上铺，数据集要素不该占满画布 */
function pixelMidpoints(pixels: Array<[number, number]>, closed: boolean): Array<{ segment: number; at: [number, number] }> {
  const segments = closed ? pixels.length : pixels.length - 1
  const handles: Array<{ segment: number; at: [number, number] }> = []
  for (let segment = 0; segment < segments; segment++) {
    const a = pixels[segment]!
    const b = pixels[(segment + 1) % pixels.length]!
    handles.push({ segment, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] })
  }
  return handles
}

/**
 * 画布行与侧栏状态一次算好：像素控制点、平滑预览曲线、偏离信息、中点把手。
 * 预览曲线走 `utils/smooth.js` 的同一个函数（与实际渲染同源），控制点仍按原坐标单独画。
 */
function buildLinearRows(list: Array<MapRoute | MapRegion>, kind: LinearKind): LinearRow[] {
  const closed = kind === 'region'
  const rows: LinearRow[] = []
  for (const shape of list) {
    const pixels: Array<[number, number]> = []
    const count = vertexCount(kind, shape.points)
    for (let index = 0; index < count; index++) {
      const point = shape.points[index]!
      const pixel = pixelOf(point[0], point[1])
      if (pixel) pixels.push(pixel)
    }
    const entry = props.layerOptions?.[smoothKeyFor(props.layerDoc, shape.id)]
    const explicit = entry && typeof entry.smooth === 'number' && Number.isFinite(entry.smooth) ? entry.smooth : null
    // 没显式写过的要素按后端缺省：数据集关、其余要素开；此处只显示，不悄悄写进草稿
    const strength = explicit ?? (shape.origin === 'dataset' ? 0 : 1)
    const normalized = viewWidth.value > 0 && viewHeight.value > 0
      ? pixels.map(pt => [pt[0] / viewWidth.value, pt[1] / viewHeight.value] as [number, number])
      : []
    const smoothOptions = { closed, strength, width: viewWidth.value, height: viewHeight.value }
    const curve = strength > 0 ? smoothPoints(normalized, smoothOptions) : normalized
    const selectedShape = selected.value?.kind === kind && selected.value.id === shape.id
    // 只有整条形状都投出来了才铺中点把手：漏掉的顶点没有像素中点，宁可不出把手也不猜坐标
    const allVisible = pixels.length === count
    rows.push({
      id: shape.id,
      name: shape.name,
      pixels,
      vertices: selectedShape || (shape.origin !== 'dataset' && pixels.length <= 60) ? pixels : [],
      attr: curve.map(pt => `${pt[0] * viewWidth.value},${pt[1] * viewHeight.value}`).join(' '),
      dataset: shape.origin === 'dataset',
      smooth: strength,
      deviation: deviationProblems(normalized, smoothOptions)[0] ?? null,
      handles: selectedShape && allVisible && !props.disabled && props.registration ? pixelMidpoints(pixels, closed) : [],
    })
  }
  return rows
}

const linearRender = computed(() => {
  const rows = [
    ...buildLinearRows(props.spec.routes, 'route').map(row => ({ kind: 'route' as LinearKind, row })),
    ...buildLinearRows(props.spec.regions, 'region').map(row => ({ kind: 'region' as LinearKind, row })),
  ]
  const states = new Map<string, { smooth: number; deviation: LinearDeviation | null }>()
  for (const { kind, row } of rows) states.set(`${kind}:${row.id}`, { smooth: row.smooth, deviation: row.deviation })
  return { routes: rows.filter(item => item.kind === 'route').map(item => item.row), regions: rows.filter(item => item.kind === 'region').map(item => item.row), states }
})

const routeShapes = computed(() => linearRender.value.routes.filter(row => row.pixels.length >= 2))
const regionShapes = computed(() => linearRender.value.regions.filter(row => row.pixels.length >= 2))
// 平滑控制不依赖底图/配准：尚未绘制时也能用要素 id 预设强度。
const linearSections = computed(() => {
  const byId = (rows: LinearRow[]) => new Map(rows.map(row => [row.id, row]))
  return [
    { kind: 'route' as LinearKind, items: props.spec.routes, rows: byId(linearRender.value.routes) },
    { kind: 'region' as LinearKind, items: props.spec.regions, rows: byId(linearRender.value.regions) },
  ]
})
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
  if (focusOnLoad && link.initial('msgeo')) {
    focusOnLoad = false
    void nextTick(() => svgEl.value?.scrollIntoView({ block: 'center' }))
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 逐字保留阶段 ② 元数据：编辑器只动几何，未触碰的 category / relations / 数据集引用不能被顺手清掉 */
function cloneMetadata<T extends MapFeatureMetadata & { proposed?: boolean }>(item: T): T {
  const copy: T = { ...item }
  if (item.verification) copy.verification = { status: item.verification.status, reasons: [...item.verification.reasons] }
  if (item.dataset_ref) {
    copy.dataset_ref = {
      ref: item.dataset_ref.ref,
      ...(item.dataset_ref.clip_bbox ? { clip_bbox: [...item.dataset_ref.clip_bbox] as [number, number, number, number] } : {}),
    }
  }
  if (item.relations) copy.relations = [...item.relations]
  return copy
}

function cloneSpec(): MapSpec {
  return {
    ...props.spec,
    places: props.spec.places.map(place => cloneMetadata(place)),
    routes: props.spec.routes.map(route => ({ ...cloneMetadata(route), points: route.points.map(pt => [pt[0], pt[1]] as [number, number]) })),
    regions: props.spec.regions.map(region => ({ ...cloneMetadata(region), points: region.points.map(pt => [pt[0], pt[1]] as [number, number]) })),
  }
}

/** 数据集几何被人工改动后不再是数据集原值：转 manual + confirmed 并去掉 dataset_ref，其余元数据原样保留 */
function markManual(item: MapFeatureMetadata & { id: string, proposed?: boolean }, kind: FeatureKind): boolean {
  if (item.origin !== 'dataset') return false
  item.origin = 'manual'
  delete item.proposed
  delete item.dataset_ref
  item.verification = { status: 'confirmed', reasons: [t('mapStudio.editor.manualReason')] }
  warnDatasetEdit(kind, item.id)
  return true
}

/**
 * 一次拖拽里连续多次改写只提示一次；离散动作（提交草稿 / 删点 / 改数值）结束后解除，
 * 下一次改动仍会得到提示。
 */
let lastDatasetWarnKey = ''
function warnDatasetEdit(kind: FeatureKind, id: string) {
  const key = `${kind}:${id}`
  if (lastDatasetWarnKey === key) return
  lastDatasetWarnKey = key
  toast.warning(t('mapStudio.editor.datasetEditWarning'))
}
function resetDatasetWarn() {
  lastDatasetWarnKey = ''
}

/** 人工新增的条目一开始就是「人工 + 已确认」，不留在 AI 候选状态 */
function manualEntry<T extends { id: string }>(entry: T): T & MapFeatureMetadata {
  return {
    ...entry,
    origin: 'manual' as const,
    verification: { status: 'confirmed' as const, reasons: [t('mapStudio.editor.manualReason')] },
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

/**
 * 写平滑草稿：线/面已有锚定图层时键用图层 id（后端按图层 id 取参数），
 * 还没画出图层时用要素 id 暂存（作图阶段把要素键映射到落地图层 id）。只发草稿，不写接口。
 */
function setSmooth(shape: MapRoute | MapRegion, value: number) {
  if (props.disabled || !Number.isFinite(value)) return
  const key = smoothKeyFor(props.layerDoc, shape.id)
  // 滑杆步长 0.05，取两位小数去掉浮点尾巴；显式写 0 表示「关」，不删键（人的选择要看得见）
  const smooth = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
  emit('layer-options', { ...(props.layerOptions ?? {}), [key]: { smooth } })
}

function setSmoothInput(shape: MapRoute | MapRegion, event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  setSmooth(shape, Number(target.value))
}

/** 侧栏偏离提示：超限的段才出现，数值给到足以照改的精度（强度由人明确调低，绝不自动改） */
function deviationWarning(kind: LinearKind, shape: MapRoute | MapRegion): string {
  const deviation = linearRender.value.states.get(`${kind}:${shape.id}`)?.deviation
  if (!deviation) return ''
  return t('mapStudio.editor.smoothDeviation', {
    layer: shape.name || shape.id,
    segment: deviation.segment,
    deviation: deviation.deviation.toFixed(0),
    limit: deviation.limit.toFixed(0),
    suggest: deviation.suggested,
  })
}

/**
 * 段中点插入顶点：像素中点按该底图的 registration 反投影回经纬度（与拖点同口径），
 * 原控制点一个不动、顺序不变；插入点是人工确认的几何，不再是 AI 候选。
 */
function insertMidpoint(kind: LinearKind, id: string, segment: number) {
  if (props.disabled || !props.registration) return
  const source = (kind === 'route' ? props.spec.routes : props.spec.regions).find(item => item.id === id)
  if (!source) return
  const count = vertexCount(kind, source.points)
  const lastSegment = kind === 'region' ? count - 1 : count - 2
  if (!Number.isInteger(segment) || segment < 0 || segment > lastSegment) return
  const nextIndex = (segment + 1) % count
  const a = pixelOf(source.points[segment]![0], source.points[segment]![1])
  const b = pixelOf(source.points[nextIndex]![0], source.points[nextIndex]![1])
  // 地球背面等投不出来的点没有像素中点可言，不猜坐标
  if (!a || !b) return
  const geo = pixelToGeo(props.registration, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  if (!geo) return
  const next = cloneSpec()
  const target = (kind === 'route' ? next.routes : next.regions).find(item => item.id === id)
  if (!target) return
  target.points = insertVertex(target.points, segment, [Number(geo[0].toFixed(5)), Number(geo[1].toFixed(5))], kind === 'region')
  if (target.origin === 'dataset') markManual(target, kind)
  else {
    target.origin = 'manual'
    delete target.proposed
    target.verification = { status: 'confirmed' as const, reasons: [t('mapStudio.editor.manualReason')] }
  }
  selected.value = { kind, id }
  emit('update', next)
  resetDatasetWarn()
  toast.success(t('mapStudio.editor.midpointInserted'))
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
    const place = manualEntry<MapPlace>({ id: newId('place'), name: '', lon: Number(geo[0].toFixed(5)), lat: Number(geo[1].toFixed(5)) })
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
  if (existing) {
    // 只重画了同样的顶点不算改动：数据集要素不该因为「点了继续编辑又原样收尾」被降级成人工几何
    const changed = JSON.stringify(existing.points) !== JSON.stringify(current.points)
    existing.points = current.points
    if (changed) markManual(existing, current.kind)
  } else {
    const shape = manualEntry({ id: newId(current.kind), name: '', points: current.points })
    list.push(shape)
    selected.value = { kind: current.kind, id: shape.id }
  }
  draft.value = null
  mode.value = 'select'
  emit('update', next)
  resetDatasetWarn()
}

function startDrag(kind: FeatureKind, id: string, index: number, event: PointerEvent) {
  if (props.disabled || mode.value !== 'select') return
  resetDatasetWarn()
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
    if (!place || (place.lon === lon && place.lat === lat)) return
    place.lon = lon
    place.lat = lat
    markManual(place, 'place')
  } else {
    const list = drag.kind === 'route' ? next.routes : next.regions
    const shape = list.find(item => item.id === drag.id)
    const point = shape?.points[drag.index]
    if (!shape || !point) return
    if (point[0] === lon && point[1] === lat) return
    const closed = drag.kind === 'region' && vertexCount('region', shape.points) < shape.points.length
    point[0] = lon
    point[1] = lat
    if (closed && drag.index === 0) {
      const last = shape.points[shape.points.length - 1]!
      last[0] = lon
      last[1] = lat
    }
    markManual(shape, drag.kind)
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
  markManual(shape, kind)
  emit('update', next)
  resetDatasetWarn()
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
  if (!place || place[axis] === value) return
  place[axis] = value
  markManual(place, 'place')
  emit('update', next)
  resetDatasetWarn()
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
.geo-region.is-dataset { fill: #8d7bd8; fill-opacity: 0.16; stroke: #8d7bd8; stroke-dasharray: 5 3; }
.geo-route { fill: none; stroke: #e2703a; stroke-linecap: round; stroke-linejoin: round; }
.geo-route.is-active { stroke: var(--accent-text); }
.geo-route.is-dataset { stroke: #8d7bd8; stroke-dasharray: 6 3; }
.geo-place { fill: #4fc3f7; cursor: grab; }
.geo-place.is-proposed { fill: #ffb74d; }
.geo-place.is-dataset { fill: #8d7bd8; stroke: var(--surface); stroke-width: 1.2; stroke-dasharray: 2.5 2; }
.geo-place.is-active { stroke: var(--text-1); stroke-width: 1.5; }
.geo-vertex { fill: var(--surface); stroke: var(--text-1); stroke-width: 1; cursor: grab; }
.geo-draft { fill: none; stroke: var(--accent-text); stroke-dasharray: 6 4; }
.geo-draft-vertex { fill: var(--accent-text); }
.geo-midpoint { cursor: pointer; }
.geo-midpoint-ring { fill: var(--surface); stroke: var(--accent-text); stroke-width: 1; }
.geo-midpoint-cross { fill: none; stroke: var(--accent-text); stroke-width: 1; pointer-events: none; }
.geo-midpoint:hover .geo-midpoint-ring { fill: var(--accent-soft, var(--surface)); }
.geo-smooth { display: inline-flex; align-items: center; gap: 4px; }
.geo-smooth-range { display: inline-flex; align-items: center; gap: 3px; color: var(--text-2); font: 600 10px var(--font-body); }
.geo-smooth-slider { width: 64px; accent-color: var(--accent-text); }
.geo-smooth-value { font: 500 10px var(--font-mono, var(--font-body)); color: var(--text-2); }
.geo-smooth-warn { flex: 1 0 100%; }
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
.geo-lock {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  font-weight: 600;
}
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
