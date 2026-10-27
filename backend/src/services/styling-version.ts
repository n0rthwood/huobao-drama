/**
 * 角色造型版本（Issue #15，Q1 = B）
 *
 * 成套服装（夏威夷度假装、雪服…）不做道具，而是该角色在**本集**的一个造型版本：
 * 以角色基础形象图做 image_edit 出一张「穿着这套衣服」的角色图，存进
 * `episode_characters.styling_version`（JSON）。基础形象的 `characters.styling` /
 * `image_url` 永不被单集造型覆盖；分镜默认选用本集造型图，人工选版优先。
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export interface StylingVersion {
  /** 造型名，如「夏威夷度假装」 */
  name: string
  /** 无歧义的造型描述（禁止「或」这类不确定写法） */
  description: string
  /** 造型图地址（image_edit 出图完成后回写；未出图时为空串） */
  image_path: string
}

/** 解析 episode_characters.styling_version；非法/空值返回 null */
export function parseStylingVersion(raw: string | null | undefined): StylingVersion | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : ''
    if (!name.trim()) return null
    return {
      name,
      description: typeof obj.description === 'string' ? obj.description : '',
      image_path: typeof obj.image_path === 'string' ? obj.image_path : '',
    }
  } catch {
    return null
  }
}

/** 本集某角色的造型版本 */
export async function getStylingVersion(episodeId: number, characterId: number): Promise<StylingVersion | null> {
  const [link] = await db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, characterId)))
  return parseStylingVersion(link?.stylingVersion)
}

/** 本集全部角色造型版本（characterId → 版本） */
export async function loadStylingVersions(episodeId: number): Promise<Map<number, StylingVersion>> {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const result = new Map<number, StylingVersion>()
  for (const link of links) {
    const parsed = parseStylingVersion(link.stylingVersion)
    if (parsed) result.set(link.characterId, parsed)
  }
  return result
}

/**
 * 写入/更新本集角色造型版本（只动关联行，不动 characters 表）。
 * 传入 image_path 为 undefined 时保留已有图，便于「先存文本、出图后回写」。
 */
export async function saveStylingVersion(
  episodeId: number,
  characterId: number,
  version: { name: string; description?: string; image_path?: string },
): Promise<StylingVersion | null> {
  const [link] = await db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, characterId)))
  if (!link) return null
  const existing = parseStylingVersion(link.stylingVersion)
  const next: StylingVersion = {
    name: version.name || existing?.name || '',
    description: version.description ?? existing?.description ?? '',
    image_path: version.image_path ?? existing?.image_path ?? '',
  }
  if (!next.name.trim()) return null
  await db.update(schema.episodeCharacters)
    .set({ stylingVersion: JSON.stringify(next) })
    .where(eq(schema.episodeCharacters.id, link.id))
  return next
}
