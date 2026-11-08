<template>
  <div class="poster-panel">
    <div class="poster-panel-main">
      <div class="poster-panel-stage-head">
        <span class="poster-panel-title">{{ t('poster.title') }}</span>
        <span class="dim">{{ t('poster.stageMeta', { size: poster?.size || '', ratio: aspectRatio }) }}</span>
        <span v-if="poster?.final_image" class="tag poster-final-tag">{{ t('poster.finalReady') }}</span>
      </div>

      <p v-if="loading" class="poster-panel-hint dim">{{ t('poster.loading') }}</p>
      <PosterLayerEditor
        v-else-if="poster"
        ref="editorRef"
        :poster="poster"
        :episode-id="episodeId"
        :drama-id="poster.drama_id || 0"
        :variables="variables"
        @changed="applyPoster"
      />
    </div>

    <aside class="poster-panel-side">
      <section class="poster-card">
        <h3 class="poster-card-title">{{ t('poster.concept.title') }}</h3>
        <p class="dim poster-model-hint">{{ t('poster.concept.modelHint', { model: chatModel || t('poster.concept.defaultModel') }) }}</p>
        <div class="poster-actions">
          <button type="button" class="btn btn-primary" :disabled="busy || !poster" @click="runConcept(false)">
            <Loader2 v-if="conceptRunning" :size="12" class="animate-spin" />
            {{ t('poster.concept.run') }}
          </button>
          <button type="button" class="btn" :disabled="busy || !poster" @click="runConcept(true)">
            {{ t('poster.concept.runAndGenerate') }}
          </button>
        </div>
        <button v-if="poster?.concept" type="button" class="btn btn-sm" :disabled="busy" @click="generateAll">
          {{ t('poster.concept.generateAll') }}
        </button>
        <p v-if="conceptRunning" class="dim poster-panel-hint">{{ t('poster.concept.running') }}</p>
        <p v-if="conceptError" class="poster-error">{{ conceptError }}</p>

        <template v-if="poster?.concept">
          <div class="poster-theme">
            <strong>{{ poster.concept.theme }}</strong>
            <p class="dim">{{ poster.concept.theme_reason }}</p>
            <span class="dim">{{ t('poster.concept.modelLine', { model: poster.concept.model, n: poster.concept.script_segments_used }) }}</span>
          </div>
          <div class="poster-concept-grid">
            <article v-for="composition in poster.concept.compositions" :key="composition.id" class="poster-concept">
              <header class="poster-concept-head">
                <strong>{{ composition.approach }}</strong>
                <span v-if="composition.recommended" class="poster-recommended">{{ t('poster.concept.recommended') }}</span>
                <span v-else class="dim">#{{ composition.id }}</span>
              </header>
              <p class="poster-concept-reason">{{ composition.rationale }}</p>
              <div class="poster-concept-assets">
                <span v-for="asset in composition.assets" :key="`${asset.kind}:${asset.id}`" class="poster-asset-chip" :title="asset.reason">
                  {{ asset.name }}<em>{{ t(`poster.reference.kind.${asset.kind}`) }}</em>
                </span>
              </div>
              <details class="poster-concept-details">
                <summary>{{ t('poster.concept.imagePrompt') }}</summary>
                <p class="poster-pre">{{ composition.image_prompt }}</p>
              </details>
              <details class="poster-concept-details">
                <summary>{{ t('poster.concept.textDescription') }}</summary>
                <p class="poster-pre">{{ composition.text_description }}</p>
              </details>
              <details class="poster-concept-details">
                <summary>{{ t('poster.concept.copy') }}</summary>
                <p class="poster-pre">{{ copyText(composition.copy) }}</p>
                <p class="dim">{{ t('poster.concept.layers', { n: composition.layer_plan.length }) }}</p>
              </details>
              <div class="poster-concept-status">
                <span v-if="candidateFailure(composition.id)" class="poster-error">{{ candidateFailure(composition.id) }}</span>
                <span v-else-if="candidateState(composition.id)" class="dim">{{ candidateState(composition.id) }}</span>
                <span v-else class="dim">{{ t('poster.concept.noImage') }}</span>
              </div>
              <div v-if="candidateVersion(composition.id)" class="poster-concept-candidate">
                <img :src="thumbOf(mediaUrl(candidateVersion(composition.id).image))" alt="" loading="lazy" @error="thumbFallback($event, mediaUrl(candidateVersion(composition.id).image))">
                <div class="poster-concept-candidate-actions">
                  <button type="button" class="btn btn-sm" :disabled="busy" @click="selectVersion(candidateVersion(composition.id))">{{ t('poster.concept.useFinal') }}</button>
                  <button type="button" class="btn btn-sm" :disabled="busy" @click="useAsBase(candidateVersion(composition.id))">{{ t('poster.concept.useBase') }}</button>
                </div>
              </div>
              <div class="poster-concept-actions">
                <button type="button" class="btn btn-sm" :disabled="busy" @click="applyFields(composition)">
                  {{ t('poster.concept.applyFields') }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="busy" @click="applyLayers(composition)">
                  {{ t('poster.concept.applyLayers') }}
                </button>
                <button type="button" class="btn btn-sm" :disabled="busy" @click="generateComposition(composition)">
                  {{ t('poster.concept.generateOne') }}
                </button>
              </div>
            </article>
          </div>
        </template>
        <p v-else-if="!conceptRunning" class="poster-panel-hint dim">{{ t('poster.concept.empty') }}</p>
      </section>

      <section class="poster-card">
        <h3 class="poster-card-title">{{ t('poster.generate.title') }}</h3>
        <label class="poster-field">
          <span>{{ t('poster.generate.prompt') }}</span>
          <textarea class="textarea" rows="4" :value="poster?.prompt || ''" :placeholder="t('poster.generate.promptPlaceholder')" @input="onPromptInput('prompt', $event.target.value)" />
        </label>
        <label class="poster-field">
          <span>{{ t('poster.generate.textPrompt') }}</span>
          <textarea class="textarea" rows="3" :value="poster?.text_prompt || ''" :placeholder="t('poster.generate.textPromptPlaceholder')" @input="onPromptInput('text_prompt', $event.target.value)" />
        </label>
        <div class="poster-copy-fields">
          <span class="poster-field-label">{{ t('poster.generate.copy') }}</span>
          <input class="input" :value="copy.title" :placeholder="t('poster.concept.copyTitle')" @input="onCopyInput('title', $event.target.value)">
          <input class="input" :value="copy.subtitle" :placeholder="t('poster.concept.copySubtitle')" @input="onCopyInput('subtitle', $event.target.value)">
          <div class="poster-copy-row">
            <input class="input" :value="copy.era" :placeholder="t('poster.concept.copyEra')" @input="onCopyInput('era', $event.target.value)">
            <input class="input" :value="copy.place" :placeholder="t('poster.concept.copyPlace')" @input="onCopyInput('place', $event.target.value)">
          </div>
        </div>

        <div class="poster-refs">
          <div class="poster-refs-head">
            <span>{{ t('poster.generate.references', { n: poster?.reference_images?.length || 0, max: 9 }) }}</span>
            <button type="button" class="btn btn-sm" :disabled="!poster" @click="pickerOpen = true">{{ t('poster.generate.pickRefs') }}</button>
          </div>
          <div v-if="namedAssets.length" class="poster-refs-list">
            <div v-for="asset in namedAssets" :key="`n:${asset.kind}:${asset.id}`" class="poster-ref-item poster-ref-named">
              <span class="poster-ref-index">{{ asset.name }}</span>
              <img :src="thumbOf(mediaUrl(asset.path))" alt="" loading="lazy" />
              <button type="button" class="poster-ref-remove" :title="t('poster.generate.removeRef')" @click="removeNamed(asset)">×</button>
            </div>
          </div>
          <div v-if="manualRefs.length" class="poster-refs-list">
            <div v-for="path in manualRefs" :key="path" class="poster-ref-item">
              <span class="poster-ref-index">{{ poster.reference_images.indexOf(path) + 1 }}</span>
              <img :src="thumbOf(mediaUrl(path))" alt="" loading="lazy" />
              <button type="button" class="poster-ref-remove" :title="t('poster.generate.removeRef')" @click="removeManual(path)">×</button>
            </div>
          </div>
          <p v-if="!(poster?.reference_images || []).length" class="poster-panel-hint dim">{{ t('poster.generate.noRefs') }}</p>
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
          <button type="button" class="btn btn-sm" :disabled="busy || !selectedCompositeId" :title="!selectedCompositeId ? t('poster.generate.needComposite') : undefined" @click="generate('composite')">
            {{ t('poster.generate.fromComposite') }}
          </button>
          <div class="poster-regen-row">
            <select v-model="compositeVersionId" class="input poster-regen-select" :disabled="!compositeVersions.length">
              <option v-for="version in compositeVersions" :key="version.id" :value="version.id">{{ t('poster.versionLabel', { n: version.id, time: formatVersionTime(version) }) }}</option>
            </select>
          </div>
          <button type="button" class="btn btn-sm" :disabled="busy || !canGenerateLayers" :title="layersDisabledReason" @click="generate('layers')">
            {{ t('poster.generate.fromLayers') }}
          </button>
          <span v-if="isFlux" class="dim">{{ t('poster.generate.fluxNoLayers') }}</span>
        </div>
      </section>

      <section class="poster-card">
        <h3 class="poster-card-title">{{ t('poster.versions.title', { n: (poster?.versions || []).length }) }}</h3>
        <p v-if="!(poster?.versions || []).length" class="poster-panel-hint dim">{{ t('poster.versions.empty') }}</p>
        <div v-else class="poster-version-grid">
          <div v-for="version in poster.versions" :key="version.id" :class="['poster-version', { selected: poster.selected_version_id === version.id }]">
            <div class="poster-version-thumb">
              <img :src="thumbOf(mediaUrl(version.image))" alt="" loading="lazy" @error="thumbFallback($event, mediaUrl(version.image))">
              <span class="poster-version-kind">{{ t(`poster.versions.kind.${version.kind}`) }}</span>
              <span v-if="version.concept_composition_id" class="poster-version-composition">{{ version.concept_composition_id }}</span>
              <span v-if="poster.selected_version_id === version.id" class="poster-version-final">{{ t('poster.versions.final') }}</span>
            </div>
            <div class="poster-version-meta">
              {{ formatVersionTime(version) }}
              <span v-if="version.task_status" :class="['poster-task-status', version.task_status]">{{ t(`poster.versions.task.${version.task_status}`) }}</span>
            </div>
            <p v-if="version.error_msg" class="poster-error">{{ version.error_msg }}</p>
            <div class="poster-version-actions">
              <button type="button" class="btn btn-sm" @click="selectVersion(version)">{{ t('poster.versions.select') }}</button>
              <button type="button" class="btn btn-sm" @click="useAsBase(version)">{{ t('poster.versions.useBase') }}</button>
              <button type="button" class="btn btn-sm" @click="loadVersion(version)">{{ t('poster.versions.loadLayout') }}</button>
            </div>
          </div>
        </div>
      </section>
    </aside>

    <PosterReferencePicker
      :open="pickerOpen"
      :episode-id="episodeId"
      :selected="manualRefs"
      :max="Math.max(0, 9 - namedAssets.length)"
      @close="pickerOpen = false"
      @confirm="applyReferences"
    />

    <Teleport to="body">
      <div v-if="conflict" class="overlay" @click.self="conflict = null">
        <div class="dialog poster-conflict" role="dialog" aria-modal="true">
          <h3>{{ t('poster.conflict.title') }}</h3>
          <p>{{ t(conflict.restored ? 'deeplink.readOnlyRestore' : 'poster.conflict.desc') }}</p>
          <p v-if="conflict.fields.length" class="poster-conflict-fields">{{ conflict.fields.map(field => t(`poster.conflict.field.${field}`)).join('、') }}</p>
          <div class="poster-conflict-actions">
            <button type="button" class="btn" @click="conflict = null">{{ t('common.cancel') }}</button>
            <button v-if="!conflict.restored" type="button" class="btn btn-primary" :disabled="busy" @click="confirmOverwrite">{{ t('poster.conflict.overwrite') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { posterAPI, taskAPI } from '~/composables/useApi'
import { useTasks } from '~/composables/useTasks'
import { thumbFallback, thumbOf } from '~/composables/useMedia'
import { mediaUrl } from '~/utils/url'
import { toastError, toastServerMessage } from '~/composables/useToast'
import PosterLayerEditor from '~/components/PosterLayerEditor.vue'
import PosterReferencePicker from '~/components/PosterReferencePicker.vue'
import { DEEPLINK_KEYS, querySingle, useDeeplink } from '~/composables/useQuerySync'

const props = defineProps({
  episodeId: { type: Number, required: true },
  aspectRatio: { type: String, default: '16:9' },
  model: { type: String, default: '' },
  configId: { type: Number, default: undefined },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: undefined },
})
const { t } = useI18n()
const { registerTask, onTaskFinished, activeTasks, episodeTasks, loadEpisodeTasks } = useTasks()

const poster = ref(null)
const loading = ref(false)
const pickerOpen = ref(false)
const compositeVersionId = ref(null)
const error = ref('')
const conceptError = ref('')
const conflict = ref(null)
const pendingAutoGenerate = ref(false)
const editorRef = ref(null)
let saveTimer = null
let unsubscribe = null
let saveChain = Promise.resolve()

// deeplink（#86）：参考图选择器、合成版本与冲突窗口。旧冲突载荷不重放，恢复仅供只读查看。
const link = useDeeplink('poster', DEEPLINK_KEYS.poster)
const urlPickerOpen = querySingle(link.initial('posterpick')) === '1'
const urlVersionId = Number(querySingle(link.initial('posterver')) || 0)
const urlConflict = querySingle(link.initial('pconflict'))
let deeplinkRestored = false

const variables = computed(() => poster.value?.variables || { project_title: '', episode_title: '', episode_no: '' })
const copy = computed(() => poster.value?.copy || { title: '', subtitle: '', era: '', place: '', notes: [] })
const isFlux = computed(() => /^flux/i.test(props.model || ''))
const compositeVersions = computed(() => (poster.value?.versions || []).filter(version => version.kind === 'composite'))
const selectedCompositeId = computed(() => compositeVersionId.value || null)
const canGenerateLayers = computed(() => !!poster.value?.base_image && (poster.value?.layer_doc?.layers || []).some(layer => layer.visible) && !isFlux.value)
const layersDisabledReason = computed(() => {
  if (!poster.value?.base_image) return t('poster.generate.needBase')
  if (!(poster.value?.layer_doc?.layers || []).some(layer => layer.visible)) return t('poster.generate.needText')
  if (isFlux.value) return t('poster.generate.fluxNoLayers')
  return undefined
})
const conceptRunning = computed(() => activeTasks.value.some(task => task.episode_id === props.episodeId && task.kind === 'poster_concept'))
const busy = computed(() => conceptRunning.value || activeTasks.value.some(task => task.episode_id === props.episodeId && task.params?.posterId))
const namedAssets = computed(() => {
  const concept = poster.value?.concept
  const composition = concept?.compositions?.find(item => item.id === concept.selected_composition_id)
  const refs = poster.value?.reference_images || []
  return (composition?.assets || []).filter(asset => refs.includes(asset.path))
})
const manualRefs = computed(() => {
  const named = new Set(namedAssets.value.map(asset => asset.path))
  return (poster.value?.reference_images || []).filter(path => !named.has(path))
})

function applyPoster(data) {
  poster.value = data
  const finalComposite = compositeVersions.value.find(version => version.id === data.selected_version_id)
  if (finalComposite) compositeVersionId.value = finalComposite.id
  else if (!compositeVersions.value.some(version => version.id === compositeVersionId.value)) compositeVersionId.value = compositeVersions.value[0]?.id || null
}

async function load() {
  loading.value = true
  try {
    applyPoster(await posterAPI.get(props.episodeId))
    restoreDeeplink()
  } catch (err) {
    toastError(err)
  } finally {
    loading.value = false
  }
}

/** 首次数据就绪后恢复 URL 子状态：目标版本不存在只提示并退回默认版本，不改任何数据 */
function restoreDeeplink() {
  if (deeplinkRestored) return
  deeplinkRestored = true
  if (urlVersionId > 0) {
    if (compositeVersions.value.some(version => version.id === urlVersionId)) compositeVersionId.value = urlVersionId
    else toast.warning(t('deeplink.missingNamed', { target: t('poster.versionLabel', { n: urlVersionId, time: '' }) }))
  }
  if (urlPickerOpen && poster.value) pickerOpen.value = true
  if (urlConflict && !conflict.value) {
    const match = /^(fields|layers):(.+)$/.exec(urlConflict)
    const composition = match && poster.value?.concept?.compositions?.find(item => String(item.id) === match[2])
    if (composition) conflict.value = { compositionId: composition.id, kind: match[1], fields: [], restored: true }
    else toast.warning(t('deeplink.missing'))
  }
}

watch([pickerOpen, compositeVersionId, conflict], () => link.set({
  posterpick: pickerOpen.value ? '1' : '',
  posterver: compositeVersionId.value || '',
  pconflict: conflict.value ? `${conflict.value.kind}:${conflict.value.compositionId}` : '',
}), { immediate: true })

function copyText(value) {
  return [value.title, value.subtitle, value.era, value.place, ...(value.notes || [])].filter(Boolean).join(' · ')
}

function formatVersionTime(version) {
  if (!version.created_at) return ''
  return new Date(version.created_at).toLocaleTimeString()
}

const conceptGeneratedAt = computed(() => Date.parse(poster.value?.concept?.generated_at || '') || 0)
/** 重新构想后，上一轮候选/失败任务不属于新方案；仍留在版本列表里可继续使用。 */
function isCurrentCandidate(item) {
  if (!conceptGeneratedAt.value) return true
  const at = Date.parse(item?.created_at || '')
  return Number.isFinite(at) && at >= conceptGeneratedAt.value
}

function candidateState(compositionId) {
  const version = candidateVersion(compositionId)
  const active = activeTasks.value.find(task => task.episode_id === props.episodeId
    && task.params?.posterConceptComposition === compositionId && isCurrentCandidate(task))
  if (active) return t('poster.concept.generating')
  if (version) return t('poster.concept.candidateReady', { n: version.id })
  return ''
}

/** 三案并行时单个方案失败：保留其它方案，失败卡显示原因并可用「生成这张底图」重试。 */
function candidateVersion(compositionId) {
  return (poster.value?.versions || []).find(item => item.concept_composition_id === compositionId && isCurrentCandidate(item))
}

function candidateFailure(compositionId) {
  if (candidateVersion(compositionId)) return ''
  const latest = episodeTasks(props.episodeId)
    .filter(task => task.params?.posterConceptComposition === compositionId && task.status === 'failed' && isCurrentCandidate(task))
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
  if (!latest) return ''
  return t('poster.concept.failed', { msg: String(latest.error_msg || '').slice(0, 120) })
}

function markProjectDirty() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushProject().catch(toastError) }, 600)
}

async function flushProject() {
  if (!poster.value) return
  clearTimeout(saveTimer)
  saveTimer = null
  const snapshot = {
    prompt: poster.value.prompt || '',
    text_prompt: poster.value.text_prompt || '',
    copy: JSON.parse(JSON.stringify(copy.value)),
  }
  saveChain = saveChain.catch(() => {}).then(() => posterAPI.save(props.episodeId, snapshot))
  const data = await saveChain
  applyPoster(data)
  return data
}

function onPromptInput(field, value) {
  if (!poster.value) return
  poster.value[field] = value
  markProjectDirty()
}

function onCopyInput(field, value) {
  if (!poster.value) return
  poster.value.copy = { ...copy.value, [field]: value }
  markProjectDirty()
}

async function applyReferences(paths) {
  if (!poster.value) return
  const named = namedAssets.value.map(asset => asset.path)
  poster.value.reference_images = [...named, ...paths.filter(path => !named.includes(path))]
  pickerOpen.value = false
  try {
    applyPoster(await flushProject())
    toast.success(t('poster.toast.refsSaved', { n: poster.value.reference_images.length }))
  } catch (err) {
    toastError(err)
  }
}

async function removeNamed(asset) {
  poster.value.reference_images = (poster.value.reference_images || []).filter(path => path !== asset.path)
  applyPoster(await flushProject())
}

async function removeManual(path) {
  poster.value.reference_images = (poster.value.reference_images || []).filter(item => item !== path)
  applyPoster(await flushProject())
}

async function runConcept(autoGenerate) {
  conceptError.value = ''
  if (!poster.value) return
  try {
    await flushProject()
    const result = await posterAPI.concept(props.episodeId, {
      model: props.chatModel || undefined,
      config_id: props.chatConfigId || undefined,
    })
    pendingAutoGenerate.value = autoGenerate
    if (result.task_id) registerTask(await taskAPI.get(result.task_id))
    toast.success(t('poster.toast.conceptStarted'))
  } catch (err) {
    conceptError.value = String(err?.body?.message || err?.message || err)
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
  }
}

async function generateAll() {
  // 只补没有当前候选的方案；成功过的候选不重生（单卡按钮可显式重生成）
  const ids = (poster.value?.concept?.compositions || [])
    .filter(item => !candidateVersion(item.id))
    .map(item => item.id)
  await generateCompositions(ids)
}

async function generateComposition(composition) {
  await generateCompositions([composition.id])
}

async function generateCompositions(ids) {
  if (!ids.length) return
  try {
    await flushProject()
    const result = await posterAPI.conceptGenerate(props.episodeId, {
      composition_ids: ids,
      config_id: props.configId,
      model: props.model || undefined,
    })
    const failed = (result.items || []).filter(item => item.error)
    const started = (result.items || []).filter(item => item.task_id)
    for (const item of started) registerTask(await taskAPI.get(item.task_id))
    if (failed.length) toast.warning(t('poster.toast.conceptPartial', { n: failed.length, first: failed[0].error }))
    else toast.success(t('poster.toast.conceptGenerating', { n: started.length }))
    applyPoster(await posterAPI.get(props.episodeId))
  } catch (err) {
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
  }
}

function requestConflict(compositionId, kind, fields) {
  conflict.value = { compositionId, kind, fields }
}

async function applyFields(composition) {
  try {
    applyPoster(await posterAPI.applyConcept(props.episodeId, { composition_id: composition.id, overwrite: false }))
    await editorRef.value?.acceptBundle(poster.value)
    toast.success(t('poster.toast.fieldsApplied'))
  } catch (err) {
    if (err?.body?.error === 'manual_edit_conflict') requestConflict(composition.id, 'fields', err.body.fields || [])
    else toastServerMessage(err, { fallback: 'poster.toast.failed' })
  }
}

async function applyLayers(composition) {
  try {
    applyPoster(await posterAPI.applyLayerPlan(props.episodeId, { composition_id: composition.id, overwrite: false }))
    await editorRef.value?.acceptBundle(poster.value)
    toast.success(t('poster.toast.layersApplied'))
  } catch (err) {
    if (err?.body?.error === 'manual_edit_conflict') requestConflict(composition.id, 'layers', err.body.fields || ['layer_doc'])
    else toastServerMessage(err, { fallback: 'poster.toast.failed' })
  }
}

async function confirmOverwrite() {
  if (!conflict.value || conflict.value.restored) return
  const { compositionId, kind, fields } = conflict.value
  conflict.value = null
  try {
    if (kind === 'layers') applyPoster(await posterAPI.applyLayerPlan(props.episodeId, { composition_id: compositionId, overwrite: true }))
    else applyPoster(await posterAPI.applyConcept(props.episodeId, { composition_id: compositionId, overwrite: true, fields }))
    await editorRef.value?.acceptBundle(poster.value)
    toast.success(t(kind === 'layers' ? 'poster.toast.layersApplied' : 'poster.toast.fieldsApplied'))
  } catch (err) {
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
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
  try {
    await flushProject()
    if (editorRef.value?.dirty()) await editorRef.value.save()
    await posterAPI.save(props.episodeId, { base_image: poster.value.base_image || undefined })
    const payload = {
      mode,
      prompt: poster.value.prompt || '',
      text_prompt: poster.value.text_prompt || '',
      config_id: props.configId,
      model: props.model || undefined,
    }
    if (mode === 'composite') payload.version_id = selectedCompositeId.value
    const result = await posterAPI.generate(props.episodeId, payload)
    registerTask(await taskAPI.get(result.task_id))
    toast.success(t(`poster.toast.started.${mode}`))
  } catch (err) {
    toastServerMessage(err, { fallback: 'poster.toast.failed' })
  }
}

async function selectVersion(version) {
  try {
    applyPoster(await posterAPI.selectVersion(props.episodeId, version.id))
    toast.success(t('poster.toast.selected', { n: version.id }))
  } catch (err) {
    toastError(err)
  }
}

async function useAsBase(version) {
  try {
    await editorRef.value?.setBasePath(version.image)
    const data = await editorRef.value?.save()
    if (data) applyPoster(data)
    toast.success(t('poster.toast.baseSet'))
  } catch (err) {
    toastError(err)
  }
}

async function loadVersion(version) {
  try {
    const data = await posterAPI.loadVersion(props.episodeId, version.id)
    applyPoster(data)
    await editorRef.value?.acceptBundle(data)
    toast.success(t('poster.toast.layoutLoaded'))
  } catch (err) {
    toastError(err)
  }
}

watch(() => props.episodeId, (next, previous) => {
  if (next !== previous) load()
})

onMounted(() => {
  load()
  // 刷新后恢复候选失败/任务状态：失败任务没有版本行，只能从本集任务快照读
  void loadEpisodeTasks(props.episodeId)
  unsubscribe = onTaskFinished(async row => {
    if (!row || row.episode_id !== props.episodeId) return
    const relevant = row.params?.posterId || row.params?.kind === 'poster_concept'
    if (!relevant) return
    try {
      applyPoster(await posterAPI.get(props.episodeId))
      if (pendingAutoGenerate.value && row.params?.kind === 'poster_concept' && row.status === 'completed') {
        pendingAutoGenerate.value = false
        await generateAll()
      }
      if (row.status !== 'completed') pendingAutoGenerate.value = false
    } catch (err) { toastError(err) }
  })
})

onBeforeUnmount(() => {
  if (saveTimer) void flushProject().catch(() => {})
  unsubscribe?.()
})
</script>

<style scoped>
/* 画布优先：编辑器占满一行，构想/生图/版本在下方按列排开（1280 工作台下画布仍有 700px+）。 */
.poster-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  min-width: 0;
}
.poster-panel-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.poster-panel-stage-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.poster-panel-title { font-size: 13px; font-weight: 600; }
.poster-final-tag { border-color: var(--success, #38b26b); color: var(--success, #38b26b); }
.poster-panel-side { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; min-width: 0; align-items: start; }
.poster-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border-color, #2a2e39); border-radius: 10px; background: var(--panel-bg, #14161c); }
.poster-card-title { margin: 0; font-size: 12px; font-weight: 600; }
.poster-model-hint { font-size: 11px; margin: 0; }
.poster-theme { display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: 8px; background: var(--panel-alt, #1b1e26); }
.poster-theme p { margin: 0; font-size: 11px; }
.poster-concept-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
.poster-concept { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--border-color, #2a2e39); border-radius: 8px; background: var(--panel-alt, #1b1e26); }
.poster-concept-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.poster-recommended { padding: 1px 5px; border-radius: 4px; background: var(--success, #38b26b); color: #fff; font-size: 9px; }
.poster-concept-reason { margin: 0; font-size: 11px; color: var(--text-2, #aab); }
.poster-concept-assets { display: flex; flex-wrap: wrap; gap: 4px; }
.poster-asset-chip { display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 6px; border-radius: 999px; background: var(--surface-card, #1b1e26); font-size: 10px; }
.poster-asset-chip em { font-style: normal; color: var(--text-3, #889); font-size: 9px; }
.poster-concept-details { font-size: 11px; }
.poster-concept-details summary { cursor: pointer; color: var(--text-2, #aab); }
.poster-pre { margin: 4px 0; white-space: pre-wrap; word-break: break-word; color: var(--text-1); }
.poster-concept-status { font-size: 10px; }
.poster-concept-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.poster-concept-candidate { display: flex; flex-direction: column; gap: 5px; }
.poster-concept-candidate img { width: 100%; max-height: 168px; object-fit: contain; border-radius: 6px; border: 1px solid var(--border-color, #2a2e39); background: #0b0d12; }
.poster-concept-candidate-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.poster-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-2, #aab); }
.poster-field-label { font-size: 11px; color: var(--text-2, #aab); }
.poster-copy-fields { display: grid; gap: 5px; }
.poster-copy-row { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.poster-panel-hint { font-size: 12px; margin: 2px 0; }
.poster-error { font-size: 12px; color: var(--danger, #e5484d); margin: 0; }
.poster-refs { display: flex; flex-direction: column; gap: 6px; }
.poster-refs-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-2, #aab); }
.poster-refs-list { display: flex; flex-wrap: wrap; gap: 6px; }
.poster-ref-item { position: relative; width: 64px; height: 64px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border-color, #2a2e39); }
.poster-ref-item img { width: 100%; height: 100%; object-fit: cover; }
.poster-ref-index { position: absolute; left: 2px; top: 2px; z-index: 1; max-width: calc(100% - 4px); padding: 0 3px; border-radius: 4px; background: var(--header-bg); color: var(--text-1); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.poster-ref-remove { position: absolute; right: 1px; top: 1px; z-index: 1; width: 16px; height: 16px; border: 0; border-radius: 8px; background: rgba(0, 0, 0, .55); color: #fff; cursor: pointer; line-height: 1; }
.poster-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.poster-regen { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--border-color, #2a2e39); }
.poster-regen-row { display: flex; gap: 6px; }
.poster-regen-select { flex: 1; }
.poster-version-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 180px)); justify-content: start; gap: 8px; }
.poster-version { border: 1px solid var(--border-color, #2a2e39); border-radius: 8px; overflow: hidden; background: var(--panel-alt, #1b1e26); }
.poster-version.selected { border-color: var(--success, #38b26b); }
.poster-version-thumb { position: relative; aspect-ratio: 16 / 9; background: #0b0d12; }
.poster-version-thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.poster-version-kind, .poster-version-final, .poster-version-composition { position: absolute; top: 4px; font-size: 9px; padding: 1px 4px; border-radius: 4px; background: var(--header-bg); color: var(--text-1); }
.poster-version-kind { left: 4px; }
.poster-version-composition { right: 4px; }
.poster-version-final { right: 4px; background: var(--success, #38b26b); color: #fff; }
.poster-version-meta { padding: 3px 6px; font-size: 10px; color: var(--text-2, #aab); display: flex; align-items: center; gap: 4px; }
.poster-task-status { padding: 0 3px; border-radius: 3px; background: var(--header-bg); }
.poster-task-status.failed { color: var(--danger, #e5484d); }
.poster-task-status.processing, .poster-task-status.queued { color: var(--accent, #4f8cff); }
.poster-version-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 6px 6px; }
.poster-conflict { max-width: 420px; }
.poster-conflict h3 { margin: 0 0 8px; font-size: 14px; }
.poster-conflict p { margin: 0 0 6px; font-size: 12px; }
.poster-conflict-fields { color: var(--text-2, #aab); }
.poster-conflict-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
</style>
