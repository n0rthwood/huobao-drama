import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { getActiveConfig, getConfigById, validateVideoModel } from '../services/ai.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { serializeTask, serializeTasks } from '../services/sys-task.js'
import { cancelImageTask, discardRemoteJob } from '../services/qwen-jobs.js'
import { enrichTask, listActiveTasks, listTaskCenter } from '../services/task-center.js'
import { retryTask } from '../services/task-retry.js'
import { completionStamp } from '../services/media-time.js'

const app = new Hono()

type TaskType = 'image' | 'video'

const videoRequestSchema = z.object({
  prompt: z.string().optional().default(''),
  model: z.string().optional(),
  image_url: z.string().optional(),
  first_frame_url: z.string().optional(),
  last_frame_url: z.string().optional(),
  reference_image_urls: z.array(z.string().trim().min(1)).max(9, '参考素材超限：图片≤9、视频≤3、音频≤3').optional().default([]),
  reference_video_urls: z.array(z.string().trim().min(1)).max(3, '参考素材超限：图片≤9、视频≤3、音频≤3').optional().default([]),
  reference_audio_urls: z.array(z.string().trim().min(1)).max(3, '参考素材超限：图片≤9、视频≤3、音频≤3').optional().default([]),
  generate_audio: z.boolean().optional(),
  duration: z.number().optional(),
  aspect_ratio: z.string().optional(),
  resolution: z.string().optional(),
  seed: z.number().optional(),
  prompt_extend: z.boolean().optional(),
  watermark: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.reference_audio_urls.length > 0 && data.reference_image_urls.length + data.reference_video_urls.length === 0) {
    ctx.addIssue({ code: 'custom', message: '参考音频需要至少 1 个参考图片或视频' })
  }
  if (!data.prompt.trim() && data.reference_image_urls.length + data.reference_video_urls.length + data.reference_audio_urls.length === 0
    && !data.first_frame_url && !data.last_frame_url) {
    ctx.addIssue({ code: 'custom', message: '视频生成需要至少一个参考素材或 prompt' })
  }
})

type VideoRequest = z.infer<typeof videoRequestSchema>

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const type = body.type
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type 必须为 image 或 video')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, '提示词必填')
  }

  const parsedVideoBody = type === 'video' ? videoRequestSchema.safeParse(body) : null
  if (parsedVideoBody && !parsedVideoBody.success) {
    return badRequest(c, parsedVideoBody.error.issues[0]?.message || '视频生成请求无效')
  }
  const videoBody: VideoRequest | null = parsedVideoBody?.success ? parsedVideoBody.data : null

  try {
    // 请求显式指定 config_id（工作台模型下拉跨厂商切换）时优先；
    // 未指定才回退到集锁定配置，避免锁定配置与所选模型错配（如锁定 Seedance 却传 MiniMax 模型名）
    let configId: number | undefined = body.config_id
    let episodeResolution: string | undefined
    let storyboardDramaId: number | undefined
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        if (locked != null && configId == null) configId = locked
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution
        storyboardDramaId = ep?.dramaId ?? undefined
      }
    }

    if (type === 'video' && videoBody) {
      const effectiveConfig = configId
        ? (await getConfigById(configId)) ?? await getActiveConfig('video')
        : await getActiveConfig('video')
      const modelError = validateVideoModel(effectiveConfig?.provider, videoBody.model || effectiveConfig?.model)
      if (modelError) return badRequest(c, modelError)
    }

    logTaskStart('TaskAPI', 'generate', {
      type,
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
    })
    logTaskPayload('TaskAPI', 'request body', body)

    // 视频生成时把项目视觉风格词注入提示词最前方（与图片侧的自动注入保持一致口径）
    let videoPrompt = videoBody?.prompt ?? ''
    if (type === 'video' && String(videoPrompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const stylePrompt = await getDramaStylePrompt(dramaId)
      if (stylePrompt) videoPrompt = `${stylePrompt}，\n${videoPrompt}`
    }

    const id = type === 'image'
      ? await generateImage({
        storyboardId: body.storyboard_id,
        episodeId: body.episode_id ? Number(body.episode_id) : undefined,
        dramaId: body.drama_id,
        sceneId: body.scene_id,
        characterId: body.character_id,
        prompt: body.prompt,
        model: body.model,
        size: body.size,
        referenceImages: body.reference_images,
        frameType: body.frame_type,
        configId,
      })
      : await generateVideo({
        storyboardId: body.storyboard_id,
        episodeId: body.episode_id ? Number(body.episode_id) : undefined,
        dramaId: body.drama_id,
        prompt: videoPrompt,
        model: videoBody!.model,
        referenceMode: 'reference',
        imageUrl: videoBody!.image_url,
        firstFrameUrl: videoBody!.first_frame_url,
        lastFrameUrl: videoBody!.last_frame_url,
        referenceImageUrls: videoBody!.reference_image_urls,
        referenceVideoUrls: videoBody!.reference_video_urls,
        referenceAudioUrls: videoBody!.reference_audio_urls,
        generateAudio: videoBody!.generate_audio,
        duration: videoBody!.duration,
        aspectRatio: videoBody!.aspect_ratio,
        resolution: episodeResolution || videoBody!.resolution,
        seed: videoBody!.seed,
        promptExtend: videoBody!.prompt_extend,
        watermark: videoBody!.watermark,
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(eq(schema.sysTask.id, id))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record ? serializeTask(record) : null)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '生成任务失败'
    logTaskError('TaskAPI', 'generate', { type, error: message })
    return badRequest(c, message)
  }
})

// POST /tasks/register-upload — 把手动上传的资产图片纳入同一版本历史
app.post('/register-upload', async (c) => {
  const body = await c.req.json()
  const kind = String(body.asset_type || '')
  const assetId = Number(body.asset_id)
  const localPath = String(body.local_path || '').trim()
  // 从素材库选图走同一注册入口，只在 params 里区分来源（source=media-library + 源图路径）
  const fromLibrary = String(body.source || '') === 'media-library'
  const copiedFrom = String(body.copied_from || '').trim()
  if (!['character', 'scene', 'prop'].includes(kind)) return badRequest(c, 'asset_type 必须是 character / scene / prop')
  if (!assetId || !localPath.startsWith('static/')) return badRequest(c, 'asset_id 与有效的 static 本地路径必填')

  const ownerFields: { characterId?: number; sceneId?: number; propId?: number } = {}
  let dramaId: number | null = null
  if (kind === 'character') {
    const [asset] = await db.select().from(schema.characters).where(eq(schema.characters.id, assetId))
    if (!asset || asset.deletedAt) return badRequest(c, '角色不存在')
    ownerFields.characterId = assetId
    dramaId = asset.dramaId
    await db.update(schema.characters).set({ imageUrl: localPath, localPath, updatedAt: now() }).where(eq(schema.characters.id, assetId))
  } else if (kind === 'scene') {
    const [asset] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, assetId))
    if (!asset || asset.deletedAt) return badRequest(c, '场景不存在')
    ownerFields.sceneId = assetId
    dramaId = asset.dramaId
    await db.update(schema.scenes).set({ imageUrl: localPath, localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, assetId))
  } else {
    const [asset] = await db.select().from(schema.props).where(eq(schema.props.id, assetId))
    if (!asset || asset.deletedAt) return badRequest(c, '道具不存在')
    ownerFields.propId = assetId
    dramaId = asset.dramaId
    await db.update(schema.props).set({ imageUrl: localPath, localPath, updatedAt: now() }).where(eq(schema.props.id, assetId))
  }

  const ts = now()
  const result = await db.insert(schema.sysTask).values({
    type: 'image',
    ...ownerFields,
    dramaId,
    provider: 'upload',
    model: 'manual-upload',
    params: JSON.stringify(fromLibrary
      ? { source: 'media-library', copied_from: copiedFrom || undefined }
      : { source: 'manual-upload' }),
    resultUrl: localPath,
    localPath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    ...completionStamp(ts),
  })
  return created(c, { id: getInsertId(result), local_path: localPath })
})

// GET /tasks/center — 全局任务中心列表（含批次父行与导出行，分页）
// 注意：必须注册在 /:id 之前，否则 center / active 会被当成任务 id
app.get('/center', async (c) => {
  const typeParam = c.req.query('type')
  const statusParam = c.req.query('status')
  const type = typeParam === 'image' || typeParam === 'video' || typeParam === 'text' ? typeParam : undefined
  const status = statusParam === 'active' || statusParam === 'completed' || statusParam === 'failed' || statusParam === 'cancelled'
    ? statusParam
    : undefined
  const data = await listTaskCenter({
    dramaId: c.req.query('drama_id') ? Number(c.req.query('drama_id')) : undefined,
    episodeId: c.req.query('episode_id') ? Number(c.req.query('episode_id')) : undefined,
    type,
    status,
    scope: c.req.query('scope') === 'all' ? 'all' : 'recent',
    page: c.req.query('page') ? Number(c.req.query('page')) : 1,
    pageSize: c.req.query('page_size') ? Number(c.req.query('page_size')) : 20,
  })
  return success(c, data)
})

// GET /tasks/active — 全部活跃任务（扁平，含批次子任务与文本任务）+ 顶层活跃数
app.get('/active', async (c) => {
  return success(c, await listActiveTasks())
})

// POST /tasks/:id/retry — 换模型重试，一律新建任务（提示词不可改）
app.post('/:id/retry', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const configId = body.config_id != null ? Number(body.config_id) : undefined
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined
  try {
    const newId = await retryTask(id, { configId, model })
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, newId))
    return created(c, await enrichTask(row))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '重试失败')
  }
})

// GET /tasks/:id — 轮询任务状态（带编号与归属信息）
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.id, id))
  return success(c, await enrichTask(row))
})

// GET /tasks — 按 type / storyboard_id / drama_id 过滤
app.get('/', async (c) => {
  const type = c.req.query('type')
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')
  const characterId = c.req.query('character_id')
  const sceneId = c.req.query('scene_id')
  const propId = c.req.query('prop_id')

  let rows = await db.select().from(schema.sysTask)

  if (type) rows = rows.filter(r => r.type === type)
  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))
  if (characterId) rows = rows.filter(r => r.characterId === Number(characterId))
  if (sceneId) rows = rows.filter(r => r.sceneId === Number(sceneId))
  if (propId) rows = rows.filter(r => r.propId === Number(propId))

  return success(c, serializeTasks(rows))
})

// POST /tasks/:id/cancel — 取消排队/运行中的 qwen-jobs 任务（其它供应商不支持）
app.post('/:id/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, serializeTask(await cancelImageTask(id)))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '取消失败')
  }
})

// DELETE /tasks/:id — 丢弃任务记录；qwen-jobs 的远端任务一并取消并清理文件
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (row) await discardRemoteJob(row)
  await db.delete(schema.sysTask).where(eq(schema.sysTask.id, id))
  return success(c)
})

export default app
