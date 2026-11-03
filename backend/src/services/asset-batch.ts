/**
 * 资产批量生成（Issue #33）—— 角色 / 场景 / 道具 / 全部资产四个入口共用一条流水线。
 *
 * 语义 =「按一次生成键」：先确保资产提示词生成好，再出图。
 *
 * 异步解耦（用户原话的核心诉求）：
 * - 文本侧有界并发池（`ASSET_PROMPT_CONCURRENCY`，默认 3），K 个 worker 共享一个游标；
 * - **提示词一好就立刻提交该资产的图像任务**，不等别的资产；提示词已可复用的资产在批次开始时就全部提交；
 * - 图像排队与调度是 qwen-jobs 网关（2 个 GPU worker）的职责，后端不再限流。
 *
 * 门禁：提示词阶段结论为 `failed` 的资产不出图、不兜底、也不拿库里残留的旧提示词出图
 * （`final-prompt.ts` 的 `FinalPromptResult`，Issue #33 验收 5）。
 *
 * 记账：一条父 `sys_task(type='text', params.kind='asset_batch')`，不新建批次表。
 * 重启由 `failInterruptedTextTasks()` 把活跃父任务标 failed（已提交网关的图像任务由 qwen-jobs 追踪器继续跟），
 * 重按按钮即恢复——默认跳过已完成项，所以「重按 = 重试」。
 */
import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { generateImage } from '../services/generation.js'
import {
  ensureCharacterFinalPrompt,
  ensurePropFinalPrompt,
  ensureSceneFinalPrompt,
  type FinalPromptOutcome,
  type FinalPromptResult,
} from './final-prompt.js'
import { sceneFinalPromptCoversTime } from './scene-time.js'
import { resolveStageModel } from './ai-stages.js'
import { partitionMissingReferences, resolveReferenceImages } from './reference-images.js'
import { ACTIVE_TASK_STATUSES, isActiveTaskStatus, isQwenJobsTask, type SysTaskRow } from './sys-task.js'
import { cancelImageTask } from './qwen-jobs.js'
import { createTextTask, parseTextTaskParams, patchTextTaskParams } from './text-task.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import {
  classifyAsset,
  isFaithfulCurrentImage,
  shouldSubmitImage,
  summarizeAssetBatchPlan,
  type AssetBatchOptions,
  type AssetBatchPlanItem,
  type AssetBatchPreviewCounts,
  type AssetBatchScope,
  type AssetKind,
  type AssetSelectionState,
} from './asset-batch-select.js'

/** 资产出图画幅：角色横版定妆照、道具白底方图、场景走 generateImage 默认值 */
export const ASSET_IMAGE_SIZE: Record<AssetKind, string | undefined> = {
  character: '1920x1080',
  scene: undefined,
  prop: '1024x1024',
}

/** 文本并发默认 3（图像侧 2 个 worker，并发 3 足以持续喂饱；env 可调） */
export const ASSET_PROMPT_CONCURRENCY = (() => {
  const raw = Number(process.env.ASSET_PROMPT_CONCURRENCY)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3
})()

/** 图像任务跟踪上限：网关任务卡死时父批次不能永久占住「同剧单批次」的名额 */
const TRACK_TIMEOUT_MS = 2 * 3600_000
const TRACK_INTERVAL_MS = 5_000

export type AssetBatchItemState =
  | AssetSelectionState
  | 'pending'
  | 'prompting'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AssetBatchItem {
  kind: AssetKind
  asset_id: number
  name: string
  /** 选集判定结论（跑完也保留，便于解释这一项为什么被跳过/纳入） */
  selection: AssetSelectionState
  state: AssetBatchItemState
  prompt_outcome: FinalPromptOutcome | null
  task_id: number | null
  error: string | null
}

export interface AssetBatchCounts {
  total: number
  skipped: { has_image: number; running: number; faithful: number }
  prompt: { done: number; failed: number; reused: number; regenerated: number; unchanged_after_rewrite: number }
  image: { submitted: number; done: number; failed: number }
}

export type AssetBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface AssetBatchJson {
  id: number
  drama_id: number
  episode_id: number | null
  scope: AssetBatchScope
  status: AssetBatchStatus
  cancel_requested: boolean
  options: { rewrite_prompts: boolean; overwrite_images: boolean }
  counts: AssetBatchCounts
  items: AssetBatchItem[]
  created_at: string
  updated_at: string
  error: string | null
}

interface AssetBatchParams {
  scope: AssetBatchScope
  options: { rewrite_prompts: boolean; overwrite_images: boolean }
  cancel_requested?: boolean
  items: AssetBatchItem[]
}

export interface AssetBatchRequest {
  scope: AssetBatchScope
  episodeId: number
  rewritePrompts: boolean
  overwriteImages: boolean
  textModel?: string
  textConfigId?: number
  imageModel?: string
  imageConfigId?: number
}

/** 本进程正在跑的批次（父任务 id → 取消标志 + 该批次的内存状态）；重启后由 failInterruptedTextTasks 清理 */
const runningBatches = new Map<number, { cancelRequested: boolean; batch: AssetBatchParams }>()

// ─── 资产装载与选集 ───────────────────────────────────────────

interface LoadedAsset {
  kind: AssetKind
  id: number
  name: string
  dramaId: number
  imageUrl: string | null
  localPath: string | null
  referenceImages: string | null
  finalPrompt: string | null
  /** 有可直接复用的提示词（场景还要求写到了场景时间，Issue #21） */
  hasPrompt: boolean
  /** 持久的证据素材标记（Issue #47，只有道具会是 1）：一票判定 skip_faithful */
  faithful: number
}

const SCOPE_KINDS: Record<AssetBatchScope, AssetKind[]> = {
  characters: ['character'],
  scenes: ['scene'],
  props: ['prop'],
  // 「全部资产」顺序：角色 → 场景 → 道具（Q9，角色先出先审）
  all: ['character', 'scene', 'prop'],
}

async function loadScopeAssets(dramaId: number, scope: AssetBatchScope): Promise<LoadedAsset[]> {
  const kinds = SCOPE_KINDS[scope]
  const assets: LoadedAsset[] = []
  for (const kind of kinds) {
    if (kind === 'character') {
      const rows = await db.select().from(schema.characters)
        .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
      rows.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.id - b.id)
      for (const row of rows) {
        assets.push({
          kind, id: row.id, name: row.name, dramaId: row.dramaId,
          imageUrl: row.imageUrl, localPath: row.localPath, referenceImages: row.referenceImages,
          finalPrompt: row.finalPrompt, hasPrompt: !!row.finalPrompt, faithful: 0,
        })
      }
    } else if (kind === 'scene') {
      const rows = await db.select().from(schema.scenes)
        .where(and(eq(schema.scenes.dramaId, dramaId), isNull(schema.scenes.deletedAt)))
      rows.sort((a, b) => a.id - b.id)
      for (const row of rows) {
        assets.push({
          kind, id: row.id, name: row.location, dramaId: row.dramaId,
          imageUrl: row.imageUrl, localPath: row.localPath, referenceImages: row.referenceImages,
          finalPrompt: row.finalPrompt,
          hasPrompt: !!row.finalPrompt && sceneFinalPromptCoversTime(row.finalPrompt, row.time),
          faithful: 0,
        })
      }
    } else {
      const rows = await db.select().from(schema.props)
        .where(and(eq(schema.props.dramaId, dramaId), isNull(schema.props.deletedAt)))
      rows.sort((a, b) => a.id - b.id)
      for (const row of rows) {
        assets.push({
          kind, id: row.id, name: row.name, dramaId: row.dramaId,
          imageUrl: row.imageUrl, localPath: row.localPath, referenceImages: row.referenceImages,
          finalPrompt: row.finalPrompt, hasPrompt: !!row.finalPrompt, faithful: row.faithful ?? 0,
        })
      }
    }
  }
  return assets
}

const OWNER_COLUMN = {
  character: schema.sysTask.characterId,
  scene: schema.sysTask.sceneId,
  prop: schema.sysTask.propId,
} as const

/** 这批资产的全部图像任务行（版本历史 + 在跑的任务都从这里判） */
async function loadAssetImageTasks(assets: LoadedAsset[]): Promise<SysTaskRow[]> {
  const conditions: SQL[] = []
  for (const kind of ['character', 'scene', 'prop'] as AssetKind[]) {
    const ids = assets.filter(a => a.kind === kind).map(a => a.id)
    if (ids.length) conditions.push(inArray(OWNER_COLUMN[kind], ids))
  }
  if (!conditions.length) return []
  return await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'image'), or(...conditions)))
}

function ownerIdOf(row: SysTaskRow, kind: AssetKind): number | null {
  if (kind === 'character') return row.characterId
  if (kind === 'scene') return row.sceneId
  return row.propId
}

/** 该资产是否有在跑的图像任务：资产出图任务不带 storyboard_id（与前端卡片进度环同口径） */
function hasActiveImageTask(tasks: SysTaskRow[], kind: AssetKind, assetId: number): boolean {
  return tasks.some(t => t.storyboardId == null && ownerIdOf(t, kind) === assetId && isActiveTaskStatus(t.status))
}

function buildPlan(assets: LoadedAsset[], tasks: SysTaskRow[], opts: AssetBatchOptions): AssetBatchPlanItem[] {
  return assets.map((asset) => {
    const versions = tasks.filter(t => ownerIdOf(t, asset.kind) === asset.id && t.status === 'completed')
    const selection = classifyAsset({
      hasImage: !!(asset.imageUrl || asset.localPath),
      hasPrompt: asset.hasPrompt,
      faithful: isFaithfulCurrentImage(asset, versions),
      running: hasActiveImageTask(tasks, asset.kind, asset.id),
    }, opts)
    return { kind: asset.kind, asset_id: asset.id, name: asset.name, selection, has_prompt: asset.hasPrompt }
  })
}

export async function previewAssetBatch(
  dramaId: number,
  opts: AssetBatchOptions & { scope: AssetBatchScope },
): Promise<AssetBatchPreviewCounts> {
  const assets = await loadScopeAssets(dramaId, opts.scope)
  const tasks = await loadAssetImageTasks(assets)
  return summarizeAssetBatchPlan(buildPlan(assets, tasks, opts))
}

// ─── 父任务读写 ───────────────────────────────────────────────

function assetBatchParamsOf(row: SysTaskRow): AssetBatchParams | null {
  const params = parseTextTaskParams(row.params)
  if (!params || params.kind !== 'asset_batch') return null
  const raw = params.asset_batch
  if (!raw || typeof raw !== 'object') return null
  const batch = raw as Partial<AssetBatchParams>
  if (!batch.scope || !Array.isArray(batch.items)) return null
  return {
    scope: batch.scope,
    options: batch.options ?? { rewrite_prompts: false, overwrite_images: false },
    cancel_requested: !!batch.cancel_requested,
    items: batch.items,
  }
}

function countItems(items: AssetBatchItem[]): AssetBatchCounts {
  const counts: AssetBatchCounts = {
    total: items.length,
    skipped: { has_image: 0, running: 0, faithful: 0 },
    prompt: { done: 0, failed: 0, reused: 0, regenerated: 0, unchanged_after_rewrite: 0 },
    image: { submitted: 0, done: 0, failed: 0 },
  }
  for (const item of items) {
    if (item.state === 'skip_has_image') counts.skipped.has_image++
    if (item.state === 'skip_running') counts.skipped.running++
    if (item.state === 'skip_faithful') counts.skipped.faithful++
    switch (item.prompt_outcome) {
      case 'reused': counts.prompt.reused++; counts.prompt.done++; break
      case 'regenerated': counts.prompt.regenerated++; counts.prompt.done++; break
      case 'unchanged_after_rewrite': counts.prompt.unchanged_after_rewrite++; counts.prompt.done++; break
      case 'failed': counts.prompt.failed++; break
    }
    if (item.task_id != null) counts.image.submitted++
    if (item.state === 'completed') counts.image.done++
    if (item.state === 'failed' && item.task_id != null) counts.image.failed++
  }
  return counts
}

function toStatusJson(row: SysTaskRow, batch: AssetBatchParams): AssetBatchJson {
  const counts = countItems(batch.items)
  return {
    id: row.id,
    drama_id: row.dramaId ?? 0,
    episode_id: row.episodeId ?? null,
    scope: batch.scope,
    status: (row.status || 'processing') === 'processing' ? 'running' : (row.status as AssetBatchStatus),
    cancel_requested: !!batch.cancel_requested,
    options: batch.options,
    counts,
    items: batch.items,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    error: row.errorMsg ?? null,
  }
}

/** 进度落盘：详细项写 params.asset_batch，同时维护任务中心通用的 progress(completed/total/failed) */
async function persist(taskId: number, batch: AssetBatchParams): Promise<void> {
  const counts = countItems(batch.items)
  const handled = batch.items.filter(i => i.state === 'completed' || i.state === 'failed'
    || i.state === 'cancelled' || i.state.startsWith('skip_')).length
  await patchTextTaskParams(taskId, {
    asset_batch: batch,
    progress: { completed: handled, total: counts.total, failed: counts.prompt.failed + counts.image.failed },
  })
}

async function findActiveAssetBatchRow(dramaId: number): Promise<SysTaskRow | null> {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'text'),
    eq(schema.sysTask.dramaId, dramaId),
    inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES),
  ))
  return rows.find(r => !!assetBatchParamsOf(r)) ?? null
}

async function findLatestAssetBatchRow(dramaId: number): Promise<SysTaskRow | null> {
  const rows = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'text'), eq(schema.sysTask.dramaId, dramaId)))
    .orderBy(desc(schema.sysTask.id))
  return rows.find(r => !!assetBatchParamsOf(r)) ?? null
}

export async function getAssetBatch(dramaId: number): Promise<AssetBatchJson | null> {
  const row = await findLatestAssetBatchRow(dramaId)
  if (!row) return null
  const batch = assetBatchParamsOf(row)
  return batch ? toStatusJson(row, batch) : null
}

// ─── 执行 ─────────────────────────────────────────────────────

/** 图像提交：资产的最终提示词 + 资产自己的参考图；绝不使用本地兜底提示词 */
async function submitImage(asset: LoadedAsset, prompt: string, episodeId: number, req: AssetBatchRequest): Promise<number> {
  const { present: referenceImages, missing } = partitionMissingReferences(resolveReferenceImages(asset.referenceImages))
  if (missing.length) logTaskWarn('AssetBatch', 'reference-missing', { kind: asset.kind, assetId: asset.id, missing })
  if (asset.kind === 'scene') {
    await db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, asset.id))
  }
  return await generateImage({
    characterId: asset.kind === 'character' ? asset.id : undefined,
    sceneId: asset.kind === 'scene' ? asset.id : undefined,
    propId: asset.kind === 'prop' ? asset.id : undefined,
    episodeId,
    dramaId: asset.dramaId,
    prompt,
    model: req.imageModel,
    size: ASSET_IMAGE_SIZE[asset.kind],
    referenceImages: referenceImages.length ? referenceImages : undefined,
    configId: req.imageConfigId,
  })
}

async function ensurePrompt(asset: LoadedAsset, episodeId: number, req: AssetBatchRequest): Promise<FinalPromptResult> {
  const opts = { model: req.textModel, configId: req.textConfigId }
  if (asset.kind === 'character') {
    const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, asset.id))
    if (!row) return { prompt: '', outcome: 'failed' }
    return await ensureCharacterFinalPrompt(row, episodeId, req.rewritePrompts, opts)
  }
  if (asset.kind === 'scene') {
    const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, asset.id))
    if (!row) return { prompt: '', outcome: 'failed' }
    return await ensureSceneFinalPrompt(row, episodeId, req.rewritePrompts, opts)
  }
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, asset.id))
  if (!row) return { prompt: '', outcome: 'failed' }
  return await ensurePropFinalPrompt(row, episodeId, req.rewritePrompts, opts)
}

interface RunContext {
  taskId: number
  dramaId: number
  episodeId: number
  req: AssetBatchRequest
  batch: AssetBatchParams
  assets: Map<string, LoadedAsset>
}

const assetKey = (kind: AssetKind, id: number) => `${kind}:${id}`

function cancelled(ctx: RunContext): boolean {
  return !!runningBatches.get(ctx.taskId)?.cancelRequested
}

/**
 * 提交一个资产的图像任务：提交前复查该资产是否已有活跃图像任务
 * （选集只判了一次，文本阶段期间用户仍可点单发生成），命中则跳过并计 skip_running。
 */
async function dispatchImage(ctx: RunContext, asset: LoadedAsset, prompt: string): Promise<void> {
  const item = ctx.batch.items.find(i => i.kind === asset.kind && i.asset_id === asset.id)!
  if (cancelled(ctx)) {
    item.state = 'cancelled'
    await persist(ctx.taskId, ctx.batch)
    return
  }
  const tasks = await loadAssetImageTasks([asset])
  if (hasActiveImageTask(tasks, asset.kind, asset.id)) {
    item.state = 'skip_running'
    logTaskWarn('AssetBatch', 'skip running asset', { kind: asset.kind, assetId: asset.id })
    await persist(ctx.taskId, ctx.batch)
    return
  }
  try {
    const taskId = await submitImage(asset, prompt, ctx.episodeId, ctx.req)
    item.task_id = taskId
    item.state = 'submitted'
    logTaskProgress('AssetBatch', 'image submitted', { batch: ctx.taskId, kind: asset.kind, assetId: asset.id, taskId })
  } catch (err: unknown) {
    item.state = 'failed'
    item.error = err instanceof Error ? err.message : String(err)
    logTaskError('AssetBatch', 'image submit failed', { kind: asset.kind, assetId: asset.id, error: item.error })
  }
  await persist(ctx.taskId, ctx.batch)
}

/** 已提交项的终态回收：派发阶段也要跑，否则父批次的「图像完成数」要等文本阶段全部跑完才动 */
async function reconcileSubmitted(ctx: RunContext): Promise<void> {
  const pending = ctx.batch.items.filter(i => i.state === 'submitted' && i.task_id != null)
  if (!pending.length) return
  const rows = await db.select().from(schema.sysTask)
    .where(inArray(schema.sysTask.id, pending.map(i => i.task_id!)))
  let changed = false
  for (const item of pending) {
    const row = rows.find(r => r.id === item.task_id)
    if (!row || isActiveTaskStatus(row.status)) continue
    item.state = row.status === 'completed' ? 'completed' : row.status === 'cancelled' ? 'cancelled' : 'failed'
    if (row.status === 'failed') item.error = row.errorMsg ?? '图像生成失败'
    changed = true
  }
  if (changed) await persist(ctx.taskId, ctx.batch)
}

/** 文本侧有界并发池：K 个 worker 共享游标，每人「跑提示词 → 立刻提交自己的图」 */
async function runPromptPool(ctx: RunContext, queue: LoadedAsset[]): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled(ctx)) return
      const asset = queue[cursor++]
      if (!asset) return
      await reconcileSubmitted(ctx)
      const item = ctx.batch.items.find(i => i.kind === asset.kind && i.asset_id === asset.id)!
      item.state = 'prompting'
      await persist(ctx.taskId, ctx.batch)
      const result = await ensurePrompt(asset, ctx.episodeId, ctx.req)
      item.prompt_outcome = result.outcome
      if (!shouldSubmitImage(result.outcome)) {
        item.state = 'failed'
        item.error = '最终提示词生成失败'
        logTaskError('AssetBatch', 'prompt failed', { batch: ctx.taskId, kind: asset.kind, assetId: asset.id })
        await persist(ctx.taskId, ctx.batch)
        continue
      }
      await dispatchImage(ctx, asset, result.prompt)
    }
  }
  const workers = Math.min(ASSET_PROMPT_CONCURRENCY, Math.max(1, queue.length))
  await Promise.all(Array.from({ length: workers }, worker))
}

/**
 * 已提交的图像任务跟到终态，父批次才算结束（卡片进度环与任务中心仍各自展示子任务）。
 * 返回超时未结束的项数：网关任务卡死时不能让父批次永久占住「同剧单批次」的名额，
 * 也不能把没结束的图像算成功——超时项统一落成 failed。
 */
async function trackSubmitted(ctx: RunContext): Promise<number> {
  const deadline = Date.now() + TRACK_TIMEOUT_MS
  for (;;) {
    await reconcileSubmitted(ctx)
    if (!ctx.batch.items.some(i => i.state === 'submitted')) return 0
    if (Date.now() > deadline) {
      const stuck = ctx.batch.items.filter(i => i.state === 'submitted')
      for (const item of stuck) {
        item.state = 'failed'
        item.error = '图像任务超时未结束'
      }
      logTaskWarn('AssetBatch', 'tracking timeout', { batch: ctx.taskId, stuck: stuck.length })
      await persist(ctx.taskId, ctx.batch)
      return stuck.length
    }
    // 轮询间隔：与 keyframe-batch / video-batch 同写法（tsconfig lib < es2024，无 Promise.withResolvers）
    await new Promise(resolve => setTimeout(resolve, TRACK_INTERVAL_MS))
  }
}

async function finish(taskId: number, status: AssetBatchStatus, errorMsg?: string): Promise<void> {
  const ts = now()
  await db.update(schema.sysTask)
    .set({ status, errorMsg: errorMsg ?? null, updatedAt: ts, completedAt: ts })
    .where(eq(schema.sysTask.id, taskId))
  runningBatches.delete(taskId)
}

async function runBatch(ctx: RunContext): Promise<void> {
  try {
    // 提示词可复用的资产在批次开始时就全部提交，不等文本阶段（这正是「不要一个提示词一张图」的解耦点）
    const ready = ctx.batch.items.filter(i => i.selection === 'ready')
    for (const item of ready) {
      if (cancelled(ctx)) break
      const asset = ctx.assets.get(assetKey(item.kind, item.asset_id))!
      item.prompt_outcome = 'reused'
      await dispatchImage(ctx, asset, asset.finalPrompt || '')
    }
    const needPrompt = ctx.batch.items
      .filter(i => i.selection === 'need_prompt')
      .map(i => ctx.assets.get(assetKey(i.kind, i.asset_id))!)
    await runPromptPool(ctx, needPrompt)
    // 取消时派发已停，剩下的 pending 项直接作废
    for (const item of ctx.batch.items) {
      if (item.state === 'pending' || item.state === 'prompting') item.state = 'cancelled'
    }
    await persist(ctx.taskId, ctx.batch)
    const stuck = await trackSubmitted(ctx)
    const wasCancelled = cancelled(ctx)
    await persist(ctx.taskId, ctx.batch)
    const failed = ctx.batch.items.filter(i => i.state === 'failed').length
    const error = stuck ? `${stuck} 个图像任务超时未结束` : failed ? `${failed} 个资产失败` : undefined
    // 超时未结束的图像已落成 failed，父批次据此记失败，绝不把没结束的图当成功
    await finish(ctx.taskId, wasCancelled ? 'cancelled' : stuck ? 'failed' : 'completed', error)
    logTaskSuccess('AssetBatch', 'done', { batch: ctx.taskId, cancelled: wasCancelled, failed, stuck })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('AssetBatch', 'batch crashed', { batch: ctx.taskId, error: message })
    await persist(ctx.taskId, ctx.batch).catch(() => {})
    await finish(ctx.taskId, 'failed', message)
  }
}

export async function startAssetBatch(dramaId: number, req: AssetBatchRequest): Promise<AssetBatchJson> {
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  if (!drama) throw new Error('项目不存在')
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, req.episodeId))
  if (!episode || episode.dramaId !== dramaId) throw new Error('剧集不存在或不属于该项目')
  // 同一项目同时只允许一个活跃资产批量（Q8）
  if (await findActiveAssetBatchRow(dramaId)) throw new Error('该项目已有资产批量在运行，请等待或先停止')

  const opts: AssetBatchOptions = { rewritePrompts: req.rewritePrompts, overwriteImages: req.overwriteImages }
  const assets = await loadScopeAssets(dramaId, req.scope)
  const tasks = await loadAssetImageTasks(assets)
  const plan = buildPlan(assets, tasks, opts)
  const items: AssetBatchItem[] = plan.map(p => ({
    kind: p.kind,
    asset_id: p.asset_id,
    name: p.name,
    selection: p.selection,
    state: p.selection === 'ready' || p.selection === 'need_prompt' ? 'pending' : p.selection,
    prompt_outcome: null,
    task_id: null,
    error: null,
  }))
  const batch: AssetBatchParams = {
    scope: req.scope,
    options: { rewrite_prompts: req.rewritePrompts, overwrite_images: req.overwriteImages },
    cancel_requested: false,
    items,
  }
  const counts = countItems(items)
  const pending = items.filter(i => i.state === 'pending').length
  // 父任务也记环节（#51）：实际提示词改写由 final-prompt.ts 按同一环节解析
  const stageModel = await resolveStageModel('final_prompt', { model: req.textModel, configId: req.textConfigId })
  const taskId = await createTextTask({
    kind: 'asset_batch',
    episodeId: req.episodeId,
    dramaId,
    prompt: `资产批量生成（${req.scope}）：${pending} 个待处理 / 共 ${counts.total} 个`,
    stageModel,
  })
  await persist(taskId, batch)
  logTaskStart('AssetBatch', 'start', {
    batch: taskId, dramaId, episodeId: req.episodeId, scope: req.scope,
    total: counts.total, pending, concurrency: ASSET_PROMPT_CONCURRENCY,
    rewritePrompts: req.rewritePrompts, overwriteImages: req.overwriteImages,
  })

  runningBatches.set(taskId, { cancelRequested: false, batch })
  const ctx: RunContext = {
    taskId, dramaId, episodeId: req.episodeId, req, batch,
    assets: new Map(assets.map(a => [assetKey(a.kind, a.id), a])),
  }
  void runBatch(ctx)

  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  return toStatusJson(row!, batch)
}

/**
 * 取消（Q7）：停止派发新的提示词与图像任务，并撤销已提交的图像任务。
 * 撤销远端任务只对 qwen-jobs 有效，其它图像 provider 降级为「仅停止派发」。
 * 在飞的 runAgent 不中断（跑完也不再提交它的图）。
 */
export async function cancelAssetBatch(dramaId: number): Promise<AssetBatchJson> {
  const row = await findActiveAssetBatchRow(dramaId)
  if (!row) throw new Error('该项目没有正在运行的资产批量')
  const state = runningBatches.get(row.id)
  // 批次在跑时改它自己的内存状态，否则 runner 的下一次 persist 会把取消标志覆盖回去
  const batch = state?.batch ?? assetBatchParamsOf(row)!
  batch.cancel_requested = true
  if (state) state.cancelRequested = true
  await persist(row.id, batch)

  for (const item of batch.items) {
    if (item.task_id == null || item.state !== 'submitted') continue
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.task_id))
    if (!task || !isActiveTaskStatus(task.status)) continue
    if (!isQwenJobsTask(task.provider)) {
      logTaskWarn('AssetBatch', 'cancel unsupported provider', { taskId: task.id, provider: task.provider })
      continue
    }
    await cancelImageTask(task.id).catch((err: unknown) => {
      logTaskWarn('AssetBatch', 'cancel image failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) })
    })
  }
  logTaskWarn('AssetBatch', 'cancelled', { batch: row.id, dramaId })
  // 批次不在本进程跑（重启后的残留行）时直接收尾
  if (!state) await finish(row.id, 'cancelled')
  const [updated] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.id))
  return toStatusJson(updated!, batch)
}
