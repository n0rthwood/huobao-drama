/**
 * 全局 agent 并发闸（Issue #118 B）——进程内信号量，跨批量给 runAgent 总量封顶。
 *
 * 背景：per-config TextSlotQueue 只限单端点并发；多个批量叠加时进程内同时活跃的
 * agent 运行数没有上限，单镜 CPU（上下文装配 / JSON / 同步 SQLite / 观测落盘）把
 * HTTP 事件循环打满。本闸在 runAgent 入口生效，先全局闸、再端点槽。
 *
 * 口径：
 * - 上限默认 2，env HUOBAO_AGENT_GLOBAL_CONCURRENCY 可配（>=1 的整数）。
 * - 交互优先 = **下一个空槽**优先给 interactive 等待者，不抢占正在运行的任务。
 * - 排队可取消：AbortSignal 触发即移出队列并 reject，不占槽、不泄漏。
 * - 全局等待单独观测（task_observed_work.agent_gate_ms），不混入端点 queue_ms。
 * - 进程内生效：D（worker 隔离）实施前不承诺跨进程总量；跨进程共享计数是 D 的前置条件。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface AgentGateWaiter {
  interactive: boolean
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  abort?: () => void
}

export class AgentGate {
  active = 0
  readonly queue: AgentGateWaiter[] = []
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`agent 并发上限必须是 >=1 的整数，收到 ${limit}`)
  }

  /** 观测快照：活跃数 / 排队数 / 上限（日志与验收用） */
  stats(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit }
  }

  async run<T>(args: { interactive?: boolean; signal?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
    if (args.signal?.aborted) throw args.signal.reason
    if (this.active >= this.limit || this.queue.length) {
      await new Promise<void>((resolve, reject) => {
        const waiter: AgentGateWaiter = { interactive: !!args.interactive, resolve, reject, signal: args.signal }
        waiter.abort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) { this.queue.splice(index, 1); reject(args.signal?.reason) }
        }
        args.signal?.addEventListener('abort', waiter.abort, { once: true })
        this.queue.push(waiter)
        this.pump()
      })
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      this.active--
      this.pump()
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length) {
      // 交互优先只作用于下一个空槽（非抢占）；同类等待者按 FIFO
      const interactive = this.queue.findIndex(waiter => waiter.interactive)
      const [waiter] = this.queue.splice(interactive < 0 ? 0 : interactive, 1)
      waiter!.signal?.removeEventListener('abort', waiter!.abort!)
      this.active++
      waiter!.resolve()
    }
  }
}

const envLimit = Number(process.env.HUOBAO_AGENT_GLOBAL_CONCURRENCY ?? '')
export const agentGate = new AgentGate(Number.isInteger(envLimit) && envLimit >= 1 ? envLimit : 2)

/** 本次 runAgent 是否交互请求（chat / 单镜重试）；批量运行不设，默认非交互 */
const interactiveALS = new AsyncLocalStorage<boolean>()

export function runAsInteractiveAgent<T>(fn: () => Promise<T>): Promise<T> {
  return interactiveALS.run(true, fn)
}

export function isInteractiveAgentRun(): boolean {
  return interactiveALS.getStore() === true
}
