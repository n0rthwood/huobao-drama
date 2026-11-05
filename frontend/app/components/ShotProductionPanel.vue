<script setup>
/**
 * 分镜制作（Issue #54 抽出挂载点）
 *
 * R1 把纪录片分支原有的两段整体搬进来，能力不丢：
 * ① 旁白覆盖 / 补全剩余条 ② 片段（图层）工作台 ③ 分镜与关键帧工作台。
 * R5 把这里重构成「图层段 + 生成段」合并工作区，`episode.vue` 不再改动。
 *
 * 关键帧工作台的属性与事件按原样透传（`$attrs`），避免在 episode.vue 里维护两份同样的绑定。
 */
import ClipWorkspace from '~/components/ClipWorkspace/ClipWorkspace.vue'
import NarrationCoverageBar from '~/components/NarrationCoverageBar.vue'
import StoryboardKeyframes from '~/components/StoryboardKeyframes.vue'

defineOptions({ inheritAttrs: false })

defineProps({
  episodeId: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
  focusClipStoryboardId: { type: Number, default: 0 },
})
const emit = defineEmits(['clips-changed', 'refresh'])
</script>

<template>
  <NarrationCoverageBar
    :episode-id="episodeId"
    :chat-model="chatModel"
    :chat-config-id="chatConfigId"
    @refresh="emit('refresh')"
  />
  <div class="prod-content">
    <ClipWorkspace
      :storyboards="storyboards"
      :focus-storyboard-id="focusClipStoryboardId"
      @changed="emit('clips-changed')"
    />
  </div>
  <StoryboardKeyframes
    v-bind="$attrs"
    :episode-id="episodeId"
    :storyboards="storyboards"
    :chat-model="chatModel"
    :chat-config-id="chatConfigId"
  />
</template>

<style scoped>
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
</style>
