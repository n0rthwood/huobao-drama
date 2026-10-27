/**
 * AI 配置 → ModelSelect 选项（任务中心「换模型重试」用）。
 *
 * 选中值使用 `provider/model` 复合键：同名模型可能来自不同厂商（中转站与官方），
 * 提交时必须把裸模型名与所属配置 id 分开传给后端（与剧集工作台顶栏同口径）。
 */
import { aiConfigAPI } from '~/composables/useApi'

export interface ModelOption {
  key: string
  model: string
  provider: string
  configId: number
  configName: string
}

interface AiConfigRow {
  id: number
  name: string
  provider: string
  model: unknown
  priority: number
  isActive: boolean
}

/** /ai-configs 行 → 本地结构（外部数据，逐字段校验后再用） */
function normalizeConfig(raw: unknown): AiConfigRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row: Record<string, unknown> = { ...raw }
  const id = Number(row.id)
  const provider = typeof row.provider === 'string' ? row.provider : ''
  if (!Number.isFinite(id) || !provider) return null
  return {
    id,
    name: typeof row.name === 'string' ? row.name : '',
    provider,
    model: row.model,
    priority: Number(row.priority) || 0,
    isActive: Boolean(row.is_active ?? row.isActive),
  }
}

/** 配置中的模型数组（首位为配置默认）；API 可能返回数组或 JSON 字符串 */
function configModels(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    return [String(parsed)].filter(Boolean)
  } catch {
    return [raw].filter(Boolean)
  }
}

/** 汇总该类型全部启用配置的模型（按 厂商+模型 去重，按优先级排序） */
export async function loadModelOptions(serviceType: 'image' | 'video' | 'text'): Promise<ModelOption[]> {
  const raw: unknown = await aiConfigAPI.list(serviceType)
  const configs = (Array.isArray(raw) ? raw : [])
    .map(normalizeConfig)
    .filter((cfg): cfg is AiConfigRow => Boolean(cfg?.isActive))
    .sort((a, b) => b.priority - a.priority)
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const cfg of configs) {
    for (const model of configModels(cfg.model)) {
      const key = `${cfg.provider}/${model}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model, provider: cfg.provider, configId: cfg.id, configName: cfg.name || cfg.provider })
    }
  }
  return out
}

/** 复合键 → 裸模型名（后端适配器按厂商校验模型名，不能带 provider 前缀） */
export function bareModelName(key: string): string {
  if (!key) return ''
  const i = key.indexOf('/')
  return i >= 0 ? key.slice(i + 1) : key
}
