<template>
  <div class="cw-root">
    <div class="prod-section-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.prod.production') }}</span>
      <span class="tag mono">{{ t('episode.clip.shotCount', { n: shots.length }) }}</span>
      <span v-if="spec" class="tag mono">{{ t('episode.clip.spec', { w: spec.width, h: spec.height, fps: spec.fps }) }}</span>
      <span v-if="spec && spec.source === 'default'" class="dim" style="font-size:11px">{{ t('episode.clip.specDefault') }}</span>
    </div>

    <div v-if="!shots.length" class="step-empty" style="flex:1">
      <div class="empty-visual">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      </div>
      <div class="empty-title">{{ t('episode.clip.emptyTitle') }}</div>
      <div class="empty-desc">{{ t('episode.clip.emptyDesc') }}</div>
    </div>

    <div v-else class="cw-body">
      <!-- 左：确定性镜头列表 -->
      <section class="cw-list">
        <div
          v-for="shot in shots" :key="shot.sb.id"
          :class="['cw-shot', { on: selectedId === shot.sb.id }]"
          role="button" tabindex="0"
          @click="select(shot.sb.id)" @keydown.enter.prevent="select(shot.sb.id)"
        >
          <div class="cw-shot-line">
            <span class="cw-shot-no">#{{ String(shot.index + 1).padStart(2, '0') }}</span>
            <strong class="cw-shot-title truncate">{{ shot.title }}</strong>
          </div>
          <div class="cw-shot-meta">
            <span class="tag">{{ deviceLabel(shot.device) }}</span>
            <span class="tag">{{ clipLabel(shot.position) }}</span>
            <span :class="['cw-state', 'is-' + statusOf(shot.sb.id)]">{{ statusLabel(statusOf(shot.sb.id)) }}</span>
          </div>
        </div>
      </section>

      <!-- 中：图层画布 / 时刻预览 -->
      <section class="cw-main">
        <div class="cw-main-bar">
          <div class="cw-tabs">
            <button type="button" :class="['cw-tab', { on: mode === 'edit' }]" @click="mode = 'edit'">{{ t('episode.clip.modeEdit') }}</button>
            <button type="button" :class="['cw-tab', { on: mode === 'preview' }]" @click="mode = 'preview'">{{ t('episode.clip.modePreview') }}</button>
          </div>
          <span v-if="clip && !clip.fresh && clip.render_path" class="cw-stale">{{ t('episode.clip.staleWarn') }}</span>
          <span v-if="saveState" class="dim" style="font-size:11px">{{ saveState }}</span>
          <span class="ml-auto" />
          <button type="button" class="btn btn-sm" :disabled="!selectedId || drafting || rendering" @click="makeDraft">
            {{ drafting ? t('episode.clip.drafting') : t('episode.clip.draft') }}
          </button>
          <button type="button" class="btn btn-sm" :disabled="!clip || saving || !dirty" @click="save()">
            {{ saving ? t('episode.clip.saving') : t('episode.clip.save') }}
          </button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="!clip || rendering || saving" @click="render">
            <span v-if="rendering" class="cw-spin" />
            {{ rendering ? t('episode.clip.rendering') : t('episode.clip.render') }}
          </button>
        </div>

        <p v-if="error" class="cw-error">{{ error }}</p>

        <div v-if="!clip" class="cw-placeholder">{{ t('episode.clip.noClip') }}</div>
        <template v-else>
          <LayerCanvas
            v-show="mode === 'edit'"
            class="cw-canvas" :doc="doc" :selected-ids="selectedIds" :base-src="baseSrc"
            @select="selectedIds = $event" @history="pushHistory" @patch="onPatch"
            @delete="removeSelected" @duplicate="duplicateSelected" @undo="undo" @redo="redo"
          />
          <div v-if="mode === 'preview'" class="cw-preview">
            <!-- 与后端 composeFrame 同构：底图合滤镜 → 按取景框裁放 → 叠加层 SVG -->
            <div class="cw-preview-stage" :style="{ aspectRatio: `${specW} / ${specH}` }">
              <div class="cw-preview-crop" :style="cropStyle">
                <img v-if="baseSrc" class="cw-preview-base" :src="baseSrc" alt="" draggable="false">
                <div v-for="filter in baseFilters" :key="filter.id" class="cw-preview-filter" :style="filterStyle(filter)" />
                <!-- eslint-disable-next-line vue/no-v-html -- 与后端同源的 layerDocToSvg 输出，内容已转义 -->
                <div class="cw-preview-svg" v-html="frameSvg" />
              </div>
            </div>
            <div class="cw-preview-foot mono">{{ t('episode.clip.previewAt', { t: time.toFixed(2) }) }}</div>
          </div>
        </template>

        <div v-if="clip && clip.render_path" class="cw-result">
          <div class="cw-result-head">
            <span>{{ t('episode.clip.renderResult') }}</span>
            <span v-if="!clip.fresh" class="cw-stale">{{ t('episode.clip.staleWarn') }}</span>
          </div>
          <video :key="clip.render_path + renderStamp" :src="mediaUrl(clip.render_path)" controls preload="metadata" playsinline class="cw-video" />
        </div>
      </section>

      <!-- 右：图层与时间线 -->
      <section class="cw-side">
        <div class="cw-tabs cw-side-tabs">
          <button type="button" :class="['cw-tab', { on: sideTab === 'timeline' }]" @click="sideTab = 'timeline'">{{ t('episode.clip.tabTimeline') }}</button>
          <button type="button" :class="['cw-tab', { on: sideTab === 'layers' }]" @click="sideTab = 'layers'">{{ t('episode.clip.tabLayers') }}</button>
        </div>
        <template v-if="clip">
          <ClipTimelinePanel
            v-if="sideTab === 'timeline'"
            :doc="doc" :timeline="timeline" :duration="duration" :position="clip.position"
            :spec="{ width: specW, height: specH, fps: timeline.fps }"
            :time="time" :selected-index="stateIndex"
            @update:timeline="onTimeline" @update:duration="onDuration"
            @update:time="v => { time = v }" @update:selected-index="v => { stateIndex = v }"
          />
          <div v-else class="cw-layer-tools">
            <LayerList
              class="cw-layer-list" :doc="doc" :selected-ids="selectedIds"
              @select="selectedIds = $event" @history="pushHistory" @patch="onPatch"
              @reorder="reorder($event.id, $event.toIndex)" @add="addLayer" @remove="removeSelected" @duplicate="duplicateSelected"
            />
            <LayerStyle
              class="cw-layer-style" :doc="doc" :layer="selectedLayers.length === 1 ? selectedLayers[0] : null"
              @history="pushHistory" @patch="onPatch" @style="onStyle" @theme="setTheme" @filter="setFilter"
            />
          </div>
        </template>
        <div v-else class="cw-placeholder">{{ t('episode.clip.noClip') }}</div>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * 确定性片段工作台（Issue #50）：左选镜 → 生成草稿 → 图层画布编辑 → 时间线关键状态
 * → 时刻预览（与后端 frameStateAt 同口径）→ 同步渲染 → 播放成片。
 * 片段数据的唯一真相在后端 /clips；这里保存后一律用返回的 clip 覆盖本地状态。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import LayerCanvas from '~/components/LayerCanvas/LayerCanvas.vue'
import LayerList from '~/components/LayerCanvas/LayerList.vue'
import LayerStyle from '~/components/LayerCanvas/LayerStyle.vue'
import ClipTimelinePanel from '~/components/ClipWorkspace/ClipTimelinePanel.vue'
import { useLayerDoc } from '~/composables/useLayerDoc'
import { clipAPI } from '~/composables/useApi'
import { toast } from 'vue-sonner'
import { frameStateAt } from '~/utils/clipTimeline'
import { baseFilterLayers, layerDocToSvg } from '~/utils/layerSvg'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  storyboards: { type: Array, default: () => [] },
  // 由关键帧页 / 视频页跳转过来时要聚焦的镜头
  focusStoryboardId: { type: Number, default: 0 },
})
const emit = defineEmits(['changed'])
const { t } = useI18n()

const selectedId = ref(0)
const clips = ref({})
const spec = ref(null)
const mode = ref('edit')
const sideTab = ref('timeline')
const time = ref(0)
const stateIndex = ref(0)
const timeline = ref({ fps: 25, ease: 'inout', fade_ms: 400, states: [] })
const duration = ref(8)
const dirty = ref(false)
const saving = ref(false)
const drafting = ref(false)
const rendering = ref(false)
const saveState = ref('')
const error = ref('')
const renderStamp = ref(0)

const {
  doc, selectedIds, selectedLayers,
  load, pushHistory, undo, redo, patchLayer, patchStyle,
  addLayer, removeSelected, duplicateSelected, reorder, setTheme, setFilter,
} = useLayerDoc(() => {
  if (!clip.value) return
  dirty.value = true
  saveState.value = t('episode.clip.unsaved')
})

/** 段组合（#57）→ 图层段位置：A 整镜替代、C 在模型视频之前、D 在之后 */
function comboPosition(combo) {
  return combo === 'A' ? 'replace' : combo === 'C' ? 'pre' : combo === 'D' ? 'post' : 'none'
}

/** 列表：只列有图层段的镜头 */
const shots = computed(() => props.storyboards
  .map((sb, index) => ({ sb, index, device: '', position: comboPosition(sb?.combo) }))
  .filter(item => item.position && item.position !== 'none')
  .map(item => ({ ...item, title: item.sb.title || item.sb.description || t('episode.clip.untitled') })))

const clip = computed(() => clips.value[selectedId.value] || null)
const specW = computed(() => spec.value?.width || doc.value.base.width || 960)
const specH = computed(() => spec.value?.height || doc.value.base.height || 544)
const baseSrc = computed(() => mediaUrl(doc.value.base.path))

/** 某一时刻：取景框 + 图层不透明度都由时间线插值得出（口径同后端 frameStateAt） */
const frame = computed(() => frameStateAt(timeline.value, time.value))
/**
 * 叠加层按整幅画出，裁切交给外层 DOM，这样底图/滤镜/图层共用同一个取景框。
 * `visibleIds` 必须显式给：`opacity` 只覆盖时间线提到过的图层，缺省 key 在
 * layerDocToSvg 里按 alpha=1 画，没被任何状态勾选的图层会全程常显（后端
 * clip-render.ts 同样用 visibleIds 排除它们）。
 */
const frameSvg = computed(() => layerDocToSvg(doc.value, { width: specW.value, height: specH.value }, {
  opacity: frame.value.opacity,
  visibleIds: Object.keys(frame.value.opacity).filter(id => frame.value.opacity[id] > 0),
  resolveImage: path => mediaUrl(path),
}))
const baseFilters = computed(() => baseFilterLayers(doc.value.base.filter, { width: specW.value, height: specH.value }))
function filterStyle(filter) {
  return { backgroundImage: `url("data:image/svg+xml;charset=utf8,${encodeURIComponent(filter.svg)}")` }
}
/** 把整幅放大 1/size 倍并平移，使取景框正好铺满舞台 */
const cropStyle = computed(() => {
  const vp = frame.value.viewport
  const size = vp.w > 0 ? vp.w : 1
  return {
    width: `${(1 / size) * 100}%`,
    height: `${(1 / size) * 100}%`,
    left: `${(-vp.x / size) * 100}%`,
    top: `${(-vp.y / size) * 100}%`,
  }
})

// 段标签（R5 会按段组合重构本组件，这里只做键名替换，口径统一为「图层段」）
function deviceLabel() { return t('episode.design.segment.layer') }
function clipLabel() { return t('episode.design.segment.layer') }

function statusOf(sbId) {
  const item = clips.value[sbId]
  if (!item) return 'none'
  if (item.status === 'failed') return 'failed'
  if (item.status === 'rendering') return 'rendering'
  if (!item.render_path) return 'draft'
  return item.fresh ? 'ready' : 'stale'
}
function statusLabel(status) { return t(`episode.clip.status.${status}`) }

async function loadShot(sbId, { silent = false } = {}) {
  if (!sbId) return
  try {
    const data = await clipAPI.list(sbId)
    spec.value = data.spec
    const intentPosition = comboPosition(props.storyboards.find(sb => sb.id === sbId)?.combo)
    const found = (data.clips || []).find(c => c.position === intentPosition) || (data.clips || [])[0] || null
    clips.value = { ...clips.value, [sbId]: found }
    // 本地有未保存改动时不回灌，避免分镜刷新把人正在编辑的图层/时间线冲掉
    if (sbId !== selectedId.value || dirty.value) return
    if (found) applyClip(found)
    else resetEditor()
  } catch (e) {
    if (!silent) error.value = e?.message || String(e)
  }
}

/** 列表状态：确定性镜头数量有限，进页面时一次性问齐，列表上就能看到草稿/已渲染 */
async function loadAll() {
  for (const shot of shots.value) await loadShot(shot.sb.id, { silent: true })
}

function applyClip(next) {
  load(next.layer_doc)
  timeline.value = JSON.parse(JSON.stringify(next.timeline))
  duration.value = next.duration
  stateIndex.value = 0
  time.value = 0
  dirty.value = false
  saveState.value = ''
  error.value = ''
}

function resetEditor() {
  timeline.value = { fps: spec.value?.fps || 25, ease: 'inout', fade_ms: 400, states: [] }
  duration.value = 8
  dirty.value = false
  saveState.value = ''
}

function select(sbId) {
  if (selectedId.value === sbId) return
  selectedId.value = sbId
  const existing = clips.value[sbId]
  if (existing) applyClip(existing)
  else {
    resetEditor()
    void loadShot(sbId)
  }
}

function onPatch({ id, patch }) { patchLayer(id, patch) }
function onStyle({ id, patch }) { patchStyle(id, patch) }
function onTimeline(next) {
  timeline.value = next
  dirty.value = true
  saveState.value = t('episode.clip.unsaved')
}
function onDuration(next) {
  duration.value = next
  dirty.value = true
  saveState.value = t('episode.clip.unsaved')
}

async function makeDraft() {
  // 请求期间人可以切镜：id 一律在发请求前捕获，响应只写回它自己那一镜
  const shotId = selectedId.value
  if (!shotId) return
  drafting.value = true
  error.value = ''
  try {
    const data = await clipAPI.draft(shotId)
    spec.value = data.spec
    clips.value = { ...clips.value, [shotId]: data.clip }
    if (selectedId.value === shotId) applyClip(data.clip)
    emit('changed')
  } catch (e) {
    error.value = e?.message || String(e)
  } finally {
    drafting.value = false
  }
}

async function save() {
  const shotId = selectedId.value
  const target = clip.value
  if (!target) return null
  saving.value = true
  error.value = ''
  try {
    const data = await clipAPI.save(shotId, target.position, {
      layer_doc: JSON.parse(JSON.stringify(doc.value)),
      timeline: JSON.parse(JSON.stringify(timeline.value)),
      duration: duration.value,
    })
    spec.value = data.spec
    clips.value = { ...clips.value, [shotId]: data.clip }
    // 已经切到别的镜头：只记账，不把这一镜的时间线灌进别人的编辑器
    if (selectedId.value === shotId) {
      timeline.value = JSON.parse(JSON.stringify(data.clip.timeline))
      duration.value = data.clip.duration
      dirty.value = false
      saveState.value = t('episode.clip.saved')
    }
    emit('changed')
    return data.clip
  } catch (e) {
    error.value = e?.message || String(e)
    return null
  } finally {
    saving.value = false
  }
}

async function render() {
  const shotId = selectedId.value
  const target = clip.value
  if (!target) return
  // 渲染的输入是库里的那份，先把未保存的改动落盘再渲染，避免渲染出旧画面
  if (dirty.value && !(await save())) return
  if (selectedId.value !== shotId) return
  rendering.value = true
  error.value = ''
  try {
    const data = await clipAPI.render(shotId, target.position)
    spec.value = data.spec
    if (data.clip) clips.value = { ...clips.value, [shotId]: data.clip }
    renderStamp.value = Date.now()
    toast.success(t('episode.clip.renderDone'))
    emit('changed')
  } catch (e) {
    error.value = e?.message || String(e)
  } finally {
    rendering.value = false
  }
}

watch(() => props.storyboards, () => {
  if (!selectedId.value || !shots.value.some(shot => shot.sb.id === selectedId.value)) {
    selectedId.value = shots.value[0]?.sb.id || 0
  }
  void loadAll()
}, { immediate: true })

watch(() => props.focusStoryboardId, (id) => {
  if (id && shots.value.some(shot => shot.sb.id === id)) select(id)
}, { immediate: true })
</script>

<style scoped>
.cw-root { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.cw-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr) 320px; gap: 8px; }
.cw-list { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
.cw-shot { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; cursor: pointer; background: var(--surface-card); }
.cw-shot.on { border-color: var(--accent); }
.cw-shot-line { display: flex; align-items: center; gap: 6px; }
.cw-shot-no { font-size: 11px; color: var(--text-3); }
.cw-shot-title { font-size: 12.5px; min-width: 0; }
.cw-shot-meta { display: flex; align-items: center; gap: 4px; margin-top: 4px; flex-wrap: wrap; font-size: 11px; }
.cw-state { font-size: 11px; color: var(--text-3); }
.cw-state.is-ready { color: #2e8b57; }
.cw-state.is-stale, .cw-state.is-failed { color: #c0472e; }
.cw-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: auto; background: var(--surface-card); }
.cw-main-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.cw-tabs { display: inline-flex; gap: 2px; }
.cw-tab { border: 1px solid var(--border); background: none; color: var(--text-2); font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.cw-tab.on { border-color: var(--accent); color: var(--text-0); }
.cw-stale { font-size: 11px; color: #c0472e; }
.cw-error { margin: 6px 8px; font-size: 12px; color: #c0472e; }
.cw-placeholder { flex: 1; display: grid; place-items: center; font-size: 12.5px; color: var(--text-3); padding: 24px; }
.cw-canvas { flex: 1; min-height: 320px; }
.cw-preview { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px; }
.cw-preview-stage { position: relative; width: 100%; max-width: 720px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--surface-base); }
.cw-preview-crop { position: absolute; }
.cw-preview-base { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; user-select: none; }
.cw-preview-filter { position: absolute; inset: 0; background-size: 100% 100%; pointer-events: none; }
.cw-preview-svg { position: absolute; inset: 0; }
.cw-preview-svg :deep(svg) { width: 100%; height: 100%; display: block; }
.cw-preview-foot { font-size: 11px; color: var(--text-3); }
.cw-result { border-top: 1px solid var(--border); padding: 8px; }
.cw-result-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
.cw-video { width: 100%; max-width: 480px; display: block; border-radius: 6px; }
.cw-side { min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface-card); }
.cw-side-tabs { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.cw-layer-tools { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.cw-layer-list { min-height: 160px; }
.cw-layer-style { min-height: 0; }
.cw-spin { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: cw-spin 0.8s linear infinite; }
@keyframes cw-spin { to { transform: rotate(360deg); } }
</style>
