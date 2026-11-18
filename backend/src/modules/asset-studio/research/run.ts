/**
 * 资产资料检索任务（Issue #79）：检索计划 → 多来源检索 + 正文摘录 → 著录预筛 → 下载 → 视觉判断角色。
 *
 * 检索状态与结果由 asset_studio_research 持久化；不创建火宝文本任务父行。
 * 候选图只缓存到 static/asset-sources/candidates，人工入库后才成为模块素材。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {stmt} from '../db.js'
import {runObservedWork} from '../../../services/task-observability.js'
import { STORAGE_ROOT } from '../../../utils/paths.js'
import { generateImageThumb } from '../../../utils/storage.js'
import { logTaskWarn } from '../../../utils/task-logger.js'
import { resolveStageModel, type StageModel } from '../../../services/ai-stages.js'
import { callTextChat, imageContentPart, type ChatContent } from '../../../services/vision-chat.js'
import { parseJsonReply } from '../prompts.js'
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

async function saveCandidate(bytes: Buffer, mime: string): Promise<{ localPath: string; sha256: string }> {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const ext = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/tiff': '.tif' }[mime] ?? '.jpg'
  const dir = path.join(STORAGE_ROOT, CANDIDATE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = `${sha256}${ext}`
  const abs = path.join(dir, file)
  const localPath = `static/${CANDIDATE_DIR}/${file}`
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, bytes)
    // 候选图网格用缩略图（Issue #106）；失败只记日志
    await generateImageThumb(localPath)
  }
  return { localPath, sha256 }
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
    const { localPath, sha256 } = await saveCandidate(file.bytes, file.mime)
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

export class ResearchConflictError extends Error {}
interface ResearchRow {id:number;status:string;step:string;result:string|null;error_msg:string|null;completed_at:string|null}
function researchRows(kind:ResearchAssetKind,id:number){return stmt('SELECT * FROM asset_studio_research WHERE host_ref=? ORDER BY id DESC').all(`${kind}:${id}`) as ResearchRow[]}
export async function startAssetResearch(subject:ResearchSubject,_episodeId:number,opts:{textConfigId?:number}={}):Promise<number>{
 if(researchRows(subject.kind,subject.id).some(r=>r.status==='running'))throw new ResearchConflictError('该资产正在检索资料')
 const ts=new Date().toISOString();const id=Number(stmt("INSERT INTO asset_studio_research (host_ref,status,step,created_at,updated_at) VALUES (?,'running','plan',?,?)").run(`${subject.kind}:${subject.id}`,ts,ts).lastInsertRowid)
 void (async()=>{
  try{
   const result=await runObservedWork({
    taskId:id,scope:'asset_studio_research',stage:'asset_studio',
    sourceChars:subject.description?.length??0,sampleKey:'asset_studio:research',
   },()=>performResearch(subject,{
    ...opts,
    onStep:step=>{stmt('UPDATE asset_studio_research SET step=?,updated_at=? WHERE id=?').run(step,new Date().toISOString(),id)},
   }))
   stmt("UPDATE asset_studio_research SET status='completed',step='done',result=?,updated_at=?,completed_at=? WHERE id=?")
    .run(JSON.stringify(result),new Date().toISOString(),new Date().toISOString(),id)
  }catch(error){
   stmt("UPDATE asset_studio_research SET status='failed',error_msg=?,updated_at=? WHERE id=?")
    .run(error instanceof Error?error.message:String(error),new Date().toISOString(),id)
  }
 })()
 return id
}
export async function getAssetResearch(kind:ResearchAssetKind,id:number){const rows=researchRows(kind,id);const latest=rows[0];const done=rows.find(r=>r.status==='completed');return {status:!latest?'none':latest.status==='completed'?'done':latest.status==='failed'?'error':'running',task_id:latest?.id??null,step:latest?.step??null,error:latest?.error_msg??null,finished_at:done?.completed_at??null,result:done?.result?JSON.parse(done.result) as AssetResearchResult:null}}
