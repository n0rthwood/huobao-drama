<template>
  <div :class="['progress-ring', 'is-' + (status || 'idle'), { compact, 'is-indeterminate': indeterminate }]">
    <span class="pr-visual" :style="{ width: size + 'px', height: size + 'px' }" :title="tooltip">
      <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" aria-hidden="true">
        <circle class="pr-track" :cx="size / 2" :cy="size / 2" :r="radius" fill="none" :stroke-width="stroke" />
        <circle
          v-if="status === 'running' || status === 'queued'"
          class="pr-value"
          :cx="size / 2"
          :cy="size / 2"
          :r="radius"
          fill="none"
          :stroke-width="stroke"
          stroke-linecap="round"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
          :transform="`rotate(-90 ${size / 2} ${size / 2})`"
        />
      </svg>
      <span class="pr-center">
        <template v-if="status === 'failed'">!</template>
        <template v-else-if="status === 'cancelled'">×</template>
        <template v-else-if="status === 'completed'">✓</template>
        <template v-else-if="status === 'queued'">{{ queuePosition ? '#' + queuePosition : '…' }}</template>
        <template v-else-if="fraction !== null && size >= 28">{{ Math.round(fraction * 100) }}</template>
      </span>
    </span>
    <span v-if="!compact" class="pr-info">
      <span class="pr-label">{{ label }}</span>
      <span v-if="sub" class="pr-sub" :title="sub">{{ sub }}</span>
      <span v-if="showActions" class="pr-actions">
        <button
          v-if="cancellable && (status === 'running' || status === 'queued') && !cancelRequested"
          type="button"
          class="pr-action"
          @click.stop="emit('cancel')"
        >{{ t('common.cancel') }}</button>
        <button
          v-if="retryable && (status === 'failed' || status === 'cancelled')"
          type="button"
          class="pr-action is-retry"
          @click.stop="emit('retry')"
        >{{ t('common.ring.retry') }}</button>
      </span>
    </span>
  </div>
</template>

<script setup>
/**
 * 生成任务的圆形进度：运行中显示百分比环 + 剩余时间；排队中显示「等待中 · 第 N 位」
 * （悬停给预计开始时间）；失败/已取消显示原因与重试。
 * 属性是「已归一化」的进度数据，由 useTaskProgress 的 ringPropsFromTask /
 * ringPropsFromBatchItem 产出，这样 sys_task 和关键帧批次 item 可共用同一个组件。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatSeconds } from '~/composables/useTaskProgress'

const { t } = useI18n()

const props = defineProps({
  status: { type: String, default: '' }, // queued | running | completed | failed | cancelled
  fraction: { type: Number, default: null },
  remainingSeconds: { type: Number, default: null },
  queuePosition: { type: Number, default: null },
  queueLength: { type: Number, default: null },
  startSeconds: { type: Number, default: null },
  etaSeconds: { type: Number, default: null },
  error: { type: String, default: '' },
  cancelRequested: { type: Boolean, default: false },
  cancellable: { type: Boolean, default: false },
  retryable: { type: Boolean, default: false },
  showActions: { type: Boolean, default: true },
  size: { type: Number, default: 34 },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['cancel', 'retry'])

const stroke = computed(() => Math.max(2, Math.round(props.size / 11)))
const radius = computed(() => (props.size - stroke.value) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
// 排队中画一小段弧示意「在队列里」，运行中按完成比例画
const indeterminate = computed(() => props.status === 'running' && props.fraction === null)
const dashOffset = computed(() => {
  if (props.status === 'queued') return circumference.value * 0.88
  const f = props.fraction === null ? 0.25 : props.fraction
  return circumference.value * (1 - f)
})

const label = computed(() => {
  if (props.status === 'queued') {
    return props.queuePosition
      ? t('common.ring.queuedAt', { n: props.queuePosition })
      : t('common.ring.queued')
  }
  if (props.status === 'running') {
    return props.cancelRequested ? t('common.ring.cancelling') : t('common.ring.running')
  }
  if (props.status === 'failed') return t('common.ring.failed')
  if (props.status === 'cancelled') return t('common.ring.cancelled')
  if (props.status === 'completed') return t('common.ring.completed')
  return ''
})

const sub = computed(() => {
  if (props.status === 'failed') return props.error || t('common.ring.noReason')
  if (props.status === 'running' && props.remainingSeconds !== null) {
    return props.remainingSeconds <= 1
      ? t('common.ring.almostDone')
      : t('common.ring.remaining', { time: formatSeconds(t, props.remainingSeconds) })
  }
  if (props.status === 'queued' && props.startSeconds !== null) {
    return t('common.ring.startsIn', { time: formatSeconds(t, props.startSeconds) })
  }
  return ''
})

const tooltip = computed(() => {
  const parts = []
  if (label.value) parts.push(label.value)
  if (props.status === 'queued') {
    if (props.queueLength) parts.push(t('common.ring.queueLength', { n: props.queueLength }))
    if (props.startSeconds !== null) parts.push(t('common.ring.startsIn', { time: formatSeconds(t, props.startSeconds) }))
  }
  if (props.status === 'running' && props.remainingSeconds !== null) {
    parts.push(t('common.ring.remaining', { time: formatSeconds(t, props.remainingSeconds) }))
  }
  if (props.status === 'failed' && props.error) parts.push(props.error)
  return parts.join(' · ')
})
</script>

<style scoped>
.progress-ring {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pr-visual {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.pr-visual svg { display: block; }
.pr-track { stroke: var(--border); }
.pr-value {
  stroke: var(--accent);
  transition: stroke-dashoffset 0.6s linear;
}
.is-queued .pr-value { stroke: var(--warning, var(--text-3)); }
.is-failed .pr-track { stroke: var(--action-danger, #e5484d); }
.is-cancelled .pr-track { stroke: var(--text-3); }
.is-completed .pr-track { stroke: var(--success, #30a46c); }
.is-indeterminate .pr-value,
.is-queued .pr-value { animation: pr-spin 1.8s linear infinite; transform-origin: 50% 50%; }
@keyframes pr-spin {
  from { transform: rotate(-90deg); }
  to { transform: rotate(270deg); }
}
.pr-center {
  position: absolute;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.is-failed .pr-center { color: var(--action-danger, #e5484d); }
.is-completed .pr-center { color: var(--success, #30a46c); }
.pr-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pr-label { font-size: 11px; color: var(--text-2); white-space: nowrap; }
.is-failed .pr-label { color: var(--action-danger, #e5484d); }
.pr-sub {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.pr-actions { display: flex; gap: 6px; margin-top: 2px; }
.pr-action {
  border: 1px solid var(--border);
  background: var(--button-bg, transparent);
  color: var(--text-2);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  cursor: pointer;
}
.pr-action:hover { border-color: var(--border-hover, var(--border)); color: var(--text-1); }
.pr-action.is-retry { color: var(--accent); border-color: var(--accent); }
</style>
