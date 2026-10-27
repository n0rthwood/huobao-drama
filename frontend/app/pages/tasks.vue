<template>
  <div class="tasks-page">
    <header class="tasks-head">
      <div>
        <h1 class="tasks-title">{{ t('taskCenter.title') }}</h1>
        <p class="tasks-desc">{{ t('taskCenter.pageDesc') }}</p>
      </div>
      <span v-if="activeCount" class="tasks-active">{{ t('taskCenter.activeMeta', { n: activeCount }) }}</span>
    </header>
    <section class="card tasks-card">
      <TaskCenterPanel variant="page" />
    </section>
  </div>
</template>

<script setup>
/** 独立任务中心页（default 布局）：与顶栏抽屉同一套列表/筛选/详情 */
import { useI18n } from 'vue-i18n'
import TaskCenterPanel from '~/components/TaskCenterPanel.vue'
import { useTasks } from '~/composables/useTasks'

const { t } = useI18n()
const { activeCount } = useTasks()
</script>

<style scoped>
.tasks-page {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 20px 24px 24px;
  gap: 14px;
  overflow: hidden;
}
.tasks-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.tasks-title { font-size: 19px; font-weight: 700; color: var(--text-0); margin: 0; }
.tasks-desc { font-size: 12.5px; color: var(--text-3); margin: 4px 0 0; }
.tasks-active { font-size: 12px; color: var(--text-2); }
.tasks-card {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 0; overflow: hidden;
}
</style>
