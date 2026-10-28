/**
 * 任务中心「换模型重试」—— 只允许改模型/厂商配置，提示词与参考输入沿用原任务。
 *
 * 一律新建 sys_task（qwen-jobs 幂等键要求），新任务 params.retry_of 记录来源。
 * 换厂商时 @名字 的引用写法不同（Qwen `<imageN>` vs 其它 `图片N`），
 * 故优先用原任务保存的源提示词（params.sourcePrompt + refNameIndex）按新 provider 重新渲染；
 * 旧任务没有源提示词时直接复用它的最终提示词。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { getActiveConfig, getConfigById, validateVideoModel, type AIConfig } from './ai.js'
import { getVideoAdapter } from './adapters/registry.js'
import { generateImage, generateVideo } from './generation.js'
import { renderRefPrompt } from './task-center.js'
import {
  createTextTask,
  findLatestTextTask,
  finishTextTask,
  resolveTextModel,
  parseTextTaskParams,
  type TextTaskKind,
} from './text-task.js'
import { startExtraction, type ExtractTarget } from './extraction.js'
import { startKeyframePromptBatch } from './keyframe-prompts.js'
import { startVideoPromptBatch } from './video-prompts.js'
import type { SysTaskRow } from './sys-task.js'

export interface RetryOptions {
  configId?: number
  model?: string
}

interface StoredParams {
  size?: string
  frameType?: string
  referenceImages?: string[]
  sourcePrompt?: string
  refNameIndex?: Record<string, number>
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  midFrameUrl?: string
  midFrameTime?: number
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  generateAudio?: number
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
}

function storedParams(raw: string | null | undefined): StoredParams {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as StoredParams : {}
  } catch {
    return {}
  }
}

async function resolveConfig(serviceType: 'image' | 'video', configId?: number): Promise<AIConfig> {
  const config = configId
    ? (await getConfigById(configId)) ?? await getActiveConfig(serviceType)
    : await getActiveConfig(serviceType)
  if (!config) {
    throw new Error(serviceType === 'image'
      ? '未配置图片模型，请先到「设置」页添加并启用 AI 服务'
      : '未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  }
  return config
}

/** 重试用的提示词：有源提示词就按新 provider 重新渲染 @引用，否则复用原最终提示词 */
function promptForRetry(row: SysTaskRow, params: StoredParams, type: 'image' | 'video', provider: string): string {
  if (params.sourcePrompt && params.refNameIndex) {
    return renderRefPrompt(params.sourcePrompt, params.refNameIndex, { type, provider })
  }
  return row.prompt || ''
}

async function retryImage(row: SysTaskRow, opts: RetryOptions): Promise<number> {
  const params = storedParams(row.params)
  const config = await resolveConfig('image', opts.configId)
  return generateImage({
    storyboardId: row.storyboardId ?? undefined,
    episodeId: row.episodeId ?? undefined,
    dramaId: row.dramaId ?? undefined,
    sceneId: row.sceneId ?? undefined,
    characterId: row.characterId ?? undefined,
    propId: row.propId ?? undefined,
    prompt: promptForRetry(row, params, 'image', config.provider),
    model: opts.model || (opts.configId ? undefined : row.model || undefined),
    size: params.size,
    referenceImages: params.referenceImages,
    frameType: params.frameType,
    configId: config.id,
    sourcePrompt: params.sourcePrompt,
    refNameIndex: params.refNameIndex,
    retryOf: row.id,
  })
}

async function retryVideo(row: SysTaskRow, opts: RetryOptions): Promise<number> {
  const params = storedParams(row.params)
  const config = await resolveConfig('video', opts.configId)
  const model = opts.model || (opts.configId ? undefined : row.model || undefined)

  const modelError = validateVideoModel(config.provider, model || config.model)
  if (modelError) throw new Error(modelError)

  const adapter = getVideoAdapter(config.provider)
  const usesFrameGuides = !!(params.firstFrameUrl || params.lastFrameUrl || params.midFrameUrl || params.imageUrl)
  if (usesFrameGuides && !adapter.supportsFrameGuides) {
    throw new Error(`当前视频模型不支持关键帧引导（${config.provider}），请改用 MiniMax-H3 等支持的模型`)
  }

  return generateVideo({
    storyboardId: row.storyboardId ?? undefined,
    episodeId: row.episodeId ?? undefined,
    dramaId: row.dramaId ?? undefined,
    prompt: promptForRetry(row, params, 'video', config.provider),
    model,
    referenceMode: params.referenceMode,
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    // 中间帧引导只有部分模型支持：换到不支持的模型时只发首尾帧（与组装链路同口径）
    midFrameUrl: adapter.supportsMidFrameGuide ? params.midFrameUrl : undefined,
    midFrameTime: adapter.supportsMidFrameGuide ? params.midFrameTime : undefined,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls,
    referenceVideoUrls: params.referenceVideoUrls,
    referenceAudioUrls: params.referenceAudioUrls,
    generateAudio: params.generateAudio !== 0,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    seed: params.seed,
    promptExtend: params.promptExtend,
    watermark: params.watermark,
    configId: config.id,
    sourcePrompt: params.sourcePrompt,
    refNameIndex: params.refNameIndex,
    retryOf: row.id,
  })
}

const EXTRACT_TARGET_OF: Record<string, ExtractTarget> = {
  extract_characters: 'characters',
  extract_scenes: 'scenes',
  extract_props: 'props',
}

const CHAT_AGENT_OF: Record<string, string> = {
  script_rewrite: 'script_rewriter',
  storyboard_breaker: 'storyboard_breaker',
}

/**
 * 同步 chat 型文本任务（剧本改写 / 拆分分镜）的后台重试：
 * 结果由 Agent 工具直接写库，等效于在原页面换模型再点一次（会覆盖本集剧本/分镜，用户已确认）。
 */
async function retryChatText(row: SysTaskRow, kind: TextTaskKind, episodeId: number, opts: RetryOptions): Promise<number> {
  const message = (row.prompt || '').trim()
  if (!message) throw new Error('原任务没有保存提示词，无法重试')
  const agentType = CHAT_AGENT_OF[kind]
  const agent = mastra.getAgent(agentType)
  if (!agent) throw new Error('Agent 不存在')

  const resolved = await resolveTextModel(opts)
  const taskId = await createTextTask({
    kind,
    episodeId,
    dramaId: row.dramaId,
    prompt: message,
    provider: resolved.provider,
    model: resolved.model,
    configId: opts.configId ?? resolved.configId ?? undefined,
    retryOf: row.id,
  })
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId: row.dramaId ?? 0,
    modelOverride: opts.model || undefined,
    textConfigId: opts.configId || undefined,
  })
  runAgent(agent, [{ role: 'user', content: message }], { maxSteps: 20, requestContext })
    .then(() => finishTextTask(taskId, 'completed'))
    .catch((err: unknown) => finishTextTask(taskId, 'failed', {
      errorMsg: err instanceof Error ? err.message : 'Agent 执行失败',
    }))
  return taskId
}

async function retryText(row: SysTaskRow, opts: RetryOptions): Promise<number> {
  const params = parseTextTaskParams(row.params)
  const kind = params?.kind
  const episodeId = row.episodeId
  if (!kind || !episodeId) throw new Error('该文本任务缺少重试所需的信息')
  const dramaId = row.dramaId ?? 0

  const extractTarget = EXTRACT_TARGET_OF[kind]
  if (extractTarget) {
    const started = await startExtraction(episodeId, dramaId, extractTarget, {
      model: opts.model, configId: opts.configId, retryOf: row.id,
    })
    if (!started) throw new Error('该集的同类提取任务正在运行，请等它结束')
  } else if (kind === 'keyframe_prompts' || kind === 'video_prompts') {
    const start = kind === 'keyframe_prompts' ? startKeyframePromptBatch : startVideoPromptBatch
    const result = await start(episodeId, dramaId, {
      model: opts.model, configId: opts.configId, retryOf: row.id,
    }, params?.storyboardIds)
    if (!result.started) {
      throw new Error(result.total === -1 ? '该集的同类提示词任务正在运行，请等它结束' : '没有需要生成提示词的分镜')
    }
  } else {
    return retryChatText(row, kind, episodeId, opts)
  }

  const fresh = await findLatestTextTask(episodeId, kind)
  if (!fresh) throw new Error('重试任务创建失败')
  return fresh.id
}

/** 重试任务，返回新建 sys_task 的 id */
export async function retryTask(taskId: number, opts: RetryOptions): Promise<number> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!row) throw new Error('任务不存在')
  if (row.type === 'image') return retryImage(row, opts)
  if (row.type === 'video') return retryVideo(row, opts)
  if (row.type === 'text') return retryText(row, opts)
  throw new Error(`不支持重试的任务类型：${row.type}`)
}
