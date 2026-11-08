<template>
  <Teleport to="body">
    <div class="overlay pool-picker-overlay" @click.self="emit('close')">
      <section class="dialog pool-picker-dialog" role="dialog" aria-modal="true" :aria-label="t('episode.pool.dialogTitle', { n: shotNumber })">
        <header class="dialog-head pool-picker-head">
          <div class="pool-picker-title-block">
            <span class="pool-picker-kicker">{{ t('episode.pool.dialogKicker') }}</span>
            <h2 class="pool-picker-title">{{ t('episode.pool.dialogTitle', { n: shotNumber }) }}</h2>
          </div>
          <button class="btn btn-ghost btn-icon" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="14" />
          </button>
        </header>

        <div class="pool-picker-body">
          <div class="pool-picker-filters">
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
              class="input pool-picker-search"
              type="search"
              :placeholder="t('episode.pool.searchPlaceholder')"
            />
            <span class="dim mono pool-picker-count">
              {{ t('episode.pool.countHint', { n: selectedCount, total: items.length }) }}
            </span>
          </div>

          <p class="pool-picker-hint">{{ t('episode.pool.dialogHint') }}</p>

          <div v-if="!items.length" class="dim pool-picker-empty">{{ t('episode.ref.empty') }}</div>
          <div v-else-if="!visibleItems.length" class="dim pool-picker-empty">{{ t('episode.pool.noResult') }}</div>
          <div v-else class="pool-picker-grid">
            <div
              v-for="item in visibleItems"
              :key="item.key"
              class="pool-picker-card"
              :class="{ on: item.selected, locked: isLocked(item), busy: isBusy(item) }"
              role="button"
              tabindex="0"
              :aria-pressed="item.selected ? 'true' : 'false'"
              :title="isLocked(item) ? lockReason : (item.selected ? t('episode.pool.remove') : t('episode.pool.add'))"
              @click="toggle(item)"
              @keydown.enter.prevent="toggle(item)"
              @keydown.space.prevent="toggle(item)"
            >
              <div class="pool-picker-media">
                <img
                  v-if="item.ready"
                  :src="thumbOf(imgSrc(item.imageUrl))"
                  loading="lazy"
                  :alt="item.name"
                  @error="onThumbError($event, item.imageUrl)"
                />
                <span v-else class="pool-picker-media-empty">
                  {{ item.kind === 'scene' ? t('episode.ref.shortScene') : item.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar') }}
                </span>
                <span class="pool-picker-check" :class="{ on: item.selected, locked: isLocked(item) }">
                  <Loader2 v-if="isBusy(item)" :size="12" class="animate-spin" />
                  <Lock v-else-if="isLocked(item)" :size="11" />
                  <svg v-else-if="item.selected" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
              </div>
              <div class="pool-picker-info">
                <span class="pool-picker-name" :title="item.name">{{ item.name }}</span>
                <span class="pool-picker-meta">{{ item.typeLabel }} · {{ item.meta }}</span>
                <span class="pool-picker-badges">
                  <span v-if="item.manual" class="tag pool-picker-tag">{{ t('episode.pool.sourceManual') }}</span>
                  <span v-if="item.mentioned" class="tag pool-picker-tag is-mention">{{ t('episode.pool.sourceMentioned') }}</span>
                  <span v-if="!item.ready" class="pool-picker-state">{{ t('episode.ref.notReady') }}</span>
                </span>
                <button
                  v-if="item.mentioned && !item.manual"
                  type="button"
                  class="pool-picker-link"
                  :disabled="isBusy(item)"
                  :title="t('episode.pool.keepManualHint')"
                  @click.stop="keepManual(item)"
                  @keydown.enter.stop
                  @keydown.space.stop
                >{{ t('episode.pool.keepManual') }}</button>
                <span v-if="errorOf(item)" class="pool-picker-error">{{ errorOf(item) }}</span>
              </div>
            </div>
          </div>
        </div>

        <footer class="dialog-foot pool-picker-foot">
          <span class="dim pool-picker-foot-hint">{{ t('episode.pool.autoSaveHint') }}</span>
          <span class="pool-picker-foot-space" />
          <button class="btn btn-primary" @click="emit('close')">{{ t('episode.pool.done') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 本镜资产池选择器（Issue #43）：关键帧页 / 其它共用池入口的唯一选择界面。
 * - 展示本集全部可视角色 / 场景 / 道具，按名称搜索、按三类浏览；已选在卡片上高亮。
 * - 单项点击立即持久化（PUT /storyboards/:id/pool-assets），每张卡片独立 busy / 错误。
 * - 被五个提示词任一 @ 引用的资产不可在此取消（后端同样校验并返回中文原因）；
 *   仅「引用自动加入」的资产可以额外标记为手选，之后删除引用也不会自动移出。
 */
import { Loader2, Lock, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { thumbOf } from '~/composables/useMedia'
import { serverMessage } from '~/composables/useToast'
import { DEEPLINK_KEYS, queryEnum, querySingle, useDeeplink } from '~/composables/useQuerySync'

const { t } = useI18n()

const props = defineProps({
  // 当前分镜 id：切镜时重置忙碌/错误状态，并丢弃切镜前发出的异步结果
  storyboardId: { type: Number, default: 0 },
  shotNumber: { type: Number, default: 0 },
  // 候选资产（本集全部可视资产，含 selected / manual / mentioned 来源标记）
  items: { type: Array, default: () => [] },
  // (asset, selected) => Promise：单项持久化，失败时抛错（错误文案就地展示）
  submit: { type: Function, default: async () => {} },
  // 是否把筛选写进 URL（#86）：嵌入模式的关键帧编辑器不持有 pool 父键，这里也就不发布
  deeplink: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])

// deeplink（#86）：弹窗内部的类型栏与关键词（取自 keyframes 登记表的子键）；关闭即卸载 → 两个键自动随 pool 一起消失
const POOL_KEYS = DEEPLINK_KEYS.keyframes.filter(key => key === 'poolkind' || key === 'poolq')
const link = props.deeplink ? useDeeplink('pool', POOL_KEYS) : null
const kind = ref(queryEnum(link?.initial('poolkind'), ['character', 'scene', 'prop']) || '')
const keyword = ref(querySingle(link?.initial('poolq')) || '')
watch([kind, keyword], () => {
  link?.set({ poolkind: kind.value, poolq: keyword.value.trim() })
}, { immediate: true })

const busy = ref({})
const errors = ref({})

const kindTabs = computed(() => [
  { value: '', label: t('index.status.all') },
  { value: 'character', label: t('common.role') },
  { value: 'scene', label: t('common.scene') },
  { value: 'prop', label: t('common.prop') },
])

const lockReason = computed(() => t('episode.pool.lockedReason'))

const visibleItems = computed(() => props.items.filter((item) => {
  if (kind.value && item.kind !== kind.value) return false
  const q = keyword.value.trim().toLowerCase()
  if (q && !String(item.name || '').toLowerCase().includes(q) && !String(item.meta || '').toLowerCase().includes(q)) return false
  return true
}))

const selectedCount = computed(() => props.items.filter(item => item.selected).length)

function imgSrc(raw) {
  return mediaUrl(raw)
}
function onThumbError(e, raw) {
  const full = imgSrc(raw)
  if (full && e.target.src !== new URL(full, window.location.origin).href) e.target.src = full
}

function isLocked(item) {
  return Boolean(item.selected && item.mentioned)
}
function isBusy(item) {
  return Boolean(busy.value[item.key])
}
function errorOf(item) {
  return errors.value[item.key] || ''
}
function setError(key, message) {
  errors.value = { ...errors.value, [key]: message }
}

// 切镜：丢掉上一镜的忙碌/错误，避免旧状态套到新镜的同名卡片上
watch(() => props.storyboardId, () => {
  busy.value = {}
  errors.value = {}
})

async function persist(item, selected) {
  if (isBusy(item)) return
  const shotId = props.storyboardId
  busy.value = { ...busy.value, [item.key]: true }
  setError(item.key, '')
  try {
    await props.submit(item, selected)
  } catch (e) {
    // 切镜后到达的失败结果不写回当前（新）分镜的卡片
    if (props.storyboardId === shotId) setError(item.key, serverMessage(e, { fallback: 'episode.pool.saveFailed' }))
  } finally {
    if (props.storyboardId === shotId) busy.value = { ...busy.value, [item.key]: false }
  }
}

function toggle(item) {
  if (isBusy(item)) return
  if (isLocked(item)) {
    setError(item.key, lockReason.value)
    return
  }
  void persist(item, !item.selected)
}

/** 引用自动加入的资产 → 记为手选：之后删除 @ 引用也会保留在池里 */
function keepManual(item) {
  if (isBusy(item) || item.manual) return
  void persist(item, true)
}
</script>

<style scoped>
.pool-picker-overlay { z-index: 62; }
.pool-picker-dialog { width: min(1080px, 94vw); max-height: 86vh; display: flex; flex-direction: column; }
.pool-picker-head { display: flex; align-items: center; gap: 10px; }
.pool-picker-title-block { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.pool-picker-kicker { font-size: 11px; color: var(--text-3); }
.pool-picker-title { font-size: 15px; margin: 0; }
.pool-picker-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; overflow: hidden; flex: 1; min-height: 0; }
.pool-picker-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pool-picker-search { flex: 1; min-width: 160px; }
.pool-picker-count { margin-left: auto; font-size: 12px; }
.pool-picker-hint { margin: 0; font-size: 11px; color: var(--text-3); }
.pool-picker-empty { padding: 32px; text-align: center; font-size: 12px; }
/* 与关键帧页资产池同一套流式网格：卡片 160–240px，图片 contain */
.pool-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 240px));
  justify-content: start;
  gap: 10px;
  /* dialog 内唯一滚动区：本集全部候选都要能滚到（父级 overflow:hidden） */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  align-content: start;
}
.pool-picker-card {
  display: flex; flex-direction: column; min-height: 212px; min-width: 0; max-width: 240px;
  border: 1px solid var(--border); border-radius: 9px; overflow: hidden;
  background: var(--surface-raised); cursor: pointer; text-align: left;
}
.pool-picker-card:hover { border-color: var(--border-strong); }
.pool-picker-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.pool-picker-card.locked { cursor: not-allowed; }
.pool-picker-card.busy { opacity: .72; }
.pool-picker-media {
  position: relative; flex: 0 0 124px; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2); color: var(--text-3); font-size: 12px;
}
.pool-picker-media img { width: 100%; height: 100%; object-fit: contain; display: block; }
.pool-picker-media-empty { font-size: 12px; }
.pool-picker-check {
  position: absolute; top: 6px; right: 6px;
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface-raised); color: var(--text-2);
}
.pool-picker-check.on { border-color: var(--accent); background: var(--accent); color: var(--surface-raised); }
.pool-picker-check.locked { border-color: var(--border-strong); }
.pool-picker-info { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px 7px; min-width: 0; }
.pool-picker-name { font-size: 12px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pool-picker-meta { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pool-picker-badges { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pool-picker-tag { font-size: 10px; }
.pool-picker-tag.is-mention { border-color: var(--accent); color: var(--accent-text); }
.pool-picker-state { font-size: 11px; color: var(--text-3); }
.pool-picker-link { align-self: flex-start; font-size: 11px; color: var(--accent-text); background: none; border: none; padding: 0; cursor: pointer; }
.pool-picker-link:disabled { opacity: .5; cursor: default; }
.pool-picker-error { font-size: 11px; color: var(--danger, #e5484d); white-space: normal; }
.pool-picker-foot { display: flex; align-items: center; gap: 8px; }
.pool-picker-foot-hint { font-size: 11px; }
.pool-picker-foot-space { flex: 1; }
</style>
