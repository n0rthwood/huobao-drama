<template>
  <Teleport to="body">
    <div class="overlay asset-browser-overlay" @click.self="emit('close')">
      <section class="dialog asset-browser-dialog" role="dialog" aria-modal="true" :aria-label="t('components.assetBrowser.title')">
        <header class="dialog-head asset-browser-head">
          <div class="asset-browser-title-block">
            <span class="asset-browser-kicker">{{ t('components.assetBrowser.title') }}</span>
            <h2 class="asset-browser-title">
              {{ episodeId ? t('components.assetBrowser.subtitleEpisode') : t('components.assetBrowser.subtitleDrama') }}
            </h2>
          </div>
          <button class="btn btn-ghost btn-icon" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="14" />
          </button>
        </header>

        <div class="asset-browser-body">
          <!-- 左：项目列表（当前项目置顶） -->
          <aside class="asset-browser-side">
            <button
              v-for="d in dramaOptions"
              :key="d.id"
              type="button"
              class="asset-browser-drama"
              :class="{ on: activeDramaId === d.id }"
              @click="activeDramaId = d.id"
            >
              <span class="asset-browser-drama-name">{{ d.title }}</span>
              <span v-if="d.id === props.dramaId" class="tag">{{ t('components.assetBrowser.currentDrama') }}</span>
              <span class="dim mono">{{ d.asset_count }}</span>
            </button>
            <div v-if="!dramaOptions.length && !loading" class="dim asset-browser-side-empty">
              {{ t('components.assetBrowser.noDrama') }}
            </div>
          </aside>

          <!-- 右：筛选 + 卡片 -->
          <div class="asset-browser-main">
            <div class="asset-browser-filters">
              <div class="seg">
                <button
                  v-for="k in kindTabs"
                  :key="k.value || 'all'"
                  type="button"
                  class="seg-item"
                  :class="{ on: kind === k.value }"
                  @click="kind = k.value"
                >{{ k.label }}</button>
              </div>
              <input
                v-model="keyword"
                class="input asset-browser-search"
                type="search"
                :placeholder="t('components.assetBrowser.searchPlaceholder')"
              />
              <span class="dim mono asset-browser-count">{{ t('components.assetBrowser.selected', { n: selectedList.length }) }}</span>
            </div>

            <div v-if="loading" class="asset-browser-loading">
              <Loader2 :size="20" class="animate-spin" />
            </div>
            <div v-else-if="!visibleItems.length" class="dim asset-browser-empty">
              {{ t('components.assetBrowser.empty') }}
            </div>
            <div v-else class="asset-browser-grid">
              <article
                v-for="item in visibleItems"
                :key="item.kind + '-' + item.id"
                class="card asset-browser-card"
                :class="{ on: isSelected(item), disabled: isInEpisode(item) || isSameDramaInDramaMode(item) }"
                @click="toggle(item)"
              >
                <div class="asset-browser-thumb">
                  <img v-if="item.image_url" :src="thumbOf(srcOf(item.image_url))" loading="lazy" @error="thumbFallback($event, srcOf(item.image_url))" />
                  <div v-else class="asset-browser-thumb-empty"><ImageOff :size="14" /></div>
                  <span class="asset-browser-kind" :class="'is-' + item.kind">{{ kindLabel(item.kind) }}</span>
                </div>
                <div class="asset-browser-info">
                  <strong class="asset-browser-name">{{ item.name }}</strong>
                  <span v-if="item.subtitle" class="dim asset-browser-sub">{{ item.subtitle }}</span>
                  <span class="dim asset-browser-meta">
                    {{ item.drama_title }} ·
                    {{ t('components.assetBrowser.versions', { n: item.version_count }) }} ·
                    {{ t('components.assetBrowser.refs', { n: item.reference_count }) }}
                  </span>
                  <span class="dim asset-browser-meta">
                    {{ item.episodes.length
                      ? t('components.assetBrowser.inEpisodes', { list: item.episodes.map(e => 'E' + e.episode_number).join(' ') })
                      : t('components.assetBrowser.noEpisode') }}
                  </span>
                  <span v-if="isInEpisode(item)" class="tag asset-browser-flag">{{ t('components.assetBrowser.alreadyLinked') }}</span>
                  <span v-else class="tag asset-browser-flag">
                    {{ actionOf(item) === 'link' ? t('components.assetBrowser.willLink') : t('components.assetBrowser.willImport') }}
                  </span>
                  <!-- 同名冲突：必须改名才能导入（默认 名字-2） -->
                  <label v-if="isSelected(item) && actionOf(item) === 'import'" class="asset-browser-rename" @click.stop>
                    <span class="dim">{{ t('components.assetBrowser.renameLabel') }}</span>
                    <input
                      class="input"
                      :class="{ 'is-invalid': nameError(item) }"
                      :value="nameOf(item)"
                      @input="setName(item, $event.target.value)"
                    />
                    <span v-if="nameError(item)" class="asset-browser-rename-error">{{ nameError(item) }}</span>
                  </label>
                </div>
              </article>
            </div>
          </div>
        </div>

        <footer class="dialog-foot asset-browser-foot">
          <span v-if="submitting" class="dim mono">{{ t('components.assetBrowser.progress', { done: progress.done, total: progress.total }) }}</span>
          <span v-else-if="blockingError" class="asset-browser-rename-error">{{ blockingError }}</span>
          <span class="asset-browser-foot-space" />
          <button class="btn" :disabled="submitting" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="submitting || !selectedList.length || !!blockingError" @click="submit">
            <Loader2 v-if="submitting" :size="12" class="animate-spin" />
            {{ t('components.assetBrowser.confirm') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 资产管理器（Issue #9）：浏览所有项目的资产，把它们放进当前项目/当前集。
 * - 本项目的资产 → 关联到本集（同一行资产，多集共用）；项目素材库页不显示本项目资产。
 * - 其他项目的资产 → 全量复制导入（文本 + 当前图 + 全部历史版本 + 参考图），
 *   与目标项目同名时必须改名，默认 `名字-2`（规则与后端同源，见 utils/assetName.js）。
 */
import { ImageOff, Loader2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { assetLibraryAPI, episodeAPI } from '~/composables/useApi'
import { thumbFallback, thumbOf } from '~/composables/useMedia'
import { toastError } from '~/composables/useToast'
import { isNameTaken, suggestUniqueName } from '~/utils/assetName'

const { t } = useI18n()

const props = defineProps({
  // 目标项目
  dramaId: { type: Number, required: true },
  // 传入时 = 剧集资产页入口：本项目资产可关联、跨项目导入后同时关联到该集
  episodeId: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'done'])

const loading = ref(true)
const submitting = ref(false)
const progress = ref({ done: 0, total: 0 })
const dramas = ref([])
const items = ref([])
const takenNames = ref({ character: [], scene: [], prop: [] })
const activeDramaId = ref(0)
const kind = ref('')
const keyword = ref('')
// key = `${kind}-${id}` → { item, name }
const selected = ref({})

const kindTabs = computed(() => [
  { value: '', label: t('index.status.all') },
  { value: 'character', label: t('common.role') },
  { value: 'scene', label: t('common.scene') },
  { value: 'prop', label: t('common.prop') },
])

function kindLabel(value) {
  if (value === 'character') return t('common.role')
  if (value === 'scene') return t('common.scene')
  return t('common.prop')
}

function srcOf(value) {
  if (!value) return ''
  return /^(https?:\/\/|data:|\/)/i.test(value) ? value : `/${value}`
}

const keyOf = item => `${item.kind}-${item.id}`

// 项目素材库页只做「从其他项目导入」，不展示本项目
const dramaOptions = computed(() => {
  const list = dramas.value.filter(d => (props.episodeId ? true : d.id !== props.dramaId))
  return [...list].sort((a, b) => (a.id === props.dramaId ? -1 : b.id === props.dramaId ? 1 : a.id - b.id))
})

const visibleItems = computed(() => items.value.filter((item) => {
  if (!props.episodeId && item.drama_id === props.dramaId) return false
  if (activeDramaId.value && item.drama_id !== activeDramaId.value) return false
  if (kind.value && item.kind !== kind.value) return false
  const q = keyword.value.trim().toLowerCase()
  if (q && !item.name.toLowerCase().includes(q) && !(item.subtitle || '').toLowerCase().includes(q)) return false
  return true
}))

const selectedList = computed(() => Object.values(selected.value))

function actionOf(item) {
  return item.drama_id === props.dramaId ? 'link' : 'import'
}
function isInEpisode(item) {
  return Boolean(props.episodeId) && item.episodes.some(ep => ep.id === props.episodeId)
}
function isSameDramaInDramaMode(item) {
  return !props.episodeId && item.drama_id === props.dramaId
}
function isSelected(item) {
  return Boolean(selected.value[keyOf(item)])
}

/** 同批次里同类资产已占用的名字（排除自己），与目标项目已有名字合并后判重 */
function takenFor(item) {
  const others = selectedList.value
    .filter(entry => entry.item.kind === item.kind && keyOf(entry.item) !== keyOf(item) && actionOf(entry.item) === 'import')
    .map(entry => entry.name)
  return [...(takenNames.value[item.kind] || []), ...others]
}

function nameOf(item) {
  return selected.value[keyOf(item)]?.name ?? item.name
}

function setName(item, value) {
  const entry = selected.value[keyOf(item)]
  if (!entry) return
  selected.value = { ...selected.value, [keyOf(item)]: { ...entry, name: value } }
}

function nameError(item) {
  const name = nameOf(item).trim()
  if (!name) return t('components.assetBrowser.nameRequired')
  if (isNameTaken(name, takenFor(item))) return t('components.assetBrowser.nameTaken')
  return ''
}

const blockingError = computed(() => {
  for (const entry of selectedList.value) {
    if (actionOf(entry.item) !== 'import') continue
    const err = nameError(entry.item)
    if (err) return err
  }
  return ''
})

function toggle(item) {
  if (submitting.value || isInEpisode(item) || isSameDramaInDramaMode(item)) return
  const key = keyOf(item)
  const next = { ...selected.value }
  if (next[key]) delete next[key]
  else next[key] = { item, name: actionOf(item) === 'import' ? suggestUniqueName(item.name, takenFor(item)) : item.name }
  selected.value = next
}

async function load() {
  loading.value = true
  try {
    const data = await assetLibraryAPI.list({ target_drama_id: props.dramaId })
    dramas.value = data?.dramas || []
    items.value = data?.items || []
    takenNames.value = data?.taken_names || { character: [], scene: [], prop: [] }
    if (!activeDramaId.value) {
      activeDramaId.value = dramaOptions.value[0]?.id || 0
    }
  } catch (err) {
    toastError(err)
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (blockingError.value) return
  const entries = selectedList.value
  submitting.value = true
  progress.value = { done: 0, total: entries.length }
  const failures = []
  let linked = 0
  let imported = 0
  let skipped = 0
  for (const entry of entries) {
    const { item } = entry
    try {
      if (actionOf(item) === 'link') {
        await episodeAPI.linkAsset(props.episodeId, item.kind, item.id)
        linked += 1
      } else {
        const res = await assetLibraryAPI.import(props.dramaId, {
          kind: item.kind,
          source_id: item.id,
          name: entry.name.trim(),
          episode_id: props.episodeId || null,
        })
        imported += 1
        skipped += (res?.skipped_versions || 0) + (res?.skipped_reference_images || 0)
      }
    } catch (err) {
      failures.push(`${item.name}: ${err?.message || err}`)
    }
    progress.value = { done: progress.value.done + 1, total: entries.length }
  }
  submitting.value = false
  if (failures.length) toastError(new Error(failures.join('; ')))
  if (linked || imported) {
    toast.success(t('components.assetBrowser.doneToast', { linked, imported }))
    if (skipped) toast.info(t('components.assetBrowser.skippedToast', { n: skipped }))
  }
  selected.value = {}
  emit('done')
  if (!failures.length) emit('close')
  else await load()
}

onMounted(load)
</script>

<style scoped>
.asset-browser-overlay { z-index: 62; }
.asset-browser-dialog { width: min(1080px, 94vw); max-height: 88vh; display: flex; flex-direction: column; }
.asset-browser-head { display: flex; align-items: center; gap: 10px; }
.asset-browser-title-block { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.asset-browser-kicker { font-size: 11px; color: var(--text-3); }
.asset-browser-title { font-size: 15px; margin: 0; }
.asset-browser-body { display: flex; gap: 12px; padding: 12px 16px; overflow: hidden; flex: 1; min-height: 0; }
.asset-browser-side { width: 180px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.asset-browser-drama {
  display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-radius: var(--radius);
  border: 1px solid var(--border); background: transparent; color: var(--text-1); cursor: pointer; text-align: left;
}
.asset-browser-drama.on { border-color: var(--accent); background: var(--overlay-track); }
.asset-browser-drama-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.asset-browser-side-empty { font-size: 12px; padding: 8px; }
.asset-browser-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
.asset-browser-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.asset-browser-search { flex: 1; min-width: 160px; }
.asset-browser-count { margin-left: auto; font-size: 12px; }
.asset-browser-loading, .asset-browser-empty { padding: 32px; text-align: center; }
.asset-browser-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px; overflow-y: auto; padding-right: 4px; align-content: start;
}
.asset-browser-card { display: flex; gap: 8px; padding: 8px; cursor: pointer; border: 1px solid var(--border); }
.asset-browser-card.on { border-color: var(--accent); }
.asset-browser-card.disabled { opacity: .55; cursor: not-allowed; }
.asset-browser-thumb { position: relative; width: 72px; height: 72px; flex-shrink: 0; border-radius: var(--radius); overflow: hidden; background: var(--overlay-track); }
.asset-browser-thumb img { width: 100%; height: 100%; object-fit: cover; }
.asset-browser-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.asset-browser-kind { position: absolute; left: 2px; bottom: 2px; font-size: 10px; padding: 0 4px; border-radius: 4px; background: var(--overlay-track); }
.asset-browser-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.asset-browser-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-browser-sub, .asset-browser-meta { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-browser-flag { align-self: flex-start; font-size: 10px; }
.asset-browser-rename { display: flex; flex-direction: column; gap: 2px; font-size: 11px; margin-top: 4px; }
.asset-browser-rename .input { height: 24px; font-size: 12px; }
.asset-browser-rename .input.is-invalid { border-color: var(--danger, #e5484d); }
.asset-browser-rename-error { color: var(--danger, #e5484d); font-size: 11px; }
.asset-browser-foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }
.asset-browser-foot-space { flex: 1; }
</style>
