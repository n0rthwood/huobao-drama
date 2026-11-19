<template>
  <section class="research-records" @click.stop>
    <div class="rr-head">
      <strong>{{ t('assetStudio.researchRecords') }}</strong>
      <span class="dim">{{ t('assetStudio.researchRecordCount', { n: records.length }) }}</span>
      <button class="btn btn-sm rr-run" type="button" :disabled="running || starting" @click="start">
        <Loader2 v-if="starting" :size="11" class="animate-spin" /><Search v-else :size="11" />
        {{ t('episode.documentary.research.run') }}
      </button>
    </div>
    <div class="rr-form">
      <input v-model="keywords" class="input" :placeholder="t('assetStudio.researchKeywordsPlaceholder')" />
      <input v-model="instruction" class="input" :placeholder="t('assetStudio.researchInstructionPlaceholder')" />
    </div>
    <StudioError v-if="error" :error="error" />

    <p v-if="!records.length" class="dim rr-hint">{{ t('episode.documentary.research.empty') }}</p>
    <article v-for="record in records" :key="record.id" class="rr-record">
      <button class="rr-record-head" type="button" @click="toggle(record.id)">
        <ChevronDown :size="12" :class="{ collapsed: !expanded.has(record.id) }" />
        <span class="pip-badge" :class="`rr-${record.status}`">{{ record.status }}</span>
        <span class="dim rr-time">{{ localTime(record.created_at) }}</span>
        <span v-if="record.keywords" class="rr-keywords clamp1">{{ record.keywords }}</span>
        <span v-if="record.result" class="dim">{{ record.result.candidates.length }} {{ t('assetStudio.candidatesCount', { n: '' }).replace(/\s*\d*$/, '') }} · {{ record.result.texts.length }} texts</span>
        <Loader2 v-if="record.status === 'running'" :size="11" class="animate-spin" />
      </button>
      <template v-if="expanded.has(record.id)">
        <p v-if="record.instruction" class="dim rr-instruction">{{ record.instruction }}</p>
        <StudioError v-if="record.status === 'failed' && record.error" :error="record.error" />
        <template v-if="record.result">
          <div class="rr-grid">
            <article v-for="c in record.result.candidates" :key="c.sha256" class="rr-card" :class="{ selected: isSelected(record.id, c.sha256) }">
              <button type="button" class="rr-thumb" @click="emit('preview', mediaUrl(c.local_path), c.title)">
                <img :src="thumbOf(mediaUrl(c.local_path))" :alt="c.title" loading="lazy" @error="thumbFallback($event, mediaUrl(c.local_path))" />
              </button>
              <div class="rr-body">
                <a v-if="c.url" :href="c.url" target="_blank" rel="noreferrer" class="rr-title">{{ c.title }}</a>
                <span v-else class="rr-title">{{ c.title }}</span>
                <span class="dim rr-meta clamp1">{{ [c.institution, c.date].filter(Boolean).join(' · ') }}</span>
                <span class="dim rr-meta">{{ c.license || t('episode.documentary.research.licenseUnknown') }} · {{ c.role }}</span>
                <span v-if="c.depicts" class="rr-text clamp">{{ c.depicts }}</span>
                <div class="rr-actions">
                  <label class="rr-check">
                    <input type="checkbox" :checked="isSelected(record.id, c.sha256)" @change="toggleCandidate(record.id, c)" />
                    {{ t('assetStudio.selectAsReference') }}
                  </label>
                  <button class="btn btn-sm" type="button" :disabled="busyKey === `save-${c.sha256}`" @click="saveAsSource(record, c)">
                    <Loader2 v-if="busyKey === `save-${c.sha256}`" :size="11" class="animate-spin" />{{ t('assetStudio.saveAsSource') }}
                  </button>
                  <button class="btn btn-sm" type="button" :disabled="busyKey === `adopt-${c.sha256}`" @click="askAdopt(record, c)">
                    <Loader2 v-if="busyKey === `adopt-${c.sha256}`" :size="11" class="animate-spin" />{{ t('assetStudio.adoptAsAsset') }}
                  </button>
                </div>
              </div>
            </article>
          </div>
          <ul v-if="record.result.texts.length" class="rr-texts">
            <li v-for="(text, index) in record.result.texts" :key="index">
              <label class="rr-check">
                <input type="checkbox" :checked="isTextSelected(record.id, index)" @change="toggleText(record.id, index)" />
                <a v-if="text.url" :href="text.url" target="_blank" rel="noreferrer">{{ text.title }}</a>
                <span v-else>{{ text.title }}</span>
              </label>
              <span class="dim clamp1">{{ text.excerpt.slice(0, 120) }}…</span>
            </li>
          </ul>
        </template>
      </template>
    </article>

    <ConfirmDialog
      :open="Boolean(adoptTarget)"
      :title="t('assetStudio.adoptAsAsset')"
      :message="t('assetStudio.adoptAsAssetConfirm')"
      :loading="busyKey.startsWith('adopt-')"
      @confirm="doAdopt"
      @cancel="adoptTarget = null"
    />
  </section>
</template>

<script setup lang="ts">
/**
 * 检索记录（Issue #123）：每次检索一行，全部可见可展开；候选三按钮（选为参考/存为素材/采用为资产图），
 * 文本勾选。选中状态通过 v-model:selection 上报给 PrecisionTab 汇总。running 记录 4s 轮询。
 */
import { ChevronDown, Loader2, Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import StudioError from './StudioError.vue'
import { mediaUrl } from '~/utils/url'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { assetStudioAPI, type AssetResearchCandidate, type AssetResearchRecord, type DraftResearchSelection } from '../api'

const props = defineProps<{ taskId: number; selection: DraftResearchSelection[] }>()
const emit = defineEmits<{
  (e: 'update:selection', value: DraftResearchSelection[]): void
  (e: 'preview', url: string, title: string): void
  (e: 'sourcesChanged'): void
}>()
const { t } = useI18n()

const records = ref<AssetResearchRecord[]>([])
const expanded = ref(new Set<number>())
const keywords = ref('')
const instruction = ref('')
const starting = ref(false)
const error = ref('')
const busyKey = ref('')
const adoptTarget = ref<{ record: AssetResearchRecord; candidate: AssetResearchCandidate } | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let stopped = false

const running = computed(() => records.value.some(record => record.status === 'running'))

function localTime(iso: string) {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''
}

function toggle(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function selectionFor(researchId: number): DraftResearchSelection {
  return props.selection.find(item => item.research_id === researchId) ?? { research_id: researchId, candidate_shas: [], text_indexes: [] }
}

function isSelected(researchId: number, sha: string) {
  return selectionFor(researchId).candidate_shas.includes(sha)
}

function isTextSelected(researchId: number, index: number) {
  return selectionFor(researchId).text_indexes.includes(index)
}

function updateSelection(researchId: number, patch: Partial<DraftResearchSelection>) {
  const current = selectionFor(researchId)
  const next = { ...current, ...patch }
  const others = props.selection.filter(item => item.research_id !== researchId)
  // 空选择不上报（保持 selection 紧凑）
  emit('update:selection', next.candidate_shas.length || next.text_indexes.length ? [...others, next] : others)
}

function toggleCandidate(researchId: number, candidate: AssetResearchCandidate) {
  const current = selectionFor(researchId)
  const shas = current.candidate_shas.includes(candidate.sha256)
    ? current.candidate_shas.filter(sha => sha !== candidate.sha256)
    : [...current.candidate_shas, candidate.sha256]
  updateSelection(researchId, { candidate_shas: shas })
}

function toggleText(researchId: number, index: number) {
  const current = selectionFor(researchId)
  const indexes = current.text_indexes.includes(index)
    ? current.text_indexes.filter(item => item !== index)
    : [...current.text_indexes, index]
  updateSelection(researchId, { text_indexes: indexes })
}

async function load() {
  try {
    const data = await assetStudioAPI.researchRecords(props.taskId)
    if (stopped) return
    records.value = data.records
    // 默认展开最新一条 completed
    if (!expanded.value.size) {
      const latest = data.records.find(record => record.status === 'completed')
      if (latest) expanded.value = new Set([latest.id])
    }
    error.value = ''
  } catch (err) {
    if (!stopped) error.value = err instanceof Error ? err.message : t('episode.documentary.research.loadFailed')
  }
}

async function start() {
  starting.value = true
  error.value = ''
  try {
    await assetStudioAPI.startResearch(props.taskId, { keywords: keywords.value || undefined, instruction: instruction.value || undefined })
    toast.success(t('episode.documentary.research.started'))
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('episode.documentary.research.startFailed')
  } finally {
    starting.value = false
  }
}

async function saveAsSource(record: AssetResearchRecord, candidate: AssetResearchCandidate) {
  busyKey.value = `save-${candidate.sha256}`
  try {
    await assetStudioAPI.addSource({
      task_id: props.taskId, local_path: candidate.local_path, source_url: candidate.url ?? undefined,
      title: candidate.title, artist: candidate.institution || undefined, era: candidate.date || undefined,
      license: candidate.license?.trim() || t('episode.documentary.research.licenseUnknown'),
      role: 'generation_reference', origin: 'research',
    })
    toast.success(t('episode.documentary.pipeline.sourceAdded'))
    emit('sourcesChanged')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('episode.documentary.pipeline.sourceAddFailed'))
  } finally {
    busyKey.value = ''
  }
}

function askAdopt(record: AssetResearchRecord, candidate: AssetResearchCandidate) {
  adoptTarget.value = { record, candidate }
}

async function doAdopt() {
  const target = adoptTarget.value
  if (!target) return
  busyKey.value = `adopt-${target.candidate.sha256}`
  try {
    await assetStudioAPI.addSource({
      task_id: props.taskId, local_path: target.candidate.local_path, source_url: target.candidate.url ?? undefined,
      title: target.candidate.title, artist: target.candidate.institution || undefined, era: target.candidate.date || undefined,
      license: target.candidate.license?.trim() || t('episode.documentary.research.licenseUnknown'),
      role: 'original', origin: 'research',
    })
    toast.success(t('assetStudio.adoptedAsAsset'))
    adoptTarget.value = null
    emit('sourcesChanged')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('episode.documentary.pipeline.sourceAddFailed'))
  } finally {
    busyKey.value = ''
  }
}

onMounted(() => { void load(); timer = setInterval(() => { if (running.value) void load() }, 4000) })
onBeforeUnmount(() => { stopped = true; clearInterval(timer) })
</script>

<style scoped>
.research-records { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.rr-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rr-run { margin-left: auto; }
.rr-form { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.rr-form .input { font-size: 12px; }
.rr-hint { margin: 0; font-size: 11px; }
.rr-record { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1, var(--surface)); padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.rr-record-head { display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none; cursor: pointer; font-size: 11px; color: var(--text-1); text-align: left; flex-wrap: wrap; }
.collapsed { transform: rotate(-90deg); }
.rr-time { font-size: 10.5px; }
.rr-keywords { max-width: 240px; }
.rr-instruction { margin: 0; font-size: 11px; }
.rr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.rr-card { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-soft); }
.rr-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-glow, var(--accent)); }
.rr-thumb { padding: 0; border: 0; background: var(--bg-2); border-radius: 4px; cursor: zoom-in; height: 96px; overflow: hidden; }
.rr-thumb img { width: 100%; height: 100%; object-fit: contain; }
.rr-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 11px; overflow-wrap: anywhere; }
.rr-title { font-weight: 650; color: var(--text-1); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
a.rr-title { color: var(--accent-text); }
.rr-meta { font-size: 10.5px; }
.rr-text { color: var(--text-2); }
.rr-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.rr-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; }
.rr-texts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.rr-texts li { display: flex; flex-direction: column; gap: 1px; }
.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.clamp1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pip-badge { display: inline-flex; padding: 1px 8px; border-radius: 999px; font-size: 10px; }
.rr-completed { background: var(--success-bg, var(--surface)); color: var(--success, var(--text-2)); }
.rr-running { background: var(--accent-bg, var(--surface)); color: var(--accent-text); }
.rr-failed { background: var(--danger-bg, var(--surface)); color: var(--danger, var(--text-2)); }
.animate-spin { animation: rr-spin 1s linear infinite; }
@keyframes rr-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) { .rr-form { grid-template-columns: 1fr; } }
</style>