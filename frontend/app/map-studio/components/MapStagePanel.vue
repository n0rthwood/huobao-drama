<template>
  <section class="msp">
    <header class="msp-head">
      <strong>{{ t('mapStudio.stage.' + stage) }}</strong>
      <span class="dim">{{ t('mapStudio.stagePanel.hint') }}</span>
    </header>

    <div class="msp-grid">
      <section class="msp-block">
        <strong class="msp-sub">{{ t('mapStudio.stagePanel.inputsTitle') }}</strong>
        <p v-if="!inputs.length" class="msp-empty dim">{{ t('mapStudio.stagePanel.noInput') }}</p>
        <ul v-else class="msp-facts">
          <li v-for="item in inputs" :key="item.key">
            <span class="msp-label">{{ item.label }}</span>
            <span class="msp-value">{{ item.value }}</span>
          </li>
        </ul>
      </section>

      <section class="msp-block">
        <strong class="msp-sub">{{ t('mapStudio.stagePanel.outputsTitle') }}</strong>
        <p v-if="!outputFacts.length" class="msp-empty dim">{{ t('mapStudio.stagePanel.noOutput') }}</p>
        <ul v-else class="msp-facts">
          <li v-for="item in outputFacts" :key="item.key">
            <span class="msp-label">{{ item.label }}</span>
            <a v-if="item.href" class="msp-link" :href="item.href" @click.prevent="item.preview ? emit('preview', item.preview) : null">{{ item.value }}</a>
            <span v-else class="msp-value">{{ item.value }}</span>
          </li>
        </ul>
      </section>
    </div>

    <!-- Issue #107：质感底纹阶段保留在流程里但恒不出图，人看到这一步时不至于以为少了产出 -->
    <p v-if="stage === 'style'" class="msp-hint dim">{{ t('mapStudio.results.styleSkipped') }}</p>

    <!-- Issue #107：细节取景框是底图阶段的产出；人换取景框的方式就是回退底图重跑，不另开编辑面板。
         回退会清空 pip（旧框失效），所以这条提示不能依赖 pip 是否存在。 -->
    <p v-if="stage === 'base'" class="msp-hint dim">{{ t('mapStudio.stagePanel.pipRollbackHint') }}</p>

    <section class="msp-block">
      <strong class="msp-sub">{{ t('mapStudio.stagePanel.issuesTitle') }}</strong>
      <p v-if="!detail.issues.length" class="msp-empty dim">{{ t('mapStudio.stagePanel.noIssues') }}</p>
      <ul v-else class="msp-issues">
        <li
          v-for="issue in detail.issues"
          :key="issue.code + issue.field"
          :class="['msp-issue', issue.blocking ? 'is-blocking' : 'is-soft']"
        >
          <span class="msp-issue-field">{{ issue.field || t('mapStudio.stagePanel.issueWhole') }}</span>
          <span>{{ issue.message }}</span>
          <span class="dim">{{ issue.blocking ? t('mapStudio.panel.blockedTitle') : t('mapStudio.panel.noticeTitle') }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<script setup lang="ts">
/**
 * 单阶段面板（Issue #99）：输入、产出、问题。
 *
 * 「输入」是该阶段实际消费的口径（需求字段 / 检索结果 / 底图配准 / 几何与图层文档），
 * 「产出」只列服务端真实存在的文件与研究结果——没有就明说没有，绝不用占位图冒充。
 * 问题来自 detail.issues（服务端判定的阻断与提示），不在这里重算。
 */
import { useI18n } from 'vue-i18n'
import type { MapPipOutput, MapStudioDetail, MapStudioStage } from '~/map-studio/api'
import { registrationFrom, registrationSummary } from '~/map-studio/utils/mapRegistration'
import { PIP_COMPOSITE_VIEW, type MapPreviewView } from '~/map-studio/utils/mapPreview'

const { t } = useI18n()

const props = defineProps<{
  detail: MapStudioDetail
  stage: MapStudioStage
}>()

const emit = defineEmits<{
  (e: 'preview', view: MapPreviewView): void
}>()

interface Fact { key: string, label: string, value: string, href?: string, preview?: MapPreviewView }

const research = computed(() => props.detail.research)
const missingRows = computed(() => research.value?.missing_geometry ?? (research.value?.features ?? []).flatMap(feature => {
  const reason = feature.dataset_missing?.reason ?? feature.verification?.reasons?.find(value => value.includes('dataset_missing'))
  if (!reason || (feature.kind === 'place' ? feature.lon != null && feature.lat != null : (feature.points?.length ?? 0) > 0)) return []
  return [{ name: feature.name, category: feature.category ?? '', queries: feature.dataset_missing?.queries ?? [], reason }]
}))
const outputs = computed(() => props.detail.outputs)
const spec = computed(() => props.detail.map_spec)
const registration = computed(() => {
  const images = outputs.value
  return registrationFrom(images.final_image?.provenance, images.base_image?.provenance)
})

function featureCounts() {
  const places = spec.value?.places?.length ?? 0
  const routes = spec.value?.routes?.length ?? 0
  const regions = spec.value?.regions?.length ?? 0
  return { places, routes, regions }
}

function sizeOf(image: { width: number, height: number } | null | undefined): string {
  return image?.width && image?.height ? t('mapStudio.results.size', { w: image.width, h: image.height }) : t('mapStudio.stagePanel.unknownSize')
}

/** 画中画一句话摘要：细节数 + 版式 id/族 + 标注层级；这些字段都是服务端定的，不在这里推断 */
function pipSummary(pip: MapPipOutput): string {
  return t('mapStudio.pip.factSummary', {
    n: pip.frames.length,
    id: pip.layout.id,
    family: t('mapStudio.pip.family.' + pip.layout.family),
    tier: t('mapStudio.pip.labelTier.' + pip.layout.label_tier),
  })
}

const inputs = computed<Fact[]>(() => {
  const brief = props.detail.brief
  const list: Fact[] = []
  if (props.stage === 'brief') {
    list.push({ key: 'subject', label: t('mapStudio.brief.subject'), value: brief.subject || t('mapStudio.stagePanel.missingValue') })
    list.push({ key: 'era', label: t('mapStudio.brief.era'), value: brief.era || t('mapStudio.stagePanel.missingValue') })
    list.push({ key: 'location', label: t('mapStudio.brief.location'), value: brief.location || t('mapStudio.stagePanel.missingValue') })
    list.push({ key: 'purpose', label: t('mapStudio.brief.purpose'), value: brief.purpose || t('mapStudio.stagePanel.missingValue') })
    list.push({ key: 'detail', label: t('mapStudio.brief.detailLevel'), value: t('mapStudio.brief.detail.' + brief.detail_level) })
    list.push({ key: 'base', label: t('mapStudio.brief.baseMode'), value: t('mapStudio.baseMode.' + brief.base_mode) })
    return list
  }
  if (props.stage === 'research') {
    list.push({ key: 'subject', label: t('mapStudio.brief.subject'), value: brief.subject || t('mapStudio.stagePanel.missingValue') })
    list.push({ key: 'location', label: t('mapStudio.brief.location'), value: brief.location || t('mapStudio.stagePanel.missingValue') })
    list.push({ key: 'era', label: t('mapStudio.brief.era'), value: brief.era || t('mapStudio.stagePanel.missingValue') })
    if (research.value) {
      list.push({ key: 'queries', label: t('mapStudio.stagePanel.queries'), value: String(research.value.queries.length) })
      list.push({ key: 'searched', label: t('mapStudio.results.searchedAt', { at: research.value.searched_at }), value: t('mapStudio.stagePanel.sourcesCount', { n: research.value.sources.length }) })
      if (research.value.extent) {
        list.push({ key: 'extent', label: t('mapStudio.researchPanel.extent'), value: research.value.extent.map(n => Number(n).toFixed(2)).join(' / ') })
      }
      if (research.value.dataset_queries) {
        list.push({ key: 'datasetQueries', label: t('mapStudio.researchPanel.datasetQueries'), value: String(research.value.dataset_queries.length) })
      }
    }
    return list
  }
  if (props.stage === 'base') {
    list.push({ key: 'mode', label: t('mapStudio.brief.baseMode'), value: t('mapStudio.baseMode.' + brief.base_mode) })
    const bbox = spec.value?.bbox
    if (bbox) list.push({ key: 'bbox', label: t('mapStudio.stagePanel.bbox'), value: bbox.map(n => Number(n).toFixed(2)).join(' / ') })
    list.push({ key: 'projection', label: t('mapStudio.stagePanel.projection'), value: spec.value?.projection?.type ?? t('mapStudio.stagePanel.missingValue') })
    const counts = featureCounts()
    list.push({ key: 'features', label: t('mapStudio.stagePanel.features'), value: t('mapStudio.stagePanel.featureCounts', counts) })
    return list
  }
  if (props.stage === 'style') {
    list.push({ key: 'style', label: t('mapStudio.brief.style'), value: t('mapStudio.brief.styleOption.' + brief.style) })
    list.push({ key: 'base', label: t('mapStudio.results.base_image'), value: outputs.value.base_image ? sizeOf(outputs.value.base_image) : t('mapStudio.stagePanel.noArtifact') })
    return list
  }
  if (props.stage === 'drawing') {
    const counts = featureCounts()
    list.push({ key: 'features', label: t('mapStudio.stagePanel.features'), value: t('mapStudio.stagePanel.featureCounts', counts) })
    const layers = (outputs.value.layer_doc?.layers as unknown[] | undefined)?.length
    list.push({ key: 'layers', label: t('mapStudio.stagePanel.layers'), value: typeof layers === 'number' ? String(layers) : t('mapStudio.stagePanel.noArtifact') })
    if (registration.value) {
      list.push({ key: 'registration', label: t('mapStudio.results.provenanceTitle'), value: registrationSummary(registration.value) })
    }
    return list
  }
  const counts = featureCounts()
  list.push({ key: 'features', label: t('mapStudio.stagePanel.features'), value: t('mapStudio.stagePanel.featureCounts', counts) })
  list.push({ key: 'deliveries', label: t('mapStudio.deliveries.title'), value: String(props.detail.deliveries.length) })
  return list
})

const outputFacts = computed<Fact[]>(() => {
  const list: Fact[] = []
  const images = outputs.value
  if (props.stage === 'brief') {
    return props.detail.brief.inferred.map(item => ({ key: item.field, label: item.field, value: `${item.value} · ${item.basis}` }))
  }
  if (props.stage === 'research') {
    if (research.value) {
      list.push({ key: 'sources', label: t('mapStudio.results.sourcesTitle', { n: research.value.sources.length }), value: t('mapStudio.stagePanel.sourcesCount', { n: research.value.sources.length }) })
      const counts = {
        places: research.value.features.filter(f => f.kind === 'place').length,
        routes: research.value.features.filter(f => f.kind === 'route').length,
        regions: research.value.features.filter(f => f.kind === 'region').length,
      }
      list.push({ key: 'features', label: t('mapStudio.results.featuresTitle', { n: research.value.features.length }), value: t('mapStudio.stagePanel.featureCounts', counts) })
    }
    return list
  }
  if (props.stage === 'base' && images.base_image) {
    list.push({ key: 'base', label: t('mapStudio.results.base_image'), value: sizeOf(images.base_image), href: '#', preview: 'base' })
    if (images.kmz) list.push({ key: 'kmz', label: 'KMZ', value: images.kmz.path })
    if (images.pip) list.push({ key: 'pip', label: t('mapStudio.pip.title'), value: pipSummary(images.pip) })
  }
  if (props.stage === 'style' && images.texture_image) {
    list.push({ key: 'texture', label: t('mapStudio.results.texture_image'), value: sizeOf(images.texture_image), href: '#', preview: 'texture' })
  }
  if ((props.stage === 'drawing' || props.stage === 'complete') && images.final_image) {
    list.push({ key: 'final', label: t('mapStudio.results.final_image'), value: sizeOf(images.final_image), href: '#', preview: 'final' })
  }
  if (props.stage === 'complete' && images.kmz) {
    list.push({ key: 'kmz', label: 'KMZ', value: images.kmz.path })
  }
  // 画中画只列真实存在的文件：细节图/组合图在「完成」登记时渲染，没渲染就写 0，不给一个点不开的链接
  if (props.stage === 'complete' && images.pip) {
    list.push({ key: 'pip', label: t('mapStudio.pip.title'), value: pipSummary(images.pip) })
    list.push({ key: 'pipDetails', label: t('mapStudio.pip.detailsTitle'), value: t('mapStudio.pip.renderedDetails', { n: images.pip.details.length }) })
    if (images.pip.composite) {
      list.push({ key: 'pipComposite', label: t('mapStudio.pip.compositeTitle'), value: sizeOf(images.pip.composite), href: '#', preview: PIP_COMPOSITE_VIEW })
    }
  }
  return list
})

</script>

<style scoped>
.msp { display: flex; flex-direction: column; gap: 8px; }
.msp-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.msp-head strong { font: 600 12px var(--font-body); }
.msp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px; }
.msp-block { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.msp-sub { font: 600 11px var(--font-body); color: var(--text-1); }
.msp-empty { margin: 0; font-size: 10.5px; }
.msp-hint { margin: 0; font-size: 10.5px; }
.msp-facts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-2); }
.msp-facts li { display: flex; flex-wrap: wrap; gap: 6px; }
.msp-label { font: 600 10.5px var(--font-body); color: var(--text-2); }
.msp-value { color: var(--text-1); word-break: break-word; }
.msp-link { color: var(--accent-text); text-decoration: none; }
.msp-link:hover { text-decoration: underline; }
.msp-issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.msp-issue { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 8px; border-radius: 6px; font-size: 10.5px; }
.msp-issue.is-blocking { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); }
.msp-issue.is-soft { border: 1px solid var(--border); color: var(--text-2); }
.msp-issue-field { font: 600 10.5px var(--font-body); }
.msp-research { gap: 6px; }
.msp-research-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
.msp-banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 9px;
  border-radius: 7px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font-size: 10.5px;
}
.msp-banner-body { margin: 0; }
.msp-banner-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.msp-btn {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--warn-border);
  background: transparent;
  color: inherit;
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.msp-btn:hover:not(:disabled) { border-color: currentColor; }
.msp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.msp-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.msp-table th {
  text-align: left;
  padding: 3px 6px;
  border-bottom: 1px solid var(--border);
  color: var(--text-2);
  font: 600 10px var(--font-body);
  white-space: nowrap;
}
.msp-table td { padding: 3px 6px; border-bottom: 1px solid var(--border); color: var(--text-1); vertical-align: top; }
.msp-table tr.is-pending td { background: var(--warn-bg); }
.msp-col-pick { width: 26px; text-align: center; }
.msp-feature-name { font-weight: 600; }
.msp-feature-kind { margin-left: 4px; }
.msp-pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-weight: 600;
  white-space: nowrap;
}
.msp-pill.is-origin-dataset { border-color: var(--accent-text); color: var(--accent-text); }
.msp-pill.is-origin-source { border-color: #3f9f6f; color: #3f9f6f; }
.msp-pill.is-origin-model { border-color: #b07a2f; color: #b07a2f; }
.msp-pill.is-origin-manual { border-color: #7a7fa8; color: #7a7fa8; }
.msp-pill.is-status-verified { border-color: #3f9f6f; color: #3f9f6f; }
.msp-pill.is-status-confirmed { border-color: #3f9f6f; color: #3f9f6f; }
.msp-pill.is-status-unverified { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.msp-pill.is-status-conflict { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
.msp-pill.is-status-needs_user { border-color: #b07a2f; color: #b07a2f; }
.msp-evidence { display: flex; flex-direction: column; gap: 2px; }
.msp-dataset { color: var(--accent-text); word-break: break-all; }
.msp-reasons { color: var(--text-2); word-break: break-word; }
.msp-excerpt { color: var(--text-2); word-break: break-word; }
</style>
