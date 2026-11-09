/**
 * 地图工作流的资料检索（Issue #84）
 *
 * 这一步**真的去检索**：维基百科（中/英）、Europeana、Smithsonian 用既有适配器
 * （services/asset-research/sources.ts）发真实请求，每个来源的失败/零命中都原样留痕。
 * 模型只被允许在「检索回来的正文」里挑地名与坐标依据，不允许凭记忆给 URL、
 * 也不允许把一条无关的馆藏条目拿来给坐标背书。
 *
 * 用户确认的口径：
 * - 有出处 ≠ 证明坐标：每条地物必须带 `supporting_excerpt`（逐字出自某条来源摘录）
 *   与 `source_ids`；程序会逐条回查，查不到就降级成「公认位置 / 示意位置」并标高不确定度；
 * - 近似可以用，但必须显式可见（approximate + uncertainty），绝不冒充考证结论；
 * - 历史面状边界不虚构：`regions` 只在示意图模式（brief.schematic）下接受，且恒为近似；
 * - 来源全空 → 本步失败/阻塞，绝不用「模型自己知道」凑成功。
 */
import { logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel, type StageModel } from '../ai-stages.js'
import { callTextChat } from '../vision-chat.js'
import { parseJsonReply } from '../asset-pipeline/prompts.js'
import { fetchText, searchAdapter, type ResearchAdapter, type ResearchHit } from '../asset-research/sources.js'
import { now } from '../../utils/response.js'
import type {
  MapBrief,
  MapCoordinateBasis,
  MapFeatureConflict,
  MapFeatureKind,
  MapResearch,
  MapResearchFeature,
  MapResearchQuery,
  MapResearchSource,
} from './types.js'

/** 用户确认的来源集合：维基系 + Europeana + Smithsonian，不扩散到其它适配器 */
export const MAP_RESEARCH_ADAPTERS: ResearchAdapter[] = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian']

const MAX_QUERIES = 12
const MAX_TEXT_SOURCES = 8
const MAX_SOURCES = 24
const MAX_FEATURES = 80
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768
const TEXT_TIMEOUT_MS = 300_000
/** 送进模型的单条摘录上限：够判断地名上下文，又不至于把窗口占满 */
const EXCERPT_FOR_MODEL = 3000

const PLAN_SYSTEM = `你在为一张历史地图制定资料检索计划。只能使用这些来源：
- wikipedia-zh / wikipedia-en：地名、事件、年代、走向的正文；
- europeana / smithsonian：欧美机构藏的历史地图与图像著录。
给出 3-10 条检索式：维基用中文或英文条目名/关键词，Europeana、Smithsonian 用英文。
不要编造 URL，不要写出检索式以外的内容。
只返回 JSON：{"queries":[{"adapter":"wikipedia-zh","query":"邗沟"}]}`

const EXTRACT_SYSTEM = `你在从**已经检索到的资料**里整理一张历史地图需要的地理要素。严禁凭记忆补充资料里没有的内容。

规则（违反即被程序丢弃）：
1. 每个要素必须给 source_ids（引用下面列出的来源编号，如 ["S3"]）。编号不存在 → 丢弃。
2. coordinate_basis 三选一，必须诚实：
   - "excerpt"：资料正文里确有支撑，supporting_excerpt 必须**逐字复制**该来源摘录中的原句（不得改写、不得翻译）；
   - "well_known"：现代地名的公认位置，资料没有逐字说明，凭常识给出；
   - "approximate_schematic"：只能给出大致方位的示意位置。
3. 坐标是 WGS84 十进制度。拿不准就用 approximate_schematic 并把 uncertainty 设为 high，不要假装精确。
4. 同一地点不同来源给出不同位置时，写进 conflicts，不要自行取舍。
5. 历史时期的**面状边界**（疆域、辖境）只有资料明确描述范围时才能给出，严禁凭几个地点任意包围出“真实防区”。
   若需求明确开启示意图模式、要表达资料中有依据的山谷/通道等空间范围，可用 approximate_schematic 给近似示意面，
   basis 必须说明来源中的范围依据以及人为概括之处，uncertainty=high；不能把它表述成历史辖界。
6. 几何按 kind 分别填写：place 必须给 lon/lat；route 的 points 至少两个不同顶点；
   region 的 points 必须至少三个不同且不共线的 WGS84 顶点（可首尾闭合）。
   不要返回 kind=region 却只给中心点或空 points：没有足够范围依据就不输出该面，并在 uncertainties 明确缺口。
7. basis 用一句话说明坐标怎么来的；uncertainties 列出这张图里读者需要知道的不确定之处。

只返回 JSON：
{"features":[{"kind":"place|route|region","name":"","lon":0,"lat":0,"points":[[lon,lat]],
"coordinate_basis":"","supporting_excerpt":"","source_ids":["S1"],"basis":"","uncertainty":"high|medium|low",
"approximate":true,"conflicts":[{"source_id":"S2","lon":0,"lat":0,"note":""}]}],
"uncertainties":[""],"notes":[""]}`

function briefText(brief: MapBrief): string {
  return [
    `地图主题：${brief.subject || '（未填）'}`,
    `时代：${brief.era || '（未填）'}`,
    `地域：${brief.location || '（未填）'}`,
    `用途：${brief.purpose || '（未填）'}`,
    `详略：${brief.detail_level}；示意图模式：${brief.schematic ? '是' : '否'}`,
    brief.notes ? `补充：${brief.notes}` : '',
  ].filter(Boolean).join('\n')
}

async function jsonChat(model: StageModel, prompt: string, systemPrompt: string): Promise<Record<string, unknown>> {
  const reply = await callTextChat(model, prompt, {
    systemPrompt, temperature: 0.1, maxTokens: MAX_TOKENS, timeoutMs: TEXT_TIMEOUT_MS, interactive: true,
  })
  const parsed = parseJsonReply(reply.text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

/** 模型给的检索计划；非法/为空时回落到按 brief 拼的确定性检索式（本步绝不跳过真实检索） */
function planQueries(raw: unknown, brief: MapBrief): Array<{ adapter: ResearchAdapter; query: string }> {
  const list = Array.isArray(raw) ? raw : []
  const planned: Array<{ adapter: ResearchAdapter; query: string }> = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const adapter = 'adapter' in item ? String(item.adapter) : ''
    const query = 'query' in item ? String(item.query ?? '').trim() : ''
    if (!query || !(MAP_RESEARCH_ADAPTERS as string[]).includes(adapter)) continue
    planned.push({ adapter: adapter as ResearchAdapter, query })
    if (planned.length >= MAX_QUERIES) break
  }
  // 三个来源族**每次都必须真的被问到**（用户确认的范围）：模型的计划只做补充，
  // 缺哪一族就按 brief 拼一条确定性检索式补上，零命中/失败也要留下证据。
  const subject = [brief.subject, brief.era, brief.location].filter(Boolean).join(' ').trim() || brief.subject
  if (!subject && !planned.length) return []
  const place = brief.location || brief.subject
  const required: Array<{ adapter: ResearchAdapter; query: string }> = [
    { adapter: 'wikipedia-zh', query: subject },
    { adapter: 'wikipedia-en', query: subject },
    { adapter: 'europeana', query: `${place} historical map` },
    { adapter: 'smithsonian', query: `${place} map` },
  ]
  for (const fallback of required) {
    if (!fallback.query.trim()) continue
    if (planned.some(item => item.adapter === fallback.adapter)) continue
    planned.push(fallback)
  }
  return planned.slice(0, MAX_QUERIES + required.length)
}

/** 比对用的归一化：去空白与常见标点差异，避免「逐字核对」被空格打败 */
function matchKey(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，,。.、；;：:！!？?「」『』“”"'（）()]/g, '')
}

interface SourceCollect {
  sources: MapResearchSource[]
  queries: MapResearchQuery[]
}

async function collectSources(planned: Array<{ adapter: ResearchAdapter; query: string }>): Promise<SourceCollect> {
  const queries: MapResearchQuery[] = []
  const hits: ResearchHit[] = []
  const seen = new Set<string>()
  for (const item of planned) {
    try {
      const found = await searchAdapter(item.adapter, item.query)
      queries.push({ adapter: item.adapter, query: item.query, hits: found.length, error: null })
      for (const hit of found) {
        const key = hit.url || hit.image || `${hit.adapter}|${hit.title}`
        if (seen.has(key)) continue
        seen.add(key)
        hits.push(hit)
      }
    } catch (err) {
      queries.push({ adapter: item.adapter, query: item.query, hits: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const sources: MapResearchSource[] = []
  let textCount = 0
  for (const hit of hits) {
    if (sources.length >= MAX_SOURCES) break
    let excerpt = hit.snippet ?? ''
    const textual = hit.adapter === 'wikipedia-zh' || hit.adapter === 'wikipedia-en' || hit.adapter === 'wikisource-zh'
    if (textual && textCount < MAX_TEXT_SOURCES) {
      try {
        const body = await fetchText(hit)
        if (body) {
          excerpt = body
          textCount++
        }
      } catch (err) {
        logTaskWarn('MapWorkflow', 'fetch-text', { title: hit.title, error: err instanceof Error ? err.message : String(err) })
      }
    }
    sources.push({
      id: `S${sources.length + 1}`,
      adapter: hit.adapter,
      title: hit.title,
      url: hit.url,
      institution: hit.institution,
      date: hit.date,
      license: hit.license,
      tier: hit.tier,
      excerpt,
    })
  }
  return { sources, queries }
}

const FEATURE_KINDS: MapFeatureKind[] = ['place', 'route', 'region']
const BASES: MapCoordinateBasis[] = ['excerpt', 'well_known', 'approximate_schematic']
const UNCERTAINTIES = ['high', 'medium', 'low'] as const

function lonLat(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null
  const lon = Number(raw[0])
  const lat = Number(raw[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
  return [lon, lat]
}

function parseConflicts(raw: unknown, sourceIds: Set<string>): MapFeatureConflict[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): MapFeatureConflict[] => {
    if (!item || typeof item !== 'object') return []
    const sourceId = 'source_id' in item ? String(item.source_id) : ''
    const note = 'note' in item ? String(item.note ?? '') : ''
    const lon = 'lon' in item && Number.isFinite(Number(item.lon)) ? Number(item.lon) : null
    const lat = 'lat' in item && Number.isFinite(Number(item.lat)) ? Number(item.lat) : null
    if (!sourceIds.has(sourceId) && !note) return []
    return [{ source_id: sourceId, lon, lat, note }]
  })
}

/**
 * 程序复核模型输出。模型说什么不算数，这里逐条回查来源与原文：
 * 引用不存在的来源 → 丢弃；说是正文支撑但原文找不到 → 降级为公认/示意位置并标高不确定度。
 */
function groundFeatures(raw: unknown, sources: MapResearchSource[], brief: MapBrief): { features: MapResearchFeature[]; notes: string[] } {
  const byId = new Map(sources.map(source => [source.id, source]))
  const excerptKeys = new Map(sources.map(source => [source.id, matchKey(source.excerpt)]))
  const notes: string[] = []
  const features: MapResearchFeature[] = []
  const list = Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (features.length >= MAX_FEATURES) break
    if (!item || typeof item !== 'object') continue
    const record: Record<string, unknown> = { ...item }
    const name = String(record.name ?? '').trim()
    if (!name) continue
    const kind = FEATURE_KINDS.includes(record.kind as MapFeatureKind) ? record.kind as MapFeatureKind : 'place'

    const citedIds = (Array.isArray(record.source_ids) ? record.source_ids : []).map(String).filter(id => byId.has(id))
    if (!citedIds.length) {
      notes.push(`已丢弃「${name}」：没有引用任何本次检索到的来源（模型给的来源编号不存在）`)
      continue
    }

    const supporting = String(record.supporting_excerpt ?? '').trim()
    const supportingKey = matchKey(supporting)
    const verified = supportingKey.length >= 6 && citedIds.some(id => (excerptKeys.get(id) ?? '').includes(supportingKey))
    let basis = BASES.includes(record.coordinate_basis as MapCoordinateBasis) ? record.coordinate_basis as MapCoordinateBasis : 'approximate_schematic'
    let uncertainty = (UNCERTAINTIES as readonly string[]).includes(String(record.uncertainty)) ? String(record.uncertainty) as MapResearchFeature['uncertainty'] : 'high'
    let approximate = record.approximate === true || basis === 'approximate_schematic'
    if (basis === 'excerpt' && !verified) {
      basis = 'well_known'
      uncertainty = 'high'
      approximate = true
      notes.push(`「${name}」声称有正文支撑，但原句在来源摘录里查不到，已降级为「公认位置（高不确定度）」`)
    }

    const point = lonLat([record.lon, record.lat])
    const rawPoints = Array.isArray(record.points) ? record.points.map(lonLat).filter((p): p is [number, number] => p !== null) : []

    if (kind === 'region') {
      // 历史疆域不虚构：只有显式示意图模式才接受面，且恒为近似
      if (!brief.schematic) {
        if (point) {
          features.push({
            id: `F${features.length + 1}`, kind: 'place', name, lon: point[0], lat: point[1], points: [],
            coordinate_basis: basis, basis: `${String(record.basis ?? '')}（面状边界未采纳，已退化为中心点）`.trim(),
            supporting_excerpt: supporting, excerpt_verified: verified, source_ids: citedIds,
            source_url: byId.get(citedIds[0]!)?.url ?? null, source_title: byId.get(citedIds[0]!)?.title ?? '',
            uncertainty: 'high', approximate: true, conflicts: parseConflicts(record.conflicts, new Set(byId.keys())),
          })
        }
        notes.push(`「${name}」的面状边界未采纳：未开启示意图模式时不绘制历史疆域（不虚构边界）`)
        continue
      }
      if (rawPoints.length < 3) {
        notes.push(`「${name}」的面状边界点数不足（<3），已丢弃`)
        continue
      }
      basis = 'approximate_schematic'
      uncertainty = 'high'
      approximate = true
    }
    if (kind === 'route' && rawPoints.length < 2) {
      notes.push(`「${name}」的路线点数不足（<2），已丢弃`)
      continue
    }
    if (kind === 'place' && !point) {
      notes.push(`「${name}」没有可用的经纬度，已丢弃`)
      continue
    }

    const primary = byId.get(citedIds[0]!)
    features.push({
      id: `F${features.length + 1}`,
      kind,
      name,
      lon: point ? point[0] : null,
      lat: point ? point[1] : null,
      points: kind === 'place' ? [] : rawPoints,
      coordinate_basis: basis,
      basis: String(record.basis ?? '').slice(0, 1000),
      supporting_excerpt: supporting.slice(0, 1000),
      excerpt_verified: verified,
      source_ids: citedIds,
      source_url: primary?.url ?? null,
      source_title: primary?.title ?? '',
      uncertainty,
      approximate,
      conflicts: parseConflicts(record.conflicts, new Set(byId.keys())),
    })
  }
  return { features, notes }
}

export class MapResearchEmptyError extends Error {
  code = 'research_no_sources'
}

/**
 * 执行一次真实检索并整理成可落库的证据。
 * 一条来源都没拿到就抛 `MapResearchEmptyError`——此时只有模型记忆，没有资料，
 * 那不是「检索成功但结果少」，而是这一步没有完成。
 */
export async function researchMap(brief: MapBrief, opts: { textConfigId?: number; onStep?: (step: string) => void } = {}): Promise<MapResearch> {
  const model = await resolveStageModel('asset_research', { configId: opts.textConfigId })
  opts.onStep?.('plan')
  let plan: Record<string, unknown> = {}
  try {
    plan = await jsonChat(model, briefText(brief), PLAN_SYSTEM)
  } catch (err) {
    logTaskWarn('MapWorkflow', 'plan-failed', { error: err instanceof Error ? err.message : String(err) })
  }
  const planned = planQueries(plan.queries, brief)
  if (!planned.length) {
    throw new MapResearchEmptyError('无法生成检索式：地图主题为空，请先填写主题/地域再开始检索')
  }

  opts.onStep?.('search')
  const { sources, queries } = await collectSources(planned)
  if (!sources.length) {
    const reasons = queries.map(item => `${item.adapter}「${item.query}」${item.error ? `失败：${item.error}` : '零命中'}`).slice(0, 4).join('；')
    throw new MapResearchEmptyError(`维基百科 / Europeana / Smithsonian 全部没有可用结果，不能只凭模型记忆出图。详情：${reasons}`)
  }

  opts.onStep?.('extract')
  const listing = sources.map(source => ({
    id: source.id, adapter: source.adapter, title: source.title, url: source.url,
    institution: source.institution, date: source.date, excerpt: source.excerpt.slice(0, EXCERPT_FOR_MODEL),
  }))
  const extracted = await jsonChat(model, `${briefText(brief)}\n\n检索到的来源：\n${JSON.stringify(listing)}`, EXTRACT_SYSTEM)
  const { features, notes } = groundFeatures(extracted.features, sources, brief)

  const uncertainties = (Array.isArray(extracted.uncertainties) ? extracted.uncertainties : []).map(String).filter(Boolean)
  const modelNotes = (Array.isArray(extracted.notes) ? extracted.notes : []).map(String).filter(Boolean)
  const failed = queries.filter(item => item.error)
  if (failed.length) {
    notes.push(`${failed.length} 条检索失败（${failed.map(item => item.adapter).join('、')}），结果可能不完整`)
  }
  if (!features.length) {
    notes.push('检索到了资料，但没有任何可用的地理要素；请人工补充地点或改写检索主题')
  }

  return {
    queries,
    sources,
    features,
    uncertainties: [...uncertainties, ...features.filter(f => f.conflicts.length).map(f => `「${f.name}」不同来源给出的位置不一致，已全部保留待人工裁定`)],
    notes: [...modelNotes, ...notes],
    searched_at: now(),
  }
}
