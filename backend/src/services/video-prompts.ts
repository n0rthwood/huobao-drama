/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 状态持久化在 sys_task(type='text', params.kind='video_prompts')，进度写 params.progress；
 * 按集跟踪，运行中不重复启动；后端重启时由启动清理标记为失败
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  patchTextTaskParams,
  promptBatchStatusFrom,
  updateTextTaskProgress,
  type PromptBatchStatus,
  type TextTaskProgress,
} from './text-task.js'
import { resolveStageModel } from './ai-stages.js'
import { loadEpisodeKeyframes } from './keyframes.js'
import { parseTransitionReview, transitionStatus } from './transition.js'
import { runTransitionReview } from './transition-agent.js'
import { buildDesignCardBriefs, loadDesignCardContext } from './design-card-context.js'
import { lockedGenSlot, toCombo } from './design-card.js'
// 锁定衔接帧（Issue #95）：C 的首帧 / D 的尾帧由图层段衔接帧锁死，画面描述要在 Agent 开跑前算好
import { ensureJunctionCaption, lockedFramePromptHint, lockedFramesOfEpisode } from './junction-caption.js'

import { isFirstAgentFailureSafe, runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-autoretry.js'
import { runObservedWork } from './task-observability.js'
import { buildSampleKey, buildWorkPlan } from './task-estimate.js'
import { narrationCharCount } from './narration.js'

export type VideoPromptBatchStatus = PromptBatchStatus

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'video_prompts', opts.retryOf)) return { started: false, total: -1 }

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
  // 段组合 A（#57）：整镜由图层段渲染，没有模型视频，
  // 既不写视频提示词也不做转场审核
  const cardCtx = loadDesignCardContext(episodeId)
  const briefs = buildDesignCardBriefs(sbs.filter(sb => !sb.deletedAt), cardCtx)
  const noVideo = new Set(sbs.filter(sb => toCombo(sb.combo) === 'A').map(sb => sb.id))
  const pendingIds = new Set([...needPrompt.map(sb => sb.id), ...needTransition]
    .filter(id => !noVideo.has(id)))
  const pending = sbs.filter(sb => pendingIds.has(sb.id) && !sb.deletedAt)
  const promptTargets = new Set(needPrompt.map(sb => sb.id).filter(id => !noVideo.has(id)))
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const [cfg] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId))
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const resolved = await resolveStageModel('video_prompts', opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'video_prompts',
    episodeId,
    dramaId,
    stageModel: resolved,
    // 落盘实际处理范围（而非调用方传入的可选列表），重试时按同一批分镜重跑
    storyboardIds: pending.map(sb => sb.id),
    progress,
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'video_prompts', args: { episodeId, dramaId, opts, storyboardIds } },
  })
  // 任务观测（Issue #104）：逐镜一个工作项（含本镜的转场审核与提示词 Agent），计划与样本分组随任务落盘
  const sampleKey = buildSampleKey({ stage: 'video_prompts', configId: resolved.configId, model: resolved.model })
  const sourceChars = new Map<number, number>(pending.map(sb => [sb.id,
    narrationCharCount(sb.description) + narrationCharCount(sb.narrationText)]))
  await patchTextTaskParams(taskId, {
    work_plan: buildWorkPlan({
      stage: 'video_prompts',
      unit: 'shot',
      sampleKey,
      items: pending.map(sb => ({ storyboard_id: sb.id, storyboard_number: sb.storyboardNumber, source_chars: sourceChars.get(sb.id) ?? 0 })),
    }),
  })

  const outputs: string[] = []
  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  void runWithTextTask(taskId, async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      textTaskId: taskId,
      storyboardPromptScope: 'video',
      modelOverride: resolved.model,
      textConfigId: resolved.configId ?? undefined,
      // 开了旁白的集：条件技能要求视频提示词里不得出现旁白台词（旁白走独立音轨）
      narrationEnabled: ep?.narrationEnabled === true,
    })
    const sink = createReasoningSink(taskId)
    // 锁定衔接帧（Issue #95）：C/D 的首/末槽位由图层段衔接帧锁死，画面只能来自那张 PNG。
    // 描述必须在这批 Agent 开跑之前算好并计入同一任务的观测窗口：read_storyboard_context
    // 与下面的提示话术才能读到同一份 caption，而不是各自猜底图。
    for (const sb of pending) {
      if (!promptTargets.has(sb.id) || !lockedGenSlot(toCombo(sb.combo))) continue
      try {
        await ensureJunctionCaption(sb.id, { taskId, storyboardNumber: sb.storyboardNumber })
      } catch (err) {
        logTaskError('VideoPrompt', 'junction-caption', { storyboardId: sb.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const lockedFrames = await lockedFramesOfEpisode(episodeId)
    for (const sb of pending) {
      requestContext.set('storyboardId', sb.id)
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: progress.completed + progress.failed + 1, total: progress.total })
      try {
        await runObservedWork({
          taskId,
          stage: 'video_prompts',
          sourceChars: sourceChars.get(sb.id) ?? 0,
          sampleKey,
          storyboardId: sb.id,
          storyboardNumber: sb.storyboardNumber,
        }, async () => {
          // 承接镜头：先审核/生成转场，视频描述再从转场结束后的画面接着写（#11）
          if (needTransition.has(sb.id)) {
            await runTransitionReview(sb.id, { model: opts.model, configId: opts.configId })
          }
          // 只补写转场的镜头：不动已有视频描述
          if (!promptTargets.has(sb.id)) return
          const [currentRow] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
          const review = parseTransitionReview(currentRow?.transitionReview)
          const hasTransition = !!(currentRow?.transitionPrompt || '').trim()
            && currentRow?.transitionEnabled !== false
            && (review?.edited_manually === true || (!!review && review.verdict !== 'none'))
          const transitionHint = hasTransition
            ? '本镜已写好开场转场段（提交视频时会自动拼在视频描述之前）：视频描述的第一段要接在转场结束后的画面上继续演，不要重复描写转场本身。'
            : ''
          const lockedLines = (lockedFrames.get(sb.id) || []).map(lockedFramePromptHint)
          const lockedHint = lockedLines.length ? `${lockedLines.join('\n')}\n` : ''
          sink.heading(`分镜 #${sb.storyboardNumber}`)
          const result = await runAgent(agent, [{
            role: 'user',
            content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围、时长及三条关键帧提示词(first_frame_prompt/mid_frame_prompt/mid_frame_time/last_frame_prompt)与 locked_frames(该镜被图层段衔接帧锁死的槽位、取景与画面描述 caption)，据此生成 video_prompt(第一行是信息头：列出该分镜出场的人物与场景，用 @角色名/@场景名 引用；之后按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；段落内允许多镜头切镜，段与段可以是不同景别/角度/对象，但不跨场景，切镜点对齐分镜 description 的【镜头N】结构)。关键帧对齐：视频的首帧就是该分镜的首关键帧画面，第一段必须从首关键帧已经呈现的画面继续演下去，不要额外重新建立空间；若有 mid_frame_time，必须让某个分段的起点正好落在该秒数并与中关键帧画面一致；最后一段收在尾关键帧的画面上。locked_frames 非空时以衔接帧为准：C 的首帧、D 的尾帧就是那张衔接帧，相应段落不许切镜（保存时会被退回）。C 的第一段必须是 0-1 秒的空镜：只复述衔接帧画面（机位/景别/画面里有什么/光线），静止或极缓推，不出现人物（不许 @ 角色）、不切镜、不做场景过渡（过渡为/叠化/dissolve 等）；人物入画与转场只能从第二段（1 秒以后）写起，否则会被退回。图像优先(绝对规则)：禁止描写角色的物种、服装、颜色、发型、体型等任何外观属性，角色一律只用 @角色名 指代，外观完全由参考图决定。
${briefs.get(sb.id)?.text || ''}${transitionHint}${lockedHint}然后调用 update_storyboard 保存到分镜 ID:${sb.id}。update_storyboard 参数只传 storyboard_id 和 video_prompt 两个键,不要回传该分镜的其他任何字段,不要重新拆分整集。`,
          }], { maxSteps: 8, requestContext }, sink)
          outputs.push(`分镜 #${sb.storyboardNumber}：${result.text || ''}`)
          // 以实际落库为准判定成败：没保存就在观测窗口内抛错，工作项记 failed
          const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
          if (!(fresh?.videoPrompt || '').trim()) throw new Error('agent finished but video_prompt is empty')
        })
        progress.completed++
      } catch (err: unknown) {
        if (!progress.completed && isFirstAgentFailureSafe(err)) throw err
        progress.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
    .then(async () => {
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'completed', { progress, outputText: outputs.filter(s => s.trim()).join('\n\n') })
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: progress.total, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : '批量生成失败'
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'failed', { errorMsg: message, progress })
      await requeueFirstModelFailure(taskId, err, isFirstAgentFailureSafe(err))
      logTaskError('VideoPrompt', 'batch', { episodeId, error: message })
    })
  return { started: true, total: pending.length }
}

export async function getVideoPromptBatchStatus(episodeId: number): Promise<VideoPromptBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'video_prompts'))
}
