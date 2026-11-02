/**
 * 剧集 Poster（Issue #39）：每集一份编辑工程 + 生图/排版版本。
 *
 * 版本只新增、切换与载入，不做删除；选中版本即成为剧集缩略图（episodes.thumbnail）。
 * 文字渲染在前端合成时完成，服务端只保存布局并生成二次生成的文字说明。
 */
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { toSnakeCase } from '../utils/transform.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { generateImage } from './generation.js'
import { isFluxJobsConfig, QWEN_MAX_REFS } from './adapters/qwen-jobs-client.js'
import { KEYFRAME_SIZES } from './storyboard-keyframes.js'
import {
  buildPosterTextInstruction,
  normalizePosterLayout,
  type PosterVariables,
} from './poster-layout.js'

export type PosterGenerationMode = 'initial' | 'composite' | 'layers'

interface EpisodeContext {
  episode: typeof schema.episodes.$inferSelect
  drama: typeof schema.dramas.$inferSelect
}

type PosterRow = typeof schema.episodePosters.$inferSelect
type VersionRow = typeof schema.posterVersions.$inferSelect

export interface PosterBundle extends Record<string, unknown> {
  variables: PosterVariables
  aspect_ratio: string
  size: string
  versions: Record<string, unknown>[]
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
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
  return paths.map(path => staticImagePath(path, '参考图'))
}

async function loadContext(episodeId: number): Promise<EpisodeContext> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))
  if (!drama || drama.deletedAt) throw new Error('项目不存在')
  return { episode, drama }
}

async function ensurePoster(context: EpisodeContext): Promise<PosterRow> {
  const [existing] = await db.select().from(schema.episodePosters)
    .where(eq(schema.episodePosters.episodeId, context.episode.id))
  if (existing) return existing
  const ts = now()
  await db.insert(schema.episodePosters).values({
    dramaId: context.drama.id,
    episodeId: context.episode.id,
    createdAt: ts,
    updatedAt: ts,
  }).onConflictDoNothing()
  const [created] = await db.select().from(schema.episodePosters)
    .where(eq(schema.episodePosters.episodeId, context.episode.id))
  return created
}

function variablesOf(context: EpisodeContext): PosterVariables {
  const episodeNumber = Number(context.episode.episodeNumber || 0)
  return {
    project_title: context.drama.title,
    episode_title: context.episode.title,
    episode_no: `EP${String(episodeNumber).padStart(2, '0')}`,
  }
}

function serializeVersion(row: VersionRow): Record<string, unknown> {
  return {
    ...toSnakeCase(row),
    layout: normalizePosterLayout(row.layout),
    reference_images: parseJsonArray(row.referenceImages),
  }
}

async function versionsOf(posterId: number): Promise<VersionRow[]> {
  const rows = await db.select().from(schema.posterVersions)
    .where(eq(schema.posterVersions.posterId, posterId))
  return rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id - a.id)
}

/** 组装前端所需的完整 Poster 状态：工程 + 变量 + 画幅 + 版本（新→旧）。 */
export async function getPosterBundle(episodeId: number): Promise<PosterBundle> {
  const context = await loadContext(episodeId)
  const poster = await ensurePoster(context)
  const versions = await versionsOf(poster.id)
  const aspectRatio = String(context.drama.aspectRatio || '16:9')
  return {
    ...toSnakeCase(poster),
    layout: normalizePosterLayout(poster.layout),
    reference_images: parseJsonArray(poster.referenceImages),
    variables: variablesOf(context),
    aspect_ratio: aspectRatio,
    size: KEYFRAME_SIZES[aspectRatio] || KEYFRAME_SIZES['16:9']!,
    versions: versions.map(serializeVersion),
  }
}

export interface PosterDraftPatch {
  prompt?: unknown
  text_prompt?: unknown
  reference_images?: unknown
  base_image?: unknown
  layout?: unknown
}

/** 保存编辑工程：只校验本次实际写入的字段，未提供的字段保持不变。 */
export async function savePosterDraft(episodeId: number, patch: PosterDraftPatch): Promise<PosterBundle> {
  const context = await loadContext(episodeId)
  const poster = await ensurePoster(context)
  const updates: Partial<typeof schema.episodePosters.$inferInsert> = { updatedAt: now() }

  if (patch.prompt !== undefined) {
    updates.prompt = String(patch.prompt || '').trim().slice(0, 4000)
  }
  if (patch.text_prompt !== undefined) {
    updates.textPrompt = String(patch.text_prompt || '').trim().slice(0, 2000)
  }
  if (patch.reference_images !== undefined) {
    updates.referenceImages = JSON.stringify(referencePaths(patch.reference_images))
  }
  if (patch.base_image !== undefined) {
    updates.baseImage = patch.base_image ? staticImagePath(patch.base_image, '底图') : null
  }
  if (patch.layout !== undefined) {
    updates.layout = JSON.stringify(normalizePosterLayout(patch.layout))
  }

  await db.update(schema.episodePosters).set(updates).where(eq(schema.episodePosters.id, poster.id))
  return getPosterBundle(episodeId)
}

interface GenerationInput {
  mode?: unknown
  prompt?: unknown
  text_prompt?: unknown
  reference_images?: unknown
  base_image?: unknown
  text_layer?: unknown
  version_id?: unknown
  layout?: unknown
  config_id?: unknown
  model?: unknown
}

/**
 * 提交 Poster 生图：
 * - initial：资产参考图，按剧集画幅出图；
 * - composite：当前/指定合成版本图作为唯一参考；
 * - layers：底图 + 透明文字图层两张参考（FLUX 不支持）。
 * 文字说明由布局里的变量现场渲染后追加到 prompt。
 */
export async function createPosterGeneration(
  episodeId: number,
  body: GenerationInput,
): Promise<{ task_id: number; mode: PosterGenerationMode; prompt: string; references: string[] }> {
  const context = await loadContext(episodeId)
  const poster = await ensurePoster(context)
  const vars = variablesOf(context)
  const mode = String(body.mode || 'initial') as PosterGenerationMode
  if (!['initial', 'composite', 'layers'].includes(mode)) throw new Error('mode 必须是 initial / composite / layers')

  const draft: PosterDraftPatch = {}
  if (body.prompt !== undefined) draft.prompt = body.prompt
  if (body.text_prompt !== undefined) draft.text_prompt = body.text_prompt
  if (body.reference_images !== undefined) draft.reference_images = body.reference_images
  if (body.layout !== undefined) draft.layout = body.layout
  const saved = Object.keys(draft).length ? await savePosterDraft(episodeId, draft) : await getPosterBundle(episodeId)

  const layout = normalizePosterLayout(saved.layout)
  const basePrompt = String(saved.prompt || '').trim()
  const textPrompt = String(saved.text_prompt || '').trim()
  let references: string[] = []
  let layoutForInstruction = layout

  if (mode === 'composite') {
    const requestedId = Number(body.version_id || saved.selected_version_id || 0)
    const versions = await versionsOf(poster.id)
    const version = versions.find(row => row.id === requestedId && row.kind === 'composite')
    if (!version?.image) throw new Error('请先保存合成图，或用当前最终版本作为参考')
    references = [staticImagePath(version.image, '合成图')]
    layoutForInstruction = normalizePosterLayout(version.layout)
  } else if (mode === 'layers') {
    const baseImage = staticImagePath(body.base_image || saved.base_image, '底图')
    const textLayer = staticImagePath(body.text_layer, '文字图层')
    if (!layout.texts.length) throw new Error('请先添加至少一个文字图层')
    references = [baseImage, textLayer]
  } else {
    const refs = body.reference_images !== undefined
      ? referencePaths(body.reference_images)
      : parseJsonArray(saved.reference_images).map(item => staticImagePath(item, '参考图'))
    references = refs
  }

  const finalInstruction = buildPosterTextInstruction(layoutForInstruction, vars)
  const promptParts = mode === 'initial' ? [basePrompt] : [basePrompt, textPrompt, finalInstruction].filter(Boolean)
  const prompt = promptParts.join('\n\n')
  if (!prompt.trim()) throw new Error('请填写画面 prompt 或针对文字的描述')

  const configId = Number(body.config_id || context.episode.imageConfigId || 0) || undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('image') : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')
  if (mode === 'layers' && isFluxJobsConfig({ ...config, model: typeof body.model === 'string' ? body.model : config.model })) {
    throw new Error('FLUX 不支持底图＋文字图层的双参考图模式，请改用合成图再生成')
  }

  const taskId = await generateImage({
    episodeId,
    dramaId: context.drama.id,
    prompt,
    size: String(saved.size),
    referenceImages: references.length ? references : undefined,
    configId,
    model: typeof body.model === 'string' ? body.model : undefined,
    posterId: poster.id,
    posterGenMode: mode,
    posterTextPrompt: textPrompt,
  })

  return { task_id: taskId, mode, prompt, references }
}

export interface CompositeVersionInput {
  image?: unknown
  base_image?: unknown
  layout?: unknown
}

/** 登记一张本地合成的 Poster：自动成为最终版本并更新剧集缩略图。 */
export async function registerCompositeVersion(
  episodeId: number,
  body: CompositeVersionInput,
): Promise<PosterBundle> {
  const context = await loadContext(episodeId)
  const poster = await ensurePoster(context)
  const image = staticImagePath(body.image, '合成图')
  const baseImage = staticImagePath(body.base_image, '底图')
  const layout = normalizePosterLayout(body.layout)
  const ts = now()

  const inserted = await db.insert(schema.posterVersions).values({
    posterId: poster.id,
    episodeId: context.episode.id,
    dramaId: context.drama.id,
    kind: 'composite',
    image,
    baseImage,
    layout: JSON.stringify(layout),
    prompt: poster.prompt || null,
    textPrompt: poster.textPrompt || null,
    mode: 'composite',
    referenceImages: JSON.stringify([image]),
    provider: 'local',
    model: 'poster-canvas',
    createdAt: ts,
    generatedAt: Math.floor(Date.now() / 1000),
  })

  await db.update(schema.episodePosters).set({
    baseImage,
    layout: JSON.stringify(layout),
    selectedVersionId: getInsertId(inserted),
    finalImage: image,
    updatedAt: ts,
  }).where(eq(schema.episodePosters.id, poster.id))
  await db.update(schema.episodes).set({ thumbnail: image, updatedAt: ts })
    .where(eq(schema.episodes.id, context.episode.id))

  return getPosterBundle(episodeId)
}

/** 选择最终版本：同步 episodes.thumbnail，剧详情页据此显示缩略图。 */
export async function selectPosterVersion(episodeId: number, versionId: unknown): Promise<PosterBundle> {
  const context = await loadContext(episodeId)
  const poster = await ensurePoster(context)
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
