<template>
  <div class="nsk">
    <!-- ===== 阶段 1：旁白骨架 ===== -->
    <template v-if="phase === 'skeleton'">
      <div class="nsk-bar">
        <span class="nsk-title">{{ t('episode.skeleton.title') }}</span>
        <span v-if="coverage" class="tag mono">
          {{ t('episode.skeleton.coverage', { covered: coverage.covered_chars, total: coverage.script_chars }) }}
        </span>
        <span v-if="coverage && !coverage.complete" class="tag nsk-tag-warn">
          {{ t('episode.skeleton.gaps', { n: coverage.gaps.length, chars: coverage.uncovered_chars }) }}
        </span>
        <span v-if="skeleton.confirmed" class="tag nsk-tag-ok">{{ t('episode.skeleton.confirmed') }}</span>
        <span v-else-if="skeleton.confirmed_revision" class="tag nsk-tag-warn">{{ t('episode.skeleton.changedSinceConfirm') }}</span>
        <TaskWorkMetrics :summary="skeletonSummary" :estimate="skeletonEstimate" dense />

        <span class="ml-auto" />
        <button class="btn btn-sm" :disabled="busy || generating || !skeleton.script_confirmed" @click="generate">
          <Loader2 v-if="generating" :size="11" class="animate-spin" />
          {{ generating ? t('episode.skeleton.generating') : t('episode.skeleton.generate') }}
        </button>
        <button class="btn btn-sm" :disabled="busy || !dirty" @click="save">{{ t('episode.skeleton.save') }}</button>
        <button v-if="skeleton.confirmed" class="btn btn-sm" :disabled="busy" @click="unconfirm">
          {{ t('episode.skeleton.unconfirm') }}
        </button>
        <button
          v-else
          class="btn btn-sm btn-primary"
          :disabled="busy || dirty || !skeleton.confirmable"
          :title="skeleton.blocked_reason || t('episode.skeleton.confirmHint')"
          @click="confirm"
        >{{ t('episode.skeleton.confirm') }}</button>
      </div>

      <p v-if="!skeleton.script_confirmed" class="nsk-block">{{ t('episode.skeleton.needScript') }}</p>
      <p v-else-if="skeleton.blocked_reason" class="nsk-block">{{ skeleton.blocked_reason }}</p>
      <p v-if="dirty" class="nsk-hint">{{ t('episode.skeleton.dirtyHint') }}</p>
      <p class="nsk-hint">{{ t('episode.skeleton.editContract') }}</p>
      <div v-if="draftGaps.length" class="nsk-gaps">
        <p>{{ t('episode.skeleton.gapHint') }}</p>
        <div v-for="gap in draftGaps" :key="gap.start" class="nsk-row">
          <strong>{{ t('episode.skeleton.gapRange', { start: gap.start, end: gap.end, chars: gap.chars }) }}</strong>
          <p class="nsk-preview">{{ gap.text }}</p>
          <div class="nsk-row-foot">
            <button class="btn btn-sm" :disabled="gap.next_index === 0" @click="applyGap(gap, 'previous')">{{ t('episode.skeleton.gapPrevious') }}</button>
            <button class="btn btn-sm" :disabled="gap.next_index === rows.length" @click="applyGap(gap, 'next')">{{ t('episode.skeleton.gapNext') }}</button>
            <button class="btn btn-sm" @click="applyGap(gap, 'new')">{{ t('episode.skeleton.gapNew') }}</button>
          </div>
        </div>
      </div>
      <ul v-if="problems.length" class="nsk-problems">
        <li v-for="(problem, i) in problems" :key="i">
          {{ t('episode.skeleton.problem', { index: problem.index + 1, message: problem.message }) }}
        </li>
      </ul>

      <div v-if="!rows.length" class="nsk-empty">{{ t('episode.skeleton.empty') }}</div>
      <ul v-else class="nsk-list">
        <li v-for="(row, index) in rows" :key="row.key" class="nsk-row">
          <div class="nsk-row-head">
            <span class="mono nsk-no">{{ shotLabel(row, index) }}</span>
            <input
              v-model="row.title"
              class="input nsk-title-input"
              :placeholder="t('episode.skeleton.titlePlaceholder')"
              @input="touch"
            >
            <span :class="['mono', 'nsk-chars', { 'is-over': spokenChars(row) > MAX_CHARS }]">
              {{ t('episode.skeleton.chars', { n: spokenChars(row), max: MAX_CHARS }) }}
            </span>
            <span class="ml-auto" />
            <button class="btn btn-ghost btn-sm" :disabled="index === 0" @click="mergeUp(index)">
              {{ t('episode.skeleton.mergeUp') }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="index === rows.length - 1" @click="mergeDown(index)">
              {{ t('episode.skeleton.mergeDown') }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="splitAt(index)">{{ t('episode.skeleton.split') }}</button>
          </div>
          <textarea
            :ref="el => registerArea(row.key, el)"
            v-model="row.narration_text"
            class="nsk-text"
            rows="3"
            :placeholder="t('episode.skeleton.textPlaceholder')"
            @input="touch"
          />
          <div v-for="(problem, i) in rowProblems(index)" :key="i" class="nsk-problems">
            {{ problem.message }}
            <span v-if="draftExcerpts[index]">{{ t('episode.skeleton.originalExcerpt', { text: draftExcerpts[index] }) }}</span>
          </div>
          <div class="nsk-row-foot">
            <span :class="['nsk-tts', 'is-' + (ttsOf(row).valid ? 'ok' : 'bad')]">
              {{ ttsLabel(ttsOf(row)) }}
            </span>
          </div>
        </li>
      </ul>
    </template>

    <!-- ===== 阶段 2：配音（实测时长的唯一来源） ===== -->
    <template v-else-if="phase === 'voice'">
      <div class="nsk-bar">
        <span class="nsk-title">{{ t('episode.skeleton.voiceTitle') }}</span>
        <span class="tag mono">
          {{ t('episode.skeleton.voiceSummary', { valid: skeleton.tts.valid, total: skeleton.tts.total }) }}
        </span>
        <span v-if="skeleton.tts.invalid" class="tag nsk-tag-warn">
          {{ t('episode.skeleton.voiceInvalid', { n: skeleton.tts.invalid }) }}
        </span>
        <span v-if="voiceBatch.running" class="tag mono">
          <Loader2 :size="11" class="animate-spin" />
          {{ t('episode.narration.voiceBatchProgress', { done: voiceBatch.completed, total: voiceBatch.total }) }}
        </span>
        <TaskWorkMetrics :summary="voiceSummary" :estimate="voiceEstimate" dense />

        <span class="ml-auto" />
        <button
          class="btn btn-sm"
          :disabled="!skeleton.confirmed || voiceBatch.running || !invalidIds.length"
          @click="emit('voice-batch', invalidIds)"
        >{{ t('episode.skeleton.voiceInvalidOnly', { n: invalidIds.length }) }}</button>
        <button
          class="btn btn-sm btn-primary"
          :disabled="!skeleton.confirmed || voiceBatch.running || !shots.length"
          :title="skeleton.confirmed ? '' : t('episode.skeleton.voiceNeedConfirm')"
          @click="emit('voice-batch', undefined)"
        >{{ t('episode.narration.batchVoice') }}</button>
      </div>

      <p v-if="!skeleton.confirmed" class="nsk-block">{{ t('episode.skeleton.voiceNeedConfirm') }}</p>

      <ul class="nsk-list">
        <li v-for="shot in shots" :key="shot.storyboard_id" class="nsk-row is-voice">
          <div class="nsk-row-head">
            <span class="mono nsk-no">{{ pad(shot.storyboard_number) }}</span>
            <span :class="['nsk-tts', 'is-' + (shot.tts.valid ? 'ok' : 'bad')]">{{ ttsLabel(shot.tts) }}</span>
            <span class="ml-auto" />
            <button
              class="btn btn-sm"
              :disabled="!skeleton.confirmed || voiceBatch.running"
              @click="emit('voice-batch', [shot.storyboard_id])"
            >{{ shot.tts.valid ? t('episode.narration.regenerateVoice') : t('episode.narration.generateVoice') }}</button>
          </div>
          <p class="nsk-preview">{{ shot.narration_text }}</p>
          <p v-if="!shot.tts.audio_url" class="nsk-hint">{{ t('episode.skeleton.audioMissing') }}</p>
          <template v-else>
            <p v-if="!shot.tts.valid" class="nsk-hint">{{ t('episode.skeleton.audioStale') }}</p>
            <audio v-if="shot.tts.valid" :key="audioSource(shot.tts)" :src="audioSource(shot.tts)" controls preload="none" />
          </template>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup>
/**
 * 旁白骨架与配音（Issue #70，纪录片分镜设计的前两个子阶段）。
 *
 * 顺序是硬的：最终稿 → 逐镜骨架 → **人工确认骨架** → 批量配音 → 实测时长填设计卡。
 * 骨架只管理连续文本边界、顺序与标题，不在这里改正文；配音状态只显示实测结果，
 * 没有任何估算回退——缺失/失败/过期/只剩旧音频一律按「无有效配音」处理。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2 } from 'lucide-vue-next'

import { episodeAPI, narrationSkeletonAPI, skeletonProblemsOf } from '~/composables/useApi'
import { onTaskFinished, refreshTasks, registerTask, useTasks } from '~/composables/useTasks'
import { toastError } from '~/composables/useToast'
import { spokenText } from '~/utils/narrationMarkup'
import { mediaUrl } from '~/utils/url'
import TaskWorkMetrics from '~/components/TaskWorkMetrics.vue'

const props = defineProps({
  episodeId: { type: Number, required: true },
  phase: { type: String, default: 'skeleton' },
  skeleton: { type: Object, required: true },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
  voiceBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
})
const emit = defineEmits(['update', 'refresh', 'voice-batch'])

const { t, te } = useI18n()
const { tasksById } = useTasks()

/** 单镜旁白上限（与后端骨架校验同口径） */
const MAX_CHARS = 80

const rows = ref([])
const dirty = ref(false)
const rowsRevision = ref(null)
const busy = ref(false)
const problems = ref([])
const areas = ref({})
const draftGaps = ref([])
const draftExcerpts = ref({})
const draftProblems = ref([])
let validateTimer
let validationSequence = 0
let rowSeq = 0

const shots = computed(() => props.skeleton?.shots || [])
const coverage = computed(() => props.skeleton?.coverage || null)
const invalidIds = computed(() => shots.value.filter(shot => !shot.tts.valid).map(shot => shot.storyboard_id))

/** 骨架生成任务：复用既有 storyboard_breaker 任务类型与全局任务轮询 */
const generating = computed(() => Object.values(tasksById.value).some(task => (
  Number(task.episode_id) === Number(props.episodeId)
  && String(task.kind || task.params?.kind || '') === 'storyboard_breaker'
  && (task.status === 'queued' || task.status === 'processing')
)))

/**
 * 三阶段真实计量（#87 §D）：运行中/已结束读全局任务 store 上的 `observation_summary`
 * （与任务详情同一个对象，刷新浏览器也不归零）；还没有任务时读「开始前」的计划字数与历史 ETA。
 */
function latestTaskOf(kind) {
  let latest = null
  for (const task of Object.values(tasksById.value)) {
    if (Number(task.episode_id) !== Number(props.episodeId)) continue
    if (String(task.kind || task.params?.kind || '') !== kind) continue
    if (!latest || task.id > latest.id) latest = task
  }
  return latest
}
const skeletonSummary = computed(() => latestTaskOf('storyboard_breaker')?.observation_summary || null)
const voiceSummary = computed(() => latestTaskOf('narration_tts')?.observation_summary || null)
const skeletonEstimate = ref(null)
const voiceEstimate = ref(null)

let workEstimateSeq = 0
async function loadWorkEstimates() {
  const seq = ++workEstimateSeq
  if (!props.episodeId) return
  for (const [stage, target] of [['skeleton', skeletonEstimate], ['voice', voiceEstimate]]) {
    target.value = null
    try {
      const res = await episodeAPI.workEstimate(props.episodeId, stage, undefined, stage === 'skeleton'
        ? { config_id: props.chatConfigId || undefined, model: props.chatModel || undefined } : {})
      if (seq === workEstimateSeq) target.value = res?.estimate || null
    } catch { /* 预估失败保持未知，不复用其他配置的旧样本。 */ }
  }
}
watch([() => props.episodeId, () => props.chatConfigId, () => props.chatModel], loadWorkEstimates, { immediate: true })

function pad(n) { return `#${String(n ?? 0).padStart(2, '0')}` }
function shotLabel(row, index) { return pad(index + 1) }
function spokenChars(row) { return spokenText(row.narration_text || '').replace(/\s/g, '').length }

function ttsOf(row) {
  const shot = row.id ? shots.value.find(item => item.storyboard_id === row.id) : null
  return shot?.tts || { valid: false, reason: 'audio_missing', message: null, duration_ms: null }
}
/** 有效：显示实测秒数；无效：显示具体原因，绝不显示估算 */
function ttsLabel(tts) {
  if (tts?.valid) return t('episode.skeleton.ttsValid', { sec: ((tts.duration_ms || 0) / 1000).toFixed(1) })
  const key = `episode.skeleton.ttsReason.${tts?.reason || 'audio_missing'}`
  return t('episode.skeleton.ttsInvalid', { reason: te(key) ? t(key) : (tts?.message || tts?.reason || '') })
}

function audioSource(tts) {
  const url = mediaUrl(tts.audio_url)
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(tts.audio_version || '')}`
}

function rowProblems(index) {
  return draftProblems.value.filter(problem => problem.index === index)
}

function draftShots() {
  return rows.value.map(row => ({ id: row.id || undefined, narration_text: row.narration_text || '', title: row.title || null }))
}

function scheduleValidation() {
  clearTimeout(validateTimer)
  const sequence = ++validationSequence
  validateTimer = setTimeout(async () => {
    try {
      const result = await narrationSkeletonAPI.validate(props.episodeId, rowsRevision.value, draftShots())
      if (sequence !== validationSequence) return
      draftProblems.value = result.problems
      draftGaps.value = result.gaps
      draftExcerpts.value = result.excerpts
    } catch (err) {
      if (sequence !== validationSequence) return
      draftGaps.value = []
      draftProblems.value = []
      toastError(err, { fallback: 'episode.skeleton.error.saveFailed' })
    }
  }, 350)
}
onBeforeUnmount(() => { clearTimeout(validateTimer); validationSequence++ })

function registerArea(key, el) {
  if (el) areas.value[key] = el
  else delete areas.value[key]
}

// ===== 骨架编辑：拆分 / 合并 / 保存 =====
function syncRows() {
  rows.value = shots.value.map(shot => ({
    key: `s${shot.storyboard_id}`,
    id: shot.storyboard_id,
    storyboard_number: shot.storyboard_number,
    title: shot.title || '',
    narration_text: shot.narration_text || '',
  }))
  dirty.value = false
  rowsRevision.value = props.skeleton.revision
  problems.value = []
  scheduleValidation()
}
watch(() => props.skeleton, () => {
  if (!dirty.value) syncRows()
}, { immediate: true, deep: false })

function touch() { dirty.value = true; scheduleValidation() }

/** 在光标处拆成两镜：后半段成为新镜（无 id），顺序与逐字覆盖不变 */
function splitAt(index) {
  const row = rows.value[index]
  const area = areas.value[row.key]
  const caret = area && Number.isInteger(area.selectionStart) ? area.selectionStart : 0
  const text = row.narration_text || ''
  if (caret <= 0 || caret >= text.length) {
    toast.warning(t('episode.skeleton.splitNeedCaret'))
    return
  }
  const head = text.slice(0, caret)
  const tail = text.slice(caret)
  row.narration_text = head
  rows.value.splice(index + 1, 0, {
    key: `n${++rowSeq}`,
    id: undefined,
    storyboard_number: 0,
    title: '',
    narration_text: tail,
  })
  touch()
}

/** 并入上一镜：文本直接相接，被并掉的那一镜在保存时删除 */
function mergeUp(index) {
  if (index <= 0) return
  const previous = rows.value[index - 1]
  const row = rows.value[index]
  previous.narration_text = `${previous.narration_text || ''}${row.narration_text || ''}`
  rows.value.splice(index, 1)
  touch()
}

function mergeDown(index) {
  if (index >= rows.value.length - 1) return
  rows.value[index + 1].narration_text = `${rows.value[index].narration_text || ''}${rows.value[index + 1].narration_text || ''}`
  rows.value.splice(index, 1)
  touch()
}

function applyGap(gap, action) {
  const index = gap.next_index
  if (action === 'previous' && index > 0) rows.value[index - 1].narration_text += gap.text
  else if (action === 'next' && index < rows.value.length) rows.value[index].narration_text = gap.text + rows.value[index].narration_text
  else if (action === 'new') rows.value.splice(index, 0, {
    key: `n${++rowSeq}`, id: undefined, storyboard_number: 0, title: '', narration_text: gap.text,
  })
  else return
  draftGaps.value = []
  touch()
}

async function save() {
  busy.value = true
  problems.value = []
  try {
    const next = await narrationSkeletonAPI.save(props.episodeId, rowsRevision.value, draftShots())
    dirty.value = false
    emit('update', next)
    toast.success(t('episode.skeleton.saved'))
    emit('refresh')
  } catch (err) {
    const found = skeletonProblemsOf(err)
    if (found) problems.value = found
    else toastError(err, { fallback: 'episode.skeleton.error.saveFailed' })
  } finally {
    busy.value = false
  }
}

async function confirm() {
  busy.value = true
  try {
    emit('update', await narrationSkeletonAPI.confirm(props.episodeId, props.skeleton.revision))
    toast.success(t('episode.skeleton.confirmedToast'))
    emit('refresh')
  } catch (err) {
    toastError(err, { fallback: 'episode.skeleton.error.confirmFailed' })
  } finally {
    busy.value = false
  }
}

async function unconfirm() {
  busy.value = true
  try {
    emit('update', await narrationSkeletonAPI.unconfirm(props.episodeId))
    emit('refresh')
  } catch (err) {
    toastError(err, { fallback: 'episode.skeleton.error.confirmFailed' })
  } finally {
    busy.value = false
  }
}

async function generate() {
  busy.value = true
  try {
    const res = await narrationSkeletonAPI.generate(props.episodeId, {
      model: props.chatModel || undefined,
      config_id: props.chatConfigId || undefined,
    })
    if (res?.task_id) registerTask({ id: res.task_id, type: 'text', status: 'queued', kind: 'storyboard_breaker', episode_id: props.episodeId })
    emit('update', res)
    void refreshTasks()
    toast.info(t('episode.skeleton.generateStarted'))
  } catch (err) {
    toastError(err, { fallback: 'episode.skeleton.error.generateFailed' })
  } finally {
    busy.value = false
  }
}

// 骨架生成任务结束：拉回最新骨架并让页面重载分镜
onTaskFinished((task) => {
  if (Number(task?.episode_id) !== Number(props.episodeId)) return
  const kind = String(task?.kind || task?.params?.kind || '')
  // 骨架/配音任务结束都会产生新的真实样本：预估按新样本重算
  if (kind !== 'storyboard_breaker' && kind !== 'narration_tts') return
  void loadWorkEstimates()
  if (kind === 'storyboard_breaker') emit('refresh')
})
</script>

<style scoped>
.nsk { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.nsk-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface-raised);
}
.nsk-title { font-size: 12px; font-weight: 700; color: var(--text-1); }
.nsk-tag-warn { color: var(--danger-text, #d9534f); }
.nsk-tag-ok { color: var(--ok-text, var(--text-1)); }
.nsk-block {
  margin: 0; padding: 8px 12px; font-size: 12px; color: var(--text-1);
  background: var(--warn-bg); border-bottom: 1px solid var(--warn-border);
}
.nsk-hint { margin: 0; padding: 6px 12px; font-size: 11.5px; color: var(--text-2); }
.nsk-problems { margin: 0; padding: 6px 12px 6px 28px; font-size: 11.5px; color: var(--danger-text, #d9534f); line-height: 1.7; }
.nsk-empty { padding: 28px 12px; text-align: center; font-size: 12.5px; color: var(--text-3); }
.nsk-gaps { padding: 8px 12px; display: grid; gap: 8px; overflow-y: auto; max-height: 35vh; }
.nsk-list { list-style: none; margin: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex: 1; min-height: 0; }
.nsk-row { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; background: var(--surface-raised); }
.nsk-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.nsk-no { font-size: 11.5px; color: var(--text-2); font-weight: 700; }
.nsk-title-input { height: 26px; font-size: 12px; max-width: 240px; }
.nsk-chars { font-size: 10.5px; color: var(--text-3); }
.nsk-chars.is-over { color: var(--danger-text, #d9534f); }
.nsk-text {
  width: 100%; border: 1px solid var(--border); border-radius: var(--radius);
  padding: 8px 10px; font-size: 13px; line-height: 1.85; resize: vertical;
  background: var(--bg-input); color: var(--text-0); font-family: var(--font-body);
}
.nsk-row-foot { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
.nsk-tts { font-size: 11px; }
.nsk-tts.is-ok { color: var(--ok-text, var(--text-1)); }
.nsk-tts.is-bad { color: var(--danger-text, #d9534f); }
.nsk-preview { margin: 0; font-size: 12px; color: var(--text-2); line-height: 1.75; white-space: pre-wrap; word-break: break-word; }
</style>
