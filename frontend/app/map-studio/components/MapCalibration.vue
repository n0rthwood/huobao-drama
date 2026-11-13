<template>
  <div class="cal">
    <div class="cal-head">
      <strong class="cal-title">{{ t('mapStudio.calibration.title') }}</strong>
      <label class="cal-upload" :class="{ 'is-disabled': disabled || uploading }">
        <input type="file" accept="image/*" :disabled="disabled || uploading" @change="onFile" />
        <Loader2 v-if="uploading" :size="11" class="animate-spin" />
        <Upload v-else :size="11" />
        {{ uploading ? t('mapStudio.calibration.uploading') : t('mapStudio.calibration.upload') }}
      </label>
    </div>
    <p class="cal-hint">{{ t('mapStudio.calibration.hint') }}</p>
    <p v-if="error" class="cal-error">{{ error }}</p>

    <div class="cal-fields">
      <label class="cal-field">
        <span>{{ t('mapStudio.calibration.sourceUrl') }}</span>
        <input class="input" :value="draft.source_url" :disabled="disabled" :placeholder="t('mapStudio.calibration.sourceUrlPlaceholder')" @input="setMeta('source_url', $event)" />
      </label>
      <label class="cal-field">
        <span>{{ t('mapStudio.calibration.license') }}</span>
        <input class="input" :value="draft.license" :disabled="disabled" :placeholder="t('mapStudio.calibration.licensePlaceholder')" @input="setMeta('license', $event)" />
      </label>
    </div>

    <template v-if="imageUrl">
      <div class="cal-stage">
        <img :src="imageUrl" class="cal-image" :alt="t('mapStudio.calibration.title')" @load="onImageLoad" />
        <svg
          v-if="natural.width > 0"
          ref="svgEl"
          class="cal-overlay"
          :viewBox="`0 0 ${natural.width} ${natural.height}`"
          preserveAspectRatio="xMidYMid meet"
          @pointerdown="onStagePointerDown"
          @pointermove="onPointerMove"
          @pointerup="dragIndex = -1"
          @pointerleave="dragIndex = -1"
        >
          <g v-for="(point, index) in draft.control_points" :key="`cp-${index}`">
            <circle
              :cx="point.x"
              :cy="point.y"
              :r="unit * 3"
              :class="['cal-point', { 'is-active': index === activeIndex }]"
              @pointerdown.stop="startDrag(index, $event)"
            />
            <text :x="point.x + unit * 4" :y="point.y - unit * 2" :font-size="unit * 10" class="cal-label">{{ index + 1 }}</text>
          </g>
        </svg>
      </div>

      <p class="cal-hint dim">{{ t('mapStudio.calibration.clickHint') }}</p>

      <ul class="cal-points">
        <li
          v-for="(point, index) in draft.control_points"
          :key="`row-${index}`"
          class="cal-row"
          :class="{ 'is-active': index === activeIndex }"
          @click="activeIndex = index"
        >
          <span class="cal-index">{{ index + 1 }}</span>
          <span class="cal-px">{{ t('mapStudio.calibration.pixel', { x: Math.round(point.x), y: Math.round(point.y) }) }}</span>
          <label class="cal-num"><span>{{ t('mapStudio.editor.lon') }}</span>
            <input class="input" type="number" step="0.0001" :value="point.lon" :disabled="disabled" @input="setCoord(index, 'lon', $event)" />
          </label>
          <label class="cal-num"><span>{{ t('mapStudio.editor.lat') }}</span>
            <input class="input" type="number" step="0.0001" :value="point.lat" :disabled="disabled" @input="setCoord(index, 'lat', $event)" />
          </label>
          <button type="button" class="cal-del" :disabled="disabled" :aria-label="t('mapStudio.editor.remove')" @click.stop="removePoint(index)">
            <X :size="12" />
          </button>
        </li>
      </ul>

      <p v-if="draft.control_points.length < 3" class="cal-warn">{{ t('mapStudio.calibration.needPoints', { n: 3 - draft.control_points.length }) }}</p>
      <p v-else-if="!fit" class="cal-warn">{{ t('mapStudio.calibration.degenerate') }}</p>
      <p v-else class="cal-ok">{{ t('mapStudio.calibration.residual', { rms: fit.residual_px.rms.toFixed(2), max: fit.residual_px.max.toFixed(2) }) }}</p>
    </template>
    <p v-else class="cal-empty dim">{{ t('mapStudio.calibration.noImage') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 外部示意图底图标定（Issue #84）。
 *
 * 一张扫描图/示意图不是「bbox 对齐的墨卡托图」，必须由人在真图上点出 ≥3 个不共线的控制点并给经纬度，
 * 才有可逆的仿射配准；残差当场显示，人能立刻看出哪一点标歪。来源 URL 与许可是入库前提，缺一不可。
 */
import { Loader2, Upload, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { mapStudioAPI, type MapControlPoint, type MapReferenceImage } from '~/map-studio/api'
import { fitControlPoints } from '~/map-studio/utils/mapRegistration'
import { mediaUrl } from '~/utils/url'

const { t } = useI18n()

const props = defineProps<{
  reference: MapReferenceImage | null
  disabled?: boolean
}>()

const emit = defineEmits<{ (e: 'update', reference: MapReferenceImage): void }>()

function emptyReference(): MapReferenceImage {
  return { path: '', source_url: '', license: '', control_points: [] }
}

const draft = ref<MapReferenceImage>(props.reference ? cloneReference(props.reference) : emptyReference())
const natural = ref({ width: 0, height: 0 })
const activeIndex = ref(-1)
const dragIndex = ref(-1)
const uploading = ref(false)
const error = ref('')
const svgEl = ref<SVGSVGElement | null>(null)

const imageUrl = computed(() => (draft.value.path ? mediaUrl(draft.value.path) : ''))
const unit = computed(() => Math.max(natural.value.width, natural.value.height, 1) / 300)
const fit = computed(() => fitControlPoints(draft.value.control_points, natural.value))

function cloneReference(reference: MapReferenceImage): MapReferenceImage {
  return {
    path: String(reference.path || ''),
    source_url: String(reference.source_url || ''),
    license: String(reference.license || ''),
    control_points: (reference.control_points ?? []).map(point => ({ ...point })),
  }
}

watch(() => props.reference, (next) => {
  // 外部（阶段回退 / 冲突刷新）换了引用图时跟随服务端，本地未提交的点只在同一张图上保留
  if (!next) {
    if (!draft.value.path) return
    draft.value = emptyReference()
    return
  }
  if (next.path !== draft.value.path) draft.value = cloneReference(next)
})

function publish() {
  emit('update', cloneReference(draft.value))
}

async function onFile(event: Event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || !input.files?.length) return
  const file = input.files[0]
  input.value = ''
  uploading.value = true
  error.value = ''
  try {
    const res = await mapStudioAPI.uploadImage(file)
    // 换了底图，旧控制点的像素坐标不再有意义，必须重标
    draft.value = { ...draft.value, path: res.path, control_points: [] }
    natural.value = { width: 0, height: 0 }
    publish()
  } catch (err) {
    error.value = err instanceof Error && err.message ? err.message : t('mapStudio.calibration.uploadFailed')
  } finally {
    uploading.value = false
  }
}

function onImageLoad(event: Event) {
  const img = event.target
  if (img instanceof HTMLImageElement) natural.value = { width: img.naturalWidth, height: img.naturalHeight }
}

function eventPixel(event: PointerEvent): MapControlPoint | null {
  const svg = svgEl.value
  if (!svg || !natural.value.width) return null
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const scale = Math.min(rect.width / natural.value.width, rect.height / natural.value.height)
  const offsetX = (rect.width - natural.value.width * scale) / 2
  const offsetY = (rect.height - natural.value.height * scale) / 2
  return {
    x: (event.clientX - rect.left - offsetX) / scale,
    y: (event.clientY - rect.top - offsetY) / scale,
    lon: 0,
    lat: 0,
  }
}

function onStagePointerDown(event: PointerEvent) {
  if (props.disabled) return
  const point = eventPixel(event)
  if (!point) return
  draft.value.control_points.push(point)
  activeIndex.value = draft.value.control_points.length - 1
  publish()
}

function startDrag(index: number, event: PointerEvent) {
  if (props.disabled) return
  activeIndex.value = index
  dragIndex.value = index
  const target = event.target
  if (target instanceof Element && target.setPointerCapture) target.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (dragIndex.value < 0 || props.disabled) return
  const point = eventPixel(event)
  const current = draft.value.control_points[dragIndex.value]
  if (!point || !current) return
  current.x = point.x
  current.y = point.y
  publish()
}

function removePoint(index: number) {
  draft.value.control_points.splice(index, 1)
  if (activeIndex.value >= draft.value.control_points.length) activeIndex.value = -1
  publish()
}

function setCoord(index: number, axis: 'lon' | 'lat', event: Event) {
  const target = event.target
  const point = draft.value.control_points[index]
  if (!(target instanceof HTMLInputElement) || !point) return
  const value = Number(target.value)
  if (!Number.isFinite(value)) return
  point[axis] = value
  publish()
}

function setMeta(field: 'source_url' | 'license', event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  draft.value[field] = target.value
  publish()
}
</script>

<style scoped>
.cal { display: flex; flex-direction: column; gap: 8px; }
.cal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.cal-title { font: 600 12px var(--font-body); color: var(--text-1); }
.cal-upload {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.cal-upload input { display: none; }
.cal-upload:hover:not(.is-disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.cal-upload.is-disabled { opacity: 0.5; cursor: not-allowed; }
.cal-hint { margin: 0; font-size: 10.5px; color: var(--text-2); }
.cal-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.cal-warn {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.cal-ok { margin: 0; font: 600 10.5px var(--font-body); color: var(--accent-text); }
.cal-empty { margin: 0; font-size: 10.5px; }
.cal-fields { display: flex; flex-wrap: wrap; gap: 8px; }
.cal-field { display: flex; flex-direction: column; gap: 3px; flex: 1 1 260px; font-size: 10.5px; color: var(--text-2); }
.cal-stage {
  position: relative;
  width: 100%;
  min-width: 360px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  cursor: crosshair;
}
.cal-image { display: block; width: 100%; height: auto; }
.cal-overlay { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.cal-point { fill: #ffb74d; stroke: var(--text-1); stroke-width: 1; cursor: grab; }
.cal-point.is-active { fill: var(--accent-text); }
.cal-label { fill: var(--text-1); paint-order: stroke; stroke: var(--surface); stroke-width: 2; }
.cal-points { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cal-row {
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
.cal-row.is-active { border-color: var(--accent-text); }
.cal-index { font-weight: 600; color: var(--text-1); min-width: 16px; }
.cal-px { color: var(--text-2); }
.cal-num { display: inline-flex; align-items: center; gap: 3px; }
.cal-num .input { width: 96px; }
.cal-del {
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
.cal-del:hover:not(:disabled) { background: var(--action-danger); color: #fff; }
</style>
