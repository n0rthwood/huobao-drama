<template>
  <span class="fps" @click.stop>
    <span :class="['fps-badge', `is-${state}`]" :title="updatedTitle">{{ badgeLabel }}</span>
    <button
      v-if="(state === 'external' || state === 'unknown') && rewritable"
      class="fps-rewrite"
      type="button"
      :disabled="busy"
      :title="t('components.promptSource.rewriteHint')"
      @click.stop="emit('rewrite')"
    >
      <Loader2 v-if="busy" :size="10" class="animate-spin" />
      {{ busy ? t('components.promptSource.rewriting') : t('components.promptSource.rewrite') }}
    </button>
    <MediaTime v-if="showTime && updatedSeconds" class="fps-time" :at="updatedSeconds" />
  </span>
</template>

<script setup>
/**
 * 最终提示词来源徽标（Issue #32）。
 *
 * 四态：
 *   agent    → Agent 生成（generate-prompt / 提取链路写入）
 *   external → 非 Agent 生成（外部写入：手工编辑、脚本/接口直写）；可一键交给 Agent 重写
 *   unknown  → 有最终提示词但没有来源标记 = 本版之前写入的存量行，中性提示，同样可以重写
 *   empty    → 未生成，出图走兜底提示词
 */
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import MediaTime from '~/components/MediaTime.vue'
import { formatFullTime } from '~/utils/mediaTime'

const props = defineProps({
  // 'agent' / 'external' / null
  source: { type: String, default: '' },
  finalPrompt: { type: String, default: '' },
  // 后端返回 ISO 字符串；MediaTime 吃 unix 秒，这里换算
  updatedAt: { type: String, default: '' },
  // external 时是否显示「交给 Agent 重写」按钮（卡片上不放按钮，详情弹窗里放）
  rewritable: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  showTime: { type: Boolean, default: false },
})

const emit = defineEmits(['rewrite'])

const { t } = useI18n()

const state = computed(() => {
  if (!String(props.finalPrompt || '').trim()) return 'empty'
  if (props.source === 'agent') return 'agent'
  if (props.source === 'external') return 'external'
  return 'unknown'
})

const badgeLabel = computed(() => t(`components.promptSource.${state.value}`))

const updatedSeconds = computed(() => {
  const ms = Date.parse(props.updatedAt || '')
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
})

const updatedTitle = computed(() => {
  if (state.value === 'empty') return t('components.promptSource.emptyHint')
  if (!updatedSeconds.value) return t(`components.promptSource.${state.value}Hint`)
  return `${t(`components.promptSource.${state.value}Hint`)}\n${t('components.promptSource.updatedAt', { time: formatFullTime(updatedSeconds.value) })}`
})
</script>

<style scoped>
.fps {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.fps-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid transparent;
  font: 600 10px var(--font-body);
  white-space: nowrap;
}
.fps-badge.is-agent {
  background: var(--accent-bg);
  color: var(--accent-text);
}
.fps-badge.is-external {
  background: var(--warn-bg);
  color: var(--warn-text);
  border-color: var(--warn-border);
}
/* unknown 与 empty 同为中性：存量行没有来源标记不等于「外部写入」，不能用告警色 */
.fps-badge.is-unknown,
.fps-badge.is-empty {
  background: var(--surface-soft);
  color: var(--text-3);
  border-color: var(--border);
}
.fps-rewrite {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10px var(--font-body);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.fps-rewrite:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.fps-rewrite:disabled { opacity: 0.5; cursor: not-allowed; }
.fps-time { font-size: 10px; }
</style>
