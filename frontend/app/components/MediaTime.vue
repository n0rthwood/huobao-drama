<template>
  <span v-if="label" class="media-time" :title="fullTime">{{ label }}</span>
</template>

<script setup>
/**
 * 媒体时间（生成/上传时间）的唯一显示组件。
 *
 * 入参 `at` 是 unix 秒（后端所有媒体时间都按 unix 秒返回），显示规则见 utils/mediaTime.js；
 * 相对档位由 useNowTicker() 的 1s 共享心跳驱动，跨档（秒→分→时→天→月→绝对）自动切换；
 * hover 显示完整本地时间。没有时间（反查不到生成任务等）时不渲染任何内容。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNowTicker } from '~/composables/useTaskProgress'
import { formatFullTime, mediaTimeLabel, mediaTimeParts } from '~/utils/mediaTime'

const props = defineProps({
  // 媒体时间（unix 秒）；null / 0 / 非法值 → 不显示
  at: { type: [Number, String], default: null },
})

const { t } = useI18n()
const now = useNowTicker()

const label = computed(() => mediaTimeLabel(props.at, t, now.value))
const fullTime = computed(() => (mediaTimeParts(props.at, now.value) ? formatFullTime(props.at) : ''))
</script>

<style scoped>
.media-time {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
</style>
