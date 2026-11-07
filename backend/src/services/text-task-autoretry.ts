/**
 * 文本任务的「模型类错误自动换模型重排」（Issue #77）。
 *
 * 单独成文件：派发器 `text-task-restart.ts` 静态 import 了全部后台服务，
 * 服务再反过来 import 派发器会形成 ESM 循环（`agentRegistry` 未初始化就访问）。
 * 这里只依赖叶子模块，并在真正派发时动态加载派发器。
 */
import { and, desc, eq, gt } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { isModelError } from './text-model-errors.js'
import { parseTextTaskParams, patchTextTaskParams, type TextTaskRestart } from './text-task.js'
import { restartArgsSchema } from './text-task-restart-schema.js'

/** Requeue only a proven pre-output model failure; never switch a pinned endpoint. */
export async function requeueFirstModelFailure(taskId: number, error: unknown, safe: boolean): Promise<boolean> {
  if (!safe || !isModelError(error)) return false
  const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
  const params = parseTextTaskParams(row?.params)
  if (!params || params.requeued === true || params.auto_retry_from || params.progress?.completed) return false
  const restart = params.restart as TextTaskRestart | undefined
  if (!restart) return false
  const parsed = restartArgsSchema.safeParse(restart.args)
  if (!parsed.success) return false
  const { opts, input, req } = parsed.data
  if (opts?.configId != null || opts?.model || input?.configId != null || req?.textConfigId != null || req?.textModel) return false
  const failedConfig = params.model_used?.config_id ?? params.configId
  if (!failedConfig) return false
  await patchTextTaskParams(taskId, { requeued: true, auto_retry: 1 })
  try {
    // 静态 import 会形成 服务 ⇄ text-task-restart 的循环，按需加载派发器
    const { dispatchTextTaskRestart } = await import('./text-task-restart.js')
    await dispatchTextTaskRestart(restart, taskId, [...(opts?.excludeConfigIds ?? []), failedConfig])
    // 子任务带 auto_retry_from：它再失败时不会再自动重排（最多两次尝试）
    const candidates = await db.select({ id: schema.sysTask.id, params: schema.sysTask.params })
      .from(schema.sysTask)
      .where(and(eq(schema.sysTask.type, 'text'), gt(schema.sysTask.id, taskId)))
      .orderBy(desc(schema.sysTask.id))
    const child = candidates.find(candidate => parseTextTaskParams(candidate.params)?.retry_of === taskId)
    if (child) await patchTextTaskParams(child.id, { auto_retry_from: taskId })
    return true
  } catch (err) {
    console.error('文本任务自动重排失败:', err instanceof Error ? err.message : String(err))
    return false
  }
}
