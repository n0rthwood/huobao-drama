import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { extractVideoTailFrame } from '../utils/video-poster.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

type TaskType = 'image' | 'video'

const WAN_MEDIA_TYPES = new Set([
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
])

/**
 * 兼容项目原有扁平入参，也支持 Wan 3.0 官方 model/input/parameters 结构。
 */
function normalizeVideoRequest(body: any) {
  const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {}
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
    ? body.parameters
    : {}
  const media = Array.isArray(input.media) ? input.media : []

  const mediaUrls = (type: string) => media
    .filter((item: any) => item?.type === type)
    .map((item: any) => item?.url)

  return {
    ...body,
    prompt: body.prompt ?? input.prompt ?? '',
    reference_image_urls: body.reference_image_urls ?? mediaUrls('reference_image'),
    reference_video_urls: body.reference_video_urls ?? mediaUrls('reference_video'),
    reference_audio_urls: body.reference_audio_urls ?? mediaUrls('reference_audio'),
    first_frame_url: body.first_frame_url ?? mediaUrls('first_frame')[0],
    last_frame_url: body.last_frame_url ?? mediaUrls('last_frame')[0],
    file_url: body.file_url ?? mediaUrls('file')[0],
    link_url: body.link_url ?? mediaUrls('link')[0],
    generate_audio: body.generate_audio ?? parameters.audio,
    duration: body.duration ?? parameters.duration,
    aspect_ratio: body.aspect_ratio ?? parameters.ratio,
    resolution: body.resolution ?? parameters.resolution,
    seed: body.seed ?? parameters.seed,
    prompt_extend: body.prompt_extend ?? parameters.prompt_extend,
    watermark: body.watermark ?? parameters.watermark,
    inherit_previous_tail: body.inherit_previous_tail === true || parameters.inherit_previous_tail === true,
    official_media: media,
  }
}

function validateVideoRequest(body: any, provider?: string): string | null {
  for (const key of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return `${key} 必须为数组`
    if (Array.isArray(body[key]) && body[key].some((url: any) => typeof url !== 'string' || !url.trim())) {
      return `${key} 中的每个 URL 都必须为非空字符串`
    }
  }

  if (body.official_media.length) {
    for (const item of body.official_media) {
      if (!item || typeof item !== 'object' || !WAN_MEDIA_TYPES.has(item.type) || typeof item.url !== 'string' || !item.url.trim()) {
        return 'input.media 中的每项都必须包含官方支持的 type 和非空 url'
      }
    }
    for (const type of ['first_frame', 'last_frame', 'file', 'link']) {
      if (body.official_media.filter((item: any) => item.type === type).length > 1) {
        return `Wan 3.0 input.media 中 ${type} 最多 1 项`
      }
    }
  }

  const imgs = body.reference_image_urls.length
  const vids = body.reference_video_urls.length
  const auds = body.reference_audio_urls.length
  const first = Boolean(body.first_frame_url)
  const last = Boolean(body.last_frame_url)
  const file = Boolean(body.file_url)
  const link = Boolean(body.link_url)

  if ((provider || '').toLowerCase() === 'aliyun') {
    if (imgs > 10 || vids > 5 || auds > 5) return 'Wan 3.0 参考素材超限：图片≤10、视频≤5、音频≤5'
    if (last && !first) return 'Wan 3.0 尾帧必须与首帧同时传入'
    if (file && link) return 'Wan 3.0 file 与 link 不能同时传入'
    if ((first || last) && (imgs + vids + auds > 0 || file || link)) {
      return 'Wan 3.0 的 first_frame/last_frame 不能与 reference_image/reference_video/reference_audio/file/link 混用'
    }
    const total = imgs + vids + auds + Number(first) + Number(last) + Number(file) + Number(link)
    if (total > 20) return 'Wan 3.0 input.media 最多 20 项'
  } else {
    if (imgs > 9 || vids > 3 || auds > 3) return '参考素材超限：图片≤9、视频≤3、音频≤3'
    if (auds > 0 && imgs + vids === 0) return '参考音频需要至少 1 个参考图片或视频'
  }

  if (!String(body.prompt || '').trim() && imgs + vids + auds === 0 && !first && !last && !file && !link) {
    return '视频生成需要至少一个参考素材或 prompt'
  }
  return null
}

async function resolvePreviousTailFrame(storyboard: typeof schema.storyboards.$inferSelect) {
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, storyboard.episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const index = rows.findIndex(row => row.id === storyboard.id)
  if (index <= 0) throw new Error('第一镜没有上一镜，不能启用尾帧衔接')
  const previous = rows[index - 1]!
  const previousVideo = previous.videoUrl || previous.composedVideoUrl
  if (!previousVideo) throw new Error(`上一镜 #${previous.storyboardNumber} 还没有采用视频，无法提取尾帧`)
  return {
    firstFrameUrl: await extractVideoTailFrame(previousVideo),
    sourceStoryboardId: previous.id,
    sourceVideoUrl: previousVideo,
  }
}

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const type = body.type as TaskType
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type 必须为 image 或 video')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, '提示词必填')
  }

  const videoBody = type === 'video' ? normalizeVideoRequest(body) : null

  try {
    // 请求显式指定 config_id（工作台模型下拉跨厂商切换）时优先；
    // 未指定才回退到集锁定配置，避免锁定配置与所选模型错配（如锁定 Seedance 却传 MiniMax 模型名）
    let configId: number | undefined = body.config_id
    let episodeResolution: string | undefined
    let storyboardDramaId: number | undefined
    let storyboard: typeof schema.storyboards.$inferSelect | undefined
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
      storyboard = sb
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        if (locked != null && configId == null) configId = locked
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution
        storyboardDramaId = ep?.dramaId ?? undefined
      }
    }

    if (type === 'video' && videoBody?.inherit_previous_tail) {
      if (!storyboard) return badRequest(c, '启用尾帧衔接时 storyboard_id 必填')
      const continuity = await resolvePreviousTailFrame(storyboard)
      videoBody.first_frame_url = continuity.firstFrameUrl
      videoBody.continuity_source_storyboard_id = continuity.sourceStoryboardId
      videoBody.continuity_source_video_url = continuity.sourceVideoUrl
      // 首尾帧模式与参考图模式是不同工作流；启用衔接时以连续性首帧为准。
      videoBody.reference_image_urls = []
    }

    if (type === 'video' && videoBody) {
      const effectiveConfig = configId
        ? (await getConfigById(configId)) ?? await getActiveConfig('video')
        : await getActiveConfig('video')
      const validationError = validateVideoRequest(videoBody, effectiveConfig?.provider)
      if (validationError) return badRequest(c, validationError)
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
        referenceFileUrl: videoBody!.file_url,
        referenceLinkUrl: videoBody!.link_url,
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
  } catch (err: any) {
    logTaskError('TaskAPI', 'generate', { type, error: err.message })
    return badRequest(c, err.message)
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
