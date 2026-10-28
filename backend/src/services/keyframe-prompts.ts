/**
 * 批量关键帧提示词任务 — 异步为缺少关键帧提示词的分镜逐个运行 prompt_generator Agent
 * 状态持久化在 sys_task(type='text', params.kind='keyframe_prompts')，进度写 params.progress；
 * 按集跟踪，运行中不重复启动；后端重启时由启动清理标记为失败
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { loadEpisodeKeyframes } from './keyframes.js'
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

export type KeyframePromptBatchStatus = PromptBatchStatus

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），
 *  否则处理缺少尾关键帧提示词、或缺少首关键帧提示词且不承接上一镜的分镜 */
export async function startKeyframePromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'keyframe_prompts')) return { started: false, total: -1 }

  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const sbs = rows.filter(sb => !sb.deletedAt)
  const keyframeMap = await loadEpisodeKeyframes(episodeId)
  const pending = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    // 承接首帧的分镜不需要自己的 first_frame_prompt（首帧沿用上一镜尾关键帧）
    : sbs.filter(sb => !(sb.lastFramePrompt || '').trim()
      || (!(sb.firstFramePrompt || '').trim() && keyframeMap.get(sb.id)?.inheritsFirst !== true))
  if (!pending.length) return { started: false, total: 0 }

  const resolved = await resolveTextModel(opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'keyframe_prompts',
    episodeId,
    dramaId,
    provider: resolved.provider,
    model: resolved.model,
    configId: opts.configId ?? resolved.configId ?? undefined,
    // 落盘实际处理范围（而非调用方传入的可选列表），重试时按同一批分镜重跑
    storyboardIds: pending.map(sb => sb.id),
    progress,
    retryOf: opts.retryOf,
  })

  const outputs: string[] = []
  logTaskStart('KeyframePrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('提示词 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    const sink = createReasoningSink(taskId)
    for (const sb of pending) {
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      logTaskProgress('KeyframePrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: progress.completed + progress.failed + 1, total: progress.total })
      sink.heading(`分镜 #${sb.storyboardNumber}`)
      try {
        const result = await runAgent(agent, [{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成关键帧提示词(first_frame_prompt、mid_frame_prompt、mid_frame_time、last_frame_prompt)，严格遵循 keyframe-prompt 技能规范。
请先调用 read_storyboard_context 读取该分镜的 description(含【镜头N】子镜头)、result、atmosphere、duration、continuity_boundary 及 inherits_first，然后写出关键帧提示词：
- 每张关键帧都是独立生成的单帧静态画面，只凭资产参考图 + 本条提示词出图，所以每条提示词必须自足（自己交代景别机位构图、@场景名、画面里有哪些 @角色名 及其位置姿态表情、关键 @道具名、光线氛围），禁止写「同上一帧」「保持不变」这类相对描述
- 绝对图像优先：禁止描写角色的物种、服装、颜色、发型、体型等任何外观属性，角色一律只用 @角色名 指代（名字只是代号，不要据此推断长相）
- first_frame_prompt = 【镜头1】开场瞬间；若该分镜 inherits_first 为 true（continuity 为 'continue'），first_frame_prompt 必须留空（首帧沿用上一镜的尾关键帧）
- mid_frame_prompt + mid_frame_time = 除第一个子镜头外最重要的那个子镜头的起始瞬间，mid_frame_time 以秒为单位、必须落在 0.5 秒与 duration-0.5 秒之间；该分镜只有一个子镜头时两者都不要写
- last_frame_prompt = 段落结尾瞬间，与 result 一致，必须是稳定清晰、可被下一镜当作开场的画面
最后调用 update_storyboard 保存到分镜 ID:${sb.id}。update_storyboard 参数只传 storyboard_id 以及上述关键帧字段,不要回传该分镜的其他任何字段(title、description、video_prompt、scene_id 等一律不传),不要重新拆分整集。`,
        }], { maxSteps: 8, requestContext }, sink)
        outputs.push(`分镜 #${sb.storyboardNumber}：${result.text || ''}`)
        // 以实际落库为准判定成败：尾关键帧提示词是必选项
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        if ((fresh?.lastFramePrompt || '').trim()) progress.completed++
        else {
          progress.failed++
          logTaskError('KeyframePrompt', 'batch-shot', { storyboardId: sb.id, error: 'agent finished but last_frame_prompt is empty' })
        }
      } catch (err: unknown) {
        progress.failed++
        logTaskError('KeyframePrompt', 'batch-shot', { storyboardId: sb.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })()
    .then(async () => {
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'completed', { progress, outputText: outputs.filter(s => s.trim()).join('\n\n') })
      logTaskSuccess('KeyframePrompt', 'batch', { episodeId, total: progress.total, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : '批量生成失败'
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'failed', { errorMsg: message, progress })
      logTaskError('KeyframePrompt', 'batch', { episodeId, error: message })
    })
  return { started: true, total: pending.length }
}

export async function getKeyframePromptBatchStatus(episodeId: number): Promise<KeyframePromptBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'keyframe_prompts'))
}
