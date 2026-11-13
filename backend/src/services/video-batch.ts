/**
 * 服务端批量视频生成 — 脱离浏览器，两种驱动方式：
 *
 * - 并发（视频配置是 h3-jobs 队列，Issue #100）：勾选镜头逐个组装（含转场审核）后立即提交，
 *   每提交一镜就落盘 sys_task id，之后只跟踪各任务状态，由队列调度两张卡。同批次镜头的输入互不依赖
 *   （承接镜首帧取上一镜尾帧**关键帧图**，不读上一镜视频），所以一次性提交是安全的。
 *   重启后按落盘的 task_id 续跟，绝不重复提交；停止 = 取消仍在排队的镜头、运行中的跑完。
 * - 串行（其它 provider）：提交 → 等待 sys_task 终态 → 下一镜；重启时被中断的那一镜重新提交
 *   （这些 provider 的任务已被启动清扫判失败，无法续跟）。
 *
 * 每一镜在提交前再复查一次阻断（关键帧确认、提示词一致性）。批次状态持久化在 video_batches。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { videoCapabilities } from './adapters/registry'
import { loadEpisodeKeyframes, type StoryboardKeyframeState } from './keyframes.js'
import {
  buildStoryboardVideoRequest,
  describeSignatureDiff,
  listEpisodeStoryboards,
  loadVideoVersions,
  submitStoryboardVideo,
  type StoryboardVideoRequest,
} from './storyboard-video.js'
import { isActiveTaskStatus, isH3JobsTask } from './sys-task.js'
import { cancelVideoTask } from './h3-jobs.js'
import { blockingIssuesFor, checkStoryboardRefs, describeIssues } from './storyboard-assets.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { transitionStatus } from './transition.js'
import { scopeFromPreview, type BatchScope } from './batch-scope.js'
import { resolveDramaProjectType } from './project-type.js'
import { getLayerSegment, resolveEpisodeSegmentSpec } from './layer-segment.js'
import { baseCheckBlockReason } from './layer-base-check.js'

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
  /** 已请求停止：不再提交新的镜头；并发批次另取消仍在排队的镜头。运行中的跑完后批次转为 cancelled */
  cancel_requested: boolean
  items: VideoBatchItem[]
  scope: BatchScope
}

interface BatchOptions {
  model?: string
  configId?: number
  /** 停止请求随批次持久化：重启恢复后仍然生效 */
  cancelRequested?: boolean
  scope?: BatchScope
  /** 并发驱动（h3-jobs 队列）：启动时按配置冻结，重启恢复沿用同一驱动方式 */
  parallel?: boolean
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
    scope: parseOptions(row.options).scope ?? { included: items.map(({ storyboard_id, storyboard_number }) => ({ storyboard_id, storyboard_number })), excluded: [] },
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

/** 停止：不再提交新的镜头；并发批次还会取消仍在排队的镜头。运行中的继续跑完，之后批次转为 cancelled */
export async function cancelEpisodeVideoBatch(episodeId: number): Promise<VideoBatchStatus> {
  const running = await loadRunningBatch(episodeId)
  if (!running) throw new Error('本集没有正在运行的批量视频任务')
  const options = parseOptions(running.options)
  await db.update(schema.videoBatches)
    .set({ options: JSON.stringify({ ...options, cancelRequested: true }), updatedAt: now() })
    .where(eq(schema.videoBatches.id, running.id))
  logTaskWarn('VideoBatch', 'cancel', { batchId: running.id, episodeId })
  // 批次项只由 runner 写：停止请求在 runner 的下一拍生效。没有 runner 在驱动（异常退出）时：
  // 并发批次拉起 runner 去取消排队项并收尾；串行批次直接落盘 cancelled，避免永远占着本集的互斥位
  if (!activeRunners.has(running.id)) {
    if (options.parallel) void runParallelBatch(running.id)
    else await setBatchStatus(running.id, 'cancelled')
  }
  const row = await loadBatch(running.id)
  return toStatus(row!)
}

export interface VideoPreviewItem {
  storyboard_id: number
  storyboard_number: number
  /**
   * missing=无视频 changed=与所有可比较版本不同 unchanged=命中历史签名 unknown=历史版本缺字段
   * blocked=阻断 skipped=不可生成
   * excluded=未启用生成段
   */
  status: 'missing' | 'changed' | 'unchanged' | 'unknown' | 'blocked' | 'skipped' | 'excluded'
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

/**
 * 底图视觉验证（Issue #94）：裁切/留白的底图没过验证就不能往下走。
 * A 组合没有生成段，但那张底图就是整镜画面，同样要拦，所以这一条单独拿出来给预览循环用。
 */
async function layerBaseCheckReason(sb: typeof schema.storyboards.$inferSelect): Promise<string | null> {
  const segment = await getLayerSegment(sb.id)
  if (!segment) return null
  return baseCheckBlockReason(segment, await resolveEpisodeSegmentSpec(sb.episodeId))
}

/** 某镜此刻是否被阻断（底图视觉验证 / 关键帧未确认 / 视频提示词与绑定不一致）；可生成时返回 null */
async function videoBlockReason(
  sb: typeof schema.storyboards.$inferSelect,
  keyframes: Map<number, StoryboardKeyframeState>,
): Promise<string | null> {
  if (!sb || sb.deletedAt) return '镜头不存在'
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (resolveDramaProjectType(ep?.dramaId) === 'documentary') {
    if (!sb.combo || sb.designCardStatus !== 'confirmed') return '设计卡未确认'
  }
  // 排在关键帧之前：衔接帧不可用的真实原因是底图没过验证，
  // 只报「关键帧尚未确认」会把人引到错误的修复动作上。
  const baseReason = await layerBaseCheckReason(sb)
  if (baseReason) return baseReason
  if (resolveDramaProjectType(ep?.dramaId) === 'documentary' && sb.combo === 'A') return '未启用生成段'
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
  const targets = opts.storyboardIds !== undefined
    ? storyboards.filter(sb => opts.storyboardIds!.includes(sb.id))
    : storyboards

  const result: VideoPreviewItem[] = []
  for (const sb of targets) {
    const base = { storyboard_id: sb.id, storyboard_number: sb.storyboardNumber }
    // 底图没过验证的镜头先于「A 组合无生成段」报出来：A 的那张底图就是整镜画面
    const baseBlocked = await layerBaseCheckReason(sb)
    if (baseBlocked) {
      result.push({ ...base, status: 'blocked', checked: false, selectable: false, reason: baseBlocked })
      continue
    }
    if (sb.combo === 'A') {
      result.push({ ...base, status: 'excluded', checked: false, selectable: false, reason: 'no_generated_segment' })
      continue
    }
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

  const preview = await previewEpisodeVideoBatch(episodeId, { model: opts.model, configId: opts.configId })
  const scope = videoBatchScopeOf(preview, opts.storyboardIds)
  const included = new Set(scope.included.map(item => item.storyboard_id))
  const targets = storyboards.filter(sb => included.has(sb.id) && opts.storyboardIds.includes(sb.id))
  if (!targets.length) throw new Error('没有需要生成的分镜')

  // 预检：关键帧驱动视频必须由支持关键帧引导的模型生成（整批共用同一配置）
  const configId = opts.configId ?? episode.videoConfigId ?? undefined
  const config = configId ? (await getConfigById(configId)) ?? await getActiveConfig('video') : await getActiveConfig('video')
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  if (!videoCapabilities(config.provider).supportsFrameGuides) {
    throw new Error(`当前视频模型不支持关键帧引导（${config.provider}），请改用 MiniMax-H3 等支持的模型`)
  }
  const parallel = isH3JobsTask(config.provider)

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
    options: JSON.stringify({ model: opts.model, configId: opts.configId, scope, parallel }),
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
    parallel,
  })
  if (parallel) void runParallelBatch(batchId)
  else void runBatch(batchId)
  const row = await loadBatch(batchId)
  return toStatus(row!)
}

export function videoBatchScopeOf(items: VideoPreviewItem[], selectedIds?: number[]): BatchScope {
  return scopeFromPreview(items.map(item => ({
    ...item,
    reason: item.status === 'unchanged' ? 'unchanged'
      : item.status === 'skipped' ? 'generating'
      : item.reason === '关键帧尚未确认' ? 'keyframes_unconfirmed' : item.reason,
  })), selectedIds)
}

export async function retryFailedVideoBatch(episodeId: number): Promise<VideoBatchStatus> {
  const latest = await getEpisodeVideoBatch(episodeId)
  if (!latest) throw new Error('没有可重试的批次')
  const ids = latest.items.filter(item => item.state === 'failed' || item.state === 'skipped').map(item => item.storyboard_id)
  if (!ids.length) throw new Error('没有失败项可重试')
  const row = await loadBatch(latest.id)
  const options = parseOptions(row?.options)
  return startEpisodeVideoBatch(episodeId, { storyboardIds: ids, model: options.model, configId: options.configId })
}

export async function previewFailedVideoBatch(episodeId: number) {
  const previous = await getEpisodeVideoBatch(episodeId)
  if (!previous) throw new Error('没有可重试的视频批次')
  const row = await loadBatch(previous.id)
  const options = parseOptions(row?.options)
  const ids = previous.items.filter(item => item.state === 'failed' || item.state === 'skipped').map(item => item.storyboard_id)
  const items = await previewEpisodeVideoBatch(episodeId, { model: options.model, configId: options.configId })
  const scope = videoBatchScopeOf(items, ids)
  const included = new Set(scope.included.map(item => item.storyboard_id))
  return { items: items.map(item => ({ ...item, checked: included.has(item.storyboard_id) })), scope }
}

/** 等待单镜的 sys_task 到达终态 */
async function waitForTask(taskId: number): Promise<{ ok: boolean; error: string | null }> {
  const deadline = Date.now() + ITEM_WAIT_TIMEOUT_MS
  for (;;) {
    // 与 generation.ts 的轮询同一写法（tsconfig target ES2022 不含 Promise.withResolvers 的类型）
    await new Promise(resolve => setTimeout(resolve, ITEM_POLL_INTERVAL_MS))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    const outcome = taskOutcome(task)
    if (outcome) return outcome
    if (Date.now() > deadline) return { ok: false, error: '等待生成超时' }
  }
}

/**
 * sys_task → 批次项结局；仍活跃返回 null。单镜被用户取消的任务按 failed + 「已取消」记
 * （不新增项状态枚举），批次继续其它镜，失败重试会把它带上。
 */
function taskOutcome(task: typeof schema.sysTask.$inferSelect | undefined): { ok: boolean; error: string | null } | null {
  if (!task) return { ok: false, error: '生成任务记录丢失' }
  if (task.status === 'completed') return { ok: true, error: null }
  if (task.status === 'failed') return { ok: false, error: task.errorMsg || '生成失败' }
  if (task.status === 'cancelled') return { ok: false, error: '已取消' }
  return null
}

/**
 * sys_task 置为 completed 与把视频写回 storyboards.video_url 是两条语句（generation.ts handleVideoComplete），
 * 中间有一次 await。这里等这一镜的产物真正落到分镜上再把该项记为完成，批次进度与分镜视频保持一致。
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

/** 串行驱动一个批次直到完成/取消（非队列 provider）；进程内同一批次只有一个 runner */
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
          // 等这一镜的新视频写回分镜后再推进，该项「已完成」与分镜上的视频一致
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

/**
 * 并发驱动（h3-jobs 队列）：按镜号依次组装并提交全部待生成镜头，每提交一镜立即落盘 task_id；
 * 之后每拍把 sys_task 状态折算到批次项。项只由本 runner 写（停止接口只改 options）。
 * 停止：不再提交新镜，并取消 sys_task 仍在排队的镜头；运行中的跑完后批次转 cancelled。
 */
async function runParallelBatch(batchId: number): Promise<void> {
  if (activeRunners.has(batchId)) return
  activeRunners.add(batchId)
  try {
    for (;;) {
      const row = await loadBatch(batchId)
      if (!row || row.status !== 'running') return
      const items = parseItems(row.items)

      // 提交：每镜之前重新读停止标记，提交成功立刻落盘 task_id（重启后据此续跟、不重复提交）
      for (const item of items) {
        if (item.state !== 'pending') continue
        const fresh = await loadBatch(batchId)
        if (!fresh || fresh.status !== 'running' || parseOptions(fresh.options).cancelRequested) break
        const blocked = await videoBlockReason(
          (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, item.storyboard_id)))[0]!,
          await loadEpisodeKeyframes(row.episodeId),
        )
        if (blocked) {
          item.state = 'skipped'
          item.error = `分镜 #${item.storyboard_number} ${blocked}`
        } else {
          try {
            item.task_id = await submitStoryboardVideo(item.storyboard_id, parseOptions(row.options))
            item.state = 'running'
            item.error = null
            logTaskProgress('VideoBatch', 'shot submit', {
              batchId, storyboardId: item.storyboard_id, shotNumber: item.storyboard_number, taskId: item.task_id,
            })
          } catch (err) {
            item.state = 'failed'
            item.error = err instanceof Error ? err.message : '生成失败'
            logTaskError('VideoBatch', 'shot', {
              batchId, storyboardId: item.storyboard_id, shotNumber: item.storyboard_number, error: item.error,
            })
          }
        }
        await saveItems(batchId, items)
      }

      // 停止：取消仍在排队（sys_task queued）的镜头；运行中的跑完
      const cancelRequested = parseOptions((await loadBatch(batchId))?.options).cancelRequested
      if (cancelRequested) {
        for (const item of items) {
          if (item.state !== 'running' || item.task_id == null) continue
          const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.task_id))
          if (task?.status !== 'queued') continue
          await cancelVideoTask(item.task_id).catch(err => {
            logTaskWarn('VideoBatch', 'cancel queued shot failed', {
              batchId, taskId: item.task_id, error: err instanceof Error ? err.message : String(err),
            })
          })
        }
      }

      // 跟踪：sys_task 终态 → 批次项。running 却没有 task_id 只会出现在「提交途中重启」：退回 pending 重新提交
      for (const item of items) {
        if (item.state !== 'running') continue
        if (item.task_id == null) {
          item.state = 'pending'
          continue
        }
        const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.task_id))
        const outcome = taskOutcome(task)
        if (!outcome) continue
        if (outcome.ok) await waitForAdoptedVideo(item.task_id, item.storyboard_id)
        item.state = outcome.ok ? 'completed' : 'failed'
        item.error = outcome.error
        if (outcome.ok) logTaskSuccess('VideoBatch', 'shot', { batchId, storyboardId: item.storyboard_id, taskId: item.task_id })
        else logTaskError('VideoBatch', 'shot', { batchId, storyboardId: item.storyboard_id, taskId: item.task_id, error: item.error })
      }
      await saveItems(batchId, items)

      if (!items.some(item => item.state === 'running')) {
        if (cancelRequested) {
          await setBatchStatus(batchId, 'cancelled')
          logTaskWarn('VideoBatch', 'batch cancelled', { batchId, episodeId: row.episodeId })
          return
        }
        if (!items.some(item => item.state === 'pending')) {
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
      }
      await sleep(ITEM_POLL_INTERVAL_MS)
    }
  } catch (err) {
    logTaskError('VideoBatch', 'batch', { batchId, error: err instanceof Error ? err.message : String(err) })
    // runner 异常退出：转为 cancelled，释放本集互斥位（已提交的镜头由追踪器继续跟完）
    await setBatchStatus(batchId, 'cancelled').catch(() => {})
  } finally {
    activeRunners.delete(batchId)
  }
}

/**
 * 启动时恢复被重启打断的批次：状态仍为 running 的批次按启动时冻结的驱动方式继续。
 * 并发批次按落盘的 task_id 续跟（任务由 h3-jobs 追踪器继续推进），不重复提交；
 * 串行批次被中断的那一镜重新提交（其任务已被启动清扫判失败）。
 */
export async function resumeVideoBatches(): Promise<void> {
  try {
    const rows = await db.select().from(schema.videoBatches)
      .where(eq(schema.videoBatches.status, 'running'))
    for (const row of rows) {
      const parallel = !!parseOptions(row.options).parallel
      const interrupted = parseItems(row.items).filter(item => item.state === 'running')
      logTaskProgress('VideoBatch', 'resume', {
        batchId: row.id,
        episodeId: row.episodeId,
        parallel,
        ...(parallel
          ? { trackedTaskIds: interrupted.map(item => item.task_id) }
          : { resubmitStoryboardId: interrupted[0]?.storyboard_id ?? null }),
      })
      if (parallel) void runParallelBatch(row.id)
      else void runBatch(row.id)
    }
  } catch (err) {
    logTaskError('VideoBatch', 'resume', { error: err instanceof Error ? err.message : String(err) })
  }
}
