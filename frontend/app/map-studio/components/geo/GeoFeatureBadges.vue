<script setup lang="ts">
/**
 * 要素状态徽标（设计 03 §8）：来源徽标只提供解释性 tooltip，不新增来源管理或深链。
 *
 * - 数据集几何：hover / 键盘 focus / 触摸或笔点按都能打开说明；Esc 或再次点按关闭，焦点留触发项。
 * - 待核对与 geometryUnverified 同口径（含 dataset_missing）；proposed 单独显示时必须叫「AI 候选」。
 * - 已确认只解释服务端字段，不声称用户点过显式确认入口；人工几何只看实际 origin。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Lock } from 'lucide-vue-next'
import { isConfirmed, isDatasetMissing, isGeometryUnverified, isManualGeometry, type FeatureGeometry } from './feature'

const props = defineProps<{ feature: FeatureGeometry }>()
const { t } = useI18n()
const open = ref(false)
const pinned = ref(false)

const datasetRef = computed(() => props.feature.dataset_ref?.ref?.trim() || '')
const datasetClip = computed(() => {
  const clip = props.feature.dataset_ref?.clip_bbox
  return Array.isArray(clip) && clip.length === 4 ? clip.join(', ') : ''
})
const missing = computed(() => isDatasetMissing(props.feature))
const unverified = computed(() => isGeometryUnverified(props.feature))
const reasons = computed(() => props.feature.verification?.reasons?.filter(Boolean) ?? [])
const showProposed = computed(() => props.feature.proposed === true)
const sourceLines = computed(() => [
  t('mapStudio.editor.sourceHint'),
  datasetRef.value ? t('mapStudio.editor.sourceRef', { ref: datasetRef.value }) : t('mapStudio.editor.sourceUnavailable'),
  ...(datasetClip.value ? [t('mapStudio.editor.sourceClip', { box: datasetClip.value })] : []),
])

function toggle() {
  pinned.value = !pinned.value
  open.value = pinned.value
}
function close() {
  open.value = false
  pinned.value = false
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    close()
    event.stopPropagation()
  }
}
</script>

<template>
  <span class="geo-badges">
    <span v-if="feature.dataset_ref" class="geo-source" :class="{ 'is-open': open }">
      <button
        type="button"
        class="geo-badge geo-source-badge"
        :aria-expanded="open"
        :aria-label="t('mapStudio.editor.datasetBadge')"
        :title="t('mapStudio.editor.datasetBadge')"
        @click.stop="toggle"
        @keydown="onKeydown"
        @focus="open = true"
        @blur="close"
        @mouseenter="open = true"
        @mouseleave="close"
      >
        <Lock :size="10" />
        {{ t('mapStudio.editor.datasetBadge') }}
      </button>
      <span v-if="open" class="geo-tip" role="tooltip" @click.stop>
        <span v-for="line in sourceLines" :key="line" class="geo-tip-line">{{ line }}</span>
      </span>
    </span>
    <span v-if="unverified" class="geo-badge geo-badge-pending" :title="reasons.length ? reasons.join('；') : t('mapStudio.editor.pendingNoReason')">
      {{ t('mapStudio.editor.pending') }}
    </span>
    <span v-if="missing" class="geo-badge geo-badge-missing">{{ t('mapStudio.editor.missingDataset') }}</span>
    <span v-if="showProposed" class="geo-badge geo-badge-proposed">{{ t('mapStudio.editor.proposed') }}</span>
    <span v-if="isConfirmed(feature)" class="geo-badge geo-badge-confirmed">{{ t('mapStudio.editor.confirmed') }}</span>
    <span v-if="isManualGeometry(feature)" class="geo-badge geo-badge-manual">{{ t('mapStudio.editor.manualGeometry') }}</span>
  </span>
</template>

<style scoped>
.geo-badges { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 3px; }
.geo-source { position: relative; display: inline-flex; }
.geo-source-badge { display: inline-flex; align-items: center; gap: 3px; }
.geo-tip {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  max-width: 260px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-1);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
  font: 500 10.5px var(--font-body);
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.geo-tip-line { white-space: normal; }
.geo-badge {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  font-weight: 600;
}
.geo-badge-pending { border-color: #d97732; color: #a4551f; }
.geo-badge-missing { border-color: #c94a3a; color: #a3352b; }
.geo-badge-proposed { background: var(--warn-bg); color: var(--warn-text); border-color: var(--warn-border); }
.geo-badge-confirmed { border-color: #4f7f6a; color: #3c6654; }
.geo-badge-manual { border-color: #557269; color: #445c55; }
</style>
