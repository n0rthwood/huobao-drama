<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, episodeAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { WORKBENCH_CTX } from '~/utils/workbenchSteps'
import { batchScopeOf } from '~/utils/documentaryFinal'
import DocumentaryFinalShot from '~/components/DocumentaryFinalShot.vue'
import BatchScopeDialog from '~/components/BatchScopeDialog.vue'
import VideoQueueBar from '~/components/VideoQueueBar.vue'
import { toast } from 'vue-sonner'
import { DEEPLINK_KEYS, deeplinkInitial, queryIdList, querySingle, useDeeplink } from '~/composables/useQuerySync'
const ctx = inject(WORKBENCH_CTX)
const { t } = useI18n()
const kinds = ['voice', 'layer', 'video', 'compose']
const paths = { voice: 'narration/voice-batch', layer: 'layer-render-batch', video: 'video-batch', compose: 'compose-batch' }
const previews = ref({})
const statuses = ref({})
const selected = ref([])
const selectMode = ref(false)
const dialog = ref(null)
const busy = ref(false)
const error = ref('')
const voiceSettings = ref(null)
const retry = ref(false)
const episodeId = computed(() => ctx.episode.value?.id)
const shots = computed(() => ctx.sbs.value || [])
const scopeIds = computed(() => selectMode.value ? [...selected.value] : undefined)
const failedCount = computed(() => kinds.reduce((n, kind) => n + (statuses.value[kind]?.items || []).filter(item => item.state === 'failed' || item.status === 'failed').length, 0))
// deeplink（#86）：多选上下文与只读批量预览弹窗；恢复不提交生成任务。
const link = useDeeplink('finalPanel', DEEPLINK_KEYS.finalPanel)
const urlSel = querySingle(link.initial('sel'))
const urlRehearse = Number(querySingle(link.initial('rehearse')) || 0)
const urlDialog = querySingle(link.initial('fdlg'))
let dialogRestored = false
// 单镜配音弹窗的键属于 NarrationBlock 分组，这里只读初值做「分镜不存在」的提示
const urlVoice = Number(querySingle(deeplinkInitial('voice')) || 0)
// 多音字检查弹窗 nedlg=check:<分镜 id>（NarrationEditor 分组），同样只做存在性提示
const urlCheck = Number(/^check:(\d+)$/.exec(querySingle(deeplinkInitial('nedlg')) || '')?.[1] || 0)
let selRestored = false
watch(shots, list => {
  if (selRestored || !list.length) return
  selRestored = true
  // 预演弹窗由对应分镜组件自行恢复，这里只负责「分镜已不存在」的提示
  if (urlRehearse > 0 && !list.some(shot => shot.id === urlRehearse)) toast.warning(t('deeplink.missingNamed', { target: `#${urlRehearse}` }))
  if (urlVoice > 0 && !list.some(shot => shot.id === urlVoice)) toast.warning(t('deeplink.missingNamed', { target: `#${urlVoice}` }))
  if (urlCheck > 0 && !list.some(shot => shot.id === urlCheck)) toast.warning(t('deeplink.missingNamed', { target: `#${urlCheck}` }))
  if (!urlSel) return
  selectMode.value = true
  const ids = queryIdList(urlSel)
  const alive = ids.filter(id => list.some(shot => shot.id === id))
  selected.value = alive
  if (alive.length < ids.length) toast.warning(t('deeplink.missing'))
}, { immediate: true })
watch([selectMode, selected, () => dialog.value?.kind, retry], () => link.set({
  shot: '',
  sel: selectMode.value ? (selected.value.join(',') || 'on') : '',
  fdlg: dialog.value ? `${dialog.value.kind}${retry.value ? ':retry' : ''}` : '',
}), { deep: true, immediate: true })
function rowsOf(result) { return Array.isArray(result) ? result : result?.items || [] }
async function preview(kind, retryOnly = false) {
  if (!episodeId.value) return
  busy.value = true; error.value = ''
  try {
    if (kind === 'voice' && !voiceSettings.value) voiceSettings.value = (await episodeAPI.ttsOptions(episodeId.value)).current
    const result = await api.post(`/episodes/${episodeId.value}/${paths[kind]}/preview`, { storyboard_ids: scopeIds.value, ...(kind === 'voice' ? { settings: voiceSettings.value } : {}), ...(retryOnly ? { retry_failed: true } : {}) })
    previews.value[kind] = result
    const items = rowsOf(result)
    dialog.value = { kind, items, scope: result.scope }
    retry.value = retryOnly
  } catch (e) { error.value = e.message; toastError(e) } finally { busy.value = false }
}
async function restoreFinalDialog() {
  if (dialogRestored || !episodeId.value || !shots.value.length) return
  dialogRestored = true
  if (!urlDialog || dialog.value) return
  const match = /^(voice|layer|video|compose)(:retry)?$/.exec(urlDialog)
  if (!match) { toast.warning(t('deeplink.missing')); return }
  await preview(match[1], !!match[2])
}
watch([episodeId, () => shots.value.length], () => { void restoreFinalDialog() }, { immediate: true })
async function start(ids) {
  busy.value = true
  try {
    const kind = dialog.value.kind
    const result = await api.post(`/episodes/${episodeId.value}/${paths[kind]}${retry.value ? '/retry-failed' : ''}`, { storyboard_ids: ids, ...(kind === 'voice' ? { settings: voiceSettings.value } : {}) })
    statuses.value[kind] = result
    dialog.value = null
    await ctx.refresh()
  } catch (e) { error.value = e.message; toastError(e) } finally { busy.value = false }
}
async function updateStatuses() {
  if (!episodeId.value) return
  await Promise.all(kinds.map(async kind => {
    try { statuses.value[kind] = await api.get(`/episodes/${episodeId.value}/${paths[kind]}${kind === 'video' ? '' : '-status'}`) } catch (e) { error.value = e.message }
  }))
}
async function loadCounts() {
  if (!episodeId.value) return
  try { voiceSettings.value = (await episodeAPI.ttsOptions(episodeId.value)).current } catch (e) { error.value = e.message }
  await Promise.all(kinds.map(async kind => {
    try { previews.value[kind] = await api.post(`/episodes/${episodeId.value}/${paths[kind]}/preview`, { ...(kind === 'voice' ? { settings: voiceSettings.value } : {}) }) } catch (e) { error.value = e.message }
  }))
}
function count(kind) { const result = previews.value[kind]; return batchScopeOf(result)?.included.length ?? rowsOf(result).filter(item => item.selectable !== false && item.checked !== false && !['blocked', 'excluded', 'skipped', 'disabled', 'unchanged'].includes(item.status)).length }
let timer
onMounted(async () => { await Promise.all([loadCounts(), updateStatuses()]); timer = setInterval(updateStatuses, 5000) })
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <div class="documentary-final prod-content">
    <div class="final-toolbar">
      <button v-for="kind in kinds" :key="kind" class="btn btn-sm" :disabled="busy || !shots.length || (selectMode && !selected.length)" @click="preview(kind)">{{ t(`episode.final.batch.${kind}`) }} {{ count(kind) }}/{{ shots.length }}</button>
      <button class="btn btn-sm" :aria-pressed="selectMode" @click="selectMode = !selectMode">{{ t('episode.vid.select') }} {{ selected.length }}</button>
      <details v-if="failedCount"><summary>{{ t('episode.vid.retryFailed', { n: failedCount }) }}</summary><button v-for="kind in kinds" :key="kind" class="btn btn-sm" @click="preview(kind, true)">{{ t(`episode.final.batch.${kind}`) }}</button></details>
      <details><summary>{{ t('episode.narration.section') }}</summary><label v-if="voiceSettings">{{ t('episode.final.voice') }}<input v-model="voiceSettings.voice" class="input" /></label><button class="btn btn-sm" @click="ctx.narrationSettingsOpen.value = true">{{ t('episode.final.settings') }} ↗</button></details>
    </div>
    <p v-if="error" class="final-error">{{ error }}</p>
    <VideoQueueBar :tasks="ctx.activeVideoTasks.value" :config-id="ctx.selectedVideoConfig.value?.id ?? null" />
    <div v-for="kind in kinds" :key="kind" class="final-batch-status">
      <template v-if="batchScopeOf(statuses[kind])">{{ t(`episode.final.batch.${kind}`) }} · {{ statuses[kind].status || statuses[kind].state }} · {{ t('episode.final.scope', { included: batchScopeOf(statuses[kind]).included.length, excluded: batchScopeOf(statuses[kind]).excluded.length }) }}</template>
    </div>
    <div v-for="(sb, index) in shots" :key="sb.id">
      <label v-if="selectMode"><input v-model="selected" type="checkbox" :value="sb.id" />#{{ index + 1 }}</label>
      <DocumentaryFinalShot :storyboard="sb" :number="sb.storyboard_number || sb.storyboardNumber || index + 1" @compose-batch="preview('compose')" />
    </div>
    <BatchScopeDialog v-if="dialog" :title="t(`episode.final.batch.${dialog.kind}`)" :items="dialog.items" :scope="dialog.scope" :retry-mode="retry" :busy="busy" @close="dialog = null" @confirm="start" />
  </div>
</template>
<style scoped>.documentary-final{padding:16px;overflow:auto}.final-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;position:sticky;top:0;background:var(--bg-1);z-index:2;padding:10px}.final-error{color:var(--error)}.final-batch-status{font-size:12px;color:var(--text-2)}</style>
