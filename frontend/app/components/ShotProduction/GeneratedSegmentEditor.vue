<template>
  <div class="gs-root">
    <!-- D + 承接：首尾双锁，只有中间帧能出图 -->
    <p v-if="doubleLocked" class="gs-note">{{ t('episode.segment.doubleLock') }}</p>
    <!-- 衔接帧更新后：确认已作废，重出首/尾帧再确认视频 -->
    <p v-if="staleReason === 'junction_updated'" class="gs-warn">
      {{ t('episode.segment.junctionUpdated') }}
    </p>
    <!-- reference_not_mentioned：本镜参考素材没被槽位提示词 @ 到 -->
    <p v-for="issue in referenceIssues" :key="String(issue.reference || issue.message)" class="gs-note">
      {{ t('episode.segment.referenceNotMentioned', { name: String(issue.reference || '') }) }}
    </p>

    <StoryboardKeyframes
      class="gs-kf"
      embedded
      project-type="documentary"
      :locked-slot="lockedSlot"
      :storyboards="shots"
      :pool-candidates="poolCandidates"
      :set-pool-asset="setPoolAsset"
      :target-assets-for="targetAssetsFor"
      :asset-versions-for="assetVersionsFor"
      :set-target-version="setTargetVersion"
      :mention-options-for="mentionOptionsFor"
      :ref-kinds="refKinds"
      :image-model="imageModel"
      :image-config-id="imageConfigId"
      :image-model-label="imageModelLabel"
      :chat-model="chatModel"
      :chat-config-id="chatConfigId"
      :aspect-ratio="aspectRatio"
      :breaking="breaking"
      :agent-busy="agentBusy"
      :field-save="fieldSave"
      :narration-enabled="narrationEnabled"
      :episode-timing="episodeTiming"
      :episode-mix-mode="episodeMixMode"
      :episode-fit-default="episodeFitDefault"
      :episode-normalize="episodeNormalize"
      :narration-batch="narrationBatch"
      :narration-voice-batch="narrationVoiceBatch"
      @refresh="emit('refresh')"
      @preview="(src, title) => emit('preview', src, title)"
      @goto-assets="emit('goto-assets')"
      @open-asset="(asset) => emit('open-asset', asset)"
      @update-field="(sb, field, value) => emit('update-field', sb, field, value)"
      @field-dirty="(sb, field, value) => emit('field-dirty', sb, field, value)"
      @goto-layer="emit('goto-layer')"
    />
  </div>
</template>

<script setup>
/**
 * 生成段编辑器（Issue #58）：剧情项目的单镜关键帧编辑器本体（StoryboardKeyframes 嵌入模式），
 * 外加衔接帧的锁定槽（◆「🔒 衔接帧」卡片，不出图、无提示词、无版本）与一致性问题提示。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import StoryboardKeyframes from '~/components/StoryboardKeyframes.vue'

const props = defineProps({
  // 选中镜（单元素数组，StoryboardKeyframes 只渲染它）
  storyboard: { type: Object, required: true },
  // 后端 keyframes.locked：{ slot, source, t, path, hash, stale } | null
  lockedSlot: { type: Object, default: null },
  // 后端 issues[] 里的 reference_not_mentioned
  issues: { type: Array, default: () => [] },
  poolCandidates: { type: Function, default: () => [] },
  setPoolAsset: { type: Function, default: async () => {} },
  targetAssetsFor: { type: Function, default: () => [] },
  assetVersionsFor: { type: Function, default: () => [] },
  setTargetVersion: { type: Function, default: async () => {} },
  mentionOptionsFor: { type: Function, default: () => [] },
  refKinds: { type: Array, default: () => [] },
  imageModel: { type: String, default: '' },
  imageConfigId: { type: Number, default: 0 },
  imageModelLabel: { type: String, default: '' },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
  aspectRatio: { type: String, default: '16:9' },
  breaking: { type: Boolean, default: false },
  agentBusy: { type: Boolean, default: false },
  fieldSave: { type: Function, default: () => ({ status: 'idle', at: 0 }) },
  narrationEnabled: { type: Boolean, default: false },
  episodeTiming: { type: String, default: 'sentence' },
  episodeMixMode: { type: String, default: 'replace' },
  episodeFitDefault: { type: Object, default: null },
  episodeNormalize: { type: Boolean, default: true },
  narrationBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
  narrationVoiceBatch: { type: Object, default: () => ({ running: false, total: 0, completed: 0 }) },
})
const emit = defineEmits([
  'refresh', 'preview', 'goto-assets', 'open-asset', 'update-field', 'field-dirty', 'goto-layer',
])
const { t } = useI18n()

const shots = computed(() => [props.storyboard])
const kf = computed(() => props.storyboard?.keyframes || {})
const lockedSlots = computed(() => {
  const list = kf.value.locked_slots
  return Array.isArray(list) ? list : []
})
const staleReason = computed(() => kf.value.stale_reason ?? kf.value.staleReason ?? null)
// 首尾双锁：衔接帧占了一头，承接（inherits_first 或首帧锁）占了另一头，只剩中间帧可出图
const doubleLocked = computed(() => {
  const locked = lockedSlots.value
  const inherits = Boolean(kf.value.inherits_first ?? kf.value.inheritsFirst)
  const firstLocked = locked.includes('first') || inherits
  const lastLocked = locked.includes('last')
  return firstLocked && lastLocked
})
const referenceIssues = computed(() => props.issues.filter(issue => issue.code === 'reference_not_mentioned'))
</script>

<style scoped>
.gs-root { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.gs-kf { flex: 1; min-height: 0; }
.gs-note { margin: 0; padding: 6px 8px; font-size: 12px; color: var(--text-2); border: 1px solid var(--border); border-radius: 8px; background: var(--surface-card); }
.gs-warn { margin: 0; padding: 6px 8px; font-size: 12px; color: #8a6508; border: 1px solid #d8a93a; border-radius: 8px; background: rgba(216, 169, 58, 0.12); }
</style>
