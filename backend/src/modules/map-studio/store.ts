/**
 * 地图工作室的持久化（Issue #99，语义等价于 #84/#90 的 `services/map-workflow/store.ts`）
 *
 * 任务文档落在 `map_studio_task.state`（JSON），几何落在 `map_studio_task.map_spec`。CAS 的做法不变：
 * UPDATE 的 WHERE 带上写之前读到的三份原文（state / map_spec / brief），任何并发写
 * 都会落空而不是互相覆盖——落空的那一方只记「结果已过期」，绝不推进阶段、绝不盖产出。
 *
 * 与旧实现的唯一实质差别：需求（brief）不在业务表的 JSON 列里，而是**宿主目标上的字段**。
 * 宿主任务每次读取都问宿主（`host.readBrief`），模块只保存最后一次快照（state.brief）用于
 * 回退快照与「执行期间被人改过」的指纹比对；独立任务的 brief 落在 `map_studio_task.brief` 列。
 */
import crypto from 'crypto'
import type { MapSpec } from './geo/base-render.js'
import { normalizeMapSpec, parseMapSpec } from './geo/base-render.js'
import { now } from '../../utils/response.js'
import { getHost } from './registry.js'
import {
  finishRun,
  selectDeliveries,
  selectRunsByTask,
  selectTask,
  updateTask,
  type DeliveryRow,
  type RunRow,
  type TaskRow,
} from './db.js'
import type { MapStudioDeliveryResult, MapStudioHost, MapStudioHostTarget } from './contract.js'
import {
  EMPTY_OUTPUTS,
  emptyAgentState,
  emptyBrief,
  emptySteps,
  emptyWorkflow,
  MAP_MAX_ROLLBACKS,
  MAP_MAX_STAGE_ROUNDS,
  MAP_WORKFLOW_STAGES,
  STAGE_LABEL,
  type MapAgentAttempt,
  type MapAgentState,
  type MapBrief,
  type MapWorkflowHistoryEntry,
  type MapWorkflowIssue,
  type MapWorkflowState,
  type MapWorkflowStage,
  type MapWorkflowStep,
  type MapStepStatus,
} from './types.js'

/** 历史快照上限：够回退与追责，又不会把一列 JSON 撑爆 */
const MAX_HISTORY = 30

export class MapStudioConflictError extends Error {
  code: 'revision_conflict' | 'workflow_busy'
  revision: number
  runId: number | null
  constructor(message: string, opts: { code: 'revision_conflict' | 'workflow_busy'; revision?: number; runId?: number | null }) {
    super(message)
    this.name = 'MapStudioConflictError'
    this.code = opts.code
    this.revision = opts.revision ?? 0
    this.runId = opts.runId ?? null
  }
}

/** 异步阶段结果迟到：任务已经被人改过/回退过，这次结果作废（不是错误，是过期） */
export class MapStudioStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MapStudioStaleError'
  }
}

/** 模块请求错误：路由据此回 400/404（code 机器可读） */
export class MapStudioRequestError extends Error {
  code: string
  constructor(message: string, code = 'invalid_request') {
    super(message)
    this.name = 'MapStudioRequestError'
    this.code = code
  }
}

/** 宿主目标不存在/不是地图：UI 只读，run/deliver 一律 400 */
export class MapStudioHostTargetMissingError extends MapStudioRequestError {
  constructor(message = '宿主目标已不存在（道具被删除或不再是地图资产），这个任务只能只读查看') {
    super(message, 'host_target_missing')
    this.name = 'MapStudioHostTargetMissingError'
  }
}

export function briefHash(brief: MapBrief | null): string | null {
  if (!brief) return null
  return crypto.createHash('sha256').update(JSON.stringify(brief), 'utf8').digest('hex')
}

const STATUSES = ['idle', 'running', 'awaiting_review', 'blocked', 'failed', 'completed'] as const
const STEP_STATUSES = ['pending', 'running', 'awaiting_review', 'completed', 'failed', 'skipped'] as const

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(String(raw)) ? raw as T : fallback
}

function nullableId(raw: unknown): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 库里 JSON → 任务文档。坏数据绝不让详情接口 500：缺字段补默认值 */
export function parseWorkflow(raw: string | null | undefined): MapWorkflowState {
  const base = emptyWorkflow()
  if (!raw) return base
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return base
  }
  if (!parsed || typeof parsed !== 'object') return base
  const record = parsed as Record<string, unknown>
  const steps = Array.isArray(record.steps) ? record.steps : []
  const stepById = new Map<string, Record<string, unknown>>()
  for (const item of steps) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
      stepById.set(String((item as Record<string, unknown>).id), item as Record<string, unknown>)
    }
  }
  return {
    version: 1,
    stage: pick(record.stage, MAP_WORKFLOW_STAGES, 'brief'),
    status: pick(record.status, STATUSES, 'idle'),
    mode: pick(record.mode, ['auto', 'manual'] as const, 'manual'),
    revision: Number.isFinite(Number(record.revision)) ? Number(record.revision) : 0,
    run_id: nullableId(record.run_id),
    error: typeof record.error === 'string' ? record.error : null,
    brief: (record.brief && typeof record.brief === 'object' ? record.brief : null) as MapBrief | null,
    brief_hash: typeof record.brief_hash === 'string' ? record.brief_hash : null,
    // 步骤表按**当前代码**的阶段清单重建：新增阶段发布后，旧文档也会立刻出现该步
    steps: emptySteps().map((step): MapWorkflowStep => {
      const stored = stepById.get(step.id)
      if (!stored) return step
      return {
        id: step.id,
        label: STAGE_LABEL[step.id],
        status: pick(stored.status, STEP_STATUSES, 'pending') as MapStepStatus,
        message: typeof stored.message === 'string' ? stored.message : null,
        started_at: typeof stored.started_at === 'string' ? stored.started_at : null,
        finished_at: typeof stored.finished_at === 'string' ? stored.finished_at : null,
      }
    }),
    issues: Array.isArray(record.issues) ? record.issues as MapWorkflowIssue[] : [],
    research: (record.research && typeof record.research === 'object' ? record.research : null) as MapWorkflowState['research'],
    outputs: { ...EMPTY_OUTPUTS, ...(record.outputs && typeof record.outputs === 'object' ? record.outputs as object : {}) },
    history: Array.isArray(record.history) ? record.history as MapWorkflowHistoryEntry[] : [],
    text_config_id: nullableId(record.text_config_id),
    image_config_id: nullableId(record.image_config_id),
    image_model: typeof record.image_model === 'string' ? record.image_model : null,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
    agent: parseAgentState(record.agent),
  }
}

/** 轮次记录只是可回看的事实：坏数据退回空记录，绝不让详情接口 500 */
function parseAgentState(raw: unknown): MapAgentState {
  const base = emptyAgentState()
  if (!raw || typeof raw !== 'object') return base
  const record = raw as Record<string, unknown>
  const counts = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, n]) => Number.isFinite(Number(n)))
      .map(([key, n]) => [key, Number(n)]))
  }
  return {
    run_id: nullableId(record.run_id),
    rounds: counts(record.rounds),
    rollbacks: Number.isFinite(Number(record.rollbacks)) ? Number(record.rollbacks) : 0,
    feedback: record.feedback && typeof record.feedback === 'object'
      ? Object.fromEntries(Object.entries(record.feedback as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as MapAgentState['feedback']
      : {},
    attempts: Array.isArray(record.attempts) ? record.attempts as MapAgentAttempt[] : [],
  }
}

export function stepOf(state: MapWorkflowState, stage: MapWorkflowStage): MapWorkflowStep {
  const step = state.steps.find(item => item.id === stage)
  if (step) return step
  const created: MapWorkflowStep = { id: stage, label: STAGE_LABEL[stage], status: 'pending', message: null, started_at: null, finished_at: null }
  state.steps.push(created)
  return created
}

export function setStep(state: MapWorkflowState, stage: MapWorkflowStage, patch: Partial<MapWorkflowStep>): void {
  Object.assign(stepOf(state, stage), patch)
}

export function stageIndex(stage: MapWorkflowStage): number {
  return MAP_WORKFLOW_STAGES.indexOf(stage)
}

// ─── 读取：任务 + 需求（宿主任务每次问宿主）──────────────────────────────

export function parseStandaloneBrief(raw: string | null): MapBrief | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as MapBrief : null
  } catch {
    return null
  }
}

export interface LoadedTask {
  row: TaskRow
  state: MapWorkflowState
  mapSpec: MapSpec | null
  rawState: string
  rawSpec: string | null
  rawBrief: string | null
  /** 当前生效的需求（宿主任务来自宿主，独立任务来自任务行） */
  brief: MapBrief
  host: MapStudioHost | null
  hostTarget: MapStudioHostTarget | null
  /** 宿主读取失败时的原因（详情里要显示，而不是假装目标还在） */
  hostError: string | null
}

/**
 * 读任务 + 需求。宿主目标被删除时 `hostTarget = null`，任务仍然可读（历史与产物都在）。
 *
 * 需求口径（契约 §2）：宿主任务**每次**都问宿主；宿主没给值（或不是宿主任务）时退回快照，
 * 再退回「标题即主题」的初值——旧实现里 `briefOfProp` 的语义（主题 = 名字）。
 */
export async function loadTask(taskId: number): Promise<LoadedTask | null> {
  const row = selectTask(taskId)
  if (!row) return null
  const state = parseWorkflow(row.state)
  const host = row.host ? getHost(row.host) : null
  let hostTarget: MapStudioHostTarget | null = null
  let hostError: string | null = null
  let hostBrief: MapBrief | null = null
  if (host && row.host_ref) {
    try {
      hostTarget = await host.describe(row.host_ref)
      hostBrief = hostTarget ? await host.readBrief(row.host_ref) : null
    } catch (err) {
      hostError = err instanceof Error ? err.message : String(err)
    }
  }
  const standaloneBrief = row.host ? null : parseStandaloneBrief(row.brief)
  const brief = hostBrief ?? standaloneBrief ?? state.brief ?? { ...emptyBrief(), subject: row.title }
  if (hostBrief && state.brief_hash && briefHash(hostBrief) !== state.brief_hash) {
    const before = { stage: state.stage, brief: state.brief, map_spec: parseMapSpec(row.map_spec), outputs: structuredClone(state.outputs), research: state.research }
    const priorRun = state.run_id
    state.brief = hostBrief
    state.brief_hash = briefHash(hostBrief)
    state.stage = 'brief'
    state.status = 'idle'
    state.run_id = null
    state.error = null
    state.revision++
    state.updated_at = now()
    for (const step of state.steps) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
    state.issues = [{ field: 'brief', code: 'brief_changed_externally', blocking: false, message: '宿主需求已修改：请重新核查；此前产出保留在历史中' }]
    state.history = [...state.history, { revision: state.revision, at: state.updated_at, stage: state.stage, status: state.status, action: 'brief_changed_externally', actor: 'system' as const, note: '检测到宿主需求变化', snapshot: before }].slice(-MAX_HISTORY)
    const raw = JSON.stringify(state)
    const changes = updateTask(row.id, { expectedState: row.state, expectedMapSpec: row.map_spec, expectedBrief: row.brief, state: raw, mapSpec: row.map_spec, brief: row.brief, updatedAt: state.updated_at })
    if (!changes) return loadTask(taskId)
    row.state = raw
    row.updated_at = state.updated_at
    if (priorRun) finishRun(priorRun, 'failed', '需求在执行期间被外部修改，结果已过期')
  }
  return {
    row,
    state,
    mapSpec: parseMapSpec(row.map_spec),
    rawState: row.state,
    rawSpec: row.map_spec,
    rawBrief: row.brief,
    brief,
    host,
    hostTarget,
    hostError,
  }
}

/** 宿主任务必须有可用目标才能推进/交付；独立任务不受影响 */
export function requireHostTarget(loaded: LoadedTask): void {
  if (loaded.row.host && !loaded.hostTarget) throw new MapStudioHostTargetMissingError()
}

// ─── 写入：唯一入口（全量校验 → CAS）─────────────────────────────────────

export interface MutateContext {
  task: TaskRow
  state: MapWorkflowState
  /** 可写：赋值即与任务文档在同一条 UPDATE 里落库（并经 normalizeMapSpec 校验） */
  mapSpec: MapSpec | null
  /** 可写：需求（宿主任务写回宿主，独立任务写任务行） */
  brief: MapBrief
}

export interface MutateOptions {
  /** 人工请求带的修订号；不传表示不做乐观锁（仍然做 CAS 原文比对） */
  expectedRevision?: number | null
  /** 这次写入要求任务当前不在跑（run/advance/rollback/人工编辑都要求） */
  requireIdle?: boolean
  /** 异步阶段回写：必须仍是这次运行、需求没被改过，否则判定结果过期 */
  expectedRunId?: number | null
  expectedBriefHash?: string | null
  action: string
  /**
   * 是否写一条修订历史（默认写）。模型阶段的逐轮记录（#90）只改 `agent` 计数与尝试列表，
   * 不进历史——否则几轮重交就会把回退所需的快照挤出 MAX_HISTORY。
   */
  history?: boolean
  actor: 'auto' | 'manual' | 'system'
  note?: string | null
  /** 记录回退快照（brief / map_spec / 产出 / 检索） */
  snapshot?: boolean
  mutate: (ctx: MutateContext) => void | Promise<void>
}

/**
 * 唯一写入口。顺序固定：**先全量校验，再做任何写**；写入用 CAS，失败不改库。
 *
 * 需求的外部变更在这里统一识别（契约 §2）：宿主上的需求指纹与快照不同时，
 * 异步回写一律判定过期；人工请求则先按「人工改了需求」的失效规则同步，再执行本次改动。
 */
export async function mutateTask(taskId: number, opts: MutateOptions): Promise<LoadedTask> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  const { row, state, mapSpec, rawState, rawSpec, rawBrief, brief } = loaded

  if (opts.expectedRevision !== undefined && opts.expectedRevision !== null && opts.expectedRevision !== state.revision) {
    throw new MapStudioConflictError(
      `地图任务已被其他操作修改（当前修订号 ${state.revision}），请刷新后重试`,
      { code: 'revision_conflict', revision: state.revision, runId: state.run_id },
    )
  }
  if (opts.requireIdle && state.status === 'running') {
    throw new MapStudioConflictError(
      `地图任务正在执行「${STAGE_LABEL[state.stage]}」${state.run_id ? `（运行 #${state.run_id}）` : ''}，请先等待完成或取消`,
      { code: 'workflow_busy', revision: state.revision, runId: state.run_id },
    )
  }
  if (opts.expectedRunId !== undefined && opts.expectedRunId !== null && state.run_id !== opts.expectedRunId) {
    throw new MapStudioStaleError(`本次结果已过期：任务的当前运行是 ${state.run_id ?? '（无）'}，不是 #${opts.expectedRunId}`)
  }
  const externalBrief = briefHash(brief)
  const briefChangedExternally = !!state.brief_hash && externalBrief !== state.brief_hash
  if (briefChangedExternally) {
    if (opts.expectedBriefHash !== undefined && opts.expectedBriefHash !== null) {
      throw new MapStudioStaleError('本次结果已过期：地图需求在执行期间被修改，结果不写入')
    }
  } else if (opts.expectedBriefHash !== undefined && opts.expectedBriefHash !== null && state.brief_hash !== opts.expectedBriefHash) {
    throw new MapStudioStaleError('本次结果已过期：地图需求在执行期间被修改或回退，结果不写入')
  }

  const before: MapWorkflowHistoryEntry['snapshot'] | undefined = opts.snapshot
    ? {
      stage: state.stage,
      brief: state.brief ? JSON.parse(JSON.stringify(state.brief)) : null,
      map_spec: mapSpec ? JSON.parse(JSON.stringify(mapSpec)) : null,
      outputs: JSON.parse(JSON.stringify(state.outputs)),
      research: state.research ? JSON.parse(JSON.stringify(state.research)) : null,
    }
    : undefined

  const ctx: MutateContext = {
    task: row,
    state: JSON.parse(JSON.stringify(state)) as MapWorkflowState,
    mapSpec: mapSpec ? JSON.parse(JSON.stringify(mapSpec)) as MapSpec : null,
    brief: JSON.parse(JSON.stringify(brief)) as MapBrief,
  }
  // 外部改过需求：先按「需求已修改」的失效规则同步（同 saveDraft 的语义），再执行本次改动
  if (briefChangedExternally) {
    ctx.state.stage = 'brief'
    ctx.state.status = 'idle'
    ctx.state.error = null
    for (const step of ctx.state.steps) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
    ctx.state.issues = [{
      field: 'brief', code: 'brief_changed_externally', blocking: false,
      message: '需求在宿主侧被修改：已回到需求步重新核查，此前的底图/成图仍保留在产出与历史中',
    }]
  }

  await opts.mutate(ctx)

  const next = ctx.state
  next.version = 1
  next.revision = state.revision + 1
  next.updated_at = now()
  next.brief = ctx.brief
  next.brief_hash = briefHash(ctx.brief)
  if (opts.history !== false) {
    next.history = [
      ...state.history,
      {
        revision: next.revision,
        at: next.updated_at,
        stage: next.stage,
        status: next.status,
        action: briefChangedExternally ? `${opts.action}+brief_changed_externally` : opts.action,
        actor: opts.actor,
        note: opts.note ?? null,
        ...(before ? { snapshot: before } : {}),
      },
    ].slice(-MAX_HISTORY)
  }

  // 几何永远过一遍 normalizeMapSpec：模块不是绕开地图校验的后门
  const nextSpec = ctx.mapSpec ? normalizeMapSpec(ctx.mapSpec) : null
  const nextSpecRaw = nextSpec ? JSON.stringify(nextSpec) : null
  const nextBriefRaw = row.host ? null : JSON.stringify(ctx.brief)

  const changes = updateTask(taskId, {
    expectedState: rawState,
    expectedMapSpec: rawSpec,
    expectedBrief: rawBrief,
    state: JSON.stringify(next),
    mapSpec: nextSpecRaw,
    brief: nextBriefRaw,
    updatedAt: next.updated_at,
  })
  if (changes === 0) {
    throw new MapStudioConflictError(
      '地图任务在本次写入期间被其他操作修改，已放弃本次写入（之前的工作完整保留），请刷新后重试',
      { code: 'revision_conflict', revision: state.revision, runId: state.run_id },
    )
  }
  // Host IO is outside the local SQL update. If it fails, revert only our still-current CAS;
  // never report a successfully saved brief while the host kept the old one.
  if (loaded.host && loaded.row.host_ref && briefHash(ctx.brief) !== briefHash(brief)) {
    try {
      await loaded.host.writeBrief(loaded.row.host_ref, ctx.brief)
    } catch (err) {
      updateTask(taskId, { expectedState: JSON.stringify(next), expectedMapSpec: nextSpecRaw, expectedBrief: nextBriefRaw,
        state: rawState, mapSpec: rawSpec, brief: rawBrief, updatedAt: row.updated_at })
      throw err
    }
  }

  const reloaded = await loadTask(taskId)
  if (!reloaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  return reloaded
}

/**
 * 回退：按历史快照把 brief/几何/产出/检索恢复到**最近一次**进入某阶段之前。
 *
 * 从最新一条往回扫，沿着「该阶段或更靠后阶段」的连续段走到头，取其中最早的那条快照。
 * 用最旧的那条（history.find）会把中间重跑过、人已经确认过的内容一起抹掉——那是丢工作，不是回退。
 */
export function restoreSnapshot(ctx: MutateContext, stage: MapWorkflowStage): string | null {
  const target = stageIndex(stage)
  let entry: MapWorkflowHistoryEntry | null = null
  for (let i = ctx.state.history.length - 1; i >= 0; i--) {
    const item = ctx.state.history[i]!
    const beforeStage = item.snapshot?.stage ?? (item.action.startsWith('stage_done:')
      ? item.action.slice('stage_done:'.length) as MapWorkflowStage : item.stage)
    if (stageIndex(beforeStage) < target) break
    if (item.snapshot) entry = item
  }
  if (!entry?.snapshot) return null
  if (entry.snapshot.brief) ctx.brief = entry.snapshot.brief
  ctx.state.research = entry.snapshot.research
  ctx.state.outputs = JSON.parse(JSON.stringify(entry.snapshot.outputs))
  const restored: MapSpec | null = entry.snapshot.map_spec ? JSON.parse(JSON.stringify(entry.snapshot.map_spec)) : null
  // 回退的是**流程**，不是人的劳动：人工确认过的地点/路线/范围（没有 proposed 标记）
  // 一律保留下来并入恢复后的几何，否则回退一次就把审核成果清零。
  const kept = ctx.mapSpec ? confirmedGeometry(ctx.mapSpec) : { places: [], routes: [], regions: [] }
  const keptCount = kept.places.length + kept.routes.length + kept.regions.length
  if (!restored) {
    ctx.mapSpec = keptCount && ctx.mapSpec
      ? { ...ctx.mapSpec, places: kept.places, routes: kept.routes, regions: kept.regions }
      : null
  } else {
    ctx.mapSpec = {
      ...restored,
      places: mergeConfirmed(restored.places, kept.places),
      routes: mergeConfirmed(restored.routes, kept.routes),
      regions: mergeConfirmed(restored.regions ?? [], kept.regions),
    }
  }
  const keptNote = keptCount ? `；已保留 ${keptCount} 条人工确认的几何` : ''
  return `已恢复到修订号 ${entry.revision}（${entry.at}）之前的内容${keptNote}`
}

interface ConfirmedGeometry {
  places: MapSpec['places']
  routes: MapSpec['routes']
  regions: MapSpec['regions']
}

/** 人工确认过的条目 = 没有 `proposed: true` 标记的那些（候选一律带标记） */
function confirmedGeometry(spec: MapSpec): ConfirmedGeometry {
  return {
    places: spec.places.filter(item => item.proposed !== true),
    routes: spec.routes.filter(item => item.proposed !== true),
    regions: (spec.regions ?? []).filter(item => item.proposed !== true),
  }
}

/** 以人工确认值为准覆盖同 id / 同名条目，其余追加 */
function mergeConfirmed<T extends { id: string; name: string }>(base: T[], confirmed: T[]): T[] {
  const merged = [...base]
  for (const item of confirmed) {
    const index = merged.findIndex(existing => existing.id === item.id || existing.name === item.name)
    if (index >= 0) merged.splice(index, 1, item)
    else merged.push(item)
  }
  return merged
}

// ─── 详情 ───────────────────────────────────────────────────────────────

export interface MapStudioRunSummary {
  latest: { id: number; stage: string; status: string; mode: string; created_at: string; finished_at: string | null; error_msg: string | null } | null
  count: number
}

export interface MapStudioDeliveryView {
  id: number
  at: string
  run_id: number | null
  host: string
  host_ref: string
  final_sha256: string
  version_ids: number[]
  message: string
}

export interface MapStudioDetail extends Omit<MapWorkflowState, 'version' | 'brief_hash' | 'agent' | 'brief'> {
  task_id: number
  title: string
  brief: MapBrief
  host: { id: string; ref: string; target: MapStudioHostTarget | null; error: string | null } | null
  map_spec: MapSpec | null
  busy: boolean
  agent: Omit<MapAgentState, 'feedback'> & { max_rounds: number; max_rollbacks: number }
  deliveries: MapStudioDeliveryView[]
  runs_summary: MapStudioRunSummary
}

function deliveryView(row: DeliveryRow): MapStudioDeliveryView {
  let result: MapStudioDeliveryResult | null = null
  try {
    const parsed = row.result ? JSON.parse(row.result) : null
    if (parsed && typeof parsed === 'object') result = parsed as MapStudioDeliveryResult
  } catch { /* 坏结果按空交付显示，历史行不因坏 JSON 消失 */ }
  return {
    id: row.id,
    at: row.created_at,
    run_id: row.run_id,
    host: row.host,
    host_ref: row.host_ref,
    final_sha256: row.final_sha256,
    version_ids: Array.isArray(result?.version_ids) ? result.version_ids : [],
    message: typeof result?.message === 'string' ? result.message : '',
  }
}

export function serializeDetail(loaded: LoadedTask): MapStudioDetail {
  const { row, state, mapSpec, brief, host, hostTarget, hostError } = loaded
  const { brief_hash: _hash, version: _version, brief: _brief, agent, ...rest } = state
  const { feedback: _feedback, ...agentView } = agent
  const runs = selectRunsByTask(row.id, 20)
  const latest = runs[0] ?? null
  return {
    ...rest,
    task_id: row.id,
    title: row.title,
    brief,
    host: row.host && row.host_ref ? { id: row.host, ref: row.host_ref, target: hostTarget, error: hostError } : null,
    map_spec: mapSpec,
    busy: state.status === 'running',
    agent: { ...agentView, max_rounds: MAP_MAX_STAGE_ROUNDS, max_rollbacks: MAP_MAX_ROLLBACKS },
    deliveries: selectDeliveries(row.id, 20).map(deliveryView),
    runs_summary: {
      latest: latest ? {
        id: latest.id, stage: latest.stage, status: latest.status, mode: latest.mode,
        created_at: latest.created_at, finished_at: latest.finished_at, error_msg: latest.error_msg,
      } : null,
      count: runs.length,
    },
  }
}

/** 任务的运行列表（§5）：状态、阶段、墙钟、模型调用耗时、排队耗时、调用数、错误 */
export interface MapStudioRunView {
  id: number
  mode: string
  start_stage: string
  stage: string
  status: RunRow['status']
  error_msg: string | null
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  started_at: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
  wall_ms: number | null
  model_ms: number
  queue_ms: number
  work_ms: number
  call_count: number
  observed_work_ids: number[]
}

export function runView(row: RunRow, observed: { model_ms: number; queue_ms: number; work_ms: number; call_count: number; work_ids: number[] }): MapStudioRunView {
  const startedMs = Date.parse(row.created_at)
  const finishedMs = row.finished_at ? Date.parse(row.finished_at) : null
  return {
    id: row.id,
    mode: row.mode,
    start_stage: row.start_stage,
    stage: row.stage,
    status: row.status,
    error_msg: row.error_msg,
    text_config_id: row.text_config_id,
    image_config_id: row.image_config_id,
    image_model: row.image_model,
    started_at: row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    wall_ms: Number.isFinite(startedMs) ? (finishedMs !== null && Number.isFinite(finishedMs) ? finishedMs - startedMs : Date.now() - startedMs) : null,
    model_ms: observed.model_ms,
    queue_ms: observed.queue_ms,
    work_ms: observed.work_ms,
    call_count: observed.call_count,
    observed_work_ids: observed.work_ids,
  }
}

