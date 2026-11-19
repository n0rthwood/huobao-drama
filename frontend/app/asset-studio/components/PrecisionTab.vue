<template>
  <div class="precision-tab" @click.stop>
    <!-- 我的参考图：origin=user_reference 的素材（资产 reference_images 同步而来） -->
    <section class="pt-block">
      <div class="pt-head">
        <strong>{{ t('assetStudio.myReferences') }}</strong>
        <span class="dim">{{ t('assetStudio.userReferencesCount', { n: userSources.length }) }}</span>
        <button class="btn btn-sm pt-upload" type="button" :disabled="uploading" @click="fileInput?.click()">
          <Loader2 v-if="uploading" :size="11" class="animate-spin" /><Upload v-else :size="11" />{{ t('assetStudio.uploadReference') }}
        </button>
        <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" hidden @change="upload" />
      </div>
      <p v-if="!userSources.length" class="dim pt-hint">{{ t('assetStudio.referencesHint') }}</p>
      <div v-else class="pt-refs">
        <label v-for="source in userSources" :key="source.id" class="pt-ref" :class="{ selected: selectedSourceIds.includes(source.id) }">
          <input type="checkbox" :checked="selectedSourceIds.includes(source.id)" @change="toggleSource(source.id)" />
          <button type="button" class="pt-ref-thumb" @click="emit('preview', mediaUrl(source.local_path), source.title || '')">
            <img :src="thumbOf(mediaUrl(source.local_path))" :alt="source.title || ''" loading="lazy" @error="thumbFallback($event, mediaUrl(source.local_path))" />
          </button>
          <button type="button" class="pt-ref-del" :title="t('common.delete')" @click="removeReference(source)"><Trash2 :size="11" /></button>
        </label>
      </div>
    </section>

    <!-- 检索记录：每次检索一行，候选可勾选/存素材/采用 -->
    <ResearchRecords
      :task-id="taskId"
      :selection="researchSelection"
      @update:selection="researchSelection = $event"
      @preview="(url, title) => emit('preview', url, title)"
      @sources-changed="emit('sourcesChanged')"
    />

    <!-- 生图输入汇总：四态徽章 + n/3 + notes -->
    <section class="pt-block">
      <div class="pt-head">
        <span class="pip-badge" :class="`pt-badge-${inputBadge}`">{{ t(`assetStudio.${badgeKey}`) }}</span>
        <span class="dim">{{ t('assetStudio.selectedImages', { n: selectedImageCount }) }}</span>
        <span class="dim">{{ t('assetStudio.sourcesCount', { n: sources.length }) }}</span>
      </div>
      <label class="pt-notes">
        <span>{{ t('assetStudio.notesLabel') }}</span>
        <textarea v-model="notes" class="input" rows="3" :placeholder="t('assetStudio.notesPlaceholder')" />
      </label>
      <button class="btn btn-primary" type="button" :disabled="creating || !canCreate" @click="createDraft">
        <Loader2 v-if="creating" :size="12" class="animate-spin" />{{ t('assetStudio.generateDraft') }}
      </button>
      <StudioError v-if="error" :error="error" />
    </section>

    <DraftPanel
      v-if="draft"
      :draft="draft"
      :task-id="taskId"
      @update="draft = $event"
      @generated="runId => emit('generated', runId)"
      @changed="emit('changed')"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 精确细化 TAB（Issue #123）：参考图（用户上传/文中图）+ 检索图文 + 用户描述 → 草稿 → 确认生图。
 * 不用资产图。总图数（user 参考 + 检索候选）≤3，与后端 validateDraftInputs 同口径。
 */
import { Loader2, Trash2, Upload } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import DraftPanel from './DraftPanel.vue'
import ResearchRecords from './ResearchRecords.vue'
import StudioError from './StudioError.vue'
import { mediaUrl } from '~/utils/url'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { assetStudioAPI, type AssetSourceRow, type AssetStudioDraft, type DraftResearchSelection } from '../api'

const props = defineProps<{ taskId: number; sources: AssetSourceRow[]; initialDraft?: AssetStudioDraft | null }>()
const emit = defineEmits<{
  (e: 'preview', url: string, title: string): void
  (e: 'sourcesChanged'): void
  (e: 'generated', runId: number): void
  (e: 'changed'): void
}>()
const { t } = useI18n()

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const creating = ref(false)
const error = ref('')
const notes = ref('')
const selectedSourceIds = ref<number[]>([])
const researchSelection = ref<DraftResearchSelection[]>([])
const draft = ref<AssetStudioDraft | null>(props.initialDraft ?? null)

const userSources = computed(() => props.sources.filter(source => source.origin === 'user_reference'))
const selectedCandidateCount = computed(() => researchSelection.value.reduce((sum, item) => sum + item.candidate_shas.length, 0))
const selectedTextCount = computed(() => researchSelection.value.reduce((sum, item) => sum + item.text_indexes.length, 0))
const selectedImageCount = computed(() => selectedSourceIds.value.length + selectedCandidateCount.value)

const inputBadge = computed(() => {
  const own = selectedSourceIds.value.length > 0
  const research = selectedCandidateCount.value > 0 || selectedTextCount.value > 0
  if (own && research) return 'mixed'
  if (own) return 'own'
  if (research) return 'research'
  return 'empty'
})
const badgeKey = computed(() => ({ own: 'inputBadgeOwn', mixed: 'inputBadgeMixed', research: 'inputBadgeResearch', empty: 'inputBadgeEmpty' }[inputBadge.value]))
const canCreate = computed(() => selectedImageCount.value > 0 || selectedTextCount.value > 0 || notes.value.trim().length > 0)

function toggleSource(id: number) {
  selectedSourceIds.value = selectedSourceIds.value.includes(id)
    ? selectedSourceIds.value.filter(item => item !== id)
    : [...selectedSourceIds.value, id]
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploading.value = true
  error.value = ''
  try {
    const form = new FormData()
    form.append('file', file)
    await assetStudioAPI.uploadReference(props.taskId, form)
    toast.success(t('assetStudio.referenceUploaded'))
    emit('sourcesChanged')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  } finally {
    uploading.value = false
  }
}

async function removeReference(source: AssetSourceRow) {
  try {
    await assetStudioAPI.deleteReference(props.taskId, source.local_path)
    selectedSourceIds.value = selectedSourceIds.value.filter(id => id !== source.id)
    toast.success(t('assetStudio.referenceRemoved'))
    emit('sourcesChanged')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  }
}

async function createDraft() {
  creating.value = true
  error.value = ''
  try {
    draft.value = await assetStudioAPI.createDraft(props.taskId, {
      tab: 'precision',
      inputs: { source_ids: selectedSourceIds.value, research: researchSelection.value, notes: notes.value },
    })
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.precision-tab { display: flex; flex-direction: column; gap: 12px; }
.pt-block { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.pt-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pt-upload { margin-left: auto; }
.pt-hint { margin: 0; font-size: 11px; }
.pt-refs { display: flex; flex-wrap: wrap; gap: 8px; }
.pt-ref { position: relative; display: flex; flex-direction: column; gap: 4px; width: 120px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1, var(--surface)); cursor: pointer; }
.pt-ref.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-glow, var(--accent)); }
.pt-ref-thumb { padding: 0; border: 0; background: var(--bg-2); border-radius: 4px; cursor: zoom-in; height: 90px; overflow: hidden; }
.pt-ref-thumb img { width: 100%; height: 100%; object-fit: contain; }
.pt-ref-del { position: absolute; top: 4px; right: 4px; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: rgba(0,0,0,0.6); color: #fff; cursor: pointer; }
.pt-notes { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.pt-notes textarea { width: 100%; font-size: 12px; resize: vertical; }
.pip-badge { display: inline-flex; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; }
.pt-badge-own { background: var(--accent-bg, var(--surface)); color: var(--accent-text); }
.pt-badge-mixed { background: var(--success-bg, var(--surface)); color: var(--success, var(--text-2)); }
.pt-badge-research { background: var(--warn-bg, var(--surface)); color: var(--warn-text, var(--text-2)); }
.pt-badge-empty { background: var(--surface); color: var(--text-3); }
.animate-spin { animation: pt-spin 1s linear infinite; }
@keyframes pt-spin { to { transform: rotate(360deg); } }
</style>