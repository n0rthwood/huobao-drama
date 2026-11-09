/**
 * 文本服务的「单次 chat/completions」直连调用（Issue #46）
 *
 * 从 portrait-appearance.ts 抽出来：原先「组装多模态 user 消息 → 打一次 OpenAI 兼容
 * /chat/completions」的代码只服务于档案画像；#46 的 Agent 工具 read_image 需要同一条
 * 通路（本地图片 → 缩放 JPEG data URL → 一次请求），而且**不能**走 Agent 当前的主模型
 * （GLM 不收多模态消息），所以这里只认显式传入的配置。
 *
 * 行为与抽出前逐字一致：URL 由 getTextProviderBaseUrl 推导，Bearer 鉴权，
 * 非 2xx 抛错并截断 300 字错误体，返回第一条 choice 的正文。
 * usage 是新增的只读回传（计量用），不影响既有调用方。
 */
import { getTextProviderBaseUrl, type AIConfig } from './ai.js'
import { isModelError, noteEndpointError, noteEndpointSuccess, selectTextEndpoint, withTextSlot } from './text-scheduler.js'
import { currentTextTaskId, isAgentTextCall } from './text-task-context.js'
import { recordTextTaskAttempt } from './text-task.js'
import { observeQueueWait, observeTextCall } from './task-observability.js'
import sharp from 'sharp'
import { getAbsolutePath, readImageAsCompressedDataUrl } from '../utils/storage.js'

/** 单次请求所需的最小配置：VisionTextConfig 与 AIConfig 都能满足 */
export interface ChatEndpointConfig {
  configId?: number | null
  id?: number
  pinned?: boolean
  vision?: boolean
  name?: string
  baseUrl: string
  apiKey: string
  model: string
  provider: string
}

/** OpenAI 兼容的 user 消息正文：纯文本或 text/image_url 片段数组 */
export type ChatContent = string | Array<Record<string, unknown>>

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
}

export interface ChatCallResult {
  text: string
  usage: ChatUsage | null
  finishReason?: string
  endpoint: { configId: number; provider: string; model: string; name: string; baseUrl: string }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface ChatCallOptions {
  systemPrompt?: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  interactive?: boolean
  /**
   * 上层（如资产流水线的步骤时限）的中止信号：与 `timeoutMs` 取**先到者**。
   * 不接这个 signal 的话，上层超时只是放弃等待，这条请求还挂在连接池里。
   */
  signal?: AbortSignal
}

export interface PreparedImage {
  /** OpenAI 兼容的 image_url 片段 */
  part: Record<string, unknown>
  /** 实际发给模型的像素尺寸（缩放后）：问像素框时必须告诉模型这个口径 */
  width: number
  height: number
  /** 原图像素尺寸：调用方据此把模型给的坐标换算回原图 */
  sourceWidth: number
  sourceHeight: number
}

/** 本地 static/ 图片 → OpenAI 兼容的 image_url 片段（JPEG data URL）+ 尺寸口径 */
export async function imageContentPart(
  relativePath: string,
  opts: { maxSide: number; quality: number },
): Promise<PreparedImage> {
  const meta = await sharp(getAbsolutePath(relativePath)).metadata()
  const sourceWidth = meta.width || 0
  const sourceHeight = meta.height || 0
  // 与 readImageAsCompressedDataUrl 的 fit:'inside' + withoutEnlargement 同口径
  const scale = Math.min(1, opts.maxSide / Math.max(sourceWidth || 1, sourceHeight || 1))
  const dataUrl = await readImageAsCompressedDataUrl(relativePath, {
    maxWidth: opts.maxSide,
    maxHeight: opts.maxSide,
    quality: opts.quality,
  })
  return {
    part: { type: 'image_url', image_url: { url: dataUrl } },
    width: Math.round(sourceWidth * scale),
    height: Math.round(sourceHeight * scale),
    sourceWidth,
    sourceHeight,
  }
}

/** 单次 /chat/completions；失败抛错，由调用方决定是降级还是记任务失败 */
export async function callTextChat(
  config: ChatEndpointConfig,
  content: ChatContent,
  opts: ChatCallOptions,
): Promise<ChatCallResult> {
  const messages: Array<{ role: string; content: ChatContent }> = []
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
  messages.push({ role: 'user', content })
  const vision = !!config.vision || Array.isArray(content) && content.some(part => part.type === 'image_url')
  let endpoint = config
  const attempted: number[] = []
  let data: ChatCompletionResponse | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const configId = endpoint.configId ?? endpoint.id
    if (configId == null) throw new Error('文本模型缺少配置 ID，无法排队')
    attempted.push(configId)
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
      : AbortSignal.timeout(opts.timeoutMs)
    try {
      // 读图等直连调用也归当前任务（#87）：排队标记在取槽位之外，采集层在槽位之内
      data = await observeQueueWait(() => withTextSlot({ configId, interactive: opts.interactive, signal }, async () => {
        try {
          const url = `${getTextProviderBaseUrl(endpoint as unknown as AIConfig)}/chat/completions`
          const observedFetch = observeTextCall({
            kind: vision ? 'vision_chat' : 'llm',
            configId,
            configName: endpoint.name ?? null,
            provider: endpoint.provider,
            model: endpoint.model,
            baseUrl: url,
          }, fetch)
          const resp = await observedFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
            body: JSON.stringify({ model: endpoint.model, temperature: opts.temperature, max_tokens: opts.maxTokens, messages }),
            signal,
          })
          if (!resp.ok) throw Object.assign(new Error(`文本服务 ${resp.status}: ${(await resp.text()).slice(0, 300)}`), { status: resp.status })
          const result = await resp.json() as ChatCompletionResponse
          await noteEndpointSuccess(configId)
          return result
        } catch (err) {
          await noteEndpointError(configId, err)
          throw err
        }
      }))
      break
    } catch (err) {
      const taskId = currentTextTaskId()
      if (taskId != null && !isAgentTextCall()) {
        const errorClass = isModelError(err) ? 'model' : err instanceof SyntaxError ? 'parse' : opts.signal?.aborted ? 'cancelled' : 'business'
        await recordTextTaskAttempt(taskId, { config_id: configId, model: endpoint.model, error_class: errorClass }, {
          configId, provider: endpoint.provider, model: endpoint.model, name: endpoint.name ?? '', vision: config.vision ?? vision,
        })
      }
      if (opts.signal?.aborted || !isModelError(err) || config.pinned || attempt === 2) throw err
      const next = await selectTextEndpoint({ vision, excludeConfigIds: attempted })
      if (!next) throw err
      endpoint = next
    }
  }
  if (!data) throw new Error('文本服务未返回结果')
  const configId = endpoint.configId ?? endpoint.id
  if (configId == null) throw new Error('文本模型缺少配置 ID，无法记录实际端点')
  const actual = { configId, provider: endpoint.provider, model: endpoint.model, name: endpoint.name ?? '', baseUrl: endpoint.baseUrl }
  const taskId = currentTextTaskId()
  if (taskId != null && !isAgentTextCall()) {
    await recordTextTaskAttempt(taskId, { config_id: configId, model: endpoint.model, error_class: null }, { ...actual, vision: config.vision ?? vision })
  }
  const usage = data.usage
    ? {
        prompt_tokens: Number(data.usage.prompt_tokens) || 0,
        completion_tokens: Number(data.usage.completion_tokens) || 0,
      }
    : null
  return { text: data.choices?.[0]?.message?.content ?? '', usage, finishReason: data.choices?.[0]?.finish_reason, endpoint: actual }
}
