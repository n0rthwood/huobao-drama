<template>
  <section class="draft-panel" @click.stop>
    <div class="dp-head">
      <strong>{{ t('assetStudio.draftPrompt') }}</strong>
      <span class="pip-badge" :class="`dp-${draft.status}`">{{ statusLabel }}</span>
      <span v-if="draft.image_model" class="dim dp-model">{{ draft.image_model }}</span>
    </div>

    <p v-if="draft.status === 'drafting'" class="dp-hint"><Loader2 :size="12" class="animate-spin" />{{ t('assetStudio.draftGenerating') }}</p>
    <template v-else-if="draft.status === 'failed'">
      <StudioError :error="draft.error_msg || t('assetStudio.draftFailed')" />
      <button class="btn btn-sm" type="button" :disabled="busy" @click="retry"><Loader2 v-if="busy" :size="11" class="animate-spin" />{{ t('assetStudio.draftRetry') }}</button>
    </template>

    <template v-else>
      <AssetFactSheet v-if="draft.spec" :spec="draft.spec" :initially-open="true" />
      <div v-if="inputSummary.length" class="dp-inputs">
        <strong>{{ t('assetStudio.inputsSummary') }}</strong>
        <ul>
          <li v-for="(item, i) in inputSummary" :key="i">{{ item }}</li>
        </ul>
      </div>
      <textarea v-model="promptText" class="input dp-prompt" rows="8" :disabled="draft.status === 'generating'" />
      <details v-if="negativeText" class="dp-negative">
        <summary>{{ t('assetStudio.draftNegative') }}</summary>
        <textarea v-model="negativeText" class="input" rows="3" :disabled="draft.status === 'generating'" />
      </details>
      <div class="dp-actions">
        <button class="btn btn-sm" type="button" :disabled="busy || draft.status === 'generating' || !promptText.trim()" @click="savePrompt">
          <Loader2 v-if="saving" :size="11" class="animate-spin" />{{ t('assetStudio.savePrompt') }}
        </button>
        <button class="btn btn-sm btn-primary" type="button" :disabled="busy || draft.status === 'generating' || !promptText.trim()" @click="askGenerate">
          <Loader2 v-if="generating" :size="11" class="animate-spin" />{{ t('assetStudio.confirmGenerate') }}
        </button>
        <button v-if="activeRunId" class="btn btn-sm" type="button" @click="cancelRun">{{ t('common.cancel') }}</button>
      </div>
      <p v-if="draft.status === 'generating'" class="dp-hint"><Loader2 :size="12" class="animate-spin" />{{ t('assetStudio.generating') }}</p>
      <StudioError v-if="error" :error="error" />
    </template>

    <ConfirmDialog
      :open="confirmOpen"
      :title="t('assetStudio.confirmGenerateTitle')"
      :message="confirmSummary"
      :loading="generating"
      @confirm="doGenerate"
      @cancel="confirmOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
/**
 * 草稿面板（Issue #123，两 TAB 共用）：drafting 进度 / failed 重展开 / ready 可编辑 prompt +
 * 最终确认生图 / generating 进度。确认前先保存 prompt，generate 带 expected_updated_at 防旧稿。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import AssetFactSheet from './AssetFactSheet.vue'
import StudioError from './StudioError.vue'
import { assetStudioAPI, type AssetStudioDraft } from '../api'

const props = defineProps<{ draft: AssetStudioDraft; taskId: number }>()
const emit = defineEmits<{ (e: 'update', draft: AssetStudioDraft): void; (e: 'generated', runId: number): void; (e: 'changed'): void }>()
const { t } = useI18n()

const promptText = ref(props.draft.prompt ?? '')
const negativeText = ref(props.draft.negative_prompt ?? '')
const saving = ref(false)
const generating = ref(false)
const busy = ref(false)
const error = ref('')
const confirmOpen = ref(false)
const activeRunId = ref<number | null>(null)
const savedDraft = ref<AssetStudioDraft | null>(null)
const pendingDraft = ref<AssetStudioDraft | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let stopped = false

watch(() => props.draft.id, () => {
  promptText.value = props.draft.prompt ?? ''
  negativeText.value = props.draft.negative_prompt ?? ''
  activeRunId.value = null
  error.value = ''
})
watch(() => props.draft.prompt, value => { if (props.draft.status === 'ready') promptText.value = value ?? '' })

const statusLabel = computed(() => {
  const key = { drafting: 'draftGenerating', ready: 'draftReady', failed: 'draftFailed', generating: 'generating', consumed: 'draftConsumed' }[props.draft.status]
  return t(`assetStudio.${key}`)
})

const inputSummary = computed(() => {
  const inputs = props.draft.inputs as Record<string, unknown>
  const items: string[] = []
  if (props.draft.tab === 'precision') {
    const shas = (inputs.source_shas ?? []) as Array<{ local_path: string }>
    const candidates = (inputs.resolved_candidates ?? []) as Array<{ local_path: string }>
    for (const row of [...shas, ...candidates]) items.push(row.local_path)
    const texts = (inputs.resolved_texts ?? []) as Array<{ title: string }>
    for (const text of texts) items.push(text.title)
  } else if (inputs.version_path) {
    items.push(String(inputs.version_path))
  }
  if (inputs.notes) items.push(String(inputs.notes))
  return items
})

const confirmSummary = computed(() => {
  const inputs = props.draft.inputs as Record<string, unknown>
  const images = props.draft.tab === 'precision'
    ? ((inputs.source_shas ?? []) as unknown[]).length + ((inputs.resolved_candidates ?? []) as unknown[]).length
    : 1
  const imageNames = inputSummary.value.filter(item => item.startsWith('static/')).map(item => item.split('/').pop()).join('、') || '—'
  const texts = props.draft.tab === 'precision' ? ((inputs.resolved_texts ?? []) as unknown[]).length : 0
  return t('assetStudio.confirmGenerateSummary', { images, imageNames, texts, model: props.draft.image_model || t('assetStudio.automatic') })
})

async function savePrompt(): Promise<boolean> {
  saving.value = true
  error.value = ''
  try {
    const updated = await assetStudioAPI.editDraft(props.draft.id, { prompt: promptText.value, negative_prompt: negativeText.value || null })
    savedDraft.value = updated
    emit('update', updated)
    toast.success(t('assetStudio.promptSaved'))
    return true
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
    return false
  } finally {
    saving.value = false
  }
}

async function askGenerate() {
  // 确认前必须等待 prompt 保存成功（评审 P1-5：防「确认框显示新稿，后端生成旧稿」）
  busy.value = true
  let latest = props.draft
  if (promptText.value !== (props.draft.prompt ?? '')) {
    const ok = await savePrompt()
    if (!ok) { busy.value = false; return }
    latest = savedDraft.value ?? props.draft
  }
  pendingDraft.value = latest
  busy.value = false
  confirmOpen.value = true
}

async function doGenerate() {
  generating.value = true
  error.value = ''
  try {
    const result = await assetStudioAPI.generateDraft(props.draft.id, { expected_updated_at: (pendingDraft.value ?? props.draft).updated_at })
    confirmOpen.value = false
    activeRunId.value = result.run_id
    emit('update', result.draft)
    emit('generated', result.run_id)
    toast.success(t('assetStudio.generateStarted'))
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
    confirmOpen.value = false
  } finally {
    generating.value = false
  }
}

async function retry() {
  busy.value = true
  error.value = ''
  try {
    const updated = await assetStudioAPI.retryDraft(props.draft.id)
    emit('update', updated)
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  } finally {
    busy.value = false
  }
}

async function cancelRun() {
  if (!activeRunId.value) return
  try {
    await assetStudioAPI.cancel(activeRunId.value)
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  }
}

async function poll() {
  if (stopped) return
  if (props.draft.status === 'drafting' || props.draft.status === 'generating') {
    try {
      const updated = await assetStudioAPI.draft(props.draft.id)
      if (!stopped) emit('update', updated)
      if (updated.status === 'consumed' || updated.status === 'failed') emit('changed')
    } catch (err) { void err }
  }
}

onMounted(() => { timer = setInterval(() => void poll(), 3000) })
onBeforeUnmount(() => { stopped = true; clearInterval(timer) })
</script>

<style scoped>
.draft-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.dp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dp-model { margin-left: auto; font-size: 11px; }
.dp-hint { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--text-3); }
.dp-prompt { width: 100%; font-size: 12px; line-height: 1.5; resize: vertical; }
.dp-negative summary { font-size: 11px; color: var(--text-3); cursor: pointer; }
.dp-negative textarea { width: 100%; margin-top: 4px; font-size: 11px; }
.dp-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dp-inputs { font-size: 11px; color: var(--text-2); }
.dp-inputs ul { margin: 4px 0 0; padding-left: 16px; }
.dp-inputs li { overflow-wrap: anywhere; }
.dp-ready { background: var(--accent-bg, var(--surface)); color: var(--accent-text); }
.dp-consumed { background: var(--success-bg, var(--surface)); color: var(--success, var(--text-2)); }
.dp-failed { background: var(--danger-bg, var(--surface)); color: var(--danger, var(--text-2)); }
.dp-generating, .dp-drafting { background: var(--surface); color: var(--text-3); }
.pip-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; }
.animate-spin { animation: dp-spin 1s linear infinite; }
@keyframes dp-spin { to { transform: rotate(360deg); } }
</style>