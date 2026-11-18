<template>
  <span class="ref-cites" @click.stop>
    <template v-for="(part, i) in parts" :key="i">
      <button
        v-if="part.n"
        type="button"
        class="ref-cite-badge"
        :class="{ 'is-missing': !part.path }"
        :title="part.path ? t('components.referenceImages.previewTitle', { index: part.n }) : t('components.referenceImages.missingHint')"
        @click.stop="part.path && emit('preview', mediaUrl(part.path), t('components.referenceImages.previewTitle', { index: part.n }))"
      >{{ '@' }}参考图{{ part.n }}</button>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>

<script setup>
// Issue #121：只读展示处的 @参考图N 渲染成可点编号徽标（点开原图）。
// 编号 = 资产参考图列表序；指向已删除/缺失图的徽标标失效，不静默换图。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseReferenceImages } from '~/composables/useApi'
import { mediaUrl } from '~/utils/url'

const { t } = useI18n()
const props = defineProps({
  text: { type: String, default: '' },
  references: { type: [String, Array], default: null },
})
const emit = defineEmits(['preview'])

const CITE_RE = /@参考图(\d+)|参考图(\d+)/g

const parts = computed(() => {
  const refs = parseReferenceImages(props.references)
  const out = []
  let last = 0
  for (const match of String(props.text || '').matchAll(CITE_RE)) {
    const n = Number(match[1] ?? match[2])
    if (match.index > last) out.push({ text: String(props.text).slice(last, match.index) })
    out.push({ n, path: refs[n - 1]?.path || '' })
    last = match.index + match[0].length
  }
  if (last < String(props.text || '').length) out.push({ text: String(props.text).slice(last) })
  return out
})
</script>

<style scoped>
.ref-cites { white-space: pre-wrap; word-break: break-word; }
.ref-cite-badge {
  display: inline-flex; align-items: center;
  font-size: 0.92em; line-height: 1.3; padding: 0 5px; margin: 0 1px;
  border-radius: 4px; border: 1px solid var(--accent, var(--border));
  background: var(--accent-bg); color: var(--text-1); cursor: pointer;
  vertical-align: baseline;
}
.ref-cite-badge.is-missing {
  border-color: var(--danger, var(--border)); background: var(--danger-bg, var(--bg-2));
  color: var(--text-2); text-decoration: line-through; cursor: default;
}
</style>