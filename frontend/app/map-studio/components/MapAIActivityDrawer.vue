<template>
  <Teleport to="body">
    <div v-if="open" class="act-overlay" @click.self="emit('close')">
      <aside class="act" :class="{ 'is-wide': wide }" role="dialog" aria-modal="false" :aria-label="t('mapStudio.activity.open')">
        <header class="act-head">
          <strong>{{ t('mapStudio.activity.open') }}</strong>
          <span class="dim">{{ t('mapStudio.activity.hint') }}</span>
          <button type="button" class="act-tool" @click="emit('close')">
            <X :size="11" />
            {{ t('mapStudio.panel.close') }}
          </button>
        </header>

        <section class="act-block">
          <MapAgentProcess
            :task-id="detail.task_id"
            :stage="stage"
            :runs="runs"
            :selected-run-id="selectedRunId"
            :loading-runs="loadingRuns"
            :now="now"
            @select-run="emit('select-run', $event)"
            @reload-runs="emit('reload-runs')"
          />
        </section>

        <section class="act-block">
          <header class="act-sub-head">
            <strong class="act-sub">{{ t('mapStudio.activity.rounds') }}</strong>
            <span class="dim">{{ t('mapStudio.activity.roundsHint') }}</span>
          </header>
          <MapAgentRounds :agent="detail.agent" :stage="stage" :open-stage="openStage" :now="now" @open="emit('open-round', $event)" />
        </section>

        <section class="act-block">
          <strong class="act-sub">{{ t('mapStudio.activity.failure') }}</strong>
          <template v-if="failureDetail">
            <p class="act-failure-kind">{{ t('mapStudio.failure.' + failureDetail.kind) }}</p>
            <p v-if="failureMessage" class="act-note is-warn">{{ failureMessage }}</p>
            <ul v-if="failureDetail.rounds.length" class="act-list">
              <li v-for="round in failureDetail.rounds" :key="round.round">
                <span class="act-round">{{ t('mapStudio.agent.roundLabel', { n: round.round }) }}</span>
                <span class="dim">{{ t('mapStudio.agent.outcome.' + round.outcome) }}</span>
                <span v-if="round.problems.length" class="act-note">{{ round.problems.join('；') }}</span>
              </li>
            </ul>
          </template>
          <p v-else-if="selectedRun?.error_msg" class="act-note is-warn">{{ selectedRun.error_msg }}</p>
          <p v-else class="act-note dim">{{ t('mapStudio.activity.failureMissing') }}</p>
        </section>

        <section class="act-block">
          <strong class="act-sub">{{ t('mapStudio.activity.progress') }}</strong>
          <p v-if="detail.research_progress_summary?.available" class="act-note dim">
            {{ t('mapStudio.activity.progressFacts', {
              sources: detail.research_progress_summary.sources,
              queries: detail.research_progress_summary.dataset_queries,
              rounds: detail.research_progress_summary.rounds_used,
              at: detail.research_progress_summary.updated_at,
            }) }}
          </p>
          <p v-else class="act-note dim">{{ t('mapStudio.activity.progressNone') }}</p>
          <template v-if="detail.research_progress_summary?.available && detail.status !== 'running'">
            <button v-if="!confirmClear" type="button" class="act-danger" :disabled="busy" @click="confirmClear = true">
              {{ t('mapStudio.action.clearProgress') }}
            </button>
            <div v-else class="act-note">
              {{ t('mapStudio.failure.clearConfirm') }}
              <button type="button" class="act-danger" :disabled="busy" @click="confirmClear = false; emit('clear-progress')">{{ t('mapStudio.action.clearProgress') }}</button>
              <button type="button" class="act-tool" @click="confirmClear = false">{{ t('mapStudio.panel.cancel') }}</button>
            </div>
          </template>
        </section>

        <section class="act-block">
          <header class="act-sub-head">
            <strong class="act-sub">{{ t('mapStudio.activity.settings') }}</strong>
            <button type="button" class="act-tool" :disabled="busy || detail.status === 'running' || !modelsDirty" @click="emit('save-models', { textConfigId, imageKey })">
              {{ t('mapStudio.activity.saveModels') }}
            </button>
          </header>
          <label class="act-select">
            <span>{{ t('mapStudio.panel.textConfig') }}</span>
            <select v-model="textConfigId" class="input" :disabled="detail.status === 'running'">
              <option :value="0">{{ t('mapStudio.panel.defaultConfig') }}</option>
              <option v-for="option in textConfigs" :key="option.id" :value="option.id">{{ option.name }}</option>
            </select>
          </label>
          <label class="act-select">
            <span>{{ t('mapStudio.panel.imageModel') }}</span>
            <select v-model="imageKey" class="input" :disabled="detail.status === 'running'">
              <option value="">{{ t('mapStudio.panel.defaultConfig') }}</option>
              <option v-for="option in imageOptions" :key="option.key" :value="option.key">{{ option.configName }} · {{ option.model }}</option>
            </select>
          </label>
          <p class="act-note dim">{{ t('mapStudio.activity.settingsHint') }}</p>
        </section>

        <section class="act-block">
          <strong class="act-sub">{{ t('mapStudio.activity.autoTitle') }}</strong>
          <p class="act-note is-warn">{{ t('mapStudio.workflow.autoWarning') }}</p>
          <div class="act-row">
            <button v-if="!confirmAuto" type="button" class="act-tool" :disabled="busy || detail.status === 'running'" @click="confirmAuto = true">
              {{ t('mapStudio.activity.autoOpen') }}
            </button>
            <template v-else>
              <button type="button" class="act-danger" :disabled="busy || detail.status === 'running'" @click="confirmAuto = false; emit('request-auto')">
                {{ t('mapStudio.activity.autoStart') }}
              </button>
              <button type="button" class="act-tool" @click="confirmAuto = false">{{ t('mapStudio.panel.cancel') }}</button>
            </template>
          </div>
        </section>

        <section class="act-block">
          <strong class="act-sub">{{ t('mapStudio.activity.history') }}</strong>
          <MapDeliveries
            :task-id="detail.task_id"
            :deliveries="detail.deliveries"
            :outputs="detail.outputs"
            :can-deliver="false"
            busy
            :delivering="false"
            error=""
            @deliver="() => {}"
          />
          <ul v-if="detail.history.length" class="act-list">
            <li v-for="entry in detail.history" :key="`${entry.revision}-${entry.at}`">
              <span class="act-round">#{{ entry.revision }}</span>
              <span class="dim">{{ entry.at }}</span>
              <span>{{ t('mapStudio.stage.' + entry.stage) }}</span>
              <span class="dim">{{ entry.action }}</span>
              <span class="act-round">{{ t('mapStudio.panel.actor.' + entry.actor) }}</span>
              <span v-if="entry.note" class="dim">{{ entry.note }}</span>
            </li>
          </ul>
          <p v-else class="act-note dim">{{ t('mapStudio.activity.noHistory') }}</p>
        </section>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * AI 活动抽屉（Issue #126 设计 01 §8）：历史运行、逐轮记录、调用与消息、失败现场、模型设置、交付历史。
 *
 * 抽屉只读观测；切换模型、清空研究进度、启动 auto 都是明确的独立命令。主恢复动作留在动作条，
 * 这里只提供「返回主界面处理」所需的现场与设置，绝不替页面发 run/advance/deliver。
 */
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapStudioDetail, MapStudioRun, MapStudioStage } from '~/map-studio/api'
import MapAgentProcess from '~/map-studio/components/MapAgentProcess.vue'
import MapAgentRounds from '~/map-studio/components/MapAgentRounds.vue'
import MapDeliveries from '~/map-studio/components/MapDeliveries.vue'

const { t } = useI18n()

const props = defineProps<{
  detail: MapStudioDetail
  runs: MapStudioRun[]
  selectedRunId: number | null
  stage: MapStudioStage
  openStage: string
  now: number
  open: boolean
  wide?: boolean
  loadingRuns: boolean
  busy?: boolean
  textConfigs: Array<{ id: number; name: string }>
  imageOptions: Array<{ key: string; configName: string; model: string }>
  textConfigId: number
  imageKey: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select-run', runId: number): void
  (e: 'reload-runs'): void
  (e: 'open-round', stage: string): void
  (e: 'save-models', payload: { textConfigId: number; imageKey: string }): void
  (e: 'request-auto'): void
  (e: 'clear-progress'): void
}>()

const confirmClear = ref(false)
const confirmAuto = ref(false)
const textConfigId = ref(props.textConfigId)
const imageKey = ref(props.imageKey)
watch(() => props.textConfigId, value => { textConfigId.value = value })
watch(() => props.imageKey, value => { imageKey.value = value })

const selectedRun = computed(() => props.runs.find(run => run.id === props.selectedRunId) ?? null)
const failureDetail = computed(() => props.selectedRunId !== null && props.selectedRunId === props.detail.run_id ? props.detail.error_detail ?? null : null)
const failureMessage = computed(() => (props.selectedRunId !== null && props.selectedRunId === props.detail.run_id ? props.detail.error : selectedRun.value?.error_msg ?? null))
const modelsDirty = computed(() => textConfigId.value !== props.textConfigId || imageKey.value !== props.imageKey)
</script>

<style scoped>
.act-overlay {
  position: fixed;
  inset: 0;
  z-index: 250;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, .32);
}
.act {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(560px, calc(100vw - 24px));
  max-height: 100vh;
  overflow: auto;
  padding: 12px;
  border-left: 1px solid var(--border-strong);
  background: var(--bg-1);
}
.act.is-wide { width: min(860px, calc(100vw - 24px)); }
.act-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.act-head strong { font: 600 12px var(--font-body); color: var(--text-1); }
.act-head .act-tool { margin-left: auto; }
.act-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.act-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.act-tool:disabled { opacity: .5; cursor: not-allowed; }
.act-danger {
  align-self: flex-start;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.act-block { display: flex; flex-direction: column; gap: 5px; padding-top: 8px; border-top: 1px dashed var(--border); }
.act-sub { font: 600 10.5px var(--font-body); color: var(--text-1); }
.act-sub-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.act-note { margin: 0; font-size: 10.5px; color: var(--text-2); }
.act-note.is-warn { color: var(--warn-text); font-weight: 600; }
.act-failure-kind { margin: 0; font: 600 11px var(--font-body); color: var(--warn-text); }
.act-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-2); }
.act-list li { display: flex; flex-wrap: wrap; gap: 6px; }
.act-round { font-weight: 600; color: var(--text-1); }
.act-select { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-2); }
.act-select .input { width: 190px; }
.act-row { display: flex; align-items: center; gap: 8px; }
</style>
