/**
 * 文本任务（提取 / 提示词批量 / 剧本改写 / 拆分分镜）的持久化 —— 统一落在 sys_task(type='text')。
 *
 * 进程内内存态不再是状态来源：刷新、切页、重启后都从库里读。
 * - params.kind：文本任务种类
 * - params.progress：{ completed, total, failed?, current_storyboard_id? }（不复用 remote_state，那是 qwen-jobs 追踪器的）
 * - provider/model：实际使用的文本模型，供任务中心展示与换模型重试
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { ACTIVE_TASK_STATUSES, type SysTaskRow } from './sys-task.js'

export type TextTaskKind =
  | 'extract_characters'
  | 'extract_scenes'
  | 'extract_props'
  | 'keyframe_prompts'
  | 'video_prompts'
  | 'script_rewrite'
  | 'storyboard_breaker'

export const TEXT_TASK_KINDS: TextTaskKind[] = [
  'extract_characters', 'extract_scenes', 'extract_props',
  'keyframe_prompts', 'video_prompts', 'script_rewrite', 'storyboard_breaker',
]

export interface TextTaskProgress {
  completed: number
  total: number
  failed: number
  current_storyboard_id?: number
}

export interface TextTaskParams {
  kind: TextTaskKind
  progress?: TextTaskProgress
  /** 批量任务的处理范围（重试时按同一范围重跑；空表示按默认规则重新挑选） */
  storyboardIds?: number[]
  configId?: number
  retry_of?: number
  [key: string]: unknown
}

export function parseTextTaskParams(raw: string | null | undefined): TextTaskParams | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as TextTaskParams : null
  } catch {
    return null
  }
}

export function textTaskKindOf(row: Pick<SysTaskRow, 'type' | 'params'>): TextTaskKind | null {
  if (row.type !== 'text') return null
  const kind = parseTextTaskParams(row.params)?.kind
  return kind && TEXT_TASK_KINDS.includes(kind) ? kind : null
}

/** 解析本次实际使用的文本模型（指定配置优先，失效回退当前启用配置），只用于记录 */
export async function resolveTextModel(opts: { model?: string; configId?: number } = {}): Promise<{ provider: string | null; model: string | null; configId: number | null }> {
  const config = opts.configId
    ? (await getConfigById(opts.configId)) ?? await getActiveConfig('text')
    : await getActiveConfig('text')
  return {
    provider: config?.provider ?? null,
    model: opts.model || config?.model || null,
    configId: config?.id ?? opts.configId ?? null,
  }
}

export async function createTextTask(input: {
  kind: TextTaskKind
  episodeId: number
  dramaId?: number | null
  storyboardId?: number | null
  prompt?: string | null
  provider?: string | null
  model?: string | null
  configId?: number | null
  storyboardIds?: number[]
  progress?: TextTaskProgress
  retryOf?: number
}): Promise<number> {
  const ts = now()
  const params: TextTaskParams = { kind: input.kind }
  if (input.progress) params.progress = input.progress
  if (input.storyboardIds?.length) params.storyboardIds = input.storyboardIds
  if (input.configId) params.configId = input.configId
  if (input.retryOf) params.retry_of = input.retryOf

  const res = await db.insert(schema.sysTask).values({
    type: 'text',
    episodeId: input.episodeId,
    dramaId: input.dramaId ?? null,
    storyboardId: input.storyboardId ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    prompt: input.prompt ?? null,
    params: JSON.stringify(params),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })
  return getInsertId(res)
}

/** 合并写 params（保留 kind/storyboardIds 等其它键） */
async function patchTextTaskParams(id: number, patch: Partial<TextTaskParams>): Promise<void> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!row) return
  const merged = { ...(parseTextTaskParams(row.params) || {}), ...patch }
  await db.update(schema.sysTask)
    .set({ params: JSON.stringify(merged), updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
}

export async function updateTextTaskProgress(id: number, progress: TextTaskProgress): Promise<void> {
  await patchTextTaskParams(id, { progress })
}

export async function finishTextTask(
  id: number,
  status: 'completed' | 'failed',
  extra: { errorMsg?: string | null; progress?: TextTaskProgress } = {},
): Promise<void> {
  if (extra.progress) await patchTextTaskParams(id, { progress: extra.progress })
  const ts = now()
  await db.update(schema.sysTask)
    .set({ status, errorMsg: extra.errorMsg ?? null, updatedAt: ts, completedAt: ts })
    .where(eq(schema.sysTask.id, id))
}

/** 该集该类型是否有正在运行的文本任务（取代原来的内存 Map 判重） */
export async function findActiveTextTask(episodeId: number, kind: TextTaskKind): Promise<SysTaskRow | null> {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'text'),
    eq(schema.sysTask.episodeId, episodeId),
    inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES),
  ))
  return rows.find(r => textTaskKindOf(r) === kind) ?? null
}

/** 该集该类型最近一次任务（状态页展示用；从未跑过为 null） */
export async function findLatestTextTask(episodeId: number, kind: TextTaskKind): Promise<SysTaskRow | null> {
  const rows = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'text'), eq(schema.sysTask.episodeId, episodeId)))
    .orderBy(desc(schema.sysTask.id))
  return rows.find(r => textTaskKindOf(r) === kind) ?? null
}

/** sys_task 状态 → 文本任务对外状态（历史接口的 running/done/error 三态） */
export function textTaskOutcome(status: string | null | undefined): 'running' | 'done' | 'error' {
  if (status === 'queued' || status === 'processing') return 'running'
  if (status === 'completed') return 'done'
  return 'error'
}

/** 批量提示词任务的对外状态（关键帧 / 视频提示词共用，接口结构与改造前保持一致） */
export interface PromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

export function promptBatchStatusFrom(row: SysTaskRow | null): PromptBatchStatus | null {
  if (!row) return null
  const progress = parseTextTaskParams(row.params)?.progress
  return {
    status: textTaskOutcome(row.status),
    total: progress?.total ?? 0,
    completed: progress?.completed ?? 0,
    failed: progress?.failed ?? 0,
    current_storyboard_id: progress?.current_storyboard_id,
    started_at: row.createdAt,
    finished_at: row.completedAt || undefined,
    error: row.errorMsg || undefined,
  }
}
