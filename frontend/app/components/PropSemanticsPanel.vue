<template>
  <div class="sem" @click.stop>
    <div class="sem-head">
      <span class="sem-label">{{ t('episode.documentary.semantics.title') }}</span>
      <span class="sem-count" :class="{ dim: !totalCount }">{{ totalCount }}</span>
      <span v-if="faithful" class="sem-faithful">{{ t('episode.asset.faithfulBadge') }}</span>
      <button class="sem-toggle" type="button" :disabled="autoRunning || !baseImageUrl" @click.stop="runAuto">
        <Loader2 v-if="autoRunning" :size="11" class="animate-spin" />
        <Wand2 v-else :size="11" />
        {{ autoRunning ? t('episode.documentary.semantics.autoRunning') : t('episode.documentary.semantics.auto') }}
      </button>
      <button class="sem-toggle" type="button" :disabled="beautifying || !baseImageUrl" @click.stop="runBeautify">
        <Loader2 v-if="beautifying" :size="11" class="animate-spin" />
        <Sparkles v-else :size="11" />
        {{ beautifying ? t('episode.documentary.semantics.beautifying') : t('episode.documentary.semantics.beautify') }}
      </button>
    </div>

    <p class="sem-notice">{{ t('episode.documentary.semantics.hint') }}</p>
    <p class="sem-note">{{ t('episode.documentary.semantics.beautifyHint') }}</p>
    <p class="sem-note">{{ t('episode.documentary.semantics.noEditorHint') }}</p>

    <p v-if="loading" class="sem-note">{{ t('episode.documentary.semantics.loading') }}</p>
    <p v-if="loadError" class="sem-error">{{ loadError }}</p>
    <p v-if="autoError" class="sem-error">{{ autoError }}</p>
    <ul v-if="warnings.length" class="sem-warnings">
      <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
    </ul>

    <!-- 底图 + SVG 叠加：viewBox 用原图像素尺寸，渲染尺寸由 CSS 决定，不做手工换算 -->
    <div v-if="baseImageUrl" class="sem-stage">
      <img
        :src="mediaUrl(baseImageUrl)"
        class="sem-base"
        :alt="t('episode.documentary.semantics.title')"
        @load="onBaseLoad"
        @click.stop="emit('preview', mediaUrl(baseImageUrl), t('episode.documentary.semantics.title'))"
      />
      <svg
        v-if="viewWidth > 0 && viewHeight > 0"
        class="sem-overlay"
        :viewBox="`0 0 ${viewWidth} ${viewHeight}`"
        preserveAspectRatio="xMidYMid meet"
      >
        <polygon
          v-for="region in doc.regions"
          :key="`r-${region.id}`"
          :points="pointsAttr(region.points)"
          :fill="colorOf(region.source)"
          fill-opacity="0.18"
          :stroke="colorOf(region.source)"
          :stroke-width="unit"
        />
        <polyline
          v-for="line in doc.lines"
          :key="`l-${line.id}`"
          :points="pointsAttr(line.points)"
          fill="none"
          :stroke="line.color || kindColor(line.kind)"
          :stroke-width="unit * 1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <g v-for="label in doc.labels" :key="`b-${label.id}`">
          <rect
            :x="label.bbox[0]"
            :y="label.bbox[1]"
            :width="Math.max(label.bbox[2] - label.bbox[0], 1)"
            :height="Math.max(label.bbox[3] - label.bbox[1], 1)"
            fill="none"
            :stroke="colorOf(label.source)"
            :stroke-width="unit"
          />
          <text
            :x="label.bbox[0]"
            :y="Math.max(label.bbox[1] - unit * 2, unit * 8)"
            :font-size="unit * 9"
            :fill="colorOf(label.source)"
          >{{ label.text }}</text>
        </g>
        <g v-for="point in doc.points" :key="`p-${point.id}`">
          <circle :cx="point.at[0]" :cy="point.at[1]" :r="unit * 2.5" :fill="colorOf(point.source)" />
          <text
            :x="point.at[0] + unit * 4"
            :y="point.at[1] + unit * 3"
            :font-size="unit * 9"
            :fill="colorOf(point.source)"
          >{{ point.name }}</text>
        </g>
      </svg>
    </div>
    <p v-else-if="!loading" class="sem-empty dim">{{ t('episode.documentary.semantics.noBase') }}</p>

    <div class="sem-legend">
      <span class="sem-legend-title">{{ t('episode.documentary.semantics.legend') }}</span>
      <span v-for="src in SOURCES" :key="src" class="sem-legend-item">
        <i class="sem-swatch" :style="{ background: colorOf(src) }" />
        {{ t(`episode.documentary.semantics.source.${src}`) }}
      </span>
    </div>

    <div v-if="totalCount" class="sem-groups">
      <section v-for="group in GROUPS" :key="group" class="sem-group">
        <div class="sem-group-head">
          <strong>{{ t(`episode.documentary.semantics.group.${group}`) }}</strong>
          <span class="dim">{{ t('episode.documentary.semantics.groupCount', { n: doc[group].length }) }}</span>
        </div>
        <ul v-if="doc[group].length" class="sem-list">
          <li v-for="(entry, index) in doc[group]" :key="entry.id || `${group}-${index}`" class="sem-item">
            <input
              class="input sem-item-input"
              :value="group === 'labels' ? entry.text : entry.name"
              :placeholder="t('episode.documentary.semantics.namePlaceholder')"
              @input="rename(group, index, $event.target.value)"
            />
            <span class="sem-badge" :style="{ borderColor: colorOf(entry.source), color: colorOf(entry.source) }">
              {{ t(`episode.documentary.semantics.source.${entry.source}`) }}
            </span>
            <span class="dim sem-conf">{{ t('episode.documentary.semantics.confidence', { v: confText(entry.confidence) }) }}</span>
            <button
              class="sem-del"
              type="button"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
              @click.stop="remove(group, index)"
            >
              <X :size="12" />
            </button>
          </li>
        </ul>
        <p v-else class="sem-empty dim">{{ t('episode.documentary.semantics.empty') }}</p>
      </section>

      <div class="sem-save-row">
        <button class="btn btn-sm btn-primary" type="button" :disabled="saving || !dirty" @click.stop="save">
          <Loader2 v-if="saving" :size="11" class="animate-spin" />
          {{ saving ? t('episode.documentary.semantics.saving') : t('episode.documentary.semantics.save') }}
        </button>
        <span v-if="saveError" class="sem-error">{{ saveError }}</span>
      </div>
    </div>
    <p v-else-if="!loading && baseImageUrl" class="sem-empty dim">{{ t('episode.documentary.semantics.empty') }}</p>

    <!-- 忠实原件：语义坐标永远相对这张上传/导入的原图 -->
    <div class="sem-source">
      <div class="sem-group-head">
        <strong>{{ t('episode.documentary.semantics.sourceTitle') }}</strong>
        <span class="dim">{{ t('episode.documentary.semantics.sourceHint') }}</span>
      </div>
      <div v-if="originalVersions.length" class="sem-source-list">
        <button
          v-for="version in originalVersions"
          :key="version.id ?? version.url"
          type="button"
          class="sem-source-card"
          :class="{ on: isCurrentSource(version), failed: version.fidelity === 'failed' }"
          :disabled="switchingSource || version.fidelity === 'failed' || isCurrentSource(version)"
          :title="version.fidelity === 'failed'
            ? (version.fidelity_reason || t('episode.documentary.semantics.fidelityFailed'))
            : (isCurrentSource(version) ? t('episode.documentary.semantics.sourceCurrent') : t('episode.documentary.semantics.sourceUse'))"
          @click.stop="pickSource(version)"
        >
          <img :src="mediaUrl(version.url)" loading="lazy" />
          <span class="sem-source-meta">
            <span class="sem-source-provider">{{ version.provider }}</span>
            <span v-if="isCurrentSource(version)" class="sem-source-flag">{{ t('episode.documentary.semantics.sourceCurrent') }}</span>
            <span v-else-if="version.fidelity === 'failed'" class="sem-source-flag is-failed">{{ t('episode.documentary.semantics.fidelityFailed') }}</span>
            <span v-else-if="version.fidelity === 'verified'" class="sem-source-flag is-ok">{{ t('episode.documentary.semantics.fidelityVerified') }}</span>
          </span>
          <span v-if="version.fidelity === 'failed' && version.fidelity_reason" class="sem-source-reason">{{ version.fidelity_reason }}</span>
        </button>
      </div>
      <p v-else class="sem-empty dim">{{ t('episode.documentary.semantics.sourceEmpty') }}</p>
      <p v-if="sourceError" class="sem-error">{{ sourceError }}</p>
    </div>
  </div>
</template>

<script setup>
/**
 * 道具「语义标注」面板（Issue #47）。
 *
 * 证据素材（地图/版画/文书）的坐标语义永远相对 `faithful_source` 指向的那张**上传原件**，
 * 美化版本只是派生物，必须通过忠实度校验才能当底图，所以校验失败的版本在这里不可选。
 * 面板只做「清单 + 叠加预览」：几何编辑（拖点/改线）属于图层编辑器（Issue #48），这里不做。
 */
import { Loader2, Sparkles, Wand2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { propAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const { t } = useI18n()

const props = defineProps({
  propId: { type: [Number, String], required: true },
  episodeId: { type: Number, required: true },
  faithful: { type: [Number, Boolean], default: 0 },
  faithfulSource: { type: Number, default: null },
  // 道具行里的 semantics 原值（JSON 字符串 / 对象 / null 都接受），接口返回值优先
  semantics: { type: [String, Object], default: null },
  imageVersions: { type: Array, default: () => [] },
})

const emit = defineEmits(['update', 'preview'])

const GROUPS = ['labels', 'points', 'regions', 'lines']
const SOURCES = ['vlm', 'cv', 'manual']
const SOURCE_COLORS = { vlm: '#4fc3f7', cv: '#66bb6a', manual: '#ffb74d' }
const KIND_COLORS = { river: '#4aa3df', route: '#e2703a', border: '#9c6ade' }

const loading = ref(false)
const loadError = ref('')
const baseImageUrl = ref('')
const doc = ref(emptyDoc())
const dirty = ref(false)
const saving = ref(false)
const saveError = ref('')
const autoRunning = ref(false)
const autoError = ref('')
const warnings = ref([])
const beautifying = ref(false)
const switchingSource = ref(false)
const sourceError = ref('')
const naturalSize = ref({ width: 0, height: 0 })

let autoTimer = null
// 卸载后仍在途的轮询回来时不能再排下一轮，也不能往已销毁的面板里写状态
let stopped = false

function emptyDoc() {
  return { image: { width: 0, height: 0, source_task_id: null }, labels: [], points: [], regions: [], lines: [] }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function coordPairs(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(pair => Array.isArray(pair) && pair.length >= 2)
    .map(pair => [num(pair[0]), num(pair[1])])
}

function source(value) {
  return SOURCES.includes(value) ? value : 'manual'
}

/** 后端返回的 doc 可能缺字段/缺整组数组，这里一次性补齐，模板不做存在性判断 */
function normalizeDoc(raw) {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return emptyDoc() }
  }
  if (!value || typeof value !== 'object') return emptyDoc()
  const image = value.image && typeof value.image === 'object' ? value.image : {}
  return {
    image: {
      width: num(image.width),
      height: num(image.height),
      source_task_id: Number.isFinite(Number(image.source_task_id)) ? Number(image.source_task_id) : null,
    },
    labels: (Array.isArray(value.labels) ? value.labels : [])
      .filter(item => item && Array.isArray(item.bbox) && item.bbox.length >= 4)
      .map((item, i) => ({
        id: String(item.id || `label-${i}`),
        text: String(item.text ?? ''),
        bbox: [num(item.bbox[0]), num(item.bbox[1]), num(item.bbox[2]), num(item.bbox[3])],
        source: source(item.source),
        confidence: num(item.confidence),
      })),
    points: (Array.isArray(value.points) ? value.points : [])
      .filter(item => item && Array.isArray(item.at) && item.at.length >= 2)
      .map((item, i) => ({
        id: String(item.id || `point-${i}`),
        name: String(item.name ?? ''),
        at: [num(item.at[0]), num(item.at[1])],
        source: source(item.source),
        confidence: num(item.confidence),
      })),
    regions: (Array.isArray(value.regions) ? value.regions : [])
      .map((item, i) => ({
        id: String(item?.id || `region-${i}`),
        name: String(item?.name ?? ''),
        points: coordPairs(item?.points),
        source: source(item?.source),
        confidence: num(item?.confidence),
      }))
      .filter(item => item.points.length >= 3),
    lines: (Array.isArray(value.lines) ? value.lines : [])
      .map((item, i) => ({
        id: String(item?.id || `line-${i}`),
        name: String(item?.name ?? ''),
        points: coordPairs(item?.points),
        kind: ['river', 'route', 'border'].includes(item?.kind) ? item.kind : 'route',
        source: source(item?.source),
        confidence: num(item?.confidence),
        ...(item?.color ? { color: String(item.color) } : {}),
      }))
      .filter(item => item.points.length >= 2),
    ...(Array.isArray(value.warnings) ? { warnings: value.warnings.map(String) } : {}),
    ...(value.generated_at ? { generated_at: String(value.generated_at) } : {}),
    ...(value.model ? { model: String(value.model) } : {}),
  }
}

const totalCount = computed(() => GROUPS.reduce((sum, group) => sum + doc.value[group].length, 0))
// 坐标基准：doc 里写了原图尺寸就用它，没写（手工 doc / 空 doc）回落到底图的自然尺寸
const viewWidth = computed(() => doc.value.image.width || naturalSize.value.width)
const viewHeight = computed(() => doc.value.image.height || naturalSize.value.height)
// 描边/字号随原图尺寸缩放，否则 6000px 的地图上线条细到看不见
const unit = computed(() => Math.max(Math.max(viewWidth.value, viewHeight.value) / 400, 0.5))

const originalVersions = computed(() => (props.imageVersions || [])
  .filter(version => version?.url && (version.provider === 'upload' || version.provider === 'import')))

function colorOf(value) {
  return SOURCE_COLORS[value] || SOURCE_COLORS.manual
}
function kindColor(value) {
  return KIND_COLORS[value] || KIND_COLORS.route
}
function pointsAttr(pairs) {
  return pairs.map(([x, y]) => `${x},${y}`).join(' ')
}
function confText(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—'
}
function isCurrentSource(version) {
  return Number(props.faithfulSource) === Number(version?.id)
}

function onBaseLoad(event) {
  naturalSize.value = { width: event.target.naturalWidth || 0, height: event.target.naturalHeight || 0 }
}

async function load() {
  loading.value = true
  loadError.value = ''
  saveError.value = ''
  try {
    const res = await propAPI.semantics(props.propId)
    if (stopped) return
    baseImageUrl.value = res?.base_image_url || ''
    doc.value = normalizeDoc(res?.semantics ?? props.semantics)
    warnings.value = Array.isArray(doc.value.warnings) ? doc.value.warnings : []
    dirty.value = false
  } catch (err) {
    if (stopped) return
    // 接口不可用时仍用道具行里带来的原值渲染清单，面板不至于整块空白
    doc.value = normalizeDoc(props.semantics)
    loadError.value = err?.message || t('episode.documentary.semantics.loadFailed')
  } finally {
    if (!stopped) loading.value = false
  }
}

function rename(group, index, value) {
  const entry = doc.value[group][index]
  if (!entry) return
  if (group === 'labels') entry.text = value
  else entry.name = value
  dirty.value = true
}

function remove(group, index) {
  doc.value[group].splice(index, 1)
  dirty.value = true
}

async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  saveError.value = ''
  try {
    const res = await propAPI.saveSemantics(props.propId, doc.value)
    const next = normalizeDoc(res?.semantics ?? doc.value)
    doc.value = next
    dirty.value = false
    emit('update', { semantics: JSON.stringify(next) })
    toast.success(t('episode.documentary.semantics.saved'))
  } catch (err) {
    // 400 的坐标越界/结构错误直接就地展示，不只弹 toast
    saveError.value = err?.message || t('episode.documentary.semantics.saveFailed')
  } finally {
    saving.value = false
  }
}

function stopAutoPoll() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
}

async function runAuto() {
  if (autoRunning.value || !baseImageUrl.value) return
  autoRunning.value = true
  autoError.value = ''
  warnings.value = []
  try {
    await propAPI.autoSemantics(props.propId, Number(props.episodeId))
    if (stopped) return
    toast.info(t('episode.documentary.semantics.autoStarted'))
    pollAuto()
  } catch (err) {
    autoRunning.value = false
    autoError.value = err?.message || t('episode.documentary.semantics.autoFailed')
  }
}

// 文本任务走任务中心：3s 轮询到 done/error 为止；none 说明任务行刚落库，继续等
function pollAuto(left = 200) {
  stopAutoPoll()
  if (left <= 0) {
    autoRunning.value = false
    autoError.value = t('episode.documentary.semantics.autoFailed')
    return
  }
  autoTimer = setTimeout(async () => {
    autoTimer = null
    try {
      const st = await propAPI.autoSemanticsStatus(props.propId)
      if (stopped) return
      if (Array.isArray(st?.warnings) && st.warnings.length) warnings.value = st.warnings
      if (st?.status === 'done') {
        autoRunning.value = false
        await load()
        if (!stopped) {
          emit('update', { semantics: JSON.stringify(doc.value) })
          toast.success(t('episode.documentary.semantics.autoDone'))
        }
        return
      }
      if (st?.status === 'error') {
        autoRunning.value = false
        autoError.value = st.error || t('episode.documentary.semantics.autoFailed')
        return
      }
      pollAuto(left - 1)
    } catch (err) {
      autoRunning.value = false
      autoError.value = err?.message || t('episode.documentary.semantics.autoFailed')
    }
  }, 3000)
}

async function runBeautify() {
  if (beautifying.value || !baseImageUrl.value) return
  beautifying.value = true
  try {
    await propAPI.beautify(props.propId, Number(props.episodeId))
    if (!stopped) toast.success(t('episode.documentary.semantics.beautifyStarted'))
  } catch (err) {
    toastError(err)
  } finally {
    if (!stopped) beautifying.value = false
  }
}

async function pickSource(version) {
  if (switchingSource.value || !version?.id || version.fidelity === 'failed' || isCurrentSource(version)) return
  switchingSource.value = true
  sourceError.value = ''
  try {
    const row = await propAPI.setFaithfulSource(props.propId, Number(version.id))
    if (stopped) return
    emit('update', row)
    toast.success(t('episode.documentary.semantics.sourceSwitched'))
    await load()
  } catch (err) {
    sourceError.value = err?.message || t('episode.documentary.semantics.sourceFailed')
  } finally {
    if (!stopped) switchingSource.value = false
  }
}

watch(() => props.propId, () => {
  stopAutoPoll()
  autoRunning.value = false
  autoError.value = ''
  naturalSize.value = { width: 0, height: 0 }
  load()
})

onMounted(load)
onBeforeUnmount(() => { stopped = true; stopAutoPoll() })
</script>

<style scoped>
.sem {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sem-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sem-label {
  font: 600 11px var(--font-body);
  color: var(--text-1);
}
.sem-count {
  font: 600 10.5px var(--font-body);
  color: var(--accent-text);
}
.sem-faithful {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10px var(--font-body);
}
.sem-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-2);
  font: 600 10.5px var(--font-body);
  cursor: pointer;
}
.sem-head .sem-toggle:first-of-type { margin-left: auto; }
.sem-toggle:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.sem-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.sem-notice {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.sem-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-2);
}
.sem-error {
  margin: 0;
  font-size: 10.5px;
  color: var(--action-danger);
}
.sem-warnings {
  margin: 0;
  padding-left: 16px;
  font-size: 10.5px;
  color: var(--warn-text);
}
.sem-stage {
  position: relative;
  width: 100%;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.sem-base {
  display: block;
  width: 100%;
  height: auto;
  cursor: zoom-in;
}
.sem-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.sem-overlay text {
  font-family: var(--font-body);
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 0.6px;
}
.sem-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 10.5px;
  color: var(--text-2);
}
.sem-legend-title { font-weight: 600; color: var(--text-1); }
.sem-legend-item { display: inline-flex; align-items: center; gap: 4px; }
.sem-swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.sem-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sem-group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 10.5px;
  color: var(--text-1);
}
.sem-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sem-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
}
.sem-item-input { flex: 1 1 auto; min-width: 0; }
.sem-badge {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  font: 600 10px var(--font-body);
}
.sem-conf { flex: none; font-size: 10.5px; }
.sem-del {
  flex: none;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.sem-del:hover { background: var(--action-danger); color: #fff; }
.sem-save-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sem-source {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}
.sem-source-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 200px));
  justify-content: start;
  gap: 8px;
}
.sem-source-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0 0 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  cursor: pointer;
  overflow: hidden;
  text-align: left;
}
.sem-source-card img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: contain;
  background: var(--bg-2);
}
.sem-source-card.on { border-color: var(--accent-text); }
.sem-source-card.failed { border-color: var(--action-danger); cursor: not-allowed; }
.sem-source-card:disabled { opacity: 0.75; cursor: not-allowed; }
.sem-source-card:hover:not(:disabled) { border-color: var(--accent-text); }
.sem-source-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 5px;
  font-size: 10px;
  color: var(--text-2);
}
.sem-source-provider { font-weight: 600; }
.sem-source-flag { color: var(--accent-text); }
.sem-source-flag.is-failed { color: var(--action-danger); }
.sem-source-flag.is-ok { color: var(--text-2); }
.sem-source-reason {
  padding: 0 5px;
  font-size: 10px;
  color: var(--action-danger);
}
.sem-empty { font-size: 10.5px; margin: 0; }
</style>
