/**
 * ComfyUI（无头）MiniMax-H3 视频 Adapter。
 *
 * 模型名以 minimax-h3 开头；含 int8 的模型走低显存模板 h3-int8/，
 * 该实例无 ref2va，因此不支持参考图。通用的上传、提交、轮询与取件逻辑
 * 位于 comfyui-client.ts；此处只做 H3 的参数映射。
 */
import type {
  AIConfig,
  ProviderRequest,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
  VideoProviderAdapter,
} from './types'
import { validateVideoModel } from '../ai.js'
import {
  buildHistoryRequest,
  buildPromptRequest,
  parseHistory,
  parseSubmitResponse,
  parseUrlArray,
  uploadImage,
  waitEngineIdle,
} from './comfyui-client'
import { buildH3Prompt, type H3Mode } from './h3-prompt'
import { buildFirstLast, buildReference, buildT2v, pickResolution } from './comfyui-workflows'

const VIDEO_EXT = /\.(mp4|webm|mkv|mov)$/i
const DEFAULT_DURATION_S = 5

interface PreparedExtra {
  prompt: string
  mode: H3Mode
  variant: 'standard' | 'int8'
  firstName?: string
  lastName?: string
  refNames: string[]
}

function clampDuration(record: VideoGenerationRecord, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number(record.duration || DEFAULT_DURATION_S))))
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  async prepare(config: AIConfig, record: VideoGenerationRecord): Promise<VideoGenerationRecord> {
    if (parseUrlArray(record.referenceVideoUrls).length || parseUrlArray(record.referenceAudioUrls).length) {
      throw new Error('ComfyUI 视频仅支持参考图，不支持参考视频/音频')
    }
    const userPrompt = (record.prompt || '').trim()
    if (!userPrompt) throw new Error('ComfyUI 视频要求必须提供提示词')

    const model = record.model || config.model
    const modelError = validateVideoModel(config.provider, model)
    if (modelError) throw new Error(`${modelError}: ${model}`)
    const firstSource = (record.firstFrameUrl || record.imageUrl || '').trim()
    const lastSource = (record.lastFrameUrl || '').trim()
    const refSources = parseUrlArray(record.referenceImageUrls)
    const tag = `huobao_${record.id}`
    const variant: PreparedExtra['variant'] = model.toLowerCase().includes('int8') ? 'int8' : 'standard'
    const mode: H3Mode = refSources.length ? 'reference' : firstSource ? 'firstlast' : 't2v'
    if (variant === 'int8' && mode === 'reference') {
      throw new Error('H3 INT8 实例没有 ref2va 权重，不支持参考图模式；请改用 bf16 实例或去参考图')
    }
    const durationS = clampDuration(record, 4, 15)
    // 先扩写提示词（失败即报错，不浪费引擎时间），再等引擎空闲、上传图片
    const prompt = await buildH3Prompt(userPrompt, mode, durationS, !!firstSource, !!lastSource)
    await waitEngineIdle(config)
    const extra: PreparedExtra = { prompt, mode, variant, refNames: [] }
    if (mode === 'reference') {
      extra.refNames = await Promise.all(refSources.map((src, i) => uploadImage(config, src, `${tag}_ref${i}`)))
    } else if (mode === 'firstlast') {
      extra.firstName = await uploadImage(config, firstSource, `${tag}_first`)
      if (lastSource) extra.lastName = await uploadImage(config, lastSource, `${tag}_last`)
    }
    return { ...record, duration: durationS, extra: { ...extra } }
  }

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const extra = record.extra as PreparedExtra | undefined
    if (!extra) throw new Error('ComfyUI adapter 需要先执行 prepare')
    const durationS = record.duration || DEFAULT_DURATION_S
    const jobId = `task${record.id}`
    const [width, height] = pickResolution(record.resolution, record.aspectRatio)
    const common = { variant: extra.variant, prompt: extra.prompt, durationS, width, height, seed: record.seed, jobId }
    const workflow =
      extra.mode === 'reference' ? buildReference({ ...common, refNames: extra.refNames })
      : extra.mode === 'firstlast' ? buildFirstLast({ ...common, firstName: extra.firstName!, lastName: extra.lastName })
      : buildT2v(common)
    return buildPromptRequest(config, workflow)
  }

  parseGenerateResponse(result: Parameters<typeof parseSubmitResponse>[0]): VideoGenResponse {
    return { isAsync: true, taskId: parseSubmitResponse(result) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return buildHistoryRequest(config, taskId)
  }

  parsePollResponse(result: Parameters<typeof parseHistory>[0], config: AIConfig): VideoPollResponse {
    const outcome = parseHistory(result, config, VIDEO_EXT, 'ComfyUI 执行完成但未找到输出视频')
    if (outcome.state === 'completed') return { status: 'completed', videoUrl: outcome.url }
    if (outcome.state === 'failed') return { status: 'failed', error: outcome.error }
    return { status: 'processing' }
  }

  /** 视频地址依赖 baseUrl，仅在 parsePollResponse 中构造；此接口无调用方 */
  extractVideoUrl(): string | null {
    return null
  }
}
