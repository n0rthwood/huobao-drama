/**
 * ComfyUI（无头）图片 Adapter —— 模型名以 qwen-image 开头：Qwen Image 2.1
 *   无参考图 -> 文生图 t2i；有参考图 -> 图生图/编辑 i2i（提示词里用 <image1>… 指代参考图）
 * 通用的上传/提交/轮询/取件逻辑在 comfyui-client.ts。
 */
import type {
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
  ImageProviderAdapter,
  ProviderRequest,
} from './types'
import {
  buildHistoryRequest,
  buildPromptRequest,
  parseHistory,
  parseSubmitResponse,
  parseUrlArray,
  uploadImage,
  waitEngineIdle,
} from './comfyui-client'
import { buildQwenI2i, buildQwenT2i, pickQwenSize, QWEN_MAX_REFS } from './comfyui-qwen-workflows'

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

interface PreparedExtra {
  prompt: string
  refNames: string[]
}

/** 提示词没有显式引用参考图时，补一句让模型知道要以参考图为基础 */
function withReferenceHint(prompt: string, refCount: number): string {
  if (!refCount || /<image\d+>/i.test(prompt)) return prompt
  const tags = Array.from({ length: refCount }, (_, i) => `<image${i + 1}>`).join('、')
  return `以 ${tags} 为参考：${prompt}`
}

export class ComfyUIImageAdapter implements ImageProviderAdapter {
  provider = 'comfyui'

  async prepare(config: AIConfig, record: ImageGenerationRecord): Promise<ImageGenerationRecord> {
    const model = (record.model || config.model || '').toLowerCase()
    if (!model.startsWith('qwen-image')) {
      throw new Error(`ComfyUI 图片不支持的模型: ${record.model || config.model}（支持 qwen-image*）`)
    }
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('ComfyUI 图片要求必须提供提示词')

    const refs = parseUrlArray(record.referenceImages)
    if (refs.length > QWEN_MAX_REFS) throw new Error(`参考图超限：最多 ${QWEN_MAX_REFS} 张，当前 ${refs.length}`)

    await waitEngineIdle(config)
    const refNames = await Promise.all(refs.map((src, i) => uploadImage(config, src, `huobao_img_${record.id}_ref${i}`)))
    const extra: PreparedExtra = { prompt: withReferenceHint(prompt, refNames.length), refNames }
    return { ...record, extra: { ...extra } }
  }

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const extra = record.extra as PreparedExtra | undefined
    if (!extra) throw new Error('ComfyUI adapter 需要先执行 prepare')
    const jobId = `img${record.id}`
    const workflow = extra.refNames.length
      ? buildQwenI2i({ prompt: extra.prompt, seed: null, jobId, refNames: extra.refNames })
      : (() => {
          const [width, height] = pickQwenSize(record.size)
          return buildQwenT2i({ prompt: extra.prompt, seed: null, jobId, width, height })
        })()
    return buildPromptRequest(config, workflow)
  }

  parseGenerateResponse(result: Parameters<typeof parseSubmitResponse>[0]): ImageGenResponse {
    return { isAsync: true, taskId: parseSubmitResponse(result) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return buildHistoryRequest(config, taskId)
  }

  parsePollResponse(result: Parameters<typeof parseHistory>[0], config?: AIConfig): ImagePollResponse {
    if (!config) throw new Error('ComfyUI 图片轮询需要 config')
    const outcome = parseHistory(result, config, IMAGE_EXT, 'ComfyUI 执行完成但未找到输出图片')
    if (outcome.state === 'completed') return { status: 'completed', imageUrl: outcome.url }
    if (outcome.state === 'failed') return { status: 'failed', error: outcome.error }
    return { status: 'processing' }
  }

  /** 图片地址依赖 baseUrl，仅在 parsePollResponse 中构造 */
  extractImageUrl(): string | null {
    return null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}
