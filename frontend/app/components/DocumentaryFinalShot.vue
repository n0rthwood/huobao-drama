<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers, Sparkles, Lock } from 'lucide-vue-next'
import { layerSegmentAPI, taskAPI, storyboardAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { WORKBENCH_CTX } from '~/utils/workbenchSteps'
import { mediaUrl } from '~/utils/url'
import { budgetOf, measuredSecondsOf, zonesOf, junctionSecondsOf } from '~/utils/documentaryFinal'
import RehearsalDialog from '~/components/ShotProduction/RehearsalDialog.vue'
import NarrationBlock from '~/components/NarrationBlock.vue'
import ShotFusionPanel from '~/components/ShotFusionPanel.vue'
import MentionTextarea from '~/components/MentionTextarea.vue'
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
const segmentState = ref(null)
const segment = computed(() => segmentState.value?.segment)
const junction = computed(() => segmentState.value?.junction)
const rendering = ref(false)
const rehearsal = ref(false)
const overConfirm = ref(false)
const history = ref([])
const preview = ref('')
const generatedSeconds = ref(0)
const finalSeconds = ref(0)
const elapsed = ref(0)
const flashed = ref(false)
let flashTimer
const layerSeconds = computed(() => Number(segment.value?.duration || 0))
const composedMeta = computed(() => (sb.value.narration_meta || sb.value.narrationMeta || {}).composed || {})
const junctionAt = computed(() => zones.value.layer && zones.value.generated ? composedMeta.value.junction_s ?? junctionSecondsOf(sb.value.combo, layerSeconds.value, generatedSeconds.value) : null)
const junctionPercent = computed(() => junctionAt.value !== null && finalSeconds.value > 0 ? Math.max(0, Math.min(100, junctionAt.value / finalSeconds.value * 100)) : null)
const composedUrl = computed(() => ctx.composeStateOf(sb.value)?.composed_video_url || sb.value.composed_video_url || sb.value.composedVideoUrl || '')
const videoUrl = computed(() => preview.value || ctx.getVideoUrl(sb.value))
const disabledReason = computed(() => !zones.value.generated ? t('episode.final.noCombo') : !ctx.isShotConfirmed(sb.value) ? t('episode.kf.gateShotUnconfirmed') : ctx.videoBlockIssues(sb.value).length ? ctx.videoBlockReason(sb.value) : ctx.videoBatchRunning.value ? t('episode.vid.batchAlreadyRunning') : ctx.videoTaskState(sb.value) === 'pending' ? t('episode.vid.emptyGenerating') : '')
const layerStatus = computed(() => rendering.value ? t('episode.final.rendering') : segment.value?.stale_reason ? segment.value.stale_reason : segment.value?.fresh ? t('episode.final.fresh') : segment.value?.status === 'failed' ? t('episode.final.failed') : t('episode.final.stale'))
async function load() {
  try {
    const [state, tasks] = await Promise.all([zones.value.layer ? layerSegmentAPI.get(sb.value.id) : Promise.resolve(null), zones.value.generated ? taskAPI.list({ type: 'video', storyboard_id: sb.value.id }) : Promise.resolve([])])
    segmentState.value = state
    history.value = (Array.isArray(tasks) ? tasks : tasks?.items || []).filter(task => task.provider !== 'layer-segment')
  } catch (error) { toastError(error) }
}
watch(() => [sb.value.id, sb.value.updated_at, sb.value.updatedAt, sb.value.videoUrl, sb.value.video_url, sb.value.keyframes?.confirmed, ctx.videoTaskState(sb.value)], load, { immediate: true })
async function render() {
  rendering.value = true
  try { await layerSegmentAPI.render(sb.value.id); await Promise.all([load(), ctx.refresh()]) } catch (error) { toastError(error) } finally { rendering.value = false }
}
function generate() {
  if (disabledReason.value) return
  if (measured.value > budgetTotal.value && !overConfirm.value) { overConfirm.value = true; return }
  overConfirm.value = false
  ctx.genVid(sb.value)
}
function historyPath(item) { return ctx.taskVideoPath(item) }
const retryingTask = ref(null)
const historyActive = computed(() => history.value.some(item => ['pending', 'queued', 'processing', 'running'].includes(item.status)))
async function retryHistory(item) {
  if (retryingTask.value || historyActive.value || disabledReason.value) return
  retryingTask.value = item.id
  try {
    const task = await taskAPI.retry(item.id)
    history.value = [task, ...history.value]
    await ctx.refresh()
  } catch (error) { toastError(error) } finally { retryingTask.value = null }
}
async function activateHistory() {
  try { await storyboardAPI.update(sb.value.id, { video_url: preview.value }); preview.value = ''; await ctx.refresh() } catch (error) { toastError(error) }
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
onBeforeUnmount(() => clearTimeout(flashTimer))
</script>

<template>
  <article :id="`final-shot-${sb.id}`" class="final-shot">
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
        <h3><Layers :size="15" />① {{ t('episode.final.layer') }} · {{ layerSeconds.toFixed(1) }}s · {{ layerStatus }}</h3>
        <video v-if="segment?.render_path" :src="mediaUrl(segment.render_path)" controls preload="metadata" />
        <button class="btn btn-sm" :disabled="rendering || !segment || !segmentState?.production_unlocked" @click="render">{{ t('episode.final.render') }}</button>
        <span v-if="segmentState?.gate_reason" class="final-warning">{{ segmentState.gate_reason }}</span>
      </section>
      <section v-if="zones.generated" class="final-zone" data-zone="generated">
        <h3><Sparkles :size="15" />② {{ t('episode.final.generated') }} · {{ budget.gen_s }}s · {{ ctx.videoTaskStatusLabel(sb) }}</h3>
        <video v-if="ctx.getVideoUrl(sb)" :src="mediaUrl(ctx.getVideoUrl(sb))" style="display:none" preload="metadata" @loadedmetadata="generatedSeconds = $event.target.duration" />
        <p v-if="!measured" class="final-info">{{ t('episode.narration.noAudio') }}</p>
        <div v-if="!ctx.isShotConfirmed(sb)" class="final-warning">
          {{ t('episode.kf.gateShotUnconfirmed') }}
          <button class="btn btn-sm" @click="ctx.gotoShotProduction(sb)">{{ t('episode.production.gotoShotProduction') }}</button>
        </div>
        <template v-else>
          <div class="final-slots">
            <div v-for="slot in ctx.KEYFRAME_SLOTS.value" :key="slot.slot">
              <img v-if="ctx.shotKeyframeImage(sb, slot.slot)" :src="mediaUrl(ctx.shotKeyframeImage(sb, slot.slot))" :alt="slot.label" />
              <span>{{ slot.label }}</span>
              <small v-if="locked(slot.slot)"><Lock :size="12" />{{ slotLock(slot.slot)?.source === 'previous_last' ? t('episode.segment.junctionInheritPrev') : t('episode.final.inherited', { seconds: Number(slotLock(slot.slot)?.t || 0).toFixed(1) }) }}<span v-if="slotLock(slot.slot)?.stale"> · {{ t('episode.final.stale') }}</span></small>
            </div>
          </div>
          <div>{{ t('episode.sb.videoPromptSection') }}
            <MentionTextarea :model-value="sb.video_prompt || sb.videoPrompt || ''" :options="ctx.shotMentionOptions(sb)" :rows="8" @update:model-value="value => ctx.markFieldDirty(sb, 'video_prompt', value)" @commit="value => ctx.updateField(sb, 'video_prompt', value)" />
          </div>
          <button class="btn btn-sm" :disabled="ctx.videoPromptGeneratingIds.value.includes(sb.id)" @click="ctx.genVideoPrompt(sb)">{{ ctx.promptHeadVideoActionLabel(sb) }}</button>
          <video v-if="videoUrl" :src="mediaUrl(videoUrl)" controls preload="metadata" />
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
        <h3>③ {{ t('episode.final.composite') }}</h3>
        <button class="btn btn-sm" @click="rehearsal = true">{{ t('episode.segment.rehearseTitle', { n: number }) }}</button>
        <div v-if="composedUrl" :class="['final-preview', { 'junction-flash': flashed }]">
          <video :src="mediaUrl(composedUrl)" controls preload="metadata" @loadedmetadata="finalSeconds = $event.target.duration" @timeupdate="timeUpdate" />
          <div class="junction-track"><span v-if="junctionPercent !== null" class="junction-tick" :style="{ left: `${junctionPercent}%` }" :title="t('episode.final.junction', { seconds: junctionAt.toFixed(1) })">◆</span></div>
        </div>
        <NarrationBlock :storyboard="sb" :narration-batch="ctx.narrationBatch.value" :episode-normalize="ctx.episodeNarrationNormalize.value" :episode-timing="ctx.episodeSubtitleTiming.value" :show-fit="false" :field-save="ctx.fieldSaveInfo(sb, 'narration_text')" @field-dirty="ctx.markFieldDirty" @update-field="ctx.updateField" @refresh="ctx.refresh" />
        <p>{{ t('episode.final.subtitle') }}</p>
        <ShotFusionPanel :storyboard="sb" :compose-state="ctx.composeStateOf(sb)" :narration-enabled="ctx.narrationEnabledOf.value" :episode-fit-default="ctx.episodeFitDefault.value" :episode-mix-mode="ctx.episodeAudioMixMode.value" :narration-save="ctx.fieldSaveInfo(sb, 'narration_text')" @refresh="ctx.refresh" @composed="ctx.onShotComposed" @open-batch="$emit('compose-batch')" @preview-fusion="preview = '';" />
        <button v-if="nextShot" class="btn btn-sm" @click="ctx.prodTab.value = 'design'">{{ t('episode.final.continuity') }} · {{ ctx.shotInheritsFirst(nextShot) ? t('episode.final.continue') : t('episode.final.cut') }} ↗</button>
      </section>
    </template>
    <RehearsalDialog v-if="rehearsal" :storyboard="sb" :shot-number="number" :combo="sb.combo" :segment="segment" :junction="junction" :budget="budget" :aspect-ratio="ctx.dramaAspectRatio.value" @close="rehearsal = false" />
  </article>
</template>

<style scoped>
.final-shot{border:1px solid var(--border);border-radius:10px;margin:16px 0;background:var(--bg-1)}
.final-shot-head,.final-zone h3{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.final-shot-head{padding:14px;border-bottom:1px solid var(--border)}
.final-zone{padding:16px;border-bottom:1px solid var(--border)}.final-zone h3{margin:0 0 12px;font-size:14px}.final-zone video{display:block;width:100%;max-width:680px;max-height:380px;background:var(--bg-2);margin:12px 0}.final-zone textarea{display:block;width:100%;min-height:110px;margin:10px 0}.final-warning{color:var(--warning);padding:8px}.final-info{color:var(--text-2)}.final-history{display:flex;gap:8px;flex-wrap:wrap}.final-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,240px));gap:12px}.final-slots img{width:100%;height:130px;object-fit:contain}.final-slots span,.final-slots small{display:flex;gap:4px}.final-preview{max-width:680px;border:2px solid transparent;border-radius:6px;transition:border-color .15s}.final-preview.junction-flash{border-color:var(--accent)}.junction-track{position:relative;height:22px;margin:0 10px;background:var(--bg-2)}.junction-tick{position:absolute;transform:translateX(-50%);color:var(--accent)}
</style>
