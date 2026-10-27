/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 状态持久化在 sys_task(type='text', params.kind='video_prompts')，进度写 params.progress；
 * 按集跟踪，运行中不重复启动；后端重启时由启动清理标记为失败
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
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
import { loadEpisodeKeyframes } from './keyframes.js'
import { parseTransitionReview, transitionStatus } from './transition.js'
import { runTransitionReview } from './transition-agent.js'

export type VideoPromptBatchStatus = PromptBatchStatus

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'video_prompts')) return { started: false, total: -1 }

  const sbs = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  // 需要写视频描述的镜头（指定列表即使已有描述也重写）
  const needPrompt = storyboardIds?.length
    ? sbs.filter(sb => storyboardIds.includes(sb.id))
    : sbs.filter(sb => !(sb.videoPrompt || '').trim())
  // 承接镜头缺转场时也纳入：已有视频描述的只补写转场，不动描述原文（#11）
  const keyframes = await loadEpisodeKeyframes(episodeId)
  const needTransition = new Set<number>()
  for (const sb of sbs) {
    if (sb.deletedAt) continue
    const status = await transitionStatus(sb, keyframes.get(sb.id)?.inheritsFirst === true)
    if (status.needsReview) needTransition.add(sb.id)
  }
  const pendingIds = new Set([...needPrompt.map(sb => sb.id), ...needTransition])
  const pending = sbs.filter(sb => pendingIds.has(sb.id) && !sb.deletedAt)
  const promptTargets = new Set(needPrompt.map(sb => sb.id))
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const resolved = await resolveTextModel(opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'video_prompts',
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

  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    for (const sb of pending) {
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: progress.completed + progress.failed + 1, total: progress.total })
      try {
        // 承接镜头：先审核/生成转场，视频描述再从转场结束后的画面接着写（#11）
        if (needTransition.has(sb.id)) {
          await runTransitionReview(sb.id, { model: opts.model, configId: opts.configId })
        }
        if (!promptTargets.has(sb.id)) {
          // 只补写转场的镜头：不动已有视频描述
          progress.completed++
          continue
        }
        const [currentRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const review = parseTransitionReview(currentRow?.transitionReview)
        const hasTransition = !!(currentRow?.transitionPrompt || '').trim()
          && currentRow?.transitionEnabled !== false
          && (review?.edited_manually === true || (!!review && review.verdict !== 'none'))
        const transitionHint = hasTransition
          ? '本镜已写好开场转场段（提交视频时会自动拼在视频描述之前）：视频描述的第一段要接在转场结束后的画面上继续演，不要重复描写转场本身。'
          : ''
        await agent.generate([{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围、时长及三条关键帧提示词(first_frame_prompt/mid_frame_prompt/mid_frame_time/last_frame_prompt)，据此生成 video_prompt(第一行是信息头：列出该分镜出场的人物与场景，用 @角色名/@场景名 引用；之后按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；段落内允许多镜头切镜，段与段可以是不同景别/角度/对象，但不跨场景，切镜点对齐分镜 description 的【镜头N】结构)。关键帧对齐：视频的首帧就是该分镜的首关键帧画面，第一段必须从首关键帧已经呈现的画面继续演下去，不要额外重新建立空间；若有 mid_frame_time，必须让某个分段的起点正好落在该秒数并与中关键帧画面一致；最后一段收在尾关键帧的画面上。图像优先(绝对规则)：禁止描写角色的物种、服装、颜色、发型、体型等任何外观属性，角色一律只用 @角色名 指代，外观完全由参考图决定。${transitionHint}然后调用 update_storyboard 保存到分镜 ID:${sb.id}。update_storyboard 参数只传 storyboard_id 和 video_prompt 两个键,不要回传该分镜的其他任何字段,不要重新拆分整集。`,
        }], { maxSteps: 8, requestContext })
        // 以实际落库为准判定成败
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        if ((fresh?.videoPrompt || '').trim()) progress.completed++
        else {
          progress.failed++
          logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: 'agent finished but video_prompt is empty' })
        }
      } catch (err: unknown) {
        progress.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })()
    .then(async () => {
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'completed', { progress })
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: progress.total, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : '批量生成失败'
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'failed', { errorMsg: message, progress })
      logTaskError('VideoPrompt', 'batch', { episodeId, error: message })
    })
  return { started: true, total: pending.length }
}

export async function getVideoPromptBatchStatus(episodeId: number): Promise<VideoPromptBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'video_prompts'))
}
