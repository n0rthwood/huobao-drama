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
import sharp from 'sharp'
import { getAbsolutePath, readImageAsCompressedDataUrl } from '../utils/storage.js'

/** 单次请求所需的最小配置：VisionTextConfig 与 AIConfig 都能满足 */
export interface ChatEndpointConfig {
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
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface ChatCallOptions {
  systemPrompt?: string
  temperature: number
  maxTokens: number
  timeoutMs: number
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
  const url = `${getTextProviderBaseUrl(config as unknown as AIConfig)}/chat/completions`
  const messages: Array<{ role: string; content: ChatContent }> = []
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
  messages.push({ role: 'user', content })

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      messages,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  })
  if (!resp.ok) throw new Error(`文本服务 ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const data = (await resp.json()) as ChatCompletionResponse
  const usage = data.usage
    ? {
        prompt_tokens: Number(data.usage.prompt_tokens) || 0,
        completion_tokens: Number(data.usage.completion_tokens) || 0,
      }
    : null
  return { text: data.choices?.[0]?.message?.content ?? '', usage }
}
