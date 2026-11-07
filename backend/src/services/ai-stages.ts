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
import { assignTextEndpoint } from './text-scheduler.js'
import { logTaskWarn } from '../utils/task-logger.js'

export interface AiStageSpec {
  /** 该环节的判断是否建立在「看见画面」之上 */
  vision: boolean
  /** 前端提示与任务详情里显示的中文名 */
  label: string
}

export const AI_STAGES = {
  // ── 需要视觉 ──────────────────────────────────────────────
  /** 纪录片拆分分镜（含设计卡初稿）：要看证据素材才能定信息点 / 必须标注 / 计划图层 */
  storyboard_breaker_documentary: { vision: true, label: '拆分分镜（纪录片）' },
  /** 设计卡填写 / 补齐：逐镜核对证据图是否真能表达信息点 */
  design_card: { vision: true, label: '分镜设计' },
  /** 证据素材语义自动标注：读地图像素 */
  asset_semantics: { vision: true, label: '语义自动标注' },
  /** 资产 QC 清单核验（Issue #56）：逐条核对产出图是否满足事实表；结论由程序闸门算，不采信模型 overall */
  asset_qc: { vision: true, label: '资产 QC 清单核验' },
  /** 史料画像 → 外貌：读画像 */
  portrait_appearance: { vision: true, label: '史料画像补充外貌' },
  /** read_image 工具本身 */
  read_image: { vision: true, label: '读图工具' },

  // ── 不需要视觉 ────────────────────────────────────────────
  /** 剧情项目拆分分镜：纯剧本文本；绝对图像优先规则下不描述外观 */
  storyboard_breaker: { vision: false, label: '拆分分镜（剧情）' },
  /** 剧本改写 / 旁白稿：纪录片分阶段改写的「忠实改写」阶段也用这个环节 */
  script_rewriter: { vision: false, label: '剧本改写' },
  /** 桥句润色（Issue #70）：读冻结原文 + 忠实改写稿，逐边界判断该不该补一句承接 */
  script_bridge: { vision: false, label: '桥句润色' },
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
  /** 资产资料研究（Issue #56）：只产出候选 URL 与许可提示，不抓取、不看图 */
  asset_research: { vision: false, label: '资产资料研究' },
  /** 资产事实表（Issue #56）：资料 → 可逐条机检的 must_have / forbidden / tolerances */
  asset_spec: { vision: false, label: '资产事实表' },
  /** 资产审核清单（Issue #55）：输入是旁白稿文本 + 本集资产名/语义条目名清单，不读图 */
  asset_review: { vision: false, label: '资产审核清单' },
  /** Poster AI 构想（Issue #72）：剧本 + 资产文字描述 → 三套构图方案；不读图 */
  poster_concept: { vision: false, label: 'Poster 构想' },
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
  'services/design-card-batch.ts': ['design_card'],
  'services/extraction.ts': ['extractor'],
  'services/final-prompt.ts': ['final_prompt'],
  'services/keyframe-prompts.ts': ['keyframe_prompts'],
  'services/video-prompts.ts': ['video_prompts'],
  'services/transition-agent.ts': ['transition_writer'],
  // 分阶段改写（#70）：忠实改写沿用 script_rewriter 环节，桥句润色是独立环节
  'services/script-rewrite/stages.ts': ['script_rewriter', 'script_bridge'],
  'services/narration-script.ts': ['narration_writer'],
  'services/task-retry.ts': ['script_rewriter', 'storyboard_breaker', 'storyboard_breaker_documentary'],
  'services/asset-review.ts': ['asset_review'],
  'services/poster-concept.ts': ['poster_concept'],
  'services/adapters/h3-prompt.ts': ['h3_prompt'],
  'services/asset-semantics-auto.ts': ['asset_semantics'],
  // 资产流水线（#56）：资料研究 / 事实表（纯文本）+ QC 清单核验（视觉）
  'services/asset-pipeline/steps.ts': ['asset_research', 'asset_spec', 'asset_qc'],
  // 地图地点坐标建议复用资料研究环节（返回的坐标一律是候选，人工确认后才写库）
  'services/asset-pipeline/map-asset.ts': ['asset_research'],
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
  /** Whether the caller explicitly selected this configuration. */
  pinned?: boolean
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
  excludeConfigIds?: number[]
  /** 请求指定的模型名（只有在最终用的就是请求指定的那条配置时才生效） */
  model?: string
}


/** Resolve an eligible endpoint for this stage. */
export async function resolveStageModel(stage: AiStage, opts: StageModelOptions = {}): Promise<StageModel> {
  return assignTextEndpoint(stage, opts)
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
