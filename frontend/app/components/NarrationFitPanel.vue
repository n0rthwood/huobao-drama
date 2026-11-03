<template>
  <div class="fit-panel">
    <div class="fit-head">
      <span class="fit-label">{{ t('episode.fit.section') }}</span>
      <span v-if="preview?.inherited && !dirty" class="fit-badge" :title="episodeDefaultLabel">{{ t('episode.fit.inherited') }}</span>
      <span v-if="dirty" class="fit-badge is-draft">{{ t('episode.fit.draft') }}</span>
      <span class="ml-auto" />
      <Loader2 v-if="loading" :size="11" class="animate-spin" />
      <button
        v-if="preview && !preview.inherited && !dirty"
        type="button"
        class="btn btn-sm"
        :disabled="busy"
        @click="restoreInherit"
      >
        {{ t('episode.fit.restoreInherit') }}
      </button>
    </div>

    <div v-if="preview" class="fit-status">{{ statusLine }}</div>
    <div v-if="dirty" class="fit-draft-hint">{{ t('episode.fit.draftHint') }}</div>

    <div v-if="blockedHint" class="fit-issue">{{ blockedHint }}</div>

    <template v-if="preview && draft">
      <div class="fit-row">
        <label class="fit-radio">
          <input type="radio" value="pad" :checked="draft.mode === 'pad'" :disabled="busy" @change="setMode('pad')" />
          {{ t('episode.fit.modePad') }}
        </label>
        <label class="fit-radio" :class="{ 'is-disabled': !preview.tempo_available }">
          <input
            type="radio"
            value="tempo"
            :checked="draft.mode === 'tempo'"
            :disabled="busy || !preview.tempo_available"
            @change="setMode('tempo')"
          />
          {{ t('episode.fit.modeTempo') }}
        </label>
        <span v-if="!preview.tempo_available" class="fit-hint">
          {{ t('episode.fit.tempoUnavailable', { n: preview.suggested_chars }) }}
        </span>
      </div>

      <div v-if="draft.mode === 'pad'" class="fit-row">
        <label class="fit-field">
          {{ t('episode.fit.padSeconds') }}
          <input
            class="input fit-num"
            type="number"
            min="0"
            :max="preview.limits.max_pad_seconds"
            step="0.1"
            :value="padSeconds"
            :disabled="busy"
            @change="setPadSeconds($event.target.value)"
          />
        </label>
        <label class="fit-radio">
          <input type="radio" :checked="draft.pad_position === 'head'" :disabled="busy" @change="draft.pad_position = 'head'" />
          {{ t('episode.fit.padHead') }}
        </label>
        <label class="fit-radio">
          <input type="radio" :checked="draft.pad_position === 'tail'" :disabled="busy" @change="draft.pad_position = 'tail'" />
          {{ t('episode.fit.padTail') }}
        </label>
      </div>

      <template v-else>
        <div class="fit-row">
          <span class="fit-hint">{{ t('episode.fit.tempoCurrent', { tempo: tempoText }) }}</span>
          <button type="button" class="btn btn-sm" :disabled="busy" @click="advanced = !advanced">
            {{ t('episode.fit.advanced') }}
          </button>
        </div>
        <div v-if="advanced" class="fit-row">
          <input
            class="fit-range"
            type="range"
            :min="preview.limits.min_tempo"
            :max="preview.limits.max_tempo"
            step="0.01"
            :value="draft.tempo_override ?? preview.tempo"
            :disabled="busy"
            @change="draft.tempo_override = Number($event.target.value)"
          />
          <span class="fit-hint">{{ tempoText }}×</span>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="busy || draft.tempo_override === null"
            @click="draft.tempo_override = null"
          >
            {{ t('episode.fit.tempoAuto') }}
          </button>
          <span class="fit-hint">{{ t('episode.fit.tempoAutoHint') }}</span>
        </div>
      </template>

      <div class="fit-row">
        <span class="fit-hint">{{ t('episode.fit.mixLabel') }}</span>
        <BaseSelect
          class="fit-select"
          :model-value="draft.audio_mix_mode"
          :options="mixOptions"
          :searchable="false"
          @update:model-value="v => { draft.audio_mix_mode = v || '' }"
        />
      </div>

      <div class="fit-row">
        <button type="button" class="btn btn-sm" :disabled="!audioUrl" @click="togglePreviewAudio">
          {{ playing ? t('episode.fit.stop') : t('episode.fit.preview') }}
        </button>
        <span class="ml-auto" />
        <button v-if="dirty" type="button" class="btn btn-sm" :disabled="busy" @click="resetDraft">
          {{ t('episode.fit.discard') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy || !dirty" @click="apply">
          <Loader2 v-if="saving" :size="11" class="animate-spin" />
          {{ t('episode.fit.apply') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 旁白与画面的时长/音轨匹配面板（#31 C.1，#42 改为显式草稿）。
 * 读写只有三个接口：narration-fit preview / PUT / DELETE；「试听」是纯前端
 * （playbackRate + preservesPitch），不发任何请求。阻断按 block_reason 渲染，
 * 不解析后端中文 message。
 *
 * #42：参数改动先进本地草稿，必须显式「应用参数」才写服务端 —— 融合 CTA 据此
 * 显示「应用参数并合成」，既不会丢草稿，也不会拿旧参数悄悄合成。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { storyboardAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import BaseSelect from '~/components/BaseSelect.vue'

const props = defineProps({
  storyboard: { type: Object, default: null },
  // 剧集级默认匹配（已解析的对象 { mode, pad_ms, pad_position }），用于「继承」项展示
  episodeFitDefault: { type: Object, default: null },
  // 剧集级音轨模式：replace | mix
  episodeMixMode: { type: String, default: 'replace' },
})
const emit = defineEmits(['draft-change', 'applied'])

const { t } = useI18n()

const preview = ref(null)
const draft = ref(null)
const loading = ref(false)
const saving = ref(false)
const advanced = ref(false)
const blockedHint = ref('')
const busy = computed(() => loading.value || saving.value)

const sb = computed(() => props.storyboard || {})
const audioUrl = computed(() => sb.value.narration_audio_url || sb.value.narrationAudioUrl || '')

const padSeconds = computed(() => ((draft.value?.pad_ms || 0) / 1000).toFixed(1))
const tempoText = computed(() => Number(draft.value?.tempo_override ?? preview.value?.tempo ?? 1).toFixed(2))

/** 已生效值（服务端口径）：草稿与之比较得出「有未应用的修改」 */
const baseline = computed(() => {
  const p = preview.value
  if (!p) return null
  return {
    mode: p.mode || 'pad',
    pad_ms: p.pad_ms ?? 0,
    pad_position: p.pad_position || 'tail',
    tempo_override: p.tempo_override ?? null,
    audio_mix_mode: p.inherited || p.audio_mix_mode === props.episodeMixMode ? '' : p.audio_mix_mode,
  }
})
const dirty = computed(() => Boolean(draft.value && baseline.value
  && JSON.stringify(draft.value) !== JSON.stringify(baseline.value)))

const statusLine = computed(() => {
  const plan = preview.value?.plan
  if (!plan) return ''
  const params = { audio: plan.da.toFixed(1), avail: plan.availSeconds.toFixed(1) }
  const pct = Math.round(Math.abs(plan.gapRatio) * 100)
  if (pct === 0) return t('episode.fit.statusExact', params)
  return plan.gapRatio > 0
    ? t('episode.fit.statusOver', { ...params, gap: pct })
    : t('episode.fit.statusShort', { ...params, gap: pct })
})

const episodeMixLabel = computed(() =>
  props.episodeMixMode === 'mix' ? t('episode.fit.mixMix') : t('episode.fit.mixReplace'))
// 「继承集级默认」徽标的悬浮说明：展示剧集默认的匹配方式与留白
const episodeDefaultLabel = computed(() => {
  const d = props.episodeFitDefault
  if (!d) return t('episode.fit.episodeDefaultUnset')
  if (d.mode === 'tempo') return t('episode.fit.episodeDefaultTempo')
  return t('episode.fit.episodeDefaultPad', {
    sec: ((Number(d.pad_ms) || 0) / 1000).toFixed(1),
    pos: d.pad_position === 'head' ? t('episode.fit.padHead') : t('episode.fit.padTail'),
  })
})
const mixOptions = computed(() => [
  { label: t('episode.fit.mixInherit', { mode: episodeMixLabel.value }), value: '' },
  { label: t('episode.fit.mixReplace'), value: 'replace' },
  { label: t('episode.fit.mixMix'), value: 'mix' },
])

function resetDraft() {
  draft.value = baseline.value ? { ...baseline.value } : null
  blockedHint.value = ''
}

// 预览请求竞态：切镜头快时只认最后一次响应
let seq = 0
async function load() {
  if (!props.storyboard?.id) { preview.value = null; draft.value = null; return }
  const my = ++seq
  loading.value = true
  try {
    const res = await storyboardAPI.narrationFitPreview(props.storyboard.id)
    if (my !== seq) return
    preview.value = res
    resetDraft()
  } catch (e) {
    if (my === seq) toastError(e)
  } finally {
    if (my === seq) loading.value = false
  }
}

onMounted(load)
watch(() => props.storyboard?.id, () => {
  stopPreviewAudio()
  blockedHint.value = ''
  advanced.value = false
  preview.value = null
  draft.value = null
  void load()
})

watch([dirty, busy], () => emit('draft-change', { dirty: dirty.value, busy: busy.value }), { immediate: true })

/** 草稿整体提交（后端按整条记录校验）；空音轨模式 = 继承剧集，不带该键 */
function bodyOf(d) {
  const body = {
    mode: d.mode || 'pad',
    pad_ms: d.pad_ms ?? 0,
    pad_position: d.pad_position || 'tail',
    tempo_override: d.tempo_override ?? null,
  }
  if (d.audio_mix_mode) body.audio_mix_mode = d.audio_mix_mode
  return body
}

function renderBlocked(err) {
  const body = err?.body
  const reason = body?.block_reason
  if (!reason) return false
  const params = {
    gap: Math.round(Math.abs(Number(body.gap_ratio) || 0) * 100),
    current: (Number(body.current_sec) || 0).toFixed(1),
    avail: (Number(body.avail_sec) || 0).toFixed(1),
    chars: Number(body.suggested_chars) || 0,
  }
  const key = reason === 'narration_gap_too_large' || reason === 'narration_too_long'
    ? `episode.fit.blocked.${reason}`
    : 'episode.fit.blocked.unknown'
  blockedHint.value = t(key, params)
  return true
}

/** 显式应用草稿；无改动直接成功。返回 false = 被阻断/失败，调用方不要继续合成 */
async function apply() {
  if (!props.storyboard?.id || saving.value) return false
  if (!dirty.value) return true
  const my = ++seq
  saving.value = true
  blockedHint.value = ''
  try {
    const res = await storyboardAPI.saveNarrationFit(props.storyboard.id, bodyOf(draft.value))
    if (my !== seq) return false
    preview.value = res
    resetDraft()
    emit('applied', props.storyboard.id)
    return true
  } catch (e) {
    if (my === seq && !renderBlocked(e)) toastError(e)
    return false
  } finally {
    if (my === seq) saving.value = false
  }
}

function setMode(next) {
  if (!draft.value || next === draft.value.mode) return
  // 倍速默认不持久化倍率：只切模式，合成时按实测时长现算
  draft.value = { ...draft.value, mode: next, tempo_override: next === 'tempo' ? null : draft.value.tempo_override }
}

function setPadSeconds(value) {
  if (!draft.value) return
  const max = preview.value?.limits?.max_pad_seconds ?? 3
  const sec = Math.min(Math.max(Number(value) || 0, 0), max)
  draft.value = { ...draft.value, mode: 'pad', pad_ms: Math.round(sec * 1000) }
}

async function restoreInherit() {
  if (!props.storyboard?.id || busy.value) return
  const my = ++seq
  saving.value = true
  blockedHint.value = ''
  try {
    const res = await storyboardAPI.clearNarrationFit(props.storyboard.id)
    if (my !== seq) return
    preview.value = res
    resetDraft()
    emit('applied', props.storyboard.id)
  } catch (e) {
    if (my === seq) toastError(e)
  } finally {
    if (my === seq) saving.value = false
  }
}

// ── 试听：纯前端，零请求。按草稿倍率变速播放，pad 在旁白前时延后起播 ──
const playing = ref(false)
let audioEl = null
let startTimer = null

function stopPreviewAudio() {
  if (startTimer) { clearTimeout(startTimer); startTimer = null }
  if (audioEl) { audioEl.pause(); audioEl.currentTime = 0 }
  playing.value = false
}

function togglePreviewAudio() {
  if (playing.value) { stopPreviewAudio(); return }
  if (!audioUrl.value) return
  const src = mediaUrl(audioUrl.value)
  if (!audioEl) {
    audioEl = new Audio(src)
    audioEl.addEventListener('ended', () => { playing.value = false })
  } else if (audioEl.src !== src && !audioEl.src.endsWith(src)) {
    audioEl.src = src
  }
  const tempo = draft.value?.mode === 'tempo' ? Number(draft.value.tempo_override ?? preview.value?.tempo ?? 1) : 1
  audioEl.preservesPitch = true
  audioEl.playbackRate = tempo
  audioEl.currentTime = 0
  playing.value = true
  const delay = draft.value?.mode === 'pad' && draft.value.pad_position === 'head' ? (draft.value.pad_ms || 0) : 0
  const start = () => { startTimer = null; void audioEl.play().catch(() => { playing.value = false }) }
  if (delay > 0) startTimer = setTimeout(start, delay)
  else start()
}

onBeforeUnmount(() => { seq += 1; stopPreviewAudio() })

defineExpose({ apply, dirty })
</script>

<style scoped>
.fit-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-muted);
}
.fit-head,
.fit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.fit-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.fit-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-2);
  background: var(--surface-soft);
}
.fit-badge.is-draft {
  color: var(--action-danger);
  background: var(--action-danger-bg);
  font-weight: 600;
}
.fit-status,
.fit-hint {
  font-size: 11px;
  color: var(--text-3);
}
.fit-draft-hint {
  font-size: 11px;
  color: var(--tag-warning-text);
}
.fit-issue {
  border: 1px solid var(--action-danger);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--action-danger);
}
.fit-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
}
.fit-radio.is-disabled {
  opacity: 0.5;
}
.fit-field {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2);
}
.fit-num {
  width: 72px;
}
.fit-range {
  width: 160px;
}
.fit-select {
  min-width: 148px;
}
</style>
