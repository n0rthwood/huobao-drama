/**
 * 资产流水线的**步骤级时限**（Issue #56）
 *
 * 为什么不能只靠 `callTextChat` 里的 `AbortSignal.timeout(300s)`：那是**单次 fetch** 的时限，
 * 一个步骤里可能发两次请求（JSON 解析失败重问一次）、还可能夹着读库与等图，
 * 任何一段卡住都没有上层兜底——实测就出现过一条 run 的步骤十几分钟不返回、
 * 任务中心既不前进也不失败。这里给每一步一个**墙钟时限**：到点就
 * ① `abort()` 掉这一步正在飞的 HTTP 请求（signal 一路传到 fetch），
 * ② 抛 `StepTimeoutError`，由 `run.ts` 写成人话的 `error_msg` 把 sys_task 结束掉。
 * 绝不允许「挂着不动」这种第三种结局。
 */

export type PipelineStepName = 'research' | 'curate' | 'spec' | 'generate' | 'qc'

const STEP_LABEL: Record<PipelineStepName, string> = {
  research: '资料研究',
  curate: '素材筛选',
  spec: '事实表',
  generate: '出图',
  qc: 'QC 清单核验',
}

/**
 * 时限取值依据实测：GLM-5.3 在 `AI_MAX_TOKENS=131072` 下 research 124 s、spec 142 s，
 * 单步给到 10 分钟 = 实测值的 4 倍余量，且容得下「解析失败重问一次」的两次调用。
 * generate 比 `IMAGE_WAIT_TIMEOUT_MS`（20 分钟）多 5 分钟，让等图的那层先报它自己的人话。
 */
export const STEP_DEADLINE_MS: Record<PipelineStepName, number> = {
  research: 10 * 60_000,
  curate: 60_000,
  spec: 10 * 60_000,
  generate: 25 * 60_000,
  qc: 10 * 60_000,
}

export function stepTimeoutMessage(step: PipelineStepName, ms: number): string {
  const span = ms >= 60_000 ? `${Math.round((ms / 60_000) * 10) / 10} 分钟` : `${Math.round(ms / 100) / 10} 秒`
  return `「${STEP_LABEL[step]}」步超过 ${span}没有返回，已中止该步的请求；任务按失败结束，可在面板上重新发起。`
}

export class StepTimeoutError extends Error {
  readonly step: PipelineStepName
  readonly timeoutMs: number
  constructor(step: PipelineStepName, timeoutMs: number) {
    super(stepTimeoutMessage(step, timeoutMs))
    this.name = 'StepTimeoutError'
    this.step = step
    this.timeoutMs = timeoutMs
  }
}

/**
 * 把底层的中止/超时异常翻成人话。`AbortSignal.timeout()` 抛的是
 * `TimeoutError: The operation was aborted due to timeout`，直接写进任务错误里没人看得懂。
 */
export function describeStepError(step: PipelineStepName, err: unknown, timeoutMs: number): Error {
  if (err instanceof StepTimeoutError) return err
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return new StepTimeoutError(step, timeoutMs)
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * 在步骤时限内跑 `run`，并把 `signal` 交给它——调用方必须把这个 signal 一路传到 fetch，
 * 否则超时只是「不再等待」，底层请求还挂在那里占着连接。
 */
export async function withStepDeadline<T>(
  step: PipelineStepName,
  run: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? STEP_DEADLINE_MS[step]
  const controller = new AbortController()
  const running = run(controller.signal)
  // 竞速的失败方稍后才拒绝：不接住就是 unhandledRejection（会打爆整个进程）
  running.catch(() => {})
  const expiry = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    const err = new StepTimeoutError(step, timeoutMs)
    controller.abort(err)
    expiry.reject(err)
  }, timeoutMs)
  try {
    return await Promise.race([running, expiry.promise])
  } catch (err) {
    throw describeStepError(step, err, timeoutMs)
  } finally {
    clearTimeout(timer)
  }
}

/** 可被步骤时限打断的 sleep：等图轮询不能在 signal 已中止后还睡满一个间隔 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const done = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', done)
    resolve()
  }
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', done, { once: true })
  return promise
}
