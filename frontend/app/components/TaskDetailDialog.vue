<template>
  <Teleport to="body">
    <div class="overlay task-detail-overlay" @click.self="emit('close')">
      <section class="dialog task-detail-dialog" role="dialog" aria-modal="true" :aria-label="t('taskCenter.detail.title')">
        <header class="dialog-head task-detail-head">
          <div class="task-detail-title-block">
            <span class="task-detail-kicker">{{ t('taskCenter.detail.title') }}</span>
            <h2 class="task-detail-title">{{ live.label || ('#' + live.id) }}</h2>
          </div>
          <button class="btn btn-ghost btn-icon" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="14" />
          </button>
        </header>

        <div class="task-detail-body">
          <!-- 状态 / 进度 -->
          <div class="task-detail-status-row">
            <span :class="['task-status-chip', 'is-' + stateClass]">{{ statusLabel }}</span>
            <span class="task-detail-id">#{{ live.id }}</span>
            <span v-if="retryOf" class="task-detail-id">{{ t('taskCenter.detail.retryOf', { id: retryOf }) }}</span>
            <ProgressRing
              v-if="ring.status && ring.status !== 'completed'"
              v-bind="ring"
              :size="34"
              :show-actions="false"
              class="task-detail-ring"
            />
          </div>
          <div v-if="live.error_msg" class="task-detail-error">{{ mapError(live.error_msg) }}</div>
          <div v-if="progressLines.length" class="task-detail-progress">
            <span v-for="(line, i) in progressLines" :key="i">{{ line }}</span>
          </div>

          <!-- 基本信息 -->
          <dl class="task-detail-grid">
            <div class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.type') }}</dt>
              <dd>{{ typeLabel }}</dd>
            </div>
            <div class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.provider') }}</dt>
              <dd>{{ live.provider || '—' }}</dd>
            </div>
            <div class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.model') }}</dt>
              <dd class="truncate">{{ live.model || t('common.default') }}</dd>
            </div>
            <div v-if="frameLabel" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.frameType') }}</dt>
              <dd>{{ frameLabel }}</dd>
            </div>
            <div v-if="params.size" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.size') }}</dt>
              <dd>{{ params.size }}</dd>
            </div>
            <div v-if="params.duration" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.duration') }}</dt>
              <dd>{{ params.duration }}s</dd>
            </div>
            <div class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.createdAt') }}</dt>
              <dd><MediaTime :at="live.created_at_unix" /></dd>
            </div>
            <div v-if="live.completed_at" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.completedAt') }}</dt>
              <dd><MediaTime :at="live.generated_at ?? live.completed_at_unix" /></dd>
            </div>
            <div v-if="elapsedText" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.elapsed') }}</dt>
              <dd>{{ elapsedText }}</dd>
            </div>
          </dl>

          <!-- 只读提示词 -->
          <div class="task-detail-section">
            <div class="task-detail-section-title">{{ t('taskCenter.detail.prompt') }}</div>
            <pre class="task-detail-prompt">{{ live.prompt || t('taskCenter.detail.noPrompt') }}</pre>
          </div>

          <!-- 参考图 -->
          <div v-if="referenceImages.length" class="task-detail-section">
            <div class="task-detail-section-title">{{ t('taskCenter.detail.references', { n: referenceImages.length }) }}</div>
            <div class="task-detail-refs">
              <img
                v-for="(url, i) in referenceImages"
                :key="i"
                :src="mediaSrc(url)"
                :alt="`ref ${i + 1}`"
                loading="lazy"
              />
            </div>
          </div>

          <!-- 结果预览 -->
          <div v-if="resultUrl" class="task-detail-section">
            <div class="task-detail-section-title">{{ t('taskCenter.detail.result') }}</div>
            <video v-if="live.type === 'video'" :src="mediaSrc(resultUrl)" controls preload="metadata" playsinline class="task-detail-result" />
            <img v-else :src="mediaSrc(resultUrl)" :alt="live.label || ''" loading="lazy" class="task-detail-result" />
            <MediaTime :at="live.generated_at ?? live.completed_at_unix" />
          </div>
        </div>

        <footer class="dialog-foot task-detail-foot">
          <div class="task-detail-retry">
            <ModelSelect
              v-if="modelOptions.length"
              v-model="retryModel"
              :label="t('taskCenter.detail.retryModel')"
              :options="modelOptions"
              :default-label="t('taskCenter.detail.keepModel')"
            />
            <span v-else class="task-detail-hint">{{ t('taskCenter.detail.noModels') }}</span>
          </div>
          <div class="task-detail-actions">
            <button
              v-if="live.cancellable && isActiveTaskStatus(live.status)"
              class="btn"
              :disabled="busy"
              @click="doCancel"
            >{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="busy" @click="askRetry">
              <Loader2 v-if="busy" :size="13" class="animate-spin" />
              {{ t('taskCenter.detail.retry') }}
            </button>
          </div>
        </footer>
      </section>
    </div>

    <ConfirmDialog
      :open="overwriteAsk"
      :title="t('taskCenter.detail.overwriteTitle')"
      :message="t('taskCenter.detail.overwriteMessage', { kind: textKindLabel })"
      :confirm-text="t('taskCenter.detail.retry')"
      :loading-text="t('taskCenter.detail.retrying')"
      :loading="busy"
      @cancel="overwriteAsk = false"
      @confirm="doRetry"
    />
  </Teleport>
</template>

<script setup>
/**
 * 任务详情：编号、状态/原因、厂商/模型、只读提示词、参数（参考图/尺寸/帧类型/时长）、
 * 时间、排队位置/进度/剩余、结果预览；操作为取消（可取消时）与换模型重试。
 * 提示词不可编辑（Issue #8：重试只允许改模型）。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { X, Loader2 } from 'lucide-vue-next'
import ProgressRing from '~/components/ProgressRing.vue'
import ModelSelect from '~/components/ModelSelect.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import MediaTime from '~/components/MediaTime.vue'
import { taskAPI } from '~/composables/useApi'
import { mapError, toastError, toastServerMessage } from '~/composables/useToast'
import { loadModelOptions, bareModelName } from '~/composables/useModelOptions'
import { useTasks } from '~/composables/useTasks'
import {
  useNowTicker, ringPropsFromTask, isActiveTaskStatus, formatSeconds, taskRemoteState,
} from '~/composables/useTaskProgress'

const props = defineProps({
  task: { type: Object, required: true },
})
const emit = defineEmits(['close', 'changed'])

const { t } = useI18n()
const now = useNowTicker()
const { tasksById, registerTask, refreshTasks } = useTasks()

// 详情里的任务始终取 store 的最新快照（轮询会原地刷新进度/状态）
const live = computed(() => ({ ...props.task, ...(tasksById.value[props.task.id] || {}) }))
const params = computed(() => live.value.params || {})
const retryOf = computed(() => live.value.retry_of || params.value.retry_of || null)
const referenceImages = computed(() => (Array.isArray(params.value.referenceImages) ? params.value.referenceImages : []))
const resultUrl = computed(() => live.value.local_path || live.value.result_url || '')
const ring = computed(() => ringPropsFromTask(live.value, now.value))

const FRAME_LABEL_KEYS = {
  first_frame: 'episode.kf.slotFirst', mid_frame: 'episode.kf.slotMid', last_frame: 'episode.kf.slotLast',
}
const frameLabel = computed(() => {
  const key = FRAME_LABEL_KEYS[String(live.value.frame_type || params.value.frameType || '')]
  return key ? t(key) : ''
})
const textKind = computed(() => String(live.value.kind || params.value.kind || ''))
const textKindLabel = computed(() => (textKind.value ? t(`taskCenter.textKind.${textKind.value}`) : ''))
const typeLabel = computed(() => {
  if (live.value.type === 'text') return textKindLabel.value || t('common.serviceType.text')
  if (live.value.type === 'video') return t('common.serviceType.video')
  return t('common.serviceType.image')
})
const statusLabel = computed(() => t(`taskCenter.status.${live.value.status || 'processing'}`))
const stateClass = computed(() => {
  const s = live.value.status
  if (s === 'completed') return 'done'
  if (s === 'failed' || s === 'cancelled') return 'failed'
  return 'pending'
})

const progressLines = computed(() => {
  const lines = []
  const r = ring.value
  if (r.queuePosition) lines.push(t('common.ring.queuedAt', { n: r.queuePosition }))
  if (r.queueLength) lines.push(t('common.ring.queueLength', { n: r.queueLength }))
  if (r.fraction !== null) lines.push(t('taskCenter.detail.percent', { percent: Math.round(r.fraction * 100) }))
  if (r.remainingSeconds !== null) lines.push(t('common.ring.remaining', { time: formatSeconds(t, r.remainingSeconds) }))
  // 文本任务进度：后端在 TaskRow.progress 透出（库里存在 params.progress）
  const textProgress = live.value.progress || params.value.progress
  if (textProgress && Number(textProgress.total)) {
    lines.push(t('taskCenter.detail.textProgress', { completed: Number(textProgress.completed || 0), total: Number(textProgress.total) }))
  }
  const remote = taskRemoteState(live.value)
  if (remote?.cancel_requested) lines.push(t('common.ring.cancelling'))
  return lines
})

const elapsedText = computed(() => {
  const start = Date.parse(String(live.value.created_at || ''))
  const end = Date.parse(String(live.value.completed_at || live.value.updated_at || ''))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  return formatSeconds(t, Math.round((end - start) / 1000))
})


function mediaSrc(url) {
  if (!url) return ''
  return /^(https?:)?\/\//.test(url) || url.startsWith('/') ? url : '/' + url
}

// ===== 换模型重试 =====
const SERVICE_TYPE = { image: 'image', video: 'video', text: 'text' }
const modelOptions = ref([])
const retryModel = ref('')
const busy = ref(false)
const overwriteAsk = ref(false)
// 剧本改写 / 拆分分镜的重试会覆盖本集剧本或分镜（Agent 工具直接写库），先让用户确认
const OVERWRITING_KINDS = ['script_rewrite', 'storyboard_breaker']

async function fetchModels() {
  const serviceType = SERVICE_TYPE[live.value.type] || 'image'
  try {
    modelOptions.value = await loadModelOptions(serviceType)
  } catch {
    modelOptions.value = []
  }
}
onMounted(fetchModels)
watch(() => live.value.type, fetchModels)

function askRetry() {
  if (OVERWRITING_KINDS.includes(textKind.value)) { overwriteAsk.value = true; return }
  void doRetry()
}

async function doRetry() {
  if (busy.value) return
  busy.value = true
  try {
    const option = modelOptions.value.find(o => o.key === retryModel.value) || null
    const created = await taskAPI.retry(live.value.id, {
      model: bareModelName(retryModel.value) || undefined,
      config_id: option?.configId,
    })
    overwriteAsk.value = false
    registerTask(created)
    toast.success(t('taskCenter.detail.retryStarted', { id: created?.id ?? '' }))
    emit('changed', created)
    emit('close')
  } catch (e) {
    toastServerMessage(e, { fallback: 'taskCenter.detail.retryFailed' })
  } finally {
    busy.value = false
  }
}

async function doCancel() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await taskAPI.cancel(live.value.id)
    registerTask(res)
    toast.success(t('common.ring.cancelRequested'))
    await refreshTasks()
    emit('changed', res)
  } catch (e) {
    toastError(e, { fallback: 'common.ring.cancelFailed' })
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.task-detail-overlay { z-index: 60; }
.task-detail-dialog {
  width: 620px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
}
.task-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.task-detail-title-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.task-detail-kicker { font-size: 10.5px; color: var(--text-3); letter-spacing: 0.04em; }
.task-detail-title { font-size: 15px; font-weight: 700; color: var(--text-0); margin: 0; }
.task-detail-body { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 14px; }
.task-detail-status-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.task-detail-id { font-size: 11px; color: var(--text-3); }
.task-detail-ring { margin-left: auto; }
.task-status-chip {
  font-size: 11px; font-weight: 600;
  padding: 2px 9px; border-radius: var(--radius-pill);
  background: var(--overlay-track); color: var(--text-1);
}
.task-status-chip.is-done { color: var(--ok-text, var(--text-1)); }
.task-status-chip.is-failed { color: var(--danger-text, #d9534f); }
.task-detail-error {
  font-size: 12px; color: var(--danger-text, #d9534f);
  background: var(--warn-bg); border: 1px solid var(--warn-border);
  border-radius: var(--radius); padding: 7px 10px;
}
.task-detail-progress { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11.5px; color: var(--text-2); }
.task-detail-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px 14px; margin: 0;
}
.task-detail-cell { min-width: 0; }
.task-detail-cell dt { font-size: 10.5px; color: var(--text-3); margin-bottom: 2px; }
.task-detail-cell dd { font-size: 12.5px; color: var(--text-1); margin: 0; }
.task-detail-section { display: flex; flex-direction: column; gap: 6px; }
.task-detail-section-title { font-size: 11px; font-weight: 600; color: var(--text-2); }
.task-detail-prompt {
  margin: 0; padding: 9px 11px;
  background: var(--overlay-track); border-radius: var(--radius);
  font-size: 12px; line-height: 1.6; color: var(--text-1);
  white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow-y: auto;
}
.task-detail-refs { display: flex; flex-wrap: wrap; gap: 8px; }
.task-detail-refs img {
  width: 64px; height: 64px; object-fit: cover;
  border-radius: var(--radius); border: 1px solid var(--border);
}
.task-detail-result { width: 100%; max-height: 320px; object-fit: contain; border-radius: var(--radius); background: var(--overlay-track); }
.task-detail-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.task-detail-retry { display: flex; align-items: center; gap: 8px; min-width: 0; }
.task-detail-hint { font-size: 11.5px; color: var(--text-3); }
.task-detail-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
</style>
