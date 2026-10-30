/**
 * ComfyUI MiniMax-H3 工作流模板填充
 *
 * 模板（src/workflows/h3/*.json）是 ComfyUI 的 API 格式工作流，拷自 175 vidgen-studio/templates，
 * 已适配 175 上安装的 bf16 权重；h3-int8/ 是低显存实例（2×3060）的变体，仅换 unet/clip 文件名
 * （fl2va int8 convrot + qwen3vl nvfp4 awq，拓扑与 bf16 逐节点相同，且无 ref2va → 不支持参考图模式）。
 * 这里只按固定节点 ID 填参数，移植自 vidgen-studio 的 templates_fill.py。
 * 模板经 JSON import 打进 esbuild bundle，桌面版无需额外资源路径。
 */
import firstlastTemplate from '../../workflows/h3/firstlast.json'
import referenceTemplate from '../../workflows/h3/reference.json'
import t2vTemplate from '../../workflows/h3/t2v.json'
import firstlastInt8Template from '../../workflows/h3-int8/firstlast.json'
import referenceInt8Template from '../../workflows/h3-int8/reference.json'
import t2vInt8Template from '../../workflows/h3-int8/t2v.json'

import { asWorkflow, cloneNode as node, randomSeed, type Workflow } from './comfyui-client'
import { effectiveFrames, H3_FPS } from './h3-prompt'

export type H3Variant = 'standard' | 'int8'

const TEMPLATES: Record<H3Variant, { t2v: Workflow; firstlast: Workflow; reference?: Workflow }> = {
  standard: {
    t2v: asWorkflow(t2vTemplate),
    firstlast: asWorkflow(firstlastTemplate),
    reference: asWorkflow(referenceTemplate),
  },
  int8: { t2v: asWorkflow(t2vInt8Template), firstlast: asWorkflow(firstlastInt8Template), reference: asWorkflow(referenceInt8Template) },
}

/** 步数 ≤8 挂 turbo LoRA（为 ~8 步蒸馏）；>8 走基础模型并取消 LoRA */
const DEFAULT_STEPS = 8
const MAX_PIXELS = 1344 * 768
/**
 * 参考图模式用基础 ref2va 权重且不挂 LoRA（175 上没有 ref2v turbo LoRA），不是蒸馏模型：
 * 实测 4 步背景是未收敛的噪点/拖影，20 步清晰完整，耗时几乎不变（耗时主要是固定开销）。
 */
const REFERENCE_STEPS = 20
const REFERENCE_STEPS_INT8 = 4

/** 项目侧档位 → 横屏边长；竖屏互换宽高 */
const LANDSCAPE_SIZES: Record<string, Record<string, [number, number]>> = {
  '16:9': { '480p': [832, 480], '720p': [960, 544], '1080p': [1344, 768] },
  '4:3': { '480p': [640, 480], '720p': [896, 672], '1080p': [1152, 864] },
  '1:1': { '480p': [512, 512], '720p': [768, 768], '1080p': [992, 992] },
}

export function pickResolution(resolution: string | null | undefined, aspectRatio: string | null | undefined): [number, number] {
  const tier = (resolution || '').toLowerCase()
  const tierKey = tier === '480p' || tier === '1080p' ? tier : '720p'
  const ratio = (aspectRatio || '').trim()
  const portrait = ratio === '9:16' || ratio === '3:4'
  const landscapeKey = portrait ? (ratio === '9:16' ? '16:9' : '4:3') : ratio
  const [w, h] = (LANDSCAPE_SIZES[landscapeKey] ?? LANDSCAPE_SIZES['16:9'])[tierKey]
  const size: [number, number] = portrait ? [h, w] : [w, h]
  if (size[0] % 32 || size[1] % 32 || size[0] * size[1] > MAX_PIXELS) {
    throw new Error(`分辨率不合法: ${size[0]}x${size[1]}（需为 32 的倍数且不超过 1344×768 像素总量）`)
  }
  return size
}

function load(variant: H3Variant, name: 't2v' | 'firstlast'): Workflow {
  const wf = TEMPLATES[variant][name]
  if (!wf) throw new Error(`H3 ${variant} 实例不支持 ${name} 工作流`)
  return structuredClone(wf)
}


/** t2v / firstlast 共用的 turbo、时长、seed、输出前缀 */
function applyTurbo(wf: Workflow, durationS: number, seed: number, jobId: string, steps: number): void {
  node(wf, '105:111').inputs.value = durationS
  const turbo = steps <= 8
  node(wf, '105:126').inputs.value = turbo
  node(wf, turbo ? '105:125' : '105:124').inputs.value = steps
  node(wf, '105:15').inputs.noise_seed = seed
  node(wf, '92').inputs.filename_prefix = `huobao/${jobId}`
}

export interface FillBase {
  variant?: H3Variant
  prompt: string
  durationS: number
  width: number
  height: number
  seed: number | null | undefined
  jobId: string
  steps?: number
}

export function buildT2v(p: FillBase): Workflow {
  const wf = load(p.variant ?? 'standard', 't2v')
  node(wf, '114').inputs.text = p.prompt
  node(wf, '116').inputs.width = p.width
  node(wf, '116').inputs.height = p.height
  applyTurbo(wf, p.durationS, randomSeed(p.seed), p.jobId, p.steps ?? DEFAULT_STEPS)
  return wf
}

export function buildFirstLast(p: FillBase & { firstName: string; lastName?: string }): Workflow {
  const wf = load(p.variant ?? 'standard', 'firstlast')
  const gen = node(wf, '105:104').inputs
  gen.prompt = p.prompt
  gen.width = p.width
  gen.height = p.height
  node(wf, '200').inputs.image = p.firstName
  if (p.lastName) {
    node(wf, '300').inputs.image = p.lastName
  } else {
    for (let id = 300; id <= 308; id++) delete wf[String(id)]
    delete gen.last_frame
  }
  // 首/尾帧按目标画幅等比缩放后居中补边（letterbox）
  const fit = `min(${p.width} / a, ${p.height} / b)`
  const padTop = `max(0, int(floor((${p.height} - a) / 2)))`
  const padLeft = `max(0, int(floor((${p.width} - a) / 2)))`
  const expressions: Record<string, string> = {
    '202': fit, '206': padTop, '207': padLeft,
    '302': fit, '306': padTop, '307': padLeft,
  }
  for (const [id, expression] of Object.entries(expressions)) {
    if (wf[id]) wf[id].inputs.expression = expression
  }
  applyTurbo(wf, p.durationS, randomSeed(p.seed), p.jobId, p.steps ?? DEFAULT_STEPS)
  return wf
}

/** 按 class_type 定位节点（模板节点号在不同实例上可能不同，引导节点接线按类型解析） */
function findByClass(wf: Workflow, classType: string): string {
  const id = Object.keys(wf).find(key => wf[key]!.class_type === classType)
  if (!id) throw new Error(`工作流模板缺少 ${classType} 节点`)
  return id
}

/**
 * 参考图模式追加关键帧引导：LoadImage → MiniMaxH3AddGuide，逐个串在 ReferenceToVideo 之后，
 * 最后把 BasicGuider 的 conditioning 指向末个引导节点。
 * 首帧 frame_idx=0；中间帧按时间点换算帧号（引擎的 17k+5 帧网格）；尾帧 frame_idx=-1。
 * 引导帧不占用 Picture 编号，@图片N 的映射照旧。
 */
function appendFrameGuides(
  wf: Workflow,
  refNodeId: string,
  frames: number,
  p: { firstName?: string; midName?: string; midTime?: number | null; lastName?: string },
): void {
  const guides: Array<{ image: string; frameIdx: number }> = []
  if (p.firstName) guides.push({ image: p.firstName, frameIdx: 0 })
  if (p.midName && p.midTime != null) {
    // 首尾各留一帧，避免中间帧引导与首/尾帧引导落在同一帧上
    const idx = Math.round(p.midTime * H3_FPS)
    guides.push({ image: p.midName, frameIdx: Math.min(Math.max(idx, 1), Math.max(1, frames - 2)) })
  }
  if (p.lastName) guides.push({ image: p.lastName, frameIdx: -1 })
  if (!guides.length) return

  const guiderId = findByClass(wf, 'BasicGuider')
  const videoVae = node(wf, findByClass(wf, 'VAEDecode')).inputs.vae
  const audioVae = node(wf, findByClass(wf, 'VAEDecodeAudio')).inputs.vae
  // MiniMaxH3AddGuide 只输出 CONDITIONING；latent 始终取 ReferenceToVideo 的输出 1
  let positive: unknown = [refNodeId, 0]
  const latent: unknown = [refNodeId, 1]
  guides.forEach((guide, i) => {
    const loaderId = `guideimg${i}`
    const guideId = `guide${i}`
    wf[loaderId] = { class_type: 'LoadImage', inputs: { image: guide.image, upload: 'image' } }
    wf[guideId] = {
      class_type: 'MiniMaxH3AddGuide',
      inputs: {
        positive,
        latent,
        frame_idx: guide.frameIdx,
        vae: videoVae,
        audio_vae: audioVae,
        image: [loaderId, 0],
      },
    }
    positive = [guideId, 0]
  })
  node(wf, guiderId).inputs.conditioning = positive
}

/** 参考图模式：standard = ref2va 基础权重固定 20 步；int8 = fused refdelta 4 步蒸馏(102 的 int8 权重集里唯一可用的参考路径) */
export function buildReference(
  p: Omit<FillBase, 'steps'> & {
    omni?: boolean
    refNames: string[]
    firstName?: string
    midName?: string
    midTime?: number | null
    lastName?: string
  },
): Workflow {
  const variant = p.variant ?? 'standard'
  const wf = structuredClone(TEMPLATES[variant].reference)
  if (!wf) throw new Error(`H3 ${variant} 参考图工作流不可用`)
  node(wf, '124').inputs.steps = variant === 'int8' ? REFERENCE_STEPS_INT8 : REFERENCE_STEPS
  if (p.omni) {
    node(wf, '127').inputs.unet_name = 'fasth3_omniref_8step_pruned_int8_convrot.safetensors'
    node(wf, '124').inputs.steps = 8
  }
  node(wf, '1').inputs.value = p.prompt
  node(wf, '133').inputs.value = p.durationS
  node(wf, '129').inputs.noise_seed = randomSeed(p.seed)
  const refNodeId = findByClass(wf, 'MiniMaxH3ReferenceToVideo')
  const gen = node(wf, refNodeId).inputs
  gen.width = p.width
  gen.height = p.height
  delete gen['ref_images.ref_image_0']
  p.refNames.forEach((name, i) => {
    const loaderId = `refimg${i}`
    wf[loaderId] = { class_type: 'LoadImage', inputs: { image: name, upload: 'image' } }
    gen[`ref_images.ref_image_${i}`] = [loaderId, 0]
  })
  appendFrameGuides(wf, refNodeId, effectiveFrames(p.durationS), p)
  node(wf, '92').inputs.filename_prefix = `huobao/${p.jobId}`
  return wf
}
