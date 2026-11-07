<template>
  <div class="dv">
    <div v-if="empty" class="dv-empty">{{ t('episode.rewrite.diff.identical') }}</div>
    <div v-else class="dv-rows">
      <template v-for="(group, gi) in groups" :key="gi">
        <button
          v-if="group.collapsed && !expanded[gi]"
          type="button"
          class="dv-collapse"
          @click="expanded = { ...expanded, [gi]: true }"
        >{{ t('episode.rewrite.diff.unchangedParagraphs', { n: group.rows.length }) }}</button>
        <template v-else>
          <div v-for="(row, ri) in group.rows" :key="gi + '-' + ri" :class="['dv-row', 'is-' + row.type]">
            <span class="dv-mark mono" :aria-label="t(`episode.rewrite.diff.${row.type}`)">{{ MARK[row.type] }}</span>
            <div class="dv-text">
              <template v-if="row.type === 'change'">
                <p class="dv-line is-before">
                  <span
                    v-for="(seg, si) in row.inline.before"
                    :key="'b' + si"
                    :class="seg.type === 'delete' ? 'dv-del' : ''"
                  >{{ seg.text }}</span>
                </p>
                <p class="dv-line is-after">
                  <span
                    v-for="(seg, si) in row.inline.after"
                    :key="'a' + si"
                    :class="seg.type === 'insert' ? 'dv-ins' : ''"
                  >{{ seg.text }}</span>
                </p>
              </template>
              <p v-else-if="row.type === 'delete'" class="dv-line is-before"><span class="dv-del">{{ row.before || ' ' }}</span></p>
              <p v-else-if="row.type === 'insert'" class="dv-line is-after"><span class="dv-ins">{{ row.after || ' ' }}</span></p>
              <p v-else class="dv-line">{{ row.after || ' ' }}</p>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
/**
 * 阶段输出与「它实际使用的前驱」之间的差异（Issue #70）。
 *
 * 插入 / 删除同时用符号（＋ − ≠）、底纹与删除线三重标记，不单靠红绿；
 * 中文按词元定位到具体字。连续未改动段默认折叠，展开后仍能看到完整正文。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { diffParagraphs, diffStats } from '~/utils/textDiff'

const props = defineProps({
  before: { type: String, default: '' },
  after: { type: String, default: '' },
})

const { t } = useI18n()
const expanded = ref({})

const MARK = { equal: '', insert: '＋', delete: '−', change: '≠' }
const COLLAPSE_AT = 4

const rows = computed(() => diffParagraphs(props.before, props.after))
const empty = computed(() => diffStats(rows.value).identical)

/** 连续 4 段以上未改动折叠成一条，改动段永远直接可见 */
const groups = computed(() => {
  const out = []
  let run = []
  const flush = () => {
    if (!run.length) return
    out.push({ collapsed: run.length >= COLLAPSE_AT, rows: run })
    run = []
  }
  for (const row of rows.value) {
    if (row.type === 'equal') { run.push(row); continue }
    flush()
    out.push({ collapsed: false, rows: [row] })
  }
  flush()
  return out
})
</script>

<style scoped>
.dv { font-size: 13px; line-height: 1.95; }
.dv-empty { color: var(--text-3); font-size: 12.5px; padding: 10px 2px; }
.dv-rows { display: flex; flex-direction: column; gap: 2px; }
.dv-row { display: flex; gap: 8px; padding: 2px 4px; border-radius: var(--radius-sm, 6px); }
.dv-row.is-insert { background: var(--ok-bg, rgba(102, 187, 106, 0.1)); }
.dv-row.is-delete { background: var(--warn-bg, rgba(239, 83, 80, 0.08)); }
.dv-row.is-change { background: var(--overlay-track); }
.dv-mark { flex: none; width: 16px; text-align: center; color: var(--text-3); font-size: 11px; padding-top: 2px; }
.dv-text { min-width: 0; flex: 1; }
.dv-line { margin: 0; white-space: pre-wrap; word-break: break-word; color: var(--text-1); }
.dv-line.is-before { color: var(--text-2); }
.dv-del { text-decoration: line-through; background: var(--warn-bg, rgba(239, 83, 80, 0.16)); }
.dv-ins { text-decoration: underline; text-decoration-style: dotted; background: var(--ok-bg, rgba(102, 187, 106, 0.18)); }
.dv-collapse {
  align-self: flex-start;
  background: none; border: 1px dashed var(--border); border-radius: var(--radius-pill);
  color: var(--text-3); font-size: 11px; padding: 1px 10px; cursor: pointer;
}
.dv-collapse:hover { color: var(--text-1); border-color: var(--text-3); }
</style>
