import { runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-autoretry.js'

/**
 * Poster AI 构想（Issue #72）：只用 AI 改写/拆分后的剧本 + 本集资产描述，
 * 一次产出三个有实质差异的构图方案（中心思想、选中资产、画面 prompt、文字描述、
 * 海报文案、文字图层规划），推荐项仅供参考。
 *
 * 本文件不写当前编辑字段：构想结果只落 `episode_posters.concept`，
 * 应用方案必须走 `POST /poster/concept/apply`（provenance 保护在 posters.ts）。
 */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getContentLanguage } from './app-settings.js'
import { loadEpisodeAssets, parseMentions } from './storyboard-assets.js'
import { parseStylingVersion } from './styling-version.js'
import { resolveStageModel, type StageModel } from './ai-stages.js'
import { normalizeLayerDoc, LAYER_VARIABLES, type LayerVariable } from './layer-doc.js'
import { QWEN_MAX_REFS } from './adapters/qwen-jobs-client.js'
import { callTextChat } from './vision-chat.js'
import {
  createTextTask,
  findActiveTextTask,
  finishTextTask,
  patchTextTaskParams,
  updateTextTaskProgress,
} from './text-task.js'
import { loadPosterContext, ensurePosterRow, parseJsonObject, normalizeProvenance, type PosterContext } from './poster-store.js'
import { getDramaStylePrompt } from './style-preset.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export const POSTER_CONCEPT_VERSION = 1
/** 三个方案是用户确认的硬要求（Q11） */
export const POSTER_CONCEPT_COUNT = 3
/** 剧本超过这个长度才分批提炼，先不静默截断。 */
const SCRIPT_BUDGET_CHARS = 24_000
const SCRIPT_CHUNK_CHARS = 8_000
const CONCEPT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16_384)
const CONCEPT_TIMEOUT_MS = 15 * 60_000

const KIND_LABEL: Record<string, string> = { character: '角色', scene: '场景', prop: '道具' }

const clipped = (max: number, fallback = '') =>
  z.preprocess(value => (typeof value === 'string' ? value.slice(0, max).trim() || fallback : fallback), z.string())

const bounded = (min: number, max: number, fallback: number) =>
  z.preprocess(value => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }, z.number())

const copySchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : {}),
  z.object({
    title: clipped(80),
    subtitle: clipped(120),
    era: clipped(60),
    place: clipped(80),
    notes: z.preprocess(
      value => (Array.isArray(value) ? value.slice(0, 12) : []),
      z.array(clipped(120)),
    ),
  }),
)

const assetSchema = z.object({
  kind: z.preprocess(value => (['character', 'scene', 'prop'].includes(String(value)) ? value : ''), z.string()),
  id: bounded(1, Number.MAX_SAFE_INTEGER, 0),
  name: clipped(60),
  role_in_poster: clipped(120),
  reason: clipped(400),
  // 方案应用时的不可变参考快照（Issue #72）：资产后续换图不能悄悄改变已生成的候选
  path: clipped(512),
  version_task_id: z.preprocess(
    value => (Number.isSafeInteger(value) && Number(value) > 0 ? value : null),
    z.number().nullable(),
  ),
})

const planItemSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : {}),
  z.object({
    type: z.preprocess(v => (v === 'card' ? 'card' : 'label'), z.enum(['label', 'card'])),
    name: clipped(60, '文字'),
    box: z.preprocess(
      value => (value && typeof value === 'object' ? value : {}),
      z.object({
        x: bounded(0, 1, 0.08),
        y: bounded(0, 1, 0.08),
        w: bounded(0.005, 2, 0.4),
        h: bounded(0.005, 2, 0.1),
      }),
    ),
    text: clipped(400),
    variable: z.preprocess(
      v => (typeof v === 'string' && (LAYER_VARIABLES as readonly string[]).includes(v) ? v : undefined),
      z.string().optional(),
    ),
    template: z.preprocess(v => (['name', 'year', 'chapter'].includes(String(v)) ? v : 'name'), z.enum(['name', 'year', 'chapter'])),
    fields: z.preprocess(
      value => (value && typeof value === 'object' ? value : {}),
      z.object({
        title: clipped(60),
        sub: clipped(60),
        meta: clipped(60),
        years: clipped(60),
      }),
    ),
    style: z.preprocess(value => (value && typeof value === 'object' ? value : {}), z.record(z.string(), z.unknown())),
  }).nullable(),
)

const compositionSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : null),
  z.object({
    id: clipped(48),
    approach: clipped(80),
    rationale: clipped(600),
    recommended: z.preprocess(v => v === true, z.boolean()),
    assets: z.preprocess(value => (Array.isArray(value) ? value.slice(0, QWEN_MAX_REFS) : []), z.array(assetSchema)),
    image_prompt: clipped(2000),
    text_description: clipped(1000),
    copy: copySchema,
    layer_plan: z.preprocess(value => (Array.isArray(value) ? value.slice(0, 24) : []), z.array(planItemSchema)),
  }).nullable(),
)

const conceptSchema = z.object({
  theme: clipped(300),
  theme_reason: clipped(600),
  compositions: z.preprocess(value => (Array.isArray(value) ? value : []), z.array(compositionSchema)),
})

export interface PosterCopy {
  title: string
  subtitle: string
  era: string
  place: string
  notes: string[]
}

export interface PosterAssetSnapshot {
  kind: 'character' | 'scene' | 'prop'
  id: number
  name: string
  role_in_poster: string
  reason: string
  path: string
  version_task_id: number | null
}

export interface PosterLayerPlanItem {
  type: 'label' | 'card'
  name: string
  box: { x: number; y: number; w: number; h: number }
  text: string
  variable?: LayerVariable
  template: 'name' | 'year' | 'chapter'
  fields: { title: string; sub: string; meta: string; years: string }
  style: Record<string, unknown>
}

export interface PosterComposition {
  id: string
  approach: string
  rationale: string
  recommended: boolean
  assets: PosterAssetSnapshot[]
  image_prompt: string
  text_description: string
  copy: PosterCopy
  layer_plan: PosterLayerPlanItem[]
}

export interface PosterConcept {
  version: number
  theme: string
  theme_reason: string
  compositions: PosterComposition[]
  selected_composition_id: string | null
  model: string
  config_id: number | null
  generated_at: string
  script_segments_used: number
}

export interface PosterConceptAsset {
  kind: 'character' | 'scene' | 'prop'
  id: number
  name: string
  description: string
  path: string
  version_task_id: number | null
  has_image: boolean
}

// ─── 纯函数 ────────────────────────────────────────────────────────

/**
 * AI 改写稿可能保留“原始材料/永久链接/原作者/许可/说明”出处块（`说明：` 明确声明不作朗读稿）。
 * 只在首行以 `原始材料：` 开头时剔除到 `说明：` 行为止，然后从第一个 `【` 起保留正文；
 * 不用通用正则删 URL/许可字样，避免误删正文。
 */
export function stripProvenanceBlock(script: string | null | undefined): string {
  const raw = String(script || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  const lines = raw.split('\n')
  const first = lines.findIndex(line => line.trim())
  if (first < 0) return ''
  if (!/^原始材料\s*[：:]/.test(lines[first].trim())) return raw
  let cut = -1
  for (let i = first; i < lines.length; i++) {
    if (/^说明\s*[：:]/.test(lines[i].trim())) { cut = i; break }
  }
  if (cut < 0) return raw
  const body = lines.slice(cut + 1).join('\n').trim()
  const start = body.indexOf('【')
  return start >= 0 ? body.slice(start).trim() : body
}

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象')
  return JSON.parse(text.slice(start, end + 1))
}

function assetKey(kind: string, id: number): string {
  return `${kind}:${id}`
}

/** 资产引用校验：只能选本集有图的资产；同名不得同时进入参考集；prompt 必须 @ 到每个被选资产。 */
export function validateComposition(
  raw: PosterComposition,
  assets: PosterConceptAsset[],
): { errors: string[]; composition: PosterComposition | null } {
  const byKey = new Map(assets.map(asset => [assetKey(asset.kind, asset.id), asset]))
  const errors: string[] = []
  const seenNames = new Set<string>()
  const selected: PosterAssetSnapshot[] = []
  for (const item of raw.assets) {
    const asset = byKey.get(assetKey(item.kind, item.id))
    if (!asset) { errors.push(`资产「${item.name || item.kind + '#' + item.id}」不属于本集`); continue }
    if (!asset.has_image) { errors.push(`资产「${asset.name}」没有可用图片，不能作为参考图`); continue }
    if (seenNames.has(asset.name)) { errors.push(`同名资产「${asset.name}」不能同时进入参考集`); continue }
    seenNames.add(asset.name)
    selected.push({
      kind: asset.kind,
      id: asset.id,
      name: asset.name,
      role_in_poster: item.role_in_poster,
      reason: item.reason,
      path: asset.path,
      version_task_id: asset.version_task_id,
    })
  }
  if (!selected.length) errors.push('至少要选择一只有图的资产')
  const names = selected.map(item => item.name)
  const mentions = parseMentions(raw.image_prompt, names)
  for (const unknown of mentions.unknown) errors.push(`画面 prompt 引用了未选中的资产「@${unknown}」`)
  for (const name of names) {
    if (!mentions.matched.includes(name)) errors.push(`画面 prompt 没有用 @${name} 引用所选资产`)
  }
  return {
    errors,
    composition: errors.length ? null : { ...raw, assets: selected },
  }
}

/** 构想 → 文字图层（只产 label/card；id 固定 `ai:` 前缀，重复应用可原位替换）。 */
export function compositionToLayers(composition: PosterComposition, base: { width: number; height: number }) {
  const layers = composition.layer_plan.map((item, index) => {
    const slug = (item.name || item.type).replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 40) || `layer-${index + 1}`
    const common = {
      id: `ai:${slug}`,
      type: item.type,
      name: item.name,
      visible: true,
      locked: false,
      z: index,
      opacity: 1,
      rotation: 0,
      box: item.box,
      style: item.style,
    }
    if (item.type === 'label') {
      return { ...common, text: item.text, ...(item.variable ? { variable: item.variable } : {}) }
    }
    return { ...common, template: item.template, fields: item.fields }
  })
  return normalizeLayerDoc({ base: { ...base, path: '' }, theme: 'archival', layers }).layers
}

export function parsePosterConcept(raw: unknown): PosterConcept | null {
  const source = parseJsonObject(raw)
  if (!source || !Array.isArray(source.compositions)) return null
  const compositions: PosterComposition[] = []
  for (const item of source.compositions) {
    const parsed = compositionSchema.safeParse(item)
    if (parsed.success && parsed.data) compositions.push(parsed.data as PosterComposition)
  }
  if (!compositions.length) return null
  return {
    version: POSTER_CONCEPT_VERSION,
    theme: String(source.theme || ''),
    theme_reason: String(source.theme_reason || ''),
    compositions,
    selected_composition_id: typeof source.selected_composition_id === 'string' ? source.selected_composition_id : null,
    model: String(source.model || ''),
    config_id: Number.isInteger(source.config_id) ? Number(source.config_id) : null,
    generated_at: String(source.generated_at || ''),
    script_segments_used: Number(source.script_segments_used) || 0,
  }
}

export function compositionOf(concept: PosterConcept | null, compositionId: unknown): PosterComposition | null {
  if (!concept) return null
  const id = String(compositionId || '')
  return concept.compositions.find(item => item.id === id) || null
}

// ─── 输入装载 ──────────────────────────────────────────────────────

async function loadConceptAssets(episodeId: number): Promise<PosterConceptAsset[]> {
  const entries = await loadEpisodeAssets(episodeId)
  const links = await db.select().from(schema.episodeCharacters)
  const chars = await db.select().from(schema.characters)
  const scenes = await db.select().from(schema.scenes)
  const props = await db.select().from(schema.props)
  const charById = new Map(chars.map(row => [row.id, row]))
  const sceneById = new Map(scenes.map(row => [row.id, row]))
  const propById = new Map(props.map(row => [row.id, row]))
  const styling = new Map(links.map(link => [link.characterId, parseStylingVersion(link.stylingVersion)]))

  const tasks = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'image'),
    eq(schema.sysTask.status, 'completed'),
  ))
  const versionOf = (kind: string, id: number, image: string): number | null => {
    const matching = tasks.filter(task => task.localPath === image && (
      kind === 'character' ? task.characterId === id : kind === 'scene' ? task.sceneId === id : task.propId === id
    ))
    return matching.length ? Math.max(...matching.map(task => task.id)) : null
  }

  return entries.map(entry => {
    let description = ''
    if (entry.kind === 'character') {
      const row = charById.get(entry.id)
      const version = styling.get(entry.id)
      description = [
        row?.role && `角色：${row.role}`,
        row?.description && `描述：${row.description}`,
        row?.appearance && `外貌：${row.appearance}`,
        row?.styling && `造型：${row.styling}`,
        row?.finalPrompt && `造型提示词：${row.finalPrompt}`,
        version?.name && `本集造型：${version.name}`,
        version?.description && `本集造型描述：${version.description}`,
      ].filter(Boolean).join('\n')
    } else if (entry.kind === 'scene') {
      const row = sceneById.get(entry.id)
      description = [
        `地点：${row?.location || entry.name}`,
        row?.time && `时间：${row.time}`,
        row?.lighting && `光线：${row.lighting}`,
        row?.prompt && `场景描述：${row.prompt}`,
        row?.finalPrompt && `场景提示词：${row.finalPrompt}`,
        row?.exposition ? '（背景信息载体）' : '',
      ].filter(Boolean).join('\n')
    } else {
      const row = propById.get(entry.id)
      description = [
        row?.type && `类型：${row.type}`,
        row?.description && `描述：${row.description}`,
        row?.prompt && `道具描述：${row.prompt}`,
        row?.finalPrompt && `道具提示词：${row.finalPrompt}`,
        row?.faithful ? '（证据素材/原件）' : '',
        row?.exposition ? '（背景信息载体）' : '',
      ].filter(Boolean).join('\n')
    }
    return {
      kind: entry.kind,
      id: entry.id,
      name: entry.name,
      description: description.slice(0, 1600),
      path: entry.defaultImage,
      has_image: Boolean(entry.defaultImage),
      version_task_id: entry.defaultImage ? versionOf(entry.kind, entry.id, entry.defaultImage) : null,
    }
  })
}

function assetLines(assets: PosterConceptAsset[]): string {
  return assets.map(asset => {
    const head = `- ${asset.name}（${KIND_LABEL[asset.kind]} #${asset.id}${asset.has_image ? '' : ' · 无图，不能作参考'}）`
    return asset.description ? `${head}\n${asset.description}` : head
  }).join('\n')
}

function systemPrompt(lang: string): string {
  const language = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }[lang] || '中文'
  return [
    '你是一名纪录片/剧情片海报美术指导。只输出一个 JSON 对象，不要 Markdown、不要解释。',
    `除 image_prompt 固定用中文外，其余文字用${language}。`,
    '任务：从本集剧本提炼中心思想，并从本集资产里选出最贴近中心思想、且**有图**的场景/道具/人物，构思三套有实质差异的海报构图。',
    '三套方案必须覆盖不同角度，例如：多时代蒙太奇/时间轴式拼接；重点场景 + 多人物群像与姿态；关键物件特写 + 人物/场景。示例不是固定模板。',
    'JSON 结构：',
    '{"theme":"中心思想一句话","theme_reason":"依据","compositions":[{"id":"c1","approach":"构图角度","rationale":"为什么","recommended":true,"assets":[{"kind":"scene|character|prop","id":数字,"name":"资产名","role_in_poster":"在画面里承担什么","reason":"选择理由"}],"image_prompt":"中文画面提示词","text_description":"排版/文字描述","copy":{"title":"主标题","subtitle":"副标题","era":"年代","place":"地点","notes":["关键标注"]},"layer_plan":[{"type":"label|card","name":"图层名","box":{"x":0.1,"y":0.1,"w":0.4,"h":0.1},"text":"文字","variable":"project_title|episode_title|episode_no(可选)","template":"name|year|chapter(card 用)","fields":{"title":"","sub":"","meta":"","years":""},"style":{"font":"sans|serif|kai|hand","size":0.05,"color":"#ffffff","align":"left|center|right","bold":false,"italic":false,"stroke":"#000000","stroke_width":0.004,"shadow":true,"bg":"#000000","bg_opacity":0,"accent":"#c0472e","scale":1}}]}]}',
    '硬规则：',
    '1. compositions 必须是三个；recommended 只能有一个为 true。',
    '2. assets 只能从输入的「本集资产」里按 kind + id 选择，且必须有图；不要选没有图的资产。',
    '3. image_prompt 必须逐个用 @资产名 引用所选资产（名字逐字照抄）；不得引用未选资产；不得虚构资产未描述的外形、衣着、颜色。姿态、相对位置、构图、光线、时代氛围可以写。',
    '4. **image_prompt 不得包含任何文字/字母/标语/标题**：底图不带字。文字描述 text_description 与海报文案 copy 只用于图层与二次生成，不能进入 image_prompt。',
    '5. layer_plan 只产文字层（label/card），不产图片层或几何层。位置只是构图建议，用户会再拖动。',
    '6. 蒙太奇/多节点组合是允许且鼓励的；每个方案都要说明它如何表现本集重心。',
    '7. 不要输出与资产无关的泛泛描述：prompt 必须落到具体场景、人物、道具。',
  ].join('\n')
}

function conceptUserPrompt(args: {
  drama: string
  episode: string
  episodeNo: string
  projectType: string
  style: string
  aspect: string
  script: string
  assets: PosterConceptAsset[]
  summarized: boolean
}): string {
  return [
    `# 项目\n${args.drama}（${args.projectType === 'documentary' ? '纪录片' : '剧情片'} · 画幅 ${args.aspect}）`,
    args.style ? `项目风格词：${args.style}` : '',
    '',
    `# 本集\n${args.episodeNo} ${args.episode}`,
    '',
    '# 剧本（AI 改写/拆分稿）',
    args.script,
    '',
    args.summarized ? '（剧本过长，已按段落分批提炼；以上是覆盖全篇的中心思想与关键节点摘要）' : '',
    '',
    `# 本集资产（只能从这里选择，共 ${args.assets.length} 项）`,
    assetLines(args.assets),
    '',
    '请输出 JSON。',
  ].filter(line => line !== '').join('\n')
}

function summarizeChunksPrompt(chunks: string[], lang: string): string {
  const language = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }[lang] || '中文'
  return [
    `你是纪录片资料整理助手。下面是一部片子按顺序切分的 ${chunks.length} 段剧本。`,
    '请逐段提炼：本段中心思想、关键历史节点、具体人物/地点/年代、可用于海报的视觉母题。',
    `用${language}输出纯文本，按「第 N 段」分段；保留专名与年份的原写法，不要编造。`,
    ...chunks.map((chunk, index) => `\n第 ${index + 1} 段：\n${chunk}`),
  ].join('\n')
}

async function summarizeLongScript(
  script: string,
  stage: StageModel,
  lang: string,
  progress: (done: number, total: number) => Promise<void>,
): Promise<{ text: string; chunks: number }> {
  const paragraphs = script.split(/\n{2,}/)
  const chunks: string[] = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > SCRIPT_CHUNK_CHARS) {
      chunks.push(buffer)
      buffer = ''
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
  }
  if (buffer) chunks.push(buffer)
  const parts: string[] = []
  for (let index = 0; index < chunks.length; index++) {
    const { text } = await callTextChat(stage, `第 ${index + 1} 段：\n${chunks[index]}`, {
      systemPrompt: summarizeChunksPrompt([], lang),
      temperature: 0.2,
      maxTokens: CONCEPT_MAX_TOKENS,
      timeoutMs: CONCEPT_TIMEOUT_MS,
    })
    parts.push(`第 ${index + 1} 段摘要：\n${text}`)
    await progress(index + 1, chunks.length + 1)
    logTaskProgress('PosterConcept', 'chunk', { index: index + 1, total: chunks.length })
  }
  return { text: parts.join('\n\n'), chunks: chunks.length }
}

async function callConcept(args: {
  stage: StageModel
  lang: string
  userPrompt: string
  onFirstResponse: () => void
}): Promise<PosterConcept> {
  const first = await callTextChat(args.stage, args.userPrompt, {
    systemPrompt: systemPrompt(args.lang),
    temperature: 0.4,
    maxTokens: CONCEPT_MAX_TOKENS,
    timeoutMs: CONCEPT_TIMEOUT_MS,
  })
  args.onFirstResponse()
  let reply = first.text
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = conceptSchema.safeParse(extractJsonObject(reply))
      if (!parsed.success) throw new Error(`JSON 结构不符：${parsed.error.issues.slice(0, 6).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}`)
      return parsed.data as unknown as PosterConcept
    } catch (err) {
      if (attempt === 1) throw err
      const message = err instanceof Error ? err.message : String(err)
      reply = (await callTextChat(args.stage, [
        '# 上一次输出（需要修正）',
        reply.slice(0, 8000),
        '',
        '# 问题',
        message,
        '',
        '请只输出修正后的完整 JSON，结构必须与要求一致。',
      ].join('\n'), {
        systemPrompt: systemPrompt(args.lang),
        temperature: 0.2,
        maxTokens: CONCEPT_MAX_TOKENS,
        timeoutMs: CONCEPT_TIMEOUT_MS,
      })).text
    }
  }
  throw new Error('Poster 构想没有产出合法 JSON')
}

// ─── 任务入口 ──────────────────────────────────────────────────────

export interface StartPosterConceptResult {
  started: boolean
  reason?: 'running' | 'empty_script'
  task_id?: number
}

export async function startPosterConcept(
  episodeId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<StartPosterConceptResult> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  if (await findActiveTextTask(episodeId, 'poster_concept', opts.retryOf)) return { started: false, reason: 'running' }
  const script = stripProvenanceBlock(context.episode.scriptContent)
  if (!script) return { started: false, reason: 'empty_script' }
  const assets = await loadConceptAssets(episodeId)
  if (!assets.some(asset => asset.has_image)) return { started: false, reason: 'empty_script' }

  const stage = await resolveStageModel('poster_concept', opts)
  const taskId = await createTextTask({
    kind: 'poster_concept',
    episodeId,
    dramaId: context.drama.id,
    prompt: `Poster 构想：${context.episode.title}`,
    stageModel: stage,
    progress: { completed: 0, total: 1, failed: 0 },
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'poster_concept', args: { episodeId, opts } },
  })
  logTaskStart('PosterConcept', 'run', { episodeId, posterId: poster.id, model: stage.model })

  const lang = await getContentLanguage()
  void runWithTextTask(taskId, () => runPosterConcept({ taskId, episodeId, posterId: poster.id, context, script, assets, stage, lang }))
  return { started: true, task_id: taskId }
}

async function runPosterConcept(args: {
  taskId: number
  episodeId: number
  posterId: number
  context: PosterContext
  script: string
  assets: PosterConceptAsset[]
  stage: StageModel
  lang: string
}): Promise<void> {
  const progress = { completed: 0, total: 1, failed: 0 }
  let firstResponse = false
  try {
    const style = await getDramaStylePrompt(args.context.drama.id)
    let script = args.script
    let segments = 1
    if (script.length > SCRIPT_BUDGET_CHARS) {
      const summarized = await summarizeLongScript(script, args.stage, args.lang, async (done, total) => {
        firstResponse = true
        progress.total = total
        progress.completed = done
        await updateTextTaskProgress(args.taskId, { ...progress })
      })
      script = summarized.text
      segments = summarized.chunks + 1
    }
    const userPrompt = conceptUserPrompt({
      drama: args.context.drama.title,
      episode: args.context.episode.title,
      episodeNo: `EP${String(args.context.episode.episodeNumber || 0).padStart(2, '0')}`,
      projectType: args.context.drama.projectType || 'drama',
      style,
      aspect: args.context.drama.aspectRatio || '16:9',
      script,
      assets: args.assets,
      summarized: segments > 1,
    })
    const parsed = await callConcept({ stage: args.stage, lang: args.lang, userPrompt, onFirstResponse: () => { firstResponse = true } })
    const compositions = parsed.compositions.filter((item): item is PosterComposition => Boolean(item)).slice(0, POSTER_CONCEPT_COUNT)
    const validated: PosterComposition[] = []
    const errors: string[] = []
    for (const composition of compositions) {
      const result = validateComposition(composition, args.assets)
      if (result.composition) validated.push(result.composition)
      else errors.push(`${composition.id || composition.approach}：${result.errors.join('；')}`)
    }
    if (validated.length !== POSTER_CONCEPT_COUNT) {
      throw new Error(`三个构图方案没有全部通过资产校验：${errors.join('；') || '模型返回的方案数量不足'}`)
    }
    // 推荐只能一个；模型没标时按第一个兜底，避免前端出现三个“推荐”
    const recommendedIndex = validated.findIndex(item => item.recommended)
    validated.forEach((item, index) => { item.recommended = index === (recommendedIndex < 0 ? 0 : recommendedIndex) })

    const concept: PosterConcept = {
      version: POSTER_CONCEPT_VERSION,
      theme: parsed.theme,
      theme_reason: parsed.theme_reason,
      compositions: validated,
      selected_composition_id: validated.find(item => item.recommended)?.id || validated[0].id,
      model: args.stage.model,
      config_id: args.stage.configId,
      generated_at: now(),
      script_segments_used: segments,
    }
    // 任务只写 concept；当前编辑字段由显式 apply 写入（provenance 保护）
    const [poster] = await db.select().from(schema.episodePosters).where(eq(schema.episodePosters.id, args.posterId))
    if (poster) {
      const provenance = normalizeProvenance(poster.provenance)
      await db.update(schema.episodePosters).set({
        concept: JSON.stringify(concept),
        conceptUpdatedAt: concept.generated_at,
        provenance: JSON.stringify({ ...provenance, concept: 'ai' }),
        updatedAt: now(),
      }).where(eq(schema.episodePosters.id, args.posterId))
    }
    await patchTextTaskParams(args.taskId, {
      concept_theme: concept.theme,
      concept_compositions: concept.compositions.map(item => ({ id: item.id, approach: item.approach, recommended: item.recommended })),
    })
    await finishTextTask(args.taskId, 'completed', {
      progress: { completed: progress.total, total: progress.total, failed: 0 },
      outputText: JSON.stringify(concept),
    })
    logTaskSuccess('PosterConcept', 'run', { episodeId: args.episodeId, compositions: concept.compositions.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishTextTask(args.taskId, 'failed', {
      errorMsg: `Poster 构想失败：${message}`,
      progress: { ...progress },
    })
    await requeueFirstModelFailure(args.taskId, err, !firstResponse)
    logTaskError('PosterConcept', 'run', { episodeId: args.episodeId, error: message })
  }
}
