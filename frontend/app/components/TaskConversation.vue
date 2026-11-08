<template>
  <!-- 没有观测记录的文本任务（本轮未接入的 harness）不占位：#88 接入后自然出现 -->
  <div v-if="works.length || calls.length || loadError" class="task-conversation">
    <div class="task-conv-head">
      <span class="task-detail-section-title">{{ t('taskCenter.detail.conversation.title') }}</span>
      <span v-if="works.length" class="task-detail-hint">
        {{ t('taskCenter.detail.conversation.summary', { works: works.length, calls: calls.length }) }}
      </span>
      <span v-if="live" class="task-detail-pulse">{{ t('taskCenter.detail.conversation.live') }}</span>
    </div>

    <p v-if="loadError" class="task-conv-error">{{ loadError }}</p>
    <p v-else-if="!loaded" class="task-detail-hint">{{ t('taskCenter.detail.conversation.loading') }}</p>

    <!-- 工作项：骨架整集 / 设计卡逐镜 / 配音逐镜，筛选调用列表 -->
    <ul v-if="works.length" class="task-conv-works">
      <li
        v-for="work in works"
        :key="work.id"
        :class="['task-conv-work', 'is-' + work.status, { 'is-active': workFilter === work.id }]"
      >
        <button type="button" class="task-conv-work-btn" @click="toggleWorkFilter(work.id)">
          <span class="task-conv-chip">{{ t(`taskCenter.detail.conversation.stage.${work.stage}`) }}</span>
          <span v-if="work.storyboard_number != null" class="mono">#{{ work.storyboard_number }}</span>
          <span class="task-conv-chip is-status">{{ t(`taskCenter.detail.conversation.status.${work.status}`) }}</span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.sourceChars', { n: work.source_chars }) }}</span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.modelTime', { time: msText(work.model_ms) }) }}</span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.queueTime', { time: msText(work.queue_ms) }) }}</span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.workTime', { time: msText(workWallMs(work)) }) }}</span>
        </button>
        <p v-if="work.error_msg" class="task-conv-error">{{ work.error_msg }}</p>
      </li>
    </ul>

    <!-- 调用：一行一条真实请求（取到槽位之后开始计时），展开看完整公开消息 -->
    <ol v-if="visibleCalls.length" class="task-conv-calls">
      <li v-for="call in visibleCalls" :key="call.id" :class="['task-conv-call', 'is-' + call.status]">
        <button type="button" class="task-conv-call-head" @click="toggleCall(call.id)">
          <span class="task-conv-chip">{{ t(`taskCenter.detail.conversation.kind.${call.kind}`) }}</span>
          <span class="truncate">{{ [call.config_name, call.model].filter(Boolean).join(' · ') || t('common.default') }}</span>
          <span class="task-conv-chip is-status">{{ t(`taskCenter.detail.conversation.status.${call.status}`) }}</span>
          <span v-if="call.http_status" class="task-detail-hint mono">HTTP {{ call.http_status }}</span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.callTime', { time: msText(call.duration_ms) }) }}</span>
          <span v-if="call.queue_ms" class="task-detail-hint">{{ t('taskCenter.detail.conversation.queueTime', { time: msText(call.queue_ms) }) }}</span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.io', { req: call.request_chars, res: call.response_chars }) }}</span>
          <span v-if="call.prompt_tokens || call.completion_tokens" class="task-detail-hint">
            {{ t('taskCenter.detail.conversation.tokens', { pt: call.prompt_tokens || 0, ct: call.completion_tokens || 0 }) }}
          </span>
          <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.messageCount', { n: call.message_count }) }}</span>
          <ChevronDown :size="14" class="task-detail-chevron" :class="{ 'is-open': !!threads[call.id] }" />
        </button>
        <p v-if="call.error_msg" class="task-conv-error">{{ call.error_msg }}</p>

        <div v-if="threads[call.id]" class="task-conv-messages">
          <p v-if="threads[call.id].loading && !threads[call.id].messages.length" class="task-detail-hint">
            {{ t('taskCenter.detail.conversation.loading') }}
          </p>
          <article
            v-for="msg in threads[call.id].messages"
            :key="msg.id"
            :class="['task-conv-msg', 'is-' + msg.phase]"
          >
            <header class="task-conv-msg-head">
              <span class="task-conv-chip is-role">{{ roleLabel(msg.role) }}</span>
              <span v-if="msg.name" class="mono truncate">{{ msg.name }}</span>
              <span class="task-detail-hint">{{ t('taskCenter.detail.conversation.phase.' + msg.phase) }}</span>
              <span class="task-detail-hint">{{ t('taskCenter.detail.chars', { n: msg.chars }) }}</span>
              <span v-if="msg.streaming" class="task-detail-pulse">{{ t('taskCenter.detail.conversation.streaming') }}</span>
            </header>
            <pre class="task-conv-body">{{ msg.body || '　' }}</pre>
          </article>
          <button
            v-if="threads[call.id].hasMore"
            class="btn btn-ghost btn-sm"
            :disabled="threads[call.id].loading"
            @click="loadMessages(call.id)"
          >{{ t('taskCenter.detail.conversation.loadMoreMessages', { n: threads[call.id].total - threads[call.id].messages.length }) }}</button>
        </div>
      </li>
    </ol>

    <button v-if="hasMore" class="btn btn-ghost btn-sm" :disabled="loading" @click="loadCalls()">
      {{ t('taskCenter.detail.conversation.loadMore') }}
    </button>
  </div>
</template>

<script setup>
/**
 * 任务对话（Issue #87）：真实 LLM/TTS 调用的完整公开对话与时序。
 * - 数据来自 /tasks/:id/observations 与 .../calls/:callId/messages，游标分页按需增量读，
 *   绝不「只显示最近 N 条」；正文一律纯文本渲染（不解析 Markdown/HTML）。
 * - 运行中只刷新自己这份从属资源（新调用 + 仍在进行的那一条 + 展开中的消息），
 *   不另起一套全局任务状态轮询：任务状态仍由 useTasks 单一来源提供（props.active）。
 */
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import { taskAPI } from '~/composables/useApi'

const props = defineProps({
  taskId: { type: Number, required: true },
  active: { type: Boolean, default: false },
})

const { t } = useI18n()

const works = ref([])
const calls = ref([])
const threads = reactive({})
// 列表页随调用带回的前几条消息：未展开的调用先存这里，展开时立刻可读
const seeds = reactive({})
const workFilter = ref(null)
const hasMore = ref(false)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
const live = computed(() => props.active)

/** 列表页每条调用附带的消息条数；超出的按 call 继续读全文 */
const PAGE_MESSAGE_LIMIT = 20

const KNOWN_ROLES = [
  'system', 'user', 'assistant', 'tool', 'tool_call', 'tool_result',
  'tool_definitions', 'request_params', 'request', 'result', 'error', 'raw_response',
]

function roleLabel(role) {
  return KNOWN_ROLES.includes(role) ? t(`taskCenter.detail.conversation.role.${role}`) : role
}

function msText(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return t('taskCenter.detail.conversation.unknown')
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

/** 进行中的工作项用心跳推算墙钟（崩溃后同样停在最后心跳），终态用落盘值 */
function workWallMs(work) {
  if (work.status === 'processing') return Math.max(work.work_ms, work.heartbeat_at - work.started_at)
  return work.work_ms
}

const visibleCalls = computed(() => (workFilter.value == null
  ? calls.value
  : calls.value.filter(call => call.work_id === workFilter.value)))

function toggleWorkFilter(id) {
  workFilter.value = workFilter.value === id ? null : id
}

function mergeCalls(rows) {
  const byId = new Map(calls.value.map(call => [call.id, call]))
  for (const row of rows) byId.set(row.id, row)
  calls.value = [...byId.values()].sort((a, b) => a.id - b.id)
}

/**
 * 实时游标：只按「比已见最大 id 更大」取追加会永远漏掉**原 id 上的更新**——
 * 在飞调用的 status/duration/message_count（收尾工具结果是加在已结束的那条上的）
 * 与流式消息的 body 都是原行更新。所以回退一个重叠窗口：
 * 有进行中的调用就从它之前开始，否则重取最后几条，按 id 合并覆盖。
 */
const LIVE_CALL_OVERLAP = 3

function tailCursor() {
  if (!calls.value.length) return 0
  const processing = calls.value.findIndex(call => call.status === 'processing')
  const base = processing === -1 ? Math.max(0, calls.value.length - LIVE_CALL_OVERLAP) : processing
  return base === 0 ? 0 : calls.value[base - 1].id
}

/** 一页里带回来的消息：已展开的直接合并（覆盖原 id 的流式更新），未展开的先存着，展开即可见 */
function absorbMessages(rows) {
  const grouped = new Map()
  for (const msg of rows) {
    const list = grouped.get(msg.call_id) || []
    list.push(msg)
    grouped.set(msg.call_id, list)
  }
  for (const [callId, list] of grouped) {
    const thread = threads[callId]
    if (thread) {
      const byId = new Map(thread.messages.map(msg => [msg.id, msg]))
      for (const msg of list) byId.set(msg.id, msg)
      thread.messages = [...byId.values()].sort((a, b) => a.id - b.id)
      const call = calls.value.find(row => row.id === callId)
      thread.total = Math.max(thread.total, call?.message_count ?? thread.messages.length)
      thread.hasMore = thread.messages.length < thread.total
    } else {
      seeds[callId] = list
    }
  }
}

async function loadCalls(cursor) {
  if (loading.value) return
  loading.value = true
  try {
    const res = await taskAPI.observations(props.taskId, {
      cursor: cursor ?? (calls.value.length ? calls.value[calls.value.length - 1].id : 0),
      message_limit: PAGE_MESSAGE_LIMIT,
    })
    const data = res?.data || res
    works.value = Array.isArray(data?.works) ? data.works : []
    mergeCalls(Array.isArray(data?.calls) ? data.calls : [])
    absorbMessages(Array.isArray(data?.messages) ? data.messages : [])
    hasMore.value = !!data?.has_more
    loadError.value = ''
  } catch (err) {
    loadError.value = err?.data?.error || err?.message || String(err)
  } finally {
    loading.value = false
    loaded.value = true
  }
}

async function loadMessages(callId, cursor) {
  const thread = threads[callId]
  if (!thread || thread.loading) return
  thread.loading = true
  try {
    const next = cursor ?? (thread.messages.length ? thread.messages[thread.messages.length - 1].id : 0)
    const res = await taskAPI.observationMessages(props.taskId, callId, { cursor: next })
    const data = res?.data || res
    const byId = new Map(thread.messages.map(msg => [msg.id, msg]))
    for (const msg of Array.isArray(data?.messages) ? data.messages : []) byId.set(msg.id, msg)
    thread.messages = [...byId.values()].sort((a, b) => a.id - b.id)
    thread.total = Number(data?.total || thread.messages.length)
    thread.hasMore = thread.messages.length < thread.total
  } catch { /* 下一轮重试 */ } finally {
    thread.loading = false
  }
}

function toggleCall(callId) {
  if (threads[callId]) {
    delete threads[callId]
    return
  }
  const seeded = seeds[callId] || []
  const call = calls.value.find(row => row.id === callId)
  const total = call?.message_count ?? seeded.length
  threads[callId] = { messages: seeded, total, hasMore: seeded.length < total, loading: false }
  // 列表页已带回前几条：缺的才补，省一次往返
  if (seeded.length < total) void loadMessages(callId, seeded.length ? seeded[seeded.length - 1].id : 0)
}

/**
 * 展开中的对话刷新：同样要覆盖原 id 的更新（流式正文边收边写、收尾工具结果后补），
 * 所以从第一条还在接收的消息之前开始取；都定稿了就回退一个重叠窗口。
 */
const LIVE_MESSAGE_OVERLAP = 3

function refreshOpenThreads() {
  for (const [key, thread] of Object.entries(threads)) {
    const callId = Number(key)
    const call = calls.value.find(row => row.id === callId)
    if (!call || thread.loading) continue
    const streaming = thread.messages.findIndex(msg => msg.streaming)
    const base = streaming === -1
      ? Math.max(0, thread.messages.length - LIVE_MESSAGE_OVERLAP)
      : streaming
    void loadMessages(callId, base === 0 ? 0 : thread.messages[base - 1].id)
  }
}

let timer = null

function startPolling() {
  stopPolling()
  if (!props.active) return
  timer = setInterval(() => {
    void loadCalls(tailCursor())
    refreshOpenThreads()
  }, 4000)
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null }
}

onMounted(() => {
  void loadCalls(0)
  startPolling()
})
onBeforeUnmount(stopPolling)

watch(() => props.active, (active) => {
  if (active) startPolling()
  else {
    stopPolling()
    // 任务刚转终态：补一次，拿到最后一条调用的收尾时间与正文
    void loadCalls(tailCursor())
    refreshOpenThreads()
  }
})

watch(() => props.taskId, () => {
  works.value = []
  calls.value = []
  for (const key of Object.keys(threads)) delete threads[key]
  for (const key of Object.keys(seeds)) delete seeds[key]
  workFilter.value = null
  loaded.value = false
  void loadCalls(0)
  startPolling()
})
</script>

<style scoped>
.task-conversation { display: flex; flex-direction: column; gap: 8px; }
.task-conv-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.task-conv-works { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.task-conv-work-btn {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%;
  background: var(--surface-2, rgba(127, 127, 127, 0.08)); border: 1px solid transparent;
  border-radius: 6px; padding: 6px 8px; text-align: left; cursor: pointer; color: inherit;
}
.task-conv-work.is-active .task-conv-work-btn { border-color: var(--primary, #4a7dff); }
.task-conv-work.is-failed .task-conv-work-btn,
.task-conv-work.is-interrupted .task-conv-work-btn { border-color: var(--danger, #d9534f); }
.task-conv-calls { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.task-conv-call { border: 1px solid var(--border, rgba(127, 127, 127, 0.3)); border-radius: 6px; overflow: hidden; }
.task-conv-call.is-failed, .task-conv-call.is-interrupted { border-color: var(--danger, #d9534f); }
.task-conv-call-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%;
  background: transparent; border: 0; padding: 6px 8px; cursor: pointer; text-align: left; color: inherit;
}
.task-conv-chip {
  font-size: 11px; padding: 1px 6px; border-radius: 999px;
  background: var(--surface-3, rgba(127, 127, 127, 0.16));
}
.task-conv-chip.is-role { font-weight: 600; }
.task-conv-messages { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px 10px; }
.task-conv-msg { border-left: 2px solid var(--border, rgba(127, 127, 127, 0.3)); padding-left: 8px; }
.task-conv-msg.is-response { border-left-color: var(--primary, #4a7dff); }
.task-conv-msg.is-final { border-left-color: var(--success, #3a9d5d); }
.task-conv-msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
.task-conv-body {
  margin: 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-size: 12px; line-height: 1.5; background: var(--surface-2, rgba(127, 127, 127, 0.08));
  border-radius: 4px; padding: 6px 8px;
}
.task-conv-error { color: var(--danger, #d9534f); font-size: 12px; margin: 2px 0 0; white-space: pre-wrap; }
.task-detail-chevron { transition: transform 0.15s ease; margin-left: auto; }
.task-detail-chevron.is-open { transform: rotate(180deg); }
</style>
