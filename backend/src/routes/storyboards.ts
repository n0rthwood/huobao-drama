import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { submitStoryboardVideo } from '../services/storyboard-video.js'
import { loadKeyframeVersions, submitStoryboardKeyframe } from '../services/storyboard-keyframes.js'
import {
  PROMPT_FIELDS,
  SLOT_PROMPT_FIELD,
  checkStoryboardRefs,
  deleteTargetBindings,
  isBindingTarget,
  loadEpisodeAssets,
  loadStoryboardTargetAssets,
  setTargetAssetImage,
  syncStoryboardBindingsFromPrompts,
} from '../services/storyboard-assets.js'
import { parseFieldSavedAt, stampFieldSavedAt } from '../services/storyboard-fields.js'
import {
  currentTransitionSignature,
  markTransitionEditedManually,
  parseTransitionReview,
} from '../services/transition.js'
import { runTransitionReview } from '../services/transition-agent.js'
import { serializeTask } from '../services/sys-task.js'
import {
  SLOT_LABEL,
  SLOT_FRAME_TYPE,
  invalidateKeyframeConfirmation,
  isKeyframeSlot,
  keyframesJson,
  loadEpisodeKeyframes,
  loadStoryboardKeyframes,
  slotOwnImage,
  type KeyframeSlot,
} from '../services/keyframes.js'
import { findActiveBatchForStoryboard } from '../services/video-batch.js'
import { findActiveKeyframeBatchForStoryboard } from '../services/keyframe-batch.js'

const app = new Hono()

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  await db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))


  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    await db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    })
  }
}

async function getStoryboardCharacterIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  return links.map(link => link.characterId)
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  await db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))

  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const propId of uniqueIds) {
    await db.insert(schema.storyboardProps).values({
      storyboardId,
      propId,
    })
  }
}

async function getStoryboardPropIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return links.map(link => link.propId)
}

async function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharacterIds = new Set(characterLinks.map(link => link.characterId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = new Set(propLinks.map(link => link.propId))

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }

  const invalidPropIds = (propIds || []).filter(id => !episodePropIds.has(id))
  if (invalidPropIds.length) {
    throw new Error('prop_ids 必须来自当前集已关联道具')
  }
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 1,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  await validateStoryboardBindings(body.episode_id, body.scene_id, body.character_ids, body.prop_ids)
  const res = await db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber: body.storyboard_number || 1,
    title: body.title,
    description: body.description,
    sceneId: body.scene_id,
    duration: body.duration || 10,
    createdAt: ts,
    updatedAt: ts,
  })
  await syncStoryboardCharacters(getInsertId(res), body.character_ids || [])
  await syncStoryboardProps(getInsertId(res), body.prop_ids || [])
  const [result] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, getInsertId(res)))
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: await getStoryboardCharacterIds(result.id),
    prop_ids: await getStoryboardPropIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', duration: 'duration',
    video_prompt: 'videoPrompt',
    scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
    video_url: 'videoUrl',
    first_frame_prompt: 'firstFramePrompt',
    mid_frame_prompt: 'midFramePrompt',
    last_frame_prompt: 'lastFramePrompt',
    mid_frame_time: 'midFrameTime',
    continuity_boundary: 'continuityBoundary',
    transition_prompt: 'transitionPrompt',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }
  // 「发送转场描述」开关
  if ('transition_enabled' in body) updates.transitionEnabled = body.transition_enabled === true
  // 承接边界由拆分镜 LLM 标注；NULL 表示未标注（按硬切处理）
  if ('continuity_boundary' in body && body.continuity_boundary != null
    && !['continue', 'cut'].includes(body.continuity_boundary)) {
    return badRequest(c, 'continuity_boundary 只支持 continue / cut 或留空')
  }
  // 中间关键帧时间点：首尾各留 0.5 秒，否则引导帧会和首/尾帧挤在一起
  if ('mid_frame_time' in body && body.mid_frame_time != null) {
    const duration = Number(('duration' in body ? body.duration : storyboard.duration) || 0)
    const midTime = Number(body.mid_frame_time)
    if (!Number.isFinite(midTime) || midTime <= 0.5 || midTime >= duration - 0.5) {
      return badRequest(c, `mid_frame_time 必须在 0.5 秒与 ${Math.max(0, duration - 0.5)} 秒之间`)
    }
    updates.midFrameTime = midTime
  }

  await validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : await getStoryboardCharacterIds(id),
    'prop_ids' in body ? body.prop_ids : await getStoryboardPropIds(id),
  )

  // 字段级保存时间：整行 updated_at 会被生图回写污染，输入框的“已保存”只认这里
  const stamp = stampFieldSavedAt(storyboard.fieldSavedAt, Object.keys(body))
  if (stamp.json) updates.fieldSavedAt = stamp.json

  await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id))
  if ('character_ids' in body) await syncStoryboardCharacters(id, body.character_ids || [])
  if ('prop_ids' in body) await syncStoryboardProps(id, body.prop_ids || [])
  // 用户手动保存转场描述：标记 edited_manually，之后不再被自动审核覆盖（#11）
  if ('transition_prompt' in body) await markTransitionEditedManually(storyboard)

  // 提示词被写入时：资产池跟随 @ 并集（同一请求里显式传入的 ids 以提示词为准被覆盖），
  // 写入的关键帧/视频目标按各自提示词的 @ 重算绑定；纯资产池编辑（没写提示词）保持用户的选择不动
  const wrotePrompt = PROMPT_FIELDS.some(field => field in body)
  const sync = wrotePrompt
    ? await syncStoryboardBindingsFromPrompts(id, Object.keys(body))
    : null
  const characterIds = sync?.characterIds ?? await getStoryboardCharacterIds(id)
  const propIds = sync?.propIds ?? await getStoryboardPropIds(id)
  const [updated] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  const assets = sync ? null : await loadEpisodeAssets(updated!.episodeId)
  const refIssues = sync?.issues ?? await checkStoryboardRefs(updated!, assets!)
  const targetAssets = sync?.targetAssets ?? await loadStoryboardTargetAssets(updated!, assets!)

  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: characterIds.join(','),
    propIds: propIds.join(','),
    bound: sync?.sync.bound.map(item => item.name).join(',') || undefined,
    unbound: sync?.sync.unbound.map(item => item.name).join(',') || undefined,
  })
  return success(c, {
    saved_at: stamp.savedAt,
    character_ids: characterIds,
    prop_ids: propIds,
    scene_id: updated?.sceneId ?? null,
    transition_review: parseTransitionReview(updated?.transitionReview),
    ref_issues: refIssues,
    target_assets: targetAssets,
    ref_sync: {
      bound: sync?.sync.bound ?? [],
      unbound: sync?.sync.unbound ?? [],
    },
  })
})

// PUT /storyboards/:id/target-assets/:target — 给某张关键帧 / 视频上已绑定的资产选版（image=null 恢复默认）
app.put('/:id/target-assets/:target', async (c) => {
  const id = Number(c.req.param('id'))
  const target = c.req.param('target')
  if (!isBindingTarget(target)) return badRequest(c, 'target 只支持 first / mid / last / video')
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const kind = body.kind
  const assetId = Number(body.asset_id)
  if (!['scene', 'character', 'prop'].includes(kind) || !Number.isInteger(assetId) || assetId <= 0) {
    return badRequest(c, 'kind 只支持 scene / character / prop，asset_id 必须是正整数')
  }
  const image = body.image == null || body.image === '' ? null : typeof body.image === 'string' ? body.image.trim() : undefined
  if (image === undefined || image === '') return badRequest(c, 'image 必须是图片地址或 null（恢复默认）')
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard || storyboard.deletedAt) return badRequest(c, '镜头不存在')
  try {
    await setTargetAssetImage(id, target, kind, assetId, image)
  } catch (err) {
    return badRequest(c, (err as Error).message)
  }
  logTaskSuccess('StoryboardAPI', 'set-target-asset', { storyboardId: id, target, kind, assetId, image: image ?? 'default' })
  const assets = await loadEpisodeAssets(storyboard.episodeId)
  return success(c, {
    target_assets: await loadStoryboardTargetAssets(storyboard, assets),
    ref_issues: await checkStoryboardRefs(storyboard, assets),
  })
})

// ─── 分镜关键帧 ────────────────────────────────────────────────

/** 单镜的完整 JSON（含关键帧计算字段），关键帧接口统一返回这个形状 */
async function storyboardJson(id: number) {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!row) return null
  return {
    ...toSnakeCase(row),
    target_assets: await loadStoryboardTargetAssets(row),
    field_saved_at: parseFieldSavedAt(row.fieldSavedAt),
    transition_review: parseTransitionReview(row.transitionReview),
    transition_stale: await (async () => {
      const review = parseTransitionReview(row.transitionReview)
      if (!review) return false
      const signature = await currentTransitionSignature(row.id)
      return !!signature && signature !== review.input_signature
    })(),
    ref_issues: await checkStoryboardRefs(row),
    keyframes: keyframesJson((await loadEpisodeKeyframes(row.episodeId)).get(row.id)),
    character_ids: await getStoryboardCharacterIds(row.id),
    prop_ids: await getStoryboardPropIds(row.id),
  }
}

function parseSlot(value: string | undefined): KeyframeSlot | null {
  return isKeyframeSlot(value) ? value : null
}

// POST /storyboards/:id/keyframes/:slot/generate — 生成某个槽位的关键帧（可同时保存改过的提示词）
app.post('/:id/keyframes/:slot/generate', async (c) => {
  const id = Number(c.req.param('id'))
  const slot = parseSlot(c.req.param('slot'))
  if (!slot) return badRequest(c, 'slot 只支持 first / mid / last')
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  logTaskStart('StoryboardAPI', 'generate-keyframe', { storyboardId: id, slot, model: body.model, configId: body.config_id })
  try {
    const batchId = await findActiveKeyframeBatchForStoryboard(id)
    if (batchId) return badRequest(c, '该镜头正排在批量关键帧队列中，请等待批量完成或先停止批量')
    // 只保存非空提示词：空串不能把已有的槽位提示词抹掉（生成随后也会因提示词为空而报错）
    const editedPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (editedPrompt) {
      const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
      if (!row) return badRequest(c, '镜头不存在')
      const field = SLOT_PROMPT_FIELD[slot]
      const promptPatch = slot === 'first' ? { firstFramePrompt: editedPrompt }
        : slot === 'mid' ? { midFramePrompt: editedPrompt }
        : { lastFramePrompt: editedPrompt }
      const stamp = stampFieldSavedAt(row.fieldSavedAt, [field])
      await db.update(schema.storyboards)
        .set({ ...promptPatch, fieldSavedAt: stamp.json ?? row.fieldSavedAt, updatedAt: now() })
        .where(eq(schema.storyboards.id, id))
      // 提示词写入 → 资产池与该槽位绑定跟随 @引用（与 PUT /storyboards/:id 同口径）
      await syncStoryboardBindingsFromPrompts(id, [field])
    }
    const taskId = await submitStoryboardKeyframe(id, slot, { model: body.model, configId: body.config_id })
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    logTaskSuccess('StoryboardAPI', 'generate-keyframe', { storyboardId: id, slot, taskId, provider: record?.provider })
    return created(c, record ? serializeTask(record) : null)
  } catch (err) {
    const message = err instanceof Error ? err.message : '关键帧生成失败'
    logTaskError('StoryboardAPI', 'generate-keyframe', { storyboardId: id, slot, error: message })
    return badRequest(c, message)
  }
})

// GET /storyboards/:id/keyframes/:slot/versions — 该槽位的历史版本（最新在前，版本号按时间正序从 1 起）
app.get('/:id/keyframes/:slot/versions', async (c) => {
  const id = Number(c.req.param('id'))
  const slot = parseSlot(c.req.param('slot'))
  if (!slot) return badRequest(c, 'slot 只支持 first / mid / last')
  const versions = await loadKeyframeVersions(id, slot)
  return success(c, [...versions].reverse())
})

// PUT /storyboards/:id/keyframes/:slot — 选定某个版本，或（仅首帧）改为继承上一镜尾帧
app.put('/:id/keyframes/:slot', async (c) => {
  const id = Number(c.req.param('id'))
  const slot = parseSlot(c.req.param('slot'))
  if (!slot) return badRequest(c, 'slot 只支持 first / mid / last')
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard) return badRequest(c, '镜头不存在')

  if (body.inherit === true) {
    if (slot !== 'first') return badRequest(c, '只有首帧可以继承上一镜的尾帧')
    const state = (await loadEpisodeKeyframes(storyboard.episodeId)).get(id)
    if (!state?.previousId || storyboard.continuityBoundary !== 'continue') {
      return badRequest(c, '该镜头没有可继承的上一镜（需要标注为承接且不是第一镜）')
    }
    await db.update(schema.storyboards)
      .set({ firstFrameImage: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
  } else {
    const image = String(body.image || '').trim()
    if (!image) return badRequest(c, '缺少 image')
    const frameType = SLOT_FRAME_TYPE[slot]
    const owned = (await db.select().from(schema.sysTask))
      .filter(task => task.type === 'image' && task.status === 'completed' && task.storyboardId === id)
      .some((task) => {
        if ((task.localPath || task.resultUrl) !== image) return false
        try {
          const params: unknown = JSON.parse(task.params || '{}')
          return !!params && typeof params === 'object' && 'frameType' in params && params.frameType === frameType
        } catch {
          return false
        }
      })
    if (!owned) return badRequest(c, `该图片不是本镜${SLOT_LABEL[slot]}的历史版本`)
    const imagePatch = slot === 'first' ? { firstFrameImage: image }
      : slot === 'mid' ? { midFrameImage: image }
      : { lastFrameImage: image }
    await db.update(schema.storyboards)
      .set({ ...imagePatch, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
  }

  // 选定图变化 → 人工确认作废（并连带继承它的下一镜）
  await invalidateKeyframeConfirmation(id)
  logTaskSuccess('StoryboardAPI', 'select-keyframe', { storyboardId: id, slot, inherit: body.inherit === true })
  return success(c, await storyboardJson(id))
})

// POST /storyboards/:id/confirm-keyframes — 人工确认/取消确认，视频生成的闸门
app.post('/:id/confirm-keyframes', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const confirmed = body.confirmed === true
  const state = await loadStoryboardKeyframes(id)
  if (!state) return badRequest(c, '镜头不存在')
  if (confirmed && !state.ready) {
    return badRequest(c, '关键帧未就绪，首帧与尾帧必须都有图；写了中间帧提示词的分镜还需要中间帧图')
  }
  await db.update(schema.storyboards)
    .set({ keyframesConfirmed: confirmed, updatedAt: now() })
    .where(eq(schema.storyboards.id, id))
  logTaskSuccess('StoryboardAPI', 'confirm-keyframes', { storyboardId: id, confirmed })
  return success(c, await storyboardJson(id))
})

// POST /storyboards/:id/transition — AI 审核并生成本镜的开场转场（承接镜头，#11）
app.post('/:id/transition', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  logTaskStart('StoryboardAPI', 'transition', { storyboardId: id, model: body.model, configId: body.config_id })
  try {
    await runTransitionReview(id, { model: body.model, configId: body.config_id })
    logTaskSuccess('StoryboardAPI', 'transition', { storyboardId: id })
    return success(c, await storyboardJson(id))
  } catch (err) {
    const message = err instanceof Error ? err.message : '转场生成失败'
    logTaskError('StoryboardAPI', 'transition', { storyboardId: id, error: message })
    return badRequest(c, message)
  }
})

// POST /storyboards/:id/generate-video — 单镜视频生成：关键帧/参考图/提示词编号/风格/时长全部由后端组装（要求该镜已确认关键帧）
app.post('/:id/generate-video', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  logTaskStart('StoryboardAPI', 'generate-video', { storyboardId: id, model: body.model, configId: body.config_id })
  try {
    const batchId = await findActiveBatchForStoryboard(id)
    if (batchId) return badRequest(c, '该镜头正排在批量视频队列中，请等待批量完成或先停止批量')
    const taskId = await submitStoryboardVideo(id, { model: body.model, configId: body.config_id })
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    logTaskSuccess('StoryboardAPI', 'generate-video', { storyboardId: id, taskId, provider: record?.provider })
    return created(c, record)
  } catch (err) {
    const message = err instanceof Error ? err.message : '视频生成失败'
    logTaskError('StoryboardAPI', 'generate-video', { storyboardId: id, error: message })
    return badRequest(c, message)
  }
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  // 删除后“上一镜”会变，继承首帧的下一镜要重新确认
  const nextRows = storyboard
    ? (await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, storyboard.episodeId)))
      .filter(row => !row.deletedAt && row.id !== id && row.storyboardNumber > storyboard.storyboardNumber)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    : []
  const next = nextRows[0]
  await db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id))
  await db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, id))
  await deleteTargetBindings({ storyboardId: id })
  await db.delete(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (next && !slotOwnImage(next, 'first') && next.continuityBoundary === 'continue') {
    await invalidateKeyframeConfirmation(next.id)
  }
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

export default app
