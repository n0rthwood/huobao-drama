<template>
  <div class="ms-page">
    <header class="ms-head">
      <div>
        <h1 class="ms-title">{{ t('mapStudio.app.title') }}</h1>
        <p class="ms-desc">{{ t('mapStudio.app.desc') }}</p>
      </div>
      <div class="ms-head-actions">
        <button type="button" class="btn btn-sm btn-primary" @click="creating = true">
          <Plus :size="13" />
          {{ t('mapStudio.app.newTask') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="loading" @click="load">
          <Loader2 v-if="loading" :size="11" class="animate-spin" />
          {{ t('mapStudio.panel.refresh') }}
        </button>
      </div>
    </header>

    <section v-if="creating" class="card ms-create">
      <NewTaskForm @cancel="creating = false" @created="onCreated" />
    </section>

    <section class="card ms-list-card">
      <div class="ms-toolbar">
        <label class="ms-search">
          <Search :size="13" />
          <input v-model.trim="search" class="input" :placeholder="t('mapStudio.app.searchPlaceholder')" />
        </label>
        <div class="ms-filters">
          <button
            v-for="option in HOST_FILTERS"
            :key="option.value || 'all'"
            type="button"
            class="ms-filter"
            :class="{ 'is-on': hostFilter === option.value }"
            :aria-pressed="hostFilter === option.value"
            @click="hostFilter = option.value"
          >
            {{ t('mapStudio.app.host.' + (option.value || 'all')) }}
          </button>
        </div>
        <span class="dim">{{ t('mapStudio.app.taskCount', { n: tasks.length }) }}</span>
      </div>

      <p v-if="error" class="ms-error">{{ error }}</p>
      <p v-if="!loading && !tasks.length && !error" class="ms-empty">{{ t('mapStudio.app.empty') }}</p>

      <ul v-else class="ms-tasks">
        <li v-for="task in tasks" :key="task.id" class="ms-task">
          <button type="button" class="ms-thumb" :disabled="!task.final_image" @click="open(task.id)">
            <img v-if="task.final_image" :src="mediaUrl(task.final_image.path)" :alt="task.title" loading="lazy" />
            <span v-else class="ms-thumb-empty">{{ t('mapStudio.app.noImage') }}</span>
          </button>
          <div class="ms-task-body">
            <strong class="ms-task-title">{{ task.title }}</strong>
            <div class="ms-task-meta">
              <span class="ms-chip">{{ task.host ? t('mapStudio.host.huobao') : t('mapStudio.host.standalone') }}</span>
              <span class="ms-chip" :class="`is-${task.status}`">{{ t('mapStudio.status.' + task.status) }}</span>
              <span>{{ t('mapStudio.stage.' + task.stage) }}</span>
              <span class="dim">{{ fmtAt(task.updated_at) }}</span>
            </div>
          </div>
          <button type="button" class="btn btn-sm" @click="open(task.id)">{{ t('mapStudio.app.open') }}</button>
        </li>
      </ul>
    </section>

    <section class="card ms-settings">
      <ModuleSettings />
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 地图工作室首页（Issue #99）：任务列表 + 新建独立任务 + 模块设置。
 *
 * 这里不挂任何火宝业务组件：列表、设置都走模块自己的 `/api/v1/map-studio`。
 * 搜索词与宿主筛选是嵌套 UI 的状态，按 #86 全部进 URL（msq / mshost），刷新与新标签直达同一列表位置。
 */
import { Loader2, Plus, Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import NewTaskForm from '~/map-studio/components/NewTaskForm.vue'
import ModuleSettings from '~/map-studio/components/ModuleSettings.vue'
import { mapStudioAPI, type MapStudioTaskListItem } from '~/map-studio/api'
import { DEEPLINK_KEYS, deeplinkHydrate, useDeeplink } from '~/composables/useQuerySync'
import { mediaUrl } from '~/utils/url'

const { t } = useI18n()
const router = useRouter()

const HOST_FILTERS: Array<{ value: '' | 'huobao' | 'standalone' }> = [
  { value: '' },
  { value: 'huobao' },
  { value: 'standalone' },
]

const tasks = ref<MapStudioTaskListItem[]>([])
const loading = ref(false)
const error = ref('')
const creating = ref(false)
const search = ref('')
const hostFilter = ref<'' | 'huobao' | 'standalone'>('')
let stopped = false
let requestId = 0

/** 列表筛选是导航位置（msq / mshost）；恢复只改界面，不发请求之外的副作用 */
const listLink = useDeeplink('mapStudioList', DEEPLINK_KEYS.mapStudioList)

function restoreFilters() {
  creating.value = listLink.initial('mscreate') === '1'
  const query = listLink.initial('msq')
  if (query) search.value = query
  const host = listLink.initial('mshost')
  if (host === 'huobao' || host === 'standalone') hostFilter.value = host
}

watch([search, hostFilter, creating], () => {
  listLink.set({ msq: search.value, mshost: hostFilter.value, mscreate: creating.value ? '1' : '' })
  void load()
})

async function load() {
  const currentRequest = ++requestId
  loading.value = true
  error.value = ''
  try {
    const res = await mapStudioAPI.listTasks({ host: hostFilter.value === 'standalone' ? '' : hostFilter.value || undefined, q: search.value || undefined })
    if (stopped || requestId !== currentRequest) return
    tasks.value = Array.isArray(res.tasks) ? res.tasks : []
  } catch (err) {
    if (!stopped && requestId === currentRequest) error.value = err instanceof Error && err.message ? err.message : t('mapStudio.app.loadFailed')
  } finally {
    if (!stopped && requestId === currentRequest) loading.value = false
  }
}

function open(taskId: number) {
  void router.push(`/map-studio/${taskId}`)
}

function onCreated(taskId: number) {
  creating.value = false
  open(taskId)
}

function fmtAt(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return iso || ''
  return new Date(parsed).toLocaleString()
}

onMounted(async () => {
  restoreFilters()
  await load()
  await nextTick()
  deeplinkHydrate()
})

onBeforeUnmount(() => { stopped = true })
</script>

<style scoped>
.ms-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 24px 24px;
  overflow: auto;
}
.ms-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.ms-title { font-size: 19px; font-weight: 700; color: var(--text-0); margin: 0; }
.ms-desc { font-size: 12.5px; color: var(--text-3); margin: 4px 0 0; }
.ms-head-actions { display: flex; align-items: center; gap: 8px; }
.ms-create,
.ms-list-card,
.ms-settings { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.ms-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.ms-search { display: inline-flex; align-items: center; gap: 6px; color: var(--text-3); }
.ms-filters { display: flex; gap: 4px; }
.ms-filter {
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.ms-filter.is-on { color: var(--accent-text); border-color: var(--accent-text); }
.ms-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.ms-empty { margin: 0; font-size: 10.5px; color: var(--text-2); }
.ms-tasks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 380px)); justify-content: start; gap: 10px; }
.ms-task {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}
.ms-thumb {
  flex: none;
  width: 100%;
  height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-3);
  font-size: 10px;
  cursor: zoom-in;
}
.ms-thumb:disabled { cursor: default; }
.ms-thumb img { width: 100%; height: 100%; object-fit: contain; border-radius: 6px; }
.ms-thumb-empty { font-size: 10px; }
.ms-task-body { display: flex; flex-direction: column; gap: 3px; flex: 1 1 auto; min-width: 0; }
.ms-task-title { font: 600 12px var(--font-body); color: var(--text-1); }
.ms-task-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 10.5px; color: var(--text-2); }
.ms-chip {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 10px var(--font-body);
}
.ms-chip.is-running { color: var(--accent-text); border-color: var(--accent-text); }
.ms-chip.is-completed { color: var(--accent-text); border-color: var(--accent-text); }
.ms-chip.is-failed,
.ms-chip.is-blocked { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
</style>
