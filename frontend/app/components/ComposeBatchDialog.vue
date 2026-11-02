<template>
  <Teleport to="body">
    <div v-if="open" class="overlay compose-overlay" @click.self="close">
      <div
        ref="dialogEl"
        class="dialog compose-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
        @keydown.esc.stop.prevent="close"
        @keydown.tab="onTab"
      >
        <header class="dialog-head">
          <h2 class="dialog-title">{{ title }}</h2>
          <button ref="firstFocusEl" class="btn btn-ghost btn-icon" :aria-label="t('common.cancel')" @click="close">
            <X :size="14" />
          </button>
        </header>

        <div class="dialog-body compose-body">
          <div class="compose-scope">
            <span class="compose-scope-text">{{ scopeText }}</span>
            <button
              v-if="scopeIds && scopeIds.length"
              type="button"
              class="btn btn-sm"
              :disabled="running"
              @click="widenScope"
            >
              {{ t('episode.composeBatch.scopeWhole') }}
            </button>
            <span class="ml-auto" />
            <button type="button" class="btn btn-sm" :disabled="loading || running" @click="loadPreview">
              <Loader2 v-if="loading" :size="11" class="animate-spin" />
              {{ t('episode.composeBatch.refreshPreview') }}
            </button>
          </div>

          <!-- 进行中 / 刚结束：展示持久化任务态，不重复提交 -->
          <section v-if="status" class="compose-progress">
            <div class="compose-progress-head">
              <strong>{{ progressTitle }}</strong>
              <span class="dim">{{ t('episode.composeBatch.progressCount', { done: processedCount, total: status.total || 0 }) }}</span>
              <span v-if="status.failed" class="compose-progress-bad">{{ t('episode.composeBatch.progressFailed', { n: status.failed }) }}</span>
              <span v-if="status.skipped" class="compose-progress-warn">{{ t('episode.composeBatch.progressSkipped', { n: status.skipped }) }}</span>
              <span v-if="currentNumber" class="dim">{{ t('episode.composeBatch.progressCurrent', { n: currentNumber }) }}</span>
            </div>
            <div class="compose-progress-bar"><i :style="{ width: progressPercent + '%' }" /></div>
            <div v-if="status.error" class="compose-error">{{ mapError(status.error, { fallback: 'episode.composeBatch.taskFailed' }) }}</div>
            <div v-if="progressIssues.length" class="compose-progress-items">
              <div v-for="item in progressIssues" :key="item.storyboard_id" class="compose-progress-item">
                <span class="compose-no">{{ shotNo(item.storyboard_number) }}</span>
                <span :class="['compose-chip', 'is-' + item.state]">{{ itemStateLabel(item.state) }}</span>
                <span class="compose-reason">{{ item.reason || t('episode.composeBatch.noReason') }}</span>
              </div>
            </div>
            <div class="compose-progress-actions">
              <button
                type="button"
                class="btn btn-sm"
                :disabled="running || !failedIds.length"
                :title="running ? t('episode.composeBatch.runningHint') : undefined"
                @click="retryFailed"
              >
                {{ t('episode.composeBatch.retryFailed', { n: failedIds.length }) }}
              </button>
            </div>
          </section>

          <template v-if="!running">
            <div v-if="loading" class="compose-state"><Loader2 :size="14" class="animate-spin" /> {{ t('episode.composeBatch.loading') }}</div>
            <div v-else-if="loadError" class="compose-error">{{ loadError }}</div>
            <template v-else>
              <div class="compose-counts">
                <span class="compose-chip is-missing">{{ t('episode.compose.statusMissing') }} {{ counts.missing }}</span>
                <span class="compose-chip is-changed">{{ t('episode.compose.statusChanged') }} {{ counts.changed }}</span>
                <span class="compose-chip is-unknown">{{ t('episode.compose.statusUnknown') }} {{ counts.unknown }}</span>
                <span class="compose-chip is-unchanged">{{ t('episode.compose.statusUnchanged') }} {{ counts.unchanged }}</span>
                <span class="compose-chip is-blocked">{{ t('episode.compose.statusBlocked') }} {{ counts.blocked }}</span>
                <span v-if="counts.skipped" class="compose-chip is-skipped">{{ t('episode.compose.statusSkipped') }} {{ counts.skipped }}</span>
                <span v-if="counts.disabled" class="compose-chip is-disabled">{{ t('episode.compose.statusDisabled') }} {{ counts.disabled }}</span>
              </div>

              <div class="compose-select-bar">
                <button type="button" class="btn btn-sm" :disabled="!todoIds.length" @click="selectTodo">
                  {{ t('episode.composeBatch.selectTodo', { n: todoIds.length }) }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="!selectableIds.length" @click="selectAll">
                  {{ t('episode.composeBatch.selectAll', { n: selectableIds.length }) }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="!checkedIds.length" @click="clearSelection">
                  {{ t('episode.composeBatch.clearSelection') }}
                </button>
                <span class="ml-auto compose-selected">{{ t('episode.composeBatch.selectedCount', { n: checkedIds.length }) }}</span>
              </div>

              <div v-if="!items.length" class="compose-state">{{ t('episode.composeBatch.emptyScope') }}</div>
              <ul v-else class="compose-list">
                <li v-for="item in items" :key="item.storyboard_id" :class="['compose-row', { 'is-off': !item.selectable }]">
                  <label class="compose-row-check">
                    <input
                      type="checkbox"
                      :checked="isChecked(item.storyboard_id)"
                      :aria-label="`${shotNo(item.storyboard_number)} ${item.title}`"
                      :disabled="!item.selectable"
                      :title="item.selectable ? undefined : (item.reason || t('episode.compose.statusBlocked'))"
                      @change="toggle(item)"
                    />
                  </label>
                  <div class="compose-row-main">
                    <div class="compose-row-line">
                      <span class="compose-no">{{ shotNo(item.storyboard_number) }}</span>
                      <span :class="['compose-chip', 'is-' + item.status]">{{ statusLabel(item.status) }}</span>
                      <span v-if="item.status === 'unchanged' && isChecked(item.storyboard_id)" class="compose-chip is-force">
                        {{ t('episode.composeBatch.forceRemake') }}
                      </span>
                      <span class="compose-row-title truncate">{{ item.title }}</span>
                    </div>
                    <div v-if="missingInputs(item).length" class="compose-row-inputs">
                      <span v-for="key in missingInputs(item)" :key="key" class="compose-chip is-blocked">{{ t(`episode.compose.input.${key}Missing`) }}</span>
                    </div>
                    <div v-if="item.reason" class="compose-reason">{{ item.reason }}</div>
                    <div v-if="item.change_reasons?.length" class="compose-reason">{{ item.change_reasons.join(t('common.listJoin')) }}</div>
                    <div v-if="planLine(item)" class="compose-plan">{{ planLine(item) }}</div>
                  </div>
                </li>
              </ul>
              <p class="compose-rule">{{ t('episode.composeBatch.rule') }}</p>
            </template>
          </template>
        </div>

        <footer class="dialog-foot">
          <button class="btn" @click="close">{{ t('common.close') }}</button>
          <button
            class="btn btn-primary"
            :disabled="!canSubmit"
            :title="running ? t('episode.composeBatch.runningHint') : undefined"
            @click="submit"
          >
            <Loader2 v-if="submitting" :size="12" class="animate-spin" />
            {{ t('episode.composeBatch.start', { n: checkedIds.length }) }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 批量融合弹窗（#42）：视频制作页的「批量融合」与导出页的「去批量融合」共用同一个入口。
 * 规则：先预览后执行 —— 预览按当前范围逐镜分类（缺失 / 已变化 / 待核验 / 最新 / 阻断 / 进行中），
 * 默认只勾选缺失与已变化；最新项必须用户显式勾选才算强制重做；阻断项不可勾并显示原因。
 * 任务态由父组件轮询（持久化在 sys_task），刷新浏览器重新进入时直接显示进度而不是再提交一次。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X } from 'lucide-vue-next'
import { episodeAPI } from '~/composables/useApi'
import { mapError } from '~/composables/useToast'

const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, required: true },
  // 手动范围（只缩小）；undefined = 整集
  scopeIds: { type: Array, default: undefined },
  // 父组件轮询到的持久化任务态（null = 当前没有任务）
  status: { type: Object, default: null },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['cancel', 'submit', 'update:scopeIds'])
const { t } = useI18n()

const items = ref([])
const loading = ref(false)
const loadError = ref('')
const checked = ref([])
const dialogEl = ref(null)
const firstFocusEl = ref(null)
let lastFocused = null

const running = computed(() => props.status?.status === 'running')
const title = computed(() => t('episode.composeBatch.title'))
const scopeText = computed(() => (props.scopeIds?.length
  ? t('episode.composeBatch.scopeSelected', { n: props.scopeIds.length })
  : t('episode.composeBatch.scopeEpisode')))

function shotNo(n) { return `#${String(n ?? 0).padStart(2, '0')}` }
function statusLabel(status) { return t(`episode.compose.status${status.charAt(0).toUpperCase()}${status.slice(1)}`) }
function itemStateLabel(state) { return t(`episode.composeBatch.item${state.charAt(0).toUpperCase()}${state.slice(1)}`) }

function missingInputs(item) {
  const inputs = item?.inputs || {}
  const out = []
  if (!inputs.video) out.push('video')
  if (!inputs.pure_visual) {
    if (!inputs.audio) out.push('audio')
    if (!inputs.subtitle) out.push('subtitle')
  }
  return out
}

function planLine(item) {
  const plan = item?.plan
  if (!plan || typeof plan.d !== 'number') return ''
  return t('episode.compose.planLine', {
    dv: Number(plan.dv || 0).toFixed(1),
    da: Number(plan.da || 0).toFixed(1),
    d: Number(plan.d || 0).toFixed(1),
    tr: Number(plan.t || 0).toFixed(1),
  })
}

const counts = computed(() => {
  const out = { missing: 0, changed: 0, unchanged: 0, unknown: 0, blocked: 0, skipped: 0, disabled: 0 }
  for (const item of items.value) if (item.status in out) out[item.status] += 1
  return out
})
const selectableIds = computed(() => items.value.filter(i => i.selectable).map(i => i.storyboard_id))
const todoIds = computed(() => items.value
  .filter(i => i.selectable && ['missing', 'changed', 'unknown'].includes(i.status))
  .map(i => i.storyboard_id))
const checkedIds = computed(() => checked.value.filter(id => selectableIds.value.includes(id)))

function isChecked(id) { return checked.value.includes(id) }
function toggle(item) {
  if (!item.selectable) return
  checked.value = isChecked(item.storyboard_id)
    ? checked.value.filter(id => id !== item.storyboard_id)
    : [...checked.value, item.storyboard_id]
}
function selectTodo() { checked.value = [...todoIds.value] }
function selectAll() { checked.value = [...selectableIds.value] }
function clearSelection() { checked.value = [] }

// 进度：只列出失败 / 跳过 / 进行中，成功项不刷屏
const progressIssues = computed(() => (props.status?.items || [])
  .filter(item => item.state === 'failed' || item.state === 'skipped' || item.state === 'processing'))
const failedIds = computed(() => (props.status?.items || [])
  .filter(item => item.state === 'failed')
  .map(item => item.storyboard_id))
const currentNumber = computed(() => {
  const id = props.status?.current_storyboard_id
  if (!id) return 0
  return (props.status?.items || []).find(item => item.storyboard_id === id)?.storyboard_number || 0
})
const processedCount = computed(() => Number(props.status?.completed || 0)
  + Number(props.status?.failed || 0) + Number(props.status?.skipped || 0))
const progressPercent = computed(() => {
  const total = Number(props.status?.total || 0)
  if (!total) return 0
  return Math.min(100, Math.round((processedCount.value / total) * 100))
})
const progressTitle = computed(() => {
  if (running.value) return t('episode.composeBatch.taskRunning')
  if (props.status?.status === 'error') return t('episode.composeBatch.taskFailed')
  return t('episode.composeBatch.taskDone')
})

const canSubmit = computed(() => !running.value && !props.submitting && !loading.value && checkedIds.value.length > 0)

// 预览请求竞态：只认最后一次（切换范围 / 反复刷新时不被旧响应覆盖）
let seq = 0
async function loadPreview() {
  if (!props.episodeId) return
  const my = ++seq
  loading.value = true
  loadError.value = ''
  try {
    const res = await episodeAPI.composePreview(props.episodeId, props.scopeIds)
    if (my !== seq) return
    items.value = res?.items || []
    checked.value = items.value.filter(i => i.selectable && i.checked).map(i => i.storyboard_id)
  } catch (e) {
    if (my === seq) { loadError.value = mapError(e); items.value = []; checked.value = [] }
  } finally {
    if (my === seq) loading.value = false
  }
}

function widenScope() {
  emit('update:scopeIds', undefined)
}

function retryFailed() {
  if (running.value || !failedIds.value.length) return
  emit('update:scopeIds', [...failedIds.value])
}

function submit() {
  if (!canSubmit.value) return
  emit('submit', [...checkedIds.value])
}

function close() {
  if (props.submitting) return
  emit('cancel')
}

// 焦点：打开时聚焦弹窗本体，关闭后还给触发按钮；Tab 不跑出弹窗
function focusables() {
  if (!dialogEl.value) return []
  return [...dialogEl.value.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null)
}
function onTab(e) {
  const list = focusables()
  if (!list.length) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === dialogEl.value)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    lastFocused = document.activeElement
    checked.value = []
    items.value = []
    loadError.value = ''
    await loadPreview()
    await nextTick()
    dialogEl.value?.focus()
  } else if (lastFocused?.isConnected) {
    lastFocused.focus()
    lastFocused = null
  }
})

// 范围变化（缩到失败项 / 放回整集）时重新分类，勾选跟着重算
watch(() => props.scopeIds, () => { if (props.open) void loadPreview() })
// 任务结束后回到预览态：按最新依赖和签名重新分类，不默认重做已最新项
watch(running, (now, before) => { if (props.open && before && !now) void loadPreview() })
</script>

<style scoped>
.compose-overlay { z-index: 119; }
.compose-dialog { width: 680px; max-width: 94vw; }
.compose-body { display: flex; flex-direction: column; gap: 10px; max-height: 70vh; overflow-y: auto; }
.compose-scope { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); }
.compose-scope-text { font-weight: 600; color: var(--text-1); }
.compose-state { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-2); }
.compose-error { font-size: 12px; color: var(--action-danger); white-space: pre-wrap; }
.compose-counts { display: flex; gap: 6px; flex-wrap: wrap; }
.compose-chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-2);
  color: var(--text-2);
  white-space: nowrap;
}
.compose-chip.is-missing,
.compose-chip.is-changed,
.compose-chip.is-pending { background: var(--action-primary-bg, var(--bg-2)); color: var(--action-primary); font-weight: 600; }
.compose-chip.is-unchanged,
.compose-chip.is-completed { color: var(--tag-success-text, var(--text-2)); }
.compose-chip.is-unknown,
.compose-chip.is-skipped,
.compose-chip.is-processing { color: var(--tag-warning-text); background: var(--surface-muted); }
.compose-chip.is-blocked,
.compose-chip.is-failed { color: var(--action-danger); background: var(--action-danger-bg); }
.compose-chip.is-force { color: var(--action-danger); background: var(--action-danger-bg); font-weight: 600; }
.compose-select-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.compose-selected { font-size: 12px; color: var(--text-1); font-weight: 600; }
.compose-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.compose-row {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
}
.compose-row.is-off { opacity: 0.72; }
.compose-row-check { display: flex; align-items: flex-start; padding-top: 2px; }
.compose-row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.compose-row-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.compose-row-title { font-size: 12px; color: var(--text-1); min-width: 0; }
.compose-row-inputs { display: flex; gap: 4px; flex-wrap: wrap; }
.compose-no { font-size: 11px; font-weight: 700; color: var(--text-0); font-variant-numeric: tabular-nums; }
.compose-reason { font-size: 11px; color: var(--text-3); word-break: break-word; }
.compose-plan { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.compose-rule { margin: 0; font-size: 11px; color: var(--text-3); }
.compose-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}
.compose-progress-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-1); }
.compose-progress-bad { color: var(--action-danger); }
.compose-progress-warn { color: var(--tag-warning-text); }
.compose-progress-bar { height: 4px; border-radius: 999px; background: var(--overlay-track); overflow: hidden; }
.compose-progress-bar i { display: block; height: 100%; background: var(--accent); transition: width 0.25s; }
.compose-progress-items { display: flex; flex-direction: column; gap: 3px; max-height: 160px; overflow-y: auto; }
.compose-progress-item { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.compose-progress-actions { display: flex; gap: 6px; }
</style>
