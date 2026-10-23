/**
 * ComfyUI Wan 2.2 14B（fp8）工作流填充：文生视频 t2v、首帧 i2v、首尾帧、参考图 Fun VACE。
 *
 * 模板（src/workflows/wan/*.json）取自 200 服务器上已跑通的任务（history），
 * 双专家结构：high_noise 模型跑前半步、low_noise 模型跑后半步，两个 KSamplerAdvanced 按 split 切分。
 * 服务器有 lightx2v LoRA，但本项目走官方标准 20 步；首尾帧模板使用 shift 8.0 / cfg 4.0，
 * 参考图模板使用 WanVaceToVideo、节点 16 TrimVideoLatent（裁掉 VACE 额外参考帧）和 shift 8.0 / cfg 3.5。
 * 节点 ID：7 正向提示词、8 负向、9 latent/generator、10 LoadImage(首帧/参考图)、
 * 11/12 采样器、14 CreateVideo、15 SaveVideo、20 LoadImage(尾帧)。
 */
import flfTemplate from '../../workflows/wan/flf.json'
import i2vTemplate from '../../workflows/wan/i2v.json'
import refTemplate from '../../workflows/wan/ref.json'
import t2vTemplate from '../../workflows/wan/t2v.json'
import { asWorkflow, cloneNode as node, randomSeed, type Workflow } from './comfyui-client'

export const WAN_FPS = 16
const TEMPLATES = {
  t2v: asWorkflow(t2vTemplate),
  i2v: asWorkflow(i2vTemplate),
  flf: asWorkflow(flfTemplate),
  ref: asWorkflow(refTemplate),
}


/** Wan 2.2 官方标准步数；前一半给 high_noise 专家，后一半给 low_noise 专家 */
const WAN_STEPS = 20
export const WAN_MAX_FRAMES = 81

/** 项目侧档位 → 横屏尺寸（均为 16 的倍数）；竖屏互换宽高 */
const LANDSCAPE_SIZES: Record<string, Record<string, [number, number]>> = {
  '16:9': { '480p': [832, 480], '720p': [1280, 720], '1080p': [1280, 720] },
  '4:3': { '480p': [640, 480], '720p': [960, 720], '1080p': [960, 720] },
  '1:1': { '480p': [640, 640], '720p': [768, 768], '1080p': [768, 768] },
}

export function pickWanResolution(resolution: string | null | undefined, aspectRatio: string | null | undefined): [number, number] {
  const tier = (resolution || '').toLowerCase()
  const tierKey = tier === '480p' || tier === '1080p' ? tier : '720p'
  const ratio = (aspectRatio || '').trim()
  const portrait = ratio === '9:16' || ratio === '3:4'
  const landscapeKey = portrait ? (ratio === '9:16' ? '16:9' : '4:3') : ratio
  const [w, h] = (LANDSCAPE_SIZES[landscapeKey] ?? LANDSCAPE_SIZES['16:9'])[tierKey]
  return portrait ? [h, w] : [w, h]
}

/** 帧数必须是 4n+1，上限 81（5 秒 @16fps） */
export function wanFrameCount(durationS: number): number {
  const n = Math.round((durationS * WAN_FPS - 1) / 4)
  return Math.min(WAN_MAX_FRAMES, Math.max(5, n * 4 + 1))
}

interface WanFill {
  prompt: string
  negativePrompt?: string
  durationS: number
  width: number
  height: number
  seed: number | null | undefined
  jobId: string
}

function applyCommon(wf: Workflow, p: WanFill): void {
  node(wf, '7').inputs.text = p.prompt
  if (p.negativePrompt) node(wf, '8').inputs.text = p.negativePrompt
  const seed = randomSeed(p.seed)
  const half = WAN_STEPS / 2
  for (const [id, start, end] of [['11', 0, half], ['12', half, 10000]] as const) {
    const sampler = node(wf, id).inputs
    sampler.noise_seed = seed
    sampler.steps = WAN_STEPS
    sampler.start_at_step = start
    sampler.end_at_step = end
  }
  node(wf, '15').inputs.filename_prefix = `huobao/${p.jobId}`
}

export function buildWanT2v(p: WanFill): Workflow {
  const wf = load('t2v')
  const latent = node(wf, '9').inputs
  latent.width = p.width
  latent.height = p.height
  latent.length = wanFrameCount(p.durationS)
  applyCommon(wf, p)
  return wf
}

export function buildWanI2v(p: WanFill & { startName: string }): Workflow {
  const wf = load('i2v')
  node(wf, '10').inputs.image = p.startName
  const gen = node(wf, '9').inputs
  gen.width = p.width
  gen.height = p.height
  gen.length = wanFrameCount(p.durationS)
  applyCommon(wf, p)
  return wf
}
export function buildWanFlf(p: WanFill & { startName: string; lastName: string }): Workflow {
  const wf = load('flf')
  node(wf, '10').inputs.image = p.startName
  node(wf, '20').inputs.image = p.lastName
  const gen = node(wf, '9').inputs
  gen.width = p.width
  gen.height = p.height
  gen.length = wanFrameCount(p.durationS)
  applyCommon(wf, p)
  return wf
}

export function buildWanRef(p: WanFill & { refName: string }): Workflow {
  const wf = load('ref')
  node(wf, '10').inputs.image = p.refName
  const gen = node(wf, '9').inputs
  gen.width = p.width
  gen.height = p.height
  gen.length = wanFrameCount(p.durationS)
  applyCommon(wf, p)
  return wf
}

function load(name: keyof typeof TEMPLATES): Workflow {
  return structuredClone(TEMPLATES[name])
}
