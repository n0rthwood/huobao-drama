<template>
  <aside class="lv" role="complementary">
    <header class="lv-head">
      <strong>{{ t('mapStudio.layers.title') }}</strong>
      <span class="dim">{{ versionTitle }}</span>
      <button type="button" class="lv-tool" @click="emit('close')">
        <X :size="11" />
        {{ t('mapStudio.panel.close') }}
      </button>
    </header>

    <p v-if="!model.available" class="lv-empty dim">{{ t('mapStudio.layers.noSnapshotData') }}</p>
    <template v-else>
      <ul class="lv-list">
        <li v-for="layer in model.layers" :key="layer.id">
          <button
            type="button"
            class="lv-item"
            :class="{ 'is-on': layer.id === selected?.id }"
            :aria-pressed="layer.id === selected?.id"
            @click="emit('select', layer.id)"
          >
            <span class="lv-type">{{ t('mapStudio.layers.layerType.' + layer.type) }}</span>
            <span class="lv-name">{{ layer.name }}</span>
          </button>
        </li>
      </ul>
      <p v-if="!model.layers.length" class="lv-empty dim">{{ t('mapStudio.layers.noLayers') }}</p>

      <section v-if="selected" class="lv-detail">
        <strong class="lv-sub">{{ selected.name }}</strong>
        <p v-if="selected.anchorMissing" class="lv-note is-warn">{{ t('mapStudio.layers.anchorMissing') }}</p>
        <p v-else-if="!selected.anchorId" class="lv-note dim">{{ t('mapStudio.layers.noAnchor') }}</p>
        <p v-if="selected.geometryChanged" class="lv-note is-warn">{{ t('mapStudio.layers.geometryChanged') }}</p>

        <dl class="lv-facts">
          <div class="lv-fact">
            <dt>{{ t('mapStudio.layers.featureName') }}</dt>
            <dd>{{ selected.featureName ?? t('mapStudio.layers.nameNotRecorded') }}</dd>
          </div>
          <div class="lv-fact">
            <dt>{{ t('mapStudio.layers.category') }}</dt>
            <dd>{{ selected.category ? t('mapStudio.researchPanel.categoryLabel.' + selected.category) : t('mapStudio.researchPanel.unknownValue') }}</dd>
          </div>
          <div class="lv-fact">
            <dt>{{ t('mapStudio.layers.geometry') }}</dt>
            <dd>{{ geometryText }}</dd>
          </div>
          <div class="lv-fact">
            <dt>{{ t('mapStudio.layers.source') }}</dt>
            <dd>{{ selected.source ?? t('mapStudio.layers.sourceNotRecorded') }}</dd>
          </div>
        </dl>

        <p v-if="selected.description" class="lv-description">{{ selected.description }}</p>
        <p v-else class="lv-note dim">{{ selected.manual ? t('mapStudio.layers.manuallyMaintainedNoDescription') : t('mapStudio.layers.noDescription') }}</p>
        <p v-if="selected.manual" class="lv-chip">{{ t('mapStudio.layers.manuallyMaintained') }}</p>
        <p v-if="selected.manual" class="lv-note dim">{{ t('mapStudio.layers.supplementsManual') }}</p>
        <p v-if="selected.nameManual" class="lv-note dim">{{ t('mapStudio.layers.nameManual') }}</p>

        <ul v-if="selected.keywords.length" class="lv-keywords">
          <li v-for="keyword in selected.keywords" :key="keyword" class="lv-chip">{{ keyword }}</li>
        </ul>

        <template v-if="selected.basis || selected.excerpt || selected.sourceTitles.length">
          <strong class="lv-sub">{{ t('mapStudio.layers.evidenceTitle') }}</strong>
          <p v-if="selected.basis" class="lv-note">{{ selected.basis }}</p>
          <p v-if="selected.coordinateBasis" class="lv-note dim">{{ selected.coordinateBasis }}</p>
          <p v-if="selected.excerpt" class="lv-note">「{{ selected.excerpt }}」</p>
          <p v-if="selected.sourceTitles.length" class="lv-note dim">{{ selected.sourceTitles.join(' · ') }}</p>
        </template>
        <p v-else-if="selected.anchorId" class="lv-note dim">{{ t('mapStudio.layers.sourcesNotRecorded') }}</p>
      </section>
    </template>
  </aside>
</template>

<script setup lang="ts">
/**
 * 图层描述查看器（Issue #126 设计 01 §7）：只读。
 *
 * 层 → 要素只按同源快照的 `anchor.semantic_id` 精确匹配；描述/关键词取 #125 的冻结字段，
 * 缺失时降级到几何摘要，不拿 keywords、brief 或当前 props 补历史图。
 */
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapLayerRow, MapLayerViewerModel } from '~/map-studio/utils/mapSnapshot'

const { t } = useI18n()

const props = defineProps<{
  model: MapLayerViewerModel
  selectedId: string | null
  versionTitle: string
}>()

const emit = defineEmits<{
  (e: 'select', layerId: string): void
  (e: 'close'): void
}>()

const selected = computed<MapLayerRow | null>(() => props.model.layers.find(layer => layer.id === props.selectedId) ?? props.model.layers[0] ?? null)

const geometryText = computed(() => {
  const geometry = selected.value?.geometry
  if (!geometry) return ''
  if (geometry.kind === 'point') return geometry.lon === null ? t('mapStudio.layers.pointNoCoordinates') : t('mapStudio.layers.point', { lon: geometry.lon.toFixed(2), lat: Number(geometry.lat).toFixed(2) })
  if (geometry.kind === 'vertices') return t('mapStudio.layers.vertices', { n: geometry.count })
  if (geometry.kind === 'text') return t('mapStudio.layers.text', { text: geometry.text })
  return t('mapStudio.layers.geometryUnknown')
})
</script>

<style scoped>
.lv {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  max-height: 520px;
  overflow: auto;
}
.lv-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.lv-head strong { font: 600 11px var(--font-body); }
.lv-tool {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10px var(--font-body);
  cursor: pointer;
}
.lv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.lv-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 10.5px;
  text-align: left;
  cursor: pointer;
}
.lv-item.is-on { border-color: var(--accent-text); color: var(--accent-text); }
.lv-type, .lv-chip {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  font: 600 9.5px var(--font-body);
}
.lv-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-detail { display: flex; flex-direction: column; gap: 5px; }
.lv-sub { font: 600 10.5px var(--font-body); color: var(--text-1); }
.lv-facts { display: flex; flex-direction: column; gap: 2px; margin: 0; font-size: 10.5px; }
.lv-fact { display: flex; gap: 6px; }
.lv-fact dt { font: 600 10px var(--font-body); color: var(--text-1); white-space: nowrap; }
.lv-fact dd { margin: 0; color: var(--text-2); }
.lv-description { margin: 0; font-size: 11px; color: var(--text-1); white-space: pre-wrap; }
.lv-note { margin: 0; font-size: 10.5px; color: var(--text-2); }
.lv-note.is-warn { color: var(--warn-text); font-weight: 600; }
.lv-empty { margin: 0; }
.lv-keywords { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
</style>
