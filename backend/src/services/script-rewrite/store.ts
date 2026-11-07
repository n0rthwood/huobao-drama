/**
 * 分阶段改写的持久化（Issue #70 §1/§3）：不可变版本、运行记录、修订号 CAS 写入。
 *
 * 两条铁律：
 * 1. **版本只新增，不修改**。采用、重跑、人工保存都只会产生新行；历史文本、报告、hash 不变。
 * 2. **最终稿只能通过这里写**。写入一律带 `source_revision` / `final_revision` 条件
 *    （单条 UPDATE 的 WHERE 就是 CAS），冲突返回 `RevisionConflictError`，绝不静默覆盖。
 *    字节没变就不升修订号、不调 `onScriptChanged`——同字节采用不该让设计卡集体过期。
 */
import crypto from 'crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { onScriptChanged } from '../workflow-gates.js'
import { REWRITE_STAGES, type RewriteStageKey } from './stages.js'

export type VersionSource = 'source_snapshot' | 'prepared_source' | 'agent' | 'skip_copy' | 'manual'
export type VersionStageKey = 'source_snapshot' | 'prepared_source' | RewriteStageKey | 'manual'
export type RunStatus = 'queued' | 'processing' | 'completed' | 'failed'
export type StageStatus = 'pending' | 'processing' | 'completed' | 'skipped' | 'failed'
export type AdoptionStatus = 'pending' | 'adopted' | 'conflict' | 'manual'

export type RunRow = typeof schema.scriptRewriteRun.$inferSelect
export type VersionRow = typeof schema.scriptVersion.$inferSelect
export type StageRow = typeof schema.scriptRewriteStage.$inferSelect

export const ACTIVE_RUN_STATUSES: RunStatus[] = ['queued', 'processing']

export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export class RevisionConflictError extends Error {
  constructor(public readonly current: { source_revision: number; final_revision: number }) {
    super('原始资料或最终稿在此期间已经改变：请先比较差异再决定是否采用，系统不会静默覆盖')
    this.name = 'RevisionConflictError'
  }
}

export interface EpisodeRevisions {
  source_revision: number
  final_revision: number
  final_version_id: number | null
  content: string
  script_content: string
}

export async function episodeRevisions(episodeId: number): Promise<EpisodeRevisions | null> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return null
  return {
    source_revision: ep.sourceRevision ?? 1,
    final_revision: ep.finalRevision ?? 1,
    final_version_id: ep.finalVersionId ?? null,
    content: ep.content ?? '',
    script_content: ep.scriptContent ?? '',
  }
}

/**
 * 原始资料真的变了才升 source_revision（PUT /episodes/:id 写 content 时调用）。
 * 自增在 SQL 里完成（`source_revision + 1`），并发改原文不会丢掉任何一次 +1，
 * 运行中的改写据此判定「原文已变」。
 */
export async function bumpSourceRevision(episodeId: number): Promise<number> {
  await db.update(schema.episodes)
    .set({ sourceRevision: sql`${schema.episodes.sourceRevision} + 1`, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  return ep?.sourceRevision ?? 1
}

export interface CreateVersionInput {
  episodeId: number
  runId?: number | null
  stageKey: VersionStageKey
  stageIndex?: number | null
  source: VersionSource
  predecessorId?: number | null
  content: string
  report?: unknown
  taskId?: number | null
}

export async function createVersion(input: CreateVersionInput): Promise<number> {
  const res = await db.insert(schema.scriptVersion).values({
    episodeId: input.episodeId,
    runId: input.runId ?? null,
    stageKey: input.stageKey,
    stageIndex: input.stageIndex ?? null,
    source: input.source,
    predecessorId: input.predecessorId ?? null,
    content: input.content,
    contentHash: contentHash(input.content),
    report: input.report === undefined ? null : JSON.stringify(input.report),
    taskId: input.taskId ?? null,
    createdAt: now(),
  })
  return getInsertId(res)
}

export async function getVersion(versionId: number): Promise<VersionRow | null> {
  const [row] = await db.select().from(schema.scriptVersion).where(eq(schema.scriptVersion.id, versionId))
  return row ?? null
}

export async function listVersions(episodeId: number): Promise<VersionRow[]> {
  return db.select().from(schema.scriptVersion)
    .where(eq(schema.scriptVersion.episodeId, episodeId))
    .orderBy(desc(schema.scriptVersion.id))
}

export async function listRuns(episodeId: number): Promise<RunRow[]> {
  return db.select().from(schema.scriptRewriteRun)
    .where(eq(schema.scriptRewriteRun.episodeId, episodeId))
    .orderBy(desc(schema.scriptRewriteRun.id))
}

export async function getRun(runId: number): Promise<RunRow | null> {
  const [row] = await db.select().from(schema.scriptRewriteRun).where(eq(schema.scriptRewriteRun.id, runId))
  return row ?? null
}

export async function activeRun(episodeId: number): Promise<RunRow | null> {
  const [row] = await db.select().from(schema.scriptRewriteRun).where(and(
    eq(schema.scriptRewriteRun.episodeId, episodeId),
    inArray(schema.scriptRewriteRun.status, ACTIVE_RUN_STATUSES),
  ))
  return row ?? null
}

export async function listStages(runIds: number[]): Promise<StageRow[]> {
  if (!runIds.length) return []
  return db.select().from(schema.scriptRewriteStage)
    .where(inArray(schema.scriptRewriteStage.runId, runIds))
    .orderBy(schema.scriptRewriteStage.stageIndex)
}

export async function updateRun(runId: number, patch: Partial<typeof schema.scriptRewriteRun.$inferInsert>): Promise<void> {
  await db.update(schema.scriptRewriteRun)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.scriptRewriteRun.id, runId))
}

export async function updateStage(runId: number, stageKey: string, patch: Partial<typeof schema.scriptRewriteStage.$inferInsert>): Promise<void> {
  await db.update(schema.scriptRewriteStage)
    .set(patch)
    .where(and(eq(schema.scriptRewriteStage.runId, runId), eq(schema.scriptRewriteStage.stageKey, stageKey)))
}

export interface CanonicalWrite {
  episodeId: number
  content: string
  /** CAS 期望值；缺省表示调用方不做并发保护（只有内部补写才允许） */
  expectedFinalRevision?: number
  expectedSourceRevision?: number
  /** 已有的不可变版本（采用历史版本/候选稿）；缺省时按 `manual` 新建一条 */
  versionId?: number
  manualPredecessorId?: number | null
  manualReport?: unknown
  reason: string
}

export interface CanonicalWriteResult {
  changed: boolean
  source_revision: number
  final_revision: number
  version_id: number
}

/**
 * 最终稿的唯一写入口。
 *
 * CAS 落在一条 UPDATE 的 WHERE 上（`final_revision` + `source_revision` 必须仍是读到的值），
 * 因此「运行结束自动采用」与「用户正在保存」不会互相覆盖：谁先到谁赢，后到的拿 409。
 * 字节相同只更新来源（final_version_id），不升修订号、不触发 `onScriptChanged`。
 */
export async function writeCanonicalFinal(input: CanonicalWrite): Promise<CanonicalWriteResult> {
  const before = await episodeRevisions(input.episodeId)
  if (!before) throw new Error('剧集不存在')
  const expectedFinal = input.expectedFinalRevision ?? before.final_revision
  const expectedSource = input.expectedSourceRevision ?? before.source_revision
  if (expectedFinal !== before.final_revision || expectedSource !== before.source_revision) {
    throw new RevisionConflictError({ source_revision: before.source_revision, final_revision: before.final_revision })
  }

  const changed = before.script_content !== input.content
  const nextFinal = changed ? before.final_revision + 1 : before.final_revision
  // 人工保存先落不可变版本；CAS 没抢到时这条尚未被任何人引用，直接撤回
  const versionId = input.versionId ?? await createVersion({
    episodeId: input.episodeId,
    stageKey: 'manual',
    source: 'manual',
    predecessorId: input.manualPredecessorId ?? before.final_version_id,
    content: input.content,
    report: input.manualReport,
  })

  const res = await db.update(schema.episodes)
    .set({ scriptContent: input.content, finalRevision: nextFinal, finalVersionId: versionId, updatedAt: now() })
    .where(and(
      eq(schema.episodes.id, input.episodeId),
      eq(schema.episodes.finalRevision, before.final_revision),
      eq(schema.episodes.sourceRevision, before.source_revision),
    ))
  if (!res.changes) {
    if (!input.versionId) await db.delete(schema.scriptVersion).where(eq(schema.scriptVersion.id, versionId))
    const current = await episodeRevisions(input.episodeId)
    throw new RevisionConflictError({
      source_revision: current?.source_revision ?? before.source_revision,
      final_revision: current?.final_revision ?? before.final_revision,
    })
  }

  // 同字节不触发失效：换个版本 ID 不该让确认状态与设计卡集体过期
  if (changed) await onScriptChanged(input.episodeId, input.reason)
  return { changed, source_revision: before.source_revision, final_revision: nextFinal, version_id: versionId }
}

export interface StagePlanEntry {
  key: RewriteStageKey
  label: string
  revision: string
  skipped: boolean
}

export function parseStagePlan(raw: string | null | undefined): StagePlanEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as StagePlanEntry[] : []
  } catch {
    return []
  }
}

/** 当前代码里注册的阶段（GET 状态的 `stages` 字段：新增阶段发布后才出现） */
export function registeredStages(): Array<{ key: RewriteStageKey; label: string; revision: string }> {
  return REWRITE_STAGES.map(stage => ({ key: stage.key, label: stage.label, revision: stage.revision }))
}

function parseReport(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function serializeVersion(row: VersionRow) {
  return {
    id: row.id,
    run_id: row.runId,
    episode_id: row.episodeId,
    stage_key: row.stageKey,
    stage_index: row.stageIndex,
    source: row.source,
    predecessor_id: row.predecessorId,
    content: row.content,
    content_hash: row.contentHash,
    report: parseReport(row.report),
    task_id: row.taskId,
    created_at: row.createdAt,
  }
}

export function serializeRun(row: RunRow, stages: StageRow[]) {
  const plan = parseStagePlan(row.stagePlan)
  const byKey = new Map(stages.filter(s => s.runId === row.id).map(s => [s.stageKey, s]))
  return {
    id: row.id,
    task_id: row.taskId,
    status: row.status as RunStatus,
    current_stage: row.currentStage,
    stage_plan: plan,
    source_version_id: row.sourceVersionId,
    prepared_version_id: row.preparedVersionId,
    source_hash: row.sourceHash,
    source_revision: row.sourceRevision,
    base_final_revision: row.baseFinalRevision,
    predecessor_version_id: row.predecessorVersionId,
    adoption_status: row.adoptionStatus as AdoptionStatus,
    auto_adopt: row.autoAdopt === 1,
    candidate_version_id: row.candidateVersionId,
    config_id: row.configId,
    model: row.model,
    error: row.errorMsg,
    created_at: row.createdAt,
    finished_at: row.finishedAt,
    stages: plan.map((entry, index) => {
      const stage = byKey.get(entry.key)
      return {
        key: entry.key,
        label: entry.label,
        revision: entry.revision,
        status: (stage?.status ?? 'pending') as StageStatus,
        stage_index: stage?.stageIndex ?? index + 1,
        version_id: stage?.versionId ?? null,
        error: stage?.errorMsg ?? null,
        started_at: stage?.startedAt ?? null,
        finished_at: stage?.finishedAt ?? null,
      }
    }),
  }
}

/** GET /episodes/:id/script-rewrite 的完整状态 */
export async function rewriteState(episodeId: number) {
  const revisions = await episodeRevisions(episodeId)
  if (!revisions) return null
  const runs = await listRuns(episodeId)
  const stages = await listStages(runs.map(run => run.id))
  const versions = await listVersions(episodeId)
  return {
    runs: runs.map(run => serializeRun(run, stages)),
    versions: versions.map(serializeVersion),
    current_run: runs.length ? serializeRun(runs[0]!, stages) : null,
    current_final_version_id: revisions.final_version_id,
    source_revision: revisions.source_revision,
    final_revision: revisions.final_revision,
    stages: registeredStages(),
  }
}
