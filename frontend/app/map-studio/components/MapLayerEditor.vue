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
            :doc="doc"
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
 * 地图图层编辑器（Issue #90）。
 *
 * 模型在绘制阶段交付的 LayerDoc 就是这里编辑的对象：画布、图层列表与样式面板全部复用
 * LayerCanvas 套件，预览走和后端同源的 `utils/layerSvg.js`，**不新造第二个渲染器**。
 * 保存走 PUT /map-workflow/layer-doc：服务端严格校验（normalizeLayerDoc 会改动即整份拒收）、
 * 用同一条 renderLayerDoc 链重绘并登记新版本。提交前只做后端一定会做的两件事——按 z 稳定排序、
 * 重复 id 加后缀；其余不合法的地方原样提交，由服务端逐条指出来，绝不在本地偷偷改成「能过」的值。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2, Redo2, Undo2, X } from 'lucide-vue-next'
import LayerCanvas from '~/components/LayerCanvas/LayerCanvas.vue'
import LayerList from '~/components/LayerCanvas/LayerList.vue'
import LayerStyle from '~/components/LayerCanvas/LayerStyle.vue'
import { useLayerDoc } from '~/composables/useLayerDoc'
import { mapLayerDocProblemsOf, mapStudioAPI, mapStudioConflictOf } from '~/map-studio/api'
import { normalizeMapLayerDoc } from '~/map-studio/utils/mapLayerDoc'
import { DEEPLINK_KEYS, useDeeplink } from '~/composables/useQuerySync'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  taskId: { type: Number, required: true },
  layerDoc: { type: Object, required: true },
  revision: { type: Number, default: 0 },
  assetName: { type: String, default: '' },
})
const emit = defineEmits(['close', 'saved', 'conflict'])
const { t } = useI18n()

const saving = ref(false)
const error = ref('')
const conflictMessage = ref('')
const problems = ref([])
const loaded = ref('')

const {
  doc, selectedIds, selectedLayers, canUndo, canRedo, missingGlyphs,
  load, pushHistory, undo, redo, patchLayer, patchStyle, detachAnchors,
  addLayer, removeSelected, duplicateSelected, reorder, setTheme, setFilter,
} = useLayerDoc()

const selectedLayer = computed(() => selectedLayers.value[0] || null)
const baseSrc = computed(() => (doc.value.base.path ? mediaUrl(doc.value.base.path) : ''))
/** 草稿是否偏离打开时的服务端文档；提交失败后仍然保留，不会被外部刷新冲掉 */
const dirty = computed(() => JSON.stringify(doc.value) !== loaded.value)

function applyDoc(next) {
  const snapshot = JSON.parse(JSON.stringify(next))
  load(snapshot)
  loaded.value = JSON.stringify(snapshot)
  selectedIds.value = doc.value.layers[0] ? [doc.value.layers[0].id] : []
  problems.value = []
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
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

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
  patchLayer(id, patch)
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

async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  error.value = ''
  conflictMessage.value = ''
  problems.value = []
  try {
    const payload = normalizeMapLayerDoc(JSON.parse(JSON.stringify(doc.value)))
    const detail = await mapStudioAPI.saveLayerDoc(props.taskId, payload, props.revision)
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
