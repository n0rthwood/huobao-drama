/**
 * 图层段的渲染任务壳（Issue #58，原 `clip-task.ts`）：`sys_task type='video', provider='layer-segment'`。
 *
 * 它**不是**模型任务：不走 provider/模型校验、不需要 `config_id`、不进 qwen-jobs 队列，
 * 重试就是「用库里当前的图层/时间线重新渲染一遍」（见 `task-retry.ts`）。
 * 归到 `type='video'` 是为了在任务中心与分镜视频页里和模型视频并排显示。
 *
 * 渲染成功后做两件契约要求的事（§3.3 + §10 裁决 5/8）：
 * 1. 衔接帧 hash 与 `storyboards.keyframes_junction_hash`（上次确认时快照的）不同 →
 *    本镜关键帧确认作废，并记 `keyframes_stale_reason='junction_updated'`；
 * 2. 清理同段旧 hash 的衔接帧 PNG，但**保留** `keyframes_junction_hash` 仍引用的那一张。
 */
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { renderLayerSegment, pruneJunctionFrames } from './layer-segment-render.js'
import {
  getLayerSegment,
  markSegmentRendered,
  markSegmentStatus,
  resolveEpisodeSegmentSpec,
  clearSegmentStaleReason,
  layerSegmentSignatureOf,
  type LayerSegmentStatus,
} from './layer-segment.js'
import { invalidateKeyframeConfirmation } from './keyframes.js'
import { toCombo } from './design-card.js'
import { refreshLayerSegmentSources, RENDER_CONSUMED_SOURCE_REASONS } from './segment-source-refresh.js'

/** 图层段任务的 provider 常量：任务中心据此把它当普通行、可重试 */
export const LAYER_SEGMENT_PROVIDER = 'layer-segment'
const LAYER_SEGMENT_MODEL = 'layer-segment'

/** 同一条图层段不允许并发渲染（进程内锁，与 compose 的做法一致） */
const rendering = new Set<number>()

export interface LayerSegmentRenderOutcome {
  task_id: number
  render_path: string
  render_signature: string
  junction: { path: string; hash: string; t: number } | null
  /** 衔接帧 hash 变了 → 本镜关键帧确认已被作废 */
  keyframes_invalidated: boolean
}

/**
 * 建任务并**同步**渲染（图层段渲染只有几秒，没必要做成轮询队列）。
 * 返回新结果；渲染失败时任务标 failed 并抛错，段保留上一次的成品与状态 failed。
 */
export async function startLayerSegmentRenderTask(storyboardId: number): Promise<LayerSegmentRenderOutcome> {
  if (rendering.has(storyboardId)) throw new Error('该图层段正在渲染中，请等待本次渲染结束')
  let segment = await getLayerSegment(storyboardId)
  if (!segment) throw new Error('本镜还没有图层段，请先生成草稿')
  if (segment.stale_reasons.some(reason => reason === 'source_unresolved' || RENDER_CONSUMED_SOURCE_REASONS.some(source => source === reason))) {
    if (!await refreshLayerSegmentSources(storyboardId)) throw new Error('图层段引用的底图或语义条目已不存在，请重新选择素材/条目或解除锚点后再渲染')
    segment = (await getLayerSegment(storyboardId))!
  }
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const combo = toCombo(sb.combo)
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)

  const ts = now()
  const inserted = await db.insert(schema.sysTask).values({
    type: 'video',
    provider: LAYER_SEGMENT_PROVIDER,
    storyboardId,
    episodeId: sb.episodeId,
    model: LAYER_SEGMENT_MODEL,
    prompt: `图层段渲染（组合 ${combo || '—'}）`,
    params: JSON.stringify({
      segment_id: segment.id,
      combo,
      duration: segment.duration,
      size: `${spec.width}x${spec.height}`,
      fps: spec.fps,
    }),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })
  const taskId = getInsertId(inserted)

  rendering.add(storyboardId)
  await markSegmentStatus(segment.id, 'rendering' as LayerSegmentStatus)
  logTaskStart('LayerSegmentTask', 'render', { taskId, storyboardId, combo, size: `${spec.width}x${spec.height}@${spec.fps}` })
  try {
    const result = await renderLayerSegment(segment, spec, combo)
    await markSegmentRendered(segment.id, {
      render_path: result.render_path,
      render_signature: result.render_signature,
      status: 'ready',
      junction_path: result.junction?.path ?? null,
      junction_hash: result.junction?.hash ?? null,
    })
    const latestSegment = await getLayerSegment(storyboardId)
    // Do not consume a second source change that arrived while ffmpeg was rendering.
    if (latestSegment && layerSegmentSignatureOf(latestSegment, spec, combo) === result.render_signature) {
      for (const reason of RENDER_CONSUMED_SOURCE_REASONS) await clearSegmentStaleReason(segment.id, reason)
    }

    // 衔接帧变了：确认时快照的 hash 对不上 → 作废确认并记原因（只在**已确认**时才有意义）
    const previousHash = sb.keyframesJunctionHash
    const nextHash = result.junction?.hash ?? null
    let invalidated = false
    if (sb.keyframesConfirmed === true && previousHash !== nextHash) {
      await invalidateKeyframeConfirmation(storyboardId, 'junction_updated')
      invalidated = true
    }
    // 保留当前衔接帧；上次确认时引用的那张旧衔接帧也保留（人工可比对），其余同段旧 hash 全部清掉
    const keep = [result.junction?.path ?? null]
    if (previousHash && previousHash !== nextHash) keep.push(`static/layer-frames/${segment.id}-${previousHash}.png`)
    await pruneJunctionFrames(segment.id, keep)

    const done = now()
    await db.update(schema.sysTask).set({
      status: 'completed',
      resultUrl: result.render_path,
      localPath: result.render_path,
      completedAt: done,
      generatedAt: Math.floor(Date.now() / 1000),
      updatedAt: done,
    }).where(eq(schema.sysTask.id, taskId))
    logTaskSuccess('LayerSegmentTask', 'render', {
      taskId,
      path: result.render_path,
      frames: String(result.frames),
      renderedFrames: String(result.rendered_frames),
      junction: result.junction?.hash || '',
      ms: String(result.ms),
    })
    return {
      task_id: taskId,
      render_path: result.render_path,
      render_signature: result.render_signature,
      junction: result.junction,
      keyframes_invalidated: invalidated,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await markSegmentStatus(segment.id, 'failed')
    await db.update(schema.sysTask).set({
      status: 'failed',
      errorMsg: message,
      updatedAt: now(),
    }).where(eq(schema.sysTask.id, taskId))
    logTaskError('LayerSegmentTask', 'render', { taskId, storyboardId, error: message })
    throw err
  } finally {
    rendering.delete(storyboardId)
  }
}

/** 重试入口：任务 params 里有分镜 id，直接重渲当前库里的那一份 */
export function storyboardIdOfSegmentTask(raw: string | null | undefined): number | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'storyboard_id' in parsed) {
      const value = Number((parsed as Record<string, unknown>).storyboard_id)
      return Number.isInteger(value) && value > 0 ? value : null
    }
  } catch { /* 坏 params 交给调用方回退到任务行自己的 storyboardId */ }
  return null
}
