<template>
  <section class="br">
    <header class="br-head">
      <span class="br-title">{{ t('episode.rewrite.bridge.title') }}</span>
      <span class="tag mono">{{ t('episode.rewrite.bridge.summary', counts) }}</span>
      <button v-if="collapsedCount" class="btn btn-ghost btn-sm ml-auto" @click="showAll = !showAll">
        {{ showAll ? t('episode.rewrite.bridge.collapseAll') : t('episode.rewrite.bridge.expandAll', { n: collapsedCount }) }}
      </button>
    </header>

    <p v-if="warnings.length" class="br-warn">{{ warnings.join(' · ') }}</p>
    <p v-if="!decisions.length" class="br-empty">{{ t('episode.rewrite.bridge.none') }}</p>

    <ul v-else class="br-list">
      <li v-for="item in visible" :key="String(item.boundary_id)" :class="['br-item', 'is-' + item.decision]">
        <div class="br-item-head">
          <span class="mono br-id">{{ item.boundary_id }}</span>
          <span :class="['tag', 'br-decision', 'is-' + item.decision]">
            {{ t(`episode.rewrite.bridge.decision.${item.decision}`) }}
          </span>
          <span v-if="item.relation" class="dim br-relation">{{ item.relation }}</span>
          <span v-if="item.shot_attribution" class="dim mono br-attr">
            {{ t(`episode.rewrite.bridge.attribution.${item.shot_attribution}`) }}
          </span>
          <span v-if="item.placement_adjusted" class="tag br-adjusted">{{ t('episode.rewrite.bridge.adjusted') }}</span>
        </div>
        <div class="br-context">
          <p class="br-para">{{ truncate(item.left_paragraph) }}</p>
          <p class="br-para is-right">{{ truncate(item.right_paragraph) }}</p>
        </div>
        <p v-if="item.bridge_text" class="br-bridge">
          {{ item.bridge_text }}
          <span v-if="item.spoken_chars !== null && item.spoken_chars !== undefined"
                :class="['mono', 'br-chars', { 'is-over': item.spoken_chars > SPOKEN_HINT }]">
            {{ t('episode.rewrite.bridge.spokenChars', { n: item.spoken_chars }) }}
          </span>
        </p>
        <p v-if="item.reason" class="br-reason">{{ item.reason }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup>
/**
 * 桥句阶段的逐边界审校报告（Issue #70）。
 *
 * 三分决策：无需补写 / 已补写 / 需要但未安全补写。第三类必须显著呈现——把弃答记成
 * 「无需补写」会假装成功率更高。默认只展开「已补写」与「需要但未安全补写」，
 * 完整检查记录可一键展开（程序完备性 ≠ 叙事质量）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  report: { type: Object, default: null },
})

const { t } = useI18n()
const showAll = ref(false)

/** 25 个朗读字符是提示，不是硬限；超过只提醒不拦截 */
const SPOKEN_HINT = 25

const decisions = computed(() => (Array.isArray(props.report?.decisions) ? props.report.decisions : []))
const warnings = computed(() => (Array.isArray(props.report?.warnings) ? props.report.warnings : []))

const counts = computed(() => ({
  total: props.report?.boundary_count ?? decisions.value.length,
  inserted: props.report?.inserted_count ?? decisions.value.filter(item => item.decision === 'inserted').length,
  unsafe: props.report?.needed_but_unsafe_count ?? decisions.value.filter(item => item.decision === 'needed_but_unsafe').length,
}))

const visible = computed(() => (showAll.value
  ? decisions.value
  : decisions.value.filter(item => item.decision !== 'no_bridge')))
/** 默认折叠掉的「无需补写」条数 */
const collapsedCount = computed(() => decisions.value.filter(item => item.decision === 'no_bridge').length)

function truncate(text) {
  const value = String(text || '')
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}
</script>

<style scoped>
.br { display: flex; flex-direction: column; gap: 8px; }
.br-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.br-title { font-size: 12px; font-weight: 700; color: var(--text-1); }
.br-warn { margin: 0; font-size: 11.5px; color: var(--danger-text, #d9534f); }
.br-empty { margin: 0; font-size: 12px; color: var(--text-3); }
.br-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.br-item { border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius); padding: 8px 10px; background: var(--surface-raised); }
.br-item.is-inserted { border-left-color: var(--accent); }
.br-item.is-needed_but_unsafe { border-left-color: var(--danger-text, #d9534f); }
.br-item.is-no_bridge { border-left-color: var(--border); }
.br-item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 5px; }
.br-id { font-size: 10.5px; color: var(--text-3); }
.br-decision.is-needed_but_unsafe { color: var(--danger-text, #d9534f); }
.br-relation, .br-attr { font-size: 10.5px; }
.br-adjusted { font-size: 10.5px; }
.br-context { display: flex; flex-direction: column; gap: 2px; margin-bottom: 5px; }
.br-para { margin: 0; font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
.br-para.is-right::before { content: '→ '; }
.br-bridge {
  margin: 0 0 4px; font-size: 12.5px; color: var(--text-0); line-height: 1.7;
  background: var(--ok-bg, rgba(102, 187, 106, 0.12)); border-radius: var(--radius-sm, 6px); padding: 4px 7px;
}
.br-chars { font-size: 10.5px; color: var(--text-3); margin-left: 6px; }
.br-chars.is-over { color: var(--danger-text, #d9534f); }
.br-reason { margin: 0; font-size: 11.5px; color: var(--text-2); line-height: 1.6; }
</style>
