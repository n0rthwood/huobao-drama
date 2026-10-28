/**
 * 风格预设 store（模块级状态）：项目列表、项目详情页共用一份启用中的预设清单，
 * `label(key)` 把 `dramas.style` 存的预设 value 显示成预设名（找不到时回落原始 key）。
 */
import { ref } from 'vue'
import { stylePresetAPI } from '~/composables/useApi'

export interface StylePreset {
  id: number
  name: string
  value: string
  prompt?: string
  description?: string
}

const presets = ref<StylePreset[]>([])
let loaded = false

export function useStylePresets() {
  async function load(force = false) {
    if (loaded && !force) return
    presets.value = ((await stylePresetAPI.list()) as StylePreset[]) || []
    loaded = true
  }
  function label(key?: string | null) {
    return presets.value.find(p => p.value === key)?.name || key || ''
  }
  return { presets, load, label }
}

/** 项目画幅选项（value 与后端 `routes/dramas.ts` 白名单一致；label 为 i18n key，渲染时求值） */
export const ASPECT_RATIO_OPTIONS = [
  { value: '16:9', labelKey: 'index.ratio.landscape' },
  { value: '9:16', labelKey: 'index.ratio.portrait' },
  { value: '4:3', labelKey: 'index.ratio.landscape43' },
  { value: '3:4', labelKey: 'index.ratio.portrait34' },
  { value: '1:1', labelKey: 'index.ratio.square' },
]
