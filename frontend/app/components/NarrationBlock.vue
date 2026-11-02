<template>
  <section class="narration-block">
    <div class="narration-head">
      <span class="narration-label">{{ t('episode.narration.section') }}</span>
      <FieldSaveStatus :status="fieldSave.status" :at="fieldSave.at" />
      <span v-if="status === 'voice_stale'" class="narration-badge is-stale">{{ t('episode.narration.stale') }}</span>
      <span v-if="subtitleEstimated" class="narration-badge is-warn">{{ t('episode.narration.estimated') }}</span>
      <span v-if="showCompose && status === 'compose_stale'" class="narration-badge is-stale">{{ t('episode.compose.stale') }}</span>
      <span class="ml-auto" />
      <label class="narration-toggle">
        <input type="checkbox" :checked="!enabled" :disabled="busy" @change="setPureVisual($event.target.checked)" />
        {{ t('episode.narration.pureVisual') }}
      </label>
    </div>

    <template v-if="enabled">
      <textarea
        :value="narrationText"
        class="textarea narration-textarea"
        rows="4"
        :placeholder="t('episode.narration.placeholder')"
        @input="emit('field-dirty', storyboard, 'narration_text', $event.target.value)"
        @blur="emit('update-field', storyboard, 'narration_text', $event.target.value)"
      />
      <div class="narration-meta">
        <span>{{ t('episode.narration.charCount', { n: chars, sec: estimateSeconds }) }}</span>
        <span v-if="measuredSeconds">· {{ t('episode.narration.measured', { sec: measuredSeconds }) }}</span>
        <span v-if="cueCount">· {{ t('episode.narration.cues', { n: cueCount }) }}</span>
      </div>

      <div v-if="tooLongIssue" class="narration-issue">
        <div class="narration-issue-msg">{{ tooLongIssue.message }}</div>
        <div class="narration-issue-ways">{{ t('episode.narration.tooLongWays') }}</div>
      </div>

      <div class="narration-actions">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy || batchRunning"
          :title="batchRunning ? t('episode.narration.batchAlreadyRunning', { done: narrationBatch.completed, total: narrationBatch.total }) : undefined"
          @click="writeNarration"
        >
          <Loader2 v-if="writing" :size="11" class="animate-spin" />
          {{ narrationText.trim() ? t('episode.narration.rewriteShot') : t('episode.narration.writeShot') }}
        </button>
        <span v-if="writing" class="narration-hint">{{ t('episode.narration.writing') }}</span>
        <span class="ml-auto" />
        <span class="narration-timing-label">{{ t('episode.narration.shotNormalizeLabel') }}</span>
        <BaseSelect
          class="narration-timing"
          :model-value="normalizeValue"
          :options="normalizeOptions"
          :searchable="false"
          @update:model-value="setNormalize"
        />
      </div>

      <div class="narration-actions">
        <span class="narration-timing-label">{{ t('episode.narration.timingLabel') }}</span>
        <BaseSelect
          class="narration-timing"
          :model-value="timingValue"
          :options="timingOptions"
          :searchable="false"
          @update:model-value="setTiming"
        />
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy || blocked || !narrationText.trim()"
          :title="blocked ? blockReason : undefined"
          @click="voiceDialogOpen = true"
        >
          <Loader2 v-if="voicing" :size="11" class="animate-spin" />
          {{ audioUrl ? t('episode.narration.regenerateVoice') : t('episode.narration.generateVoice') }}
        </button>
        <button
          v-if="audioUrl"
          type="button"
          :class="['btn btn-sm', { 'is-on': subtitleDirty }]"
          :disabled="busy"
          @click="regenerateSubtitle"
        >
          <Loader2 v-if="subtitling" :size="11" class="animate-spin" />
          {{ t('episode.narration.regenSubtitle') }}
        </button>
      </div>
      <div v-if="subtitleDirty" class="narration-hint">{{ t('episode.narration.timingChangedHint') }}</div>

      <audio v-if="audioUrl" :key="audioUrl" class="narration-audio" :src="mediaUrl(audioUrl)" controls preload="metadata" />
      <NarrationFitPanel
        v-if="audioUrl"
        :storyboard="storyboard"
        :episode-fit-default="episodeFitDefault"
        :episode-mix-mode="episodeMixMode"
        @refresh="emit('refresh')"
      />
      <div v-if="!audioUrl" class="narration-hint">{{ t('episode.narration.noAudio') }}</div>
    </template>
    <div v-else class="narration-hint">{{ t('episode.narration.pureVisualHint') }}</div>

    <template v-if="showCompose">
      <div class="narration-compose">
        <span class="narration-label">{{ t('episode.compose.section') }}</span>
        <span v-if="composedUrl" class="narration-meta">{{ t('episode.compose.duration', { sec: composedSeconds }) }}</span>
        <span class="ml-auto" />
        <button
          type="button"
          class="btn btn-sm"
          :disabled="busy || blocked || !hasVideo"
          :title="composeDisabledReason || undefined"
          @click="compose"
        >
          <Loader2 v-if="composing" :size="11" class="animate-spin" />
          {{ composedUrl ? t('episode.compose.recompose') : t('episode.compose.composeShot') }}
        </button>
      </div>
      <video v-if="composedUrl" :key="composedUrl" class="narration-composed-video" :src="mediaUrl(composedUrl)" controls preload="metadata" playsinline />
      <div v-else class="narration-hint">{{ t('episode.compose.none') }}</div>
      <div class="narration-hint">{{ t('episode.compose.durationNote') }}</div>
    </template>

    <NarrationVoiceDialog
      v-if="storyboard"
      :open="voiceDialogOpen"
      mode="single"
      :episode-id="Number(storyboard.episode_id ?? storyboard.episodeId)"
      :storyboard-id="storyboard.id"
      :text="narrationText"
      :has-audio="!!audioUrl"
      :submitting="voicing"
      @cancel="voiceDialogOpen = false"
      @confirm="generateVoice"
    />
  </section>
</template>

<script setup>
/**
 * 每镜旁白审核区（#30）：分镜（关键帧）页与视频页共用。
 * 文本走父级的 update-field / field-dirty（与 description 同一条自动保存链路），
 * 配音 / 字幕 / 合成是本镜级同步接口，完成后 emit('refresh') 由工作台重新拉分镜。
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { storyboardAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { toast } from 'vue-sonner'
import BaseSelect from '~/components/BaseSelect.vue'
import FieldSaveStatus from '~/components/FieldSaveStatus.vue'
import NarrationFitPanel from '~/components/NarrationFitPanel.vue'
import NarrationVoiceDialog from '~/components/NarrationVoiceDialog.vue'

const props = defineProps({
  storyboard: { type: Object, default: null },
  // { status, at }：由工作台按（分镜, narration_text）维护
  fieldSave: { type: Object, default: () => ({ status: 'idle', at: 0 }) },
  // 剧集级字幕时间码，用于「继承」选项的显示
  episodeTiming: { type: String, default: 'sentence' },
  // 视频页额外显示「合成本镜」与合成结果
  showCompose: { type: Boolean, default: false },
  // 剧集级音轨模式与默认匹配（#31），用于「继承」展示
  episodeMixMode: { type: String, default: 'replace' },
  episodeFitDefault: { type: Object, default: null },
  // 批量旁白在跑时禁用单镜写作（后端也会拒绝）：两边同时写同一镜会互相覆盖
  narrationBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
  // 剧集级文本规范化（#35），用于「继承」选项的显示
  episodeNormalize: { type: Boolean, default: true },
})
const emit = defineEmits(['update-field', 'field-dirty', 'refresh'])

const { t } = useI18n()

const voicing = ref(false)
const writing = ref(false)
const subtitling = ref(false)
const composing = ref(false)
const subtitleDirty = ref(false)
const voiceDialogOpen = ref(false)
const busy = computed(() => voicing.value || writing.value || subtitling.value || composing.value)
const batchRunning = computed(() => Boolean(props.narrationBatch?.running))

watch(() => props.storyboard?.id, () => { subtitleDirty.value = false })

const sb = computed(() => props.storyboard || {})
const narrationText = computed(() => sb.value.narration_text ?? sb.value.narrationText ?? '')
const enabled = computed(() => {
  const v = sb.value.narration_enabled ?? sb.value.narrationEnabled
  return v === undefined || v === null ? true : Boolean(v)
})
const status = computed(() => sb.value.narration_status || sb.value.narrationStatus || 'missing')
const meta = computed(() => sb.value.narration_meta || sb.value.narrationMeta || {})
const audioUrl = computed(() => sb.value.narration_audio_url || sb.value.narrationAudioUrl || '')
const composedUrl = computed(() => sb.value.composed_video_url || sb.value.composedVideoUrl || '')
const hasVideo = computed(() => Boolean(sb.value.video_url || sb.value.videoUrl))
const chars = computed(() => Number(sb.value.narration_chars ?? sb.value.narrationChars ?? narrationText.value.length))
const estimateSeconds = computed(() => {
  const v = Number(sb.value.narration_estimate_seconds ?? sb.value.narrationEstimateSeconds ?? 0)
  return v ? v.toFixed(1) : '0.0'
})
const measuredSeconds = computed(() => {
  const ms = Number(meta.value?.audio?.duration_ms || 0)
  return ms > 0 ? (ms / 1000).toFixed(1) : ''
})
const composedSeconds = computed(() => {
  const ms = Number(meta.value?.composed?.duration_ms || 0)
  return ms > 0 ? (ms / 1000).toFixed(1) : '—'
})
const cueCount = computed(() => Number(meta.value?.subtitle?.cues || 0))
const subtitleEstimated = computed(() => meta.value?.subtitle?.source === 'proportional_fallback')

// 阻断（后端 ref_issues）：旁白过长 / 配音过期，阻断期间禁用配音与合成
function issuesOf() {
  const list = sb.value.ref_issues || sb.value.refIssues
  return Array.isArray(list) ? list : []
}
const narrationIssues = computed(() => issuesOf().filter(i => i.code === 'narration_too_long' || i.code === 'narration_voice_stale'))
const tooLongIssue = computed(() => narrationIssues.value.find(i => i.code === 'narration_too_long') || null)
const blocked = computed(() => Boolean(tooLongIssue.value))
const blockReason = computed(() => tooLongIssue.value?.message || '')
const composeDisabledReason = computed(() => {
  if (blocked.value) return blockReason.value
  if (!hasVideo.value) return t('episode.compose.needVideo')
  return ''
})

const timingValue = computed(() => sb.value.subtitle_timing ?? sb.value.subtitleTiming ?? '')
const timingOptions = computed(() => [
  { label: t('episode.narration.timingInherit', { mode: episodeTimingLabel.value }), value: '' },
  { label: t('episode.narration.timingSentence'), value: 'sentence' },
  { label: t('episode.narration.timingChar'), value: 'char' },
])
const episodeTimingLabel = computed(() =>
  props.episodeTiming === 'char' ? t('episode.narration.timingChar') : t('episode.narration.timingSentence'))

async function setPureVisual(pureVisual) {
  if (!props.storyboard) return
  const next = !pureVisual
  try {
    await storyboardAPI.update(props.storyboard.id, { narration_enabled: next })
    props.storyboard.narration_enabled = next
    props.storyboard.narrationEnabled = next
    emit('refresh')
  } catch (e) {
    toastError(e)
  }
}

async function setTiming(value) {
  if (!props.storyboard || value === timingValue.value) return
  try {
    await storyboardAPI.update(props.storyboard.id, { subtitle_timing: value || null })
    props.storyboard.subtitle_timing = value || null
    props.storyboard.subtitleTiming = value || null
    if (audioUrl.value) subtitleDirty.value = true
  } catch (e) {
    toastError(e)
  }
}

// 本镜文本规范化（#35）：''=继承剧集，'on'/'off'=镜级覆盖
const normalizeValue = computed(() => {
  const v = sb.value.narration_normalize ?? sb.value.narrationNormalize
  if (v === null || v === undefined) return ''
  return v ? 'on' : 'off'
})
const normalizeOptions = computed(() => [
  { label: t('episode.narration.normalizeInherit', { mode: props.episodeNormalize ? t('episode.narration.normalizeOn') : t('episode.narration.normalizeOff') }), value: '' },
  { label: t('episode.narration.normalizeOn'), value: 'on' },
  { label: t('episode.narration.normalizeOff'), value: 'off' },
])

async function setNormalize(value) {
  if (!props.storyboard || value === normalizeValue.value) return
  const next = value === '' ? null : value === 'on'
  try {
    await storyboardAPI.update(props.storyboard.id, { narration_normalize: next })
    props.storyboard.narration_normalize = next
    props.storyboard.narrationNormalize = next
    emit('refresh')
  } catch (e) {
    toastError(e)
  }
}

// 单镜旁白写作/重写（#35）：后端用剧本全文 + 整集主线 + 前后镜旁白做上下文，只写这一镜
async function writeNarration() {
  if (!props.storyboard || busy.value || batchRunning.value) return
  writing.value = true
  try {
    const res = await storyboardAPI.writeNarration(props.storyboard.id)
    const text = res?.narration_text || ''
    props.storyboard.narration_text = text
    props.storyboard.narrationText = text
    toast.success(t('episode.narration.writeDone', { n: text.length }))
    emit('refresh')
  } catch (e) {
    toastError(e)
  } finally {
    writing.value = false
  }
}

// 配音参数来自弹窗（#37）：服务端校验并保存为本集默认，再合成
async function generateVoice(settings) {
  if (!props.storyboard || busy.value) return
  voicing.value = true
  try {
    const res = await storyboardAPI.generateNarrationVoice(props.storyboard.id, settings)
    voiceDialogOpen.value = false
    subtitleDirty.value = false
    toast.success(t('episode.narration.voiceDone', { sec: (Number(res?.duration_ms ?? res?.durationMs ?? 0) / 1000).toFixed(1) }))
    emit('refresh')
  } catch (e) {
    toastError(e)
  } finally {
    voicing.value = false
  }
}

async function regenerateSubtitle() {
  if (!props.storyboard || busy.value) return
  subtitling.value = true
  try {
    await storyboardAPI.regenerateSubtitle(props.storyboard.id)
    subtitleDirty.value = false
    toast.success(t('episode.narration.subtitleDone'))
    emit('refresh')
  } catch (e) {
    toastError(e)
  } finally {
    subtitling.value = false
  }
}

async function compose() {
  if (!props.storyboard || busy.value) return
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
</script>

<style scoped>
.narration-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}
.narration-head,
.narration-compose,
.narration-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.narration-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}
.narration-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}
.narration-badge.is-stale {
  color: var(--action-danger);
  background: var(--action-danger-bg);
}
.narration-badge.is-warn {
  color: var(--tag-warning-text);
  background: var(--surface-muted);
}
.narration-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
}
.narration-textarea {
  width: 100%;
}
.narration-meta,
.narration-hint {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-3);
}
.narration-issue {
  border: 1px solid var(--action-danger);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--action-danger);
}
.narration-issue-ways {
  color: var(--text-2);
  margin-top: 2px;
}
.narration-timing-label {
  font-size: 11px;
  color: var(--text-3);
}
.narration-timing {
  min-width: 148px;
}
.narration-audio {
  width: 100%;
  height: 32px;
}
.narration-composed-video {
  width: 100%;
  border-radius: 6px;
  background: var(--surface-muted);
}
</style>
