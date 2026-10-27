/**
 * 分镜关键帧生成请求组装 — 单张生成、批量预览与批量生成共用的唯一实现
 *
 * 参考图 = 分镜绑定素材（场景 → 角色 → 道具）的选定版本，**不含任何关键帧**：
 * 实测把首帧作为额外参考图去生成尾帧会让画面崩坏，三张关键帧各自独立生成。
 * 提示词 = 剧集风格词 + 槽位提示词（@名字 换成模型的图片引用写法）。
 * 尺寸按剧集画幅固定（Qwen i2i 用显式 latent，不跟随第一张参考图）。
 * 提示词里 @ 的角色/道具与绑定不一致时拒绝组装（Issue #7），由调用方返回 400。
 */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { generateImage } from './generation.js'
import { SLOT_FRAME_TYPE, SLOT_LABEL, slotPrompt, type KeyframeSlot } from './keyframes.js'
import {
  SLOT_PROMPT_FIELD,
  blockingIssuesFor,
  collectStoryboardAssetRefs,
  computeRefIssues,
  describeIssues,
  indexRefs,
  loadEpisodeAssets,
  promptFieldsOf,
  resolvePromptRefs,
  type EpisodeAssetEntry,
  type RefIssue,
} from './storyboard-assets.js'
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

/** 整集共用的组装上下文（批量预览时避免逐槽位重复查库） */
export interface KeyframeBuildContext {
  episode: typeof schema.episodes.$inferSelect
  drama: typeof schema.dramas.$inferSelect | null
  config: { provider: string; model: string | null }
  configId: number | undefined
  stylePrompt: string
  size: string
}

export interface KeyframeRequest {
  storyboardId: number
  episodeId: number
  dramaId: number
  slot: KeyframeSlot
  /** 最终提示词（风格词 + @名字 已换成图片引用） */
  prompt: string
  /** 重试用的来源提示词（含风格词，@名字 未解析） */
  sourcePrompt: string
  referenceImages: string[]
  refNameIndex: Record<string, number>
  size: string
  provider: string
  model: string
  configId: number | undefined
  /** 本次请求的内容签名（批量判定“是否变化”） */
  signature: string
  issues: RefIssue[]
}

/** 参考图/引导帧的文件名（签名只看文件名，和本机存储路径/域名无关） */
export function refBasename(url: string): string {
  const path = url.split('?')[0] || ''
  return path.split('/').filter(Boolean).pop() || path
}

/**
 * 关键帧内容签名 = sha256(最终提示词, 参考图文件名(按发送顺序), 尺寸, provider, model)。
 * 批量预览据此判断“与某个历史版本相同”。
 */
export function computeKeyframeSignature(input: {
  prompt: string
  referenceImages: string[]
  size: string
  provider: string
  model: string
}): string {
  const payload = JSON.stringify([
    input.prompt,
    input.referenceImages.map(refBasename),
    input.size,
    input.provider,
    input.model,
  ])
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * 历史版本（sys_task）的签名。早期任务缺字段（提示词/尺寸/厂商/模型）时返回 null，
 * 视为与当前请求不匹配，不报错。
 */
export function signatureFromTask(task: {
  prompt: string | null
  provider: string | null
  model: string | null
  params: string | null
}): string | null {
  if (!task.prompt || !task.provider || !task.model) return null
  let params: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(task.params || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const size = typeof params.size === 'string' ? params.size : null
  if (!size) return null
  const refs = Array.isArray(params.referenceImages)
    ? (params.referenceImages as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  return computeKeyframeSignature({
    prompt: task.prompt,
    referenceImages: refs,
    size,
    provider: task.provider,
    model: task.model,
  })
}

export interface KeyframeVersion {
  id: number
  image: string
  prompt: string | null
  provider: string | null
  model: string | null
  created_at: string | null
  /** 按创建时间正序从 1 编号 */
  version_no: number
  /** 早期任务缺字段时为 null（与任何当前请求都不匹配） */
  signature: string | null
}

/** 某槽位的历史版本（含版本号与签名），按创建时间正序 */
export async function loadKeyframeVersions(
  storyboardId: number,
  slot: KeyframeSlot,
): Promise<KeyframeVersion[]> {
  const frameType = SLOT_FRAME_TYPE[slot]
  const tasks = (await db.select().from(schema.sysTask))
    .filter(task => task.type === 'image' && task.status === 'completed' && task.storyboardId === storyboardId)
    .filter((task) => {
      try {
        const params: unknown = JSON.parse(task.params || '{}')
        return !!params && typeof params === 'object' && 'frameType' in params && params.frameType === frameType
      } catch {
        return false
      }
    })
    .filter(task => task.localPath || task.resultUrl)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id - b.id)
  return tasks.map((task, index) => ({
    id: task.id,
    image: (task.localPath || task.resultUrl)!,
    prompt: task.prompt,
    provider: task.provider,
    model: task.model,
    created_at: task.createdAt,
    version_no: index + 1,
    signature: signatureFromTask(task),
  }))
}

/** 整集共用的配置/风格/画幅（批量预览只取一次） */
export async function loadKeyframeBuildContext(
  episodeId: number,
  opts: KeyframeGenerationOptions = {},
): Promise<KeyframeBuildContext> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))

  // 配置优先级与视频侧一致：请求显式指定 > 集锁定配置 > 当前启用配置
  const configId = opts.configId ?? episode.imageConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('image') : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  return {
    episode,
    drama: drama ?? null,
    config: { provider: config.provider, model: config.model },
    configId,
    stylePrompt: await getDramaStylePrompt(episode.dramaId),
    size: KEYFRAME_SIZES[(drama?.aspectRatio || '16:9').trim()] || KEYFRAME_SIZES['16:9']!,
  }
}

/**
 * 组装某个槽位的关键帧生成请求（不提交）。
 * 提示词为空或存在阻断性一致性问题时抛错。
 */
export async function buildKeyframeRequest(
  storyboardId: number,
  slot: KeyframeSlot,
  opts: KeyframeGenerationOptions & {
    context?: KeyframeBuildContext
    assets?: EpisodeAssetEntry[]
    characterIds?: number[]
    propIds?: number[]
  } = {},
): Promise<KeyframeRequest> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard || storyboard.deletedAt) throw new Error('镜头不存在')

  const prompt = slotPrompt(storyboard, slot)
  if (!prompt) {
    throw new Error(`分镜 #${storyboard.storyboardNumber} 的${SLOT_LABEL[slot]}提示词为空，请先补齐关键帧提示词`)
  }

  const context = opts.context ?? await loadKeyframeBuildContext(storyboard.episodeId, opts)
  const assets = opts.assets ?? await loadEpisodeAssets(storyboard, storyboard.episodeId)

  const charLinks = opts.characterIds ?? (await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))).map(link => link.characterId)
  const propLinks = opts.propIds ?? (await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))).map(link => link.propId)

  const issues = computeRefIssues({
    prompts: promptFieldsOf(storyboard),
    assets,
    sceneId: storyboard.sceneId ?? null,
    characterIds: charLinks,
    propIds: propLinks,
  })
  const blocking = blockingIssuesFor(issues, SLOT_PROMPT_FIELD[slot])
  if (blocking.length) {
    throw new Error(`分镜 #${storyboard.storyboardNumber} 的${SLOT_LABEL[slot]}参考图与提示词不一致：${describeIssues(blocking)}`)
  }

  const { urls, nameToIndex } = indexRefs(await collectStoryboardAssetRefs(storyboard, storyboard.episodeId))
  // qwen-jobs（Qwen Image 2.1）用 <imageN> 指代参考图；其余厂商没有占位语法，退化成“图片N”
  const supportsImageTags = isQwenJobsTask(context.config.provider)
  let finalPrompt = resolvePromptRefs(prompt, nameToIndex, (index, name) =>
    supportsImageTags ? `<image${index}>${name}` : `图片${index}${name}`)
  let sourcePrompt = prompt
  if (context.stylePrompt) {
    finalPrompt = `${context.stylePrompt}，\n${finalPrompt}`
    sourcePrompt = `${context.stylePrompt}，\n${sourcePrompt}`
  }

  const model = opts.model || context.config.model || ''
  return {
    storyboardId,
    episodeId: storyboard.episodeId,
    dramaId: context.episode.dramaId,
    slot,
    prompt: finalPrompt,
    sourcePrompt,
    referenceImages: urls,
    refNameIndex: nameToIndex,
    size: context.size,
    provider: context.config.provider,
    model,
    configId: context.configId,
    signature: computeKeyframeSignature({
      prompt: finalPrompt,
      referenceImages: urls,
      size: context.size,
      provider: context.config.provider,
      model,
    }),
    issues,
  }
}

/** 组装并提交某个槽位的关键帧生成，返回 sys_task id */
export async function submitStoryboardKeyframe(
  storyboardId: number,
  slot: KeyframeSlot,
  opts: KeyframeGenerationOptions & { context?: KeyframeBuildContext } = {},
): Promise<number> {
  const request = await buildKeyframeRequest(storyboardId, slot, opts)
  return generateImage({
    storyboardId,
    episodeId: request.episodeId,
    dramaId: request.dramaId,
    prompt: request.prompt,
    sourcePrompt: request.sourcePrompt,
    refNameIndex: request.refNameIndex,
    model: opts.model || undefined,
    size: request.size,
    referenceImages: request.referenceImages.length ? request.referenceImages : undefined,
    frameType: SLOT_FRAME_TYPE[slot],
    configId: request.configId,
  })
}
