/**
 * 出图路由（Issue #56）
 *
 * 资产实验的实测结论（~/projects/huobao-asset-lab/report.md）：
 * - **qwen** 风格统一、出片好看，但会按自己的理解重画结构（地图海岸线被改写就是它）；
 * - **gpt-image**（codex 包装服务，provider=`openai`）结构保真明显更好，风格偏「插画」。
 *
 * 所以精确轮优先结构型（gpt-image），美化轮优先风格型（qwen-jobs）。匹配不到就回退到
 * 当前启用的图片配置，并在轮次行记 `generator_fallback:` 前缀——出了问题要能一眼看出
 * 这一轮根本没用上期望的那条配置。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { getActiveConfig, parseConfigTemperature } from '../ai.js'
import type { AssetKind, RoundPurpose } from './store.js'

/** 结构/细节优先的厂商（按 ai_service_configs.provider 匹配） */
const STRUCTURE_PROVIDER = 'openai'
/** 风格统一优先的厂商 */
const STYLE_PROVIDER = 'qwen-jobs'

export interface PickedGenerator {
  configId: number | null
  provider: string
  model: string
  /** 写进 asset_round.generator，便于事后按产出图追责到具体配置 */
  generator: string
  reason: string
}

async function activeImageConfigs(): Promise<Array<{ id: number; provider: string; model: string; priority: number }>> {
  const rows = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'image'))
  return rows
    .filter(row => row.isActive)
    .map((row) => {
      let models: unknown
      try {
        models = row.model ? JSON.parse(row.model) : []
      } catch {
        models = []
      }
      const model = Array.isArray(models) ? String(models[0] ?? '') : String(models ?? '')
      return { id: row.id, provider: (row.provider || '').toLowerCase(), model, priority: row.priority || 0 }
    })
    .filter(row => Boolean(row.model))
    .sort((a, b) => b.priority - a.priority)
}

/**
 * 选本轮的出图配置。显式 `configId` 优先（面板可覆盖），其次按用途匹配厂商，最后回退。
 */
export async function pickGenerator(input: {
  assetKind: AssetKind
  purpose: RoundPurpose
  configId?: number | null
  model?: string | null
}): Promise<PickedGenerator> {
  const configs = await activeImageConfigs()
  if (input.configId) {
    const chosen = configs.find(config => config.id === input.configId)
    if (chosen) {
      return {
        configId: chosen.id,
        provider: chosen.provider,
        model: input.model || chosen.model,
        generator: `${chosen.provider}:${input.model || chosen.model}`,
        reason: '面板显式指定',
      }
    }
  }

  const wanted = input.purpose === 'precision' ? STRUCTURE_PROVIDER : STYLE_PROVIDER
  const matched = configs.find(config => config.provider === wanted)
  if (matched) {
    return {
      configId: matched.id,
      provider: matched.provider,
      model: matched.model,
      generator: `${matched.provider}:${matched.model}`,
      reason: input.purpose === 'precision'
        ? '精确轮优先结构保真的出图服务'
        : '美化轮优先风格统一的出图服务',
    }
  }

  const fallback = await getActiveConfig('image')
  if (!fallback) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')
  // 温度在图片链路无意义，这里只是复用同一条解析口径确保读到的是同一行配置
  void parseConfigTemperature(fallback.settings)
  return {
    configId: fallback.id ?? null,
    provider: fallback.provider,
    model: fallback.model,
    generator: `generator_fallback:${fallback.provider}:${fallback.model}`,
    reason: `没有启用的「${wanted}」图片配置，回退到当前启用配置`,
  }
}

/**
 * 原图画幅 → 生图尺寸桶（从已删除的 prop-beautify.ts:62 原样搬来）。
 * 多轮流水线每一轮都必须守这条不变量：派生图与底图不同画幅，既有语义坐标会全部错位。
 */
export function sizeBucketFor(width: number, height: number): string {
  const ratio = width / Math.max(height, 1)
  const buckets: Array<{ size: string; ratio: number }> = [
    { size: '1344x768', ratio: 16 / 9 },
    { size: '1152x864', ratio: 4 / 3 },
    { size: '1024x1024', ratio: 1 },
    { size: '864x1152', ratio: 3 / 4 },
    { size: '768x1344', ratio: 9 / 16 },
  ]
  let best = buckets[0]!
  for (const bucket of buckets) {
    if (Math.abs(Math.log(bucket.ratio / ratio)) < Math.abs(Math.log(best.ratio / ratio))) best = bucket
  }
  return best.size
}
