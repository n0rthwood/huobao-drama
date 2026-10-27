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
import { completeImageTaskFromBytes, failTask, resumeQwenJobsTask } from './generation.js'
import {
  isActiveTaskStatus,
  isQwenJobsTask,
  mapRemoteStatus,
  parseRemoteState,
  patchTaskRemoteState,
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

/**
 * 追踪器要看的行：活跃任务，外加"本地已终结但远端取消还没确认"的行
 * （提交与取消撞车：task_id 已落盘，远端任务还活着）—— 否则那个远端任务没人去取消。
 */
async function listTrackedQwenJobsTasks(): Promise<SysTaskRow[]> {
  return (await db.select().from(schema.sysTask)).filter(row => {
    if (row.type !== 'image' || !isQwenJobsTask(row.provider)) return false
    if (isActiveTaskStatus(row.status)) return true
    return !!row.taskId && !!parseRemoteState(row.remoteState).cancel_pending
  })
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

/**
 * 远端取消的唯一入口：取消意图（cancel_pending）先落盘，再调 POST /v1/jobs/{id}/cancel。
 * 网络/5xx/429 等暂时性失败保留 cancel_pending，追踪器下一拍继续重试 —— 重试期间
 * 这个任务永远不会被标完成，也就不会写回任何图片，而且超时不会把它当成已取消。
 * 非暂时性失败（404/鉴权/请求被拒）补救不了，本地直接作废让任务进入终态；
 * 远端记录彻底消失的情况由 handleMissing 兜底。
 */
async function cancelRemoteJob(row: SysTaskRow, config: AIConfig, jobId: string): Promise<void> {
  try {
    const job = await cancelQwenJob(config, jobId)
    const done = job.status === 'cancelled' || job.status === 'failed' || job.status === 'succeeded'
    await patchTaskRemoteState(
      row.id,
      { ...remoteSnapshot(job), cancel_pending: !done },
      done ? { status: 'cancelled' } : {},
    )
    return
  } catch (err) {
    if (err instanceof QwenJobsError && err.transient) {
      logTaskWarn('ImageTask', 'qwen-jobs cancel retry', {
        id: row.id, jobId, error: err.message,
      })
      return
    }
    logTaskWarn('ImageTask', 'qwen-jobs cancel rejected, cancelled locally', {
      id: row.id, jobId, error: err instanceof Error ? err.message : String(err),
    })
  }
  await patchTaskRemoteState(row.id, { cancel_pending: false }, { status: 'cancelled' })
}

async function applyJob(row: SysTaskRow, config: AIConfig, job: QwenJob): Promise<void> {
  missingTicks.delete(row.id)

  // 本地已请求取消：绝不取件、绝不写回；远端还活着就继续推进取消
  if (parseRemoteState(row.remoteState).cancel_pending) {
    if (job.status === 'queued' || job.status === 'running') {
      // 服务端已经收下取消请求（运行中的任务按它自己的规则收尾）：等它变终态即可
      if (job.cancel_requested) await patchTaskRemoteState(row.id, remoteSnapshot(job))
      else await cancelRemoteJob(row, config, job.id)
      return
    }
    await patchTaskRemoteState(row.id, { ...remoteSnapshot(job), cancel_pending: false }, { status: 'cancelled' })
    logTaskWarn('ImageTask', 'qwen-jobs cancelled after remote finish', { id: row.id, jobId: job.id, remote: job.status })
    return
  }

  if (job.status === 'succeeded') {
    // 取件即删：必须先把字节落盘，再标完成
    try {
      const { bytes, contentType } = await downloadQwenOutput(config, job.id, job.outputs?.[0]?.index ?? 0)
      await patchTaskRemoteState(row.id, remoteSnapshot(job), { resultUrl: `qwen-jobs:${job.id}/0` })
      const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.id))
      // 下载期间被取消（状态已终结，或取消意图已落盘但远端还没确认）：不落盘、不写回
      if (fresh && (!isActiveTaskStatus(fresh.status) || parseRemoteState(fresh.remoteState).cancel_pending)) {
        logTaskWarn('ImageTask', 'qwen-jobs result dropped (cancelled)', { id: row.id, jobId: job.id })
        return
      }
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
  // 远端记录没了就没什么可取消的：清掉取消意图，否则这一行会被一直轮询
  if (parseRemoteState(row.remoteState).cancel_pending) {
    await patchTaskRemoteState(row.id, { cancel_pending: false }, { status: 'cancelled' })
  }
  await failTask(row.id, '远端任务记录已消失（可能已过保留期），请重试')
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const rows = await listTrackedQwenJobsTasks()
    if (!rows.length) return
    const cache = new Map<number, AIConfig | null>()
    const groups = new Map<string, { config: AIConfig; rows: SysTaskRow[] }>()

    for (const row of rows) {
      const config = await configForTask(row, cache)
      if (!config) {
        logTaskWarn('ImageTask', 'qwen-jobs config missing', { id: row.id })
        // 还没提交过（没有远端 id）且没有可用配置：永远也提交不出去，不能让它一直活跃
        if (!row.taskId) await failTask(row.id, '图片服务配置不存在或已停用，任务无法提交，请检查配置后重试')
        continue
      }
      const key = `${config.baseUrl}|${config.apiKey}`
      const group = groups.get(key) ?? { config, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }

    for (const { config, rows: groupRows } of groups.values()) {
      // 没有远端 id 的行：请求体已落盘的原样重发，连请求体都没有的（上传途中重启）
      // 回到完整提交路径。都用同一个幂等键，服务端不会重复出图。
      // 上传可能很慢，所以不阻塞本拍的轮询；重入由 generation 的在途集合挡住。
      for (const row of groupRows.filter(row => !row.taskId)) void resumeQwenJobsTask(row, config)

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

/**
 * 取消一个 qwen-jobs 任务：排队中立即取消，运行中按服务端规则结束，最终都是 cancelled。
 * 取消意图先落盘（cancel_pending）：远端取消失败时任务保持活跃但永不写回，
 * 由追踪器继续重试；调用方用返回行的状态判断是否已经真正结束。
 */
export async function cancelImageTask(taskId: number): Promise<SysTaskRow> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!row) throw new Error('任务不存在')
  if (!isQwenJobsTask(row.provider)) throw new Error('该供应商不支持取消')
  if (!isActiveTaskStatus(row.status)) return row

  if (!row.taskId) {
    // 还没拿到远端 id（提交途中）：本地立即作废。提交线程落盘 task_id 时会看到终态，
    // 由它把刚建好的远端任务取消 —— 这里不需要 cancel_pending。
    await patchTaskRemoteState(taskId, {}, { status: 'cancelled' })
  } else {
    const config = await configForTask(row, new Map<number, AIConfig | null>())
    if (!config) throw new Error('图片服务配置不存在，无法取消')
    await patchTaskRemoteState(taskId, { cancel_pending: true })
    await cancelRemoteJob(row, config, row.taskId)
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
