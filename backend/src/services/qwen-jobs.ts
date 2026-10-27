/**
 * qwen-jobs 本地任务追踪器 —— 替代 qwen-jobs 任务的客户端轮询。
 *
 * 常驻循环每 3 s 把所有活跃（queued/processing）的 qwen-jobs 图片任务按配置分组，
 * 用 GET /v1/jobs?ids=（每组 ≤100）批量查询，回写 status 与 remote_state；
 * 成功的任务先取回输出字节落盘，落盘成功才标 completed 并回写业务表（服务端取回即删）。
 *
 * 没有客户端超时：服务端自己处理 20 分钟超时与 worker 掉线。
 * 网络错误/5xx/网关抖动（530/502）一律当作瞬时故障：保留任务活跃，下一轮重试；
 * 只有远端 failed/cancelled、任务记录消失（404）、输出已回收（410）才是终态。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import {
  QwenJobsError,
  QWEN_JOBS_IDS_CHUNK,
  cancelQwenJob,
  deleteQwenJob,
  downloadQwenOutput,
  listQwenJobs,
  type QwenJob,
} from './adapters/qwen-jobs-client.js'
import { completeImageTaskFromBytes, failTask, resubmitQwenJobsTask } from './generation.js'
import {
  isActiveTaskStatus,
  isQwenJobsTask,
  mapRemoteStatus,
  parseRemoteState,
  patchTaskRemoteState,
  qwenIdempotencyKey,
  remoteSnapshot,
  type SysTaskRow,
} from './sys-task.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const TICK_MS = 3_000
/** 连续多少轮查不到远端记录才判定任务消失（容忍服务端刚建任务时的短暂不可见与网关抖动） */
const MISSING_TICKS_BEFORE_FAIL = 3

const missingTicks = new Map<number, number>()
let timer: NodeJS.Timeout | null = null
let ticking = false

export async function listActiveQwenJobsTasks(): Promise<SysTaskRow[]> {
  return (await db.select().from(schema.sysTask))
    .filter(row => row.type === 'image' && isQwenJobsTask(row.provider) && isActiveTaskStatus(row.status))
}

/** 任务提交时用的那套网关与凭据；配置被删/停用时退回当前启用的图片配置 */
async function configForTask(row: SysTaskRow, cache: Map<number, AIConfig | null>): Promise<AIConfig | null> {
  const configId = parseRemoteState(row.remoteState).config_id
  if (configId != null) {
    if (!cache.has(configId)) cache.set(configId, await getConfigById(configId))
    const found = cache.get(configId)
    if (found) return found
  }
  if (!cache.has(0)) cache.set(0, await getActiveConfig('image'))
  return cache.get(0) ?? null
}

async function applyJob(row: SysTaskRow, config: AIConfig, job: QwenJob): Promise<void> {
  missingTicks.delete(row.id)

  if (job.status === 'succeeded') {
    // 取件即删：必须先把字节落盘，再标完成
    try {
      const { bytes, contentType } = await downloadQwenOutput(config, job.id, job.outputs?.[0]?.index ?? 0)
      await patchTaskRemoteState(row.id, remoteSnapshot(job), { resultUrl: `qwen-jobs:${job.id}/0` })
      const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.id))
      await completeImageTaskFromBytes(fresh ?? row, bytes, contentType)
      logTaskSuccess('ImageTask', 'qwen-jobs completed', { id: row.id, jobId: job.id })
    } catch (err) {
      if (err instanceof QwenJobsError && err.status === 410) {
        await failTask(row.id, '生成结果已被服务端回收（输出只能取回一次），请重试')
        return
      }
      // 下载/落盘失败：不标完成，下一轮重试
      logTaskWarn('ImageTask', 'qwen-jobs download retry', {
        id: row.id,
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  if (job.status === 'failed') {
    await patchTaskRemoteState(row.id, remoteSnapshot(job))
    await failTask(row.id, job.error?.message || '生成失败，请重试')
    return
  }

  const status = mapRemoteStatus(job.status)
  await patchTaskRemoteState(row.id, remoteSnapshot(job), status ? { status } : {})
}

/** 远端查不到记录：连续多轮后判定失败（服务端记录保留 24 h，超期即消失） */
async function handleMissing(row: SysTaskRow): Promise<void> {
  const count = (missingTicks.get(row.id) ?? 0) + 1
  missingTicks.set(row.id, count)
  if (count < MISSING_TICKS_BEFORE_FAIL) return
  missingTicks.delete(row.id)
  await failTask(row.id, '远端任务记录已消失（可能已过保留期），请重试')
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const rows = await listActiveQwenJobsTasks()
    if (!rows.length) return
    const cache = new Map<number, AIConfig | null>()
    const groups = new Map<string, { config: AIConfig; rows: SysTaskRow[] }>()

    for (const row of rows) {
      const config = await configForTask(row, cache)
      if (!config) {
        logTaskWarn('ImageTask', 'qwen-jobs config missing', { id: row.id })
        continue
      }
      const key = `${config.baseUrl}|${config.apiKey}`
      const group = groups.get(key) ?? { config, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }

    for (const { config, rows: groupRows } of groups.values()) {
      // 提交途中重启：请求体已落盘但没有远端 id，按同一幂等键原样重发
      const pending = groupRows.filter(row => !row.taskId)
      for (const row of pending) {
        const state = parseRemoteState(row.remoteState)
        if (!state.request) continue
        try {
          await resubmitQwenJobsTask(row.id, config, state.request, state.idempotency_key || qwenIdempotencyKey(row.id))
        } catch (err) {
          logTaskWarn('ImageTask', 'qwen-jobs resubmit retry', {
            id: row.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      const tracked = groupRows.filter(row => row.taskId)
      for (let i = 0; i < tracked.length; i += QWEN_JOBS_IDS_CHUNK) {
        const chunk = tracked.slice(i, i + QWEN_JOBS_IDS_CHUNK)
        let jobs: QwenJob[]
        try {
          jobs = await listQwenJobs(config, chunk.map(row => row.taskId as string))
        } catch (err) {
          // 网络/5xx：任务保持活跃，下一轮重试
          logTaskWarn('ImageTask', 'qwen-jobs poll retry', {
            count: chunk.length,
            error: err instanceof Error ? err.message : String(err),
          })
          continue
        }
        const byId = new Map(jobs.map(job => [job.id, job]))
        for (const row of chunk) {
          const job = byId.get(row.taskId as string)
          if (!job) {
            await handleMissing(row)
            continue
          }
          await applyJob(row, config, job)
        }
      }
    }
  } catch (err) {
    logTaskError('ImageTask', 'qwen-jobs tracker', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    ticking = false
  }
}

export function startQwenJobsTracker(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref?.()
  logTaskProgress('ImageTask', 'qwen-jobs tracker started', { intervalMs: TICK_MS })
  void tick()
}

/** 取消一个 qwen-jobs 任务：排队中立即取消，运行中按服务端规则结束，最终都是 cancelled */
export async function cancelImageTask(taskId: number): Promise<SysTaskRow> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!row) throw new Error('任务不存在')
  if (!isQwenJobsTask(row.provider)) throw new Error('该供应商不支持取消')
  if (!isActiveTaskStatus(row.status)) return row

  if (!row.taskId) {
    // 还没拿到远端 id（提交途中）：本地直接作废，追踪器不会再重发
    await db.update(schema.sysTask)
      .set({ status: 'cancelled', updatedAt: now() })
      .where(eq(schema.sysTask.id, taskId))
  } else {
    const cache = new Map<number, AIConfig | null>()
    const config = await configForTask(row, cache)
    if (!config) throw new Error('图片服务配置不存在，无法取消')
    const job = await cancelQwenJob(config, row.taskId)
    await patchTaskRemoteState(taskId, remoteSnapshot(job), job.status === 'cancelled' ? { status: 'cancelled' } : {})
  }
  logTaskWarn('ImageTask', 'qwen-jobs cancel', { id: taskId, jobId: row.taskId })
  const [updated] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  return updated!
}

/** 丢弃任务（DELETE /tasks/:id）：顺带让服务端取消并清掉它的文件 */
export async function discardRemoteJob(row: SysTaskRow): Promise<void> {
  if (!isQwenJobsTask(row.provider) || !row.taskId) return
  const config = await configForTask(row, new Map<number, AIConfig | null>())
  if (!config) return
  await deleteQwenJob(config, row.taskId).catch(err => {
    logTaskWarn('ImageTask', 'qwen-jobs delete failed', { id: row.id, error: err instanceof Error ? err.message : String(err) })
  })
}
