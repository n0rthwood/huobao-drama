<template>
  <div class="map-preview">
    <p v-if="versionsError" class="hint">{{ t('mapPreview.versionsUnavailable') }}</p>
    <section v-if="versions.length">
      <strong>{{ t('episode.asset.versions') }}</strong>
      <p class="hint">{{ t('mapPreview.readOnly') }}</p>
      <div class="versions">
        <button v-for="v in versions" :key="v.id ?? v.url" type="button" @click="view(imageUrl(v.url), v.provider || '')">
          <img v-if="!failed[imageUrl(v.url)]" :src="thumbOf(imageUrl(v.url))" loading="lazy" :alt="t('episode.asset.versions')" @error="onError($event, imageUrl(v.url))" />
          <span v-else>{{ t('mapPreview.imageMissing') }}</span>
          <small>{{ v.provider || t('episode.asset.unknownEngine') }}</small>
          <MediaTime v-if="v.generated_at" :at="v.generated_at" />
        </button>
      </div>
    </section>
    <template v-if="pip?.role === 'overview'">
      <section v-if="pip.composite_path">
        <strong>{{ t('mapStudio.pip.compositeTitle') }}</strong>
        <button v-if="!failed[imageUrl(pip.composite_path)]" class="image-button" type="button" @click="view(imageUrl(pip.composite_path), t('mapStudio.pip.compositeTitle'))">
          <img :src="thumbOf(imageUrl(pip.composite_path))" loading="lazy" :alt="t('mapStudio.pip.compositeTitle')" @error="onError($event, imageUrl(pip.composite_path))" />
        </button>
        <p v-else class="hint">{{ t('mapPreview.imageMissing') }}</p>
      </section>
      <p v-else-if="frames.length" class="hint">{{ t('mapPreview.imageMissing') }}</p>
      <section v-if="frames.length">
        <strong>{{ t('mapStudio.pip.title') }}</strong>
        <div v-for="frame in frames" :key="frame.no" class="detail-row">
          <button v-if="findAsset(frame.detail_prop_id)" type="button" class="image-button" @click="emit('open-asset', frame.detail_prop_id)">
            <img v-if="assetImage(findAsset(frame.detail_prop_id)) && !failed[assetImage(findAsset(frame.detail_prop_id))]" :src="thumbOf(assetImage(findAsset(frame.detail_prop_id)))" loading="lazy" :alt="frame.label" @error="onError($event, assetImage(findAsset(frame.detail_prop_id)))" />
            <span v-else>{{ t('mapPreview.imageMissing') }}</span>
          </button>
          <p v-else class="hint">{{ t('mapPreview.targetMissing') }}</p>
          <strong>{{ frame.label }}</strong>
          <span v-if="parsePipMeta(findAsset(frame.detail_prop_id)?.map_pip)?.stale" class="hint">{{ t('mapPreview.stale') }}</span>
          <small v-if="episodeNumbers">{{ visibleNumbers(frame).map(n => `#${n}`).join('、') }}</small>
          <small v-else>{{ t('mapPreview.shotCount', { n: (frame.storyboard_numbers || []).length }) }}</small>
        </div>
      </section>
    </template>
    <section v-else-if="pip?.role === 'detail'">
      <strong>{{ t('mapPreview.overview') }}</strong>
      <span v-if="pip.stale" class="hint">{{ t('mapPreview.stale') }}</span>
      <template v-if="parent">
        <button v-if="assetImage(parent) && !failed[assetImage(parent)]" type="button" class="image-button locator" @click="view(assetImage(parent), parent.name)">
          <img :src="thumbOf(assetImage(parent))" loading="lazy" :alt="parent.name" @load="onOverviewLoad" @error="onError($event, assetImage(parent))" />
          <svg v-if="rect && imageSize.width" class="locator-box" :viewBox="`0 0 ${imageSize.width} ${imageSize.height}`" preserveAspectRatio="none" aria-hidden="true">
            <rect :x="rect[0]" :y="rect[1]" :width="rect[2] - rect[0]" :height="rect[3] - rect[1]" fill="none" stroke="#fff" stroke-width="5" />
            <rect :x="rect[0]" :y="rect[1]" :width="rect[2] - rect[0]" :height="rect[3] - rect[1]" fill="none" stroke="#b3272d" stroke-width="2" />
          </svg>
        </button>
        <p v-else class="hint">{{ t('mapPreview.imageMissing') }}</p>
        <button type="button" class="btn btn-sm" @click="emit('open-asset', pip.parent_prop_id)">{{ t('mapPreview.openOverview') }}</button>
      </template>
      <p v-else class="hint">{{ t('mapPreview.targetMissing') }}</p>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parsePipMeta, frameRectOn } from '~/map-studio/utils/mapPip'
import { mediaUrl } from '~/utils/url'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { assetLibraryAPI } from '~/composables/useApi'
import MediaTime from '~/components/MediaTime.vue'

const props = defineProps({ item: { type: Object, required: true }, assets: { type: Array, default: () => [] }, episodeNumbers: { type: Array, default: null } })
const emit = defineEmits(['open-asset', 'preview'])
const { t } = useI18n()
const failed = reactive({})
const imageSize = ref({ width: 0, height: 0 })
const pip = computed(() => parsePipMeta(props.item.map_pip))
const loadedVersions = ref([])
const versionsError = ref(false)
const versions = computed(() => (props.item.image_versions || props.item.imageVersions || loadedVersions.value).filter(v => v?.url))
const frames = computed(() => pip.value?.role === 'overview' && Array.isArray(pip.value.frames) ? pip.value.frames : [])
const findAsset = id => props.assets.find(a => Number(a.id) === Number(id))
const parent = computed(() => pip.value?.role === 'detail' ? findAsset(pip.value.parent_prop_id) : null)
const imageUrl = path => path ? mediaUrl(path) : ''
const assetImage = item => imageUrl(item?.image_url || item?.imageUrl || item?.local_path || item?.localPath)
const visibleNumbers = frame => (frame.storyboard_numbers || []).filter(n => props.episodeNumbers.includes(n))
const rect = computed(() => {
  if (pip.value?.role !== 'detail' || !parent.value) return null
  let workflow = parent.value.map_workflow
  if (typeof workflow === 'string') { try { workflow = JSON.parse(workflow) } catch { workflow = null } }
  let spec = parent.value.map_spec || workflow?.map_spec || workflow?.outputs?.map_spec
  if (typeof spec === 'string') { try { spec = JSON.parse(spec) } catch { spec = null } }
  const parentPip = parsePipMeta(parent.value.map_pip)
  return frameRectOn({ bbox: pip.value.overview_bbox || parentPip?.overview_bbox || spec?.bbox, projection: spec?.projection || { type: 'mercator' } }, imageSize.value, pip.value.frame?.focus_bbox)
})
watch(() => props.item.id, async id => {
  imageSize.value = { width: 0, height: 0 }
  loadedVersions.value = []
  versionsError.value = false
  if (props.item.image_versions || props.item.imageVersions) return
  try {
    const result = await assetLibraryAPI.detail('prop', id)
    if (props.item.id === id) loadedVersions.value = result?.image_versions || []
  } catch {
    if (props.item.id === id) versionsError.value = true
  }
}, { immediate: true })
function onOverviewLoad(event) { imageSize.value = { width: event.target.naturalWidth, height: event.target.naturalHeight } }
function onError(event, original) {
  if (!event.target.dataset.fbk && event.target.src !== original) thumbFallback(event, original)
  else failed[original] = true
}
function view(src, title) { if (src && !failed[src]) emit('preview', src, title) }
</script>

<style scoped>
.map-preview, .map-preview section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.map-preview section { padding-top: 12px; border-top: 1px solid var(--border); }
.hint, small { color: var(--text-2); font-size: 12px; margin: 0; }
.versions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.versions button, .image-button { min-width: 0; padding: 0; border: 0; background: var(--bg-2); color: inherit; cursor: pointer; text-align: left; }
.versions button { display: flex; flex-direction: column; gap: 3px; }
img { display: block; width: 100%; height: auto; object-fit: contain; }
.detail-row { display: flex; flex-direction: column; gap: 4px; }
.locator { position: relative; width: 100%; }
.locator-box { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
</style>
