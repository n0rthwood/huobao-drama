/**
 * Agent 请求上下文 — 通过 Mastra RequestContext 按请求注入
 * 路由层 build → generate({ requestContext }) → 工具 execute 内读取
 */
import { RequestContext } from '@mastra/core/request-context'
import { randomUUID } from 'crypto'
import { getContentLanguage, type ContentLanguage } from '../services/app-settings.js'
import { resolveDramaGenreRuleset, type GenreRuleset } from '../services/genre-ruleset.js'

export interface AgentRequestContextValues {
  episodeId: number
  dramaId: number
  /** 单镜任务（转场设计）作用的分镜 */
  storyboardId?: number
  modelOverride?: string
  textConfigId?: number
  /** AI 内容语言；缺省时读全局设置（app_settings.content_language） */
  language?: ContentLanguage
  /** 单资产重提取作用的资产名（Issue #32）：名册完整性只对这一个人要求，不牵连其它成员 */
  singleAssetName?: string
  /** 题材规则集（Issue #32）；缺省时按项目的 genre + 纪录片开关解析 */
  genreRuleset?: GenreRuleset | null
  /** 本次运行的检索预算作用域（构建处生成，调用方不传） */
  researchRunId?: string
}

export function buildAgentRequestContext(values: AgentRequestContextValues): RequestContext<AgentRequestContextValues> {
  const rc = new RequestContext<AgentRequestContextValues>()
  rc.set('episodeId', values.episodeId)
  rc.set('dramaId', values.dramaId)
  if (values.modelOverride) rc.set('modelOverride', values.modelOverride)
  if (values.textConfigId) rc.set('textConfigId', values.textConfigId)
  if (values.storyboardId) rc.set('storyboardId', values.storyboardId)
  if (values.singleAssetName) rc.set('singleAssetName', values.singleAssetName)
  // 语言在构建处统一解析：4 条链路（chat/提取/图片提示词/视频提示词）都经过这里，
  // 全局设置一处生效；显式传入 values.language 可按请求覆盖
  rc.set('language', values.language ?? getContentLanguage())
  // 题材规则集在构建处统一解析（与 language 同理）：所有 Agent 链路都经过这里，
  // 技能装配据此叠加纪录片 addendum，调用方无需逐个注入
  const genreRuleset = values.genreRuleset === undefined
    ? resolveDramaGenreRuleset(values.dramaId)
    : values.genreRuleset
  if (genreRuleset) rc.set('genreRuleset', genreRuleset)
  // 每次运行一个检索预算作用域：联网工具按它限次（agents/tools/research-tools.ts）
  rc.set('researchRunId', randomUUID())
  return rc
}

export function getEpisodeId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('episodeId' as never)
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
