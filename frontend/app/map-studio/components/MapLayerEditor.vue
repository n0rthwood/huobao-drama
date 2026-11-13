<template>
  <div class="mle-overlay" @click.self="requestClose">
    <div class="mle-dialog">
      <div class="mle-bar">
        <strong class="mle-title">{{ t('mapStudio.layerEditor.title') }}</strong>
        <span v-if="assetName" class="dim">{{ assetName }}</span>
        <span class="dim">{{ t('mapStudio.panel.revision', { n: revision }) }}</span>
        <span v-if="dirty" class="mle-state">{{ t('mapStudio.layerEditor.unsaved') }}</span>
        <span class="mle-spacer" />
        <button type="button" class="mle-tool" :disabled="!canUndo || saving" :title="t('layerCanvas.toolbar.undo')" @click="undo">
          <Undo2 :size="12" />
        </button>
        <button type="button" class="mle-tool" :disabled="!canRedo || saving" :title="t('layerCanvas.toolbar.redo')" @click="redo">
          <Redo2 :size="12" />
        </button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="saving || !dirty" @click="save">
          <Loader2 v-if="saving" :size="12" class="animate-spin" />
          {{ saving ? t('mapStudio.layerEditor.saving') : t('mapStudio.layerEditor.save') }}
        </button>
        <button type="button" class="mle-tool" :disabled="saving" @click="requestClose">
          <X :size="12" />
          {{ t('mapStudio.layerEditor.close') }}
        </button>
      </div>

      <p class="mle-hint dim">{{ t('mapStudio.layerEditor.hint') }}</p>
      <p v-if="conflictMessage" class="mle-warn">{{ conflictMessage }}</p>
      <p v-if="error" class="mle-error">{{ error }}</p>
      <section v-if="problems.length" class="mle-problems">
        <strong>{{ t('mapStudio.layerEditor.problemsTitle', { n: problems.length }) }}</strong>
        <ul>
          <li v-for="(problem, index) in problems" :key="index">
            <code>{{ problem.path || t('mapStudio.layerEditor.problemRoot') }}</code>
            <span>{{ problem.message }}</span>
          </li>
        </ul>
        <span class="dim">{{ t('mapStudio.layerEditor.invalidHint') }}</span>
      </section>
      <p v-if="missingGlyphs.length" class="mle-error">{{ t('layerCanvas.style.missingChars', { chars: missingGlyphs.join(' ') }) }}</p>

      <div class="mle-body">
        <section class="mle-main">
          <LayerCanvas
            :doc="canvasDoc"
            :selected-ids="selectedIds"
            :base-src="baseSrc"
            crop-locked
            :missing-glyphs="missingGlyphs"
            :can-undo="canUndo"
            :can-redo="canRedo"
            @select="selectedIds = $event"
            @history="pushHistory"
            @patch="onPatch"
            @delete="onRemove"
            @duplicate="onDuplicate"
            @undo="undo"
            @redo="redo"
            @detach="onDetach"
          />
        </section>
        <aside class="mle-side">
          <LayerList
            :doc="doc"
            :selected-ids="selectedIds"
            @select="selectedIds = $event"
            @history="pushHistory"
            @patch="onPatch"
            @reorder="onReorder"
            @add="onAdd"
            @remove="onRemove"
            @duplicate="onDuplicate"
          />
          <!-- 标签排版问题：点一行就选中对应图层（沿用现有 mssel），自动排布只写草稿、可撤销 -->
          <section class="mle-issues">
            <header class="mle-issues-head">
              <strong>{{ t('mapStudio.layerEditor.labelIssuesTitle', { n: labelProblems.length }) }}</strong>
              <button
                type="button"
                class="mle-tool"
                :disabled="saving || laying || !doc.layers.length"
                @click="autoLayout"
              >
                <Loader2 v-if="laying" :size="11" class="animate-spin" />
                {{ laying ? t('mapStudio.layerEditor.autoLayoutBusy') : t('mapStudio.layerEditor.autoLayout') }}
              </button>
            </header>
            <p v-if="labelError" class="mle-error">{{ labelError }}</p>
            <p v-else-if="!labelProblems.length" class="mle-issues-ok">{{ t('mapStudio.layerEditor.labelIssuesEmpty') }}</p>
            <ul v-else class="mle-issues-list">
              <li v-for="(problem, index) in labelProblems" :key="`${problem.layer_id ?? problem.path}-${index}`">
                <button
                  type="button"
                  class="mle-issue-row"
                  :disabled="!problemLayerId(problem)"
                  :title="problem.path"
                  @click="selectProblemLayer(problem)"
                >
                  <span class="mle-code">{{ problemCode(problem) }}</span>
                  <span>{{ problem.message }}</span>
                </button>
              </li>
            </ul>
            <div v-if="unresolved.length" class="mle-unresolved">
              <strong>{{ t('mapStudio.layerEditor.unresolvedTitle', { n: unresolved.length }) }}</strong>
              <ul class="mle-issues-list">
                <li v-for="row in unresolved" :key="row.layer_id">
                  <button type="button" class="mle-issue-row" @click="selectLayer(row.layer_id)">
                    <span class="mle-code">{{ row.layer_id }}</span>
                    <span>{{ row.message }}</span>
                  </button>
                </li>
              </ul>
              <span class="dim">{{ t('mapStudio.layerEditor.unresolvedHint') }}</span>
            </div>
            <p v-if="hasSmoothing" class="dim">{{ t('mapStudio.layerEditor.smoothingPreviewNote') }}</p>
          </section>
          <LayerStyle :doc="doc" document-only @theme="onTheme" @filter="onFilter" />
          <LayerStyle
            :doc="doc"
            :layer="selectedLayer"
            layer-only
            @patch="onPatch"
            @style="onStyle"
            @history="pushHistory"
          />
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 地图图层编辑器（Issue #90；阶段 ③ 补平滑预览与标签排版）。
 *
 * 模型在绘制阶段交付的 LayerDoc 就是这里编辑的对象：画布、图层列表与样式面板全部复用
 * LayerCanvas 套件，预览走和后端同源的 `utils/layerSvg.js`，**不新造第二个渲染器**。
 * 画布拿的是 `renderCopyWithSmoothing` 的渲染副本（只改画出来的曲线），编辑永远写回文档里的
 * **原始控制点**——LayerCanvas 看不出两套几何，所以拖动/缩放的回调由 `mapSmoothEdit` 反解回控制点；
 * 反解不了就明确拒绝并提示，绝不把采样点当控制点落盘，也不静默丢改动。
 * 侧栏列出服务端只读检查（严格校验 + 平滑偏离 + 标签排版）的问题，点一行选中对应图层；
 * 「自动排布标签」调用后端同一个纯函数，结果只进草稿（可撤销），不删除标签、不缩字号。
 * 保存走 PUT /map-studio/tasks/:id/layer-doc：服务端严格校验，只有精确投影的已存要素允许密集顶点，
 * 用同一条 renderLayerDoc 链重绘并登记新版本。提交前只做后端一定会做的两件事——按 z 稳定排序、
 * 重复 id 加后缀；其余不合法的地方原样提交，由服务端逐条指出来，绝不在本地偷偷改成「能过」的值。
 * 密集数据集几何（600+ 投影点）在前端只读加载/保存，绝不截断。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2, Redo2, Undo2, X } from 'lucide-vue-next'
import LayerCanvas from '~/components/LayerCanvas/LayerCanvas.vue'
import LayerList from '~/components/LayerCanvas/LayerList.vue'
import LayerStyle from '~/components/LayerCanvas/LayerStyle.vue'
import { useLayerDoc } from '~/composables/useLayerDoc'
import { mapLayerDocProblemsOf, mapLayerProblemLayerId, mapStudioAPI, mapStudioConflictOf } from '~/map-studio/api'
import { normalizeMapLayerDoc } from '~/map-studio/utils/mapLayerDoc'
import { remapCanvasPatch } from '~/map-studio/utils/mapSmoothEdit'
import { renderCopyWithSmoothing } from '~/map-studio/utils/smooth'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  taskId: { type: Number, required: true },
  layerDoc: { type: Object, required: true },
  /** 阶段 ③：按图层 id 保存的平滑强度；画布用它渲染平滑副本，编辑永远写回控制点 */
  layerOptions: { type: Object, default: () => ({}) },
  revision: { type: Number, default: 0 },
  assetName: { type: String, default: '' },
})
const emit = defineEmits(['close', 'saved', 'conflict'])
const { t, te } = useI18n()

const saving = ref(false)
const error = ref('')
const conflictMessage = ref('')
const problems = ref([])
const loaded = ref('')
const laying = ref(false)
const labelProblems = ref([])
const unresolved = ref([])
const labelError = ref('')

const {
  doc, selectedIds, selectedLayers, canUndo, canRedo, missingGlyphs,
  load, pushHistory, undo, redo, patchLayer, patchStyle, detachAnchors,
  addLayer, removeSelected, duplicateSelected, reorder, setTheme, setFilter,
} = useLayerDoc()

const selectedLayer = computed(() => selectedLayers.value[0] || null)
const baseSrc = computed(() => (doc.value.base.path ? mediaUrl(doc.value.base.path) : ''))
/** 草稿是否偏离打开时的服务端文档；提交失败后仍然保留，不会被外部刷新冲掉 */
const dirty = computed(() => JSON.stringify(doc.value) !== loaded.value)

/**
 * 画布拿到的是平滑后的渲染副本：只改画出来的曲线，存储里的控制点一个不动。
 * 回调（拖动/缩放）经 remapCanvasPatch 反解回控制点，采样点绝不会被当成控制点写进文档。
 */
const canvasDoc = computed(() => renderCopyWithSmoothing(doc.value, props.layerOptions || {}))
const hasSmoothing = computed(() => Object.values(props.layerOptions || {}).some(option => Number(option?.smooth) > 0))

/** 问题行点击选中：服务端 layer_id 优先；没有时按服务端看到的 z 序文档解析 layers[N] */
function problemLayerId(problem) {
  if (problem?.layer_id && doc.value.layers.some(layer => layer.id === problem.layer_id)) return problem.layer_id
  const checked = normalizeMapLayerDoc(JSON.parse(JSON.stringify(doc.value)))
  return mapLayerProblemLayerId(problem, checked.layers)
}

function selectProblemLayer(problem) {
  const id = problemLayerId(problem)
  if (id) selectLayer(id)
}

function selectLayer(id) {
  if (id && doc.value.layers.some(layer => layer.id === id)) selectedIds.value = [id]
}

/** 问题代码按语言显示；没有翻译就直接显示代码本身，不吞掉服务端给的分类 */
function problemCode(problem) {
  const code = problem?.code || ''
  if (!code) return problem?.path || t('mapStudio.layerEditor.problemRoot')
  const key = `mapStudio.layerEditor.problemCode.${code}`
  return te(key) ? t(key) : code
}

function applyDoc(next) {
  const snapshot = JSON.parse(JSON.stringify(next))
  load(snapshot)
  loaded.value = JSON.stringify(snapshot)
  selectedIds.value = doc.value.layers[0] ? [doc.value.layers[0].id] : []
  problems.value = []
  labelProblems.value = []
  unresolved.value = []
  labelError.value = ''
  conflictMessage.value = ''
  error.value = ''
}

// 外部刷新只在本地没有改动时回灌，正在编辑的内容一个字都不动
watch(() => props.layerDoc, next => {
  if (!next || saving.value || dirty.value) return
  if (JSON.stringify(next) === loaded.value) return
  applyDoc(next)
})

/**
 * 选中图层是工作位置：用稳定的图层 id 写进 mssel，刷新/新标签回到同一个图层与样式面板。
 * 恢复只改选择，不触发任何保存或重绘；图层已不存在就清键并提示，不静默换一个图层冒充。
 */
const selectionLink = useDeeplink('mapStudioLayerSel', DEEPLINK_KEYS.mapStudioLayer)

function restoreSelectionFromLink() {
  const raw = selectionLink.initial('mssel')
  if (!raw) return
  if (doc.value.layers.some(layer => layer.id === raw)) {
    selectedIds.value = [raw]
    return
  }
  selectionLink.set({ mssel: '' })
  toast.warning(t('deeplink.missingNamed', { target: t('mapStudio.layerEditor.layerTarget') }))
}

watch(selectedIds, ids => selectionLink.set({ mssel: ids[0] ?? '' }))

onMounted(() => {
  applyDoc(props.layerDoc)
  restoreSelectionFromLink()
  window.addEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (checkTimer) clearTimeout(checkTimer)
})

/** Esc 只关自己这一层：捕获阶段拦下，宿主弹窗的全局 Esc 不能顺带把资产也关掉 */
function onKeydown(event) {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  requestClose()
}

function requestClose() {
  if (saving.value) return
  if (dirty.value && !window.confirm(t('mapStudio.layerEditor.confirmDiscard'))) return
  emit('close')
}

function onPatch({ id, patch }) {
  // 画布显示的是平滑副本：回调点必须反解回控制点，绝不把采样点写进文档
  const controlLayer = doc.value.layers.find(layer => layer.id === id)
  const renderedLayer = canvasDoc.value.layers.find(layer => layer.id === id)
  const remapped = remapCanvasPatch(patch, controlLayer, renderedLayer, props.layerOptions || {})
  if (!remapped) {
    // 点数对不上时宁可拒绝这次改动并明说，也不把采样点当控制点写进去、更不静默丢弃
    warnRemapFailure()
    return
  }
  patchLayer(id, remapped)
}

let lastRemapWarn = 0
function warnRemapFailure() {
  const now = Date.now()
  if (now - lastRemapWarn < 2000) return
  lastRemapWarn = now
  toast.warning(t('mapStudio.layerEditor.remapFailed'))
}
function onStyle({ id, patch }) {
  patchStyle(id, patch)
}
function onDetach(ids) {
  detachAnchors(ids)
}
function onReorder({ id, toIndex }) {
  reorder(id, toIndex)
}
function onAdd(type, partial) {
  const layer = addLayer(type, partial)
  // 后端 normalizeLayer 的 card 一定带 fields.years；新建时就补上，否则严格校验必然拒收
  if (layer?.type === 'card' && layer.fields && !('years' in layer.fields)) layer.fields.years = ''
}
function onRemove() {
  removeSelected()
}
function onDuplicate() {
  duplicateSelected()
}
function onTheme(theme) {
  setTheme(theme)
}
function onFilter(patch) {
  setFilter(patch)
}

/** 提交前镜像后端口径（z 排序 + id 去重），检查与保存看到的是同一份文档 */
function draftPayload() {
  return normalizeMapLayerDoc(JSON.parse(JSON.stringify(doc.value)))
}

let checkTimer = null
let checkSequence = 0
/** 自动排布之后文档没再动过才保留那次 unresolved；用户一改文档，旧结论就不能继续挂着 */
let layoutBaseline = ''

function scheduleCheck() {
  checkSequence += 1
  if (layoutBaseline && JSON.stringify(doc.value) !== layoutBaseline) {
    unresolved.value = []
    layoutBaseline = ''
  }
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = setTimeout(() => { checkTimer = null; void refreshProblems() }, 600)
}
watch(doc, scheduleCheck, { deep: true })
watch(() => props.layerOptions, scheduleCheck, { deep: true })

/** 只读检查：逐条列出严格校验、平滑偏离与标签排版问题；不保存、不重绘 */
async function refreshProblems() {
  if (saving.value || laying.value) return
  const sequence = checkSequence
  labelError.value = ''
  try {
    const result = await mapStudioAPI.checkLayerDoc(props.taskId, draftPayload(), props.layerOptions)
    if (sequence !== checkSequence || saving.value || laying.value) return
    labelProblems.value = result.problems || []
  } catch (err) {
    if (sequence !== checkSequence || saving.value || laying.value) return
    const conflict = mapStudioConflictOf(err)
    if (conflict) {
      conflictMessage.value = conflict.message || t('mapStudio.panel.conflictDefault')
      return
    }
    labelError.value = String(err?.body?.message || err?.message || t('mapStudio.layerEditor.checkFailed'))
  }
}

/**
 * 自动排布标签：服务端跑与作图阶段同一个纯函数，返回调整后的文档与排不下的条目。
 * 结果写进草稿并压一条历史（可撤销），不删除标签、不缩字号，也不自动保存。
 */
async function autoLayout() {
  if (saving.value || laying.value) return
  const baseline = JSON.stringify(doc.value)
  laying.value = true
  error.value = ''
  labelError.value = ''
  try {
    const result = await mapStudioAPI.autoLayoutLayerDoc(props.taskId, draftPayload(), props.layerOptions)
    if (JSON.stringify(doc.value) !== baseline) {
      labelError.value = t('mapStudio.layerEditor.layoutChanged')
      return
    }
    pushHistory()
    const next = JSON.parse(JSON.stringify(result.layer_doc))
    doc.value = next
    selectedIds.value = selectedIds.value.filter(id => next.layers.some(layer => layer.id === id))
    labelProblems.value = result.problems || []
    unresolved.value = result.unresolved || []
    layoutBaseline = JSON.stringify(next)
    if (unresolved.value.length) toast.warning(t('mapStudio.layerEditor.unresolvedTitle', { n: unresolved.value.length }))
    else toast.success(t('mapStudio.layerEditor.autoLayoutDone'))
  } catch (err) {
    const conflict = mapStudioConflictOf(err)
    if (conflict) {
      conflictMessage.value = conflict.message || t('mapStudio.panel.conflictDefault')
      emit('conflict')
      return
    }
    const invalid = mapLayerDocProblemsOf(err)
    if (invalid) {
      labelProblems.value = invalid.problems
      error.value = invalid.message || t('mapStudio.layerEditor.invalidTitle')
      return
    }
    labelError.value = String(err?.body?.message || err?.message || err)
  } finally {
    laying.value = false
  }
}

async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  error.value = ''
  conflictMessage.value = ''
  problems.value = []
  try {
    const payload = normalizeMapLayerDoc(JSON.parse(JSON.stringify(doc.value)))
    const detail = await mapStudioAPI.saveLayerDoc(props.taskId, payload, props.revision, props.layerOptions)
    emit('saved', detail)
    toast.success(t('mapStudio.layerEditor.saved'))
    emit('close')
  } catch (err) {
    const conflict = mapStudioConflictOf(err)
    if (conflict) {
      // 冲突不改服务端状态：草稿一个字不动，只请宿主回读最新修订号，改好后可直接重试保存
      conflictMessage.value = conflict.message || t('mapStudio.panel.conflictDefault')
      emit('conflict')
      return
    }
    const invalid = mapLayerDocProblemsOf(err)
    if (invalid) {
      problems.value = invalid.problems
      error.value = invalid.message || t('mapStudio.layerEditor.invalidTitle')
      return
    }
    error.value = String(err?.body?.message || err?.message || err)
    toast.error(error.value)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
/* 必须盖在宿主素材详情弹窗（z-index 118）与地图大图（240）之上，否则开了也看不见、关不掉 */
.mle-overlay {
  position: fixed;
  inset: 0;
  z-index: 242;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.72);
}
.mle-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(1680px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  padding: 10px 12px 12px;
  border-radius: 10px;
  background: var(--bg-1);
  overflow: auto;
}
.mle-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.mle-title { font: 600 12.5px var(--font-body); color: var(--text-1); }
.mle-spacer { margin-left: auto; }
.mle-tool {
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
.mle-tool:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.mle-tool:disabled { opacity: 0.5; cursor: not-allowed; }
.mle-state {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.mle-hint { margin: 0; font-size: 10.5px; }
.mle-error { margin: 0; font-size: 10.5px; color: var(--action-danger); }
.mle-warn {
  margin: 0;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.mle-problems {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 10.5px;
}
.mle-problems ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.mle-problems li { display: flex; gap: 6px; word-break: break-word; }
.mle-problems code { flex: none; font-family: var(--font-mono, monospace); }
.mle-issues {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft, var(--surface-card));
  font-size: 10.5px;
  color: var(--text-2);
}
.mle-issues-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.mle-issues-head strong { font: 600 11px var(--font-body); color: var(--text-1); }
.mle-issues-head .mle-tool { margin-left: auto; }
.mle-issues-ok { margin: 0; color: var(--text-2); }
.mle-issues-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.mle-issue-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: 400 10.5px var(--font-body);
  text-align: left;
  cursor: pointer;
}
.mle-issue-row:hover:not(:disabled) { border-color: var(--accent-text); color: var(--accent-text); }
.mle-issue-row:disabled { cursor: default; opacity: 0.8; }
.mle-code { flex: none; font-family: var(--font-mono, monospace); color: var(--warn-text, var(--text-1)); }
.mle-unresolved { display: flex; flex-direction: column; gap: 3px; padding-top: 4px; border-top: 1px dashed var(--border); }
.mle-unresolved strong { font: 600 10.5px var(--font-body); color: var(--warn-text, var(--text-1)); }
.mle-body { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 8px; min-height: 0; }
.mle-main { min-width: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface-card); }
.mle-main :deep(.layer-canvas) { height: clamp(420px, 58vh, 760px); }
.mle-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  max-height: clamp(420px, 58vh, 760px);
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-card);
}
</style>
