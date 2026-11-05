<template>
  <div class="sb-root">
    <span class="sb-head mono">#{{ shotNo }}</span>
    <span class="sb-combo">{{ t('episode.segment.comboLabel', { combo, glyph: comboGlyph }) }}</span>
    <span class="sb-budget mono">{{ budgetText }}</span>

    <div class="sb-track">
      <button
        v-if="hasLayer"
        type="button"
        :class="['sb-seg', 'is-layer', { on: active === 'layer' }]"
        :style="{ flexGrow: layerSeconds || 1, order: genFirst ? 3 : 1 }"
        @click="emit('update:active', 'layer')"
      >
        <span class="sb-seg-glyph">▣</span>
        <span class="sb-seg-name">{{ t('episode.segment.layerName') }}</span>
        <span class="sb-seg-time mono">{{ layerSeconds.toFixed(1) }}s</span>
        <span :class="['sb-seg-state', 'is-' + layerStatus]">{{ t(`episode.segment.status.${layerStatus}`) }}</span>
      </button>

      <!-- ◆ 衔接帧：图层段与生成段之间那一帧，锁定继承，不单独出图 -->
      <button
        v-if="hasLayer && hasGen"
        type="button"
        :class="['sb-junction', { stale: junction && junction.stale }]"
        :style="{ order: 2 }"
        :title="junctionTip"
        @click="emit('open-junction')"
      >
        <img v-if="junctionSrc" class="sb-junction-img" :src="junctionSrc" alt="">
        <span v-else class="sb-junction-empty">◆</span>
        <span class="sb-junction-lock">🔒</span>
      </button>

      <button
        v-if="hasGen"
        type="button"
        :class="['sb-seg', 'is-gen', { on: active === 'generated' }]"
        :style="{ flexGrow: genSeconds || 1, order: genFirst ? 1 : 3 }"
        @click="emit('update:active', 'generated')"
      >
        <span class="sb-seg-glyph">▶</span>
        <span class="sb-seg-name">{{ t('episode.segment.generatedName') }}</span>
        <span class="sb-seg-time mono">{{ genSeconds.toFixed(1) }}s</span>
        <span :class="['sb-seg-state', 'is-' + genStatus]">{{ t(`episode.segment.status.${genStatus}`) }}</span>
      </button>
    </div>

    <span v-if="budgetMismatch" class="sb-mismatch">
      {{ t('episode.segment.budgetMismatch', {
        actual: Number(budgetMismatch.actual || 0).toFixed(1),
        budget: Number(budgetMismatch.budget || 0).toFixed(1),
      }) }}
    </span>

    <span class="ml-auto" />
    <button type="button" class="btn btn-sm" @click="emit('rehearse')">{{ t('episode.segment.rehearse') }}</button>
    <button type="button" class="btn btn-sm" @click="emit('switch-combo')">{{ t('episode.segment.switchCombo') }}</button>
  </div>
</template>

<script setup>
/**
 * 段结构条（Issue #58）：一镜的段组合一眼看全——按真实时长比例分宽的 ▣/▶ 段头、
 * 中间锁定的 ◆ 衔接帧，右侧「预演本镜 / 改组合」。点击段头切换下方编辑器。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { layerSegmentAPI } from '~/composables/useApi'

const props = defineProps({
  shotNumber: { type: Number, default: 0 },
  storyboardId: { type: Number, required: true },
  combo: { type: String, default: '' },
  active: { type: String, default: 'layer' },
  // GET /layer-segments/storyboards/:id 的 segment / junction / issues
  segment: { type: Object, default: null },
  junction: { type: Object, default: null },
  issues: { type: Array, default: () => [] },
  // 设计卡预算 { layer_s, gen_s }
  budget: { type: Object, default: () => ({}) },
  // 生成段状态：draft | ready | stale | failed
  generatedStatus: { type: String, default: 'draft' },
})
const emit = defineEmits(['update:active', 'rehearse', 'switch-combo', 'open-junction'])
const { t } = useI18n()

const COMBO_GLYPH = { A: '▣', B: '▶', C: '▣→▶', D: '▶→▣' }

const shotNo = computed(() => String(props.shotNumber || 0).padStart(2, '0'))
const comboGlyph = computed(() => COMBO_GLYPH[props.combo] || '')
const hasLayer = computed(() => props.combo === 'A' || props.combo === 'C' || props.combo === 'D')
const hasGen = computed(() => props.combo === 'B' || props.combo === 'C' || props.combo === 'D')

const layerSeconds = computed(() => Number(props.segment?.duration || props.budget?.layer_s || 0))
const genSeconds = computed(() => Number(props.budget?.gen_s || 0))
const genFirst = computed(() => props.combo === 'D')
const budgetText = computed(() => {
  const parts = []
  if (hasLayer.value) parts.push(Number(props.budget?.layer_s || 0).toFixed(1))
  if (hasGen.value) parts.push(Number(props.budget?.gen_s || 0).toFixed(1))
  // D = 先生成段后图层段，预算也按放映顺序写
  if (genFirst.value && parts.length === 2) parts.reverse()
  return t('episode.segment.budget', { value: parts.join('+') })
})

const layerStatus = computed(() => {
  const segment = props.segment
  if (!segment) return 'draft'
  if (segment.status === 'failed') return 'failed'
  if (segment.status === 'rendering') return 'rendering'
  if (!segment.render_path) return 'draft'
  return segment.fresh ? 'ready' : 'stale'
})
const genStatus = computed(() => props.generatedStatus)

const junctionSrc = computed(() => {
  const junction = props.junction
  if (!junction?.path) return ''
  return layerSegmentAPI.junctionUrl(props.storyboardId, junction.hash || Date.now())
})
const junctionTip = computed(() => {
  const at = Number(props.junction?.t || 0).toFixed(1)
  return props.combo === 'D'
    ? t('episode.segment.junctionTipD', { t: at })
    : t('episode.segment.junctionTipC', { t: at })
})
const budgetMismatch = computed(() => props.issues.find(issue => issue.code === 'budget_mismatch') || null)
</script>

<style scoped>
.sb-root { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-card); }
.sb-head { font-size: 12px; color: var(--text-2); }
.sb-combo { font-size: 12px; }
.sb-budget { font-size: 11px; color: var(--text-3); }
.sb-track { flex: 1; min-width: 160px; display: flex; align-items: stretch; gap: 4px; }
.sb-seg {
  display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 8px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface-base); cursor: pointer; font-size: 12px;
}
.sb-seg.on { border-color: var(--accent); }
.sb-seg-glyph { color: var(--text-2); }
.sb-seg-name { white-space: nowrap; }
.sb-seg-time { font-size: 11px; color: var(--text-3); }
.sb-seg-state { font-size: 11px; color: var(--text-3); }
.sb-seg-state.is-ready { color: #2e8b57; }
.sb-seg-state.is-stale { color: #8a6508; }
.sb-seg-state.is-failed { color: #c0472e; }
.sb-junction {
  position: relative; width: 48px; height: 32px; padding: 0; overflow: hidden;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface-base); cursor: pointer;
}
.sb-junction.stale { border-color: #d8a93a; animation: sb-blink 1.2s ease-in-out infinite; }
.sb-junction-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sb-junction-empty { font-size: 14px; color: var(--text-3); }
.sb-junction-lock { position: absolute; right: 1px; bottom: 0; font-size: 9px; }
.sb-mismatch { font-size: 11px; color: #8a6508; }
@keyframes sb-blink { 50% { box-shadow: 0 0 0 2px rgba(216, 169, 58, 0.5); } }
</style>
