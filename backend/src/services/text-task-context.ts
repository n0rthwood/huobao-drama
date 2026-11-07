import { AsyncLocalStorage } from 'node:async_hooks'

interface TaskContext { taskId: number | null; agentRuns: number; agentFetches: number; firstAgentFailureSafe: boolean }
const context = new AsyncLocalStorage<TaskContext>()
const agentCall = new AsyncLocalStorage<boolean>()
const safeAgentFailures = new WeakSet<object>()

export function runWithTextTask<T>(taskId: number | null, fn: () => Promise<T>): Promise<T> {
  const parent = context.getStore()
  return context.run(parent && parent.taskId === taskId ? parent : { taskId, agentRuns: 0, agentFetches: 0, firstAgentFailureSafe: false }, fn)
}

export function currentTextTaskId(): number | null {
  return context.getStore()?.taskId ?? null
}

/** Prevent nested Agent tools from rewriting the Agent's fixed model attribution. */
export function runWithAgentTextCall<T>(fn: () => Promise<T>): Promise<T> {
  const state = context.getStore()
  if (state) { state.agentRuns++; state.firstAgentFailureSafe = false }
  return agentCall.run(true, fn)
}

export function isAgentTextCall(): boolean {
  return agentCall.getStore() === true
}

/** A later model request means this is no longer a first-request failure. */
export function noteAgentFetchStarted(): boolean {
  const state = context.getStore()
  if (!state) return false
  state.agentFetches++
  state.firstAgentFailureSafe = false
  return state.agentRuns === 1 && state.agentFetches === 1
}

export function noteFirstAgentFetchFailed(): void {
  const state = context.getStore()
  if (state?.agentRuns === 1 && state.agentFetches === 1) state.firstAgentFailureSafe = true
}

export function markAgentFailureIfSafe(err: unknown): void {
  if (context.getStore()?.firstAgentFailureSafe && err != null && typeof err === 'object') safeAgentFailures.add(err)
}

export function isFirstAgentFailureSafe(err: unknown): boolean {
  const seen = new Set<object>()
  while (err != null && typeof err === 'object' && !seen.has(err)) {
    if (safeAgentFailures.has(err)) return true
    seen.add(err)
    err = 'cause' in err ? err.cause : undefined
  }
  return false
}
