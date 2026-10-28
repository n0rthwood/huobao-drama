/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { db, getInsertId, schema } from '../db/index.js'
import { and, eq, inArray } from 'drizzle-orm'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, readImageAsDataUrl, saveBase64Image, saveImageBuffer } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { authHeaders } from './adapters/comfyui-client'
import { getImageAdapter, getVideoAdapter } from './adapters/registry'
import type { AIConfig, ImageGenerationRecord, VideoGenerationRecord } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { FRAME_TYPE_SLOT, invalidateKeyframeConfirmation } from './keyframes.js'
import { completionStamp } from './media-time.js'
import { saveStylingVersion } from './styling-version.js'
import {
  cancelQwenJob,
  createQwenJob,
  evictQwenFileIds,
  pickQwenSize,
  QWEN_MAX_REFS,
  QwenJobsError,
  uploadReferenceImage,
  withReferenceHint,
  type QwenJobMode,
  type QwenJobRequest,
} from './adapters/qwen-jobs-client.js'
import {
  ACTIVE_TASK_STATUSES,
  isActiveTaskStatus,
  isQwenJobsTask,
  mapRemoteStatus,
  parseRemoteState,
  patchTaskRemoteState,
  qwenIdempotencyKey,
  remoteSnapshot,
} from './sys-task.js'

/** ComfyUI 公网网关的 /view 取件要带网关鉴权头；其它 provider 的输出直链无需鉴权。
 *  四个完成回调调用点需保持同一行为，故收敛成一处。 */
function downloadHeaders(config: AIConfig): Record<string, string> | undefined {
  return config.provider.toLowerCase() === 'comfyui' ? authHeaders(config) : undefined
}

type TaskType = 'image' | 'video'

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: null },
}

/**
 * 重试相关的可选字段（全链路共用）：
 * - episodeId：任务归属集，供全局任务中心按集筛选/编号
 * - sourcePrompt：渲染前的源提示词（含风格前缀，@名字 未解析），换厂商重试时据此重新渲染
 * - refNameIndex：资产名 → 参考图序号（1 基），重新渲染引用格式时用
 * - retryOf：来源任务 id
 */
interface TaskOriginParams {
  episodeId?: number
  sourcePrompt?: string
  refNameIndex?: Record<string, number>
  retryOf?: number
}

interface GenerateImageParams extends TaskOriginParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
  /**
   * 角色造型版本出图（Issue #15）：仍带 characterId（任务落在该角色的版本历史里），
   * 但完成后只回写 episode_characters.styling_version.image_path，**不动**角色基础形象图。
   */
  characterVersion?: { episodeId: number; name: string }
}

interface GenerateVideoParams extends TaskOriginParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  /** 中间关键帧引导（仅 supportsMidFrameGuide 的模型会收到） */
  midFrameUrl?: string
  midFrameTime?: number
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  /** #11 开场转场：T=转场秒数，E=本次实际加长的秒数（duration 已含 E） */
  transition?: { T: number; E: number }
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置，避免生成被旧引用卡死
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('image')
    : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    episodeId: await resolveEpisodeId(params),
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages,
    characterVersion: params.characterVersion,
    ...originParams(params),
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置
  const config = params.configId
    ? (await getConfigById(params.configId)) ?? await getActiveConfig('video')
    : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')

  const id = await createTask('video', config, {
    storyboardId: params.storyboardId,
    episodeId: await resolveEpisodeId(params),
    dramaId: params.dramaId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    referenceMode: params.referenceMode || 'reference',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    midFrameUrl: params.midFrameUrl,
    midFrameTime: params.midFrameTime,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls,
    referenceVideoUrls: params.referenceVideoUrls,
    referenceAudioUrls: params.referenceAudioUrls,
    generateAudio: params.generateAudio === false ? 0 : 1,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
    resolution: normalizeStoredVideoResolution(params.resolution),
    seed: params.seed,
    promptExtend: params.promptExtend,
    watermark: params.watermark,
    transition: params.transition,
    ...originParams(params),
  })

  logTaskStart('VideoTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'reference',
    duration: params.duration || 5,
  })
  logTaskPayload('VideoTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

/**
 * 任务归属集：显式传入优先，否则由分镜反查（分镜任务必有集，资产出图可空）。
 */
async function resolveEpisodeId(params: TaskOriginParams & { storyboardId?: number }): Promise<number | undefined> {
  if (params.episodeId) return params.episodeId
  if (!params.storyboardId) return undefined
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, params.storyboardId))
  return sb?.episodeId ?? undefined
}

/** 换厂商重试需要的溯源字段，只在有值时写入 params */
function originParams(params: TaskOriginParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (params.sourcePrompt) out.sourcePrompt = params.sourcePrompt
  if (params.refNameIndex && Object.keys(params.refNameIndex).length) out.refNameIndex = params.refNameIndex
  if (params.retryOf) out.retry_of = params.retryOf
  return out
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    episodeId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  const ts = now()
  const res = await db.insert(schema.sysTask).values({
    type,
    ...fields,
    provider: config.provider,
    params: JSON.stringify(params),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })

  const id = getInsertId(res)
  processTask(id, config).catch(err => {
    logTaskError(taskLabel(type), 'process', { id, error: err.message })
    console.error(`${taskLabel(type)} ${id} failed:`, err)
  })
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function processTask(id: number, config: AIConfig) {
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown

    if (type === 'image') {
      // qwen-jobs：服务端排队的任务 API，提交后由追踪器（services/qwen-jobs.ts）按远端 id 跟踪
      if (isQwenJobsTask(config.provider)) {
        // 追踪器可能已经抢先在恢复这一行（3 s 一拍）：同一任务只允许一个提交在途
        if (inFlightQwenSubmits.has(record.id)) return
        inFlightQwenSubmits.add(record.id)
        try {
          await submitQwenJobsImage(record, config, params)
        } finally {
          inFlightQwenSubmits.delete(record.id)
        }
        return
      }
      const adapter = getImageAdapter(config.provider)
      const resolvedReferenceImages = await normalizeReferenceImages(params.referenceImages)
      const imageRecord: ImageGenerationRecord = {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      }
      const preparedImage = adapter.prepare ? await adapter.prepare(config, imageRecord) : imageRecord
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, preparedImage))
    } else {
      const adapter = getVideoAdapter(config.provider)
      const resolvedImageUrl = await normalizeVideoReferenceUrl(params.imageUrl)
      const resolvedFirstFrameUrl = await normalizeVideoReferenceUrl(params.firstFrameUrl)
      const resolvedMidFrameUrl = await normalizeVideoReferenceUrl(params.midFrameUrl)
      const resolvedLastFrameUrl = await normalizeVideoReferenceUrl(params.lastFrameUrl)
      const resolvedReferenceImageUrls = await normalizeVideoReferenceUrls(params.referenceImageUrls)
      // 参考视频/音频文件较大，不适合 dataURL 内联，需解析为公网可访问 URL
      const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      const resolvedReferenceAudioUrls = resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
      const videoRecord: VideoGenerationRecord = {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        midFrameUrl: resolvedMidFrameUrl,
        midFrameTime: params.midFrameTime,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        generateAudio: params.generateAudio,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
      }
      // 可选预处理（如 ComfyUI：上传参考图、扩写提示词）；抛错落入 catch 写入 error_msg
      const prepared = adapter.prepare ? await adapter.prepare(config, videoRecord) : videoRecord
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, prepared))
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
    })

    const resp = await fetch(url, {
      method,
      headers,
      body: isMultipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })

    if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`)
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl, downloadHeaders(config))
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      await handleVideoComplete(record, videoUrl, params.duration, downloadHeaders(config))
      return
    }

    await markPolling(id, taskId)
    pollTask(record, config, taskId!)
  } catch (err: any) {
    await failTask(id, err.message)
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

export async function failTask(id: number, message: string) {
  logTaskError('SysTask', 'failed', { id, error: message })
  // 终态不覆盖：用户取消过的任务不能再被迟到的失败改写
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: message, updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES)))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

/** 本进程正在提交（上传参考图 → POST /v1/jobs）的任务：追踪器据此不重复提交 */
const inFlightQwenSubmits = new Set<number>()

/**
 * qwen-jobs 提交：先把完整请求体（含已上传的 file id）落盘到 remote_state.request，
 * 再调 POST /v1/jobs —— 提交途中重启时启动恢复可按同一幂等键原样重发（服务端去重）。
 * 参考图被服务端回收（422 unknown reference image）时清掉 file id 缓存并重传一次。
 */
async function submitQwenJobsImage(record: SysTaskRecord, config: AIConfig, params: Record<string, any>) {
  const refs = await normalizeReferenceImages(params.referenceImages)
  if (refs.length > QWEN_MAX_REFS) {
    throw new Error(`参考图超限：共 ${refs.length} 张，单次最多 ${QWEN_MAX_REFS} 张，请减少绑定的角色/场景/道具`)
  }
  // 已落盘过请求的（重启恢复后走完整提交路径）沿用原键，否则新生成
  const idempotencyKey = parseRemoteState(record.remoteState).idempotency_key || qwenIdempotencyKey(record.id)

  for (let attempt = 1; attempt <= 2; attempt++) {
    const fileIds: string[] = []
    for (const ref of refs) fileIds.push(await uploadReferenceImage(config, ref))

    // 关键帧（frameType 命中槽位）必须按剧集画幅出图 → reference_to_image；
    // 角色/道具的编辑跟随第 1 张参考图 → image_edit（不能带 width/height）
    const isKeyframe = !!FRAME_TYPE_SLOT[String(params.frameType || '')]
    const mode: QwenJobMode = !fileIds.length ? 'text_to_image' : isKeyframe ? 'reference_to_image' : 'image_edit'
    const [width, height] = pickQwenSize(params.size)
    const body: QwenJobRequest = {
      mode,
      prompt: withReferenceHint(record.prompt || '', fileIds.length),
      metadata: { sys_task_id: String(record.id) },
      ...(mode === 'image_edit' ? {} : { width, height }),
      ...(fileIds.length ? { reference_images: fileIds } : {}),
    }
    const row = await patchTaskRemoteState(
      record.id,
      { request: body, config_id: config.id, idempotency_key: idempotencyKey },
      { status: 'queued' },
    )
    // 上传期间被取消：请求体已落盘但不提交，追踪器也只看活跃任务
    if (!row || !isActiveTaskStatus(row.status)) {
      logTaskWarn('ImageTask', 'qwen-jobs submit skipped (cancelled)', { id: record.id, status: row?.status })
      return
    }
    logTaskPayload('ImageTask', 'qwen-jobs request', { id: record.id, body })
    const result = await sendQwenJob(record.id, config, body, idempotencyKey)
    // 服务端已回收参考文件：缓存已在 sendQwenJob 里清掉，重新上传后再提交一次
    if (result !== 'stale_refs') return
    logTaskWarn('ImageTask', 'qwen-jobs re-upload refs', { id: record.id, attempt })
  }
  await failTask(record.id, '参考图已被服务端回收，重新上传后仍然提交失败，请重试')
}

type SendResult = 'submitted' | 'retry_later' | 'stale_refs' | 'failed'

/**
 * 调远端建任务并立即落盘远端 id。
 * 422 unknown reference（参考文件被回收）可重传一次；409 幂等冲突是终态。
 * 网络错误/5xx/网关抖动/429 queue_full 都不是终态：请求体已落盘，任务保持 queued
 * 且没有 task_id，追踪器下一拍按同一幂等键原样重发（服务端对失败请求不记幂等键）。
 */
async function sendQwenJob(
  id: number,
  config: AIConfig,
  body: QwenJobRequest,
  idempotencyKey: string,
): Promise<SendResult> {
  try {
    const job = await createQwenJob(config, body, idempotencyKey)
    const row = await patchTaskRemoteState(id, remoteSnapshot(job), {
      taskId: job.id,
      status: mapRemoteStatus(job.status) ?? 'processing',
    })
    // 提交在途时本地已终结（取消/失败）：远端任务马上取消，别让它白占一张卡
    if (row && !isActiveTaskStatus(row.status)) {
      logTaskWarn('ImageTask', 'qwen-jobs cancel after local terminal', { id, jobId: job.id, status: row.status })
      await patchTaskRemoteState(id, { cancel_pending: true })
      await cancelQwenJob(config, job.id).catch(err => {
        // 取消失败：cancel_pending 已落盘，追踪器会接着重试
        logTaskWarn('ImageTask', 'qwen-jobs cancel retry', { id, jobId: job.id, error: err instanceof Error ? err.message : String(err) })
      })
      return 'submitted'
    }
    logTaskProgress('ImageTask', 'qwen-jobs submitted', { id, jobId: job.id, status: job.status })
    return 'submitted'
  } catch (err) {
    if (err instanceof QwenJobsError && err.transient) {
      logTaskWarn('ImageTask', 'qwen-jobs submit retry', { id, error: err.message })
      return 'retry_later'
    }
    if (err instanceof QwenJobsError && (err.status === 409 || err.status === 422)) {
      const refs = body.reference_images ?? []
      const evicted = evictQwenFileIds(refs)
      if (err.status === 422 && refs.length) {
        logTaskWarn('ImageTask', 'qwen-jobs stale refs', { id, evicted, error: err.message })
        return 'stale_refs'
      }
      await failTask(id, `${err.message}（请重试，将重新上传参考图并新建任务）`)
      return 'failed'
    }
    throw err
  }
}

/**
 * 追踪器驱动的恢复（含启动恢复）：
 * - remote_state.request 已落盘但没有远端 id（提交途中重启）→ 按同一幂等键原样重发；
 * - 连请求体都没有（createTask 后、上传参考图途中重启）→ 用 sys_task.params 走完整提交路径；
 *   这种行从未调过 POST /v1/jobs，新生成幂等键即可（键随请求体一起落盘）。
 * 本进程正在提交的任务直接跳过，避免追踪器与提交线程重复上传。
 */
export async function resumeQwenJobsTask(row: SysTaskRecord, config: AIConfig): Promise<void> {
  if (inFlightQwenSubmits.has(row.id)) return
  inFlightQwenSubmits.add(row.id)
  try {
    const state = parseRemoteState(row.remoteState)
    const idempotencyKey = state.idempotency_key || qwenIdempotencyKey(row.id)
    if (state.request) {
      logTaskProgress('ImageTask', 'qwen-jobs resubmit', { id: row.id, idempotencyKey })
      const result = await sendQwenJob(row.id, config, state.request, idempotencyKey)
      if (result !== 'stale_refs') return
      // 参考文件已被回收：回到完整提交路径重新上传
    }
    logTaskProgress('ImageTask', 'qwen-jobs resume submit', { id: row.id, idempotencyKey })
    await submitQwenJobsImage(row, config, parseTaskParams(row.params))
  } catch (err) {
    if (err instanceof QwenJobsError && err.transient) {
      logTaskWarn('ImageTask', 'qwen-jobs resume retry', { id: row.id, error: err.message })
      return
    }
    await failTask(row.id, err instanceof Error ? err.message : String(err))
  } finally {
    inFlightQwenSubmits.delete(row.id)
  }
}

/**
 * 远端输出取回后落盘并走与其它 provider 相同的完成链路（落盘成功才标 completed）。
 * 下载期间任务可能已被取消：completed 只在任务仍活跃时落库，否则不写回任何图片。
 */
export async function completeImageTaskFromBytes(record: SysTaskRecord, bytes: Buffer, contentType: string) {
  const localPath = await saveImageBuffer(bytes, contentType, 'images')
  await generateImageThumb(localPath)
  const res = await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', ...completionStamp(), updatedAt: now() })
    .where(and(eq(schema.sysTask.id, record.id), inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES)))
  if (!(res?.changes ?? 0)) {
    logTaskWarn('ImageTask', 'completion dropped (task no longer active)', { id: record.id, status: record.status })
    return
  }
  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })
  await writeBackImageAssets(record, localPath)
}

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = POLL_PROFILES[type]
  const adapter = type === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result, config)

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl, downloadHeaders(config))
            return
          }
          if (adapter.provider === 'gemini') {
            // Gemini 可能返回 base64
            const b64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
          }
        } else if (pollResp.videoUrl) {
          logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: pollResp.videoUrl })
          await handleVideoComplete(record, pollResp.videoUrl, pollResp.duration, downloadHeaders(config))
          return
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        await failTask(record.id, pollResp.error || 'Generation failed')
        return
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted')
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string, headers?: Record<string, string>) {
  const localPath = await downloadFile(imageUrl, 'images', headers)
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', ...completionStamp(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', ...completionStamp(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const slot = FRAME_TYPE_SLOT[String(params.frameType || '')]
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (slot === 'first') sbUpdate.firstFrameImage = localPath
    else if (slot === 'mid') sbUpdate.midFrameImage = localPath
    else if (slot === 'last') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
    // 新关键帧自动成为该槽位的选定版本 → 之前的人工确认作废（并连带继承它的下一镜）
    if (slot) await invalidateKeyframeConfirmation(record.storyboardId)
  }
  if (record.characterId) {
    // 造型版本出图（Issue #15）：只回写本集造型图，基础形象图保持不变
    const version = params.characterVersion as { episodeId?: number; name?: string } | undefined
    if (version?.episodeId && version.name) {
      const saved = await saveStylingVersion(Number(version.episodeId), record.characterId, { name: version.name, image_path: localPath })
      // 造型图是关键帧/视频绑定里角色的默认图（读时解析，Issue #18），无需回写选版
      if (saved) {
        logTaskSuccess('ImageTask', 'styling-version-image', { id: record.id, characterId: record.characterId, episodeId: version.episodeId, name: version.name })
      }
      // 关联行被删（角色已从本集移除）：图片仍在任务历史里，但无处落版本
      else logTaskWarn('ImageTask', 'styling-version-link-missing', { id: record.id, characterId: record.characterId, episodeId: version.episodeId })
    } else {
      await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
    }
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
  }
}

async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined, headers?: Record<string, string>) {
  const localPath = await downloadFile(videoUrl, 'videos', headers)
  // 海报帧供列表/封面展示，避免前端为显示首帧缓冲整个视频
  await extractVideoPoster(localPath)
  await db.update(schema.sysTask)
    .set({ resultUrl: videoUrl, localPath, status: 'completed', ...completionStamp(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('VideoTask', 'downloaded', { id: record.id, localPath, storyboardId: record.storyboardId, duration })

  if (record.storyboardId) {
    // storyboards.duration 是「内容时长」：带转场提交时视频比它长 E 秒（#11），
    // 把返回时长写回会让下次生成再叠加一次转场，所以只写视频地址。
    await db.update(schema.storyboards)
      .set({ videoUrl: localPath, updatedAt: now() })
      .where(eq(schema.storyboards.id, record.storyboardId))
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  // 不做张数截断：厂商上限由各 adapter 明确报错（静默丢参考图会让用户得到无法解释的结果）
  return normalized.filter((item): item is string => !!item)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      // 视频参考图直接编码原文件，保留原始尺寸、格式、透明通道和画质。
      return readImageAsDataUrl(localPath)
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : '音频'
      throw new Error(
        `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游视频生成 API 无法访问内网地址。` +
        `请在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL。`,
      )
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return `${base}${p}`
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  return undefined
}
