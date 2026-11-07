import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage<number | null>()

export function runWithTextTask<T>(taskId: number | null, fn: () => Promise<T>): Promise<T> {
  return context.run(taskId, fn)
}

export function currentTextTaskId(): number | null {
  return context.getStore() ?? null
}
