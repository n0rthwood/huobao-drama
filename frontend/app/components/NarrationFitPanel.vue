<template>
  <div class="fit-panel">
    <div class="fit-head">
      <span class="fit-label">{{ t('episode.fit.section') }}</span>
      <span v-if="preview?.inherited" class="fit-badge" :title="episodeDefaultLabel">{{ t('episode.fit.inherited') }}</span>
      <button
        v-if="preview && !preview.inherited"
        type="button"
        class="btn btn-sm"
        :disabled="busy"
        @click="restoreInherit"
      >
        {{ t('episode.fit.restoreInherit') }}
      </button>
      <span class="ml-auto" />
      <Loader2 v-if="loading" :size="11" class="animate-spin" />
    </div>

    <div v-if="preview" class="fit-status">{{ statusLine }}</div>

    <div v-if="blockedHint" class="fit-issue">{{ blockedHint }}</div>

    <template v-if="preview">
      <div class="fit-row">
        <label class="fit-radio">
          <input type="radio" value="pad" :checked="mode === 'pad'" :disabled="busy" @change="setMode('pad')" />
          {{ t('episode.fit.modePad') }}
        </label>
        <label class="fit-radio" :class="{ 'is-disabled': !preview.tempo_available }">
          <input
            type="radio"
            value="tempo"
            :checked="mode === 'tempo'"
            :disabled="busy || !preview.tempo_available"
            @change="setMode('tempo')"
          />
          {{ t('episode.fit.modeTempo') }}
        </label>
        <span v-if="!preview.tempo_available" class="fit-hint">
          {{ t('episode.fit.tempoUnavailable', { n: preview.suggested_chars }) }}
        </span>
      </div>

      <div v-if="mode === 'pad'" class="fit-row">
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
          <input type="radio" :checked="padPosition === 'head'" :disabled="busy" @change="setPadPosition('head')" />
          {{ t('episode.fit.padHead') }}
        </label>
        <label class="fit-radio">
          <input type="radio" :checked="padPosition === 'tail'" :disabled="busy" @change="setPadPosition('tail')" />
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
            :value="preview.tempo"
            :disabled="busy"
            @change="setTempoOverride($event.target.value)"
          />
          <span class="fit-hint">{{ tempoText }}×</span>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="busy || preview.tempo_override === null"
            @click="setTempoOverride(null)"
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
          :model-value="mixValue"
          :options="mixOptions"
          :searchable="false"
          @update:model-value="setMixMode"
        />
      </div>

      <div class="fit-row">
        <button type="button" class="btn btn-sm" :disabled="!audioUrl" @click="togglePreviewAudio">
          {{ playing ? t('episode.fit.stop') : t('episode.fit.preview') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy || !hasVideo" @click="applyAndCompose">
          <Loader2 v-if="composing" :size="11" class="animate-spin" />
          {{ t('episode.fit.applyCompose') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 旁白与画面的时长/音轨匹配面板（#31 C.1）。
 * 读写只有三个接口：narration-fit preview / PUT / DELETE；「试听」是纯前端
 * （playbackRate + preservesPitch），不发任何请求。阻断按 block_reason 渲染，
 * 不解析后端中文 message。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { storyboardAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { toast } from 'vue-sonner'
import BaseSelect from '~/components/BaseSelect.vue'

const props = defineProps({
  storyboard: { type: Object, default: null },
  // 剧集级默认匹配（已解析的对象 { mode, pad_ms, pad_position }），用于「继承」项展示
  episodeFitDefault: { type: Object, default: null },
  // 剧集级音轨模式：replace | mix
  episodeMixMode: { type: String, default: 'replace' },
})
const emit = defineEmits(['refresh'])

const { t } = useI18n()

const preview = ref(null)
const loading = ref(false)
const saving = ref(false)
const composing = ref(false)
const advanced = ref(false)
const blockedHint = ref('')
const busy = computed(() => loading.value || saving.value || composing.value)

const sb = computed(() => props.storyboard || {})
const audioUrl = computed(() => sb.value.narration_audio_url || sb.value.narrationAudioUrl || '')
const hasVideo = computed(() => Boolean(sb.value.video_url || sb.value.videoUrl))

const mode = computed(() => preview.value?.mode || 'pad')
const padSeconds = computed(() => ((preview.value?.pad_ms || 0) / 1000).toFixed(1))
const padPosition = computed(() => preview.value?.pad_position || 'tail')
const tempoText = computed(() => (preview.value?.tempo ?? 1).toFixed(2))

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

const mixValue = computed(() => {
  // 本镜未覆盖时显示「继承」；覆盖后显示具体值
  if (!preview.value || preview.value.inherited) return ''
  return preview.value.audio_mix_mode === props.episodeMixMode ? '' : preview.value.audio_mix_mode
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

async function load() {
  if (!props.storyboard?.id) { preview.value = null; return }
  loading.value = true
  try {
    preview.value = await storyboardAPI.narrationFitPreview(props.storyboard.id)
  } catch (e) {
    toastError(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.storyboard?.id, () => { stopPreviewAudio(); blockedHint.value = ''; advanced.value = false; void load() })

/** 当前已生效的参数 + 本次改动，整体提交（后端按整条记录校验） */
function currentBody(patch) {
  const p = preview.value
  const body = {
    mode: p?.mode || 'pad',
    pad_ms: p?.pad_ms ?? 0,
    pad_position: p?.pad_position || 'tail',
    tempo_override: p?.tempo_override ?? null,
    ...patch,
  }
  // 空字符串 = 继承剧集音轨模式：不带该键
  const mix = patch && 'audio_mix_mode' in patch ? patch.audio_mix_mode : mixValue.value
  if (mix) body.audio_mix_mode = mix
  else delete body.audio_mix_mode
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

async function save(patch) {
  if (!props.storyboard?.id || saving.value) return false
  saving.value = true
  blockedHint.value = ''
  try {
    preview.value = await storyboardAPI.saveNarrationFit(props.storyboard.id, currentBody(patch))
    return true
  } catch (e) {
    if (!renderBlocked(e)) toastError(e)
    return false
  } finally {
    saving.value = false
  }
}

function setMode(next) {
  if (next === mode.value) return
  // 倍速默认不持久化倍率：只切模式，合成时按实测时长现算
  void save(next === 'tempo' ? { mode: 'tempo', tempo_override: null } : { mode: 'pad' })
}

function setPadSeconds(value) {
  const max = preview.value?.limits?.max_pad_seconds ?? 3
  const sec = Math.min(Math.max(Number(value) || 0, 0), max)
  void save({ mode: 'pad', pad_ms: Math.round(sec * 1000) })
}

function setPadPosition(pos) {
  if (pos === padPosition.value) return
  void save({ mode: 'pad', pad_position: pos })
}

function setTempoOverride(value) {
  void save({ mode: 'tempo', tempo_override: value === null ? null : Number(value) })
}

function setMixMode(value) {
  void save({ audio_mix_mode: value || undefined })
}

async function restoreInherit() {
  if (!props.storyboard?.id || busy.value) return
  saving.value = true
  blockedHint.value = ''
  try {
    preview.value = await storyboardAPI.clearNarrationFit(props.storyboard.id)
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function applyAndCompose() {
  if (!props.storyboard?.id || busy.value) return
  if (!await save({})) return
  composing.value = true
  try {
    await storyboardAPI.compose(props.storyboard.id)
    toast.success(t('episode.compose.done'))
    emit('refresh')
  } catch (e) {
    toastError(e)
  } finally {
    composing.value = false
  }
}

// ── 试听：纯前端，零请求。按生效倍率变速播放，pad 在旁白前时延后起播 ──
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
  const tempo = mode.value === 'tempo' ? (preview.value?.tempo || 1) : 1
  audioEl.preservesPitch = true
  audioEl.playbackRate = tempo
  audioEl.currentTime = 0
  playing.value = true
  const delay = mode.value === 'pad' && padPosition.value === 'head' ? (preview.value?.pad_ms || 0) : 0
  const start = () => { startTimer = null; void audioEl.play().catch(() => { playing.value = false }) }
  if (delay > 0) startTimer = setTimeout(start, delay)
  else start()
}

onBeforeUnmount(stopPreviewAudio)
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
.fit-status,
.fit-hint {
  font-size: 11px;
  color: var(--text-3);
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
