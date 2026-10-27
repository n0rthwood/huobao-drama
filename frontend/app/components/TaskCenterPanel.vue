<template>
  <div :class="['task-center', 'is-' + variant]">
    <!-- 筛选 -->
    <div class="tc-filters">
      <div v-if="episodeId" class="tc-scope">
        <button :class="['tc-scope-btn', { active: onlyEpisode }]" @click="setOnlyEpisode(true)">{{ t('taskCenter.scope.episode') }}</button>
        <button :class="['tc-scope-btn', { active: !onlyEpisode }]" @click="setOnlyEpisode(false)">{{ t('taskCenter.scope.all') }}</button>
      </div>
      <div v-if="!onlyEpisode" class="tc-filter">
        <span class="tc-filter-label">{{ t('taskCenter.filter.drama') }}</span>
        <BaseSelect v-model="dramaFilter" :options="dramaOptions" :placeholder="t('taskCenter.filter.allDramas')" :searchable="false" />
      </div>
      <div v-if="!onlyEpisode && episodeOptions.length > 1" class="tc-filter">
        <span class="tc-filter-label">{{ t('taskCenter.filter.episode') }}</span>
        <BaseSelect v-model="episodeFilter" :options="episodeOptions" :placeholder="t('taskCenter.filter.allEpisodes')" :searchable="false" />
      </div>
      <div class="tc-filter">
        <span class="tc-filter-label">{{ t('taskCenter.filter.type') }}</span>
        <BaseSelect v-model="typeFilter" :options="typeOptions" :placeholder="t('taskCenter.filter.allTypes')" :searchable="false" />
      </div>
      <div class="tc-filter">
        <span class="tc-filter-label">{{ t('taskCenter.filter.status') }}</span>
        <BaseSelect v-model="statusFilter" :options="statusOptions" :placeholder="t('taskCenter.filter.allStatus')" :searchable="false" />
      </div>
      <div class="tc-filter">
        <span class="tc-filter-label">{{ t('taskCenter.filter.range') }}</span>
        <BaseSelect v-model="scopeFilter" :options="scopeOptions" :searchable="false" />
      </div>
      <button class="btn btn-sm tc-refresh" :disabled="loading" @click="reload">
        <RefreshCw :size="11" :class="{ 'animate-spin': loading }" />
        {{ t('common.refresh') }}
      </button>
    </div>

    <!-- 列表 -->
    <div v-if="!rows.length" class="tc-empty">
      <ListTodo :size="28" />
      <div class="tc-empty-title">{{ loading ? t('common.loading') : t('taskCenter.emptyTitle') }}</div>
      <div v-if="!loading" class="tc-empty-desc">{{ t('taskCenter.emptyDesc') }}</div>
    </div>
    <div v-else class="tc-list">
      <template v-for="row in rows" :key="rowKey(row)">
        <div :class="['tc-row', 'is-' + stateClass(row.status)]" @click="onRowClick(row)">
          <button
            v-if="isParentRow(row)"
            class="tc-expand"
            :aria-label="t('taskCenter.expand')"
            @click.stop="toggleExpand(row)"
          >
            <ChevronRight :size="13" :class="{ 'is-open': expanded.includes(rowKey(row)) }" />
          </button>
          <span v-else class="tc-expand-placeholder" />
          <div class="tc-row-main">
            <div class="tc-row-title">
              <strong class="truncate">{{ row.label || ('#' + row.id) }}</strong>
              <span class="tc-row-kind">{{ rowKindLabel(row) }}</span>
            </div>
            <div class="tc-row-meta">
              <span v-if="row.provider" class="truncate">{{ row.provider }}{{ row.model ? ' · ' + row.model : '' }}</span>
              <span v-if="isParentRow(row) && row.counts" class="tc-row-counts">{{ countsText(row) }}</span>
              <span class="tc-row-time">{{ shortTime(row.created_at) }}</span>
              <span v-if="row.error_msg" class="tc-row-error truncate">{{ mapError(row.error_msg) }}</span>
            </div>
          </div>
          <ProgressRing
            v-if="rowRing(row).status && rowRing(row).status !== 'completed'"
            v-bind="rowRing(row)"
            :size="30"
            compact
            class="tc-row-ring"
          />
          <span v-else :class="['tc-row-status', 'is-' + stateClass(row.status)]">{{ statusLabel(row.status) }}</span>
        </div>
        <div v-if="isParentRow(row) && expanded.includes(rowKey(row))" class="tc-children">
          <div
            v-for="child in row.children || []"
            :key="'child-' + child.id"
            :class="['tc-row', 'tc-child-row', 'is-' + stateClass(child.status)]"
            @click="openDetail(child)"
          >
            <div class="tc-row-main">
              <div class="tc-row-title">
                <strong class="truncate">{{ child.label || ('#' + child.id) }}</strong>
              </div>
              <div class="tc-row-meta">
                <span v-if="child.error_msg" class="tc-row-error truncate">{{ mapError(child.error_msg) }}</span>
                <span v-else class="tc-row-time">{{ shortTime(child.created_at) }}</span>
              </div>
            </div>
            <ProgressRing
              v-if="rowRing(child).status && rowRing(child).status !== 'completed'"
              v-bind="rowRing(child)"
              :size="26"
              compact
            />
            <span v-else :class="['tc-row-status', 'is-' + stateClass(child.status)]">{{ statusLabel(child.status) }}</span>
          </div>
          <div v-if="!(row.children || []).length" class="tc-child-empty">{{ t('taskCenter.noChildren') }}</div>
        </div>
      </template>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="tc-pager">
      <button class="btn btn-sm" :disabled="page <= 1 || loading" @click="go(page - 1)">{{ t('taskCenter.prev') }}</button>
      <span class="tc-pager-info">{{ t('taskCenter.pageInfo', { page, pages: totalPages, total }) }}</span>
      <button class="btn btn-sm" :disabled="page >= totalPages || loading" @click="go(page + 1)">{{ t('taskCenter.next') }}</button>
    </div>

    <TaskDetailDialog v-if="detailTask" :task="detailTask" @close="detailTask = null" @changed="reload" />
  </div>
</template>

<script setup>
/**
 * 任务中心列表（抽屉与 /tasks 页共用）：筛选（剧/集/类型/状态/范围）、分页、
 * 批次父任务可展开、点击行看详情。行的进度随全局 store 原地刷新，
 * 批次父行的整体进度靠「有活跃任务时定时重新拉列表」更新。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, ListTodo, RefreshCw } from 'lucide-vue-next'
import ProgressRing from '~/components/ProgressRing.vue'
import TaskDetailDialog from '~/components/TaskDetailDialog.vue'
import BaseSelect from '~/components/BaseSelect.vue'
import { taskAPI, dramaAPI } from '~/composables/useApi'
import { mapError } from '~/composables/useToast'
import { useTasks, absorbRows, isParentRow } from '~/composables/useTasks'
import {
  useNowTicker, ringPropsFromTask, ringPropsFromBatchItem,
} from '~/composables/useTaskProgress'

const props = defineProps({
  // 剧集工作台打开时默认只看当前集，可切换为全部
  episodeId: { type: Number, default: 0 },
  dramaId: { type: Number, default: 0 },
  variant: { type: String, default: 'drawer' }, // drawer | page
})

const { t } = useI18n()
const now = useNowTicker()
const { tasksById, activeCount, onTaskFinished } = useTasks()

const PAGE_SIZE = 20
const onlyEpisode = ref(Boolean(props.episodeId))
const dramaFilter = ref('')
const episodeFilter = ref('')
const typeFilter = ref('')
const statusFilter = ref('')
const scopeFilter = ref('recent')
const page = ref(1)
const total = ref(0)
const items = ref([])
const loading = ref(false)
const expanded = ref([])
const detailTask = ref(null)
const dramas = ref([])

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

const dramaOptions = computed(() => [
  { label: t('taskCenter.filter.allDramas'), value: '' },
  ...dramas.value.map(d => ({ label: d.title || `#${d.id}`, value: String(d.id) })),
])
const episodeOptions = computed(() => {
  const drama = dramas.value.find(d => String(d.id) === dramaFilter.value)
  const eps = drama?.episodes || []
  return [
    { label: t('taskCenter.filter.allEpisodes'), value: '' },
    ...eps.map(ep => ({
      label: t('taskCenter.filter.episodeN', { n: ep.episode_number ?? ep.episodeNumber ?? ep.id }),
      value: String(ep.id),
    })),
  ]
})
const typeOptions = computed(() => [
  { label: t('taskCenter.filter.allTypes'), value: '' },
  { label: t('common.serviceType.image'), value: 'image' },
  { label: t('common.serviceType.video'), value: 'video' },
  { label: t('common.serviceType.text'), value: 'text' },
])
const statusOptions = computed(() => [
  { label: t('taskCenter.filter.allStatus'), value: '' },
  { label: t('taskCenter.status.active'), value: 'active' },
  { label: t('taskCenter.status.completed'), value: 'completed' },
  { label: t('taskCenter.status.failed'), value: 'failed' },
  { label: t('taskCenter.status.cancelled'), value: 'cancelled' },
])
const scopeOptions = computed(() => [
  { label: t('taskCenter.range.recent'), value: 'recent' },
  { label: t('taskCenter.range.all'), value: 'all' },
])

/** 列表行：任务行用 store 的最新快照覆盖，进度环不用等下一次列表请求 */
const rows = computed(() => items.value.map((row) => {
  if (isParentRow(row)) {
    return { ...row, children: (row.children || []).map(child => ({ ...child, ...(tasksById.value[child.id] || {}) })) }
  }
  return { ...row, ...(tasksById.value[row.id] || {}) }
}))

function rowKey(row) { return `${row.row_type || 'task'}-${row.id}` }

function rowKindLabel(row) {
  if (row.row_type === 'keyframe_batch') return t('taskCenter.kind.keyframeBatch')
  if (row.row_type === 'video_batch') return t('taskCenter.kind.videoBatch')
  if (row.row_type === 'video_merge') return t('taskCenter.kind.videoMerge')
  if (row.type === 'text') {
    const kind = String(row.kind || row.params?.kind || '')
    return kind ? t(`taskCenter.textKind.${kind}`) : t('common.serviceType.text')
  }
  if (row.type === 'video') return t('common.serviceType.video')
  return t('common.serviceType.image')
}

function statusLabel(status) {
  const key = `taskCenter.status.${status || 'processing'}`
  const label = t(key)
  return label === key ? String(status || '') : label
}

function stateClass(status) {
  if (status === 'completed' || status === 'done') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'pending'
}

function countsText(row) {
  const c = row.counts || {}
  return t('taskCenter.counts', {
    done: Number(c.completed || 0),
    failed: Number(c.failed || 0),
    total: Number(c.total || (row.children || []).length),
  })
}

/** 任务行用 sys_task 的进度；批次父行用后端算好的整体进度 */
function rowRing(row) {
  if (isParentRow(row)) {
    const active = row.status === 'running' || row.status === 'processing' || row.status === 'pending' || row.status === 'queued'
    return ringPropsFromBatchItem({
      state: active ? 'running' : row.status,
      progress: Number(row.progress) || null,
      error: row.error_msg || '',
    })
  }
  return ringPropsFromTask(row, now.value)
}

function shortTime(value) {
  const ms = Date.parse(String(value || ''))
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString()
}

function toggleExpand(row) {
  const key = rowKey(row)
  expanded.value = expanded.value.includes(key)
    ? expanded.value.filter(k => k !== key)
    : [...expanded.value, key]
}
function onRowClick(row) {
  if (isParentRow(row)) { toggleExpand(row); return }
  openDetail(row)
}
function openDetail(row) {
  detailTask.value = row
}

function queryParams() {
  const params = { scope: scopeFilter.value, page: page.value, page_size: PAGE_SIZE }
  if (onlyEpisode.value && props.episodeId) {
    params.episode_id = props.episodeId
  } else {
    if (dramaFilter.value) params.drama_id = Number(dramaFilter.value)
    if (episodeFilter.value) params.episode_id = Number(episodeFilter.value)
  }
  if (typeFilter.value) params.type = typeFilter.value
  if (statusFilter.value) params.status = statusFilter.value
  return params
}

async function reload() {
  loading.value = true
  try {
    const data = await taskAPI.center(queryParams())
    items.value = Array.isArray(data?.items) ? data.items : []
    total.value = Number(data?.total || 0)
    absorbRows(items.value)
  } catch { /* 静默：列表失败不打断页面 */ }
  finally { loading.value = false }
}

function go(next) {
  page.value = Math.min(Math.max(1, next), totalPages.value)
}

function setOnlyEpisode(value) {
  onlyEpisode.value = value
  page.value = 1
}

watch([onlyEpisode, dramaFilter, episodeFilter, typeFilter, statusFilter, scopeFilter], () => {
  page.value = 1
  void reload()
})
watch(page, () => { void reload() })
watch(dramaFilter, () => { episodeFilter.value = '' })
// 任务结束时列表需要换状态/补结果
onTaskFinished(() => { void reload() })

// 有活跃任务时定时刷新：批次父行的整体进度与新任务的出现都靠它
let timer = null
watch(activeCount, (n) => {
  clearInterval(timer)
  timer = n > 0 ? setInterval(reload, 6000) : null
}, { immediate: true })
onBeforeUnmount(() => { clearInterval(timer) })

onMounted(async () => {
  if (props.dramaId) dramaFilter.value = String(props.dramaId)
  void reload()
  try {
    const data = await dramaAPI.list()
    dramas.value = Array.isArray(data?.items) ? data.items : []
  } catch { /* 剧列表失败：筛选退化为全部 */ }
})

defineExpose({ reload })
</script>

<style scoped>
.task-center { display: flex; flex-direction: column; min-height: 0; flex: 1; }

/* 筛选条 */
.tc-filters {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
}
.tc-scope { display: flex; gap: 2px; padding: 2px; border-radius: var(--radius-pill); background: var(--overlay-track); }
.tc-scope-btn {
  border: none; background: transparent; cursor: pointer;
  font-size: 11.5px; font-weight: 600; color: var(--text-2);
  padding: 4px 11px; border-radius: var(--radius-pill);
}
.tc-scope-btn.active { background: var(--seg-active-bg); color: var(--text-0); }
.tc-filter { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tc-filter-label { font-size: 11px; color: var(--text-3); white-space: nowrap; }
.tc-filter :deep(.base-select) { min-width: 118px; }
.tc-refresh { margin-left: auto; }

/* 列表 */
.tc-list { flex: 1; overflow-y: auto; padding: 6px 10px 10px; }
.tc-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  cursor: pointer; margin-top: 6px;
  transition: background 0.16s var(--ease-out);
}
.tc-row:hover { background: var(--bg-hover); }
.tc-row.is-failed { border-color: var(--warn-border); }
.tc-expand {
  border: none; background: transparent; cursor: pointer;
  color: var(--text-3); display: flex; align-items: center; padding: 0;
}
.tc-expand :deep(svg) { transition: transform 0.16s var(--ease-out); }
.tc-expand :deep(svg.is-open) { transform: rotate(90deg); }
.tc-expand-placeholder { width: 13px; flex-shrink: 0; }
.tc-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tc-row-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.tc-row-title strong { font-size: 12.5px; font-weight: 600; color: var(--text-0); }
.tc-row-kind {
  font-size: 10px; color: var(--text-3);
  padding: 1px 6px; border-radius: var(--radius-pill); background: var(--overlay-track);
  flex-shrink: 0;
}
.tc-row-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-3); min-width: 0; }
.tc-row-error { color: var(--danger-text, #d9534f); }
.tc-row-time { flex-shrink: 0; }
.tc-row-counts { flex-shrink: 0; }
.tc-row-status { font-size: 11px; font-weight: 600; color: var(--text-2); flex-shrink: 0; }
.tc-row-status.is-failed { color: var(--danger-text, #d9534f); }
.tc-row-ring { flex-shrink: 0; }
.tc-children { padding-left: 24px; }
.tc-child-row { background: transparent; }
.tc-child-empty { font-size: 11px; color: var(--text-3); padding: 8px 10px; }

/* 空态 */
.tc-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 7px; color: var(--text-3); padding: 40px 20px; text-align: center;
}
.tc-empty-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.tc-empty-desc { font-size: 11.5px; max-width: 320px; line-height: 1.6; }

/* 分页 */
.tc-pager {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 10px 16px; border-top: 1px solid var(--border);
}
.tc-pager-info { font-size: 11.5px; color: var(--text-3); }
</style>
