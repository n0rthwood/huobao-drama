/**
 * 文本批量的取消注册表（Issue #118 B）——进程内，按 sys_task id 索引。
 *
 * 批量提示词/设计卡任务在启动时注册 AbortController：
 * - `POST /tasks/:id/cancel` 对这三类文本任务触发 abort → 正在等待全局 agent 闸的
 *   runAgent 立即出队（不占槽、不泄漏），在飞的模型流按既有 abortSignal 语义中断；
 * - 批次循环在每镜开始前检查 signal，已取消就不再提交新镜；
 * - 任务行由 cancelTextTask 标 cancelled（既有函数），批次收尾不再覆盖终态。
 *
 * 重启后注册表为空：在飞任务按既有政策标中断，不依赖本表恢复。
 */
const controllers = new Map<number, AbortController>()

export function registerBatchCancellation(taskId: number): AbortController {
  const existing = controllers.get(taskId)
  if (existing) return existing
  const controller = new AbortController()
  controllers.set(taskId, controller)
  return controller
}

export function releaseBatchCancellation(taskId: number): void {
  controllers.delete(taskId)
}

/** 触发取消；任务不在本进程运行时返回 false（路由据此回 400） */
export function abortBatchTask(taskId: number, reason: string): boolean {
  const controller = controllers.get(taskId)
  if (!controller) return false
  controller.abort(new Error(reason))
  return true
}

export function batchCancellationSignal(taskId: number): AbortSignal | undefined {
  return controllers.get(taskId)?.signal
}
