<template>
  <div class="target-assets">
    <div v-if="lead" class="target-asset is-lead">
      <button
        type="button"
        class="target-asset-thumb"
        :disabled="!lead.image"
        :title="lead.label"
        @click="lead.image && emit('preview', srcOf(lead.image), lead.label)"
      >
        <img v-if="lead.image" :src="thumbOf(srcOf(lead.image))" :alt="lead.label" loading="lazy" @error="thumbFallback($event, srcOf(lead.image))" />
        <span v-else class="target-asset-missing">{{ t('episode.ref.targetMissingImage') }}</span>
      </button>
      <div class="target-asset-main">
        <span class="target-asset-head">
          <span class="target-asset-no">{{ t('episode.ref.targetRefNo', { n: 1 }) }}</span>
          <span class="target-asset-name">{{ lead.label }}</span>
        </span>
        <span class="target-asset-meta">{{ t('episode.ref.targetLeadMeta') }}</span>
      </div>
    </div>

    <div
      v-for="item in items"
      :key="`${item.kind}-${item.asset_id}`"
      :class="['target-asset', { 'is-missing': !item.image }]"
    >
      <button
        type="button"
        class="target-asset-thumb"
        :disabled="!item.image"
        :title="`${item.name} · ${kindLabel(item.kind)}`"
        @click="item.image && emit('preview', srcOf(item.image), `${item.name} ${kindLabel(item.kind)}`)"
      >
        <img v-if="item.image" :src="thumbOf(srcOf(item.image))" :alt="item.name" loading="lazy" @error="thumbFallback($event, srcOf(item.image))" />
        <span v-else class="target-asset-missing">{{ t('episode.ref.targetMissingImage') }}</span>
      </button>
      <div class="target-asset-main">
        <span class="target-asset-head">
          <span v-if="item.ref_no" class="target-asset-no">{{ t('episode.ref.targetRefNo', { n: item.ref_no }) }}</span>
          <span class="target-asset-name">{{ item.name }}</span>
        </span>
        <span class="target-asset-meta">
          {{ kindLabel(item.kind) }}
          <template v-if="!item.image"> · {{ t('episode.ref.targetMissingImage') }}</template>
        </span>
        <select
          v-if="candidatesOf(item).length > 1"
          class="target-asset-version"
          :value="item.selected_image || ''"
          :disabled="busy"
          :aria-label="t('episode.ref.chooseVersion', { name: item.name })"
          @change="onVersionChange(item, $event.target.value)"
        >
          <option value="">{{ t('episode.ref.targetVersionDefault') }}</option>
          <option v-for="candidate in candidatesOf(item)" :key="candidate.url" :value="candidate.url">
            {{ candidateLabel(candidate) }}
          </option>
        </select>
      </div>
    </div>

    <div v-if="!items.length && !lead" class="target-assets-empty">{{ t('episode.ref.targetEmpty') }}</div>
  </div>
</template>

<script setup>
/**
 * 某个生成目标（首/中/尾关键帧或视频）实际发送的参考图列表（后端 target_assets，只读）。
 * 绑定由该目标提示词的 @ 自动决定，这里只展示顺序/编号/缺图状态，并提供按目标的版本选择。
 */
import { useI18n } from 'vue-i18n'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { mediaTimeLabel } from '~/utils/mediaTime'
import { useNowTicker } from '~/composables/useTaskProgress'

const props = defineProps({
  // TargetAsset[]：{ kind, asset_id, name, image, selected_image, default_image, ref_no }
  items: { type: Array, default: () => [] },
  // (item) => 该资产的候选图版本列表（[{ id, url, provider, model, generated_at }]）
  versionsFor: { type: Function, default: () => [] },
  // 视频目标的首帧占位（占 1 号位）：{ image, label }
  lead: { type: Object, default: null },
  busy: { type: Boolean, default: false },
})
const emit = defineEmits(['preview', 'select-version'])

const { t } = useI18n()
const now = useNowTicker()

function srcOf(raw) {
  const value = String(raw || '')
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value
  return `/${value}`
}

function kindLabel(kind) {
  if (kind === 'scene') return t('common.scene')
  if (kind === 'prop') return t('common.prop')
  return t('common.role')
}

/** 候选图 = 该资产的全部版本 + 默认图（本集造型图 / 资产当前图，可能不在版本列表里） */
function candidatesOf(item) {
  const out = []
  const seen = new Set()
  const push = (url, fallbackLabel) => {
    const value = String(url || '')
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push({ url: value, fallbackLabel })
  }
  const fallback = t('episode.ref.targetVersionDefaultImage')
  push(item?.default_image, fallback)
  for (const version of props.versionsFor(item) || []) {
    const value = String(version?.url || '')
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ url: value, ...version })
  }
  // 人工选过但版本已被删除时仍要能看到当前值
  push(item?.selected_image, fallback)
  return out
}

function candidateLabel(candidate) {
  const engine = candidate?.provider || candidate?.fallbackLabel || t('episode.asset.unknownEngine')
  const model = candidate?.model ? ` · ${candidate.model}` : ''
  const time = mediaTimeLabel(candidate?.generated_at ?? candidate?.generatedAt, t, now.value)
  return `${engine}${model}${time ? ` · ${time}` : ''}`
}

function onVersionChange(item, value) {
  emit('select-version', item, value || null)
}
</script>

<style scoped>
.target-assets { display: flex; flex-direction: column; gap: 5px; }
.target-asset {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 6px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--surface-raised);
}
.target-asset.is-missing { border-color: var(--error); }
.target-asset-thumb {
  width: 34px; height: 34px; flex: none; padding: 0;
  border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
  background: var(--bg-2); color: var(--text-3); font-size: 11px; cursor: pointer;
}
.target-asset-thumb:disabled { cursor: default; }
.target-asset-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.target-asset-missing { font-size: 10px; color: var(--error); }
.target-asset-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.target-asset-head { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.target-asset-no {
  flex: none; padding: 0 4px; border-radius: 4px;
  background: var(--bg-2); color: var(--text-2);
  font-family: var(--font-mono); font-size: 10px;
}
.target-asset-name { font-size: 12px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.target-asset-meta { font-size: 11px; color: var(--text-3); }
.target-asset-version {
  max-width: 220px; margin-top: 2px; padding: 1px 4px;
  border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg-2); color: var(--text-2); font-size: 11px;
}
.target-assets-empty { font-size: 11px; color: var(--text-3); }
</style>
