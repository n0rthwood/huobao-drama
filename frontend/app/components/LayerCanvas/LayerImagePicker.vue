<template>
  <Teleport to="body">
    <div v-if="open && mode === 'source'" class="overlay" @click.self="close">
      <section class="dialog lip-dialog" role="dialog" aria-modal="true" :aria-label="t('layerCanvas.image.pick')">
        <header class="dialog-head"><h3 class="dialog-title">{{ t('layerCanvas.image.pick') }}</h3>
          <button type="button" class="btn-ghost" :aria-label="t('components.mediaLibrary.close')" @click="close"><X :size="16" /></button>
        </header>
        <div class="dialog-body lip-options">
          <button type="button" class="btn" :disabled="busy" @click="mode = 'asset'"><Layers :size="16" />{{ t('layerCanvas.image.episode') }}</button>
          <button type="button" class="btn" :disabled="busy" @click="mode = 'library'"><Images :size="16" />{{ t('components.mediaLibrary.pick') }}</button>
          <button type="button" class="btn" :disabled="busy || !dramaId || !episodeId" @click="uploadInput?.click()"><Upload :size="16" />{{ t('episode.asset.uploadImage') }}</button>
          <input ref="uploadInput" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden @change="chooseUpload">
          <p class="dim">{{ t('layerCanvas.image.uploadHint') }}</p>
          <p v-if="!dramaId || !episodeId" class="lip-warning">{{ t('layerCanvas.image.contextMissing') }}</p>
          <p v-if="busy" class="dim"><Loader2 :size="14" class="animate-spin" />{{ t('components.mediaLibrary.loading') }}</p>
          <p v-if="selectionError" class="lip-warning">{{ t('layerCanvas.image.selectionCount') }}</p>
          <p v-if="errorText" class="lip-warning">{{ errorText }}</p>
        </div>
      </section>
    </div>
  </Teleport>
  <AssetPicker :open="open && mode === 'asset'" :assets="assets" @close="mode = 'source'" @confirm="chooseAsset" />
  <MediaLibraryDialog :open="open && mode === 'library'" :drama-id="dramaId" :submitting="busy" detailed
    @close="mode = 'source'" @pick="chooseLibrary" />
</template>

<script setup>
/**
 * Unified image-layer chooser. select emits a real ImageSrc {path,asset_kind,asset_id,version_task_id}.
 * Episode and library asset versions keep original ownership/version. Uploads, storyboard frames and
 * reference-only library pictures are registered as a new prop/version in the current episode.
 * No fabricated ids and no unregistered upload paths can enter a new image layer.
 * registered emits after asset creation so the parent can refresh its asset/candidate context.
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers, Images, Upload, X, Loader2 } from 'lucide-vue-next'
import AssetPicker from '~/components/AssetPicker.vue'
import MediaLibraryDialog from '~/components/MediaLibraryDialog.vue'
import { assetLibraryAPI, mediaLibraryAPI, propAPI, taskAPI, uploadAPI } from '~/composables/useApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  assets: { type: Array, default: () => [] },
  dramaId: { type: Number, default: 0 },
  episodeId: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'select', 'registered'])
const { t } = useI18n()
const mode = ref('source')
const busy = ref(false)
const uploadInput = ref(null)
const selectionError = ref(false)
const errorText = ref('')

watch(() => props.open, (open) => {
  if (open) { mode.value = 'source'; selectionError.value = false; errorText.value = '' }
})

function close() { if (!busy.value) emit('close') }
function complete(src) { emit('select', src); emit('close') }
function failure(error) {
  mode.value = 'source'
  errorText.value = error instanceof Error ? error.message : t('layerCanvas.base.loadError')
}
function samePath(left, right) {
  const local = path => String(path || '').replace(/^\//, '')
  return local(left) === local(right)
}

async function versionOf(kind, id, path) {
  const detail = await assetLibraryAPI.detail(kind, id)
  return (detail.image_versions || []).find(version => samePath(version.url, path))?.id ?? null
}

async function chooseAsset(selected) {
  if (selected.length !== 1) { selectionError.value = true; mode.value = 'source'; return }
  const asset = props.assets.find(item => item.kind === selected[0].kind && item.id === selected[0].id)
  if (!asset?.image) { failure(new Error(t('layerCanvas.base.loadError'))); return }
  busy.value = true
  try {
    const id = Number(asset.asset_id ?? asset.id)
    const version = asset.version_task_id ?? await versionOf(asset.kind, id, asset.image)
    complete({ path: asset.image, asset_kind: asset.kind, asset_id: id, version_task_id: version })
  } catch (error) { failure(error) } finally { busy.value = false }
}

async function chooseLibrary(selected) {
  if (selected.length !== 1) { selectionError.value = true; mode.value = 'source'; return }
  const image = selected[0]
  busy.value = true
  try {
    // Asset-owned versions and legacy current images have valid provenance without copying.
    if (image.kind !== 'storyboard' && image.source !== 'reference') {
      const version = await versionOf(image.kind, image.owner_id, image.path)
      complete({ path: image.path, asset_kind: image.kind, asset_id: image.owner_id, version_task_id: version })
    } else {
      if (!props.dramaId || !props.episodeId) throw new Error(t('layerCanvas.image.contextMissing'))
      const copy = await mediaLibraryAPI.copy(image.path)
      complete(await registerImage(copy.path, image.owner_name || image.source_label, copy.copied_from))
    }
  } catch (error) { failure(error) } finally { busy.value = false }
}

async function chooseUpload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || busy.value) return
  busy.value = true
  errorText.value = ''
  try {
    if (!props.dramaId || !props.episodeId) throw new Error(t('layerCanvas.image.contextMissing'))
    const upload = await uploadAPI.image(file)
    complete(await registerImage(upload.path, file.name.replace(/\.[^.]+$/, '')))
  } catch (error) { failure(error) } finally { busy.value = false }
}

async function registerImage(path, name, copiedFrom) {
  // This is the same upload/version registration used by the episode asset page.
  const asset = await propAPI.create({ drama_id: props.dramaId, episode_id: props.episodeId,
    name: String(name || t('layerCanvas.type.image')).trim().slice(0, 60) })
  const version = await taskAPI.registerUpload('prop', asset.id, path, copiedFrom)
  emit('registered', { asset_id: asset.id, asset_kind: 'prop', version_task_id: version.id })
  return { path, asset_kind: 'prop', asset_id: asset.id, version_task_id: version.id }
}
</script>

<style scoped>
.lip-dialog { width: 480px; max-width: calc(100vw - 48px); }
.lip-options { display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
.lip-options > button { display: flex; align-items: center; gap: 8px; }
.lip-options p { margin: 0; font-size: 12px; line-height: 1.6; }
.lip-warning { color: var(--danger, #c0472e); }
</style>
