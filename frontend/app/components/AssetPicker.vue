<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="close">
      <div class="dialog ap-dialog" role="dialog" aria-modal="true" :aria-label="t('episode.design.picker.title')">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ t('episode.design.picker.title') }}</h2>
          <input
            class="input ap-search"
            type="search"
            :value="keyword"
            :placeholder="t('episode.design.picker.search')"
            @input="keyword = $event.target.value"
          >
          <button class="btn btn-ghost btn-icon" :aria-label="t('episode.design.picker.cancel')" @click="close">
            <X :size="14" />
          </button>
        </header>

        <div class="dialog-body ap-body">
          <nav class="ap-rail">
            <button
              v-for="type in TYPES"
              :key="type"
              type="button"
              :class="['ap-rail-item', { on: railType === type }]"
              :aria-pressed="railType === type"
              @click="railType = type"
            >
              <span>{{ t(`episode.design.picker.${type}`) }}</span>
              <span class="ap-rail-count mono">{{ countOf(type) }}</span>
            </button>
          </nav>

          <!-- 素材网格：语义模式下点卡片进入该素材的条目列表 -->
          <section v-if="!drillAsset" class="ap-main">
            <div v-if="filtered.length" class="ap-grid">
              <button
                v-for="asset in filtered"
                :key="`${asset.kind}:${asset.id}`"
                type="button"
                :class="['ap-card', { on: isAssetPicked(asset) }]"
                :aria-pressed="isAssetPicked(asset)"
                @click="onAssetClick(asset)"
              >
                <span class="ap-card-media">
                  <img v-if="asset.image" :src="mediaUrl(asset.image)" :alt="asset.name" loading="lazy">
                  <span v-else class="ap-card-noimg">{{ t(`episode.design.assetKind.${asset.kind}`) }}</span>
                  <span v-if="asset.faithful" class="ap-card-badge" :title="t('episode.design.picker.verified')">
                    <ShieldCheck :size="11" />
                  </span>
                </span>
                <span class="ap-card-name" :title="asset.name">{{ asset.name }}</span>
                <span class="ap-card-kind dim">{{ t(`episode.design.assetKind.${asset.kind}`) }}</span>
              </button>
            </div>
            <div v-else class="ap-empty">
              <p>{{ hasAnyAsset ? t('episode.design.picker.empty') : t('episode.design.picker.emptyAsset') }}</p>
              <button class="btn btn-sm" @click="gotoAssets()">{{ t('episode.design.picker.gotoAssets') }}</button>
            </div>
          </section>

          <!-- 语义条目列表 + 右侧小图实时高亮 -->
          <section v-else class="ap-main ap-entries">
            <div class="ap-entries-head">
              <button class="btn btn-sm" @click="drillAsset = null">
                <ChevronLeft :size="11" />
                {{ t('episode.design.picker.all') }}
              </button>
              <strong class="ap-entries-title">{{ drillAsset.name }}</strong>
              <span class="tag mono">{{ t('episode.design.picker.entries') }} {{ entries.length }}</span>
            </div>

            <div v-if="entries.length" class="ap-entries-body">
              <ul class="ap-entry-list">
                <li v-for="entry in entries" :key="entry.id">
                  <button
                    type="button"
                    :class="['ap-entry', { on: isEntryPicked(entry) }]"
                    :aria-pressed="isEntryPicked(entry)"
                    @click="toggleEntry(entry)"
                    @mouseenter="hoverId = entry.id"
                    @mouseleave="hoverId = ''"
                    @focus="hoverId = entry.id"
                    @blur="hoverId = ''"
                  >
                    <span class="ap-entry-name">{{ entry.name }}</span>
                    <span class="tag mono">{{ t(`episode.design.layerType.${GROUP_LAYER_TYPE[entry.group]}`) }}</span>
                  </button>
                </li>
              </ul>

              <div class="ap-preview">
                <div v-if="previewImage" class="ap-preview-stage">
                  <img :src="mediaUrl(previewImage)" :alt="drillAsset.name" @load="onPreviewLoad">
                  <svg
                    v-if="viewWidth > 0 && viewHeight > 0"
                    class="ap-preview-overlay"
                    :viewBox="`0 0 ${viewWidth} ${viewHeight}`"
                    preserveAspectRatio="xMidYMid meet"
                  >
                    <polygon
                      v-for="region in geometry.regions"
                      :key="`r-${region.id}`"
                      :points="pointsAttr(region.points)"
                      :fill="colorFor(region.id)"
                      fill-opacity="0.18"
                      :stroke="colorFor(region.id)"
                      :stroke-width="unit * (isHot(region.id) ? 2 : 1)"
                    />
                    <polyline
                      v-for="line in geometry.lines"
                      :key="`l-${line.id}`"
                      :points="pointsAttr(line.points)"
                      fill="none"
                      :stroke="colorFor(line.id)"
                      :stroke-width="unit * (isHot(line.id) ? 2.6 : 1.4)"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <rect
                      v-for="label in geometry.labels"
                      :key="`b-${label.id}`"
                      :x="label.bbox[0]"
                      :y="label.bbox[1]"
                      :width="Math.max(label.bbox[2] - label.bbox[0], 1)"
                      :height="Math.max(label.bbox[3] - label.bbox[1], 1)"
                      fill="none"
                      :stroke="colorFor(label.id)"
                      :stroke-width="unit * (isHot(label.id) ? 2 : 1)"
                    />
                    <circle
                      v-for="point in geometry.points"
                      :key="`p-${point.id}`"
                      :cx="point.at[0]"
                      :cy="point.at[1]"
                      :r="unit * (isHot(point.id) ? 4 : 2.5)"
                      :fill="colorFor(point.id)"
                    />
                  </svg>
                </div>
                <p v-else class="ap-preview-empty dim">{{ t('episode.design.picker.empty') }}</p>
                <p class="ap-preview-caption dim">{{ hoverName || t('episode.design.picker.selected', { n: pickedEntries.length }) }}</p>
              </div>
            </div>

            <div v-else class="ap-empty">
              <p>{{ t('episode.design.picker.emptySemantic') }}</p>
              <button class="btn btn-sm" @click="gotoAssets(drillAsset)">{{ t('episode.design.picker.gotoSemantics') }}</button>
            </div>
          </section>
        </div>

        <footer class="dialog-foot ap-foot">
          <span class="dim">{{ t('episode.design.picker.selected', { n: pickedCount }) }}</span>
          <span class="ml-auto" />
          <button class="btn btn-sm" @click="close">{{ t('episode.design.picker.cancel') }}</button>
          <button class="btn btn-sm btn-primary" :disabled="!pickedCount" @click="confirm">
            {{ t('episode.design.picker.confirm') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 素材与语义条目选择器（Issue #57，Fabel §3.4）——设计卡里所有「+」入口共用的统一弹层。
 *
 * 两种模式：
 * - `mode="asset"`：多选资产，确定后回 `AssetRef[]`（参考素材）。
 * - `mode="semantic"`：先选一张素材，再在它的语义条目里多选，回 `SemanticRef[]`（必须标注 / 图层锚点）。
 *
 * 条目的几何坐标不在设计卡上下文里（那里只有 id/name/group），右侧小图的高亮按需向
 * `propAPI.semantics` 取一次完整标注文档，口径与 `PropSemanticsPanel.vue` 一致：
 * viewBox 用原图像素尺寸，描边随原图尺寸缩放。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ShieldCheck, X } from 'lucide-vue-next'
import { propAPI } from '~/composables/useApi'
import { mediaUrl } from '~/utils/url'

const { t } = useI18n()

const props = defineProps({
  open: { type: Boolean, default: false },
  // asset = 选资产本身；semantic = 选某张素材上的语义条目
  mode: { type: String, default: 'asset' },
  // 设计卡上下文里的资产清单（design-card-context.assets）
  assets: { type: Array, default: () => [] },
  // 已选条目：asset 模式是 AssetRef[]，semantic 模式是 SemanticRef[]
  selected: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'confirm'])

const TYPES = ['all', 'character', 'scene', 'prop', 'evidence', 'carrier']
// 语义条目分组 → 可复用的图层类型文案（点/线/区域/标签）
const GROUP_LAYER_TYPE = { point: 'marker', line: 'polyline', region: 'polygon', label: 'label' }
const HOT_COLOR = '#ffb74d'
const DIM_COLOR = '#4fc3f7'

const railType = ref('all')
const keyword = ref('')
const drillAsset = ref(null)
const hoverId = ref('')
const pickedAssets = ref([])
const pickedEntries = ref([])
const geometry = ref(emptyGeometry())
const geometryBase = ref('')
const naturalSize = ref({ width: 0, height: 0 })

function emptyGeometry() {
  return { image: { width: 0, height: 0 }, labels: [], points: [], regions: [], lines: [] }
}

/** 打开时按传入的已选值初始化，关闭不清空（父级每次打开都会重新传 selected） */
watch(() => props.open, (open) => {
  if (!open) return
  railType.value = 'all'
  keyword.value = ''
  hoverId.value = ''
  drillAsset.value = null
  geometry.value = emptyGeometry()
  geometryBase.value = ''
  if (props.mode === 'semantic') {
    pickedEntries.value = props.selected.map(item => ({ ...item }))
    pickedAssets.value = []
  } else {
    pickedAssets.value = props.selected.map(item => ({ ...item }))
    pickedEntries.value = []
  }
}, { immediate: true })

const hasAnyAsset = computed(() => props.assets.length > 0)

function matchType(asset, type) {
  if (type === 'all') return true
  if (type === 'evidence') return asset.faithful === true
  if (type === 'carrier') return asset.exposition === true
  return asset.kind === type
}
function countOf(type) {
  return props.assets.filter(asset => matchType(asset, type)).length
}
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return props.assets.filter(asset => matchType(asset, railType.value)
    && (!kw || String(asset.name || '').toLowerCase().includes(kw)))
})

function isAssetPicked(asset) {
  if (props.mode === 'semantic') return drillAsset.value?.id === asset.id && drillAsset.value?.kind === asset.kind
  return pickedAssets.value.some(item => item.id === asset.id && item.kind === asset.kind)
}
function onAssetClick(asset) {
  if (props.mode === 'semantic') { openEntries(asset); return }
  const exists = pickedAssets.value.some(item => item.id === asset.id && item.kind === asset.kind)
  pickedAssets.value = exists
    ? pickedAssets.value.filter(item => !(item.id === asset.id && item.kind === asset.kind))
    : [...pickedAssets.value, { kind: asset.kind, id: asset.id, name: asset.name }]
}

const entries = computed(() => (drillAsset.value?.semantics || []))

async function openEntries(asset) {
  drillAsset.value = asset
  hoverId.value = ''
  geometry.value = emptyGeometry()
  geometryBase.value = asset.image || ''
  naturalSize.value = { width: 0, height: 0 }
  // 几何只有道具（证据素材）有；取不到就只展示缩略图，不阻断选择
  if (asset.kind !== 'prop' || !(asset.semantics || []).length) return
  try {
    const res = await propAPI.semantics(asset.id)
    if (drillAsset.value?.id !== asset.id) return
    geometry.value = normalizeGeometry(res?.semantics)
    if (res?.base_image_url) geometryBase.value = res.base_image_url
  } catch { /* 静默：高亮是辅助信息，取不到不影响选条目 */ }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
function coordPairs(value) {
  if (!Array.isArray(value)) return []
  return value.filter(pair => Array.isArray(pair) && pair.length >= 2).map(pair => [num(pair[0]), num(pair[1])])
}
function normalizeGeometry(raw) {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return emptyGeometry() }
  }
  if (!value || typeof value !== 'object') return emptyGeometry()
  const image = value.image && typeof value.image === 'object' ? value.image : {}
  return {
    image: { width: num(image.width), height: num(image.height) },
    labels: (Array.isArray(value.labels) ? value.labels : [])
      .filter(item => item && Array.isArray(item.bbox) && item.bbox.length >= 4)
      .map((item, i) => ({
        id: String(item.id || `label-${i}`),
        bbox: [num(item.bbox[0]), num(item.bbox[1]), num(item.bbox[2]), num(item.bbox[3])],
      })),
    points: (Array.isArray(value.points) ? value.points : [])
      .filter(item => item && Array.isArray(item.at) && item.at.length >= 2)
      .map((item, i) => ({ id: String(item.id || `point-${i}`), at: [num(item.at[0]), num(item.at[1])] })),
    regions: (Array.isArray(value.regions) ? value.regions : [])
      .map((item, i) => ({ id: String(item?.id || `region-${i}`), points: coordPairs(item?.points) }))
      .filter(item => item.points.length >= 3),
    lines: (Array.isArray(value.lines) ? value.lines : [])
      .map((item, i) => ({ id: String(item?.id || `line-${i}`), points: coordPairs(item?.points) }))
      .filter(item => item.points.length >= 2),
  }
}

const previewImage = computed(() => geometryBase.value)
const viewWidth = computed(() => geometry.value.image.width || naturalSize.value.width)
const viewHeight = computed(() => geometry.value.image.height || naturalSize.value.height)
const unit = computed(() => Math.max(Math.max(viewWidth.value, viewHeight.value) / 400, 0.5))

function onPreviewLoad(event) {
  naturalSize.value = { width: event.target.naturalWidth || 0, height: event.target.naturalHeight || 0 }
}
function pointsAttr(pairs) {
  return pairs.map(([x, y]) => `${x},${y}`).join(' ')
}
function isHot(id) {
  if (hoverId.value) return hoverId.value === id
  return pickedEntries.value.some(item => item.semantic_id === id)
}
function colorFor(id) {
  return isHot(id) ? HOT_COLOR : DIM_COLOR
}
const hoverName = computed(() => entries.value.find(entry => entry.id === hoverId.value)?.name || '')

function isEntryPicked(entry) {
  return pickedEntries.value.some(item => item.asset_id === drillAsset.value?.id && item.semantic_id === entry.id)
}
function toggleEntry(entry) {
  const assetId = drillAsset.value?.id
  if (!assetId) return
  const exists = isEntryPicked(entry)
  pickedEntries.value = exists
    ? pickedEntries.value.filter(item => !(item.asset_id === assetId && item.semantic_id === entry.id))
    : [...pickedEntries.value, { asset_id: assetId, semantic_id: entry.id, name: entry.name }]
}

const pickedCount = computed(() => (props.mode === 'semantic' ? pickedEntries.value.length : pickedAssets.value.length))

function close() { emit('close') }
function confirm() {
  emit('confirm', props.mode === 'semantic' ? pickedEntries.value.map(item => ({ ...item })) : pickedAssets.value.map(item => ({ ...item })))
}

/** 空态出路：跳到本集资产页（带上资产 deeplink 时直接定位到那张素材） */
function gotoAssets(asset = null) {
  const url = new URL(window.location.href)
  url.searchParams.set('panel', 'production')
  url.searchParams.set('tab', 'assets')
  url.searchParams.set('sub', 'cards')
  if (asset) url.searchParams.set('asset', `${asset.kind}-${asset.id}`)
  else url.searchParams.delete('asset')
  window.location.assign(url.toString())
}
</script>

<style scoped>
.ap-dialog {
  width: 720px;
  max-width: calc(100vw - 32px);
  height: 520px;
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}
.ap-search { flex: 1; min-width: 160px; height: 26px; font-size: 12px; }
.ap-body { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 10px; flex: 1; min-height: 0; overflow: hidden; }

.ap-rail { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.ap-rail-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-2); font-size: 12px; text-align: left; cursor: pointer;
}
.ap-rail-item:hover { background: var(--bg-3); }
.ap-rail-item.on { border-color: var(--accent); color: var(--text-1); background: var(--bg-3); }
.ap-rail-count { margin-left: auto; font-size: 11px; color: var(--text-3); }

.ap-main { min-width: 0; min-height: 0; overflow-y: auto; }
.ap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 180px));
  justify-content: start;
  gap: 8px;
}
.ap-card {
  display: flex; flex-direction: column; gap: 3px;
  padding: 6px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text-1); cursor: pointer; text-align: left;
}
.ap-card:hover { border-color: var(--accent); }
.ap-card.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.ap-card-media {
  position: relative; display: flex; align-items: center; justify-content: center;
  aspect-ratio: 4 / 3; border-radius: 6px; overflow: hidden; background: var(--bg-3);
}
.ap-card-media img { width: 100%; height: 100%; object-fit: contain; }
.ap-card-noimg { font-size: 11px; color: var(--text-3); }
.ap-card-badge {
  position: absolute; top: 3px; right: 3px; display: inline-flex; align-items: center;
  padding: 2px; border-radius: 999px;
  background: var(--header-bg); color: var(--text-1);
}
.ap-card-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-card-kind { font-size: 11px; }

.ap-entries { display: flex; flex-direction: column; gap: 8px; }
.ap-entries-head { display: flex; align-items: center; gap: 8px; }
.ap-entries-title { font-size: 13px; }
.ap-entries-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 42%); gap: 10px; min-height: 0; }
.ap-entry-list { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 0; list-style: none; overflow-y: auto; }
.ap-entry {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-1); font-size: 12px; cursor: pointer; text-align: left;
}
.ap-entry.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.ap-entry-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ap-preview { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ap-preview-stage { position: relative; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--bg-3); }
.ap-preview-stage img { display: block; width: 100%; height: auto; object-fit: contain; }
.ap-preview-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ap-preview-empty, .ap-preview-caption { font-size: 11px; }

.ap-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 100%; font-size: 12px; color: var(--text-2); }
.ap-foot { display: flex; align-items: center; gap: 8px; }
</style>
