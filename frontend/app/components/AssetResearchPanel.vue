<template>
  <div class="rsp" @click.stop>
    <div class="rsp-head">
      <strong>{{ t('episode.documentary.research.title') }}</strong>
      <span v-if="running" class="rsp-state"><Loader2 :size="11" class="animate-spin" />{{ stepLabel }}</span>
      <span v-else-if="state?.finished_at" class="dim rsp-time">{{ t('episode.documentary.research.finishedAt', { time: localTime(state.finished_at) }) }}</span>
      <button class="btn btn-sm rsp-run" type="button" :disabled="running || starting" @click="start">
        <Loader2 v-if="starting" :size="11" class="animate-spin" /><Search v-else :size="11" />
        {{ result ? t('episode.documentary.research.rerun') : t('episode.documentary.research.run') }}
      </button>
    </div>
    <p class="rsp-hint">{{ t('episode.documentary.research.hint') }}</p>
    <TaskErrorMessage v-if="state?.status === 'error' && state.error" :error="state.error" />
    <TaskErrorMessage v-if="error" :error="error" />

    <template v-if="result">
      <p class="dim rsp-summary">
        {{ t('episode.documentary.research.summary', { texts: result.texts.length, images: result.candidates.length, queries: result.queries.length, failed: failedQueries }) }}
      </p>

      <section v-for="group in groups" :key="group.role" class="rsp-group">
        <div class="rsp-group-head">
          <span class="pip-badge" :class="`cand-${group.role}`">{{ t(`episode.documentary.research.role.${group.role}`) }}</span>
          <span class="dim">{{ t(`episode.documentary.research.roleHint.${group.role}`) }}</span>
        </div>
        <div class="rsp-grid">
          <article v-for="c in group.items" :key="c.sha256" class="rsp-card">
            <button type="button" class="rsp-thumb" @click="emit('preview', mediaUrl(c.local_path), c.title)">
              <img :src="mediaUrl(c.local_path)" :alt="c.title" loading="lazy" />
            </button>
            <div class="rsp-body">
              <a v-if="c.url" :href="c.url" target="_blank" rel="noreferrer" class="rsp-title">{{ c.title }}</a>
              <span v-else class="rsp-title">{{ c.title }}</span>
              <span class="dim rsp-meta clamp1">{{ [c.institution, c.date].filter(Boolean).join(' · ') }}</span>
              <span class="dim rsp-meta">{{ t('episode.documentary.research.license') }}{{ c.license || t('episode.documentary.research.licenseUnknown') }} · {{ c.tier === 'A' ? t('episode.documentary.research.tierA') : t('episode.documentary.research.tierB') }}</span>
              <span v-if="c.depicts" class="rsp-text clamp" :title="c.depicts">{{ c.depicts }}</span>
              <span v-if="c.what_it_proves.length" class="rsp-text ok clamp" :title="c.what_it_proves.join('；')">{{ t('episode.documentary.research.proves') }}{{ c.what_it_proves.join('；') }}</span>
              <span v-if="c.cautions.length" class="rsp-text warn clamp" :title="c.cautions.join('；')">{{ t('episode.documentary.research.cautions') }}{{ c.cautions.join('；') }}</span>
              <div class="rsp-actions">
                <span v-if="ingestedShas.includes(c.sha256)" class="rsp-done"><Check :size="12" />{{ t('episode.documentary.research.ingested') }}</span>
                <template v-else>
                  <input v-model="licenses[c.sha256]" class="input rsp-license" :placeholder="t('episode.documentary.pipeline.sourceLicense')" />
                  <select v-model="roles[c.sha256]" class="input rsp-role">
                    <option value="generation_reference">{{ t('episode.documentary.pipeline.roleGenerationReference') }}</option>
                    <option value="shape_only">{{ t('episode.documentary.pipeline.roleShapeOnly') }}</option>
                  </select>
                  <button class="btn btn-sm btn-primary" type="button" :disabled="ingesting === c.sha256 || !licenses[c.sha256]?.trim()" @click="ingest(c)">
                    <Loader2 v-if="ingesting === c.sha256" :size="11" class="animate-spin" />{{ t('episode.documentary.research.ingest') }}
                  </button>
                </template>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section v-if="result.texts.length" class="rsp-group">
        <div class="rsp-group-head">
          <span class="pip-badge">{{ t('episode.documentary.research.texts') }}</span>
          <span class="dim">{{ t('episode.documentary.research.textsHint') }}</span>
        </div>
        <ul class="rsp-texts">
          <li v-for="text in result.texts" :key="text.adapter + text.title">
            <a v-if="text.url" :href="text.url" target="_blank" rel="noreferrer">{{ text.title }}</a>
            <span v-else>{{ text.title }}</span>
            <span class="dim">{{ text.excerpt.slice(0, 120) }}…</span>
          </li>
        </ul>
      </section>
    </template>
    <p v-else-if="!running && state?.status !== 'error'" class="rsp-hint">{{ t('episode.documentary.research.empty') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 检索权威资料（Issue #79）：一次检索 = 多来源检索 + 文字摘录 + 视觉判断过的图像候选。
 * 入库仍需用户点（许可要人确认）；入库走 addSource(local_path + source_url)，复用检索时已缓存的图片。
 */
import { Check, Loader2, Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import TaskErrorMessage from '~/components/TaskErrorMessage.vue'
import { registerTask, useTasks } from '~/composables/useTasks'
import {
  assetPipelineAPI, taskAPI,
  type AssetPipelineKind, type AssetResearchCandidate, type AssetResearchRole, type AssetResearchStatus, type AssetSourceRole,
} from '~/composables/useApi'

const props = defineProps<{ assetKind: AssetPipelineKind; assetId: number; episodeId: number; ingestedShas: string[] }>()
const emit = defineEmits<{ (e: 'ingested'): void; (e: 'preview', url: string, title: string): void }>()
const { t } = useI18n()
const { tasksById } = useTasks()

const state = ref<AssetResearchStatus | null>(null)
const starting = ref(false)
const error = ref('')
const ingesting = ref('')
const licenses = reactive<Record<string, string>>({})
const roles = reactive<Record<string, AssetSourceRole>>({})

const result = computed(() => state.value?.result ?? null)
const running = computed(() => state.value?.status === 'running')
const failedQueries = computed(() => result.value?.queries.filter(item => item.error).length ?? 0)
const stepLabel = computed(() => t(`episode.documentary.research.step.${state.value?.step || 'plan'}`))

const ROLE_ORDER: AssetResearchRole[] = ['original', 'generation_reference', 'shape_only', 'text_source', 'reject']
const groups = computed(() => ROLE_ORDER
  .map(role => ({ role, items: (result.value?.candidates ?? []).filter(c => c.role === role) }))
  .filter(group => group.items.length))

function localTime(iso: string) {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''
}

function seedForm() {
  for (const c of result.value?.candidates ?? []) {
    if (!(c.sha256 in licenses)) licenses[c.sha256] = c.license
    if (!(c.sha256 in roles)) roles[c.sha256] = c.role === 'original' || c.role === 'generation_reference' ? 'generation_reference' : 'shape_only'
  }
}

async function load() {
  try {
    state.value = await assetPipelineAPI.research(props.assetKind, props.assetId)
    seedForm()
    error.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('episode.documentary.research.loadFailed')
  }
}

async function start() {
  starting.value = true
  error.value = ''
  try {
    const res = await assetPipelineAPI.startResearch(props.assetKind, props.assetId, { episode_id: Number(props.episodeId) })
    toast.success(t('episode.documentary.research.started'))
    registerTask(await taskAPI.get(res.task_id))
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('episode.documentary.research.startFailed')
  } finally {
    starting.value = false
  }
}

async function ingest(c: AssetResearchCandidate) {
  ingesting.value = c.sha256
  try {
    await assetPipelineAPI.addSource({
      asset_kind: props.assetKind, asset_id: props.assetId, local_path: c.local_path, source_url: c.url ?? undefined,
      title: c.title, artist: c.institution || undefined, era: c.date || undefined,
      license: licenses[c.sha256].trim(), role: roles[c.sha256],
    })
    toast.success(t('episode.documentary.pipeline.sourceAdded'))
    emit('ingested')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('episode.documentary.pipeline.sourceAddFailed'))
  } finally {
    ingesting.value = ''
  }
}

// 进度与结束由全局任务轮询驱动，面板不另起定时器
watch(() => {
  const id = state.value?.task_id
  const task = id ? tasksById.value[id] : null
  return task ? `${task.status}|${JSON.stringify(task.params?.research_step ?? '')}` : ''
}, (next, prev) => { if (next && next !== prev) void load() })

watch(() => [props.assetKind, props.assetId], () => { state.value = null; void load() })
onMounted(load)
</script>

<style scoped>
.rsp { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.rsp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rsp-run { margin-left: auto; }
.rsp-state { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--accent-text); }
.rsp-time, .rsp-summary { font-size: 11px; margin: 0; }
.rsp-group { display: flex; flex-direction: column; gap: 6px; }
.rsp-group-head { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.rsp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.rsp-card { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; padding: 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1, var(--surface)); }
.rsp-thumb { padding: 0; border: 0; background: var(--bg-2); border-radius: 4px; cursor: zoom-in; height: 96px; overflow: hidden; }
.rsp-thumb img { width: 100%; height: 100%; object-fit: contain; }
.rsp-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 11px; overflow-wrap: anywhere; }
.rsp-title { font-weight: 650; color: var(--text-1); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
a.rsp-title { color: var(--accent-text); }
.rsp-meta { font-size: 10.5px; }
.rsp-hint { margin: 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }
.rsp-text { color: var(--text-2); }
.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.clamp1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rsp-text.ok { color: var(--success, var(--text-2)); }
.rsp-text.warn { color: var(--warn-text, var(--text-2)); }
.rsp-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.rsp-license, .rsp-role { height: 28px; min-height: 28px; padding: 0 8px; font-size: 11px; line-height: 26px; }
.rsp-license { flex: 1 1 120px; min-width: 0; }
.rsp-role { flex: 0 0 auto; width: auto; }
.rsp-done { display: inline-flex; align-items: center; gap: 3px; color: var(--success, var(--accent-text)); }
.rsp-texts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.rsp-texts li { display: flex; flex-direction: column; gap: 1px; }
.cand-original { background: var(--success-bg, var(--accent-bg)); }
.cand-reject { opacity: 0.7; }
</style>
