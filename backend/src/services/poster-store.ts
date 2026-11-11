/**
 * Poster 工程共享读写（Issue #72）：剧集上下文、工程行、变量与 provenance。
 *
 * Poster 的字段来源只有两种：`ai`（构想/方案应用写入）与 `manual`（人工编辑）。
 * 任务本身（poster_concept / 三案生图）只写 `concept` 与版本行，不直接改当前编辑字段；
 * 只有显式 apply 才写 prompt/text_prompt/copy/layer_doc，并在这里统一落 provenance。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export interface PosterContext {
  episode: typeof schema.episodes.$inferSelect
  drama: typeof schema.dramas.$inferSelect
}

export type PosterRow = typeof schema.episodePosters.$inferSelect
export type PosterVersionRow = typeof schema.posterVersions.$inferSelect

export type PosterSource = 'ai' | 'manual'
export type PosterField = 'prompt' | 'text_prompt' | 'copy' | 'concept' | 'layer_doc'

export interface PosterProvenance {
  prompt?: PosterSource
  text_prompt?: PosterSource
  copy?: PosterSource
  concept?: PosterSource
  layer_doc?: PosterSource
  layers?: Record<string, PosterSource>
}

export interface PosterVariables {
  project_title: string
  episode_title: string
  episode_no: string
}

const SOURCES: PosterSource[] = ['ai', 'manual']
const FIELDS: PosterField[] = ['prompt', 'text_prompt', 'copy', 'concept', 'layer_doc']
/** 人工改任一字段/图层即标 manual；AI 写入标 ai（apply 时重置）。 */
export const POSTER_FIELDS: PosterField[] = FIELDS

export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function normalizeProvenance(raw: unknown): PosterProvenance {
  const source = parseJsonObject(raw) || {}
  const out: PosterProvenance = {}
  for (const field of FIELDS) {
    if (SOURCES.includes(source[field] as PosterSource)) out[field] = source[field] as PosterSource
  }
  const layers = parseJsonObject(source.layers)
  if (layers) {
    const parsed: Record<string, PosterSource> = {}
    for (const [id, value] of Object.entries(layers)) {
      if (id && SOURCES.includes(value as PosterSource)) parsed[id] = value as PosterSource
    }
    out.layers = parsed
  }
  return out
}

export async function loadPosterContext(episodeId: number): Promise<PosterContext> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))
  if (!drama || drama.deletedAt) throw new Error('项目不存在')
  return { episode, drama }
}

export async function ensurePosterRow(context: PosterContext): Promise<PosterRow> {
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

export function posterVariablesOf(context: PosterContext): PosterVariables {
  const episodeNumber = Number(context.episode.episodeNumber || 0)
  return {
    project_title: context.drama.title,
    episode_title: context.episode.title,
    episode_no: `EP${String(episodeNumber).padStart(2, '0')}`,
  }
}

/**
 * Poster 集号行（`poster_project.sub`）的显示文本（Issue #96）。
 *
 * 变量 `episode_no` 是生产编号 `EP01`，不是规范要求的「第N集」，也不能拼上集名，
 * 所以这里落**字面文本**：`第1集 · 漕运兴衰`。缺集号或集名时只写存在的那一段。
 * 槽位容量放不下整行时由 `posterProjectFields` 退到 `posterEpisodeNumberLabel`。
 */
export function posterEpisodeLabel(episode: PosterContext['episode']): string {
  const number = posterEpisodeNumberLabel(episode)
  const title = String(episode.title || '').trim()
  // 默认集名就是「第N集」（或 EP01 之类的编号写法）时不重复写（验收实测「第1集 · 第1集」）
  const redundant = Boolean(number) && (title === number || /^(第\s*\d+\s*集|EP\s*\d+|Episode\s*\d+)$/i.test(title))
  return redundant ? number : [number, title].filter(Boolean).join(' · ')
}

/** 只有集号 `第N集`（规范的写法，也是集号行的兜底）。 */
export function posterEpisodeNumberLabel(episode: PosterContext['episode']): string {
  const episodeNumber = Number(episode.episodeNumber || 0)
  return episodeNumber > 0 ? `第${episodeNumber}集` : ''
}
