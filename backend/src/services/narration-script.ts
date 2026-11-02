/**
 * 旁白写作任务（Issue #30）—— 以整集为单位跑 narration_writer Agent。
 *
 * 状态持久化在 sys_task(type='text', params.kind='narration_script')，与关键帧/视频提示词
 * 批量完全同构；后端重启由既有 failInterruptedTextTasks() 标失败，不自动重跑。
 *
 * 整集一次调用（不是逐镜循环）：旁白要有全片弧线，逐镜 Agent 看不到主线。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  promptBatchStatusFrom,
  resolveTextModel,
  updateTextTaskProgress,
  type PromptBatchStatus,
  type TextTaskProgress,
} from './text-task.js'

export type NarrationScriptStatus = PromptBatchStatus

/**
 * 启动旁白写作（立即返回）。
 * 运行中返回 started:false,total:-1；本集没有分镜返回 started:false,total:0。
 * 传入 storyboardIds 时只重写这些镜头，否则整集重写。
 */
export async function startNarrationScript(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'narration_script')) return { started: false, total: -1 }

  const sbs = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt)
  const targets = storyboardIds?.length ? sbs.filter(sb => storyboardIds.includes(sb.id)) : sbs
  if (!targets.length) return { started: false, total: 0 }

  const resolved = await resolveTextModel(opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: targets.length }
  const taskId = await createTextTask({
    kind: 'narration_script',
    episodeId,
    dramaId,
    prompt: `为本集 ${targets.length} 个分镜撰写旁白`,
    provider: resolved.provider,
    model: resolved.model,
    configId: opts.configId || resolved.configId || undefined,
    progress,
    storyboardIds: targets.map(sb => sb.id),
    retryOf: opts.retryOf,
  })

  logTaskStart('Narration', 'script-batch', { episodeId, dramaId, total: targets.length })

  ;(async () => {
    const agent = mastra.getAgent('narration_writer')
    if (!agent) throw new Error('旁白写作 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
      narrationEnabled: true,
    })
    const sink = createReasoningSink(taskId)
    const scope = storyboardIds?.length
      ? `只为分镜 ${targets.map(sb => `#${sb.storyboardNumber}`).join('、')} 重写旁白，其它镜头不要改动。`
      : `为本集全部 ${targets.length} 个分镜逐镜撰写旁白。`
    const result = await runAgent(agent, [{
      role: 'user',
      content: `请为本集撰写旁白（解说词）。${scope}
先调用 read_storyboard_context 读取剧本原文与全部分镜，通读后确定本集的叙事主线，再逐镜写旁白，保证镜与镜衔接不割裂、与本镜画面匹配、字数落在该镜 duration × 3.8 ~ duration × 5.1 且不超过 80 字、忠实剧本不新增事实。
纯画面镜头传 narration_enabled: false 且 narration 为空字符串。
分批调用 save_narrations 保存，每批最多 8 镜，直到全部镜头写完。`,
    }], { maxSteps: 30, requestContext }, sink)

    // 以实际落库为准统计
    const after = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const byId = new Map(after.map(sb => [sb.id, sb]))
    for (const sb of targets) {
      const fresh = byId.get(sb.id)
      const written = fresh?.narrationEnabled === false || (fresh?.narrationText || '').trim().length > 0
      if (written) progress.completed++
      else progress.failed++
    }
    await updateTextTaskProgress(taskId, progress)
    return result.text || ''
  })()
    .then(async (outputText) => {
      await finishTextTask(taskId, progress.failed && !progress.completed ? 'failed' : 'completed', {
        progress,
        outputText,
        errorMsg: progress.failed ? `${progress.failed} 个镜头没有写出旁白` : null,
      })
      logTaskSuccess('Narration', 'script-batch', { episodeId, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      logTaskError('Narration', 'script-batch', { episodeId, error: err instanceof Error ? err.message : String(err) })
      await finishTextTask(taskId, 'failed', {
        progress,
        errorMsg: err instanceof Error ? err.message : String(err),
      })
    })

  return { started: true, total: targets.length }
}

export async function getNarrationScriptStatus(episodeId: number): Promise<NarrationScriptStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'narration_script'))
}
