/**
 * AI 环节的视觉需求静态标定与按环节选模型（Issue #51）
 *
 * 背景：顶栏只有一个文本模型选择器，作用于全部 Agent。纪录片拆分分镜/表达设计要看地图与
 * 版画才能判断 device、must_show、overlay_plan 能否成立，但实测 GLM 5.3 任务（865/866）
 * `params.vision_calls` 为空——模型有 `read_image` 工具却从不调用，所有「图上有什么」的判断
 * 都是凭文字编的。运行时按次判断既费时又不准（HTTP 200 不等于真能读图），所以：
 *
 * 1. **模型**能否看图：`ai_service_configs.vision` 人工标定（见 vision-capability.ts）。
 * 2. **环节**需不需要看图：本文件的 `AI_STAGES` 静态标定，唯一来源。
 * 3. 需要视觉的环节必须落到视觉配置上；一条都没有就 400，绝不静默用纯文本模型糊弄。
 *
 * 新增 AI 环节必须在 `AI_STAGES` 登记并在 `AI_CALL_SITES` 写上调用点文件，
 * 否则 tests/ai-stages.test.mjs 的调用点扫描会失败。
 */
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { resolveVisionTextConfig } from './vision-capability.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

export interface AiStageSpec {
  /** 该环节的判断是否建立在「看见画面」之上 */
  vision: boolean
  /** 前端提示与任务详情里显示的中文名 */
  label: string
}

export const AI_STAGES = {
  // ── 需要视觉 ──────────────────────────────────────────────
  /** 纪录片拆分分镜（含表达设计初稿）：要看证据素材才能定 device / must_show / overlay_plan */
  storyboard_breaker_documentary: { vision: true, label: '拆分分镜（纪录片）' },
  /** 表达设计重算 / 补齐：逐镜核对证据图是否真能表达信息点 */
  shot_intent: { vision: true, label: '表达设计' },
  /** 证据素材语义自动标注：读地图像素 */
  asset_semantics: { vision: true, label: '语义自动标注' },
  /** 美化保真核验：核对美化图是否保留原件要素 */
  prop_beautify: { vision: true, label: '美化保真核验' },
  /** 史料画像 → 外貌：读画像 */
  portrait_appearance: { vision: true, label: '史料画像补充外貌' },
  /** read_image 工具本身 */
  read_image: { vision: true, label: '读图工具' },

  // ── 不需要视觉 ────────────────────────────────────────────
  /** 剧情项目拆分分镜：纯剧本文本；绝对图像优先规则下不描述外观 */
  storyboard_breaker: { vision: false, label: '拆分分镜（剧情）' },
  /** 剧本改写 / 旁白稿 */
  script_rewriter: { vision: false, label: '剧本改写' },
  /** 资产提取：从剧本文本提取 */
  extractor: { vision: false, label: '资产提取' },
  /** 资产最终提示词（含资产批量） */
  final_prompt: { vision: false, label: '资产提示词' },
  /** 关键帧提示词：纪录片地图/卡片/档案镜头由确定性片段渲染，不写提示词 */
  keyframe_prompts: { vision: false, label: '关键帧提示词' },
  /** 视频提示词 */
  video_prompts: { vision: false, label: '视频提示词' },
  /** 转场设计 */
  transition_writer: { vision: false, label: '转场设计' },
  /** 旁白写作 / 注音 */
  narration_writer: { vision: false, label: '旁白写作' },
  /** H3 视频提示词扩写 */
  h3_prompt: { vision: false, label: 'H3 提示词扩写' },
} as const satisfies Record<string, AiStageSpec>

export type AiStage = keyof typeof AI_STAGES

/**
 * 每个 AI 调用点所在文件 → 它用到的环节（相对 backend/src 的路径）。
 * 单测按 `runAgent(` / `callTextChat(` / `expandWithTextModel(` 扫描源码，
 * 扫出来的文件集合必须与这张表的键完全一致——新增环节漏标会直接红。
 */
export const AI_CALL_SITES: Record<string, AiStage[]> = {
  // chat 路由可跑任意 Agent 类型（见 AGENT_STAGE）
  'routes/agent.ts': [
    'script_rewriter', 'storyboard_breaker', 'storyboard_breaker_documentary',
    'extractor', 'final_prompt', 'transition_writer', 'narration_writer',
  ],
  'services/shot-intent-batch.ts': ['shot_intent'],
  'services/extraction.ts': ['extractor'],
  'services/final-prompt.ts': ['final_prompt'],
  'services/keyframe-prompts.ts': ['keyframe_prompts'],
  'services/video-prompts.ts': ['video_prompts'],
  'services/transition-agent.ts': ['transition_writer'],
  'services/narration-script.ts': ['narration_writer'],
  'services/task-retry.ts': ['script_rewriter', 'storyboard_breaker', 'storyboard_breaker_documentary'],
  'services/adapters/h3-prompt.ts': ['h3_prompt'],
  'services/asset-semantics-auto.ts': ['asset_semantics'],
  'services/prop-beautify.ts': ['prop_beautify'],
  // 补全剩余（#52）：纪录片拆分分镜的续跑，复用同一视觉环节
  'services/storyboard-fill-gaps.ts': ['storyboard_breaker_documentary'],
  'services/portrait-appearance.ts': ['portrait_appearance'],
  'agents/tools/vision-tools.ts': ['read_image'],
}

/** 本次实际落到哪条配置上——写进 sys_task.params.model_used，任务详情直接显示 */
export interface StageModelUsed {
  config_id: number | null
  name: string
  provider: string
  model: string
  vision: boolean
}

export interface StageModel {
  stage: AiStage
  label: string
  /** 该环节是否要求视觉模型（= AI_STAGES[stage].vision） */
  vision: boolean
  configId: number | null
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number | null
  settings: string | null
}

/** 需要视觉的环节没有任何可用视觉配置 —— 路由层据此返回 400 */
export class StageVisionUnavailableError extends Error {
  constructor(public readonly stage: AiStage, label: string) {
    super(`「${label}」需要视觉模型，但没有任何启用并标定为「视觉模型」的文本配置。请在「设置 → AI 服务」里给能看图的文本配置打开「视觉模型」开关。`)
    this.name = 'StageVisionUnavailableError'
  }
}

/** 顶栏文本模型选择器 / 接口参数传来的覆盖 */
export interface StageModelOptions {
  /** 请求指定的 ai_service_configs.id */
  configId?: number
  /** 请求指定的模型名（只有在最终用的就是请求指定的那条配置时才生效） */
  model?: string
}

function toStageModel(stage: AiStage, config: AIConfig, model: string): StageModel {
  return {
    stage,
    label: AI_STAGES[stage].label,
    vision: AI_STAGES[stage].vision,
    configId: config.id ?? null,
    name: config.name || '',
    provider: config.provider || '',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    temperature: config.temperature ?? null,
    settings: config.settings ?? null,
  }
}

/**
 * 按环节解析本次要用的文本配置与模型。
 *
 * - 不需要视觉：沿用原有规则（请求指定的配置 > 当前启用的最高优先级配置；模型名可被请求覆盖）。
 * - 需要视觉：请求指定的配置若已标定视觉则用它；否则换成优先级最高的视觉配置（顶栏选了 GLM
 *   也会被换掉，这是用户确认过的行为，前端有提示、任务里记 model_used）；一条都没有就抛
 *   `StageVisionUnavailableError`。换配置时请求指定的模型名一并作废——它属于另一条配置。
 */
export async function resolveStageModel(stage: AiStage, opts: StageModelOptions = {}): Promise<StageModel> {
  const spec = AI_STAGES[stage]
  if (!spec) throw new Error(`未登记的 AI 环节：${stage}`)

  if (!spec.vision) {
    const config = (opts.configId ? await getConfigById(opts.configId) : null) ?? await getActiveConfig('text')
    if (!config) throw new Error('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
    return toStageModel(stage, config, opts.model || config.model)
  }

  // 视觉配置的挑选只有一条路径：vision-capability.resolveVisionTextConfig（标记 + 官方 provider + 优先级）
  const chosen = await resolveVisionTextConfig(opts.configId)
  if (!chosen) throw new StageVisionUnavailableError(stage, spec.label)

  const requested = opts.configId != null && chosen.configId === opts.configId
  // 换了配置，请求指定的模型名一并作废——它属于另一条配置
  const model = requested ? (opts.model || chosen.model) : chosen.model
  if (opts.configId != null && !requested) {
    logTaskProgress('AIStage', 'vision-config-substituted', {
      stage, requestedConfigId: opts.configId, usedConfigId: chosen.configId, usedModel: model,
    })
  }
  return toStageModel(stage, {
    id: chosen.configId,
    provider: chosen.provider,
    baseUrl: chosen.baseUrl,
    apiKey: chosen.apiKey,
    model: chosen.model,
    name: chosen.name,
  }, model)
}

/** 任务 params 里记录的「实际用了什么」 */
export function stageModelUsed(resolved: StageModel): StageModelUsed {
  return {
    config_id: resolved.configId,
    name: resolved.name,
    provider: resolved.provider,
    model: resolved.model,
    vision: resolved.vision,
  }
}

/** Agent 类型 → 环节（storyboard_breaker 另按项目类型分叉） */
const AGENT_STAGE: Record<string, AiStage> = {
  script_rewriter: 'script_rewriter',
  extractor: 'extractor',
  prompt_generator: 'final_prompt',
  transition_writer: 'transition_writer',
  narration_writer: 'narration_writer',
}

/** Agent chat / 重试入口：同一个 storyboard_breaker，纪录片项目走视觉环节 */
export function agentChatStage(agentType: string, projectType: 'drama' | 'documentary'): AiStage {
  if (agentType === 'storyboard_breaker') {
    return projectType === 'documentary' ? 'storyboard_breaker_documentary' : 'storyboard_breaker'
  }
  const stage = AGENT_STAGE[agentType]
  if (stage) return stage
  // Agent 类型与环节一一对应；新 Agent 必须先登记环节
  logTaskWarn('AIStage', 'unregistered-agent', { agentType })
  throw new Error(`Agent「${agentType}」没有在 AI_STAGES 登记视觉标定`)
}
