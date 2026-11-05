<template>
  <div class="map" @click.stop>
    <div class="map-head">
      <span class="map-label">{{ t('episode.documentary.map.sectionTitle') }}</span>
      <button class="map-toggle" type="button" :disabled="saving || !dirty" @click.stop="save">
        <Loader2 v-if="saving" :size="11" class="animate-spin" />
        {{ saving ? t('episode.documentary.map.saving') : t('episode.documentary.map.save') }}
      </button>
      <button class="map-toggle" type="button" :disabled="rendering" @click.stop="render">
        <Loader2 v-if="rendering" :size="11" class="animate-spin" />
        <Map v-else :size="11" />
        {{ rendering ? t('episode.documentary.map.rendering') : t('episode.documentary.map.render') }}
      </button>
      <button class="map-toggle" type="button" :disabled="suggesting" @click.stop="suggest">
        <Loader2 v-if="suggesting" :size="11" class="animate-spin" />
        <Sparkles v-else :size="11" />
        {{ suggesting ? t('episode.documentary.map.suggesting') : t('episode.documentary.map.suggest') }}
      </button>
    </div>

    <p class="map-notice">{{ t('episode.documentary.map.noTextHint') }}</p>
    <p class="map-note">{{ t('episode.documentary.map.sectionHint') }}</p>
    <p v-if="error" class="map-error">{{ error }}</p>

    <div class="map-row">
      <label class="map-field">
        <span>{{ t('episode.documentary.map.projection') }}</span>
        <select v-model="spec.projection.type" class="input" @change="dirty = true">
          <option value="mercator">{{ t('episode.documentary.map.projectionMercator') }}</option>
          <option value="equirectangular">{{ t('episode.documentary.map.projectionEquirectangular') }}</option>
        </select>
      </label>
    </div>

    <div class="map-row">
      <span class="map-sub-label">{{ t('episode.documentary.map.bbox') }}</span>
      <label class="map-field">
        <span>{{ t('episode.documentary.map.bboxWest') }}</span>
        <input v-model.number="spec.bbox[0]" class="input" type="number" step="0.01" @input="dirty = true" />
      </label>
      <label class="map-field">
        <span>{{ t('episode.documentary.map.bboxSouth') }}</span>
        <input v-model.number="spec.bbox[1]" class="input" type="number" step="0.01" @input="dirty = true" />
      </label>
      <label class="map-field">
        <span>{{ t('episode.documentary.map.bboxEast') }}</span>
        <input v-model.number="spec.bbox[2]" class="input" type="number" step="0.01" @input="dirty = true" />
      </label>
      <label class="map-field">
        <span>{{ t('episode.documentary.map.bboxNorth') }}</span>
        <input v-model.number="spec.bbox[3]" class="input" type="number" step="0.01" @input="dirty = true" />
      </label>
    </div>
    <p class="map-note dim">{{ t('episode.documentary.map.bboxHint') }}</p>
    <p v-if="bboxInvalid" class="map-error">{{ t('episode.documentary.map.bboxInvalid') }}</p>

    <div class="map-row">
      <span class="map-sub-label">{{ t('episode.documentary.map.layers') }}</span>
      <label v-for="layer in LAYERS" :key="layer" class="map-chk">
        <input type="checkbox" :checked="spec.layers[layer]" @change="toggleLayer(layer, $event)" />
        <span>{{ t(`episode.documentary.map.layer${cap(layer)}`) }}</span>
      </label>
    </div>

    <section class="map-block">
      <div class="map-block-head">
        <strong>{{ t('episode.documentary.map.placesTitle') }}</strong>
        <button class="map-toggle" type="button" @click.stop="addPlace">
          <Plus :size="11" />
          {{ t('episode.documentary.map.addPlace') }}
        </button>
      </div>
      <ul v-if="spec.places.length" class="map-list">
        <li v-for="(place, index) in spec.places" :key="place.id" class="map-item">
          <input v-model="place.name" class="input" :placeholder="t('episode.documentary.map.placeName')" @input="dirty = true" />
          <input v-model.number="place.lon" class="input map-num" type="number" step="0.0001" :placeholder="t('episode.documentary.map.lon')" @input="dirty = true" />
          <input v-model.number="place.lat" class="input map-num" type="number" step="0.0001" :placeholder="t('episode.documentary.map.lat')" @input="dirty = true" />
          <button class="map-del" type="button" :title="t('episode.documentary.map.removePlace')" @click.stop="removePlace(index)">
            <X :size="12" />
          </button>
        </li>
      </ul>
      <p v-else class="map-empty dim">{{ t('episode.documentary.map.placesEmpty') }}</p>
    </section>

    <section class="map-block">
      <div class="map-block-head">
        <strong>{{ t('episode.documentary.map.routesTitle') }}</strong>
        <button class="map-toggle" type="button" @click.stop="addRoute">
          <Plus :size="11" />
          {{ t('episode.documentary.map.addRoute') }}
        </button>
      </div>
      <ul v-if="spec.routes.length" class="map-list">
        <li v-for="(route, rIndex) in spec.routes" :key="route.id" class="map-route">
          <div class="map-item">
            <input v-model="route.name" class="input" :placeholder="t('episode.documentary.map.routeName')" @input="dirty = true" />
            <button class="map-toggle" type="button" @click.stop="addRoutePoint(rIndex)">
              <Plus :size="11" />
              {{ t('episode.documentary.map.addPoint') }}
            </button>
            <button class="map-del" type="button" :title="t('episode.documentary.map.removeRoute')" @click.stop="removeRoute(rIndex)">
              <X :size="12" />
            </button>
          </div>
          <div v-for="(point, pIndex) in route.points" :key="`${route.id}-${pIndex}`" class="map-item map-point">
            <input
              class="input map-num"
              type="number"
              step="0.0001"
              :value="point[0]"
              :placeholder="t('episode.documentary.map.lon')"
              @input="setRoutePoint(rIndex, pIndex, 0, $event)"
            />
            <input
              class="input map-num"
              type="number"
              step="0.0001"
              :value="point[1]"
              :placeholder="t('episode.documentary.map.lat')"
              @input="setRoutePoint(rIndex, pIndex, 1, $event)"
            />
            <button class="map-del" type="button" :title="t('episode.documentary.map.removePoint')" @click.stop="removeRoutePoint(rIndex, pIndex)">
              <X :size="12" />
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="map-empty dim">{{ t('episode.documentary.map.routesEmpty') }}</p>
    </section>

    <!-- AI 建议坐标：一律先当候选，人工勾选后才写进 map_spec -->
    <section v-if="proposed.length" class="map-block">
      <div class="map-block-head">
        <strong>{{ t('episode.documentary.map.proposedTitle') }}</strong>
        <button class="btn btn-sm btn-primary" type="button" @click.stop="applyProposed">
          {{ t('episode.documentary.map.apply') }}
        </button>
      </div>
      <p class="map-notice">{{ t('episode.documentary.map.proposedHint') }}</p>
      <ul class="map-list">
        <li v-for="(item, index) in proposed" :key="`prop-${index}`" class="map-item">
          <label class="map-chk">
            <input type="checkbox" v-model="item.picked" />
            <span>{{ item.name }}</span>
          </label>
          <span class="dim">{{ item.lon.toFixed(4) }} / {{ item.lat.toFixed(4) }}</span>
          <span v-if="item.source" class="dim">{{ item.source }}</span>
        </li>
      </ul>
    </section>

    <div class="map-row">
      <input v-model="suggestNames" class="input" :placeholder="t('episode.documentary.map.suggestNamesPlaceholder')" />
      <span class="dim">{{ t('episode.documentary.map.suggestNames') }}</span>
    </div>

    <section v-if="rendered" class="map-block">
      <div class="map-block-head">
        <strong>{{ t('episode.documentary.map.render') }}</strong>
        <span class="dim">{{ t('episode.documentary.map.renderSize', { w: rendered.width, h: rendered.height }) }}</span>
        <span class="dim">{{ t('episode.documentary.map.renderSha', { sha: rendered.sha256.slice(0, 12) }) }}</span>
        <span v-if="rendered.reused" class="dim">{{ t('episode.documentary.map.renderReused') }}</span>
      </div>
      <p class="map-notice">{{ rendered.context.disclaimer }}</p>
      <p v-for="warning in rendered.context.warnings" :key="warning" class="map-notice" role="status">{{ warning }}</p>
      <div class="map-preview">
        <img :src="mediaUrl(rendered.path)" :alt="t('episode.documentary.map.sectionTitle')" />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图确定性底图面板（Issue #56）。
 *
 * 地图几何不能交给扩散模型重画（海岸线/河道会被改写），所以底图由 d3-geo 按 map_spec 确定性渲染，
 * 样式化只在其之上做。AI 只用于「建议坐标」，返回项一律 proposed，人工勾选并点「应用」才会写进 map_spec。
 */
import { Loader2, Map, Plus, Sparkles, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { propAPI, type MapRenderResp, type MapSpec } from '~/composables/useApi'

const { t } = useI18n()

const props = defineProps<{
  propId: number
  episodeId: number
  mapSpec?: MapSpec | null
}>()

const emit = defineEmits<{ (e: 'update'): void }>()

type LayerKey = keyof MapSpec['layers']
const LAYERS: LayerKey[] = ['land', 'coastline', 'rivers', 'lakes', 'countries']

interface ProposedPlace { name: string; lon: number; lat: number; source?: string; picked: boolean }

function emptySpec(): MapSpec {
  return {
    version: 1,
    projection: { type: 'mercator' },
    bbox: [100, 20, 130, 45],
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true },
    places: [],
    routes: [],
    style: { theme: 'archival' },
  }
}

const spec = ref<MapSpec>(props.mapSpec ? normalize(props.mapSpec) : emptySpec())
const dirty = ref(false)
const saving = ref(false)
const rendering = ref(false)
const suggesting = ref(false)
const error = ref('')
const rendered = ref<MapRenderResp | null>(null)
const proposed = ref<ProposedPlace[]>([])
const suggestNames = ref('')

let stopped = false

function msg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 后端可能缺字段（老行、手写 JSON），这里一次补齐，模板不做存在性判断 */
function normalize(raw: MapSpec): MapSpec {
  const base = emptySpec()
  const bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4
    ? ([num(raw.bbox[0]), num(raw.bbox[1]), num(raw.bbox[2]), num(raw.bbox[3])] as [number, number, number, number])
    : base.bbox
  return {
    version: 1,
    projection: { type: raw.projection?.type === 'equirectangular' ? 'equirectangular' : 'mercator' },
    bbox,
    layers: { ...base.layers, ...(raw.layers ?? {}) },
    places: (raw.places ?? []).map((p, i) => ({ id: String(p.id || `place-${i}`), name: String(p.name ?? ''), lon: num(p.lon), lat: num(p.lat) })),
    routes: (raw.routes ?? []).map((r, i) => ({
      id: String(r.id || `route-${i}`),
      name: String(r.name ?? ''),
      points: (r.points ?? []).map(pt => [num(pt[0]), num(pt[1])] as [number, number]),
    })),
    style: { theme: raw.style?.theme === 'clean' ? 'clean' : raw.style?.theme === 'ink' ? 'ink' : 'archival' },
  }
}

// 西 < 东、南 < 北，且在经纬度域内；非法就别提交渲染，省一次 400
const bboxInvalid = computed(() => {
  const [w, s, e, n] = spec.value.bbox
  return !(w < e && s < n && w >= -180 && e <= 180 && s >= -85 && n <= 85)
})

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function toggleLayer(layer: LayerKey, event: Event) {
  const target = event.target
  if (target instanceof HTMLInputElement) {
    spec.value.layers[layer] = target.checked
    dirty.value = true
  }
}

function addPlace() {
  spec.value.places.push({ id: newId('place'), name: '', lon: 0, lat: 0 })
  dirty.value = true
}

function removePlace(index: number) {
  spec.value.places.splice(index, 1)
  dirty.value = true
}

function addRoute() {
  spec.value.routes.push({ id: newId('route'), name: '', points: [] })
  dirty.value = true
}

function removeRoute(index: number) {
  spec.value.routes.splice(index, 1)
  dirty.value = true
}

function addRoutePoint(routeIndex: number) {
  spec.value.routes[routeIndex]?.points.push([0, 0])
  dirty.value = true
}

function removeRoutePoint(routeIndex: number, pointIndex: number) {
  spec.value.routes[routeIndex]?.points.splice(pointIndex, 1)
  dirty.value = true
}

function setRoutePoint(routeIndex: number, pointIndex: number, axis: 0 | 1, event: Event) {
  const target = event.target
  const point = spec.value.routes[routeIndex]?.points[pointIndex]
  if (point && target instanceof HTMLInputElement) {
    point[axis] = num(target.value)
    dirty.value = true
  }
}

async function save(): Promise<boolean> {
  if (saving.value) return false
  if (bboxInvalid.value) {
    error.value = t('episode.documentary.map.bboxInvalid')
    return false
  }
  saving.value = true
  error.value = ''
  try {
    const res = await propAPI.saveMapSpec(props.propId, spec.value)
    if (stopped) return false
    spec.value = normalize(res?.map_spec ?? spec.value)
    dirty.value = false
    toast.success(t('episode.documentary.map.saved'))
    emit('update')
    return true
  } catch (err) {
    error.value = msg(err, t('episode.documentary.map.saveFailed'))
    return false
  } finally {
    if (!stopped) saving.value = false
  }
}

async function render() {
  if (rendering.value) return
  // 渲染读的是库里的 map_spec，所以有未保存改动时先保存，避免渲染出旧图
  if (dirty.value && !(await save())) return
  rendering.value = true
  error.value = ''
  try {
    const res = await propAPI.renderMapBase(props.propId, Number(props.episodeId))
    if (stopped) return
    rendered.value = res
    emit('update')
  } catch (err) {
    if (!stopped) error.value = msg(err, t('episode.documentary.map.renderFailed'))
  } finally {
    if (!stopped) rendering.value = false
  }
}

async function suggest() {
  if (suggesting.value) return
  suggesting.value = true
  error.value = ''
  try {
    const names = suggestNames.value.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean)
    const res = await propAPI.suggestMapPlaces(props.propId, Number(props.episodeId), names)
    if (stopped) return
    proposed.value = (res?.places ?? []).map(p => ({ name: String(p.name ?? ''), lon: num(p.lon), lat: num(p.lat), source: p.source, picked: false }))
  } catch (err) {
    if (!stopped) error.value = msg(err, t('episode.documentary.map.suggestFailed'))
  } finally {
    if (!stopped) suggesting.value = false
  }
}

function applyProposed() {
  const picked = proposed.value.filter(item => item.picked)
  if (!picked.length) {
    error.value = t('episode.documentary.map.applyEmpty')
    return
  }
  for (const item of picked) {
    spec.value.places.push({ id: newId('place'), name: item.name, lon: item.lon, lat: item.lat })
  }
  proposed.value = proposed.value.filter(item => !item.picked)
  dirty.value = true
  error.value = ''
  toast.success(t('episode.documentary.map.applied'))
}

async function load() {
  error.value = ''
  try {
    const res = await propAPI.mapSpec(props.propId)
    if (stopped) return
    if (res?.map_spec) {
      spec.value = normalize(res.map_spec)
      dirty.value = false
    }
  } catch (err) {
    if (!stopped) error.value = msg(err, t('episode.documentary.map.loadFailed'))
  }
}

watch(() => props.propId, () => {
  spec.value = emptySpec()
  rendered.value = null
  proposed.value = []
  dirty.value = false
  void load()
})

onMounted(load)
onBeforeUnmount(() => { stopped = true })
</script>

<style scoped>
.map {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.map-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.map-label {
  font: 600 11px var(--font-body);
  color: var(--text-1);
}
.map-head .map-toggle:first-of-type { margin-left: auto; }
.map-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.map-toggle:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.map-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.map-notice {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.map-note { margin: 0; font-size: 10.5px; color: var(--text-2); }
.map-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.map-empty { margin: 0; font-size: 10.5px; }
.map-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-2);
}
.map-sub-label { font-weight: 600; color: var(--text-1); }
.map-field { display: inline-flex; align-items: center; gap: 4px; }
.map-field .input { width: 104px; }
.map-chk { display: inline-flex; align-items: center; gap: 4px; }
.map-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}
.map-block-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-1);
}
.map-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.map-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  font-size: 10.5px;
}
.map-route { display: flex; flex-direction: column; gap: 3px; }
.map-point { margin-left: 16px; }
.map-num { width: 96px; }
.map-preview {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 420px));
  justify-content: start;
  gap: 8px;
}
.map-preview img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: contain;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.map-del {
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
/* 与 PropSemanticsPanel .sem-del:hover 同口径：危险底色上固定用白字 */
.map-del:hover { background: var(--action-danger); color: #fff; }
</style>
