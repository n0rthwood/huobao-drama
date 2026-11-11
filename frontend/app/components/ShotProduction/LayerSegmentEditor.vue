<template>
  <div class="ls-root">
    <!-- 一致性黄条：后端 issues[] 原样展示，带可执行出路 -->
    <div v-for="issue in issues" :key="issue.code + (issue.semantic_id || issue.name || '')" class="ls-issue">
      <span class="ls-issue-text">
        <template v-if="issue.code === 'budget_mismatch'">
          {{ t('episode.segment.budgetMismatch', { actual: Number(issue.actual || 0).toFixed(1), budget: Number(issue.budget || 0).toFixed(1) }) }}
        </template>
        <template v-else>{{ issue.message }}</template>
      </span>
      <span class="ml-auto" />
      <button
        v-if="issue.code === 'must_mark_not_marked'"
        type="button" class="btn btn-sm"
        :disabled="saving || !segment"
        @click="createMarker(issue)"
      >{{ t('episode.segment.createMarker') }}</button>
      <button type="button" class="btn btn-sm" @click="emit('goto-design')">{{ t('episode.segment.backToCard') }}</button>
    </div>

    <!-- 底图视觉验证（Issue #94）：裁切 / contain 留白的底图必须过验证才能出关键帧、视频与成片 -->
    <div v-if="segment && segment.base_check_required" :class="['ls-check', checkTone]">
      <span class="ls-check-text">
        <strong>{{ t(`baseCheck.status.${checkStatus}`) }}</strong>
        <template v-if="baseCheck?.problems?.length">：{{ baseCheck.problems.join('；') }}</template>
        <template v-else-if="baseCheck?.error">：{{ baseCheck.error }}</template>
        <template v-else-if="baseCheck?.notes">：{{ baseCheck.notes }}</template>
        <template v-else-if="checkStatus === 'none'">：{{ t('baseCheck.neverChecked') }}</template>
        <span v-if="baseCheck?.override_reason" class="dim">（{{ t('baseCheck.overrideReason', { reason: baseCheck.override_reason }) }}）</span>
        <span v-if="baseCheck?.model" class="dim mono"> · {{ baseCheck.model }}</span>
      </span>
      <span class="ml-auto" />
      <button v-if="baseCheck?.task_id" type="button" class="btn btn-sm" @click="openTaskCenter({ episodeId, dramaId })">
        {{ t('baseCheck.viewTask', { id: baseCheck.task_id }) }}
      </button>
      <button type="button" class="btn btn-sm" :disabled="checking" @click="rerunCheck">
        {{ checking ? t('baseCheck.rechecking') : t('baseCheck.recheck') }}
      </button>
      <button type="button" class="btn btn-sm" :disabled="checking || segment.base_check_satisfied" @click="overrideCheck">
        {{ t('baseCheck.override') }}
      </button>
    </div>

    <!-- 比例不符且底图来自资产：可按项目画幅重出一版（忠实素材 / 地图道具由后端 400 拒绝） -->
    <div v-if="aspectIssue && assetBaseRef" class="ls-check warn">
      <span class="ls-check-text">{{ t('baseCheck.aspectVersionHint', { aspect: aspectIssue.aspect }) }}</span>
      <span class="ml-auto" />
      <button type="button" class="btn btn-sm" :disabled="aspectVersioning" @click="makeAspectVersion">
        {{ aspectVersioning ? t('baseCheck.aspectVersionRunning') : t('baseCheck.aspectVersion') }}
      </button>
    </div>
    <p v-if="aspectVersionError" class="ls-error">{{ aspectVersionError }}</p>

    <!-- 钉选了旧版本的段：资产当前图已经换了，给一键切换 -->
    <div v-if="pinnedOutdated" class="ls-check warn">
      <span class="ls-check-text">{{ t('baseCheck.pinnedOutdated') }}</span>
      <span class="ml-auto" />
      <button type="button" class="btn btn-sm" :disabled="saving" @click="switchToCurrentVersion">
        {{ t('baseCheck.switchToCurrent') }}
      </button>
    </div>

    <div class="ls-body">
      <!-- 中：图层画布 / 时刻预览 -->
      <section class="ls-main">
        <div class="ls-main-bar">
          <div class="ls-tabs">
            <button type="button" :class="['ls-tab', { on: mode === 'edit' }]" :title="t('layerCanvas.toolbar.edit')" @click="mode = 'edit'"><PencilLine :size="16" /></button>
            <button type="button" :class="['ls-tab', { on: mode === 'preview' }]" :title="t('layerCanvas.toolbar.preview')" @click="mode = 'preview'"><MonitorPlay :size="16" /></button>
          </div>
          <span v-if="segment && !segment.fresh && segment.render_path" class="ls-stale">{{ t('episode.segment.staleWarn') }}</span>
          <span v-if="saveState" class="dim" style="font-size:11px">{{ saveState }}</span>
          <span class="ml-auto" />
          <button type="button" class="btn btn-sm" :disabled="drafting || rendering" @click="makeDraft">
            {{ drafting ? t('episode.segment.drafting') : t('episode.segment.draft') }}
          </button>
          <button type="button" class="btn btn-sm" :disabled="!segment || saving || !dirty" @click="save()">
            {{ saving ? t('episode.segment.saving') : t('episode.segment.save') }}
          </button>
          <button type="button" class="btn btn-sm btn-primary" :title="missingGlyphs.join(' ')" :disabled="!segment || rendering || saving || missingGlyphs.length > 0" @click="render">
            <span v-if="rendering" class="ls-spin" />
            <Clapperboard v-else :size="16" />
            {{ rendering ? t('episode.segment.rendering') : t('episode.segment.render') }}
          </button>
        </div>

        <p v-if="error" class="ls-error">{{ error }}</p>

        <div v-if="!segment" class="ls-placeholder">{{ t('episode.segment.noSegment') }}</div>
        <template v-else>
          <LayerCanvas
            ref="canvasRef" v-show="mode === 'edit'"
            class="ls-canvas" :doc="doc" :selected-ids="selectedIds" :base-src="baseSrc"
            :quality="currentQuality" :aspect-issue="aspectIssue" :missing-glyphs="missingGlyphs"
            :can-undo="canUndo" :can-redo="canRedo" :crop-locked="inherited"
            :viewport="timeline.keyframes[keyframeIndex]?.viewport"
            @select="selectedIds = $event" @history="pushHistory" @patch="onPatch"
            @delete="removeSelected" @duplicate="duplicateSelected" @undo="undo" @redo="redo"
            @detach="detachAnchors" @crop="applyCrop" @viewport="onViewport"
          />
          <div v-if="mode === 'preview'" class="ls-preview">
            <!-- 与后端 composeFrame 同构：取景框（留白垫底 + 底图等比）→ 滤镜 → 按取景裁放 → 叠加层 SVG -->
            <div class="ls-preview-stage" :style="{ aspectRatio: `${specW} / ${specH}` }">
              <div class="ls-preview-crop" :style="cropStyle">
                <div class="ls-preview-frame" :style="frameStyle">
                  <img v-if="baseSrc && !baseFailed && letterboxed" class="ls-preview-backdrop" :src="baseSrc" :style="backdropStyle" alt="" draggable="false">
                </div>
                <div class="ls-preview-bounds" :style="boundsStyle">
                  <img v-if="baseSrc && !baseFailed" class="ls-preview-base" :src="baseSrc" :style="baseImageStyle" alt="" draggable="false" @error="baseFailed = true">
                </div>
                <div class="ls-preview-frame" :style="frameStyle">
                  <div v-for="filter in baseFilters" :key="filter.id" class="ls-preview-filter" :style="filterStyle(filter)" />
                </div>
                <!-- eslint-disable-next-line vue/no-v-html -- 与后端同源的 layerDocToSvg 输出，内容已转义 -->
                <div class="ls-preview-svg" v-html="frameSvg" />
              </div>
            </div>
            <p v-if="baseFailed" class="ls-error">{{ t('layerCanvas.base.loadError') }}</p>
            <div class="ls-preview-foot mono">{{ t('episode.segment.previewAt', { t: time.toFixed(2) }) }}</div>
          </div>
          <PreciseKeyframeBar
            :doc="doc" :timeline="timeline" :duration="duration"
            :spec="{ width: specW, height: specH, fps: timeline.fps }"
            :time="time" :selected-index="keyframeIndex" :quality="quality" :junction="junction"
            @viewport-pick="enterCanvasTool('viewport')"
            @history="pushHistory" @update:timeline="onTimeline" @update:duration="onDuration"
            @update:time="time = $event" @update:selected-index="keyframeIndex = $event"
          />
        </template>

        <div v-if="segment && segment.render_path" class="ls-result">
          <div class="ls-result-head">
            <span>{{ t('episode.segment.renderResult') }}</span>
            <span v-if="!segment.fresh" class="ls-stale">{{ t('episode.segment.staleWarn') }}</span>
          </div>
          <video :key="segment.render_path + renderStamp" :src="mediaUrl(segment.render_path)" controls preload="metadata" playsinline class="ls-video" />
        </div>
      </section>

      <section class="ls-side">
        <LayerRail v-if="segment" :doc="doc" :selected-ids="selectedIds"
          :episode-id="episodeId"
          :drama-id="dramaId" medium="video" :beats="beats"
          :spec="{width:specW,height:specH}" :inherited="inherited"
          @select="selectedIds = $event" @history="pushHistory" @patch="onPatch"
          @style="onStyle" @theme="setTheme" @filter="setFilter"
          @reorder="reorder($event.id, $event.toIndex)" @add="addLayer"
          @remove="removeSelected" @duplicate="duplicateSelected"
          @base="replaceBase" @crop-request="enterCanvasTool('crop')" @reanchor="reanchorLayer($event.id,$event.patch)"
          @text-layout="setTextLayout"
          @assets-changed="markDirty"
        />
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * 图层段编辑器（Issue #58）：一镜一段，承载图层画布 / 图层列表 / 图层样式 + 精确关键帧面板，
 * 并把后端 `issues[]` 的一致性问题直接摆在顶部给出路。
 * 段数据的唯一真相在后端 `/layer-segments`；保存与渲染后一律用返回值覆盖本地状态。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { PencilLine, MonitorPlay, Clapperboard } from 'lucide-vue-next'
import LayerCanvas from '~/components/LayerCanvas/LayerCanvas.vue'
import LayerRail from '~/components/LayerCanvas/LayerRail.vue'
import PreciseKeyframeBar from '~/components/LayerCanvas/PreciseKeyframeBar.vue'
import { baseAspectIssue, baseFrameOf, qualityWarningsOf, clampTimelineToFrame, normalizeCrop } from '~/utils/layerQuality'
import { useLayerDoc } from '~/composables/useLayerDoc'
import { assetAspectAPI, assetPipelineAPI, layerSegmentAPI } from '~/composables/useApi'
import { openTaskCenter } from '~/composables/useTasks'
import { frameStateAt } from '~/utils/segmentTimeline'
import { baseFilterLayers, layerDocToSvg } from '~/utils/layerSvg'
import { useLayerTextSpec } from '~/composables/useLayerTextSpec'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  storyboardId: { type: Number, required: true },
  episodeId: { type: Number, required: true },
  dramaId: { type: Number, required: true },
  // 后端 GET /layer-segments/storyboards/:id 的整份返回
  state: { type: Object, default: null },
})
const emit = defineEmits(['changed', 'goto-design'])
const { t } = useI18n()

const mode = ref('edit')
const canvasRef = ref(null)
const baseFailed = ref(false)
const time = ref(0)
const keyframeIndex = ref(0)
const timeline = ref({ fps: 25, ease: 'inout', fade_ms: 400, keyframes: [] })
const duration = ref(8)
const dirty = ref(false)
const saving = ref(false)
const drafting = ref(false)
const rendering = ref(false)
const saveState = ref('')
const error = ref('')
const renderStamp = ref(0)

const segment = computed(() => props.state?.segment || null)
const issues = computed(() => props.state?.issues || [])
const spec = computed(() => props.state?.spec || null)

const {
  doc, selectedIds, canUndo, canRedo, missingGlyphs,
  load, acceptSaved, pushHistory, undo, redo, patchLayer, patchStyle, detachAnchors, reanchorLayer,
  addLayer, removeSelected, duplicateSelected, reorder, setTheme, setFilter, setTextLayout,
} = useLayerDoc(() => {
  if (!segment.value) return
  dirty.value = true
  saveState.value = t('episode.segment.unsaved')
}, {
  snapshot: () => ({timeline:timeline.value,duration:duration.value}),
  restore: snapshot => {timeline.value=snapshot.timeline;duration.value=snapshot.duration},
}, { medium: 'video' })
// 模板文本框（#96）：规范到达后重画预览（文字排版由规范驱动）
const { version: specVersion } = useLayerTextSpec()

const specW = computed(() => spec.value?.width || doc.value.base.width || 960)
const specH = computed(() => spec.value?.height || doc.value.base.height || 544)
const baseSrc = computed(() => doc.value.base.path ? mediaUrl(doc.value.base.path) : '')
watch(baseSrc, () => {baseFailed.value=false})
const inherited = computed(() => segment.value?.base_ref?.kind === 'inherit_prev')
const quality = computed(() => qualityWarningsOf(doc.value, timeline.value.keyframes, {width:specW.value,height:specH.value}))
const currentQuality = computed(() => quality.value.find(q => q.frame_index === keyframeIndex.value) || null)
const aspectIssue = computed(() => baseAspectIssue(doc.value.base, {width:specW.value,height:specH.value}))
const junction = computed(() => {
  const combo=props.state?.storyboard?.combo || props.state?.combo
  return combo==='C' ? {slot:'last',t:duration.value} : combo==='D' ? {slot:'first',t:0} : null
})
/**
 * 文本框检查的「拍」（#96）：每个关键帧可见的图层集合；不属于任何关键帧的图层单独成一拍
 * （它们全程常显，同样要参与同拍位置区/重复检查）。
 */
const beats = computed(() => {
  const seen = new Set()
  const frames = (timeline.value.keyframes || []).map(frame => {
    const ids = [...new Set(frame.visible || [])]
    ids.forEach(id => seen.add(id))
    return ids
  })
  const absent = doc.value.layers.filter(layer => !seen.has(layer.id)).map(layer => layer.id)
  return absent.length ? [...frames, absent] : frames
})

// ── 底图视觉验证（Issue #94） ──────────────────────────────
const checking = ref(false)
const aspectVersioning = ref(false)
const aspectVersionError = ref('')
const baseCandidates = ref([])
const baseCheck = computed(() => segment.value?.base_check || null)
const checkStatus = computed(() => baseCheck.value?.status || 'none')
const checkTone = computed(() => {
  if (segment.value?.base_check_satisfied) return 'ok'
  return checkStatus.value === 'failed' || checkStatus.value === 'error' ? 'bad' : 'warn'
})
const assetBaseRef = computed(() => segment.value?.base_ref?.kind === 'asset' ? segment.value.base_ref : null)
/** 该资产的当前生效图（候选里 version_task_id 为空的那条） */
const currentVersionCandidate = computed(() => {
  const ref = assetBaseRef.value
  if (!ref) return null
  return baseCandidates.value.find(item =>
    item.asset_kind === ref.asset_kind && item.asset_id === ref.asset_id && !item.version_task_id) || null
})
/** 本段钉选了具体版本，而资产当前图已经换成了别的 */
const pinnedOutdated = computed(() => Boolean(
  assetBaseRef.value?.version_task_id
  && currentVersionCandidate.value
  && currentVersionCandidate.value.path !== doc.value.base.path,
))

watch(() => props.episodeId, async (episodeId) => {
  baseCandidates.value = []
  if (!episodeId) return
  try {
    const result = await assetPipelineAPI.baseCandidates(episodeId)
    if (props.episodeId === episodeId) baseCandidates.value = result.candidates || []
  } catch { baseCandidates.value = [] }
}, { immediate: true })

async function rerunCheck() {
  const shotId = props.storyboardId
  if (!segment.value) return
  checking.value = true
  error.value = ''
  try {
    const data = await layerSegmentAPI.baseCheck(shotId)
    emit('changed', shotId, data)
    if (!data.started && data.reason) toast.warning(data.reason)
  } catch (e) {
    error.value = e?.body?.reason || e?.message || String(e)
  } finally {
    checking.value = false
  }
}

async function overrideCheck() {
  const shotId = props.storyboardId
  if (!segment.value) return
  const reason = (window.prompt(t('baseCheck.overridePrompt')) || '').trim()
  if (!reason) return
  checking.value = true
  error.value = ''
  try {
    const data = await layerSegmentAPI.baseCheckOverride(shotId, reason)
    emit('changed', shotId, data)
    toast.success(t('baseCheck.overrideDone'))
  } catch (e) {
    error.value = e?.body?.reason || e?.message || String(e)
  } finally {
    checking.value = false
  }
}

/** 以当前图为参考、按项目画幅重出一版；忠实素材与地图道具由后端 400 拒绝，原文照显 */
async function makeAspectVersion() {
  const ref = assetBaseRef.value
  if (!ref) return
  aspectVersioning.value = true
  aspectVersionError.value = ''
  try {
    const data = await assetAspectAPI.generate(ref.asset_kind, ref.asset_id, { episode_id: props.episodeId })
    toast.success(t('baseCheck.aspectVersionStarted', { size: data.size }))
  } catch (e) {
    aspectVersionError.value = e?.body?.message || e?.body?.error || e?.body?.reason || e?.message || String(e)
  } finally {
    aspectVersioning.value = false
  }
}

/** 切到资产当前图（与图层列表的换底图同一条路径：改 doc.base 再保存） */
async function switchToCurrentVersion() {
  const candidate = currentVersionCandidate.value
  if (!candidate) return
  replaceBase({
    path: candidate.path,
    ref: { asset_kind: candidate.asset_kind, asset_id: candidate.asset_id, version_task_id: null },
    ...(candidate.width && candidate.height ? { source_width: candidate.width, source_height: candidate.height } : {}),
  })
  await save()
}

/** 某一时刻：取景框 + 图层不透明度都由时间线插值得出（口径同后端 frameStateAt） */
const frame = computed(() => frameStateAt(
  timeline.value,
  time.value,
  (doc.value?.layers || []).filter(layer => layer.type === 'text').map(layer => layer.id),
))
/**
 * 叠加层按整幅画出，裁切交给外层 DOM，这样底图/滤镜/图层共用同一个取景框。
 * `visibleIds` 必须显式给：`opacity` 只覆盖时间线提到过的图层，缺省 key 在
 * layerDocToSvg 里按 alpha=1 画，没被任何关键帧勾选的图层会全程常显（后端渲染同样排除它们）。
 */
const frameSvg = computed(() => {
  void specVersion.value
  return layerDocToSvg(doc.value, { width: specW.value, height: specH.value }, {
    opacity: frame.value.opacity,
    viewport: {x:0,y:0,w:1,h:1},
    visibleIds: Object.keys(frame.value.opacity).filter(id => frame.value.opacity[id] > 0),
    resolveImage: path => mediaUrl(path),
  })
})
const baseFilters = computed(() => baseFilterLayers(doc.value.base.filter, { width: specW.value, height: specH.value }))
function filterStyle(filter) {
  return { backgroundImage: `url("data:image/svg+xml;charset=utf8,${encodeURIComponent(filter.svg)}")` }
}
/** 把整幅放大 1/size 倍并平移，使取景框正好铺满舞台 */
const cropStyle = computed(() => {
  const vp = frame.value.viewport
  return {
    width: `${(1 / vp.w) * 100}%`,
    height: `${(1 / vp.h) * 100}%`,
    left: `${(-vp.x / vp.w) * 100}%`,
    top: `${(-vp.y / vp.h) * 100}%`,
  }
})
/** 取景框（#94）：底图等比落在 bounds，留白由同图放大模糊垫底，口径与后端取景框画布一致 */
const previewFrame = computed(() => baseFrameOf(doc.value.base, { width: specW.value, height: specH.value }))
const frameStyle = computed(() => {
  const box = previewFrame.value.frame
  return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }
})
const boundsStyle = computed(() => {
  const box = previewFrame.value.bounds
  return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }
})
const baseImageStyle = computed(() => {
  const box = previewFrame.value.bounds
  return { width: `${100 / box.w}%`, height: `${100 / box.h}%`, left: `${-100 * box.x / box.w}%`, top: `${-100 * box.y / box.h}%` }
})
const letterboxed = computed(() => {
  const { bounds, frame: box } = previewFrame.value
  return box.w > bounds.w + 1e-6 || box.h > bounds.h + 1e-6
})
const backdropStyle = computed(() => {
  const { bounds, frame: box } = previewFrame.value
  const scale = Math.max(box.w / bounds.w, box.h / bounds.h)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return {
    width: `${scale / box.w * 100}%`,
    height: `${scale / box.h * 100}%`,
    left: `${(cx * (1 - scale) - box.x) / box.w * 100}%`,
    top: `${(cy * (1 - scale) - box.y) / box.h * 100}%`,
  }
})


function applySegment(next) {
  if (!next) {
    timeline.value = { fps: spec.value?.fps || 25, ease: 'inout', fade_ms: 400, keyframes: [] }
    duration.value = 8
    dirty.value = false
    saveState.value = ''
    return
  }
  load(next.layer_doc)
  // 旧段的取景产生于「裁切边界 + 写死 16:9」：加载时按取景框归一到成片比例（#94）
  timeline.value = clampTimelineToFrame(
    JSON.parse(JSON.stringify(next.timeline)),
    next.layer_doc.base,
    { width: spec.value?.width || next.layer_doc.base.width, height: spec.value?.height || next.layer_doc.base.height },
  ).timeline
  duration.value = next.duration
  keyframeIndex.value = 0
  time.value = 0
  dirty.value = false
  saveState.value = ''
  error.value = ''
}

// 本地有未保存改动时不回灌，避免上层刷新把人正在编辑的图层/时间线冲掉
watch(() => [props.storyboardId, segment.value], ([id, next], old = []) => {
  // 换镜：无论本地脏不脏都按新镜的数据重来
  if (id !== old[0]) { applySegment(next); return }
  if (dirty.value) return
  // A save acknowledgement / status-only refresh must not reset the selected frame or undo history.
  if (next && duration.value === next.duration &&
      JSON.stringify(doc.value) === JSON.stringify(next.layer_doc) &&
      JSON.stringify(timeline.value) === JSON.stringify(next.timeline)) return
  applySegment(next)
}, { immediate: true })

function onPatch({ id, patch }) {
  const result=patchLayer(id, patch)
  if (result && !result.confirmationRequired) markDirty()
}
function onStyle({ id, patch }) { patchStyle(id, patch);markDirty() }
function onTimeline(next) {
  timeline.value = next
  dirty.value = true
  saveState.value = t('episode.segment.unsaved')
}
function onDuration(next) {
  duration.value = next
  dirty.value = true
  saveState.value = t('episode.segment.unsaved')
}

function markDirty() { dirty.value=true;saveState.value=t('episode.segment.unsaved') }
async function enterCanvasTool(tool) {
  mode.value='edit'
  await nextTick()
  if (tool === 'crop') canvasRef.value?.startCrop()
  else canvasRef.value?.startViewport()
}
function applyCrop(raw) {
  pushHistory()
  const crop=normalizeCrop(raw)
  if(crop.x===0 && crop.y===0 && crop.w===1 && crop.h===1) delete doc.value.base.crop
  else doc.value.base.crop=crop
  // 取景按新裁切算出的取景框（contain 时会扩展到成片比例）重新夹取
  const result=clampTimelineToFrame(timeline.value,doc.value.base,{width:specW.value,height:specH.value})
  timeline.value=result.timeline
  if(result.changed) toast.warning(t('layerCanvas.base.framingClamped'))
  markDirty()
}
function replaceBase(base) {
  pushHistory()
  doc.value.base={...doc.value.base,...base}
  markDirty()
}
function onViewport(viewport) {
  const keyframes=timeline.value.keyframes.map((frame,index)=>index===keyframeIndex.value?{...frame,viewport}:frame)
  timeline.value={...timeline.value,keyframes}
  markDirty()
}

async function makeDraft() {
  const shotId = props.storyboardId
  if (!shotId) return
  drafting.value = true
  error.value = ''
  try {
    const data = await layerSegmentAPI.draft(shotId)
    emit('changed', shotId, data)
    if (props.storyboardId === shotId) applySegment(data.segment)
  } catch (e) {
    error.value = e?.body?.code === 'missing_base' ? t('episode.segment.missingBase') : (e?.message || String(e))
  } finally {
    drafting.value = false
  }
}

async function save() {
  const shotId = props.storyboardId
  if (!segment.value) return null
  saving.value = true
  error.value = ''
  try {
    const data = await layerSegmentAPI.save(shotId, {
      layer_doc: JSON.parse(JSON.stringify(doc.value)),
      timeline: JSON.parse(JSON.stringify(timeline.value)),
      duration: duration.value,
    })
    emit('changed', shotId, data)
    // 已经切到别的镜头：只记账，不把这一镜的时间线灌进别人的编辑器
    if (props.storyboardId === shotId && data.segment) {
      acceptSaved(data.segment.layer_doc)
      timeline.value = JSON.parse(JSON.stringify(data.segment.timeline))
      duration.value = data.segment.duration
      dirty.value = false
      saveState.value = t('episode.segment.saved')
    }
    return data.segment
  } catch (e) {
    error.value = e?.body?.reason || e?.message || String(e)
    return null
  } finally {
    saving.value = false
  }
}

async function render() {
  const shotId = props.storyboardId
  if (!segment.value) return
  // 渲染的输入是库里的那份，先把未保存的改动落盘再渲染，避免渲染出旧画面
  if (dirty.value && !(await save())) return
  if (props.storyboardId !== shotId) return
  rendering.value = true
  error.value = ''
  try {
    const data = await layerSegmentAPI.render(shotId)
    renderStamp.value = Date.now()
    emit('changed', shotId, data)
    toast.success(t('episode.segment.renderDone'))
    if (data.keyframes_invalidated) toast.warning(t('episode.segment.junctionInvalidated'))
  } catch (e) {
    error.value = e?.body?.reason || e?.message || String(e)
  } finally {
    rendering.value = false
  }
}

/**
 * 「一键创建标记并锚定」：按该 must_mark 条目的语义坐标插入一个已锚定的 marker 图层
 * （anchor 带 semantic_id/asset_id，表明它兑现的是设计卡里那一条），
 * 并让它在全部关键帧上可见，然后立刻保存（问题条随后端重算消失）。
 */
async function createMarker(issue) {
  if (!segment.value) return
  const x = Number(issue?.x)
  const y = Number(issue?.y)
  const anchor = {}
  if (issue?.semantic_id) anchor.semantic_id = String(issue.semantic_id)
  if (issue?.asset_id) anchor.asset_id = Number(issue.asset_id)
  const layer = addLayer('marker', {
    name: issue?.name || issue?.semantic_id || t('episode.segment.markerName'),
    at: [Number.isFinite(x) ? x : 0.5, Number.isFinite(y) ? y : 0.5],
    text: issue?.name || '',
    anchor,
  })
  timeline.value = {
    ...timeline.value,
    keyframes: (timeline.value.keyframes || []).map(frame => ({ ...frame, visible: [...frame.visible, layer.id] })),
  }
  dirty.value = true
  saveState.value = t('episode.segment.unsaved')
  await save()
}
</script>

<style scoped>
.ls-root { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.ls-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 8px; }
.ls-issue {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 12px;
  border: 1px solid #d8a93a; border-radius: 8px; background: rgba(216, 169, 58, 0.12); color: #8a6508;
}
.ls-issue-text { min-width: 0; }
.ls-check {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 8px;
}
.ls-check.ok { border-color: #2f7d4f; background: rgba(47, 125, 79, 0.1); color: #2f7d4f; }
.ls-check.warn { border-color: #d8a93a; background: rgba(216, 169, 58, 0.12); color: #8a6508; }
.ls-check.bad { border-color: #c0472e; background: rgba(192, 71, 46, 0.1); color: #c0472e; }
.ls-check-text { min-width: 0; }
.ls-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: auto; background: var(--surface-card); }
.ls-main-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.ls-tabs { display: inline-flex; gap: 2px; }
.ls-tab { border: 1px solid var(--border); background: none; color: var(--text-2); font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.ls-tab.on { border-color: var(--accent); color: var(--text-0); }
.ls-stale { font-size: 11px; color: #c0472e; }
.ls-error { margin: 6px 8px; font-size: 12px; color: #c0472e; }
.ls-placeholder { flex: 1; display: grid; place-items: center; font-size: 12.5px; color: var(--text-3); padding: 24px; }
.ls-main .ls-canvas { flex: none; height: clamp(360px, 44vh, 600px); min-height: 360px; }
.ls-preview { flex: none; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px; }
.ls-preview-stage { position: relative; flex-shrink: 0; width: 100%; max-width: 720px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--surface-base); }
.ls-preview-crop { position: absolute; }
/* 位置与尺寸由取景框几何算出；底图框本身等比，绝不用 object-fit 拉伸 */
.ls-preview-frame { position: absolute; overflow: hidden; pointer-events: none; }
.ls-preview-bounds { position: absolute; overflow: hidden; }
.ls-preview-backdrop { position: absolute; filter: blur(12px); user-select: none; }
.ls-preview-base { position: absolute; user-select: none; }
.ls-preview-filter { position: absolute; inset: 0; background-size: 100% 100%; pointer-events: none; }
.ls-preview-svg { position: absolute; inset: 0; }
.ls-preview-svg :deep(svg) { width: 100%; height: 100%; display: block; }
.ls-preview-foot { font-size: 11px; color: var(--text-3); }
.ls-result { border-top: 1px solid var(--border); padding: 8px; }
.ls-result-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
.ls-video { width: 100%; max-width: 480px; display: block; border-radius: 6px; }
.ls-side { min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface-card); }
.ls-spin { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ls-spin 0.8s linear infinite; }
@keyframes ls-spin { to { transform: rotate(360deg); } }
</style>
