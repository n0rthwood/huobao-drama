<template>
  <section class="map-agent">
    <header class="map-agent-head">
      <strong>{{ t('mapStudio.agentProcess.title') }}</strong>
      <span class="dim">{{ t('mapStudio.agentProcess.hint') }}</span>
      <button type="button" class="map-tool" :disabled="loadingRuns" @click="emit('reload-runs')">
        <Loader2 v-if="loadingRuns" :size="11" class="animate-spin" />
        {{ t('mapStudio.panel.refresh') }}
      </button>
    </header>

    <p v-if="!runs.length" class="map-empty dim">{{ t('mapStudio.agentProcess.noRuns') }}</p>

    <ul v-else class="map-runs">
      <li
        v-for="run in runs"
        :key="run.id"
        class="map-run"
        :class="{ 'is-active': run.id === selectedRunId, 'is-live': run.status === 'processing', 'is-stage': run.stage === stage || run.start_stage === stage }"
      >
        <button type="button" class="map-run-head" :aria-pressed="run.id === selectedRunId" @click="emit('select-run', run.id)">
          <strong>{{ t('mapStudio.agentProcess.runLabel', { id: run.id }) }}</strong>
          <span class="map-chip">{{ t('mapStudio.stage.' + run.stage) }}</span>
          <span class="map-chip" :class="`is-${run.status}`">{{ t('mapStudio.agentProcess.runStatus.' + run.status) }}</span>
          <span class="dim">{{ run.mode === 'auto' ? t('mapStudio.panel.mode.auto') : t('mapStudio.panel.mode.manual') }}</span>
          <span class="dim">{{ fmtAt(run.created_at) }}</span>
          <span v-if="run.error_msg" class="map-error-inline">{{ run.error_msg }}</span>
        </button>
        <div class="map-run-metrics">
          <span>{{ t('mapStudio.agentProcess.wall', { value: duration(run.wall_ms, run.status === 'processing' ? run.created_at : null) }) }}</span>
          <span>{{ t('mapStudio.agentProcess.modelTime', { value: duration(run.model_ms) }) }}</span>
          <span>{{ t('mapStudio.agentProcess.queueTime', { value: duration(run.queue_ms) }) }}</span>
          <span>{{ t('mapStudio.agentProcess.calls', { n: run.call_count }) }}</span>
          <span class="dim">{{ run.status === 'processing' ? t('mapStudio.agentProcess.live') : t('mapStudio.agentProcess.frozen') }}</span>
        </div>
      </li>
    </ul>

    <p v-if="error" class="map-error">{{ error }}</p>

    <template v-if="selectedRun">
      <div class="map-observe">
        <div class="map-observe-head">
          <strong>{{ t('mapStudio.agentProcess.worksTitle', { n: works.length }) }}</strong>
          <button v-if="hasMoreWorks" type="button" class="map-tool" :disabled="loadingObserved" @click="loadObserved(false)">
            {{ t('mapStudio.agentProcess.loadMore') }}
          </button>
        </div>
        <p v-if="!works.length" class="map-empty dim">{{ t('mapStudio.agentProcess.noWorks') }}</p>
        <ul v-else class="map-works">
          <li v-for="work in works" :key="work.id" class="map-work">
            <span class="map-chip" :class="`is-${work.status}`">{{ t('mapStudio.agentProcess.workStatus.' + work.status) }}</span>
            <span class="dim">{{ t('mapStudio.agentProcess.workLabel', { id: work.id }) }}</span>
            <span>{{ t('mapStudio.agentProcess.modelTime', { value: duration(work.model_ms) }) }}</span>
            <span>{{ t('mapStudio.agentProcess.queueTime', { value: duration(work.queue_ms) }) }}</span>
            <span>{{ t('mapStudio.agentProcess.calls', { n: work.call_count }) }}</span>
            <span>{{ t('mapStudio.agentProcess.chars', { n: work.source_chars }) }}</span>
            <span class="dim">{{ fmtEpoch(work.started_at) }}</span>
            <span v-if="work.error_msg" class="map-error-inline">{{ work.error_msg }}</span>
          </li>
        </ul>

        <div class="map-observe-head">
          <strong>{{ t('mapStudio.agentProcess.callsTitle', { n: stageCalls.length }) }}</strong>
          <div class="map-stage-toggle">
            <button type="button" class="map-tool" :aria-pressed="!showAllStages" @click="showAllStages = false">
              {{ t('mapStudio.stage.' + stage) }}
            </button>
            <button type="button" class="map-tool" :aria-pressed="showAllStages" @click="showAllStages = true">
              {{ t('mapStudio.agentProcess.stageAll') }}
            </button>
          </div>
          <button v-if="hasMoreCalls" type="button" class="map-tool" :disabled="loadingObserved" @click="loadObserved(false)">
            {{ t('mapStudio.agentProcess.loadMore') }}
          </button>
        </div>
        <p v-if="!calls.length" class="map-empty dim">{{ t('mapStudio.agentProcess.noCalls') }}</p>
        <p v-else-if="!stageCalls.length" class="map-empty dim">{{ t('mapStudio.agentProcess.stageFilterEmpty') }}</p>
        <ul v-else class="map-calls">
          <li v-for="call in stageCalls" :key="call.id" class="map-call" :class="{ 'is-active': call.id === openCallId }">
            <button type="button" class="map-call-head" :aria-expanded="call.id === openCallId" @click="toggleCall(call.id)">
              <span class="map-chip">{{ t('mapStudio.agentProcess.kind.' + call.kind) }}</span>
              <span class="map-chip" :class="`is-${call.status}`">{{ t('mapStudio.agentProcess.workStatus.' + call.status) }}</span>
              <span v-if="showAllStages" class="map-chip">{{ call.stage ? t('mapStudio.stage.' + call.stage) : t('mapStudio.agentProcess.stageNone') }}</span>
              <strong>{{ call.model || t('mapStudio.agentProcess.unknownModel') }}</strong>
              <span class="dim">{{ call.config_name || t('mapStudio.agentProcess.unknownConfig') }}</span>
              <span>{{ t('mapStudio.agentProcess.called', { value: callDuration(call) }) }}</span>
              <span>{{ t('mapStudio.agentProcess.queued', { value: duration(call.queue_ms) }) }}</span>
              <span v-if="call.id === openCallId">{{ t('mapStudio.agentProcess.messageCount', { n: messagesTotal }) }}</span>
              <span class="dim">{{ t('mapStudio.agentProcess.requestChars', { n: call.request_chars, r: call.response_chars }) }}</span>
            </button>
            <p v-if="call.error_msg" class="map-error">{{ call.error_msg }}</p>

            <div v-if="call.id === openCallId" class="map-messages">
              <p v-if="messagesError" class="map-error">{{ messagesError }}</p>
              <p class="dim">{{ call.http_status ?? '—' }} · {{ call.finish_reason ?? '—' }} · tokens {{ call.prompt_tokens ?? '—' }} / {{ call.completion_tokens ?? '—' }}</p>
              <p v-if="!messages.length && !messagesLoading" class="map-empty dim">{{ t('mapStudio.agentProcess.noMessages') }}</p>
              <ol class="map-message-list">
                <li v-for="message in messages" :key="message.id" class="map-message">
                  <header class="map-message-head">
                    <span class="map-message-role">{{ message.role }}</span>
                    <span v-if="message.name" class="dim">{{ message.name }}</span>
                    <span v-if="message.tool_call_id" class="dim">{{ t('mapStudio.agentProcess.toolCallId', { id: message.tool_call_id }) }}</span>
                    <span class="dim">{{ t('mapStudio.agentProcess.phase.' + message.phase) }}</span>
                    <span class="dim">{{ t('mapStudio.agentProcess.chars', { n: message.chars }) }}</span>
                    <span v-if="message.streaming" class="map-chip">{{ t('mapStudio.agentProcess.streaming') }}</span>
                    <span class="dim map-message-at">{{ fmtEpoch(message.created_at) }}</span>
                  </header>
                  <!-- 公开正文按纯文本渲染：工具定义、参数与结果、模型正文都可能是任意字符，禁止 v-html -->
                  <pre class="map-message-body">{{ message.body }}</pre>
                </li>
              </ol>
              <div class="map-messages-foot">
                <span class="dim">{{ t('mapStudio.agentProcess.messagesLoaded', { n: messages.length, total: messagesTotal }) }}</span>
                <button v-if="messagesHasMore" type="button" class="map-tool" :disabled="messagesLoading" @click="loadMessages(false)">
                  <Loader2 v-if="messagesLoading" :size="11" class="animate-spin" />
                  {{ t('mapStudio.agentProcess.loadMore') }}
                </button>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * Agent 过程（Issue #99 + #87 口径）：一次运行的完整公开调用链。
 *
 * 三件事必须能分开看：**墙钟**（任务开始到结束）、**模型调用耗时**（服务端观测到的调用时间）、
 * **排队耗时**（进入执行槽之前等的时间）。都是服务端事实，前端只格式化，不重算、不猜。
 * 进行中的运行与调用用本地时钟补「已用」，终态一律用服务端落盘的数值并冻结，不继续增长。
 * 公开消息（system/user/assistant/tool 正文、工具定义与参数结果）按纯文本分页回看，刷新与重启后仍在。
 * 调用按阶段跨度归属（后端纯包含判定）：列表默认只看当前阶段，可显式切到「全部阶段」（mscf deeplink）。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  mapStudioAPI,
  type MapStudioCallMessages,
  type MapStudioRun,
  type MapStudioStage,
  type ObservedCallRow,
  type ObservedMessageRow,
  type ObservedWorkRow,
} from '~/map-studio/api'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'

const { t } = useI18n()

const props = defineProps<{
  taskId: number
  stage: MapStudioStage
  runs: MapStudioRun[]
  selectedRunId: number | null
  loadingRuns: boolean
  /** 页面本地时钟（毫秒）：只用于给进行中的项补「已用」时间 */
  now: number
}>()

const emit = defineEmits<{
  (e: 'select-run', runId: number): void
  (e: 'reload-runs'): void
}>()

const selectedRun = computed(() => props.runs.find(run => run.id === props.selectedRunId) ?? null)
const live = computed(() => selectedRun.value?.status === 'processing')

const works = ref<ObservedWorkRow[]>([])
const calls = ref<ObservedCallRow[]>([])
const workCursor = ref<number | null>(null)
const callCursor = ref<number | null>(null)
const hasMoreWorks = ref(false)
const hasMoreCalls = ref(false)
const loadingObserved = ref(false)
const error = ref('')
const loadedRunId = ref<number | null>(null)

const openCallId = ref<number | null>(null)
const messages = ref<ObservedMessageRow[]>([])
const messagesTotal = ref(0)
const messagesCursor = ref<number | null>(null)
const messagesHasMore = ref(false)
const messagesLoading = ref(false)
const messagesError = ref('')
let messagesRestored = false

let pollTimer: ReturnType<typeof setInterval> | null = null
let stopped = false

async function loadObserved(reset: boolean) {
  const runId = props.selectedRunId
  if (!runId || loadingObserved.value) return
  loadingObserved.value = true
  error.value = ''
  try {
    const res = await mapStudioAPI.observed(runId, {
      work_cursor: reset ? 0 : workCursor.value ?? 0,
      call_cursor: reset ? 0 : callCursor.value ?? 0,
      limit: 50,
    })
    if (stopped || runId !== props.selectedRunId) return
    if (reset && loadedRunId.value !== runId) {
      works.value = []
      calls.value = []
    }
    loadedRunId.value = runId
    works.value = mergeById(works.value, res.works)
    calls.value = mergeById(calls.value, res.calls)
    workCursor.value = res.next_work_cursor
    callCursor.value = res.next_call_cursor
    hasMoreWorks.value = res.has_more_works
    hasMoreCalls.value = res.has_more_calls
    restoreCallFromLink()
  } catch (err) {
    if (!stopped && runId === props.selectedRunId) error.value = messageOf(err)
  } finally {
    if (!stopped) loadingObserved.value = false
    if (!stopped && runId !== props.selectedRunId) { void loadObserved(true); return }
    if (!stopped && !messagesRestored && callLink.initial('mscall') && hasMoreCalls.value && !openCallId.value) void loadObserved(false)
  }
}

function mergeById<T extends { id: number }>(current: T[], next: T[]): T[] {
  const merged = new Map(current.map(row => [row.id, row]))
  for (const row of next) merged.set(row.id, row)
  return [...merged.values()].sort((a, b) => a.id - b.id)
}

async function loadMessages(reset: boolean) {
  const callId = openCallId.value
  if (!callId || messagesLoading.value) return
  messagesLoading.value = true
  messagesError.value = ''
  try {
    const res: MapStudioCallMessages = await mapStudioAPI.messages(callId, {
      cursor: reset ? undefined : messagesCursor.value ?? undefined,
      limit: 40,
    })
    if (stopped || callId !== openCallId.value) return
    messages.value = mergeById(messages.value, res.messages)
    messagesTotal.value = res.total
    messagesCursor.value = messages.value.length ? Math.max(...messages.value.map(message => message.id)) : null
    messagesHasMore.value = messages.value.length < res.total
  } catch (err) {
    if (!stopped && callId === openCallId.value) messagesError.value = messageOf(err)
  } finally {
    if (!stopped) messagesLoading.value = false
    if (!stopped && callId !== openCallId.value) void loadMessages(true)
  }
}

/**
 * 展开的调用是导航位置（稳定 call id，写进 mscall）。恢复只展开界面并读消息，
 * 不触发任何模型调用；调用在当前运行里不存在就清键并提示，不静默换一个调用冒充。
 */
const callLink = useDeeplink('mapStudioCall', DEEPLINK_KEYS.mapStudioCall)

/**
 * 「只看本阶段 / 全部阶段」是嵌套界面状态：取值写进 mscf（all = 全部，空 = 只看当前阶段）。
 * 缺省是只看当前阶段，因为它与页面的阶段选择一致；切到全部是显式动作，刷新与分享链接都能回到同一视图。
 */
const stageFilterLink = useDeeplink('mapStudioCallFilter', DEEPLINK_KEYS.mapStudioCallFilter)
const showAllStages = ref(stageFilterLink.initial('mscf') === 'all')
const stageCalls = computed(() => showAllStages.value ? calls.value : calls.value.filter(call => call.stage === props.stage))

/**
 * 过滤只影响列表展示：展开的调用被过滤出可见集合就收起（消息面板不能凭空消失），
 * 它仍可在「全部阶段」里重新展开。还没加载到该调用时不动，等分页补齐。
 */
function pruneOpenCall(): void {
  const id = openCallId.value
  if (id === null) return
  if (!calls.value.some(call => call.id === id)) return
  if (showAllStages.value || calls.value.some(call => call.id === id && call.stage === props.stage)) return
  openCallId.value = null
}

watch(showAllStages, all => {
  stageFilterLink.set({ mscf: all ? 'all' : '' })
  pruneOpenCall()
})

watch(() => props.stage, pruneOpenCall)

function restoreCallFromLink() {
  if (messagesRestored) return
  const raw = callLink.initial('mscall')
  if (!raw) return
  const id = Number(raw)
  if (!calls.value.some(call => call.id === id) && hasMoreCalls.value) return
  if (!Number.isFinite(id) || !calls.value.some(call => call.id === id)) {
    messagesRestored = true
    callLink.set({ mscall: '' })
    toast.warning(t('deeplink.missingNamed', { target: t('mapStudio.agentProcess.callTarget') }))
    return
  }
  messagesRestored = true
  // 链接指向的调用不属于当前阶段：先切到全部阶段，否则恢复出来的导航位置在列表里不可见
  if (!showAllStages.value && calls.value.find(call => call.id === id)!.stage !== props.stage) showAllStages.value = true
  openCallId.value = id
  callLink.set({ mscall: id })
  void loadMessages(true)
}

watch(openCallId, id => callLink.set({ mscall: id ?? '' }))

function toggleCall(id: number) {
  messagesRestored = true
  if (openCallId.value === id) {
    openCallId.value = null
    return
  }
  openCallId.value = id
  messages.value = []
  messagesTotal.value = 0
  messagesCursor.value = null
  messagesHasMore.value = false
  void loadMessages(true)
}

/** 换运行 = 换一段过程：清空上一段的分页与展开消息 */
watch(() => props.selectedRunId, (runId) => {
  works.value = []
  calls.value = []
  workCursor.value = null
  callCursor.value = null
  hasMoreWorks.value = false
  hasMoreCalls.value = false
  loadedRunId.value = null
  if (messagesRestored) openCallId.value = null
  messages.value = []
  messagesTotal.value = 0
  messagesCursor.value = null
  messagesHasMore.value = false
  if (!runId) return
  void loadObserved(true)
})

/**
 * 运行进行中才轮询：终态计时与列表冻结（服务端不再变化），后台刷新不覆盖展开的消息分页。
 */
watch([live, () => selectedRun.value?.status], ([isLive]) => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  void loadObserved(true)
  if (!isLive) return
  pollTimer = setInterval(() => {
    void loadObserved(true)
    if (openCallId.value) void loadMessages(true)
  }, 3_000)
}, { immediate: true })

onMounted(() => {
  if (props.selectedRunId) void loadObserved(true)
  else if (callLink.initial('mscall')) {
    callLink.set({})
    toast.warning(t('deeplink.missing'))
  }
})

onBeforeUnmount(() => {
  stopped = true
  if (pollTimer) clearInterval(pollTimer)
})

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : t('mapStudio.agentProcess.loadFailed')
}

function duration(ms: number | null | undefined, liveSinceIso?: string | null): string {
  let value = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
  if (liveSinceIso) {
    const started = Date.parse(liveSinceIso)
    if (Number.isFinite(started)) value = Math.max(value, props.now - started)
  }
  return formatDuration(value)
}

/** 观测行的进行中调用给的是毫秒时间戳，不是 ISO：单独格式化 */
function durationFromEpoch(startedMs: number | null | undefined, ms: number | null | undefined): string {
  const base = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
  const live = typeof startedMs === 'number' && startedMs > 0 ? Math.max(base, props.now - startedMs) : base
  return formatDuration(live)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('mapStudio.agentProcess.durationZero')
  if (ms < 1_000) return `${Math.round(ms)} ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} m ${Math.round(seconds % 60)} s`
}

function callDuration(call: ObservedCallRow): string {
  // 观测行的 started_at 是毫秒时间戳；终态直接用服务端落盘的 duration_ms
  return call.status === 'processing' ? durationFromEpoch(call.started_at, call.duration_ms) : formatDuration(call.duration_ms ?? 0)
}

function fmtAt(iso: string | null): string {
  if (!iso) return ''
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return iso
  return new Date(parsed).toLocaleString()
}

function fmtEpoch(ms: number | null): string {
  if (!ms || !Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString()
}
</script>

<style scoped>
.map-agent { display: flex; flex-direction: column; gap: 8px; }
.map-agent-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.map-agent-head strong { font: 600 12px var(--font-body); }
.map-tool {
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
.map-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.map-tool[aria-pressed='true'] { color: var(--accent-text); border-color: var(--accent-text); }
.map-tool:disabled { opacity: 0.5; cursor: not-allowed; }
.map-stage-toggle { display: flex; align-items: center; gap: 4px; }
.map-empty { margin: 0; font-size: 10.5px; }
.map-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.map-error-inline { font-size: 10px; color: var(--action-danger); }
.map-chip {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10px var(--font-body);
  color: var(--text-2);
}
.map-chip.is-processing { color: var(--accent-text); border-color: var(--accent-text); }
.map-chip.is-completed { color: var(--accent-text); border-color: var(--accent-text); }
.map-chip.is-failed,
.map-chip.is-interrupted { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.map-runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.map-run { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.map-run.is-active { border-color: var(--accent-text); }
.map-run.is-stage { box-shadow: inset 3px 0 0 var(--accent-text); }
.map-run-head {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 5px 8px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: 400 10.5px var(--font-body);
  text-align: left;
  cursor: pointer;
}
.map-run-head strong { font: 600 11px var(--font-body); color: var(--text-1); }
.map-run-metrics { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 0 8px 6px; font-size: 10.5px; color: var(--text-2); }
.map-observe { display: flex; flex-direction: column; gap: 6px; }
.map-observe-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-1); }
.map-observe-head strong { font: 600 11px var(--font-body); }
.map-works { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.map-work { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 6px; font-size: 10.5px; color: var(--text-2); }
.map-calls { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.map-call { border: 1px solid var(--border); border-radius: 6px; background: var(--surface-soft); }
.map-call.is-active { border-color: var(--accent-text); }
.map-call-head {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: 400 10.5px var(--font-body);
  text-align: left;
  cursor: pointer;
}
.map-call-head strong { font: 600 10.5px var(--font-body); color: var(--text-1); }
.map-messages { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 8px; border-top: 1px dashed var(--border); }
.map-message-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.map-message { display: flex; flex-direction: column; gap: 3px; }
.map-message-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 10px; color: var(--text-2); }
.map-message-role { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-strong); font: 600 10px var(--font-body); color: var(--text-1); }
.map-message-at { margin-left: auto; }
.map-message-body {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
  font: 400 10.5px var(--font-mono, monospace);
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
.map-messages-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 10.5px; }
</style>
