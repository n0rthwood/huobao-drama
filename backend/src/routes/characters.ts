import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensureCharacterFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { deleteAllReferenceImages, partitionMissingReferences, resolveReferenceImages } from '../services/reference-images.js'
import { deleteAssetLinks } from '../services/asset-links.js'
import { getStylingVersion, saveStylingVersion } from '../services/styling-version.js'
import { mountReferenceImageRoutes } from './reference-images.js'
import { planFinalPromptWrite, promptSourceChanged } from '../services/asset-prompt-invalidation.js'

const app = new Hono()
const CHARACTER_IMAGE_SIZE = '1920x1080'

// POST/DELETE /characters/:id/reference-images — 角色参考图（生图输入，与成片图互不影响）
mountReferenceImageRoutes(app, 'character')

// POST /characters — 手动新增角色（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.name?.trim()) return badRequest(c, '名称必填')
  const ts = now()
  const res = await db.insert(schema.characters).values({
    name: body.name.trim(),
    role: body.role || '',
    description: body.description || '',
    appearance: body.appearance || '',
    styling: body.styling || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const charId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeCharacters)
      .where(and(eq(schema.episodeCharacters.episodeId, Number(body.episode_id)), eq(schema.episodeCharacters.characterId, charId)))
    if (!existing.length) {
      await db.insert(schema.episodeCharacters).values({ episodeId: Number(body.episode_id), characterId: charId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, charId))
  return created(c, toSnakeCase(row))
})

function characterImagePrompt(char: typeof schema.characters.$inferSelect, stylePrompt = '') {
  return [
    stylePrompt || '',
    char.name,
    char.appearance || char.description || '人物立绘',
    char.styling || '',
    '16:9 横版角色定妆照',
    '半身角色海报构图',
    '正面',
    '高质量',
    '白色背景',
  ].filter(Boolean).join(', ')
}

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'styling', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  // 手写最终提示词以传入值为准；否则样貌/造型/描述改了值 → 旧提示词失效（Issue #24）
  Object.assign(updates, planFinalPromptWrite({
    currentFinalPrompt: char.finalPrompt,
    finalPrompt: body.final_prompt !== undefined ? body.final_prompt : body.finalPrompt,
    sourceChanged: promptSourceChanged('character', char, updates),
  }))
  await db.update(schema.characters).set(updates).where(eq(schema.characters.id, id))
  const [updated] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return success(c, toSnakeCase(updated))
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id))
  // 参考图是角色私有的生图输入，随角色一起清理（成片图保留，与既有行为一致）
  deleteAllReferenceImages('character', id)
  // 集关联/分镜绑定不保留：残留行会让提取与 @引用 继续看到已删角色（Issue #15）
  await deleteAssetLinks('character', id)
  return success(c)
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  const stylePrompt = await getDramaStylePrompt(char.dramaId)
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined })
  const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
  // 默认用角色自己保存的参考图；请求显式传 reference_images（含空数组）时以请求为准
  const resolved = resolveReferenceImages(char.referenceImages, body.reference_images)
  const { present: referenceImages, missing } = partitionMissingReferences(resolved)
  if (missing.length) logTaskWarn('CharacterImage', 'reference-missing', { characterId: id, missing })
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId, references: referenceImages.length })
    const genId = await generateImage({ characterId: id, episodeId: ep.id, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, referenceImages: referenceImages.length ? referenceImages : undefined, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId, reference_images: referenceImages, missing_reference_images: missing })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/:id/generate-prompt — 独立生成/重新生成三视图最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  logTaskStart('FinalPrompt', 'character-generate', { characterId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, !!body.force, { model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'character-generate', { characterId: id })
  return success(c, { final_prompt: finalPrompt })
})

// PUT /characters/:id/styling-version — 保存本集造型版本的文字（Issue #15，不动基础形象）
app.put('/:id/styling-version', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  if (!body.name?.trim()) return badRequest(c, '造型名必填')
  const saved = await saveStylingVersion(Number(body.episode_id), id, {
    name: String(body.name).trim(),
    description: body.description ? String(body.description) : undefined,
    image_path: body.image_path !== undefined ? String(body.image_path || '') : undefined,
  })
  if (!saved) return badRequest(c, '该角色未关联到本集，无法保存造型版本')
  return success(c, { styling_version: saved })
})

// POST /characters/:id/styling-version/generate-image — 以基础形象图做 image_edit 出造型图
app.post('/:id/styling-version/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  // 造型文本可随请求一并更新（提取写入后再手工改的场景）
  const existing = await getStylingVersion(ep.id, id)
  const name = String(body.name || existing?.name || '').trim()
  if (!name) return badRequest(c, '本集没有造型版本，请先保存造型名与描述')
  const description = String(body.description ?? existing?.description ?? '').trim()
  if (!description) return badRequest(c, '造型描述为空，无法出图')
  // 造型版本写在集关联行上：没有关联就没有落点，先挡住，避免出一张无处回写的图
  const saved = await saveStylingVersion(ep.id, id, { name, description })
  if (!saved) return badRequest(c, '该角色未关联到本集，无法生成造型版本图')

  // image_edit：基础形象图是唯一参考，保证换装后还是同一个角色
  const baseImage = char.imageUrl || ''
  if (!baseImage) return badRequest(c, '角色还没有基础形象图，请先生成角色图再出造型版本')
  const stylePrompt = await getDramaStylePrompt(char.dramaId)
  const prompt = [
    stylePrompt || '',
    `保持参考图中${char.name}的物种、体型、五官、毛色与三视图构图完全不变，只更换其身上的服装`,
    `换装为：${description}`,
    '服装合身、完整可见，不改变角色比例与姿态',
    '白色背景',
    '高质量',
  ].filter(Boolean).join(', ')
  try {
    logTaskStart('CharacterImage', 'styling-version', { characterId: id, episodeId: ep.id, name })
    const genId = await generateImage({
      characterId: id,
      episodeId: ep.id,
      dramaId: char.dramaId,
      prompt,
      model: body.model,
      size: CHARACTER_IMAGE_SIZE,
      referenceImages: [baseImage],
      configId: body.config_id ?? ep.imageConfigId ?? undefined,
      characterVersion: { episodeId: ep.id, name },
    })
    logTaskSuccess('CharacterImage', 'styling-version', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId, styling_version: { name, description, image_path: existing?.image_path || '' } })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('CharacterImage', 'styling-version', { characterId: id, error: message })
    return badRequest(c, message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  // 批量不接受统一参考图：一套参考图套到所有角色是误用，各角色用自己保存的参考图
  if (body.reference_images !== undefined) return badRequest(c, '批量生成不支持统一参考图，请在角色卡片上分别管理参考图')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')
  const results: number[] = []
  const stylePrompt = await getDramaStylePrompt(ep.dramaId)
  for (const cid of ids) {
    const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, cid))
    if (!char) continue
    const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined })
    const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
    const { present: referenceImages, missing } = partitionMissingReferences(resolveReferenceImages(char.referenceImages))
    if (missing.length) logTaskWarn('CharacterImage', 'reference-missing', { characterId: cid, missing })
    try {
      const genId = await generateImage({ characterId: cid, episodeId: ep.id, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, referenceImages: referenceImages.length ? referenceImages : undefined, configId: body.config_id ?? ep.imageConfigId ?? undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
