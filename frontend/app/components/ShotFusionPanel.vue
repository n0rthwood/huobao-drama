<template>
  <section class="fusion-panel">
    <div class="fusion-head">
      <span class="fusion-title">{{ t('episode.compose.section') }}</span>
      <span :class="['fusion-chip', 'is-' + status]">{{ statusLabel }}</span>
      <span v-if="composedSeconds" class="fusion-dim">{{ t('episode.compose.duration', { sec: composedSeconds }) }}</span>
      <span class="ml-auto" />
      <button
        type="button"
        class="btn btn-sm"
        :title="batchRunning ? t('episode.compose.batchAlreadyRunning') : undefined"
        @click="emit('open-batch')"
      >
        <Loader2 v-if="batchRunning" :size="11" class="animate-spin" />
        {{ batchRunning ? t('episode.compose.batchOpenRunning') : t('episode.compose.batch') }}
      </button>
    </div>

    <!-- 输入就绪：视频 / 旁白音频 / 字幕（纯画面镜头不要求音频与字幕） -->
    <div class="fusion-inputs">
      <span v-for="chip in inputChips" :key="chip.key" :class="['fusion-input', chip.ok ? 'is-ok' : 'is-off']">
        {{ chip.label }}
      </span>
      <span v-if="pureVisual" class="fusion-input is-note">{{ t('episode.compose.input.pureVisual') }}</span>
    </div>

    <div v-if="reasonText" :class="['fusion-reason', blocking ? 'is-bad' : 'is-warn']">{{ reasonText }}</div>
    <div v-if="planLine" class="fusion-plan">{{ planLine }}</div>

    <div v-if="status === 'disabled'" class="fusion-hint">{{ t('episode.compose.disabledHint') }}</div>

    <!-- 匹配参数（草稿式）：有音频才有意义 -->
    <template v-if="showFit">
      <button
        type="button"
        class="fusion-collapse"
        :aria-expanded="fitOpen"
        @click="fitOpen = !fitOpen"
      >
        <ChevronRight :size="12" :class="['fusion-caret', { open: fitOpen }]" />
        {{ t('episode.fit.section') }}
        <span v-if="fitDraft.dirty" class="fusion-chip is-changed">{{ t('episode.fit.draft') }}</span>
      </button>
      <NarrationFitPanel
        v-show="fitOpen"
        ref="fitPanel"
        :storyboard="storyboard"
        :episode-fit-default="episodeFitDefault"
        :episode-mix-mode="episodeMixMode"
        @draft-change="onFitDraft"
        @applied="id => emit('refresh', id)"
      />
    </template>

    <div class="fusion-actions">
      <button
        type="button"
        class="btn btn-sm"
        :disabled="!composedUrl"
        :title="composedUrl ? undefined : t('episode.compose.none')"
        @click="emit('preview-fusion')"
      >
        {{ t('episode.compose.viewFusion') }}
      </button>
      <span class="ml-auto" />
      <button
        type="button"
        class="btn btn-primary fusion-cta"
        :disabled="!canCompose"
        :title="composeDisabledReason || undefined"
        @click="runCompose"
      >
        <Loader2 v-if="composing" :size="12" class="animate-spin" />
        {{ ctaLabel }}
      </button>
    </div>
    <div v-if="!canCompose && composeDisabledReason" class="fusion-hint">{{ composeDisabledReason }}</div>
    <div v-if="composeError" class="fusion-reason is-bad">{{ composeError }}</div>
  </section>
</template>

<script setup>
/**
 * 本镜融合区（#42）：右栏首屏显示融合状态、输入就绪与唯一的融合 CTA。
 * 状态与原因一律来自服务端的 compose_state（与批量预览、导出就绪同一口径），
 * 前端不再用「有没有 composed_video_url」自推就绪。
 *
 * CTA 语义只有一个入口：匹配参数有未应用草稿时是「应用参数并合成」，
 * 先应用再合成；旁白文本还在保存中则等待落盘，绝不拿旧参数/旧文本合成。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { storyboardAPI } from '~/composables/useApi'
import { mapError, toastError } from '~/composables/useToast'
import NarrationFitPanel from '~/components/NarrationFitPanel.vue'

const props = defineProps({
  storyboard: { type: Object, default: null },
  // 服务端融合状态（GET /episodes/:id/storyboards 的 compose_state）
  composeState: { type: Object, default: null },
  // 本集旁白总开关：关闭时融合不适用，拼接走原视频
  narrationEnabled: { type: Boolean, default: true },
  // 旁白文本的保存状态 { status, at }：草稿未落盘前不合成
  narrationSave: { type: Object, default: () => ({ status: 'idle', at: 0 }) },
  episodeFitDefault: { type: Object, default: null },
  episodeMixMode: { type: String, default: 'replace' },
  batchRunning: { type: Boolean, default: false },
})
const emit = defineEmits(['composed', 'refresh', 'open-batch', 'preview-fusion'])

const { t } = useI18n()

const composing = ref(false)
const composeError = ref('')
const fitOpen = ref(false)
const fitPanel = ref(null)
const fitDraft = ref({ dirty: false, busy: false })

const sb = computed(() => props.storyboard || {})
const state = computed(() => props.composeState || null)
const status = computed(() => state.value?.status || (props.narrationEnabled ? 'unknown' : 'disabled'))
const inputs = computed(() => state.value?.inputs || { video: false, audio: false, subtitle: false, pure_visual: false })
const pureVisual = computed(() => Boolean(inputs.value.pure_visual))
const composedUrl = computed(() => state.value?.composed_video_url
  || sb.value.composed_video_url || sb.value.composedVideoUrl || '')
const audioUrl = computed(() => sb.value.narration_audio_url || sb.value.narrationAudioUrl || '')
const showFit = computed(() => props.narrationEnabled && !pureVisual.value && Boolean(audioUrl.value))

const statusLabel = computed(() => t(`episode.compose.status${status.value.charAt(0).toUpperCase()}${status.value.slice(1)}`))
const blocking = computed(() => status.value === 'blocked')

const composedSeconds = computed(() => {
  const meta = sb.value.narration_meta || sb.value.narrationMeta || {}
  const ms = Number(meta?.composed?.duration_ms || 0)
  return ms > 0 ? (ms / 1000).toFixed(1) : ''
})

const inputChips = computed(() => {
  const list = [{ key: 'video', ok: Boolean(inputs.value.video), label: t('episode.compose.input.video') }]
  if (props.narrationEnabled && !pureVisual.value) {
    list.push({ key: 'audio', ok: Boolean(inputs.value.audio), label: t('episode.compose.input.audio') })
    list.push({ key: 'subtitle', ok: Boolean(inputs.value.subtitle), label: t('episode.compose.input.subtitle') })
  }
  return list
})

const reasonText = computed(() => {
  const parts = []
  if (state.value?.reason) parts.push(state.value.reason)
  for (const r of state.value?.change_reasons || []) parts.push(r)
  return parts.join(t('common.listJoin'))
})

const planLine = computed(() => {
  const plan = state.value?.plan
  if (!plan || typeof plan.d !== 'number') return ''
  return t('episode.compose.planLine', {
    dv: Number(plan.dv || 0).toFixed(1),
    da: Number(plan.da || 0).toFixed(1),
    d: Number(plan.d || 0).toFixed(1),
    tr: Number(plan.t || 0).toFixed(1),
  })
})

const selectable = computed(() => (state.value ? Boolean(state.value.selectable) : Boolean(sb.value.video_url || sb.value.videoUrl)))
const composeDisabledReason = computed(() => {
  if (status.value === 'disabled') return t('episode.compose.disabledHint')
  if (status.value === 'skipped') return state.value?.reason || t('episode.compose.statusSkipped')
  if (!selectable.value) return state.value?.reason || t('episode.compose.needVideo')
  if (props.narrationSave?.status === 'saving') return t('episode.compose.draftSaving')
  return ''
})
const canCompose = computed(() => !composing.value && !fitDraft.value.busy && !composeDisabledReason.value)

const ctaLabel = computed(() => {
  if (fitDraft.value.dirty) return t('episode.compose.applyCompose')
  return composedUrl.value ? t('episode.compose.recompose') : t('episode.compose.composeShot')
})

function onFitDraft(payload) {
  fitDraft.value = { dirty: Boolean(payload?.dirty), busy: Boolean(payload?.busy) }
}

watch(() => props.storyboard?.id, () => {
  composeError.value = ''
  fitDraft.value = { dirty: false, busy: false }
})

/** 旁白文本失焦保存是异步的：等它落盘再合成，避免产物对应的是旧文本 */
async function narrationSettled() {
  const deadline = Date.now() + 8000
  while (props.narrationSave?.status === 'saving' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  if (props.narrationSave?.status === 'saving') {
    toast.error(t('episode.compose.draftSaving'))
    return false
  }
  if (props.narrationSave?.status === 'error') {
    toast.error(t('episode.compose.draftFailed'))
    return false
  }
  return true
}

function renderComposeBlocked(err) {
  const body = err?.body
  const reason = body?.block_reason
  if (!reason) return false
  const key = reason === 'narration_gap_too_large' || reason === 'narration_too_long'
    ? `episode.fit.blocked.${reason}`
    : 'episode.fit.blocked.unknown'
  composeError.value = t(key, {
    gap: Math.round(Math.abs(Number(body.gap_ratio) || 0) * 100),
    current: (Number(body.current_sec) || 0).toFixed(1),
    avail: (Number(body.avail_sec) || 0).toFixed(1),
    chars: Number(body.suggested_chars) || 0,
  })
  return true
}

async function runCompose() {
  const target = props.storyboard
  if (!target?.id || !canCompose.value) return
  const targetId = target.id
  composing.value = true
  composeError.value = ''
  try {
    if (!await narrationSettled()) return
    if (props.storyboard?.id !== targetId) return
    // 有草稿就先应用：被阻断时面板已显示原因，不继续用旧参数合成
    if (fitDraft.value.dirty && !(await fitPanel.value?.apply())) return
    if (props.storyboard?.id !== targetId) return
    const res = await storyboardAPI.compose(targetId)
    toast.success(t('episode.compose.doneSec', { sec: (Number(res?.durationMs || 0) / 1000).toFixed(1) }))
    // 结果只回到发起的那一镜：切镜后不抢当前预览
    emit('composed', targetId)
  } catch (e) {
    if (props.storyboard?.id !== targetId) {
      toastError(e, { fallback: 'episode.compose.failed' })
      return
    }
    if (!renderComposeBlocked(e)) {
      composeError.value = mapError(e, { fallback: 'episode.compose.failed' })
      toastError(e, { fallback: 'episode.compose.failed' })
    }
  } finally {
    composing.value = false
  }
}
</script>

<style scoped>
.fusion-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
  background: var(--surface-soft);
}
.fusion-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fusion-title { font-size: 13px; font-weight: 700; color: var(--accent); }
.fusion-dim { font-size: 11px; color: var(--text-3); }
.fusion-chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-2);
  color: var(--text-2);
  white-space: nowrap;
}
.fusion-chip.is-unchanged { color: var(--tag-success-text, var(--text-2)); }
.fusion-chip.is-missing,
.fusion-chip.is-changed { color: var(--action-primary); background: var(--action-primary-bg, var(--bg-2)); font-weight: 600; }
.fusion-chip.is-unknown,
.fusion-chip.is-skipped { color: var(--tag-warning-text); background: var(--surface-muted); }
.fusion-chip.is-blocked { color: var(--action-danger); background: var(--action-danger-bg); }
.fusion-inputs { display: flex; gap: 5px; flex-wrap: wrap; }
.fusion-input {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--surface-muted);
  color: var(--text-3);
}
.fusion-input.is-ok { color: var(--tag-success-text, var(--text-2)); }
.fusion-input.is-off { color: var(--action-danger); background: var(--action-danger-bg); }
.fusion-reason { font-size: 11px; word-break: break-word; }
.fusion-reason.is-bad { color: var(--action-danger); }
.fusion-reason.is-warn { color: var(--tag-warning-text); }
.fusion-plan,
.fusion-hint { font-size: 11px; color: var(--text-3); }
.fusion-collapse {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 0;
  border: none;
  background: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  cursor: pointer;
}
.fusion-caret { transition: transform 0.15s; }
.fusion-caret.open { transform: rotate(90deg); }
.fusion-actions { display: flex; align-items: center; gap: 6px; }
.fusion-cta { min-width: 128px; justify-content: center; }
</style>
