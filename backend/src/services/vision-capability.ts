/**
 * 文本服务的「看图能力」探测（Issue #32）
 *
 * 「按史料画像补充外貌」要把画像真的给模型看。但同一台网关上挂的文本配置并不都能收图：
 * 实测默认文本模型（优先级最高那条）会用 HTTP 400 `messages.content.type 参数非法，
 * 取值范围 ['text']` 拒绝多模态消息，而另一条优先级更低的配置能正确答出颜色。
 * 能力因此只能探测，不能按优先级/厂商名假设——这里用一张极小的纯色 PNG 发一次真实请求，
 * HTTP 200 即视为可看图，其余（400/404/超时/网络错）一律视为不可看图，调用方降级为纯文本。
 *
 * 探测结果按「配置 id + 配置更新时间 + 模型名」缓存在进程内：配置没动就不重复打网关，
 * 用户在设置页改了 base_url/模型后 updated_at 变化，缓存键自然失效。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTextProviderBaseUrl, type AIConfig } from './ai.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

export interface VisionTextConfig {
  configId: number
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

/** 32×32 纯红 PNG（120 字节）：探测请求的图片负载，小到不影响任何计费与带宽 */
export const VISION_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAKklEQVR42mO4o6ZGU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAIjyoD2JhwFtAAAAAElFTkSuQmCC'

/** 探测超时：网关挂了也不能把用户的 POST 卡住，20 秒足够一次 16 token 的回答 */
const VISION_PROBE_TIMEOUT_MS = 20_000

/**
 * 探测请求体（纯函数，便于单测）：OpenAI 兼容的多模态 user 消息。
 * 不能看图的服务正是在解析 content 数组这一步报错，所以必须用数组形态而不是裸字符串。
 */
export function buildVisionProbeBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 16,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_PROBE_PNG_BASE64}` } },
      ],
    }],
  }
}

/** 缓存键：配置内容没变就复用上次结论 */
function probeCacheKey(configId: number, updatedAt: string | null | undefined, model: string): string {
  return `${configId}:${updatedAt || ''}:${model}`
}

const visionProbeCache = new Map<string, boolean>()

/** 对单条配置发一次真实探测请求；HTTP 200 才算能看图 */
async function probeVision(config: VisionTextConfig): Promise<boolean> {
  const url = `${getTextProviderBaseUrl(config as unknown as AIConfig)}/chat/completions`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildVisionProbeBody(config.model)),
      signal: AbortSignal.timeout(VISION_PROBE_TIMEOUT_MS),
    })
    if (resp.status === 200) return true
    // 400 是「不收图」的正常答复，不是故障：记一条便于用户在日志里看到为什么降级
    logTaskProgress('Vision', 'probe-rejected', {
      configId: config.configId, model: config.model, status: resp.status,
      body: (await resp.text()).slice(0, 200),
    })
    return false
  } catch (err) {
    logTaskWarn('Vision', 'probe-failed', {
      configId: config.configId, model: config.model,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * 找一条能看图的文本配置：指定配置优先（必须仍然启用），其余按 priority 从高到低依次探测。
 * 一条都不行时返回 null —— 调用方降级为纯文本（史料元数据 + 维基正文）。
 */
export async function resolveVisionTextConfig(preferConfigId?: number): Promise<VisionTextConfig | null> {
  const rows = (await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'text'))
  )
    // 能不能看图只由探测说了算：不按厂商名/优先级预判，启用的文本配置都排进来试
    .filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))

  const ordered = preferConfigId
    ? [...rows.filter(r => r.id === preferConfigId), ...rows.filter(r => r.id !== preferConfigId)]
    : rows

  for (const row of ordered) {
    let models: unknown
    try {
      models = row.model ? JSON.parse(row.model) : []
    } catch {
      continue
    }
    const model = Array.isArray(models) ? String(models[0] || '') : String(models || '')
    if (!model) continue

    const config: VisionTextConfig = {
      configId: row.id,
      name: row.name,
      provider: row.provider || '',
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      model,
    }
    const key = probeCacheKey(row.id, row.updatedAt, model)
    let capable = visionProbeCache.get(key)
    if (capable === undefined) {
      capable = await probeVision(config)
      visionProbeCache.set(key, capable)
    }
    if (capable) {
      logTaskProgress('Vision', 'config-selected', { configId: row.id, name: row.name, model })
      return config
    }
  }
  logTaskWarn('Vision', 'no-vision-config', { preferConfigId })
  return null
}
