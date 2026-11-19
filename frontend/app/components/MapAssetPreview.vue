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
          <!-- Issue #125：引用分镜读时反查（不显示生成时的镜号快照） -->
          <small v-if="detailCounts(frame).total">{{ t('mapPreview.referencesCounts', detailCounts(frame)) }}</small>
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

    <!-- Issue #125：资产被哪些分镜引用（动态反查）+ 一键跳到段编辑器或设计卡 -->
    <section v-if="isMap">
      <strong>{{ t('mapPreview.referencesTitle') }}</strong>
      <p class="hint">{{ t('mapPreview.referencesHint') }}</p>
      <template v-if="refs">
        <p v-if="!refs.total" class="hint">{{ t('mapPreview.referencesEmpty') }}</p>
        <template v-else>
          <p class="ref-counts">{{ t('mapPreview.referencesCounts', { materialized: refs.materialized, planned: refs.planned }) }}</p>
          <p class="hint">{{ t('mapPreview.referenceUpdateHint') }}</p>
          <ul class="ref-list">
            <li v-for="ref in shownRefs" :key="ref.storyboard_id">
              <NuxtLink class="res-link" :to="routeOf(ref)">{{ t('mapPreview.referenceShot', { ep: ref.episode_number, shot: ref.storyboard_number }) }}</NuxtLink>
              <span class="ref-via">{{ ref.materialized ? t('mapPreview.referenceMaterialized') : t('mapPreview.referencePlanned') }}</span>
            </li>
          </ul>
          <p v-if="refs.total > shownRefs.length" class="hint">{{ t('mapPreview.referenceMore', { n: refs.total - shownRefs.length }) }}</p>
        </template>
      </template>
      <p v-else-if="refsError" class="hint">{{ t('mapPreview.referencesUnavailable') }}</p>
    </section>

    <!-- 地图资产的语义条目只读展示（#125）：描述是佐证，名称只是昵称 -->
    <section v-if="isMap">
      <strong>{{ t('mapPreview.semanticsTitle') }}</strong>
      <p class="hint">{{ t('mapPreview.semanticsHint') }}</p>
      <p v-if="!semanticsEntries.length" class="hint">{{ t('mapPreview.semanticsEmpty') }}</p>
      <ul v-else class="ref-list sem-list">
        <li v-for="entry in semanticsEntries" :key="entry.id">
          <span class="sem-name">{{ entry.name }}</span>
          <span class="ref-via">{{ t(`episode.documentary.semantics.group.${entry.group}`) }}</span>
          <p v-if="entry.description" class="sem-desc">{{ entry.description }}</p>
          <p v-if="entry.keywords?.length" class="sem-keys">{{ entry.keywords.map(word => `#${word}`).join(' ') }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup>
/**
 * 地图资产弹窗的只读预览（Issue #107 / #110 / #125）。
 *
 * 画中画：全览列出各细节资产与定位框；细节显示所属全览。
 * 引用（#125）：镜号不再是资产身份或引用依据——**读时反查**「当前被哪些分镜引用」，
 * 显示「已落段 n / 仅规划 m」并给出直达段编辑器/设计卡的 deeplink；旧 `map_pip`
 * 里的 `storyboard_numbers` 快照一律不读（存量数据不迁移、不改写）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parsePipMeta, frameRectOn } from '~/map-studio/utils/mapPip'
import { mediaUrl } from '~/utils/url'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { assetLibraryAPI, propAPI } from '~/composables/useApi'
import MediaTime from '~/components/MediaTime.vue'

const props = defineProps({ item: { type: Object, required: true }, assets: { type: Array, default: () => [] } })
const emit = defineEmits(['open-asset', 'preview'])
const { t } = useI18n()
const failed = reactive({})
const imageSize = ref({ width: 0, height: 0 })
const pip = computed(() => parsePipMeta(props.item.map_pip))
const isMap = computed(() => (props.item.asset_type || props.item.assetType || 'prop') === 'map')
const loadedVersions = ref([])
const versionsError = ref(false)
const versions = computed(() => (props.item.image_versions || props.item.imageVersions || loadedVersions.value).filter(v => v?.url))
const frames = computed(() => pip.value?.role === 'overview' && Array.isArray(pip.value.frames) ? pip.value.frames : [])
const findAsset = id => props.assets.find(a => Number(a.id) === Number(id))
const parent = computed(() => pip.value?.role === 'detail' ? findAsset(pip.value.parent_prop_id) : null)
const imageUrl = path => path ? mediaUrl(path) : ''
const assetImage = item => imageUrl(item?.image_url || item?.imageUrl || item?.local_path || item?.localPath)

// ─── 动态反查引用（#125）─────────────────────────────────
const refs = ref(null)
const refsError = ref(false)
const detailRefs = ref({})
const shownRefs = computed(() => (refs.value?.references || []).slice(0, 12))
const detailCounts = frame => detailRefs.value[frame.no] || { total: 0, materialized: 0, planned: 0 }
/** 已落段 → 段编辑器；仅规划 → 设计卡（两者都在分镜制作工作台里） */
function routeOf(ref) {
  const tab = ref.materialized ? 'production' : 'design'
  const dramaId = refs.value?.drama_id ?? props.item.drama_id
  return `/drama/${dramaId}/episode/${ref.episode_number}?panel=production&tab=${tab}&shot=${ref.storyboard_id}`
}

async function loadReferences(id) {
  refs.value = null
  detailRefs.value = {}
  refsError.value = false
  if (!isMap.value) return
  try {
    const result = await propAPI.mapReferences(Number(id))
    if (props.item.id !== id) return
    refs.value = result
    // 全览：各细节资产各自的引用计数（详情列表在细节资产的弹窗里看）
    if (pip.value?.role === 'overview') {
      const entries = await Promise.all(frames.value
        .filter(frame => Number(frame.detail_prop_id) > 0)
        .map(async frame => [frame.no, await propAPI.mapReferences(Number(frame.detail_prop_id)).catch(() => null)]))
      if (props.item.id !== id) return
      const next = {}
      for (const [no, value] of entries) if (value) next[no] = { total: value.total, materialized: value.materialized, planned: value.planned }
      detailRefs.value = next
    }
  } catch {
    if (props.item.id === id) refsError.value = true
  }
}

// ─── 语义条目只读展示（#125）──────────────────────────────
const GROUPS = ['labels', 'points', 'regions', 'lines']
const semanticsEntries = computed(() => {
  let doc = props.item.semantics
  if (typeof doc === 'string') { try { doc = JSON.parse(doc) } catch { doc = null } }
  if (!doc || typeof doc !== 'object') return []
  return GROUPS.flatMap(group => (Array.isArray(doc[group]) ? doc[group] : []).map(entry => ({
    id: entry.id || `${group}-${entry.name || entry.text}`,
    name: group === 'labels' ? entry.text || '' : entry.name || '',
    group,
    ...(entry.description ? { description: entry.description } : {}),
    ...(Array.isArray(entry.keywords) && entry.keywords.length ? { keywords: entry.keywords } : {}),
  })))
})

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
  if (!(props.item.image_versions || props.item.imageVersions)) {
    try {
      const result = await assetLibraryAPI.detail('prop', id)
      if (props.item.id === id) loadedVersions.value = result?.image_versions || []
    } catch {
      if (props.item.id === id) versionsError.value = true
    }
  }
  await loadReferences(id)
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
.ref-counts { margin: 0; font: 600 12px var(--font-body); color: var(--text-1); }
.ref-list { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.ref-list li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ref-via { font-size: 11px; color: var(--text-2); }
.res-link { font-size: 12px; color: var(--accent-text); text-decoration: none; }
.sem-name { font: 600 12px var(--font-body); }
.sem-desc { margin: 0; font-size: 11.5px; color: var(--text-2); }
.sem-keys { margin: 0; font-size: 11px; color: var(--text-2); }
</style>
