/**
 * 全局任务中心 —— 把 sys_task（图像/视频/文本）、关键帧批次、视频批次、导出合成
 * 汇总成一份带编号（label）的统一列表，供顶栏抽屉、/tasks 页与各处进度环读取。
 *
 * 编号（用户确认 2026-10-27）：
 *   分镜任务 `《剧名》E02-#05 · 尾帧 / 中间帧 / 首帧 / 视频`
 *   资产出图 `《剧名》· 角色|场景|道具 · <名字>`
 *   集级文本 `《剧名》E02 · 拆分分镜 …`
 * 批次是一行父任务，子任务挂在 children 下、不在顶层重复。
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  ACTIVE_TASK_STATUSES,
  isActiveTaskStatus,
  parseRemoteState,
  serializeTask,
  type RemoteState,
  type SysTaskRow,
} from './sys-task.js'
import { aggregateBatchItems, type KeyframeBatchItem } from './keyframe-batch-progress.js'
import { parseTextTaskParams } from './text-task.js'
import { composeEpisodeLabel, composeTaskLabel, type TaskTargetKind } from './task-label.js'
import { toUnixSeconds } from './media-time.js'
import { IMPORTED_TASK_PROVIDER } from './asset-library.js'

export type { TaskLabelInput, TaskTargetKind } from './task-label.js'
export { composeEpisodeLabel, composeTaskLabel, renderRefPrompt } from './task-label.js'


// ─── 启动维护 ─────────────────────────────────────────────────

/** 重启打断的文本任务：执行线程已丢失，统一标记为失败（不自动重跑） */
export async function failInterruptedTextTasks(): Promise<void> {
  const res = await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: '后端重启中断', updatedAt: now() })
    .where(and(eq(schema.sysTask.type, 'text'), inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES)))
  const affected = typeof res === 'object' && res !== null && 'changes' in res && typeof res.changes === 'number'
    ? res.changes
    : 0
  if (affected > 0) console.log(`🔁 已标记 ${affected} 个中断的文本任务为失败`)
}

/** 存量任务补归属集：分镜任务可由 storyboard_id 反查 */
export async function backfillTaskEpisodeIds(): Promise<void> {
  const rows = await db.select().from(schema.sysTask).where(and(
    isNull(schema.sysTask.episodeId),
    ne(schema.sysTask.storyboardId, 0),
  ))
  const pending = rows.filter(row => row.storyboardId != null && row.episodeId == null)
  if (!pending.length) return
  const storyboardIds = [...new Set(pending.map(row => row.storyboardId as number))]
  const storyboards = await db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.id, storyboardIds))
  const episodeOf = new Map(storyboards.map(sb => [sb.id, sb.episodeId]))
  let filled = 0
  for (const row of pending) {
    const episodeId = episodeOf.get(row.storyboardId as number)
    if (!episodeId) continue
    await db.update(schema.sysTask).set({ episodeId }).where(eq(schema.sysTask.id, row.id))
    filled++
  }
  if (filled > 0) console.log(`🧩 已回填 ${filled} 个任务的归属集`)
}

// ─── 行组装 ───────────────────────────────────────────────────

interface NameLookups {
  dramaTitles: Map<number, string>
  episodes: Map<number, { number: number; dramaId: number }>
  storyboards: Map<number, { number: number; episodeId: number }>
  characters: Map<number, string>
  scenes: Map<number, string>
  props: Map<number, string>
}

const EMPTY_LOOKUPS: NameLookups = {
  dramaTitles: new Map(), episodes: new Map(), storyboards: new Map(),
  characters: new Map(), scenes: new Map(), props: new Map(),
}

async function loadLookups(rows: SysTaskRow[], extraEpisodeIds: number[] = []): Promise<NameLookups> {
  const ids = <T,>(values: (T | null | undefined)[]) => [...new Set(values.filter((v): v is T => v != null))]
  const storyboardIds = ids(rows.map(r => r.storyboardId))
  const storyboards = storyboardIds.length
    ? await db.select().from(schema.storyboards).where(inArray(schema.storyboards.id, storyboardIds))
    : []

  const episodeIds = ids([...rows.map(r => r.episodeId), ...storyboards.map(sb => sb.episodeId), ...extraEpisodeIds])
  const episodes = episodeIds.length
    ? await db.select().from(schema.episodes).where(inArray(schema.episodes.id, episodeIds))
    : []

  const dramaIds = ids([...rows.map(r => r.dramaId), ...episodes.map(ep => ep.dramaId)])
  const dramas = dramaIds.length
    ? await db.select().from(schema.dramas).where(inArray(schema.dramas.id, dramaIds))
    : []

  const characterIds = ids(rows.map(r => r.characterId))
  const sceneIds = ids(rows.map(r => r.sceneId))
  const propIds = ids(rows.map(r => r.propId))
  const characters = characterIds.length
    ? await db.select().from(schema.characters).where(inArray(schema.characters.id, characterIds))
    : []
  const scenes = sceneIds.length
    ? await db.select().from(schema.scenes).where(inArray(schema.scenes.id, sceneIds))
    : []
  const props = propIds.length
    ? await db.select().from(schema.props).where(inArray(schema.props.id, propIds))
    : []

  return {
    dramaTitles: new Map(dramas.map(d => [d.id, d.title || ''])),
    episodes: new Map(episodes.map(ep => [ep.id, { number: ep.episodeNumber, dramaId: ep.dramaId }])),
    storyboards: new Map(storyboards.map(sb => [sb.id, { number: sb.storyboardNumber, episodeId: sb.episodeId }])),
    characters: new Map(characters.map(a => [a.id, a.name || ''])),
    // 场景没有 name 列，展示用地点
    scenes: new Map(scenes.map(a => [a.id, a.location || ''])),
    props: new Map(props.map(a => [a.id, a.name || ''])),
  }
}

function paramsOf(row: SysTaskRow): Record<string, unknown> {
  if (!row.params) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(row.params)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const params = { ...(parsed as Record<string, unknown>) }
  // output_text 全文只在 GET /tasks/:id 顶层返回，列表/活跃轮询不携带（Issue #19）
  delete params.output_text
  return params
}

export type TaskRow = Record<string, unknown> & { row_type: 'task'; id: number }

/** sys_task 行 → 任务中心行（serializeTask + 归属信息 + 编号） */
export function buildTaskRow(row: SysTaskRow, lookups: NameLookups): TaskRow {
  const params = paramsOf(row)
  const storyboard = row.storyboardId != null ? lookups.storyboards.get(row.storyboardId) : undefined
  const episodeId = row.episodeId ?? storyboard?.episodeId ?? null
  const episode = episodeId != null ? lookups.episodes.get(episodeId) : undefined
  const dramaId = row.dramaId ?? episode?.dramaId ?? null

  let targetKind: TaskTargetKind | null = null
  let targetName: string | null = null
  if (row.storyboardId != null) {
    targetKind = 'storyboard'
  } else if (row.characterId != null) {
    targetKind = 'character'
    targetName = lookups.characters.get(row.characterId) ?? null
  } else if (row.sceneId != null) {
    targetKind = 'scene'
    targetName = lookups.scenes.get(row.sceneId) ?? null
  } else if (row.propId != null) {
    targetKind = 'prop'
    targetName = lookups.props.get(row.propId) ?? null
  } else if (row.type === 'text') {
    targetKind = 'episode'
  }

  const frameType = typeof params.frameType === 'string' ? params.frameType : null
  const kind = row.type === 'text' ? parseTextTaskParams(row.params)?.kind ?? null : null
  const dramaTitle = dramaId != null ? lookups.dramaTitles.get(dramaId) ?? null : null

  return {
    ...serializeTask(row),
    // 任务中心行里 params 以对象返回（扁平 GET /tasks 仍是原始字符串，老调用方不受影响）
    params,
    row_type: 'task',
    id: row.id,
    episode_id: episodeId,
    drama_id: dramaId,
    drama_title: dramaTitle,
    episode_number: episode?.number ?? null,
    storyboard_number: storyboard?.number ?? null,
    target_kind: targetKind,
    target_name: targetName,
    frame_type: frameType,
    kind,
    progress: row.type === 'text' ? parseTextTaskParams(row.params)?.progress ?? null : null,
    reasoning_chars: row.type === 'text' && typeof params.reasoning_chars === 'number' ? params.reasoning_chars : null,
    retry_of: typeof params.retry_of === 'number' ? params.retry_of : null,
    label: composeTaskLabel({
      type: row.type,
      dramaTitle,
      episodeNumber: episode?.number ?? null,
      storyboardNumber: storyboard?.number ?? null,
      frameType,
      kind,
      targetKind,
      targetName,
    }),
  }
}

export async function enrichTasks(rows: SysTaskRow[]): Promise<TaskRow[]> {
  if (!rows.length) return []
  const lookups = await loadLookups(rows)
  return rows.map(row => buildTaskRow(row, lookups))
}

export async function enrichTask(row: SysTaskRow | undefined | null): Promise<TaskRow | null> {
  if (!row) return null
  const lookups = await loadLookups([row])
  return buildTaskRow(row, lookups)
}

// ─── 父任务行（批次 / 导出） ──────────────────────────────────

export interface ParentRow {
  row_type: 'keyframe_batch' | 'video_batch'
  id: number
  episode_id: number
  drama_id: number | null
  label: string
  status: string
  progress: number
  counts: Record<string, number>
  created_at: string
  created_at_unix: number | null
  updated_at: string
  updated_at_unix: number | null
  children: TaskRow[]
}

export interface MergeRow {
  row_type: 'video_merge'
  id: number
  episode_id: number | null
  drama_id: number | null
  label: string
  status: string
  result_url: string | null
  error_msg: string | null
  created_at: string
  created_at_unix: number | null
  updated_at: string
  updated_at_unix: number | null
  /** 成片产出时刻（unix 秒），未完成为 null */
  generated_at: number | null
}

export type CenterRow = TaskRow | ParentRow | MergeRow

function parseBatchItems(raw: string | null | undefined): KeyframeBatchItem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as KeyframeBatchItem[] : []
  } catch {
    return []
  }
}

/** 批次状态 → 是否仍在进行（running 为活跃，done/cancelled 终态） */
export function isActiveBatchStatus(status: string | null | undefined): boolean {
  return (status || 'running') === 'running'
}

const RECENT_WINDOW_MS = 7 * 24 * 3600_000

export interface CenterFilters {
  dramaId?: number
  episodeId?: number
  type?: 'image' | 'video' | 'text'
  status?: 'active' | 'completed' | 'failed' | 'cancelled'
  scope?: 'recent' | 'all'
  page?: number
  pageSize?: number
}

function matchesTaskStatus(filter: CenterFilters['status'], status: string | null | undefined): boolean {
  if (!filter) return true
  if (filter === 'active') return isActiveTaskStatus(status)
  return status === filter
}

/** 批次/导出的状态归一到筛选用的四态 */
function parentStatusFilterValue(status: string | null | undefined): 'active' | 'completed' | 'failed' | 'cancelled' {
  const value = status || 'running'
  if (value === 'running' || value === 'pending' || value === 'processing' || value === 'queued') return 'active'
  if (value === 'cancelled') return 'cancelled'
  if (value === 'failed' || value === 'error') return 'failed'
  return 'completed'
}

/**
 * 任务中心列表：sys_task + 关键帧批次 + 视频批次 + 导出合成，按创建时间倒序分页。
 * 批次子任务挂在父行 children 下，不在顶层重复出现。
 */
export async function listTaskCenter(filters: CenterFilters): Promise<{
  items: CenterRow[]
  total: number
  page: number
  page_size: number
}> {
  const page = Math.max(1, filters.page || 1)
  const pageSize = Math.min(200, Math.max(1, filters.pageSize || 20))
  const cutoff = Date.now() - RECENT_WINDOW_MS
  const recentOnly = (filters.scope || 'recent') === 'recent'

  const allTasks = await db.select().from(schema.sysTask)
  const keyframeBatches = await db.select().from(schema.keyframeBatches)
  const videoBatches = await db.select().from(schema.videoBatches)
  const merges = (await db.select().from(schema.videoMerges)).filter(row => !row.deletedAt)

  const batchEpisodeIds = [
    ...keyframeBatches.map(b => b.episodeId),
    ...videoBatches.map(b => b.episodeId),
    ...merges.map(m => m.episodeId).filter((id): id is number => id != null),
  ]
  const lookups = await loadLookups(allTasks, batchEpisodeIds)
  const dramaOfEpisode = (episodeId: number | null) =>
    (episodeId != null ? lookups.episodes.get(episodeId)?.dramaId ?? null : null)
  const labelOfEpisode = (episodeId: number | null, suffix: string) => {
    const dramaId = dramaOfEpisode(episodeId)
    return composeEpisodeLabel(
      dramaId != null ? lookups.dramaTitles.get(dramaId) : null,
      episodeId != null ? lookups.episodes.get(episodeId)?.number : null,
      suffix,
    )
  }

  const taskById = new Map(allTasks.map(row => [row.id, row]))
  const childIds = new Set<number>()
  for (const batch of [...keyframeBatches, ...videoBatches]) {
    for (const item of parseBatchItems(batch.items)) {
      if (item.task_id != null) childIds.add(item.task_id)
    }
  }

  const inRange = (createdAt: string, active: boolean) =>
    !recentOnly || active || Date.parse(createdAt) >= cutoff

  const rows: CenterRow[] = []

  for (const row of allTasks) {
    // 跨项目导入复制出的版本行（Issue #9）不是真的跑过的任务，不进任务中心
    if (row.provider === IMPORTED_TASK_PROVIDER) continue
    if (childIds.has(row.id)) continue
    if (filters.type && row.type !== filters.type) continue
    if (!matchesTaskStatus(filters.status, row.status)) continue
    const built = buildTaskRow(row, lookups)
    if (filters.episodeId && built.episode_id !== filters.episodeId) continue
    if (filters.dramaId && built.drama_id !== filters.dramaId) continue
    if (!inRange(row.createdAt, isActiveTaskStatus(row.status))) continue
    rows.push(built)
  }

  const pushBatch = (
    rowType: 'keyframe_batch' | 'video_batch',
    batch: { id: number; episodeId: number; status: string | null; items: string | null; createdAt: string; updatedAt: string },
    suffix: string,
  ) => {
    const items = parseBatchItems(batch.items)
    const children = items
      .map(item => (item.task_id != null ? taskById.get(item.task_id) : undefined))
      .filter((row): row is SysTaskRow => !!row)
      .map(row => buildTaskRow(row, lookups))
    const remoteByTask: Record<number, RemoteState> = {}
    for (const item of items) {
      if (item.task_id == null) continue
      const task = taskById.get(item.task_id)
      if (task) remoteByTask[item.task_id] = parseRemoteState(task.remoteState)
    }
    const aggregate = aggregateBatchItems(items, remoteByTask)
    const dramaId = dramaOfEpisode(batch.episodeId)
    const status = batch.status || 'running'
    if (filters.episodeId && batch.episodeId !== filters.episodeId) return
    if (filters.dramaId && dramaId !== filters.dramaId) return
    if (filters.status && parentStatusFilterValue(status) !== filters.status) return
    if (!inRange(batch.createdAt, isActiveBatchStatus(status))) return
    rows.push({
      row_type: rowType,
      id: batch.id,
      episode_id: batch.episodeId,
      drama_id: dramaId,
      label: labelOfEpisode(batch.episodeId, suffix),
      status,
      progress: aggregate.progress,
      counts: aggregate.counts,
      created_at: batch.createdAt,
      created_at_unix: toUnixSeconds(batch.createdAt),
      updated_at: batch.updatedAt,
      updated_at_unix: toUnixSeconds(batch.updatedAt),
      children,
    })
  }

  if (filters.type !== 'video' && filters.type !== 'text') {
    for (const batch of keyframeBatches) pushBatch('keyframe_batch', batch, '关键帧批量')
  }
  if (filters.type !== 'image' && filters.type !== 'text') {
    for (const batch of videoBatches) pushBatch('video_batch', batch, '视频批量')
    for (const merge of merges) {
      const dramaId = merge.dramaId ?? dramaOfEpisode(merge.episodeId)
      const status = merge.status || 'pending'
      if (filters.episodeId && merge.episodeId !== filters.episodeId) continue
      if (filters.dramaId && dramaId !== filters.dramaId) continue
      if (filters.status && parentStatusFilterValue(status) !== filters.status) continue
      if (!inRange(merge.createdAt, parentStatusFilterValue(status) === 'active')) continue
      rows.push({
        row_type: 'video_merge',
        id: merge.id,
        episode_id: merge.episodeId,
        drama_id: dramaId,
        label: labelOfEpisode(merge.episodeId, '导出合成'),
        status,
        result_url: merge.mergedUrl ?? null,
        error_msg: merge.errorMsg ?? null,
        created_at: merge.createdAt,
        created_at_unix: toUnixSeconds(merge.createdAt),
        updated_at: merge.completedAt || merge.createdAt,
        updated_at_unix: toUnixSeconds(merge.completedAt || merge.createdAt),
        generated_at: merge.generatedAt ?? null,
      })
    }
  }

  rows.sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)) || Number(b.id) - Number(a.id))
  const start = (page - 1) * pageSize
  return { items: rows.slice(start, start + pageSize), total: rows.length, page, page_size: pageSize }
}

/**
 * 活跃任务快照：所有未终结的 sys_task（含批次子任务与文本任务）扁平返回，
 * active_count 只数顶层（活跃批次 + 不属于批次的活跃任务），用于顶栏角标。
 */
export async function listActiveTasks(): Promise<{ items: TaskRow[]; active_count: number }> {
  const activeRows = await db.select().from(schema.sysTask)
    .where(inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES))
  const keyframeBatches = await db.select().from(schema.keyframeBatches)
  const videoBatches = await db.select().from(schema.videoBatches)

  const childIds = new Set<number>()
  let activeParents = 0
  for (const batch of [...keyframeBatches, ...videoBatches]) {
    const active = isActiveBatchStatus(batch.status)
    if (active) activeParents++
    for (const item of parseBatchItems(batch.items)) {
      if (item.task_id != null) childIds.add(item.task_id)
    }
  }

  const items = await enrichTasks(activeRows)
  const topLevel = activeRows.filter(row => !childIds.has(row.id)).length
  return { items, active_count: topLevel + activeParents }
}
