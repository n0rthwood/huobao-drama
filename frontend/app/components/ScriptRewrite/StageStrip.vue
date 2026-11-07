<template>
  <div class="ss" role="tablist" :aria-label="t('episode.rewrite.strip.label')">
    <template v-for="(stage, index) in stages" :key="stage.key">
      <span v-if="index" class="ss-arrow" aria-hidden="true">→</span>
      <div class="ss-chip-wrap">
        <button
          type="button"
          role="tab"
          :class="['ss-chip', 'is-' + stage.status, { on: stage.key === selected }]"
          :aria-selected="stage.key === selected"
          @click="emit('select', stage.key)"
        >
          <span class="ss-num mono">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="ss-name">{{ stageLabel(stage.key) }}</span>
          <span :class="['ss-state', 'is-' + stage.status]">
            <Loader2 v-if="stage.status === 'processing'" :size="11" class="animate-spin" />
            <span class="mono ss-glyph">{{ STATUS_GLYPH[stage.status] }}</span>
            {{ t(`episode.rewrite.stageStatus.${stage.status}`) }}
          </span>
        </button>
        <button
          v-if="stage.ai"
          type="button"
          class="ss-more"
          :aria-label="t('episode.rewrite.strip.actions')"
          :disabled="busy"
          @click="menu = menu === stage.key ? '' : stage.key"
        >⋯</button>

        <div v-if="menu === stage.key" class="ss-menu">
          <button type="button" class="ss-menu-item" :disabled="runActive" @click="pick('rerun', stage.key)">
            {{ t('episode.rewrite.strip.rerunFrom', { name: stageLabel(stage.key) }) }}
          </button>
          <button type="button" class="ss-menu-item" :disabled="runActive" @click="pick('skip', stage.key)">
            {{ t('episode.rewrite.strip.skipStage', { name: stageLabel(stage.key) }) }}
          </button>
          <button
            v-if="stage.status === 'failed'"
            type="button"
            class="ss-menu-item"
            :disabled="runActive"
            @click="pick('retry', stage.key)"
          >{{ t('episode.rewrite.strip.retryStage') }}</button>
          <p v-if="stage.error" class="ss-menu-error">{{ stage.error }}</p>
        </div>
      </div>
    </template>

    <span class="ss-arrow" aria-hidden="true">→</span>
    <button
      type="button"
      class="ss-chip is-final"
      @click="emit('select', 'final')"
    >
      <span class="ss-name">{{ t('episode.rewrite.strip.final') }}</span>
      <span class="ss-state">{{ finalStateLabel }}</span>
    </button>

    <div v-if="menu" class="ss-backdrop" @click="menu = ''" />
  </div>
</template>

<script setup>
/**
 * 改写阶段条（Issue #70）：输入准备 → 各 AI 阶段 → 最终稿。
 *
 * 阶段条只放名称、状态与入口；点击只切换预览，绝不改最终稿。状态显示
 * 未开始 / 运行中 / 已完成 / 已跳过 / 失败，并且同时用符号与文字表达，不单靠颜色。
 * 不渲染尚未启用的未来阶段占位。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'

const props = defineProps({
  stages: { type: Array, default: () => [] },
  selected: { type: String, default: '' },
  runActive: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  /** 'pending' | 'adopted' | 'manual_edits' */
  finalState: { type: String, default: 'pending' },
})
const emit = defineEmits(['select', 'rerun', 'skip', 'retry'])

const { t, te } = useI18n()
const menu = ref('')

const STATUS_GLYPH = {
  pending: '○', processing: '', completed: '✓', skipped: '⤼', failed: '✕',
}

const finalStateLabel = computed(() => t(`episode.rewrite.strip.finalState.${props.finalState}`))

/** 阶段名：输入准备与后端注册的 AI 阶段都走本地四语文案，未知 key 原样显示 */
function stageLabel(key) {
  const name = `episode.rewrite.stageName.${key}`
  return te(name) ? t(name) : key
}

function pick(action, key) {
  menu.value = ''
  emit(action, key)
}
</script>

<style scoped>
.ss {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; overflow-x: auto;
  border-bottom: 1px solid var(--border); background: var(--surface-raised);
}
.ss-arrow { color: var(--text-3); font-size: 12px; flex: none; }
.ss-chip-wrap { position: relative; display: flex; align-items: center; flex: none; }
.ss-chip {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill);
  background: var(--bg-1); color: var(--text-1); cursor: pointer; white-space: nowrap;
  font-size: 12px;
}
.ss-chip.on { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
.ss-chip.is-failed { border-color: var(--danger-text, #d9534f); }
.ss-num { font-size: 10px; color: var(--text-3); font-weight: 700; }
.ss-name { font-weight: 600; }
.ss-state { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--text-3); }
.ss-state.is-failed { color: var(--danger-text, #d9534f); }
.ss-glyph { font-size: 10px; }
.ss-more {
  margin-left: 2px; border: none; background: none; color: var(--text-3);
  cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px;
}
.ss-more:disabled { opacity: 0.4; cursor: not-allowed; }
.ss-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 20;
  min-width: 190px; padding: 4px;
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-md, 0 6px 20px rgba(0,0,0,.18));
}
.ss-menu-item {
  display: block; width: 100%; text-align: left;
  padding: 6px 8px; border: none; background: none; cursor: pointer;
  font-size: 12px; color: var(--text-1); border-radius: var(--radius-sm, 6px);
}
.ss-menu-item:hover:not(:disabled) { background: var(--overlay-track); }
.ss-menu-item:disabled { color: var(--text-3); cursor: not-allowed; }
.ss-menu-error { margin: 4px 6px 2px; font-size: 11px; color: var(--danger-text, #d9534f); line-height: 1.5; }
.ss-backdrop { position: fixed; inset: 0; z-index: 10; }
</style>
