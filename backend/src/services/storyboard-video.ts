/**
 * 分镜视频请求组装 — 单镜生成与服务端批量共用的唯一实现
 *
 * 画面由关键帧驱动：生效首帧既作为 <Picture 1> 参考图、又作为第 0 帧引导（实测能消除开头“瞬移”），
 * 中间帧/尾帧只作引导帧。参考图顺序 = 首帧关键帧 → 场景 → 角色 → 道具（去重、最多 9 张），
 * 因此素材在提示词里的编号从 2 起。关键帧未经人工确认的分镜拒绝生成。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, validateVideoModel } from './ai.js'
import { getVideoAdapter } from './adapters/registry'
import { generateVideo } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'
import { loadEpisodeKeyframes } from './keyframes.js'
import { collectStoryboardAssetRefs, indexRefs, resolvePromptRefs } from './storyboard-assets.js'

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
}

/** 组装分镜的视频生成请求（不提交） */
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

  // 关键帧闸门：就绪且人工确认过才允许生成视频
  const keyframes = (await loadEpisodeKeyframes(episode.id)).get(storyboardId)
  if (!keyframes?.confirmed) {
    throw new Error(`分镜 #${storyboard.storyboardNumber} 的关键帧尚未确认`)
  }

  // 配置优先级与 POST /tasks 一致：请求显式指定 > 集锁定配置 > 当前启用配置
  const configId = opts.configId ?? episode.videoConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('video') : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  const model = opts.model || undefined
  const modelError = validateVideoModel(config.provider, model || config.model)
  if (modelError) throw new Error(modelError)

  const adapter = getVideoAdapter(config.provider)
  if (!adapter.supportsFrameGuides) {
    throw new Error(`当前视频模型不支持关键帧引导（${config.provider}），请改用 MiniMax-H3 等支持的模型`)
  }

  // ===== 参考图：首帧关键帧 → 场景 → 角色 → 道具 =====
  const assetRefs = await collectStoryboardAssetRefs(storyboard, episode.id)
  const { urls: referenceImageUrls, nameToIndex } = indexRefs([
    // 关键帧没有名字，不参与 @名字 编号，但占用 1 号位
    { name: '', url: keyframes.first! },
    ...assetRefs,
  ])

  let prompt = resolvePromptRefs((storyboard.videoPrompt || '').trim(), nameToIndex, (index, name) => `@图片${index}${name}`)
  if (!prompt && !referenceImageUrls.length) {
    throw new Error('视频生成需要至少一个参考素材或提示词')
  }
  // 项目视觉风格词注入提示词最前方（与图片侧口径一致）
  if (prompt) {
    const stylePrompt = await getDramaStylePrompt(episode.dramaId)
    if (stylePrompt) prompt = `${stylePrompt}，\n${prompt}`
  }

  // 中间帧引导只有部分模型支持（H3 走 MiniMaxH3AddGuide），不支持的模型只发首尾帧
  const midFrameUrl = adapter.supportsMidFrameGuide ? keyframes.mid || undefined : undefined

  return {
    storyboardId,
    episodeId: episode.id,
    dramaId: episode.dramaId,
    params: {
      storyboardId,
      dramaId: episode.dramaId,
      prompt,
      model,
      referenceMode: 'reference',
      firstFrameUrl: keyframes.first || undefined,
      midFrameUrl,
      midFrameTime: midFrameUrl ? storyboard.midFrameTime ?? undefined : undefined,
      lastFrameUrl: keyframes.last || undefined,
      referenceImageUrls,
      generateAudio: true,
      duration: Number(storyboard.duration || 10),
      aspectRatio: drama?.aspectRatio || '16:9',
      resolution: episode.resolution || undefined,
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

/** 本集内未删除的分镜（按分镜号排序），批量目标与关键帧批量共用 */
export async function listEpisodeStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
}
