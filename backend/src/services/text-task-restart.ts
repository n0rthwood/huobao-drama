import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseTextTaskParams, type TextTaskRestart } from './text-task.js'
import { startExtraction, startSingleAssetExtraction } from './extraction.js'
import { startKeyframePromptBatch } from './keyframe-prompts.js'
import { startVideoPromptBatch } from './video-prompts.js'
import { startDesignCardBatch } from './design-card-batch.js'
import { startNarrationScript } from './narration-script.js'
import { startAssetReview } from './asset-review.js'
import { startPosterConcept } from './poster-concept.js'
import { startFillGapsTask } from './storyboard-fill-gaps.js'
import { startSkeletonGeneration } from './narration-skeleton.js'
import { startRewriteRun } from './script-rewrite/run.js'
import { startPortraitAppearance } from './portrait-appearance.js'
import { startSemanticsAuto } from './asset-semantics-auto.js'
import { startAssetBatch } from './asset-batch.js'
import { retryTask } from './task-retry.js'
import { isModelError } from './text-scheduler.js'
import { patchTextTaskParams } from './text-task.js'

const optionsSchema = z.object({
  model: z.string().optional(), configId: z.number().optional(), retryOf: z.number().optional(),
  excludeConfigIds: z.array(z.number()).optional(),
  singleAssetName: z.string().optional(), assetReviewItemId: z.number().optional(), episodeId: z.number().optional(),
  startStage: z.enum(['fidelity', 'bridge']).optional(), predecessorVersionId: z.number().optional(),
  skipStages: z.array(z.string()).optional(), autoAdopt: z.boolean().optional(),
  sourceRevision: z.number().optional(), finalRevision: z.number().optional(), acknowledgeSourceChange: z.boolean().optional(),
})
const argsSchema = z.object({
  episodeId: z.number().optional(), dramaId: z.number().optional(), characterId: z.number().optional(),
  sourceTaskId: z.number().optional(), target: z.enum(['characters', 'scenes', 'props']).optional(),
  storyboardIds: z.array(z.number()).optional(), opts: optionsSchema.optional(),
  input: z.object({ propId: z.number(), episodeId: z.number(), dramaId: z.number(), propName: z.string(),
    absPath: z.string(), sourceTaskId: z.number().nullable(), configId: z.number().optional(), excludeConfigIds: z.array(z.number()).optional() }).optional(),
  req: z.object({ scope: z.enum(['characters', 'scenes', 'props', 'all']), episodeId: z.number(),
    rewritePrompts: z.boolean(), overwriteImages: z.boolean(), textModel: z.string().optional(),
    textConfigId: z.number().optional(), imageModel: z.string().optional(), imageConfigId: z.number().optional() }).optional(),
})

/** Dispatch persisted inputs through the same validation and entry points as a new task. */
export async function dispatchTextTaskRestart(restart: TextTaskRestart, retryOf: number, excluded?: number[]): Promise<void> {
  const a = argsSchema.parse(restart.args)
  const opts = { ...a.opts, retryOf, ...(excluded ? { excludeConfigIds: excluded } : {}) }
  if (a.sourceTaskId !== undefined) {
    await retryTask(retryOf, opts)
    return
  }
  const episodeId = () => z.number().parse(a.episodeId)
  const dramaId = () => z.number().parse(a.dramaId)
  let result: unknown
  switch (restart.kind) {
    case 'extract_characters':
    case 'extract_scenes':
    case 'extract_props':
      result = a.opts?.singleAssetName
        ? await startSingleAssetExtraction(episodeId(), dramaId(), z.enum(['characters', 'scenes', 'props']).parse(a.target), a.opts.singleAssetName, opts)
        : await startExtraction(episodeId(), dramaId(), z.enum(['characters', 'scenes', 'props']).parse(a.target), opts)
      if (result === null) throw new Error('任务恢复未启动')
      break
    case 'keyframe_prompts': result = await startKeyframePromptBatch(episodeId(), dramaId(), opts, a.storyboardIds); break
    case 'video_prompts': result = await startVideoPromptBatch(episodeId(), dramaId(), opts, a.storyboardIds); break
    case 'design_card': result = await startDesignCardBatch(episodeId(), dramaId(), opts, a.storyboardIds); break
    case 'narration_script': result = await startNarrationScript(episodeId(), dramaId(), opts, a.storyboardIds); break
    case 'asset_review': result = await startAssetReview(episodeId(), opts); break
    case 'poster_concept': result = await startPosterConcept(episodeId(), opts); break
    case 'storyboard_fill_gaps': result = await startFillGapsTask(episodeId(), opts); break
    case 'storyboard_breaker': result = await startSkeletonGeneration(episodeId(), opts); break
    case 'script_rewrite': result = await startRewriteRun(episodeId(), opts); break
    case 'portrait_appearance': result = await startPortraitAppearance(z.number().parse(a.characterId), { ...opts, episodeId: z.number().parse(a.opts?.episodeId) }); break
    case 'asset_semantics': result = await startSemanticsAuto({ ...argsSchema.shape.input.unwrap().parse(a.input), retryOf, excludeConfigIds: opts.excludeConfigIds }); break
    case 'asset_batch': result = await startAssetBatch(dramaId(), argsSchema.shape.req.unwrap().parse(a.req), retryOf); break
    default: throw new Error(`不支持恢复任务类型：${restart.kind}`)
  }
  if (result === false || (typeof result === 'object' && result !== null && 'started' in result && result.started === false)) throw new Error('任务恢复未启动')
}

/** Requeue only a proven pre-output model failure; never switch a pinned endpoint. */
export async function requeueFirstModelFailure(taskId: number, error: unknown, safe: boolean): Promise<boolean> {
  if (!safe || !isModelError(error)) return false
  const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
  const params = parseTextTaskParams(row?.params)
  if (!params || params.requeued === true || params.progress?.completed) return false
  const restart = params.restart as TextTaskRestart | undefined
  if (!restart) return false
  const parsed = argsSchema.safeParse(restart.args)
  if (!parsed.success) return false
  const { opts, input, req } = parsed.data
  if (opts?.configId != null || opts?.model || input?.configId != null || req?.textConfigId != null || req?.textModel) return false
  const attempts = z.array(z.object({ config_id: z.number(), error_class: z.string().nullable() })).safeParse(params.attempts)
  const failedAttempt = attempts.success ? attempts.data.findLast(attempt => attempt.error_class !== null) : undefined
  const failedConfig = failedAttempt?.config_id ?? params.model_used?.config_id ?? params.configId
  if (!failedConfig) return false
  await patchTextTaskParams(taskId, { requeued: true, auto_retry: 1 })
  try {
    await dispatchTextTaskRestart(restart, taskId, [...(opts?.excludeConfigIds ?? []), failedConfig])
    return true
  } catch (err) {
    console.error('文本任务自动重排失败:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/** A queued request has not acquired a model slot, so it is safe to resubmit. */
export async function resumeQueuedTextTasks(dispatch = dispatchTextTaskRestart): Promise<void> {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'text'), eq(schema.sysTask.status, 'queued'),
  )).orderBy(asc(schema.sysTask.id))
  for (const row of rows) {
    const params = parseTextTaskParams(row.params)
    const restart = params?.restart as TextTaskRestart | undefined
    if (params?.kind === 'asset_batch') {
      const batch = z.object({ items: z.array(z.object({ task_id: z.number().nullable().optional(), state: z.string() })) }).safeParse(params.asset_batch)
      if (batch.success && batch.data.items.some(item => item.task_id != null || item.state === 'submitted')) {
        await db.update(schema.sysTask).set({ status: 'failed', errorMsg: '批次已有图片任务提交，不能自动重排', updatedAt: now() })
          .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'queued')))
        continue
      }
    }
    await db.update(schema.sysTask).set({ status: 'cancelled', errorMsg: restart ? '后端重启，已重新排队' : '后端重启，无法恢复该任务', updatedAt: now() })
      .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'queued')))
    if (!restart) continue
    try {
      await dispatch(restart, row.id)
    } catch (err) {
      await db.update(schema.sysTask).set({ status: 'failed', errorMsg: `恢复失败：${err instanceof Error ? err.message : String(err)}`, updatedAt: now() })
        .where(eq(schema.sysTask.id, row.id))
    }
  }
}
