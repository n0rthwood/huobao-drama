<script setup>
/**
 * 步骤状态图标（Issue #105）：done ✓ / in_progress 脉冲点 / available ○ / locked 锁+原因 /
 * stale 琥珀 ! / skipped ⤼ / checking 校验中。符号与颜色共用 `utils/stepStatus.js` 的口径，
 * 各步骤面板只引用本组件，不再各写一套。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Lock } from 'lucide-vue-next'

import { STEP_STATUS_GLYPHS } from '~/utils/stepStatus'

const props = defineProps({
  status: { type: String, default: '' },
  /** 锁定原因：与状态一起出现在 tooltip 里 */
  reason: { type: String, default: '' },
  /**
   * 锁与状态是两个维度：步骤可能已有产物（进行中/需复核）但上游未就绪而锁着。
   * status 本身不是 locked 时，用它在状态符号旁再画一把锁。
   */
  locked: { type: Boolean, default: false },
})

const { t } = useI18n()
const state = computed(() => props.status || 'checking')
const label = computed(() => t(`episode.stepStatus.${state.value}`))
const showLock = computed(() => state.value === 'locked' || props.locked)
const title = computed(() => {
  const lockLabel = state.value === 'locked' ? label.value : `${label.value} · ${t('episode.stepStatus.locked')}`
  return showLock.value && props.reason ? `${lockLabel} · ${props.reason}` : showLock.value ? lockLabel : label.value
})
</script>

<template>
  <span :class="['step-status', 'is-' + state]" :title="title" :aria-label="title">
    <Loader2 v-if="state === 'checking'" :size="10" class="animate-spin" />
    <Lock v-else-if="state === 'locked'" :size="10" />
    <span v-else-if="state === 'in_progress'" class="step-status-pulse" />
    <span v-else class="step-status-glyph mono">{{ STEP_STATUS_GLYPHS[state] || '' }}</span>
    <!-- 「!」不足以表达需复核：琥珀色永远带文字，避免被读成失败/警告图标 -->
    <span v-if="state === 'stale'" class="step-status-text">{{ label }}</span>
    <Lock v-if="props.locked && state !== 'locked' && state !== 'checking'" :size="10" class="step-status-lock" />
  </span>
</template>

<style>
/* 共享状态色板（#105）：刻意不 scoped——侧栏、进度条、阶段条、设计/资产子页签都用同一套口径 */
.step-status {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; line-height: 1; color: var(--text-3); flex: none;
}
.step-status.is-done { color: var(--success); }
.step-status.is-skipped { color: var(--text-2); }
.step-status.is-stale { color: var(--warning); }
.step-status.is-in_progress { color: var(--accent); }
.step-status-glyph { font-size: 10px; }
.step-status-text { font-size: 10px; }
.step-status-lock { color: var(--text-3); }
.step-status-pulse {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor;
  animation: step-status-pulse 1.4s ease-in-out infinite;
}
@keyframes step-status-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
/* 标签文字色：完成 = 绿色，需复核 = 琥珀；其余保持中性不抢注意力 */
.step-text-done { color: var(--success); }
.step-text-stale { color: var(--warning); }
</style>
