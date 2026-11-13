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
  if (!adapter) {
    throw new Error(isJobQueueVideoProvider(provider)
      ? `Video provider ${provider} is a job-queue provider: use services/h3-jobs.ts, not an adapter`
      : `Unsupported video provider: ${provider}`)
  }
  return adapter
}

/**
 * 视频 provider 注册表 —— provider → 执行方式的唯一映射（与图片的 imageProviderKinds 同构）。
 * `job-queue` 类：服务端排队的任务 API（h3-jobs = h3-central 队列），由 services/h3-jobs.ts 的追踪器驱动，
 * 没有 VideoProviderAdapter 形态，generation.ts 按这里的 kind 分流。
 */
export type VideoProviderKind = 'adapter' | 'job-queue'

export const H3_JOBS_PROVIDER = 'h3-jobs'

export const videoProviderKinds: Record<string, VideoProviderKind> = {
  volcengine: 'adapter',
  minimax: 'adapter',
  comfyui: 'adapter',
  [H3_JOBS_PROVIDER]: 'job-queue',
}

/** 该视频 provider 是否走服务端任务队列（而非本地轮询 adapter） */
export function isJobQueueVideoProvider(provider: string | null | undefined): boolean {
  return videoProviderKinds[(provider || '').toLowerCase()] === 'job-queue'
}

/** 走服务端任务队列的全部 provider（图片 + 视频）：启动清扫据此豁免，交给各自的追踪器 */
export const JOB_QUEUE_PROVIDERS: readonly string[] = [
  ...Object.keys(imageProviderKinds).filter(provider => imageProviderKinds[provider] === 'job-queue'),
  ...Object.keys(videoProviderKinds).filter(provider => videoProviderKinds[provider] === 'job-queue'),
]

export interface VideoCapabilities {
  /** 是否支持首/尾关键帧引导 */
  supportsFrameGuides: boolean
  /** 是否支持按时间点锚定的中间帧引导 */
  supportsMidFrameGuide: boolean
}

/**
 * 视频 provider 的能力位：调用方只需要这两个布尔，不必为此拿完整 adapter。
 * h3-jobs 跑的是与 comfyui 直连相同的 MiniMax-H3 工作流（AddGuide 支持首/中/尾引导）。
 */
export function videoCapabilities(provider: string): VideoCapabilities {
  if (isJobQueueVideoProvider(provider)) return { supportsFrameGuides: true, supportsMidFrameGuide: true }
  const adapter = getVideoAdapter(provider)
  return { supportsFrameGuides: !!adapter.supportsFrameGuides, supportsMidFrameGuide: !!adapter.supportsMidFrameGuide }
}
