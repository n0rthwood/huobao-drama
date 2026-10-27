/**
 * 关键帧批次聚合（纯函数，不碰数据库）——整批进度/剩余时间/各状态计数。
 *
 * 进度按各项的实测估计（remote_state.estimate.run_seconds）加权：
 * 完成=1、运行中=远端 progress.fraction、其余=0；跳过项不计入。
 * 整批剩余时间取所有未完成项 estimated_finish_seconds 的最大值（并发出图，用最大值而非求和）。
 */
import type { RemoteState } from './sys-task.js'
import type { KeyframeSlot } from './keyframes.js'

export type KeyframeBatchItemState =
  | 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'

export interface KeyframeBatchItem {
  storyboard_id: number
  storyboard_number: number
  slot: KeyframeSlot
  state: KeyframeBatchItemState
  task_id: number | null
  error: string | null
}

/** 对前端输出的单项：持久化字段 + 来自 sys_task.remote_state 的排队/进度 */
export interface KeyframeBatchItemView extends KeyframeBatchItem {
  queue_position: number | null
  progress: number
  remaining_seconds: number | null
  estimated_finish_seconds: number | null
}

export type KeyframeBatchCounts = Record<KeyframeBatchItemState, number>

/** 未结束状态：停止批次要取消这些项，整批剩余时间也只看它们 */
export const UNFINISHED_STATES: KeyframeBatchItemState[] = ['pending', 'queued', 'running']

/** 没有实测估计时的单张权重（与服务端默认一致） */
const DEFAULT_ITEM_SECONDS = 120

export function aggregateBatchItems(
  items: KeyframeBatchItem[],
  remoteByTask: Record<number, RemoteState>,
): { items: KeyframeBatchItemView[]; counts: KeyframeBatchCounts; eta_seconds: number | null; progress: number } {
  const counts: KeyframeBatchCounts = {
    pending: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0,
  }
  let weightTotal = 0
  let weightDone = 0
  let eta: number | null = null

  const views = items.map((item) => {
    counts[item.state] = (counts[item.state] ?? 0) + 1
    const remote = item.task_id != null ? remoteByTask[item.task_id] : undefined
    const view: KeyframeBatchItemView = {
      ...item,
      queue_position: remote?.queue?.position ?? null,
      progress: item.state === 'completed' ? 1 : item.state === 'running' ? (remote?.progress?.fraction ?? 0) : 0,
      remaining_seconds: remote?.progress?.remaining_seconds ?? null,
      estimated_finish_seconds: remote?.estimated_finish_seconds ?? null,
    }
    if (item.state !== 'skipped') {
      const weight = remote?.estimate?.run_seconds || DEFAULT_ITEM_SECONDS
      weightTotal += weight
      weightDone += weight * view.progress
    }
    if (UNFINISHED_STATES.includes(item.state) && view.estimated_finish_seconds != null) {
      eta = Math.max(eta ?? 0, view.estimated_finish_seconds)
    }
    return view
  })

  return { items: views, counts, eta_seconds: eta, progress: weightTotal ? weightDone / weightTotal : 0 }
}
