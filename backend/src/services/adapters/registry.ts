/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { OpenAIImageAdapter } from './openai-image'
import { GeminiImageAdapter } from './gemini-image'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { ComfyUIVideoAdapter } from './comfyui-video'
import type { ImageProviderAdapter, VideoProviderAdapter } from './types'

/**
 * 图片 provider 注册表 —— provider → 执行方式的唯一映射。
 * `adapter` 类：传统「构建请求 → 轮询」HTTP adapter。
 * `job-queue` 类：服务端排队的任务 API（qwen-jobs），由 services/qwen-jobs.ts 的追踪器驱动，
 * 没有 ImageProviderAdapter 形态，generation.ts 按这里的 kind 分流。
 */
export type ImageProviderKind = 'adapter' | 'job-queue'

export const QWEN_JOBS_PROVIDER = 'qwen-jobs'

export const imageProviderKinds: Record<string, ImageProviderKind> = {
  openai: 'adapter',
  gemini: 'adapter',
  volcengine: 'adapter',
  [QWEN_JOBS_PROVIDER]: 'job-queue',
}

/** 该 provider 是否走服务端任务队列（而非本地轮询 adapter） */
export function isJobQueueImageProvider(provider: string | null | undefined): boolean {
  return imageProviderKinds[(provider || '').toLowerCase()] === 'job-queue'
}

export const imageAdapters: Record<string, ImageProviderAdapter> = {
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  volcengine: new VolcEngineVideoAdapter(),
  minimax: new MiniMaxVideoAdapter(),
  comfyui: new ComfyUIVideoAdapter(),
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getImageAdapter(provider: string): ImageProviderAdapter {
  const adapter = imageAdapters[provider.toLowerCase()]
  if (!adapter) {
    throw new Error(isJobQueueImageProvider(provider)
      ? `Image provider ${provider} is a job-queue provider: use services/qwen-jobs.ts, not an adapter`
      : `Unsupported image provider: ${provider}`)
  }
  return adapter
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  const adapter = videoAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported video provider: ${provider}`)
  return adapter
}
