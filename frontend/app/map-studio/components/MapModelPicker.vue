<template>
  <div class="mp">
    <label class="mp-field">
      <span>{{ t('mapStudio.panel.textConfig') }}</span>
      <select class="input" :value="textConfigId" :disabled="disabled" @change="setText($event)">
        <option :value="0">{{ t('mapStudio.panel.defaultConfig') }}</option>
        <option v-for="option in options.text" :key="option.config_id" :value="option.config_id">
          {{ option.name }}<template v-if="option.vision">{{ t('mapStudio.models.visionSuffix') }}</template>
        </option>
      </select>
    </label>
    <label class="mp-field">
      <span>{{ t('mapStudio.panel.imageModel') }}</span>
      <select class="input" :value="imageKey" :disabled="disabled" @change="setImage($event)">
        <option value="">{{ t('mapStudio.panel.defaultConfig') }}</option>
        <option v-for="option in imageOptions" :key="option.key" :value="option.key">{{ option.label }}</option>
      </select>
    </label>
  </div>
</template>

<script setup lang="ts">
/**
 * 模型选择（Issue #99）：文本配置与图像「配置 · 模型」都来自模块的 `/model-options`。
 *
 * 模块有自己的模型设置（可切换），这里的值只影响下一次运行；图像模型只用于底纹，不参与地理形状的决定。
 * 选项只来自服务端给的 id / 名称 / 模型与能力，模块绝不请求或显示 key、base_url。
 */
import { useI18n } from 'vue-i18n'
import type { MapStudioModelOptions } from '~/map-studio/api'

const { t } = useI18n()

const props = defineProps<{
  options: MapStudioModelOptions
  textConfigId: number
  imageConfigId: number | null
  imageModel: string | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', value: { textConfigId: number, imageConfigId: number | null, imageModel: string | null }): void
}>()

/** `${config_id}:${model}`：与旧面板同口径，提交时再拆回两列 */
const imageKey = computed(() => (props.imageConfigId && props.imageModel ? `${props.imageConfigId}:${props.imageModel}` : ''))

const imageOptions = computed(() => {
  const list: Array<{ key: string, label: string }> = []
  for (const entry of props.options.image) {
    for (const model of entry.models) list.push({ key: `${entry.config_id}:${model}`, label: `${entry.name} · ${model}` })
  }
  return list
})

function setText(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  emit('update', { textConfigId: Number(target.value) || 0, imageConfigId: props.imageConfigId, imageModel: props.imageModel })
}

function setImage(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const key = target.value
  if (!key) {
    emit('update', { textConfigId: props.textConfigId, imageConfigId: null, imageModel: null })
    return
  }
  const [configId, ...rest] = key.split(':')
  emit('update', { textConfigId: props.textConfigId, imageConfigId: Number(configId) || null, imageModel: rest.join(':') })
}
</script>

<style scoped>
.mp { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.mp-field { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-2); }
.mp-field .input { width: 200px; }
</style>
