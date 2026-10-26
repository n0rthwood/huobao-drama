import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { getActiveConfig, getConfigById, validateVideoModel } from '../services/ai.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

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
  continuity_source_storyboard_id: z.number().int().optional(),
  continuity_source_video_url: z.string().optional(),
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
    let videoPrompt = videoBody?.prompt
    if (type === 'video' && String(videoPrompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const stylePrompt = await getDramaStylePrompt(dramaId)
      if (stylePrompt) videoPrompt = `${stylePrompt}，\n${videoPrompt}`
    }

    const id = type === 'image'
      ? await generateImage({
        storyboardId: body.storyboard_id,
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
        continuitySourceStoryboardId: videoBody!.continuity_source_storyboard_id,
        continuitySourceVideoUrl: videoBody!.continuity_source_video_url,
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(eq(schema.sysTask.id, id))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record)
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
    params: JSON.stringify({ source: 'manual-upload' }),
    resultUrl: localPath,
    localPath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  })
  return created(c, { id: getInsertId(result), local_path: localPath })
})

// GET /tasks/:id — 轮询任务状态
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.id, id))
  return success(c, row || null)
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

  return success(c, rows)
})

// DELETE /tasks/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.sysTask).where(eq(schema.sysTask.id, id))
  return success(c)
})

export default app
