<template>
  <div class="poster-panel">
    <div class="poster-panel-main">
      <div class="poster-panel-stage-head">
        <span class="poster-panel-title">{{ t('poster.title') }}</span>
        <span class="dim">{{ t('poster.stageMeta', { size: poster?.size || '', ratio: aspectRatio }) }}</span>
        <span v-if="poster?.final_image" class="tag poster-final-tag">{{ t('poster.finalReady') }}</span>
        <span v-if="saving" class="dim">{{ t('poster.saving') }}</span>
      </div>

      <p v-if="loading" class="poster-panel-hint dim">{{ t('poster.loading') }}</p>
      <template v-else-if="poster">
        <PosterCanvasStage
          :image-src="baseImageSrc"
          :layout="layout"
          :variables="variables"
          :selected-id="selectedId"
          :size="poster.size"
          @select="selectedId = $event"
          @move="moveBox"
        />

        <PosterTextTools
          :box="selectedBox"
          :variables="variables"
          @add="addBox"
          @update="updateSelected"
          @remove="removeBox"
        />
      </template>
    </div>

    <aside class="poster-panel-side">
      <section class="poster-card">
        <h3 class="poster-card-title">{{ t('poster.generate.title') }}</h3>
        <label class="poster-field">
          <span>{{ t('poster.generate.prompt') }}</span>
          <textarea
            class="textarea"
            rows="4"
            :value="poster?.prompt || ''"
            :placeholder="t('poster.generate.promptPlaceholder')"
            @input="onPromptInput('prompt', $event.target.value)"
          />
        </label>
        <label class="poster-field">
          <span>{{ t('poster.generate.textPrompt') }}</span>
          <textarea
            class="textarea"
            rows="3"
            :value="poster?.text_prompt || ''"
            :placeholder="t('poster.generate.textPromptPlaceholder')"
            @input="onPromptInput('text_prompt', $event.target.value)"
          />
        </label>

        <div class="poster-refs">
          <div class="poster-refs-head">
            <span>{{ t('poster.generate.references', { n: (poster?.reference_images || []).length, max: 9 }) }}</span>
            <button type="button" class="btn btn-sm" :disabled="!poster" @click="pickerOpen = true">
              {{ t('poster.generate.pickRefs') }}
            </button>
          </div>
          <div v-if="(poster?.reference_images || []).length" class="poster-refs-list">
            <div v-for="(path, index) in poster.reference_images" :key="path" class="poster-ref-item">
              <span class="poster-ref-index">{{ index + 1 }}</span>
              <img :src="thumbOf(mediaUrl(path))" alt="" loading="lazy" />
            </div>
          </div>
          <p v-else class="poster-panel-hint dim">{{ t('poster.generate.noRefs') }}</p>
        </div>

        <p v-if="error" class="poster-error">{{ error }}</p>

        <div class="poster-actions">
          <button type="button" class="btn btn-primary" :disabled="busy || !poster" @click="generate('initial')">
            <Loader2 v-if="busy" :size="12" class="animate-spin" />
            {{ t('poster.generate.initial') }}
          </button>
        </div>

        <div class="poster-regen">
          <span class="poster-field-label">{{ t('poster.generate.regenTitle') }}</span>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="busy || !selectedCompositeId"
            :title="!selectedCompositeId ? t('poster.generate.needComposite') : undefined"
            @click="generate('composite')"
          >
            {{ t('poster.generate.fromComposite') }}
          </button>
          <div class="poster-regen-row">
            <select
              v-model="compositeVersionId"
              class="input poster-regen-select"
              :disabled="!compositeVersions.length"
            >
              <option v-for="version in compositeVersions" :key="version.id" :value="version.id">
                {{ t('poster.versionLabel', { n: version.id, time: formatVersionTime(version) }) }}
              </option>
            </select>
          </div>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="busy || !canGenerateLayers"
            :title="layersDisabledReason"
            @click="generate('layers')"
          >
            {{ t('poster.generate.fromLayers') }}
          </button>
          <span v-if="isFlux" class="dim">{{ t('poster.generate.fluxNoLayers') }}</span>
        </div>

        <button type="button" class="btn" :disabled="busy || !poster?.base_image" @click="saveComposite">
          {{ t('poster.generate.saveComposite') }}
        </button>
      </section>

      <section class="poster-card">
        <h3 class="poster-card-title">{{ t('poster.versions.title', { n: (poster?.versions || []).length }) }}</h3>
        <p v-if="!(poster?.versions || []).length" class="poster-panel-hint dim">{{ t('poster.versions.empty') }}</p>
        <div v-else class="poster-version-grid">
          <div
            v-for="version in poster.versions"
            :key="version.id"
            :class="['poster-version', { selected: poster.selected_version_id === version.id }]"
          >
            <div class="poster-version-thumb">
              <img
                :src="thumbOf(mediaUrl(version.image))"
                alt=""
                loading="lazy"
                @error="thumbFallback($event, mediaUrl(version.image))"
              />
              <span class="poster-version-kind">{{ t(`poster.versions.kind.${version.kind}`) }}</span>
              <span v-if="poster.selected_version_id === version.id" class="poster-version-final">{{ t('poster.versions.final') }}</span>
            </div>
            <div class="poster-version-meta">{{ formatVersionTime(version) }}</div>
            <div class="poster-version-actions">
              <button type="button" class="btn btn-sm" @click="selectVersion(version)">{{ t('poster.versions.select') }}</button>
              <button type="button" class="btn btn-sm" @click="useAsBase(version)">{{ t('poster.versions.useBase') }}</button>
              <button v-if="version.kind === 'composite'" type="button" class="btn btn-sm" @click="loadLayout(version)">
                {{ t('poster.versions.loadLayout') }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </aside>

    <PosterReferencePicker
      :open="pickerOpen"
      :episode-id="episodeId"
      :selected="poster?.reference_images || []"
      :max="9"
      @close="pickerOpen = false"
      @confirm="applyReferences"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { posterAPI, taskAPI, uploadAPI } from '~/composables/useApi'
import { useTasks } from '~/composables/useTasks'
import { thumbFallback, thumbOf } from '~/composables/useMedia'
import { mediaUrl } from '~/utils/url'
import { toastError, toastServerMessage } from '~/composables/useToast'
import { renderPosterBlob, posterFile } from '~/utils/posterCanvas'
import { normalizePosterLayout } from '~/utils/posterLayout'
import PosterCanvasStage from '~/components/PosterCanvasStage.vue'
import PosterTextTools from '~/components/PosterTextTools.vue'
import PosterReferencePicker from '~/components/PosterReferencePicker.vue'

const props = defineProps({
  episodeId: { type: Number, required: true },
  aspectRatio: { type: String, default: '16:9' },
  model: { type: String, default: '' },
  configId: { type: Number, default: undefined },
})
const { t } = useI18n()
const { registerTask, onTaskFinished, activeTasks } = useTasks()

const poster = ref(null)
const loading = ref(false)
const saving = ref(false)
const selectedId = ref(null)
const pickerOpen = ref(false)
const compositeVersionId = ref(null)
const error = ref('')
const activeTaskId = ref(0)
let saveTimer = null
let unsubscribe = null
let saveChain = Promise.resolve()
let pendingSaves = 0

const layout = computed(() => poster.value?.layout || { texts: [] })
const variables = computed(() => poster.value?.variables || { project_title: '', episode_title: '', episode_no: '' })
const baseImageSrc = computed(() => (poster.value?.base_image ? mediaUrl(poster.value.base_image) : ''))
const selectedBox = computed(() => layout.value.texts.find(box => box.id === selectedId.value) || null)
const busy = computed(() => saving.value || !!activeTaskId.value || activeTasks.value.some(task => task.episode_id === props.episodeId && task.params?.posterId))
const isFlux = computed(() => /^flux/i.test(props.model || ''))
const compositeVersions = computed(() => (poster.value?.versions || []).filter(version => version.kind === 'composite'))
const selectedCompositeId = computed(() => compositeVersionId.value || null)
const canGenerateLayers = computed(() => !!poster.value?.base_image && layout.value.texts.length > 0 && !isFlux.value)
const layersDisabledReason = computed(() => {
  if (!poster.value?.base_image) return t('poster.generate.needBase')
  if (!layout.value.texts.length) return t('poster.generate.needText')
  if (isFlux.value) return t('poster.generate.fluxNoLayers')
  return undefined
})

function applyPoster(data) {
  poster.value = data
  poster.value.layout = normalizePosterLayout(data.layout)
  const finalComposite = compositeVersions.value.find(version => version.id === data.selected_version_id)
  if (finalComposite) compositeVersionId.value = finalComposite.id
  else if (!compositeVersions.value.some(version => version.id === compositeVersionId.value)) compositeVersionId.value = compositeVersions.value[0]?.id || null
  if (!selectedId.value || !poster.value.layout.texts.some(box => box.id === selectedId.value)) {
    selectedId.value = poster.value.layout.texts[0]?.id || null
  }
}

async function load() {
  loading.value = true
  try {
    applyPoster(await posterAPI.get(props.episodeId))
  } catch (err) {
    toastError(err)
  } finally {
    loading.value = false
  }
}

function formatVersionTime(version) {
  if (!version.created_at) return ''
  return new Date(version.created_at).toLocaleTimeString()
}

function markDirty() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave().catch(toastError) }, 500)
}

async function flushSave() {
  if (!poster.value) return
  clearTimeout(saveTimer)
  saveTimer = null
  const snapshot = JSON.parse(JSON.stringify({
    prompt: poster.value.prompt || '',
    text_prompt: poster.value.text_prompt || '',
    layout: poster.value.layout,
    base_image: poster.value.base_image,
    reference_images: poster.value.reference_images || [],
  }))
  saving.value = true
  pendingSaves++
  // Serialize writes; never apply an older server response over a newer local drag/edit.
  saveChain = saveChain.catch(() => {}).then(() => posterAPI.save(props.episodeId, snapshot))
  try {
    await saveChain
  } finally {
    pendingSaves--
    saving.value = pendingSaves > 0
  }
}

function onPromptInput(field, value) {
  if (!poster.value) return
  poster.value[field] = value
  markDirty()
}

function addBox(kind) {
  if (!poster.value) return
  const count = layout.value.texts.length
  const box = {
    id: `box-${Date.now()}`,
    kind,
    text: kind === 'text' ? t('poster.tools.newText') : '',
    x: 0.1,
    y: Math.min(0.78, 0.1 + count * 0.09),
    width: 0.8,
    fontSize: 0.08,
    fontFamily: 'sans',
    color: '#ffffff',
    bold: true,
    italic: false,
    strokeColor: '#000000',
    strokeWidth: 0.03,
    shadow: true,
    align: 'center',
  }
  poster.value.layout.texts.push(box)
  selectedId.value = box.id
  markDirty()
}

function updateSelected(patch) {
  const box = selectedBox.value
  if (!box || !poster.value) return
  Object.assign(box, patch)
  markDirty()
}

function removeBox(id) {
  if (!poster.value) return
  poster.value.layout.texts = poster.value.layout.texts.filter(box => box.id !== id)
  if (selectedId.value === id) selectedId.value = poster.value.layout.texts[0]?.id || null
  markDirty()
}

function moveBox({ id, x, y }) {
  const box = layout.value.texts.find(item => item.id === id)
  if (!box) return
  box.x = x
  box.y = y
  markDirty()
}

async function applyReferences(paths) {
  if (!poster.value) return
  poster.value.reference_images = paths
  try {
    await flushSave()
    toast.success(t('poster.toast.refsSaved', { n: paths.length }))
  } catch (err) {
    toastError(err)
  }
}

async function generate(mode) {
  error.value = ''
  if (!poster.value) return
  if (mode === 'initial' && !String(poster.value.prompt || '').trim()) {
    error.value = t('poster.generate.needPrompt')
    return
  }
  if (mode === 'composite' && !selectedCompositeId.value) {
    error.value = t('poster.generate.needComposite')
    return
  }
  if (mode === 'layers' && !canGenerateLayers.value) {
    error.value = layersDisabledReason.value || ''
    return
  }
  activeTaskId.value = -1
  try {
    await flushSave()
    const payload = {
      mode,
      prompt: poster.value.prompt || '',
      text_prompt: poster.value.text_prompt || '',
      layout: poster.value.layout,
      config_id: props.configId,
      model: props.model || undefined,
    }
    if (mode === 'initial') payload.reference_images = poster.value.reference_images || []
    if (mode === 'composite') payload.version_id = selectedCompositeId.value
    if (mode === 'layers') {
      const imageSrc = mediaUrl(poster.value.base_image)
      const baseBlob = await renderPosterBlob(imageSrc, { texts: [] }, variables.value, { size: poster.value.size })
      const baseUpload = await uploadAPI.image(posterFile(baseBlob, 'poster-base.png'))
      payload.base_image = baseUpload.path
      const blob = await renderPosterBlob(imageSrc, poster.value.layout, variables.value, { transparent: true, size: poster.value.size })
      const uploaded = await uploadAPI.image(posterFile(blob, 'poster-text-layer.png'))
      payload.text_layer = uploaded.path
    }
    const result = await posterAPI.generate(props.episodeId, payload)
    activeTaskId.value = result.task_id
    registerTask(await taskAPI.get(result.task_id))
    toast.success(t(`poster.toast.started.${mode}`))
  } catch (err) {
    activeTaskId.value = 0
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
  }
}

async function saveComposite() {
  if (!poster.value?.base_image) {
    error.value = t('poster.generate.needBase')
    return
  }
  activeTaskId.value = -1
  try {
    await flushSave()
    const blob = await renderPosterBlob(mediaUrl(poster.value.base_image), poster.value.layout, variables.value, { size: poster.value.size })
    const uploaded = await uploadAPI.image(posterFile(blob, 'poster-composite.png'))
    const data = await posterAPI.registerVersion(props.episodeId, {
      image: uploaded.path,
      base_image: poster.value.base_image,
      layout: poster.value.layout,
    })
    applyPoster(data)
    toast.success(t('poster.toast.compositeSaved'))
  } catch (err) {
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
  } finally {
    activeTaskId.value = 0
  }
}

async function selectVersion(version) {
  try {
    await flushSave()
    applyPoster(await posterAPI.selectVersion(props.episodeId, version.id))
    toast.success(t('poster.toast.selected', { n: version.id }))
  } catch (err) {
    toastError(err)
  }
}

async function useAsBase(version) {
  if (!poster.value) return
  poster.value.base_image = version.image
  try {
    await flushSave()
    toast.success(t('poster.toast.baseSet'))
  } catch (err) {
    toastError(err)
  }
}

async function loadLayout(version) {
  if (!poster.value) return
  poster.value.layout = normalizePosterLayout(version.layout)
  poster.value.base_image = version.base_image || version.image
  try {
    await flushSave()
    selectedId.value = poster.value.layout.texts[0]?.id || null
    toast.success(t('poster.toast.layoutLoaded'))
  } catch (err) {
    toastError(err)
  }
}

onMounted(() => {
  load()
  unsubscribe = onTaskFinished(async row => {
    if (!row || row.episode_id !== props.episodeId || !row.params?.posterId) return
    activeTaskId.value = 0
    try {
      const data = await posterAPI.get(props.episodeId)
      if (poster.value) poster.value.versions = data.versions
    } catch (err) { toastError(err) }
  })
})

onBeforeUnmount(() => {
  if (saveTimer) void flushSave().catch(toastError)
  unsubscribe?.()
})
</script>

<style scoped>
.poster-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 14px;
  padding: 14px;
  min-width: 0;
}
.poster-panel-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.poster-panel-stage-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.poster-panel-title {
  font-size: 13px;
  font-weight: 600;
}
.poster-final-tag {
  border-color: var(--success, #38b26b);
  color: var(--success, #38b26b);
}
.poster-panel-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.poster-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border-color, #2a2e39);
  border-radius: 10px;
  background: var(--panel-bg, #14161c);
}
.poster-card-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.poster-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-2, #aab);
}
.poster-field-label {
  font-size: 11px;
  color: var(--text-2, #aab);
}
.poster-panel-hint {
  font-size: 12px;
  margin: 2px 0;
}
.poster-error {
  font-size: 12px;
  color: var(--danger, #e5484d);
  margin: 0;
}
.poster-refs {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.poster-refs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2, #aab);
}
.poster-refs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.poster-ref-item {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color, #2a2e39);
}
.poster-ref-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.poster-ref-index {
  position: absolute;
  left: 2px;
  top: 2px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  background: var(--accent, #4f8cff);
  color: #fff;
  font-size: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.poster-actions {
  display: flex;
  gap: 8px;
}
.poster-regen {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color, #2a2e39);
}
.poster-regen-row {
  display: flex;
  gap: 6px;
}
.poster-regen-select {
  flex: 1;
}
.poster-version-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 180px));
  justify-content: start;
  gap: 8px;
}
.poster-version {
  border: 1px solid var(--border-color, #2a2e39);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel-alt, #1b1e26);
}
.poster-version.selected {
  border-color: var(--success, #38b26b);
}
.poster-version-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #0b0d12;
}
.poster-version-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.poster-version-kind,
.poster-version-final {
  position: absolute;
  top: 4px;
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--header-bg);
  color: var(--text-1);
}
.poster-version-kind {
  left: 4px;
}
.poster-version-final {
  right: 4px;
  background: var(--success, #38b26b);
}
.poster-version-meta {
  padding: 3px 6px;
  font-size: 10px;
  color: var(--text-2, #aab);
}
.poster-version-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 6px 6px;
}
</style>
