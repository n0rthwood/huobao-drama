<template>
  <div class="prod-content si-step">
    <div class="si-bar">
      <span class="dim" style="font-size:12px">{{ t('episode.prod.expression') }}</span>
      <span class="tag mono">{{ t('episode.intent.confirmedCount', { done: confirmedCount, total: storyboards.length }) }}</span>
      <span v-if="unresolvedCount" class="tag mono si-tag-warn">{{ t('episode.intent.unresolvedCount', { n: unresolvedCount }) }}</span>
      <div class="ml-auto flex gap-1">
        <button class="btn btn-sm" :disabled="batch.running || !storyboards.length" @click="generateAll">
          <Loader2 v-if="batch.running" :size="11" class="animate-spin" />
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          {{ t('episode.intent.generateAll') }}
        </button>
      </div>
    </div>

    <div v-if="batch.running" class="si-batch-line">
      <Loader2 :size="12" class="animate-spin" />
      <span>{{ t('episode.intent.batchProgress', { done: batch.completed, total: batch.total }) }}</span>
    </div>

    <div v-if="!storyboards.length" class="step-empty" style="flex:1">
      <div class="empty-visual">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>
      </div>
      <div class="empty-title">{{ t('episode.intent.emptyTitle') }}</div>
      <div class="empty-desc">{{ t('episode.intent.emptyDesc') }}</div>
    </div>

    <div v-else class="si-list">
      <section v-for="(sb, index) in storyboards" :key="sb.id" class="si-card">
        <header class="si-card-head">
          <span class="si-no">{{ t('episode.intent.shotNo', { n: String(index + 1).padStart(2, '0') }) }}</span>
          <span v-if="intentOf(sb)" class="si-device-badge">{{ deviceLabel(intentOf(sb).device) }}</span>
          <span v-if="intentOf(sb)" :class="['si-state', reviewedOf(sb) ? 'is-ok' : 'is-todo']">
            {{ reviewedOf(sb) ? t('episode.intent.confirmed') : t('episode.intent.unconfirmed') }}
          </span>
          <span v-else class="si-state is-none">{{ t('episode.intent.noIntent') }}</span>
          <FieldSaveStatus v-bind="saveStateOf(sb)" />
          <span class="ml-auto" />
          <button
            class="btn btn-sm"
            :disabled="batch.running || regenerating.includes(sb.id)"
            @click="generateOne(sb)"
          >
            <Loader2 v-if="regenerating.includes(sb.id)" :size="11" class="animate-spin" />
            {{ regenerating.includes(sb.id) ? t('episode.intent.generating') : t('episode.intent.generateOne') }}
          </button>
          <button
            class="btn btn-sm"
            :class="{ 'is-on': reviewedOf(sb) }"
            :disabled="confirmDisabled(sb)"
            :title="confirmBlockReason(sb) || undefined"
            @click="toggleConfirm(sb)"
          >{{ reviewedOf(sb) ? t('episode.intent.confirmed') : t('episode.intent.confirm') }}</button>
        </header>

        <div class="si-card-body">
          <div class="si-col-read">
            <div class="si-read-block">
              <div class="si-label">{{ t('episode.intent.narration') }}</div>
              <p class="si-read-text">{{ narrationOf(sb) || t('episode.intent.narrationEmpty') }}</p>
            </div>
            <div class="si-read-block">
              <div class="si-label">{{ t('episode.intent.description') }}</div>
              <p class="si-read-text si-clamp" :title="sb.description || ''">{{ sb.description || t('episode.intent.descriptionEmpty') }}</p>
            </div>
          </div>

          <div class="si-col-edit">
            <div class="si-row">
              <label class="si-field si-field-grow">
                <span class="si-label">{{ t('episode.intent.infoPoint') }}</span>
                <input
                  class="input"
                  type="text"
                  :value="intentOf(sb)?.info_point || ''"
                  :disabled="!intentOf(sb)"
                  :placeholder="intentOf(sb) ? t('episode.intent.infoPointPlaceholder') : t('episode.intent.pickDeviceFirst')"
                  @input="markDirty(sb, 'info_point', $event.target.value)"
                  @blur="saveText(sb, 'info_point', $event.target.value)"
                />
              </label>
              <label class="si-field">
                <span class="si-label">{{ t('episode.intent.device') }}</span>
                <select class="input si-select" :value="intentOf(sb)?.device || ''" @change="onDeviceChange(sb, $event.target.value)">
                  <option v-if="!intentOf(sb)" value="">{{ t('episode.intent.devicePick') }}</option>
                  <option v-for="d in ctx.devices" :key="d" :value="d">{{ deviceLabel(d) }}</option>
                </select>
              </label>
              <label class="si-field">
                <span class="si-label">{{ t('episode.intent.deterministic') }}</span>
                <select
                  v-if="intentOf(sb) && allowedClip(intentOf(sb).device).length > 1"
                  class="input si-select"
                  :value="intentOf(sb).deterministic"
                  @change="saveIntent(sb, { deterministic: $event.target.value })"
                >
                  <option v-for="p in allowedClip(intentOf(sb).device)" :key="p" :value="p">{{ clipLabel(p) }}</option>
                </select>
                <span v-else-if="intentOf(sb)" class="si-fixed" :title="t('episode.intent.deterministicFixed')">
                  {{ clipLabel(intentOf(sb).deterministic) }}
                </span>
                <span v-else class="si-fixed">—</span>
              </label>
            </div>

            <div v-if="intentOf(sb)" class="si-block">
              <div class="si-label">{{ t('episode.intent.mustShow') }}</div>
              <div v-if="intentOf(sb).must_show.length" class="si-chips">
                <span
                  v-for="(item, i) in intentOf(sb).must_show"
                  :key="`ms-${i}`"
                  :class="['si-chip', { 'is-unresolved': item.unresolved }]"
                  :title="item.unresolved ? item.unresolved_reason : mustShowTitle(item)"
                >
                  <span class="si-chip-kind">{{ kindLabel(item.kind) }}</span>
                  <span class="si-chip-text">{{ mustShowText(item) }}</span>
                  <button type="button" class="si-chip-x" :aria-label="t('episode.intent.remove')" @click="removeMustShow(sb, i)">×</button>
                </span>
              </div>
              <div v-else class="si-empty-line">{{ t('episode.intent.mustShowEmpty') }}</div>
              <div class="si-row si-picker">
                <select class="input si-select" :value="msDraft(sb).kind" @change="setMsDraft(sb, { kind: $event.target.value, semantic: '' })">
                  <option v-for="k in ctx.must_show_kinds" :key="k" :value="k">{{ kindLabel(k) }}</option>
                </select>
                <select class="input si-select" :value="msDraft(sb).assetKey" @change="setMsDraft(sb, { assetKey: $event.target.value, semantic: '' })">
                  <option value="">{{ t('episode.intent.pickAsset') }}</option>
                  <option v-for="a in assetOptions(msDraft(sb).kind)" :key="assetKey(a)" :value="assetKey(a)">
                    {{ assetKindLabel(a.kind) }} · {{ a.name }}
                  </option>
                </select>
                <select
                  v-if="isSemanticKind(msDraft(sb).kind)"
                  class="input si-select"
                  :value="msDraft(sb).semantic"
                  @change="setMsDraft(sb, { semantic: $event.target.value })"
                >
                  <option value="">{{ t('episode.intent.pickSemantic') }}</option>
                  <optgroup v-for="g in semanticGroups(msDraft(sb).assetKey)" :key="g.group" :label="kindLabel(g.group)">
                    <option v-for="s in g.items" :key="s.id" :value="s.id">{{ s.name }}</option>
                  </optgroup>
                </select>
                <template v-if="msDraft(sb).kind === 'route'">
                  <input class="input si-small" type="text" :value="msDraft(sb).from" :placeholder="t('episode.intent.routeFrom')" @input="setMsDraft(sb, { from: $event.target.value })" />
                  <input class="input si-small" type="text" :value="msDraft(sb).to" :placeholder="t('episode.intent.routeTo')" @input="setMsDraft(sb, { to: $event.target.value })" />
                </template>
                <button type="button" class="btn btn-sm" :disabled="!msDraftValid(sb)" @click="addMustShow(sb)">{{ t('episode.intent.addMustShow') }}</button>
              </div>
            </div>

            <div v-if="intentOf(sb)" class="si-block">
              <div class="si-label">
                {{ t('episode.intent.overlayPlan') }}
                <span class="dim si-hint">{{ t('episode.intent.overlayGeometryHint') }}</span>
              </div>
              <ul v-if="intentOf(sb).overlay_plan.length" class="si-overlay-list">
                <li
                  v-for="(item, i) in intentOf(sb).overlay_plan"
                  :key="`ov-${i}`"
                  :class="['si-overlay-row', { 'is-unresolved': item.unresolved }]"
                  :title="item.unresolved ? item.unresolved_reason : undefined"
                >
                  <span class="si-overlay-layer">{{ layerLabel(item.layer) }}</span>
                  <span class="si-overlay-anchor">{{ overlayAnchorText(item) }}</span>
                  <span v-if="item.reveal_at !== undefined && item.reveal_at !== null" class="si-overlay-time">
                    {{ t('episode.intent.revealAtValue', { n: item.reveal_at }) }}
                  </span>
                  <button type="button" class="si-chip-x ml-auto" :aria-label="t('episode.intent.remove')" @click="removeOverlay(sb, i)">×</button>
                </li>
              </ul>
              <div v-else class="si-empty-line">{{ t('episode.intent.overlayEmpty') }}</div>
              <div class="si-row si-picker">
                <select class="input si-select" :value="ovDraft(sb).layer" @change="setOvDraft(sb, { layer: $event.target.value })">
                  <option v-for="l in ctx.overlay_layer_types" :key="l" :value="l">{{ layerLabel(l) }}</option>
                </select>
                <select class="input si-select" :value="ovDraft(sb).assetKey" @change="setOvDraft(sb, { assetKey: $event.target.value, semantic: '' })">
                  <option value="">{{ t('episode.intent.pickAnchor') }}</option>
                  <option v-for="a in ctx.assets" :key="assetKey(a)" :value="assetKey(a)">
                    {{ assetKindLabel(a.kind) }} · {{ a.name }}
                  </option>
                </select>
                <select
                  v-if="semanticGroups(ovDraft(sb).assetKey).length"
                  class="input si-select"
                  :value="ovDraft(sb).semantic"
                  @change="setOvDraft(sb, { semantic: $event.target.value })"
                >
                  <option value="">{{ t('episode.intent.anchorWholeAsset') }}</option>
                  <optgroup v-for="g in semanticGroups(ovDraft(sb).assetKey)" :key="g.group" :label="kindLabel(g.group)">
                    <option v-for="s in g.items" :key="s.id" :value="s.id">{{ s.name }}</option>
                  </optgroup>
                </select>
                <label class="si-inline">
                  <span class="dim si-hint">{{ t('episode.intent.revealAt') }}</span>
                  <input class="input si-time" type="number" min="0" step="0.5" :value="ovDraft(sb).revealAt" @input="setOvDraft(sb, { revealAt: $event.target.value })" />
                  <span class="dim si-hint">{{ t('episode.intent.revealAtUnit') }}</span>
                </label>
                <button type="button" class="btn btn-sm" :disabled="!ovDraftValid(sb)" @click="addOverlay(sb)">{{ t('episode.intent.addOverlay') }}</button>
              </div>
            </div>

            <label v-if="intentOf(sb)" class="si-field">
              <span class="si-label">{{ t('episode.intent.rationale') }}</span>
              <textarea
                class="textarea"
                rows="2"
                :value="intentOf(sb).rationale || ''"
                :placeholder="t('episode.intent.rationalePlaceholder')"
                @input="markDirty(sb, 'rationale', $event.target.value)"
                @blur="saveText(sb, 'rationale', $event.target.value)"
              />
            </label>

            <p v-if="!intentOf(sb)" class="si-empty-line">{{ t('episode.intent.noIntentHint') }}</p>

            <ul v-if="issuesOf(sb).length" class="si-issues">
              <li
                v-for="(issue, i) in issuesOf(sb)"
                :key="`${issue.code}-${i}`"
                :class="['si-issue', issue.severity === 'block' ? 'is-block' : 'is-warn']"
              >
                <span class="si-issue-dot" />
                <span>{{ issue.message }}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
/**
 * 表达设计页（Issue #49，纪录片项目）— 逐镜写明「这一镜要让观众理解什么、用什么手段表现、
 * 必须让观众看到哪些要素」，并与解说词两栏对照检查。
 *
 * 保存契约：后端**整份替换** storyboards.intent，所以任何一次改动都把完整 intent 文档
 * PUT 回去；界面随后一律改用响应里的 intent / intent_issues / intent_reviewed，
 * 不在前端自行推断解析结果（unresolved 是读时重算的结论）。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { episodeAPI, storyboardAPI } from '~/composables/useApi'
import { toastError, toastServerMessage } from '~/composables/useToast'
import FieldSaveStatus from '~/components/FieldSaveStatus.vue'

const { t } = useI18n()

const props = defineProps({
  episodeId: { type: Number, default: 0 },
  // 本集分镜（按分镜号升序），字段与 /episodes/:id/storyboards 返回一致
  storyboards: { type: Array, default: () => [] },
  // 顶栏文本模型覆盖，透传给 AI 重算
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
})
const emit = defineEmits(['refresh'])

const EMPTY_CTX = {
  assets: [],
  devices: [],
  device_default_clip: {},
  device_allowed_clip: {},
  must_show_kinds: [],
  overlay_layer_types: [],
}
const ctx = ref({ ...EMPTY_CTX })
// 几何类 must_show 指向语义标注条目，其余指向资产本身
const SEMANTIC_KINDS = ['region', 'line', 'point', 'label']

async function loadContext() {
  if (!props.episodeId) return
  try {
    const data = await episodeAPI.intentContext(props.episodeId)
    ctx.value = { ...EMPTY_CTX, ...(data || {}) }
  } catch (e) {
    toastError(e, { fallback: 'episode.intent.contextFailed' })
  }
}

// ===== 服务端最新结果的本地覆盖：PUT 返回即生效，父级刷新后交还给 props =====
const overrides = ref({})
watch(() => props.storyboards, () => { overrides.value = {} })

function intentOf(sb) {
  const o = overrides.value[sb?.id]
  const intent = o ? o.intent : (sb?.intent ?? null)
  return intent || null
}
function issuesOf(sb) {
  const o = overrides.value[sb?.id]
  const list = o ? o.intent_issues : (sb?.intent_issues ?? sb?.intentIssues)
  return Array.isArray(list) ? list : []
}
function reviewedOf(sb) {
  const o = overrides.value[sb?.id]
  return (o ? o.intent_reviewed : (sb?.intent_reviewed ?? sb?.intentReviewed)) === true
}
function narrationOf(sb) {
  return (sb?.narration_text ?? sb?.narrationText ?? '').trim()
}
function unresolvedOf(sb) {
  const intent = intentOf(sb)
  if (!intent) return 0
  return intent.must_show.filter(i => i.unresolved).length + intent.overlay_plan.filter(i => i.unresolved).length
}

const confirmedCount = computed(() => props.storyboards.filter(sb => reviewedOf(sb)).length)
const unresolvedCount = computed(() => props.storyboards.reduce((sum, sb) => sum + unresolvedOf(sb), 0))

// ===== 标签 =====
function deviceLabel(device) { return device ? t(`episode.intent.deviceLabel.${device}`) : '' }
function clipLabel(clip) { return clip ? t(`episode.intent.clipLabel.${clip}`) : '' }
function kindLabel(kind) { return kind ? t(`episode.intent.kindLabel.${kind}`) : '' }
function layerLabel(layer) { return layer ? t(`episode.intent.layerLabel.${layer}`) : '' }
function assetKindLabel(kind) { return kind ? t(`episode.intent.assetKind.${kind}`) : '' }

function allowedClip(device) {
  const list = ctx.value.device_allowed_clip?.[device]
  return Array.isArray(list) && list.length ? list : (device ? [defaultClip(device)] : [])
}
function defaultClip(device) {
  return ctx.value.device_default_clip?.[device] || 'none'
}
function isSemanticKind(kind) { return SEMANTIC_KINDS.includes(kind) }

function assetKey(asset) { return `${asset.kind}:${asset.id}` }
function assetByKey(key) {
  if (!key) return null
  const [kind, id] = String(key).split(':')
  return ctx.value.assets.find(a => a.kind === kind && String(a.id) === id) || null
}
/** 候选资产：几何类只列有语义标注的素材，肖像只列角色，其余列全部 */
function assetOptions(kind) {
  const assets = ctx.value.assets || []
  if (isSemanticKind(kind)) return assets.filter(a => (a.semantics || []).length)
  if (kind === 'portrait') return assets.filter(a => a.kind === 'character')
  if (kind === 'route') return assets.filter(a => (a.semantics || []).length)
  return assets
}
function semanticGroups(key) {
  const asset = assetByKey(key)
  const items = asset?.semantics || []
  const groups = []
  for (const group of ['region', 'line', 'point', 'label']) {
    const list = items.filter(s => s.group === group)
    if (list.length) groups.push({ group, items: list })
  }
  return groups
}
function semanticNameOf(key, semanticId) {
  const asset = assetByKey(key)
  return (asset?.semantics || []).find(s => s.id === semanticId)?.name || semanticId
}
function assetNameOf(item) {
  const asset = item?.asset_id
    ? ctx.value.assets.find(a => a.id === item.asset_id && (!item.asset_kind || a.kind === item.asset_kind))
    : null
  return asset?.name || ''
}
function mustShowText(item) {
  const parts = []
  const name = assetNameOf(item)
  if (name) parts.push(name)
  const semantic = item.semantic_name || item.semantic
  if (semantic) parts.push(semantic)
  if (item.from || item.to) parts.push(`${item.from || '?'} → ${item.to || '?'}`)
  if (!parts.length && item.note) parts.push(item.note)
  return parts.join(' · ') || t('episode.intent.unnamedItem')
}
function mustShowTitle(item) {
  return `${kindLabel(item.kind)} · ${mustShowText(item)}`
}
function overlayAnchorText(item) {
  const anchor = item.anchor || {}
  const name = assetNameOf({ asset_id: anchor.asset_id, asset_kind: anchor.asset_kind })
  const semantic = anchor.semantic || ''
  const parts = [name, semantic].filter(Boolean)
  if (!parts.length && item.text) return item.text
  return parts.join(' · ') || t('episode.intent.anchorNone')
}

// ===== 字段保存状态：整份 intent 当一个字段（后端 field_saved_at.intent） =====
const saveStates = ref({})
function saveStateOf(sb) {
  const state = saveStates.value[sb?.id]
  if (state) return state
  return persistedSaveState(sb)
}
function persistedSaveState(sb) {
  const stamps = sb?.field_saved_at || sb?.fieldSavedAt || {}
  const at = Number(stamps?.intent || 0)
  return { status: at ? 'loaded' : 'idle', at }
}
function setSaveState(sb, status, at) {
  const prev = saveStateOf(sb)
  saveStates.value = { ...saveStates.value, [sb.id]: { status, at: at ?? prev.at } }
}
function markDirty(sb, field, value) {
  const intent = intentOf(sb)
  if (!intent) return
  if ((intent[field] || '') === value) setSaveState(sb, persistedSaveState(sb).status, persistedSaveState(sb).at)
  else setSaveState(sb, 'dirty')
}

// ===== 保存：永远 PUT 完整 intent 文档 =====
function draftIntent(sb, patch) {
  const base = intentOf(sb)
  const next = {
    info_point: base?.info_point || '',
    device: base?.device || '',
    must_show: base ? [...base.must_show] : [],
    overlay_plan: base ? [...base.overlay_plan] : [],
    deterministic: base?.deterministic || '',
    rationale: base?.rationale || '',
    source: 'manual',
    ...patch,
  }
  if (!next.deterministic) next.deterministic = defaultClip(next.device)
  return next
}
// 同一镜的写入串行化：intent 是**整份替换**，并发两次写会用各自的旧快照互相覆盖
// （#43 的教训）。patch 可以是函数，在轮到自己时才按**最新** intent 计算。
const saveQueues = new Map()
function saveIntent(sb, patch) {
  const prev = saveQueues.get(sb.id) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => runSave(sb, patch))
  saveQueues.set(sb.id, next)
  return next
}
async function runSave(sb, patch) {
  const resolved = typeof patch === 'function' ? patch(intentOf(sb)) : patch
  if (!resolved) return
  const next = draftIntent(sb, resolved)
  if (!next.device) return
  setSaveState(sb, 'saving')
  try {
    const res = await storyboardAPI.setIntent(sb.id, next)
    applyResult(sb, res)
    setSaveState(sb, 'saved', res?.saved_at)
    emit('refresh')
  } catch (e) {
    setSaveState(sb, 'error')
    toastServerMessage(e, { fallback: 'episode.intent.saveFailed' })
  }
}
function applyResult(sb, res) {
  overrides.value = {
    ...overrides.value,
    [sb.id]: {
      intent: res?.intent ?? null,
      intent_issues: Array.isArray(res?.intent_issues) ? res.intent_issues : [],
      intent_reviewed: res?.intent_reviewed === true,
    },
  }
}
function saveText(sb, field, value) {
  const intent = intentOf(sb)
  if (!intent) return
  const next = String(value ?? '')
  if ((intent[field] || '') === next) {
    const persisted = persistedSaveState(sb)
    setSaveState(sb, persisted.status, persisted.at)
    return
  }
  saveIntent(sb, { [field]: next })
}
/** 换 device 时片段位置不在允许集里就回落到该 device 的默认值 */
function onDeviceChange(sb, device) {
  if (!device) return
  const current = intentOf(sb)?.deterministic
  const allowed = ctx.value.device_allowed_clip?.[device] || []
  const deterministic = current && allowed.includes(current) ? current : defaultClip(device)
  saveIntent(sb, { device, deterministic })
}

// ===== must_show 选择器 =====
const msDrafts = ref({})
function msDraft(sb) {
  return msDrafts.value[sb.id] || { kind: ctx.value.must_show_kinds[0] || 'region', assetKey: '', semantic: '', from: '', to: '' }
}
function setMsDraft(sb, patch) {
  msDrafts.value = { ...msDrafts.value, [sb.id]: { ...msDraft(sb), ...patch } }
}
function msDraftValid(sb) {
  const d = msDraft(sb)
  if (!d.kind) return false
  if (isSemanticKind(d.kind)) return Boolean(d.assetKey && d.semantic)
  if (d.kind === 'route') return Boolean(d.assetKey && d.from && d.to)
  return Boolean(d.assetKey)
}
function addMustShow(sb) {
  const intent = intentOf(sb)
  if (!intent || !msDraftValid(sb)) return
  const d = msDraft(sb)
  const asset = assetByKey(d.assetKey)
  const item = { kind: d.kind }
  if (asset) { item.asset_id = asset.id; item.asset_kind = asset.kind }
  if (isSemanticKind(d.kind) && d.semantic) item.semantic = d.semantic
  if (d.kind === 'route') {
    if (d.from) item.from = semanticNameOf(d.assetKey, d.from) || d.from
    if (d.to) item.to = semanticNameOf(d.assetKey, d.to) || d.to
  }
  msDrafts.value = { ...msDrafts.value, [sb.id]: { kind: d.kind, assetKey: '', semantic: '', from: '', to: '' } }
  saveIntent(sb, current => (current ? { must_show: [...current.must_show, item] } : null))
}
/**
 * 按稳定身份删除：排队期间列表可能已被别的改动重排，不能只认点击时的下标；
 * 也不能比整份 JSON —— 服务端规范化会补 semantic_id / semantic_name 等字段。
 */
function removeMustShow(sb, index) {
  const target = intentOf(sb)?.must_show?.[index]
  if (!target) return
  saveIntent(sb, current => (current ? { must_show: dropOnce(current.must_show, target, mustShowKey) } : null))
}
function mustShowKey(item) {
  return [
    item.kind, item.asset_kind || '', item.asset_id ?? '',
    item.semantic_id || item.semantic || item.semantic_name || '',
    item.from || '', item.to || '', item.note || '',
  ].join('|')
}
function overlayKey(item) {
  const anchor = item.anchor || {}
  return [
    item.layer, anchor.asset_kind || '', anchor.asset_id ?? '',
    anchor.semantic_id || anchor.semantic || '',
    item.reveal_at ?? '', item.template || '', item.text || '',
  ].join('|')
}
function dropOnce(list, target, keyOf) {
  const key = keyOf(target)
  let dropped = false
  return list.filter(item => {
    if (!dropped && keyOf(item) === key) { dropped = true; return false }
    return true
  })
}

// ===== overlay_plan 选择器（几何留给图层编辑页，这里只管层类型 / 锚点 / 出现时间） =====
const ovDrafts = ref({})
function ovDraft(sb) {
  return ovDrafts.value[sb.id] || { layer: ctx.value.overlay_layer_types[0] || 'polygon', assetKey: '', semantic: '', revealAt: '' }
}
function setOvDraft(sb, patch) {
  ovDrafts.value = { ...ovDrafts.value, [sb.id]: { ...ovDraft(sb), ...patch } }
}
/** 锚点是必填：没有锚点的图层在 #48 的图层编辑页无处落地 */
function ovDraftValid(sb) {
  const d = ovDraft(sb)
  return Boolean(d.layer && d.assetKey)
}
function addOverlay(sb) {
  const intent = intentOf(sb)
  if (!intent || !ovDraftValid(sb)) return
  const d = ovDraft(sb)
  const item = { layer: d.layer }
  const asset = assetByKey(d.assetKey)
  if (asset) {
    item.anchor = { asset_id: asset.id, asset_kind: asset.kind }
    if (d.semantic) item.anchor.semantic_id = d.semantic
  }
  const revealAt = Number(d.revealAt)
  if (d.revealAt !== '' && Number.isFinite(revealAt)) item.reveal_at = Math.max(0, revealAt)
  ovDrafts.value = { ...ovDrafts.value, [sb.id]: { layer: d.layer, assetKey: '', semantic: '', revealAt: '' } }
  saveIntent(sb, current => (current ? { overlay_plan: [...current.overlay_plan, item] } : null))
}
function removeOverlay(sb, index) {
  const target = intentOf(sb)?.overlay_plan?.[index]
  if (!target) return
  saveIntent(sb, current => (current ? { overlay_plan: dropOnce(current.overlay_plan, target, overlayKey) } : null))
}

// ===== 人工确认 =====
function confirmBlockReason(sb) {
  if (reviewedOf(sb)) return ''
  if (!intentOf(sb)) return t('episode.intent.confirmBlockedNoIntent')
  const blocking = issuesOf(sb).filter(issue => issue.severity === 'block')
  if (blocking.length) return blocking.map(i => i.message).join(t('common.listJoin'))
  if (unresolvedOf(sb)) return t('episode.intent.confirmBlockedUnresolved', { n: unresolvedOf(sb) })
  return ''
}
function confirmDisabled(sb) {
  if (reviewedOf(sb)) return false
  return Boolean(confirmBlockReason(sb))
}
async function toggleConfirm(sb) {
  const next = !reviewedOf(sb)
  try {
    const res = await storyboardAPI.setIntentReviewed(sb.id, next)
    applyResult(sb, res)
    emit('refresh')
  } catch (e) {
    toastServerMessage(e, { fallback: 'episode.intent.confirmFailed' })
  }
}

// ===== AI 重算：单镜与整集缺失，都是集级异步文本任务，前端轮询进度 =====
const batch = ref({ running: false, total: 0, completed: 0 })
const regenerating = ref([])

async function startBatch(ids) {
  if (batch.value.running || !props.episodeId) return null
  return episodeAPI.generateIntents(props.episodeId, {
    storyboard_ids: ids,
    model: props.chatModel || undefined,
    config_id: props.chatConfigId || undefined,
  })
}
async function generateAll() {
  if (!props.storyboards.length) { toast.warning(t('episode.intent.emptyTitle')); return }
  try {
    const res = await startBatch(undefined)
    if (!res?.total) {
      if (res?.already_running) { batch.value = { running: true, total: 0, completed: 0 }; pollBatch() }
      else toast.info(t('episode.intent.allFilled'))
      return
    }
    batch.value = { running: true, total: res.total, completed: 0 }
    toast.info(t('episode.intent.batchStarted', { n: res.total }))
    pollBatch()
  } catch (e) {
    toastError(e, { fallback: 'episode.intent.batchFailed' })
  }
}
async function generateOne(sb) {
  if (regenerating.value.includes(sb.id)) return
  regenerating.value = [...regenerating.value, sb.id]
  try {
    const res = await startBatch([sb.id])
    if (res?.total || res?.already_running) {
      batch.value = { running: true, total: res.total || 0, completed: 0 }
      pollBatch()
    } else {
      toast.info(t('episode.intent.allFilled'))
    }
  } catch (e) {
    toastError(e, { fallback: 'episode.intent.batchFailed' })
  } finally {
    regenerating.value = regenerating.value.filter(id => id !== sb.id)
  }
}

let pollTimer = null
function pollBatch(attempts = 240) {
  const tick = async (left) => {
    pollTimer = null
    try {
      const st = await episodeAPI.intentStatus(props.episodeId)
      if (st && st.status !== 'running') {
        batch.value = { running: false, total: 0, completed: 0 }
        overrides.value = {}
        emit('refresh')
        if (st.status === 'done') {
          toast.success(st.failed ? t('episode.intent.batchDoneFailed', { n: st.failed }) : t('episode.intent.batchDone'))
        } else {
          toastError(st.error, { fallback: 'episode.intent.batchFailed' })
        }
        return
      }
      if (st) {
        const prev = batch.value.completed
        batch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
        if ((st.completed || 0) !== prev) { overrides.value = {}; emit('refresh') }
      }
    } catch { /* 静默：轮询失败继续重试 */ }
    if (left > 0) pollTimer = setTimeout(() => tick(left - 1), 2500)
    else batch.value = { running: false, total: 0, completed: 0 }
  }
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => tick(attempts), 2500)
}

/** 进页时若已有正在跑的重算（别的标签页发起），接着轮询 */
async function resumeBatch() {
  if (!props.episodeId) return
  try {
    const st = await episodeAPI.intentStatus(props.episodeId)
    if (st?.status === 'running' && !batch.value.running) {
      batch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
      pollBatch()
    }
  } catch { /* 静默 */ }
}

onMounted(() => {
  loadContext()
  resumeBatch()
})
watch(() => props.episodeId, () => {
  overrides.value = {}
  saveStates.value = {}
  loadContext()
  resumeBatch()
})
onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
})
</script>

<style scoped>
.si-step {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.si-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.si-tag-warn {
  color: var(--tag-warning-text);
}
.si-batch-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.si-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.si-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-2);
  min-width: 0;
}
.si-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.si-no {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.si-device-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--bg-3);
  color: var(--text-2);
}
.si-state {
  font-size: 11px;
}
.si-state.is-ok { color: var(--tag-success-text); }
.si-state.is-todo { color: var(--tag-warning-text); }
.si-state.is-none { color: var(--text-3); }
.si-card-body {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  min-width: 0;
}
.si-col-read {
  flex: 1 1 220px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.si-col-edit {
  flex: 3 1 380px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.si-read-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.si-read-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.si-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.si-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.si-hint {
  font-size: 10px;
}
.si-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
}
.si-picker {
  align-items: center;
}
.si-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.si-field-grow {
  flex: 1 1 240px;
}
.si-select {
  max-width: 100%;
  min-width: 96px;
}
.si-small {
  width: 104px;
  min-width: 0;
}
.si-time {
  width: 72px;
  min-width: 0;
}
.si-inline {
  display: flex;
  align-items: center;
  gap: 4px;
}
.si-fixed {
  font-size: 12px;
  color: var(--text-2);
  padding: 4px 0;
}
.si-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.si-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.si-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 4px 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-2);
}
.si-chip.is-unresolved {
  border-color: var(--action-danger);
  color: var(--action-danger);
}
.si-chip-kind {
  color: var(--text-3);
}
.si-chip.is-unresolved .si-chip-kind {
  color: inherit;
}
.si-chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-chip-x {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 3px;
}
.si-overlay-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.si-overlay-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
  min-width: 0;
}
.si-overlay-row.is-unresolved {
  color: var(--action-danger);
}
.si-overlay-layer {
  flex: 0 0 auto;
  color: var(--text-3);
}
.si-overlay-row.is-unresolved .si-overlay-layer {
  color: inherit;
}
.si-overlay-anchor {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-overlay-time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.si-empty-line {
  font-size: 11px;
  color: var(--text-3);
  margin: 0;
}
.si-issues {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}
.si-issue {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 11px;
  line-height: 1.5;
}
.si-issue-dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  margin-top: 5px;
  border-radius: 50%;
  background: currentColor;
}
.si-issue.is-block { color: var(--action-danger); }
.si-issue.is-warn { color: var(--tag-warning-text); }
</style>
