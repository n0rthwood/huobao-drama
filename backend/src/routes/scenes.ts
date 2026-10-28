import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensureSceneFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { deleteAllReferenceImages, partitionMissingReferences, resolveReferenceImages } from '../services/reference-images.js'
import { deleteAssetLinks } from '../services/asset-links.js'
import { mountReferenceImageRoutes } from './reference-images.js'
import { planSceneTimePatch } from '../services/scene-time.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

// POST/DELETE /scenes/:id/reference-images — 场景参考图（生图输入，与成片图互不影响）
mountReferenceImageRoutes(app, 'scene')

// POST /scenes — 手动新增场景（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.location?.trim()) return badRequest(c, '地点必填')
  const ts = now()
  const res = await db.insert(schema.scenes).values({
    dramaId: body.drama_id,
    episodeId: body.episode_id,
    location: body.location.trim(),
    time: body.time || '',
    prompt: body.prompt || body.description || body.location,
    lighting: body.lighting || '',
    createdAt: ts,
    updatedAt: ts,
  })
  const sceneId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeScenes)
      .where(and(eq(schema.episodeScenes.episodeId, Number(body.episode_id)), eq(schema.episodeScenes.sceneId, sceneId)))
    if (!existing.length) {
      await db.insert(schema.episodeScenes).values({ episodeId: Number(body.episode_id), sceneId, createdAt: ts })
    }
  }
  const [result] = await db.select().from(schema.scenes)
    .where(eq(schema.scenes.id, sceneId))
  return created(c, result)
})

// PUT /scenes/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
  if (!scene) return badRequest(c, '场景不存在')
  // 场景时间不变量（Issue #21）：提示词必须引用 time，改时间让旧提示词失效
  const timePatch = planSceneTimePatch({
    currentTime: scene.time,
    currentFinalPrompt: scene.finalPrompt,
    time: body.time,
    finalPrompt: body.final_prompt !== undefined ? body.final_prompt : body.finalPrompt,
  })
  if ('error' in timePatch) return badRequest(c, timePatch.error)
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.location !== undefined) updates.location = body.location
  if (timePatch.time !== undefined) updates.time = timePatch.time
  if (body.prompt !== undefined) updates.prompt = body.prompt
  if (body.description !== undefined) updates.prompt = body.description
  if (body.lighting !== undefined) updates.lighting = body.lighting
  // 用户上传场景图：直接写入图片地址与本地路径
  const uploadedImage = body.image_url ?? body.imageUrl
  if (uploadedImage !== undefined) {
    updates.imageUrl = uploadedImage
    if (uploadedImage) updates.status = 'completed'
  }
  if (body.local_path !== undefined) updates.localPath = body.local_path
  else if (body.localPath !== undefined) updates.localPath = body.localPath
  if (timePatch.finalPrompt !== undefined) updates.finalPrompt = timePatch.finalPrompt
  await db.update(schema.scenes).set(updates).where(eq(schema.scenes.id, id))
  const [updated] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
  return success(c, toSnakeCase(updated))
})

// POST /scenes/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
  if (!scene) return badRequest(c, '场景不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  const stylePrompt = await getDramaStylePrompt(scene.dramaId)
  const finalPrompt = await ensureSceneFinalPrompt(scene, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined })
  // 回退拼接也要守住无人物约束：场景描述(prompt)可能含人物活动，直接拼会让人混进图里
  const prompt = finalPrompt || [
    stylePrompt || '',
    scene.location,
    scene.time || '',
    scene.prompt || '高质量场景',
    scene.lighting || '电影感光影',
    '画面中没有任何人物，空场景，只有场景本身',
  ].filter(Boolean).join(', ')
  // 默认用场景自己保存的参考图；请求显式传 reference_images（含空数组）时以请求为准
  const resolved = resolveReferenceImages(scene.referenceImages, body.reference_images)
  const { present: referenceImages, missing } = partitionMissingReferences(resolved)
  if (missing.length) logTaskWarn('SceneImage', 'reference-missing', { sceneId: id, missing })
  try {
    logTaskStart('SceneImage', 'generate', { sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, location: scene.location, references: referenceImages.length })
    await db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id))
    const genId = await generateImage({ sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, prompt, model: body.model, referenceImages: referenceImages.length ? referenceImages : undefined, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('SceneImage', 'generate', { sceneId: id, generationId: genId })
    return success(c, { image_generation_id: genId, reference_images: referenceImages, missing_reference_images: missing })
  } catch (err: any) {
    logTaskError('SceneImage', 'generate', { sceneId: id, error: err.message })
    await db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id))
    return badRequest(c, err.message)
  }
})

// POST /scenes/:id/generate-prompt — 独立生成/重新生成固定视角最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
  if (!scene) return badRequest(c, '场景不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  logTaskStart('FinalPrompt', 'scene-generate', { sceneId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensureSceneFinalPrompt(scene, ep.id, !!body.force, { model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'scene-generate', { sceneId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'scene-generate', { sceneId: id })
  return success(c, { final_prompt: finalPrompt })
})

// DELETE /scenes/:id — 软删除（保留历史生成记录）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.scenes).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.scenes.id, id))
  // 参考图是场景私有的生图输入，随场景一起清理（成片图保留，与既有行为一致）
  deleteAllReferenceImages('scene', id)
  // 集关联不保留：残留行会让提取与 @引用 继续看到已删场景（Issue #15）
  await deleteAssetLinks('scene', id)
  return success(c)
})

export default app
