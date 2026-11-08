<template>
  <Teleport to="body">
    <div class="overlay task-detail-overlay" @click.self="emit('close')">
      <section class="dialog task-detail-dialog" :class="{ 'is-review': reviewing }" role="dialog" aria-modal="true" :aria-label="t('taskCenter.detail.title')">
        <header class="dialog-head task-detail-head">
          <div class="task-detail-title-block">
            <span class="task-detail-kicker">{{ t('taskCenter.detail.title') }}</span>
            <h2 class="task-detail-title">{{ live.label || ('#' + live.id) }}</h2>
          </div>
          <button class="btn btn-ghost btn-icon" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="14" />
          </button>
        </header>

        <footer v-if="reviewing" id="pipeline-review-footer" class="dialog-foot task-detail-foot review-foot" />

        <div ref="bodyEl" class="task-detail-body">
          <template v-if="reviewing && live.pipeline">
            <div class="task-detail-status-row">
              <span class="task-status-chip">{{ statusLabel }}</span>
              <span v-if="live.pipeline?.awaiting">{{ t('episode.documentary.pipeline.roundLabel', { n: live.pipeline.awaiting.round_no }) }}</span>
              <span v-if="elapsedText">{{ t('episode.documentary.pipeline.elapsedIncludingWaiting', { time: elapsedText }) }}</span>
            </div>
            <AssetPipelinePanel
              :asset-kind="live.pipeline.asset_kind" :asset-id="live.pipeline.asset_id"
              :episode-id="live.episode_id || 0" :review-run-id="live.id"
              :asset-name="live.label || ''" @preview="showPreview" @update="emit('changed')"
            />
          </template>
          <template v-else>
          <!-- 状态 / 进度 -->
          <div class="task-detail-status-row">
            <span :class="['task-status-chip', 'is-' + stateClass]">{{ statusLabel }}</span>
            <span class="task-detail-id">#{{ live.id }}</span>
            <span v-if="retryOf" class="task-detail-id">{{ t('taskCenter.detail.retryOf', { id: retryOf }) }}</span>
            <button v-if="live.pipeline?.state === 'waiting_approval'" class="btn btn-sm" @click="reviewing = true">{{ t('episode.documentary.pipeline.reviewAction') }}</button>
            <ProgressRing
              v-if="(!live.pipeline || live.pipeline.state === 'running') && ring.status && ring.status !== 'completed'"
              v-bind="ring"
              :size="34"
              :show-actions="false"
              class="task-detail-ring"
            />
          </div>
          <div v-if="progressLines.length" class="task-detail-progress">
            <span v-for="(line, i) in progressLines" :key="i">{{ line }}</span>
          </div>

          <!-- 改写运行的阶段时间线（#70）：一个父任务 + 详情时间线，不另建运行仪表盘 -->
          <div v-if="rewriteStages.length" class="task-detail-section">
            <span class="task-detail-section-title">
              {{ t('taskCenter.detail.rewriteStages') }}
              <span v-if="rewritePosition" class="task-detail-hint">{{ rewritePosition }}</span>
            </span>
            <ol class="task-detail-timeline">
              <li v-for="stage in rewriteStages" :key="stage.key" :class="['is-' + stage.status]">
                <span class="mono task-detail-timeline-glyph">{{ STAGE_GLYPH[stage.status] || '○' }}</span>
                <span>{{ t(`episode.rewrite.stageName.${stage.key}`) }}</span>
                <span class="task-detail-hint">{{ t(`episode.rewrite.stageStatus.${stage.status}`) }}</span>
                <span v-if="stage.error" class="task-detail-timeline-error">{{ stage.error }}</span>
              </li>
            </ol>
          </div>

          <!-- 错误信息（滚动 + 复制，Issue #19） -->
          <div v-if="live.error_msg" class="task-detail-section">
            <div class="task-detail-section-head">
              <span class="task-detail-section-title is-error">{{ t('taskCenter.detail.errorTitle') }}</span>
              <button class="btn btn-ghost btn-icon task-detail-copy" :title="t('taskCenter.detail.copyError')" @click="copyError">
                <Check v-if="errorCopied" :size="13" class="ok" />
                <Copy v-else :size="13" />
              </button>
            </div>
            <TaskErrorMessage :error="live.error_msg" :show-copy="false" />
          </div>

          <!-- 思考过程（仅文本任务，Issue #19） -->
          <div v-if="live.type === 'text'" class="task-detail-section">
            <button class="task-detail-section-head is-clickable" type="button" @click="thinkingOpen = !thinkingOpen">
              <span class="task-detail-section-title">
                {{ t('taskCenter.detail.thinking') }}
                <span v-if="taskActive && reasoning.chars === 0" class="task-detail-hint">{{ t('taskCenter.detail.noThinking') }}</span>
              </span>
              <span class="task-detail-thinking-meta">
                <span v-if="taskActive" class="task-detail-pulse" :title="t('taskCenter.detail.thinkingLive')">{{ t('taskCenter.detail.thinkingLive') }}</span>
                <span v-if="reasoning.chars" class="task-detail-id">{{ t('taskCenter.detail.chars', { n: reasoning.chars }) }}</span>
                <ChevronDown :size="14" class="task-detail-chevron" :class="{ 'is-open': thinkingOpen }" />
              </span>
            </button>
            <template v-if="thinkingOpen">
              <pre ref="thinkingEl" class="task-detail-thinking" @scroll="onThinkingScroll">{{ reasoning.text || '　' }}</pre>
              <div v-if="!fullView && reasoning.chars > reasoning.text.length" class="task-detail-hint">
                <button class="btn btn-ghost btn-sm" @click="loadFullReasoning">{{ t('taskCenter.detail.viewFull') }}</button>
              </div>
            </template>
          </div>

          <!-- 最终输出（文本任务正文，Issue #19） -->
          <div v-if="live.type === 'text' && outputText" class="task-detail-section">
            <div class="task-detail-section-head">
              <span class="task-detail-section-title">{{ t('taskCenter.detail.output') }}</span>
            </div>
            <pre class="task-detail-output">{{ outputText }}</pre>
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
              <dt>{{ live.pipeline ? t('episode.documentary.pipeline.elapsedLabel') : t('taskCenter.detail.elapsed') }}</dt>
              <dd>{{ elapsedText }}</dd>
            </div>
            <!-- AI 环节与实际使用的模型（#51）：视觉环节会把顶栏选的非视觉模型换掉 -->
            <div v-if="stageInfo" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.stage') }}</dt>
              <dd>{{ stageInfo }}</dd>
            </div>
            <div v-if="modelUsed" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.modelUsed') }}</dt>
              <dd>{{ modelUsed }}</dd>
            </div>
            <!-- 读图调用计量（#46）：文本任务里 read_image 用了几次、哪个模型、多少 token -->
            <div v-if="visionCalls" class="task-detail-cell">
              <dt>{{ t('taskCenter.detail.visionCalls') }}</dt>
              <dd>{{ t('taskCenter.detail.visionCallsValue', {
                n: visionCalls.count,
                model: visionCalls.model,
                pt: visionCalls.prompt_tokens,
                ct: visionCalls.completion_tokens,
              }) }}</dd>
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
          </template>
        </div>

        <footer v-if="!reviewing" class="dialog-foot task-detail-foot">
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
    <div v-if="previewUrl" class="pipeline-preview" role="dialog" aria-modal="true" :aria-label="previewTitle" @click.self="previewUrl = ''">
      <button class="btn pipeline-preview-close" :aria-label="t('common.close')" @click="previewUrl = ''"><X :size="18" /></button>
      <img :src="previewUrl" :alt="previewTitle" @error="previewUnavailable" />
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
 * 任务详情（Issue #19 布局重构）：状态/进度 → 错误（滚动 + 复制）→ 思考过程（文本任务，
 * 进行中每 3s 拉尾部并自动滚底，结束后折叠可展开全文）→ 最终输出 → 基本信息 → 提示词 →
 * 参考图 → 结果预览；操作为取消（可取消时）与换模型重试。提示词不可编辑（Issue #8）。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { X, Loader2, Copy, Check, ChevronDown } from 'lucide-vue-next'
import ProgressRing from '~/components/ProgressRing.vue'
import ModelSelect from '~/components/ModelSelect.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import MediaTime from '~/components/MediaTime.vue'
import AssetPipelinePanel from '~/components/AssetPipelinePanel.vue'
import TaskErrorMessage from '~/components/TaskErrorMessage.vue'
import { taskErrorPresentation } from '~/utils/taskError'
import { taskAPI } from '~/composables/useApi'
import { mapError, toastError, toastServerMessage } from '~/composables/useToast'
import { loadModelOptions, bareModelName } from '~/composables/useModelOptions'
import { useTasks } from '~/composables/useTasks'
import { copyToClipboard } from '~/utils/clipboard'
import { mediaUrl } from '~/utils/url'
import { DEEPLINK_KEYS, querySingle, useDeeplink } from '~/composables/useQuerySync'
import {
  useNowTicker, ringPropsFromTask, isActiveTaskStatus, formatSeconds, taskRemoteState,
} from '~/composables/useTaskProgress'

const props = defineProps({
  task: { type: Object, required: true },
  reviewMode: { type: Boolean, default: false },
  // 全屏正文视图：由宿主（任务中心面板）经 URL 同步（Issue #86 tfull）
  fullView: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'changed', 'update:fullView'])

const { t } = useI18n()
const now = useNowTicker()
const { tasksById, registerTask, refreshTasks } = useTasks()
const reviewing = ref(props.reviewMode)
const previewUrl = ref('')
const previewTitle = ref('')
function showPreview(url, title) { previewUrl.value = url; previewTitle.value = title }

// 详情里的任务始终取 store 的最新快照（轮询会原地刷新进度/状态）
const live = computed(() => ({ ...props.task, ...(tasksById.value[props.task.id] || {}) }))
const params = computed(() => live.value.params || {})
const retryOf = computed(() => live.value.retry_of || params.value.retry_of || null)
const referenceImages = computed(() => (Array.isArray(params.value.referenceImages) ? params.value.referenceImages : []))
// 读图调用计量（#46）：只有 read_image 真的跑过的文本任务才有这段
const visionCalls = computed(() => {
  const v = params.value.vision_calls
  return v && typeof v === 'object' && Number(v.count) > 0 ? v : null
})
/** AI 环节标记（#51）：stage + 是否视觉环节 */
const stageInfo = computed(() => {
  const stage = params.value.stage
  if (!stage) return ''
  return params.value.model_used?.vision === true
    ? `${stage}（${t('taskCenter.detail.stageVision')}）`
    : String(stage)
})
/** 本次实际落到哪条配置/模型（顶栏选 GLM 的视觉环节会显示 DeepSeek） */
const modelUsed = computed(() => {
  const m = params.value.model_used
  if (!m || typeof m !== 'object') return ''
  return [m.name, m.model].filter(Boolean).join(' · ')
})
const resultUrl = computed(() => live.value.local_path || live.value.result_url || '')
const ring = computed(() => ringPropsFromTask(live.value, now.value))
const taskActive = computed(() => isActiveTaskStatus(live.value.status) && (!live.value.pipeline || live.value.pipeline.state === 'running'))

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
const statusLabel = computed(() => live.value.pipeline
  ? t(`episode.documentary.pipeline.execution${live.value.pipeline.state.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join('')}`)
  : t(`taskCenter.status.${live.value.status || 'processing'}`))
const stateClass = computed(() => {
  const s = live.value.status
  if (s === 'completed') return 'done'
  if (s === 'failed' || s === 'cancelled') return 'failed'
  return 'pending'
})

/** 改写运行（#70）：阶段进度来自 params.rewrite，和阶段条同一份事实 */
const STAGE_GLYPH = { pending: '○', processing: '◌', completed: '✓', skipped: '⤼', failed: '✕' }
const rewriteInfo = computed(() => {
  const raw = params.value.rewrite
  return raw && typeof raw === 'object' ? raw : null
})
const rewriteStages = computed(() => (Array.isArray(rewriteInfo.value?.stages) ? rewriteInfo.value.stages : []))
const rewritePosition = computed(() => {
  const info = rewriteInfo.value
  if (!info?.stage_total || !info?.stage_key) return ''
  return t('episode.rewrite.runStagePosition', {
    index: info.stage_index,
    total: info.stage_total,
    name: t(`episode.rewrite.stageName.${info.stage_key}`),
  })
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
  const end = live.value.completed_at
    ? Date.parse(String(live.value.completed_at))
    : isActiveTaskStatus(live.value.status) ? now.value : Date.parse(String(live.value.updated_at || ''))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  return formatSeconds(t, Math.round((end - start) / 1000))
})

function mediaSrc(url) {
  return mediaUrl(url)
}

// ===== 错误复制（Issue #19） =====
const errorCopied = ref(false)
let errorCopiedTimer = null

async function copyError() {
  const ok = await copyToClipboard(taskErrorPresentation(live.value.error_msg || '', t).diagnostic)
  if (ok) {
    errorCopied.value = true
    clearTimeout(errorCopiedTimer)
    errorCopiedTimer = setTimeout(() => { errorCopied.value = false }, 2000)
    toast.success(t('taskCenter.detail.copied'))
  } else {
    toast.error(t('taskCenter.detail.copyFailed'))
  }
}

// ===== 思考过程（仅文本任务，Issue #19） =====
const reasoning = ref({ chars: 0, text: '', offset: 0 })
const thinkingOpen = ref(isActiveTaskStatus(props.task.status))
const fullView = ref(Boolean(props.fullView))
const followTail = ref(true)
const thinkingEl = ref(null)
let reasoningTimer = null
let reasoningSeq = 0
const outputText = ref('')

async function fetchReasoning(opts = { tail: 4096 }) {
  if (live.value.type !== 'text') return
  const seq = ++reasoningSeq
  try {
    const res = await taskAPI.reasoning(live.value.id, opts)
    if (seq !== reasoningSeq) return
    const data = res?.data || res
    reasoning.value = {
      chars: Number(data?.chars || 0),
      text: String(data?.text || ''),
      offset: Number(data?.offset || 0),
    }
    if (taskActive.value) {
      await nextTick()
      if (followTail.value && thinkingEl.value) thinkingEl.value.scrollTop = thinkingEl.value.scrollHeight
    }
  } catch { /* 拉取失败静默，下一轮重试 */ }
}

async function loadFullReasoning() {
  fullView.value = true
  await fetchReasoning({ tail: Math.max(reasoning.value.chars, 4096) })
  await nextTick()
  if (thinkingEl.value) thinkingEl.value.scrollTop = 0
}

// 用户手动上滚时暂停自动跟随，滚回底部则恢复
function onThinkingScroll() {
  const el = thinkingEl.value
  if (!el) return
  followTail.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

async function fetchDetail() {
  try {
    const res = await taskAPI.get(live.value.id)
    const data = res?.data || res
    if (typeof data?.output_text === 'string') outputText.value = data.output_text
  } catch { /* 详情失败静默 */ }
}

function startReasoningPolling() {
  stopReasoningPolling()
  if (live.value.type !== 'text' || !taskActive.value) return
  void fetchReasoning()
  reasoningTimer = setInterval(() => {
    if (!taskActive.value) { stopReasoningPolling(); return }
    if (!fullView.value) void fetchReasoning()
  }, 3000)
}

function stopReasoningPolling() {
  if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null }
}

// 全屏正文视图与宿主双向同步（Issue #86）：宿主负责把它写进 URL
watch(() => props.fullView, (open) => { if (open !== fullView.value) fullView.value = open })
watch(fullView, (open) => {
  emit('update:fullView', open)
  // 非文本任务没有这个视图：链接里带了也要回落
  if (open && live.value.type !== 'text') fullView.value = false
})

/** 从链接恢复全屏正文：展开思考块并按总字数取回全文（只读，不触发任何写操作） */
async function restoreFullView() {
  if (!fullView.value) return
  if (live.value.type !== 'text') { fullView.value = false; return }
  thinkingOpen.value = true
  await fetchReasoning()
  await loadFullReasoning()
}

onMounted(startReasoningPolling)
onBeforeUnmount(() => {
  stopReasoningPolling()
  clearTimeout(errorCopiedTimer)
})
// 任务进入终态：停轮询，补拉一次详情（正文）与思考尾部，思考块按 Q1 折叠
watch(taskActive, (active) => {
  if (!active) {
    stopReasoningPolling()
    thinkingOpen.value = false
    fullView.value = false
    void fetchDetail()
    if (live.value.pipeline?.state !== 'waiting_approval') void fetchReasoning()
  } else {
    startReasoningPolling()
  }
})

// ===== 换模型重试 =====
const SERVICE_TYPE = { image: 'image', video: 'video', text: 'text' }
const modelOptions = ref([])
const retryModel = ref('')
const busy = ref(false)
const overwriteAsk = ref(false)
// 剧本改写 / 拆分分镜的重试会覆盖本集剧本或分镜（Agent 工具直接写库），先让用户确认
const OVERWRITING_KINDS = ['script_rewrite', 'storyboard_breaker']
const uiLink = useDeeplink('taskDialogUi', DEEPLINK_KEYS.taskDialogUi)
const urlRetryModel = querySingle(uiLink.initial('tmodel'))
const urlOverwrite = uiLink.initial('taskoverwrite') === '1'
const urlPreview = querySingle(uiLink.initial('tpreview'))
const urlThinking = querySingle(uiLink.initial('tthink'))

function previewIdentity(value) {
  if (!value) return ''
  try {
    const url = new URL(value, window.location.href)
    if (url.origin !== window.location.origin) return ''
    const start = url.pathname.indexOf('/static/')
    if (start < 0) return ''
    const path = decodeURIComponent(url.pathname.slice(start + 1))
    return path.split('/').some(part => part === '..' || part === '.' || /[\\\u0000-\u001f]/.test(part)) ? '' : path
  } catch { return '' }
}
function previewUnavailable() {
  previewUrl.value = ''
  toast.warning(t('deeplink.missing'))
}
function restoreTaskUi() {
  let validModel = true
  if (urlRetryModel && !retryModel.value) {
    if (modelOptions.value.some(option => option.key === urlRetryModel)) retryModel.value = urlRetryModel
    else { validModel = false; toast.warning(t('deeplink.missing')) }
  }
  if (urlOverwrite && validModel) {
    if (OVERWRITING_KINDS.includes(textKind.value) && !isActiveTaskStatus(live.value.status)) overwriteAsk.value = true
    else toast.warning(t('deeplink.missing'))
  }
  if (urlThinking === '1' || urlThinking === '0') thinkingOpen.value = urlThinking === '1'
  if (urlPreview && !previewUrl.value) {
    const path = previewIdentity(urlPreview)
    if (path) showPreview(mediaUrl(path), path)
    else toast.warning(t('deeplink.missing'))
  }
}
watch([previewUrl, retryModel, overwriteAsk, thinkingOpen], () => uiLink.set({
  tpreview: previewIdentity(previewUrl.value),
  tmodel: retryModel.value || '',
  taskoverwrite: overwriteAsk.value ? '1' : '',
  tthink: thinkingOpen.value ? '1' : '0',
}), { immediate: true })

async function fetchModels() {
  const serviceType = SERVICE_TYPE[live.value.type] || 'image'
  try {
    modelOptions.value = await loadModelOptions(serviceType)
  } catch {
    modelOptions.value = []
  }
}

onMounted(async () => {
  if (live.value.type === 'text' && live.value.pipeline?.state !== 'waiting_approval') {
    void fetchReasoning()
    void fetchDetail()
  }
  void restoreFullView()
  await fetchModels()
  restoreTaskUi()
})

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
.task-detail-dialog.is-review { width: 1120px; max-height: calc(100vh - 48px); }
.task-detail-head { flex: none; order: 0; }
.task-detail-body { order: 1; min-height: 0; overflow-wrap: anywhere; }
.task-detail-foot { flex: none; order: 2; }
.pipeline-preview { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.9); display: flex; align-items: center; justify-content: center; padding: 48px; }
.pipeline-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
.pipeline-preview-close { position: absolute; right: 16px; top: 16px; }
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
.task-detail-progress { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11.5px; color: var(--text-2); }
.task-detail-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.task-detail-timeline li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-1); flex-wrap: wrap; }
.task-detail-timeline li.is-failed { color: var(--danger-text, #d9534f); }
.task-detail-timeline li.is-pending { color: var(--text-3); }
.task-detail-timeline-glyph { width: 14px; text-align: center; font-size: 11px; }
.task-detail-timeline-error { font-size: 11px; color: var(--danger-text, #d9534f); }
.task-detail-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px 14px; margin: 0;
}
.task-detail-cell { min-width: 0; }
.task-detail-cell dt { font-size: 10.5px; color: var(--text-3); margin-bottom: 2px; }
.task-detail-cell dd { font-size: 12.5px; color: var(--text-1); margin: 0; }
.task-detail-section { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.task-detail-section-title { font-size: 11px; font-weight: 600; color: var(--text-2); }
.task-detail-section-title.is-error { color: var(--danger-text, #d9534f); }
.task-detail-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-detail-section-head.is-clickable { background: none; border: none; padding: 0; cursor: pointer; text-align: left; width: 100%; color: inherit; }
.task-detail-thinking-meta { display: flex; align-items: center; gap: 8px; }
.task-detail-chevron { color: var(--text-3); transition: transform 0.15s ease; }
.task-detail-chevron.is-open { transform: rotate(180deg); }
.task-detail-pulse { font-size: 10.5px; color: var(--text-2); animation: task-detail-breathe 1.6s ease-in-out infinite; }
@keyframes task-detail-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.task-detail-copy { color: var(--text-2); }
.task-detail-copy .ok { color: var(--ok-text, var(--text-1)); }
.task-detail-errorcard, .task-detail-thinking, .task-detail-output {
  margin: 0; padding: 9px 11px;
  border-radius: var(--radius);
  font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  overflow-y: auto;
}
.task-detail-errorcard {
  max-height: 200px;
  color: var(--danger-text, #d9534f);
  background: var(--warn-bg); border: 1px solid var(--warn-border);
}
.task-detail-thinking {
  max-height: 260px; color: var(--text-1);
  background: var(--overlay-track);
}
.task-detail-output {
  max-height: 220px; color: var(--text-1);
  background: var(--overlay-track);
}
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
