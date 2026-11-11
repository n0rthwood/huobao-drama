<template>
  <aside class="layer-rail">
    <details ref="baseSection" open class="lr-section">
      <summary><Image :size="15" />{{ t('layerCanvas.base.title') }}</summary>
      <div class="lr-base">
        <img v-if="doc.base.path && !baseImageError" :src="mediaUrl(doc.base.path)" alt="" @load="readSourceSize" @error="baseImageError = true">
        <p v-if="baseImageError" class="lr-error">{{ t('layerCanvas.base.loadError') }}</p>
        <p v-else-if="!doc.base.path" class="lr-guide">{{ t('layerCanvas.base.noBase') }}</p>
        <strong>{{ currentBase?.name || baseAsset?.name || t('layerCanvas.base.unknown') }}</strong>
        <span v-if="doc.base.ref" class="lr-meta">{{ t('layerCanvas.base.version', { version: doc.base.ref.version_task_id ?? '—' }) }}
          <span v-if="currentBase?.faithful" :title="t('layerCanvas.base.verified')"><ShieldCheck :size="13" />{{ t('layerCanvas.base.verified') }}</span>
        </span>
        <span v-if="inherited" class="lr-meta"><Link2 :size="13" /><Lock :size="13" />{{ t('layerCanvas.base.inherited') }}</span>
        <span class="lr-meta">{{ t('layerCanvas.base.outputSize', { w: doc.base.width, h: doc.base.height }) }}</span>
        <span v-if="sourceSize.width && sourceSize.height" class="lr-meta">{{ t('layerCanvas.base.sourceSize', { w: sourceSize.width, h: sourceSize.height }) }}</span>
        <span v-else class="lr-meta">{{ t('layerCanvas.base.sourceUnknown') }}</span>
        <span v-if="outputRatio !== null" class="lr-meta">{{ t('layerCanvas.base.resolution', { times: outputRatio, sw: finalSize.width, sh: finalSize.height }) }}</span>
        <small v-if="!doc.base.source_width">{{ t('layerCanvas.base.saveSize') }}</small>
        <div class="lr-actions">
          <button v-if="externalSources" type="button" class="btn-ghost" :disabled="inherited" @click="posterPickerOpen = !posterPickerOpen"><ImagePlus :size="14" />{{ t('layerCanvas.base.replace') }}</button>
          <button v-else type="button" class="btn-ghost" :disabled="inherited" @click="pickerOpen = true"><ImagePlus :size="14" />{{ t('layerCanvas.base.replace') }}</button>
          <button type="button" class="btn-ghost" :disabled="inherited || !sourceSize.width || !sourceSize.height" @click="emit('crop-request')"><Crop :size="14" />{{ t('layerCanvas.base.cropToOutput') }}</button>
        </div>
        <small class="lr-guide"><Info :size="13" />{{ t('layerCanvas.base.guide') }}</small>
        <div v-if="posterPickerOpen" class="lr-poster-bases">
          <button v-for="source in baseSources" :key="source.path" type="button" class="lr-poster-base" @click="chooseExternal(source)">
            <img :src="mediaUrl(source.path)" alt="" loading="lazy">
            <span>{{ source.label }}</span>
          </button>
        </div>
        <p v-if="loadError" class="lr-error">{{ t('layerCanvas.base.loadError') }}</p>
        <p v-if="pickerError" class="lr-error">{{ t('layerCanvas.image.selectionCount') }}</p>
        <details class="lr-overall"><summary>{{ t('layerCanvas.base.style') }}</summary>
          <LayerStyle :doc="doc" document-only @theme="emit('theme', $event)" @filter="emit('filter', $event)" />
        </details>
        <p v-if="inherited" class="lr-guide">{{ t('layerCanvas.anchor.inherited') }}</p>
        <template v-else>
          <div v-if="relinkId" class="lr-relink"><Anchor :size="14" />{{ t('layerCanvas.anchor.choose') }}
            <button type="button" class="btn-ghost" @click="relinkId = null">{{ t('layerCanvas.anchor.cancel') }}</button>
          </div>
          <template v-for="group in GROUPS" :key="group">
            <div v-if="entries.some(entry => entry.group === group)" class="lr-semantic-group">
              <h5>{{ t(`layerCanvas.anchor.${group}`) }}</h5>
              <div v-for="entry in entries.filter(item => item.group === group)" :key="`${group}:${entry.id}`" class="lr-entry">
                <span :title="entry.name">{{ entry.name }}</span>
                <button type="button" class="btn-ghost" :disabled="!canUseEntry(entry)" :title="t(relinkId ? 'layerCanvas.anchor.relink' : actionKey(entry))" @click="useEntry(entry)">
                  <component :is="group === 'regions' ? Lasso : group === 'lines' ? Route : MapPin" :size="13" />
                  {{ t(relinkId ? 'layerCanvas.anchor.relink' : actionKey(entry)) }}
                </button>
              </div>
            </div>
          </template>
          <p v-if="!entries.length" class="lr-guide">{{ t('layerCanvas.anchor.noSemantics') }}</p>
        </template>
      </div>
    </details>
    <details open class="lr-section">
      <summary><Layers :size="15" />{{ t('layerCanvas.list.title') }}</summary>
      <LayerList :doc="doc" :selected-ids="selectedIds" :anchor-states="anchorStates" :variables="variables"
        @select="emit('select', $event)" @history="emit('history')" @patch="emit('patch', $event)"
        @reorder="emit('reorder', $event)" @add="(type, partial) => emit('add', type, partial)" @remove="emit('remove')"
        @duplicate="emit('duplicate')" @relink="startRelink" />
    </details>
    <details open class="lr-section">
      <summary><SlidersHorizontal :size="15" />{{ t('layerCanvas.style.docTitle') }}</summary>
      <LayerStyle :doc="doc" :layer="selectedLayer" :assets="imageAssets" :drama-id="dramaId" :episode-id="episodeId" :variables="variables" layer-only
        @patch="emit('patch', $event)" @style="emit('style', $event)" @history="emit('history')" @registered="emit('assets-changed', $event)" />
    </details>
    <AssetPicker v-if="!externalSources" :open="pickerOpen" :assets="baseChoices" @close="pickerOpen = false" @confirm="chooseBase" />
  </aside>
</template>

<script setup>
/**
 * R6 public rail contract: doc/selectedIds are controlled, episodeId loads verified base versions.
 * Optional assets are AssetPicker context assets, baseAsset supplies inherited-base display metadata.
 * Existing document operations are forwarded unchanged; add(type,partial) supports semantic quick-create.
 * base(baseObject) replaces the whole base, crop-request starts the canvas crop UI, and
 * reanchor({id,patch}) requests an explicit history-backed rebind through useLayerDoc.reanchorLayer.
 * Loaded source dimensions stay local; the parent/backend save probes the actual source file.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Image, ImagePlus, Crop, ShieldCheck, Link2, Lock, Info, Anchor, Lasso, Route, MapPin, Layers, SlidersHorizontal } from 'lucide-vue-next'
import AssetPicker from '~/components/AssetPicker.vue'
import LayerList from './LayerList.vue'
import LayerStyle from './LayerStyle.vue'
import { assetPipelineAPI, propAPI } from '~/composables/useApi'
import { semanticEntries, semanticLayerPatch, anchorState } from '~/utils/semanticGeometry'
import { normalizeCrop } from '~/utils/layerQuality'
import { mediaUrl } from '~/utils/url'
import { DEEPLINK_KEYS, querySingle, useDeeplink } from '~/composables/useQuerySync'
import { toast } from 'vue-sonner'

const props = defineProps({
  doc: { type: Object, required: true },
  selectedIds: { type: Array, default: () => [] },
  episodeId: { type: Number, default: 0 },
  dramaId: { type: Number, default: 0 },
  spec: { type: Object, default: () => ({}) },
  inherited: { type: Boolean, default: false },
  baseAsset: { type: Object, default: null },
  assets: { type: Array, default: () => [] },
  // Poster 固定文本变量（Issue #72）
  variables: { type: Object, default: null },
  // Poster 底图候选（Issue #72）：生成/合成版本、人工上传、资产图；非空时不再请求资产流水线候选
  baseSources: { type: Array, default: null },
})
const emit = defineEmits(['select', 'patch', 'style', 'history', 'reorder', 'add', 'remove', 'duplicate', 'theme', 'filter', 'base', 'crop-request', 'reanchor', 'assets-changed'])
const { t } = useI18n()
const GROUPS = ['points', 'regions', 'lines', 'labels']
const candidates = ref([])
const entries = ref([])
const semanticsLoaded = ref(false)
const loadError = ref(false)
const pickerError = ref(false)
const pickerOpen = ref(false)
const posterPickerOpen = ref(false)
const relinkId = ref(null)
const baseSection = ref(null)
const naturalSize = ref({ width: 0, height: 0 })
const baseImageError = ref(false)
let semanticRequest = 0
let candidateRequest = 0

// Deeplink (#86): lpick marks an open image picker. This rail owns the base AssetPicker, which has no
// inner mode, so it only claims lpick when the link carries no lpmode (that one belongs to LayerImagePicker).
const link = useDeeplink('layerPicker', DEEPLINK_KEYS.layerPicker)
const urlPickerOpen = querySingle(link.initial('lpick')) === '1' && !link.initial('lpmode')
watch(pickerOpen, open => link.set({ lpick: open ? '1' : '', lpmode: '' }), { immediate: true })
const externalSources = computed(() => Array.isArray(props.baseSources))
if (urlPickerOpen) {
  // Poster hosts replace the base from an inline source list, so there is no AssetPicker to restore.
  if (externalSources.value) toast.warning(t('deeplink.missing'))
  else pickerOpen.value = true
}
// AssetPicker selects by kind/id, so each version has a synthetic id; real ids stay on metadata.
const baseChoices = computed(() => (props.baseSources || candidates.value).map((candidate, index) => ({
  id: index + 1, kind: candidate.asset_kind, asset_id: candidate.asset_id,
  name: candidate.label || (candidate.asset_name
    ? `${candidate.asset_name} · ${t('layerCanvas.base.version', { version: candidate.version_task_id })}`
    : `#${candidate.version_task_id ?? index + 1}`),
  image: candidate.path, version_task_id: candidate.version_task_id,
  faithful: candidate.verified === 'faithful' || candidate.verified === 'gate_passed', candidate,
})))
const imageAssets = computed(() => [
  ...baseChoices.value.map(item => ({ ...item, id: `version:${item.id}` })),
  ...props.assets.filter(item => item.image).map(item => ({ ...item, asset_id: item.asset_id ?? item.id, id: `asset:${item.kind}:${item.id}` })),
])
const currentBase = computed(() => baseChoices.value.find(item => item.image === props.doc.base.path))
const sourceSize = computed(() => ({
  width: props.doc.base.source_width || naturalSize.value.width || 0,
  height: props.doc.base.source_height || naturalSize.value.height || 0,
}))
const finalSize = computed(() => ({
  width: props.spec.width || props.doc.base.width,
  height: props.spec.height || props.doc.base.height,
}))
const outputRatio = computed(() => {
  if (!sourceSize.value.width || !sourceSize.value.height) return null
  const crop = normalizeCrop(props.doc.base.crop)
  return Math.min(crop.w * sourceSize.value.width / finalSize.value.width, crop.h * sourceSize.value.height / finalSize.value.height).toFixed(1)
})
const selectedLayer = computed(() => props.doc.layers.find(layer => props.selectedIds.includes(layer.id)) || null)
const anchorStates = computed(() => Object.fromEntries(props.doc.layers.map(layer => [layer.id,
  anchorState(layer, entries.value, semanticsLoaded.value, props.doc.base.ref?.asset_id ?? null),
])))

watch(() => props.episodeId, async (episodeId) => {
  const request = ++candidateRequest
  candidates.value = []
  if (externalSources.value || !episodeId) return
  try {
    const result = await assetPipelineAPI.baseCandidates(episodeId)
    if (request === candidateRequest) candidates.value = result.candidates || []
  } catch { if (request === candidateRequest) loadError.value = true }
}, { immediate: true })

watch(() => [props.doc.base.path, props.doc.base.ref?.asset_kind, props.doc.base.ref?.asset_id, props.inherited], refreshSemantics, { immediate: true })
watch(() => props.doc.base.path, () => { baseImageError.value = false })
async function refreshSemantics() {
  const request = ++semanticRequest
  entries.value = []
  semanticsLoaded.value = false
  relinkId.value = null
  naturalSize.value = { width: 0, height: 0 }
  if (props.inherited || props.doc.base.ref?.asset_kind !== 'prop' || !props.doc.base.ref?.asset_id) return
  try {
    const result = await propAPI.semantics(props.doc.base.ref.asset_id)
    if (request !== semanticRequest) return
    entries.value = semanticEntries(result.semantics)
    semanticsLoaded.value = true
  } catch { if (request === semanticRequest) loadError.value = true }
}

function readSourceSize(event) {
  naturalSize.value = { width: event.target.naturalWidth, height: event.target.naturalHeight }
}
/** Poster 底图候选没有 asset kind/id（生成版本/上传图），直接按路径选择，不经过 AssetPicker 分类。 */
function chooseExternal(source) {
  const base = { path: source.path, width: props.doc.base.width, height: props.doc.base.height,
    ...(props.doc.base.filter ? { filter: { ...props.doc.base.filter } } : {}) }
  if (source.ref) base.ref = { ...source.ref }
  if (source.width && source.height) Object.assign(base, { source_width: source.width, source_height: source.height })
  emit('base', base)
  posterPickerOpen.value = false
}

function chooseBase(selected) {
  if (selected.length !== 1) { pickerError.value = true; return }
  const candidate = baseChoices.value.find(item => item.id === selected[0].id && item.kind === selected[0].kind)?.candidate
  if (!candidate) return
  const base = { path: candidate.path, width: props.doc.base.width, height: props.doc.base.height,
    ...(props.doc.base.filter ? { filter: { ...props.doc.base.filter } } : {}) }
  if (candidate.asset_kind && candidate.asset_id) {
    base.ref = { asset_kind: candidate.asset_kind, asset_id: candidate.asset_id, version_task_id: candidate.version_task_id }
  }
  // Source dimensions are only persisted when already supplied by the server candidate.
  if (candidate.width && candidate.height) Object.assign(base, { source_width: candidate.width, source_height: candidate.height })
  emit('base', base)
  pickerOpen.value = false
  pickerError.value = false
}
function actionKey(entry) {
  return `layerCanvas.anchor.${entry.group === 'regions' ? 'addRegion' : entry.group === 'lines' ? 'addRoute' : 'addMarker'}`
}
function canUseEntry(entry) {
  const patch = semanticLayerPatch(entry, props.doc.base.ref?.asset_id)
  if (!patch) return false
  return !relinkId.value || props.doc.layers.find(layer => layer.id === relinkId.value)?.type === patch.type
}
function useEntry(entry) {
  const patch = semanticLayerPatch(entry, props.doc.base.ref?.asset_id)
  if (!patch || !canUseEntry(entry)) return
  if (relinkId.value) { emit('reanchor', { id: relinkId.value, patch }); relinkId.value = null }
  else emit('add', patch.type, patch)
}
function startRelink(id) {
  if (props.inherited) return
  relinkId.value = id
  if (baseSection.value) baseSection.value.open = true
}

defineExpose({ refreshSemantics })
</script>

<style scoped>
.layer-rail { min-width: 0; min-height: 0; overflow: auto; border-left: 1px solid var(--border); background: var(--surface-card); font-size: 12px; }
.lr-section { border-bottom: 1px solid var(--border); }
.lr-section > summary { display: flex; align-items: center; gap: 7px; padding: 10px; font-weight: 600; color: var(--text-1); cursor: pointer; }
.lr-section > summary::before { content: '›'; transition: transform .15s; }
.lr-section[open] > summary::before { transform: rotate(90deg); }
.lr-base { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 7px; }
.lr-base > img { width: 100%; max-height: 150px; object-fit: contain; background: var(--surface-base); }
.lr-meta, .lr-meta > span, .lr-actions, .lr-actions button, .lr-entry button, .lr-guide { display: flex; align-items: center; gap: 5px; }
.lr-meta, .lr-guide, .lr-base > small { color: var(--text-2); font-size: 11px; }
.lr-meta { flex-wrap: wrap; }
.lr-actions { flex-wrap: wrap; }
.lr-guide { align-items: flex-start; line-height: 1.6; margin: 0; }
.lr-guide svg { flex-shrink: 0; margin-top: 3px; }
.lr-overall > summary { cursor: pointer; color: var(--text-2); }
.lr-semantic-group h5 { margin: 5px 0; color: var(--text-2); }
.lr-entry { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 0; }
.lr-entry > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr-entry button { flex-shrink: 0; font-size: 11px; }
.lr-entry button:disabled { opacity: .4; cursor: not-allowed; }
.lr-relink { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; color: var(--accent); }
.lr-error { margin: 0; color: var(--danger, #c0472e); }
.lr-poster-bases { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
.lr-poster-base { display: flex; flex-direction: column; gap: 3px; padding: 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-card); color: var(--text-2); font-size: 10px; cursor: pointer; }
.lr-poster-base img { width: 100%; height: 56px; object-fit: cover; border-radius: 4px; }
.lr-poster-base span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layer-rail :deep(.layer-list), .layer-rail :deep(.layer-style) { border: 0; }
</style>
