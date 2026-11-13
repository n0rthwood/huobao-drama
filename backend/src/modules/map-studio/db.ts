/**
 * 地图工作室的持久化底座（Issue #99）
 *
 * 模块自有四张表，全部用原生 SQL 建（`initMapStudio` 幂等重放）；读写一律通过下面的
 * `stmt()` 走同一个 better-sqlite3 连接，**不使用火宝的 `schema`**——模块不认识 props/sys_task 等业务表，
 * 边界测试会扫描这一点。
 *
 * 表：
 * - `map_studio_task`：任务（标题、宿主引用、独立任务的需求、旧 MapWorkflowState JSON、几何）
 * - `map_studio_run`：一次执行（替代旧 `sys_task kind=map_workflow`），阶段/状态/模型选择/底纹认领参数
 * - `map_studio_setting`：模块设置（研究 key、默认模型选择）
 * - `map_studio_delivery`：交付日志（幂等：同一任务同一成图 sha 只记一次宿主结果）
 */
import type Database from 'better-sqlite3'
import { getInsertId, sqlite } from '../../db/index.js'
import { now } from '../../utils/response.js'

/** 同一个连接上的同步语句；建表发生在 initMapStudio，模块文件加载时不能 prepare 不存在的表 */
const statementCache = new Map<string, Database.Statement>()
function stmt(sql: string): Database.Statement {
  let prepared = statementCache.get(sql)
  if (!prepared) {
    prepared = sqlite.prepare(sql)
    statementCache.set(sql, prepared)
  }
  return prepared
}

export const MAP_STUDIO_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS map_studio_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    host TEXT,
    host_ref TEXT,
    brief TEXT,
    state TEXT NOT NULL,
    map_spec TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  // 一个宿主目标只能有一个存活任务（再次打开时复用）
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_map_studio_task_host
     ON map_studio_task (host, host_ref) WHERE deleted_at IS NULL AND host IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_map_studio_task_updated ON map_studio_task (updated_at)`,
  `CREATE TABLE IF NOT EXISTS map_studio_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    start_stage TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    error_msg TEXT,
    text_config_id INTEGER,
    image_config_id INTEGER,
    image_model TEXT,
    params TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_map_studio_run_task ON map_studio_run (task_id, id)`,
  `CREATE TABLE IF NOT EXISTS map_studio_setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS map_studio_delivery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    run_id INTEGER,
    host TEXT NOT NULL,
    host_ref TEXT NOT NULL,
    final_sha256 TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_map_studio_delivery_task ON map_studio_delivery (task_id, id)`,
]

// ─── 行类型（与建表语句一一对应）─────────────────────────────────────────

export interface TaskRow {
  id: number
  title: string
  host: string | null
  host_ref: string | null
  brief: string | null
  state: string
  map_spec: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface RunRow {
  id: number
  task_id: number
  mode: string
  start_stage: string
  stage: string
  status: 'processing' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error_msg: string | null
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  params: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface DeliveryRow {
  id: number
  task_id: number
  run_id: number | null
  host: string
  host_ref: string
  final_sha256: string
  result: string | null
  created_at: string
}

// ─── 任务/运行/交付的原始读写 ────────────────────────────────────────────

export function selectTask(id: number): TaskRow | null {
  return (stmt('SELECT * FROM map_studio_task WHERE id = ? AND deleted_at IS NULL').get(id) as TaskRow | undefined) ?? null
}

export function selectTaskByHost(host: string, hostRef: string): TaskRow | null {
  return (stmt('SELECT * FROM map_studio_task WHERE host = ? AND host_ref = ? AND deleted_at IS NULL').get(host, hostRef) as TaskRow | undefined) ?? null
}

/** 列表：host 过滤（`host=''` 表示只要独立任务）、`q` 对标题做 LIKE */
export function selectTasks(opts: { host?: string | null; q?: string | null; limit?: number } = {}): TaskRow[] {
  const where: string[] = ['deleted_at IS NULL']
  const params: unknown[] = []
  if (opts.host === '') where.push('host IS NULL')
  else if (opts.host) {
    where.push('host = ?')
    params.push(opts.host)
  }
  if (opts.q) {
    where.push('title LIKE ?')
    params.push(`%${opts.q}%`)
  }
  params.push(Math.min(Math.max(1, Math.trunc(opts.limit ?? 200)), 500))
  return stmt(`SELECT * FROM map_studio_task WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...params) as TaskRow[]
}

export function insertTask(input: {
  title: string
  host: string | null
  hostRef: string | null
  brief: string | null
  state: string
  mapSpec: string | null
}): number {
  const ts = now()
  return getInsertId(stmt(`INSERT INTO map_studio_task (title, host, host_ref, brief, state, map_spec, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.title, input.host, input.hostRef, input.brief, input.state, input.mapSpec, ts, ts,
  ))
}

/** CAS：只有原文没被改写才落库（调用方比对 `changes`） */
export function updateTask(id: number, input: {
  expectedState: string
  expectedMapSpec: string | null
  expectedBrief: string | null
  state: string
  mapSpec: string | null
  brief: string | null
  title?: string
  updatedAt: string
}): number {
  const result = stmt(`UPDATE map_studio_task
      SET state = ?, map_spec = ?, brief = ?, title = COALESCE(?, title), updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
      AND state = ? AND map_spec IS ? AND brief IS ?`).run(
    input.state, input.mapSpec, input.brief, input.title ?? null, input.updatedAt,
    id, input.expectedState, input.expectedMapSpec, input.expectedBrief,
  ) as Database.RunResult
  return Number(result.changes ?? 0)
}

export function insertRun(input: {
  taskId: number
  mode: string
  startStage: string
  stage: string
  textConfigId: number | null
  imageConfigId: number | null
  imageModel: string | null
  params: Record<string, unknown> | null
}): number {
  const ts = now()
  return getInsertId(stmt(`INSERT INTO map_studio_run
    (task_id, mode, start_stage, stage, status, text_config_id, image_config_id, image_model, params, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)`).run(
    input.taskId, input.mode, input.startStage, input.stage,
    input.textConfigId, input.imageConfigId, input.imageModel,
    input.params ? JSON.stringify(input.params) : null, ts, ts,
  ))
}

export function selectRun(id: number): RunRow | null {
  return (stmt('SELECT * FROM map_studio_run WHERE id = ?').get(id) as RunRow | undefined) ?? null
}

export function selectRunsByTask(taskId: number, limit?: number): RunRow[] {
  if (limit === undefined) return stmt('SELECT * FROM map_studio_run WHERE task_id = ? ORDER BY id DESC').all(taskId) as RunRow[]
  return stmt('SELECT * FROM map_studio_run WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .all(taskId, Math.min(Math.max(1, Math.trunc(limit)), 200)) as RunRow[]
}

export function activeRunOfTask(taskId: number): RunRow | null {
  return (stmt("SELECT * FROM map_studio_run WHERE task_id = ? AND status = 'processing' ORDER BY id DESC LIMIT 1")
    .get(taskId) as RunRow | undefined) ?? null
}

export function updateRunStage(id: number, patch: { stage?: string; params?: Record<string, unknown> }): void {
  const fields: string[] = ['updated_at = ?']
  const params: unknown[] = [now()]
  if (patch.stage !== undefined) {
    fields.push('stage = ?')
    params.push(patch.stage)
  }
  if (patch.params !== undefined) {
    fields.push('params = ?')
    params.push(JSON.stringify(patch.params))
  }
  params.push(id)
  stmt(`UPDATE map_studio_run SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

/** 运行参数：读改写用同一个同步调用，避免两条异步路径覆盖 */
export function patchRunParams(id: number, patch: Record<string, unknown>): Record<string, unknown> | null {
  const row = selectRun(id)
  if (!row) return null
  let current: Record<string, unknown> = {}
  try {
    const parsed = row.params ? JSON.parse(row.params) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch { /* 坏参数按空对象处理：认领信息丢失只会多花一次出图，不会改坏任务 */ }
  const next = { ...current, ...patch }
  updateRunStage(id, { params: next })
  return next
}

export function readRunParams(id: number): Record<string, unknown> {
  const row = selectRun(id)
  if (!row?.params) return {}
  try {
    const parsed = JSON.parse(row.params)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function finishRun(id: number, status: RunRow['status'], errorMsg: string | null): void {
  const ts = now()
  stmt("UPDATE map_studio_run SET status = ?, error_msg = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'processing'")
    .run(status, errorMsg, ts, ts, id)
}

export function insertDelivery(input: {
  taskId: number
  runId: number | null
  host: string
  hostRef: string
  finalSha256: string
  result: unknown
}): number {
  return getInsertId(stmt(`INSERT INTO map_studio_delivery (task_id, run_id, host, host_ref, final_sha256, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.taskId, input.runId, input.host, input.hostRef, input.finalSha256,
    input.result === undefined ? null : JSON.stringify(input.result), now(),
  ))
}

export function selectDeliveries(taskId: number, limit = 20): DeliveryRow[] {
  return stmt('SELECT * FROM map_studio_delivery WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .all(taskId, Math.min(Math.max(1, Math.trunc(limit)), 100)) as DeliveryRow[]
}

/** 幂等交付的判据：同一任务同一成图 sha 已经交付过就复用那次结果 */
export function selectDeliveryBySha(taskId: number, sha256: string): DeliveryRow | null {
  return (stmt('SELECT * FROM map_studio_delivery WHERE task_id = ? AND final_sha256 = ? ORDER BY id DESC LIMIT 1')
    .get(taskId, sha256) as DeliveryRow | undefined) ?? null
}

// ─── 设置 ────────────────────────────────────────────────────────────────

export function readSetting(key: string): unknown {
  const row = stmt('SELECT value FROM map_studio_setting WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

export function writeSetting(key: string, value: unknown): void {
  stmt(`INSERT INTO map_studio_setting (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), now())
}

export function hasSettingRow(key: string): boolean {
  return !!stmt('SELECT 1 AS hit FROM map_studio_setting WHERE key = ?').get(key)
}
