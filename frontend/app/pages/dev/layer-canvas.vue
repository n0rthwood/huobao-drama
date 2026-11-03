<template>
  <div class="lc-page">
    <header class="lc-head">
      <div>
        <h1 class="lc-title">{{ t('layerCanvas.dev.title') }}</h1>
        <p class="lc-desc">{{ t('layerCanvas.dev.desc') }}</p>
      </div>
      <div class="lc-actions">
        <button type="button" class="btn-ghost" :disabled="!canUndo" @click="undo">{{ t('layerCanvas.dev.undo') }}</button>
        <button type="button" class="btn-ghost" :disabled="!canRedo" @click="redo">{{ t('layerCanvas.dev.redo') }}</button>
        <button type="button" class="btn-ghost" @click="loadSample">{{ t('layerCanvas.dev.reset') }}</button>
        <button type="button" class="btn-primary" :disabled="rendering" @click="renderOnServer">
          {{ rendering ? t('layerCanvas.dev.rendering') : t('layerCanvas.dev.render') }}
        </button>
      </div>
    </header>

    <div class="lc-paths">
      <label><span>{{ t('layerCanvas.dev.basePath') }}</span><input v-model="basePath" @change="loadSample"></label>
      <label><span>{{ t('layerCanvas.dev.portraitPath') }}</span><input v-model="portraitPath" @change="loadSample"></label>
      <span class="lc-save">{{ saveState }}</span>
    </div>

    <div class="lc-body">
      <LayerList
        class="lc-list" :doc="doc" :selected-ids="selectedIds"
        @select="selectedIds = $event" @history="pushHistory" @patch="onPatch"
        @reorder="reorder($event.id, $event.toIndex)" @add="addLayer" @remove="removeSelected" @duplicate="duplicateSelected"
      />
      <div class="lc-main">
        <LayerCanvas
          ref="canvasRef" class="lc-canvas" :doc="doc" :selected-ids="selectedIds" :base-src="baseSrc"
          @select="selectedIds = $event" @history="pushHistory" @patch="onPatch"
          @delete="removeSelected" @duplicate="duplicateSelected" @undo="undo" @redo="redo"
        />
        <section v-if="serverImage || renderError" class="lc-server">
          <h4>{{ t('layerCanvas.dev.serverRender') }}<em v-if="renderMs">{{ t('layerCanvas.dev.renderMs', { ms: renderMs }) }}</em></h4>
          <img v-if="serverImage" :src="serverImage" alt="server render">
          <p v-else class="lc-error">{{ renderError }}</p>
        </section>
      </div>
      <LayerStyle
        class="lc-style" :doc="doc" :layer="selectedLayers.length === 1 ? selectedLayers[0] : null"
        @history="pushHistory" @patch="onPatch" @style="onStyle" @theme="setTheme" @filter="setFilter"
      />
    </div>
  </div>
</template>

<script setup>
/**
 * 图层编辑器演示页（Issue #48，仅 dev 构建，见 nuxt.config pages:extend）。
 * 用一份示例文档独立验收编辑器与服务端渲染：拖动/缩放/旋转/z 序/撤销，
 * 以及「画布 vs 服务端渲染」并排对照。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LayerCanvas from '~/components/LayerCanvas/LayerCanvas.vue'
import LayerList from '~/components/LayerCanvas/LayerList.vue'
import LayerStyle from '~/components/LayerCanvas/LayerStyle.vue'
import { useLayerDoc } from '~/composables/useLayerDoc'
import { apiBase, mediaUrl } from '~/utils/url'

const { t } = useI18n()
// 默认底图 = 资产 39 的原始上传图（1720 年初三方局势图），演示页可改成任意素材路径
const DEFAULT_BASE = 'static/uploads/2988b746-e035-4ab4-905e-3abe19ebc145.png'
const basePath = ref(DEFAULT_BASE)
const portraitPath = ref('')
const saveState = ref('')
const serverImage = ref('')
const renderError = ref('')
const renderMs = ref(0)
const rendering = ref(false)
const canvasRef = ref(null)

const {
  doc, selectedIds, selectedLayers, canUndo, canRedo,
  load, pushHistory, undo, redo, patchLayer, patchStyle,
  addLayer, removeSelected, duplicateSelected, reorder, setTheme, setFilter,
} = useLayerDoc((next) => {
  saveState.value = t('layerCanvas.dev.saved', { n: next.layers.length })
})

const baseSrc = computed(() => mediaUrl(doc.value.base.path))

function onPatch({ id, patch }) {
  patchLayer(id, patch)
}

function onStyle({ id, patch }) {
  patchStyle(id, patch)
}

/** 示例文档：准噶尔多边形、额尔齐斯河折线箭头、斋桑湖 marker、标签、姓名条、肖像。 */
function sampleDoc() {
  return {
    version: 1,
    base: { path: basePath.value, width: 1344, height: 768, filter: { paper: 0.25, tint: 'sepia', tint_strength: 0.3, vignette: 0.3 } },
    theme: 'archival',
    layers: [
      {
        id: 'dzungar', type: 'polygon', name: '准噶尔汗国范围', visible: true, locked: false, z: 0, opacity: 1, rotation: 0,
        points: [[0.2, 0.22], [0.42, 0.18], [0.52, 0.3], [0.46, 0.45], [0.24, 0.42]],
        anchor: { asset_id: 39, semantic_id: 'region-dzungar' },
        style: {},
      },
      {
        id: 'irtysh', type: 'polyline', name: '额尔齐斯河', visible: true, locked: false, z: 1, opacity: 1, rotation: 0,
        points: [[0.22, 0.56], [0.3, 0.46], [0.38, 0.38], [0.47, 0.32], [0.55, 0.26]],
        anchor: { asset_id: 39, semantic_id: 'line-irtysh' },
        style: { arrow_end: true },
      },
      {
        id: 'zaysan', type: 'marker', name: '斋桑湖', visible: true, locked: false, z: 2, opacity: 1, rotation: 0,
        at: [0.47, 0.32], text: '斋桑湖', anchor: { asset_id: 39, semantic_id: 'point-zaysan' }, style: {},
      },
      {
        id: 'label-dzungar', type: 'label', name: '准噶尔游牧区', visible: true, locked: false, z: 3, opacity: 1, rotation: 0,
        box: { x: 0.06, y: 0.64, w: 0.3, h: 0.16 }, text: '准噶尔游牧区，1720 年初',
        style: { bg_opacity: 0.6 },
      },
      {
        id: 'card-lihalev', type: 'card', name: '利哈列夫姓名条', visible: true, locked: false, z: 4, opacity: 1, rotation: 0,
        box: { x: 0.56, y: 0.76, w: 0.38, h: 0.14 }, template: 'name',
        fields: { title: '利哈列夫', sub: '俄国少将 · 额尔齐斯河远征', meta: '1720' },
        style: {},
      },
      {
        id: 'portrait', type: 'image', name: '肖像', visible: true, locked: false, z: 5, opacity: 1, rotation: 0,
        box: { x: 0.74, y: 0.08, w: 0.18, h: 0.3 },
        src: { path: portraitPath.value || basePath.value }, fit: 'cover', style: {},
      },
    ],
  }
}

function loadSample() {
  load(sampleDoc())
  serverImage.value = ''
  renderError.value = ''
  saveState.value = ''
}

async function renderOnServer() {
  rendering.value = true
  renderError.value = ''
  try {
    const resp = await fetch(`${apiBase()}/layer-docs/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: doc.value }),
    })
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}))
      throw new Error(json.message || `HTTP ${resp.status}`)
    }
    renderMs.value = Number(resp.headers.get('X-Render-Ms') || 0)
    if (serverImage.value) URL.revokeObjectURL(serverImage.value)
    serverImage.value = URL.createObjectURL(await resp.blob())
  } catch (err) {
    serverImage.value = ''
    renderError.value = err.message
  } finally {
    rendering.value = false
  }
}

loadSample()
</script>

<style scoped>
.lc-page { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 16px 20px 20px; overflow: hidden; }
.lc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.lc-title { font-size: 19px; font-weight: 700; color: var(--text-0); margin: 0; }
.lc-desc { font-size: 12.5px; color: var(--text-3); margin: 4px 0 0; }
.lc-actions { display: flex; gap: 6px; }
.lc-paths { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--text-2); }
.lc-paths label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.lc-paths input { flex: 1; min-width: 0; font-size: 12px; }
.lc-save { color: var(--text-3); min-width: 96px; text-align: right; }
.lc-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--surface-card); }
.lc-list { min-height: 0; }
.lc-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.lc-canvas { flex: 1; min-height: 360px; }
.lc-server { border-top: 1px solid var(--border); padding: 8px 10px 12px; }
.lc-server h4 { display: flex; align-items: center; justify-content: space-between; margin: 0 0 6px; font-size: 12px; color: var(--text-1); }
.lc-server h4 em { font-style: normal; color: var(--text-3); font-weight: 400; }
.lc-server img { width: 100%; display: block; border: 1px solid var(--border); border-radius: 6px; }
.lc-error { color: #c0472e; font-size: 12px; margin: 0; }
.lc-style { min-height: 0; }
</style>
