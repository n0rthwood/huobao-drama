<template>
  <Teleport to="body">
    <div v-if="open" class="overlay voice-overlay" @click.self="emit('cancel')">
      <div class="dialog voice-dialog" role="dialog" aria-modal="true" :aria-label="title">
        <header class="dialog-head">
          <h2 class="dialog-title">{{ title }}</h2>
          <button class="btn btn-ghost btn-icon" :aria-label="t('common.cancel')" @click="emit('cancel')">
            <X :size="14" />
          </button>
        </header>

        <div class="dialog-body voice-body">
          <div v-if="loading" class="voice-state"><Loader2 :size="14" class="animate-spin" /> {{ t('episode.voiceDialog.loading') }}</div>
          <div v-else-if="loadError" class="voice-error">{{ loadError }}</div>
          <template v-else-if="form">
            <p class="voice-source dim">{{ t('episode.voiceDialog.source', { name: options.config_name }) }}</p>

            <label class="voice-field">
              <span class="voice-label">{{ t('episode.voiceDialog.voice') }}</span>
              <select v-model="form.voice" class="input voice-select">
                <option v-if="!voiceKnown" :value="form.voice">{{ form.voice || t('episode.voiceDialog.voicePick') }}</option>
                <optgroup v-for="g in voiceGroups" :key="g.label" :label="g.label">
                  <option v-for="v in g.voices" :key="v" :value="v">{{ v }}</option>
                </optgroup>
              </select>
              <span v-if="form.voice && !voiceKnown" class="voice-warn">{{ t('episode.voiceDialog.voiceMissing') }}</span>
            </label>

            <div class="voice-field">
              <span class="voice-label">
                {{ t('episode.voiceDialog.steps') }}
                <strong>{{ form.inference_timesteps }}</strong>
                <span class="dim">（{{ options.steps.min }}–{{ options.steps.max }}）</span>
              </span>
              <div class="voice-presets">
                <button
                  v-for="p in options.steps.presets"
                  :key="p.steps"
                  type="button"
                  :class="['btn btn-sm', { 'is-on': form.inference_timesteps === p.steps }]"
                  :aria-pressed="form.inference_timesteps === p.steps"
                  @click="form.inference_timesteps = p.steps"
                >
                  {{ t(`episode.voiceDialog.preset${p.steps}`) }} · RTF {{ p.rtf }}
                </button>
              </div>
              <input v-model.number="form.inference_timesteps" type="range" :min="options.steps.min" :max="options.steps.max" step="1" />
              <span class="voice-hint">{{ t('episode.voiceDialog.stepsHint') }}</span>
            </div>

            <div class="voice-field">
              <span class="voice-label">
                cfg <strong>{{ Number(form.cfg_value).toFixed(1) }}</strong>
                <span class="dim">（{{ options.cfg.min.toFixed(1) }}–{{ options.cfg.max.toFixed(1) }}）</span>
              </span>
              <input v-model.number="form.cfg_value" type="range" :min="options.cfg.min" :max="options.cfg.max" step="0.1" />
              <span class="voice-hint">{{ t('episode.voiceDialog.cfgHint') }}</span>
            </div>

            <label class="voice-check">
              <input v-model="form.normalize" type="checkbox" />
              <span>
                {{ t('episode.voiceDialog.normalize') }}
                <span class="voice-hint">{{ t('episode.voiceDialog.normalizeHint') }}</span>
              </span>
            </label>
            <p v-if="hasDigits && !form.normalize" class="voice-warn">{{ t('episode.voiceDialog.normalizeSuggest') }}</p>

            <div class="voice-field">
              <span class="voice-label">seed</span>
              <div class="voice-seed">
                <label class="voice-radio"><input v-model="seedMode" type="radio" value="random" /> {{ t('episode.voiceDialog.seedRandom') }}</label>
                <label class="voice-radio"><input v-model="seedMode" type="radio" value="fixed" /> {{ t('episode.voiceDialog.seedFixed') }}</label>
                <input v-if="seedMode === 'fixed'" v-model.number="form.seed" class="input voice-seed-input" type="number" min="0" step="1" />
              </div>
              <span class="voice-hint">{{ t('episode.voiceDialog.seedHint') }}</span>
            </div>

            <label class="voice-field">
              <span class="voice-label">{{ t('episode.voiceDialog.instructions') }}</span>
              <textarea v-model="form.instructions" class="textarea" rows="2" :placeholder="t('episode.voiceDialog.instructionsPlaceholder')" />
            </label>

            <div v-if="mode === 'batch'" class="voice-plan">
              <div v-if="planLoading" class="voice-state"><Loader2 :size="12" class="animate-spin" /> {{ t('episode.voiceDialog.planLoading') }}</div>
              <div v-else-if="planError" class="voice-error">{{ planError }}</div>
              <template v-else-if="plan">
                <div class="voice-plan-row">
                  <span class="voice-plan-tag is-todo">{{ t('episode.voiceDialog.planMissing', { n: planGroups.missing.length }) }}</span>
                  <span class="voice-plan-tag is-todo">{{ t('episode.voiceDialog.planChanged', { n: planGroups.changed.length }) }}</span>
                  <span class="voice-plan-tag">{{ t('episode.voiceDialog.planUnchanged', { n: planGroups.unchanged.length }) }}</span>
                  <span v-if="planGroups.skipped.length" class="voice-plan-tag">{{ t('episode.voiceDialog.planSkipped', { n: planGroups.skipped.length }) }}</span>
                </div>
                <p v-if="todoNumbers" class="voice-hint">{{ t('episode.voiceDialog.planShots', { list: todoNumbers }) }}</p>
                <p class="voice-hint">{{ t('episode.voiceDialog.planRule') }}</p>
              </template>
            </div>

            <p class="voice-eta">{{ t('episode.voiceDialog.eta', { sec: etaText }) }}</p>
            <p class="voice-hint">{{ t('episode.voiceDialog.saveNote') }}</p>
          </template>
        </div>

        <footer class="dialog-foot">
          <button class="btn" :disabled="submitting" @click="emit('cancel')">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="!canConfirm" @click="confirm">
            <Loader2 v-if="submitting" :size="12" class="animate-spin" />
            {{ confirmLabel }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
/**
 * 配音参数弹窗（#37）：单镜「生成 / 重新生成配音」与「批量生成配音」共用。
 * 选项与预填值取自 GET /episodes/:id/tts-options（实时读 VoxCPM 音色）；确定后由父组件提交，
 * 服务端校验并保存为本集默认。批量模式按当前参数调 preview，显示缺失 / 已变化 / 未变化镜数。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X } from 'lucide-vue-next'
import { episodeAPI } from '~/composables/useApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: 'single' }, // single | batch
  episodeId: { type: Number, required: true },
  storyboardId: { type: Number, default: 0 },
  // 批量时手动选择的镜头（只缩小范围）
  storyboardIds: { type: Array, default: undefined },
  // 单镜的旁白文本（用于预计时长与数字提示）
  text: { type: String, default: '' },
  hasAudio: { type: Boolean, default: false },
  submitting: { type: Boolean, default: false },
})
const emit = defineEmits(['cancel', 'confirm'])
const { t } = useI18n()

const loading = ref(false)
const loadError = ref('')
const options = ref(null)
const form = ref(null)
const seedMode = ref('random')
const plan = ref(null)
const planLoading = ref(false)
const planError = ref('')

const title = computed(() => props.mode === 'batch'
  ? t('episode.voiceDialog.titleBatch')
  : (props.hasAudio ? t('episode.voiceDialog.titleRegen') : t('episode.voiceDialog.titleSingle')))

const voiceGroups = computed(() => {
  const groups = []
  for (const v of options.value?.voices || []) {
    let g = groups.find(x => x.label === v.group)
    if (!g) groups.push(g = { label: v.group, voices: [] })
    g.voices.push(v.name)
  }
  return groups
})
const voiceKnown = computed(() => (options.value?.voices || []).some(v => v.name === form.value?.voice))

function rtfFor(steps) {
  const table = options.value?.steps.presets || []
  if (!table.length) return 0.49
  if (steps <= table[0].steps) return table[0].rtf
  const last = table[table.length - 1]
  if (steps >= last.steps) return last.rtf
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i]; const b = table[i + 1]
    if (steps >= a.steps && steps <= b.steps) return a.rtf + ((b.rtf - a.rtf) * (steps - a.steps)) / (b.steps - a.steps)
  }
  return 0.49
}

const hasDigits = computed(() => /\d/.test(props.text || ''))

const planGroups = computed(() => {
  const out = { missing: [], changed: [], unchanged: [], skipped: [] }
  for (const it of plan.value || []) out[it.status]?.push(it)
  return out
})
const todoNumbers = computed(() => [...planGroups.value.missing, ...planGroups.value.changed]
  .sort((a, b) => a.storyboard_number - b.storyboard_number)
  .map(it => `#${String(it.storyboard_number).padStart(2, '0')}`)
  .join(' '))

const audioSeconds = computed(() => {
  if (props.mode === 'batch') {
    return [...planGroups.value.missing, ...planGroups.value.changed].reduce((sum, it) => sum + Number(it.audio_seconds || 0), 0)
  }
  const chars = (props.text || '').replace(/\s+/g, '').length
  return chars / (options.value?.chars_per_second || 4.5)
})
const etaText = computed(() => form.value ? (audioSeconds.value * rtfFor(form.value.inference_timesteps)).toFixed(1) : '0')

const todoCount = computed(() => planGroups.value.missing.length + planGroups.value.changed.length)
const confirmLabel = computed(() => {
  if (props.mode === 'batch') return t('episode.voiceDialog.confirmBatch', { n: todoCount.value })
  return props.hasAudio ? t('episode.voiceDialog.confirmRegen') : t('episode.voiceDialog.confirmSingle')
})
const canConfirm = computed(() => {
  if (!form.value || !form.value.voice || props.submitting || loading.value) return false
  if (props.mode === 'batch') return !planLoading.value && !planError.value && todoCount.value > 0
  return true
})

function settingsPayload() {
  const f = form.value
  return {
    voice: f.voice,
    inference_timesteps: Number(f.inference_timesteps),
    cfg_value: Number(f.cfg_value),
    seed: seedMode.value === 'fixed' && Number.isInteger(Number(f.seed)) ? Number(f.seed) : null,
    instructions: f.instructions || '',
    normalize: !!f.normalize,
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  options.value = null
  form.value = null
  plan.value = null
  try {
    const res = await episodeAPI.ttsOptions(props.episodeId, props.mode === 'single' ? props.storyboardId : undefined)
    options.value = res
    form.value = { ...res.current }
    seedMode.value = res.current.seed === null || res.current.seed === undefined ? 'random' : 'fixed'
    if (seedMode.value === 'random') form.value.seed = 0
  } catch (e) {
    loadError.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

let planSeq = 0
let planTimer = null
async function refreshPlan() {
  if (props.mode !== 'batch' || !form.value?.voice) return
  const my = ++planSeq
  planLoading.value = true
  planError.value = ''
  try {
    const res = await episodeAPI.narrationVoicePreview(props.episodeId, settingsPayload(), props.storyboardIds)
    if (my === planSeq) plan.value = res.items || []
  } catch (e) {
    if (my === planSeq) planError.value = e?.message || String(e)
  } finally {
    if (my === planSeq) planLoading.value = false
  }
}

watch(() => props.open, (open) => { if (open) load() })
// 批量：参数变了重新分类（防抖），保证「将重配的镜头」与确定后实际执行的一致
watch([form, seedMode], () => {
  if (props.mode !== 'batch' || !form.value) return
  clearTimeout(planTimer)
  planTimer = setTimeout(refreshPlan, 300)
}, { deep: true })

function confirm() {
  if (!canConfirm.value) return
  emit('confirm', settingsPayload())
}
</script>

<style scoped>
.voice-overlay { z-index: 119; }
.voice-dialog { width: 520px; max-width: 94vw; }
.voice-body { display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow-y: auto; }
.voice-source { margin: 0; font-size: 11px; }
.voice-field { display: flex; flex-direction: column; gap: 6px; }
.voice-label { font-size: 12px; font-weight: 600; color: var(--text-1); display: flex; gap: 6px; align-items: baseline; }
.voice-label .dim { font-weight: 400; color: var(--text-3); }
.voice-select { width: 100%; }
.voice-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.voice-presets .is-on { border-color: var(--action-primary); color: var(--action-primary); }
.voice-hint { font-size: 11px; color: var(--text-3); font-weight: 400; display: block; }
.voice-warn { margin: 0; font-size: 11px; color: var(--action-danger); }
.voice-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--text-1); }
.voice-seed { display: flex; gap: 12px; align-items: center; font-size: 12px; }
.voice-radio { display: flex; gap: 4px; align-items: center; }
.voice-seed-input { width: 140px; }
.voice-plan { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); display: flex; flex-direction: column; gap: 6px; }
.voice-plan-row { display: flex; gap: 6px; flex-wrap: wrap; }
.voice-plan-tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-2); color: var(--text-2); }
.voice-plan-tag.is-todo { background: var(--action-primary-bg, var(--bg-2)); color: var(--action-primary); font-weight: 600; }
.voice-plan p { margin: 0; }
.voice-eta { margin: 0; font-size: 12px; color: var(--text-1); }
.voice-state { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-2); }
.voice-error { font-size: 12px; color: var(--action-danger); white-space: pre-wrap; }
</style>
