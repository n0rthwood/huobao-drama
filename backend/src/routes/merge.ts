import { Hono } from 'hono'
import fs from 'fs'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { mergeEpisodeVideos, MergeBlockedError, type MergeIntro } from '../services/ffmpeg-merge.js'
import { toSnakeCase } from '../utils/transform.js'
import { getAbsolutePath, thumbPathFor } from '../utils/storage.js'
import { posterPathFor } from '../utils/video-poster.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { toUnixSeconds } from '../services/media-time.js'

const app = new Hono()

// POST /episodes/:id/merge — 拼接镜头视频(body.storyboard_ids 可选,只拼所选)
app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return badRequest(c, '剧集不存在')

  // storyboard_ids 省略 = 整集范围；显式传数组 = 用户明确选镜，原样交给服务层校验
  // （空数组、非本集 id 都会被拒绝，绝不静默扩大或缩小选择）
  let storyboardIds: number[] | undefined
  let intro: MergeIntro | undefined
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}))
  if (Array.isArray(body.storyboard_ids)) {
    storyboardIds = body.storyboard_ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
  }
  if (body.poster_version_id) {
    const versionId = Number(body.poster_version_id)
    const durationRaw = Number(body.poster_duration ?? 3)
    if (!Number.isFinite(durationRaw)) return badRequest(c, 'Poster 片头时长无效')
    const [version] = await db.select().from(schema.posterVersions).where(and(
      eq(schema.posterVersions.id, versionId),
      eq(schema.posterVersions.episodeId, episodeId),
    ))
    if (!version?.image) return badRequest(c, 'Poster 版本不存在')
    if (!fs.existsSync(getAbsolutePath(version.image))) return badRequest(c, 'Poster 图片文件已丢失')
    intro = {
      imagePath: version.image,
      duration: Math.min(10, Math.max(0.5, durationRaw)),
    }
  }

  try {
    logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId, storyboardIds, intro })
    const { mergeId, skipped } = await mergeEpisodeVideos(episodeId, ep.dramaId, storyboardIds, intro)
    logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId, skipped: skipped.length })
    return success(c, { merge_id: mergeId, status: 'processing', skipped })
  } catch (err) {
    const message = err instanceof Error ? err.message : '拼接失败'
    logTaskError('MergeAPI', 'episode-merge', { episodeId, error: message })
    // 所选镜头里有不可用的：返回逐镜原因，前端据此进入同一套批量融合修复入口
    if (err instanceof MergeBlockedError) {
      return c.json({ success: false, message, blocked: err.blocked }, 400)
    }
    return badRequest(c, message)
  }
})

// GET /episodes/:id/merge — 查询最新拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))

  // 显式按创建时间取最新（行顺序不保证；软删的不参与）
  merges.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  const latest = merges[0]
  if (!latest) return success(c, null)

  return success(c, serializeMerge(latest))
})

// GET /episodes/:id/merges — 成片列表(全部拼接记录,新的在前)
app.get('/episodes/:id/merges', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt)))
  merges.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return success(c, merges.slice(0, 30).map(serializeMerge))
})

/** 成片行 → API：时间统一补 unix 秒（前端 MediaTime 只吃 unix 秒） */
function serializeMerge(row: typeof schema.videoMerges.$inferSelect) {
  return {
    ...toSnakeCase(row),
    created_at_unix: toUnixSeconds(row.createdAt),
  }
}

/**
 * DELETE /episodes/:id/merges/:mergeId — 删除成片
 *
 * 软删记录 + 删除磁盘文件（成片、海报帧、缩略图）；幂等：重复删除、文件已缺失都返回成功。
 * 正在拼接中的成片不可删（400）。若 episodes.video_url 正指向它，回退到剩余最新的已完成成片，
 * 没有则置空——否则剧详情页「已合成」会指向已删除的文件。
 */
app.delete('/episodes/:id/merges/:mergeId', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const mergeId = Number(c.req.param('mergeId'))
  const [merge] = await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.id, mergeId), eq(schema.videoMerges.episodeId, episodeId)))
  if (!merge) return notFound(c, '成片不存在')

  if (!merge.deletedAt) {
    if (isMergeInProgress(merge.status)) return badRequest(c, '正在拼接中的成片不能删除，请等待拼接结束')
    await db.update(schema.videoMerges)
      .set({ deletedAt: now() })
      .where(eq(schema.videoMerges.id, mergeId))
    removeMergeFiles(merge.mergedUrl)
    logTaskSuccess('MergeAPI', 'merge-delete', { episodeId, mergeId, file: merge.mergedUrl })
  }

  const videoUrl = await syncEpisodeVideoUrl(episodeId, merge.mergedUrl)
  return success(c, { id: mergeId, deleted: true, episode_video_url: videoUrl })
})

/** 拼接进行中（pending/processing/queued/running）的记录不可删：文件还在写 */
function isMergeInProgress(status: string | null | undefined): boolean {
  const value = status || 'pending'
  return value === 'pending' || value === 'processing' || value === 'queued' || value === 'running'
}

/** 删除成片及其衍生文件（海报帧 / 缩略图）；文件已不存在不是错误 */
function removeMergeFiles(mergedUrl: string | null) {
  if (!mergedUrl || !mergedUrl.startsWith('static/')) return
  for (const rel of [mergedUrl, posterPathFor(mergedUrl), thumbPathFor(mergedUrl)]) {
    try {
      fs.rmSync(getAbsolutePath(rel), { force: true })
    } catch (err) {
      logTaskError('MergeAPI', 'merge-delete-file', { path: rel, error: (err as Error).message })
    }
  }
}

/** 被删的是当前成片时，episodes.video_url 回退到剩余最新的已完成成片，没有则置空 */
async function syncEpisodeVideoUrl(episodeId: number, removedUrl: string | null): Promise<string | null> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return null
  if (!removedUrl || ep.videoUrl !== removedUrl) return ep.videoUrl ?? null

  const remaining = (await db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.episodeId, episodeId), isNull(schema.videoMerges.deletedAt))))
    .filter(row => row.status === 'completed' && row.mergedUrl)
    .sort((a, b) => (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || ''))
  const fallback = remaining[0]?.mergedUrl ?? null
  await db.update(schema.episodes)
    .set({ videoUrl: fallback, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
  return fallback
}

export default app
