<script setup lang="ts">
/**
 * 平滑偏离警告（设计 03 §7，Issue #126）。
 *
 * - 偏离与上限各显示一位小数，比较仍用未舍入值；两者舍入后相同但确实超限时标「（超限）」。
 * - 精确值 tooltip：hover、键盘 focus、触摸/笔点按都能打开，Esc 关闭并回到触发项。
 * - 建议强度取所有超限段 suggested 的最小值；应用后整条曲线复算（调用方重新计算 problems），
 *   仍超限就列真实剩余段，复算为空才显示偏离已回到范围。
 * - 只发 layer-options 草稿，零自动 PUT、零几何确认。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

export interface DeviationProblem {
  segment: number
  deviation: number
  limit: number
  suggested: number
}

const props = defineProps<{
  featureName: string
  problems: DeviationProblem[]
  strength: number
  /** 有尺寸、registration 且能构造同口径像素几何时才允许给建议 */
  canPreview: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'apply-suggested', strength: number): void
  (e: 'disable'): void
}>()

const { t } = useI18n()
const openSegment = ref<number | null>(null)
const pinnedSegment = ref<number | null>(null)

const suggested = computed(() => {
  const values = props.problems.map(problem => problem.suggested).filter(value => Number.isFinite(value))
  return values.length ? Math.min(...values) : 0
})

/** 一位小数展示；舍入后相同却仍超限时要标「（超限）」 */
function deviationText(problem: DeviationProblem): string {
  const rounded = problem.deviation.toFixed(1)
  const same = rounded === problem.limit.toFixed(1)
  return same ? t('mapStudio.editor.smoothOverLimit', { value: rounded }) : `${rounded}px`
}

function limitText(problem: DeviationProblem): string {
  return `${problem.limit.toFixed(1)}px`
}

function exactText(problem: DeviationProblem): string {
  return t('mapStudio.editor.smoothExact', { deviation: String(problem.deviation), limit: String(problem.limit) })
}

function toggleExact(segment: number) {
  pinnedSegment.value = pinnedSegment.value === segment ? null : segment
  openSegment.value = pinnedSegment.value
}

function onKeydown(event: KeyboardEvent, segment: number) {
  if (event.key === 'Escape' && openSegment.value === segment) {
    openSegment.value = null
    event.stopPropagation()
  }
}

function applySuggested() {
  if (props.disabled || suggested.value <= 0) return
  emit('apply-suggested', suggested.value)
}

function disable() {
  if (props.disabled) return
  emit('disable')
}
</script>

<template>
  <section class="geo-smooth-warn" role="group" :aria-label="t('mapStudio.editor.smoothPathTitle')">
    <header class="geo-smooth-head">
      <strong>{{ t('mapStudio.editor.smoothPathTitle') }}</strong>
      <span class="dim">{{ t('mapStudio.editor.smoothPrinciple') }}</span>
    </header>
    <p class="geo-smooth-feature">{{ featureName }}</p>
    <ul v-if="problems.length" class="geo-smooth-problems">
      <li v-for="problem in problems" :key="problem.segment" class="geo-smooth-problem">
        <span class="geo-smooth-segment">
          {{ t('mapStudio.editor.smoothSegment', { n: problem.segment, d: deviationText(problem), l: limitText(problem), s: problem.suggested.toFixed(2) }) }}
        </span>
        <button
          type="button"
          class="geo-exact-toggle"
          :aria-expanded="openSegment === problem.segment"
          :aria-label="t('mapStudio.editor.smoothExactToggle', { n: problem.segment })"
          @click.stop="toggleExact(problem.segment)"
          @keydown="onKeydown($event, problem.segment)"
          @focus="openSegment = problem.segment"
          @blur="openSegment = null"
          @mouseenter="openSegment = problem.segment"
          @mouseleave="openSegment = null"
        >
          {{ t('mapStudio.editor.smoothExactToggleShort') }}
        </button>
        <span v-if="openSegment === problem.segment" class="geo-exact" role="tooltip">{{ exactText(problem) }}</span>
      </li>
    </ul>
    <p v-if="canPreview && problems.length === 0 && strength > 0" class="geo-smooth-pass">
      {{ t('mapStudio.editor.smoothWithinRange') }}
    </p>
    <p v-if="!canPreview && strength > 0" class="geo-smooth-unverified">
      {{ t('mapStudio.editor.smoothUnverified') }}
    </p>
    <div v-if="strength > 0" class="geo-smooth-actions">
      <button
        v-if="canPreview && suggested > 0"
        type="button"
        class="geo-tool"
        :disabled="disabled"
        @click.stop="applySuggested"
      >
        {{ t('mapStudio.editor.smoothUseSuggested', { s: suggested.toFixed(2) }) }}
      </button>
      <button type="button" class="geo-tool" :disabled="disabled" @click.stop="disable">
        {{ t('mapStudio.editor.smoothTurnOff') }}
      </button>
    </div>
    <p v-if="canPreview && suggested === 0 && problems.length" class="geo-smooth-zero">
      {{ t('mapStudio.editor.smoothZeroNote') }}
    </p>
  </section>
</template>

<style scoped>
.geo-smooth-warn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.geo-smooth-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.geo-smooth-head .dim { font-weight: 500; }
.geo-smooth-feature { margin: 0; font-weight: 500; }
.geo-smooth-problems { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 2px; }
.geo-smooth-problem { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.geo-exact-toggle {
  border: 1px solid var(--warn-border);
  background: transparent;
  color: inherit;
  padding: 1px 6px;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
}
.geo-exact {
  flex: 1 0 100%;
  padding: 3px 6px;
  border-radius: 5px;
  border: 1px solid var(--warn-border);
  background: var(--bg-1);
  font: 500 10px var(--font-mono, var(--font-body));
}
.geo-smooth-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.geo-smooth-pass, .geo-smooth-unverified, .geo-smooth-zero { margin: 0; font-weight: 500; }
</style>
