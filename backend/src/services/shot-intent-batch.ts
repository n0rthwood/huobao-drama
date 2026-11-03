/**
 * 表达设计重算（Issue #49）— 为纪录片分镜逐镜跑 `storyboard_breaker`，只写 `intent`。
 *
 * 与关键帧/视频提示词批量同形：落 `sys_task(type='text', params.kind='shot_intent')`，
 * 进度写 `params.progress`，前端轮询。
 * 本任务用 `storyboardPromptScope='intent'` 收窄工具集：模型只能看上下文、读图、写 intent，
 * **不能**调用 `save_storyboards` 重拆整集（重算一镜把整集旁白冲掉是最贵的事故）。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { loadIntentContext, resolveStoryboardIntent } from './shot-intent-context.js'
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

export type ShotIntentBatchStatus = PromptBatchStatus

/** 指定 storyboardIds 时只重算这几镜（即使已有 intent）；否则补齐所有还没有 intent 的镜头 */
export async function startShotIntentBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'shot_intent')) return { started: false, total: -1 }

  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const alive = rows.filter(sb => !sb.deletedAt)
  const pending = storyboardIds?.length
    ? alive.filter(sb => storyboardIds.includes(sb.id))
    : alive.filter(sb => !(sb.intent || '').trim())
  if (!pending.length) return { started: false, total: 0 }

  const resolved = await resolveTextModel(opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'shot_intent',
    episodeId,
    dramaId,
    provider: resolved.provider,
    model: resolved.model,
    configId: opts.configId ?? resolved.configId ?? undefined,
    storyboardIds: pending.map(sb => sb.id),
    progress,
    retryOf: opts.retryOf,
  })

  const outputs: string[] = []
  logTaskStart('ShotIntent', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('storyboard_breaker')
    if (!agent) throw new Error('分镜 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      textTaskId: taskId,
      storyboardPromptScope: 'intent',
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    const sink = createReasoningSink(taskId)
    for (const sb of pending) {
      requestContext.set('storyboardId', sb.id)
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      logTaskProgress('ShotIntent', 'batch-shot', {
        episodeId, storyboardId: sb.id,
        index: progress.completed + progress.failed + 1, total: progress.total,
      })
      sink.heading(`分镜 #${sb.storyboardNumber}`)
      try {
        const result = await runAgent(agent, [{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id}) 做表达设计（intent），严格遵循 documentary-storyboard 技能里「表达设计」一节。
先调用 read_storyboard_context：读本镜的 narration_text（旁白原文）、description、duration，读前后镜的 intent（同一段落要共用底图与图层状态，不要各写各的），读 props 里每张证据素材的 semantics（只有名称与 id，没有坐标）与 exposition_assets。
然后按这个顺序想：这一镜要让观众理解的**唯一**信息点是什么 → 用哪种 device → 为了让这个信息点成立，画面上**必须看到**哪些具体东西（旁白里出现的每一个地名/路线/范围都要在某张图的 semantics 里找到对应项并写进 must_show；人物首次出现用 card + 肖像；旁白提到但不出场的组织/人物/事件引用 exposition 资产）→ 这些东西用哪些图层画出来、按什么顺序显现（overlay_plan）。
必要时用 read_image 打开证据素材核对：旁白说的东西图上到底有没有。图上没有就在 rationale 里写明并降级，不要凭空写一个不存在的要素。
最后调用 update_storyboard 保存，参数只传 storyboard_id 和 intent 两个键。`,
        }], { maxSteps: 10, requestContext }, sink)
        outputs.push(`分镜 #${sb.storyboardNumber}：${result.text || ''}`)
        // 以实际落库为准判定成败
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        if ((fresh?.intent || '').trim()) progress.completed++
        else {
          progress.failed++
          logTaskError('ShotIntent', 'batch-shot', { storyboardId: sb.id, error: 'agent finished but intent is empty' })
        }
      } catch (err: unknown) {
        progress.failed++
        logTaskError('ShotIntent', 'batch-shot', { storyboardId: sb.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })()
    .then(async () => {
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'completed', { progress, outputText: outputs.filter(s => s.trim()).join('\n\n') })
      logTaskSuccess('ShotIntent', 'batch', { episodeId, total: progress.total, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : '表达设计重算失败'
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'failed', { errorMsg: message, progress })
      logTaskError('ShotIntent', 'batch', { episodeId, error: message })
    })
  return { started: true, total: pending.length }
}

export async function getShotIntentBatchStatus(episodeId: number): Promise<ShotIntentBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'shot_intent'))
}

/** 整集表达设计的结构机检（验收 1）：逐镜给出 intent 与问题 */
export async function auditEpisodeIntents(episodeId: number): Promise<Array<{
  storyboard_id: number
  shot_number: number
  narration_text: string
  has_intent: boolean
  device: string | null
  deterministic: string | null
  overlay_layers: number
  must_show: number
  unresolved: number
  reviewed: boolean
  issues: { code: string; severity: string; message: string }[]
}>> {
  const ctx = loadIntentContext(episodeId)
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  return rows.filter(sb => !sb.deletedAt).map((sb) => {
    const { intent, issues } = resolveStoryboardIntent(sb.intent, ctx)
    const unresolved = intent
      ? intent.must_show.filter(item => item.unresolved).length + intent.overlay_plan.filter(item => item.unresolved).length
      : 0
    return {
      storyboard_id: sb.id,
      shot_number: sb.storyboardNumber,
      narration_text: sb.narrationText || '',
      has_intent: !!intent,
      device: intent?.device ?? null,
      deterministic: intent?.deterministic ?? null,
      overlay_layers: intent?.overlay_plan.length ?? 0,
      must_show: intent?.must_show.length ?? 0,
      unresolved,
      reviewed: sb.intentReviewed === true,
      issues: issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message })),
    }
  })
}
