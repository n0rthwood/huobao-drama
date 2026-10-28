/**
 * 服务端批量关键帧生成 — 脱离浏览器，批次状态持久化在 keyframe_batches，重启后自动恢复
 *
 * qwen-jobs（服务端排队的任务 API）：批次启动后**一次性提交全部待生成槽位**，
 * 每提交一张就把 sys_task id 落盘（重启后不会重复提交），之后只跟踪各 sys_task 的终态。
 * 三张关键帧各自独立生成、互不作为参考图（见 storyboard-keyframes.ts），所以并发安全。
 *
 * 其它 provider（OpenAI/Gemini/火山）没有服务端队列，保持原来的严格串行：
 * 提交 → 等 sys_task 终态 → 等写回落库 → 下一张。
 *
 * 停止批次 = 取消所有未结束项（排队的立即取消，运行中的按服务端规则结束）。
 */
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  KEYFRAME_SLOTS,
  SLOT_FRAME_TYPE,
  SLOT_LABEL,
  loadEpisodeKeyframes,
  slotOwnImage,
  slotPrompt,
  type KeyframeSlot,
} from './keyframes.js'
import { listEpisodeStoryboards } from './storyboard-video.js'
import {
  buildKeyframeRequest,
  loadKeyframeBuildContext,
  loadKeyframeVersions,
  submitStoryboardKeyframe,
} from './storyboard-keyframes.js'
import {
  SLOT_PROMPT_FIELD,
  blockingIssuesFor,
  checkStoryboardRefs,
  computeRefIssues,
  describeIssues,
  loadEpisodeAssets,
  loadTargetBindings,
  promptFieldsOf,
  type RefIssue,
} from './storyboard-assets.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { cancelImageTask } from './qwen-jobs.js'
import { isActiveTaskStatus, isQwenJobsTask, parseRemoteState, type RemoteState } from './sys-task.js'
import {
  aggregateBatchItems,
  UNFINISHED_STATES,
  type KeyframeBatchCounts,
  type KeyframeBatchItem,
  type KeyframeBatchItemState,
  type KeyframeBatchItemView,
} from './keyframe-batch-progress.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

export type KeyframeBatchStatus = 'running' | 'done' | 'cancelled'
export type {
  KeyframeBatchCounts,
  KeyframeBatchItem,
  KeyframeBatchItemState,
  KeyframeBatchItemView,
} from './keyframe-batch-progress.js'

export interface KeyframeBatchStatusJson {
  id: number
  episode_id: number
  status: KeyframeBatchStatus
  current_storyboard_id: number | null
  current_slot: KeyframeSlot | null
  /** 已请求停止：不再提交新的关键帧，未结束项按各自规则结束 */
  cancel_requested: boolean
  created_at: string
  updated_at: string
  /** 未完成项 estimated_finish_seconds 的最大值；无法估计时 null */
  eta_seconds: number | null
  /** 按各项 estimate.run_seconds 加权：完成=1、运行中=fraction、其余=0 */
  progress: number
  counts: KeyframeBatchCounts
  items: KeyframeBatchItemView[]
}

interface BatchOptions {
  model?: string
  configId?: number
  /** 停止请求随批次持久化：重启恢复后仍然生效 */
  cancelRequested?: boolean
}

/** 单张等待上限（串行模式）：生图链路自身轮询上限 10 分钟，这里留出排队余量兜底 */
const ITEM_WAIT_TIMEOUT_MS = 40 * 60_000
const ITEM_POLL_INTERVAL_MS = 5_000
/** 等待"生成完成 → 写回 storyboards 槽位"落库的短窗口 */
const ADOPT_WAIT_TIMEOUT_MS = 60_000
const ADOPT_POLL_INTERVAL_MS = 500
/** 并发模式的跟踪节奏：与 qwen-jobs 追踪器同频 */
const PARALLEL_TICK_MS = 3_000

/** 进程内已有 runner 的批次，避免启动恢复与新建批次重复驱动同一批 */
const activeRunners = new Set<number>()

function parseItems(raw: string | null | undefined): KeyframeBatchItem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as KeyframeBatchItem[] : []
  } catch {
    return []
  }
}

function parseOptions(raw: string | null | undefined): BatchOptions {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as BatchOptions : {}
  } catch {
    return {}
  }
}

/** sys_task.params 里的 frameType（参数损坏按“无槽位”处理，不影响批量继续） */
function frameTypeOf(raw: string | null | undefined): string {
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object' && 'frameType' in parsed && typeof parsed.frameType === 'string') {
      return parsed.frameType
    }
  } catch {
    // 忽略：按无槽位处理
  }
  return ''
}

async function loadRemoteStates(items: KeyframeBatchItem[]): Promise<Record<number, RemoteState>> {
  const ids = items.map(item => item.task_id).filter((id): id is number => id != null)
  if (!ids.length) return {}
  const rows = (await db.select().from(schema.sysTask)).filter(row => ids.includes(row.id))
  const map: Record<number, RemoteState> = {}
  for (const row of rows) map[row.id] = parseRemoteState(row.remoteState)
  return map
}

async function toStatus(row: typeof schema.keyframeBatches.$inferSelect): Promise<KeyframeBatchStatusJson> {
  const items = parseItems(row.items)
  const current = items.find(item => item.state === 'running')
  const aggregate = aggregateBatchItems(items, await loadRemoteStates(items))
  return {
    id: row.id,
    episode_id: row.episodeId,
    status: (row.status || 'running') as KeyframeBatchStatus,
    current_storyboard_id: current?.storyboard_id ?? null,
    current_slot: current?.slot ?? null,
    cancel_requested: !!parseOptions(row.options).cancelRequested,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    eta_seconds: aggregate.eta_seconds,
    progress: aggregate.progress,
    counts: aggregate.counts,
    items: aggregate.items,
  }
}

async function loadBatch(batchId: number) {
  const [row] = await db.select().from(schema.keyframeBatches).where(eq(schema.keyframeBatches.id, batchId))
  return row
}

async function saveItems(batchId: number, items: KeyframeBatchItem[]) {
  await db.update(schema.keyframeBatches)
    .set({ items: JSON.stringify(items), updatedAt: now() })
    .where(eq(schema.keyframeBatches.id, batchId))
}

/** 同一批次的 items 读-改-写串行化：停止与 runner 的提交并发，不能用过期快照互相覆盖 */
const itemQueues = new Map<number, Promise<KeyframeBatchItem[]>>()

async function mutateItems(
  batchId: number,
  mutate: (items: KeyframeBatchItem[]) => void,
): Promise<KeyframeBatchItem[]> {
  const run = (itemQueues.get(batchId) ?? Promise.resolve([] as KeyframeBatchItem[]))
    .catch(() => [] as KeyframeBatchItem[])
    .then(async () => {
      const row = await loadBatch(batchId)
      if (!row) return []
      const items = parseItems(row.items)
      mutate(items)
      await saveItems(batchId, items)
      return items
    })
  itemQueues.set(batchId, run)
  try {
    return await run
  } finally {
    if (itemQueues.get(batchId) === run) itemQueues.delete(batchId)
  }
}

async function setBatchStatus(batchId: number, status: KeyframeBatchStatus) {
  await db.update(schema.keyframeBatches)
    .set({ status, updatedAt: now() })
    .where(eq(schema.keyframeBatches.id, batchId))
}

/** 本集未完成的批次（running）；用于互斥与单张生成拦截 */
async function loadRunningBatch(episodeId: number) {
  const rows = await db.select().from(schema.keyframeBatches)
    .where(and(eq(schema.keyframeBatches.episodeId, episodeId), eq(schema.keyframeBatches.status, 'running')))
  return rows.sort((a, b) => b.id - a.id)[0]
}

/** 批次用的图片配置是否是 qwen-jobs（决定并发提交还是串行） */
async function batchUsesQwenJobs(episodeId: number, options: BatchOptions): Promise<boolean> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const configId = options.configId ?? episode?.imageConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('image') : await getActiveConfig('image')
  return isQwenJobsTask(config?.provider)
}

/** 启动对应模式的 runner */
async function startRunner(batchId: number, episodeId: number, options: BatchOptions): Promise<void> {
  if (await batchUsesQwenJobs(episodeId, options)) void runParallelBatch(batchId)
  else void runBatch(batchId)
}

/** 某分镜是否正排在某个运行中的关键帧批次里（未结束项）——单张手动生成据此拒绝 */
export async function findActiveKeyframeBatchForStoryboard(storyboardId: number): Promise<number | null> {
  const rows = await db.select().from(schema.keyframeBatches)
    .where(eq(schema.keyframeBatches.status, 'running'))
  for (const row of rows) {
    const hit = parseItems(row.items).some(item =>
      item.storyboard_id === storyboardId && UNFINISHED_STATES.includes(item.state))
    if (hit) return row.id
  }
  return null
}

export async function getEpisodeKeyframeBatch(episodeId: number): Promise<KeyframeBatchStatusJson | null> {
  const rows = await db.select().from(schema.keyframeBatches)
    .where(eq(schema.keyframeBatches.episodeId, episodeId))
  const latest = rows.sort((a, b) => b.id - a.id)[0]
  return latest ? await toStatus(latest) : null
}

/**
 * 取消该批次所有未结束项：已提交的调远端取消，未提交的直接作废。
 * 远端取消只是暂时失败（网关抖动/5xx）时**不**把项标成已取消 —— 那会让仍在跑的
 * 远端任务把图片写回来。这类项保持未结束，由 sys_task 追踪器继续重试取消
 * （它自己有重试上限，到点会把任务置为终态），下一拍再收敛。返回仍未结束的项数。
 */
async function cancelUnfinishedItems(batchId: number): Promise<number> {
  const row = await loadBatch(batchId)
  if (!row) return 0
  // 远端取消放在锁外：它是网络调用，不能挡住 runner/停止接口的其它落盘
  const settled = new Set<number>()
  for (const item of parseItems(row.items)) {
    if (!UNFINISHED_STATES.includes(item.state) || item.task_id == null) continue
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.task_id))
    // sys_task 不存在或已终结：没有什么可取消的了
    if (!task || !isActiveTaskStatus(task.status)) {
      settled.add(item.task_id)
      continue
    }
    // 暂时性失败不会抛（cancelImageTask 内部保留取消意图，由追踪器重试）：
    // 这里抛出的都是补救不了的（供应商不支持取消 / 配置已删），重试也没用，直接作废
    const updated = await cancelImageTask(item.task_id).catch(err => {
      logTaskWarn('KeyframeBatch', 'cancel item unrecoverable', {
        batchId, taskId: item.task_id, error: err instanceof Error ? err.message : String(err),
      })
      return 'unrecoverable' as const
    })
    if (updated === 'unrecoverable' || !isActiveTaskStatus(updated.status)) settled.add(item.task_id)
  }

  let remaining = 0
  await mutateItems(batchId, items => {
    for (const item of items) {
      if (!UNFINISHED_STATES.includes(item.state)) continue
      // 没有 sys_task 的项直接作废；有 task 的只在它确实终结后才作废
      if (item.task_id == null || settled.has(item.task_id)) {
        item.state = 'cancelled'
        item.error = item.error ?? '已取消'
        continue
      }
      remaining++
    }
  })
  return remaining
}

/** 停止：取消该批次所有未结束的关键帧任务 */
export async function cancelEpisodeKeyframeBatch(episodeId: number): Promise<KeyframeBatchStatusJson> {
  const running = await loadRunningBatch(episodeId)
  if (!running) throw new Error('本集没有正在运行的批量关键帧任务')
  const options = parseOptions(running.options)
  await db.update(schema.keyframeBatches)
    .set({ options: JSON.stringify({ ...options, cancelRequested: true }), updatedAt: now() })
    .where(eq(schema.keyframeBatches.id, running.id))
  logTaskWarn('KeyframeBatch', 'cancel', { batchId: running.id, episodeId })

  if (await batchUsesQwenJobs(episodeId, options)) {
    // 服务端排队：立即取消，不等 runner 的下一拍（排队项马上结束，运行项按服务端规则）
    const remaining = await cancelUnfinishedItems(running.id)
    await setBatchStatus(running.id, 'cancelled')
    // 还有没收敛的项（远端取消暂时失败，或提交正好在途）：交给 runner 继续重试
    if (remaining > 0) void runParallelBatch(running.id)
  } else if (!activeRunners.has(running.id)) {
    // 串行模式且没有 runner 在驱动：直接落盘 cancelled，避免批次永远占着本集的互斥位
    await setBatchStatus(running.id, 'cancelled')
  }
  const row = await loadBatch(running.id)
  return await toStatus(row!)
}

/** 重试失败/已取消项：一律新建 sys_task（幂等键随新 id 变化，服务端才会真正重跑） */
export async function retryFailedKeyframeBatch(episodeId: number): Promise<KeyframeBatchStatusJson> {
  const rows = await db.select().from(schema.keyframeBatches)
    .where(eq(schema.keyframeBatches.episodeId, episodeId))
  const latest = rows.sort((a, b) => b.id - a.id)[0]
  if (!latest) throw new Error('本集还没有批量关键帧任务')
  const items = parseItems(latest.items)
  const retryable = items.filter(item => item.state === 'failed' || item.state === 'cancelled')
  if (!retryable.length) throw new Error('没有需要重试的关键帧')

  for (const item of retryable) {
    item.state = 'pending'
    item.task_id = null
    item.error = null
  }
  const options = { ...parseOptions(latest.options), cancelRequested: false }
  await db.update(schema.keyframeBatches)
    .set({ status: 'running', options: JSON.stringify(options), items: JSON.stringify(items), updatedAt: now() })
    .where(eq(schema.keyframeBatches.id, latest.id))
  logTaskStart('KeyframeBatch', 'retry-failed', { batchId: latest.id, episodeId, total: retryable.length })
  await startRunner(latest.id, episodeId, options)
  const row = await loadBatch(latest.id)
  return await toStatus(row!)
}

export interface KeyframePreviewItem {
  storyboard_id: number
  storyboard_number: number
  slot: KeyframeSlot
  /** missing=无图 changed=与所有历史版本不同 unchanged=命中历史签名 blocked=一致性阻断 skipped=不可生成 */
  status: 'missing' | 'changed' | 'unchanged' | 'blocked' | 'skipped'
  /** 默认勾选（missing / changed） */
  checked: boolean
  matched_version_no?: number
  selected_version_no?: number | null
  issues?: RefIssue[]
  reason?: string
}

/** 本集正在排队/运行中的关键帧槽位（同一张不重复提交） */
async function loadActiveSlots(): Promise<string[]> {
  return (await db.select().from(schema.sysTask))
    .filter(task => task.type === 'image' && isActiveTaskStatus(task.status) && task.storyboardId)
    .map(task => `${task.storyboardId}:${frameTypeOf(task.params)}`)
}

/**
 * 批量预览：逐个“分镜 × 槽位”判断是否需要重生成。
 * 与启动共用 buildKeyframeRequest，所以签名口径与真正提交完全一致。
 */
export async function previewEpisodeKeyframeBatch(
  episodeId: number,
  opts: { storyboardIds?: number[]; model?: string; configId?: number } = {},
): Promise<KeyframePreviewItem[]> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')
  const storyboards = await listEpisodeStoryboards(episodeId)
  if (!storyboards.length) throw new Error('本集还没有分镜，请先拆分分镜')

  const context = await loadKeyframeBuildContext(episodeId, { model: opts.model, configId: opts.configId })
  const keyframes = await loadEpisodeKeyframes(episodeId)
  const active = await loadActiveSlots()
  // “选择”模式只缩小范围，勾选默认值仍按签名判断
  const targets = opts.storyboardIds?.length
    ? storyboards.filter(sb => opts.storyboardIds!.includes(sb.id))
    : storyboards

  const assets = await loadEpisodeAssets(episodeId)
  const result: KeyframePreviewItem[] = []
  for (const sb of targets) {
    const state = keyframes.get(sb.id)
    const bindings = await loadTargetBindings(sb.id)
    const issues = computeRefIssues({ prompts: promptFieldsOf(sb), assets, bindings })

    for (const slot of KEYFRAME_SLOTS) {
      // 中间帧只在 LLM 给了提示词时才存在，不写进清单
      if (slot === 'mid' && !slotPrompt(sb, 'mid')) continue
      const base = { storyboard_id: sb.id, storyboard_number: sb.storyboardNumber, slot }
      if (!slotPrompt(sb, slot)) {
        result.push({
          ...base,
          status: 'skipped',
          checked: false,
          reason: slot === 'first' && state?.inheritsFirst
            ? '承接上一镜尾帧，没有自有首帧提示词'
            : `${SLOT_LABEL[slot]}提示词为空`,
        })
        continue
      }
      if (active.includes(`${sb.id}:${SLOT_FRAME_TYPE[slot]}`)) {
        result.push({ ...base, status: 'skipped', checked: false, reason: '该槽位正在生成中' })
        continue
      }
      const blocking = blockingIssuesFor(issues, SLOT_PROMPT_FIELD[slot])
      if (blocking.length) {
        result.push({ ...base, status: 'blocked', checked: false, issues: blocking, reason: describeIssues(blocking) })
        continue
      }

      let signature: string
      try {
        signature = (await buildKeyframeRequest(sb.id, slot, {
          model: opts.model, configId: opts.configId, context, assets, bindings,
        })).signature
      } catch (err) {
        result.push({ ...base, status: 'skipped', checked: false, reason: err instanceof Error ? err.message : '无法组装生成请求' })
        continue
      }

      const versions = await loadKeyframeVersions(sb.id, slot)
      const ownImage = slotOwnImage(sb, slot)
      const selected = versions.find(version => version.image === ownImage) ?? null
      if (!ownImage) {
        result.push({ ...base, status: 'missing', checked: true, selected_version_no: null })
        continue
      }
      const matched = versions.find(version => version.signature && version.signature === signature)
      result.push(matched
        ? {
          ...base,
          status: 'unchanged',
          checked: false,
          matched_version_no: matched.version_no,
          selected_version_no: selected?.version_no ?? null,
        }
        : { ...base, status: 'changed', checked: true, selected_version_no: selected?.version_no ?? null })
    }
  }
  return result
}

/**
 * 启动批量：按前端勾选的 items（分镜 × 槽位）入批。
 * 预览之后才变成阻断/正在生成/提示词被清空的项跳过并标注原因，不让整批失败。
 */
export async function startEpisodeKeyframeBatch(
  episodeId: number,
  opts: { items: Array<{ storyboard_id: number; slot: KeyframeSlot }>; model?: string; configId?: number },
): Promise<KeyframeBatchStatusJson> {
  if (await loadRunningBatch(episodeId)) throw new Error('本集已有批量关键帧在运行')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')

  const storyboards = await listEpisodeStoryboards(episodeId)
  if (!storyboards.length) throw new Error('本集还没有分镜，请先拆分分镜')
  if (!opts.items?.length) throw new Error('没有需要生成的关键帧')

  const active = await loadActiveSlots()
  const issuesByStoryboard = new Map<number, RefIssue[]>()

  const items: KeyframeBatchItem[] = []
  const seen: string[] = []
  for (const target of opts.items) {
    const key = `${target.storyboard_id}:${target.slot}`
    if (seen.includes(key)) continue
    seen.push(key)
    const sb = storyboards.find(row => row.id === target.storyboard_id)
    if (!sb) continue
    const item: KeyframeBatchItem = {
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      slot: target.slot,
      state: 'pending',
      task_id: null,
      error: null,
    }
    if (!slotPrompt(sb, target.slot)) {
      item.state = 'skipped'
      item.error = `${SLOT_LABEL[target.slot]}提示词为空，已跳过`
    } else if (active.includes(`${sb.id}:${SLOT_FRAME_TYPE[target.slot]}`)) {
      item.state = 'skipped'
      item.error = '该槽位正在生成中，已跳过'
    } else {
      if (!issuesByStoryboard.has(sb.id)) issuesByStoryboard.set(sb.id, await checkStoryboardRefs(sb))
      const blocking = blockingIssuesFor(issuesByStoryboard.get(sb.id)!, SLOT_PROMPT_FIELD[target.slot])
      if (blocking.length) {
        item.state = 'skipped'
        item.error = `参考图与提示词不一致，已跳过：${describeIssues(blocking)}`
      }
    }
    items.push(item)
  }
  if (!items.some(item => item.state === 'pending')) {
    const reason = items.find(item => item.error)?.error
    throw new Error(reason ? `没有需要生成的关键帧：${reason}` : '没有需要生成的关键帧')
  }

  const ts = now()
  const options: BatchOptions = { model: opts.model, configId: opts.configId }
  const res = await db.insert(schema.keyframeBatches).values({
    episodeId,
    status: 'running',
    options: JSON.stringify(options),
    items: JSON.stringify(items),
    createdAt: ts,
    updatedAt: ts,
  })
  const batchId = getInsertId(res)
  logTaskStart('KeyframeBatch', 'batch', {
    batchId,
    episodeId,
    total: items.filter(item => item.state === 'pending').length,
    skipped: items.filter(item => item.state === 'skipped').length,
    model: opts.model || undefined,
  })
  await startRunner(batchId, episodeId, options)
  const row = await loadBatch(batchId)
  return await toStatus(row!)
}

/** sys_task 状态 → 批次项状态 */
function itemStateFromTask(status: string | null | undefined): KeyframeBatchItemState {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'queued') return 'queued'
  return 'running'
}

/**
 * 并发驱动（qwen-jobs）：一次性提交全部待生成项，然后只跟踪各 sys_task 的状态。
 * 写回由生成链路在各自完成时进行（关键帧之间没有生成依赖）。
 *
 * 停止是随时可能发生的：每张提交前都重新确认一次停止标记，所有落盘都走 mutateItems
 * 的读-改-写（绝不用自己手里的过期快照覆盖已落盘的 cancelled），停止后才提交出去的
 * 那一张会立刻被远端取消。远端取消一时失败的项保持未结束，这里按拍重试直到收敛。
 */
async function runParallelBatch(batchId: number): Promise<void> {
  if (activeRunners.has(batchId)) return
  activeRunners.add(batchId)
  try {
    let drainTicks = 0
    for (;;) {
      const row = await loadBatch(batchId)
      if (!row) return
      const options = parseOptions(row.options)

      // 停止（或批次已被置为非 running）：收敛所有未结束项，收不干净就下一拍接着取消
      if (options.cancelRequested || row.status !== 'running') {
        const remaining = await cancelUnfinishedItems(batchId)
        // 批次状态先落 cancelled：UI 立刻看到停止，未确认的项继续重试
        if (row.status === 'running') {
          await setBatchStatus(batchId, 'cancelled')
          logTaskWarn('KeyframeBatch', 'batch cancelled', { batchId, episodeId: row.episodeId, remaining })
        }
        if (!remaining) return
        if (drainTicks++ % 20 === 0) {
          logTaskWarn('KeyframeBatch', 'cancel drain retry', { batchId, remaining, ticks: drainTicks })
        }
        await new Promise(resolve => setTimeout(resolve, PARALLEL_TICK_MS))
        continue
      }

      // 提交：每提交一张立即落盘 sys_task id，重启恢复时不会重复提交
      for (const target of parseItems(row.items)) {
        if (target.state !== 'pending') continue
        // 每张之前重新确认：停止请求可能刚刚落盘
        const fresh = await loadBatch(batchId)
        if (!fresh || fresh.status !== 'running' || parseOptions(fresh.options).cancelRequested) break
        const current = parseItems(fresh.items)
          .find(item => item.storyboard_id === target.storyboard_id && item.slot === target.slot)
        if (!current || current.state !== 'pending') continue

        let taskId: number | null = null
        let error: string | null = null
        try {
          taskId = await submitStoryboardKeyframe(target.storyboard_id, target.slot, options)
        } catch (err) {
          error = err instanceof Error ? err.message : '生成失败'
          logTaskError('KeyframeBatch', 'keyframe', {
            batchId, storyboardId: target.storyboard_id, slot: target.slot, error,
          })
        }
        let cancelledDuringSubmit = false
        await mutateItems(batchId, items => {
          const item = items.find(it => it.storyboard_id === target.storyboard_id && it.slot === target.slot)
          if (!item) return
          if (!UNFINISHED_STATES.includes(item.state)) {
            // 提交途中批次被停止：保留已落盘的 cancelled，只补上 task_id 以便取消远端
            if (taskId != null) {
              item.task_id = taskId
              cancelledDuringSubmit = true
            }
            return
          }
          item.task_id = taskId
          item.state = taskId != null ? 'queued' : 'failed'
          item.error = taskId != null ? null : error
        })
        if (cancelledDuringSubmit && taskId != null) {
          logTaskWarn('KeyframeBatch', 'cancel item submitted after stop', { batchId, taskId })
          await cancelImageTask(taskId).catch(err => {
            logTaskWarn('KeyframeBatch', 'cancel item failed', {
              batchId, taskId, error: err instanceof Error ? err.message : String(err),
            })
          })
        } else if (taskId != null) {
          logTaskProgress('KeyframeBatch', 'keyframe submit', {
            batchId,
            storyboardId: target.storyboard_id,
            shotNumber: target.storyboard_number,
            slot: target.slot,
            taskId,
          })
        }
      }

      // 跟踪：sys_task 状态 → 批次项状态（只推进未结束项，不复活已取消的）
      const tracking = parseItems((await loadBatch(batchId))?.items)
      const taskIds = tracking.map(item => item.task_id).filter((id): id is number => id != null)
      const tasks = (await db.select().from(schema.sysTask)).filter(task => taskIds.includes(task.id))
      const completed: KeyframeBatchItem[] = []
      const items = await mutateItems(batchId, list => {
        for (const item of list) {
          if (item.task_id == null || !UNFINISHED_STATES.includes(item.state)) continue
          const task = tasks.find(t => t.id === item.task_id)
          if (!task) continue
          const next = itemStateFromTask(task.status)
          if (next === item.state) continue
          item.state = next
          item.error = next === 'failed' ? (task.errorMsg || '生成失败') : item.error
          if (next === 'completed') completed.push(item)
        }
      })
      for (const item of completed) {
        logTaskSuccess('KeyframeBatch', 'keyframe', {
          batchId, storyboardId: item.storyboard_id, slot: item.slot, taskId: item.task_id,
        })
      }

      if (!items.some(item => UNFINISHED_STATES.includes(item.state))) {
        // 跟踪期间可能刚收到停止：别把已停止的批次写成 done，交给下一拍的停止分支
        const latest = await loadBatch(batchId)
        if (!latest) return
        if (latest.status !== 'running' || parseOptions(latest.options).cancelRequested) continue
        await setBatchStatus(batchId, 'done')
        logTaskSuccess('KeyframeBatch', 'batch', {
          batchId,
          episodeId: row.episodeId,
          completed: items.filter(item => item.state === 'completed').length,
          failed: items.filter(item => item.state === 'failed').length,
          cancelled: items.filter(item => item.state === 'cancelled').length,
          skipped: items.filter(item => item.state === 'skipped').length,
        })
        return
      }
      await new Promise(resolve => setTimeout(resolve, PARALLEL_TICK_MS))
    }
  } catch (err) {
    logTaskError('KeyframeBatch', 'batch', { batchId, error: err instanceof Error ? err.message : String(err) })
    await setBatchStatus(batchId, 'cancelled').catch(() => {})
  } finally {
    activeRunners.delete(batchId)
  }
}

/** 等待单张的 sys_task 到达终态（串行模式） */
async function waitForTask(taskId: number): Promise<{ ok: boolean; error: string | null }> {
  const deadline = Date.now() + ITEM_WAIT_TIMEOUT_MS
  for (;;) {
    // 与 video-batch.ts/generation.ts 的轮询同一写法（tsconfig target ES2022 不含 Promise.withResolvers 的类型）
    await new Promise(resolve => setTimeout(resolve, ITEM_POLL_INTERVAL_MS))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) return { ok: false, error: '生成任务记录丢失' }
    if (task.status === 'completed') return { ok: true, error: null }
    if (task.status === 'failed') return { ok: false, error: task.errorMsg || '生成失败' }
    if (Date.now() > deadline) return { ok: false, error: '等待生成超时' }
  }
}

/**
 * sys_task 置为 completed 与把图片写回 storyboards 槽位是两条语句（generation.ts writeBackImageAssets），
 * 中间有一次 await。下一镜可能要继承这一镜的尾帧，等写回落库后再推进。
 */
async function waitForSlotImage(storyboardId: number, slot: KeyframeSlot): Promise<void> {
  const deadline = Date.now() + ADOPT_WAIT_TIMEOUT_MS
  for (;;) {
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
    if (sb && slotOwnImage(sb, slot)) return
    if (Date.now() > deadline) {
      logTaskWarn('KeyframeBatch', 'write-back wait timeout', { storyboardId, slot })
      return
    }
    await new Promise(resolve => setTimeout(resolve, ADOPT_POLL_INTERVAL_MS))
  }
}

/** 串行驱动一个批次直到完成/取消（非 qwen-jobs provider）；进程内同一批次只有一个 runner */
async function runBatch(batchId: number): Promise<void> {
  if (activeRunners.has(batchId)) return
  activeRunners.add(batchId)
  try {
    for (;;) {
      const row = await loadBatch(batchId)
      if (!row) return
      if (row.status !== 'running') {
        logTaskWarn('KeyframeBatch', 'batch stopped', { batchId, status: row.status })
        return
      }
      const items = parseItems(row.items)
      const options = parseOptions(row.options)
      // 停止请求：在跑的那一张已在上一轮 await 完并落盘，这里不再提交新的
      if (options.cancelRequested) {
        await setBatchStatus(batchId, 'cancelled')
        logTaskWarn('KeyframeBatch', 'batch cancelled', { batchId, episodeId: row.episodeId })
        return
      }
      // pending 正常推进；running 只会出现在重启恢复时，重新提交那一张
      const index = items.findIndex(item => item.state === 'pending' || item.state === 'running')
      if (index < 0) {
        await setBatchStatus(batchId, 'done')
        logTaskSuccess('KeyframeBatch', 'batch', {
          batchId,
          episodeId: row.episodeId,
          completed: items.filter(item => item.state === 'completed').length,
          failed: items.filter(item => item.state === 'failed').length,
          skipped: items.filter(item => item.state === 'skipped').length,
        })
        return
      }

      const item = items[index]!
      item.state = 'running'
      item.error = null
      item.task_id = null
      await saveItems(batchId, items)
      logTaskProgress('KeyframeBatch', 'keyframe submit', {
        batchId,
        storyboardId: item.storyboard_id,
        shotNumber: item.storyboard_number,
        slot: item.slot,
      })

      try {
        const taskId = await submitStoryboardKeyframe(item.storyboard_id, item.slot, options)
        item.task_id = taskId
        await saveItems(batchId, items)
        const result = await waitForTask(taskId)
        item.state = result.ok ? 'completed' : 'failed'
        item.error = result.error
        // 下一镜可能要继承这一镜的尾帧：等写回分镜后再推进
        if (result.ok) await waitForSlotImage(item.storyboard_id, item.slot)
      } catch (err) {
        item.state = 'failed'
        item.error = err instanceof Error ? err.message : '生成失败'
      }

      if (item.state === 'failed') {
        logTaskError('KeyframeBatch', 'keyframe', {
          batchId,
          storyboardId: item.storyboard_id,
          shotNumber: item.storyboard_number,
          slot: item.slot,
          error: item.error,
        })
      } else {
        logTaskSuccess('KeyframeBatch', 'keyframe', {
          batchId,
          storyboardId: item.storyboard_id,
          shotNumber: item.storyboard_number,
          slot: item.slot,
          taskId: item.task_id,
        })
      }
      await saveItems(batchId, items)
    }
  } catch (err) {
    logTaskError('KeyframeBatch', 'batch', { batchId, error: err instanceof Error ? err.message : String(err) })
    // runner 异常退出：转为 cancelled，释放本集互斥位（已提交的关键帧不受影响）
    await setBatchStatus(batchId, 'cancelled').catch(() => {})
  } finally {
    activeRunners.delete(batchId)
  }
}

/**
 * 启动时恢复被重启打断的批次。
 * qwen-jobs：已提交的项保留 task_id，由追踪器继续跟，只有还没提交的 pending 会被提交。
 * 其它 provider：中断的那一张重新提交（它的 sys_task 已被启动清理标记为 failed）。
 * 已停止但还有未结束项的批次（远端取消在重启前没确认完）同样要恢复 runner，
 * 由它继续重试取消，直到每一项都真的终结。
 */
export async function resumeKeyframeBatches(): Promise<void> {
  try {
    const rows = (await db.select().from(schema.keyframeBatches)).filter(row =>
      row.status === 'running'
      || (row.status === 'cancelled' && parseItems(row.items).some(item => UNFINISHED_STATES.includes(item.state))))
    for (const row of rows) {
      const items = parseItems(row.items)
      logTaskProgress('KeyframeBatch', 'resume', {
        batchId: row.id,
        episodeId: row.episodeId,
        status: row.status,
        pending: items.filter(item => item.state === 'pending').length,
        tracking: items.filter(item => item.state === 'queued' || item.state === 'running').length,
      })
      await startRunner(row.id, row.episodeId, parseOptions(row.options))
    }
  } catch (err) {
    logTaskError('KeyframeBatch', 'resume', { error: err instanceof Error ? err.message : String(err) })
  }
}
