/**
 * 资料检索 Agent 工具（Issue #32）— 火宝自己的联网能力
 *
 * 只挂 extractor（v1 决定）：身份符号在提取期就落进 appearance/styling，
 * 提示词期无需再查。白名单限定维基百科 / Wikimedia Commons（config/research.ts）。
 *
 * 纪律：
 * - 每次调用都落一条 research_citations（成功/失败都记），UI 的「资料来源」读它；
 * - 单次 Agent 运行有调用次数上限，超限返回 degraded，Agent 按技能规则只用剧本原文；
 * - 检索不可用（超时/退避耗尽/出网受限）同样返回 degraded，提取不失败；
 * - 返回体里的 source_url / retrieved_at 只用于记录，禁止写进任何资产字段。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { RESEARCH_MAX_CALLS_PER_RUN, RESEARCH_MAX_RESULTS, WIKI_LANGS } from '../../config/research.js'
import { logTaskProgress, logTaskWarn } from '../../utils/task-logger.js'
import { recordCitation } from '../../services/research-citations.js'
import { normalizeWikiLang, wikiExtract, wikiSearch, wikiSummary } from '../../services/wiki-research.js'
import { getDramaId, getEpisodeId, getResearchRunId } from '../context.js'
import type { ToolExecutionContext } from '@mastra/core/tools'

const ASSET_KINDS = ['character', 'scene', 'prop'] as const
/** 一次 wiki_search 最多记几条命中（返回给 Agent 的仍是全部结果）：
 *  一次检索落 8 行会把资产详情的「资料来源」刷成噪声 */
const RECORDED_SEARCH_HITS = 3

/** 单次 Agent 运行的调用预算（runId → 已用次数 + 创建时间，超时清理） */
const RUN_BUDGET = new Map<string, { used: number; at: number }>()
const BUDGET_TTL_MS = 60 * 60 * 1000

function takeBudget(runId: string): boolean {
  const now = Date.now()
  for (const [key, value] of RUN_BUDGET) {
    if (now - value.at > BUDGET_TTL_MS) RUN_BUDGET.delete(key)
  }
  const entry = RUN_BUDGET.get(runId) || { used: 0, at: now }
  if (entry.used >= RESEARCH_MAX_CALLS_PER_RUN) return false
  entry.used++
  RUN_BUDGET.set(runId, entry)
  return true
}

const subjectShape = {
  subject_kind: z.enum(ASSET_KINDS).optional().describe('本次检索服务于哪类资产（用于资料来源记录）'),
  subject_name: z.string().optional().describe('本次检索服务于哪个资产的名字，必须与保存时的名字完全一致'),
  lang: z.enum(WIKI_LANGS).optional().describe('维基百科语言版本，默认 zh'),
}

type Subject = { subject_kind?: typeof ASSET_KINDS[number]; subject_name?: string }

interface RunInfo {
  dramaId: number | null
  episodeId: number | null
  runId: string
}

function runInfo(context: ToolExecutionContext | undefined): RunInfo {
  return {
    dramaId: getDramaId(context?.requestContext),
    episodeId: getEpisodeId(context?.requestContext),
    runId: getResearchRunId(context?.requestContext) || 'unscoped',
  }
}

/** 统一的降级返回：记一条「未检索」，并明确告诉 Agent 只能用剧本原文 */
async function degrade(info: RunInfo, subject: Subject, tool: string, query: string, reason: string) {
  await recordCitation({
    dramaId: info.dramaId,
    episodeId: info.episodeId,
    assetKind: subject.subject_kind ?? null,
    assetName: subject.subject_name?.trim() || null,
    tool,
    query,
    title: null,
    sourceUrl: null,
    lang: null,
    snippet: reason,
    status: 'failed',
  })
  logTaskWarn('Research', `${tool}-degraded`, { episodeId: info.episodeId ?? undefined, query, reason })
  return {
    degraded: true,
    reason,
    instruction: '检索不可用：本资产只能使用剧本原文中的事实，不要凭印象补充任何史实细节。',
  }
}

const wikiSearchTool = createTool({
  id: 'wiki_search',
  description: '在维基百科检索条目，返回候选条目标题与摘要片段。只用于补全历史人物/地点/器物的事实，不得把链接或来源写进资产字段。',
  inputSchema: z.object({
    query: z.string().describe('检索词，例如「彼得一世」「涅尔琴斯克条约」'),
    ...subjectShape,
  }),
  execute: async ({ query, lang, subject_kind, subject_name }, context) => {
    const info = runInfo(context)
    const subject = { subject_kind, subject_name }
    if (!takeBudget(info.runId)) {
      return degrade(info, subject, 'wiki_search', query, `本次运行检索次数已达上限（${RESEARCH_MAX_CALLS_PER_RUN} 次）`)
    }
    const wikiLang = normalizeWikiLang(lang)
    try {
      const hits = await wikiSearch(query, wikiLang)
      for (const hit of hits.slice(0, RECORDED_SEARCH_HITS)) {
        await recordCitation({
          dramaId: info.dramaId,
          episodeId: info.episodeId,
          assetKind: subject_kind ?? null,
          assetName: subject_name?.trim() || null,
          tool: 'wiki_search',
          query,
          title: hit.title,
          sourceUrl: hit.source_url,
          lang: wikiLang,
          snippet: hit.snippet,
          status: 'ok',
        })
      }
      logTaskProgress('Research', 'wiki-search', { episodeId: info.episodeId ?? undefined, query, hits: hits.length })
      return { results: hits, lang: wikiLang, retrieved_at: new Date().toISOString() }
    } catch (err) {
      return degrade(info, subject, 'wiki_search', query, err instanceof Error ? err.message : '检索失败')
    }
  },
})

const wikiSummaryTool = createTool({
  id: 'wiki_summary',
  description: '读取某个维基百科条目的摘要（首段）。先用 wiki_search 确认条目标题再调用。',
  inputSchema: z.object({
    title: z.string().describe('条目标题，必须来自 wiki_search 的结果'),
    ...subjectShape,
  }),
  execute: async ({ title, lang, subject_kind, subject_name }, context) => {
    const info = runInfo(context)
    const subject = { subject_kind, subject_name }
    if (!takeBudget(info.runId)) {
      return degrade(info, subject, 'wiki_summary', title, `本次运行检索次数已达上限（${RESEARCH_MAX_CALLS_PER_RUN} 次）`)
    }
    const wikiLang = normalizeWikiLang(lang)
    try {
      const article = await wikiSummary(title, wikiLang)
      await recordCitation({
        dramaId: info.dramaId,
        episodeId: info.episodeId,
        assetKind: subject_kind ?? null,
        assetName: subject_name?.trim() || null,
        tool: 'wiki_summary',
        query: title,
        title: article.title,
        sourceUrl: article.source_url,
        lang: wikiLang,
        snippet: article.text.slice(0, 500),
        status: 'ok',
      })
      logTaskProgress('Research', 'wiki-summary', { episodeId: info.episodeId ?? undefined, title: article.title })
      return article
    } catch (err) {
      return degrade(info, subject, 'wiki_summary', title, err instanceof Error ? err.message : '检索失败')
    }
  },
})

const wikiExtractTool = createTool({
  id: 'wiki_extract',
  description: '读取某个维基百科条目的正文（可指定小节，如「肖像」「服饰」「生平」）。用于取服饰/仪仗/身份符号等可画细节。',
  inputSchema: z.object({
    title: z.string().describe('条目标题，必须来自 wiki_search 的结果'),
    section: z.string().optional().describe('只取该小节（按标题匹配）；不传则返回全文开头部分'),
    ...subjectShape,
  }),
  execute: async ({ title, section, lang, subject_kind, subject_name }, context) => {
    const info = runInfo(context)
    const subject = { subject_kind, subject_name }
    if (!takeBudget(info.runId)) {
      return degrade(info, subject, 'wiki_extract', title, `本次运行检索次数已达上限（${RESEARCH_MAX_CALLS_PER_RUN} 次）`)
    }
    const wikiLang = normalizeWikiLang(lang)
    try {
      const article = await wikiExtract(title, wikiLang, section)
      await recordCitation({
        dramaId: info.dramaId,
        episodeId: info.episodeId,
        assetKind: subject_kind ?? null,
        assetName: subject_name?.trim() || null,
        tool: 'wiki_extract',
        query: section ? `${title}#${section}` : title,
        title: article.title,
        sourceUrl: article.source_url,
        lang: wikiLang,
        snippet: article.text.slice(0, 500),
        status: 'ok',
      })
      logTaskProgress('Research', 'wiki-extract', { episodeId: info.episodeId ?? undefined, title: article.title, section })
      return article
    } catch (err) {
      return degrade(info, subject, 'wiki_extract', title, err instanceof Error ? err.message : '检索失败')
    }
  },
})

export const researchTools = {
  wiki_search: wikiSearchTool,
  wiki_summary: wikiSummaryTool,
  wiki_extract: wikiExtractTool,
}
