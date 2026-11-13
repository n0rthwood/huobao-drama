<template>
  <div v-if="summary.total || overview?.available" class="video-queue-bar">
    <span class="video-queue-title">{{ t('episode.vid.queueTitle') }}</span>
    <span class="video-queue-sep">·</span>
    <span>{{ t('episode.vid.queueSummary', { running: summary.running, queued: summary.queued }) }}</span>
    <template v-if="etaText">
      <span class="video-queue-sep">·</span>
      <span class="video-queue-eta">{{ etaText }}</span>
    </template>
    <template v-if="overview?.available">
      <span class="video-queue-sep">·</span>
      <span :title="t('episode.vid.queueOverallHint')">{{ t('episode.vid.queueOverall', {
        running: overview.counts?.running ?? 0,
        queued: overview.counts?.queued ?? 0,
        idle: overview.workers?.idle ?? 0,
        total: overview.workers?.total ?? 0,
      }) }}</span>
      <template v-if="overview.estimated_wait_seconds != null">
        <span class="video-queue-sep">·</span>
        <span>{{ t('episode.vid.queueWait', { time: formatSeconds(t, overview.estimated_wait_seconds) || t('episode.vid.queueNoWait') }) }}</span>
      </template>
    </template>
    <template v-if="summary.total">
      <div class="video-queue-progress" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
        <span class="video-queue-progress-fill" :style="{ width: percent + '%' }" />
      </div>
      <span class="video-queue-percent">{{ t('episode.vid.queueProgress', { percent }) }}</span>
    </template>
  </div>
</template>

<script setup>
/**
 * 视频生成队列汇总条（Issue #100）：本集活跃视频任务的「生成中 / 排队 / 整体进度 / 预计全部完成」，
 * 视频配置是 h3-jobs 队列时再加队列整体「运行 / 排队 / 空闲卡 / 新任务预计等待」。
 * 本集明细来自全局任务 store（含提交在途、尚无远端 id 的任务，按排队计）；队列整体来自
 * GET /video-queue/overview，两者分开标注。队列不可达时只显示本集部分。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatSeconds, summarizeTasks, useNowTicker } from '~/composables/useTaskProgress'
import { videoQueueAPI } from '~/composables/useApi'

const props = defineProps({
  /** 本集活跃（queued/processing）视频任务 */
  tasks: { type: Array, default: () => [] },
  /** 生效的视频配置 id；不是队列配置时后端返回 available:false */
  configId: { type: Number, default: null },
})

const { t } = useI18n()
const now = useNowTicker()
const summary = computed(() => summarizeTasks(props.tasks, now.value))
const percent = computed(() => Math.round(summary.value.progress * 100))
const etaText = computed(() => summary.value.etaSeconds === null
  ? ''
  : t('episode.vid.queueEta', { time: formatSeconds(t, summary.value.etaSeconds) }))

const overview = ref(null)
let timer = null
let seq = 0
async function loadOverview() {
  const mine = ++seq
  try {
    const data = await videoQueueAPI.overview(props.configId || undefined)
    if (mine === seq) overview.value = data
  } catch {
    if (mine === seq) overview.value = null
  }
}
function schedule() {
  if (timer) clearTimeout(timer)
  // 有本集任务在跑时与任务轮询同频（3 s），空闲时放慢
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await loadOverview()
    schedule()
  }, props.tasks.length ? 3000 : 15000)
}
watch(() => props.configId, () => { void loadOverview(); schedule() }, { immediate: true })
onBeforeUnmount(() => { if (timer) clearTimeout(timer); seq++ })
</script>

<style scoped>
.video-queue-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 10px;
  padding: 8px 11px;
  border: 1px solid var(--accent);
  border-radius: 8px;
  background: var(--bg-2);
  font-size: 12px;
  color: var(--text-2);
}
.video-queue-title { font-weight: 600; color: var(--text-1); }
.video-queue-sep { color: var(--text-3); }
.video-queue-eta { color: var(--accent); font-weight: 600; }
.video-queue-progress {
  flex: 1;
  min-width: 120px;
  height: 8px;
  border-radius: 4px;
  background: var(--bg-3, var(--bg-1));
  overflow: hidden;
}
.video-queue-progress-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.6s linear;
}
.video-queue-percent { font-variant-numeric: tabular-nums; }
</style>
