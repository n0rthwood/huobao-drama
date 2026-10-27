/**
 * 服务端批量视频生成 — 按分镜顺序串行，脱离浏览器
 *
 * 提交 → 等待 sys_task 终态（完成即自动采用）→ 下一镜。
 * 前提是本集所有分镜的关键帧都已人工确认；每一镜在提交前再复查一次确认状态。
 * 批次状态持久化在 video_batches，后端重启（开发机 tsx watch 很常见）后自动恢复：
 * 被重启中断的那一镜重新提交（接受上游可能残留的重复任务）。
 */
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { getVideoAdapter } from './adapters/registry'
import { loadEpisodeKeyframes, type StoryboardKeyframeState } from './keyframes.js'
import {
  buildStoryboardVideoRequest,
  describeSignatureDiff,
  listEpisodeStoryboards,
  loadVideoVersions,
  submitStoryboardVideo,
  type StoryboardVideoRequest,
} from './storyboard-video.js'
import { blockingIssuesFor, checkStoryboardRefs, describeIssues } from './storyboard-assets.js'
import { isActiveTaskStatus } from './sys-task.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { transitionStatus } from './transition.js'

export type BatchStatus = 'running' | 'done' | 'cancelled'
export type BatchItemState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface VideoBatchItem {
  storyboard_id: number
  storyboard_number: number
  state: BatchItemState
  task_id: number | null
  error: string | null
}

export interface VideoBatchStatus {
  id: number
  episode_id: number
  status: BatchStatus
  current_storyboard_id: number | null
  created_at: string
  updated_at: string
  /** 已请求停止：不再提交新的镜头，在跑的那一镜等它跑完后批次转为 cancelled */
  cancel_requested: boolean
  items: VideoBatchItem[]
}

interface BatchOptions {
  model?: string
  configId?: number
  /** 停止请求随批次持久化：重启恢复后仍然生效 */
  cancelRequested?: boolean
}

/** 单镜等待上限：生成链路自身已有界（等待引擎 30 分钟 + 轮询 50 分钟），这里留出余量兜底 */
const ITEM_WAIT_TIMEOUT_MS = 95 * 60_000
const ITEM_POLL_INTERVAL_MS = 5_000
/** 等待"生成完成 → 写回 storyboards.video_url"落库的短窗口 */
const ADOPT_WAIT_TIMEOUT_MS = 60_000
const ADOPT_POLL_INTERVAL_MS = 500

/** 进程内已有 runner 的批次，避免启动恢复与新建批次重复驱动同一批 */
const activeRunners = new Set<number>()

function parseItems(raw: string | null | undefined): VideoBatchItem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as VideoBatchItem[] : []
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

function toStatus(row: typeof schema.videoBatches.$inferSelect): VideoBatchStatus {
  const items = parseItems(row.items)
  return {
    id: row.id,
    episode_id: row.episodeId,
    status: (row.status || 'running') as BatchStatus,
    current_storyboard_id: items.find(item => item.state === 'running')?.storyboard_id ?? null,
    cancel_requested: !!parseOptions(row.options).cancelRequested,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    items,
  }
}

async function loadBatch(batchId: number) {
  const [row] = await db.select().from(schema.videoBatches).where(eq(schema.videoBatches.id, batchId))
  return row
}

async function saveItems(batchId: number, items: VideoBatchItem[]) {
  await db.update(schema.videoBatches)
    .set({ items: JSON.stringify(items), updatedAt: now() })
    .where(eq(schema.videoBatches.id, batchId))
}

async function setBatchStatus(batchId: number, status: BatchStatus) {
  await db.update(schema.videoBatches)
    .set({ status, updatedAt: now() })
    .where(eq(schema.videoBatches.id, batchId))
}

/** 本集未完成的批次（running）；用于互斥与单镜生成拦截 */
async function loadRunningBatch(episodeId: number) {
  const rows = await db.select().from(schema.videoBatches)
    .where(and(eq(schema.videoBatches.episodeId, episodeId), eq(schema.videoBatches.status, 'running')))
  return rows.sort((a, b) => b.id - a.id)[0]
}

/** 某分镜是否正排在某个运行中的批次里（pending/running）——单镜手动生成据此拒绝，避免打乱串行承接 */
export async function findActiveBatchForStoryboard(storyboardId: number): Promise<number | null> {
  const rows = await db.select().from(schema.videoBatches)
    .where(eq(schema.videoBatches.status, 'running'))
  for (const row of rows) {
    const hit = parseItems(row.items).some(item =>
      item.storyboard_id === storyboardId && (item.state === 'pending' || item.state === 'running'))
    if (hit) return row.id
  }
  return null
}

export async function getEpisodeVideoBatch(episodeId: number): Promise<VideoBatchStatus | null> {
  const rows = await db.select().from(schema.videoBatches)
    .where(eq(schema.videoBatches.episodeId, episodeId))
  const latest = rows.sort((a, b) => b.id - a.id)[0]
  return latest ? toStatus(latest) : null
}

/** 停止：只是不再提交新的镜头；在跑的那一镜继续跑完，之后批次转为 cancelled */
export async function cancelEpisodeVideoBatch(episodeId: number): Promise<VideoBatchStatus> {
  const running = await loadRunningBatch(episodeId)
  if (!running) throw new Error('本集没有正在运行的批量视频任务')
  const options = parseOptions(running.options)
  await db.update(schema.videoBatches)
    .set({ options: JSON.stringify({ ...options, cancelRequested: true }), updatedAt: now() })
    .where(eq(schema.videoBatches.id, running.id))
  logTaskWarn('VideoBatch', 'cancel', { batchId: running.id, episodeId })
  // 没有 runner 在驱动（runner 异常退出）时直接落盘 cancelled，避免批次永远占着本集的互斥位；
  // 否则由 runner 在当前镜头结束后的下一轮落盘 cancelled
  if (!activeRunners.has(running.id)) await setBatchStatus(running.id, 'cancelled')
  const row = await loadBatch(running.id)
  return toStatus(row!)
}

export interface VideoPreviewItem {
  storyboard_id: number
  storyboard_number: number
  /** missing=无视频 changed=与所有可比较版本不同 unchanged=命中历史签名 unknown=历史版本缺字段 blocked=阻断 skipped=不可生成 */
  status: 'missing' | 'changed' | 'unchanged' | 'unknown' | 'blocked' | 'skipped'
  /** 默认勾选（missing / changed） */
  checked: boolean
  /** 可勾选（blocked / skipped 不可勾） */
  selectable: boolean
  matched_version_no?: number
  /** 当前采用视频对应的版本号 */
  adopted_version_no?: number | null
  /** changed 的变化分项（提示词 / 关键帧 / 参考图 / 时长画幅 / 模型） */
  change_reasons?: string[]
  reason?: string
}

/** 本集正在排队/运行中的视频分镜（同一镜不重复提交） */
async function loadActiveStoryboardIds(): Promise<Set<number>> {
  return new Set((await db.select().from(schema.sysTask))
    .filter(task => task.type === 'video' && isActiveTaskStatus(task.status) && task.storyboardId)
    .map(task => task.storyboardId as number))
}

/** 某镜此刻是否被阻断（关键帧未确认 / 视频提示词与绑定不一致）；可生成时返回 null */
async function videoBlockReason(
  sb: typeof schema.storyboards.$inferSelect,
  keyframes: Map<number, StoryboardKeyframeState>,
): Promise<string | null> {
  if (!keyframes.get(sb.id)?.confirmed) return '关键帧尚未确认'
  const blocking = blockingIssuesFor(await checkStoryboardRefs(sb), 'video_prompt')
  if (blocking.length) return `视频提示词与参考图不一致：${describeIssues(blocking)}`
  return null
}

/**
 * 批量预览：逐镜判断输入是否相对历史版本发生变化。
 * 与提交共用 buildStoryboardVideoRequest，所以签名口径与真正提交完全一致。
 * 分类优先级：命中任一历史版本 → unchanged；否则有可比较版本 → changed；
 * 全部历史版本缺字段 → unknown；没有任何版本 → missing。
 */
export async function previewEpisodeVideoBatch(
  episodeId: number,
  opts: { storyboardIds?: number[]; model?: string; configId?: number } = {},
): Promise<VideoPreviewItem[]> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')
  const storyboards = await listEpisodeStoryboards(episodeId)
  if (!storyboards.length) throw new Error('本集还没有分镜，请先拆分分镜')

  const keyframes = await loadEpisodeKeyframes(episodeId)
  const active = await loadActiveStoryboardIds()
  // “选择”模式只缩小范围，勾选默认值仍按签名判断
  const targets = opts.storyboardIds?.length
    ? storyboards.filter(sb => opts.storyboardIds!.includes(sb.id))
    : storyboards

  const result: VideoPreviewItem[] = []
  for (const sb of targets) {
    const base = { storyboard_id: sb.id, storyboard_number: sb.storyboardNumber }
    if (active.has(sb.id)) {
      result.push({ ...base, status: 'skipped', checked: false, selectable: false, reason: '该镜头正在生成中' })
      continue
    }
    const blocked = await videoBlockReason(sb, keyframes)
    if (blocked) {
      result.push({ ...base, status: 'blocked', checked: false, selectable: false, reason: blocked })
      continue
    }

    // 预览不跑转场 agent（写库且耗时）：需要转场却还没审核的镜头直接归为 changed
    const pendingTransition = (await transitionStatus(sb, keyframes.get(sb.id)?.inheritsFirst === true)).needsReview
    let request: StoryboardVideoRequest
    try {
      request = await buildStoryboardVideoRequest(sb.id, { model: opts.model, configId: opts.configId, autoTransition: false })
    } catch (err) {
      result.push({
        ...base,
        status: 'blocked',
        checked: false,
        selectable: false,
        reason: err instanceof Error ? err.message : '无法组装生成请求',
      })
      continue
    }

    const versions = await loadVideoVersions(sb.id)
    const adoptedVideo = sb.videoUrl || sb.composedVideoUrl || null
    const adopted = versions.find(version => version.video === adoptedVideo) ?? null
    if (!versions.length) {
      result.push({ ...base, status: 'missing', checked: true, selectable: true, adopted_version_no: null })
      continue
    }
    if (pendingTransition) {
      result.push({
        ...base,
        status: 'changed',
        checked: true,
        selectable: true,
        adopted_version_no: adopted?.version_no ?? null,
        reason: '提交前将自动生成转场',
      })
      continue
    }
    // 命中任一历史版本即未变化；当前采用的版本也命中时优先报它，文案才贴合用户看到的那条视频
    const matched = adopted?.signature === request.signature
      ? adopted
      : versions.find(version => version.signature && version.signature === request.signature)
    if (matched) {
      result.push({
        ...base,
        status: 'unchanged',
        checked: false,
        selectable: true,
        matched_version_no: matched.version_no,
        adopted_version_no: adopted?.version_no ?? null,
      })
      continue
    }
    // 变化原因与“当前采用的版本”比较；采用版本缺字段/找不到时退回最新的可比较版本
    const comparable = adopted?.parts
      ? adopted
      : [...versions].reverse().find(version => version.parts) ?? null
    if (!comparable?.parts) {
      result.push({
        ...base,
        status: 'unknown',
        checked: false,
        selectable: true,
        adopted_version_no: adopted?.version_no ?? null,
        reason: '旧版本缺少对比信息，无法判断',
      })
      continue
    }
    result.push({
      ...base,
      status: 'changed',
      checked: true,
      selectable: true,
      adopted_version_no: adopted?.version_no ?? null,
      change_reasons: describeSignatureDiff(request.signatureParts, comparable.parts),
    })
  }
  return result
}

/**
 * 启动批量：目标必须是预览里明确勾选的分镜（唯一调用方是前端的预览清单）。
 * 不再做整集预检，只检查所选镜头；提交时再逐镜复查阻断（变为阻断的标 skipped，批次继续）。
 */
export async function startEpisodeVideoBatch(
  episodeId: number,
  opts: { storyboardIds: number[]; model?: string; configId?: number },
): Promise<VideoBatchStatus> {
  if (await loadRunningBatch(episodeId)) throw new Error('本集已有批量视频在运行')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')

  const storyboards = await listEpisodeStoryboards(episodeId)
  if (!storyboards.length) throw new Error('本集还没有分镜')
  if (!opts.storyboardIds?.length) throw new Error('没有需要生成的分镜')

  // 正在生成中的分镜不纳入批量，避免同一镜被重复提交
  const processingIds = await loadActiveStoryboardIds()
  const selected = storyboards.filter(sb => opts.storyboardIds.includes(sb.id))
  const targets = selected.filter(sb => !processingIds.has(sb.id))
  if (!targets.length) throw new Error('没有需要生成的分镜')

  // 预检：关键帧驱动视频必须由支持关键帧引导的模型生成（整批共用同一配置）
  const configId = opts.configId ?? episode.videoConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('video') : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  if (!getVideoAdapter(config.provider).supportsFrameGuides) {
    throw new Error(`当前视频模型不支持关键帧引导（${config.provider}），请改用 MiniMax-H3 等支持的模型`)
  }

  const items: VideoBatchItem[] = targets.map(sb => ({
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    state: 'pending',
    task_id: null,
    error: null,
  }))

  const ts = now()
  const res = await db.insert(schema.videoBatches).values({
    episodeId,
    status: 'running',
    options: JSON.stringify({ model: opts.model, configId: opts.configId }),
    items: JSON.stringify(items),
    createdAt: ts,
    updatedAt: ts,
  })
  const batchId = getInsertId(res)
  logTaskStart('VideoBatch', 'batch', {
    batchId,
    episodeId,
    total: items.length,
    model: opts.model || undefined,
  })
  void runBatch(batchId)
  const row = await loadBatch(batchId)
  return toStatus(row!)
}

/** 等待单镜的 sys_task 到达终态 */
async function waitForTask(taskId: number): Promise<{ ok: boolean; error: string | null }> {
  const deadline = Date.now() + ITEM_WAIT_TIMEOUT_MS
  for (;;) {
    // 与 generation.ts 的轮询同一写法（tsconfig target ES2022 不含 Promise.withResolvers 的类型）
    await new Promise(resolve => setTimeout(resolve, ITEM_POLL_INTERVAL_MS))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) return { ok: false, error: '生成任务记录丢失' }
    if (task.status === 'completed') return { ok: true, error: null }
    if (task.status === 'failed') return { ok: false, error: task.errorMsg || '生成失败' }
    if (Date.now() > deadline) return { ok: false, error: '等待生成超时' }
  }
}

/**
 * sys_task 置为 completed 与把视频写回 storyboards.video_url 是两条语句（generation.ts handleVideoComplete），
 * 中间有一次 await。下一镜承接时要读上一镜的采用视频，这里等这一镜的产物真正落到分镜上再推进。
 * 判定以任务终态为主（调用前已终态）、`video_url === 任务 local_path` 为辅：镜头本来就有旧视频时，
 * 只看“非空”会立刻返回，重生成场景下等于没等。用户中途手动切换采用版本时由超时兜底。
 */
async function waitForAdoptedVideo(taskId: number, storyboardId: number): Promise<void> {
  const deadline = Date.now() + ADOPT_WAIT_TIMEOUT_MS
  for (;;) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    const produced = task?.localPath || task?.resultUrl || null
    // 任务终态但没有产物路径（理论上不会发生）：无从比对，直接推进
    if (!produced) return
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
    if (sb?.videoUrl === produced || sb?.composedVideoUrl === produced) return
    if (Date.now() > deadline) {
      logTaskWarn('VideoBatch', 'adopt wait timeout', { storyboardId, taskId })
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
        logTaskWarn('VideoBatch', 'batch stopped', { batchId, status: row.status })
        return
      }
      const items = parseItems(row.items)
      const options = parseOptions(row.options)
      // 停止请求：在跑的那一镜已在上一轮 await 完并落盘，这里不再提交新的镜头
      if (options.cancelRequested) {
        await setBatchStatus(batchId, 'cancelled')
        logTaskWarn('VideoBatch', 'batch cancelled', { batchId, episodeId: row.episodeId })
        return
      }
      // pending 正常推进；running 只会出现在重启恢复时，重新提交那一镜
      const index = items.findIndex(item => item.state === 'pending' || item.state === 'running')
      if (index < 0) {
        await setBatchStatus(batchId, 'done')
        logTaskSuccess('VideoBatch', 'batch', {
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
      logTaskProgress('VideoBatch', 'shot submit', {
        batchId,
        storyboardId: item.storyboard_id,
        shotNumber: item.storyboard_number,
      })

      // 预览之后才变成阻断的镜头（关键帧被改动/提示词与绑定不一致）：标记 skipped，批次继续下一镜
      const blocked = await videoBlockReason(
        (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, item.storyboard_id)))[0]!,
        await loadEpisodeKeyframes(row.episodeId),
      )
      if (blocked) {
        item.state = 'skipped'
        item.error = `分镜 #${item.storyboard_number} ${blocked}`
      } else {
        try {
          const taskId = await submitStoryboardVideo(item.storyboard_id, options)
          item.task_id = taskId
          await saveItems(batchId, items)
          const result = await waitForTask(taskId)
          item.state = result.ok ? 'completed' : 'failed'
          item.error = result.error
          // 等这一镜的新视频写回分镜后再推进，下一镜承接读到的才是刚生成的那条
          if (result.ok) await waitForAdoptedVideo(taskId, item.storyboard_id)
        } catch (err) {
          item.state = 'failed'
          item.error = err instanceof Error ? err.message : '生成失败'
        }
      }

      if (item.state === 'failed') {
        logTaskError('VideoBatch', 'shot', {
          batchId,
          storyboardId: item.storyboard_id,
          shotNumber: item.storyboard_number,
          error: item.error,
        })
      } else {
        logTaskSuccess('VideoBatch', 'shot', {
          batchId,
          storyboardId: item.storyboard_id,
          shotNumber: item.storyboard_number,
          taskId: item.task_id,
        })
      }
      await saveItems(batchId, items)
    }
  } catch (err) {
    logTaskError('VideoBatch', 'batch', { batchId, error: err instanceof Error ? err.message : String(err) })
    // runner 异常退出：转为 cancelled，释放本集互斥位（已提交的镜头不受影响）
    await setBatchStatus(batchId, 'cancelled').catch(() => {})
  } finally {
    activeRunners.delete(batchId)
  }
}

/** 启动时恢复被重启打断的批次：状态仍为 running 的批次继续跑，中断的那一镜重新提交 */
export async function resumeVideoBatches(): Promise<void> {
  try {
    const rows = await db.select().from(schema.videoBatches)
      .where(eq(schema.videoBatches.status, 'running'))
    for (const row of rows) {
      const interrupted = parseItems(row.items).find(item => item.state === 'running')
      logTaskProgress('VideoBatch', 'resume', {
        batchId: row.id,
        episodeId: row.episodeId,
        // 上游可能仍在跑同一镜，这里接受重复生成
        resubmitStoryboardId: interrupted?.storyboard_id ?? null,
      })
      void runBatch(row.id)
    }
  } catch (err) {
    logTaskError('VideoBatch', 'resume', { error: err instanceof Error ? err.message : String(err) })
  }
}
