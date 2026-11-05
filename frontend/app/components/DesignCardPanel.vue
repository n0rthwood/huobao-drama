<script setup>
/**
 * 分镜设计（Issue #54 抽出挂载点）
 *
 * R1 把 `episode.vue` 的旁白覆盖条 + 表达设计面板整体搬进来，能力不丢；
 * R4 用「导演分镜单」设计卡替换本组件内部，`episode.vue` 不再改动。
 */
import NarrationCoverageBar from '~/components/NarrationCoverageBar.vue'
import ShotIntentPanel from '~/components/ShotIntentPanel.vue'

defineProps({
  episodeId: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
  chatModel: { type: String, default: '' },
  chatConfigId: { type: Number, default: 0 },
})
const emit = defineEmits(['refresh'])
</script>

<template>
  <NarrationCoverageBar
    :episode-id="episodeId"
    :chat-model="chatModel"
    :chat-config-id="chatConfigId"
    @refresh="emit('refresh')"
  />
  <ShotIntentPanel
    :episode-id="episodeId"
    :storyboards="storyboards"
    :chat-model="chatModel"
    :chat-config-id="chatConfigId"
    @refresh="emit('refresh')"
  />
</template>
