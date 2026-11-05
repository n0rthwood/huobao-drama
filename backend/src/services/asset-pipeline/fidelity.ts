/**
 * 版本列表上的「保真结论」（Issue #56，从已删除的 prop-beautify.ts 搬出并扩展）
 *
 * 两个来源：
 * - **存量**：#47 的一次性美化把结论写进了版本行 `params.fidelity/fidelity_reason`，
 *   那些版本行永远不会再被流水线碰到，必须原样显示（验收 8）。
 * - **流水线**：新产出的版本行对应 `asset_round.image_task_id`，结论在该轮最新一条
 *   `asset_qc_record` 上——人工裁决（`human_verdict`）优先于程序闸门（`gate_pass`）。
 */
import { inArray } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'

export type FidelityVerdict = 'verified' | 'failed'

export interface FidelityReadout {
  fidelity: FidelityVerdict | null
  reason: string | null
}

/** 版本行 params → 存量核验结论 */
export function fidelityOf(params: string | null | undefined): FidelityReadout {
  if (!params) return { fidelity: null, reason: null }
  try {
    const parsed: unknown = JSON.parse(params)
    if (!parsed || typeof parsed !== 'object') return { fidelity: null, reason: null }
    const record = parsed as Record<string, unknown>
    const fidelity = record.fidelity === 'verified' || record.fidelity === 'failed' ? record.fidelity : null
    return { fidelity, reason: typeof record.fidelity_reason === 'string' ? record.fidelity_reason : null }
  } catch {
    return { fidelity: null, reason: null }
  }
}

/**
 * 批量取流水线轮次的结论：生图 sys_task id → 结论。
 * 版本装配是同步 map，所以这里一次性把整批查出来，不在循环里打库。
 */
export async function loadPipelineFidelity(imageTaskIds: number[]): Promise<Map<number, FidelityReadout>> {
  const result = new Map<number, FidelityReadout>()
  const ids = [...new Set(imageTaskIds.filter(id => Number.isFinite(id) && id > 0))]
  if (!ids.length) return result

  const rounds = (await db.select().from(schema.assetRound)
    .where(inArray(schema.assetRound.imageTaskId, ids)))
    .filter(round => round.imageTaskId != null)
  if (!rounds.length) return result

  const records = await db.select().from(schema.assetQcRecord)
    .where(inArray(schema.assetQcRecord.roundId, rounds.map(round => round.id)))
  // 同一轮可追加多条 QC（便宜步允许重算）：以最新一条为准（主进程裁决「疑问 2」）
  const latestByRound = new Map<number, typeof records[number]>()
  for (const record of records) {
    const prev = latestByRound.get(record.roundId)
    if (!prev || record.id > prev.id) latestByRound.set(record.roundId, record)
  }

  for (const round of rounds) {
    const record = latestByRound.get(round.id)
    if (!record) {
      result.set(round.imageTaskId!, { fidelity: null, reason: `流水线第 ${round.roundNo} 轮，尚未核验` })
      continue
    }
    const human = record.humanVerdict
    if (human === 'approve') {
      result.set(round.imageTaskId!, {
        fidelity: 'verified',
        reason: `人工通过（第 ${round.roundNo} 轮，闸门${record.gatePass ? '通过' : '未通过'}）${record.humanNotes ? `：${record.humanNotes}` : ''}`,
      })
      continue
    }
    if (human === 'revise' || human === 'rollback' || human === 'abort') {
      result.set(round.imageTaskId!, {
        fidelity: 'failed',
        reason: `人工判为不可用（第 ${round.roundNo} 轮，动作 ${human}）${record.humanNotes ? `：${record.humanNotes}` : ''}`,
      })
      continue
    }
    result.set(round.imageTaskId!, {
      fidelity: record.gatePass ? 'verified' : 'failed',
      reason: `程序闸门${record.gatePass ? '通过' : '未通过'}（第 ${round.roundNo} 轮，清单覆盖率 ${Math.round((record.checklistCoverage ?? 0) * 100)}%），等待人工审批`,
    })
  }
  return result
}
