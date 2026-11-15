<script setup>
/**
 * 「视频与成品」单镜卡（Issue #106）。
 *
 * 整卡由 DocumentaryFinalPanel 用 LazyMount 按视口挂载/卸载，所以：
 * - 卡内请求只在挂载后发出：每卡单飞、输入键没变就不重复请求、过期响应按序号丢弃；
 * - 卸载前必须通过 canUnload()：编辑中/保存中或失败、草稿未应用、请求在飞、媒体在播、
 *   弹窗打开时都拒绝卸载（面板会把拒绝原因交给 LazyMount 轮询复查）；
 * - 媒体一律 preload="none" + 封面；时长与衔接点读服务端已存数据，播放后用实测值覆盖。
 */
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers, Sparkles, Lock } from 'lucide-vue-next'
import { layerSegmentAPI, taskAPI, storyboardAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { posterOf, thumbFallback, thumbOf } from '~/composables/useMedia'
import { SAVE_STATUS_FIELDS, WORKBENCH_CTX } from '~/utils/workbenchSteps'
import { mediaUrl } from '~/utils/url'
import {
  budgetOf, composedSecondsOf, displaySecondsOf, junctionSecondsOf, measuredSecondsOf, taskDurationOf, zonesOf,
} from '~/utils/documentaryFinal'
import RehearsalDialog from '~/components/ShotProduction/RehearsalDialog.vue'
import NarrationBlock from '~/components/NarrationBlock.vue'
import ShotFusionPanel from '~/components/ShotFusionPanel.vue'
import MentionTextarea from '~/components/MentionTextarea.vue'
import FieldSaveStatus from '~/components/FieldSaveStatus.vue'
import ProgressRing from '~/components/ProgressRing.vue'
import { DEEPLINK_KEYS, querySingle, useDeeplink } from '~/composables/useQuerySync'
const props = defineProps({ storyboard: { type: Object, required: true }, number: Number })
const ctx = inject(WORKBENCH_CTX)
const { t } = useI18n()
const sb = computed(() => props.storyboard)
const zones = computed(() => zonesOf(sb.value.combo))
const budget = computed(() => budgetOf(sb.value))
const measured = computed(() => measuredSecondsOf(sb.value))
const budgetTotal = computed(() => (zones.value.layer ? Number(budget.value.layer_s || 0) : 0) + (zones.value.generated ? Number(budget.value.gen_s || 0) : 0))
const nextShot = computed(() => {
  const shots = ctx.sbs.value
  return shots[shots.findIndex(shot => shot.id === sb.value.id) + 1] || null
})
const cardEl = ref(null)
const narrationBlock = ref(null)
const fusionPanel = ref(null)
const segmentState = ref(null)
const segment = computed(() => segmentState.value?.segment)
const junction = computed(() => segmentState.value?.junction)
const rendering = ref(false)
const rehearsal = ref(false)
// deeplink（#86）：预演弹窗只按分镜 id 恢复外壳，不触发任何渲染/生成；
// 只认领 rehearse 键（shot/sel 归面板），每个分镜实例只在自己弹窗打开时发布
const link = useDeeplink('finalShot', DEEPLINK_KEYS.finalPanel.filter(key => key === 'rehearse'))
if (Number(querySingle(link.initial('rehearse')) || 0) === props.storyboard.id) rehearsal.value = true
watch(rehearsal, open => link.set({ rehearse: open ? sb.value.id : '' }), { immediate: true })
const overConfirm = ref(false)
const history = ref([])
const preview = ref('')
// 播放后才有的实测时长（loadedmetadata）；首帧不预加载媒体，所以先显示服务端已存的值
const playedGeneratedSeconds = ref(0)
const playedFinalSeconds = ref(0)
const elapsed = ref(0)
const flashed = ref(false)
let flashTimer
const layerSeconds = computed(() => Number(segment.value?.duration || 0))
const composedMeta = computed(() => (sb.value.narration_meta || sb.value.narrationMeta || {}).composed || {})
const videoUrl = computed(() => preview.value || ctx.getVideoUrl(sb.value))
/** 采用中的生成视频对应的任务：与后端同口径（localPath / resultUrl 等于分镜 video_url） */
const adoptedTask = computed(() => {
  const url = videoUrl.value
  return url ? history.value.find(item => ctx.taskVideoPath(item) === url) || null : null
})
/** 生成段时长：采用任务的请求时长 params.duration；播放后以实测值覆盖 */
const generatedSeconds = computed(() => displaySecondsOf(playedGeneratedSeconds.value, taskDurationOf(adoptedTask.value)))
/** 成品时长：narration_meta.composed.duration_ms；播放后以实测值覆盖 */
const finalSeconds = computed(() => displaySecondsOf(playedFinalSeconds.value, composedSecondsOf(sb.value)))
/** 时长显示：服务端没有数据时显示「—」 */
const secondsText = seconds => (Number(seconds) > 0 ? t('episode.final.duration', { seconds: Number(seconds).toFixed(1) }) : '—')
const junctionAt = computed(() => zones.value.layer && zones.value.generated ? composedMeta.value.junction_s ?? junctionSecondsOf(sb.value.combo, layerSeconds.value, generatedSeconds.value) : null)
const junctionPercent = computed(() => junctionAt.value !== null && finalSeconds.value > 0 ? Math.max(0, Math.min(100, junctionAt.value / finalSeconds.value * 100)) : null)
const composedUrl = computed(() => ctx.composeStateOf(sb.value)?.composed_video_url || sb.value.composed_video_url || sb.value.composedVideoUrl || '')
const disabledReason = computed(() => !zones.value.generated ? t('episode.final.noCombo') : !ctx.isShotConfirmed(sb.value) ? t('episode.kf.gateShotUnconfirmed') : ctx.videoBlockIssues(sb.value).length ? ctx.videoBlockReason(sb.value) : ctx.videoBatchRunning.value ? t('episode.vid.batchAlreadyRunning') : ctx.videoTaskState(sb.value) === 'pending' ? t('episode.vid.emptyGenerating') : '')
const layerStatus = computed(() => rendering.value ? t('episode.final.rendering') : segment.value?.stale_reason ? segment.value.stale_reason : segment.value?.fresh ? t('episode.final.fresh') : segment.value?.status === 'failed' ? t('episode.final.failed') : t('episode.final.stale'))
/**
 * 图层段封面：新渲染的数据有 _poster.jpg 旁文件；旧数据没有就退回服务端首帧缩略图。
 * <video> 不会因为 poster 404 触发 error 事件，所以先用一次 Image 探测（命中浏览器缓存）
 * 决定用哪个地址，再交给 <video poster>。
 */
const layerPoster = ref('')
watch([() => sb.value.id, () => segment.value?.render_path], ([id, path]) => {
  layerPoster.value = ''
  if (!id || !path || typeof window === 'undefined') return
  const derived = posterOf(mediaUrl(path))
  if (!derived) return
  const probe = new Image()
  const sameSegment = () => segment.value?.render_path === path
  probe.onload = () => { if (sameSegment()) layerPoster.value = derived }
  probe.onerror = () => { if (sameSegment()) layerPoster.value = layerSegmentAPI.thumbnailUrl(id, 'first') }
  probe.src = derived
}, { immediate: true })
function openKeyframe(slot) {
  const path = ctx.shotKeyframeImage(sb.value, slot.slot)
  if (!path) return
  ctx.openImageViewer(mediaUrl(path), `#${String(props.number).padStart(2, '0')} · ${slot.label}`)
}

// ===== 卡内请求（#106）：每卡单飞 + 输入键去重 + 过期响应丢弃 =====
// 输入键 = 会改变本卡服务端数据的字段；键没变就不重复请求（首载期数据陆续到达不再连发）
const loadKey = computed(() => [
  sb.value.id,
  sb.value.updated_at ?? sb.value.updatedAt ?? '',
  sb.value.video_url ?? sb.value.videoUrl ?? '',
  sb.value.keyframes?.confirmed ? 1 : 0,
  ctx.videoTaskState(sb.value) || '',
].join('|'))
let lastLoadedKey = ''
let inflightLoad = false
let queuedLoad = null
let loadSeq = 0

async function fetchState(key) {
  const seq = ++loadSeq
  inflightLoad = true
  try {
    const [state, tasks] = await Promise.all([zones.value.layer ? layerSegmentAPI.get(sb.value.id) : Promise.resolve(null), zones.value.generated ? taskAPI.list({ type: 'video', storyboard_id: sb.value.id }) : Promise.resolve([])])
    if (seq !== loadSeq) return
    segmentState.value = state
    history.value = (Array.isArray(tasks) ? tasks : tasks?.items || []).filter(task => task.provider !== 'layer-segment')
    lastLoadedKey = key
  } catch (error) {
    toastError(error)
  } finally {
    inflightLoad = false
    const next = queuedLoad
    queuedLoad = null
    // 请求途中输入又变了：只追最新的一份；强制刷新（动作完成后）必须落地，普通重复请求丢弃
    if (next && (next.force || next.key !== lastLoadedKey)) void fetchState(next.key)
  }
}

/**
 * 按当前输入键加载：同一镜同一份输入只请求一次。
 * force = 渲染 / 重试 / 切换主视频之后的强制刷新（服务端数据已变，键可能没变）。
 */
function load(force = false) {
  const key = loadKey.value
  if (inflightLoad) {
    queuedLoad = { key, force: force || Boolean(queuedLoad?.force) }
    return
  }
  if (!force && key === lastLoadedKey) return
  return fetchState(key)
}

watch(loadKey, () => { void load() }, { immediate: true })

async function render() {
  rendering.value = true
  try {
    await layerSegmentAPI.render(sb.value.id)
    await Promise.all([load(true), ctx.refresh()])
  } catch (error) { toastError(error) } finally { rendering.value = false }
}
async function generate() {
  if (disabledReason.value || submitting.value) return
  if (measured.value > budgetTotal.value && !overConfirm.value) { overConfirm.value = true; return }
  overConfirm.value = false
  submitting.value = true
  try { await ctx.genVid(sb.value) } finally { submitting.value = false }
}
function historyPath(item) { return ctx.taskVideoPath(item) }
const retryingTask = ref(null)
// 生成视频的提交在飞：卸载会让失败提示和进度环无处显示
const submitting = ref(false)
const historyActive = computed(() => history.value.some(item => ['pending', 'queued', 'processing', 'running'].includes(item.status)))
async function retryHistory(item) {
  if (retryingTask.value || historyActive.value || disabledReason.value) return
  retryingTask.value = item.id
  try {
    const task = await taskAPI.retry(item.id)
    history.value = [task, ...history.value]
    await ctx.refresh()
    await load()
  } catch (error) { toastError(error) } finally { retryingTask.value = null }
}
async function activateHistory() {
  try {
    await storyboardAPI.update(sb.value.id, { video_url: preview.value })
    preview.value = ''
    await ctx.refresh()
    await load()
  } catch (error) { toastError(error) }
}
function slotLock(slot) { return sb.value.keyframes?.slot_locks?.find(item => item.slot === slot) || null }
function locked(slot) { return Boolean(slotLock(slot) || sb.value.keyframes?.locked_slots?.includes(slot)) }
function timeUpdate(event) {
  const time = event.target.currentTime
  const at = junctionAt.value
  if (at !== null && elapsed.value < at && time >= at) {
    flashed.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { flashed.value = false }, 650)
  }
  elapsed.value = time
}

// ===== 卸载保护（#106）：下列任一条成立就拒绝卸载，由 LazyMount 轮询复查 =====
const BLOCKING_SAVE_STATUSES = ['dirty', 'saving', 'error']
function focusedInside() {
  const active = document.activeElement
  return Boolean(cardEl.value && active && cardEl.value.contains(active))
}
function fieldsUnsaved() {
  return SAVE_STATUS_FIELDS.some(field => BLOCKING_SAVE_STATUSES.includes(ctx.fieldSaveInfo(sb.value, field).status))
}
function mediaPlaying() {
  const el = cardEl.value
  if (!el) return false
  return Array.from(el.querySelectorAll('video, audio')).some(media => !media.paused && !media.ended)
}
function fitDraftUnsafe() {
  const draft = fusionPanel.value?.fitDraft
  return Boolean(draft && (draft.dirty || draft.busy))
}
function localBusy() {
  return rendering.value
    || submitting.value
    || Boolean(retryingTask.value)
    || Boolean(narrationBlock.value?.busy)
    || Boolean(fusionPanel.value?.composing)
    || ctx.videoPromptGeneratingIds.value.includes(sb.value.id)
}
/** 镜卡此刻能否卸载：编辑中的内容、在飞的请求、播放中的媒体、打开的弹窗都必须先结束 */
function canUnload() {
  if (focusedInside() || fieldsUnsaved()) return false
  if (rehearsal.value || Boolean(narrationBlock.value?.dialogOpen)) return false
  if (mediaPlaying() || localBusy() || fitDraftUnsafe()) return false
  return true
}
defineExpose({ canUnload })

onBeforeUnmount(() => clearTimeout(flashTimer))
</script>

<template>
  <article ref="cardEl" :id="`final-shot-${sb.id}`" class="final-shot">
    <header class="final-shot-head">
      <strong>#{{ String(number).padStart(2, '0') }} · {{ sb.combo || '—' }}</strong>
      <Layers v-if="sb.combo === 'A' || sb.combo === 'C'" :size="16" /><span v-if="sb.combo === 'C'">→</span><Sparkles v-if="zones.generated" :size="16" /><span v-if="sb.combo === 'D'">→ <Layers :size="16" /></span>
      <span>{{ t('episode.final.budget', { seconds: budgetTotal.toFixed(1) }) }}</span>
      <span>{{ t('episode.final.measured', { seconds: measured.toFixed(1) }) }}</span>
      <button class="btn btn-sm ml-auto" @click="ctx.gotoShotProduction(sb)">{{ t('episode.production.gotoShotProduction') }}</button>
    </header>
    <div v-if="!zones.final" class="final-warning">{{ t('episode.final.noCombo') }}</div>
    <template v-else>
      <section v-if="zones.layer" class="final-zone" data-zone="layer">
        <h3><Layers :size="15" />① {{ t('episode.final.layer') }} · {{ secondsText(layerSeconds) }} · {{ layerStatus }}</h3>
        <video v-if="segment?.render_path" :src="mediaUrl(segment.render_path)" :poster="layerPoster" controls preload="none" />
        <button class="btn btn-sm" :disabled="rendering || !segment || !segmentState?.production_unlocked" @click="render">{{ t('episode.final.render') }}</button>
        <span v-if="segmentState?.gate_reason" class="final-warning">{{ segmentState.gate_reason }}</span>
      </section>
      <section v-if="zones.generated" class="final-zone" data-zone="generated">
        <h3><Sparkles :size="15" />② {{ t('episode.final.generated') }} · {{ t('episode.final.budget', { seconds: budget.gen_s }) }} · {{ secondsText(generatedSeconds) }} · {{ ctx.videoTaskStatusLabel(sb) }}</h3>
        <p v-if="!measured" class="final-info">{{ t('episode.narration.noAudio') }}</p>
        <div v-if="!ctx.isShotConfirmed(sb)" class="final-warning">
          {{ t('episode.kf.gateShotUnconfirmed') }}
          <button class="btn btn-sm" @click="ctx.gotoShotProduction(sb)">{{ t('episode.production.gotoShotProduction') }}</button>
        </div>
        <template v-else>
          <div class="final-slots">
            <div v-for="slot in ctx.KEYFRAME_SLOTS.value" :key="slot.slot">
              <button v-if="ctx.shotKeyframeImage(sb, slot.slot)" type="button" class="final-slot-thumb" :title="t('common.viewOriginal')" :aria-label="`${slot.label} · ${t('common.viewOriginal')}`" @click="openKeyframe(slot)">
                <img :src="thumbOf(mediaUrl(ctx.shotKeyframeImage(sb, slot.slot)))" :alt="slot.label" loading="lazy" @error="thumbFallback($event, mediaUrl(ctx.shotKeyframeImage(sb, slot.slot)))" />
              </button>
              <span>{{ slot.label }}</span>
              <small v-if="locked(slot.slot)"><Lock :size="12" />{{ slotLock(slot.slot)?.source === 'previous_last' ? t('episode.segment.junctionInheritPrev') : t('episode.final.inherited', { seconds: Number(slotLock(slot.slot)?.t || 0).toFixed(1) }) }}<span v-if="slotLock(slot.slot)?.stale"> · {{ t('episode.final.stale') }}</span></small>
            </div>
          </div>
          <div>{{ t('episode.sb.videoPromptSection') }}
            <FieldSaveStatus v-bind="ctx.fieldSaveInfo(sb, 'video_prompt')" />
            <MentionTextarea :model-value="sb.video_prompt || sb.videoPrompt || ''" :options="ctx.shotMentionOptions(sb)" :rows="8" @update:model-value="value => ctx.markFieldDirty(sb, 'video_prompt', value)" @commit="value => ctx.updateField(sb, 'video_prompt', value)" />
          </div>
          <button class="btn btn-sm" :disabled="ctx.videoPromptGeneratingIds.value.includes(sb.id)" @click="ctx.genVideoPrompt(sb)">{{ ctx.promptHeadVideoActionLabel(sb) }}</button>
          <video v-if="videoUrl" :src="mediaUrl(videoUrl)" :poster="posterOf(mediaUrl(videoUrl))" controls preload="none" @loadedmetadata="playedGeneratedSeconds = $event.target.duration" />
          <ProgressRing
            v-if="ctx.videoRing(sb)"
            v-bind="ctx.videoRing(sb)"
            detailed
            :size="30"
            :cancellable="ctx.isVideoCancellable(sb)"
            @cancel="ctx.cancelVideoTask(sb)"
          />
          <p v-if="measured > budgetTotal" class="final-warning">{{ t('episode.final.overBudget') }}</p>
          <button class="btn btn-primary" :disabled="!!disabledReason" :title="disabledReason" @click="generate">{{ overConfirm ? t('episode.final.confirmGenerate') : t('episode.vid.generateVideo') }}</button>
          <p v-if="disabledReason" class="final-warning">{{ disabledReason }}</p>
        </template>
        <div class="final-history">
          <div v-for="item in history" :key="item.id" class="final-history-row">
            <button class="btn btn-sm" :disabled="!historyPath(item)" :aria-pressed="Boolean(historyPath(item)) && preview === historyPath(item)" @click="preview = historyPath(item)">#{{ item.id }} · {{ item.model || item.provider }} · {{ t(`taskCenter.status.${item.status || 'processing'}`) }}</button>
            <span v-if="item.error_msg || item.errorMsg" class="final-warning">{{ item.error_msg || item.errorMsg }}</span>
            <button v-if="item.status === 'failed' || item.status === 'cancelled'" class="btn btn-sm" :disabled="Boolean(retryingTask) || historyActive || Boolean(disabledReason)" :title="disabledReason" @click="retryHistory(item)">{{ t('episode.vid.retryFailed', { n: 1 }) }}</button>
          </div>
          <button v-if="preview" class="btn btn-sm" @click="preview = ''">{{ t('episode.vid.current') }}</button>
          <button v-if="preview" class="btn btn-sm" @click="activateHistory">{{ t('episode.vid.setMain') }}</button>
        </div>
      </section>
      <section :id="`final-composite-${sb.id}`" class="final-zone" data-zone="composite">
        <h3>③ {{ t('episode.final.composite') }} · {{ secondsText(finalSeconds) }}</h3>
        <button class="btn btn-sm" @click="rehearsal = true">{{ t('episode.segment.rehearseTitle', { n: number }) }}</button>
        <div v-if="composedUrl" :class="['final-preview', { 'junction-flash': flashed }]">
          <video :src="mediaUrl(composedUrl)" :poster="posterOf(mediaUrl(composedUrl))" controls preload="none" @loadedmetadata="playedFinalSeconds = $event.target.duration" @timeupdate="timeUpdate" />
          <div class="junction-track"><span v-if="junctionPercent !== null" class="junction-tick" :style="{ left: `${junctionPercent}%` }" :title="t('episode.final.junction', { seconds: junctionAt.toFixed(1) })">◆</span></div>
        </div>
        <NarrationBlock ref="narrationBlock" :storyboard="sb" :narration-batch="ctx.narrationBatch.value" :episode-normalize="ctx.episodeNarrationNormalize.value" :episode-timing="ctx.episodeSubtitleTiming.value" :show-fit="false" :field-save="ctx.fieldSaveInfo(sb, 'narration_text')" @field-dirty="ctx.markFieldDirty" @update-field="ctx.updateField" @refresh="ctx.refresh" />
        <p>{{ t('episode.final.subtitle') }}</p>
        <ShotFusionPanel ref="fusionPanel" :storyboard="sb" :compose-state="ctx.composeStateOf(sb)" :narration-enabled="ctx.narrationEnabledOf.value" :episode-fit-default="ctx.episodeFitDefault.value" :episode-mix-mode="ctx.episodeAudioMixMode.value" :narration-save="ctx.fieldSaveInfo(sb, 'narration_text')" @refresh="ctx.refresh" @composed="ctx.onShotComposed" @open-batch="$emit('compose-batch')" @preview-fusion="preview = '';" />
        <button v-if="nextShot" class="btn btn-sm" @click="ctx.prodTab.value = 'design'">{{ t('episode.final.continuity') }} · {{ ctx.shotInheritsFirst(nextShot) ? t('episode.final.continue') : t('episode.final.cut') }} ↗</button>
      </section>
    </template>
    <RehearsalDialog v-if="rehearsal" :storyboard="sb" :shot-number="number" :combo="sb.combo" :segment="segment" :junction="junction" :budget="budget" :aspect-ratio="ctx.dramaAspectRatio.value" @close="rehearsal = false" />
  </article>
</template>

<style scoped>
.final-shot{border:1px solid var(--border);border-radius:10px;background:var(--bg-1)}
.final-shot-head,.final-zone h3{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.final-shot-head{padding:14px;border-bottom:1px solid var(--border)}
.final-zone{padding:16px;border-bottom:1px solid var(--border)}.final-zone h3{margin:0 0 12px;font-size:14px}.final-zone video{display:block;width:100%;max-width:680px;max-height:380px;background:var(--bg-2);margin:12px 0}.final-zone textarea{display:block;width:100%;min-height:110px;margin:10px 0}.final-warning{color:var(--warning);padding:8px}.final-info{color:var(--text-2)}.final-history{display:flex;gap:8px;flex-wrap:wrap}.final-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,240px));gap:12px}.final-slots img{width:100%;height:130px;object-fit:contain}.final-slot-thumb{display:block;padding:0;border:0;background:none;cursor:zoom-in}.final-slots span,.final-slots small{display:flex;gap:4px}.final-preview{max-width:680px;border:2px solid transparent;border-radius:6px;transition:border-color .15s}.final-preview.junction-flash{border-color:var(--accent)}.junction-track{position:relative;height:22px;margin:0 10px;background:var(--bg-2)}.junction-tick{position:absolute;transform:translateX(-50%);color:var(--accent)}
</style>
