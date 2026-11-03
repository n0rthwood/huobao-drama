/**
 * 确定性片段的任务壳（Issue #50）：`sys_task type='video', provider='clip'`。
 *
 * 它**不是**模型任务：不走 provider/模型校验、不需要 `config_id`、不进 qwen-jobs 队列，
 * 重试就是「用库里当前的图层/时间线重新渲染一遍」（见 `task-retry.ts`）。
 * 归到 `type='video'` 是为了在任务中心与分镜视频页里和模型视频并排显示。
 */
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { renderClip } from './clip-render.js'
import {
  PERSISTED_CLIP_POSITIONS,
  getStoryboardClip,
  markClipRendered,
  markClipStatus,
  resolveEpisodeClipSpec,
  type PersistedClipPosition,
} from './storyboard-clips.js'

/** 片段任务的 provider 常量：任务中心据此把它当普通行、可重试 */
export const CLIP_PROVIDER = 'clip'

/** 从任务 params 里取回片段位置（重试要知道重渲染哪一条） */
export function clipPositionOfTask(raw: string | null | undefined): PersistedClipPosition {
  if (!raw) return 'replace'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'position' in parsed) {
      const value = parsed.position
      if (typeof value === 'string' && (PERSISTED_CLIP_POSITIONS as readonly string[]).includes(value)) {
        return value as PersistedClipPosition
      }
    }
  } catch {
    return 'replace'
  }
  return 'replace'
}

/** 同一条片段不允许并发渲染（进程内锁，与 compose 的做法一致） */
const rendering = new Set<string>()

/**
 * 建任务并**同步**渲染（片段渲染只有几秒，没必要做成轮询队列）。
 * 返回新建的 sys_task id；渲染失败时任务标 failed 并抛错，片段保留上一次的成品。
 */
export async function startClipRenderTask(
  storyboardId: number,
  position: PersistedClipPosition,
): Promise<number> {
  const key = `${storyboardId}:${position}`
  if (rendering.has(key)) throw new Error('该片段正在渲染中，请等待本次渲染结束')
  const clip = await getStoryboardClip(storyboardId, position)
  if (!clip) throw new Error('本镜还没有该位置的确定性片段，请先生成草稿')
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const spec = await resolveEpisodeClipSpec(sb.episodeId)

  const ts = now()
  const inserted = await db.insert(schema.sysTask).values({
    type: 'video',
    provider: CLIP_PROVIDER,
    storyboardId,
    episodeId: sb.episodeId,
    model: 'overlay-clip',
    prompt: `确定性片段渲染（${position}）`,
    params: JSON.stringify({
      position,
      duration: clip.duration,
      size: `${spec.width}x${spec.height}`,
      fps: spec.fps,
    }),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })
  const taskId = getInsertId(inserted)

  rendering.add(key)
  await markClipStatus(clip.id, 'rendering')
  logTaskStart('ClipTask', 'render', { taskId, storyboardId, position, size: `${spec.width}x${spec.height}@${spec.fps}` })
  try {
    const result = await renderClip(clip, spec)
    await markClipRendered(clip.id, {
      render_path: result.render_path,
      render_signature: result.render_signature,
      status: 'ready',
    })
    const done = now()
    await db.update(schema.sysTask).set({
      status: 'completed',
      resultUrl: result.render_path,
      localPath: result.render_path,
      completedAt: done,
      generatedAt: Math.floor(Date.now() / 1000),
      updatedAt: done,
    }).where(eq(schema.sysTask.id, taskId))
    logTaskSuccess('ClipTask', 'render', {
      taskId,
      path: result.render_path,
      frames: String(result.frames),
      renderedFrames: String(result.rendered_frames),
      ms: String(result.ms),
    })
    return taskId
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await markClipStatus(clip.id, 'failed')
    await db.update(schema.sysTask).set({
      status: 'failed',
      errorMsg: message,
      updatedAt: now(),
    }).where(eq(schema.sysTask.id, taskId))
    logTaskError('ClipTask', 'render', { taskId, storyboardId, position, error: message })
    throw err
  } finally {
    rendering.delete(key)
  }
}
