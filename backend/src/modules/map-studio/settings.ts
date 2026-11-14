/**
 * 地图工作室的设置（Issue #99，契约 Q2/Q6）
 *
 * 两类设置：
 * - 资料检索 key（Europeana / Smithsonian）：存在模块自己的 `map_studio_setting` 里，
 *   读取接口只回末 4 位（长度 ≥ 12 才给），永不返回完整 key。首次启动时若模块设置为空，
 *   由宿主做**一次性种子**（`legacyResearchKeys`），模块本身不读宿主的 app_settings。
 * - 默认模型选择：文本 / 图片配置与图片模型名（`models`），null = 用当前自动可用配置。
 *
 * 模块自带的模型选择（契约 Q2）不是「再写一套调度」：文本仍走 `services/ai-stages`，
 * 图片仍走宿主注入的 `platform.submitImage`，这里只保存用户选的 id 与模型名。
 */
import { hasSettingRow, readSetting, writeSetting } from './db.js'
import type { MapStudioPlatform } from './contract.js'
import { DEFAULT_MAP_STYLE, isMapStyleFamilyId, MapStyleValidationError, type MapStyleFamilyId } from './styles/index.js'

export const RESEARCH_KEY_IDS = ['europeana', 'smithsonian'] as const
export type ResearchKeyId = typeof RESEARCH_KEY_IDS[number]

const RESEARCH_KEY_LABEL: Record<ResearchKeyId, string> = {
  europeana: 'Europeana',
  smithsonian: 'Smithsonian',
}

const RESEARCH_KEYS_SETTING = 'research_keys'
const MODELS_SETTING = 'models'

export interface MapStudioModels {
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
}

export interface ResearchKeyStatus {
  id: ResearchKeyId
  label: string
  configured: boolean
  last4: string | null
}

function normalizeModels(raw: unknown): MapStudioModels {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = (value: unknown) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null)
  return {
    text_config_id: id(record.text_config_id),
    image_config_id: id(record.image_config_id),
    image_model: typeof record.image_model === 'string' && record.image_model.trim() ? record.image_model.trim() : null,
  }
}

function readResearchKeyMap(): Record<string, string> {
  const raw = readSetting(RESEARCH_KEYS_SETTING)
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const id of RESEARCH_KEY_IDS) {
    const value = (raw as Record<string, unknown>)[id]
    if (typeof value === 'string' && value.trim()) out[id] = value.trim()
  }
  return out
}

/** 已配置的 key 原文（只给检索适配器用；任何 HTTP 响应都不得带上它） */
export function getResearchKey(id: ResearchKeyId): string | null {
  return readResearchKeyMap()[id] ?? null
}

function writeResearchKeyMap(keys: Record<string, string>): void {
  writeSetting(RESEARCH_KEYS_SETTING, keys)
}

/**
 * 写入或清除某个来源的 key。空串 / null = 清除；首尾空白裁掉。
 * 已配置的值与写入值相同就不写库（避免每次保存都 bump updated_at）。
 */
export function setResearchKey(id: ResearchKeyId, raw: string | null): void {
  const keys = readResearchKeyMap()
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value) keys[id] = value
  else delete keys[id]
  writeResearchKeyMap(keys)
}

/**
 * 一次性种子：模块设置里**从未**写过 research_keys 时才问宿主要旧值。
 * 写过的空对象也认作「用户已经做过决定」，不再回填——否则用户清空 key 后重启又会被旧值灌回来。
 */
export async function seedLegacyResearchKeys(platform: MapStudioPlatform): Promise<void> {
  if (hasSettingRow(RESEARCH_KEYS_SETTING)) return
  let legacy: Record<string, string> = {}
  try {
    legacy = (await platform.legacyResearchKeys?.()) ?? {}
  } catch (err) {
    console.log(`🗺️ 地图工作室：读取宿主旧检索 key 失败，本次不种子（${err instanceof Error ? err.message : String(err)}）`)
    writeResearchKeyMap({})
    return
  }
  const keys: Record<string, string> = {}
  for (const id of RESEARCH_KEY_IDS) {
    const value = legacy[id]
    if (typeof value === 'string' && value.trim()) keys[id] = value.trim()
  }
  writeResearchKeyMap(keys)
  if (Object.keys(keys).length) console.log(`🗺️ 地图工作室：已从宿主设置复制 ${Object.keys(keys).length} 个检索 key`)
}

/** 设置页视图（掩码）：长度 < 12 的 key 不给末 4 位，短 key 的末 4 位几乎等于全文 */
export function researchKeyStatus(): ResearchKeyStatus[] {
  const keys = readResearchKeyMap()
  return RESEARCH_KEY_IDS.map(id => {
    const value = keys[id]
    return {
      id,
      label: RESEARCH_KEY_LABEL[id],
      configured: !!value,
      last4: value && value.length >= 12 ? value.slice(-4) : null,
    }
  })
}

export function readModels(): MapStudioModels {
  return normalizeModels(readSetting(MODELS_SETTING))
}

/** 合并式写入：只覆盖请求里出现的键 */
export function writeModels(patch: unknown): MapStudioModels {
  const previous = readModels()
  const record = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}
  const next = normalizeModels({
    text_config_id: 'text_config_id' in record ? record.text_config_id : previous.text_config_id,
    image_config_id: 'image_config_id' in record ? record.image_config_id : previous.image_config_id,
    image_model: 'image_model' in record ? record.image_model : previous.image_model,
  })
  writeSetting(MODELS_SETTING, next)
  return next
}

export function readDefaultStyle(): MapStyleFamilyId {
  const stored = readSetting('default_style')
  return isMapStyleFamilyId(stored) ? stored : DEFAULT_MAP_STYLE
}

export function writeDefaultStyle(value: unknown): MapStyleFamilyId {
  if (!isMapStyleFamilyId(value)) throw new MapStyleValidationError('default_style 必须是已采纳的主题 id', 'default_style')
  writeSetting('default_style', value)
  return value
}
