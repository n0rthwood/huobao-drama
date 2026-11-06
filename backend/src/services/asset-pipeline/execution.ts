import { isActiveTaskStatus, type SysTaskRow } from '../sys-task.js'
import { parseTextTaskParams } from '../text-task.js'
import { pipelineMastra } from './mastra.js'

export interface PipelineExecution {
  state: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  awaiting: { round_id: number; round_no: number } | null
  asset_kind: string
  asset_id: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** Translate only a current, well-formed approval suspension into a waiting state. */
export function pipelineExecutionFromSnapshot(
  status: string | null, assetKind: string, assetId: number, snapshot: unknown,
): PipelineExecution {
  const result: PipelineExecution = { state: 'unknown', awaiting: null, asset_kind: assetKind, asset_id: assetId }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    result.state = status
    return result
  }
  if (!isActiveTaskStatus(status)) return result
  const state = record(snapshot)
  if (state?.status === 'running') {
    result.state = 'running'
    return result
  }
  if (state?.status !== 'suspended') return result
  const paths = record(state.suspendedPaths)
  const steps = record(state.steps)
  for (const step of Object.keys(paths ?? {})) {
    if (!/^approval_\d+$/.test(step)) continue
    const payload = record(record(steps?.[step])?.suspendPayload)
    if (typeof payload?.round_id !== 'number' || !Number.isInteger(payload.round_id) || payload.round_id <= 0 ||
        typeof payload.round_no !== 'number' || !Number.isInteger(payload.round_no) || payload.round_no < 0) continue
    result.state = 'waiting_approval'
    result.awaiting = { round_id: payload.round_id, round_no: payload.round_no }
    break
  }
  return result
}

/** No snapshot lookup for terminal or non-pipeline tasks; read failures remain unknown. */
export async function pipelineExecution(row: SysTaskRow): Promise<PipelineExecution | null> {
  const params = parseTextTaskParams(row.params)
  if (params?.kind !== 'asset_pipeline') return null
  const kind = typeof params.asset_kind === 'string' ? params.asset_kind : ''
  const id = Number(params.asset_id) || 0
  // cancelRun historically finishes the generic task as failed with this exact reason.
  const status = row.status === 'failed' && row.errorMsg === '已取消' ? 'cancelled' : row.status
  if (!isActiveTaskStatus(status)) return pipelineExecutionFromSnapshot(status, kind, id, null)
  const runId = typeof params.mastra_run_id === 'string' ? params.mastra_run_id : ''
  if (!runId) return pipelineExecutionFromSnapshot(row.status, kind, id, null)
  try {
    const snapshot = await pipelineMastra.getWorkflow('assetPipeline').getWorkflowRunById(runId)
    return pipelineExecutionFromSnapshot(row.status, kind, id, snapshot)
  } catch {
    return pipelineExecutionFromSnapshot(row.status, kind, id, null)
  }
}
