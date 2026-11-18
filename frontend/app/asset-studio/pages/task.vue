<template>
  <main class="as-page">
    <header><div><NuxtLink to="/asset-studio">{{ t('assetStudio.title') }}</NuxtLink><h1>{{ detail?.target?.title || detail?.task.title || `#${taskId}` }}</h1><p v-if="detail?.target?.subtitle" class="dim">{{ detail.target.subtitle }}</p></div><NuxtLink v-if="detail?.target?.return_path" class="btn btn-sm" :to="detail.target.return_path">{{ t('assetStudio.returnHost') }}</NuxtLink><button class="btn btn-sm" @click="load">{{ t('assetStudio.refresh') }}</button></header>
    <StudioError :error="error" />
    <p v-if="loading && !detail">{{ t('common.loading') }}</p>
    <template v-if="detail">
      <section v-if="detail.asset" class="as-snapshot">
        <h2>{{ t('assetStudio.assetInput') }}</h2>
        <div class="as-input-grid"><button v-if="detail.asset.imageUrl" class="as-image" @click="preview(detail.asset.imageUrl, detail.asset.name)"><img :src="mediaUrl(detail.asset.imageUrl)" :alt="detail.asset.name" /></button><dl><template v-for="field in inputFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ field.value || '—' }}</dd></template></dl></div>
        <h3>{{ t('episode.documentary.pipeline.referenceTitle') }}</h3>
        <div class="as-refs"><button v-for="ref in detail.asset.referenceImages" :key="ref.path" class="as-image" @click="preview(ref.path, detail.asset?.name || '')"><img :src="mediaUrl(ref.path)" :alt="ref.usage || t('episode.documentary.pipeline.referenceTitle')" /><span>{{ ref.usage }}</span></button></div>
      </section>
      <p v-else class="dim">{{ t('assetStudio.targetMissing') }}</p>
      <AssetPipeline :key="taskId" :task-id="taskId" :asset-name="detail.task.title" :map-configured="!detail.asset || detail.asset.isMap" :faithful="detail.asset?.faithful" @preview="preview" @update="load" />
      <section class="as-deliveries"><h2>{{ t('assetStudio.deliveries') }}</h2><p v-if="!detail.deliveries.length" class="dim">{{ t('assetStudio.noDeliveries') }}</p><ul><li v-for="row in detail.deliveries" :key="row.id">#{{ row.id }} · {{ t('assetStudio.run') }} #{{ row.run_id }} · {{ t('episode.documentary.pipeline.roundLabel', {n: row.round_id}) }} · {{ t('assetStudio.version') }} #{{ row.version_id || '—' }} · {{ row.set_as_current ? t('assetStudio.adopted') : t('assetStudio.versionOnly') }} · {{ new Date(row.created_at).toLocaleString() }} <code>{{ row.image_sha256 }}</code></li></ul></section>
      <ModuleSettings />
    </template>
    <Teleport to="body"><div v-if="previewUrl" class="as-preview" role="dialog" aria-modal="true" :aria-label="previewTitle" @click.self="closePreview"><button class="btn as-close" :aria-label="t('common.close')" @click="closePreview">×</button><img :src="previewUrl" :alt="previewTitle" @error="previewMissing" /></div></Teleport>
  </main>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { assetStudioAPI, type AssetStudioDetail } from '../api'
import AssetPipeline from '../components/AssetPipeline.vue'
import ModuleSettings from '../components/ModuleSettings.vue'
import StudioError from '../components/StudioError.vue'
import { mediaUrl } from '~/utils/url'
import { DEEPLINK_KEYS, deeplinkHydrate, useDeeplink } from '~/composables/useQuerySync'
const { t } = useI18n()
const route = useRoute()
const taskId = computed(() => Number(route.params.taskId))
const detail = ref<AssetStudioDetail | null>(null)
const loading = ref(false)
const error = ref('')
const previewUrl = ref('')
const previewTitle = ref('')
const link = useDeeplink('assetStudioPreview', DEEPLINK_KEYS.assetStudioPreview)
let stopped = false
let sequence = 0
const inputFields = computed(() => [
 {key: 'description', label: t('episode.asset.appearanceOfObject'), value: detail.value?.asset?.description},
 {key: 'appearance', label: t('episode.asset.appearanceField'), value: detail.value?.asset?.appearance},
 {key: 'styling', label: t('episode.asset.stylingField'), value: detail.value?.asset?.styling},
 {key: 'prompt', label: t('episode.asset.sceneDescField'), value: detail.value?.asset?.prompt},
 {key: 'lighting', label: t('episode.asset.sceneLightField'), value: detail.value?.asset?.lighting},
].filter(field => field.value))
function preview(url: string, title: string) { previewUrl.value = mediaUrl(url); previewTitle.value = title; link.set({asview: url}) }
function closePreview() { previewUrl.value = ''; link.set({asview: ''}) }
function previewMissing() { closePreview(); toast.warning(t('deeplink.missing')) }
async function load() {
  const seq = ++sequence
  loading.value = true; error.value = ''
  try {
    const data = await assetStudioAPI.task(taskId.value)
    if (stopped || sequence !== seq) return
    detail.value = data
  } catch (err) { if (!stopped) error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed') }
  finally { if (!stopped && sequence === seq) loading.value = false }
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape') closePreview() }
watch(taskId, () => { detail.value = null; closePreview(); void load() })
onMounted(async () => {
  await load()
  const wanted = String(link.initial('asview') || '')
  if (wanted && !/^(?:javascript|data):/i.test(wanted)) preview(wanted, t('episode.documentary.pipeline.roundImageTitle'))
  window.addEventListener('keydown', escape)
  await nextTick()
  deeplinkHydrate()
})
onBeforeUnmount(() => { stopped = true; sequence++; window.removeEventListener('keydown', escape) })
</script>
<style scoped>
.as-page { max-width: 1280px; margin: auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; } header > div { margin-right: auto; }
h1 { margin: 6px 0; font-size: 22px; } h2 { font-size: 16px; margin: 0 0 12px; } h3 { font-size: 13px; }
.as-snapshot, .as-deliveries { border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.as-input-grid { display: grid; grid-template-columns: minmax(160px, 1fr) 2fr; gap: 16px; } dl { margin: 0; } dt { font-size: 11px; color: var(--text-3); } dd { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.as-image { border: 1px solid var(--border); border-radius: 6px; background: var(--surface-soft); padding: 0; cursor: zoom-in; } .as-image img { width: 100%; max-height: 300px; object-fit: contain; }
.as-refs { display: flex; flex-wrap: wrap; gap: 8px; } .as-refs .as-image { width: 120px; }
.as-deliveries li { overflow-wrap: anywhere; margin-bottom: 8px; font-size: 12px; } code { font-size: 10px; }
.as-preview { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.92); display: flex; align-items: center; justify-content: center; padding: 48px; }.as-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }.as-close { position: absolute; right: 16px; top: 16px; }
@media (max-width: 720px) { .as-input-grid { grid-template-columns: 1fr; }.as-page { padding: 16px; } }
</style>
