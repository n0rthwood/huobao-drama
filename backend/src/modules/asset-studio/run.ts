/** Asset Studio owns run lifecycle; Mastra only owns workflow snapshots. */
import {now} from '../../utils/response.js'
import {logTaskError,logTaskProgress,logTaskStart,logTaskWarn} from '../../utils/task-logger.js'
import {getRun,getTask,stmt,parseParams as parseTextTaskParams,patchParams as patchTextTaskParams,finishRun as finishTextTask,type RunRow} from './db.js'
import {getHost,getPlatform} from './registry.js'
import {pipelineMastra} from './mastra.js'
import {planNextRound,RoundPlanError} from './contract.js'
import {resolvePrecisionReferences} from './references.js'
import {loadAssetTarget} from './steps.js'
import {latestQcByRound,listRounds,patchRound,type AssetKind,type RoundPurpose} from './store.js'
import {roundPurposes,type ApprovalResume,type PipelineInput} from './workflow.js'
import {settings} from './settings.js'
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

/** 工作流失败时 `result.error` 可能是 Error、字符串或 `{message}` 对象；三种都要能读出人话 */
function describeError(raw: unknown): string | null {
  if (!raw) return null
  if (raw instanceof Error) return raw.message
  if (typeof raw === 'string') return raw
  const record = asRecord(raw)
  if (typeof record?.message === 'string') return record.message
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
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
  const row=stmt("SELECT r.id FROM asset_studio_run r JOIN asset_studio_task t ON t.id=r.task_id WHERE t.host_ref=? AND r.status IN ('running','suspended')").get(`${kind}:${assetId}`) as {id:number}|undefined
  return row?.id??null
}

export async function startAssetPipeline(input: {
  taskId: number
  assetKind: AssetKind
  assetId: number
  episodeId: number
  purpose: RoundPurpose
  /** 精确轮必填：人选定的 1–3 条已入库素材（Issue #73）。美化轮忽略 */
  sourceIds?: number[] | null
  configId?: number | null
  model?: string | null
  textConfigId?: number | null
}): Promise<{ runId: number; mastraRunId: string }> {
  const defaults=settings()
  input={...input,configId:input.configId??(Number(defaults.image_config_id)||undefined),model:input.model??(defaults.image_model||undefined),textConfigId:input.textConfigId??(Number(defaults.text_config_id)||undefined)}
  const active = await findActiveRun(input.assetKind, input.assetId)
  if (active) throw new PipelineConflictError(`该资产已有进行中的流水线（任务 #${active}），请先完成或终止它`)

  const target = await loadAssetTarget(input.assetKind, input.assetId)
  if (!target) throw new PipelineStateError('资产不存在')
  // 地图/图示类资产的几何是程序投影出来的真源：让它进生图链路 = 让扩散模型重画海岸线
  // 与河道（第一轮的事故形态）。服务端直接拒绝，UI 上也就没有误触的可能。
  const snapshot=await getHost().readAsset(`${input.assetKind}:${input.assetId}`)
  if(!snapshot || snapshot.faithful || snapshot.isMap)throw new PipelineStateError('忠实原件或地图资产不能进入生图流水线')

  // 参考图与出图模型都在**启动时定下来**：之后每一轮、重启续跑都用同一套输入。
  // 精确轮没有参考图就不许建任务（零参考图的「精确」只是换个说法的自由发挥）。
  const references = input.purpose === 'precision'
    ? await resolvePrecisionReferences(input.assetKind, input.assetId, input.sourceIds ?? [])
    : []
  const image = await getPlatform().imageSelection({ configId: input.configId, model: input.model })
  const referenceSourceIds = references.map(item => item.id)

  const previous=stmt("SELECT id FROM asset_studio_run WHERE task_id=? AND status='interrupted' ORDER BY id DESC LIMIT 1").get(input.taskId) as {id:number}|undefined
  const taskId=Number(stmt("INSERT INTO asset_studio_run(task_id,prev_run_id,status,purpose,params,created_at,updated_at) VALUES (?,?,'running',?,'{}',?,?)").run(input.taskId,previous?.id??null,input.purpose,now(),now()).lastInsertRowid)

  const workflow = pipelineMastra.getWorkflow('assetPipeline')
  const run = await workflow.createRun()
  const prior=previous?getRun(previous.id):undefined
  const priorParams=parseTextTaskParams(prior?.params)
  const reusable=priorParams.fingerprint===snapshot.fingerprint && priorParams.purpose===input.purpose
    && priorParams.image_config_id===image.configId && priorParams.image_model===image.model
    && JSON.stringify(priorParams.reference_source_ids)===JSON.stringify(referenceSourceIds)
  await patchTextTaskParams(taskId, {
    ...(reusable?{asset_research:priorParams.asset_research,asset_spec_id:priorParams.asset_spec_id,asset_spec_version:priorParams.asset_spec_version}:{}),
    mastra_run_id: run.runId,
    snapshot, fingerprint:snapshot.fingerprint, episode_id:input.episodeId, text_config_id:input.textConfigId??null,
    asset_kind: input.assetKind,
    asset_id: input.assetId,
    purpose: input.purpose,
    reference_source_ids: referenceSourceIds,
    image_config_id: image.configId,
    image_model: image.model,
    progress: { completed: 0, total: 0, failed: 0, step: 'research' },
  })

  const payload: PipelineInput = {
    pipelineTaskId: taskId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    episodeId: input.episodeId,
    purpose: input.purpose,
    referenceSourceIds,
    configId: image.configId,
    model: image.model,
    textConfigId: input.textConfigId ?? null,
  }
  stmt('UPDATE asset_studio_run SET mastra_run_id=? WHERE id=?').run(run.runId,taskId)
  logTaskStart('AssetPipeline', 'run', { taskId, runId: run.runId, assetKind: input.assetKind, assetId: input.assetId })
  void driveRun(taskId, run.runId, payload, 'start')
  return { runId: taskId, mastraRunId: run.runId }
}

/**
 * 执行一次 start/resume 并把终态写回模块运行表。
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
      stmt("UPDATE asset_studio_run SET status='suspended',updated_at=? WHERE id=? AND status='running'").run(now(),taskId)
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
    const text = describeError('error' in result ? result.error : undefined) ?? `工作流结束于 ${result.status}`
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

/**
 * 续跑（人工审批 / 重启恢复）用的输入：一律取**启动时冻结**的那一套，
 * 不读「现在的」素材角色与图片配置。老 run 的 params 里没有 `reference_source_ids`，
 * 保持 `undefined` 让 `selectPrecisionSources()` 走兼容口径（而不是当成「选了 0 张」）。
 */
function frozenPipelineInput(params: Record<string,any>, taskId: number, episodeId: number): PipelineInput {
  const rawIds = params.reference_source_ids
  return {
    pipelineTaskId: taskId,
    assetKind: params.asset_kind as AssetKind,
    assetId: Number(params.asset_id),
    episodeId,
    textConfigId:params.text_config_id??null,
    purpose: (params.purpose as RoundPurpose) ?? 'precision',
    referenceSourceIds: Array.isArray(rawIds) ? rawIds.map(Number) : undefined,
    configId: typeof params.image_config_id === 'number' ? params.image_config_id : null,
    model: typeof params.image_model === 'string' && params.image_model ? params.image_model : null,
  }
}

export interface ApproveInput {
  runId: number
  roundId: number
  verdict: ApprovalResume['verdict']
  selectedViolations: string[]
  notes: string | null
  opened: Array<{ path: string; sha256: string }>
  overrideGate: boolean
  /** 打回重修时下一轮的用途（Issue #73）；不给就沿用本轮用途 */
  nextPurpose?: RoundPurpose | null
}

export async function approveRound(input: ApproveInput): Promise<void> {
  const row = getRun(input.runId)
  if (!row) throw new PipelineStateError('流水线任务不存在')
  const params = parseTextTaskParams(row.params)
  const mastraRunId = String(params.mastra_run_id ?? '')
  if (!mastraRunId) throw new PipelineStateError('该 run 没有 Mastra runId，无法续跑')

  // 「已打开看过」是硬门槛：没有图片 hash 的审批一律拒收（主进程裁决「建议 3」）
  if (!input.opened.length || input.opened.some(item=>!item || typeof item.path!=='string' || !item.path || typeof item.sha256!=='string' || !item.sha256)) {
    throw new PipelineStateError('审批必须附上已打开查看的图片（path + sha256）')
  }

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
  // 页面可能停在旧轮次上：审批的轮次必须就是当前挂起的那一轮，否则一次「通过」会把
  // 正在等审批的 FAIL 轮直接放行（而且绕过了 override_gate 的检查）
  if (suspended.payload.round_id !== input.roundId) {
    throw new PipelineStateError(`页面上的轮次已过期：当前等待审批的是第 ${suspended.payload.round_no} 轮（round_id=${suspended.payload.round_id}），请刷新后重试`)
  }

  // 打回重修：下一轮用途默认沿用本轮，人可以显式改；去向不成立就别让它进工作流
  let nextPurpose: RoundPurpose | null = null
  if (input.nextPurpose) {
    if (input.verdict !== 'revise') throw new PipelineStateError('只有「打回重修」时才能指定下一轮用途')
    if (input.nextPurpose !== 'precision' && input.nextPurpose !== 'beautify') {
      throw new PipelineStateError('next_purpose 只能是 precision（精确轮）或 beautify（美化轮）')
    }
  }
  if (input.verdict === 'revise') {
    const startPurpose = (params.purpose as RoundPurpose) ?? 'precision'
    try {
      const plan = planNextRound({
        currentPurpose: round.purpose,
        currentRoundNo: round.round_no,
        requested: input.nextPurpose ?? null,
        beautifyDone: rounds.filter(item => item.purpose === 'beautify').length,
        maxRounds: roundPurposes(startPurpose).length,
      })
      nextPurpose = plan.purpose
    } catch (err) {
      if (err instanceof RoundPlanError) throw new PipelineStateError(err.message)
      throw err
    }
    if (nextPurpose === 'precision') {
      // 参考图取不到就不要开新轮：错误要在点「打回」的那一刻说清楚，而不是让下一轮跑崩
      const frozenIds = Array.isArray(params.reference_source_ids) ? params.reference_source_ids.map(Number) : undefined
      if (frozenIds && !frozenIds.length) {
        throw new PipelineStateError('这条流水线启动时没有选定精确轮参考图（以美化轮发起），无法转入精确轮；请终止后以「精确轮」重新发起并选择参考图')
      }
      await resolvePrecisionReferences(params.asset_kind as AssetKind, Number(params.asset_id), frozenIds)
    }
  }

  const payload = frozenPipelineInput(params, input.runId, Number(params.episode_id)||0)
  stmt("UPDATE asset_studio_run SET status='running',updated_at=? WHERE id=?").run(now(),input.runId)
  void driveRun(input.runId, mastraRunId, payload, 'resume', {
    verdict: input.verdict,
    round_id: input.roundId,
    selected_violations: input.selectedViolations,
    notes: input.notes,
    opened: input.opened,
    override_gate: input.overrideGate,
    next_purpose: nextPurpose,
  }, suspended.step)
}

export async function cancelRun(runId: number): Promise<void> {
  const row = getRun(runId)
  if (!row) throw new PipelineStateError('流水线任务不存在')
  const params = parseTextTaskParams(row.params)

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

  for(const round of await listRounds(runId)){
    if(round.image_task_id && round.status!=='generated')await getPlatform().cancelImage(round.image_task_id)
    if(round.status!=='generated')await patchRound(round.id,{status:'discarded'})
  }
  await finishTextTask(runId,'cancelled',{errorMsg:'已取消'})
}

/** Preserve approval suspensions; never replay an execution interrupted by process exit. */
export async function resumeAssetStudioRuns():Promise<void>{
 const rows=stmt("SELECT * FROM asset_studio_run WHERE status IN ('running','suspended')").all() as RunRow[]
 for(const row of rows){
  try{
   const status=row.mastra_run_id?snapshotStatus(await pipelineMastra.getWorkflow('assetPipeline').getWorkflowRunById(row.mastra_run_id)):null
   if(!status){await finishTextTask(row.id,'failed',{errorMsg:'重启恢复：工作流快照缺失'});continue}
   if(row.status==='suspended' && status==='suspended')continue
   const hb=stmt("SELECT MAX(heartbeat_at) AS hb FROM task_observed_work WHERE scope='asset_studio' AND task_id=?").get(row.id) as {hb:number|null}
   const frozen=new Date(Math.max(Date.parse(row.updated_at),hb.hb??0)).toISOString()
   const params=parseTextTaskParams(row.params)
   if(Array.isArray(params.stage_spans)){
    const spans=params.stage_spans.map((span:Record<string,any>)=>{
     if(span.finished_at)return span
     const works=stmt("SELECT id FROM task_observed_work WHERE scope='asset_studio' AND task_id=? AND id>?")
       .all(row.id,span.after_work_id??0) as {id:number}[]
     return {...span,finished_at:Date.parse(frozen),status:'interrupted',work_ids:works.map(work=>work.id)}
    })
    await patchTextTaskParams(row.id,{stage_spans:spans})
   }
   stmt("UPDATE asset_studio_run SET status='interrupted',error_msg='后端重启中断；请重新运行',completed_at=? WHERE id=?").run(frozen,row.id)
  }catch(e){await finishTextTask(row.id,'failed',{errorMsg:e instanceof Error?e.message:String(e)})}
 }
 stmt("UPDATE asset_studio_research SET status='failed',error_msg='后端重启中断',completed_at=? WHERE status='running'").run(now())
}
