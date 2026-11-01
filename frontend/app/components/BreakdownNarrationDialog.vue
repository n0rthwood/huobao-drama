<template>
  <div v-if="open" class="overlay" @click.self="emit('cancel')">
    <div class="dialog breakdown-narration-dialog">
      <header class="dialog-head">
        <h2 class="dialog-title">{{ t('episode.breakdown.title') }}</h2>
        <button class="btn btn-ghost btn-icon" @click="emit('cancel')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div class="dialog-body breakdown-narration-body">
        <p class="breakdown-chain">{{ t('episode.breakdown.chain') }}</p>
        <label :class="['breakdown-option', { selected: choice === true }]">
          <input type="radio" :checked="choice === true" @change="choice = true" />
          <span class="breakdown-option-text">
            <strong>{{ t('episode.breakdown.withNarration') }}</strong>
            <span class="dim">{{ t('episode.breakdown.withNarrationDesc') }}</span>
          </span>
        </label>
        <label :class="['breakdown-option', { selected: choice === false }]">
          <input type="radio" :checked="choice === false" @change="choice = false" />
          <span class="breakdown-option-text">
            <strong>{{ t('episode.breakdown.withoutNarration') }}</strong>
            <span class="dim">{{ t('episode.breakdown.withoutNarrationDesc') }}</span>
          </span>
        </label>
        <p v-if="hasNarrationData" class="breakdown-destructive">{{ t('episode.breakdown.destructive') }}</p>
        <p v-else-if="hasStoryboards" class="breakdown-note">{{ t('episode.breakdown.replaceNote') }}</p>
      </div>
      <footer class="dialog-foot">
        <button class="btn" @click="emit('cancel')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="emit('confirm', choice)">{{ t('episode.breakdown.confirm') }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
/**
 * 拆分分镜前的旁白选项（#30 C.1）：要旁白 / 不要旁白二选一。
 * 默认取本集当前开关；已有旁白文本或配音时给出会被清空的破坏性警告。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  open: { type: Boolean, default: false },
  defaultEnabled: { type: Boolean, default: false },
  // 本集已有任一镜的旁白文本或配音：重拆会连同已审核内容一起删掉
  hasNarrationData: { type: Boolean, default: false },
  hasStoryboards: { type: Boolean, default: false },
})
const emit = defineEmits(['cancel', 'confirm'])

const { t } = useI18n()
const choice = ref(props.defaultEnabled)

watch(() => props.open, (open) => { if (open) choice.value = Boolean(props.defaultEnabled) })
</script>

<style scoped>
.breakdown-narration-dialog {
  width: 480px;
  max-width: 92vw;
}
.breakdown-narration-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.breakdown-chain {
  font-size: 12px;
  color: var(--text-2);
  margin: 0;
}
.breakdown-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  background: var(--surface-soft);
}
.breakdown-option.selected {
  border-color: var(--action-primary);
}
.breakdown-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.breakdown-option-text .dim {
  font-size: 11px;
  color: var(--text-3);
}
.breakdown-destructive {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--action-danger);
  border-radius: 6px;
  background: var(--action-danger-bg);
  color: var(--action-danger);
  font-size: 12px;
  font-weight: 600;
}
.breakdown-note {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}
</style>
