<template>
  <div class="sp-root">
    <NarrationCoverageBar
      :episode-id="episodeId"
      :chat-model="chatModel"
      :chat-config-id="chatConfigId"
      @refresh="emit('refresh')"
    />

    <!-- 批量条：只有「批量AI提示词」与「批量出关键帧」，两者都先弹范围清单 -->
    <div class="sp-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.production.title') }}</span>
      <span class="tag mono">{{ t('episode.production.shotCount', { n: storyboards.length }) }}</span>
      <div class="ml-auto flex gap-1">
        <button class="btn btn-sm" :disabled="promptBatch.running || !storyboards.length" @click="openPromptScope">
          <Loader2 v-if="promptBatch.running" :size="11" class="animate-spin" />
          {{ promptBatch.running
            ? t('episode.production.promptProgress', { done: promptBatch.completed, total: promptBatch.total })
            : t('episode.production.batchPrompts') }}
        </button>
        <button class="btn btn-sm" :disabled="batchRunning || !storyboards.length" @click="openBatchScope">
          <Loader2 v-if="batchRunning" :size="11" class="animate-spin" />
          {{ batchRunning
            ? t('episode.production.batchProgress', { done: batchDone, total: batchTotal })
            : t('episode.production.batchKeyframes') }}
        </button>
      </div>
    </div>

    <div v-if="!storyboards.length" class="step-empty" style="flex:1">
      <div class="empty-title">{{ t('episode.production.emptyTitle') }}</div>
      <div class="empty-desc">{{ t('episode.production.emptyDesc') }}</div>
    </div>

    <div v-else class="sp-body">
      <!-- 左：镜列表（镜号 + 组合象形 + 段状态；设计卡未确认则置灰锁定） -->
      <section class="sp-list">
        <div
          v-for="shot in shots" :key="shot.sb.id"
          :class="['sp-shot', { on: selectedId === shot.sb.id, locked: !shot.unlocked }]"
          role="button" tabindex="0"
          :title="shot.unlocked ? undefined : t('episode.production.lockedHint', { n: shot.no })"
          @click="selectShot(shot)" @keydown.enter.prevent="selectShot(shot)"
        >
          <div class="sp-shot-line">
            <span class="sp-shot-no">#{{ shot.no }}</span>
            <strong class="sp-shot-title truncate">{{ shot.title }}</strong>
            <span v-if="!shot.unlocked" class="sp-lock" :title="t('episode.production.lockedHint', { n: shot.no })">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </span>
          </div>
          <div class="sp-shot-meta">
            <span class="tag mono" :title="shot.combo ? t(`episode.design.combo.${shot.combo}.name`) : t('episode.production.comboMissing')">
              {{ shot.glyph || t('episode.segment.comboNone') }}
            </span>
            <span v-if="shot.layerStatus" :class="['sp-seg-state', 'is-' + shot.layerStatus]">▣ {{ t(`episode.segment.status.${shot.layerStatus}`) }}</span>
            <span v-if="shot.genStatus" :class="['sp-seg-state', 'is-' + shot.genStatus]">▶ {{ t(`episode.segment.status.${shot.genStatus}`) }}</span>
            <span v-if="shot.issueCount" class="sp-warn" :title="shot.issueTitle">⚠ {{ shot.issueCount }}</span>
          </div>
        </div>
      </section>

      <!-- 右：段结构条 + 所选段的编辑器 -->
      <section class="sp-main">
        <div v-if="!selected" class="sp-placeholder">{{ t('episode.production.selectShot') }}</div>
        <template v-else>
          <SegmentBar
            :shot-number="selected.noNumber"
            :storyboard-id="selected.sb.id"
            :combo="selected.combo || ''"
            :active="activeSegment"
            :segment="state?.segment || null"
            :junction="state?.junction || null"
            :issues="state?.issues || []"
            :budget="budgetOf(selected.sb)"
            :generated-status="genStatusOf(selected.sb)"
            @update:active="v => activeSegment = v"
            @rehearse="rehearseOpen = true"
            @switch-combo="comboOpen = true"
            @open-junction="openJunction"
          />
          <LayerSegmentEditor
            v-if="activeSegment === 'layer'"
            :key="`layer-${selected.sb.id}`"
            :storyboard-id="selected.sb.id"
            :episode-id="episodeId"
            :drama-id="dramaId"
            :state="state"
            @changed="onLayerChanged"
            @goto-design="emit('goto-design')"
          />
          <GeneratedSegmentEditor
            v-else
            :key="`gen-${selected.sb.id}`"
            :storyboard="selected.sb"
            :locked-slot="lockedSlotOf(selected.sb)"
            :issues="state?.issues || []"
            :pool-candidates="poolCandidates"
            :set-pool-asset="setPoolAsset"
            :target-assets-for="targetAssetsFor"
            :asset-versions-for="assetVersionsFor"
            :set-target-version="setTargetVersion"
            :mention-options-for="mentionOptionsFor"
            :ref-kinds="refKinds"
            :image-model="imageModel"
            :image-config-id="imageConfigId"
            :image-model-label="imageModelLabel"
            :chat-model="chatModel"
            :chat-config-id="chatConfigId"
            :aspect-ratio="aspectRatio"
            :breaking="breaking"
            :agent-busy="agentBusy"
            :field-save="fieldSave"
            :narration-enabled="narrationEnabled"
            :episode-timing="episodeTiming"
            :episode-mix-mode="episodeMixMode"
            :episode-fit-default="episodeFitDefault"
            :episode-normalize="episodeNormalize"
            :narration-batch="narrationBatch"
            :narration-voice-batch="narrationVoiceBatch"
            @refresh="onGeneratedChanged"
            @preview="(src, title) => emit('preview', src, title)"
            @goto-assets="emit('goto-assets')"
            @open-asset="(asset) => emit('open-asset', asset)"
            @update-field="(sb, field, value) => emit('update-field', sb, field, value)"
            @field-dirty="(sb, field, value) => emit('field-dirty', sb, field, value)"
            @goto-layer="activeSegment = 'layer'"
          />
        </template>
      </section>
    </div>

    <!-- 范围清单：确认后才提交 -->
    <div v-if="scopeDialog.open" class="overlay" @click.self="scopeDialog.open = false">
      <div class="dialog sp-scope-dialog">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ t(`episode.production.scopeTitle.${scopeDialog.kind}`) }}</h2>
          <button class="btn btn-ghost btn-icon" @click="scopeDialog.open = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>
        <div class="dialog-body sp-scope-body">
          <div v-if="scopeDialog.loading" class="dim" style="font-size:12px">{{ t('episode.production.scopeLoading') }}</div>
          <template v-else>
            <div class="sp-scope-summary">
              {{ t('episode.production.scopeSummary', { n: scopeDialog.included.length, m: scopeDialog.excluded.length }) }}
            </div>
            <p v-if="scopeDialog.error" class="sp-scope-error">{{ scopeDialog.error }}</p>
            <div class="sp-scope-cols">
              <section class="sp-scope-col">
                <h3 class="sp-scope-title">{{ t('episode.production.scopeWillProcess') }}</h3>
                <div class="sp-scope-list">
                  <span v-for="item in scopeDialog.included" :key="`in-${item.storyboard_id}`" class="tag mono" :title="(item.slots || []).map(slot => slotLabel(slot)).join(t('common.listJoin'))">#{{ pad(item.storyboard_number) }}</span>
                  <span v-if="!scopeDialog.included.length" class="dim" style="font-size:12px">{{ t('episode.segment.comboNone') }}</span>
                </div>
              </section>
              <section class="sp-scope-col">
                <h3 class="sp-scope-title">{{ t('episode.production.scopeExcluded') }}</h3>
                <div class="sp-scope-list sp-scope-list-col">
                  <div v-for="item in scopeDialog.excluded" :key="`ex-${item.storyboard_id}`" class="sp-scope-item">
                    <span class="tag mono">#{{ pad(item.storyboard_number) }}</span>
                    <span class="sp-scope-reason">{{ item.reason }}</span>
                  </div>
                  <span v-if="!scopeDialog.excluded.length" class="dim" style="font-size:12px">{{ t('episode.segment.comboNone') }}</span>
                </div>
              </section>
            </div>
            <p v-if="scopeDialog.kind === 'keyframes'" class="sp-scope-hint">{{ t('episode.production.scopeSubmitHint') }}</p>
          </template>
        </div>
        <footer class="dialog-foot">
          <button class="btn" @click="scopeDialog.open = false">{{ t('common.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="scopeDialog.loading || !scopeDialog.included.length"
            @click="confirmScope"
          >{{ t('episode.production.scopeConfirm', { n: scopeDialog.included.length }) }}</button>
        </footer>
      </div>
    </div>

    <ComboSwitchDialog
      v-if="comboOpen && selected"
      :storyboard-id="selected.sb.id"
      :shot-number="selected.noNumber"
      :from="selected.combo || ''"
      @close="comboOpen = false"
      @switched="onComboSwitched"
    />

    <RehearsalDialog
      v-if="rehearseOpen && selected"
      :storyboard="selected.sb"
      :shot-number="selected.noNumber"
      :combo="selected.combo || ''"
      :segment="state?.segment || null"
      :junction="state?.junction || null"
      :budget="budgetOf(selected.sb)"
      :aspect-ratio="aspectRatio"
      @close="rehearseOpen = false"
    />
  </div>
</template>

<script setup>
/**
 * 分镜制作页根（Issue #58）：一镜 = ▣ 图层段 + ▶ 生成段（由段组合决定形态）。
 * 左侧镜列表带组合象形与段状态，选中后顶部常驻段结构条，下方按所选段切换编辑器；
 * A 组合只有图层段（不渲染任何故事关键帧 UI），B 组合只有生成段（同剧情项目）。
 * 批量入口只有两个：批量AI提示词、批量出关键帧，都先弹范围清单再提交。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2 } from 'lucide-vue-next'
import NarrationCoverageBar from '~/components/NarrationCoverageBar.vue'
import SegmentBar from '~/components/ShotProduction/SegmentBar.vue'
import LayerSegmentEditor from '~/components/ShotProduction/LayerSegmentEditor.vue'
import GeneratedSegmentEditor from '~/components/ShotProduction/GeneratedSegmentEditor.vue'
import ComboSwitchDialog from '~/components/ShotProduction/ComboSwitchDialog.vue'
import RehearsalDialog from '~/components/ShotProduction/RehearsalDialog.vue'
import { episodeAPI, layerSegmentAPI } from '~/composables/useApi'
import { toastError, toastServerMessage } from '~/composables/useToast'
import { isActiveBatchItemState } from '~/composables/useTaskProgress'
import { DEEPLINK_KEYS, queryEnum, querySingle, useDeeplink } from '~/composables/useQuerySync'

const props = defineProps({
  episodeId: { type: Number, required: true },
  dramaId: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
  // 从视频页/关键帧页跳转过来时要聚焦的镜头
  focusStoryboardId: { type: Number, default: 0 },
  poolCandidates: { type: Function, default: () => [] },
  setPoolAsset: { type: Function, default: async () => {} },
  targetAssetsFor: { type: Function, default: () => [] },
  assetVersionsFor: { type: Function, default: () => [] },
  setTargetVersion: { type: Function, default: async () => {} },
  mentionOptionsFor: { type: Function, default: () => [] },
  refKinds: { type: Array, default: () => [] },
  imageModel: { type: String, default: '' },
  imageConfigId: { type: Number, default: 0 },
  imageModelLabel: { type: String, default: '' },
  aspectRatio: { type: String, default: '16:9' },
  breaking: { type: Boolean, default: false },
  agentBusy: { type: Boolean, default: false },
  fieldSave: { type: Function, default: () => ({ status: 'idle', at: 0 }) },
  narrationEnabled: { type: Boolean, default: false },
  episodeTiming: { type: String, default: 'sentence' },
  episodeMixMode: { type: String, default: 'replace' },
  episodeFitDefault: { type: Object, default: null },
  episodeNormalize: { type: Boolean, default: true },
  narrationBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
  narrationVoiceBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
})
const emit = defineEmits([
  'refresh', 'preview', 'goto-assets', 'goto-design', 'open-asset', 'update-field', 'field-dirty',
])
const { t } = useI18n()

const COMBO_GLYPH = { A: '▣', B: '▶', C: '▣▶', D: '▶▣' }

// deeplink（#86）：选中镜 / 片段页签 / 弹窗；恢复只还原界面，不自动切组合、不自动起预演渲染
const link = useDeeplink('shotProduction', DEEPLINK_KEYS.shotProduction)
const urlShotRaw = querySingle(link.initial('shot'))
const urlShotId = Number(urlShotRaw || 0) || 0
const urlSegment = queryEnum(link.initial('seg'), ['layer', 'gen'])
// spdlg 取值：combo | rehearse | scope:prompts | scope:keyframes（范围清单也要能恢复，不豁免瞬时弹窗）
const urlDialog = queryEnum(link.initial('spdlg'), ['combo', 'rehearse', 'scope:prompts', 'scope:keyframes'])
// shot=abc / shot=0 也算「显式给了但无效」：照样提示并回到默认镜
let shotRestored = urlShotRaw === null
let dialogRestored = !urlDialog
let deeplinkShotWins = false

const selectedId = ref(0)
const activeSegment = ref('layer')
const comboOpen = ref(false)
const rehearseOpen = ref(false)
// GET /layer-segments/storyboards/:id 的整份返回（选中镜）
const state = ref(null)
const stateLoading = ref(false)

function pad(n) { return String(n ?? 0).padStart(2, '0') }

/** 段组合 → 本镜有哪些段 */
function segmentsOf(combo) {
  return { layer: combo === 'A' || combo === 'C' || combo === 'D', gen: combo === 'B' || combo === 'C' || combo === 'D' }
}
function designUnlocked(sb) {
  return (sb?.design_card_status ?? sb?.designCardStatus ?? 'blank') === 'confirmed'
}
function budgetOf(sb) {
  return sb?.design_card?.budget || sb?.designCard?.budget || {}
}

/** Every row reads the episode summary, never the selected editor's transient response. */
function layerStatusOf(sb) {
  if (!segmentsOf(sb?.combo).layer) return ''
  const segment = sb?.layer_segment ?? sb?.layerSegment
  return segment && segment.exists !== false ? segmentStatus(segment) : 'unknown'
}
function segmentStatus(segment) {
  if (segment.status === 'failed') return 'failed'
  if (segment.status === 'rendering') return 'rendering'
  if (!segment.render_path) return 'draft'
  return segment.fresh ? 'ready' : 'stale'
}
function genStatusOf(sb) {
  if (!segmentsOf(sb?.combo).gen) return ''
  const k = sb?.keyframes || {}
  if (k.ready) return 'ready'
  if (k.stale_reason || k.staleReason) return 'stale'
  return 'draft'
}
function lockedSlotOf(sb) {
  const locked = sb?.keyframes?.locked
  return locked && locked.slot ? locked : null
}

const shots = computed(() => props.storyboards.map((sb, index) => {
  const combo = sb?.combo ?? null
  return {
    sb,
    index,
    no: pad(index + 1),
    noNumber: index + 1,
    title: sb.title || sb.description || t('episode.production.untitled'),
    combo,
    glyph: combo ? COMBO_GLYPH[combo] : '',
    unlocked: designUnlocked(sb),
    layerStatus: layerStatusOf(sb),
    genStatus: genStatusOf(sb),
    // 一致性警告数：已加载的 issues[] 优先，其次分镜行摘要
    issueCount: selectedId.value === sb?.id && state.value ? (state.value.issues || []).length : Number(sb?.production_issue_count || 0),
    issueTitle: (selectedId.value === sb?.id && state.value)
      ? (state.value.issues || []).map(issue => issue.message).join(t('common.listJoin'))
      : (sb?.production_issue_summary || ''),
  }
}))

const selected = computed(() => shots.value.find(shot => shot.sb.id === selectedId.value) || null)

let stateRequest = 0
async function loadState(sbId) {
  if (!sbId) return
  const request = ++stateRequest
  state.value = null
  stateLoading.value = true
  try {
    const data = await layerSegmentAPI.get(sbId)
    if (selectedId.value === sbId && request === stateRequest) {
      state.value = data
      syncActiveSegment()
    }
  } catch (e) {
    if (selectedId.value === sbId && request === stateRequest) {
      toastServerMessage(e, { fallback: 'episode.production.loadFailed' })
    }
  } finally {
    if (request === stateRequest) stateLoading.value = false
  }
}

/** 组合变了或当前段不存在时，把选中段拉回本镜真实存在的那个 */
function syncActiveSegment() {
  const combo = selected.value?.combo
  const segments = segmentsOf(combo)
  if (activeSegment.value === 'layer' && !segments.layer) activeSegment.value = 'gen'
  if (activeSegment.value === 'gen' && !segments.gen) activeSegment.value = 'layer'
}

function selectShot(shot) {
  if (!shot.unlocked) {
    toast.warning(t('episode.production.lockedHint', { n: shot.no }))
    return
  }
  // 同一镜也重拉一次：列表刷新后设计卡/关键帧可能变了，段状态要跟上
  selectedId.value = shot.sb.id
  activeSegment.value = segmentsOf(shot.combo).layer ? 'layer' : 'gen'
  state.value = null
  void loadState(shot.sb.id)
}

/** 图层段编辑器的保存/草稿/渲染结果：保存返回 GET 同形，渲染只返回 segment/junction，缺 issues */
function onLayerChanged(sbId, data) {
  if (selectedId.value !== sbId) { emit('refresh'); return }
  if (data && !Array.isArray(data.issues)) {
    // 渲染结果：先合进本地状态（列表状态立刻更新），再重拉一次拿齐 issues
    state.value = { ...(state.value || {}), ...data }
    if (selectedId.value) void loadState(selectedId.value)
  } else if (data) {
    state.value = data
  }
  emit('refresh')
}

function onGeneratedChanged() {
  emit('refresh')
  if (selectedId.value) void loadState(selectedId.value)
}

function onComboSwitched() {
  emit('refresh')
  if (selectedId.value) {
    syncActiveSegment()
    void loadState(selectedId.value)
  }
}

function openJunction() {
  if (!selected.value) return
  const src = state.value?.junction?.path || state.value?.segment?.junction_path
  if (src) emit('preview', src, `${t('episode.segment.junctionShort')} · #${selected.value.no}`)
  else toast.info(t('episode.production.junctionMissing'))
}

// ===== 批量AI提示词：先拉范围清单 =====
const promptBatch = ref({ running: false, total: 0, completed: 0 })

function openScopeDialog(kind, payload) {
  scopeDialog.value = { open: true, kind, loading: true, included: [], excluded: [], error: '', payload }
}

const scopeDialog = ref({ open: false, kind: 'prompts', loading: false, included: [], excluded: [], error: '', payload: null })

async function openPromptScope() {
  if (promptBatch.value.running) { toast.info(t('episode.production.promptRunning')); return }
  openScopeDialog('prompts')
  try {
    const data = await episodeAPI.keyframePromptsScope(props.episodeId)
    scopeDialog.value = {
      ...scopeDialog.value,
      loading: false,
      included: data?.included || [],
      excluded: data?.excluded || [],
    }
  } catch (e) {
    scopeDialog.value = { ...scopeDialog.value, loading: false, error: e?.message || String(e) }
  }
}

// ===== 批量出关键帧：先问预览，把 skipped 按 reason 归入「排除」 =====
const batch = ref(null)
const batchRunning = computed(() => batch.value?.status === 'running')
const batchItems = computed(() => batch.value?.items || [])
const batchDone = computed(() => batchItems.value.filter(item => !isActiveBatchItemState(item.state)).length)
const batchTotal = computed(() => batchItems.value.length)

async function openBatchScope() {
  if (batchRunning.value) { toast.info(t('episode.production.batchRunning')); return }
  openScopeDialog('keyframes')
  try {
    const res = await episodeAPI.keyframeBatchPreview(props.episodeId, {
      model: props.imageModel || undefined,
      config_id: props.imageConfigId || undefined,
    })
    const items = Array.isArray(res?.items) ? res.items : []
    // 组合 A / 设计卡未确认的镜由后端的范围快照判定，原因写组合口径而不是槽位口径
    const scopeExcluded = new Map()
    for (const row of (res?.scope?.excluded || [])) scopeExcluded.set(Number(row.storyboard_id), row)
    // 提交按「分镜 × 槽位」逐项（服务端默认勾选），展示按「镜」去重
    const includedSlots = []
    const excludedSlots = []
    for (const item of items) {
      const no = Number(item.storyboard_number) || 0
      const byScope = scopeExcluded.get(Number(item.storyboard_id))
      if (byScope) {
        excludedSlots.push({
          storyboard_id: item.storyboard_id,
          storyboard_number: no,
          slot: item.slot,
          reason: byScope.reason,
        })
        continue
      }
      if (item.status === 'skipped' || item.status === 'blocked') {
        excludedSlots.push({
          storyboard_id: item.storyboard_id,
          storyboard_number: no,
          slot: item.slot,
          reason: item.reason || blockReasonText(item),
        })
        continue
      }
      includedSlots.push({ storyboard_id: item.storyboard_id, storyboard_number: no, slot: item.slot, status: item.status })
    }
    // 预览里没有槽位行、但范围快照判定排除的镜（例如组合 A 完全不进关键帧预览）
    const seen = new Set(items.map(item => Number(item.storyboard_id)))
    for (const [id, row] of scopeExcluded) {
      if (seen.has(id)) continue
      excludedSlots.push({ storyboard_id: id, storyboard_number: Number(row.storyboard_number) || 0, slot: '', reason: row.reason })
    }
    scopeDialog.value = {
      ...scopeDialog.value,
      loading: false,
      included: uniqueByShot(includedSlots, true),
      excluded: uniqueByShot(excludedSlots, false),
      payload: { items: items.filter(item => !scopeExcluded.has(Number(item.storyboard_id))) },
    }
    if (!includedSlots.length) scopeDialog.value.error = t('episode.production.scopeNothing')
  } catch (e) {
    scopeDialog.value = { ...scopeDialog.value, loading: false, error: e?.message || String(e) }
  }
}

/**
 * 展示用的「镜」清单：同一镜多个槽位合成一条（带 slots）。
 * 排除项同理，同镜多槽位的原因合并在一起。
 */
function uniqueByShot(rows, includeSlots) {
  const map = new Map()
  for (const row of rows) {
    const existing = map.get(row.storyboard_id)
    if (!existing) {
      map.set(row.storyboard_id, {
        storyboard_id: row.storyboard_id,
        storyboard_number: row.storyboard_number,
        slots: includeSlots ? [row.slot] : [],
        reason: includeSlots ? '' : row.reason,
      })
      continue
    }
    if (includeSlots) existing.slots.push(row.slot)
    else if (row.reason && !existing.reason.includes(row.reason)) {
      existing.reason = existing.reason ? `${existing.reason}${t('common.listJoin')}${row.reason}` : row.reason
    }
  }
  return [...map.values()]
}

function slotLabel(slot) {
  if (slot === 'first') return t('episode.kf.slotFirst')
  if (slot === 'mid') return t('episode.kf.slotMid')
  if (slot === 'last') return t('episode.kf.slotLast')
  return String(slot || '')
}

function blockReasonText(item) {
  const issues = Array.isArray(item?.issues) ? item.issues : []
  return issues.map(issue => issue.message).join(t('common.listJoin')) || t('episode.production.scopeNoReason')
}

async function confirmScope() {
  const dialog = scopeDialog.value
  if (!dialog.included.length) return
  if (dialog.kind === 'prompts') {
    dialog.open = false
    await runPromptBatch(dialog.included.map(item => item.storyboard_id))
  } else {
    dialog.open = false
    await runKeyframeBatch(dialog.payload?.items || [])
  }
}

async function runPromptBatch(storyboardIds) {
  try {
    const res = await episodeAPI.generateKeyframePrompts(props.episodeId, {
      storyboard_ids: storyboardIds,
      model: props.chatModel || undefined,
      config_id: props.chatConfigId || undefined,
    })
    if (!res?.total) {
      if (res?.already_running) promptBatch.value = { running: true, total: 0, completed: 0 }
      else toast.info(t('episode.production.promptNothing'))
    } else {
      promptBatch.value = { running: true, total: res.total, completed: 0 }
      toast.info(t('episode.production.promptStarted', { n: res.total }))
    }
    pollPromptBatch()
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.production.promptFailed' })
  }
}

function pollPromptBatch(attempts = 240) {
  const tick = async (left) => {
    try {
      const st = await episodeAPI.keyframePromptsStatus(props.episodeId)
      if (st && st.status !== 'running') {
        promptBatch.value = { running: false, total: 0, completed: 0 }
        emit('refresh')
        if (st.status === 'done') toast.success(t('episode.production.promptDone'))
        else toastError(st.error, { fallback: 'episode.production.promptFailed' })
        return
      }
      if (st) {
        const prev = promptBatch.value.completed
        promptBatch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
        if ((st.completed || 0) !== prev) emit('refresh')
      }
    } catch { /* 静默：轮询失败继续重试 */ }
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else promptBatch.value = { running: false, total: 0, completed: 0 }
  }
  setTimeout(() => tick(attempts), 2500)
}

async function runKeyframeBatch(items) {
  // 只提交服务端默认勾选（未变化/被跳过/被拦截的不提交）
  const submit = items
    .filter(item => Boolean(item.checked) && item.status !== 'blocked' && item.status !== 'skipped')
    .map(item => ({ storyboard_id: item.storyboard_id, slot: item.slot }))
  if (!submit.length) { toast.info(t('episode.production.scopeNothing')); return }
  try {
    batch.value = await episodeAPI.startKeyframeBatch(props.episodeId, {
      items: submit,
      model: props.imageModel || undefined,
      config_id: props.imageConfigId || undefined,
    })
    toast.success(t('episode.production.batchStarted', { n: submit.length }))
    startBatchPolling()
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.production.batchFailed' })
  }
}

let batchTimer = null
let batchSettledCount = -1
async function loadBatch() {
  let current = null
  try { current = await episodeAPI.keyframeBatch(props.episodeId) } catch { return }
  batch.value = current && current.status ? current : null
  const settled = batchItems.value.filter(item => !isActiveBatchItemState(item.state)).length
  const wasPolling = Boolean(batchTimer)
  if (batchSettledCount >= 0 && settled !== batchSettledCount) emit('refresh')
  batchSettledCount = settled
  if (current?.status === 'running') startBatchPolling()
  else {
    stopBatchPolling()
    if (wasPolling) {
      emit('refresh')
      toast.success(t('episode.production.batchDone'))
    }
  }
}
function startBatchPolling() {
  if (!batchTimer) batchTimer = setInterval(loadBatch, 3500)
}
function stopBatchPolling() {
  if (batchTimer) { clearInterval(batchTimer); batchTimer = null }
}

// ===== 选中镜的同步 =====
/** 片段页签：URL 给的值只在本镜确实有该段时生效，否则按组合取默认段 */
function pickSegment(combo, preferred) {
  const segments = segmentsOf(combo)
  if (preferred && segments[preferred]) return preferred
  return segments.layer ? 'layer' : 'gen'
}
let segPending = urlSegment
function consumeSegment() {
  const seg = segPending
  segPending = null
  return seg
}

/**
 * 弹窗壳体恢复：combo / rehearse 跟着已恢复的分镜打开；
 * 范围清单（scope:*）重新拉一次只读预览（GET …/keyframe-prompts/scope、POST …/keyframe-batch/preview
 * 都只 select/计算、不落库、不入队），清单仍要人工点「确认」才提交，恢复过程零提交。
 */
function restoreDialog() {
  if (dialogRestored) return
  dialogRestored = true
  void nextTick(() => {
    if (urlDialog === 'scope:prompts') { void openPromptScope(); return }
    if (urlDialog === 'scope:keyframes') { void openKeyframeScope(); return }
    if (!selected.value) return
    if (urlDialog === 'combo') comboOpen.value = true
    else if (urlDialog === 'rehearse') rehearseOpen.value = true
  })
}

watch(() => props.storyboards, () => {
  // deeplink：先按 URL 的 shot 恢复一次（失败则留在默认镜并提示）
  if (!shotRestored && shots.value.length) {
    shotRestored = true
    const hit = shots.value.find(shot => shot.sb.id === urlShotId)
    // 父键没恢复成功就不要把「镜级」子层（页签/组合/预演弹窗）套到另一镜上；
    // 范围清单是集级的，与 shot 无关，仍然照常恢复
    if (!hit || !hit.unlocked) {
      segPending = null
      if (urlDialog === 'combo' || urlDialog === 'rehearse') dialogRestored = true
    }
    if (!hit) toast.warning(t('deeplink.missing'))
    else if (!hit.unlocked) toast.warning(t('deeplink.locked'))
    else {
      selectedId.value = hit.sb.id
      deeplinkShotWins = true
      activeSegment.value = pickSegment(hit.combo, consumeSegment())
      state.value = null
      void loadState(hit.sb.id)
      restoreDialog()
      void loadBatch()
      return
    }
  }
  if (!selectedId.value || !shots.value.some(shot => shot.sb.id === selectedId.value)) {
    const first = shots.value.find(shot => shot.unlocked) || shots.value[0]
    if (first) {
      selectedId.value = first.sb.id
      activeSegment.value = pickSegment(first.combo, consumeSegment())
      void loadState(first.sb.id)
    }
  } else {
    syncActiveSegment()
    void loadState(selectedId.value)
  }
  if (shots.value.length) restoreDialog()
  void loadBatch()
}, { immediate: true })

// deeplink：本层键统一在这里写出（选中镜 / 片段页签 / 弹窗身份）
watch([selectedId, activeSegment, comboOpen, rehearseOpen, () => scopeDialog.value.open, () => scopeDialog.value.kind], () => {
  const dialog = scopeDialog.value.open
    ? `scope:${scopeDialog.value.kind === 'keyframes' ? 'keyframes' : 'prompts'}`
    : (selectedId.value && comboOpen.value ? 'combo' : (selectedId.value && rehearseOpen.value ? 'rehearse' : ''))
  link.set({
    shot: selectedId.value || '',
    seg: selectedId.value ? activeSegment.value : '',
    spdlg: dialog,
  })
}, { immediate: true })

watch(() => props.focusStoryboardId, (id) => {
  // 显式 deeplink 的 shot 优先级最高：首轮不让上次跳转残留的聚焦覆盖它
  if (deeplinkShotWins) { deeplinkShotWins = false; return }
  if (!id) return
  const shot = shots.value.find(item => item.sb.id === id)
  if (shot && shot.unlocked && shot.sb.id !== selectedId.value) {
    selectedId.value = shot.sb.id
    activeSegment.value = segmentsOf(shot.combo).layer ? 'layer' : 'gen'
    void loadState(shot.sb.id)
  }
}, { immediate: true })
</script>

<style scoped>
.sp-root { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.sp-bar { display: flex; align-items: center; gap: 8px; }
.sp-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 8px; }
.sp-list { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
.sp-shot { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; cursor: pointer; background: var(--surface-card); }
.sp-shot.on { border-color: var(--accent); }
.sp-shot.locked { opacity: 0.55; cursor: not-allowed; }
.sp-shot-line { display: flex; align-items: center; gap: 6px; }
.sp-shot-no { font-size: 11px; color: var(--text-3); }
.sp-shot-title { font-size: 12.5px; min-width: 0; }
.sp-lock { margin-left: auto; color: var(--text-3); display: inline-flex; }
.sp-shot-meta { display: flex; align-items: center; gap: 4px; margin-top: 4px; flex-wrap: wrap; font-size: 11px; }
.sp-seg-state { font-size: 11px; color: var(--text-3); }
.sp-seg-state.is-ready { color: #2e8b57; }
.sp-seg-state.is-stale { color: #8a6508; }
.sp-seg-state.is-failed { color: #c0472e; }
.sp-warn { font-size: 11px; color: #8a6508; }
.sp-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.sp-placeholder { flex: 1; display: grid; place-items: center; font-size: 12.5px; color: var(--text-3); }
.sp-scope-dialog { max-width: 680px; width: 92vw; }
.sp-scope-body { display: flex; flex-direction: column; gap: 8px; }
.sp-scope-summary { font-size: 13px; }
.sp-scope-error { margin: 0; font-size: 12px; color: #c0472e; }
.sp-scope-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 8px; }
.sp-scope-col { border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.sp-scope-title { margin: 0 0 6px; font-size: 12px; color: var(--text-2); }
.sp-scope-list { display: flex; flex-wrap: wrap; gap: 4px; }
.sp-scope-list-col { flex-direction: column; }
.sp-scope-item { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
.sp-scope-reason { color: var(--text-3); font-size: 11px; }
.sp-scope-hint { margin: 0; font-size: 11px; color: var(--text-3); }
</style>
