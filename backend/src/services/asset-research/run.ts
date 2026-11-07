/**
 * 资产资料检索任务（Issue #79）：检索计划 → 多来源检索 + 正文摘录 → 著录预筛 → 下载 → 视觉判断角色。
 *
 * 任务行 = sys_task(type='text', params.kind='asset_research')，结果整体落在 `params.asset_research`：
 * 浏览器刷新、流水线事实表步骤都从这里读。候选图只缓存到 `static/asset-sources/candidates/`，
 * 是否入库（变成 asset_source）由用户在面板上点——检索不替用户做许可判断。
 *
 * 本模块不 import 资产流水线：调用方传入资产的最小视图，避免 asset-pipeline ⇄ asset-research 循环依赖。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel, type StageModel } from '../ai-stages.js'
import { callTextChat, imageContentPart, type ChatContent } from '../vision-chat.js'
import { createTextTask, finishTextTask, parseTextTaskParams, patchTextTaskParams, textTaskKindOf, textTaskOutcome } from '../text-task.js'
import { runWithTextTask } from '../text-task-context.js'
import { parseJsonReply } from '../asset-pipeline/prompts.js'
import { downloadImage, fetchText, RESEARCH_ADAPTERS, searchAdapter, type ResearchAdapter, type ResearchHit } from './sources.js'

export type ResearchAssetKind = 'character' | 'scene' | 'prop'

export interface ResearchSubject {
  kind: ResearchAssetKind
  id: number
  dramaId: number
  name: string
  description: string | null
}

export type CandidateRole = 'original' | 'generation_reference' | 'shape_only' | 'text_source' | 'reject'

export interface ResearchCandidate extends ResearchHit {
  /** 本地缓存（static/ 相对路径），入库时直接用它，不重新下载 */
  local_path: string
  sha256: string
  role: CandidateRole
  depicts: string
  what_it_proves: string[]
  cautions: string[]
}

export interface ResearchText {
  adapter: ResearchAdapter
  title: string
  url: string | null
  excerpt: string
}

export interface AssetResearchResult {
  asset_kind: ResearchAssetKind
  asset_id: number
  queries: Array<{ adapter: ResearchAdapter; query: string; hits: number; error?: string }>
  texts: ResearchText[]
  candidates: ResearchCandidate[]
  /** 预筛后没下载成功或视觉判断失败的条数（只计数，便于解释「为什么候选少」） */
  dropped: number
}

const TEXT_TIMEOUT_MS = 300_000
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768
const MAX_QUERIES = 20
const MAX_TEXTS = 8
const MAX_IMAGES = 12
const CANDIDATE_DIR = 'asset-sources/candidates'

const KIND_LABEL: Record<ResearchAssetKind, string> = { character: '人物', scene: '场景', prop: '器物/道具' }

// ── prompts（实验 lab2 的最终版：中文器物名、分三类找图、分类浏览）──────────────
const PLAN_SYSTEM = `你是纪录片美术组的资料研究员。给定一件历史资产，制定检索计划，在权威来源里找到：
（1）它是什么、不是什么的文字依据；（2）它本身或同时期同类实物的图像；（3）带文字的资产要找准确原文。
可用来源（adapter 只能用这些名字）：
- wikipedia-zh / wikipedia-en：概述与线索（不能作为唯一事实依据）
- wikisource-zh：古籍、典制、条约原文（如会典、正史志书）
- commons：维基共享资源图像搜索。中国器物、建筑、人物必须同时用中文名检索（中文名能命中国内博物馆、档案馆上传的实物与印迹，英文常检不到）
- commons-category：按维基共享资源分类浏览，query 写分类名（如 Seals of the Ming Dynasty、Grand Canal (China)）；分类比关键词准
- europeana / smithsonian / met / cleveland：欧美博物馆开放藏品，用英文关键词，写馆藏常用英文名
- loc：美国国会图书馆（老照片、地图、版画）
- internet-archive：古籍与旧书扫描（中文或英文书名）
- uk-national-archives：英国国家档案馆著录（外交、条约档案）
- openalex：学术论文元数据（制度、形制研究）
要求：12–20 条查询；查询词具体（器物名、制度名、年代、地名），不要泛泛的大词。
图像要分三类去找：①目标本身（原物、原件、印章则包括钤在文书上的印迹）；②同制度同时代的同类实物；③同类但不同时代、只能参考形制的实物。
只返回 JSON：{"queries":[{"adapter":"","query":""}]}`

const SCREEN_SYSTEM = `你在为一件历史资产挑选值得下载细看的图像候选。只看著录（标题、机构、年代、说明、许可）。
挑出最可能是「该资产本身」或「同类同期实物」的候选；排除书籍封面、目录页、无关画作、现代宣传图。
只返回 JSON：{"pick":[0]}，按优先级排序，最多 ${MAX_IMAGES} 个下标。`

const CURATE_SYSTEM = `你是纪录片考据员，判断一张检索到的图像能否用于复原指定资产。只依据图像和著录信息，不编造。
role 取值：
- original：图上就是目标资产本身（原物照片、原件扫描、印迹），可作忠实原件
- generation_reference：同类同期实物，许可允许时可直接给图像模型做参考
- shape_only：只能用来定形制/比例/版式（年代不同、局部、或许可受限），不送进生成模型
- text_source：价值主要在上面的文字
- reject：无关或会误导
只返回 JSON：{"role":"","depicts":"图上实际是什么","what_it_proves":[""],"cautions":["不能据此推出的点、年代/形制差异"]}`

async function jsonChat(model: StageModel, content: ChatContent, systemPrompt: string): Promise<Record<string, unknown>> {
  const call = async (body: ChatContent) => (await callTextChat(model, body, {
    systemPrompt, temperature: 0.2, maxTokens: MAX_TOKENS, timeoutMs: TEXT_TIMEOUT_MS,
  })).text
  const first = await call(content)
  try {
    return parseJsonReply(first) as Record<string, unknown>
  } catch (err) {
    const retry = `上一次的回答不是合法 JSON（${err instanceof Error ? err.message : String(err)}）。请只输出合法 JSON。`
    return parseJsonReply(await call(typeof content === 'string' ? `${content}\n\n${retry}` : [...content, { type: 'text', text: retry }])) as Record<string, unknown>
  }
}

function subjectText(s: ResearchSubject): string {
  return `资产：${s.name}（${KIND_LABEL[s.kind]}）\n描述：${s.description || '（无）'}`
}

function saveCandidate(bytes: Buffer, mime: string): { localPath: string; sha256: string } {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const ext = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tif' }[mime] ?? '.jpg'
  const dir = path.join(STORAGE_ROOT, CANDIDATE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = `${sha256}${ext}`
  const abs = path.join(dir, file)
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, bytes)
  return { localPath: `static/${CANDIDATE_DIR}/${file}`, sha256 }
}

const CANDIDATE_ROLES: CandidateRole[] = ['original', 'generation_reference', 'shape_only', 'text_source', 'reject']
const strList = (raw: unknown) => (Array.isArray(raw) ? raw.map(String).filter(Boolean) : [])

/**
 * 执行一次完整检索；任何单个来源/单张图失败都只计入结果，不抛。
 * `withImages=false`：只做检索计划 + 文字摘录（流水线内联兜底用，控制在步骤时限内）。
 */
export async function performResearch(subject: ResearchSubject, opts: { textConfigId?: number; withImages?: boolean; onStep?: (step: string) => void } = {}): Promise<AssetResearchResult> {
  const text = await resolveStageModel('asset_research', { configId: opts.textConfigId })
  opts.onStep?.('plan')
  const plan = await jsonChat(text, subjectText(subject), PLAN_SYSTEM)
  const planned = (Array.isArray(plan.queries) ? plan.queries : [])
    .map(item => item as { adapter?: string; query?: string })
    .filter((item): item is { adapter: ResearchAdapter; query: string } =>
      (RESEARCH_ADAPTERS as readonly string[]).includes(String(item.adapter)) && !!String(item.query ?? '').trim())
    .slice(0, MAX_QUERIES)

  opts.onStep?.('search')
  const queries: AssetResearchResult['queries'] = []
  const hits: Array<ResearchHit & { query: string }> = []
  const seen = new Set<string>()
  for (const item of planned) {
    try {
      const found = await searchAdapter(item.adapter, item.query)
      queries.push({ ...item, hits: found.length })
      for (const hit of found) {
        const key = hit.url || hit.image
        if (!key || seen.has(key)) continue
        seen.add(key)
        hits.push({ ...hit, query: item.query })
      }
    } catch (err) {
      queries.push({ ...item, hits: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!hits.length && queries.every(item => item.error)) {
    throw new Error(`所有来源检索失败：${queries.map(item => `${item.adapter}「${item.error}」`).slice(0, 3).join('；')}`)
  }

  // 文字资料：每条文字类查询只取首条命中（实测按全局顺序取会被同一主题的条目占满）
  opts.onStep?.('texts')
  const texts: ResearchText[] = []
  const firstPerQuery = new Map<string, ResearchHit>()
  for (const hit of hits) {
    if (/^(wikipedia|wikisource)/.test(hit.adapter) && !firstPerQuery.has(`${hit.adapter}|${hit.query}`)) firstPerQuery.set(`${hit.adapter}|${hit.query}`, hit)
  }
  for (const hit of firstPerQuery.values()) {
    if (texts.length >= MAX_TEXTS) break
    try {
      const excerpt = await fetchText(hit)
      if (excerpt) texts.push({ adapter: hit.adapter, title: hit.title, url: hit.url, excerpt })
    } catch (err) {
      logTaskWarn('AssetResearch', 'fetch-text', { title: hit.title, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (opts.withImages === false) return { asset_kind: subject.kind, asset_id: subject.id, queries, texts, candidates: [], dropped: 0 }

  // 图像：先按著录预筛，再下载给视觉模型判断
  opts.onStep?.('screen')
  const pool = hits.filter(hit => hit.image)
  let picked = pool.slice(0, MAX_IMAGES)
  if (pool.length > MAX_IMAGES) {
    const listing = pool.map((hit, idx) => ({ idx, adapter: hit.adapter, title: hit.title.slice(0, 160), institution: hit.institution.slice(0, 80), date: hit.date, snippet: hit.snippet.slice(0, 160), license: hit.license }))
    const screen = await jsonChat(text, `${subjectText(subject)}\n候选：${JSON.stringify(listing)}`, SCREEN_SYSTEM)
    const order = (Array.isArray(screen.pick) ? screen.pick : []).map(Number).filter(idx => Number.isInteger(idx) && idx >= 0 && idx < pool.length)
    picked = [...new Set(order)].slice(0, MAX_IMAGES).map(idx => pool[idx]!)
  }

  opts.onStep?.('curate')
  const vision = await resolveStageModel('asset_curate')
  const candidates: ResearchCandidate[] = []
  let dropped = 0
  for (const hit of picked) {
    const file = await downloadImage(hit.image!)
    if (!file) { dropped++; continue }
    const { localPath, sha256 } = saveCandidate(file.bytes, file.mime)
    try {
      const image = await imageContentPart(localPath, { maxSide: 1280, quality: 85 })
      const meta = { title: hit.title, institution: hit.institution, date: hit.date, license: hit.license, snippet: hit.snippet }
      const verdict = await jsonChat(vision, [{ type: 'text', text: `目标${subjectText(subject)}\n候选著录：${JSON.stringify(meta)}` }, image.part], CURATE_SYSTEM)
      const role = CANDIDATE_ROLES.includes(verdict.role as CandidateRole) ? verdict.role as CandidateRole : 'shape_only'
      candidates.push({
        ...hit, local_path: localPath, sha256, role, depicts: String(verdict.depicts ?? ''),
        what_it_proves: strList(verdict.what_it_proves), cautions: strList(verdict.cautions),
      })
    } catch (err) {
      dropped++
      logTaskWarn('AssetResearch', 'curate', { title: hit.title, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const order: Record<CandidateRole, number> = { original: 0, generation_reference: 1, shape_only: 2, text_source: 3, reject: 4 }
  candidates.sort((a, b) => order[a.role] - order[b.role])
  return { asset_kind: subject.kind, asset_id: subject.id, queries, texts, candidates, dropped }
}

function isResearchRowFor(row: typeof schema.sysTask.$inferSelect, kind: ResearchAssetKind, id: number): boolean {
  const params = parseTextTaskParams(row.params)
  return textTaskKindOf(row) === 'asset_research' && params?.research_asset_kind === kind && Number(params?.research_asset_id) === id
}

async function researchRows(kind: ResearchAssetKind, id: number) {
  return (await db.select().from(schema.sysTask).where(eq(schema.sysTask.type, 'text')).orderBy(desc(schema.sysTask.id)))
    .filter(row => isResearchRowFor(row, kind, id))
}

export class ResearchConflictError extends Error {}

export async function startAssetResearch(subject: ResearchSubject, episodeId: number, opts: { textConfigId?: number } = {}): Promise<number> {
  const active = (await researchRows(subject.kind, subject.id)).find(row => textTaskOutcome(row.status) === 'running')
  if (active) throw new ResearchConflictError(`该资产正在检索资料（任务 #${active.id}）`)
  const stageModel = await resolveStageModel('asset_research', { configId: opts.textConfigId })
  const taskId = await createTextTask({
    kind: 'asset_research', episodeId, dramaId: subject.dramaId, stageModel,
    prompt: `为${KIND_LABEL[subject.kind]}「${subject.name}」检索权威资料`,
  })
  await patchTextTaskParams(taskId, { research_asset_kind: subject.kind, research_asset_id: subject.id, research_step: 'plan' })
  logTaskStart('AssetResearch', 'run', { taskId, kind: subject.kind, id: subject.id })
  void runWithTextTask(taskId, async () => {
    try {
      const result = await performResearch(subject, {
        textConfigId: opts.textConfigId,
        onStep: step => { void patchTextTaskParams(taskId, { research_step: step }) },
      })
      await patchTextTaskParams(taskId, { asset_research: result, research_step: 'done' })
      await finishTextTask(taskId, 'completed', {
        outputText: `文字资料 ${result.texts.length} 条，图像候选 ${result.candidates.length} 张`,
      })
      logTaskSuccess('AssetResearch', 'run', { taskId, texts: result.texts.length, candidates: result.candidates.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logTaskError('AssetResearch', 'run', { taskId, error: message })
      await finishTextTask(taskId, 'failed', { errorMsg: `资料检索失败：${message}`, error: err })
    }
  })
  return taskId
}

export interface AssetResearchStatus {
  status: 'none' | 'running' | 'done' | 'error'
  task_id: number | null
  step: string | null
  error: string | null
  finished_at: string | null
  result: AssetResearchResult | null
}

/** 最近一次检索：进行中的优先；结果取最近一次成功的 */
export async function getAssetResearch(kind: ResearchAssetKind, id: number): Promise<AssetResearchStatus> {
  const rows = await researchRows(kind, id)
  const latest = rows[0]
  if (!latest) return { status: 'none', task_id: null, step: null, error: null, finished_at: null, result: null }
  const lastDone = rows.find(row => row.status === 'completed')
  const params = parseTextTaskParams(latest.params)
  return {
    status: textTaskOutcome(latest.status),
    task_id: latest.id,
    step: typeof params?.research_step === 'string' ? params.research_step : null,
    error: latest.status === 'failed' ? latest.errorMsg ?? null : null,
    finished_at: lastDone?.completedAt ?? null,
    result: (parseTextTaskParams(lastDone?.params)?.asset_research as AssetResearchResult | undefined) ?? null,
  }
}
