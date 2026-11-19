<template>
  <main class="as-page">
    <header><div><NuxtLink to="/asset-studio">{{ t('assetStudio.title') }}</NuxtLink><h1>{{ detail?.target?.title || detail?.task.title || `#${taskId}` }}</h1><p v-if="detail?.target?.subtitle" class="dim">{{ detail.target.subtitle }}</p></div><NuxtLink v-if="detail?.target?.return_path" class="btn btn-sm" :to="detail.target.return_path">{{ t('assetStudio.returnHost') }}</NuxtLink><button class="btn btn-sm" @click="refreshAll">{{ t('assetStudio.refresh') }}</button></header>
    <StudioError :error="error" />
    <p v-if="loading && !detail">{{ t('common.loading') }}</p>
    <template v-if="detail">
      <section v-if="detail.asset" class="as-snapshot">
        <h2>{{ t('assetStudio.assetInput') }}</h2>
        <div class="as-badges">
          <span class="as-badge">{{ t(`assetStudio.kind${cap(detail.asset.kind)}`) }}</span>
          <span v-if="detail.asset.subtype" class="as-badge as-badge-sub">{{ detail.asset.subtype }}</span>
          <span v-if="detail.asset.faithful" class="as-badge as-badge-faithful"><Lock :size="11" />{{ t('assetStudio.faithfulBadge') }}</span>
        </div>
        <div class="as-input-grid"><button v-if="detail.asset.imageUrl" class="as-image" @click="preview(detail.asset.imageUrl, detail.asset.name)"><img :src="mediaUrl(detail.asset.imageUrl)" :alt="detail.asset.name" /></button><dl><template v-for="field in inputFields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></template></dl></div>
      </section>
      <p v-else class="dim">{{ t('assetStudio.targetMissing') }}</p>

      <div class="as-tabs" role="tablist">
        <button type="button" role="tab" :class="['as-tab', { active: activeTab === 'precision' }]" :aria-selected="activeTab === 'precision'" @click="setTab('precision')">{{ t('assetStudio.tabs.precision') }}</button>
        <button type="button" role="tab" :class="['as-tab', { active: activeTab === 'beautify' }]" :aria-selected="activeTab === 'beautify'" @click="setTab('beautify')">{{ t('assetStudio.tabs.beautify') }}</button>
      </div>
      <PrecisionTab
        v-if="activeTab === 'precision'"
        :key="`precision-${taskId}`"
        :task-id="taskId"
        :sources="detail.sources"
        :initial-draft="latestDraft('precision')"
        @preview="preview"
        @sources-changed="load"
        @generated="onGenerated"
        @changed="load"
      />
      <BeautifyTab
        v-else
        :key="`beautify-${taskId}`"
        :task-id="taskId"
        :initial-draft="latestDraft('beautify')"
        @generated="onGenerated"
        @changed="load"
      />

      <section class="as-rounds">
        <h2>{{ t('assetStudio.historyRounds') }}</h2>
        <p v-if="!detail.rounds.length" class="dim">{{ t('assetStudio.noRounds') }}</p>
        <article v-for="round in detail.rounds" :key="round.id" class="as-round">
          <div class="as-round-head">
            <span class="as-badge">{{ t(`assetStudio.tabs.${round.purpose}`) }}</span>
            <span class="dim">#{{ round.id }} · {{ t('assetStudio.run') }} #{{ round.pipeline_task_id }}</span>
            <span class="as-badge" :class="`as-round-${round.status}`">{{ round.status }}</span>
            <span v-if="round.version_deleted" class="as-badge as-badge-deleted">{{ t('assetStudio.versionDeleted') }}</span>
          </div>
          <div class="as-round-body">
            <button v-if="round.image_path && !round.version_deleted" class="as-image as-round-image" @click="preview(round.image_path, t('episode.documentary.pipeline.roundImageTitle'))">
              <img :src="thumbOf(mediaUrl(round.image_path))" :alt="t('episode.documentary.pipeline.roundImageTitle')" loading="lazy" @error="thumbFallback($event, mediaUrl(round.image_path))" />
            </button>
            <div class="as-round-info">
              <details class="as-round-prompt"><summary>{{ t('assetStudio.roundPrompt') }}</summary><p>{{ round.prompt }}</p></details>
              <div v-if="round.reference_images.length" class="as-round-refs">
                <span v-for="(ref, i) in round.reference_images" :key="i" class="dim as-round-ref">{{ ref.path.split('/').pop() }}<template v-if="ref.type === 'source'"> ({{ t('assetStudio.version') }} #{{ ref.source_id }})</template></span>
              </div>
              <template v-if="round.qc">
                <strong class="as-qc-title">{{ t('assetStudio.qcAdvisory') }} — {{ round.gate?.pass ? 'PASS' : 'FAIL' }}</strong>
                <ul v-if="round.gate" class="as-qc-list">
                  <li v-for="v in round.gate.violations" :key="v.id" class="as-qc-fail">{{ v.element }}：{{ v.evidence }}</li>
                  <li v-for="f in round.gate.forbidden_hits" :key="f.id" class="as-qc-fail">{{ f.error }}：{{ f.evidence }}</li>
                  <li v-if="!round.gate.violations.length && !round.gate.forbidden_hits.length" class="as-qc-ok">{{ round.gate.coverage * 100 }}% coverage</li>
                </ul>
              </template>
              <p v-else-if="round.purpose === 'precision' && round.status === 'generated'" class="dim">{{ t('assetStudio.qcIncomplete') }}</p>
              <p v-if="round.error_msg" class="as-round-error">{{ round.error_msg }}</p>
              <div v-if="round.status === 'generated' && !round.version_deleted" class="as-round-actions">
                <button class="btn btn-sm" type="button" :disabled="delivering === round.id" @click="deliver(round, false)">{{ t('assetStudio.saveVersionOnly') }}</button>
                <button class="btn btn-sm btn-primary" type="button" :disabled="delivering === round.id" @click="askAdopt(round)">{{ t('assetStudio.adoptCurrent') }}</button>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section class="as-deliveries"><h2>{{ t('assetStudio.deliveries') }}</h2><p v-if="!detail.deliveries.length" class="dim">{{ t('assetStudio.noDeliveries') }}</p><ul><li v-for="row in detail.deliveries" :key="row.id">#{{ row.id }} · {{ t('assetStudio.run') }} #{{ row.run_id }} · {{ t('episode.documentary.pipeline.roundLabel', {n: row.round_id}) }} · {{ t('assetStudio.version') }} #{{ row.version_id || '—' }} · {{ row.set_as_current ? t('assetStudio.adopted') : t('assetStudio.versionOnly') }} · {{ new Date(row.created_at).toLocaleString() }} <code>{{ row.image_sha256 }}</code></li></ul></section>
      <ModuleSettings />
    </template>
    <ConfirmDialog
      :open="Boolean(adoptRound)"
      :title="t('assetStudio.adoptCurrent')"
      :message="t('assetStudio.adoptFaithfulConfirm')"
      :loading="Boolean(delivering)"
      @confirm="doAdopt"
      @cancel="adoptRound = null"
    />
    <Teleport to="body"><div v-if="previewUrl" class="as-preview" role="dialog" aria-modal="true" :aria-label="previewTitle" @click.self="closePreview"><button class="btn as-close" :aria-label="t('common.close')" @click="closePreview">×</button><img :src="previewUrl" :alt="previewTitle" @error="previewMissing" /></div></Teleport>
  </main>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Lock } from 'lucide-vue-next'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { assetStudioAPI, type AssetPipelineRound, type AssetStudioDetail, type AssetStudioDraft } from '../api'
import BeautifyTab from '../components/BeautifyTab.vue'
import ModuleSettings from '../components/ModuleSettings.vue'
import PrecisionTab from '../components/PrecisionTab.vue'
import StudioError from '../components/StudioError.vue'
import { mediaUrl } from '~/utils/url'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { DEEPLINK_KEYS, deeplinkHydrate, useDeeplink } from '~/composables/useQuerySync'
const { t } = useI18n()
const route = useRoute()
const taskId = computed(() => Number(route.params.taskId))
const detail = ref<AssetStudioDetail | null>(null)
const loading = ref(false)
const error = ref('')
const previewUrl = ref('')
const previewTitle = ref('')
const activeTab = ref<'precision' | 'beautify'>('precision')
const delivering = ref<number | null>(null)
const adoptRound = ref<AssetPipelineRound | null>(null)
const link = useDeeplink('assetStudioPreview', DEEPLINK_KEYS.assetStudioPreview)
const tabLink = useDeeplink('assetStudioTab', DEEPLINK_KEYS.assetStudioTab)
let stopped = false
let sequence = 0
const inputFields = computed(() => [
 {key: 'description', label: t('episode.asset.appearanceOfObject'), value: detail.value?.asset?.description},
 {key: 'appearance', label: t('episode.asset.appearanceField'), value: detail.value?.asset?.appearance},
 {key: 'styling', label: t('episode.asset.stylingField'), value: detail.value?.asset?.styling},
 {key: 'prompt', label: t('episode.asset.sceneDescField'), value: detail.value?.asset?.prompt},
 {key: 'lighting', label: t('episode.asset.sceneLightField'), value: detail.value?.asset?.lighting},
 {key: 'finalPrompt', label: t('assetStudio.finalPromptField'), value: detail.value?.asset?.finalPrompt},
].filter(field => field.value))
function cap(value: string) { return value ? value[0].toUpperCase() + value.slice(1) : '' }
function latestDraft(tab: 'precision' | 'beautify'): AssetStudioDraft | null {
  return detail.value?.drafts.find(draft => draft.tab === tab) ?? null
}
function setTab(tab: 'precision' | 'beautify') { activeTab.value = tab; tabLink.set({ tab }) }
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
async function refreshAll() {
  // 显式同步（幂等）：直达/刷新也把资产参考图导入素材池（GET 保持只读）
  try { await assetStudioAPI.sync(taskId.value) } catch { /* 同步失败不阻断读取 */ }
  await load()
}
function onGenerated(_runId: number) { void load() }
async function deliver(round: AssetPipelineRound, setAsCurrent: boolean) {
  delivering.value = round.id
  try {
    await assetStudioAPI.deliver(round.pipeline_task_id, round.id, setAsCurrent)
    toast.success(t('assetStudio.delivered'))
    await load()
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('assetStudio.loadFailed'))
  } finally {
    delivering.value = null
  }
}
function askAdopt(round: AssetPipelineRound) {
  if (detail.value?.asset?.faithful) adoptRound.value = round
  else void deliver(round, true)
}
async function doAdopt() {
  const round = adoptRound.value
  adoptRound.value = null
  if (round) await deliver(round, true)
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape') closePreview() }
watch(taskId, () => { detail.value = null; closePreview(); void refreshAll() })
onMounted(async () => {
  const wantedTab = String(tabLink.initial('tab') || '')
  if (wantedTab === 'beautify') activeTab.value = 'beautify'
  await refreshAll()
  const wanted = String(link.initial('asview') || '')
  if (wanted && !/^(?:javascript|data):/i.test(wanted)) preview(wanted, t('episode.documentary.pipeline.roundImageTitle'))
  window.addEventListener('keydown', escape)
  await nextTick()
  deeplinkHydrate()
})
onBeforeUnmount(() => { stopped = true; sequence++; window.removeEventListener('keydown', escape) })
</script>
<style scoped>
.as-page { max-width: 1280px; margin: auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; flex: 1; min-height: 0; overflow-y: auto; width: 100%; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; } header > div { margin-right: auto; }
h1 { margin: 6px 0; font-size: 22px; } h2 { font-size: 16px; margin: 0 0 12px; } h3 { font-size: 13px; }
.as-snapshot, .as-deliveries, .as-rounds { border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.as-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.as-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; background: var(--surface-soft); color: var(--text-2); border: 1px solid var(--border); }
.as-badge-sub { background: var(--accent-bg, var(--surface-soft)); color: var(--accent-text); }
.as-badge-faithful { background: var(--warn-bg, var(--surface-soft)); color: var(--warn-text, var(--text-2)); }
.as-badge-deleted { background: var(--danger-bg, var(--surface-soft)); color: var(--danger, var(--text-2)); }
.as-input-grid { display: grid; grid-template-columns: minmax(160px, 1fr) 2fr; gap: 16px; } dl { margin: 0; } dt { font-size: 11px; color: var(--text-3); } dd { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.as-image { border: 1px solid var(--border); border-radius: 6px; background: var(--surface-soft); padding: 0; cursor: zoom-in; } .as-image img { width: 100%; max-height: 300px; object-fit: contain; }
.as-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.as-tab { padding: 8px 16px; border: 0; background: none; cursor: pointer; font-size: 13px; color: var(--text-3); border-bottom: 2px solid transparent; }
.as-tab.active { color: var(--accent-text); border-bottom-color: var(--accent); font-weight: 650; }
.as-round { border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
.as-round-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; }
.as-round-generated { background: var(--success-bg, var(--surface-soft)); color: var(--success, var(--text-2)); }
.as-round-failed { background: var(--danger-bg, var(--surface-soft)); color: var(--danger, var(--text-2)); }
.as-round-body { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 12px; }
.as-round-image img { max-height: 160px; }
.as-round-info { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 11px; }
.as-round-prompt summary { cursor: pointer; color: var(--text-3); }
.as-round-prompt p { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
.as-round-refs { display: flex; flex-wrap: wrap; gap: 6px; }
.as-round-ref { overflow-wrap: anywhere; }
.as-qc-title { font-size: 11px; }
.as-qc-list { margin: 0; padding-left: 16px; }
.as-qc-fail { color: var(--danger, var(--text-2)); }
.as-qc-ok { color: var(--success, var(--text-2)); }
.as-round-error { margin: 0; color: var(--danger, var(--text-2)); }
.as-round-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.as-deliveries li { overflow-wrap: anywhere; margin-bottom: 8px; font-size: 12px; } code { font-size: 10px; }
.as-preview { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.92); display: flex; align-items: center; justify-content: center; padding: 48px; }.as-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }.as-close { position: absolute; right: 16px; top: 16px; }
@media (max-width: 720px) { .as-input-grid { grid-template-columns: 1fr; }.as-page { padding: 16px; }.as-round-body { grid-template-columns: 1fr; } }
</style>