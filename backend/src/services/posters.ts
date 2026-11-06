/**
 * 剧集 Poster（Issue #39 / #72）：每集一份编辑工程 + 生图/排版版本。
 *
 * Issue #72 起：
 * - 编辑工程 = `layer_doc`（与分镜制作同源），旧 `layout` 不再读写；
 * - AI 构想只写 `concept`，应用方案必须显式走 `applyPosterConcept`；
 * - 所有 `initial` 底图注入项目风格词，底图不带字；
 * - `layers` 二次生成的两张参考图由服务端从 LayerDoc 渲染，不再用浏览器 canvas。
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { toSnakeCase } from '../utils/transform.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { generateImage } from './generation.js'
import { isFluxJobsConfig, QWEN_MAX_REFS } from './adapters/qwen-jobs-client.js'
import { KEYFRAME_SIZES } from './storyboard-keyframes.js'
import { getDramaStylePrompt } from './style-preset.js'
import { normalizeLayerDoc, type LayerDoc } from './layer-doc.js'
import { renderLayerDocToFile } from './layer-render.js'
import { resolvedText } from './layer-svg.js'
import { parseMentions } from './storyboard-assets.js'
import { renderRefPrompt } from './task-label.js'
import {
  compositionOf,
  compositionToLayers,
  parsePosterConcept,
  type PosterComposition,
  type PosterConcept,
  type PosterCopy,
} from './poster-concept.js'
import {
  ensurePosterRow,
  loadPosterContext,
  normalizeProvenance,
  parseJsonArray,
  parseJsonObject,
  posterVariablesOf,
  type PosterField,
  type PosterProvenance,
  type PosterRow,
  type PosterVariables,
} from './poster-store.js'

export type PosterGenerationMode = 'initial' | 'composite' | 'layers'

export interface PosterBundle extends Record<string, unknown> {
  variables: PosterVariables
  aspect_ratio: string
  size: string
  versions: Record<string, unknown>[]
}

type VersionRow = typeof schema.posterVersions.$inferSelect

const POSTER_EDITABLE_FIELDS: PosterField[] = ['prompt', 'text_prompt', 'copy']

/**
 * 底图硬约束（Issue #72 用户确认）：海报文字与排版只由图层编辑器完成，
 * 底图提示词必须明确不生成任何文字/字母/数字。方案里的 `image_prompt` 由 AI 写，
 * 这里在提交前统一追加，避免模型自由发挥出「南京条约」这类画面文字。
 */
const POSTER_NO_TEXT_RULE = '画面中不要出现任何文字、字母、数字、标题、标语、印章文字或书籍正文；参考图中的书籍、文件、印章只保留材质、形状与装帧，页面必须留空，不得复制或生成任何文字痕迹；所有文字与排版由后期图层叠加，底图只保留画面。'

export class PosterConflictError extends Error {
  constructor(public readonly fields: string[], message = '有手动编辑，是否需要覆盖？') {
    super(message)
    this.name = 'PosterConflictError'
  }
}

export class PosterNotFoundError extends Error {
  constructor() {
    super('Poster 构想不存在或方案已失效')
    this.name = 'PosterNotFoundError'
  }
}

/** 图片必须已落盘在 static/ 下：拒绝任意服务器路径与远程地址混入 Poster 链路 */
function staticImagePath(value: unknown, label: string): string {
  const relative = String(value || '').trim()
  const root = fs.realpathSync(getAbsolutePath('static/'))
  const absolute = path.resolve(getAbsolutePath(relative))
  if (!relative.startsWith('static/') || !absolute.startsWith(root + path.sep)) throw new Error(`${label}必须是 static/ 本地路径`)
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`${label}文件不存在`)
  if (!fs.realpathSync(absolute).startsWith(root + path.sep) || !/\.(png|jpe?g|webp)$/i.test(relative)) throw new Error(`${label}必须是本地图片`)
  return relative
}

function referencePaths(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const paths = input.map(item => String(item || '').trim()).filter(Boolean)
  if (paths.length > QWEN_MAX_REFS) throw new Error(`参考图最多 ${QWEN_MAX_REFS} 张`)
  return paths.map(item => staticImagePath(item, '参考图'))
}

function normalizeCopy(raw: unknown): PosterCopy {
  const source = parseJsonObject(raw) || {}
  const notes = Array.isArray(source.notes) ? source.notes.map(item => String(item || '').trim()).filter(Boolean) : []
  return {
    title: String(source.title || '').trim(),
    subtitle: String(source.subtitle || '').trim(),
    era: String(source.era || '').trim(),
    place: String(source.place || '').trim(),
    notes,
  }
}

/** 可见文字层 + 文案 → 二次生成的文字说明（变量已现场解析）。 */
export function buildPosterTextInstruction(doc: LayerDoc, variables: PosterVariables, copy: PosterCopy): string {
  const texts: string[] = []
  for (const layer of doc.layers) {
    if (!layer.visible) continue
    if (layer.type === 'label' || layer.type === 'marker') {
      const value = resolvedText(layer, variables).trim()
      if (value) texts.push(value)
    }
    if (layer.type === 'card') {
      for (const value of [layer.fields.title, layer.fields.sub, layer.fields.meta, layer.fields.years]) {
        if (value.trim()) texts.push(value.trim())
      }
    }
  }
  for (const value of [copy.title, copy.subtitle, copy.era, copy.place, ...copy.notes]) {
    if (value.trim() && !texts.includes(value.trim())) texts.push(value.trim())
  }
  if (!texts.length) return ''
  return [
    'The poster contains the following text elements. Render them exactly as written, keep every character and punctuation unchanged, do not translate, and do not invent any additional text:',
    ...texts.map(value => `- ${JSON.stringify(value)}`),
  ].join('\n')
}

function serializeVersion(row: VersionRow, taskStatus?: { status: string | null; error: string | null }): Record<string, unknown> {
  return {
    ...toSnakeCase(row),
    layer_doc: parseJsonObject(row.layerDoc) ? normalizeLayerDoc(parseJsonObject(row.layerDoc)) : null,
    reference_images: parseJsonArray(row.referenceImages),
    task_status: taskStatus?.status || null,
    error_msg: taskStatus?.error || null,
  }
}

async function versionsOf(posterId: number): Promise<VersionRow[]> {
  const rows = await db.select().from(schema.posterVersions)
    .where(eq(schema.posterVersions.posterId, posterId))
  return rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id - a.id)
}

async function versionStatuses(rows: VersionRow[]): Promise<Map<number, { status: string | null; error: string | null }>> {
  const ids = rows.map(row => row.sysTaskId).filter((id): id is number => Number.isInteger(id) && !!id)
  if (!ids.length) return new Map()
  const tasks = await db.select().from(schema.sysTask)
  const byId = new Map(tasks.filter(task => ids.includes(task.id)).map(task => [task.id, task]))
  const out = new Map<number, { status: string | null; error: string | null }>()
  for (const row of rows) {
    const task = row.sysTaskId ? byId.get(row.sysTaskId) : undefined
    if (task) out.set(row.id, { status: task.status || null, error: task.errorMsg || null })
  }
  return out
}

/** 组装前端所需的完整 Poster 状态：工程 + 变量 + 画幅 + 版本（新→旧）。 */
export async function getPosterBundle(episodeId: number): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const versions = await versionsOf(poster.id)
  const statuses = await versionStatuses(versions)
  const aspectRatio = String(context.drama.aspectRatio || '16:9')
  const layerDoc = normalizeLayerDoc(parseJsonObject(poster.layerDoc))
  // 空底图也必须有项目画幅：normalizeLayerDoc 的默认 1344×768 只是兜底，不能覆盖 9:16 等项目
  if (!layerDoc.base.path) {
    const [width, height] = String(KEYFRAME_SIZES[aspectRatio] || KEYFRAME_SIZES['16:9']).split('x').map(Number)
    layerDoc.base.width = width || layerDoc.base.width
    layerDoc.base.height = height || layerDoc.base.height
  }
  return {
    ...toSnakeCase(poster),
    layer_doc: layerDoc,
    concept: parsePosterConcept(poster.concept),
    copy: normalizeCopy(poster.copy),
    provenance: normalizeProvenance(poster.provenance),
    reference_images: parseJsonArray(poster.referenceImages),
    variables: posterVariablesOf(context),
    aspect_ratio: aspectRatio,
    size: KEYFRAME_SIZES[aspectRatio] || KEYFRAME_SIZES['16:9']!,
    versions: versions.map(row => serializeVersion(row, statuses.get(row.id))),
  }
}

export interface PosterDraftPatch {
  prompt?: unknown
  text_prompt?: unknown
  copy?: unknown
  reference_images?: unknown
  base_image?: unknown
  layer_doc?: unknown
}

function layerSources(previous: PosterProvenance, before: LayerDoc, after: LayerDoc): Record<string, 'ai' | 'manual'> {
  const oldLayers = new Map(before.layers.map(layer => [layer.id, JSON.stringify(layer)]))
  const sources: Record<string, 'ai' | 'manual'> = {}
  for (const layer of after.layers) {
    const previousSource = previous.layers?.[layer.id]
    if (previousSource === 'ai' && oldLayers.get(layer.id) === JSON.stringify(layer)) sources[layer.id] = 'ai'
    else sources[layer.id] = 'manual'
  }
  return sources
}

/** 保存编辑工程：只校验本次实际写入的字段；人工写入把对应 provenance 标成 manual。 */
export async function savePosterDraft(episodeId: number, patch: PosterDraftPatch): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const provenance = normalizeProvenance(poster.provenance)
  const updates: Partial<typeof schema.episodePosters.$inferInsert> = { updatedAt: now() }
  const nextProvenance: PosterProvenance = { ...provenance }

  if (patch.prompt !== undefined) {
    const value = String(patch.prompt || '').trim().slice(0, 4000)
    updates.prompt = value
    if (value !== String(poster.prompt || '').trim()) nextProvenance.prompt = 'manual'
  }
  if (patch.text_prompt !== undefined) {
    const value = String(patch.text_prompt || '').trim().slice(0, 2000)
    updates.textPrompt = value
    if (value !== String(poster.textPrompt || '').trim()) nextProvenance.text_prompt = 'manual'
  }
  if (patch.copy !== undefined) {
    const value = normalizeCopy(patch.copy)
    updates.copy = JSON.stringify(value)
    if (JSON.stringify(value) !== JSON.stringify(normalizeCopy(poster.copy))) nextProvenance.copy = 'manual'
  }
  if (patch.reference_images !== undefined) {
    updates.referenceImages = JSON.stringify(referencePaths(patch.reference_images))
  }
  if (patch.base_image !== undefined) {
    updates.baseImage = patch.base_image ? staticImagePath(patch.base_image, '底图') : null
  }
  const beforeDoc = normalizeLayerDoc(parseJsonObject(poster.layerDoc))
  if (patch.base_image !== undefined && updates.baseImage) updates.baseImage = staticImagePath(updates.baseImage, '底图')
  if (patch.layer_doc !== undefined) {
    const doc = normalizeLayerDoc(patch.layer_doc)
    const [width, height] = String(KEYFRAME_SIZES[String(context.drama.aspectRatio || '16:9')] || KEYFRAME_SIZES['16:9']).split('x').map(Number)
    if (doc.base.path) {
      doc.base.path = staticImagePath(doc.base.path, '底图')
      // 底图原件像素是裁切与清晰度判定的真源；输出画布始终等于 Poster 画幅。
      const metadata = await sharp(getAbsolutePath(doc.base.path)).metadata()
      if (metadata.width && metadata.height) {
        doc.base.source_width = metadata.width
        doc.base.source_height = metadata.height
      }
    }
    doc.base.width = width || doc.base.width
    doc.base.height = height || doc.base.height
    updates.layerDoc = JSON.stringify(doc)
    // 当前编辑底图以 LayerDoc 为准：否则上传/候选「作为编辑底图」后 base_image 仍旧，
    // 前端 layers 生成按钮会被误判为没有底图。
    updates.baseImage = doc.base.path || null
    if (JSON.stringify(doc) !== JSON.stringify(beforeDoc)) {
      nextProvenance.layer_doc = 'manual'
      nextProvenance.layers = layerSources(nextProvenance, beforeDoc, doc)
    }
  }
  updates.provenance = JSON.stringify(nextProvenance)

  await db.update(schema.episodePosters).set(updates).where(eq(schema.episodePosters.id, poster.id))
  return getPosterBundle(episodeId)
}

// ─── 参考图与 @名字 ────────────────────────────────────────────────

interface ResolvedReferences {
  references: string[]
  nameIndex: Record<string, number>
  namedPaths: string[]
  manualPaths: string[]
}

function selectedComposition(poster: PosterRow): { concept: PosterConcept | null; composition: PosterComposition | null } {
  const concept = parsePosterConcept(poster.concept)
  return { concept, composition: compositionOf(concept, concept?.selected_composition_id) }
}

function namedSnapshots(poster: PosterRow): PosterComposition['assets'] {
  const { composition } = selectedComposition(poster)
  return composition?.assets || []
}

/**
 * 最终参考图 = 命名的 AI 方案资产（按方案顺序，仍存在于 reference_images 的）+ 人工追加的图。
 * 绝对编号按最终列表重算；命名资产相对顺序稳定。`@名字` 只解析命名资产。
 */
export function resolvePosterReferences(
  referenceImages: string[],
  named: PosterComposition['assets'],
): ResolvedReferences {
  const existing = new Set(referenceImages)
  const namedPaths: string[] = []
  for (const asset of named) {
    if (!existing.has(asset.path) || namedPaths.includes(asset.path)) continue
    namedPaths.push(asset.path)
  }
  const manualPaths = referenceImages.filter(item => !namedPaths.includes(item))
  const references = [...namedPaths, ...manualPaths].slice(0, QWEN_MAX_REFS)
  const nameIndex: Record<string, number> = {}
  named.forEach(asset => {
    const index = references.indexOf(asset.path)
    if (index >= 0 && !(asset.name in nameIndex)) nameIndex[asset.name] = index + 1
  })
  return { references, nameIndex, namedPaths, manualPaths }
}

/** 前端提示：哪些 @名字 在最终参考图里没有位置（被删掉/超出上限/模型只会收到前 N 张）。 */
export function unresolvedPosterMentions(prompt: string, nameIndex: Record<string, number>): string[] {
  // `parseMentions` 的原始捕获会带上 `@灵渠，青灰条石…` 里的正文；错误提示只保留名字本身
  return parseMentions(prompt, Object.keys(nameIndex)).unknown
    .map(name => name.match(/^[^\s@，,。；;：:、！!？?（）()]+/)?.[0] || '')
    .filter(Boolean)
}

/** 当前工程的最终参考集（人工生图入口）。 */
export async function posterReferences(episodeId: number): Promise<ResolvedReferences> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  return resolvePosterReferences(parseJsonArray(poster.referenceImages).map(String), namedSnapshots(poster))
}

function compositionReferences(composition: PosterComposition): ResolvedReferences {
  const references = composition.assets.map(asset => staticImagePath(asset.path, `资产「${asset.name}」的图片`))
  const nameIndex: Record<string, number> = {}
  composition.assets.forEach((asset, index) => {
    if (!(asset.name in nameIndex)) nameIndex[asset.name] = index + 1
  })
  return { references, nameIndex, namedPaths: references, manualPaths: [] }
}

function assertMentionsResolved(prompt: string, nameIndex: Record<string, number>): void {
  const unknown = unresolvedPosterMentions(prompt, nameIndex)
  if (unknown.length) {
    throw new Error(`画面 prompt 引用了没有参考图位置的资产：${unknown.map(name => `@${name}`).join('、')}。请恢复这些资产的参考图，或改写 prompt。`)
  }
}

function assertModelReferenceCapacity(prompt: string, resolved: ResolvedReferences, flux: boolean): void {
  if (!flux) return
  const names = Object.keys(resolved.nameIndex).sort((a, b) => resolved.nameIndex[a]! - resolved.nameIndex[b]!)
  const dropped = names.filter(name => resolved.nameIndex[name]! > 1 && prompt.includes(`@${name}`))
  if (dropped.length) {
    throw new Error(`FLUX 只发送第 1 张参考图，prompt 里的 ${dropped.map(name => `@${name}`).join('、')} 不会被发送。请改用支持多参考图的模型（qwen-jobs），或只保留第 1 张并重写 prompt。`)
  }
}

// ─── 生图 ──────────────────────────────────────────────────────────

interface GenerationInput {
  mode?: unknown
  prompt?: unknown
  text_prompt?: unknown
  reference_images?: unknown
  base_image?: unknown
  version_id?: unknown
  config_id?: unknown
  model?: unknown
  composition_id?: unknown
}

async function resolveImageConfig(episodeId: number, body: GenerationInput, fallbackConfigId?: number | null) {
  const configId = Number(body.config_id || fallbackConfigId || 0) || undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('image') : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')
  return config
}

async function submitPosterImage(args: {
  episodeId: number
  dramaId: number
  posterId: number
  mode: PosterGenerationMode
  prompt: string
  sourcePrompt: string
  refNameIndex: Record<string, number>
  references: string[]
  size: string
  configId?: number
  model?: string
  textPrompt: string
  compositionId?: string | null
  autoBase?: boolean
}): Promise<number> {
  return generateImage({
    episodeId: args.episodeId,
    dramaId: args.dramaId,
    prompt: args.prompt,
    size: args.size,
    referenceImages: args.references.length ? args.references : undefined,
    configId: args.configId,
    model: args.model,
    sourcePrompt: args.sourcePrompt,
    refNameIndex: args.refNameIndex,
    posterId: args.posterId,
    posterGenMode: args.mode,
    posterTextPrompt: args.textPrompt,
    posterConceptComposition: args.compositionId || undefined,
    posterAutoBase: args.autoBase === true,
    posterSize: args.size,
  })
}

/**
 * 提交 Poster 生图：
 * - initial：当前工程 prompt + 最终参考图（人工入口），或某个 AI 方案冻结的快照；
 * - composite：当前/指定合成版本图作为唯一参考；
 * - layers：服务端渲染的底图 + 透明文字图层两张参考（FLUX 不支持）。
 * 所有 initial 都前置项目风格词；底图 prompt 不带文字/文案。
 */
export async function createPosterGeneration(
  episodeId: number,
  body: GenerationInput,
): Promise<{ task_id: number; mode: PosterGenerationMode; prompt: string; references: string[] }> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const vars = posterVariablesOf(context)
  const mode = String(body.mode || 'initial') as PosterGenerationMode
  if (!['initial', 'composite', 'layers'].includes(mode)) throw new Error('mode 必须是 initial / composite / layers')

  if (body.prompt !== undefined || body.text_prompt !== undefined) {
    await savePosterDraft(episodeId, {
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.text_prompt !== undefined ? { text_prompt: body.text_prompt } : {}),
    })
  }
  const saved = await ensurePosterRow(context)
  const size = KEYFRAME_SIZES[String(context.drama.aspectRatio || '16:9')] || KEYFRAME_SIZES['16:9']!
  const style = await getDramaStylePrompt(context.drama.id)
  const copy = normalizeCopy(saved.copy)
  const config = await resolveImageConfig(episodeId, body, context.episode.imageConfigId)
  const model = typeof body.model === 'string' ? body.model : undefined
  const textPrompt = String(saved.textPrompt || '').trim()

  if (mode === 'composite') {
    const requestedId = Number(body.version_id || saved.selectedVersionId || 0)
    const versions = await versionsOf(poster.id)
    const version = versions.find(row => row.id === requestedId && row.kind === 'composite')
    if (!version?.image) throw new Error('请先保存合成图，或用当前最终版本作为参考')
    const references = [staticImagePath(version.image, '合成图')]
    const instruction = buildPosterTextInstruction(normalizeLayerDoc(parseJsonObject(saved.layerDoc)), vars, copy)
    const finalPrompt = [String(saved.prompt || '').trim(), textPrompt, instruction].filter(Boolean).join('\n\n')
    if (!finalPrompt.trim()) throw new Error('请填写画面 prompt 或针对文字的描述')
    const taskId = await submitPosterImage({
      episodeId, dramaId: context.drama.id, posterId: poster.id, mode,
      prompt: finalPrompt, sourcePrompt: finalPrompt, refNameIndex: {}, references, size,
      configId: config.id ?? undefined, model, textPrompt,
    })
    return { task_id: taskId, mode, prompt: finalPrompt, references }
  }

  if (mode === 'layers') {
    if (isFluxJobsConfig({ ...config, model: model || config.model })) {
      throw new Error('FLUX 不支持底图＋文字图层的双参考图模式，请改用合成图再生成')
    }
    const doc = normalizeLayerDoc(parseJsonObject(saved.layerDoc))
    if (!doc.base.path) throw new Error('请先生成或选择底图')
    if (!doc.layers.some(layer => layer.visible)) throw new Error('请先添加至少一个可见文字图层')
    const base = await renderLayerDocToFile({
      ...doc,
      layers: [],
      base: { ...doc.base },
    }, { width: doc.base.width, height: doc.base.height, variables: vars })
    const overlay = await renderLayerDocToFile(doc, {
      width: doc.base.width, height: doc.base.height, variables: vars, transparent: true,
    })
    const instruction = buildPosterTextInstruction(doc, vars, copy)
    const finalPrompt = [String(saved.prompt || '').trim(), textPrompt, instruction].filter(Boolean).join('\n\n')
    if (!finalPrompt.trim()) throw new Error('请填写画面 prompt 或针对文字的描述')
    const references = [base.url, overlay.url]
    const taskId = await submitPosterImage({
      episodeId, dramaId: context.drama.id, posterId: poster.id, mode,
      prompt: finalPrompt, sourcePrompt: finalPrompt, refNameIndex: {}, references, size,
      configId: config.id ?? undefined, model, textPrompt,
    })
    return { task_id: taskId, mode, prompt: finalPrompt, references }
  }

  // initial：AI 方案快照优先（一步按钮/方案生图），否则用当前工程 prompt + 最终参考集
  const composition = compositionOf(parsePosterConcept(saved.concept), body.composition_id)
  if (body.composition_id && !composition) throw new PosterNotFoundError()
  const basePrompt = composition ? composition.image_prompt : String(saved.prompt || '').trim()
  if (!basePrompt) throw new Error('请填写画面 prompt，或先生成 AI 构想')
  const resolved = composition
    ? compositionReferences(composition)
    : resolvePosterReferences(parseJsonArray(saved.referenceImages).map(String), namedSnapshots(poster))
  assertMentionsResolved(basePrompt, resolved.nameIndex)
  assertModelReferenceCapacity(basePrompt, resolved, isFluxJobsConfig({ ...config, model: model || config.model }))
  const sourcePrompt = [style, basePrompt, POSTER_NO_TEXT_RULE].filter(Boolean).join('\n\n')
  const provider = config.provider || ''
  const finalPrompt = renderRefPrompt(sourcePrompt, resolved.nameIndex, { type: 'image', provider })
  const taskId = await submitPosterImage({
    episodeId, dramaId: context.drama.id, posterId: poster.id, mode,
    prompt: finalPrompt, sourcePrompt, refNameIndex: resolved.nameIndex,
    references: resolved.references, size,
    configId: config.id, model, textPrompt: composition?.text_description || textPrompt,
    compositionId: composition?.id || null,
    // 无底图时只让推荐方案成功图自动成为临时编辑底图；其他候选不能抢占
    autoBase: composition ? composition.recommended : false,
  })
  return { task_id: taskId, mode, prompt: finalPrompt, references: resolved.references }
}

// ─── AI 构想：三案生图 ────────────────────────────────────────────

export interface CompositionGenerationItem {
  composition_id: string
  task_id?: number
  error?: string
}

/** 为每个构图方案各提交一张冻结快照的 initial 底图；不读当前编辑字段，也不改它们。 */
export async function generateConceptCompositions(
  episodeId: number,
  body: { composition_ids?: unknown; config_id?: unknown; model?: unknown },
): Promise<CompositionGenerationItem[]> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const concept = parsePosterConcept(poster.concept)
  if (!concept) throw new PosterNotFoundError()
  const requested = Array.isArray(body.composition_ids)
    ? body.composition_ids.map(String)
    : concept.compositions.map(item => item.id)
  const items: CompositionGenerationItem[] = []
  for (const compositionId of requested) {
    const composition = compositionOf(concept, compositionId)
    if (!composition) { items.push({ composition_id: compositionId, error: '方案不存在' }); continue }
    try {
      const result = await createPosterGeneration(episodeId, {
        mode: 'initial',
        composition_id: compositionId,
        config_id: body.config_id,
        model: body.model,
      })
      items.push({ composition_id: compositionId, task_id: result.task_id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      items.push({ composition_id: compositionId, error: message })
    }
  }
  return items
}

// ─── 方案应用（provenance 保护） ──────────────────────────────────

export interface ApplyConceptInput {
  composition_id?: unknown
  fields?: unknown
  overwrite?: unknown
}

/** 应用方案字段：手动字段默认 409；overwrite 才替换并重置为 ai。 */
export async function applyPosterConcept(
  episodeId: number,
  body: ApplyConceptInput,
): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const concept = parsePosterConcept(poster.concept)
  const composition = compositionOf(concept, body.composition_id)
  if (!concept || !composition) throw new PosterNotFoundError()
  const requested = Array.isArray(body.fields) ? body.fields.map(String) : POSTER_EDITABLE_FIELDS
  const fields = requested.filter((field): field is PosterField => POSTER_EDITABLE_FIELDS.includes(field as PosterField))
  if (!fields.length) throw new Error('没有可应用的字段')
  const provenance = normalizeProvenance(poster.provenance)
  const overwrite = body.overwrite === true
  const conflicts = overwrite ? [] : fields.filter(field => provenance[field] === 'manual')
  if (conflicts.length) throw new PosterConflictError(conflicts)

  const updates: Partial<typeof schema.episodePosters.$inferInsert> = { updatedAt: now() }
  const nextProvenance: PosterProvenance = { ...provenance }
  if (fields.includes('prompt')) {
    updates.prompt = composition.image_prompt
    nextProvenance.prompt = 'ai'
  }
  if (fields.includes('text_prompt')) {
    updates.textPrompt = composition.text_description
    nextProvenance.text_prompt = 'ai'
  }
  if (fields.includes('copy')) {
    updates.copy = JSON.stringify(composition.copy)
    nextProvenance.copy = 'ai'
  }
  // 命名参考图随方案更新；人工追加的图保留在命名资产之后
  const missingPath = composition.assets.find(asset => !asset.path)
  if (missingPath) throw new Error(`方案资产「${missingPath.name}」缺少图片快照路径，请重新生成构想`)
  const currentRefs = parseJsonArray(poster.referenceImages).map(String)
  const previousNamed = new Set(namedSnapshots(poster).map(asset => asset.path))
  const manual = currentRefs.filter(item => !previousNamed.has(item))
  const refs = [...composition.assets.map(asset => asset.path), ...manual]
  updates.referenceImages = JSON.stringify(Array.from(new Set(refs)).slice(0, QWEN_MAX_REFS))
  updates.provenance = JSON.stringify(nextProvenance)
  const nextConcept: PosterConcept = { ...concept, selected_composition_id: composition.id, model: concept.model, config_id: concept.config_id }
  updates.concept = JSON.stringify(nextConcept)

  await db.update(schema.episodePosters).set(updates).where(eq(schema.episodePosters.id, poster.id))
  return getPosterBundle(episodeId)
}

/** 只应用 AI 文字层：替换 `ai:` 层，保留固定变量层与人工层；重复应用不重复文字。 */
export async function applyPosterLayerPlan(
  episodeId: number,
  body: { composition_id?: unknown; overwrite?: unknown },
): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const concept = parsePosterConcept(poster.concept)
  const composition = compositionOf(concept, body.composition_id)
  if (!concept || !composition) throw new PosterNotFoundError()
  const provenance = normalizeProvenance(poster.provenance)
  const doc = normalizeLayerDoc(parseJsonObject(poster.layerDoc))
  const manualAiLayers = Object.entries(provenance.layers || {})
    .filter(([id, source]) => id.startsWith('ai:') && source === 'manual')
    .map(([id]) => id)
  const conflict = body.overwrite !== true && (provenance.layer_doc === 'manual' || manualAiLayers.length > 0)
  if (conflict) throw new PosterConflictError(['layer_doc'], '图层有手动编辑，是否需要覆盖 AI 图层？')

  const base = { width: doc.base.width, height: doc.base.height }
  const aiLayers = compositionToLayers(composition, base)
  const retained = doc.layers.filter(layer => !layer.id.startsWith('ai:'))
  const layers = [...retained, ...aiLayers.map((layer, index) => ({ ...layer, z: retained.length + index }))]
  const nextDoc: LayerDoc = normalizeLayerDoc({ ...doc, layers })
  const nextLayers: Record<string, 'ai' | 'manual'> = { ...(provenance.layers || {}) }
  for (const id of Object.keys(nextLayers)) if (!nextDoc.layers.some(layer => layer.id === id)) delete nextLayers[id]
  for (const layer of aiLayers) nextLayers[layer.id] = 'ai'
  const nextProvenance: PosterProvenance = { ...provenance, layer_doc: 'ai', layers: nextLayers }
  const nextConcept: PosterConcept = { ...concept, selected_composition_id: composition.id }
  await db.update(schema.episodePosters).set({
    layerDoc: JSON.stringify(nextDoc),
    provenance: JSON.stringify(nextProvenance),
    concept: JSON.stringify(nextConcept),
    updatedAt: now(),
  }).where(eq(schema.episodePosters.id, poster.id))
  return getPosterBundle(episodeId)
}

// ─── 合成版本 ──────────────────────────────────────────────────────

export interface CompositeVersionInput {
  layer_doc?: unknown
  prompt?: unknown
  text_prompt?: unknown
}

/** 服务端从当前 LayerDoc 渲染合成图（底图 + 风格化 + 叠加层），登记版本并设为最终版本。 */
export async function registerCompositeVersion(
  episodeId: number,
  body: CompositeVersionInput,
): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const vars = posterVariablesOf(context)
  const doc = normalizeLayerDoc(body.layer_doc !== undefined ? body.layer_doc : parseJsonObject(poster.layerDoc))
  if (!doc.base.path) throw new Error('请先生成或选择底图')
  doc.base.path = staticImagePath(doc.base.path, '底图')
  const rendered = await renderLayerDocToFile(doc, { width: doc.base.width, height: doc.base.height, variables: vars })
  const ts = now()

  const inserted = await db.insert(schema.posterVersions).values({
    posterId: poster.id,
    episodeId: context.episode.id,
    dramaId: context.drama.id,
    kind: 'composite',
    image: rendered.url,
    baseImage: doc.base.path,
    layerDoc: JSON.stringify(doc),
    prompt: typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : poster.prompt || null,
    textPrompt: typeof body.text_prompt === 'string' ? body.text_prompt.trim().slice(0, 2000) : poster.textPrompt || null,
    mode: 'composite',
    referenceImages: JSON.stringify([rendered.url]),
    provider: 'local',
    model: 'layer-doc',
    createdAt: ts,
    generatedAt: Math.floor(Date.now() / 1000),
  })

  await db.update(schema.episodePosters).set({
    baseImage: doc.base.path,
    layerDoc: JSON.stringify(doc),
    selectedVersionId: getInsertId(inserted),
    finalImage: rendered.url,
    updatedAt: ts,
  }).where(eq(schema.episodePosters.id, poster.id))
  await db.update(schema.episodes).set({ thumbnail: rendered.url, updatedAt: ts })
    .where(eq(schema.episodes.id, context.episode.id))
  return getPosterBundle(episodeId)
}

/** 选择最终版本：同步 episodes.thumbnail，剧详情页据此显示缩略图。 */
export async function selectPosterVersion(episodeId: number, versionId: unknown): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const id = Number(versionId || 0)
  if (!id) throw new Error('version_id 必填')
  const versions = await versionsOf(poster.id)
  const version = versions.find(row => row.id === id)
  if (!version?.image) throw new Error('版本不存在')
  const ts = now()
  await db.update(schema.episodePosters).set({
    selectedVersionId: version.id,
    finalImage: version.image,
    updatedAt: ts,
  }).where(eq(schema.episodePosters.id, poster.id))
  await db.update(schema.episodes).set({ thumbnail: version.image, updatedAt: ts })
    .where(eq(schema.episodes.id, context.episode.id))
  return getPosterBundle(episodeId)
}

/** 把某版本的 layer_doc 载入当前工程（旧版本没有 layer_doc 时只换底图）。 */
export async function loadPosterVersion(episodeId: number, versionId: unknown): Promise<PosterBundle> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  const id = Number(versionId || 0)
  if (!id) throw new Error('version_id 必填')
  const versions = await versionsOf(poster.id)
  const version = versions.find(row => row.id === id)
  if (!version) throw new Error('版本不存在')
  const doc = version.layerDoc ? normalizeLayerDoc(parseJsonObject(version.layerDoc)) : normalizeLayerDoc(parseJsonObject(poster.layerDoc))
  const baseImage = version.baseImage || version.image || doc.base.path
  const ts = now()
  await db.update(schema.episodePosters).set({
    baseImage,
    layerDoc: JSON.stringify(doc),
    prompt: version.prompt ?? poster.prompt,
    textPrompt: version.textPrompt ?? poster.textPrompt,
    updatedAt: ts,
    provenance: JSON.stringify({ ...normalizeProvenance(poster.provenance), layer_doc: 'manual' }),
  }).where(eq(schema.episodePosters.id, poster.id))
  return getPosterBundle(episodeId)
}
