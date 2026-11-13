/**
 * 地图工作流的资料检索阶段（Issue #84 → #90 改为模型工具循环）
 *
 * 模型自己决定检索什么、读哪些正文、提交哪些要素；代码只提供真实检索工具并校验交付：
 * - 检索是真的去维基百科（中/英）、Europeana、Smithsonian 发请求，每个来源本阶段都必须真的问过；
 * - 交付（submit_features）逐条校验来源引用、逐字出处、坐标合法性、离群、示意图模式等，
 *   任何一处不合格整批拒收并把原因回给模型——**代码不再降级、退化或丢弃后继续**；
 * - 近似可以用，但必须显式（coordinate_basis / uncertainty），绝不冒充考证结论。
 */
import { z } from 'zod'
import { now } from '../../utils/response.js'
import type { StageModel } from '../../services/ai-stages.js'
import type { MapSpec } from './geo/base-render.js'
import { fetchText, searchAdapter, type ResearchAdapter, type ResearchHit } from './research-sources.js'
import { mapBriefText, rollbackTool, runStageAgent, stageTool, type StageAgentResult } from './agent-loop.js'
import { validateFeatureSubmission } from './validate.js'
import type { MapBrief, MapResearch, MapResearchQuery, MapResearchSource } from './types.js'

/** 用户确认的来源集合：维基系 + Europeana + Smithsonian，不扩散到其它适配器 */
export const MAP_RESEARCH_ADAPTERS: ResearchAdapter[] = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']

/** 检索 IO 的唯一入口；测试替换成本地夹具，生产就是 asset-research 的真实适配器 */
export const mapResearchIO = { search: searchAdapter, fetchText }

const MAX_SOURCES = 40
const HITS_PER_QUERY = 8
const SNIPPET_FOR_MODEL = 300
const TEXT_FOR_MODEL = 6000
const MAX_STEPS = 40

export interface ResearchStageInput {
  taskId: number
  runId: number
  stageModel: StageModel
  brief: MapBrief
  spec: MapSpec | null
  startRounds: number
  feedback: string | null
}

export async function runResearchStage(input: ResearchStageInput): Promise<StageAgentResult<MapResearch>> {
  const sources: MapResearchSource[] = []
  const hitsById = new Map<string, ResearchHit>()
  const queries: MapResearchQuery[] = []

  const confirmed = input.spec ? [
    ...input.spec.places.filter(item => item.proposed !== true).map(item => `地点「${item.name}」(${item.lon}, ${item.lat})`),
    ...input.spec.routes.filter(item => item.proposed !== true).map(item => `路线「${item.name}」${item.points.length} 个顶点`),
    ...(input.spec.regions ?? []).filter(item => item.proposed !== true).map(item => `范围「${item.name}」${item.points.length} 个顶点`),
  ] : []

  return await runStageAgent<MapResearch>({
    taskId: input.taskId,
    runId: input.runId,
    stage: 'research',
    stageModel: input.stageModel,
    skill: 'research',
    maxSteps: MAX_STEPS,
    startRounds: input.startRounds,
    initialFeedback: input.feedback,
    prompt: () => [
      '请为下面这张历史地图检索资料并提交地理要素。',
      mapBriefText(input.brief),
      confirmed.length ? `已由人工确认、你不能改写也不要再提交的要素：\n${confirmed.join('\n')}` : '',
      sources.length ? `本阶段已检索到的来源（仍可引用）：${sources.map(s => `${s.id} ${s.adapter}「${s.title}」`).join('；')}` : '',
    ].filter(Boolean).join('\n\n'),
    tools: (session) => ({
      search_sources: stageTool(session, {
        id: 'search_sources',
        description: `真实检索一个来源。adapter 只能是 ${MAP_RESEARCH_ADAPTERS.join(' / ')}；每个 adapter 本阶段至少检索一次（零命中也要检索）。`
          + '维基用中文或英文条目名/关键词，Europeana、Smithsonian 用英文。返回的命中会登记为来源 S1、S2…，提交要素时用这些编号引用。',
        inputSchema: z.object({
          adapter: z.string().describe(MAP_RESEARCH_ADAPTERS.join(' / ')),
          query: z.string().describe('检索式'),
        }),
        execute: async ({ adapter, query }) => {
          if (!(MAP_RESEARCH_ADAPTERS as string[]).includes(adapter)) {
            return { error: `adapter 只能是 ${MAP_RESEARCH_ADAPTERS.join(' / ')}，收到 ${JSON.stringify(adapter)}` }
          }
          const text = String(query ?? '').trim()
          if (!text) return { error: 'query 不能为空' }
          let found: ResearchHit[]
          try {
            found = await mapResearchIO.search(adapter as ResearchAdapter, text)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            queries.push({ adapter, query: text, hits: 0, error: message })
            return { error: `检索失败：${message}`, hint: '可以换检索式重试；该来源已记为「问过」' }
          }
          queries.push({ adapter, query: text, hits: found.length, error: null })
          const registered: Array<Record<string, unknown>> = []
          for (const hit of found.slice(0, HITS_PER_QUERY)) {
            const existing = sources.find(source => (hit.url && source.url === hit.url) || (source.adapter === hit.adapter && source.title === hit.title))
            if (existing) {
              registered.push({ id: existing.id, title: existing.title, already_registered: true })
              continue
            }
            if (sources.length >= MAX_SOURCES) break
            const source: MapResearchSource = {
              id: `S${sources.length + 1}`,
              adapter: hit.adapter,
              title: hit.title,
              url: hit.url,
              institution: hit.institution,
              date: hit.date,
              license: hit.license,
              tier: hit.tier,
              excerpt: hit.snippet ?? '',
            }
            sources.push(source)
            hitsById.set(source.id, hit)
            registered.push({
              id: source.id, adapter: source.adapter, title: source.title, url: source.url,
              institution: source.institution, date: source.date, snippet: source.excerpt.slice(0, SNIPPET_FOR_MODEL),
            })
          }
          return {
            hits: registered,
            ...(found.length ? {} : { note: '零命中；该来源已记为「问过」' }),
            ...(sources.length >= MAX_SOURCES ? { note: `来源已达上限 ${MAX_SOURCES}，后续命中不再登记` } : {}),
          }
        },
      }),
      read_source: stageTool(session, {
        id: 'read_source',
        description: '读取一条已登记来源的正文（维基类返回条目正文；其它来源只有著录摘要）。逐字引用（coordinate_basis=excerpt）必须出自这里读到的文字。',
        inputSchema: z.object({ source_id: z.string().describe('来源编号，如 S3') }),
        execute: async ({ source_id }) => {
          const source = sources.find(item => item.id === source_id)
          const hit = hitsById.get(String(source_id))
          if (!source || !hit) return { error: `没有来源 ${JSON.stringify(source_id)}；已登记：${sources.map(s => s.id).join('、') || '（无，请先检索）'}` }
          const textual = hit.adapter === 'wikipedia-zh' || hit.adapter === 'wikipedia-en'
          if (textual) {
            const body = await mapResearchIO.fetchText(hit, TEXT_FOR_MODEL)
            if (body) source.excerpt = body
          }
          return { id: source.id, title: source.title, url: source.url, text: source.excerpt.slice(0, TEXT_FOR_MODEL), full_text: textual }
        },
      }),
      submit_features: stageTool(session, {
        id: 'submit_features',
        description: '交付本阶段结果（消耗一轮）。features 每项字段见技能说明；uncertainties 列出读者需要知道的不确定之处，notes 写其它说明。'
          + '任何一条不合格都会整批拒收并逐条说明原因。',
        inputSchema: z.object({
          features: z.array(z.record(z.string(), z.unknown())).describe('地理要素数组'),
          uncertainties: z.array(z.string()).optional(),
          notes: z.array(z.string()).optional(),
        }),
        execute: async (submission) => {
          const checked = validateFeatureSubmission(submission.features, {
            brief: input.brief,
            sources,
            searchedAdapters: queries.map(query => query.adapter),
            requiredAdapters: MAP_RESEARCH_ADAPTERS,
            confirmed: input.spec,
          })
          return await session.deliver(checked.problems, () => ({
            queries: [...queries],
            sources: sources.map(source => ({ ...source })),
            features: checked.features,
            uncertainties: (submission.uncertainties ?? []).map(String).filter(Boolean),
            notes: (submission.notes ?? []).map(String).filter(Boolean),
            searched_at: now(),
          }))
        },
      }),
      request_rollback: rollbackTool(session, { taskId: input.taskId, runId: input.runId }),
    }),
  })
}
