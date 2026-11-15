<template>
  <div class="ss" role="tablist" :aria-label="t('episode.rewrite.strip.label')">
    <template v-for="(stage, index) in stages" :key="stage.key">
      <span v-if="index" class="ss-arrow" aria-hidden="true">→</span>
      <div class="ss-chip-wrap">
        <button
          type="button"
          role="tab"
          :class="['ss-chip', 'is-' + stateOf(stage), { on: stage.key === selected }]"
          :aria-selected="stage.key === selected"
          @click="emit('select', stage.key)"
        >
          <span class="ss-num mono">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="ss-name" :class="stepTextClass(stateOf(stage))">{{ stageLabel(stage.key) }}</span>
          <span :class="['ss-state', 'is-' + stateOf(stage)]">
            <Loader2 v-if="stateOf(stage) === 'processing'" :size="11" class="animate-spin" />
            <span v-else-if="stateOf(stage) === 'failed'" class="mono ss-glyph">✕</span>
            <StepStatusIcon v-else :status="stateOf(stage)" />
            {{ stateLabel(stateOf(stage)) }}
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

    <!-- 最终稿：可选中（#105）——点它切到最终稿编辑区，并写 rwstage=final 便于深链与刷新恢复 -->
    <span class="ss-arrow" aria-hidden="true">→</span>
    <button
      type="button"
      :class="['ss-chip', 'is-final', 'is-' + finalStatus, { on: selected === 'final' }]"
      :aria-selected="selected === 'final'"
      :title="finalStateLabel"
      @click="emit('select', 'final')"
    >
      <span class="ss-name" :class="stepTextClass(finalStatus)">{{ t('episode.rewrite.strip.final') }}</span>
      <StepStatusIcon :status="finalStatus" />
      <span :class="['ss-state', 'is-' + finalStatus]">{{ stateLabel(finalStatus) }}</span>
    </button>

    <span class="ss-arrow" aria-hidden="true">→</span>
    <!-- 确认旁白稿：只显示状态（确认动作在最终稿下方的确认条，不在阶段条里代劳） -->
    <span :class="['ss-chip', 'is-static', 'is-confirm', 'is-' + confirmStatus]">
      <span class="ss-name" :class="stepTextClass(confirmStatus)">{{ t('episode.rewrite.strip.confirm') }}</span>
      <StepStatusIcon :status="confirmStatus" />
      <span :class="['ss-state', 'is-' + confirmStatus]">{{ stateLabel(confirmStatus) }}</span>
    </span>

    <div v-if="menu" class="ss-backdrop" @click="menu = ''" />
  </div>
</template>

<script setup>
/**
 * 改写阶段条（Issue #70 / #105）：输入准备 → 各 AI 阶段 → 最终稿 → 确认旁白稿。
 *
 * 状态以 roadmap 为准（`rewrite.prepared|fidelity|bridge|final|confirm`）：完成 ✓、
 * 需复核琥珀、锁定、跳过 ⤼ 都由同一套口径渲染；只有「正在执行的那一阶段」允许用
 * 运行任务进度覆盖（这才是真正的运行事实，而不是完成判据）。
 * 阶段条只切换预览/最终稿视图，绝不改最终稿内容。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'

import StepStatusIcon from '~/components/StepStatusIcon.vue'
import { stepTextClass } from '~/utils/stepStatus'

const props = defineProps({
  stages: { type: Array, default: () => [] },
  selected: { type: String, default: '' },
  runActive: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  /** 'pending' | 'adopted' | 'manual_edits'（最终稿来源说明，作为 tooltip 保留） */
  finalState: { type: String, default: 'pending' },
  /** roadmap 的五个子步骤状态：{ prepared_source, fidelity, bridge, final, confirm } */
  roadmapStatuses: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['select', 'rerun', 'skip', 'retry'])

const { t, te } = useI18n()
const menu = ref('')

/** 旧运行状态 → roadmap 状态（只在 roadmap 尚未给出该格子状态时兜底） */
const LEGACY_STATE = { pending: 'available', completed: 'done', skipped: 'skipped' }
const ROADMAP_STATES = ['locked', 'available', 'in_progress', 'done', 'stale', 'skipped']

/**
 * 一格显示什么状态：正在跑的阶段用运行进度（processing）覆盖；失败保留运行事实（failed，红 ✕）；
 * 其余读 roadmap；roadmap 还没取到时兜底旧运行状态。
 */
function stateOf(stage) {
  if (!stage) return 'checking'
  if (stage.status === 'processing') return 'processing'
  if (stage.status === 'failed') return 'failed'
  const known = props.roadmapStatuses?.[stage.key]
  if (known) return known
  return LEGACY_STATE[stage.status] || stage.status || 'available'
}
/** 状态文字：roadmap 状态与运行状态各有一套四语文案 */
function stateLabel(state) {
  if (state === 'checking') return t('episode.stepStatus.checking')
  return ROADMAP_STATES.includes(state) ? t(`episode.stepStatus.${state}`) : t(`episode.rewrite.stageStatus.${state}`)
}

const finalStateLabel = computed(() => t(`episode.rewrite.strip.finalState.${props.finalState}`))
const finalStatus = computed(() => props.roadmapStatuses?.final || 'checking')
const confirmStatus = computed(() => props.roadmapStatuses?.confirm || 'checking')

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
.ss-chip.is-static { cursor: default; }
.ss-chip.is-done .ss-name, .ss-state.is-done { color: var(--success); }
.ss-chip.is-stale { border-color: var(--warning); }
.ss-state.is-stale { color: var(--warning); }
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
