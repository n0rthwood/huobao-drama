<template>
  <Teleport to="body">
    <div v-if="open" class="overlay poster-picker-overlay" @click.self="close">
      <div class="dialog poster-picker" role="dialog" aria-modal="true" :aria-label="t('poster.reference.title')">
        <header class="poster-picker-head">
          <h2 class="poster-picker-title">{{ t('poster.reference.title') }}</h2>
          <span class="poster-picker-count" :class="{ full: picked.length >= max }">
            {{ t('poster.reference.selected', { n: picked.length, max }) }}
          </span>
          <button type="button" class="btn btn-sm" @click="close">
            <X :size="13" />
          </button>
        </header>

        <div class="poster-picker-body">
          <p v-if="loading" class="poster-picker-hint dim">{{ t('poster.reference.loading') }}</p>
          <p v-else-if="!groups.length" class="poster-picker-hint dim">{{ t('poster.reference.empty') }}</p>
          <template v-else>
            <section v-for="group in groups" :key="group.kind" class="poster-picker-group">
              <h3 class="poster-picker-group-title">{{ t(`poster.reference.kind.${group.kind}`) }}</h3>
              <div v-for="owner in group.owners" :key="owner.name" class="poster-picker-owner">
                <span class="poster-picker-owner-name">{{ owner.name }}</span>
                <div class="poster-picker-grid">
                  <button
                    v-for="image in owner.images"
                    :key="image.path"
                    type="button"
                    :class="['poster-picker-cell', { picked: picked.includes(image.path) }]"
                    :aria-pressed="picked.includes(image.path)"
                    @click="toggle(image.path)"
                  >
                    <img :src="mediaUrl(image.thumb_url)" :alt="owner.name" loading="lazy" />
                    <span v-if="picked.includes(image.path)" class="poster-picker-order">{{ picked.indexOf(image.path) + 1 }}</span>
                  </button>
                </div>
              </div>
            </section>
          </template>
        </div>

        <footer class="poster-picker-foot">
          <span class="poster-picker-hint dim">{{ t('poster.reference.orderHint') }}</span>
          <button type="button" class="btn" @click="close">{{ t('common.cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="loading" @click="confirm">
            {{ t('poster.reference.confirm', { n: picked.length }) }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { mediaLibraryAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, required: true },
  selected: { type: Array, default: () => [] },
  max: { type: Number, default: 9 },
})
const emit = defineEmits(['close', 'confirm'])
const { t } = useI18n()

const loading = ref(false)
const groups = ref([])
const picked = ref([])
let loadToken = 0

const KINDS = ['character', 'scene', 'prop']

async function fetchKind(kind) {
  const images = []
  let page = 1
  while (true) {
    const res = await mediaLibraryAPI.images({ episode_id: props.episodeId, kind, page, page_size: 200 })
    images.push(...(res.items || []))
    if (images.length >= (res.total || 0) || !(res.items || []).length) break
    page += 1
  }
  const owners = new Map()
  for (const image of images) {
    const name = image.owner_name || image.source_label || kind
    if (!owners.has(name)) owners.set(name, [])
    owners.get(name).push(image)
  }
  return {
    kind,
    owners: Array.from(owners, ([name, list]) => ({ name, images: list })),
  }
}

async function load() {
  const token = ++loadToken
  loading.value = true
  try {
    const loaded = await Promise.all(KINDS.map(fetchKind))
    if (token === loadToken) groups.value = loaded.filter(group => group.owners.length)
  } catch (err) {
    toastError(err)
  } finally {
    if (token === loadToken) loading.value = false
  }
}

function toggle(path) {
  const index = picked.value.indexOf(path)
  if (index >= 0) picked.value.splice(index, 1)
  else if (picked.value.length < props.max) picked.value.push(path)
}

function close() {
  emit('close')
}

function confirm() {
  emit('confirm', [...picked.value])
  emit('close')
}

watch(() => props.open, open => {
  if (!open) return
  picked.value = props.selected.filter(path => typeof path === 'string')
  load()
})
</script>

<style scoped>
.poster-picker-overlay {
  z-index: 119;
  background: rgba(0, 0, 0, 0.62);
}
.poster-picker {
  width: min(920px, 92vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #14161c);
  border: 1px solid var(--border-color, #2a2e39);
  border-radius: 12px;
  overflow: hidden;
}
.poster-picker-head,
.poster-picker-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color, #2a2e39);
}
.poster-picker-foot {
  border-bottom: 0;
  border-top: 1px solid var(--border-color, #2a2e39);
}
.poster-picker-title {
  font-size: 14px;
  margin: 0;
  flex: 1;
}
.poster-picker-count {
  font-size: 12px;
  color: var(--text-2, #aab);
}
.poster-picker-count.full {
  color: var(--warning, #f5a524);
}
.poster-picker-body {
  flex: 1;
  overflow: auto;
  padding: 8px 16px 16px;
}
.poster-picker-hint {
  font-size: 12px;
}
.poster-picker-group + .poster-picker-group {
  margin-top: 14px;
}
.poster-picker-group-title {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-2, #aab);
  font-weight: 600;
}
.poster-picker-owner {
  margin-bottom: 10px;
}
.poster-picker-owner-name {
  display: block;
  font-size: 11px;
  color: var(--text-2, #aab);
  margin-bottom: 4px;
}
.poster-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 120px));
  gap: 6px;
  justify-content: start;
}
.poster-picker-cell {
  position: relative;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  background: var(--panel-alt, #1b1e26);
  overflow: hidden;
  cursor: pointer;
  aspect-ratio: 1;
}
.poster-picker-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.poster-picker-cell.picked {
  border-color: var(--accent, #4f8cff);
}
.poster-picker-order {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--accent, #4f8cff);
  color: #fff;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
