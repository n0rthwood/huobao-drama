/**
 * 确定性片段接口（Issue #50），挂载在 /api/v1/clips。
 * 列表（含本集成片规格与新鲜度）、按表达设计生成草稿、保存图层/时间线、渲染、首末帧缩略图。
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { logTaskError } from '../utils/task-logger.js'
import { startClipRenderTask } from '../services/clip-task.js'
import { renderClipThumbnails } from '../services/clip-render.js'
import {
  PERSISTED_CLIP_POSITIONS,
  clipIsFresh,
  deleteStoryboardClip,
  getStoryboardClip,
  listStoryboardClips,
  resolveEpisodeClipSpec,
  saveClipDraft,
  saveStoryboardClip,
  type PersistedClipPosition,
} from '../services/storyboard-clips.js'

const app = new Hono()

function toPosition(raw: string | undefined): PersistedClipPosition | null {
  return raw && (PERSISTED_CLIP_POSITIONS as readonly string[]).includes(raw)
    ? (raw as PersistedClipPosition)
    : null
}

async function episodeOf(storyboardId: number): Promise<number | null> {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  return row?.episodeId ?? null
}

/** 列表 + 本集成片规格 + 每条片段是否仍对得上当前输入 */
app.get('/storyboards/:id', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const episodeId = await episodeOf(storyboardId)
  if (!episodeId) return notFound(c, '分镜不存在')
  const spec = await resolveEpisodeClipSpec(episodeId)
  const clips = await listStoryboardClips(storyboardId)
  return success(c, {
    spec,
    clips: clips.map(clip => ({ ...clip, fresh: clipIsFresh(clip, spec) })),
  })
})

/** 按 `intent.overlay_plan` 生成片段草稿（覆盖该位置的既有草稿） */
app.post('/storyboards/:id/draft', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  try {
    const clip = await saveClipDraft(storyboardId)
    if (!clip) return badRequest(c, '本镜没有表达设计、不需要确定性片段，或找不到可用底图（请先在表达设计页补锚点，并确认引用的素材有忠实原图）')
    const episodeId = await episodeOf(storyboardId)
    const spec = await resolveEpisodeClipSpec(episodeId!)
    return success(c, { spec, clip: { ...clip, fresh: clipIsFresh(clip, spec) } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('ClipAPI', 'draft', { storyboardId, error: message })
    return badRequest(c, message)
  }
})

/** 保存人工编辑后的图层文档 / 时间线 / 时长 */
app.put('/storyboards/:id/:position', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const position = toPosition(c.req.param('position'))
  if (!position) return badRequest(c, 'position 只能是 replace / pre / post')
  const episodeId = await episodeOf(storyboardId)
  if (!episodeId) return notFound(c, '分镜不存在')
  let body: Record<string, unknown> = {}
  try {
    const parsed = await c.req.json()
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  const clip = await saveStoryboardClip(storyboardId, position, {
    ...('layer_doc' in body ? { layer_doc: body.layer_doc } : {}),
    ...('timeline' in body ? { timeline: body.timeline } : {}),
    ...(body.duration !== undefined ? { duration: Number(body.duration) } : {}),
  })
  const spec = await resolveEpisodeClipSpec(episodeId)
  return success(c, { spec, clip: { ...clip, fresh: clipIsFresh(clip, spec) } })
})

app.delete('/storyboards/:id/:position', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const position = toPosition(c.req.param('position'))
  if (!position) return badRequest(c, 'position 只能是 replace / pre / post')
  await deleteStoryboardClip(storyboardId, position)
  return success(c, { deleted: true })
})

/** 渲染（同步，几秒级）：建 sys_task、出 mp4、写回 render_path/render_signature */
app.post('/storyboards/:id/:position/render', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const position = toPosition(c.req.param('position'))
  if (!position) return badRequest(c, 'position 只能是 replace / pre / post')
  try {
    const taskId = await startClipRenderTask(storyboardId, position)
    const clip = await getStoryboardClip(storyboardId, position)
    const episodeId = await episodeOf(storyboardId)
    const spec = await resolveEpisodeClipSpec(episodeId!)
    return success(c, { task_id: taskId, spec, clip: clip ? { ...clip, fresh: clipIsFresh(clip, spec) } : null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('ClipAPI', 'render', { storyboardId, position, error: message })
    return badRequest(c, message)
  }
})

/** 首/末帧缩略图：关键帧页三槽位的「由片段渲染」占位用，不落盘 */
app.get('/storyboards/:id/:position/thumbnail/:which', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const position = toPosition(c.req.param('position'))
  const which = c.req.param('which') === 'last' ? 'last' : 'first'
  if (!position) return badRequest(c, 'position 只能是 replace / pre / post')
  const clip = await getStoryboardClip(storyboardId, position)
  if (!clip) return notFound(c, '该位置还没有确定性片段')
  const episodeId = await episodeOf(storyboardId)
  try {
    const frames = await renderClipThumbnails(clip, await resolveEpisodeClipSpec(episodeId!))
    c.header('Content-Type', 'image/png')
    c.header('Cache-Control', 'no-store')
    return c.body(new Uint8Array(frames[which]))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('ClipAPI', 'thumbnail', { storyboardId, position, error: message })
    return badRequest(c, message)
  }
})

export default app
