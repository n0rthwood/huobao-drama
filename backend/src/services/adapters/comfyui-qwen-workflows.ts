/**
 * ComfyUI Qwen Image 2.1 工作流填充：文生图 t2i、参考图编辑/图生图 i2i。
 *
 * 模板（src/workflows/qwen/*.json）取自 200 服务器上已跑通的任务（history）。
 * 节点 ID：4 TextEncodeQwenImage21（prompt、images.image_N）、5 EmptyLatentImage(仅 t2i)、
 * 7 KSampler、9 SaveImage；i2i 的 latent 来自 4 的第 3 个输出（尺寸跟随参考图），LoadImage 节点 ID 为 101+。
 * 参考图在提示词里用 <image1>、<image2> 指代。
 */
import i2iTemplate from '../../workflows/qwen/i2i.json'
import t2iTemplate from '../../workflows/qwen/t2i.json'
import { asWorkflow, cloneNode as node, randomSeed, type Workflow } from './comfyui-client'

const TEMPLATES = { t2i: asWorkflow(t2iTemplate), i2i: asWorkflow(i2iTemplate) }
export const QWEN_MAX_REFS = 9
const MAX_PIXELS = 2048 * 2048
const MIN_SIDE = 256

/** "WxH" → 对齐到 32 的宽高，总像素不超过 2048²；无法解析时返回 1024x1024 */
export function pickQwenSize(size: string | null | undefined): [number, number] {
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec((size || '').trim())
  if (!match) return [1024, 1024]
  let w = Number(match[1])
  let h = Number(match[2])
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)))
  w *= scale
  h *= scale
  const snap = (v: number) => Math.max(MIN_SIDE, Math.round(v / 32) * 32)
  return [snap(w), snap(h)]
}

interface QwenFill {
  prompt: string
  seed: number | null | undefined
  jobId: string
}

export function buildQwenT2i(p: QwenFill & { width: number; height: number }): Workflow {
  const wf = structuredClone(TEMPLATES.t2i)
  node(wf, '4').inputs.prompt = p.prompt
  node(wf, '5').inputs.width = p.width
  node(wf, '5').inputs.height = p.height
  node(wf, '7').inputs.seed = randomSeed(p.seed)
  node(wf, '9').inputs.filename_prefix = `huobao/${p.jobId}`
  return wf
}

/**
 * 图生图：默认 latent 来自编码器输出（尺寸跟随第 1 张参考图）。
 * 传入 width/height 时插入显式 `EmptyLatentImage` 并改接 KSampler，
 * 输出尺寸就固定为目标画幅——关键帧必须按剧集画幅出图，不能跟随三视图之类的参考图。
 */
export function buildQwenI2i(p: QwenFill & { refNames: string[]; width?: number; height?: number }): Workflow {
  const wf = structuredClone(TEMPLATES.i2i)
  const encoder = node(wf, '4').inputs
  encoder.prompt = p.prompt
  for (const key of Object.keys(encoder)) {
    if (key.startsWith('images.image_')) delete encoder[key]
  }
  delete wf['101']
  p.refNames.forEach((name, i) => {
    const loaderId = String(101 + i)
    wf[loaderId] = { class_type: 'LoadImage', inputs: { image: name } }
    encoder[`images.image_${i + 1}`] = [loaderId, 0]
  })
  if (p.width && p.height) {
    wf['5'] = { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } }
    node(wf, '7').inputs.latent_image = ['5', 0]
  }
  node(wf, '7').inputs.seed = randomSeed(p.seed)
  node(wf, '9').inputs.filename_prefix = `huobao/${p.jobId}`
  return wf
}
