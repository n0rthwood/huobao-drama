<template>
  <ul v-if="issues.length" :class="['ref-issues', { compact }]">
    <li
      v-for="(issue, i) in issues"
      :key="`${issue.code}-${issue.asset_id ?? issue.name ?? i}`"
      :class="['ref-issue', issue.severity === 'block' ? 'is-block' : 'is-warn']"
      :title="issue.message"
    >
      <span class="ref-issue-dot" />
      <span class="ref-issue-text">{{ issue.message }}</span>
    </li>
  </ul>
</template>

<script setup>
/** 参考图 ↔ 提示词一致性问题列表（后端 ref_issues，message 已是可直接展示的中文句子） */
defineProps({
  issues: { type: Array, default: () => [] },
  compact: { type: Boolean, default: false },
})
</script>

<style scoped>
.ref-issues {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.ref-issue {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-2);
}
.ref-issues.compact .ref-issue {
  font-size: 10px;
}
.ref-issue-dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--text-3);
}
.ref-issue.is-block {
  color: var(--action-danger);
}
.ref-issue.is-block .ref-issue-dot {
  background: var(--action-danger);
}
.ref-issue.is-warn {
  color: var(--tag-warning-text);
}
.ref-issue.is-warn .ref-issue-dot {
  background: var(--tag-warning-text);
}
.ref-issue-text {
  min-width: 0;
}
</style>
