<template>
  <div class="cc-card">
    <div class="cc-head">
      <span class="cc-title">{{ t('episode.clip.cardTitle') }}</span>
      <span class="tag">{{ t(`episode.intent.clipLabel.${position}`) }}</span>
      <span v-if="clip" class="tag mono">{{ clip.duration }}s</span>
      <span :class="['cc-state', 'is-' + status]">{{ t(`episode.clip.status.${status}`) }}</span>
      <span class="ml-auto" />
      <button type="button" class="btn btn-sm" @click="emit('edit')">{{ t('episode.clip.gotoEditor') }}</button>
      <button type="button" class="btn btn-sm btn-primary" :disabled="!clip || rendering" @click="emit('render')">
        {{ rendering ? t('episode.clip.rendering') : t('episode.clip.render') }}
      </button>
    </div>
    <p v-if="status === 'stale'" class="cc-stale">{{ t('episode.clip.staleWarn') }}</p>
    <p v-if="!clip" class="cc-empty">{{ t('episode.clip.cardNoClip') }}</p>
    <video
      v-else-if="clip.render_path"
      :key="clip.render_path"
      :src="mediaUrl(clip.render_path)"
      controls preload="metadata" playsinline class="cc-video"
    />
    <p v-else class="cc-empty">{{ t('episode.clip.cardDraftOnly') }}</p>
  </div>
</template>

<script setup>
/** 确定性片段卡（Issue #50）：视频制作页里代替「生成视频」的那张卡，状态 + 预览 + 两个入口。 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { mediaUrl } from '~/utils/url'

const props = defineProps({
  clip: { type: Object, default: null },
  // 本镜表达设计里的片段位置（草稿还没生成时也要能显示）
  position: { type: String, default: 'replace' },
  rendering: { type: Boolean, default: false },
})
const emit = defineEmits(['edit', 'render'])
const { t } = useI18n()

const status = computed(() => {
  const clip = props.clip
  if (!clip) return 'none'
  if (clip.status === 'failed') return 'failed'
  if (clip.status === 'rendering') return 'rendering'
  if (!clip.render_path) return 'draft'
  return clip.fresh ? 'ready' : 'stale'
})
</script>

<style scoped>
.cc-card { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface-card); display: flex; flex-direction: column; gap: 6px; }
.cc-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cc-title { font-size: 12.5px; color: var(--text-1); font-weight: 600; }
.cc-state { font-size: 11px; color: var(--text-3); }
.cc-state.is-ready { color: #2e8b57; }
.cc-state.is-stale, .cc-state.is-failed { color: #c0472e; }
.cc-stale { margin: 0; font-size: 11px; color: #c0472e; }
.cc-empty { margin: 0; font-size: 12px; color: var(--text-3); }
.cc-video { width: 100%; max-width: 420px; display: block; border-radius: 6px; }
</style>
