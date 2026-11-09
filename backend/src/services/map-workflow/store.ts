/**
 * 地图工作流的持久化（Issue #84）
 *
 * 工作流文档落在 `props.map_workflow`（JSON），几何落在 `props.map_spec`。两者**同一条
 * UPDATE 写入**，并且 WHERE 子句带上写之前读到的原文：这就是比较并交换（CAS）。
 * 任何并发写（人在编辑 + 后台阶段完成、两次重复提交、回退之后迟到的异步回调）都会
 * 落空而不是互相覆盖——落空的那一方只记一条「结果已过期」，绝不推进阶段、绝不盖产出。
 *
 * 全部读写都经过这里，路由与 runner 不直接碰这两列。
 */
import crypto from 'crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { toSnakeCase } from '../../utils/transform.js'
import { normalizeMapSpec, parseMapSpec, type MapSpec } from '../map-base-render.js'
import {
  EMPTY_OUTPUTS,
  emptyBrief,
  MAP_WORKFLOW_STAGES,
  STAGE_LABEL,
  emptySteps,
  emptyWorkflow,
  type MapBrief,
  type MapWorkflowHistoryEntry,
  type MapWorkflowIssue,
  type MapWorkflowState,
  type MapWorkflowStage,
  type MapWorkflowStep,
  type MapStepStatus,
} from './types.js'

export type PropRow = typeof schema.props.$inferSelect

/** 历史快照上限：够回退与追责，又不会把一列 JSON 撑爆 */
const MAX_HISTORY = 30
const IMPORT_MEDIA_KEYS = new Set(['path', 'base', 'texture', 'background', 'evidence_image', 'evidence_path', 'screenshot', 'kmz'])

export class MapWorkflowConflictError extends Error {
  code: 'revision_conflict' | 'workflow_busy'
  revision: number
  taskId: number | null
  constructor(message: string, opts: { code: 'revision_conflict' | 'workflow_busy'; revision?: number; taskId?: number | null }) {
    super(message)
    this.name = 'MapWorkflowConflictError'
    this.code = opts.code
    this.revision = opts.revision ?? 0
    this.taskId = opts.taskId ?? null
  }
}

/** 异步阶段结果迟到：工作流已经被人改过/回退过，这次结果作废（不是错误，是过期） */
export class MapWorkflowStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MapWorkflowStaleError'
  }
}

export class MapAssetTypeError extends Error {
  code = 'not_a_map'
}

export function isMapAsset(prop: Pick<PropRow, 'assetType'>): boolean {
  return (prop.assetType ?? 'prop') === 'map'
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

/** 库里 JSON → 工作流文档。坏数据绝不让详情接口 500：缺字段补默认值 */
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
    task_id: nullableId(record.task_id),
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
  }
}

export async function getProp(propId: number): Promise<PropRow | null> {
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
  return row && !row.deletedAt ? row : null
}

export interface LoadedWorkflow {
  prop: PropRow
  state: MapWorkflowState
  mapSpec: MapSpec | null
  rawWorkflow: string | null
  rawSpec: string | null
}

/** 读地图资产 + 工作流；不是地图资产抛 MapAssetTypeError（路由翻 400 not_a_map） */
export async function loadWorkflow(propId: number): Promise<LoadedWorkflow | null> {
  const prop = await getProp(propId)
  if (!prop) return null
  if (!isMapAsset(prop)) {
    throw new MapAssetTypeError('该资产不是地图资产（asset_type≠map），没有地图工作流；如需地图能力请先把它标记为地图资产')
  }
  return {
    prop,
    state: parseWorkflow(prop.mapWorkflow),
    mapSpec: parseMapSpec(prop.mapSpec),
    rawWorkflow: prop.mapWorkflow ?? null,
    rawSpec: prop.mapSpec ?? null,
  }
}

export function stepOf(state: MapWorkflowState, stage: MapWorkflowStage): MapWorkflowStep {
  const step = state.steps.find(item => item.id === stage)
  if (step) return step
  const created: MapWorkflowStep = { id: stage, label: STAGE_LABEL[stage], status: 'pending', message: null, started_at: null, finished_at: null }
  state.steps.push(created)
  return created
}

/**
 * 尚未保存过需求时的初值：主题取资产名、补充说明取资产描述（Issue #84）。
 *
 * 地图资产本来就是带着名字与描述建出来的，让用户再抄一遍是白费事；
 * 时代/地域/用途仍然空着，由充分性判断去推断或阻塞——这里**不做任何关键词解析**。
 * 已经保存过的需求一律原样返回，绝不被资产描述覆盖。
 */
export function briefOfProp(prop: Pick<PropRow, 'name' | 'description'>, state: MapWorkflowState): MapBrief {
  if (state.brief) return state.brief
  return { ...emptyBrief(), subject: prop.name ?? '', notes: prop.description ?? '' }
}

export function setStep(state: MapWorkflowState, stage: MapWorkflowStage, patch: Partial<MapWorkflowStep>): void {
  Object.assign(stepOf(state, stage), patch)
}

export function stageIndex(stage: MapWorkflowStage): number {
  return MAP_WORKFLOW_STAGES.indexOf(stage)
}

export interface MutateContext {
  prop: PropRow
  state: MapWorkflowState
  /** 可写：赋值即与工作流在同一条 UPDATE 里落库（并经 normalizeMapSpec 校验） */
  mapSpec: MapSpec | null
  /** 可写：完成登记时回写 image_url / local_path / faithful_source 等 */
  propPatch: Partial<typeof schema.props.$inferInsert>
}

export interface MutateOptions {
  /** 人工请求带的修订号；不传表示不做乐观锁（仍然做 CAS 原文比对） */
  expectedRevision?: number | null
  /** 这次写入要求工作流当前不在跑（run/advance/rollback/人工编辑都要求） */
  requireIdle?: boolean
  /** 异步阶段回写：必须仍是这次任务、brief 没被改过，否则判定结果过期 */
  expectedTaskId?: number | null
  expectedBriefHash?: string | null
  action: string
  actor: 'auto' | 'manual' | 'system'
  note?: string | null
  /** 记录回退快照（brief / map_spec / 产出 / 检索） */
  snapshot?: boolean
  mutate: (ctx: MutateContext) => void | Promise<void>
}

/**
 * 唯一写入口。顺序固定：**先全量校验，再做任何写**；写入用 CAS，失败不改库。
 * 返回写入后的最新状态。
 */
export async function mutateWorkflow(propId: number, opts: MutateOptions): Promise<LoadedWorkflow> {
  const loaded = await loadWorkflow(propId)
  if (!loaded) throw new MapAssetTypeError('道具不存在')
  const { prop, state, mapSpec, rawWorkflow, rawSpec } = loaded

  if (opts.expectedRevision !== undefined && opts.expectedRevision !== null && opts.expectedRevision !== state.revision) {
    throw new MapWorkflowConflictError(
      `地图工作流已被其他操作修改（当前修订号 ${state.revision}），请刷新后重试`,
      { code: 'revision_conflict', revision: state.revision, taskId: state.task_id },
    )
  }
  if (opts.requireIdle && state.status === 'running') {
    throw new MapWorkflowConflictError(
      `地图工作流正在执行「${STAGE_LABEL[state.stage]}」${state.task_id ? `（任务 #${state.task_id}）` : ''}，请先等待完成或取消`,
      { code: 'workflow_busy', revision: state.revision, taskId: state.task_id },
    )
  }
  if (opts.expectedTaskId !== undefined && opts.expectedTaskId !== null && state.task_id !== opts.expectedTaskId) {
    throw new MapWorkflowStaleError(`本次结果已过期：工作流的当前任务是 ${state.task_id ?? '（无）'}，不是 #${opts.expectedTaskId}`)
  }
  if (opts.expectedBriefHash !== undefined && opts.expectedBriefHash !== null && state.brief_hash !== opts.expectedBriefHash) {
    throw new MapWorkflowStaleError('本次结果已过期：地图需求在执行期间被修改或回退，结果不写入')
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
    prop,
    state: JSON.parse(JSON.stringify(state)) as MapWorkflowState,
    mapSpec: mapSpec ? JSON.parse(JSON.stringify(mapSpec)) as MapSpec : null,
    propPatch: {},
  }
  await opts.mutate(ctx)

  const next = ctx.state
  next.version = 1
  next.revision = state.revision + 1
  next.updated_at = now()
  next.history = [
    ...state.history,
    {
      revision: next.revision,
      at: next.updated_at,
      stage: next.stage,
      status: next.status,
      action: opts.action,
      actor: opts.actor,
      note: opts.note ?? null,
      ...(before ? { snapshot: before } : {}),
    },
  ].slice(-MAX_HISTORY)

  // 几何永远过一遍 normalizeMapSpec：工作流不是绕开地图校验的后门
  const nextSpec = ctx.mapSpec ? normalizeMapSpec(ctx.mapSpec) : null
  const nextSpecRaw = nextSpec ? JSON.stringify(nextSpec) : null

  const result = await db.update(schema.props)
    .set({ ...ctx.propPatch, mapWorkflow: JSON.stringify(next), mapSpec: nextSpecRaw, updatedAt: next.updated_at })
    .where(and(
      eq(schema.props.id, propId),
      rawWorkflow === null ? isNull(schema.props.mapWorkflow) : eq(schema.props.mapWorkflow, rawWorkflow),
      rawSpec === null ? isNull(schema.props.mapSpec) : eq(schema.props.mapSpec, rawSpec),
    ))
  // better-sqlite3 的 RunResult：CAS 没命中时 changes = 0（原文已被别人改写）
  const changes = result && typeof result === 'object' && 'changes' in result ? Number(result.changes) : 0
  if (changes === 0) {
    throw new MapWorkflowConflictError(
      '地图工作流在本次写入期间被其他操作修改，已放弃本次写入（之前的工作完整保留），请刷新后重试',
      { code: 'revision_conflict', revision: state.revision, taskId: state.task_id },
    )
  }

  const reloaded = await loadWorkflow(propId)
  if (!reloaded) throw new MapAssetTypeError('道具不存在')
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
  ctx.state.brief = entry.snapshot.brief
  ctx.state.brief_hash = briefHash(entry.snapshot.brief)
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

/**
 * 跨项目导入：当前产物和回退快照都指向目标项目自己的文件与版本。
 * 源任务只作为导入来源保留在版本元数据中，不作为新工作流的执行任务。
 */
export function prepareImportedWorkflow(
  raw: string | null | undefined,
  options: { copyPath: (path: string) => string; versionIds: ReadonlyMap<number, number> },
): string | null {
  if (!raw) return null
  const state = parseWorkflow(JSON.stringify(parseWorkflow(raw), (key, value: unknown) =>
    IMPORT_MEDIA_KEYS.has(key) && typeof value === 'string' && value.startsWith('static/') ? options.copyPath(value) : value))
  state.brief_hash = briefHash(state.brief)
  const at = now()
  state.task_id = null
  state.error = null
  if (state.status === 'running') state.status = 'idle'
  for (const step of state.steps) {
    if (step.status === 'running') Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
  }
  for (const outputs of [state.outputs, ...state.history.flatMap(item => item.snapshot ? [item.snapshot.outputs] : [])]) {
    for (const key of ['base_image', 'texture_image', 'final_image'] as const) {
      const output = outputs[key]
      if (output) output.task_id = options.versionIds.get(output.task_id ?? 0) ?? null
    }
  }
  state.revision += 1
  state.updated_at = at
  const entry: MapWorkflowHistoryEntry = {
    revision: state.revision,
    at,
    stage: state.stage,
    status: state.status,
    action: 'imported',
    actor: 'system',
    note: '从其它项目导入：文件与版本已独立复制，运行态已复位',
  }
  state.history = [...state.history, entry].slice(-MAX_HISTORY)
  return JSON.stringify(state)
}

/**
 * 道具行 → 接口载荷（Issue #84）。所有返回道具行的接口都必须走这里。
 *
 * 规则：
 * - `asset_type` 永远带上（前端据它决定显不显示地图 UI，不靠猜名字）；
 * - 普通道具**不带任何地图字段**：没有 map_spec、没有 map_workflow，连 null 都不出现；
 * - 地图资产带 `map_spec`，但不带 `map_workflow`——那是一份大文档，
 *   只由 `GET /props/:id/map-workflow` 提供，列表接口不该驮着它走。
 */
export function serializeProp(row: PropRow): Record<string, unknown> {
  const payload = toSnakeCase(row)
  delete payload.map_workflow
  if (!isMapAsset(row)) delete payload.map_spec
  payload.asset_type = row.assetType ?? 'prop'
  return payload
}

export interface MapWorkflowDetail extends Omit<MapWorkflowState, 'version' | 'brief_hash'> {
  prop_id: number
  prop_name: string
  asset_type: 'map'
  map_spec: MapSpec | null
  busy: boolean
}

export function serializeDetail(loaded: LoadedWorkflow): MapWorkflowDetail {
  const { prop, state, mapSpec } = loaded
  const { brief_hash: _hash, version: _version, ...rest } = state
  return {
    ...rest,
    prop_id: prop.id,
    prop_name: prop.name,
    asset_type: 'map',
    // 还没保存过需求时给出「资产名 + 描述」的初值，面板一打开就不是空白
    brief: briefOfProp(prop, state),
    map_spec: mapSpec,
    busy: state.status === 'running',
  }
}
