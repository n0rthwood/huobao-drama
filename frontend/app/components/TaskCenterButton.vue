<template>
  <button :class="['task-center-trigger', 'is-' + variant]" @click="open">
    <ListTodo :size="variant === 'topbar' ? 12 : 15" :stroke-width="1.8" />
    <span class="task-center-trigger-text">{{ t('taskCenter.button') }}</span>
    <span v-if="activeCount" class="task-center-badge">{{ activeCount }}</span>
  </button>

  <Teleport to="body">
    <div v-if="centerOpen" class="task-center-overlay" @click.self="closeTaskCenter">
      <aside class="task-center-drawer" role="dialog" aria-modal="true" :aria-label="t('taskCenter.title')">
        <header class="task-center-head">
          <div>
            <div class="task-center-title">{{ t('taskCenter.title') }}</div>
            <div class="task-center-meta">{{ t('taskCenter.activeMeta', { n: activeCount }) }}</div>
          </div>
          <div class="task-center-head-actions">
            <NuxtLink to="/tasks" class="btn btn-sm" @click="closeTaskCenter">{{ t('taskCenter.openPage') }}</NuxtLink>
            <button class="btn btn-ghost btn-icon" :aria-label="t('common.close')" @click="closeTaskCenter"><X :size="14" /></button>
          </div>
        </header>
        <TaskCenterPanel :episode-id="episodeId" :drama-id="dramaId" variant="drawer" />
      </aside>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 任务中心入口：顶栏按钮 + 进行中角标 + 抽屉。
 * 抽屉开关是全局状态，页面里只渲染一个按钮实例即可覆盖该页面。
 */
import { onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { ListTodo, X } from 'lucide-vue-next'
import TaskCenterPanel from '~/components/TaskCenterPanel.vue'
import { useTasks } from '~/composables/useTasks'

const props = defineProps({
  // 剧集工作台传入后，抽屉默认只筛选当前集
  episodeId: { type: Number, default: 0 },
  dramaId: { type: Number, default: 0 },
  variant: { type: String, default: 'header' }, // header | topbar
})

const { t } = useI18n()
const { activeCount, centerOpen, openTaskCenter, closeTaskCenter } = useTasks()

function open() {
  openTaskCenter({ episodeId: props.episodeId || null, dramaId: props.dramaId || null })
}

function onKeydown(e) {
  if (e.key === 'Escape' && centerOpen.value) closeTaskCenter()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  closeTaskCenter()
})
</script>

<style scoped>
.task-center-trigger {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); background: var(--surface-raised);
  color: var(--text-1); cursor: pointer;
  border-radius: var(--radius-pill);
  transition: all 0.18s var(--ease-out);
}
.task-center-trigger:hover { color: var(--text-0); background: var(--bg-hover); }
.task-center-trigger:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.task-center-trigger.is-header { height: 32px; padding: 0 12px; font-size: 13px; font-weight: 600; margin-right: 8px; }
.task-center-trigger.is-topbar { height: 26px; padding: 0 9px; font-size: 10.5px; font-weight: 600; }
.task-center-badge {
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--accent-strong, #f97316); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 16px; text-align: center;
}

.task-center-overlay {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(0, 0, 0, 0.28);
  display: flex; justify-content: flex-end;
}
.task-center-drawer {
  width: 560px; max-width: 100vw; height: 100%;
  display: flex; flex-direction: column;
  background: var(--surface-raised);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-xl);
  animation: taskCenterIn 0.22s var(--ease-out);
}
@keyframes taskCenterIn {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.task-center-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
.task-center-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.task-center-meta { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.task-center-head-actions { display: flex; align-items: center; gap: 6px; }
</style>
