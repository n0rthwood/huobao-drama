/**
 * 分镜关键帧生成请求组装 — 单张生成与剧集批量共用的唯一实现
 *
 * 参考图 = 分镜绑定素材（场景 → 角色 → 道具）的选定版本，**不含任何关键帧**：
 * 实测把首帧作为额外参考图去生成尾帧会让画面崩坏，三张关键帧各自独立生成。
 * 提示词 = 剧集风格词 + 槽位提示词（@名字 换成模型的图片引用写法）。
 * 尺寸按剧集画幅固定（Qwen i2i 用显式 latent，不跟随第一张参考图）。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { generateImage } from './generation.js'
import { SLOT_FRAME_TYPE, SLOT_LABEL, slotPrompt, type KeyframeSlot } from './keyframes.js'
import { collectStoryboardAssetRefs, indexRefs, resolvePromptRefs } from './storyboard-assets.js'
import { getDramaStylePrompt } from './style-preset.js'
import { isQwenJobsTask } from './sys-task.js'

/** 剧集画幅 → 关键帧尺寸（与 H3 的 1080p 档位同画幅，生图侧统一按长边 1344） */
const KEYFRAME_SIZES: Record<string, string> = {
  '16:9': '1344x768',
  '9:16': '768x1344',
  '4:3': '1152x864',
  '3:4': '864x1152',
  '1:1': '1024x1024',
}

export interface KeyframeGenerationOptions {
  model?: string
  configId?: number
}

/** 组装并提交某个槽位的关键帧生成，返回 sys_task id */
export async function submitStoryboardKeyframe(
  storyboardId: number,
  slot: KeyframeSlot,
  opts: KeyframeGenerationOptions = {},
): Promise<number> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard || storyboard.deletedAt) throw new Error('镜头不存在')

  const prompt = slotPrompt(storyboard, slot)
  if (!prompt) {
    throw new Error(`分镜 #${storyboard.storyboardNumber} 的${SLOT_LABEL[slot]}提示词为空，请先补齐关键帧提示词`)
  }

  const [episode] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboard.episodeId))
  if (!episode) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))

  // 配置优先级与视频侧一致：请求显式指定 > 集锁定配置 > 当前启用配置
  const configId = opts.configId ?? episode.imageConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('image') : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  const { urls, nameToIndex } = indexRefs(await collectStoryboardAssetRefs(storyboard, episode.id))
  // qwen-jobs（Qwen Image 2.1）用 <imageN> 指代参考图；其余厂商没有占位语法，退化成“图片N”
  const supportsImageTags = isQwenJobsTask(config.provider)
  let finalPrompt = resolvePromptRefs(prompt, nameToIndex, (index, name) =>
    supportsImageTags ? `<image${index}>${name}` : `图片${index}${name}`)
  const stylePrompt = await getDramaStylePrompt(episode.dramaId)
  if (stylePrompt) finalPrompt = `${stylePrompt}，\n${finalPrompt}`

  return generateImage({
    storyboardId,
    dramaId: episode.dramaId,
    prompt: finalPrompt,
    model: opts.model || undefined,
    size: KEYFRAME_SIZES[(drama?.aspectRatio || '16:9').trim()] || KEYFRAME_SIZES['16:9'],
    referenceImages: urls.length ? urls : undefined,
    frameType: SLOT_FRAME_TYPE[slot],
    configId,
  })
}
