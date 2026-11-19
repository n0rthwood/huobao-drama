/**
 * 工作室 run 生命周期（Issue #123：Mastra 工作流已删，run 由 drafts.generateFromDraft 创建）。
 * 这里只保留：活跃 run 查询、取消、重启恢复。旧 suspended run 一律置 interrupted（只读历史）。
 */
import { now } from '../../utils/response.js'
import { stmt, getRun, finishRun, parseParams, patchParams, type RunRow } from './db.js'
import { getPlatform } from './registry.js'
import { listRounds, patchRound, type AssetKind } from './store.js'
import { logTaskWarn } from '../../utils/task-logger.js'

export class PipelineConflictError extends Error {}
export class PipelineStateError extends Error {}

/** 某资产是否已有活跃 run（同资产同时只允许一条；idx_asset_studio_active_run 唯一索引兜底） */
export async function findActiveRun(kind: AssetKind, assetId: number): Promise<number | null> {
  const row = stmt("SELECT r.id FROM asset_studio_run r JOIN asset_studio_task t ON t.id=r.task_id WHERE t.host_ref=? AND r.status IN ('running','suspended')").get(`${kind}:${assetId}`) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * 取消运行：远端生图任务尽力取消（排队中立即取消，运行中由服务端决定），
 * 未出图的轮次置 discarded，run 置 cancelled。执行体的写回点检查 run.status，取消后不复活。
 */
export async function cancelRun(runId: number): Promise<void> {
  const row = getRun(runId)
  if (!row) throw new PipelineStateError('工作室运行不存在')
  if (row.status !== 'running' && row.status !== 'suspended') throw new PipelineStateError('该运行已结束，无法取消')
  for (const round of await listRounds(runId)) {
    if (round.image_task_id && round.status !== 'generated') {
      try { await getPlatform().cancelImage(round.image_task_id) } catch (err) {
        logTaskWarn('AssetStudio', 'cancel-image-failed', { runId, imageTaskId: round.image_task_id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (round.status !== 'generated') await patchRound(round.id, { status: 'discarded' })
  }
  await finishRun(runId, 'cancelled', { errorMsg: '已取消' })
}

/**
 * 重启恢复（评审 P1-4 状态矩阵）：
 * - running/suspended run → interrupted（旧 Mastra 挂起审批不再续跑，只读历史）；
 * - drafting 草稿 → failed（可 retry 重新展开）；
 * - running 检索 → failed；
 * - 已下单未完成的 sys_task 保留原状态由 provider 轮询自然终结，round.image_task_id 保留供对账。
 */
export async function resumeAssetStudioRuns(): Promise<void> {
  const ts = now()
  const rows = stmt("SELECT * FROM asset_studio_run WHERE status IN ('running','suspended')").all() as RunRow[]
  for (const row of rows) {
    const params = parseParams(row.params)
    if (Array.isArray(params.stage_spans)) {
      const spans = params.stage_spans.map((span: Record<string, any>) => span.finished_at ? span : { ...span, finished_at: Date.parse(ts), status: 'interrupted' })
      await patchParams(row.id, { stage_spans: spans })
    }
    stmt("UPDATE asset_studio_run SET status='interrupted',error_msg='后端重启中断；请重新生成',completed_at=?,updated_at=? WHERE id=?").run(ts, ts, row.id)
  }
  stmt("UPDATE asset_studio_draft SET status='failed',error_msg='后端重启中断；请重新展开草稿',updated_at=? WHERE status='drafting'").run(ts)
  stmt("UPDATE asset_studio_research SET status='failed',error_msg='后端重启中断',completed_at=?,updated_at=? WHERE status='running'").run(ts, ts)
}