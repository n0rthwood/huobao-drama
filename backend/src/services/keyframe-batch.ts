/**
 * 服务端批量关键帧生成 — 按「分镜 × 槽位」顺序串行，脱离浏览器
 *
 * 提交 → 等待 sys_task 终态（完成即自动成为该槽位选定版本）→ 下一张；
 * 承接分镜的首帧要用上一镜刚生成的尾帧，所以必须串行且等写回落库。
 * 批次状态持久化在 keyframe_batches，后端重启后自动恢复（被打断的那一张重新提交）。
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
import { submitStoryboardKeyframe } from './storyboard-keyframes.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

export type KeyframeBatchStatus = 'running' | 'done' | 'cancelled'
export type KeyframeBatchItemState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface KeyframeBatchItem {
  storyboard_id: number
  storyboard_number: number
  slot: KeyframeSlot
  state: KeyframeBatchItemState
  task_id: number | null
  error: string | null
}

export interface KeyframeBatchStatusJson {
  id: number
  episode_id: number
  status: KeyframeBatchStatus
  current_storyboard_id: number | null
  current_slot: KeyframeSlot | null
  /** 已请求停止：不再提交新的关键帧，在跑的那一张等它跑完后批次转为 cancelled */
  cancel_requested: boolean
  created_at: string
  updated_at: string
  items: KeyframeBatchItem[]
}

interface BatchOptions {
  model?: string
  configId?: number
  /** 停止请求随批次持久化：重启恢复后仍然生效 */
  cancelRequested?: boolean
}

/** 单张等待上限：生图链路自身轮询上限 10 分钟，这里留出排队余量兜底 */
const ITEM_WAIT_TIMEOUT_MS = 40 * 60_000
const ITEM_POLL_INTERVAL_MS = 5_000
/** 等待"生成完成 → 写回 storyboards 槽位"落库的短窗口 */
const ADOPT_WAIT_TIMEOUT_MS = 60_000
const ADOPT_POLL_INTERVAL_MS = 500

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

function toStatus(row: typeof schema.keyframeBatches.$inferSelect): KeyframeBatchStatusJson {
  const items = parseItems(row.items)
  const current = items.find(item => item.state === 'running')
  return {
    id: row.id,
    episode_id: row.episodeId,
    status: (row.status || 'running') as KeyframeBatchStatus,
    current_storyboard_id: current?.storyboard_id ?? null,
    current_slot: current?.slot ?? null,
    cancel_requested: !!parseOptions(row.options).cancelRequested,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    items,
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

/** 某分镜是否正排在某个运行中的关键帧批次里（pending/running）——单张手动生成据此拒绝 */
export async function findActiveKeyframeBatchForStoryboard(storyboardId: number): Promise<number | null> {
  const rows = await db.select().from(schema.keyframeBatches)
    .where(eq(schema.keyframeBatches.status, 'running'))
  for (const row of rows) {
    const hit = parseItems(row.items).some(item =>
      item.storyboard_id === storyboardId && (item.state === 'pending' || item.state === 'running'))
    if (hit) return row.id
  }
  return null
}

export async function getEpisodeKeyframeBatch(episodeId: number): Promise<KeyframeBatchStatusJson | null> {
  const rows = await db.select().from(schema.keyframeBatches)
    .where(eq(schema.keyframeBatches.episodeId, episodeId))
  const latest = rows.sort((a, b) => b.id - a.id)[0]
  return latest ? toStatus(latest) : null
}

/** 停止：只是不再提交新的关键帧；在跑的那一张继续跑完，之后批次转为 cancelled */
export async function cancelEpisodeKeyframeBatch(episodeId: number): Promise<KeyframeBatchStatusJson> {
  const running = await loadRunningBatch(episodeId)
  if (!running) throw new Error('本集没有正在运行的批量关键帧任务')
  const options = parseOptions(running.options)
  await db.update(schema.keyframeBatches)
    .set({ options: JSON.stringify({ ...options, cancelRequested: true }), updatedAt: now() })
    .where(eq(schema.keyframeBatches.id, running.id))
  logTaskWarn('KeyframeBatch', 'cancel', { batchId: running.id, episodeId })
  // 没有 runner 在驱动（runner 异常退出）时直接落盘 cancelled，避免批次永远占着本集的互斥位
  if (!activeRunners.has(running.id)) await setBatchStatus(running.id, 'cancelled')
  const row = await loadBatch(running.id)
  return toStatus(row!)
}

/**
 * 启动批量：未指定分镜时只补缺图的槽位；指定分镜时对它们的全部槽位重新生成。
 * 继承首帧且没有自有首帧提示词的分镜跳过首帧槽位；没有中间帧提示词就没有中间帧槽位。
 */
export async function startEpisodeKeyframeBatch(
  episodeId: number,
  opts: { storyboardIds?: number[]; model?: string; configId?: number } = {},
): Promise<KeyframeBatchStatusJson> {
  if (await loadRunningBatch(episodeId)) throw new Error('本集已有批量关键帧在运行')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')

  const storyboards = await listEpisodeStoryboards(episodeId)
  if (!storyboards.length) throw new Error('本集还没有分镜，请先拆分分镜')

  const keyframes = await loadEpisodeKeyframes(episodeId)
  const regenerate = !!opts.storyboardIds?.length
  const targets = regenerate
    ? storyboards.filter(sb => opts.storyboardIds!.includes(sb.id))
    : storyboards

  // 正在生成中的同槽位不纳入批量，避免同一张被重复提交
  const processing = new Set((await db.select().from(schema.sysTask))
    .filter(task => task.type === 'image' && task.status === 'processing' && task.storyboardId)
    .map(task => `${task.storyboardId}:${frameTypeOf(task.params)}`))

  const items: KeyframeBatchItem[] = []
  for (const sb of targets) {
    const state = keyframes.get(sb.id)
    for (const slot of KEYFRAME_SLOTS) {
      // 承接分镜没有自有首帧提示词时，首帧用上一镜尾帧，不生成
      if (slot === 'first' && state?.inheritsFirst && !slotPrompt(sb, 'first')) continue
      // 中间帧只在 LLM 给了提示词时才存在
      if (slot === 'mid' && !slotPrompt(sb, 'mid')) continue
      if (processing.has(`${sb.id}:${SLOT_FRAME_TYPE[slot]}`)) continue
      // 默认只补缺图：首帧按“生效首帧”判断（继承到的也算有图）
      if (!regenerate) {
        const existing = slot === 'first' ? state?.first ?? slotOwnImage(sb, 'first') : slotOwnImage(sb, slot)
        if (existing) continue
      }
      const prompt = slotPrompt(sb, slot)
      items.push({
        storyboard_id: sb.id,
        storyboard_number: sb.storyboardNumber,
        slot,
        state: prompt ? 'pending' : 'skipped',
        task_id: null,
        error: prompt ? null : `${SLOT_LABEL[slot]}提示词为空，已跳过`,
      })
    }
  }
  if (!items.some(item => item.state === 'pending')) throw new Error('没有需要生成的关键帧')

  const ts = now()
  const res = await db.insert(schema.keyframeBatches).values({
    episodeId,
    status: 'running',
    options: JSON.stringify({ model: opts.model, configId: opts.configId }),
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
  void runBatch(batchId)
  const row = await loadBatch(batchId)
  return toStatus(row!)
}

/** 等待单张的 sys_task 到达终态 */
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

/** 串行驱动一个批次直到完成/取消；进程内同一批次只有一个 runner */
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

/** 启动时恢复被重启打断的批次：状态仍为 running 的批次继续跑，中断的那一张重新提交 */
export async function resumeKeyframeBatches(): Promise<void> {
  try {
    const rows = await db.select().from(schema.keyframeBatches)
      .where(eq(schema.keyframeBatches.status, 'running'))
    for (const row of rows) {
      const interrupted = parseItems(row.items).find(item => item.state === 'running')
      logTaskProgress('KeyframeBatch', 'resume', {
        batchId: row.id,
        episodeId: row.episodeId,
        // 上游可能仍在跑同一张，这里接受重复生成
        resubmitStoryboardId: interrupted?.storyboard_id ?? null,
        resubmitSlot: interrupted?.slot ?? null,
      })
      void runBatch(row.id)
    }
  } catch (err) {
    logTaskError('KeyframeBatch', 'resume', { error: err instanceof Error ? err.message : String(err) })
  }
}
