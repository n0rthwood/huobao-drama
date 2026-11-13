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

    <!-- 阶段 ②：研究要素的来源/核验与相对位置证据。条目一律取当前 map_spec 的元数据，
         不拿历史 research 里的提议对象冒充现状；确认走 PUT map_spec 的 CAS。 -->
    <section v-if="stage === 'research' && research" class="msp-block msp-research">
      <header class="msp-research-head">
        <strong class="msp-sub">{{ t('mapStudio.researchPanel.title') }}</strong>
        <span class="dim">{{ t('mapStudio.researchPanel.hint') }}</span>
      </header>

      <div v-if="pendingRows.length" class="msp-banner">
        <strong>{{ t('mapStudio.researchPanel.unverifiedTitle', { n: pendingRows.length }) }}</strong>
        <p class="msp-banner-body">{{ t('mapStudio.researchPanel.unverifiedHint') }}</p>
        <div class="msp-banner-actions">
          <button type="button" class="msp-btn" :disabled="confirming || !selectedCount" @click="confirmSelected">
            {{ t('mapStudio.researchPanel.confirmSelected', { n: selectedCount }) }}
          </button>
          <button type="button" class="msp-btn" :disabled="confirming" @click="confirmAll">
            {{ t('mapStudio.researchPanel.confirmAll') }}
          </button>
        </div>
      </div>

      <p v-if="!featureRows.length" class="msp-empty dim">{{ t('mapStudio.researchPanel.noFeatures') }}</p>
      <table v-else class="msp-table">
        <thead>
          <tr>
            <th class="msp-col-pick">{{ t('mapStudio.researchPanel.pick') }}</th>
            <th>{{ t('mapStudio.researchPanel.name') }}</th>
            <th>{{ t('mapStudio.researchPanel.category') }}</th>
            <th>{{ t('mapStudio.researchPanel.origin') }}</th>
            <th>{{ t('mapStudio.researchPanel.verification') }}</th>
            <th>{{ t('mapStudio.researchPanel.evidence') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in featureRows" :key="row.key" :class="{ 'is-pending': row.pending }">
            <td class="msp-col-pick">
              <input
                v-if="row.pending"
                type="checkbox"
                :checked="selectedKeys.has(row.key)"
                :disabled="confirming"
                :aria-label="t('mapStudio.researchPanel.pick')"
                @change="toggle(row.key)"
              />
              <span v-else class="dim">·</span>
            </td>
            <td>
              <span class="msp-feature-name">{{ row.name }}</span>
              <span class="dim msp-feature-kind">{{ t('mapStudio.results.kind.' + row.kind) }}</span>
            </td>
            <td>
              <span v-if="row.category" class="msp-pill">{{ t('mapStudio.researchPanel.categoryLabel.' + row.category) }}</span>
              <span v-else class="dim">{{ t('mapStudio.researchPanel.unknownValue') }}</span>
            </td>
            <td>
              <span v-if="row.origin" class="msp-pill" :class="'is-origin-' + row.origin">{{ t('mapStudio.researchPanel.originLabel.' + row.origin) }}</span>
              <span v-else class="dim">{{ t('mapStudio.researchPanel.unknownValue') }}</span>
            </td>
            <td>
              <span v-if="row.verification" class="msp-pill" :class="'is-status-' + row.verification.status">{{ t('mapStudio.researchPanel.statusLabel.' + row.verification.status) }}</span>
              <span v-else class="dim">{{ t('mapStudio.researchPanel.unknownValue') }}</span>
            </td>
            <td class="msp-evidence">
              <span v-if="row.datasetRef" class="msp-dataset">{{ t('mapStudio.researchPanel.datasetRef', { ref: row.datasetRef }) }}</span>
              <span v-if="row.reasons.length" class="msp-reasons">{{ row.reasons.join('；') }}</span>
              <span v-if="!row.reasons.length && !row.datasetRef" class="dim">{{ t('mapStudio.researchPanel.noEvidence') }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <strong class="msp-sub">{{ t('mapStudio.researchPanel.relationsTitle', { n: relationRows.length }) }}</strong>
      <p v-if="!relationRows.length" class="msp-empty dim">{{ t('mapStudio.researchPanel.noRelations') }}</p>
      <table v-else class="msp-table">
        <thead>
          <tr>
            <th>{{ t('mapStudio.researchPanel.relationSubject') }}</th>
            <th>{{ t('mapStudio.researchPanel.relationKind') }}</th>
            <th>{{ t('mapStudio.researchPanel.declared') }}</th>
            <th>{{ t('mapStudio.researchPanel.computed') }}</th>
            <th>{{ t('mapStudio.researchPanel.consistency') }}</th>
            <th>{{ t('mapStudio.researchPanel.excerpt') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="relation in relationRows" :key="relation.id">
            <td>{{ relation.subject }} → {{ relation.object }}</td>
            <td>{{ t('mapStudio.researchPanel.relationLabel.' + relation.relation) }}</td>
            <td>
              <span>{{ declaredValue(relation) }}</span>
              <span v-if="relation.tolerance_km !== undefined" class="dim">{{ t('mapStudio.researchPanel.tolerance', { km: relation.tolerance_km }) }}</span>
            </td>
            <td>{{ computedValue(relation) }}</td>
            <td>
              <span v-if="!relation.computed" class="dim">{{ t('mapStudio.researchPanel.notComputed') }}</span>
              <span v-else class="msp-pill" :class="relation.computed.consistent ? 'is-status-verified' : 'is-status-conflict'">
                {{ relation.computed.consistent ? t('mapStudio.researchPanel.consistent') : t('mapStudio.researchPanel.inconsistent') }}
              </span>
            </td>
            <td class="msp-excerpt">「{{ relation.excerpt }}」</td>
          </tr>
        </tbody>
      </table>
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
import type {
  MapConfirmTarget,
  MapFeatureCategory,
  MapFeatureOrigin,
  MapPlace,
  MapRegion,
  MapRelation,
  MapRoute,
  MapSpecFeatureKind,
  MapStudioDetail,
  MapStudioStage,
  MapVerification,
} from '~/map-studio/api'
import { mapPendingGeometry, mapSpecFeatureKey } from '~/map-studio/api'
import { registrationFrom, registrationSummary } from '~/map-studio/utils/mapRegistration'
import type { MapPreviewView } from '~/map-studio/utils/mapPreview'

const { t } = useI18n()

const props = defineProps<{
  detail: MapStudioDetail
  stage: MapStudioStage
  /** 确认请求在途：按钮禁用，选择保留 */
  confirming?: boolean
}>()

const emit = defineEmits<{
  (e: 'preview', view: MapPreviewView): void
  (e: 'confirm', targets: MapConfirmTarget[]): void
}>()

interface Fact { key: string, label: string, value: string, href?: string, preview?: MapPreviewView }

const research = computed(() => props.detail.research)
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

/**
 * 研究要素一览：来源徽标、核验状态、原因。数据一律取当前 map_spec 条目的元数据
 * （数据集多段要素在 map_spec 里拆成 `name (i/N)`，每段独立一行、独立确认），
 * research 只补它的 dataset_queries / extent / 关系证据。
 */
interface FeatureRow {
  key: string
  kind: MapSpecFeatureKind
  id: string
  name: string
  category?: MapFeatureCategory
  origin?: MapFeatureOrigin
  verification?: MapVerification
  datasetRef?: string
  reasons: string[]
  pending: boolean
}

const pendingRows = computed(() => mapPendingGeometry(spec.value))
const pendingKeys = computed(() => new Set(pendingRows.value.map(row => mapSpecFeatureKey(row.kind, row.id))))

function specRow(kind: MapSpecFeatureKind, item: MapPlace | MapRoute | MapRegion): FeatureRow {
  const key = mapSpecFeatureKey(kind, item.id)
  return {
    key,
    kind,
    id: item.id,
    name: item.name,
    category: item.category,
    origin: item.origin,
    verification: item.verification,
    datasetRef: item.dataset_ref?.ref,
    reasons: item.verification?.reasons ?? [],
    pending: pendingKeys.value.has(key),
  }
}

const featureRows = computed<FeatureRow[]>(() => {
  const current = spec.value
  if (!current) return []
  return [
    ...(current.places ?? []).map(item => specRow('place', item)),
    ...(current.routes ?? []).map(item => specRow('route', item)),
    ...(current.regions ?? []).map(item => specRow('region', item)),
  ]
})

const selectedKeys = ref<Set<string>>(new Set())
const selectedCount = computed(() => featureRows.value.filter(row => row.pending && selectedKeys.value.has(row.key)).length)

function toggle(key: string) {
  const next = new Set(selectedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}

// 服务端回执（保存成功）后待确认集合变小，把已确认的键从选择里去掉；
// 保存失败时集合不变，用户的选择原样保留。
watch(pendingKeys, (keys) => {
  const kept = new Set([...selectedKeys.value].filter(key => keys.has(key)))
  if (kept.size !== selectedKeys.value.size) selectedKeys.value = kept
})

/** 确认 = PUT map_spec 去掉 proposed（CAS）；真正的核验结论与闸门都在服务端 */
function confirmSelected() {
  if (props.confirming) return
  const rows = featureRows.value.filter(row => row.pending && selectedKeys.value.has(row.key))
  if (!rows.length) return
  emit('confirm', rows.map(row => ({ kind: row.kind, id: row.id })))
}

function confirmAll() {
  if (props.confirming || !pendingRows.value.length) return
  emit('confirm', pendingRows.value.map(row => ({ kind: row.kind, id: row.id })))
}

/** 声明 vs 计算：两张表都只呈现服务端给的 relation 对象，缺 computed 就写「未计算」 */
const relationRows = computed<MapRelation[]>(() => {
  const seen = new Map<string, MapRelation>()
  const push = (relation: MapRelation | undefined) => {
    if (!relation?.id || seen.has(relation.id)) return
    seen.set(relation.id, relation)
  }
  for (const relation of research.value?.relations ?? []) push(relation)
  for (const entry of [...(spec.value?.places ?? []), ...(spec.value?.routes ?? []), ...(spec.value?.regions ?? [])]) {
    for (const relation of entry.relations ?? []) push(relation)
  }
  return [...seen.values()]
})

function declaredValue(relation: MapRelation): string {
  if (relation.relation === 'distance_km') {
    return relation.value_km !== undefined
      ? t('mapStudio.researchPanel.km', { km: relation.value_km })
      : t('mapStudio.researchPanel.unknownValue')
  }
  return t('mapStudio.researchPanel.relationLabel.' + relation.relation)
}

function computedValue(relation: MapRelation): string {
  const computed = relation.computed
  if (!computed) return t('mapStudio.researchPanel.notComputed')
  if (computed.value_km !== undefined) return t('mapStudio.researchPanel.km', { km: computed.value_km.toFixed(2) })
  return computed.consistent
    ? t('mapStudio.researchPanel.directionConsistent')
    : t('mapStudio.researchPanel.directionOpposite')
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
