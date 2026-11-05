/**
 * 流水线 run 的生命周期（Issue #56）
 *
 * run 容器 = `sys_task(type='text', params.kind='asset_pipeline', provider='mastra')`：
 * 任务中心、进度、错误展示全部复用既有文本任务的那一套，不另建一张 run 表。
 * `params.mastra_run_id` 是 Mastra 的 runId，`params.progress.step` 是当前步名。
 *
 * 重启恢复：`resumeAssetPipelines()` 扫活跃的 `asset_pipeline` 任务，
 * - 快照 `suspended` → 保持等待人工（**不能**判失败，这正是 `failInterruptedTextTasks()`
 *   必须排除本 kind 的原因）；
 * - 快照 `running` → 原地重放（各步按库短路，昂贵的生图步由 `asset_round` 唯一索引兜底）；
 * - 快照缺失 → 标 failed 并写明原因。
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskWarn } from '../../utils/task-logger.js'
import { ACTIVE_TASK_STATUSES } from '../sys-task.js'
import { createTextTask, finishTextTask, parseTextTaskParams, patchTextTaskParams } from '../text-task.js'
import { pipelineMastra } from './mastra.js'
import { loadAssetTarget } from './steps.js'
import { latestQcByRound, listRounds, type AssetKind, type RoundPurpose } from './store.js'
import type { ApprovalResume, PipelineInput } from './workflow.js'

export const ASSET_PIPELINE_KIND = 'asset_pipeline'
export const ASSET_PIPELINE_PROVIDER = 'mastra'

export class PipelineConflictError extends Error {}
export class PipelineStateError extends Error {}

/**
 * `getWorkflowRunById()` 返回的是 Mastra 的 `WorkflowState`：顶层直接带
 * `status` / `suspendedPaths`（`Record<stepId, number[]>`）/ `steps[stepId].suspendPayload`
 * （@mastra/core 1.78 实测，见本文件头的冒烟）。这里只按 `in`/`typeof` 窄化读这三项，
 * 不对它的整体形状做断言。
 */
function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
}

function readSuggestion(raw: unknown): SuspendedPayload['suggestion'] {
  const record = asRecord(raw)
  return {
    action: typeof record?.action === 'string' ? record.action : 'pass',
    target_round_no: typeof record?.target_round_no === 'number' ? record.target_round_no : null,
    reason: typeof record?.reason === 'string' ? record.reason : '',
  }
}

function snapshotStatus(raw: unknown): string | null {
  const status = asRecord(raw)?.status
  return typeof status === 'string' ? status : null
}

interface SuspendedPayload {
  round_id: number
  round_no: number
  gate_pass: boolean
  suggestion: { action: string; target_round_no: number | null; reason: string }
}

/** 某资产是否已有活跃 run（同资产同时只允许一条，避免两条 run 抢同一个 round_no） */
export async function findActiveRun(kind: AssetKind, assetId: number): Promise<number | null> {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'text'),
    inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES),
  ))
  for (const row of rows) {
    const params = parseTextTaskParams(row.params)
    if (params?.kind !== ASSET_PIPELINE_KIND) continue
    if (params.asset_kind === kind && params.asset_id === assetId) return row.id
  }
  return null
}

export async function startAssetPipeline(input: {
  assetKind: AssetKind
  assetId: number
  episodeId: number
  purpose: RoundPurpose
  configId?: number | null
  model?: string | null
  textConfigId?: number | null
}): Promise<{ runId: number; mastraRunId: string }> {
  const active = await findActiveRun(input.assetKind, input.assetId)
  if (active) throw new PipelineConflictError(`该资产已有进行中的流水线（任务 #${active}），请先完成或终止它`)

  const target = await loadAssetTarget(input.assetKind, input.assetId)
  if (!target) throw new PipelineStateError('资产不存在')

  const taskId = await createTextTask({
    kind: ASSET_PIPELINE_KIND,
    episodeId: input.episodeId,
    dramaId: target.dramaId,
    prompt: `为${input.assetKind === 'prop' ? '道具' : input.assetKind === 'scene' ? '场景' : '角色'}「${target.name}」跑资产流水线（${input.purpose === 'precision' ? '精确轮' : '美化轮'}）`,
    provider: ASSET_PIPELINE_PROVIDER,
    model: 'asset-pipeline',
  })

  const workflow = pipelineMastra.getWorkflow('assetPipeline')
  const run = await workflow.createRun()
  await patchTextTaskParams(taskId, {
    mastra_run_id: run.runId,
    asset_kind: input.assetKind,
    asset_id: input.assetId,
    purpose: input.purpose,
    progress: { completed: 0, total: 0, failed: 0, step: 'research' },
  })

  const payload: PipelineInput = {
    pipelineTaskId: taskId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    episodeId: input.episodeId,
    purpose: input.purpose,
    configId: input.configId ?? null,
    model: input.model ?? null,
    textConfigId: input.textConfigId ?? null,
  }
  logTaskStart('AssetPipeline', 'run', { taskId, runId: run.runId, assetKind: input.assetKind, assetId: input.assetId })
  void driveRun(taskId, run.runId, payload, 'start')
  return { runId: taskId, mastraRunId: run.runId }
}

/**
 * 执行一次 start/resume 并把终态写回 sys_task。
 * `suspended` **不是终态**：任务保持活跃，等人在面板上点审批。
 */
async function driveRun(
  taskId: number,
  mastraRunId: string,
  payload: PipelineInput,
  mode: 'start' | 'resume',
  resumeData?: ApprovalResume,
  resumeStep?: string,
): Promise<void> {
  try {
    const workflow = pipelineMastra.getWorkflow('assetPipeline')
    const run = await workflow.createRun({ runId: mastraRunId })
    const result = mode === 'start'
      ? await run.start({ inputData: payload })
      : await run.resume({ step: resumeStep!, resumeData: resumeData! })

    if (result.status === 'suspended') {
      logTaskProgress('AssetPipeline', 'suspended', { taskId, runId: mastraRunId })
      return
    }
    if (result.status === 'success') {
      const output = 'result' in result && result.result && typeof result.result === 'object' ? result.result : {}
      await patchTextTaskParams(taskId, { result: output })
      await finishTextTask(taskId, 'completed')
      logTaskProgress('AssetPipeline', 'completed', { taskId, runId: mastraRunId })
      return
    }
    const message = 'error' in result ? result.error : undefined
    const text = message instanceof Error ? message.message : String(message ?? `工作流结束于 ${result.status}`)
    await finishTextTask(taskId, 'failed', { errorMsg: text })
    logTaskError('AssetPipeline', 'run', { taskId, runId: mastraRunId, error: text })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await finishTextTask(taskId, 'failed', { errorMsg: text })
    logTaskError('AssetPipeline', 'run', { taskId, runId: mastraRunId, error: text })
  }
}

/** 当前挂起在哪一步（没有挂起返回 null） */
export async function suspendedApproval(mastraRunId: string): Promise<{ step: string; payload: SuspendedPayload } | null> {
  const workflow = pipelineMastra.getWorkflow('assetPipeline')
  const state = asRecord(await workflow.getWorkflowRunById(mastraRunId))
  if (!state || state.status !== 'suspended') return null
  const suspendedPaths = asRecord(state.suspendedPaths)
  const step = suspendedPaths ? Object.keys(suspendedPaths)[0] ?? '' : ''
  if (!step) return null
  const stepState = asRecord(asRecord(state.steps)?.[step])
  const raw = asRecord(stepState?.suspendPayload)
  // 挂起载荷是本模块自己 suspend() 进去的，但它经过了一次 JSON 持久化：逐字段校验后再用
  const payload: SuspendedPayload = {
    round_id: typeof raw?.round_id === 'number' ? raw.round_id : 0,
    round_no: typeof raw?.round_no === 'number' ? raw.round_no : 0,
    gate_pass: raw?.gate_pass === true,
    suggestion: readSuggestion(raw?.suggestion),
  }
  return { step, payload }
}

export interface ApproveInput {
  runId: number
  roundId: number
  verdict: ApprovalResume['verdict']
  selectedViolations: string[]
  notes: string | null
  opened: Array<{ path: string; sha256: string }>
  overrideGate: boolean
}

export async function approveRound(input: ApproveInput): Promise<void> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, input.runId))
  if (!row) throw new PipelineStateError('流水线任务不存在')
  const params = parseTextTaskParams(row.params)
  if (params?.kind !== ASSET_PIPELINE_KIND) throw new PipelineStateError('该任务不是资产流水线')
  const mastraRunId = String(params.mastra_run_id ?? '')
  if (!mastraRunId) throw new PipelineStateError('该 run 没有 Mastra runId，无法续跑')

  // 「已打开看过」是硬门槛：没有图片 hash 的审批一律拒收（主进程裁决「建议 3」）
  if (!input.opened.length) throw new PipelineStateError('审批必须附上已打开查看的图片（path + sha256）')

  const rounds = await listRounds(input.runId)
  const round = rounds.find(item => item.id === input.roundId)
  if (!round) throw new PipelineStateError('该轮次不属于这条流水线')
  const qc = (await latestQcByRound([round.id])).get(round.id)
  if (input.verdict === 'approve' && qc && qc.gate_pass !== 1) {
    if (!input.overrideGate) throw new PipelineStateError('该轮未通过程序闸门，通过前必须显式勾选「覆盖闸门」')
    if (!input.notes?.trim()) throw new PipelineStateError('覆盖闸门必须写明理由')
  }

  const suspended = await suspendedApproval(mastraRunId)
  if (!suspended) throw new PipelineStateError('该 run 当前不在等待人工审批')

  const payload: PipelineInput = {
    pipelineTaskId: input.runId,
    assetKind: params.asset_kind as AssetKind,
    assetId: Number(params.asset_id),
    episodeId: row.episodeId ?? 0,
    purpose: (params.purpose as RoundPurpose) ?? 'precision',
  }
  await driveRun(input.runId, mastraRunId, payload, 'resume', {
    verdict: input.verdict,
    round_id: input.roundId,
    selected_violations: input.selectedViolations,
    notes: input.notes,
    opened: input.opened,
    override_gate: input.overrideGate,
  }, suspended.step)
}

export async function cancelRun(runId: number): Promise<void> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, runId))
  if (!row) throw new PipelineStateError('流水线任务不存在')
  const params = parseTextTaskParams(row.params)
  if (params?.kind !== ASSET_PIPELINE_KIND) throw new PipelineStateError('该任务不是资产流水线')

  const mastraRunId = String(params.mastra_run_id ?? '')
  if (mastraRunId) {
    try {
      const workflow = pipelineMastra.getWorkflow('assetPipeline')
      const run = await workflow.createRun({ runId: mastraRunId })
      await run.cancel()
    } catch (err) {
      logTaskWarn('AssetPipeline', 'cancel-workflow-failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 在飞的生图任务：qwen-jobs 可取消；取消不了的等它落地后把该轮标 discarded，不计入闸门
  const rounds = await listRounds(runId)
  for (const round of rounds) {
    if (!round.image_task_id || round.status === 'generated') continue
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, round.image_task_id))
    if (task && ACTIVE_TASK_STATUSES.includes(task.status as typeof ACTIVE_TASK_STATUSES[number])) {
      await db.update(schema.sysTask)
        .set({ status: 'cancelled', errorMsg: '流水线已取消', updatedAt: now() })
        .where(eq(schema.sysTask.id, task.id))
    }
    await db.update(schema.assetRound)
      .set({ status: 'discarded', updatedAt: now() })
      .where(eq(schema.assetRound.id, round.id))
  }
  await finishTextTask(runId, 'failed', { errorMsg: '已取消' })
}

/**
 * 启动恢复（在 index.ts 的批次恢复旁串行调用）。
 * 注意：`failInterruptedTextTasks()` 必须排除本 kind，否则这里永远看不到等待审批的 run。
 */
export async function resumeAssetPipelines(): Promise<void> {
  const rows = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'text'), inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES)))
    .orderBy(desc(schema.sysTask.id))
  let resumed = 0
  for (const row of rows) {
    const params = parseTextTaskParams(row.params)
    if (params?.kind !== ASSET_PIPELINE_KIND) continue
    const mastraRunId = String(params.mastra_run_id ?? '')
    if (!mastraRunId) {
      await finishTextTask(row.id, 'failed', { errorMsg: '重启恢复：该 run 没有 Mastra runId' })
      continue
    }
    try {
      const workflow = pipelineMastra.getWorkflow('assetPipeline')
      const status = snapshotStatus(await workflow.getWorkflowRunById(mastraRunId))
      if (!status) {
        await finishTextTask(row.id, 'failed', { errorMsg: '重启恢复：工作流快照缺失，无法续跑' })
        continue
      }
      if (status === 'suspended') {
        logTaskProgress('AssetPipeline', 'resume-waiting-human', { taskId: row.id, runId: mastraRunId })
        resumed++
        continue
      }
      if (status === 'running') {
        const payload: PipelineInput = {
          pipelineTaskId: row.id,
          assetKind: params.asset_kind as AssetKind,
          assetId: Number(params.asset_id),
          episodeId: row.episodeId ?? 0,
          purpose: (params.purpose as RoundPurpose) ?? 'precision',
        }
        void driveRun(row.id, mastraRunId, payload, 'start')
        resumed++
      }
    } catch (err) {
      await finishTextTask(row.id, 'failed', { errorMsg: `重启恢复失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }
  if (resumed > 0) console.log(`🧪 已恢复 ${resumed} 条资产流水线`)
}
