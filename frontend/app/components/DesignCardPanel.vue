<template>
  <!-- 门禁：分镜设计未解锁时只给原因与出路，绝不渲染设计卡内容 -->
  <div v-if="designLocked" class="step-empty" style="flex:1">
    <div class="empty-visual"><Lock :size="32" /></div>
    <div class="empty-title">{{ t('episode.design.lockedTitle') }}</div>
    <div class="empty-desc">{{ t('episode.design.lockedDesc', { reason: lockReason }) }}</div>
    <button class="btn btn-primary" @click="gotoBlocker">{{ t('episode.design.lockedGoto') }}</button>
  </div>

  <template v-else>
    <NarrationCoverageBar
      :episode-id="episodeId"
      :chat-model="chatModel"
      :chat-config-id="chatConfigId"
      @refresh="emit('refresh')"
    />

    <div class="prod-content dc-step">
      <div class="dc-bar">
        <span class="dim" style="font-size:12px">{{ t('episode.design.title') }}</span>
        <span class="tag mono">{{ t('episode.design.summary', counts) }}</span>
        <span v-if="batch.running" class="tag mono dc-tag-run">
          <Loader2 :size="11" class="animate-spin" />
          {{ t('episode.design.fill.progress', { done: batch.completed, total: batch.total }) }}
        </span>
        <span class="ml-auto" />
        <button class="btn btn-sm" :disabled="batch.running || !shots.length" @click="openScope('fill')">
          <Sparkles :size="11" />
          {{ t('episode.design.batch.fillAll') }}
        </button>
        <button class="btn btn-sm" :disabled="batch.running || !shots.length" @click="openScope('confirm')">
          {{ t('episode.design.batch.confirmAll') }}
        </button>
      </div>

      <div v-if="!shots.length" class="step-empty" style="flex:1">
        <div class="empty-title">{{ t('episode.design.empty.noShots') }}</div>
      </div>

      <div v-else class="dc-body">
        <!-- 左：镜列表（镜号 + 组合象形 + 状态点），支持拖拽与上下移动排序 -->
        <section class="dc-list" :aria-label="t('episode.design.order.hint')">
          <button
            v-for="(sb, index) in shots"
            :key="sb.id"
            type="button"
            :class="['dc-shot', { on: sb.id === selectedId }]"
            :aria-pressed="sb.id === selectedId"
            draggable="true"
            @click="selectedId = sb.id"
            @dragstart="onDragStart(sb)"
            @dragover.prevent
            @drop.prevent="onDrop(index)"
            @dragend="dragId = 0"
          >
            <span class="dc-shot-no mono">{{ shotLabel(sb) }}</span>
            <span class="dc-shot-combo mono" :title="comboTitle(stateOf(sb).combo)">{{ comboGlyph(stateOf(sb).combo) }}</span>
            <span :class="['dc-dot', 'is-' + stateOf(sb).design_card_status]" :title="t(`episode.design.status.${stateOf(sb).design_card_status}`)" />
            <span class="dc-shot-grip">
              <span
                class="dc-move"
                role="button"
                tabindex="0"
                :aria-label="t('episode.design.order.up')"
                :title="t('episode.design.order.up')"
                @click.stop="move(index, -1)"
                @keydown.enter.stop.prevent="move(index, -1)"
              ><ChevronUp :size="11" /></span>
              <span
                class="dc-move"
                role="button"
                tabindex="0"
                :aria-label="t('episode.design.order.down')"
                :title="t('episode.design.order.down')"
                @click.stop="move(index, 1)"
                @keydown.enter.stop.prevent="move(index, 1)"
              ><ChevronDown :size="11" /></span>
            </span>
          </button>
        </section>

        <!-- 右：选中镜的设计卡 -->
        <section v-if="!selected" class="dc-card dc-card-empty">{{ t('episode.design.empty.selectShot') }}</section>
        <section v-else class="dc-card">
          <header class="dc-card-head">
            <strong>{{ shotLabel(selected) }}</strong>
            <span :class="['dc-state', 'is-' + current.design_card_status]">
              {{ t(`episode.design.status.${current.design_card_status}`) }}
            </span>
            <span v-if="current.design_card_stale_reason" class="dc-stale" :title="current.design_card_stale_reason">
              {{ current.design_card_stale_reason }}
            </span>
            <span v-if="saveState" class="dim" style="font-size:11px">{{ saveState }}</span>
            <span class="ml-auto" />
            <button class="btn btn-sm" :disabled="batch.running || busy" @click="refillOne">
              <Loader2 v-if="batch.running" :size="11" class="animate-spin" />
              {{ batch.running ? t('episode.design.actions.refilling') : t('episode.design.actions.refill') }}
            </button>
            <button
              v-if="current.design_card_status === 'confirmed'"
              class="btn btn-sm"
              :disabled="busy"
              @click="unconfirm"
            >{{ t('episode.design.actions.unconfirm') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="busy || !canConfirm"
              :title="confirmBlockReason"
              @click="confirm"
            >{{ t('episode.design.actions.confirm') }}</button>
          </header>

          <!-- 叙事 -->
          <div class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.narrative') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.narrative')">{{ t('episode.design.affects.narrative') }}</span>
            </div>
            <div class="dc-field">
              <span class="dc-label">{{ t('episode.design.field.narration') }}</span>
              <p class="dc-read">{{ current.narration_text || t('episode.design.narrationEmpty') }}</p>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.infoPoints') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.infoPoints')">{{ t('episode.design.affects.infoPoints') }}</span>
              </span>
              <div class="dc-chips">
                <span v-for="(point, index) in draft.info_points" :key="point.id || index" class="dc-chip">
                  <span class="dc-chip-text">{{ point.text }}</span>
                  <select
                    class="input dc-chip-select"
                    :value="point.via"
                    :aria-label="t('episode.design.field.infoPoints')"
                    @change="setInfoVia(index, $event.target.value)"
                  >
                    <option v-for="via in ctx.info_point_vias" :key="via" :value="via">{{ t(`episode.design.via.${via}`) }}</option>
                  </select>
                  <button
                    type="button"
                    class="dc-chip-del"
                    :aria-label="t('episode.design.actions.remove')"
                    @click="removeInfoPoint(index)"
                  >×</button>
                </span>
                <span class="dc-chip-add">
                  <input
                    class="input dc-chip-input"
                    type="text"
                    :value="infoDraft"
                    :placeholder="t('episode.design.field.infoPoints')"
                    @input="infoDraft = $event.target.value"
                    @keydown.enter.prevent="addInfoPoint"
                  >
                  <button type="button" class="btn btn-sm" :disabled="!infoDraft.trim()" @click="addInfoPoint">
                    {{ t('episode.design.actions.add') }}
                  </button>
                </span>
              </div>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.neighbors') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.neighbors')">{{ t('episode.design.affects.neighbors') }}</span>
              </span>
              <p class="dc-read dim">
                {{ t('episode.design.prevShot') }}: {{ neighborText(-1) }} ｜ {{ t('episode.design.nextShot') }}: {{ neighborText(1) }}
              </p>
            </div>
          </div>

          <!-- 结构：段组合 + 时长预算 -->
          <div class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.structure') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.combo')">{{ t('episode.design.affects.combo') }}</span>
            </div>
            <p class="dc-hint">{{ t('episode.design.combo.required') }}</p>
            <div class="dc-combos">
              <button
                v-for="key in COMBOS"
                :key="key"
                type="button"
                :class="['dc-combo', { on: draft.combo === key }]"
                :aria-pressed="draft.combo === key"
                @click="pickCombo(key)"
              >
                <span class="dc-combo-icons">
                  <Layers v-if="key !== 'B'" :size="14" />
                  <Sparkles v-if="key !== 'A'" :size="14" />
                  <span v-if="suggestedCombo === key" class="dc-combo-sug">{{ t('episode.design.combo.suggested') }}</span>
                </span>
                <span class="dc-combo-name">{{ t(`episode.design.combo.${key}.name`) }}</span>
                <span class="dc-combo-desc">{{ t(`episode.design.combo.${key}.desc`) }}</span>
              </button>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ totalSeconds === null ? t('episode.design.budget.totalMissing') : t('episode.design.budget.total', { n: totalSeconds.toFixed(1) }) }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.budget')">{{ t('episode.design.affects.budget') }}</span>
              </span>
              <div class="dc-budget">
                <label v-if="hasLayer" class="dc-budget-num">
                  <span class="dim">{{ t('episode.design.budget.layerSegment') }}</span>
                  <input
                    class="input dc-num" type="number" min="0" :max="ctx.limits.layer_s" step="0.5"
                    :value="layerSeconds"
                    @change="setSeconds('layer_s', $event.target.value)"
                  >
                </label>
                <label v-if="hasGen" class="dc-budget-num">
                  <span class="dim">{{ t('episode.design.budget.genSegment') }}</span>
                  <input
                    class="input dc-num" type="number" min="0" :max="ctx.limits.gen_s" step="0.5"
                    :value="genSeconds"
                    @change="setSeconds('gen_s', $event.target.value)"
                  >
                </label>
                <span class="dim dc-budget-limit">
                  {{ t('episode.design.budget.limitLayer', { n: ctx.limits.layer_s }) }} ·
                  {{ t('episode.design.budget.limitGen', { n: ctx.limits.gen_s }) }}
                </span>
              </div>

              <p v-if="budgetMessage" class="dc-hint">{{ budgetMessage }}</p>
              <div v-if="budgetPositive" ref="barEl" class="dc-bar-track">
                <span v-if="hasLayer" class="dc-seg is-layer" :style="{ width: layerPct + '%' }">
                  <span v-if="layerOverPct > 0" class="dc-seg-over" :style="{ width: layerOverPct + '%' }" />
                  <span
                    class="dc-seg-tick"
                    :class="{ 'is-over': layerOverPct > 0 }"
                    :style="{ left: tickLeft(layerSeconds, ctx.limits.layer_s) + '%' }"
                    :title="t('episode.design.budget.limitLayer', { n: ctx.limits.layer_s })"
                  />
                  <span class="dc-seg-text mono">{{ layerSeconds.toFixed(1) }}s</span>
                </span>
                <span
                  v-if="hasLayer && hasGen"
                  class="dc-divider"
                  role="separator"
                  :aria-label="t('episode.design.budget.total', { n: totalSeconds.toFixed(1) })"
                  @pointerdown="startDrag"
                >◆</span>
                <span v-if="hasGen" class="dc-seg is-gen" :style="{ width: genPct + '%' }">
                  <span v-if="genOverPct > 0" class="dc-seg-over" :style="{ width: genOverPct + '%' }" />
                  <span
                    class="dc-seg-tick"
                    :class="{ 'is-over': genOverPct > 0 }"
                    :style="{ left: tickLeft(genSeconds, ctx.limits.gen_s) + '%' }"
                    :title="t('episode.design.budget.limitGen', { n: ctx.limits.gen_s })"
                  />
                  <span class="dc-seg-text mono">{{ genSeconds.toFixed(1) }}s</span>
                </span>
              </div>

              <div class="dc-narr-line">
                <span v-if="budgetPositive" :class="['dc-narr-fill', narrationClass]" :style="{ width: narrationPct + '%' }" />
                <span class="dc-narr-text mono">
                  {{ current.narration_measured_s === null
                    ? t('episode.design.budget.estimate', { n: narrationSeconds.toFixed(1) })
                    : t('episode.design.budget.measured', { n: narrationSeconds.toFixed(1) }) }}
                  <template v-if="!budgetPositive"> · {{ t('episode.design.budget.headroomMissing') }}</template>
                  <template v-else-if="narrationClass === 'is-over'"> · {{ t('episode.design.budget.over') }}</template>
                  <template v-else-if="narrationClass === 'is-tight'"> · {{ t('episode.design.budget.tight') }}</template>
                  <template v-else> · {{ t('episode.design.budget.remain', { n: headroom.toFixed(1) }) }}</template>
                </span>
              </div>
            </div>
          </div>

          <!-- 图层段计划（B 组合没有图层段） -->
          <div v-if="draft.combo !== 'B'" class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.layerPlan') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.plannedLayers')">{{ t('episode.design.affects.plannedLayers') }}</span>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.base') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.base')">{{ t('episode.design.affects.base') }}</span>
              </span>
              <select class="input dc-select" :value="baseValue" :aria-label="t('episode.design.field.base')" @change="setBase($event.target.value)">
                <option value="">{{ t('episode.design.baseNone') }}</option>
                <option value="inherit_prev">{{ t('episode.design.inheritPrev') }}</option>
                <option
                  v-for="candidate in ctx.base_candidates"
                  :key="`${candidate.asset_kind}:${candidate.asset_id}:${candidate.version_task_id ?? 0}`"
                  :value="baseKeyOf(candidate)"
                >
                  {{ candidate.name }}{{ candidate.verified ? ` · ${t('episode.design.picker.verified')}` : '' }}
                </option>
              </select>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.mustMark') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.mustMark')">{{ t('episode.design.affects.mustMark') }}</span>
              </span>
              <div class="dc-chips">
                <span v-for="(item, index) in layerPlan.must_mark" :key="`${item.asset_id}:${item.semantic_id}`" :class="['dc-chip', { 'is-unresolved': item.unresolved }]">
                  <span class="dc-chip-text">{{ item.name }}</span>
                  <button type="button" class="dc-chip-del" :aria-label="t('episode.design.actions.remove')" @click="removeMustMark(index)">×</button>
                </span>
                <button type="button" class="btn btn-sm" @click="openPicker('must_mark')">{{ t('episode.design.actions.add') }}</button>
              </div>
            </div>

            <div class="dc-field">
              <span class="dc-label">{{ t('episode.design.field.plannedLayers') }}</span>
              <div class="dc-rows">
                <div v-for="(layer, index) in layerPlan.planned_layers" :key="index" class="dc-row">
                  <select
                    class="input dc-select dc-row-type"
                    :value="layer.type"
                    :aria-label="t('episode.design.field.plannedLayers')"
                    @change="patchLayer(index, { type: $event.target.value })"
                  >
                    <option v-for="type in ctx.planned_layer_types" :key="type" :value="type">{{ t(`episode.design.layerType.${type}`) }}</option>
                  </select>
                  <input
                    class="input dc-row-text" type="text" :value="layer.text || ''"
                    :aria-label="t('episode.design.field.plannedLayers')"
                    @input="patchLayer(index, { text: $event.target.value }, true)"
                    @blur="saveNow()"
                  >
                  <input
                    class="input dc-row-at" type="number" min="0" step="0.5" :value="layer.at_s"
                    :aria-label="t('episode.design.atSeconds', { n: layer.at_s })"
                    @change="patchLayer(index, { at_s: toSeconds($event.target.value) })"
                  >
                  <button type="button" class="dc-chip-del" :aria-label="t('episode.design.actions.remove')" @click="removeLayer(index)">×</button>
                </div>
                <button type="button" class="btn btn-sm" @click="addLayer">{{ t('episode.design.actions.add') }}</button>
              </div>
            </div>
          </div>

          <!-- 生成段计划（A 组合没有生成段） -->
          <div v-if="draft.combo !== 'A'" class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.genPlan') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.frames')">{{ t('episode.design.affects.frames') }}</span>
            </div>

            <div class="dc-field">
              <span class="dc-label">
                {{ t('episode.design.field.referenceAssets') }}
                <span class="dc-affect" :title="t('episode.design.affectsTip.referenceAssets')">{{ t('episode.design.affects.referenceAssets') }}</span>
              </span>
              <div class="dc-chips">
                <span v-for="(item, index) in genPlan.reference_assets" :key="`${item.kind}:${item.id}`" :class="['dc-chip', { 'is-unresolved': item.unresolved }]">
                  <span class="dc-chip-text">{{ item.name }}</span>
                  <button type="button" class="dc-chip-del" :aria-label="t('episode.design.actions.remove')" @click="removeReference(index)">×</button>
                </span>
                <button type="button" class="btn btn-sm" @click="openPicker('reference_assets')">{{ t('episode.design.actions.add') }}</button>
              </div>
            </div>

            <div v-for="slot in ['first', 'mid', 'last']" :key="slot" class="dc-field">
              <span class="dc-label">{{ t(`episode.design.field.${slot}`) }}</span>
              <p v-if="junctionSlot === slot" class="dc-read dc-junction" :title="t('episode.design.junction.noText')">
                {{ t('episode.design.junction.locked') }} · {{ draft.combo === 'C' ? t('episode.design.junction.layerLast') : t('episode.design.junction.layerFirst') }}
              </p>
              <input
                v-else
                class="input"
                type="text"
                :value="genPlan[slot] || ''"
                :aria-label="t(`episode.design.field.${slot}`)"
                @input="patchGen({ [slot]: $event.target.value }, true)"
                @blur="saveNow()"
              >
            </div>
          </div>

          <!-- 理由与问题 -->
          <div class="dc-section">
            <div class="dc-section-head">
              <span class="dc-section-title">{{ t('episode.design.section.rationale') }}</span>
              <span class="dc-affect" :title="t('episode.design.affectsTip.rationale')">{{ t('episode.design.affects.rationale') }}</span>
            </div>
            <p v-if="current.design_card_stale_reason === 'migration_combo_unresolved'" class="dc-read dc-stale">
              {{ t('episode.design.migrationComboUnresolved') }}
            </p>
            <textarea
              class="textarea"
              rows="3"
              :value="draft.rationale"
              :aria-label="t('episode.design.field.rationale')"
              :placeholder="t('episode.design.field.rationale')"
              @input="patchDraft({ rationale: $event.target.value }, true)"
              @blur="saveNow()"
            />
            <ul v-if="issues.length" class="dc-issues">
              <li v-for="(issue, index) in issues" :key="`${issue.code}-${index}`" :class="['dc-issue', 'is-' + issue.severity]">
                {{ t(`episode.design.issue.${issue.code}`) }}
              </li>
            </ul>
            <label v-if="warnOnly" class="dc-ack">
              <input type="checkbox" :checked="acknowledged" @change="acknowledged = $event.target.checked">
              {{ t('episode.design.actions.acknowledge') }}
            </label>
          </div>
        </section>
      </div>
    </div>

    <!-- 批量范围清单：将处理 n 镜 / 排除 m 镜及原因 -->
    <Teleport to="body">
      <div v-if="scope" class="overlay" @click.self="scope = null">
        <div class="dialog dc-scope" role="dialog" aria-modal="true" :aria-label="t('episode.design.batch.scopeTitle')">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.design.batch.scopeTitle') }}</h2>
          </header>
          <div class="dialog-body">
            <p>{{ t('episode.design.batch.willProcess', { n: scope.include.length }) }}</p>
            <p class="dim">{{ t('episode.design.batch.excluded', { n: scope.exclude.length }) }}</p>
            <ul class="dc-scope-list">
              <li v-for="item in scope.exclude" :key="item.storyboard_id">
                <span class="mono">#{{ pad(item.shot_number) }}</span>
                <span class="dim">{{ t('episode.design.batch.reason') }}: {{ t(`episode.design.exclude.${item.reason}`) }}</span>
              </li>
            </ul>
          </div>
          <footer class="dialog-foot">
            <button class="btn btn-sm" @click="scope = null">{{ t('episode.design.batch.cancel') }}</button>
            <button class="btn btn-sm btn-primary" :disabled="!scope.include.length" @click="runScope">
              {{ t('episode.design.batch.run') }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 本镜已有制作产物时，改组合不再直接写设计卡，而是走「保留/归档/新做」的影响清单 -->
    <ComboSwitchDialog
      v-if="comboSwitch.open"
      :storyboard-id="comboSwitch.sbId"
      :shot-number="comboSwitch.shotNumber"
      :from="comboSwitch.from"
      :initial="comboSwitch.to"
      @close="comboSwitch.open = false"
      @switched="onComboSwitched"
    />

    <AssetPicker
      :open="picker.open"
      :mode="picker.mode"
      :assets="ctx.assets"
      :selected="picker.selected"
      @close="picker.open = false"
      @confirm="onPicked"
    />
  </template>
</template>

<script setup>
/**
 * 分镜设计卡（Issue #57，纪录片）——导演分镜单：逐镜写明叙事、段组合、两段的时长预算与
 * 各自的制作计划，每个分组都标出「→ 影响」哪一步下游工作。
 *
 * 保存契约：后端**整份替换** `design_card`，所以任何一次改动都把完整卡片 PUT 回去，
 * 界面随后一律改用响应里的 design_card / issues / design_card_status（issues 是读时重算的
 * 结论，前端不自行推断）。同一镜的写入串行化，避免并发写各自用旧快照互相覆盖。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, Layers, Loader2, Lock, Sparkles } from 'lucide-vue-next'
import NarrationCoverageBar from '~/components/NarrationCoverageBar.vue'
import AssetPicker from '~/components/AssetPicker.vue'
import ComboSwitchDialog from '~/components/ShotProduction/ComboSwitchDialog.vue'
import { COMBOS, episodeAPI, storyboardAPI } from '~/composables/useApi'
import { useWorkflowGates } from '~/composables/useWorkflowGates'
import { toastError, toastServerMessage } from '~/composables/useToast'

const { t } = useI18n()

const props = defineProps({
  episodeId: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
})
const emit = defineEmits(['refresh'])

const COMBO_GLYPH = { A: '▣', B: '▶', C: '▣▶', D: '▶▣' }
const EMPTY_CTX = {
  assets: [],
  base_candidates: [],
  combos: ['A', 'B', 'C', 'D'],
  info_point_vias: ['layer', 'generated', 'narration_only'],
  planned_layer_types: ['polygon', 'polyline', 'marker', 'label', 'card', 'image'],
  limits: { layer_s: 30, gen_s: 15, narration_cps: 4.2, info_points: 12, planned_layers: 20, must_mark: 12, rationale: 600 },
}

const ctx = ref({ ...EMPTY_CTX })
const audit = ref([])
const overrides = ref({})
const selectedId = ref(0)
const localOrder = ref(null)
const dragId = ref(0)
const busy = ref(false)
const saveState = ref('')
const infoDraft = ref('')
const acknowledged = ref(false)
const scope = ref(null)
const batch = ref({ running: false, total: 0, completed: 0 })
const picker = reactive({ open: false, mode: 'asset', field: '', selected: [] })
const comboSwitch = ref({ open: false, sbId: 0, shotNumber: 0, from: '', to: '' })
const barEl = ref(null)

// ===== 门禁 =====
const { gates, ready: gatesReady, refreshGates, reasonOf, gotoOf } = useWorkflowGates(() => props.episodeId)
// 门禁未判定（首屏未取到 /gates 或取数失败）时同样按锁定渲染，内容绝不先闪出来
const designLocked = computed(() => !gatesReady.value || gates.value.unlocked?.design === false)
const lockReason = computed(() => reasonOf('design') || t('episode.gate.checking'))
function gotoBlocker() {
  const target = gotoOf('design') || 'assets'
  const url = new URL(window.location.href)
  if (target === 'script') {
    url.searchParams.set('panel', 'script')
    url.searchParams.delete('tab')
  } else {
    url.searchParams.set('panel', 'production')
    url.searchParams.set('tab', target)
  }
  window.location.assign(url.toString())
}

// ===== 镜列表与选中镜 =====
const auditById = computed(() => Object.fromEntries(audit.value.map(item => [item.storyboard_id, item])))

const shots = computed(() => {
  const list = [...props.storyboards]
  const order = localOrder.value
  if (!order) return list
  const rank = new Map(order.map((id, index) => [id, index]))
  return list.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
})

function pad(n) { return String(n ?? 0).padStart(2, '0') }
function shotLabel(sb) { return `#${pad(stateOf(sb).shot_number)}` }
function comboGlyph(combo) { return combo ? COMBO_GLYPH[combo] : t('episode.design.combo.none') }
function comboTitle(combo) { return combo ? t(`episode.design.combo.${combo}.name`) : t('episode.design.combo.required') }

/** 单镜状态：PUT/确认的响应覆盖 > 审计结果 > 分镜行本身 */
function stateOf(sb) {
  const override = overrides.value[sb?.id]
  if (override) return override
  const item = auditById.value[sb?.id]
  const card = sb?.design_card ?? sb?.designCard ?? null
  return {
    storyboard_id: sb?.id,
    shot_number: sb?.shot_number ?? sb?.shotNumber ?? item?.shot_number ?? 0,
    narration_text: sb?.narration_text ?? sb?.narrationText ?? item?.narration_text ?? '',
    combo: sb?.combo ?? item?.combo ?? null,
    design_card: card,
    design_card_status: sb?.design_card_status ?? item?.status ?? 'blank',
    design_card_confirmed_at: sb?.design_card_confirmed_at ?? item?.confirmed_at ?? null,
    design_card_stale_reason: sb?.design_card_stale_reason ?? item?.stale_reason ?? null,
    issues: sb?.design_card_issues ?? card?.issues ?? item?.issues ?? [],
    narration_estimate_s: item?.narration_estimate_s ?? 0,
    narration_measured_s: item?.narration_measured_s ?? null,
  }
}

const selected = computed(() => shots.value.find(sb => sb.id === selectedId.value) || null)
const current = computed(() => (selected.value ? stateOf(selected.value) : stateOf(null)))

const counts = computed(() => {
  const all = shots.value.map(sb => stateOf(sb))
  return {
    confirmed: all.filter(s => s.design_card_status === 'confirmed').length,
    pending: all.filter(s => s.design_card_status === 'pending').length,
    stale: all.filter(s => s.design_card_status === 'stale').length,
    issues: all.filter(s => (s.issues || []).length).length,
  }
})

// ===== 卡片草稿：服务端响应即真值，本地只在两次保存之间持有编辑中的内容 =====
function emptyCard() {
  return {
    version: 2,
    combo: null,
    info_points: [],
    budget: { layer_s: null, gen_s: null },
    layer_plan: { base: null, must_mark: [], planned_layers: [] },
    gen_plan: { reference_assets: [], first: '', mid: '', last: '' },
    rationale: '',
    suggested_combo: null,
  }
}
const draft = ref(emptyCard())

function fromState(state) {
  const card = state?.design_card || null
  const next = emptyCard()
  next.combo = state?.combo ?? null
  if (!card) return next
  next.info_points = (card.info_points || []).map(item => ({ ...item }))
  next.budget = { layer_s: card.budget?.layer_s ?? null, gen_s: card.budget?.gen_s ?? null }
  next.layer_plan = {
    base: card.layer_plan?.base ? { ...card.layer_plan.base } : null,
    must_mark: (card.layer_plan?.must_mark || []).map(item => ({ ...item })),
    planned_layers: (card.layer_plan?.planned_layers || []).map(item => ({ ...item })),
  }
  next.gen_plan = {
    reference_assets: (card.gen_plan?.reference_assets || []).map(item => ({ ...item })),
    first: card.gen_plan?.first || '',
    mid: card.gen_plan?.mid || '',
    last: card.gen_plan?.last || '',
  }
  next.rationale = card.rationale || ''
  next.suggested_combo = card.suggested_combo ?? null
  return next
}

function syncDraft() {
  draft.value = fromState(current.value)
  infoDraft.value = ''
  acknowledged.value = false
  saveState.value = ''
}

const layerPlan = computed(() => draft.value.layer_plan)
const genPlan = computed(() => draft.value.gen_plan)
const suggestedCombo = computed(() => draft.value.suggested_combo)
const issues = computed(() => (current.value.issues || []).filter(issue => !budgetMissing.value
  || !['budget_under_narration', 'budget_tight'].includes(issue.code)))
const warnOnly = computed(() => issues.value.length > 0 && issues.value.every(issue => issue.severity !== 'block'))
const junctionSlot = computed(() => (draft.value.combo === 'C' ? 'first' : (draft.value.combo === 'D' ? 'last' : '')))

// ===== 时长预算 =====
const hasLayer = computed(() => draft.value.combo !== 'B' && draft.value.combo !== null)
const hasGen = computed(() => draft.value.combo !== 'A' && draft.value.combo !== null)
const layerSeconds = computed(() => draft.value.budget.layer_s)
const genSeconds = computed(() => draft.value.budget.gen_s)
const budgetMissing = computed(() => !draft.value.combo
  || (hasLayer.value && layerSeconds.value === null)
  || (hasGen.value && genSeconds.value === null))
const totalSeconds = computed(() => budgetMissing.value ? null
  : (hasLayer.value ? layerSeconds.value : 0) + (hasGen.value ? genSeconds.value : 0))
const budgetPositive = computed(() => !budgetMissing.value
  && (!hasLayer.value || layerSeconds.value > 0)
  && (!hasGen.value || genSeconds.value > 0))
const budgetMessage = computed(() => {
  if (!draft.value.combo) return t('episode.design.budget.comboMissing')
  if (budgetMissing.value) return t('episode.design.budget.valuesMissing')
  if (!budgetPositive.value) return t('episode.design.budget.invalid')
  return ''
})
const layerPct = computed(() => (budgetPositive.value && hasLayer.value ? (layerSeconds.value / totalSeconds.value) * 100 : 0))
const genPct = computed(() => (budgetPositive.value && hasGen.value ? (genSeconds.value / totalSeconds.value) * 100 : 0))
/** 段内超出硬限的比例：刻度画在限额处，右侧溢出部分标红 */
const layerOverPct = computed(() => (layerSeconds.value > ctx.value.limits.layer_s
  ? ((layerSeconds.value - ctx.value.limits.layer_s) / layerSeconds.value) * 100 : 0))
const genOverPct = computed(() => (genSeconds.value > ctx.value.limits.gen_s
  ? ((genSeconds.value - ctx.value.limits.gen_s) / genSeconds.value) * 100 : 0))
const overLimit = computed(() => layerOverPct.value > 0 || genOverPct.value > 0)

const narrationSeconds = computed(() => Number(current.value.narration_measured_s ?? current.value.narration_estimate_s ?? 0))
const headroom = computed(() => budgetPositive.value ? totalSeconds.value - narrationSeconds.value : null)
const narrationPct = computed(() => (totalSeconds.value > 0
  ? Math.min(100, (narrationSeconds.value / totalSeconds.value) * 100)
  : 100))
const narrationClass = computed(() => {
  if (!budgetPositive.value) return ''
  if (headroom.value < 0) return 'is-over'
  if (headroom.value < 0.5) return 'is-tight'
  return 'is-ok'
})

function toSeconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 2) / 2
}
/** 硬限刻度位置：段内超限时画在限额处，未超限时落在段的右端 */
function tickLeft(seconds, limit) {
  return seconds > limit ? (limit / seconds) * 100 : 100
}

function setSeconds(field, value) {
  const next = { ...draft.value.budget, [field]: value.trim() === '' ? null : toSeconds(value) }
  patchDraft({ budget: next })
}

/** 拖分界：总时长不变，按 0.5s 吸附重新分配两段 */
function startDrag(event) {
  if (!hasLayer.value || !hasGen.value || !barEl.value) return
  const total = totalSeconds.value
  if (total <= 0) return
  const rect = barEl.value.getBoundingClientRect()
  const onMove = (e) => {
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const layer = toSeconds(total * ratio)
    draft.value = { ...draft.value, budget: { layer_s: layer, gen_s: toSeconds(total - layer) } }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    saveNow()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  onMove(event)
}

// ===== 编辑动作 =====
// 防抖写入必须记住它属于**哪一镜**：延迟期间换镜时，待写内容仍要落回原来那一镜，
// 否则会把上一镜的草稿 PUT 到新选中的分镜上。
let debounceTimer = null
let pendingSave = null
function patchDraft(patch, debounce = false) {
  draft.value = { ...draft.value, ...patch }
  const sbId = selectedId.value
  if (!sbId) return
  if (debounce) {
    pendingSave = { sbId, card: draft.value }
    saveState.value = ''
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; flushPending() }, 600)
    return
  }
  flushPending()
  save(sbId, draft.value)
}
/** 立即提交待写内容（失焦、拖动结束、换镜、卸载前都走这里） */
function flushPending() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  const job = pendingSave
  pendingSave = null
  if (job) save(job.sbId, job.card)
}
function saveNow() {
  flushPending()
}

/** 本镜是否已有制作产物：已出过任一关键帧图（图层段渲染与否由后端门禁兜底） */
function hasProductionArtifacts(sb) {
  const k = sb?.keyframes || {}
  return Boolean(
    k.first_image || k.firstImage ||
    k.mid_image || k.midImage ||
    k.last_image || k.lastImage ||
    sb?.layer_segment || sb?.layerSegment,
  )
}
function pickCombo(key) {
  if (draft.value.combo === key) return
  const sb = selected.value
  // 已有产物：先看影响清单再切换（只归档不删除），不再直接覆盖写设计卡
  if (sb && draft.value.combo && hasProductionArtifacts(sb)) {
    comboSwitch.value = {
      open: true,
      sbId: sb.id,
      shotNumber: Number(stateOf(sb).shot_number) || 0,
      from: draft.value.combo,
      to: key,
    }
    return
  }
  patchDraft({ combo: key })
}
function onComboSwitched() {
  emit('refresh')
  if (selected.value) syncDraft()
}
function setInfoVia(index, via) {
  const list = draft.value.info_points.map((item, i) => (i === index ? { ...item, via } : item))
  patchDraft({ info_points: list })
}
function addInfoPoint() {
  const text = infoDraft.value.trim()
  if (!text) return
  if (draft.value.info_points.length >= ctx.value.limits.info_points) return
  const id = `ip-${Date.now().toString(36)}-${draft.value.info_points.length}`
  infoDraft.value = ''
  patchDraft({ info_points: [...draft.value.info_points, { id, text, via: ctx.value.info_point_vias[0] || 'layer' }] })
}
function removeInfoPoint(index) {
  patchDraft({ info_points: draft.value.info_points.filter((_, i) => i !== index) })
}

function baseKeyOf(candidate) {
  return `asset:${candidate.asset_kind}:${candidate.asset_id}:${candidate.version_task_id ?? ''}`
}
const baseValue = computed(() => {
  const base = layerPlan.value.base
  if (!base) return ''
  if (base.kind === 'inherit_prev') return 'inherit_prev'
  const exact = `asset:${base.asset_kind}:${base.asset_id}:${base.version_task_id ?? ''}`
  if (base.version_task_id != null) return exact
  // 迁移与 AI 填卡只写到资产级（没有版本号）：落到该资产的候选版本上，
  // 否则下拉匹配不到任何 option，明明选了底图却显示成「未选择底图」
  const candidate = ctx.value.base_candidates.find(item => item.asset_kind === base.asset_kind && item.asset_id === base.asset_id)
  return candidate ? baseKeyOf(candidate) : exact
})
function setBase(value) {
  let base = null
  if (value === 'inherit_prev') base = { kind: 'inherit_prev' }
  else if (value) {
    const candidate = ctx.value.base_candidates.find(item => baseKeyOf(item) === value)
    if (candidate) {
      base = {
        kind: 'asset',
        asset_kind: candidate.asset_kind,
        asset_id: candidate.asset_id,
        version_task_id: candidate.version_task_id ?? null,
      }
    }
  }
  patchDraft({ layer_plan: { ...layerPlan.value, base } })
}
function removeMustMark(index) {
  patchDraft({ layer_plan: { ...layerPlan.value, must_mark: layerPlan.value.must_mark.filter((_, i) => i !== index) } })
}
function addLayer() {
  if (layerPlan.value.planned_layers.length >= ctx.value.limits.planned_layers) return
  const type = ctx.value.planned_layer_types[0] || 'label'
  patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: [...layerPlan.value.planned_layers, { type, text: '', at_s: 0 }] } })
}
function patchLayer(index, patch, debounce = false) {
  const list = layerPlan.value.planned_layers.map((item, i) => (i === index ? { ...item, ...patch } : item))
  patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: list } }, debounce)
}
function removeLayer(index) {
  patchDraft({ layer_plan: { ...layerPlan.value, planned_layers: layerPlan.value.planned_layers.filter((_, i) => i !== index) } })
}
function patchGen(patch, debounce = false) {
  patchDraft({ gen_plan: { ...genPlan.value, ...patch } }, debounce)
}
function removeReference(index) {
  patchGen({ reference_assets: genPlan.value.reference_assets.filter((_, i) => i !== index) })
}

function openPicker(field) {
  picker.field = field
  picker.mode = field === 'must_mark' ? 'semantic' : 'asset'
  picker.selected = field === 'must_mark'
    ? layerPlan.value.must_mark.map(item => ({ ...item }))
    : genPlan.value.reference_assets.map(item => ({ ...item }))
  picker.open = true
}
function onPicked(items) {
  picker.open = false
  if (picker.field === 'must_mark') patchDraft({ layer_plan: { ...layerPlan.value, must_mark: items } })
  else patchGen({ reference_assets: items })
}

function neighborText(delta) {
  const index = shots.value.findIndex(sb => sb.id === selectedId.value)
  const neighbor = index >= 0 ? shots.value[index + delta] : null
  if (!neighbor) return t('episode.design.noneShot')
  const state = stateOf(neighbor)
  const text = (state.narration_text || '').slice(0, 20)
  return `#${pad(state.shot_number)} ${text}`
}

// ===== 保存：永远 PUT 完整卡片，响应即真值 =====
const saveQueues = new Map()
/** 同一镜的写入串行化：整份替换的并发写会用各自的旧快照互相覆盖 */
function save(sbId, card) {
  if (!sbId || !card) return Promise.resolve()
  // 超硬上限的段条不往后端送：后端必定 400，回灌服务端事实会把用户刚输入的数字抹掉，
  // 红色超限段与禁用的确认按钮就永远看不到。留在草稿里，改回上限内再接着存。
  const overLayer = Number(card.budget?.layer_s || 0) > ctx.value.limits.layer_s
  const overGen = Number(card.budget?.gen_s || 0) > ctx.value.limits.gen_s
  if (overLayer || overGen) {
    if (sbId === selectedId.value) {
      saveState.value = t(overLayer ? 'episode.design.error.budgetOverLayer' : 'episode.design.error.budgetOverGen')
    }
    return Promise.resolve()
  }
  const prev = saveQueues.get(sbId) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => runSave(sbId, card))
  saveQueues.set(sbId, next)
  return next
}
function payloadOf(card) {
  return {
    version: 2,
    info_points: card.info_points,
    budget: card.budget,
    layer_plan: card.layer_plan,
    gen_plan: card.gen_plan,
    rationale: card.rationale,
    suggested_combo: card.suggested_combo,
    issues: [],
  }
}
async function runSave(sbId, card) {
  if (sbId === selectedId.value) saveState.value = t('episode.design.actions.save')
  try {
    const res = await storyboardAPI.setDesignCard(sbId, { combo: card.combo, design_card: payloadOf(card) })
    applyResult(sbId, res)
    if (sbId === selectedId.value) saveState.value = t('episode.design.actions.saved')
    emit('refresh')
    loadAudit()
  } catch (err) {
    if (sbId === selectedId.value) saveState.value = ''
    reportError(err, 'episode.design.error.saveFailed')
    // 写入被拒（超上限 / 卡被 AI 占用）时回到服务端的事实，不让界面留着没落库的值
    if (sbId === selectedId.value) syncDraft()
  }
}
function applyResult(id, res) {
  if (!res) return
  overrides.value = { ...overrides.value, [id]: res }
  if (id === selectedId.value) {
    draft.value = fromState(res)
    acknowledged.value = false
  }
}

/** 结构化错误码 → 可读文案（400/409 的 code / gate 由后端给出） */
function reportError(err, fallback) {
  const body = err?.body || {}
  const map = {
    card_busy: 'episode.design.error.cardBusy',
    budget_over_gen: 'episode.design.error.budgetOverGen',
    budget_over_layer: 'episode.design.error.budgetOverLayer',
    blocked: 'episode.design.error.blocked',
    needs_acknowledge: 'episode.design.error.needsAcknowledge',
  }
  if (body.gate === 'combo_switch') {
    // 后端判定已有制作产物：按影响清单走组合切换（不直接改写设计卡）
    const sb = selected.value
    if (sb && draft.value.combo) {
      comboSwitch.value = {
        open: true,
        sbId: sb.id,
        shotNumber: Number(stateOf(sb).shot_number) || 0,
        from: draft.value.combo,
        to: '',
      }
      syncDraft()
    } else toast.error(t('episode.design.error.comboSwitch'))
    return
  }
  // 后端错误体是 { code: 400, error: 'budget_over_layer', ... }：错误码在 error 上，code 是 HTTP 状态
  const key = map[body.error]
  if (key) {
    const detail = Array.isArray(body.issues) && body.issues.length
      ? body.issues.map(issue => t(`episode.design.issue.${issue.code}`)).join(t('common.listJoin'))
      : ''
    toast.error(detail ? `${t(key)}：${detail}` : t(key))
    return
  }
  toastServerMessage(err, { fallback })
}

// ===== 确认 / 取消确认 =====
const confirmBlockReason = computed(() => {
  if (!draft.value.combo) return t('episode.design.issue.combo_missing')
  if (budgetMessage.value) return budgetMessage.value
  if (overLimit.value) {
    return layerOverPct.value > 0
      ? t('episode.design.issue.budget_over_layer')
      : t('episode.design.issue.budget_over_gen')
  }
  const blocking = issues.value.filter(issue => issue.severity === 'block')
  if (blocking.length) return blocking.map(issue => t(`episode.design.issue.${issue.code}`)).join(t('common.listJoin'))
  if (warnOnly.value && !acknowledged.value) return t('episode.design.error.needsAcknowledge')
  return ''
})
const canConfirm = computed(() => !confirmBlockReason.value)

async function confirm() {
  const sb = selected.value
  if (!sb) return
  busy.value = true
  try {
    const res = await storyboardAPI.confirmDesignCard(sb.id, warnOnly.value && acknowledged.value)
    applyResult(sb.id, res)
    emit('refresh')
    loadAudit()
    refreshGates({ background: true })
  } catch (err) {
    reportError(err, 'episode.design.error.confirmFailed')
  } finally {
    busy.value = false
  }
}
async function unconfirm() {
  const sb = selected.value
  if (!sb) return
  busy.value = true
  try {
    const res = await storyboardAPI.unconfirmDesignCard(sb.id)
    applyResult(sb.id, res)
    emit('refresh')
    loadAudit()
    refreshGates({ background: true })
  } catch (err) {
    reportError(err, 'episode.design.error.confirmFailed')
  } finally {
    busy.value = false
  }
}

// ===== 排序：拖拽与上下按钮共用一个提交口 =====
function onDragStart(sb) { dragId.value = sb.id }
function onDrop(targetIndex) {
  const from = shots.value.findIndex(sb => sb.id === dragId.value)
  dragId.value = 0
  if (from < 0 || from === targetIndex) return
  const ids = shots.value.map(sb => sb.id)
  const [moved] = ids.splice(from, 1)
  ids.splice(targetIndex, 0, moved)
  commitOrder(ids)
}
function move(index, delta) {
  const target = index + delta
  if (target < 0 || target >= shots.value.length) return
  const ids = shots.value.map(sb => sb.id)
  const [moved] = ids.splice(index, 1)
  ids.splice(target, 0, moved)
  commitOrder(ids)
}
async function commitOrder(ids) {
  const previous = localOrder.value
  localOrder.value = ids
  try {
    await episodeAPI.reorderStoryboards(props.episodeId, ids)
    toast.success(t('episode.design.order.saved'))
    emit('refresh')
    loadAudit()
  } catch (err) {
    localOrder.value = previous
    toastServerMessage(err, { fallback: 'episode.design.error.orderFailed' })
  }
}

// ===== 批量：先弹范围清单，再执行 =====
/**
 * 批量范围：「AI 填写」只处理 空白/过期，「批量确认」只处理 待审且零问题，
 * 其余逐镜给出被排除的原因（已确认 / AI 填写中 / 有阻断问题 / 有问题 / 状态不符）。
 */
function excludeReasonFor(state, kind) {
  if (state.design_card_status === 'ai_filling') return 'ai_filling'
  if (state.design_card_status === 'confirmed') return 'confirmed'
  if (kind === 'fill') {
    return ['blank', 'stale'].includes(state.design_card_status) ? '' : 'notPending'
  }
  if (state.design_card_status !== 'pending') return 'notPending'
  if ((state.issues || []).some(issue => issue.severity === 'block')) return 'blocked'
  if ((state.issues || []).length) return 'hasIssues'
  return ''
}
function openScope(kind) {
  const include = []
  const exclude = []
  for (const sb of shots.value) {
    const state = stateOf(sb)
    const reason = excludeReasonFor(state, kind)
    if (reason) exclude.push({ storyboard_id: sb.id, shot_number: state.shot_number, reason })
    else include.push({ storyboard_id: sb.id, shot_number: state.shot_number })
  }
  scope.value = { kind, include, exclude }
}
async function runScope() {
  const picked = scope.value
  scope.value = null
  if (!picked) return
  if (picked.kind === 'fill') await startFill(picked.include.map(item => item.storyboard_id))
  else await confirmMany(picked.include.map(item => item.storyboard_id))
}
async function confirmMany(ids) {
  busy.value = true
  let failed = 0
  for (const id of ids) {
    try {
      const res = await storyboardAPI.confirmDesignCard(id, false)
      applyResult(id, res)
    } catch { failed += 1 }
  }
  busy.value = false
  if (failed) toast.error(t('episode.design.error.confirmFailed'))
  emit('refresh')
  loadAudit()
  refreshGates({ background: true })
}

async function startFill(ids) {
  try {
    const res = await episodeAPI.fillDesignCards(props.episodeId, {
      storyboard_ids: ids,
      model: props.chatModel || undefined,
      config_id: props.chatConfigId || undefined,
    })
    if (!res?.total) {
      if (res?.already_running) { batch.value = { running: true, total: 0, completed: 0 }; poll() }
      else toast.info(t('episode.design.fill.allFilled'))
      return
    }
    batch.value = { running: true, total: res.total, completed: 0 }
    toast.info(t('episode.design.fill.started', { n: res.total }))
    poll()
  } catch (err) {
    reportError(err, 'episode.design.error.fillFailed')
  }
}
async function refillOne() {
  if (!selected.value) return
  await startFill([selected.value.id])
}

let pollTimer = null
function poll(attempts = 240) {
  const tick = async (left) => {
    pollTimer = null
    try {
      const st = await episodeAPI.designCardStatus(props.episodeId)
      if (st && st.status !== 'running') {
        batch.value = { running: false, total: 0, completed: 0 }
        overrides.value = {}
        emit('refresh')
        await loadAudit()
        syncDraft()
        if (st.status === 'done') {
          toast.success(st.failed ? t('episode.design.fill.doneFailed', { n: st.failed }) : t('episode.design.fill.done'))
        } else {
          toastError(st.error, { fallback: 'episode.design.error.fillFailed' })
        }
        return
      }
      if (st) {
        const before = batch.value.completed
        batch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
        if ((st.completed || 0) !== before) { overrides.value = {}; emit('refresh'); loadAudit() }
      }
    } catch { /* 静默：轮询失败继续重试 */ }
    if (left > 0) pollTimer = setTimeout(() => tick(left - 1), 5000)
    else batch.value = { running: false, total: 0, completed: 0 }
  }
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => tick(attempts), 5000)
}

// ===== 取数 =====
async function loadContext() {
  if (!props.episodeId) return
  try {
    const data = await episodeAPI.designCardContext(props.episodeId)
    ctx.value = { ...EMPTY_CTX, ...(data || {}), limits: { ...EMPTY_CTX.limits, ...(data?.limits || {}) } }
  } catch (err) {
    toastError(err, { fallback: 'episode.design.error.loadFailed' })
  }
}
async function loadAudit() {
  if (!props.episodeId) return
  try {
    const data = await episodeAPI.designCardAudit(props.episodeId)
    audit.value = Array.isArray(data) ? data : []
  } catch { /* 静默：审计只影响左列状态点与批量范围 */ }
}
async function resumeFill() {
  if (!props.episodeId) return
  try {
    const st = await episodeAPI.designCardStatus(props.episodeId)
    if (st?.status === 'running' && !batch.value.running) {
      batch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
      poll()
    }
  } catch { /* 静默 */ }
}

function ensureSelection() {
  if (!shots.value.length) { selectedId.value = 0; return }
  if (!shots.value.some(sb => sb.id === selectedId.value)) selectedId.value = shots.value[0].id
}

watch(() => props.storyboards, () => {
  flushPending()
  overrides.value = {}
  // 服务端顺序已经追上本地乐观顺序后就放手，之后一律以 props 为准
  if (localOrder.value) {
    const serverIds = props.storyboards.map(sb => sb.id).join(',')
    if (serverIds === localOrder.value.join(',')) localOrder.value = null
  }
  ensureSelection()
  nextTick(syncDraft)
})
// 换镜前先把待写内容提交回原来那一镜，再按新镜的服务端事实重建草稿
watch(selectedId, () => { flushPending(); syncDraft() })
watch(() => props.episodeId, () => {
  overrides.value = {}
  localOrder.value = null
  selectedId.value = 0
  loadContext()
  loadAudit()
  resumeFill()
  refreshGates()
})

onMounted(() => {
  ensureSelection()
  syncDraft()
  loadContext()
  loadAudit()
  resumeFill()
  refreshGates()
})
onBeforeUnmount(() => {
  flushPending()
  if (pollTimer) clearTimeout(pollTimer)
  if (debounceTimer) clearTimeout(debounceTimer)
  pollTimer = null
  debounceTimer = null
})
</script>

<style scoped>
.dc-step { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.dc-bar { display: flex; align-items: center; gap: 8px; }
.dc-tag-run { display: inline-flex; align-items: center; gap: 4px; }

.dc-body { display: grid; grid-template-columns: clamp(220px, 16vw, 300px) minmax(0, 1fr); gap: 10px; flex: 1; min-height: 0; }

.dc-list { display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }
.dc-shot {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-1); font-size: 12px; cursor: pointer; text-align: left;
}
.dc-shot.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.dc-shot-no { min-width: 34px; }
.dc-shot-combo { min-width: 28px; color: var(--text-2); }
.dc-shot-grip { margin-left: auto; display: flex; gap: 2px; }
.dc-move {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 4px; color: var(--text-3); cursor: pointer;
}
.dc-move:hover { background: var(--bg-3); color: var(--text-1); }
.dc-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--text-3); }
.dc-dot.is-blank { background: var(--text-3); }
.dc-dot.is-ai_filling { background: var(--tag-info-text, #4fc3f7); }
.dc-dot.is-pending { background: var(--tag-warning-text, #ffb74d); }
.dc-dot.is-confirmed { background: var(--tag-success-text, #66bb6a); }
.dc-dot.is-stale { background: var(--tag-danger-text, #ef5350); }

.dc-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow-y: auto; padding-right: 4px; }
.dc-card-empty { align-items: center; justify-content: center; color: var(--text-3); font-size: 12px; }
.dc-card-head { display: flex; align-items: center; gap: 8px; }
.dc-state { padding: 1px 6px; border-radius: 999px; font-size: 11px; background: var(--bg-3); color: var(--text-2); }
.dc-state.is-confirmed { color: var(--tag-success-text, #66bb6a); }
.dc-state.is-pending { color: var(--tag-warning-text, #ffb74d); }
.dc-state.is-stale { color: var(--tag-danger-text, #ef5350); }
.dc-stale { font-size: 11px; color: var(--tag-danger-text, #ef5350); }

.dc-section { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.dc-section-head { display: flex; align-items: center; gap: 8px; }
.dc-section-title { font-size: 12px; font-weight: 600; }
.dc-affect {
  padding: 1px 6px; border-radius: 999px;
  background: var(--bg-3); color: var(--text-3); font-size: 11px; cursor: help;
}
.dc-hint { margin: 0; font-size: 11px; color: var(--text-3); }
.dc-field { display: flex; flex-direction: column; gap: 4px; }
.dc-label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }
.dc-read { margin: 0; font-size: 12px; line-height: 1.5; }
.dc-junction { color: var(--text-2); }

.dc-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dc-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 6px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-3); font-size: 11px;
}
.dc-chip.is-unresolved { border-color: var(--tag-danger-text, #ef5350); }
.dc-chip-text { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-chip-select { height: 20px; padding: 0 4px; font-size: 11px; }
.dc-chip-del { border: 0; background: transparent; color: var(--text-3); cursor: pointer; font-size: 12px; line-height: 1; }
.dc-chip-del:hover { color: var(--text-1); }
.dc-chip-add { display: inline-flex; align-items: center; gap: 4px; }
.dc-chip-input { height: 24px; width: 180px; font-size: 11px; }

.dc-rows { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.dc-row { display: flex; align-items: center; gap: 4px; width: 100%; }
.dc-row-type { width: auto; min-width: max-content; flex: 0 0 auto; }
.dc-row-text { flex: 1; min-width: 0; }
.dc-row-at { width: 80px; }
.dc-select { height: 26px; padding: 2px 8px; font-size: 12px; line-height: normal; }
.dc-num { width: 80px; height: 24px; font-size: 12px; }

.dc-combos { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.dc-combo {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-3); color: var(--text-1); text-align: left; cursor: pointer;
}
.dc-combo.on { outline: 2px solid var(--accent); outline-offset: -2px; }
.dc-combo-icons { display: flex; align-items: center; gap: 4px; color: var(--text-2); }
.dc-combo-sug {
  margin-left: auto; padding: 0 5px; border-radius: 999px;
  background: var(--bg-2); color: var(--tag-warning-text, #ffb74d); font-size: 10px;
}
.dc-combo-name { font-size: 12px; font-weight: 600; }
.dc-combo-desc { font-size: 11px; color: var(--text-3); line-height: 1.4; }

.dc-budget { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dc-budget-num { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.dc-budget-limit { font-size: 11px; }
.dc-bar-track { display: flex; align-items: stretch; height: 22px; border-radius: 4px; overflow: hidden; background: var(--bg-3); }
.dc-seg { position: relative; display: flex; align-items: center; justify-content: center; min-width: 0; }
.dc-seg.is-layer { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.dc-seg.is-gen { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dc-seg-over { position: absolute; top: 0; right: 0; bottom: 0; background: color-mix(in srgb, #ef5350 45%, transparent); }
.dc-seg-tick { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text-2); }
.dc-seg-tick.is-over { background: #ef5350; }
.dc-seg-text { position: relative; font-size: 11px; }
.dc-divider { display: flex; align-items: center; padding: 0 2px; cursor: col-resize; color: var(--text-2); font-size: 11px; user-select: none; }

.dc-narr-line { position: relative; display: flex; align-items: center; gap: 6px; height: 16px; }
.dc-narr-fill { position: absolute; left: 0; top: 7px; height: 2px; background: var(--text-3); }
.dc-narr-fill.is-over { background: var(--tag-danger-text, #ef5350); }
.dc-narr-fill.is-tight { background: var(--tag-warning-text, #ffb74d); }
.dc-narr-text { position: relative; font-size: 11px; color: var(--text-2); }

.dc-issues { display: flex; flex-direction: column; gap: 2px; margin: 0; padding-left: 16px; font-size: 11px; }
.dc-issue.is-block { color: var(--tag-danger-text, #ef5350); }
.dc-issue.is-warn { color: var(--tag-warning-text, #ffb74d); }
.dc-ack { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); }

.dc-scope { width: 420px; max-width: calc(100vw - 32px); }
.dc-scope-list { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 0; padding-left: 16px; font-size: 11px; }
</style>
