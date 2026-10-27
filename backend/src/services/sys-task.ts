/**
 * sys_task 的状态语义与对外序列化 —— 生成链路、批量、路由共用。
 *
 * 状态：queued（远端排队中）| processing（远端运行中或其它 provider 生成中）| completed | failed | cancelled。
 * remote_state（TEXT JSON）保存 qwen-jobs 任务的最近一次快照，另外保留内部键：
 *   request（提交用的请求体，先落盘再调远端，重启后按同一幂等键原样重发）、
 *   config_id（追踪器据此找回 baseUrl/凭据）、idempotency_key。
 * 这三个内部键只存库，不出 API。
 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskWarn } from '../utils/task-logger.js'
import type { QwenJob, QwenJobRequest } from './adapters/qwen-jobs-client.js'

import { isJobQueueImageProvider } from './adapters/registry.js'

export { QWEN_JOBS_PROVIDER } from './adapters/registry.js'

export type SysTaskRow = typeof schema.sysTask.$inferSelect
export type SysTaskStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

/** 活跃（未终结）任务：排队中或生成中 */
export const ACTIVE_TASK_STATUSES: SysTaskStatus[] = ['queued', 'processing']

export function isActiveTaskStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'processing'
}

/** 该任务是否走服务端任务队列（qwen-jobs）——provider → 执行方式的映射在 adapters/registry.ts */
export function isQwenJobsTask(provider: string | null | undefined): boolean {
  return isJobQueueImageProvider(provider)
}

export interface RemoteState {
  request?: QwenJobRequest
  config_id?: number
  idempotency_key?: string
  remote_status?: string
  queue?: QwenJob['queue']
  progress?: QwenJob['progress']
  estimate?: QwenJob['estimate']
  estimated_finish_seconds?: number | null
  cancel_requested?: boolean
  /** 本地已请求取消但远端还没确认（取消接口失败/提交在途）：追踪器据此重试取消且永不写回结果 */
  cancel_pending?: boolean
  updated_at?: string
}

export function parseRemoteState(raw: string | null | undefined): RemoteState {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as RemoteState : {}
  } catch {
    return {}
  }
}

/** 远端任务对象 → 对前端可见的 remote_state 字段 */
export function remoteSnapshot(job: QwenJob): RemoteState {
  return {
    remote_status: job.status,
    queue: job.queue ?? null,
    progress: job.progress ?? null,
    estimate: job.estimate ?? null,
    estimated_finish_seconds: job.estimated_finish_seconds ?? null,
    cancel_requested: !!job.cancel_requested,
    updated_at: now(),
  }
}

async function applyRemoteStatePatch(
  id: number,
  patch: RemoteState,
  extra: { status?: SysTaskStatus; taskId?: string; resultUrl?: string; errorMsg?: string | null },
): Promise<SysTaskRow | null> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!row) return null
  const merged: RemoteState = { ...parseRemoteState(row.remoteState), ...patch }
  const { status, ...rest } = extra
  await db.update(schema.sysTask)
    .set({ remoteState: JSON.stringify(merged), updatedAt: now(), ...rest })
    .where(eq(schema.sysTask.id, id))
  if (status) {
    await db.update(schema.sysTask)
      .set({ status, updatedAt: now() })
      .where(and(eq(schema.sysTask.id, id), inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES)))
  }
  const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (status && fresh && fresh.status !== status) {
    logTaskWarn('SysTask', 'terminal status kept', { id, kept: fresh.status, ignored: status })
  }
  return fresh ?? null
}

/** 同一任务的 remote_state 读-改-写串行化：取消与提交并发时不能用过期快照盖掉对方写入的键 */
const patchQueues = new Map<number, Promise<SysTaskRow | null>>()

/**
 * 合并写入 remote_state（保留 request/config_id 等内部键），可同时改状态与远端任务 id。
 *
 * remote_state 与 task_id 无条件落盘：取消链路要靠 task_id 找到刚建好的远端任务。
 * 状态迁移则带 `status IN (queued, processing)` 条件，终态永不被改回活跃 ——
 * 提交与取消是并发的，迟到的提交结果绝不能把用户已取消的任务复活。
 * 返回写入后的那一行：调用方据此判断“这次写入落在一个已终结的任务上”，
 * 从而把刚建好的远端任务取消掉。
 */
export async function patchTaskRemoteState(
  id: number,
  patch: RemoteState,
  extra: { status?: SysTaskStatus; taskId?: string; resultUrl?: string; errorMsg?: string | null } = {},
): Promise<SysTaskRow | null> {
  const run = (patchQueues.get(id) ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => applyRemoteStatePatch(id, patch, extra))
  patchQueues.set(id, run)
  try {
    return await run
  } finally {
    if (patchQueues.get(id) === run) patchQueues.delete(id)
  }
}

/** 远端任务状态 → sys_task 状态（succeeded 要先落盘再标 completed，故不在此映射） */
export function mapRemoteStatus(status: QwenJob['status']): SysTaskStatus | null {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'processing'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return null
}

/**
 * 幂等键：每个 sys_task 首次提交时新生成并随请求体落盘，重启重发沿用落盘的键。
 * 只用 sys_task id 不够——id 在数据库重建/拷贝（如 worktree QA）后会重复，服务端按 key 去重会把
 * 新任务当成旧任务（409 idempotency_conflict）。重试必须新建 sys_task（新 key）。
 */
export function qwenIdempotencyKey(taskId: number): string {
  return `huobao-sys_task-${taskId}-${randomUUID()}`
}

/** API 输出：snake_case + remote_state 已解析（剥掉内部键）+ cancellable */
export function serializeTask(row: SysTaskRow): Record<string, any> {
  const {
    request: _request, config_id: _configId, idempotency_key: _key, cancel_pending: cancelPending, ...visible
  } = parseRemoteState(row.remoteState)
  // 本地已请求取消：对前端就是“取消中”，与服务端自己的 cancel_requested 同一个字段
  if (cancelPending) visible.cancel_requested = true
  return {
    ...toSnakeCase(row),
    remote_state: Object.keys(visible).length ? visible : null,
    cancellable: isActiveTaskStatus(row.status) && isQwenJobsTask(row.provider),
  }
}

export function serializeTasks(rows: SysTaskRow[]): Record<string, any>[] {
  return rows.map(serializeTask)
}
