<script setup>
/**
 * 资产审核清单（Issue #54 建壳，#55 填充）
 *
 * 纪录片「资产」步的第二个子页签：AI 逐条列出「信息点 → 需要的素材 → 有/缺」，
 * 全部处置后 `episodes.asset_review_status` 变成 `passed`，分镜设计步才解锁。
 *
 * 面板只跟 `assetReviewAPI` 说话：对照、处置、补提取都在这里；
 * 「打开某个资产的语义标注」与「新建资产补齐」通过事件交回 episode.vue 的现有抽屉。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ClipboardCheck, Loader2, Lock, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

import { assetReviewAPI, episodeAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { onTaskFinished } from '~/composables/useTasks'
import AssetReviewBatchDialog from './AssetReviewBatchDialog.vue'

const props = defineProps({
  episodeId: { type: Number, default: 0 },
  /** `GET /episodes/:id/gates` 的 assets 分项：{ review_status, stale_reasons, missing } */
  review: { type: Object, default: () => ({ review_status: 'none', stale_reasons: [], missing: 0 }) },
})

const emit = defineEmits(['update:status', 'open-asset', 'create-asset', 'goto-design'])

const { t, te } = useI18n()

const STATUSES = ['missing', 'have', 'added', 'ignored', 'not_needed']
/** 轮询节奏与 PropSemanticsPanel 的自动标注一致 */
const POLL_MS = 3000

const loading = ref(false)
const running = ref(false)
const payload = ref(null)
const filter = ref('all')
const collapsed = ref({})
const episodeAssets = ref([])
const busyItemId = ref(0)
const ignoreDialog = ref({ open: false, item: null, reason: '', saving: false })
const bindDialog = ref({ open: false, item: null, kind: 'prop', assetId: 0, saving: false })
const batchMode = ref('')
const batchItems = ref([])
const batchSaving = ref(false)
const batchResult = ref(null)
let timer = null

const status = computed(() => payload.value?.status || props.review?.review_status || 'none')
const reviewStatusLabel = computed(() => t(`episode.assetReview.status${status.value.replace(/^./, c => c.toUpperCase())}`))
const counts = computed(() => payload.value?.counts || { total: 0, missing: 0, have: 0, added: 0, ignored: 0, not_needed: 0 })
const decided = computed(() => counts.value.total - counts.value.missing)
const staleReasons = computed(() => payload.value?.stale?.reasons || props.review?.stale_reasons || [])
const isStale = computed(() => staleReasons.value.length > 0)
const runProgress = computed(() => payload.value?.run?.progress || null)
const segments = computed(() => payload.value?.segments || [])
const hasItems = computed(() => counts.value.total > 0)
const firstMissing = computed(() => {
  for (const seg of segments.value) {
    const hit = seg.items.find(item => item.status === 'missing')
    if (hit) return hit
  }
  return null
})

const filteredSegments = computed(() => {
  if (filter.value === 'all') return segments.value
  return segments.value
    .map(seg => ({ ...seg, items: seg.items.filter(item => item.status === filter.value) }))
    .filter(seg => seg.items.length)
})
const filteredMissing = computed(() => filteredSegments.value.flatMap(seg => seg.items.filter(item => item.status === 'missing')))
const activeExtractions = computed(() => segments.value.some(seg => seg.items.some(item => item.extraction)))

const staleText = computed(() => staleReasons.value
  .map(reason => t(`episode.assetReview.staleReason.${reason}`))
  .join('、'))

function needKindLabel(kind) {
  return t(`episode.assetReview.needKind.${kind}`)
}

function statusLabel(value) {
  return t(`episode.assetReview.itemStatus.${value}`)
}

function statusIcon(value) {
  return { missing: '✗', have: '✓', added: '✓', ignored: '⊘', not_needed: '—' }[value] || '·'
}

function assetKindOfItem(item) {
  if (item.asset_kind) return item.asset_kind
  if (item.need_kind === 'character' || item.need_kind === 'scene') return item.need_kind
  return 'prop'
}

async function load(opts = {}) {
  if (!props.episodeId) return
  if (!opts.silent) loading.value = true
  try {
    const data = await assetReviewAPI.get(props.episodeId)
    payload.value = data
    running.value = data.run?.status === 'running'
    schedulePoll()
    // 只在状态真的变了才通知父级重算门禁：每次轮询都 emit 会让门禁刷新把面板卸载重挂，
    // 重挂又触发一次 load，形成无限循环
    if (!batchResult.value && (opts.refreshGate || data.status !== props.review?.review_status)) emit('update:status', data.status)
  } catch (err) {
    // 剧情项目（400 not_documentary）在这个面板下不会被挂载；其余错误照常提示
    toastError(err)
  } finally {
    loading.value = false
  }
}

function schedulePoll() {
  if (timer) { clearTimeout(timer); timer = null }
  if (running.value || activeExtractions.value) timer = setTimeout(() => load({ silent: true }), POLL_MS)
}

async function loadEpisodeAssets() {
  if (!props.episodeId) return
  try {
    const [chars, scenes, items] = await Promise.all([
      episodeAPI.characters(props.episodeId),
      episodeAPI.scenes(props.episodeId),
      episodeAPI.props(props.episodeId),
    ])
    episodeAssets.value = [
      ...(chars || []).map(row => ({ kind: 'character', id: row.id, name: row.name })),
      ...(scenes || []).map(row => ({ kind: 'scene', id: row.id, name: row.location })),
      ...(items || []).map(row => ({ kind: 'prop', id: row.id, name: row.name, faithful: Number(row.faithful) === 1 })),
    ]
  } catch (err) {
    toastError(err)
  }
}

async function runReview() {
  if (running.value || !props.episodeId) return
  running.value = true
  try {
    await assetReviewAPI.run(props.episodeId)
    toast.success(t('episode.assetReview.runStarted'))
    await load({ silent: true })
  } catch (err) {
    running.value = false
    toastError(err)
  }
}

async function patchItem(item, patch) {
  busyItemId.value = item.id
  try {
    await assetReviewAPI.updateItem(item.id, patch)
    await load({ silent: true })
    await loadEpisodeAssets()
  } catch (err) {
    toastError(err)
    throw err
  } finally {
    busyItemId.value = 0
  }
}

async function markNotNeeded(item) {
  await patchItem(item, { status: 'not_needed', reason: t('episode.assetReview.notNeededReason') })
}

async function undecide(item) {
  await patchItem(item, { status: 'missing' })
}

async function extractItem(item) {
  busyItemId.value = item.id
  try {
    const res = await assetReviewAPI.extract(item.id)
    toast.success(t('episode.assetReview.extractStarted', { name: res.asset_name }))
    await load({ silent: true })
  } catch (err) {
    toastError(err)
  } finally {
    busyItemId.value = 0
  }
}

function openBatch(mode) {
  batchItems.value = [...filteredMissing.value]
  batchResult.value = null
  batchMode.value = mode
}

function closeBatch() {
  if (batchSaving.value) return
  const refreshGate = !!batchResult.value
  batchMode.value = ''
  batchResult.value = null
  if (refreshGate) emit('update:status', status.value)
}

async function confirmBatch(ids) {
  if (batchSaving.value || !ids.length) return
  batchSaving.value = true
  const mode = batchMode.value
  const items = batchItems.value.filter(item => ids.includes(item.id))
  try {
    const result = mode === 'extract'
      ? await assetReviewAPI.extractBatch(props.episodeId, ids)
      : mode === 'create'
        ? await assetReviewAPI.createAssets(props.episodeId, ids)
        : await assetReviewAPI.batchStatus(props.episodeId, ids)
    const done = mode === 'extract' ? result.queued.length : mode === 'create' ? result.created.length : result.updated
    const summary = t(`episode.assetReview.results.${mode}Summary`, { done, skipped: result.skipped.length })
    const skippedById = new Map(result.skipped.map(row => [row.item_id, row]))
    const createdById = new Map((result.created || []).map(row => [row.item_id, row]))
    const rows = items.map(item => ({
      item_id: item.id,
      info_point: item.info_point,
      ...createdById.get(item.id),
      ...skippedById.get(item.id),
    }))
    if (mode !== 'extract' && rows.length > 10) {
      batchResult.value = { mode, summary, rows }
    } else {
      const details = mode === 'extract' ? '' : rows.map(row => {
        if (!row.reason) return `${row.info_point}: ${t(`episode.assetReview.results.${mode === 'create' ? 'created' : 'updated'}`)}${row.name ? ` — ${row.name}` : ''}`
        const key = `episode.assetReview.results.reason.${row.reason}`
        const reason = te(key) ? t(key) : row.reason
        const candidate = row.candidate ? ` — ${t('episode.assetReview.results.candidate', { kind: needKindLabel(row.candidate.kind), name: row.candidate.name, id: row.candidate.id })}` : ''
        return `${row.info_point}: ${reason}${candidate}`
      }).join('\n')
      toast.success(summary, details ? { description: details } : undefined)
      batchMode.value = ''
    }
    await load({ silent: true, refreshGate: true })
    if (mode === 'create') await loadEpisodeAssets()
  } catch (err) {
    toastError(err)
  } finally {
    batchSaving.value = false
  }
}

function openIgnore(item) {
  ignoreDialog.value = { open: true, item, reason: '', saving: false }
}

async function confirmIgnore() {
  const dialog = ignoreDialog.value
  if (dialog.saving || dialog.reason.trim().length < 5) return
  dialog.saving = true
  try {
    await patchItem(dialog.item, { status: 'ignored', reason: dialog.reason.trim() })
    ignoreDialog.value = { open: false, item: null, reason: '', saving: false }
  } catch {
    dialog.saving = false
  }
}

function openBind(item) {
  // 选项值用 `kind:id`：三类资产的 id 各自从 1 开始，exposition 条目的候选跨类别，
  // 只传裸 id 会把角色/场景错绑成同号道具
  bindDialog.value = { open: true, item, kind: assetKindOfItem(item), assetId: '', saving: false }
  loadEpisodeAssets()
}

const bindCandidates = computed(() => {
  const item = bindDialog.value.item
  if (!item) return []
  if (item.need_kind === 'exposition') return episodeAssets.value
  if (item.need_kind === 'prop_faithful') return episodeAssets.value.filter(a => a.kind === 'prop' && a.faithful)
  const kind = assetKindOfItem(item)
  return episodeAssets.value.filter(a => a.kind === kind)
})

async function confirmBind() {
  const dialog = bindDialog.value
  if (dialog.saving || !dialog.assetId) return
  const [kind, id] = String(dialog.assetId).split(':')
  const asset = episodeAssets.value.find(a => a.kind === kind && a.id === Number(id))
  if (!asset) return
  dialog.saving = true
  try {
    await patchItem(dialog.item, { status: 'have', asset_kind: asset.kind, asset_id: asset.id })
    bindDialog.value = { open: false, item: null, kind: 'prop', assetId: '', saving: false }
  } catch {
    dialog.saving = false
  }
}

/** 「上传 / AI 生成」= 打开新建资产抽屉，预填类别与名称，保存后服务端自动回链为「已补」 */
function createAsset(item) {
  emit('create-asset', {
    kind: assetKindOfItem(item),
    name: item.need_desc || item.info_point,
    faithful: item.need_kind === 'prop_faithful',
    review_item_id: item.id,
  })
}

function openAsset(item) {
  if (!item.asset_id) return
  emit('open-asset', { kind: item.asset_kind, id: item.asset_id, semantic_id: item.semantic_id || null })
}

function toggleSegment(segmentNo) {
  collapsed.value = { ...collapsed.value, [segmentNo]: !isCollapsed(segmentNo) }
}

function isCollapsed(segmentNo) {
  if (segmentNo in collapsed.value) return collapsed.value[segmentNo]
  // 默认展开含缺失的段
  const seg = segments.value.find(s => s.segment_no === segmentNo)
  return !!seg && seg.counts.missing === 0
}

function scrollToFirstMissing() {
  const item = firstMissing.value
  if (!item) return
  collapsed.value = { ...collapsed.value, [item.segment_no]: false }
  filter.value = 'missing'
  requestAnimationFrame(() => {
    document.querySelector(`[data-review-item="${item.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

watch(() => props.episodeId, () => {
  payload.value = null
  collapsed.value = {}
  load()
  loadEpisodeAssets()
}, { immediate: true })

onTaskFinished((task) => {
  const kind = String(task?.kind || task?.params?.kind || '')
  if (kind === 'asset_review' || kind.startsWith('extract_')) load({ silent: true })
})

onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <div class="prod-content">
    <div class="prod-section-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.assets.tabReview') }}</span>
      <span class="tag mono">{{ t('episode.assetReview.statusLabel', { status: reviewStatusLabel }) }}</span>
      <span class="tag mono">{{ t('episode.assetReview.progress', { decided, total: counts.total }) }}</span>
      <span v-if="payload?.auto_segmented" class="tag">{{ t('episode.assetReview.autoSegmented') }}</span>
      <button class="btn btn-sm" :disabled="!filteredMissing.length || batchSaving" @click="openBatch('extract')">{{ t('episode.assetReview.batch.extract') }}</button>
      <button class="btn btn-sm" :disabled="!filteredMissing.length || batchSaving" @click="openBatch('create')">{{ t('episode.assetReview.batch.create') }}</button>
      <button class="btn btn-sm" :disabled="!filteredMissing.length || batchSaving" @click="openBatch('status')">{{ t('episode.assetReview.batch.status') }}</button>
      <div class="ml-auto flex gap-1">
        <button class="btn btn-sm" :disabled="running" @click="runReview()">
          <Loader2 v-if="running" :size="11" class="animate-spin" />
          <RefreshCw v-else :size="11" />
          {{ hasItems ? t('episode.assetReview.rerun') : t('episode.assetReview.start') }}
        </button>
      </div>
    </div>

    <!-- 失效横幅：资产库在上次对照后变过；不遮挡已解锁状态 -->
    <div v-if="isStale" class="review-banner">
      <span>{{ t('episode.assetReview.staleBanner', { reasons: staleText }) }}</span>
      <button class="btn btn-sm" :disabled="running" @click="runReview()">{{ t('episode.assetReview.rerun') }}</button>
    </div>

    <!-- 对照中：逐段流入 -->
    <div v-if="running" class="review-running">
      <Loader2 :size="12" class="animate-spin" />
      <span v-if="runProgress">{{ t('episode.assetReview.runningProgress', {
        completed: runProgress.completed, total: runProgress.total, failed: runProgress.failed }) }}</span>
      <span v-else>{{ t('episode.assetReview.running') }}</span>
    </div>

    <!-- 空态 -->
    <div v-if="!hasItems && !running" class="step-empty" style="flex:1">
      <div class="empty-visual"><ClipboardCheck :size="32" /></div>
      <div class="empty-title">{{ t('episode.assetReview.emptyTitle') }}</div>
      <div class="empty-desc">{{ t('episode.assetReview.emptyDesc') }}</div>
      <button class="btn btn-primary" :disabled="loading || running" @click="runReview()">
        {{ t('episode.assetReview.start') }}
      </button>
    </div>

    <template v-else>
      <!-- 筛选 -->
      <div class="seg review-filters" role="tablist">
        <button
          type="button" class="seg-item" role="tab"
          :class="{ on: filter === 'all' }" :aria-selected="filter === 'all'"
          @click="filter = 'all'"
        >{{ t('episode.assetReview.filter.all', { n: counts.total }) }}</button>
        <button
          v-for="key in STATUSES" :key="key"
          type="button" class="seg-item" role="tab"
          :class="{ on: filter === key }" :aria-selected="filter === key"
          @click="filter = key"
        >{{ t(`episode.assetReview.filter.${key}`, { n: counts[key] || 0 }) }}</button>
      </div>

      <!-- 分段清单 -->
      <div class="review-list">
        <section v-for="seg in filteredSegments" :key="seg.segment_no" class="review-segment">
          <button type="button" class="review-segment-head" @click="toggleSegment(seg.segment_no)">
            <span class="review-segment-title">{{ t('episode.assetReview.segmentTitle', {
              n: seg.segment_no, excerpt: seg.narration_excerpt.slice(0, 40) }) }}</span>
            <span class="dim mono">{{ t('episode.assetReview.segmentSummary', {
              total: seg.counts.total, missing: seg.counts.missing, review: seg.counts.needs_review }) }}</span>
          </button>
          <div v-show="!isCollapsed(seg.segment_no)" class="review-items">
            <article
              v-for="item in seg.items" :key="item.id"
              class="review-item" :class="[`is-${item.status}`]" :data-review-item="item.id"
            >
              <span class="review-item-icon" :title="statusLabel(item.status)">{{ statusIcon(item.status) }}</span>
              <div class="review-item-body">
                <div class="review-item-head">
                  <strong>{{ item.info_point }}</strong>
                  <span class="tag">{{ statusLabel(item.status) }}</span>
                </div>
                <div class="review-item-need">
                  {{ t('episode.assetReview.needLine', { kind: needKindLabel(item.need_kind), desc: item.need_desc }) }}
                </div>
                <div v-if="item.asset_name" class="review-item-bound">
                  <button type="button" class="link" @click="openAsset(item)">
                    {{ item.asset_name }}<template v-if="item.semantic_name"> · {{ item.semantic_name }}</template>
                  </button>
                  <button
                    v-if="item.semantics_needs_review"
                    type="button" class="link link-warn" @click="openAsset(item)"
                  >{{ t('episode.assetReview.needsReviewTag') }}</button>
                </div>
                <div v-if="item.reason" class="review-item-reason">{{ item.reason }}</div>
              </div>
              <div class="review-item-actions">
                <template v-if="item.status === 'missing'">
                  <button class="btn btn-sm" :disabled="busyItemId === item.id || !!item.extraction" @click="extractItem(item)">{{ item.extraction ? t(`episode.assetReview.batch.${item.extraction.status}`) : t('episode.assetReview.action.extract') }}</button>
                  <button class="btn btn-sm" :disabled="busyItemId === item.id" @click="createAsset(item)">{{ t('episode.assetReview.action.create') }}</button>
                  <button class="btn btn-sm" :disabled="busyItemId === item.id" @click="openBind(item)">{{ t('episode.assetReview.action.bind') }}</button>
                  <button class="btn btn-sm" :disabled="busyItemId === item.id" @click="openIgnore(item)">{{ t('episode.assetReview.action.ignore') }}</button>
                  <button class="btn btn-sm" :disabled="busyItemId === item.id" @click="markNotNeeded(item)">{{ t('episode.assetReview.action.notNeeded') }}</button>
                </template>
                <button v-else class="btn btn-sm" :disabled="busyItemId === item.id" @click="undecide(item)">{{ t('episode.assetReview.action.undo') }}</button>
              </div>
            </article>
          </div>
        </section>
      </div>

      <!-- 门禁底条 -->
      <div class="review-gate" :class="status === 'passed' ? 'is-passed' : 'is-pending'">
        <template v-if="status === 'passed'">
          <span>{{ t('episode.assetReview.gate.passed') }}</span>
          <button class="btn btn-sm btn-primary" @click="emit('goto-design')">{{ t('episode.assetReview.gate.goDesign') }}</button>
        </template>
        <template v-else>
          <!-- 对照中 / 缺失为 0 仍 pending（上次有失败段）都不能说「还有 0 项未处置」，与后端 assetReviewGateReason 同口径 -->
          <span v-if="status === 'running'">{{ t('episode.assetReview.gate.running') }}</span>
          <span v-else-if="counts.missing === 0">{{ t('episode.assetReview.gate.incomplete') }}</span>
          <span v-else>{{ t('episode.assetReview.gate.pending', { n: counts.missing }) }}</span>
          <button class="btn btn-sm" :disabled="!firstMissing" @click="scrollToFirstMissing()">{{ t('episode.assetReview.gate.next') }}</button>
          <button class="btn btn-sm" disabled :title="t('episode.assetReview.gate.lockedHint')">
            <Lock :size="11" /> {{ t('episode.assetReview.gate.locked') }}
          </button>
        </template>
      </div>
    </template>

    <!-- 忽略：理由必填 -->
    <div v-if="ignoreDialog.open" class="overlay" @click.self="ignoreDialog.open = false">
      <div class="dialog">
        <div class="dialog-head"><h2 class="dialog-title">{{ t('episode.assetReview.ignoreDialog.title') }}</h2></div>
        <div class="dialog-body">
          <p class="dim" style="font-size:12px">{{ t('episode.assetReview.ignoreDialog.hint') }}</p>
          <textarea
            v-model="ignoreDialog.reason" class="textarea" rows="3"
            :placeholder="t('episode.assetReview.ignoreDialog.placeholder')"
          />
          <p v-if="ignoreDialog.reason.trim().length < 5" class="dim" style="font-size:12px">
            {{ t('episode.assetReview.ignoreDialog.required') }}
          </p>
        </div>
        <div class="dialog-foot">
          <button class="btn" @click="ignoreDialog.open = false">{{ t('common.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="ignoreDialog.saving || ignoreDialog.reason.trim().length < 5"
            @click="confirmIgnore()"
          >{{ t('common.confirm') }}</button>
        </div>
      </div>
    </div>

    <!-- 选择已有资产 -->
    <div v-if="bindDialog.open" class="overlay" @click.self="bindDialog.open = false">
      <div class="dialog">
        <div class="dialog-head"><h2 class="dialog-title">{{ t('episode.assetReview.bindDialog.title') }}</h2></div>
        <div class="dialog-body">
          <p class="dim" style="font-size:12px">{{ t('episode.assetReview.bindDialog.hint') }}</p>
          <select v-model="bindDialog.assetId" class="input">
            <option value="">{{ t('episode.assetReview.bindDialog.placeholder') }}</option>
            <option
              v-for="asset in bindCandidates"
              :key="`${asset.kind}-${asset.id}`"
              :value="`${asset.kind}:${asset.id}`"
            >{{ asset.name }}（{{ t(`episode.assetReview.needKind.${asset.kind}`) }}）</option>
          </select>
          <p v-if="!bindCandidates.length" class="dim" style="font-size:12px">
            {{ t('episode.assetReview.bindDialog.empty') }}
          </p>
        </div>
        <div class="dialog-foot">
          <button class="btn" @click="bindDialog.open = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="bindDialog.saving || !bindDialog.assetId" @click="confirmBind()">
            {{ t('common.confirm') }}
          </button>
        </div>
      </div>
    </div>
    <AssetReviewBatchDialog
      v-if="batchMode" :mode="batchMode" :items="batchItems" :saving="batchSaving" :result="batchResult"
      @close="closeBatch" @confirm="confirmBatch"
    />
  </div>
</template>

<style scoped>
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.prod-section-bar { flex-wrap: wrap; }
.prod-section-bar { display: flex; align-items: center; gap: 8px; }
.step-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
.empty-visual { opacity: 0.5; }
.empty-title { font-size: 13px; font-weight: 600; }
.empty-desc { font-size: 12px; opacity: 0.65; max-width: 520px; line-height: 1.6; }
.review-banner { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 8px 10px; border-radius: 8px; background: rgba(255, 183, 77, 0.14); border: 1px solid rgba(255, 183, 77, 0.45); }
.review-running { display: flex; align-items: center; gap: 8px; font-size: 12px; opacity: 0.8; }
.review-filters { flex-wrap: wrap; }
.review-list { display: flex; flex-direction: column; gap: 10px; }
.review-segment { border: 1px solid var(--border, rgba(128, 128, 128, 0.25)); border-radius: 8px; overflow: hidden; }
.review-segment-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; background: transparent; border: 0; cursor: pointer; text-align: left; font-size: 12px; }
.review-segment-title { font-weight: 600; }
.review-items { display: flex; flex-direction: column; }
.review-item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-top: 1px solid var(--border, rgba(128, 128, 128, 0.18)); font-size: 12px; }
.review-item.is-missing { background: rgba(239, 83, 80, 0.07); }
.review-item-icon { width: 16px; text-align: center; font-weight: 700; }
.review-item-body { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.review-item-head { display: flex; align-items: center; gap: 6px; }
.review-item-need { opacity: 0.75; }
.review-item-reason { opacity: 0.6; font-style: italic; }
.review-item-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.link { background: none; border: 0; padding: 0; cursor: pointer; color: var(--accent, #4fc3f7); font-size: 12px; }
.link-warn { color: #ffb74d; margin-left: 8px; }
.review-gate { position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12px; }
.review-gate.is-pending { background: rgba(239, 83, 80, 0.14); border: 1px solid rgba(239, 83, 80, 0.45); }
.review-gate.is-passed { background: rgba(102, 187, 106, 0.14); border: 1px solid rgba(102, 187, 106, 0.45); }
</style>
