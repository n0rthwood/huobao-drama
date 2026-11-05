/**
 * Agent 请求上下文 — 通过 Mastra RequestContext 按请求注入
 * 路由层 build → generate({ requestContext }) → 工具 execute 内读取
 */
import { RequestContext } from '@mastra/core/request-context'
import { randomUUID } from 'crypto'
import { getContentLanguage, type ContentLanguage } from '../services/app-settings.js'
import { resolveDramaGenreRuleset, type GenreRuleset } from '../services/genre-ruleset.js'
import { resolveDramaProjectType, type ProjectType } from '../services/project-type.js'

export interface AgentRequestContextValues {
  episodeId: number
  dramaId: number
  /** 单镜任务（转场设计）作用的分镜 */
  storyboardId?: number
  /** 提示词批次的写入边界；工具 schema 与执行层共同限制。'design_card' = 设计卡填写（#57） */
  storyboardPromptScope?: 'video' | 'keyframes' | 'design_card'
  modelOverride?: string
  textConfigId?: number
  /** AI 内容语言；缺省时读全局设置（app_settings.content_language） */
  language?: ContentLanguage
  /** 本集是否启用旁白（#30）：决定条件技能是否注入 */
  narrationEnabled?: boolean
  /** 本次旁白写作允许落库的镜号（#35）：分块/单镜运行只能写自己这一段 */
  narrationShotNumbers?: number[]
  /** 单资产重提取作用的资产名（Issue #32）：名册完整性只对这一个人要求，不牵连其它成员 */
  singleAssetName?: string
  /** 题材规则集（Issue #32）；缺省时按项目的 genre + 纪录片开关解析 */
  genreRuleset?: GenreRuleset | null
  /** 项目类型（Issue #45）；缺省时按 dramas.project_type 解析，决定 narration-first 工具变体 */
  projectType?: ProjectType
  /** 本次运行的检索预算作用域（构建处生成，调用方不传） */
  researchRunId?: string
  /** 本次运行所属的文本任务 id（Issue #46）：工具的计量写进该任务的 params.vision_calls */
  textTaskId?: number
  /** 补镜模式（Issue #52）：save_storyboards 改为纯插入，旁白必须落在未覆盖的缺口内 */
  storyboardFillGaps?: boolean
}

export function buildAgentRequestContext(values: AgentRequestContextValues): RequestContext<AgentRequestContextValues> {
  const rc = new RequestContext<AgentRequestContextValues>()
  rc.set('episodeId', values.episodeId)
  rc.set('dramaId', values.dramaId)
  if (values.modelOverride) rc.set('modelOverride', values.modelOverride)
  if (values.textConfigId) rc.set('textConfigId', values.textConfigId)
  if (values.storyboardId) rc.set('storyboardId', values.storyboardId)
  if (values.storyboardPromptScope) rc.set('storyboardPromptScope', values.storyboardPromptScope)
  if (values.narrationEnabled) rc.set('narrationEnabled', true)
  if (values.narrationShotNumbers !== undefined) rc.set('narrationShotNumbers', values.narrationShotNumbers)
  if (values.singleAssetName) rc.set('singleAssetName', values.singleAssetName)
  if (values.textTaskId) rc.set('textTaskId', values.textTaskId)
  if (values.storyboardFillGaps) rc.set('storyboardFillGaps', true)
  // 语言在构建处统一解析：4 条链路（chat/提取/图片提示词/视频提示词）都经过这里，
  // 全局设置一处生效；显式传入 values.language 可按请求覆盖
  rc.set('language', values.language ?? getContentLanguage())
  // 题材规则集在构建处统一解析（与 language 同理）：所有 Agent 链路都经过这里，
  // 技能装配据此叠加纪录片 addendum，调用方无需逐个注入
  const genreRuleset = values.genreRuleset === undefined
    ? resolveDramaGenreRuleset(values.dramaId)
    : values.genreRuleset
  if (genreRuleset) rc.set('genreRuleset', genreRuleset)
  // 项目类型（Issue #45）：纪录片项目的分镜/旁白工具换成 narration-first 变体
  const projectType = values.projectType ?? resolveDramaProjectType(values.dramaId)
  rc.set('projectType', projectType)
  // 每次运行一个检索预算作用域：联网工具按它限次（agents/tools/research-tools.ts）
  rc.set('researchRunId', randomUUID())
  return rc
}

export function getEpisodeId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('episodeId' as never)
  return typeof v === 'number' ? v : null
}

/** 本次运行所属的文本任务 id（#46）；没有任务上下文时返回 null，工具只记日志 */
export function getTextTaskId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('textTaskId' as never)
  return typeof v === 'number' ? v : null
}

export function getDramaId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('dramaId' as never)
  return typeof v === 'number' ? v : null
}

export function getStoryboardId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('storyboardId' as never)
  return typeof v === 'number' ? v : null
}

/**
 * 本次旁白写作允许落库的镜号（#35）。
 * null = 不限制（整集一次运行）；空数组 = 一个镜头都不许写（阶段 A 只规划主线）。
 */
export function getNarrationShotNumbers(requestContext: RequestContext | undefined): number[] | null {
  const v = requestContext?.get('narrationShotNumbers' as never)
  return Array.isArray(v) ? v as number[] : null
}

/** 读取请求上下文中的内容语言；未设置返回 null（调用方按 zh 处理） */
export function getContentLanguageFromRC(requestContext: RequestContext | undefined): ContentLanguage | null {
  const v = requestContext?.get('language' as never)
  return typeof v === 'string' && v ? (v as ContentLanguage) : null
}

/** 读取请求上下文中的题材规则集；未命中返回 null */
export function getGenreRuleset(requestContext: RequestContext | undefined): GenreRuleset | null {
  const v = requestContext?.get('genreRuleset' as never)
  return v === 'documentary' ? 'documentary' : null
}

/** 读取请求上下文中的项目类型；未设置按 drama 处理（Issue #45） */
export function getProjectType(requestContext: RequestContext | undefined): ProjectType {
  return requestContext?.get('projectType' as never) === 'documentary' ? 'documentary' : 'drama'
}

/** 读取单资产重提取的目标资产名；整集提取为 null */
export function getSingleAssetName(requestContext: RequestContext | undefined): string | null {
  const v = requestContext?.get('singleAssetName' as never)
  return typeof v === 'string' && v ? v : null
}

/** 读取本次 Agent 运行的检索预算作用域 id */
export function getResearchRunId(requestContext: RequestContext | undefined): string | null {
  const v = requestContext?.get('researchRunId' as never)
  return typeof v === 'string' && v ? v : null
}

/** 本次运行是不是补镜模式（Issue #52）：save_storyboards 纯插入、旁白必须落在缺口内 */
export function isStoryboardFillGaps(requestContext: RequestContext | undefined): boolean {
  return requestContext?.get('storyboardFillGaps' as never) === true
}
