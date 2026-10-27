/**
 * sys_task 的状态语义与对外序列化 —— 生成链路、批量、路由共用。
 *
 * 状态：queued（远端排队中）| processing（远端运行中或其它 provider 生成中）| completed | failed | cancelled。
 * remote_state（TEXT JSON）保存 qwen-jobs 任务的最近一次快照，另外保留内部键：
 *   request（提交用的请求体，先落盘再调远端，重启后按同一幂等键原样重发）、
 *   config_id（追踪器据此找回 baseUrl/凭据）、idempotency_key。
 * 这三个内部键只存库，不出 API。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import type { QwenJob, QwenJobRequest } from './adapters/qwen-jobs-client.js'

export const QWEN_JOBS_PROVIDER = 'qwen-jobs'

export type SysTaskRow = typeof schema.sysTask.$inferSelect
export type SysTaskStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

/** 活跃（未终结）任务：排队中或生成中 */
export function isActiveTaskStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'processing'
}

export function isQwenJobsTask(provider: string | null | undefined): boolean {
  return (provider || '').toLowerCase() === QWEN_JOBS_PROVIDER
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

/** 合并写入 remote_state（保留 request/config_id 等内部键），可同时改状态与远端任务 id */
export async function patchTaskRemoteState(
  id: number,
  patch: RemoteState,
  extra: { status?: SysTaskStatus; taskId?: string; resultUrl?: string; errorMsg?: string | null } = {},
): Promise<void> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!row) return
  const merged: RemoteState = { ...parseRemoteState(row.remoteState), ...patch }
  await db.update(schema.sysTask)
    .set({ remoteState: JSON.stringify(merged), updatedAt: now(), ...extra })
    .where(eq(schema.sysTask.id, id))
}

/** 远端任务状态 → sys_task 状态（succeeded 要先落盘再标 completed，故不在此映射） */
export function mapRemoteStatus(status: QwenJob['status']): SysTaskStatus | null {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'processing'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return null
}

/** 幂等键：重试必须新建 sys_task（新 key），否则服务端会原样返回旧任务而不重跑 */
export function qwenIdempotencyKey(taskId: number): string {
  return `huobao-sys_task-${taskId}`
}

/** API 输出：snake_case + remote_state 已解析（剥掉内部键）+ cancellable */
export function serializeTask(row: SysTaskRow): Record<string, any> {
  const { request: _request, config_id: _configId, idempotency_key: _key, ...visible } = parseRemoteState(row.remoteState)
  return {
    ...toSnakeCase(row),
    remote_state: Object.keys(visible).length ? visible : null,
    cancellable: isActiveTaskStatus(row.status) && isQwenJobsTask(row.provider),
  }
}

export function serializeTasks(rows: SysTaskRow[]): Record<string, any>[] {
  return rows.map(serializeTask)
}
