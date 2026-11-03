<template>
  <div v-if="coverage.project_type === 'documentary' && coverage.script_chars" class="nc-bar" :class="{ 'has-gaps': coverage.gap_count > 0 }">
    <span class="nc-text">
      {{ t('episode.coverage.summary', { covered: coverage.covered_chars, total: coverage.script_chars }) }}
    </span>
    <span class="nc-track"><span class="nc-fill" :style="{ width: percent + '%' }" /></span>
    <span class="nc-percent mono">{{ percent }}%</span>
    <span v-if="coverage.gap_count" class="tag mono nc-gap-tag" :title="gapTitle">
      {{ t('episode.coverage.gaps', { n: coverage.gap_count, chars: coverage.uncovered_chars }) }}
    </span>
    <span v-else class="tag mono nc-ok-tag">{{ t('episode.coverage.complete') }}</span>
    <button
      v-if="coverage.gap_count"
      class="btn btn-sm ml-auto"
      :disabled="filling || coverage.running"
      :title="coverage.running ? t('episode.coverage.running') : gapTitle"
      @click="fill"
    >
      <Loader2 v-if="filling || coverage.running" :size="11" class="animate-spin" />
      {{ (filling || coverage.running) ? t('episode.coverage.filling') : t('episode.coverage.fill') }}
    </button>
  </div>
</template>

<script setup>
/**
 * 旁白覆盖条（Issue #52，纪录片项目）——分镜页与表达设计页顶部共用。
 * 拆分中断后剧本会剩下「没有被任何一镜领走」的缺口；这里显示覆盖进度，
 * 并用一个批量按钮「补全剩余」只补缺口（已拆分镜原样保留，任务进任务中心）。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { episodeAPI } from '~/composables/useApi'
import { toastServerMessage } from '~/composables/useToast'

const { t } = useI18n()

const props = defineProps({
  episodeId: { type: Number, default: 0 },
  // 顶栏文本模型覆盖，透传给补镜任务
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
})
const emit = defineEmits(['refresh'])

const EMPTY = {
  project_type: 'drama',
  script_chars: 0,
  covered_chars: 0,
  uncovered_chars: 0,
  gaps: [],
  gap_count: 0,
  shots: 0,
  running: false,
}
const coverage = ref({ ...EMPTY })
const filling = ref(false)
let timer = null

const percent = computed(() => (coverage.value.script_chars
  ? Math.min(100, Math.round((coverage.value.covered_chars / coverage.value.script_chars) * 100))
  : 0))
const gapTitle = computed(() => coverage.value.gaps
  .map(gap => t('episode.coverage.gapItem', { start: gap.start, end: gap.end, chars: gap.chars, excerpt: gap.excerpt }))
  .join('\n'))

async function load() {
  if (!props.episodeId) { coverage.value = { ...EMPTY }; return }
  try {
    const data = await episodeAPI.narrationCoverage(props.episodeId)
    const wasRunning = coverage.value.running
    coverage.value = { ...EMPTY, ...(data || {}) }
    // 补镜任务刚结束：分镜已重编号，通知父级重新拉列表
    if (wasRunning && !coverage.value.running) {
      filling.value = false
      emit('refresh')
    }
    if (coverage.value.running) schedule()
  } catch {
    // 覆盖条是只读信息，拉取失败时保持原样，不打断页面
  }
}

function schedule() {
  if (timer) return
  timer = setInterval(async () => {
    await load()
    if (!coverage.value.running && timer) { clearInterval(timer); timer = null }
  }, 5000)
}

async function fill() {
  if (filling.value || !props.episodeId) return
  filling.value = true
  try {
    const res = await episodeAPI.fillStoryboardGaps(props.episodeId, {
      model: props.chatModel || undefined,
      config_id: props.chatConfigId || undefined,
    })
    if (res?.status !== 'running') {
      filling.value = false
      toast.info(t('episode.coverage.complete'))
      await load()
      emit('refresh')
      return
    }
    toast.info(t('episode.coverage.started', { n: res.gaps }))
    coverage.value = { ...coverage.value, running: true }
    schedule()
  } catch (e) {
    filling.value = false
    toastServerMessage(e, { fallback: 'episode.coverage.failed' })
  }
}

watch(() => props.episodeId, load)
onMounted(load)
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

defineExpose({ reload: load })
</script>

<style scoped>
.nc-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-soft, rgba(127, 127, 127, 0.06));
  font-size: 12px;
}
.nc-bar.has-gaps { border-color: #d08a21; }
.nc-text { color: var(--text-dim, #888); }
.nc-track {
  position: relative;
  width: 160px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.25);
}
.nc-fill { position: absolute; inset: 0 auto 0 0; background: #3b9a62; }
.nc-bar.has-gaps .nc-fill { background: #d08a21; }
.nc-percent { font-size: 11px; }
.nc-gap-tag { color: #d08a21; }
.nc-ok-tag { color: #3b9a62; }
</style>
