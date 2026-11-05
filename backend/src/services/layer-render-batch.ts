import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { scopeFromPreview, type BatchScopePreviewItem } from './batch-scope.js'
import { hasLayerSegment, toCombo } from './design-card.js'
import { getLayerSegment, layerSegmentIsFresh, resolveEpisodeSegmentSpec } from './layer-segment.js'
import { startLayerSegmentRenderTask } from './layer-segment-task.js'
import { listEpisodeStoryboards } from './storyboard-video.js'
import { assertShotGate } from './workflow-gates.js'
import { createTextTask, findActiveTextTask, findLatestTextTask, finishTextTask, parseTextTaskParams, promptBatchStatusFrom, updateTextTaskProgress, type TextTaskProgress } from './text-task.js'
import { RENDER_CONSUMED_SOURCE_REASONS } from './segment-source-refresh.js'

export interface LayerRenderPreviewItem extends BatchScopePreviewItem {
  status: 'missing' | 'changed' | 'unchanged' | 'excluded' | 'blocked' | 'skipped'
}

/** The server reads all media inputs from the saved segment, never the request body. */
export async function previewLayerRenderBatch(episodeId: number, storyboardIds?: number[]): Promise<LayerRenderPreviewItem[]> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const spec = await resolveEpisodeSegmentSpec(episodeId)
  const out: LayerRenderPreviewItem[] = []
  for (const sb of await listEpisodeStoryboards(episodeId)) {
    if (storyboardIds !== undefined && !storyboardIds.includes(sb.id)) continue
    const item: LayerRenderPreviewItem = { storyboard_id: sb.id, storyboard_number: sb.storyboardNumber, status: 'blocked', selectable: false, checked: false }
    if (!hasLayerSegment(toCombo(sb.combo))) {
      item.status = 'excluded'
      item.reason = sb.combo === 'B' ? '未启用图层段' : '设计卡未确认'
    } else {
      try {
        await assertShotGate(sb.id, 'production')
        const segment = await getLayerSegment(sb.id)
        if (!segment) item.reason = '图层段尚未制作'
        else if (segment.status === 'rendering') { item.status = 'skipped'; item.reason = 'generating' }
        else if (segment.stale_reasons.some(reason => reason !== 'migrated_multi_clip' && !RENDER_CONSUMED_SOURCE_REASONS.some(source => source === reason))) item.reason = `图层段输入已过期：${segment.stale_reasons.join('、')}`
        else {
          item.status = !segment.stale_reasons.some(reason => RENDER_CONSUMED_SOURCE_REASONS.some(source => source === reason)) && layerSegmentIsFresh(segment, spec) ? 'unchanged' : segment.render_path ? 'changed' : 'missing'
          item.selectable = true
          item.checked = item.status !== 'unchanged'
          if (!item.checked) item.reason = 'unchanged'
        }
      } catch (err) { item.reason = err instanceof Error ? err.message : String(err) }
    }
    out.push(item)
  }
  return out
}

export async function startLayerRenderBatch(episodeId: number, dramaId: number, storyboardIds: number[], retry?: { retryOf: number }) {
  if (await findActiveTextTask(episodeId, 'layer_render_batch')) throw new Error('本集已有图层段批量渲染在运行')
  if (!storyboardIds.length) throw new Error('没有选择需要渲染的图层段')
  const preview = await previewLayerRenderBatch(episodeId)
  const scope = scopeFromPreview(preview, storyboardIds)
  const included = new Set(scope.included.map(item => item.storyboard_id))
  const targets = preview.filter(item => included.has(item.storyboard_id) && storyboardIds.includes(item.storyboard_id) && item.selectable)
  if (!targets.length) throw new Error('没有可渲染的图层段')
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: targets.length, items: targets.map(item => ({ storyboard_id: item.storyboard_id, storyboard_number: item.storyboard_number, state: 'pending', reason: null })) }
  const taskId = await createTextTask({ kind: 'layer_render_batch', episodeId, dramaId, prompt: `渲染 ${targets.length} 镜图层段`, storyboardIds: targets.map(item => item.storyboard_id), scope, progress, retryOf: retry?.retryOf })
  void (async () => {
    for (const item of progress.items!) {
      item.state = 'processing'
      progress.current_storyboard_id = item.storyboard_id
      await updateTextTaskProgress(taskId, progress)
      try {
        // Re-evaluate eligibility after waiting for the preceding render.
        const [current] = await previewLayerRenderBatch(episodeId, [item.storyboard_id])
        if (!current?.selectable) throw new Error(current?.reason || '图层段不可渲染')
        await assertShotGate(item.storyboard_id, 'production')
        await startLayerSegmentRenderTask(item.storyboard_id)
        item.state = 'completed'
        progress.completed++
      } catch (err) {
        item.state = 'failed'
        item.reason = err instanceof Error ? err.message : String(err)
        progress.failed++
      }
      await updateTextTaskProgress(taskId, progress)
    }
    delete progress.current_storyboard_id
    await finishTextTask(taskId, progress.failed && !progress.completed ? 'failed' : 'completed', { progress, errorMsg: progress.failed ? `${progress.failed} 镜图层段渲染失败` : null })
  })().catch(async err => { await finishTextTask(taskId, 'failed', { progress, errorMsg: err instanceof Error ? err.message : String(err) }) })
  return { started: true, total: targets.length, task_id: taskId, scope }
}

export async function getLayerRenderBatchStatus(episodeId: number) {
  const row = await findLatestTextTask(episodeId, 'layer_render_batch')
  const status = promptBatchStatusFrom(row)
  const params = parseTextTaskParams(row?.params)
  return status ? { ...status, task_id: row!.id, scope: params?.scope, items: params?.progress?.items ?? [] } : null
}

export async function retryFailedLayerRenderBatch(episodeId: number, dramaId: number, sourceTaskId?: number) {
  const row = sourceTaskId
    ? (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, sourceTaskId)))[0]
    : await findLatestTextTask(episodeId, 'layer_render_batch')
  const params = parseTextTaskParams(row?.params)
  if (!row || row.episodeId !== episodeId || params?.kind !== 'layer_render_batch' || !params.scope) throw new Error('没有可重试的图层段范围快照')
  const ids = params.progress?.items?.filter(item => ['failed', 'processing', 'pending'].includes(item.state)).map(item => item.storyboard_id) ?? []
  if (!ids.length) throw new Error('没有失败项可重试')
  return startLayerRenderBatch(episodeId, dramaId, ids, { retryOf: row.id })
}
