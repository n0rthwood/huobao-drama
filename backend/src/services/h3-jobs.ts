/**
 * h3-jobs 本地任务追踪器 —— h3-central 视频队列任务的唯一驱动（镜像图片的 services/qwen-jobs.ts）。
 *
 * 常驻循环每 3 s 把所有活跃（queued/processing）的 h3-jobs 视频任务按配置分组，
 * 用 GET /v1/jobs?ids=（每组 ≤100）批量查询，回写 status 与 remote_state（排队位置/进度/预计）；
 * 成功的任务先取回 mp4 落盘，落盘成功才标 completed 并写回分镜（服务端取回即删）。
 *
 * 没有客户端超时：超时与 worker 掉线由队列处理。网络错误/5xx 一律当瞬时故障，下一轮重试；
 * 只有远端 failed/cancelled、任务记录消失（连续 3 拍查不到）、输出已回收（410）才是终态。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import {
  H3JobsError,
  H3_JOBS_IDS_CHUNK,
  cancelH3Job,
  deleteH3Job,
  downloadH3Output,
  listH3Jobs,
  type H3Job,
} from './adapters/h3-jobs-client.js'
import { completeVideoTaskFromBytes, failTask, resumeH3JobsTask } from './generation.js'
import {
  isActiveTaskStatus,
  isH3JobsTask,
  mapRemoteStatus,
  parseRemoteState,
  patchTaskRemoteState,
  remoteSnapshot,
  type SysTaskRow,
} from './sys-task.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const TICK_MS = 3_000
/** 连续多少轮查不到远端记录才判定任务消失（容忍刚建任务时的短暂不可见与网络抖动） */
const MISSING_TICKS_BEFORE_FAIL = 3

const missingTicks = new Map<number, number>()
let timer: NodeJS.Timeout | null = null
let ticking = false

/**
 * 追踪器要看的行：活跃的 h3-jobs 视频任务，外加"本地已终结但远端取消还没确认"的行
 * （提交与取消撞车：task_id 已落盘，远端任务还活着）—— 否则那个远端任务没人去取消。
 */
async function listTrackedH3JobsTasks(): Promise<SysTaskRow[]> {
  return (await db.select().from(schema.sysTask)).filter(row => {
    if (row.type !== 'video' || !isH3JobsTask(row.provider)) return false
    if (isActiveTaskStatus(row.status)) return true
    return !!row.taskId && !!parseRemoteState(row.remoteState).cancel_pending
  })
}

/** 任务提交时用的那套队列地址；配置被删/停用时退回当前启用的视频配置 */
async function configForTask(row: SysTaskRow, cache: Map<number, AIConfig | null>): Promise<AIConfig | null> {
  const configId = parseRemoteState(row.remoteState).config_id
  if (configId != null) {
    if (!cache.has(configId)) cache.set(configId, await getConfigById(configId))
    const found = cache.get(configId)
    if (found) return found
  }
  if (!cache.has(0)) cache.set(0, await getActiveConfig('video'))
  const fallback = cache.get(0) ?? null
  // 当前启用的视频配置已不是队列（如改回直连）：没有可用的队列地址
  return fallback && isH3JobsTask(fallback.provider) ? fallback : null
}

/**
 * 远端取消的唯一入口：取消意图（cancel_pending）先落盘，再调 POST /v1/jobs/{id}/cancel。
 * 暂时性失败保留 cancel_pending，追踪器下一拍继续重试 —— 期间任务永不标完成、永不写回。
 * 非暂时性失败（404/请求被拒）补救不了，本地直接作废；远端记录消失由 handleMissing 兜底。
 */
async function cancelRemoteJob(row: SysTaskRow, config: AIConfig, jobId: string): Promise<void> {
  try {
    const job = await cancelH3Job(config, jobId)
    const done = job.status === 'cancelled' || job.status === 'failed' || job.status === 'succeeded'
    await patchTaskRemoteState(
      row.id,
      { ...remoteSnapshot(job), cancel_pending: !done },
      done ? { status: 'cancelled' } : {},
    )
    return
  } catch (err) {
    if (err instanceof H3JobsError && err.transient) {
      logTaskWarn('VideoTask', 'h3-jobs cancel retry', { id: row.id, jobId, error: err.message })
      return
    }
    logTaskWarn('VideoTask', 'h3-jobs cancel rejected, cancelled locally', {
      id: row.id, jobId, error: err instanceof Error ? err.message : String(err),
    })
  }
  await patchTaskRemoteState(row.id, { cancel_pending: false }, { status: 'cancelled' })
}

async function applyJob(row: SysTaskRow, config: AIConfig, job: H3Job): Promise<void> {
  missingTicks.delete(row.id)

  // 本地已请求取消：绝不取件、绝不写回；远端还活着就继续推进取消
  if (parseRemoteState(row.remoteState).cancel_pending) {
    if (job.status === 'queued' || job.status === 'running') {
      // 队列已收下取消请求（运行中的任务由它中断引擎后收尾）：等它变终态即可
      if (job.cancel_requested) await patchTaskRemoteState(row.id, remoteSnapshot(job))
      else await cancelRemoteJob(row, config, job.id)
      return
    }
    await patchTaskRemoteState(row.id, { ...remoteSnapshot(job), cancel_pending: false }, { status: 'cancelled' })
    logTaskWarn('VideoTask', 'h3-jobs cancelled after remote finish', { id: row.id, jobId: job.id, remote: job.status })
    return
  }

  if (job.status === 'succeeded') {
    // 取件即删：必须先把字节落盘，再标完成
    try {
      const bytes = await downloadH3Output(config, job.id, job.outputs?.[0]?.index ?? 0)
      await patchTaskRemoteState(row.id, remoteSnapshot(job), { resultUrl: `h3-jobs:${job.id}/0` })
      const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.id))
      // 下载期间被取消（已终结，或取消意图已落盘）：不落盘、不写回
      if (fresh && (!isActiveTaskStatus(fresh.status) || parseRemoteState(fresh.remoteState).cancel_pending)) {
        logTaskWarn('VideoTask', 'h3-jobs result dropped (cancelled)', { id: row.id, jobId: job.id })
        return
      }
      await completeVideoTaskFromBytes(fresh ?? row, bytes)
      logTaskSuccess('VideoTask', 'h3-jobs completed', { id: row.id, jobId: job.id })
    } catch (err) {
      if (err instanceof H3JobsError && err.status === 410) {
        await failTask(row.id, '生成结果已被服务端回收（输出只能取回一次），请重试')
        return
      }
      // 下载/落盘失败：不标完成，下一轮重试
      logTaskWarn('VideoTask', 'h3-jobs download retry', {
        id: row.id, jobId: job.id, error: err instanceof Error ? err.message : String(err),
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

/** 远端查不到记录：连续多轮后判定失败（终态记录在输出取走后保留 24 h，超期即消失） */
async function handleMissing(row: SysTaskRow): Promise<void> {
  const count = (missingTicks.get(row.id) ?? 0) + 1
  missingTicks.set(row.id, count)
  if (count < MISSING_TICKS_BEFORE_FAIL) return
  missingTicks.delete(row.id)
  if (parseRemoteState(row.remoteState).cancel_pending) {
    await patchTaskRemoteState(row.id, { cancel_pending: false }, { status: 'cancelled' })
  }
  await failTask(row.id, '远端任务记录已消失（可能已过保留期），请重试')
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const rows = await listTrackedH3JobsTasks()
    if (!rows.length) return
    const cache = new Map<number, AIConfig | null>()
    const groups = new Map<string, { config: AIConfig; rows: SysTaskRow[] }>()

    for (const row of rows) {
      const config = await configForTask(row, cache)
      if (!config) {
        logTaskWarn('VideoTask', 'h3-jobs config missing', { id: row.id })
        // 还没提交过（没有远端 id）且没有可用配置：永远也提交不出去，不能让它一直活跃
        if (!row.taskId) await failTask(row.id, '视频服务配置不存在或已停用，任务无法提交，请检查配置后重试')
        continue
      }
      const key = `${config.baseUrl}|${config.apiKey}`
      const group = groups.get(key) ?? { config, rows: [] }
      group.rows.push(row)
      groups.set(key, group)
    }

    for (const { config, rows: groupRows } of groups.values()) {
      // 没有远端 id 的行：请求体已落盘的原样重发，没有请求体的回到完整提交路径（同一幂等键）。
      // 扩写/上传可能很慢，不阻塞本拍的轮询；重入由 generation 的在途集合挡住。
      for (const row of groupRows.filter(row => !row.taskId)) void resumeH3JobsTask(row, config)

      const tracked = groupRows.filter(row => row.taskId)
      for (let i = 0; i < tracked.length; i += H3_JOBS_IDS_CHUNK) {
        const chunk = tracked.slice(i, i + H3_JOBS_IDS_CHUNK)
        let jobs: H3Job[]
        try {
          jobs = await listH3Jobs(config, chunk.map(row => row.taskId as string))
        } catch (err) {
          logTaskWarn('VideoTask', 'h3-jobs poll retry', {
            count: chunk.length, error: err instanceof Error ? err.message : String(err),
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
    logTaskError('VideoTask', 'h3-jobs tracker', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    ticking = false
  }
}

export function startH3JobsTracker(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, TICK_MS)
  timer.unref?.()
  logTaskProgress('VideoTask', 'h3-jobs tracker started', { intervalMs: TICK_MS })
  void tick()
}

/**
 * 取消一个 h3-jobs 视频任务：排队中立即取消，运行中由队列中断引擎后收尾，最终都是 cancelled。
 * 取消意图先落盘（cancel_pending）：远端取消失败时任务保持活跃但永不写回，由追踪器继续重试。
 */
export async function cancelVideoTask(taskId: number): Promise<SysTaskRow> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!row) throw new Error('任务不存在')
  if (!isH3JobsTask(row.provider)) throw new Error('该供应商不支持取消')
  if (!isActiveTaskStatus(row.status)) return row

  if (!row.taskId) {
    // 还没拿到远端 id（扩写/上传/提交途中）：本地立即作废，提交线程落盘 task_id 时会自行取消远端
    await patchTaskRemoteState(taskId, {}, { status: 'cancelled' })
  } else {
    const config = await configForTask(row, new Map<number, AIConfig | null>())
    if (!config) throw new Error('视频服务配置不存在，无法取消')
    await patchTaskRemoteState(taskId, { cancel_pending: true })
    await cancelRemoteJob(row, config, row.taskId)
  }
  logTaskWarn('VideoTask', 'h3-jobs cancel', { id: taskId, jobId: row.taskId })
  const [updated] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  return updated!
}

/** 丢弃任务（DELETE /tasks/:id）：顺带让队列取消并清掉它的文件 */
export async function discardRemoteVideoJob(row: SysTaskRow): Promise<void> {
  if (!isH3JobsTask(row.provider) || !row.taskId) return
  const config = await configForTask(row, new Map<number, AIConfig | null>())
  if (!config) return
  await deleteH3Job(config, row.taskId).catch(err => {
    logTaskWarn('VideoTask', 'h3-jobs delete failed', { id: row.id, error: err instanceof Error ? err.message : String(err) })
  })
}
