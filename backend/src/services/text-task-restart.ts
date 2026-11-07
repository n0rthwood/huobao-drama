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
import { restartArgsSchema as argsSchema } from './text-task-restart-schema.js'

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
    case 'asset_batch': result = await startAssetBatch(dramaId(), { ...argsSchema.shape.req.unwrap().parse(a.req), excludeTextConfigIds: opts.excludeConfigIds ?? a.req?.excludeTextConfigIds }, retryOf); break
    default: throw new Error(`不支持恢复任务类型：${restart.kind}`)
  }
  if (result === false || (typeof result === 'object' && result !== null && 'started' in result && result.started === false)) throw new Error('任务恢复未启动')
}

/** A queued request has not acquired a model slot, so it is safe to resubmit. */
export async function resumeQueuedTextTasks(dispatch = dispatchTextTaskRestart): Promise<void> {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'text'), eq(schema.sysTask.status, 'queued'),
  )).orderBy(asc(schema.sysTask.id))
  // A crash may occur after the replacement is inserted but before its parent is cancelled.
  // Existing retry_of links make that window idempotent, even if the child already completed.
  const known = await db.select({ id: schema.sysTask.id, params: schema.sysTask.params })
    .from(schema.sysTask).where(eq(schema.sysTask.type, 'text'))
  for (const row of rows) {
    const params = parseTextTaskParams(row.params)
    const restart = params?.restart as TextTaskRestart | undefined
    const replacementExists = known.some(candidate => candidate.id > row.id && parseTextTaskParams(candidate.params)?.retry_of === row.id)
    if (replacementExists) {
      await db.update(schema.sysTask).set({ status: 'cancelled', errorMsg: '后端重启，已重新排队', updatedAt: now() })
        .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'queued')))
      continue
    }
    if (params?.kind === 'asset_batch') {
      const batch = z.object({ items: z.array(z.object({ task_id: z.number().nullable().optional(), state: z.string() })) }).safeParse(params.asset_batch)
      if (batch.success && batch.data.items.some(item => item.task_id != null || item.state === 'submitted')) {
        await db.update(schema.sysTask).set({ status: 'failed', errorMsg: '批次已有图片任务提交，不能自动重排', updatedAt: now() })
          .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'queued')))
        continue
      }
    }
    if (!restart) {
      await db.update(schema.sysTask).set({ status: 'cancelled', errorMsg: '后端重启，无法恢复该任务', updatedAt: now() })
        .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'queued')))
      continue
    }
    try {
      await dispatch(restart, row.id)
      await db.update(schema.sysTask).set({ status: 'cancelled', errorMsg: '后端重启，已重新排队', updatedAt: now() })
        .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'queued')))
    } catch (err) {
      await db.update(schema.sysTask).set({ status: 'failed', errorMsg: `恢复失败：${err instanceof Error ? err.message : String(err)}`, updatedAt: now() })
        .where(eq(schema.sysTask.id, row.id))
    }
  }
}
