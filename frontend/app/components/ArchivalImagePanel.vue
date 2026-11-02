<template>
  <div class="arch" @click.stop>
    <div class="arch-head">
      <span class="arch-label">{{ t('components.archival.label') }}</span>
      <span class="arch-count" :class="{ dim: !items.length }">{{ items.length }}/{{ max }}</span>
      <button
        class="arch-toggle arch-portrait"
        type="button"
        :disabled="portraitDisabled"
        :title="portraitHint"
        @click.stop="runPortraitAppearance"
      >
        <Loader2 v-if="portraitRunning" :size="10" class="animate-spin" />
        <ScanFace v-else :size="10" />
        {{ portraitRunning ? t('components.archival.portraitRunning') : t('components.archival.portraitAction') }}
      </button>
      <button class="arch-toggle" type="button" @click.stop="searchOpen = !searchOpen">
        <Plus v-if="!searchOpen" :size="10" />
        <X v-else :size="10" />
        {{ searchOpen ? t('common.close') : t('components.archival.add') }}
      </button>
    </div>

    <p class="arch-notice">{{ t('components.archival.notUsedForGeneration') }}</p>
    <p v-if="portraitModelNote" class="arch-portrait-note">{{ portraitModelNote }}</p>
    <p v-if="portraitDoneNote" class="arch-portrait-note">{{ t('components.archival.portraitDone') }}</p>
    <p v-if="portraitError" class="arch-error">{{ portraitError }}</p>

    <div v-if="searchOpen" class="arch-search">
      <input
        v-model="query"
        class="input arch-search-input"
        type="search"
        :placeholder="t('components.archival.searchPlaceholder')"
        @keydown.enter.prevent="runSearch"
      />
      <button class="btn btn-sm" type="button" :disabled="searching || !query.trim()" @click.stop="runSearch">
        <Loader2 v-if="searching" :size="11" class="animate-spin" />
        {{ searching ? t('components.archival.searching') : t('components.archival.search') }}
      </button>
    </div>

    <p v-if="searchOpen && searchError" class="arch-error">{{ searchError }}</p>

    <div v-if="searchOpen && results.length" class="arch-results">
      <button
        v-for="file in results"
        :key="file.file_title"
        type="button"
        class="arch-result"
        :disabled="!!adding || items.length >= max"
        :title="t('components.archival.addThis', { title: file.file_title })"
        @click.stop="add(file)"
      >
        <span class="arch-result-media">
          <img v-if="file.thumb_url" :src="file.thumb_url" :alt="file.file_title" loading="lazy" />
          <ImageOff v-else :size="16" />
          <Loader2 v-if="adding === file.file_title" class="arch-result-spin animate-spin" :size="16" />
        </span>
        <span class="arch-result-title">{{ shortTitle(file.file_title) }}</span>
      </button>
    </div>
    <p v-else-if="searchOpen && searched && !searching" class="arch-empty dim">{{ t('components.archival.noResults') }}</p>

    <ul v-if="items.length" class="arch-list">
      <li v-for="item in items" :key="item.path" class="arch-item">
        <img
          class="arch-thumb"
          :src="mediaUrl(item.path)"
          :alt="item.file_title || ''"
          @click.stop="emit('preview', mediaUrl(item.path), item.file_title || '')"
        />
        <div class="arch-meta">
          <span class="arch-title">{{ shortTitle(item.file_title || item.path) }}</span>
          <span class="arch-line">
            <span>{{ t('components.archival.artist') }}: {{ item.artist || t('components.archival.unknown') }}</span>
            <span>{{ t('components.archival.workDate') }}: {{ item.work_date || t('components.archival.unknown') }}</span>
          </span>
          <span class="arch-line">
            <span>
              {{ t('components.archival.license') }}:
              <a v-if="item.license_url" :href="item.license_url" target="_blank" rel="noopener noreferrer">{{ item.license || t('components.archival.unknown') }}</a>
              <template v-else>{{ item.license || t('components.archival.unknown') }}</template>
            </span>
            <a v-if="item.source_page_url" :href="item.source_page_url" target="_blank" rel="noopener noreferrer">{{ t('components.archival.sourcePage') }}</a>
          </span>
          <span class="arch-line dim">{{ t('components.archival.retrievedAt') }}: {{ localTime(item.retrieved_at) || t('components.archival.unknown') }}</span>
        </div>
        <button
          class="arch-del"
          type="button"
          :title="t('components.archival.remove')"
          @click.stop="askRemove(item)"
        >
          <X :size="12" />
        </button>
      </li>
    </ul>
    <p v-else class="arch-empty dim">{{ t('components.archival.empty') }}</p>

    <ConfirmDialog
      :open="!!pendingRemove"
      :title="t('components.archival.confirmTitle')"
      :message="t('components.archival.confirmMessage')"
      :loading="!!removing"
      @confirm="doRemove"
      @cancel="pendingRemove = null"
    />
  </div>
</template>

<script setup>
/**
 * 角色「史料参考」面板（Issue #32）。
 *
 * 史料参考 = 真实历史画像/照片的出处留档（作者 / 年代 / 许可证 / 来源页 / 取用时间），
 * **不参与生图**：参考图（ReferenceImageManager）会被 image_edit 当底图，史料画像进去会
 * 毁掉三视图人设格式，所以两者严格分离，面板里也显式写明。
 *
 * 检索只走后端白名单代理（Commons），前端不接受任意 URL。
 */
import { Loader2, ImageOff, Plus, X, ScanFace } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { characterAPI, researchAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

const { t } = useI18n()

const props = defineProps({
  characterId: { type: [Number, String], required: true },
  // 角色行里的 archival_images 原值（对象数组 / JSON 字符串 / null 都接受）
  archivalImages: { type: [String, Array], default: null },
  // 本集 id：「按史料画像补充外貌」要按集跑文本任务，没有它就不能发起
  episodeId: { type: Number, required: true },
  max: { type: Number, default: 10 },
})

const emit = defineEmits(['update', 'preview', 'appearance'])

const searchOpen = ref(false)
const query = ref('')
const searching = ref(false)
const searched = ref(false)
const searchError = ref('')
const results = ref([])
const adding = ref('')
const removing = ref('')
const pendingRemove = ref(null)

function parseEntries(raw) {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  return value.filter(entry => entry && typeof entry.path === 'string' && entry.path)
}

const items = computed(() => parseEntries(props.archivalImages))

// Commons 文件名形如 "File:Peter I of Russia.jpg"，列表里只显示去前缀/去扩展名的短标题
function shortTitle(value) {
  return String(value || '')
    .replace(/^File:/i, '')
    .replace(/\.(jpe?g|png|webp|gif|tiff?)$/i, '')
    .split('/')
    .filter(Boolean)
    .pop() || ''
}

function localTime(iso) {
  const ms = Date.parse(iso || '')
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : ''
}

async function runSearch() {
  const q = query.value.trim()
  if (!q || searching.value) return
  searching.value = true
  searchError.value = ''
  try {
    const res = await researchAPI.commonsSearch(q)
    results.value = Array.isArray(res?.results) ? res.results : []
    searched.value = true
  } catch (err) {
    results.value = []
    searched.value = true
    searchError.value = err?.message || t('components.archival.searchFailed')
  } finally {
    searching.value = false
  }
}

async function add(file) {
  if (adding.value || !file?.file_title) return
  adding.value = file.file_title
  try {
    const res = await characterAPI.addArchivalImage(props.characterId, file.file_title)
    emit('update', parseEntries(res))
    toast.success(t('components.archival.added'))
  } catch (err) {
    toastError(err)
  } finally {
    adding.value = ''
  }
}

function askRemove(item) {
  pendingRemove.value = item
}

async function doRemove() {
  const item = pendingRemove.value
  if (!item?.path || removing.value) return
  removing.value = item.path
  try {
    const res = await characterAPI.removeArchivalImage(props.characterId, item.path)
    emit('update', parseEntries(res))
    toast.success(t('components.archival.removed'))
    pendingRemove.value = null
  } catch (err) {
    toastError(err)
  } finally {
    removing.value = ''
  }
}

/**
 * 「按史料画像补充外貌」（Issue #32）：让模型读这些史料画像，把具体长相写回 characters.appearance。
 * 画像全程只是「被读的档案」，不会写进 reference_images —— 带参考图的角色走 image_edit，
 * 三视图人设格式会被底图毁掉。能否读图取决于后端挑到的文本模型，故由后端实测探测。
 */
const portraitRunning = ref(false)
const portraitError = ref('')
const portraitModelNote = ref('')
const portraitDoneNote = ref(false)
let portraitTimer = null
// 卸载后仍在途的 GET 回来时不能再排下一轮、也不能往已销毁的面板里 emit
let portraitStopped = false

const portraitDisabled = computed(() => portraitRunning.value || !items.value.length || !Number(props.episodeId))
const portraitHint = computed(() => {
  if (!items.value.length) return t('components.archival.portraitNeedImages')
  if (!Number(props.episodeId)) return t('components.archival.portraitNeedEpisode')
  return t('components.archival.portraitHint')
})

function stopPortraitPoll() {
  if (portraitTimer) { clearTimeout(portraitTimer); portraitTimer = null }
}

async function runPortraitAppearance() {
  if (portraitDisabled.value) return
  portraitRunning.value = true
  portraitError.value = ''
  portraitModelNote.value = ''
  portraitDoneNote.value = false
  try {
    const res = await characterAPI.appearanceFromPortrait(props.characterId, Number(props.episodeId))
    if (portraitStopped) return
    const vision = res?.vision || {}
    portraitModelNote.value = vision.used
      ? t('components.archival.portraitVisionUsed', { model: vision.model || vision.config_name || '' })
      : t('components.archival.portraitVisionMissing')
    pollPortrait()
  } catch (err) {
    portraitRunning.value = false
    portraitError.value = err?.message || t('components.archival.portraitFailed')
  }
}

// 任务走后端文本任务队列：3s 轮询到 done/error 为止；status 还是 null 说明任务行刚落库，继续等。
// 组件卸载立刻停表，弹窗关掉后不该再打接口。
function pollPortrait(left = 100) {
  stopPortraitPoll()
  if (left <= 0) {
    portraitRunning.value = false
    portraitError.value = t('components.archival.portraitFailed')
    return
  }
  portraitTimer = setTimeout(async () => {
    portraitTimer = null
    try {
      const st = await characterAPI.appearanceFromPortraitStatus(props.characterId, Number(props.episodeId))
      if (portraitStopped) return
      if (st?.status === 'done') {
        portraitRunning.value = false
        portraitDoneNote.value = true
        emit('appearance', st.appearance || '')
        toast.success(t('components.archival.portraitDone'))
        return
      }
      if (st?.status === 'error') {
        portraitRunning.value = false
        portraitError.value = st.error || t('components.archival.portraitFailed')
        return
      }
      pollPortrait(left - 1)
    } catch (err) {
      portraitRunning.value = false
      portraitError.value = err?.message || t('components.archival.portraitFailed')
    }
  }, 3000)
}

onBeforeUnmount(() => { portraitStopped = true; stopPortraitPoll() })
</script>

<style scoped>
.arch {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0 2px;
  border-top: 1px dashed var(--border);
}
.arch-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.arch-label {
  font: 600 11px var(--font-body);
  color: var(--text-1);
}
.arch-count {
  font: 600 10.5px var(--font-body);
  color: var(--accent-text);
}
.arch-toggle {
  margin-left: auto;
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
}
.arch-toggle:hover { color: var(--accent-text); border-color: var(--accent-text); }
.arch-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.arch-toggle:disabled:hover { color: var(--text-2); border-color: var(--border-strong); }
/* 两个 toggle 并排时只让第一个吃掉剩余空间，否则 auto 会被平分、按钮跑到中间 */
.arch-head .arch-portrait + .arch-toggle { margin-left: 0; }
.arch-portrait-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-2);
}
.arch-notice {
  margin: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  color: var(--warn-text);
  font: 600 10.5px var(--font-body);
}
.arch-search {
  display: flex;
  align-items: center;
  gap: 6px;
}
.arch-search-input { flex: 1 1 auto; min-width: 0; }
.arch-error {
  margin: 0;
  font-size: 10.5px;
  color: var(--action-danger);
}
.arch-results {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 120px));
  justify-content: start;
  gap: 8px;
}
.arch-result {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0 0 3px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  cursor: pointer;
  overflow: hidden;
  text-align: left;
}
.arch-result:hover:not(:disabled) { border-color: var(--accent-text); }
.arch-result:disabled { opacity: 0.55; cursor: not-allowed; }
.arch-result-media {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  background: var(--bg-2);
  color: var(--text-3);
}
.arch-result-media img { width: 100%; height: 100%; object-fit: contain; }
.arch-result-spin { position: absolute; color: var(--accent-text); }
.arch-result-title {
  padding: 0 4px;
  font-size: 9.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arch-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.arch-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
}
.arch-thumb {
  flex: none;
  width: 64px;
  height: 64px;
  object-fit: contain;
  background: var(--bg-2);
  border-radius: 4px;
  cursor: zoom-in;
}
.arch-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.arch-title {
  font: 600 11px var(--font-body);
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arch-line {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font-size: 10.5px;
  color: var(--text-2);
}
.arch-line a { color: var(--accent-text); text-decoration: underline; }
.arch-del {
  flex: none;
  align-self: flex-start;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.arch-del:hover { background: var(--action-danger); color: #fff; }
.arch-empty { font-size: 10.5px; margin: 0; }
</style>
