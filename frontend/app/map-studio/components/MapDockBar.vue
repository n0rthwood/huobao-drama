<template>
  <section class="dock" role="group" aria-label="next action">
    <div class="dock-reason">
      <span class="dock-label">{{ t('mapStudio.dock.reason') }}</span>
      <span class="dock-text" :class="{ 'is-warn': isFailure }">{{ reasonText }}</span>
    </div>
    <div class="dock-actions">
      <button
        v-if="action.code !== 'none'"
        type="button"
        class="btn btn-sm btn-primary dock-primary"
        :disabled="action.disabled || busy"
        @click="emit('command', action)"
      >
        <Loader2 v-if="busy" :size="11" class="animate-spin" />
        {{ t('mapStudio.action.' + action.label) }}
      </button>
      <span v-else class="dock-idle">{{ t('mapStudio.dock.observing') }}</span>
      <details class="dock-more">
        <summary class="btn btn-sm">{{ t('mapStudio.panel.more') }}</summary>
        <div class="dock-menu">
          <button
            v-for="item in secondary"
            :key="item"
            type="button"
            class="dock-menu-item"
            :disabled="busy && item !== 'activity'"
            @click="emit('more', item)"
          >
            {{ t('mapStudio.more.' + item) }}
          </button>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 动作条（Issue #126 设计 01 §9 / 02 §2）：一个小节只放一个主色按钮 + 停靠原因 + 「更多」。
 *
 * 分派结果由 utils/mapDock.ts 的纯函数产出，组件不自己判断阶段；「更多」只放取消 / 刷新 /
 * AI 活动 / 回退这类非主路径动作，auto 只在 AI 活动抽屉里作为明确的高级命令存在。
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapDockAction } from '~/map-studio/utils/mapDock'

const { t } = useI18n()

const props = defineProps<{
  action: MapDockAction
  busy?: boolean
  secondary: Array<'cancel' | 'refresh' | 'activity' | 'rollback'>
}>()

const emit = defineEmits<{
  (e: 'command', action: MapDockAction): void
  (e: 'more', item: 'cancel' | 'refresh' | 'activity' | 'rollback'): void
}>()

const isFailure = computed(() => props.action.reason.startsWith('failure') || props.action.reason === 'unknownFailure' || props.action.reason === 'failureUnclassified')

const reasonText = computed(() => {
  const reason = props.action.reason
  if (reason.startsWith('failure:')) {
    const kind = reason.slice('failure:'.length)
    return t('mapStudio.failure.' + kind)
  }
  if (reason === 'unknownFailure') return t('mapStudio.workflow.unknownFailure', { kind: props.action.detail ?? '' })
  return t('mapStudio.dock.' + reason)
})
</script>

<style scoped>
.dock {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}
.dock-reason { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 320px; font-size: 11px; color: var(--text-2); }
.dock-label { font: 600 11px var(--font-body); color: var(--text-1); }
.dock-text { word-break: break-word; }
.dock-text.is-warn { color: var(--warn-text); font-weight: 600; }
.dock-actions { display: flex; align-items: center; gap: 8px; }
.dock-primary { min-width: 140px; }
.dock-idle { font-size: 10.5px; color: var(--text-2); }
.dock-more { position: relative; }
.dock-more summary { list-style: none; cursor: pointer; }
.dock-more summary::-webkit-details-marker { display: none; }
.dock-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 30;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-1);
  box-shadow: 0 6px 18px rgba(0, 0, 0, .18);
}
.dock-menu-item {
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font: 600 10.5px var(--font-body);
  color: var(--text-2);
  cursor: pointer;
}
.dock-menu-item:hover:not(:disabled) { color: var(--accent-text); background: var(--surface-soft); }
.dock-menu-item:disabled { opacity: .5; cursor: not-allowed; }
</style>
