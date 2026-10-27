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
import {
  blockingIssuesFor,
  collectStoryboardAssetRefs,
  computeRefIssues,
  describeIssues,
  indexRefs,
  loadEpisodeAssets,
  promptFieldsOf,
  resolvePromptRefs,
} from './storyboard-assets.js'
import { createHash } from 'node:crypto'
import { refBasename } from './storyboard-keyframes.js'

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
  /** 实际落到 sys_task 的厂商/模型（model 已回落到配置默认值） */
  provider: string
  model: string
  /** 本次请求的内容签名与分项摘要（批量预览判定“是否变化”） */
  signature: string
  signatureParts: VideoSignatureParts
}

/** 签名分项：变化原因按分项比较得出 */
export interface VideoSignatureParts {
  /** 最终提交的提示词（含风格词；#11 的转场段也写在这里，自动纳入签名） */
  prompt: string
  /** 首/中/尾引导帧文件名 + 中间帧引导时间 */
  guides: string
  /** 参考图文件名（按发送顺序） */
  refs: string
  /** 提交时长（整数秒）/ 画幅 / 分辨率 */
  spec: string
  /** provider + model */
  engine: string
}

export type VideoSignaturePart = keyof VideoSignatureParts

export interface VideoSignatureInput {
  prompt: string
  firstFrameUrl?: string | null
  midFrameUrl?: string | null
  midFrameTime?: number | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string[] | null
  duration: number
  aspectRatio: string
  resolution?: string | null
  provider: string
  model: string
}

const SIGNATURE_PART_LABEL: Record<VideoSignaturePart, string> = {
  prompt: '提示词',
  guides: '关键帧',
  refs: '参考图',
  spec: '时长/画幅',
  engine: '模型',
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * 视频内容签名 = sha256(各分项摘要)。输入来自 buildStoryboardVideoRequest 的最终输出，
 * 所以后续往提交参数里加东西（#11 的转场段进提示词、转场加长后的提交时长）会自动纳入签名，
 * 无需改这里。
 *
 * 注意（#11 联动）：承接镜头“转场尚未审核 → 预览归为 changed”这一条不靠签名判断——
 * 转场文本要到提交前才生成，签名提前算不出来；该规则由 #11 在预览里按审核状态直接标注。
 */
export function computeVideoSignature(input: VideoSignatureInput): {
  signature: string
  parts: VideoSignatureParts
} {
  const parts: VideoSignatureParts = {
    prompt: digest(input.prompt || ''),
    guides: digest([
      refBasename(input.firstFrameUrl || ''),
      refBasename(input.midFrameUrl || ''),
      input.midFrameUrl ? input.midFrameTime ?? null : null,
      refBasename(input.lastFrameUrl || ''),
    ]),
    refs: digest((input.referenceImageUrls || []).map(refBasename)),
    spec: digest([Math.round(Number(input.duration) || 0), input.aspectRatio || '', input.resolution || '']),
    engine: digest([input.provider || '', input.model || '']),
  }
  return { signature: digest(parts), parts }
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

  // 视频提示词的 @引用 必须与绑定一致（Issue #7），否则会出现“提到了却没带参考图”
  const refIssues = computeRefIssues({
    prompts: promptFieldsOf(storyboard),
    assets: await loadEpisodeAssets(storyboard, episode.id),
    sceneId: storyboard.sceneId ?? null,
    characterIds: (await db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))).map(link => link.characterId),
    propIds: (await db.select().from(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboardId))).map(link => link.propId),
  })
  const blocking = blockingIssuesFor(refIssues, 'video_prompt')
  if (blocking.length) {
    throw new Error(`分镜 #${storyboard.storyboardNumber} 的视频提示词与参考图不一致：${describeIssues(blocking)}`)
  }

  // ===== 参考图：首帧关键帧 → 场景 → 角色 → 道具 =====
  const assetRefs = await collectStoryboardAssetRefs(storyboard, episode.id)
  const { urls: referenceImageUrls, nameToIndex } = indexRefs([
    // 关键帧没有名字，不参与 @名字 编号，但占用 1 号位
    { name: '', url: keyframes.first! },
    ...assetRefs,
  ])

  const rawPrompt = (storyboard.videoPrompt || '').trim()
  let prompt = resolvePromptRefs(rawPrompt, nameToIndex, (index, name) => `@图片${index}${name}`)
  if (!prompt && !referenceImageUrls.length) {
    throw new Error('视频生成需要至少一个参考素材或提示词')
  }
  // 项目视觉风格词注入提示词最前方（与图片侧口径一致）
  let sourcePrompt = rawPrompt
  if (prompt) {
    const stylePrompt = await getDramaStylePrompt(episode.dramaId)
    if (stylePrompt) {
      prompt = `${stylePrompt}，\n${prompt}`
      sourcePrompt = `${stylePrompt}，\n${sourcePrompt}`
    }
  }

  // 中间帧引导只有部分模型支持（H3 走 MiniMaxH3AddGuide），不支持的模型只发首尾帧
  const midFrameUrl = adapter.supportsMidFrameGuide ? keyframes.mid || undefined : undefined

  const params = {
    storyboardId,
    dramaId: episode.dramaId,
    prompt,
    model,
    referenceMode: 'reference' as const,
    firstFrameUrl: keyframes.first || undefined,
    episodeId: episode.id,
    sourcePrompt,
    refNameIndex: nameToIndex,
    midFrameUrl,
    midFrameTime: midFrameUrl ? storyboard.midFrameTime ?? undefined : undefined,
    lastFrameUrl: keyframes.last || undefined,
    referenceImageUrls,
    generateAudio: true,
    duration: Number(storyboard.duration || 10),
    aspectRatio: drama?.aspectRatio || '16:9',
    resolution: episode.resolution || undefined,
    configId,
  }

  // 签名取请求的最终输出，与 sys_task 落库的 params 同一份口径
  const resolvedModel = model || config.model || ''
  const { signature, parts } = computeVideoSignature({
    prompt: params.prompt,
    firstFrameUrl: params.firstFrameUrl,
    midFrameUrl: params.midFrameUrl,
    midFrameTime: params.midFrameTime,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    provider: config.provider,
    model: resolvedModel,
  })

  return {
    storyboardId,
    episodeId: episode.id,
    dramaId: episode.dramaId,
    params,
    provider: config.provider,
    model: resolvedModel,
    signature,
    signatureParts: parts,
  }
}

export interface VideoVersion {
  id: number
  /** 任务产出的视频（本地路径优先，与 storyboards.video_url 同一口径） */
  video: string
  created_at: string | null
  /** 按创建时间正序从 1 编号 */
  version_no: number
  /** 早期任务缺字段时为 null（无法比较） */
  signature: string | null
  parts: VideoSignatureParts | null
}

/**
 * 历史版本（sys_task）的签名。#5 之前的任务缺少引导帧/时长等字段时返回 null，
 * 作为 unknown 单列，不报错也不当成“已变化”。
 */
export function videoSignatureFromTask(task: {
  prompt: string | null
  provider: string | null
  model: string | null
  params: string | null
}): { signature: string; parts: VideoSignatureParts } | null {
  if (!task.prompt || !task.provider || !task.model) return null
  let params: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(task.params || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    params = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const firstFrameUrl = typeof params.firstFrameUrl === 'string' ? params.firstFrameUrl : null
  const aspectRatio = typeof params.aspectRatio === 'string' ? params.aspectRatio : null
  const duration = Number(params.duration)
  if (!firstFrameUrl || !aspectRatio || !Number.isFinite(duration) || duration <= 0) return null
  return computeVideoSignature({
    prompt: task.prompt,
    firstFrameUrl,
    midFrameUrl: typeof params.midFrameUrl === 'string' ? params.midFrameUrl : null,
    midFrameTime: typeof params.midFrameTime === 'number' ? params.midFrameTime : null,
    lastFrameUrl: typeof params.lastFrameUrl === 'string' ? params.lastFrameUrl : null,
    referenceImageUrls: Array.isArray(params.referenceImageUrls)
      ? (params.referenceImageUrls as unknown[]).filter((item): item is string => typeof item === 'string')
      : [],
    duration,
    aspectRatio,
    resolution: typeof params.resolution === 'string' ? params.resolution : null,
    provider: task.provider,
    model: task.model,
  })
}

/** 某分镜的历史视频版本（含版本号与签名），按创建时间正序 */
export async function loadVideoVersions(storyboardId: number): Promise<VideoVersion[]> {
  const tasks = (await db.select().from(schema.sysTask))
    .filter(task => task.type === 'video' && task.status === 'completed' && task.storyboardId === storyboardId)
    .filter(task => task.localPath || task.resultUrl)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id - b.id)
  return tasks.map((task, index) => {
    const computed = videoSignatureFromTask(task)
    return {
      id: task.id,
      video: (task.localPath || task.resultUrl)!,
      created_at: task.createdAt,
      version_no: index + 1,
      signature: computed?.signature ?? null,
      parts: computed?.parts ?? null,
    }
  })
}

/** 与某个历史版本逐分项比较，返回变化的分项中文名（用于预览的「变化原因」） */
export function describeSignatureDiff(current: VideoSignatureParts, previous: VideoSignatureParts): string[] {
  return (Object.keys(SIGNATURE_PART_LABEL) as VideoSignaturePart[])
    .filter(part => current[part] !== previous[part])
    .map(part => SIGNATURE_PART_LABEL[part])
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
