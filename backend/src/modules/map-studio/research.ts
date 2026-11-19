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
import { logTaskWarn } from '../../utils/task-logger.js'
import type { StageModel } from '../../services/ai-stages.js'
import type { MapSpec } from './geo/base-render.js'
import { fetchText, searchAdapter, type ResearchAdapter, type ResearchHit } from './research-sources.js'
import { mapBriefText, rollbackTool, runStageAgent, stageTool, type StageAgentResult } from './agent-loop.js'
import { validateFeatureSubmission } from './validate.js'
import type { MapBrief, MapFailureKind, MapResearch, MapResearchProgress, MapResearchQuery, MapResearchSource } from './types.js'
import { searchDataset } from './geo/datasets.js'
import { regionRiverPackAvailable } from './geo/river-region-store.js'
import type { MapDatasetQuery } from './types.js'
import { briefHash, MapStudioConflictError, MapStudioStaleError, mutateTask } from './store.js'

/** 用户确认的来源集合：维基系 + Europeana + Smithsonian，不扩散到其它适配器 */
export const MAP_RESEARCH_ADAPTERS: ResearchAdapter[] = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']

/** 检索 IO 的唯一入口；测试替换成本地夹具，生产就是 asset-research 的真实适配器 */
export const mapResearchIO = { search: searchAdapter, fetchText }

const MAX_SOURCES = 40
const HITS_PER_QUERY = 8
const SNIPPET_FOR_MODEL = 300
const TEXT_FOR_MODEL = 6000

// 定长数组而非 z.tuple：百炼 qwen4-max-preview 拒绝元组式 JSON Schema（items:[…] → 400
// invalid_parameter_error，Issue #120，observed call 7020–7022）；.length(N) 校验语义等价
// （恰好 N 个 number），emitted schema 为 items:{type:number}+minItems/maxItems，各端点通用。
const bboxSchema = z.array(z.number()).length(4)
export const featureSubmissionSchema = z.object({
  kind: z.enum(['place', 'route', 'region']),
  name: z.string().min(1),
  category: z.enum(['river', 'lake', 'coast', 'mountain', 'settlement', 'route', 'territory', 'other']),
  geometry_source: z.enum(['dataset', 'source', 'model']),
  dataset_ref: z.object({ ref: z.string(), clip_bbox: bboxSchema.optional() }).optional(),
  dataset_missing: z.object({ queries: z.array(z.string()), reason: z.string() }).optional(),
  lon: z.number().optional(),
  lat: z.number().optional(),
  points: z.array(z.array(z.number()).length(2)).optional(),
  coordinate_basis: z.enum(['excerpt', 'well_known', 'approximate_schematic']),
  basis: z.string(),
  supporting_excerpt: z.string().optional(),
  source_ids: z.array(z.string()),
  uncertainty: z.enum(['high', 'medium', 'low']),
  approximate: z.boolean().optional(),
  far_from_others_reason: z.string().optional(),
  acknowledge: z.array(z.object({ code: z.string(), reason: z.string() })).optional(),
  conflicts: z.array(z.object({ source_id: z.string(), lon: z.number().nullable(), lat: z.number().nullable(), note: z.string() })).optional(),
})
export const relationSubmissionSchema = z.object({
  id: z.string(), subject: z.string(), object: z.string(),
  relation: z.enum(['distance_km', 'east_of', 'west_of', 'north_of', 'south_of', 'near_river']),
  value_km: z.number().nonnegative().optional(), tolerance_km: z.number().nonnegative().optional(),
  excerpt: z.string(), source_id: z.string(),
})

/** 自由文本没有结构化地名表：按分隔符切分，并只把地理类别词结尾的短语作为候选；
 * 这只是确定性的规模估计，不能把漏识别当作地图事实。续跑没有已提交要素，仍按原规模估算。 */
export function researchStepBudget(brief: MapBrief, _progress: MapResearchProgress | null): { steps: number; targets: number; basis: string } {
  const candidates = new Set<string>()
  for (const text of [brief.subject, brief.location, brief.purpose, brief.notes]) {
    for (const part of text.split(/[、，,；;。.\n和与至—–/]+/u)) {
      // 类别词本身包含地名末字，前缀仅一个字符的「长江」等两字地名也要计入。
      const matches = part.match(/[\p{Script=Han}A-Za-z0-9·\-]{1,30}?(?:汗国|盐场|领地|河|江|湖|山|镇|城)/gu) ?? []
      for (const match of matches) candidates.add(match)
    }
  }
  const targets = candidates.size || ({ site: 4, regional: 6, overview: 8 } as const)[brief.detail_level]
  return { steps: Math.min(100, 40 + 6 * targets), targets, basis: candidates.size ? '地理类别词结尾的去重候选' : `detail_level=${brief.detail_level} 保底` }
}


export interface ResearchStageInput {
  taskId: number
  runId: number
  stageModel: StageModel
  brief: MapBrief
  spec: MapSpec | null
  startRounds: number
  feedback: string | null
  progress: MapResearchProgress | null
}

export async function runResearchStage(input: ResearchStageInput): Promise<StageAgentResult<MapResearch>> {
  const progress = input.progress
  const sources: MapResearchSource[] = (progress?.sources ?? []).map(source => ({ ...source }))
  const hitsById = new Map<string, ResearchHit>(Object.entries(progress?.hits ?? {}) as Array<[string, ResearchHit]>)
  const queries: MapResearchQuery[] = (progress?.queries ?? []).map(query => ({ ...query }))
  const datasetQueries: MapDatasetQuery[] = (progress?.dataset_queries ?? []).map(query => ({ ...query, refs: [...query.refs] }))
  // 命中保留供 fetchText 使用；标记记录已读，即使正文恰好等于摘要也可恢复。
  const readIds = new Set(sources.filter(source => (hitsById.get(source.id) as (ResearchHit & { _map_studio_read?: boolean }) | undefined)?._map_studio_read === true).map(source => source.id))
  let uncertainties = [...(progress?.uncertainties ?? [])]
  let stepsUsed = progress?.steps_used ?? 0
  let roundsUsed = progress?.rounds_used ?? 0
  const reportedRounds = new Set<number>()
  const budget = researchStepBudget(input.brief, progress)

  const confirmed = input.spec ? [
    ...input.spec.places.filter(item => item.proposed !== true).map(item => `地点「${item.name}」(${item.lon}, ${item.lat})`),
    ...input.spec.routes.filter(item => item.proposed !== true).map(item => `路线「${item.name}」${item.points.length} 个顶点`),
    ...(input.spec.regions ?? []).filter(item => item.proposed !== true).map(item => `范围「${item.name}」${item.points.length} 个顶点`),
  ] : []
  const datasetHistory = () => {
    const groups = new Map<string, { query: MapDatasetQuery; count: number; refs: Set<string>; hits: number }>()
    for (const query of datasetQueries) {
      const key = JSON.stringify([query.layer, query.query, query.bbox ?? null])
      const group = groups.get(key)
      if (group) {
        group.count++
        group.query = query
        group.hits = Math.max(group.hits, query.hits)
        for (const ref of query.refs) group.refs.add(ref)
      } else {
        groups.set(key, { query, count: 1, refs: new Set(query.refs), hits: query.hits })
      }
    }
    return [...groups.values()].map(({ query, count, refs, hits }) =>
      `${query.layer}「${query.query}」${query.bbox ? ` bbox=${JSON.stringify(query.bbox)}` : ''}${count > 1 ? ` ×${count} 次 ` : ''}${hits} 命中，refs：${[...refs].join('、') || '无'}${query.error ? `；最近错误：${query.error}` : ''}`,
    ).join('；')
  }


  return await runStageAgent<MapResearch>({
    taskId: input.taskId,
    runId: input.runId,
    stage: 'research',
    stageModel: input.stageModel,
    skill: 'research',
    maxSteps: budget.steps,
    stepBudget: { steps: budget.steps, extendSteps: 40, warnRemaining: 8, warnText: '步数预算即将用完：先补齐未检索适配器再立即提交已有要素，未尽事项写 uncertainties。' },
    onRoundEnd: async ({ round, outcome, problems, stepsUsed: used }) => {
      stepsUsed += used
      if (!reportedRounds.has(round)) { reportedRounds.add(round); roundsUsed++ }
      const kind: MapFailureKind = outcome === 'steps_exhausted' || outcome === 'ended_without_delivery' || outcome === 'call_error' || outcome === 'rejected' ? outcome : 'mixed'
      try {
        await mutateTask(input.taskId, { expectedRunId: input.runId, expectedBriefHash: briefHash(input.brief), action: 'research_progress', actor: 'auto', history: false, mutate: ctx => {
          ctx.state.research_progress = {
            brief_hash: briefHash(input.brief)!, sources: sources.map(source => ({ ...source })),
            hits: Object.fromEntries(hitsById), queries: queries.map(query => ({ ...query })),
            dataset_queries: datasetQueries.map(query => ({ ...query, refs: [...query.refs] })),
            uncertainties: [...uncertainties], steps_used: stepsUsed, rounds_used: roundsUsed,
            last_failure: outcome === 'accepted' ? null : { kind, problems: [...problems], at: now() }, updated_at: now(),
          }
        } })
      } catch (err) {
        if (!(err instanceof MapStudioStaleError) && !(err instanceof MapStudioConflictError)) {
          logTaskWarn('MapStudio', 'research-progress-write', { taskId: input.taskId, runId: input.runId, error: err instanceof Error ? err.message : String(err) })
        }
      }
    },
    startRounds: input.startRounds,
    initialFeedback: input.feedback,
    prompt: () => [
      '请为下面这张历史地图检索资料并提交地理要素。',
      mapBriefText(input.brief),
      confirmed.length ? `已由人工确认、你不能改写也不要再提交的要素：\n${confirmed.join('\n')}` : '',
      progress ? `续跑：已登记 ${sources.length} 条来源；已读正文：${sources.filter(s => readIds.has(s.id)).map(s => `${s.id}「${s.title}」`).join('、') || '无'}。未决事项：${uncertainties.join('；') || '无'}。不要重复逐字相同的查询。` : '',
      sources.length ? `本阶段已检索到的来源（仍可引用）：${sources.map(s => `${s.id} ${s.adapter}「${s.title}」`).join('；')}` : '',
    ].filter(Boolean).join('\n\n'),
    // 检索阶段的状态全部由代码从本次会话的登记结果生成：早先的检索结果被压缩后，模型从这里看已有来源与查询历史
    state: () => [
      sources.length
        ? `已登记来源（只列编号与标题，正文需要时再 read_source）：${sources.map(source => `${source.id}「${source.title}」(${source.adapter}，${readIds.has(source.id) ? '已读正文' : '仅摘要'})`).join('；')}`
        : '已登记来源：无（先 search_sources）',
      datasetQueries.length
        ? `dataset 查询历史：${datasetHistory()}`
        : 'dataset 查询历史：无',
      queries.length
        ? `已检索过的来源适配器：${[...new Set(queries.map(query => query.adapter))].join('、')}（要求全部：${MAP_RESEARCH_ADAPTERS.join('、')}）`
        : `已检索过的来源适配器：无（要求全部：${MAP_RESEARCH_ADAPTERS.join('、')}）`,
      queries.length ? `来源查询历史：${queries.map(query => `${query.adapter}「${query.query}」${query.error ? `错误：${query.error}` : `${query.hits} 命中`}`).join('；')}` : '',
    ].join('\n'),
    tools: (session) => ({
      search_dataset: stageTool(session, {
        id: 'search_dataset',
        description: '检索离线 Natural Earth 原始几何与预取的 OSM 河流（ODbL）。自然要素必须优先采用 dataset_ref；没有命中才可提交 dataset_missing。每次查询会被登记并核对。'
          + '河流/湖泊结果里带 group 字段的是组引用 ne-group:…：它覆盖同一条河/湖的全部要素（River 与 Lake Centerline），拼接成连续几何；'
          + 'group.members 是成员要素，group.chains 是拼接后仍不连通的链数，group.shortest_chain_km 是最短链长度——链数多或短链很小说明 clip_bbox 该收紧。'
          + '单个要素 ref（ne:…）只覆盖一个原始要素，裁剪后容易碎成多段。',
        inputSchema: z.object({
          layer: z.enum(['river', 'lake', 'coast', 'mountain', 'physical_region', 'place']),
          query: z.string().min(1),
          bbox: z.array(z.number()).length(4).optional(),
        }),
        summarize: result => Array.isArray(result.candidates)
          ? `${result.candidates.length} 个候选（refs 已列入当前状态的查询历史）`
          : `返回错误：${String(result.error ?? '未知')}`,
        execute: async ({ layer, query, bbox: rawBbox }) => {
          // zod .length(4) 类型是 number[]；运行时已校验恰好 4 个 number，收窄回领域元组类型
          const bbox = rawBbox as [number, number, number, number] | undefined
          try {
            const hits = searchDataset(layer, query, bbox)
            datasetQueries.push({ layer, query, ...(bbox ? { bbox } : {}), hits: hits.length, refs: hits.map(hit => hit.ref), error: null })
            return { candidates: hits, ...(layer === 'river' && !regionRiverPackAvailable()
              ? { warning: '区域 OSM 河流索引尚未预取；当前仅检索 Natural Earth。请在 backend 运行 node --import tsx scripts/prefetch-river-region.ts。' }
              : {}) }
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            datasetQueries.push({ layer, query, ...(bbox ? { bbox } : {}), hits: 0, refs: [], error })
            return { error, hint: '这是检索失败，不是零命中；不能用它声称 dataset_missing' }
          }
        },
      }),
      search_sources: stageTool(session, {
        id: 'search_sources',
        description: `真实检索一个来源。adapter 只能是 ${MAP_RESEARCH_ADAPTERS.join(' / ')}；每个 adapter 本阶段至少检索一次（零命中也要检索）。`
          + '维基用中文或英文条目名/关键词，Europeana、Smithsonian 用英文。返回的命中会登记为来源 S1、S2…，提交要素时用这些编号引用。',
        inputSchema: z.object({
          adapter: z.string().describe(MAP_RESEARCH_ADAPTERS.join(' / ')),
          query: z.string().describe('检索式'),
        }),
        summarize: result => {
          const hits = Array.isArray(result.hits) ? result.hits : []
          const ids = hits.map(hit => hit && typeof hit === 'object' && 'id' in hit ? String(hit.id) : '').filter(Boolean)
          return ids.length ? `登记了 ${ids.join('、')}（${hits.length} 条命中）` : `零命中，该来源已记为「问过」${result.note ? `；${String(result.note)}` : ''}`
        },
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
        summarize: result => typeof result.text === 'string'
          ? `${String(result.id)} 正文 ${result.text.length} 字，已读（正文不再重发；逐字引用需要时再 read_source）`
          : `返回错误：${String(result.error ?? '未知')}`,
        execute: async ({ source_id }) => {
          const source = sources.find(item => item.id === source_id)
          const hit = hitsById.get(String(source_id))
          if (!source || !hit) return { error: `没有来源 ${JSON.stringify(source_id)}；已登记：${sources.map(s => s.id).join('、') || '（无，请先检索）'}` }
          const textual = hit.adapter === 'wikipedia-zh' || hit.adapter === 'wikipedia-en'
          if (textual) {
            const body = await mapResearchIO.fetchText(hit, TEXT_FOR_MODEL)
            if (body) source.excerpt = body
          }
          readIds.add(source.id)
          Object.assign(hit, { _map_studio_read: true })
          return { id: source.id, title: source.title, url: source.url, text: source.excerpt.slice(0, TEXT_FOR_MODEL), full_text: textual }
        },
      }),
      submit_features: stageTool(session, {
        id: 'submit_features',
        description: '交付本阶段结果（消耗一轮）。features 每项字段见技能说明；uncertainties 列出读者需要知道的不确定之处，notes 写其它说明。'
          + '任何一条不合格都会整批拒收并逐条说明原因。',
        inputSchema: z.object({
          features: z.array(featureSubmissionSchema).describe('地理要素数组；dataset 只提交 dataset_ref，不能手写 points/lon/lat'),
          extent: z.array(z.number()).length(4).describe('地图研究空间范围 [west,south,east,north]；所有顶点必须落在范围内；数据集要素可直接用 extent 作为 dataset_ref.clip_bbox 裁剪'),
          relations: z.array(relationSubmissionSchema).optional().describe('从正文抽取距离及方位；excerpt 必须逐字引用 source_id 正文'),
          uncertainties: z.array(z.string()).optional(),
          notes: z.array(z.string()).optional(),
        }),
        summarize: result => result.accepted === true
          ? `第 ${String(result.round)} 轮交付已接受`
          : `第 ${String(result.round)} 轮交付被拒收，${Array.isArray(result.problems) ? result.problems.length : 0} 个问题（逐条见当前状态）`,
        execute: async (submission) => {
          uncertainties = (submission.uncertainties ?? []).map(String).filter(Boolean)
          const checked = validateFeatureSubmission(submission.features, {
            brief: input.brief,
            sources,
            searchedAdapters: queries.map(query => query.adapter),
            requiredAdapters: MAP_RESEARCH_ADAPTERS,
            confirmed: input.spec,
            extent: submission.extent,
            relations: submission.relations,
            datasetQueries,
          })
          return await session.deliver(checked.problems, () => ({
            queries: [...queries],
            dataset_queries: [...datasetQueries],
            // zod .length(4) 的类型是 number[]；运行时已校验恰好 4 个 number，收窄回领域元组类型
            extent: submission.extent as [number, number, number, number],
            relations: checked.relations,
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
