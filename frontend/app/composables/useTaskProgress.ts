/**
 * 图片/视频生成任务的进度展示辅助。
 *
 * 任务状态（sys_task.status）：queued | processing | completed | failed | cancelled
 * - queued：远端任务服务排队中（qwen-jobs 队列），同样算「活跃」
 * - cancelled：终态，和 completed/failed 一样不再轮询
 *
 * 进度数据来自后端透传的 remote_state（qwen-jobs 任务对象快照），秒数相对
 * remote_state.updated_at，所以两次轮询之间前端可以本地倒数。
 */
import { ref, onScopeDispose, getCurrentScope } from 'vue'

export type RingStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | ''

export interface RemoteState {
  remote_status?: string
  queue?: { position?: number; length?: number; estimated_start_seconds?: number } | null
  progress?: { fraction?: number; elapsed_seconds?: number; remaining_seconds?: number; phase?: string; step?: number; total_steps?: number } | null
  estimate?: { run_seconds?: number; basis?: string; samples?: number } | null
  estimated_finish_seconds?: number | null
  cancel_requested?: boolean
  updated_at?: string
}

/** 后端任务 JSON（/tasks、/tasks/active、/tasks/center 等；驼峰为 /tasks 的原始行） */
export interface TaskLike {
  id?: number
  type?: string
  status?: string
  provider?: string
  remote_state?: RemoteState | null
  remoteState?: RemoteState | null
  error_msg?: string | null
  errorMsg?: string | null
  cancellable?: boolean
  character_id?: number | null
  scene_id?: number | null
  prop_id?: number | null
  storyboard_id?: number | null
  created_at?: string
  updated_at?: string
}

/** 关键帧批次 item（后端已把 remote_state 摊平成这些字段） */
export interface BatchItemLike {
  state?: string
  queue_position?: number | null
  progress?: number | null
  remaining_seconds?: number | null
  estimated_finish_seconds?: number | null
  error?: string | null
}

export interface RingProps {
  status: RingStatus
  fraction: number | null
  remainingSeconds: number | null
  queuePosition: number | null
  queueLength: number | null
  startSeconds: number | null
  etaSeconds: number | null
  error: string
  cancelRequested: boolean
}

export function isActiveTaskStatus(status?: string | null): boolean {
  return status === 'queued' || status === 'processing'
}
export function isTerminalTaskStatus(status?: string | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
/** 批次 item 的 state 同样把 queued 视作活跃、cancelled 视作终态 */
export function isActiveBatchItemState(state?: string | null): boolean {
  return state === 'pending' || state === 'queued' || state === 'running'
}
export function taskRemoteState(task: TaskLike | null | undefined): RemoteState | null {
  return task?.remote_state ?? task?.remoteState ?? null
}

// ===== 共享 1s 心跳：所有进度环共用一个计时器，组件销毁后自动停表 =====
const nowMs = ref(Date.now())
let tickers = 0
let tickTimer: number | null = null
export function useNowTicker() {
  tickers += 1
  if (!tickTimer) {
    nowMs.value = Date.now()
    // 浏览器环境返回 number；Nuxt 带入的 Node 类型声明会推成 Timeout
    tickTimer = setInterval(() => { nowMs.value = Date.now() }, 1000) as unknown as number
  }
  if (getCurrentScope()) {
    onScopeDispose(() => {
      tickers -= 1
      if (tickers <= 0 && tickTimer) { clearInterval(tickTimer); tickTimer = null; tickers = 0 }
    })
  }
  return nowMs
}

// 服务端与浏览器时钟可能有偏差：本地倒数最多补 120s，避免把进度直接推满
const MAX_DRIFT = 120
function driftSeconds(remote: RemoteState | null, now: number): number {
  const updated = remote?.updated_at ? Date.parse(remote.updated_at) : Number.NaN
  if (!Number.isFinite(updated)) return 0
  return Math.min(MAX_DRIFT, Math.max(0, (now - updated) / 1000))
}
function countdown(value: number | null | undefined, drift: number): number | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, n - drift)
}

const EMPTY_RING: RingProps = {
  status: '', fraction: null, remainingSeconds: null, queuePosition: null,
  queueLength: null, startSeconds: null, etaSeconds: null, error: '', cancelRequested: false,
}

/** sys_task（含 remote_state）→ 进度环属性 */
export function ringPropsFromTask(task: TaskLike | null | undefined, now: number = Date.now()): RingProps {
  if (!task) return { ...EMPTY_RING }
  const remote = taskRemoteState(task)
  const drift = driftSeconds(remote, now)
  const status: RingStatus =
    task.status === 'queued' ? 'queued'
      : task.status === 'completed' ? 'completed'
        : task.status === 'failed' ? 'failed'
          : task.status === 'cancelled' ? 'cancelled' : 'running'

  const progress = remote?.progress || null
  const queue = remote?.queue || null
  let fraction: number | null = null
  if (status === 'running' && progress) {
    const elapsed = Number(progress.elapsed_seconds)
    const remaining = countdown(progress.remaining_seconds, drift)
    if (Number.isFinite(elapsed) && remaining !== null && elapsed + drift + remaining > 0) {
      fraction = (elapsed + drift) / (elapsed + drift + remaining)
    } else if (Number.isFinite(Number(progress.fraction))) {
      fraction = Number(progress.fraction)
    }
    if (fraction !== null) fraction = Math.min(0.99, Math.max(0, fraction))
  }

  return {
    status,
    fraction,
    remainingSeconds: status === 'running' ? countdown(progress?.remaining_seconds, drift) : null,
    queuePosition: status === 'queued' ? (Number(queue?.position) || null) : null,
    queueLength: status === 'queued' ? (Number(queue?.length) || null) : null,
    startSeconds: status === 'queued' ? countdown(queue?.estimated_start_seconds, drift) : null,
    etaSeconds: countdown(remote?.estimated_finish_seconds, drift),
    error: String(task.error_msg || task.errorMsg || ''),
    cancelRequested: Boolean(remote?.cancel_requested),
  }
}

/** 关键帧批次 item → 进度环属性 */
export function ringPropsFromBatchItem(item: BatchItemLike | null | undefined): RingProps {
  if (!item) return { ...EMPTY_RING }
  const status: RingStatus =
    item.state === 'queued' || item.state === 'pending' ? 'queued'
      : item.state === 'running' ? 'running'
        : item.state === 'completed' ? 'completed'
          : item.state === 'failed' ? 'failed'
            : item.state === 'cancelled' ? 'cancelled' : ''
  const fraction = Number(item.progress)
  const remaining = Number(item.remaining_seconds)
  const eta = Number(item.estimated_finish_seconds)
  return {
    status,
    fraction: status === 'running' && Number.isFinite(fraction) ? Math.min(0.99, Math.max(0, fraction)) : null,
    remainingSeconds: status === 'running' && Number.isFinite(remaining) ? Math.max(0, remaining) : null,
    queuePosition: status === 'queued' ? (Number(item.queue_position) || null) : null,
    queueLength: null,
    startSeconds: null,
    etaSeconds: Number.isFinite(eta) ? Math.max(0, eta) : null,
    error: String(item.error || ''),
    cancelRequested: false,
  }
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/** 秒 → 人类可读时长（秒 / 分 / 小时），t 由调用方传入以跟随界面语言 */
export function formatSeconds(t: Translate, seconds: number | null | undefined): string {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total < 0) return ''
  const rounded = Math.round(total)
  if (rounded < 60) return t('common.duration.sec', { n: Math.max(1, rounded) })
  if (rounded < 3600) {
    const m = Math.floor(rounded / 60)
    const s = rounded % 60
    return s ? t('common.duration.minSec', { m, s }) : t('common.duration.min', { m })
  }
  const h = Math.floor(rounded / 3600)
  const m = Math.round((rounded % 3600) / 60)
  return m ? t('common.duration.hourMin', { h, m }) : t('common.duration.hour', { h })
}

/**
 * 一组活跃任务的汇总：加权进度（按各自预计耗时加权，完成=1、运行中=fraction、排队=0）
 * 与整体预计剩余（各任务 estimated_finish_seconds 的最大值）。
 */
export interface TaskSummary {
  total: number
  queued: number
  running: number
  progress: number
  etaSeconds: number | null
}

export function summarizeTasks(tasks: TaskLike[], now: number = Date.now()): TaskSummary {
  let queued = 0
  let running = 0
  let weight = 0
  let done = 0
  let eta: number | null = null
  for (const task of tasks) {
    const ring = ringPropsFromTask(task, now)
    const runSeconds = Number(taskRemoteState(task)?.estimate?.run_seconds)
    const w = runSeconds > 0 ? runSeconds : 120
    weight += w
    if (ring.status === 'queued') queued += 1
    else if (ring.status === 'running') { running += 1; done += w * (ring.fraction ?? 0) }
    if (ring.etaSeconds !== null) eta = eta === null ? ring.etaSeconds : Math.max(eta, ring.etaSeconds)
  }
  return { total: tasks.length, queued, running, progress: weight > 0 ? done / weight : 0, etaSeconds: eta }
}
