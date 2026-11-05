<template>
  <div class="overlay" @click.self="emit('close')">
    <div ref="dialogEl" class="dialog rh-dialog" tabindex="-1" @keydown.esc.stop.prevent="emit('close')">
      <header class="dialog-head">
        <h2 class="dialog-title">{{ t('episode.segment.rehearseTitle', { n: shotNo }) }}</h2>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div class="dialog-body rh-body">
        <div class="rh-stage" :style="{ aspectRatio: previewAspect }">
          <img v-if="activeSrc" class="rh-frame" :src="activeSrc" alt="">
          <div v-else class="rh-empty">{{ t('episode.segment.rehearseEmptySlot') }}</div>
          <div class="rh-progress" :style="{ width: `${percent}%` }" />
        </div>

        <div class="rh-timeline">
          <div
            v-for="cell in displayCells" :key="cell.key"
            :class="['rh-cell', 'is-' + cell.kind, { on: cell.active }]"
            :style="{ flexGrow: cell.seconds || 0.2 }"
          >
            <div class="rh-cell-head">
              <span class="rh-cell-glyph">{{ cell.kind === 'junction' ? '◆' : cell.glyph }}</span>
              <span class="rh-cell-label">{{ cell.label }}</span>
              <span class="rh-cell-time mono">{{ cell.seconds.toFixed(1) }}s</span>
            </div>
            <img v-if="cell.src" class="rh-cell-img" :src="cell.src" alt="">
          </div>
        </div>

        <div class="rh-controls">
          <button type="button" class="btn btn-sm" :disabled="!totalSeconds" @click="togglePlay">
            {{ playing ? t('episode.segment.rehearsePause') : t('episode.segment.rehearsePlay') }}
          </button>
          <span class="mono rh-clock">{{ elapsed.toFixed(2) }}s / {{ totalSeconds.toFixed(2) }}s</span>
          <span class="dim" style="font-size:11px">{{ hasNarration ? t('episode.segment.rehearseNarration') : t('episode.segment.rehearseEstimate') }}</span>
        </div>

        <p class="rh-note">{{ t('episode.segment.rehearseNote') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 本镜预演（Issue #58）：按时长比例的帧条——图层段按需取 6–10 帧缩略图，
 * 生成段用已有首/中/尾图（缺的留空槽占位），◆ 衔接帧高亮。
 * 播放只是推拉示意 + 交叉淡化；有配音音频时以音频时间轴为准，否则走估算进度线。
 * 预演不代表最终视频效果。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { layerSegmentAPI } from '~/composables/useApi'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  storyboard: { type: Object, required: true },
  shotNumber: { type: Number, default: 0 },
  combo: { type: String, default: '' },
  segment: { type: Object, default: null },
  junction: { type: Object, default: null },
  budget: { type: Object, default: () => ({}) },
  aspectRatio: { type: String, default: '16:9' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const LAYER_FRAME_COUNT = 8
const shotNo = computed(() => String(props.shotNumber || 0).padStart(2, '0'))
const previewAspect = computed(() => String(props.aspectRatio || '16:9').replace(':', ' / ') || '16 / 9')

const hasLayer = computed(() => ['A', 'C', 'D'].includes(props.combo))
const hasGen = computed(() => ['B', 'C', 'D'].includes(props.combo))
const layerSeconds = computed(() => (hasLayer.value ? Number(props.segment?.duration || props.budget?.layer_s || 0) : 0))
const genSeconds = computed(() => (hasGen.value ? Number(props.budget?.gen_s || 15) : 0))
const totalSeconds = computed(() => Math.max(0.1, layerSeconds.value + genSeconds.value))

const kf = computed(() => props.storyboard?.keyframes || {})
const narrationAudio = computed(() => props.storyboard?.narration_audio_url || props.storyboard?.narrationAudioUrl || '')
const hasNarration = computed(() => Boolean(narrationAudio.value))

/** 图层段：按时间轴等分取帧（最多 10 帧） */
const layerFrames = computed(() => {
  if (!hasLayer.value) return []
  const seconds = layerSeconds.value
  if (seconds <= 0) return []
  const count = Math.max(2, Math.min(10, LAYER_FRAME_COUNT + (seconds > 12 ? 2 : 0)))
  const fps = Number(props.segment?.timeline?.fps || 25)
  const frames = []
  for (let i = 0; i < count; i++) {
    const t = (seconds * i) / Math.max(1, count - 1)
    const index = Math.min(Math.max(0, Math.round(t * fps)), Math.max(0, Math.round(seconds * fps) - 1))
    frames.push({
      key: `layer-${i}`,
      src: layerSegmentAPI.thumbnailUrl(props.storyboard.id, `frame-${index}`, props.segment?.junction_hash || props.segment?.id || 0),
      at: t,
    })
  }
  return frames
})

const cells = computed(() => {
  const list = []
  const addGen = () => {
    const slots = [
      { slot: 'first', label: t('episode.kf.slotFirst'), src: kf.value.first_image ?? kf.value.firstImage },
      { slot: 'mid', label: t('episode.kf.slotMid'), src: kf.value.mid_image ?? kf.value.midImage },
      { slot: 'last', label: t('episode.kf.slotLast'), src: kf.value.last_image ?? kf.value.lastImage },
    ]
    const seconds = genSeconds.value / slots.length
    for (const item of slots) {
      list.push({
        key: `gen-${item.slot}`,
        kind: 'gen',
        glyph: '▶',
        label: item.label,
        seconds,
        src: item.src ? mediaUrl(item.src) : '',
        startAt: 0,
      })
    }
  }
  const addJunction = (atSeconds) => {
    list.push({
      key: 'junction',
      kind: 'junction',
      glyph: '◆',
      label: t('episode.segment.junctionShort'),
      seconds: 0,
      src: props.junction?.path ? layerSegmentAPI.junctionUrl(props.storyboard.id, props.junction.hash || 0) : '',
      junctionAt: atSeconds,
    })
  }

  const addLayer = () => {
    for (const frame of layerFrames.value) {
      list.push({
        key: frame.key,
        kind: 'layer',
        glyph: '▣',
        label: t('episode.segment.layerShort'),
        seconds: layerSeconds.value / Math.max(1, layerFrames.value.length),
        src: frame.src,
        startAt: frame.at,
      })
    }
  }

  // D = 生成段在前、图层段在后；◆ 落在两段交界处
  if (props.combo === 'D') {
    if (hasGen.value) addGen()
    if (hasLayer.value && hasGen.value) addJunction(genSeconds.value)
    if (hasLayer.value) addLayer()
    return list
  }
  if (hasLayer.value) addLayer()
  if (hasLayer.value && hasGen.value) addJunction(layerSeconds.value)
  if (hasGen.value) addGen()
  return list
})

/** 每一格的起始时刻（秒）与结束时刻 */
const spans = computed(() => {
  let cursor = 0
  return cells.value.map(cell => {
    const start = cell.kind === 'junction' ? Number(cell.junctionAt || 0) : cursor
    const end = cell.kind === 'junction' ? start : cursor + (cell.seconds || 0)
    if (cell.kind !== 'junction') cursor = end
    return { key: cell.key, start, end }
  })
})

const elapsed = ref(0)
const playing = ref(false)
let timer = null
let audioEl = null

const percent = computed(() => Math.min(100, (elapsed.value / totalSeconds.value) * 100))

/** 当前高亮格：图层段按时间取对应帧；生成段按时段；◆ 在其时刻附近高亮 */
const activeKey = computed(() => {
  const time = elapsed.value
  let best = ''
  for (const span of spans.value) {
    if (span.start <= time + 1e-6 && time < span.end + 1e-6) best = span.key
  }
  // ◆ 在衔接时刻 ±0.25s 内优先高亮
  const junctionSpan = spans.value.find(span => span.key === 'junction')
  if (junctionSpan && Math.abs(time - junctionSpan.start) < 0.25) return 'junction'
  return best || spans.value[0]?.key || ''
})

const displayCells = computed(() => cells.value.map(cell => ({ ...cell, active: cell.key === activeKey.value })))

const activeSrc = computed(() => {
  // 生成段：按进度在首/中/尾之间硬切，模拟推拉
  const cell = cells.value.find(item => item.key === activeKey.value)
  return cell?.src || ''
})

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null }
}

function tick() {
  if (hasNarration.value && audioEl && !audioEl.paused) {
    elapsed.value = Math.min(totalSeconds.value, audioEl.currentTime)
  } else {
    elapsed.value = Math.min(totalSeconds.value, elapsed.value + 0.1)
  }
  if (elapsed.value >= totalSeconds.value) {
    playing.value = false
    stopTimer()
  }
}

function togglePlay() {
  if (playing.value) {
    playing.value = false
    stopTimer()
    audioEl?.pause()
    return
  }
  if (elapsed.value >= totalSeconds.value) elapsed.value = 0
  playing.value = true
  if (hasNarration.value) {
    if (!audioEl) {
      audioEl = new Audio(mediaUrl(narrationAudio.value))
      audioEl.preload = 'auto'
    }
    audioEl.currentTime = elapsed.value
    audioEl.play().catch(() => { /* 自动播放被拒：退回估算进度线 */ })
  }
  stopTimer()
  timer = setInterval(tick, 100)
}

watch(() => props.storyboard?.id, () => { elapsed.value = 0 })

onBeforeUnmount(() => {
  stopTimer()
  audioEl?.pause()
  audioEl = null
})
</script>

<style scoped>
.rh-dialog { max-width: 880px; width: 94vw; }
.rh-body { display: flex; flex-direction: column; gap: 10px; }
.rh-stage { position: relative; width: 100%; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface-base); }
.rh-frame { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
.rh-empty { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; color: var(--text-3); }
.rh-progress { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--accent); transition: width 0.1s linear; }
.rh-timeline { display: flex; gap: 3px; align-items: stretch; }
.rh-cell { min-width: 0; border: 1px solid var(--border); border-radius: 6px; padding: 4px; background: var(--surface-card); overflow: hidden; }
.rh-cell.on { border-color: var(--accent); }
.rh-cell.is-junction { flex-grow: 0 !important; width: 44px; border-color: #d8a93a; }
.rh-cell-head { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); }
.rh-cell-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rh-cell-img { width: 100%; height: 44px; object-fit: cover; border-radius: 4px; margin-top: 3px; }
.rh-controls { display: flex; align-items: center; gap: 10px; }
.rh-clock { font-size: 12px; color: var(--text-2); }
.rh-note { margin: 0; font-size: 12px; color: var(--text-3); }
</style>
