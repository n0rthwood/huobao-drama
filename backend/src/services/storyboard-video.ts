/**
 * 分镜视频请求组装 — 单镜生成与服务端批量共用的唯一实现
 *
 * 参考图顺序与前端预览一致：场景 → 角色（本集角色、排除旁白、按角色列表顺序）→ 道具；
 * 优先用分镜选定的素材版本（asset_version_selection），否则用素材当前成片图；去重后最多 9 张。
 * 提示词里的 @名字 按同一顺序替换为 @图片N名字。
 * 生效承接时在“提交的这一刻”提取上一镜采用视频的尾帧作为首帧，参考图照常发送。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, validateVideoModel } from './ai.js'
import { getVideoAdapter } from './adapters/registry'
import { generateVideo } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'
import { loadEpisodeContinuity } from './continuity.js'
import { extractVideoTailFrame } from '../utils/video-poster.js'

/** 参考图上限（与前端面板、Seedance 多模态上限一致） */
const REF_IMAGE_LIMIT = 9

/** 旁白角色识别：提取产物中的旁白角色不参与画面生成（与前端 isNarratorCharacter 同口径） */
const NARRATOR_KEYWORDS = ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설']

function isNarratorCharacter(char: { name: string | null; role: string | null }): boolean {
  const text = `${char.name || ''} ${char.role || ''}`.toLowerCase()
  return NARRATOR_KEYWORDS.some(keyword => text.includes(keyword))
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

type AssetKind = 'scene' | 'character' | 'prop'

function selectedAssetImage(
  selection: Record<string, string>,
  kind: AssetKind,
  item: { id: number; imageUrl: string | null } | null,
): string {
  if (!item) return ''
  return selection[`${kind}:${item.id}`] || item.imageUrl || ''
}

/** 将视频提示词里的 @名字 替换为 @图片N名字（N 为参考图序号，1 起） */
function resolveVideoPromptRefs(prompt: string, nameToIndex: Record<string, number>): string {
  const names = Object.keys(nameToIndex).sort((a, b) => b.length - a.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@]+)/g, (match, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) {
        return `@图片${nameToIndex[name]}${name}${raw.slice(name.length)}`
      }
    }
    return match
  })
}

export interface StoryboardVideoOptions {
  model?: string
  configId?: number
}

export interface StoryboardVideoRequest {
  storyboardId: number
  episodeId: number
  dramaId: number
  /** 直接可交给 generateVideo 的参数 */
  params: Parameters<typeof generateVideo>[0]
  continuity: {
    effective: boolean
    sourceStoryboardId?: number
    sourceStoryboardNumber?: number
    sourceVideoUrl?: string
  }
}

/** 组装分镜的视频生成请求（不提交）。承接镜头在此刻提取上一镜尾帧。 */
export async function buildStoryboardVideoRequest(
  storyboardId: number,
  opts: StoryboardVideoOptions = {},
): Promise<StoryboardVideoRequest> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard || storyboard.deletedAt) throw new Error('镜头不存在')

  const [episode] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboard.episodeId))
  if (!episode) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))

  // 配置优先级与 POST /tasks 一致：请求显式指定 > 集锁定配置 > 当前启用配置
  const configId = opts.configId ?? episode.videoConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('video') : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  const model = opts.model || undefined
  const modelError = validateVideoModel(config.provider, model || config.model)
  if (modelError) throw new Error(modelError)

  // ===== 参考素材：场景 → 角色 → 道具 =====
  const selection = parseAssetVersionSelection(storyboard.assetVersionSelection)

  // 与前端一致：场景取自本集已关联且未删除的场景列表，软删/解绑的场景不参与参考图与编号
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episode.id))
  const episodeSceneIds = sceneLinks.map(link => link.sceneId)
  const scene = storyboard.sceneId && episodeSceneIds.includes(storyboard.sceneId)
    ? (await db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId)))
      .filter(row => !row.deletedAt)[0] ?? null
    : null

  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const boundCharIds = charLinks.map(link => link.characterId)
  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episode.id))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const characters = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt && !isNarratorCharacter(ch))
    .filter(ch => boundCharIds.includes(ch.id))

  const propLinks = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  const boundPropIds = propLinks.map(link => link.propId)
  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episode.id))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const props = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)
    .filter(p => boundPropIds.includes(p.id))

  const ordered: Array<{ name: string; url: string }> = []
  const pushRef = (name: string, url: string) => {
    if (!url || ordered.length >= REF_IMAGE_LIMIT || ordered.some(item => item.url === url)) return
    ordered.push({ name, url })
  }
  pushRef(scene?.location || '', selectedAssetImage(selection, 'scene', scene))
  for (const char of characters) pushRef(char.name || '', selectedAssetImage(selection, 'character', char))
  for (const prop of props) pushRef(prop.name || '', selectedAssetImage(selection, 'prop', prop))

  const referenceImageUrls = ordered.map(item => item.url)
  const nameToIndex: Record<string, number> = {}
  ordered.forEach((item, index) => {
    if (item.name && !(item.name in nameToIndex)) nameToIndex[item.name] = index + 1
  })

  let prompt = resolveVideoPromptRefs((storyboard.videoPrompt || '').trim(), nameToIndex)
  if (!prompt && !referenceImageUrls.length) {
    throw new Error('视频生成需要至少一个参考素材或提示词')
  }
  // 项目视觉风格词注入提示词最前方（与图片侧口径一致）
  if (prompt) {
    const stylePrompt = await getDramaStylePrompt(episode.dramaId)
    if (stylePrompt) prompt = `${stylePrompt}，\n${prompt}`
  }

  // ===== 尾帧承接 =====
  const continuityMap = await loadEpisodeContinuity(episode.id)
  const entry = continuityMap.get(storyboardId)
  const continuity: StoryboardVideoRequest['continuity'] = { effective: !!entry?.effective }
  let firstFrameUrl: string | undefined
  if (entry?.effective && entry.previousId) {
    const [previous] = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, entry.previousId))
    const previousVideo = previous?.videoUrl || previous?.composedVideoUrl
    if (!previousVideo) {
      throw new Error(`上一镜 #${previous?.storyboardNumber ?? '?'} 还没有采用视频，无法承接尾帧`)
    }
    firstFrameUrl = await extractVideoTailFrame(previousVideo)
    continuity.sourceStoryboardId = previous.id
    continuity.sourceStoryboardNumber = previous.storyboardNumber
    continuity.sourceVideoUrl = previousVideo
  }

  const lastFrameUrl = storyboard.lastFrameImage || undefined
  if (firstFrameUrl || lastFrameUrl) {
    const adapter = getVideoAdapter(config.provider)
    if (!adapter.supportsFrameGuides) {
      throw new Error(firstFrameUrl
        ? `当前视频模型（${config.provider}）不支持首帧引导，无法承接上一镜尾帧，请改用 MiniMax-H3 等支持的模型`
        : `当前视频模型（${config.provider}）不支持尾帧引导，请清除分镜尾帧图或改用支持的模型`)
    }
  }

  return {
    storyboardId,
    episodeId: episode.id,
    dramaId: episode.dramaId,
    continuity,
    params: {
      storyboardId,
      dramaId: episode.dramaId,
      prompt,
      model,
      referenceMode: 'reference',
      firstFrameUrl,
      lastFrameUrl,
      referenceImageUrls,
      generateAudio: true,
      duration: Number(storyboard.duration || 10),
      aspectRatio: drama?.aspectRatio || '16:9',
      resolution: episode.resolution || undefined,
      continuitySourceStoryboardId: continuity.sourceStoryboardId,
      continuitySourceVideoUrl: continuity.sourceVideoUrl,
      configId,
    },
  }
}

/** 组装并提交分镜视频生成，返回 sys_task id */
export async function submitStoryboardVideo(
  storyboardId: number,
  opts: StoryboardVideoOptions = {},
): Promise<number> {
  const request = await buildStoryboardVideoRequest(storyboardId, opts)
  return generateVideo(request.params)
}

/** 本集内未删除的分镜（按分镜号排序），批量目标与承接链共用 */
export async function listEpisodeStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
}
