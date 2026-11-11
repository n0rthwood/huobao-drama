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
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { getActiveConfig, getConfigById, validateVideoModel, type AIConfig } from './ai.js'
import { getVideoAdapter } from './adapters/registry.js'
import { generateImage, generateVideo } from './generation.js'
import { renderRefPrompt } from './task-center.js'
import { LAYER_SEGMENT_PROVIDER, startLayerSegmentRenderTask, storyboardIdOfSegmentTask } from './layer-segment-task.js'
import { startPosterConcept } from './poster-concept.js'
import {
  createTextTask,
  findLatestTextTask,
  finishTextTask,
  parseTextTaskParams,
  type TextTaskKind,
} from './text-task.js'
import { agentChatStage, resolveStageModel } from './ai-stages.js'
import { resolveDramaProjectType } from './project-type.js'
import { startExtraction, type ExtractTarget } from './extraction.js'
import { startKeyframePromptBatch } from './keyframe-prompts.js'
import { startVideoPromptBatch } from './video-prompts.js'
import { isCoverageGapFailure, startFillGapsTask } from './storyboard-fill-gaps.js'
import type { SysTaskRow } from './sys-task.js'
import { buildStoryboardVideoRequest } from './storyboard-video.js'
import { retryFailedVoiceBatch } from './narration-voice.js'
import { retryFailedLayerRenderBatch } from './layer-render-batch.js'
import { assertShotGate } from './workflow-gates.js'
import { retryFailedComposeBatch } from './shot-compose.js'
import { retryRewriteRun } from './script-rewrite/run.js'
import { startSkeletonGeneration } from './narration-skeleton.js'
import { isFirstAgentFailureSafe, runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-autoretry.js'

export interface RetryOptions {
  configId?: number
  model?: string
}

interface StoredParams {
  config_id?: number
  size?: string
  /** 画幅锁定（Issue #94）：重试必须照样锁，否则重试一次就退回「跟随参考图比例」 */
  aspect_locked?: boolean
  frameType?: string
  referenceImages?: string[]
  sourcePrompt?: string
  refNameIndex?: Record<string, number>
  posterId?: number
  posterGenMode?: 'initial' | 'composite' | 'layers'
  posterConceptComposition?: string
  posterAutoBase?: boolean
  posterSize?: string
  text_prompt?: string
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
    aspectLocked: params.aspect_locked === true,
    referenceImages: params.referenceImages,
    frameType: params.frameType,
    configId: config.id,
    sourcePrompt: params.sourcePrompt,
    refNameIndex: params.refNameIndex,
    retryOf: row.id,
    posterId: params.posterId,
    posterGenMode: params.posterGenMode,
    posterTextPrompt: params.text_prompt,
    posterConceptComposition: params.posterConceptComposition,
    // 重试不改变「推荐方案自动成为临时编辑底图」的一次性语义：只在仍无底图时生效
    posterAutoBase: params.posterAutoBase === true,
    posterSize: params.posterSize,
  })
}

async function retryVideo(row: SysTaskRow, opts: RetryOptions): Promise<number> {
  if (row.storyboardId && row.episodeId) {
    const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
    if (resolveDramaProjectType(episode?.dramaId) === 'documentary') {
      const savedConfigId = storedParams(row.params).config_id
      const request = await buildStoryboardVideoRequest(row.storyboardId, { model: opts.model, configId: opts.configId ?? (Number.isInteger(savedConfigId) ? savedConfigId : undefined) })
      return generateVideo({ ...request.params, retryOf: row.id })
    }
  }
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

  const resolved = await resolveStageModel(
    agentChatStage(agentType, resolveDramaProjectType(row.dramaId ?? 0)),
    opts,
  )
  const taskId = await createTextTask({
    kind,
    episodeId,
    dramaId: row.dramaId,
    prompt: message,
    stageModel: resolved,
    retryOf: row.id,
    queued: true,
    restart: { kind, args: { sourceTaskId: row.id, opts } },
  })
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId: row.dramaId ?? 0,
    textTaskId: taskId,
    modelOverride: resolved.model,
    textConfigId: resolved.configId ?? undefined,
  })
  void runWithTextTask(taskId, () => runAgent(agent, [{ role: 'user', content: message }], { maxSteps: 20, requestContext }, createReasoningSink(taskId)))
    .then(result => finishTextTask(taskId, 'completed', { outputText: result.text || '' }))
    .catch(async err => {
      await finishTextTask(taskId, 'failed', { errorMsg: err instanceof Error ? err.message : String(err) })
      await requeueFirstModelFailure(taskId, err, isFirstAgentFailureSafe(err))
    })
  return taskId
}

async function retryText(row: SysTaskRow, opts: RetryOptions): Promise<number> {
  const params = parseTextTaskParams(row.params)
  const kind = params?.kind
  const episodeId = row.episodeId
  // 地图工作流（#84）的状态机在 props.map_workflow 上，重试要带修订号与阶段语义，
  // 通用重试做不到；给出可操作的说明，绝不建一条注定对不上状态的任务
  if (kind === 'map_workflow') {
    throw new Error('地图工作流任务不支持在任务中心重试：请到该地图资产的工作流面板，从失败的那一步「继续」或先回退再重跑（已产出的底图/成图都保留）')
  }
  if (!kind || !episodeId) throw new Error('该文本任务缺少重试所需的信息')
  const dramaId = row.dramaId ?? 0
  if (kind === 'shot_compose') {
    const result = await retryFailedComposeBatch(episodeId, dramaId, row.id)
    if (!result.started) throw new Error('没有可重试的合成任务')
    const fresh = await findLatestTextTask(episodeId, 'shot_compose')
    if (!fresh) throw new Error('重试任务创建失败')
    return fresh.id
  }
  if (kind === 'narration_tts' || kind === 'layer_render_batch') {
    const result = kind === 'narration_tts'
      ? await retryFailedVoiceBatch(episodeId, dramaId, row.id)
      : await retryFailedLayerRenderBatch(episodeId, dramaId, row.id)
    if (!result.task_id) throw new Error('重试任务未创建')
    return result.task_id
  }

  // 覆盖缺口失败的纪录片拆分任务（#52）：重试 = 补镜，保留已拆分镜只补剩余；
  // 整集重拆仍由分镜页的「拆分分镜」按钮显式发起（语义不变）。
  if (kind === 'storyboard_fill_gaps' || (kind === 'storyboard_breaker' && isCoverageGapFailure(row.errorMsg))) {
    const fill = await startFillGapsTask(episodeId, { model: opts.model, configId: opts.configId, retryOf: row.id })
    if (fill.reason === 'running') throw new Error('该集的拆分/补镜任务正在运行，请等它结束')
    if (fill.reason === 'not_documentary') throw new Error('只有纪录片项目才有补镜')
    if (!fill.started) throw new Error('本集旁白已被分镜全部领走，没有需要补的缺口')
    return fill.taskId!
  }

  // 纪录片剧本改写（#70）：重试 = 从失败的那个阶段续跑一轮分阶段运行，
  // 已完成阶段的版本作为前驱复用。绝不回到旧的同步 chat 通路（那条路会直接写最终稿）。
  if (kind === 'script_rewrite' && resolveDramaProjectType(dramaId) === 'documentary') {
    return retryRewriteRun({ id: row.id, episodeId, params: row.params }, { configId: opts.configId, model: opts.model })
  }

  // 纪录片拆分分镜（#70）：重试 = 重新生成旁白骨架（只拆旁白，不填设计卡），
  // 与分镜页按钮同一条通路：确认门禁、同类任务去重、覆盖校验都在。旧的同步 chat 重试会把
  // 这些全绕开，还会无条件把任务标成完成，纪录片不再走它。
  if (kind === 'storyboard_breaker' && resolveDramaProjectType(dramaId) === 'documentary') {
    const skeleton = await startSkeletonGeneration(episodeId, {
      model: opts.model, configId: opts.configId, retryOf: row.id,
    })
    if (skeleton.reason === 'running') throw new Error('该集的拆分/补镜任务正在运行，请等它结束')
    if (skeleton.reason === 'script_missing') throw new Error('本集还没有最终旁白稿，无法拆分')
    if (!skeleton.started || !skeleton.task_id) throw new Error('重试任务创建失败')
    return skeleton.task_id
  }

  if (kind === 'poster_concept') {
    const started = await startPosterConcept(episodeId, {
      model: opts.model,
      configId: opts.configId,
      retryOf: row.id,
    })
    if (started.reason === 'running') throw new Error('该集的 Poster 构想正在运行，请等它结束')
    if (started.reason === 'empty_script') throw new Error('请先完成剧本改写/拆分，并且本集至少有一个带图的资产')
    if (!started.task_id) throw new Error('重试任务创建失败')
    return started.task_id
  }

  const extractTarget = EXTRACT_TARGET_OF[kind]
  if (extractTarget) {
    const taskId = await startExtraction(episodeId, dramaId, extractTarget, {
      model: opts.model, configId: opts.configId, retryOf: row.id,
    })
    if (taskId === null) throw new Error('该集的同类提取任务正在运行，请等它结束')
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
  // 图层段（#58）不是模型任务：重试 = 用库里当前的图层/精确关键帧重渲染，
  // 绝不进视频 provider/模型校验，也不需要 config_id
  if (row.type === 'video' && row.provider === LAYER_SEGMENT_PROVIDER) {
    const storyboardId = storyboardIdOfSegmentTask(row.params) ?? row.storyboardId ?? null
    if (!storyboardId) throw new Error('图层段任务缺少分镜 id，无法重渲染')
    await assertShotGate(storyboardId, 'production')
    const outcome = await startLayerSegmentRenderTask(storyboardId)
    return outcome.task_id
  }
  if (row.type === 'video') return retryVideo(row, opts)
  if (row.type === 'text') return retryText(row, opts)
  throw new Error(`不支持重试的任务类型：${row.type}`)
}
