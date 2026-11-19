<template>
  <!-- 阶段 ②：研究要素的来源/核验与相对位置证据。条目一律取当前 map_spec 的元数据，
         不拿历史 research 里的提议对象冒充现状；确认走 PUT map_spec 的 CAS。 -->
    <section id="map-pending-geometry" class="review" v-if="pendingRows.length || missingRows.length || (research?.features?.length ?? 0) > 0">
      <header class="mgr-head">
        <strong class="mgr-sub">{{ t('mapStudio.researchPanel.reviewTitle') }}</strong>
        <span class="dim">{{ t('mapStudio.researchPanel.reviewHint') }}</span>
      </header>

      <div v-if="pendingRows.length" class="mgr-banner">
        <strong>{{ t('mapStudio.researchPanel.unverifiedTitle', { n: pendingRows.length }) }}</strong>
        <p class="mgr-note">{{ t('mapStudio.researchPanel.reviewHint') }}</p>
        <div class="mgr-banner-actions">
          <button type="button" class="mgr-btn" :disabled="confirming || !selectedCount" @click="confirmSelected">
            {{ t('mapStudio.researchPanel.confirmSelected', { n: selectedCount }) }}
          </button>
          <button type="button" class="mgr-btn" :disabled="confirming || !confirmableRows.length" @click="confirmAll">
            {{ t('mapStudio.researchPanel.confirmAll') }}
          </button>
        </div>
      </div>
      <details v-for="item in missingRows" :key="item.name" class="mgr-banner">
        <summary>{{ item.name }} — {{ t('mapStudio.researchPanel.notDrawn') }}</summary>
        <p>{{ item.reason }}</p>
        <p>{{ item.queries.join('、') }}</p>
      </details>

      <p v-if="!featureRows.length" class="mgr-empty dim">{{ t('mapStudio.researchPanel.noFeatures') }}</p>
      <table v-else class="mgr-table">
        <thead>
          <tr>
            <th class="mgr-col-pick">{{ t('mapStudio.researchPanel.pick') }}</th>
            <th>{{ t('mapStudio.researchPanel.name') }}</th>
            <th>{{ t('mapStudio.researchPanel.category') }}</th>
            <th>{{ t('mapStudio.researchPanel.origin') }}</th>
            <th>{{ t('mapStudio.researchPanel.verification') }}</th>
            <th>{{ t('mapStudio.researchPanel.evidence') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in featureRows" :key="row.key" :class="{ 'is-pending': row.pending }">
            <td class="mgr-col-pick">
              <input
                v-if="row.pending && !row.reasons.some(reason => reason.includes('dataset_missing'))"
                type="checkbox"
                :checked="selectedKeys.has(row.key)"
                :disabled="confirming"
                :aria-label="t('mapStudio.researchPanel.pick')"
                @change="toggle(row.key)"
              />
              <span v-else class="dim">·</span>
            </td>
            <td>
              <button type="button" class="mgr-feature-name" @click="emit('focus', { kind: row.kind, id: row.id })">{{ row.name }}</button>
              <span class="dim mgr-feature-kind">{{ t('mapStudio.results.kind.' + row.kind) }}</span>
            </td>
            <td>
              <span v-if="row.category" class="mgr-pill">{{ t('mapStudio.researchPanel.categoryLabel.' + row.category) }}</span>
              <span v-else class="dim">{{ t('mapStudio.researchPanel.unknownValue') }}</span>
            </td>
            <td>
              <span v-if="row.origin" class="mgr-pill" :class="'is-origin-' + row.origin">{{ t('mapStudio.researchPanel.originLabel.' + row.origin) }}</span>
              <span v-else class="dim">{{ t('mapStudio.researchPanel.unknownValue') }}</span>
            </td>
            <td>
              <span v-if="row.verification" class="mgr-pill" :class="'is-status-' + row.verification.status">{{ t('mapStudio.researchPanel.statusLabel.' + row.verification.status) }}</span>
              <span v-else class="dim">{{ t('mapStudio.researchPanel.unknownValue') }}</span>
            </td>
            <td class="mgr-evidence">
              <span v-if="row.datasetRef" class="mgr-dataset">{{ t('mapStudio.researchPanel.datasetRef', { ref: row.datasetRef }) }}</span>
              <span v-if="row.pending" class="mgr-reasons">{{ row.reasons.some(reason => reason.includes('dataset_missing')) ? t('mapStudio.researchPanel.notDrawn') : t('mapStudio.researchPanel.schematic') }}</span>
              <span v-if="row.reasons.length" class="mgr-reasons">{{ row.reasons.join('；') }}</span>
              <span v-if="!row.reasons.length && !row.datasetRef" class="dim">{{ t('mapStudio.researchPanel.noEvidence') }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <strong class="mgr-sub">{{ t('mapStudio.researchPanel.relationsTitle', { n: relationRows.length }) }}</strong>
      <p v-if="!relationRows.length" class="mgr-empty dim">{{ t('mapStudio.researchPanel.noRelations') }}</p>
      <table v-else class="mgr-table">
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
              <span v-else class="mgr-pill" :class="relation.computed.consistent ? 'is-status-verified' : 'is-status-conflict'">
                {{ relation.computed.consistent ? t('mapStudio.researchPanel.consistent') : t('mapStudio.researchPanel.inconsistent') }}
              </span>
            </td>
            <td class="mgr-excerpt">「{{ relation.excerpt }}」</td>
          </tr>
        </tbody>
      </table>
  </section>
</template>


<script setup lang="ts">
/**
 * 阶段 ② 核对清单（Issue #126 设计 01 §4.2）：地点/线/面条目、来源核验与相对位置证据。
 *
 * 这里是核对阶段③的一部分：条目一律取当前 map_spec 的元数据（不拿历史 research 的提议冒充现状），
 * 勾选只是挑选，确认走页面统一的 PUT map_spec CAS；组件自己不保存、不运行。
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
  MapVerification,
} from '~/map-studio/api'
import { mapPendingGeometry, mapSpecFeatureKey } from '~/map-studio/api'

const { t } = useI18n()

const props = defineProps<{
  detail: MapStudioDetail
  confirming?: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm', targets: MapConfirmTarget[]): void
  (e: 'focus', target: MapConfirmTarget): void
}>()

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

const research = computed(() => props.detail.research)
const missingRows = computed(() => research.value?.missing_geometry ?? (research.value?.features ?? []).flatMap(feature => {
  const reason = feature.dataset_missing?.reason ?? feature.verification?.reasons?.find(value => value.includes('dataset_missing'))
  if (!reason || (feature.kind === 'place' ? feature.lon != null && feature.lat != null : (feature.points?.length ?? 0) > 0)) return []
  return [{ name: feature.name, category: feature.category ?? '', queries: feature.dataset_missing?.queries ?? [], reason }]
}))
const spec = computed(() => props.detail.map_spec)

const pendingRows = computed(() => mapPendingGeometry(spec.value))
const confirmableRows = computed(() => pendingRows.value.filter(row => !row.reasons.some(reason => reason.includes('dataset_missing'))))
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

// 服务端回执（保存成功）后待确认集合变小，把已确认的键从选择里去掉；保存失败时集合不变，选择原样保留。
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
  if (props.confirming || !confirmableRows.value.length) return
  emit('confirm', confirmableRows.value.map(row => ({ kind: row.kind, id: row.id })))
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
</script>

<style scoped>
.review { display: flex; flex-direction: column; gap: 6px; }
.mgr-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--text-1); }
.mgr-sub { font: 600 10.5px var(--font-body); color: var(--text-1); }
.mgr-banner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--warn-border);
  border-radius: 6px;
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 10.5px;
}
.mgr-banner p { margin: 0; }
.mgr-banner-actions { display: flex; gap: 6px; }
.mgr-btn {
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10px var(--font-body);
  cursor: pointer;
}
.mgr-btn:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.mgr-btn:disabled { opacity: .5; cursor: not-allowed; }
.mgr-empty { margin: 0; }
.mgr-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.mgr-table th, .mgr-table td { text-align: left; padding: 3px 5px; border-bottom: 1px solid var(--border); vertical-align: top; }
.mgr-table th { font: 600 10px var(--font-body); color: var(--text-2); }
.mgr-table tr.is-pending { background: var(--surface-soft); }
.mgr-col-pick { width: 22px; }
.mgr-feature-name { border: 0; background: transparent; padding: 0; color: var(--accent-text); font: 600 10.5px var(--font-body); cursor: pointer; }
.mgr-feature-kind { margin-left: 4px; }
.mgr-pill { padding: 0 6px; border-radius: 999px; border: 1px solid var(--border-strong); font: 600 9.5px var(--font-body); }
.mgr-evidence { display: flex; flex-direction: column; gap: 2px; }
.mgr-dataset, .mgr-reasons { font-size: 10px; }
.mgr-excerpt { max-width: 320px; word-break: break-word; }
</style>
