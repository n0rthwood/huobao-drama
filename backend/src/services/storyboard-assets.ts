/**
 * 分镜参考素材装配 — 关键帧生成与视频生成共用的唯一实现
 *
 * 顺序与前端预览一致：场景 → 角色（本集角色、排除旁白、按角色列表顺序）→ 道具；
 * 优先用分镜选定的素材版本（asset_version_selection），否则用素材当前成片图；去重后最多 9 张。
 * 提示词里的 @名字 按同一顺序替换为各模型的图片引用写法。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/** 参考图上限（与前端面板、Seedance 多模态上限一致） */
const REF_IMAGE_LIMIT = 9

/** 旁白角色识别：提取产物中的旁白角色不参与画面生成（与前端 isNarratorCharacter 同口径） */
const NARRATOR_KEYWORDS = ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설']

type AssetKind = 'scene' | 'character' | 'prop'

export interface AssetRef {
  name: string
  url: string
}

function parseAssetVersionSelection(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function selectedAssetImage(
  selection: Record<string, string>,
  kind: AssetKind,
  item: { id: number; imageUrl: string | null } | null,
): string {
  if (!item) return ''
  return selection[`${kind}:${item.id}`] || item.imageUrl || ''
}

/**
 * 分镜绑定素材的参考图（场景 → 角色 → 道具），不含任何关键帧。
 * 调用方可在前面插入关键帧，再按最终顺序生成 @名字 的编号映射。
 */
export async function collectStoryboardAssetRefs(
  storyboard: typeof schema.storyboards.$inferSelect,
  episodeId: number,
): Promise<AssetRef[]> {
  const selection = parseAssetVersionSelection(storyboard.assetVersionSelection)

  // 与前端一致：场景取自本集已关联且未删除的场景列表，软删/解绑的场景不参与参考图与编号
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = sceneLinks.map(link => link.sceneId)
  const scene = storyboard.sceneId && episodeSceneIds.includes(storyboard.sceneId)
    ? (await db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId)))
      .filter(row => !row.deletedAt)[0] ?? null
    : null

  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id))
  const boundCharIds = charLinks.map(link => link.characterId)
  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const characters = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)
    .filter(ch => !NARRATOR_KEYWORDS.some(keyword => `${ch.name || ''} ${ch.role || ''}`.toLowerCase().includes(keyword)))
    .filter(ch => boundCharIds.includes(ch.id))

  const propLinks = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboard.id))
  const boundPropIds = propLinks.map(link => link.propId)
  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const props = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)
    .filter(p => boundPropIds.includes(p.id))

  const refs: AssetRef[] = []
  refs.push({ name: scene?.location || '', url: selectedAssetImage(selection, 'scene', scene) })
  for (const char of characters) refs.push({ name: char.name || '', url: selectedAssetImage(selection, 'character', char) })
  for (const prop of props) refs.push({ name: prop.name || '', url: selectedAssetImage(selection, 'prop', prop) })
  return refs.filter(ref => !!ref.url)
}

/** 去重并截断到上限，同时给有名字的参考图编号（1 起，顺序即发送顺序） */
export function indexRefs(refs: AssetRef[]): { urls: string[]; nameToIndex: Record<string, number> } {
  const ordered: AssetRef[] = []
  for (const ref of refs) {
    if (!ref.url || ordered.length >= REF_IMAGE_LIMIT || ordered.some(item => item.url === ref.url)) continue
    ordered.push(ref)
  }
  const nameToIndex: Record<string, number> = {}
  ordered.forEach((ref, index) => {
    if (ref.name && !(ref.name in nameToIndex)) nameToIndex[ref.name] = index + 1
  })
  return { urls: ordered.map(ref => ref.url), nameToIndex }
}

/**
 * 把提示词里的 @名字 换成模型可识别的图片引用。
 * 名字按长度倒序匹配，避免“小明”抢在“小明妈妈”前面命中。
 */
export function resolvePromptRefs(
  prompt: string,
  nameToIndex: Record<string, number>,
  format: (index: number, name: string) => string,
): string {
  const names = Object.keys(nameToIndex).sort((a, b) => b.length - a.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@]+)/g, (match, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) return `${format(nameToIndex[name]!, name)}${raw.slice(name.length)}`
    }
    return match
  })
}
