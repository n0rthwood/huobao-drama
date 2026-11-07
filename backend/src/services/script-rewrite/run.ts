import { runWithTextTask } from '../text-task-context.js'
import { requeueFirstModelFailure } from '../text-task-restart.js'

/**
 * 分阶段改写的服务端串行 runner（Issue #70 §2）。
 *
 * - 一集同时只允许一个活跃运行；执行状态走既有 `sys_task`，不另建一套调度或轮询。
 * - 每个阶段成功后**先落不可变版本**再进入下一阶段；失败就地停住，保留已完成版本和旧最终稿。
 * - 后端重启：活跃运行标为中断失败，已提交版本保持有效，**不自动重放模型调用**（不重复计费）。
 * - 迟到响应：每次写回前重读运行状态，运行已经不是本轮 processing 就丢弃结果。
 * - 全部阶段完成后才有候选稿；只有「原文与最终稿修订号都没变 + 用户没有开始手改」时才自动采用。
 */
import { and, eq, inArray } from 'drizzle-orm'

import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { resolveDramaProjectType } from '../project-type.js'
import { resolveStageModel, stageModelUsed, type StageModel } from '../ai-stages.js'
import {
  createTextTask,
  finishTextTask,
  parseTextTaskParams,
  patchTextTaskParams,
} from '../text-task.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../../utils/task-logger.js'
import { PreparedSourceEmptyError, prepareSourceOrThrow } from './source-filter.js'
import { FidelityContractError, REWRITE_STAGES, type RewriteStageKey } from './stages.js'
import {
  ACTIVE_RUN_STATUSES,
  RevisionConflictError,
  activeRun,
  contentHash,
  createVersion,
  episodeRevisions,
  getRun,
  getVersion,
  updateRun,
  updateStage,
  writeCanonicalFinal,
  type RunRow,
  type StagePlanEntry,
} from './store.js'

/** 路由层据此把服务错误翻译成 {code,error,message}；不再在路由里复述规则 */
export class RewriteRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly extra?: Record<string, unknown>) {
    super(message)
    this.name = 'RewriteRequestError'
  }
}

export interface StartRunOptions {
  startStage?: RewriteStageKey
  predecessorVersionId?: number
  skipStages?: string[]
  configId?: number
  model?: string
  autoAdopt?: boolean
  sourceRevision?: number
  finalRevision?: number
  /** 前驱属于更早的原文快照时，必须显式确认才允许混用（默认 409 拦下） */
  acknowledgeSourceChange?: boolean
  retryOf?: number
  excludeConfigIds?: number[]
}

export interface StartRunResult {
  run_id: number
  task_id: number
}

function stageIndexOf(key: string): number {
  return REWRITE_STAGES.findIndex(stage => stage.key === key)
}
/**
 * 插入运行行；撞上「一集一个活跃运行」的部分唯一索引就翻成 409。
 * 约束在库里，先查后插的竞态窗口因此不会真的放进第二个运行。
 */
async function insertRunOrConflict(values: typeof schema.scriptRewriteRun.$inferInsert) {
  try {
    return await db.insert(schema.scriptRewriteRun).values(values)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/UNIQUE constraint failed/i.test(message)) throw err
    const running = await activeRun(values.episodeId)
    throw new RewriteRequestError(409, 'run_active', '本集已有正在执行的改写运行，请等它结束或先处理它', { run_id: running?.id })
  }
}


/**
 * 新建一次运行：冻结原文 → 自动过滤（不可跳过）→ 建任务与阶段行 → 后台串行执行。
 * 过滤后没有正文时**不建运行**，直接 400：不能把元信息当旁白，也不伪造正文。
 */
export async function startRewriteRun(episodeId: number, opts: StartRunOptions = {}): Promise<StartRunResult> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new RewriteRequestError(404, 'not_found', '剧集不存在')
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') {
    throw new RewriteRequestError(400, 'not_documentary', '分阶段改写只用于纪录片项目')
  }

  const revisions = await episodeRevisions(episodeId)
  if (!revisions) throw new RewriteRequestError(404, 'not_found', '剧集不存在')
  if ((opts.sourceRevision != null && opts.sourceRevision !== revisions.source_revision)
    || (opts.finalRevision != null && opts.finalRevision !== revisions.final_revision)) {
    throw new RewriteRequestError(409, 'revision_conflict', '原始资料或最终稿已经变化，请刷新后再执行', {
      source_revision: revisions.source_revision,
      final_revision: revisions.final_revision,
    })
  }

  const running = await activeRun(episodeId)
  if (running) {
    throw new RewriteRequestError(409, 'run_active', '本集已有正在执行的改写运行，请等它结束或先处理它', { run_id: running.id })
  }

  const rawSource = revisions.content
  if (!rawSource.trim()) throw new RewriteRequestError(400, 'no_source', '本集还没有原始内容，无法改写')

  let prepared
  try {
    prepared = prepareSourceOrThrow(rawSource)
  } catch (err) {
    if (err instanceof PreparedSourceEmptyError) {
      throw new RewriteRequestError(400, 'prepared_source_empty', err.message, { report: err.report })
    }
    throw err
  }

  const startKey = opts.startStage ?? REWRITE_STAGES[0]!.key
  const startIndex = stageIndexOf(startKey)
  if (startIndex < 0) throw new RewriteRequestError(400, 'invalid_stage', `未注册的阶段：${startKey}`)

  const planned = REWRITE_STAGES.slice(startIndex)
  const skip = new Set((opts.skipStages ?? []).filter(key => planned.some(stage => stage.key === key)))
  const plan: StagePlanEntry[] = planned.map(stage => ({
    key: stage.key,
    label: stage.label,
    revision: stage.revision,
    skipped: skip.has(stage.key),
  }))

  // 从后续阶段重跑：前驱必须是上一阶段的**正式版本**，不能拿人工稿或原文冒充阶段产出
  let predecessorVersionId: number | null = null
  if (startIndex > 0) {
    if (!opts.predecessorVersionId) {
      throw new RewriteRequestError(400, 'predecessor_required', `从「${REWRITE_STAGES[startIndex]!.label}」重跑必须指定上一阶段的版本`)
    }
    const predecessor = await getVersion(opts.predecessorVersionId)
    const requiredStage = REWRITE_STAGES[startIndex - 1]!
    if (!predecessor || predecessor.episodeId !== episodeId) {
      throw new RewriteRequestError(400, 'invalid_predecessor', '指定的前驱版本不属于本集')
    }
    if (predecessor.stageKey !== requiredStage.key || !['agent', 'skip_copy'].includes(predecessor.source)) {
      throw new RewriteRequestError(400, 'invalid_predecessor', `前驱必须是「${requiredStage.label}」阶段的正式版本`)
    }
    const predecessorRun = predecessor.runId ? await getRun(predecessor.runId) : null
    if (!opts.acknowledgeSourceChange && predecessorRun?.sourceHash && predecessorRun.sourceHash !== contentHash(rawSource)) {
      throw new RewriteRequestError(409, 'source_changed', '该前驱版本基于更早的原始资料：确认要在新原文下继续使用它，请显式确认后重试', {
        predecessor_version_id: predecessor.id,
      })
    }
    predecessorVersionId = predecessor.id
  }

  // 任务行要记「实际用了哪条配置/模型」：按本轮第一个真正要调模型的阶段解析
  const firstModelStage = planned.find(stage => !skip.has(stage.key))
  let stageModel: StageModel | null = null
  if (firstModelStage) {
    try {
      stageModel = await resolveStageModel(firstModelStage.aiStage, { configId: opts.configId, model: opts.model, excludeConfigIds: opts.excludeConfigIds })
    } catch (err) {
      throw new RewriteRequestError(400, 'model_unavailable', err instanceof Error ? err.message : '文本模型不可用')
    }
  }

  const ts = now()
  // 并发保护落在部分唯一索引上（idx_script_rewrite_run_active）：上面的 activeRun 查询只是
  // 快路径，真正保证「一集一个活跃运行」的是这条插入；撞约束就是别人先到，照样 409。
  const runRes = await insertRunOrConflict({
    episodeId,
    dramaId: ep.dramaId,
    status: 'queued',
    currentStage: plan[0]?.key ?? null,
    stagePlan: JSON.stringify(plan),
    sourceHash: contentHash(rawSource),
    sourceRevision: revisions.source_revision,
    baseFinalRevision: revisions.final_revision,
    predecessorVersionId,
    adoptionStatus: 'pending',
    autoAdopt: opts.autoAdopt === false ? 0 : 1,
    configId: stageModel?.configId ?? opts.configId ?? null,
    model: stageModel?.model ?? opts.model ?? null,
    createdAt: ts,
    updatedAt: ts,
  })
  const runId = getInsertId(runRes)

  // 冻结输入：原始资料快照 + 自动过滤正文（过滤报告挂在 prepared 版本上）
  const sourceVersionId = await createVersion({
    episodeId, runId, stageKey: 'source_snapshot', source: 'source_snapshot', content: rawSource,
  })
  const preparedVersionId = await createVersion({
    episodeId, runId, stageKey: 'prepared_source', source: 'prepared_source',
    predecessorId: sourceVersionId, content: prepared.prepared, report: prepared.report,
  })

  for (const [index, entry] of plan.entries()) {
    await db.insert(schema.scriptRewriteStage).values({
      runId, stageKey: entry.key, stageIndex: index + 1, status: 'pending',
    })
  }

  const taskId = await createTextTask({
    kind: 'script_rewrite',
    episodeId,
    dramaId: ep.dramaId,
    prompt: `分阶段改写：${plan.map(entry => `${entry.label}${entry.skipped ? '（跳过）' : ''}`).join(' → ')}`,
    stageModel: stageModel ?? undefined,
    configId: stageModel ? undefined : opts.configId ?? null,
    retryOf: opts.retryOf,
    progress: { completed: 0, total: plan.length, failed: 0, step: plan[0]?.key },
    queued: true,
    restart: { kind: 'script_rewrite', args: { episodeId, opts } },
  })
  await patchTextTaskParams(taskId, {
    rewrite: {
      run_id: runId,
      stage_key: plan[0]?.key ?? null,
      stage_index: 1,
      stage_total: plan.length,
      stages: plan.map(entry => ({ key: entry.key, status: 'pending', version_id: null, error: null })),
    },
  })
  await updateRun(runId, { taskId, sourceVersionId, preparedVersionId, status: 'processing' })

  logTaskStart('ScriptRewrite', 'run', { runId, taskId, episodeId, stages: plan.map(entry => entry.key) })
  void runWithTextTask(taskId, () => executeRun(runId)).catch(err => logTaskError('ScriptRewrite', 'run', {
    runId, error: err instanceof Error ? err.message : String(err),
  }))
  return { run_id: runId, task_id: taskId }
}

/** 任务详情里的阶段时间线：每次状态变化都同步进 sys_task.params */
async function syncTaskProgress(run: RunRow, plan: StagePlanEntry[], states: Map<string, { status: string; versionId: number | null; error: string | null }>, currentKey: string | null): Promise<void> {
  if (!run.taskId) return
  const done = [...states.values()].filter(state => state.status === 'completed' || state.status === 'skipped').length
  const failed = [...states.values()].filter(state => state.status === 'failed').length
  await patchTextTaskParams(run.taskId, {
    progress: { completed: done, total: plan.length, failed, step: currentKey ?? undefined },
    rewrite: {
      run_id: run.id,
      stage_key: currentKey,
      stage_index: currentKey ? plan.findIndex(entry => entry.key === currentKey) + 1 : plan.length,
      stage_total: plan.length,
      stages: plan.map(entry => ({
        key: entry.key,
        status: states.get(entry.key)?.status ?? 'pending',
        version_id: states.get(entry.key)?.versionId ?? null,
        error: states.get(entry.key)?.error ?? null,
      })),
    },
  })
}

async function executeRun(runId: number): Promise<void> {
  const run = await getRun(runId)
  if (!run) return
  const plan: StagePlanEntry[] = JSON.parse(run.stagePlan)
  const states = new Map<string, { status: string; versionId: number | null; error: string | null }>()

  const sourceVersion = run.sourceVersionId ? await getVersion(run.sourceVersionId) : null
  const preparedVersion = run.preparedVersionId ? await getVersion(run.preparedVersionId) : null
  if (!sourceVersion || !preparedVersion) {
    await failRun(runId, run.taskId, '本轮冻结输入缺失，无法执行')
    return
  }

  let predecessor = run.predecessorVersionId ? await getVersion(run.predecessorVersionId) : preparedVersion
  if (!predecessor) {
    await failRun(runId, run.taskId, '指定的前驱版本已不存在')
    return
  }

  for (const entry of plan) {
    const spec = REWRITE_STAGES.find(stage => stage.key === entry.key)!
    const fresh = await getRun(runId)
    // 运行已被重启标失败 / 被新运行取代：不再写回任何结果
    if (!fresh || fresh.status !== 'processing') {
      logTaskProgress('ScriptRewrite', 'run-abandoned', { runId, stage: entry.key, status: fresh?.status })
      return
    }
    const startedAt = now()
    await updateRun(runId, { currentStage: entry.key })
    await updateStage(runId, entry.key, { status: entry.skipped ? 'skipped' : 'processing', startedAt })
    states.set(entry.key, { status: entry.skipped ? 'skipped' : 'processing', versionId: null, error: null })
    await syncTaskProgress(fresh, plan, states, entry.key)

    try {
      let versionId: number
      if (entry.skipped) {
        // 跳过 = 服务端按字节复制直接前驱，产生真实版本；**不调用**该阶段的模型
        versionId = await createVersion({
          episodeId: run.episodeId,
          runId,
          stageKey: entry.key,
          stageIndex: plan.findIndex(item => item.key === entry.key) + 1,
          source: 'skip_copy',
          predecessorId: predecessor.id,
          content: predecessor.content,
          report: { skipped: true, copied_from_version_id: predecessor.id },
          taskId: run.taskId,
        })
      } else {
        const stageModel = await resolveStageModel(spec.aiStage, {
          configId: run.configId ?? undefined,
          model: run.model ?? undefined,
        })
        if (run.taskId) await patchTextTaskParams(run.taskId, { stage: spec.aiStage, model_used: stageModelUsed(stageModel) })
        const result = await spec.run({
          rawSource: sourceVersion.content,
          preparedText: preparedVersion.content,
          predecessorText: predecessor.content,
          stageModel,
          taskId: run.taskId,
        })
        // 迟到响应：运行已经终结就丢弃，绝不覆盖新运行或最终稿
        const still = await getRun(runId)
        if (!still || still.status !== 'processing') {
          logTaskProgress('ScriptRewrite', 'late-result-discarded', { runId, stage: entry.key })
          return
        }
        versionId = await createVersion({
          episodeId: run.episodeId,
          runId,
          stageKey: entry.key,
          stageIndex: plan.findIndex(item => item.key === entry.key) + 1,
          source: 'agent',
          predecessorId: predecessor.id,
          content: result.content,
          report: result.report,
          taskId: run.taskId,
        })
      }
      await updateStage(runId, entry.key, { status: entry.skipped ? 'skipped' : 'completed', versionId, finishedAt: now() })
      states.set(entry.key, { status: entry.skipped ? 'skipped' : 'completed', versionId, error: null })
      await syncTaskProgress(fresh, plan, states, entry.key)
      predecessor = (await getVersion(versionId))!
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 失败不产生正式版本，但诊断要留得住：契约违例的逐项计量写进任务 params
      if (err instanceof FidelityContractError && run.taskId) {
        await patchTextTaskParams(run.taskId, { failed_stage: { key: entry.key, report: err.report } })
      }
      await updateStage(runId, entry.key, { status: 'failed', errorMsg: message, finishedAt: now() })
      states.set(entry.key, { status: 'failed', versionId: null, error: message })
      await syncTaskProgress(fresh, plan, states, entry.key)
      // 阶段失败：下游停止，已完成版本与旧最终稿保留，不自动采用最近成功阶段
      await failRun(runId, run.taskId, `「${entry.label}」失败：${message}`)
      if (run.taskId) await requeueFirstModelFailure(run.taskId, err, entry.key === 'fidelity' && plan[0]?.key === 'fidelity' && !entry.skipped)
      return
    }
  }

  await finishRunWithCandidate(runId, predecessor.id, plan, states)
}

async function failRun(runId: number, taskId: number | null, message: string): Promise<void> {
  await updateRun(runId, { status: 'failed', errorMsg: message, finishedAt: now() })
  if (taskId) await finishTextTask(taskId, 'failed', { errorMsg: message })
  logTaskError('ScriptRewrite', 'run', { runId, error: message })
}

/** 全部阶段完成：产生候选稿，并只在「输入没被动过 + 未开始人工编辑」时一次性采用 */
async function finishRunWithCandidate(runId: number, candidateVersionId: number, plan: StagePlanEntry[], states: Map<string, { status: string; versionId: number | null; error: string | null }>): Promise<void> {
  const run = await getRun(runId)
  if (!run) return
  // 重启后老进程可能把最后一个阶段跑完：此时运行已被 failInterruptedRewriteRuns 标成失败，
  // 迟到的结果只丢弃——不采用候选稿，也不把 failed 改回 completed（验收 #6）。
  if (run.status !== 'processing') {
    logTaskProgress('ScriptRewrite', 'late-result-discarded', { runId, stage: 'finish', status: run.status })
    return
  }
  const candidate = await getVersion(candidateVersionId)
  if (!candidate) {
    await failRun(runId, run.taskId, '候选版本缺失')
    return
  }

  let adoption: 'adopted' | 'conflict' | 'manual' = 'manual'
  let adoptError: string | null = null
  if (run.autoAdopt === 1) {
    try {
      await writeCanonicalFinal({
        episodeId: run.episodeId,
        content: candidate.content,
        expectedSourceRevision: run.sourceRevision,
        expectedFinalRevision: run.baseFinalRevision,
        versionId: candidate.id,
        reason: `分阶段改写运行 R${run.id} 自动采用候选稿`,
      })
      adoption = 'adopted'
    } catch (err) {
      if (!(err instanceof RevisionConflictError)) throw err
      adoption = 'conflict'
      adoptError = err.message
    }
  }

  await updateRun(runId, {
    status: 'completed',
    candidateVersionId: candidate.id,
    adoptionStatus: adoption,
    currentStage: plan[plan.length - 1]?.key ?? null,
    errorMsg: adoptError,
    finishedAt: now(),
  })
  if (run.taskId) {
    const refreshed = await getRun(runId)
    if (refreshed) await syncTaskProgress(refreshed, plan, states, null)
    await finishTextTask(run.taskId, 'completed', { outputText: candidate.content })
  }
  logTaskSuccess('ScriptRewrite', 'run', { runId, adoption, candidateVersionId: candidate.id })
}

/**
 * 运行期间用户开始手改最终稿：先持久化「本轮不自动采用」，前端才允许进入编辑。
 * 已经采用过的运行不回滚——采用是事实，撤销要走显式的人工保存。
 */
export async function disableAutoAdopt(runId: number): Promise<RunRow> {
  const run = await getRun(runId)
  if (!run) throw new RewriteRequestError(404, 'not_found', '运行不存在')
  if (run.adoptionStatus === 'adopted') {
    throw new RewriteRequestError(409, 'already_adopted', '本轮结果已经采用：请直接编辑最终稿并保存')
  }
  await updateRun(runId, { autoAdopt: 0, adoptionStatus: run.status === 'completed' ? 'manual' : run.adoptionStatus })
  return (await getRun(runId))!
}

/**
 * 任何人工最终稿写入（改写页保存、PUT /episodes/:id 的 script_content）都先调这里：
 * 本集还有活跃运行时，持久化「不自动采用」，于是运行结束只保留候选稿，
 * 不会在用户手改之后把自己的结果盖上去。没有活跃运行时什么都不做。
 */
export async function holdAutoAdoptForManualEdit(episodeId: number): Promise<number | null> {
  const run = await activeRun(episodeId)
  if (!run || run.autoAdopt === 0) return run?.id ?? null
  await updateRun(run.id, { autoAdopt: 0 })
  logTaskProgress('ScriptRewrite', 'auto-adopt-held', { runId: run.id, episodeId })
  return run.id
}

/** 显式采用某个历史/候选版本；历史版本本身不变，只产生新的采用记录 */
export async function adoptVersion(episodeId: number, versionId: number, expected: { sourceRevision?: number; finalRevision?: number }): Promise<{ changed: boolean; final_revision: number }> {
  const version = await getVersion(versionId)
  if (!version || version.episodeId !== episodeId) throw new RewriteRequestError(404, 'not_found', '版本不存在')
  if (version.stageKey === 'source_snapshot') {
    throw new RewriteRequestError(400, 'not_adoptable', '原始资料快照不是旁白稿，不能直接作为最终稿采用')
  }
  const result = await writeCanonicalFinal({
    episodeId,
    content: version.content,
    expectedSourceRevision: expected.sourceRevision,
    expectedFinalRevision: expected.finalRevision,
    versionId: version.id,
    reason: `显式采用版本 V${version.id}（${version.stageKey}）`,
  })
  if (version.runId) {
    const run = await getRun(version.runId)
    if (run && run.candidateVersionId === version.id) await updateRun(run.id, { adoptionStatus: 'adopted' })
  }
  return { changed: result.changed, final_revision: result.final_revision }
}

/**
 * 启动钩子（Issue #70 §2「后端重启」）：活跃运行标为中断失败。
 * 已落版本保持有效，不自动重放模型调用、不自动采用；人工决定继续跑还是跳过。
 */
export async function failInterruptedRewriteRuns(): Promise<void> {
  const runs = await db.select().from(schema.scriptRewriteRun)
    .where(inArray(schema.scriptRewriteRun.status, ACTIVE_RUN_STATUSES))
  if (!runs.length) return
  const ts = now()
  const message = '服务重启，改写运行中断：已完成的阶段版本保留，请从失败阶段继续或跳过'
  for (const run of runs) {
    await db.update(schema.scriptRewriteStage)
      .set({ status: 'failed', errorMsg: message, finishedAt: ts })
      .where(and(
        eq(schema.scriptRewriteStage.runId, run.id),
        inArray(schema.scriptRewriteStage.status, ['pending', 'processing']),
      ))
    await updateRun(run.id, { status: 'failed', errorMsg: message, finishedAt: ts })
  }
  console.log(`🔁 已标记 ${runs.length} 个被重启打断的剧本改写运行`)
}

/**
 * 任务中心重试（换模型）：按原运行的阶段计划从**失败的那个阶段**续跑，
 * 已完成阶段的版本直接作为前驱复用，不重跑已经花过钱的阶段。
 */
export async function retryRewriteRun(taskRow: { id: number; episodeId: number | null; params: string | null }, opts: { configId?: number; model?: string }): Promise<number> {
  const episodeId = taskRow.episodeId
  if (!episodeId) throw new RewriteRequestError(400, 'invalid_task', '该任务缺少剧集信息，无法重试')
  const params = parseTextTaskParams(taskRow.params)
  const runId = params?.rewrite?.run_id
  const previous = Number.isInteger(runId) ? await getRun(Number(runId)) : null
  if (!previous) {
    // 旧的同步改写任务没有运行记录：按默认计划重新跑一轮完整流程
    const started = await startRewriteRun(episodeId, { configId: opts.configId, model: opts.model, retryOf: taskRow.id })
    return started.task_id
  }

  const plan: StagePlanEntry[] = JSON.parse(previous.stagePlan)
  const stageRows = await db.select().from(schema.scriptRewriteStage)
    .where(eq(schema.scriptRewriteStage.runId, previous.id))
  const doneKeys = new Set(stageRows.filter(row => row.status === 'completed' || row.status === 'skipped').map(row => row.stageKey))
  const resume = plan.find(entry => !doneKeys.has(entry.key)) ?? plan[plan.length - 1]!
  const resumeIndex = stageIndexOf(resume.key)
  const predecessorKey = resumeIndex > 0 ? REWRITE_STAGES[resumeIndex - 1]!.key : null
  // 前驱先看本轮已完成的阶段行；只跑后段的运行（startStage:'bridge'）没有上一阶段的阶段行，
  // 它继承来的前驱记在运行行上，必须接着往下传，否则这类运行根本重试不了。
  const predecessorVersionId = predecessorKey
    ? stageRows.find(row => row.stageKey === predecessorKey)?.versionId ?? previous.predecessorVersionId ?? undefined
    : undefined

  try {
    const started = await startRewriteRun(episodeId, {
      startStage: resume.key,
      predecessorVersionId: predecessorVersionId ?? undefined,
      skipStages: plan.filter(entry => entry.skipped).map(entry => entry.key),
      configId: opts.configId,
      model: opts.model,
      // 重试不替用户确认「新原文配旧前驱」（source_changed 409 照常冒出来），
      // 也不把被关掉的自动采用救活：手改过的最终稿不会被重试结果盖回去。
      autoAdopt: previous.autoAdopt === 1,
      retryOf: taskRow.id,
    })
    return started.task_id
  } catch (err) {
    if (err instanceof RewriteRequestError && err.code === 'source_changed') {
      throw new RewriteRequestError(409, 'source_changed',
        '原始资料在这次运行之后已经改过：任务中心重试不会把旧阶段结果套到新原文上，请到剧本改写页重新发起一轮改写',
        err.extra)
    }
    throw err
  }
}
