<template>
  <div class="ple-root">
    <div class="ple-bar">
      <span class="ple-title">{{ t('poster.editor.title') }}</span>
      <span v-if="saveState" class="dim ple-state">{{ saveState }}</span>
      <span class="ml-auto" />
      <button type="button" class="btn btn-sm" :disabled="saving" @click="undo" :title="t('layerCanvas.toolbar.undo')"><Undo2 :size="15" /></button>
      <button type="button" class="btn btn-sm" :disabled="saving" @click="redo" :title="t('layerCanvas.toolbar.redo')"><Redo2 :size="15" /></button>
      <button type="button" class="btn btn-sm" @click="uploadBase" :title="t('poster.editor.uploadBase')"><Upload :size="15" />{{ t('poster.editor.uploadBase') }}</button>
      <span class="ple-divider" />
      <button type="button" class="btn btn-sm" :disabled="!specReady" @click="addPosterProject">
        + {{ roleName('poster_project') }}
      </button>
      <span class="ple-divider" />
      <button type="button" class="btn btn-sm" :disabled="saving" @click="save">{{ saving ? t('poster.saving') : t('poster.editor.save') }}</button>
      <button type="button" class="btn btn-sm btn-primary" :disabled="!canRender || saving || rendering" @click="renderComposite">
        <span v-if="rendering" class="ple-spin" />
        {{ rendering ? t('poster.editor.rendering') : t('poster.editor.render') }}
      </button>
    </div>

    <p v-if="error" class="ple-error">{{ error }}</p>
    <p v-if="!doc.base.path" class="ple-banner">{{ t('poster.editor.noBase') }}</p>
    <p v-if="missingGlyphs.length" class="ple-error">{{ t('layerCanvas.style.missingChars', { chars: missingGlyphs.join(' ') }) }}</p>

    <div class="ple-body">
      <section class="ple-main">
        <LayerCanvas
          :doc="doc"
          :selected-ids="selectedIds"
          :base-src="baseSrc"
          :aspect-issue="aspectIssue"
          :missing-glyphs="missingGlyphs"
          :can-undo="canUndo"
          :can-redo="canRedo"
          :variables="variables"
          @select="selectedIds = $event"
          @history="pushHistory"
          @patch="onPatch"
          @delete="removeSelected"
          @duplicate="duplicateSelected"
          @undo="undo"
          @redo="redo"
        />
      </section>
      <section class="ple-side">
        <LayerRail
          :doc="doc"
          :selected-ids="selectedIds"
          :episode-id="episodeId"
          :drama-id="dramaId"
          medium="poster"
          :spec="{ width, height }"
          :variables="variables"
          :base-sources="baseSources"
          @select="selectedIds = $event"
          @history="pushHistory"
          @patch="onPatch"
          @style="onStyle"
          @theme="setTheme"
          @filter="setFilter"
          @reorder="reorder($event.id, $event.toIndex)"
          @add="addLayer"
          @remove="removeSelected"
          @duplicate="duplicateSelected"
          @base="replaceBase"
          @text-layout="setTextLayout"
          @assets-changed="markDirty"
        />
      </section>
    </div>
    <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onFilePicked">
  </div>
</template>

<script setup>
/**
 * Poster 图层编辑器（Issue #72）：静态版分镜制作编辑器——复用 LayerCanvas / LayerRail /
 * LayerStyle，不带时间线与精确关键帧条。空底图也能编辑/保存文字图层；
 * 「渲染合成」在服务端用同一份 layerDocToSvg + 同一批打包字体出图。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Undo2, Redo2, Upload } from 'lucide-vue-next'
import LayerCanvas from '~/components/LayerCanvas/LayerCanvas.vue'
import LayerRail from '~/components/LayerCanvas/LayerRail.vue'
import { useLayerDoc } from '~/composables/useLayerDoc'
import { useLayerTextNames, useLayerTextSpec } from '~/composables/useLayerTextSpec'
import { assetPipelineAPI, posterAPI, uploadAPI } from '~/composables/useApi'
import { baseAspectIssue } from '~/utils/layerQuality'
import { mediaUrl } from '~/utils/url'
import { toastError, toastServerMessage } from '~/composables/useToast'

const props = defineProps({
  poster: { type: Object, required: true },
  episodeId: { type: Number, required: true },
  dramaId: { type: Number, required: true },
  variables: { type: Object, required: true },
})
const emit = defineEmits(['changed'])
const { t } = useI18n()

const saving = ref(false)
const { ready: specReady } = useLayerTextSpec()
const { roleName } = useLayerTextNames()
const rendering = ref(false)
const saveState = ref('')
const error = ref('')
const fileInput = ref(null)
const assetCandidates = ref([])

const {
  doc, selectedIds, canUndo, canRedo, missingGlyphs,
  load, acceptSaved, pushHistory, undo, redo, patchLayer, patchStyle,
  addLayer, removeSelected, duplicateSelected, reorder, setTheme, setFilter, setTextLayout,
} = useLayerDoc(undefined, undefined, () => props.variables, { medium: 'poster' })

const width = computed(() => {
  const [w] = String(props.poster.size || '1344x768').split('x').map(Number)
  return w || 1344
})
const height = computed(() => {
  const [, h] = String(props.poster.size || '1344x768').split('x').map(Number)
  return h || 768
})
const baseSrc = computed(() => doc.value.base.path ? mediaUrl(doc.value.base.path) : '')
const aspectIssue = computed(() => doc.value.base.path
  ? baseAspectIssue(doc.value.base, { width: width.value, height: height.value })
  : null)
const canRender = computed(() => !!doc.value.base.path && doc.value.layers.some(layer => layer.visible))

const baseSources = computed(() => {
  const versions = (props.poster.versions || []).map(version => ({
    path: version.image,
    label: `${t(`poster.versions.kind.${version.kind}`)} #${version.id}${version.concept_composition_id ? ` · ${version.concept_composition_id}` : ''}`,
    ref: null,
    width: null,
    height: null,
  }))
  const current = props.poster.base_image && !versions.some(item => item.path === props.poster.base_image)
    ? [{ path: props.poster.base_image, label: t('poster.editor.currentBase'), ref: null, width: null, height: null }]
    : []
  const assets = assetCandidates.value.map(candidate => ({
    path: candidate.path,
    label: `${candidate.asset_name} · ${t('layerCanvas.base.version', { version: candidate.version_task_id })}`,
    ref: { asset_kind: candidate.asset_kind, asset_id: candidate.asset_id, version_task_id: candidate.version_task_id },
    width: candidate.width,
    height: candidate.height,
  }))
  return [...current, ...versions, ...assets]
})

function applyPoster(next) {
  if (!next) return
  load(next.layer_doc || { base: { path: '', width: width.value, height: height.value }, theme: 'archival', layers: [] })
  selectedIds.value = doc.value.layers[0] ? [doc.value.layers[0].id] : []
  saveState.value = ''
  error.value = ''
}

// 本地有未保存改动时不回灌，避免上层刷新把人正在编辑的内容冲掉
watch(() => props.poster.layer_doc, next => {
  if (saving.value) return
  if (JSON.stringify(doc.value) === JSON.stringify(next)) return
  if (saveState.value === t('poster.editor.unsaved')) return
  applyPoster(props.poster)
}, { immediate: true })

watch(() => props.episodeId, () => {
  // 换集时无论本地是否脏都按新集数据重来（旧集的未保存图层不能带到新集）
  applyPoster(props.poster)
}, { immediate: false })

watch(() => props.episodeId, async episodeId => {
  assetCandidates.value = []
  if (!episodeId) return
  try {
    const result = await assetPipelineAPI.baseCandidates(episodeId)
    assetCandidates.value = result.candidates || []
  } catch { /* 资产候选缺失不影响 Poster 生成；用户仍可用 Poster 版本或上传 */ }
}, { immediate: true })

function markDirty() {
  saveState.value = t('poster.editor.unsaved')
}
function onPatch({ id, patch }) {
  const result = patchLayer(id, patch)
  if (result && !result.confirmationRequired) markDirty()
}
function onStyle({ id, patch }) {
  patchStyle(id, patch)
  markDirty()
}
function replaceBase(base) {
  pushHistory()
  doc.value.base = { ...doc.value.base, ...base, width: width.value, height: height.value }
  markDirty()
}

/**
 * 栏目识别（#96）：主字段默认绑项目名变量——文本由渲染层按剧集数据现场解析，
 * 不再往文档里写死项目名。绑定可在样式面板里解除。
 */
function addPosterProject() {
  const layer = addLayer('text', { role: 'poster_project', fields: {}, field_vars: { main: 'project_title' } })
  if (!layer) return
  selectedIds.value = [layer.id]
  markDirty()
}

function uploadBase() {
  fileInput.value?.click()
}
async function onFilePicked(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const uploaded = await uploadAPI.image(file)
    replaceBase({ path: uploaded.path })
    toast.success(t('poster.editor.baseUploaded'))
  } catch (err) {
    toastError(err)
  }
}

async function save() {
  if (saving.value) return null
  saving.value = true
  error.value = ''
  try {
    const data = await posterAPI.save(props.episodeId, {
      layer_doc: JSON.parse(JSON.stringify(doc.value)),
    })
    acceptSaved(data.layer_doc)
    saveState.value = t('poster.editor.saved')
    emit('changed', data)
    return data
  } catch (err) {
    error.value = String(err?.body?.message || err?.message || err)
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
    return null
  } finally {
    saving.value = false
  }
}

async function renderComposite() {
  rendering.value = true
  error.value = ''
  try {
    if (saveState.value === t('poster.editor.unsaved')) {
      const saved = await save()
      if (!saved) return
    }
    const data = await posterAPI.registerVersion(props.episodeId, {
      layer_doc: JSON.parse(JSON.stringify(doc.value)),
    })
    emit('changed', data)
    acceptSaved(data.layer_doc)
    saveState.value = t('poster.editor.saved')
    toast.success(t('poster.toast.compositeSaved'))
  } catch (err) {
    error.value = String(err?.body?.message || err?.message || err)
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
  } finally {
    rendering.value = false
  }
}

function acceptBundle(bundle) {
  applyPoster(bundle)
  saveState.value = ''
}
/** 外部选择/上传底图：改当前 LayerDoc 的 base，随后由调用方保存。 */
function setBasePath(path) {
  replaceBase({ path })
}

defineExpose({ save, renderComposite, acceptBundle, setBasePath, dirty: () => saveState.value === t('poster.editor.unsaved') })
</script>

<style scoped>
.ple-root { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.ple-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-card); }
.ple-title { font-size: 12px; font-weight: 600; }
.ple-state { font-size: 11px; }
.ple-divider { width: 1px; height: 18px; background: var(--border); }
.ple-error { margin: 0; font-size: 12px; color: #c0472e; }
.ple-banner { margin: 0; padding: 6px 8px; font-size: 12px; color: var(--text-2); border: 1px dashed var(--border); border-radius: 8px; }
.ple-body { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 8px; min-height: 0; }
.ple-main { min-width: 0; min-height: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface-card); }
.ple-main :deep(.layer-canvas) { height: clamp(460px, 55vh, 720px); }
.ple-side { min-height: 0; border: 1px solid var(--border); border-radius: 8px; overflow: auto; background: var(--surface-card); }
.ple-spin { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ple-spin 0.8s linear infinite; }
@keyframes ple-spin { to { transform: rotate(360deg); } }
</style>
