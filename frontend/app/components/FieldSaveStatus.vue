<template>
  <span v-if="label" :class="['field-save', 'is-' + status]">{{ label }}</span>
</template>

<script setup>
/**
 * 字段级保存状态（关键帧页自动保存字段 + 视频页视频提示词）。
 * 相对时间完全由前端按 unix 秒与本地时钟实时计算，复用进度环的 1s 共享心跳。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNowTicker } from '~/composables/useTaskProgress'

const props = defineProps({
  // idle | loaded(本次会话未改动，只有历史保存时间) | dirty | saving | saved | error
  status: { type: String, default: 'idle' },
  // 最近一次保存时间（unix 秒），0 表示没有记录
  at: { type: Number, default: 0 },
})

const { t } = useI18n()
const now = useNowTicker()

const relative = computed(() => {
  const at = Number(props.at)
  if (!Number.isFinite(at) || at <= 0) return ''
  const diff = Math.max(0, Math.floor(now.value / 1000 - at))
  if (diff < 5) return t('episode.save.justNow')
  if (diff < 60) return t('episode.save.seconds', { n: diff })
  if (diff < 3600) return t('episode.save.minutes', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('episode.save.hours', { n: Math.floor(diff / 3600) })
  return t('episode.save.days', { n: Math.floor(diff / 86400) })
})

const label = computed(() => {
  if (props.status === 'dirty') return t('episode.save.unsaved')
  if (props.status === 'saving') return t('episode.save.saving')
  if (props.status === 'error') return t('episode.save.failed')
  if (props.status === 'saved') return relative.value ? t('episode.save.saved', { time: relative.value }) : t('episode.save.savedPlain')
  if (props.status === 'loaded' && relative.value) return t('episode.save.lastSaved', { time: relative.value })
  return ''
})
</script>

<style scoped>
.field-save {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
.field-save.is-dirty {
  color: var(--tag-warning-text);
}
.field-save.is-saved {
  color: var(--tag-success-text);
}
.field-save.is-error {
  color: var(--action-danger);
}
</style>
