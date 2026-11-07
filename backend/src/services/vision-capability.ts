/**
 * 文本配置的「看图能力」标定与校验（Issue #32 探测 → Issue #51 人工标定）
 *
 * #32 曾用一张 32×32 PNG 在运行时探测：HTTP 200 即视为可看图。实测这个判据不准
 * （网关接受多模态消息不等于模型真能读出图里的字），而且每条配置都要打一次网关、
 * 费时间。#51 改为**人工静态标定**：`ai_service_configs.vision` 为真的配置才会被
 * 需要视觉的环节选中；探测函数降级为设置页「测试」按钮的辅助校验，只显示结果、不改标记。
 */
import { getTextProviderBaseUrl, type AIConfig } from './ai.js'
import { listEligibleTextEndpoints } from './text-scheduler.js'
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

/**
 * 对单条配置发一次真实探测请求；HTTP 200 才算收下了图片消息。
 * 只有设置页「测试」按钮会调用——结果仅供人工参考，不写回 vision 标记。
 */
export async function probeVision(config: VisionTextConfig): Promise<{ ok: boolean; detail: string }> {
  const url = `${getTextProviderBaseUrl(config as unknown as AIConfig)}/chat/completions`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildVisionProbeBody(config.model)),
      signal: AbortSignal.timeout(VISION_PROBE_TIMEOUT_MS),
    })
    if (resp.status === 200) return { ok: true, detail: '服务接受了图片消息（HTTP 200）' }
    // 400 是「不收图」的正常答复，不是故障：记一条便于用户在日志里看到为什么
    const body = (await resp.text()).slice(0, 200)
    logTaskProgress('Vision', 'probe-rejected', { configId: config.configId, model: config.model, status: resp.status, body })
    return { ok: false, detail: `HTTP ${resp.status}：${body}` }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logTaskWarn('Vision', 'probe-failed', { configId: config.configId, model: config.model, error })
    return { ok: false, detail: `请求失败：${error}` }
  }
}

/**
 * 找一条**被标定为视觉**的启用文本配置：指定配置优先（它自己必须标了视觉），
 * 否则按 priority 从高到低取第一条。一条都没有时返回 null，由调用方决定报错还是降级。
 *
 * 只收官方 provider：Agent 通道的 getModel 也按 provider 建端点，认不出的 provider
 * 会被悄悄换回默认文本配置，「强制视觉」就白做了。
 */
export async function resolveVisionTextConfig(preferConfigId?: number): Promise<VisionTextConfig | null> {
  const rows = await listEligibleTextEndpoints({ vision: true })
  const chosen = (preferConfigId ? rows.find(c => c.configId === preferConfigId) : null) ?? rows[0]
  if (!chosen) {
    logTaskWarn('Vision', 'no-vision-config', { preferConfigId })
    return null
  }
  logTaskProgress('Vision', 'config-selected', { configId: chosen.configId, name: chosen.name, model: chosen.model })
  return {
    configId: chosen.configId,
    name: chosen.name || '',
    provider: chosen.provider,
    baseUrl: chosen.baseUrl,
    apiKey: chosen.apiKey,
    model: chosen.model,
  }
}
