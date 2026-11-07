<template>
  <section class="fr">
    <header class="fr-head">
      <span class="fr-title">{{ t('episode.rewrite.filter.title') }}</span>
      <span class="tag mono">{{ t('episode.rewrite.filter.count', { n: removed.length }) }}</span>
      <span v-if="report?.raw_chars && report?.prepared_chars" class="dim fr-chars mono">
        {{ t('episode.rewrite.filter.chars', { raw: report.raw_chars, prepared: report.prepared_chars }) }}
      </span>
    </header>

    <p v-if="!removed.length" class="fr-empty">{{ t('episode.rewrite.filter.none') }}</p>
    <ul v-else class="fr-list">
      <li v-for="(item, i) in removed" :key="i" class="fr-item">
        <div class="fr-item-head">
          <span class="tag fr-cat">{{ categoryLabel(item.category) }}</span>
          <span class="dim mono fr-span">{{ t('episode.rewrite.filter.span', { start: item.start, end: item.end }) }}</span>
        </div>
        <p class="fr-text">{{ item.text }}</p>
        <p class="fr-reason">{{ item.reason }}</p>
      </li>
    </ul>

    <div v-if="keptNotes.length" class="fr-kept">
      <span class="fr-kept-title">{{ t('episode.rewrite.filter.kept') }}</span>
      <ul class="fr-kept-list">
        <li v-for="(note, i) in keptNotes" :key="i">{{ note }}</li>
      </ul>
    </div>
  </section>
</template>

<script setup>
/**
 * 输入准备（自动过滤）报告（Issue #70）：逐条展示「过滤了什么、属于哪类、为什么」。
 *
 * 过滤是必经的公共输入准备，不属于任何 AI 阶段，也不能被跳过；完整原始资料仍保留在原文步，
 * 这里只说明哪些授权 / 溯源 / 编辑信息没有进入旁白。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  report: { type: Object, default: null },
})

const { t, te } = useI18n()

const removed = computed(() => (Array.isArray(props.report?.removed) ? props.report.removed : []))
const keptNotes = computed(() => (Array.isArray(props.report?.kept_notes) ? props.report.kept_notes : []))

/** 未知分类原样显示后端给的值，绝不吞掉 */
function categoryLabel(category) {
  const key = `episode.rewrite.filter.category.${category}`
  return te(key) ? t(key) : String(category || '')
}
</script>

<style scoped>
.fr { display: flex; flex-direction: column; gap: 8px; }
.fr-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fr-title { font-size: 12px; font-weight: 700; color: var(--text-1); }
.fr-chars { font-size: 11px; }
.fr-empty { margin: 0; font-size: 12px; color: var(--text-3); }
.fr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.fr-item { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; background: var(--surface-raised); }
.fr-item-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.fr-cat { font-size: 10.5px; }
.fr-span { font-size: 10.5px; }
.fr-text {
  margin: 0 0 4px; font-size: 12px; line-height: 1.7; color: var(--text-2);
  white-space: pre-wrap; word-break: break-word;
  text-decoration: line-through; background: var(--warn-bg, rgba(239, 83, 80, 0.08));
  border-radius: var(--radius-sm, 6px); padding: 3px 6px;
}
.fr-reason { margin: 0; font-size: 11.5px; color: var(--text-2); line-height: 1.6; }
.fr-kept { display: flex; flex-direction: column; gap: 4px; }
.fr-kept-title { font-size: 11.5px; font-weight: 600; color: var(--text-2); }
.fr-kept-list { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--text-2); line-height: 1.7; }
</style>
