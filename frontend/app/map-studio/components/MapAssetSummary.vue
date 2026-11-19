<template>
  <section class="asset" :class="{ 'is-compact': compact }">
    <header class="asset-head">
      <strong>{{ t('mapStudio.asset.title') }}</strong>
      <span class="asset-sub dim">{{ detail.title }}</span>
      <button type="button" class="asset-tool" @click="editing = !editing">
        <PenLine :size="11" />
        {{ editing ? t('mapStudio.asset.closeEdit') : t('mapStudio.asset.editBrief') }}
      </button>
    </header>

    <dl class="asset-facts">
      <div class="asset-fact">
        <dt>{{ t('mapStudio.brief.subject') }}</dt>
        <dd>{{ brief.subject || t('mapStudio.asset.missingValue') }}</dd>
      </div>
      <div class="asset-fact">
        <dt>{{ t('mapStudio.brief.era') }}</dt>
        <dd>{{ brief.era || t('mapStudio.asset.missingValue') }}</dd>
      </div>
      <div class="asset-fact">
        <dt>{{ t('mapStudio.brief.location') }}</dt>
        <dd>{{ brief.location || t('mapStudio.asset.missingValue') }}</dd>
      </div>
      <div class="asset-fact">
        <dt>{{ t('mapStudio.brief.purpose') }}</dt>
        <dd>{{ brief.purpose || t('mapStudio.asset.missingValue') }}</dd>
      </div>
      <div class="asset-fact">
        <dt>{{ t('mapStudio.asset.detailLevel') }}</dt>
        <dd>{{ t('mapStudio.brief.detail.' + brief.detail_level) }}</dd>
      </div>
      <div class="asset-fact">
        <dt>{{ t('mapStudio.asset.baseMode') }}</dt>
        <dd>{{ t('mapStudio.baseMode.' + brief.base_mode) }}</dd>
      </div>
    </dl>

    <section class="asset-host">
      <strong class="asset-sub">{{ t('mapStudio.asset.hostTitle') }}</strong>
      <p class="asset-note dim">{{ t('mapStudio.asset.hostHint') }}</p>
      <p v-if="hostMissing" class="asset-note">{{ t('mapStudio.host.notProvided') }}</p>
      <template v-else>
        <p v-if="detail.host?.target?.description" class="asset-note">{{ detail.host.target.description }}</p>
        <p v-else class="asset-note dim">{{ t('mapStudio.host.notProvided') }}</p>
        <ul v-if="hostRefs.length" class="asset-refs">
          <li v-for="url in hostRefs" :key="url">
            <img :src="url" :alt="t('mapStudio.asset.hostReference')" loading="lazy" />
          </li>
        </ul>
      </template>
      <figure v-if="brief.reference_image" class="asset-geref">
        <img :src="mediaUrl(brief.reference_image.path)" :alt="t('mapStudio.asset.taskReference')" loading="lazy" />
        <figcaption class="dim">{{ brief.reference_image.source_url }} · {{ brief.reference_image.license }}</figcaption>
      </figure>
      <p v-else class="asset-note dim">{{ t('mapStudio.asset.taskReferenceMissing') }}</p>
    </section>

    <section v-if="editing" class="asset-edit">
      <header class="asset-edit-head">
        <strong>{{ t('mapStudio.asset.editBrief') }}</strong>
        <button type="button" class="asset-tool" :disabled="disabled || !briefDirty" @click="emit('save')">
          {{ t('mapStudio.action.saveBrief') }}
        </button>
        <button type="button" class="asset-tool" :disabled="disabled || !briefDirty" @click="emit('discard')">
          {{ t('mapStudio.panel.discard') }}
        </button>
      </header>
      <p v-if="briefDirty" class="asset-note is-warn">{{ t('mapStudio.asset.draftUnsaved') }}</p>
      <MapBriefForm :brief="brief" :issues="issues" :disabled="disabled" @patch="emit('patch', $event)" />
    </section>
  </section>
</template>

<script setup lang="ts">
/**
 * ① 资产信息（Issue #126 设计 01 §3.1 / §7.2）：需求摘要 + 宿主只读信息 + 参考图。
 *
 * 宿主描述与参考图只读来自 `detail.host.target.description/reference_images`；宿主未供给时
 * 显示「宿主信息未提供」，绝不拿 brief.notes 冒充。任务配准参考图（brief.reference_image）另列。
 * 需求表单收起在默认布局里，展开时只改需求，不挤占点线面区域。
 */
import { PenLine } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { MapBrief, MapStudioDetail, MapStudioIssue } from '~/map-studio/api'
import MapBriefForm from '~/map-studio/components/MapBriefForm.vue'
import { mediaUrl } from '~/utils/url'

const { t } = useI18n()

const props = defineProps<{
  detail: MapStudioDetail
  brief: MapBrief
  issues: MapStudioIssue[]
  disabled?: boolean
  briefDirty?: boolean
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'patch', patch: Partial<MapBrief>): void
  (e: 'save'): void
  (e: 'discard'): void
}>()

const editing = ref(false)
const hostMissing = computed(() => !!props.detail.host && !props.detail.host.target)
const hostRefs = computed(() => (props.detail.host?.target?.reference_images ?? []).map(url => mediaUrl(url)))

/** 动作条「补全需求 / 修复底图」只展开表单，不发 run、不改任何字段。 */
defineExpose({ openEdit: () => { editing.value = true } })
</script>

<style scoped>
.asset { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.asset-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.asset-head strong { font: 600 11px var(--font-body); }
.asset-sub { font: 600 10.5px var(--font-body); color: var(--text-1); }
.asset-tool {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.asset-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.asset-tool:disabled { opacity: .5; cursor: not-allowed; }
.asset-head .asset-tool { margin-left: auto; }
.asset-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 4px 10px; margin: 0; font-size: 10.5px; }
.asset-fact { display: flex; gap: 6px; min-width: 0; }
.asset-fact dt { font: 600 10px var(--font-body); color: var(--text-2); white-space: nowrap; }
.asset-fact dd { margin: 0; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-host { display: flex; flex-direction: column; gap: 4px; }
.asset-note { margin: 0; font-size: 10.5px; color: var(--text-1); }
.asset-note.is-warn { color: var(--warn-text); font: 600 10.5px var(--font-body); }
.asset-refs { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.asset-refs img { width: 72px; height: 72px; object-fit: cover; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }
.asset-geref { margin: 0; display: flex; flex-direction: column; gap: 3px; }
.asset-geref img { max-width: 160px; max-height: 120px; object-fit: contain; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }
.asset-geref figcaption { font-size: 9.5px; word-break: break-all; }
.asset-edit { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.asset-edit-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; }
</style>
