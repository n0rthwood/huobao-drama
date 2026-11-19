<template>
  <div class="beautify-tab" @click.stop>
    <section class="bt-block">
      <strong>{{ t('assetStudio.beautifyVersion') }}</strong>
      <p v-if="!versions.length" class="dim bt-hint">{{ t('assetStudio.beautifyNoVersion') }}</p>
      <div v-else class="bt-versions">
        <button
          v-for="version in versions"
          :key="version.id ?? version.url"
          type="button"
          class="bt-version"
          :class="{ selected: selectedVersionId === version.id }"
          @click="selectedVersionId = version.id"
        >
          <img :src="thumbOf(mediaUrl(version.url || ''))" :alt="version.model || ''" loading="lazy" @error="thumbFallback($event, mediaUrl(version.url || ''))" />
          <span class="bt-version-meta">{{ version.provider }}<template v-if="version.model"> · {{ version.model }}</template></span>
          <span v-if="version.is_current" class="bt-current">{{ t('episode.asset.currentVersion') }}</span>
        </button>
      </div>
      <label class="bt-notes">
        <span>{{ t('assetStudio.notesLabel') }}</span>
        <textarea v-model="notes" class="input" rows="3" :placeholder="t('assetStudio.beautifyNotesPlaceholder')" />
      </label>
      <div class="bt-actions">
        <button class="btn btn-primary" type="button" :disabled="creating || !versions.length" @click="createDraft(false)">
          <Loader2 v-if="creating && !oneClick" :size="12" class="animate-spin" />{{ t('assetStudio.generateBeautifyDraft') }}
        </button>
        <button class="btn" type="button" :disabled="creating || !versions.length" @click="createDraft(true)">
          <Loader2 v-if="creating && oneClick" :size="12" class="animate-spin" />{{ t('assetStudio.oneClickBeautify') }}
        </button>
      </div>
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
 * 美化 TAB（Issue #123）：选中资产图版本 + 视觉描述式优化。无版本时禁用并提示问题 C 答案。
 * 「一键美化」= 自动创建草稿并等 ready，仍进入可编辑面板与最终确认（评审 P1-5：不跳过确认）。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import DraftPanel from './DraftPanel.vue'
import StudioError from './StudioError.vue'
import { mediaUrl } from '~/utils/url'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { assetStudioAPI, type AssetImageVersion, type AssetStudioDraft } from '../api'

const props = defineProps<{ taskId: number; initialDraft?: AssetStudioDraft | null }>()
const emit = defineEmits<{ (e: 'generated', runId: number): void; (e: 'changed'): void }>()
const { t } = useI18n()

const versions = ref<AssetImageVersion[]>([])
const selectedVersionId = ref<number | null>(null)
const notes = ref('')
const creating = ref(false)
const oneClick = ref(false)
const error = ref('')
const draft = ref<AssetStudioDraft | null>(props.initialDraft ?? null)
let stopped = false

async function loadVersions() {
  try {
    const data = await assetStudioAPI.versions(props.taskId)
    if (stopped) return
    versions.value = data.versions
    const current = data.versions.find(version => version.is_current)
    selectedVersionId.value = current?.id ?? data.versions[0]?.id ?? null
  } catch (err) {
    if (!stopped) error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  }
}

async function createDraft(auto: boolean) {
  creating.value = true
  oneClick.value = auto
  error.value = ''
  try {
    let created = await assetStudioAPI.createDraft(props.taskId, {
      tab: 'beautify',
      inputs: { version_task_id: selectedVersionId.value, notes: notes.value },
    })
    // 一键美化：等展开完成（ready/failed），仍停在 DraftPanel 由人确认
    if (auto) {
      for (let i = 0; i < 200 && created.status === 'drafting'; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        if (stopped) return
        created = await assetStudioAPI.draft(created.id)
      }
    }
    draft.value = created
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('assetStudio.loadFailed')
  } finally {
    creating.value = false
    oneClick.value = false
  }
}

onMounted(() => void loadVersions())
onBeforeUnmount(() => { stopped = true })
</script>

<style scoped>
.beautify-tab { display: flex; flex-direction: column; gap: 12px; }
.bt-block { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.bt-hint { margin: 0; font-size: 12px; color: var(--warn-text, var(--text-3)); }
.bt-versions { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.bt-version { position: relative; flex: 0 0 120px; width: 120px; height: 120px; padding: 0; border: 1.5px solid var(--border); border-radius: 6px; background: var(--bg-2); cursor: pointer; overflow: hidden; }
.bt-version.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow, var(--accent)); }
.bt-version img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bt-version-meta { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 4px; background: rgba(0,0,0,0.64); color: #fff; font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bt-current { position: absolute; top: 3px; right: 3px; padding: 1px 4px; border-radius: 999px; background: var(--accent); color: var(--on-accent, #fff); font-size: 8px; font-weight: 700; }
.bt-notes { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.bt-notes textarea { width: 100%; font-size: 12px; resize: vertical; }
.bt-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.animate-spin { animation: bt-spin 1s linear infinite; }
@keyframes bt-spin { to { transform: rotate(360deg); } }
</style>