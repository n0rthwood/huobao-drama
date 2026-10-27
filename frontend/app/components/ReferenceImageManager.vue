<template>
  <div class="ref-images" @click.stop>
    <div class="ref-head">
      <span class="ref-label">{{ t('components.referenceImages.label') }}</span>
      <span class="ref-count" :class="{ dim: !refs.length }">{{ refs.length }}/{{ max }}</span>
      <span class="ref-hint dim">{{ t('components.referenceImages.hint') }}</span>
      <button
        class="ref-add-btn"
        :disabled="uploading || refs.length >= max"
        :title="refs.length >= max ? t('components.referenceImages.full', { max }) : t('components.referenceImages.add')"
        @click.stop="pickAndUpload"
      >
        <Loader2 v-if="uploading" :size="10" class="animate-spin" />
        <Plus v-else :size="10" />
        {{ t('components.referenceImages.add') }}
      </button>
      <button
        class="ref-add-btn"
        :disabled="picking || refs.length >= max"
        :title="refs.length >= max ? t('components.referenceImages.full', { max }) : t('components.mediaLibrary.pickRef')"
        @click.stop="libraryOpen = true"
      >
        <Loader2 v-if="picking" :size="10" class="animate-spin" />
        <Images v-else :size="10" />
        {{ t('components.mediaLibrary.pick') }}
      </button>
    </div>

    <div v-if="refs.length" class="ref-strip">
      <div
        v-for="(entry, i) in refs"
        :key="entry.path"
        class="ref-item"
        :class="{ 'is-broken': broken.includes(entry.path) }"
      >
        <img
          v-if="!broken.includes(entry.path)"
          :src="thumbOf(srcOf(entry.path))"
          class="ref-thumb"
          loading="lazy"
          :alt="t('components.referenceImages.previewTitle', { index: i + 1 })"
          @error="onThumbError($event, entry.path)"
          @click.stop="emit('preview', srcOf(entry.path), t('components.referenceImages.previewTitle', { index: i + 1 }))"
        />
        <div v-else class="ref-missing" :title="t('components.referenceImages.missingHint')">
          <ImageOff :size="12" />
          <span>{{ t('components.referenceImages.missing') }}</span>
        </div>
        <MediaTime v-if="entry.uploaded_at" class="ref-time" :at="entry.uploaded_at" />
        <button
          class="ref-del-btn"
          :title="t('components.referenceImages.remove')"
          :disabled="removing === entry.path"
          @click.stop="askRemove(entry.path)"
        >
          <Loader2 v-if="removing === entry.path" :size="9" class="animate-spin" />
          <X v-else :size="9" />
        </button>
      </div>
    </div>
    <div v-else class="ref-empty dim">{{ t('components.referenceImages.empty') }}</div>

    <ConfirmDialog
      :open="confirmOpen"
      :title="t('components.referenceImages.confirmTitle')"
      :message="t('components.referenceImages.confirmMessage')"
      :loading="!!removing"
      @confirm="doRemove"
      @cancel="cancelRemove"
    />

    <MediaLibraryDialog
      :open="libraryOpen"
      multi
      :limit="Math.max(0, max - refs.length)"
      :drama-id="dramaId"
      :submitting="picking"
      :title="t('components.mediaLibrary.pickRef')"
      @close="libraryOpen = false"
      @pick="pickFromLibrary"
    />
  </div>
</template>

<script setup>
import { Images, Loader2, ImageOff, Plus, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { characterAPI, parseReferenceImages, propAPI, sceneAPI } from '~/composables/useApi'
import { thumbFallback, thumbOf } from '~/composables/useMedia'
import { toastError } from '~/composables/useToast'
import MediaTime from '~/components/MediaTime.vue'
import MediaLibraryDialog from '~/components/MediaLibraryDialog.vue'

const { t } = useI18n()

const props = defineProps({
  // character / scene / prop：三类资产的参考图交互完全一致
  assetType: { type: String, required: true },
  assetId: { type: [Number, String], required: true },
  // 资产行里的 reference_images 原值（对象数组 [{path, uploaded_at}] / JSON 字符串 / null 都接受）
  references: { type: [String, Array], default: null },
  max: { type: Number, default: 10 },
  // 素材管理器默认展开的项目
  dramaId: { type: [Number, String], default: 0 },
})

const emit = defineEmits(['update', 'preview'])

const API_BY_TYPE = { character: characterAPI, scene: sceneAPI, prop: propAPI }

const uploading = ref(false)
const removing = ref('')
const pendingRemove = ref('')
const confirmOpen = ref(false)
const broken = ref([])
const libraryOpen = ref(false)
const picking = ref(false)

const refs = computed(() => parseReferenceImages(props.references))
const assetApi = computed(() => API_BY_TYPE[props.assetType])

// 与成片图一致：库里存相对路径（static/...），展示时补前导斜杠
function srcOf(item) {
  if (!item) return ''
  if (/^(https?:\/\/|data:|\/)/i.test(item)) return item
  return `/${item}`
}

// 缩略图缺失先回退原图；原图也加载不出来 → 标记为「文件缺失」，用删除按钮补救
function onThumbError(e, item) {
  if (e.target?.dataset?.fbk) {
    if (!broken.value.includes(item)) broken.value = [...broken.value, item]
    return
  }
  thumbFallback(e, srcOf(item))
}

function pickAndUpload() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
  input.multiple = true
  input.onchange = async () => {
    const files = Array.from(input.files || [])
    if (!files.length) return
    uploading.value = true
    let added = 0
    try {
      // 逐张串行上传：服务端返回的数组即最新状态（不做乐观更新），部分失败不影响已成功的
      for (const file of files) {
        try {
          const res = await assetApi.value.addReference(props.assetId, file)
          emit('update', parseReferenceImages(res?.reference_images))
          added += 1
        } catch (err) {
          toastError(err)
        }
      }
      if (added) toast.success(t('components.referenceImages.added'))
    } finally {
      uploading.value = false
    }
  }
  input.click()
}

// 从素材库选图：服务端复制文件（uploaded_at = 选择当时），同源重复选入会被去重
async function pickFromLibrary(urls) {
  if (!urls.length || picking.value) return
  picking.value = true
  try {
    const res = await assetApi.value.addRefsFromLibrary(props.assetId, urls)
    emit('update', parseReferenceImages(res?.reference_images))
    if (res.added) toast.success(t('components.mediaLibrary.refAdded', { n: res.added }))
    if (res.skipped) toast.success(t('components.mediaLibrary.refSkipped', { n: res.skipped }))
    libraryOpen.value = false
  } catch (err) {
    toastError(err)
  } finally {
    picking.value = false
  }
}

function askRemove(item) {
  pendingRemove.value = item
  confirmOpen.value = true
}

function cancelRemove() {
  confirmOpen.value = false
  pendingRemove.value = ''
}

async function doRemove() {
  const item = pendingRemove.value
  if (!item || removing.value) return
  removing.value = item
  try {
    const res = await assetApi.value.delReference(props.assetId, item)
    emit('update', parseReferenceImages(res?.reference_images))
    broken.value = broken.value.filter(b => b !== item)
    toast.success(t('components.referenceImages.removed'))
    confirmOpen.value = false
    pendingRemove.value = ''
  } catch (err) {
    toastError(err)
  } finally {
    removing.value = ''
  }
}
</script>

<style scoped>
.ref-images {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0 2px;
  border-top: 1px dashed var(--border);
}
.ref-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ref-label {
  font: 600 11px var(--font-body);
  color: var(--text-1);
  flex: none;
}
.ref-count {
  font: 600 10.5px var(--font-body);
  color: var(--accent-text);
  flex: none;
}
.ref-hint {
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}
.ref-add-btn {
  flex: none;
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
  transition: color 0.15s, border-color 0.15s;
}
.ref-add-btn:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent-text); }
.ref-add-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ref-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.ref-item {
  position: relative;
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--surface-soft);
}
.ref-item.is-broken { border-color: var(--action-danger); }
.ref-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
  display: block;
}
.ref-missing {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--action-danger);
  font-size: 9px;
  text-align: center;
  padding: 0 2px;
}
/* 上传时间压在缩略图底部，46px 的格子里不额外占高度 */
.ref-time {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 1px 2px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ref-del-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.ref-item:hover .ref-del-btn,
.ref-del-btn:focus-visible { opacity: 1; }
.ref-del-btn:hover { background: var(--action-danger); }
.ref-empty { font-size: 10.5px; }
</style>
