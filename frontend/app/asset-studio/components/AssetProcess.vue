<template>
  <section class="as-process">
    <header><strong>{{ t('assetStudio.process') }}</strong><button class="btn btn-sm" :disabled="loading" @click="load(true)">{{ t('assetStudio.refresh') }}</button></header>
    <StudioError :error="error" />
    <ol><li v-for="work in works" :key="String(work.id)"><pre>{{ JSON.stringify(work, null, 2) }}</pre></li></ol>
    <ol v-if="spans.length"><li v-for="(span, index) in spans" :key="index"><strong>{{ stageLabel(String(span.stage || '')) }}</strong> · {{ span.status }}<pre>{{ JSON.stringify(span, null, 2) }}</pre></li></ol>
    <p v-if="!calls.length" class="dim">{{ t('assetStudio.noCalls') }}</p>
    <article v-for="call in calls" :key="call.id">
      <button class="btn btn-sm" :aria-expanded="selectedCall === call.id" @click="selectCall(call.id)">#{{ call.id }} · {{ call.stage || '' }} · {{ call.model || '' }} · {{ call.status }}</button>
      <StudioError v-if="call.error_msg" :error="call.error_msg" />
      <div v-if="selectedCall === call.id"><pre>{{ JSON.stringify(call, null, 2) }}</pre><div v-for="message in messages" :key="message.id"><strong>{{ message.role }}</strong><pre>{{ messageText(message) }}</pre></div><button v-if="moreMessages" class="btn btn-sm" :disabled="loadingMessages" @click="loadMessages(false)">{{ t('assetStudio.loadMore') }}</button></div>
    </article>
    <button v-if="more" class="btn btn-sm" :disabled="loading" @click="load(false)">{{ t('assetStudio.loadMore') }}</button>
  </section>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { assetStudioAPI, type ObservedCall, type ObservedMessage } from '../api'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'
import StudioError from './StudioError.vue'
const props = defineProps<{runId?: number; researchTaskId?: number}>()
const { t } = useI18n()
const callKey = props.researchTaskId ? 'asrcall' : 'ascall'
const link = useDeeplink(`assetStudioCall:${callKey}`, props.researchTaskId ? DEEPLINK_KEYS.assetStudioResearchCall : DEEPLINK_KEYS.assetStudioCall)
const selectedCall = ref(Number(link.initial(callKey)) || 0)
const calls = ref<ObservedCall[]>([])
const spans = ref<Record<string, unknown>[]>([])
function stageLabel(stage: string) { const key = `episode.documentary.pipeline.steps.${stage}`; const label = t(key); return label === key ? stage : label }
const works = ref<Record<string, unknown>[]>([])
const messages = ref<ObservedMessage[]>([])
const error = ref('')
const loading = ref(false)
const loadingMessages = ref(false)
const more = ref(false)
const moreMessages = ref(false)
const nextAfterId = ref(0)
let sequence = 0
let messageSequence = 0
let stopped = false
function messageText(message: ObservedMessage) { const value = message.content ?? message.text ?? message; return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
async function load(reset: boolean) {
  const seq = ++sequence
  loading.value = true
  error.value = ''
  try {
    const data = props.researchTaskId
      ? await assetStudioAPI.research(props.researchTaskId, reset ? 0 : nextAfterId.value)
      : await assetStudioAPI.observed(props.runId!, reset ? 0 : nextAfterId.value)
    if (stopped || seq !== sequence) return
    calls.value = reset ? data.calls ?? [] : [...calls.value, ...(data.calls ?? [])]
    works.value = data.works ?? []
    spans.value = 'stage_spans' in data ? data.stage_spans : []
    more.value = !!data.has_more
    nextAfterId.value = data.next_after_id ?? 0
    if (selectedCall.value && calls.value.some(row => row.id === selectedCall.value)) await loadMessages(true)
    else if (selectedCall.value && more.value) await load(false)
    else if (selectedCall.value) { selectedCall.value = 0; toast.warning(t('deeplink.missing')) }
  } catch (err) { if (!stopped && seq === sequence) error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed') }
  finally { if (seq === sequence) loading.value = false }
}
function selectCall(id: number) { selectedCall.value = selectedCall.value === id ? 0 : id; messages.value = []; if (selectedCall.value) void loadMessages(true) }
async function loadMessages(reset: boolean) {
  if (!selectedCall.value) return
  const seq = ++messageSequence
  loadingMessages.value = true
  try {
    const data = await assetStudioAPI.messages(selectedCall.value, reset ? 0 : (messages.value.at(-1)?.id ?? 0))
    if (stopped || seq !== messageSequence) return
    messages.value = reset ? data.messages : [...messages.value, ...data.messages]
    moreMessages.value = messages.value.length < data.total
  } catch (err) { if (!stopped) error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed') }
  finally { if (seq === messageSequence) loadingMessages.value = false }
}
watch(selectedCall, id => link.set({[callKey]: id || ''}))
watch(() => [props.runId, props.researchTaskId], () => { selectedCall.value = 0; messages.value = []; void load(true) })
onMounted(() => { void load(true) })
onBeforeUnmount(() => { stopped = true; sequence++; messageSequence++ })
</script>
<style scoped>
.as-process { display: flex; flex-direction: column; gap: 8px; } header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow-y: auto; font-size: 11px; padding: 8px; background: var(--surface-soft); }
ol { padding-left: 20px; }
</style>
