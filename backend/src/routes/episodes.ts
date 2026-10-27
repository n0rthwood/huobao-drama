import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { getActiveConfigId } from '../services/ai.js'
import { EXTRACT_TARGETS, getExtractionStatus, startExtraction, type ExtractTarget } from '../services/extraction.js'
import { getVideoPromptBatchStatus, startVideoPromptBatch } from '../services/video-prompts.js'
import { getKeyframePromptBatchStatus, startKeyframePromptBatch } from '../services/keyframe-prompts.js'
import { isKeyframeSlot, keyframesJson, loadEpisodeKeyframes, type KeyframeSlot } from '../services/keyframes.js'
import {
  cancelEpisodeVideoBatch,
  getEpisodeVideoBatch,
  previewEpisodeVideoBatch,
  startEpisodeVideoBatch,
} from '../services/video-batch.js'
import {
  cancelEpisodeKeyframeBatch,
  getEpisodeKeyframeBatch,
  retryFailedKeyframeBatch,
  startEpisodeKeyframeBatch,
  previewEpisodeKeyframeBatch,
} from '../services/keyframe-batch.js'
import { checkStoryboardRefs } from '../services/storyboard-assets.js'
import { parseFieldSavedAt } from '../services/storyboard-fields.js'
import { lookupGeneratedAt } from '../services/media-time.js'
import { parseTransitionReview, transitionInputSignature } from '../services/transition.js'
import {
  AssetLibraryError,
  isAssetKind,
  linkAssetToEpisode,
  loadImageVersions,
  unlinkAssetFromEpisode,
} from '../services/asset-library.js'
import type { AssetKind } from '../services/reference-images.js'

const app = new Hono()

async function attachImageVersions<T extends { id: number; imageUrl: string | null }>(
  rows: T[],
  kind: AssetKind,
) {
  const versionsOf = await loadImageVersions(kind, rows)
  return rows.map((row) => {
    const versions = versionsOf.get(row.id) ?? []
    return {
      ...toSnakeCase(row),
      image_versions: versions,
      image_generated_at: versions.find(version => version.is_current)?.generated_at ?? null,
    }
  })
}


// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')

  // 图片/视频配置：显式传入优先，缺省时自动锁定当前启用的最高优先级官方配置
  const imageConfigId = body.image_config_id ?? await getActiveConfigId('image')
  const videoConfigId = body.video_config_id ?? await getActiveConfigId('video')
  if (!imageConfigId) return badRequest(c, '未找到启用的图片生成配置，请先在设置中心添加')
  if (!videoConfigId) return badRequest(c, '未找到启用的视频生成配置，请先在设置中心添加')
  const ts = now()

  // Get next episode number（忽略已软删的集，删除中间集后新集号可复用空位之后的最大值）
  const existing = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, body.drama_id), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = await db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    imageConfigId,
    videoConfigId,
    // 视频分辨率在创建集时固定（480p/720p/1080p），后续可通过 PUT 修改；各视频适配器再映射为厂商档位
    resolution: ['480p', '720p', '1080p'].includes(body.resolution) ? body.resolution : '720p',
    createdAt: ts,
    updatedAt: ts,
  })

  const [ep] = await db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, getInsertId(res)))
  return success(c, {
    id: ep.id,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    resolution: ep.resolution,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()

  const allowed = ['content', 'script_content', 'title', 'description', 'status', 'resolution']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, '没有可更新的字段')
  if ('resolution' in updates && !['480p', '720p', '1080p'].includes(updates.resolution)) {
    return badRequest(c, 'resolution 只支持 480p / 720p / 1080p')
  }

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('resolution' in updates) drizzleUpdates.resolution = updates.resolution

  await db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id))
  return success(c)
})

// DELETE /episodes/:id - Soft delete episode（其分镜/生成记录保留但不可达）
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  await db.update(schema.episodes).set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.episodes.id, id))
  return success(c)
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = await db.select().from(schema.characters)
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  return success(c, await attachImageVersions(result, 'character'))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = await db.select().from(schema.scenes)
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, await attachImageVersions(result, 'scene'))
})

// GET /episodes/:id/props — props linked to this episode
app.get('/:id/props', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const propIds = links.map(l => l.propId)
  if (!propIds.length) return success(c, [])
  const allProps = await db.select().from(schema.props)
  const result = allProps.filter(p => propIds.includes(p.id) && !p.deletedAt)
  return success(c, await attachImageVersions(result, 'prop'))
})

// POST /episodes/:id/assets/link — 把本项目已有资产关联到本集（资产管理器·本项目复用）
app.post('/:id/assets/link', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body: unknown = await c.req.json()
  const kind = body && typeof body === 'object' && 'kind' in body ? body.kind : undefined
  const assetIdRaw = body && typeof body === 'object' && 'asset_id' in body ? body.asset_id : undefined
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const assetId = Number(assetIdRaw)
  if (!Number.isInteger(assetId) || assetId <= 0) return badRequest(c, 'asset_id 必填')
  try {
    return success(c, await linkAssetToEpisode(episodeId, kind, assetId))
  } catch (err) {
    if (err instanceof AssetLibraryError) {
      return err.status === 404 ? notFound(c, err.message) : badRequest(c, err.message)
    }
    throw err
  }
})

// DELETE /episodes/:id/assets/link?kind=&asset_id= — 取消关联（不删资产，幂等）
app.delete('/:id/assets/link', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const kind = c.req.query('kind')
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const assetId = Number(c.req.query('asset_id'))
  if (!Number.isInteger(assetId) || assetId <= 0) return badRequest(c, 'asset_id 必填')
  return success(c, await unlinkAssetFromEpisode(episodeId, kind, assetId))
})

// POST /episodes/:id/extract — 异步提取资产（target: characters | scenes | props），立即返回，前端轮询状态
app.post('/:id/extract', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const target = body.target as ExtractTarget
  if (!EXTRACT_TARGETS.includes(target)) return badRequest(c, 'target 必须是 characters / scenes / props')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const started = await startExtraction(ep.id, ep.dramaId, target, { model: body.model || undefined, configId: body.config_id ?? undefined })
  return success(c, { target, status: 'running', already_running: !started })
})

// GET /episodes/:id/extract-status — 查询三类资产提取任务状态
app.get('/:id/extract-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getExtractionStatus(id))
})

// POST /episodes/:id/generate-video-prompts — 异步批量为缺少视频提示词的分镜生成（立即返回，前端轮询状态）
app.post('/:id/generate-video-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startVideoPromptBatch(ep.id, ep.dramaId, { model: body.model || undefined, configId: body.config_id ?? undefined }, storyboardIds)
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/video-prompts-status — 查询批量视频提示词任务状态
app.get('/:id/video-prompts-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getVideoPromptBatchStatus(id))
})

// POST /episodes/:id/video-batch/preview — 逐镜列出 缺视频/已变化/未变化(同第N版)/无法判断/阻断/跳过
app.post('/:id/video-batch/preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  try {
    const items = await previewEpisodeVideoBatch(id, {
      storyboardIds: Array.isArray(body.storyboard_ids) ? body.storyboard_ids.map(Number) : undefined,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, { items })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量视频预览失败')
  }
})

// POST /episodes/:id/video-batch — 服务端批量视频（按预览勾选的分镜顺序串行，脱离浏览器）
app.post('/:id/video-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : []
  if (!storyboardIds.length) return badRequest(c, '请先在清单里勾选要生成的镜头')
  try {
    const status = await startEpisodeVideoBatch(id, {
      storyboardIds,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, status)
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量视频启动失败')
  }
})

// GET /episodes/:id/video-batch — 最近一次批量的进度（刷新页面后仍可查看）
app.get('/:id/video-batch', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getEpisodeVideoBatch(id))
})

// POST /episodes/:id/video-batch/cancel — 停止：不再提交新的镜头，在跑的那一镜继续完成
app.post('/:id/video-batch/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, await cancelEpisodeVideoBatch(id))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '停止批量视频失败')
  }
})

// POST /episodes/:id/generate-keyframe-prompts — 异步批量补齐关键帧提示词（立即返回，前端轮询状态）
app.post('/:id/generate-keyframe-prompts', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const result = await startKeyframePromptBatch(ep.id, ep.dramaId, { model: body.model || undefined, configId: body.config_id ?? undefined }, storyboardIds)
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// GET /episodes/:id/keyframe-prompts-status — 查询批量关键帧提示词任务状态
app.get('/:id/keyframe-prompts-status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getKeyframePromptBatchStatus(id))
})

// POST /episodes/:id/keyframe-batch/preview — 逐个“分镜 × 槽位”列出 缺图/已变化/未变化(同第N版)/阻断/跳过
app.post('/:id/keyframe-batch/preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  try {
    const items = await previewEpisodeKeyframeBatch(id, {
      storyboardIds: Array.isArray(body.storyboard_ids) ? body.storyboard_ids.map(Number) : undefined,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, { items })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量关键帧预览失败')
  }
})

// POST /episodes/:id/keyframe-batch — 服务端批量关键帧（按勾选的 分镜 × 槽位 入批）
app.post('/:id/keyframe-batch', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const items: Array<{ storyboard_id: number; slot: KeyframeSlot }> = []
  for (const raw of Array.isArray(body.items) ? (body.items as unknown[]) : []) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { storyboard_id?: unknown; slot?: unknown }
    const storyboardId = Number(entry.storyboard_id)
    if (!Number.isInteger(storyboardId) || !isKeyframeSlot(entry.slot)) continue
    items.push({ storyboard_id: storyboardId, slot: entry.slot })
  }
  if (!items.length) return badRequest(c, 'items 必须是 [{ storyboard_id, slot }] 且 slot 为 first/mid/last')
  try {
    const status = await startEpisodeKeyframeBatch(id, {
      items,
      model: body.model,
      configId: body.config_id,
    })
    return success(c, status)
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '批量关键帧启动失败')
  }
})

// GET /episodes/:id/keyframe-batch — 最近一次批量的进度（刷新页面后仍可查看）
app.get('/:id/keyframe-batch', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getEpisodeKeyframeBatch(id))
})

// POST /episodes/:id/keyframe-batch/cancel — 停止：取消该批次所有未结束的关键帧任务
app.post('/:id/keyframe-batch/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, await cancelEpisodeKeyframeBatch(id))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '停止批量关键帧失败')
  }
})

// POST /episodes/:id/keyframe-batch/retry-failed — 只重提失败/已取消项（新建 sys_task）
app.post('/:id/keyframe-batch/retry-failed', async (c) => {
  const id = Number(c.req.param('id'))
  try {
    return success(c, await retryFailedKeyframeBatch(id))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '重试失败项失败')
  }
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  const links = await db.select().from(schema.storyboardCharacters)
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const propLinks = await db.select().from(schema.storyboardProps)
  const propIdsByStoryboard = new Map<number, number[]>()
  for (const link of propLinks) {
    const arr = propIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.propId)
    propIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const allChars = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const allProps = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)

  const videoTasks = (await db.select().from(schema.sysTask))
    .filter(task => task.type === 'video' && task.status === 'completed' && task.storyboardId)

  // 关键帧状态（生效首帧、就绪、确认），界面据此显示状态与承接标记
  const keyframes = await loadEpisodeKeyframes(episodeId)

  // 「当前媒体」（三个槽位的生效关键帧 + 当前分镜视频）的生成时间：一次批量反查
  const mediaPaths: Array<string | null> = []
  for (const row of rows) {
    const state = keyframes.get(row.id)
    mediaPaths.push(row.videoUrl, row.firstFrameImage, row.midFrameImage, row.lastFrameImage,
      state?.first ?? null, state?.mid ?? null, state?.last ?? null)
  }
  const mediaGeneratedAt = await lookupGeneratedAt(mediaPaths)
  return success(c, await Promise.all(rows.map(async (row) => {
    let assetVersionSelection: Record<string, string> = {}
    try {
      assetVersionSelection = row.assetVersionSelection ? JSON.parse(row.assetVersionSelection) : {}
    } catch {
      assetVersionSelection = {}
    }
    const videoVersions: Array<{
      id: number | null
      url: string | null
      provider: string | null
      model: string | null
      created_at: string | null
      generated_at: number | null
      is_current: boolean
    }> = videoTasks
      .filter(task => task.storyboardId === row.id && (task.localPath || task.resultUrl))
      .map(task => ({
        id: task.id,
        url: task.localPath || task.resultUrl,
        provider: task.provider,
        model: task.model,
        created_at: task.createdAt,
        generated_at: task.generatedAt ?? null,
        is_current: (task.localPath || task.resultUrl) === row.videoUrl,
      }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    if (row.videoUrl && !videoVersions.some(version => version.url === row.videoUrl)) {
      videoVersions.unshift({
        id: null,
        url: row.videoUrl,
        provider: 'legacy',
        model: null,
        created_at: null,
        generated_at: null,
        is_current: true,
      })
    }
    return {
      ...toSnakeCase(row),
      asset_version_selection: assetVersionSelection,
      field_saved_at: parseFieldSavedAt(row.fieldSavedAt),
      ref_issues: await checkStoryboardRefs(row),
      keyframes: keyframesJson(keyframes.get(row.id)),
      video_versions: videoVersions,
      transition_review: parseTransitionReview(row.transitionReview),
      // 上下镜输入变化后旧审核即失效，前端据此提示「建议重新审核」（#11）
      transition_stale: (() => {
        const review = parseTransitionReview(row.transitionReview)
        const prevId = keyframes.get(row.id)?.previousId
        const prev = prevId ? rows.find(item => item.id === prevId) : null
        if (!review || !prev || !keyframes.get(row.id)?.inheritsFirst) return false
        return transitionInputSignature(prev, keyframes.get(prev.id)?.last ?? null, row) !== review.input_signature
      })(),
      // 路径 → 生成时间（unix 秒）：关键帧槽位、分镜视频等「当前媒体」共用，反查不到的路径不在表里
      media_generated_at: Object.fromEntries(
        [row.videoUrl, row.firstFrameImage, row.midFrameImage, row.lastFrameImage,
          keyframes.get(row.id)?.first ?? null, keyframes.get(row.id)?.mid ?? null, keyframes.get(row.id)?.last ?? null]
          .filter((p): p is string => !!p && mediaGeneratedAt.has(p))
          .map(p => [p, mediaGeneratedAt.get(p)!]),
      ),
      character_ids: charIdsByStoryboard.get(row.id) || [],
      prop_ids: propIdsByStoryboard.get(row.id) || [],
      characters: allChars
        .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
        .map(ch => toSnakeCase(ch)),
      props: allProps
        .filter(p => (propIdsByStoryboard.get(row.id) || []).includes(p.id))
        .map(p => toSnakeCase(p)),
    }
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
// 按集聚合任务的旧接口 /generation-tasks 已删除：任务中心统一走 GET /tasks/center（sys_task.episode_id）
app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return notFound(c, '剧集不存在')

  const chars = await db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId))
  const scenes = await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId))
  const sbs = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  // 软删的成片不参与「已合成」判断：文件已被删除，继续展示会产生死链
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))

  const sbsWithImage = sbs.filter(s => s.composedImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const latestMerge = merges[merges.length - 1]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  return success(c, {
    episode_id: episodeId,
    steps: {
      script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
      extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
      extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
      extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
      generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
      generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length },
      merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
    },
  })
})

export default app
