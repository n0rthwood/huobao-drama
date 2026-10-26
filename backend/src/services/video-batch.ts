/**
 * 服务端批量视频生成 — 按分镜顺序串行，脱离浏览器
 *
 * 提交 → 等待 sys_task 终态（完成即自动采用）→ 下一镜；承接镜头的尾帧在它提交的那一刻才提取。
 * 批次状态持久化在 video_batches，后端重启（开发机 tsx watch 很常见）后自动恢复：
 * 被重启中断的那一镜重新提交（接受上游可能残留的重复任务）。
 */
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { getVideoAdapter } from './adapters/registry'
import { loadEpisodeContinuity } from './continuity.js'
import { listEpisodeStoryboards, submitStoryboardVideo } from './storyboard-video.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

export type BatchStatus = 'running' | 'done' | 'cancelled'
export type BatchItemState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface VideoBatchItem {
  storyboard_id: number
  storyboard_number: number
  state: BatchItemState
  task_id: number | null
  error: string | null
  continuity: boolean
}

export interface VideoBatchStatus {
  id: number
  episode_id: number
  status: BatchStatus
  current_storyboard_id: number | null
  created_at: string
  updated_at: string
  /** 已请求停止：不再提交新的镜头，在跑的那一镜等它跑完后批次转为 cancelled */
  cancel_requested: boolean
  items: VideoBatchItem[]
}

interface BatchOptions {
  model?: string
  configId?: number
  /** 停止请求随批次持久化：重启恢复后仍然生效 */
  cancelRequested?: boolean
}

/** 单镜等待上限：生成链路自身已有界（等待引擎 30 分钟 + 轮询 50 分钟），这里留出余量兜底 */
const ITEM_WAIT_TIMEOUT_MS = 95 * 60_000
const ITEM_POLL_INTERVAL_MS = 5_000
/** 等待"生成完成 → 写回 storyboards.video_url"落库的短窗口 */
const ADOPT_WAIT_TIMEOUT_MS = 60_000
const ADOPT_POLL_INTERVAL_MS = 500

/** 进程内已有 runner 的批次，避免启动恢复与新建批次重复驱动同一批 */
const activeRunners = new Set<number>()

function parseItems(raw: string | null | undefined): VideoBatchItem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as VideoBatchItem[] : []
  } catch {
    return []
  }
}

function parseOptions(raw: string | null | undefined): BatchOptions {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as BatchOptions : {}
  } catch {
    return {}
  }
}

function toStatus(row: typeof schema.videoBatches.$inferSelect): VideoBatchStatus {
  const items = parseItems(row.items)
  return {
    id: row.id,
    episode_id: row.episodeId,
    status: (row.status || 'running') as BatchStatus,
    current_storyboard_id: items.find(item => item.state === 'running')?.storyboard_id ?? null,
    cancel_requested: !!parseOptions(row.options).cancelRequested,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    items,
  }
}

async function loadBatch(batchId: number) {
  const [row] = await db.select().from(schema.videoBatches).where(eq(schema.videoBatches.id, batchId))
  return row
}

async function saveItems(batchId: number, items: VideoBatchItem[]) {
  await db.update(schema.videoBatches)
    .set({ items: JSON.stringify(items), updatedAt: now() })
    .where(eq(schema.videoBatches.id, batchId))
}

async function setBatchStatus(batchId: number, status: BatchStatus) {
  await db.update(schema.videoBatches)
    .set({ status, updatedAt: now() })
    .where(eq(schema.videoBatches.id, batchId))
}

/** 本集未完成的批次（running）；用于互斥与单镜生成拦截 */
async function loadRunningBatch(episodeId: number) {
  const rows = await db.select().from(schema.videoBatches)
    .where(and(eq(schema.videoBatches.episodeId, episodeId), eq(schema.videoBatches.status, 'running')))
  return rows.sort((a, b) => b.id - a.id)[0]
}

/** 某分镜是否正排在某个运行中的批次里（pending/running）——单镜手动生成据此拒绝，避免打乱串行承接 */
export async function findActiveBatchForStoryboard(storyboardId: number): Promise<number | null> {
  const rows = await db.select().from(schema.videoBatches)
    .where(eq(schema.videoBatches.status, 'running'))
  for (const row of rows) {
    const hit = parseItems(row.items).some(item =>
      item.storyboard_id === storyboardId && (item.state === 'pending' || item.state === 'running'))
    if (hit) return row.id
  }
  return null
}

export async function getEpisodeVideoBatch(episodeId: number): Promise<VideoBatchStatus | null> {
  const rows = await db.select().from(schema.videoBatches)
    .where(eq(schema.videoBatches.episodeId, episodeId))
  const latest = rows.sort((a, b) => b.id - a.id)[0]
  return latest ? toStatus(latest) : null
}

/** 停止：只是不再提交新的镜头；在跑的那一镜继续跑完，之后批次转为 cancelled */
export async function cancelEpisodeVideoBatch(episodeId: number): Promise<VideoBatchStatus> {
  const running = await loadRunningBatch(episodeId)
  if (!running) throw new Error('本集没有正在运行的批量视频任务')
  const options = parseOptions(running.options)
  await db.update(schema.videoBatches)
    .set({ options: JSON.stringify({ ...options, cancelRequested: true }), updatedAt: now() })
    .where(eq(schema.videoBatches.id, running.id))
  logTaskWarn('VideoBatch', 'cancel', { batchId: running.id, episodeId })
  // 没有 runner 在驱动（runner 异常退出）时直接落盘 cancelled，避免批次永远占着本集的互斥位；
  // 否则由 runner 在当前镜头结束后的下一轮落盘 cancelled
  if (!activeRunners.has(running.id)) await setBatchStatus(running.id, 'cancelled')
  const row = await loadBatch(running.id)
  return toStatus(row!)
}

/** 启动批量：目标为所选分镜，未指定则是尚未生成视频的分镜；预检不通过直接抛错（不创建批次） */
export async function startEpisodeVideoBatch(
  episodeId: number,
  opts: { storyboardIds?: number[]; model?: string; configId?: number } = {},
): Promise<VideoBatchStatus> {
  if (await loadRunningBatch(episodeId)) throw new Error('本集已有批量视频在运行')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')

  const storyboards = await listEpisodeStoryboards(episodeId)
  if (!storyboards.length) throw new Error('本集还没有分镜')

  // 正在生成中的分镜不纳入批量，避免同一镜被重复提交
  const processingIds = new Set((await db.select().from(schema.sysTask))
    .filter(task => task.type === 'video' && task.status === 'processing' && task.storyboardId)
    .map(task => task.storyboardId as number))

  const selected = opts.storyboardIds?.length
    ? storyboards.filter(sb => opts.storyboardIds!.includes(sb.id))
    : storyboards.filter(sb => !(sb.videoUrl || sb.composedVideoUrl))
  const targets = selected.filter(sb => !processingIds.has(sb.id))
  if (!targets.length) throw new Error('没有需要生成的分镜')

  const continuity = await loadEpisodeContinuity(episodeId)
  const targetIds = new Set(targets.map(sb => sb.id))
  const numberById = new Map(storyboards.map(sb => [sb.id, sb.storyboardNumber]))

  // 预检 1：承接镜头的上一镜必须在本批更早位置，或已有采用视频
  const missingSource: number[] = []
  for (const sb of targets) {
    const entry = continuity.get(sb.id)
    if (!entry?.effective || !entry.previousId) continue
    const previous = storyboards.find(row => row.id === entry.previousId)
    const previousInBatch = targetIds.has(entry.previousId)
      && (numberById.get(entry.previousId) ?? 0) < sb.storyboardNumber
    if (!previousInBatch && !(previous?.videoUrl || previous?.composedVideoUrl)) {
      missingSource.push(sb.storyboardNumber)
    }
  }
  if (missingSource.length) {
    throw new Error(`以下镜头需要承接上一镜尾帧，但上一镜既不在本次批量中、也没有采用视频：${missingSource.map(n => `#${n}`).join('、')}`)
  }

  // 预检 2：有承接镜头时，所选模型必须支持首帧引导
  const continuityNumbers = targets.filter(sb => continuity.get(sb.id)?.effective).map(sb => sb.storyboardNumber)
  if (continuityNumbers.length) {
    const configId = opts.configId ?? episode.videoConfigId ?? undefined
    const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('video') : await getActiveConfig('video')
    if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
    if (!getVideoAdapter(config.provider).supportsFrameGuides) {
      throw new Error(`当前视频模型（${config.provider}）不支持首帧引导，无法生成承接镜头：${continuityNumbers.map(n => `#${n}`).join('、')}`)
    }
  }

  const items: VideoBatchItem[] = targets.map(sb => ({
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    state: 'pending',
    task_id: null,
    error: null,
    continuity: !!continuity.get(sb.id)?.effective,
  }))

  const ts = now()
  const res = await db.insert(schema.videoBatches).values({
    episodeId,
    status: 'running',
    options: JSON.stringify({ model: opts.model, configId: opts.configId }),
    items: JSON.stringify(items),
    createdAt: ts,
    updatedAt: ts,
  })
  const batchId = getInsertId(res)
  logTaskStart('VideoBatch', 'batch', {
    batchId,
    episodeId,
    total: items.length,
    continuityShots: continuityNumbers.length,
    model: opts.model || undefined,
  })
  void runBatch(batchId)
  const row = await loadBatch(batchId)
  return toStatus(row!)
}

/** 等待单镜的 sys_task 到达终态 */
async function waitForTask(taskId: number): Promise<{ ok: boolean; error: string | null }> {
  const deadline = Date.now() + ITEM_WAIT_TIMEOUT_MS
  for (;;) {
    // 与 generation.ts 的轮询同一写法（tsconfig target ES2022 不含 Promise.withResolvers 的类型）
    await new Promise(resolve => setTimeout(resolve, ITEM_POLL_INTERVAL_MS))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) return { ok: false, error: '生成任务记录丢失' }
    if (task.status === 'completed') return { ok: true, error: null }
    if (task.status === 'failed') return { ok: false, error: task.errorMsg || '生成失败' }
    if (Date.now() > deadline) return { ok: false, error: '等待生成超时' }
  }
}

/**
 * sys_task 置为 completed 与把视频写回 storyboards.video_url 是两条语句（generation.ts handleVideoComplete），
 * 中间有一次 await。下一镜承接时要读上一镜的采用视频，这里等采用结果落库后再推进。
 */
async function waitForAdoptedVideo(storyboardId: number): Promise<void> {
  const deadline = Date.now() + ADOPT_WAIT_TIMEOUT_MS
  for (;;) {
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
    if (sb?.videoUrl || sb?.composedVideoUrl) return
    if (Date.now() > deadline) {
      logTaskWarn('VideoBatch', 'adopt wait timeout', { storyboardId })
      return
    }
    await new Promise(resolve => setTimeout(resolve, ADOPT_POLL_INTERVAL_MS))
  }
}

/** 失败/跳过的镜头会断开承接链：后续依赖它的镜头标为跳过，到下一个切换边界恢复 */
async function applySkipChain(episodeId: number, items: VideoBatchItem[]): Promise<void> {
  const continuity = await loadEpisodeContinuity(episodeId)
  const storyboards = await listEpisodeStoryboards(episodeId)
  const numberById = new Map(storyboards.map(sb => [sb.id, sb.storyboardNumber]))
  const broken = new Set(items
    .filter(item => item.state === 'failed' || item.state === 'skipped')
    .map(item => item.storyboard_id))
  for (const item of items) {
    if (item.state !== 'pending') continue
    const entry = continuity.get(item.storyboard_id)
    if (!entry?.effective || !entry.previousId || !broken.has(entry.previousId)) continue
    item.state = 'skipped'
    item.error = `上一镜 #${numberById.get(entry.previousId) ?? '?'} 未成功生成，跳过承接`
    broken.add(item.storyboard_id)
  }
}

/** 串行驱动一个批次直到完成/取消；进程内同一批次只有一个 runner */
async function runBatch(batchId: number): Promise<void> {
  if (activeRunners.has(batchId)) return
  activeRunners.add(batchId)
  try {
    for (;;) {
      const row = await loadBatch(batchId)
      if (!row) return
      if (row.status !== 'running') {
        logTaskWarn('VideoBatch', 'batch stopped', { batchId, status: row.status })
        return
      }
      const items = parseItems(row.items)
      const options = parseOptions(row.options)
      // 停止请求：在跑的那一镜已在上一轮 await 完并落盘，这里不再提交新的镜头
      if (options.cancelRequested) {
        await setBatchStatus(batchId, 'cancelled')
        logTaskWarn('VideoBatch', 'batch cancelled', { batchId, episodeId: row.episodeId })
        return
      }
      // pending 正常推进；running 只会出现在重启恢复时，重新提交那一镜
      const index = items.findIndex(item => item.state === 'pending' || item.state === 'running')
      if (index < 0) {
        await setBatchStatus(batchId, 'done')
        logTaskSuccess('VideoBatch', 'batch', {
          batchId,
          episodeId: row.episodeId,
          completed: items.filter(item => item.state === 'completed').length,
          failed: items.filter(item => item.state === 'failed').length,
          skipped: items.filter(item => item.state === 'skipped').length,
        })
        return
      }

      const item = items[index]!
      item.state = 'running'
      item.error = null
      item.task_id = null
      await saveItems(batchId, items)
      logTaskProgress('VideoBatch', 'shot submit', {
        batchId,
        storyboardId: item.storyboard_id,
        shotNumber: item.storyboard_number,
        continuity: item.continuity,
      })

      try {
        const taskId = await submitStoryboardVideo(item.storyboard_id, options)
        item.task_id = taskId
        await saveItems(batchId, items)
        const result = await waitForTask(taskId)
        item.state = result.ok ? 'completed' : 'failed'
        item.error = result.error
        // 下一镜可能要承接这一镜的尾帧：等采用结果写回分镜后再推进
        if (result.ok) await waitForAdoptedVideo(item.storyboard_id)
      } catch (err) {
        item.state = 'failed'
        item.error = err instanceof Error ? err.message : '生成失败'
      }

      if (item.state === 'failed') {
        logTaskError('VideoBatch', 'shot', {
          batchId,
          storyboardId: item.storyboard_id,
          shotNumber: item.storyboard_number,
          error: item.error,
        })
        await applySkipChain(row.episodeId, items)
      } else {
        logTaskSuccess('VideoBatch', 'shot', {
          batchId,
          storyboardId: item.storyboard_id,
          shotNumber: item.storyboard_number,
          taskId: item.task_id,
        })
      }
      await saveItems(batchId, items)
    }
  } catch (err) {
    logTaskError('VideoBatch', 'batch', { batchId, error: err instanceof Error ? err.message : String(err) })
    // runner 异常退出：转为 cancelled，释放本集互斥位（已提交的镜头不受影响）
    await setBatchStatus(batchId, 'cancelled').catch(() => {})
  } finally {
    activeRunners.delete(batchId)
  }
}

/** 启动时恢复被重启打断的批次：状态仍为 running 的批次继续跑，中断的那一镜重新提交 */
export async function resumeVideoBatches(): Promise<void> {
  try {
    const rows = await db.select().from(schema.videoBatches)
      .where(eq(schema.videoBatches.status, 'running'))
    for (const row of rows) {
      const interrupted = parseItems(row.items).find(item => item.state === 'running')
      logTaskProgress('VideoBatch', 'resume', {
        batchId: row.id,
        episodeId: row.episodeId,
        // 上游可能仍在跑同一镜，这里接受重复生成
        resubmitStoryboardId: interrupted?.storyboard_id ?? null,
      })
      void runBatch(row.id)
    }
  } catch (err) {
    logTaskError('VideoBatch', 'resume', { error: err instanceof Error ? err.message : String(err) })
  }
}
