<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="close">
      <div class="dialog lib-dialog" role="dialog" aria-modal="true" :aria-label="t('components.mediaLibrary.title')">
        <header class="lib-head">
          <h2 class="lib-title">{{ title || t('components.mediaLibrary.title') }}</h2>
          <span v-if="multi" class="lib-count" :class="{ full: selected.length >= limit }">
            {{ t('components.mediaLibrary.selected', { n: selected.length, max: limit }) }}
          </span>
          <span v-else-if="selected.length" class="lib-count">{{ t('components.mediaLibrary.selectedOne') }}</span>
          <button type="button" class="btn btn-sm lib-close" :title="t('components.mediaLibrary.close')" @click="close">
            <X :size="13" />
          </button>
        </header>

        <div class="lib-body">
          <nav class="lib-tree">
            <div v-for="drama in dramas" :key="drama.id" class="lib-drama">
              <button type="button" class="lib-node lib-node-drama" :class="{ active: isActive({ dramaId: drama.id }) }" @click="toggleDrama(drama)">
                <ChevronDown v-if="expanded === drama.id" :size="12" />
                <ChevronRight v-else :size="12" />
                <span class="lib-node-name">{{ drama.title }}</span>
                <span class="lib-node-count">{{ drama.count }}</span>
              </button>

              <div v-if="expanded === drama.id" class="lib-children">
                <p v-if="treeLoading" class="lib-hint dim">{{ t('components.mediaLibrary.loading') }}</p>
                <template v-else-if="tree">
                  <div v-for="episode in tree.episodes" :key="episode.id" class="lib-episode">
                    <button type="button" class="lib-node" :class="{ active: isActive({ dramaId: drama.id, episodeId: episode.id }) }" @click="selectNode({ dramaId: drama.id, episodeId: episode.id })">
                      <span class="lib-node-name">E{{ String(episode.episode_number).padStart(2, '0') }} · {{ episode.title }}</span>
                      <span class="lib-node-count">{{ episode.count }}</span>
                    </button>
                    <div class="lib-grandchildren">
                      <template v-for="group in assetGroups(episode)" :key="group.key">
                        <p v-if="group.nodes.length" class="lib-group dim">{{ group.label }}</p>
                        <button
                          v-for="node in group.nodes"
                          :key="group.key + node.id"
                          type="button"
                          class="lib-node lib-node-leaf"
                          :class="{ active: isActive({ dramaId: drama.id, episodeId: episode.id, kind: node.kind, ownerId: node.id }) }"
                          @click="selectNode({ dramaId: drama.id, episodeId: episode.id, kind: node.kind, ownerId: node.id })"
                        >
                          <span class="lib-node-name">{{ node.name }}</span>
                          <span class="lib-node-count">{{ node.count }}</span>
                        </button>
                      </template>
                      <p v-if="episode.storyboards.length" class="lib-group dim">{{ t('components.mediaLibrary.storyboards') }}</p>
                      <div v-for="sb in episode.storyboards" :key="`sb${sb.id}`" class="lib-sb">
                        <button
                          type="button"
                          class="lib-node lib-node-leaf"
                          :class="{ active: isActive({ dramaId: drama.id, episodeId: episode.id, kind: 'storyboard', ownerId: sb.id }) }"
                          @click="selectNode({ dramaId: drama.id, episodeId: episode.id, kind: 'storyboard', ownerId: sb.id })"
                        >
                          <span class="lib-node-name">{{ sb.name }}</span>
                          <span class="lib-node-count">{{ sb.count }}</span>
                        </button>
                        <button
                          v-for="slot in sb.slots || []"
                          :key="`sb${sb.id}${slot.slot}`"
                          type="button"
                          class="lib-node lib-node-slot"
                          :class="{ active: isActive({ dramaId: drama.id, episodeId: episode.id, kind: 'storyboard', ownerId: sb.id, slot: slot.slot }) }"
                          @click="selectNode({ dramaId: drama.id, episodeId: episode.id, kind: 'storyboard', ownerId: sb.id, slot: slot.slot })"
                        >
                          <span class="lib-node-name">{{ slotLabel(slot.slot) }}</span>
                          <span class="lib-node-count">{{ slot.count }}</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div v-if="tree.unassigned.count" class="lib-episode">
                    <button type="button" class="lib-node" :class="{ active: isActive({ dramaId: drama.id, episodeId: 'unassigned' }) }" @click="selectNode({ dramaId: drama.id, episodeId: 'unassigned' })">
                      <span class="lib-node-name">{{ t('components.mediaLibrary.unassigned') }}</span>
                      <span class="lib-node-count">{{ tree.unassigned.count }}</span>
                    </button>
                  </div>
                </template>
              </div>
            </div>
          </nav>

          <section class="lib-grid-wrap">
            <p v-if="imagesLoading" class="lib-hint dim">{{ t('components.mediaLibrary.loading') }}</p>
            <p v-else-if="!images.length" class="lib-hint dim">{{ t('components.mediaLibrary.empty') }}</p>
            <div v-else class="lib-grid">
              <div
                v-for="image in images"
                :key="image.path"
                class="lib-cell"
                :class="{ picked: selected.includes(image.path) }"
                @click="togglePick(image)"
              >
                <img :src="image.thumb_url" :alt="image.source_label" loading="lazy" @error="onThumbError($event, image)">
                <span class="lib-cell-check" v-if="selected.includes(image.path)"><Check :size="12" /></span>
                <button type="button" class="lib-cell-zoom" :title="t('components.mediaLibrary.preview')" @click.stop="preview = image">
                  <Maximize2 :size="11" />
                </button>
                <div class="lib-cell-meta">
                  <span class="lib-cell-label" :title="image.source_label">{{ image.source_label }}</span>
                  <MediaTime v-if="image.generated_at" class="lib-cell-time" :at="image.generated_at" />
                </div>
              </div>
            </div>
            <div v-if="total > images.length || page > 1" class="lib-pager">
              <button type="button" class="btn btn-sm" :disabled="page <= 1" @click="gotoPage(page - 1)">‹</button>
              <span class="dim">{{ page }} / {{ totalPages }}</span>
              <button type="button" class="btn btn-sm" :disabled="page >= totalPages" @click="gotoPage(page + 1)">›</button>
            </div>
          </section>
        </div>

        <footer class="lib-foot">
          <span v-if="multi" class="dim lib-limit">{{ t('components.mediaLibrary.limit', { max: limit }) }}</span>
          <button type="button" class="btn btn-sm" @click="close">{{ t('components.mediaLibrary.cancel') }}</button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="!selected.length || submitting" @click="confirm">
            <Loader2 v-if="submitting" :size="12" class="animate-spin" />
            {{ t('components.mediaLibrary.confirm') }}
          </button>
        </footer>
      </div>

      <div v-if="preview" class="lib-preview" @click.self="preview = null">
        <img :src="preview.url" :alt="preview.source_label">
        <p class="lib-preview-label">{{ preview.source_label }}</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 素材管理器：按 项目 → 剧集 → 资产/分镜 → 版本/关键帧/已上传参考图 浏览历史图片。
 * 只负责「选哪张」；复制与落库由调用方走 /media-library/copy 或 from-library 接口。
 */
import { Check, ChevronDown, ChevronRight, Loader2, Maximize2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { mediaLibraryAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import MediaTime from '~/components/MediaTime.vue'

const { t } = useI18n()

const props = defineProps({
  open: { type: Boolean, default: false },
  // multi = 参考图（可多选，受 limit 限制）；否则资产图单选
  multi: { type: Boolean, default: false },
  limit: { type: Number, default: 1 },
  // 默认展开的项目
  dramaId: { type: [Number, String], default: 0 },
  title: { type: String, default: '' },
  submitting: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'pick'])

const PAGE_SIZE = 48

const dramas = ref([])
const tree = ref(null)
const treeLoading = ref(false)
const expanded = ref(0)
const node = ref({})
const images = ref([])
const imagesLoading = ref(false)
const total = ref(0)
const page = ref(1)
const selected = ref([])
const preview = ref(null)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

const SLOT_KEYS = { first_frame: 'firstFrame', mid_frame: 'midFrame', last_frame: 'lastFrame' }
function slotLabel(slot) {
  return t(`components.mediaLibrary.${SLOT_KEYS[slot] || 'all'}`)
}

function assetGroups(episode) {
  return [
    { key: 'character', label: t('components.mediaLibrary.characters'), nodes: episode.characters },
    { key: 'scene', label: t('components.mediaLibrary.scenes'), nodes: episode.scenes },
    { key: 'prop', label: t('components.mediaLibrary.props'), nodes: episode.props },
  ]
}

function isActive(candidate) {
  const current = node.value
  return current.dramaId === candidate.dramaId
    && (current.episodeId ?? null) === (candidate.episodeId ?? null)
    && (current.kind ?? null) === (candidate.kind ?? null)
    && (current.ownerId ?? null) === (candidate.ownerId ?? null)
    && (current.slot ?? null) === (candidate.slot ?? null)
}

// 缩略图缺失（存量图未回填）回退原图
function onThumbError(e, image) {
  const el = e.target
  if (!el || el.dataset.fbk) return
  el.dataset.fbk = '1'
  el.src = image.url
}

async function loadDramas() {
  try {
    const res = await mediaLibraryAPI.dramas()
    dramas.value = res.items || []
  } catch (err) {
    toastError(err)
  }
}

async function loadTree(dramaId) {
  treeLoading.value = true
  tree.value = null
  try {
    tree.value = await mediaLibraryAPI.tree(dramaId)
  } catch (err) {
    toastError(err)
  } finally {
    treeLoading.value = false
  }
}

async function loadImages() {
  imagesLoading.value = true
  try {
    const res = await mediaLibraryAPI.images({
      drama_id: node.value.dramaId || undefined,
      episode_id: node.value.episodeId ?? undefined,
      kind: node.value.kind || undefined,
      owner_id: node.value.ownerId || undefined,
      slot: node.value.slot || undefined,
      page: page.value,
      page_size: PAGE_SIZE,
    })
    images.value = res.items || []
    total.value = res.total || 0
  } catch (err) {
    toastError(err)
  } finally {
    imagesLoading.value = false
  }
}

async function toggleDrama(drama) {
  if (expanded.value === drama.id) {
    expanded.value = 0
    return
  }
  expanded.value = drama.id
  node.value = { dramaId: drama.id }
  page.value = 1
  await Promise.all([loadTree(drama.id), loadImages()])
}

function selectNode(next) {
  node.value = next
  page.value = 1
  loadImages()
}

function gotoPage(next) {
  page.value = Math.min(Math.max(1, next), totalPages.value)
  loadImages()
}

function togglePick(image) {
  if (!props.multi) {
    selected.value = selected.value[0] === image.path ? [] : [image.path]
    return
  }
  if (selected.value.includes(image.path)) {
    selected.value = selected.value.filter(p => p !== image.path)
    return
  }
  if (selected.value.length >= props.limit) return
  selected.value = [...selected.value, image.path]
}

function close() {
  emit('close')
}

function confirm() {
  if (!selected.value.length) return
  emit('pick', [...selected.value])
}

watch(() => props.open, async (isOpen) => {
  if (!isOpen) {
    preview.value = null
    return
  }
  selected.value = []
  page.value = 1
  const focus = Number(props.dramaId) || 0
  await loadDramas()
  const target = focus || dramas.value[0]?.id || 0
  if (target) {
    expanded.value = target
    node.value = { dramaId: target }
    await Promise.all([loadTree(target), loadImages()])
  } else {
    images.value = []
    total.value = 0
  }
}, { immediate: true })
</script>

<style scoped>
.lib-dialog {
  width: 1020px;
  max-width: calc(100vw - 48px);
  height: 640px;
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.lib-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-1);
}
.lib-title { font-size: 15px; font-weight: 700; color: var(--text-0); }
.lib-count { font-size: 12px; color: var(--text-2); }
.lib-count.full { color: var(--action-danger); }
.lib-close { margin-left: auto; }
.lib-body { flex: 1; display: flex; min-height: 0; }
.lib-tree {
  width: 268px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-1);
  overflow: auto;
  padding: 8px;
}
.lib-node {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.lib-node:hover { background: var(--surface-2); }
.lib-node.active { background: var(--surface-3); color: var(--text-0); font-weight: 600; }
.lib-node-drama { font-weight: 600; color: var(--text-0); }
.lib-node-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-node-count { font-size: 11px; color: var(--text-3); }
.lib-children { padding-left: 10px; }
.lib-grandchildren { padding-left: 12px; }
.lib-node-leaf { font-size: 11.5px; }
.lib-node-slot { font-size: 11px; padding-left: 20px; color: var(--text-2); }
.lib-group { font-size: 10.5px; margin: 6px 0 2px 8px; }
.lib-grid-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: auto; padding: 12px; }
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 10px;
}
.lib-cell {
  position: relative;
  border: 2px solid transparent;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-2);
  cursor: pointer;
}
.lib-cell.picked { border-color: var(--accent); }
.lib-cell img { width: 100%; height: 104px; object-fit: cover; display: block; }
.lib-cell-check {
  position: absolute;
  top: 5px;
  left: 5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
}
.lib-cell-zoom {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.lib-cell-meta { padding: 5px 6px 6px; display: flex; flex-direction: column; gap: 2px; }
.lib-cell-label {
  font-size: 10.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lib-cell-time { font-size: 10px; }
.lib-hint { font-size: 12px; padding: 18px 4px; }
.lib-pager { display: flex; align-items: center; gap: 10px; justify-content: center; padding: 12px 0 2px; font-size: 12px; }
.lib-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-1);
}
.lib-limit { font-size: 11.5px; margin-right: auto; }
.lib-foot .btn:nth-last-child(2) { margin-left: auto; }
.lib-preview {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.78);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  z-index: 60;
}
.lib-preview img { max-width: 86vw; max-height: 80vh; border-radius: 8px; }
.lib-preview-label { color: #eee; font-size: 12px; }
</style>
