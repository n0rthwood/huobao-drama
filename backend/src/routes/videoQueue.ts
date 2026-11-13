/**
 * 视频队列估计与概览 —— 视频工单「预计完成/总耗时」与「谁在生成/谁在排队」的唯一数据源。
 * - 本地样本 provider（comfyui 直连 / minimax）：近 30 天 type='video' AND status='completed' 的 sys_task，
 *   elapsed = completed_at - created_at（墙钟，含排队/上传/下载），时长取 params.duration（Issue #28）。
 * - h3-jobs 队列（Issue #100）：估计与排队全部由队列给出（按时长四舍五入到秒分桶的实测均值 + 双卡仿真），
 *   火宝只透传展示，不本地重算。
 */
import { Hono } from 'hono'
import { and, eq, isNotNull, gte, sql } from 'drizzle-orm'
import { success, badRequest } from '../utils/response.js'
import { getActiveConfig, getConfigById, type AIConfig } from '../services/ai.js'
import { db, schema } from '../db/index.js'
import { configModelList, selectVideoEstimate, type VideoEstimateSample } from '../services/video-estimate.js'
import { getH3Estimate, getH3Queue, type H3QueueEntry, type H3QueueOverview } from '../services/adapters/h3-jobs-client.js'
import { pickResolution } from '../services/video-resolution.js'
import { isH3JobsTask } from '../services/sys-task.js'

const app = new Hono()

/** 有本地实测样本的视频 provider */
const SAMPLED_PROVIDERS: Record<string, true> = { comfyui: true, minimax: true }

async function resolveVideoConfig(configIdRaw: string | undefined): Promise<AIConfig | null> {
  const configId = configIdRaw ? Number(configIdRaw) : undefined
  return configId
    ? (await getConfigById(configId)) ?? await getActiveConfig('video')
    : await getActiveConfig('video')
}

/** 近 30 天样本窗口（ISO 文本可直接字典序比较） */
function sampleWindowStart(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
}

export function loadVideoEstimateSamples(): VideoEstimateSample[] {
  const rows = db
    .select({
      provider: schema.sysTask.provider,
      model: schema.sysTask.model,
      createdAt: schema.sysTask.createdAt,
      completedAt: schema.sysTask.completedAt,
      durationSeconds: sql<number>`json_extract(${schema.sysTask.params}, '$.duration')`,
    })
    .from(schema.sysTask)
    .where(and(
      eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.status, 'completed'),
      isNotNull(schema.sysTask.completedAt),
      gte(schema.sysTask.createdAt, sampleWindowStart()),
      sql`json_valid(${schema.sysTask.params})`,
      sql`json_extract(${schema.sysTask.params}, '$.duration') > 0`,
    ))
    .all()

  const samples: VideoEstimateSample[] = []
  for (const row of rows) {
    // 异常行（时间缺失/倒挂、时长非法）跳过，不抛错
    const created = Date.parse(row.createdAt)
    const completed = Date.parse(row.completedAt ?? '')
    const elapsedSeconds = (completed - created) / 1000
    const durationSeconds = Number(row.durationSeconds)
    if (!Number.isFinite(created) || !Number.isFinite(completed) || elapsedSeconds <= 0 || !(durationSeconds > 0)) continue
    if (!row.provider || !row.model) continue
    samples.push({ provider: row.provider, model: row.model, durationSeconds, elapsedSeconds })
  }
  return samples
}

// GET /video-queue/estimate?config_id=&model=&duration=[&resolution=&aspect=&references=]
app.get('/estimate', async (c) => {
  const duration = Number(c.req.query('duration'))
  if (!Number.isFinite(duration) || duration <= 0) return badRequest(c, 'duration 必须为正数（秒）')

  const config = await resolveVideoConfig(c.req.query('config_id'))
  const provider = (config?.provider || '').toLowerCase()
  // 生效模型来自前端选择，但必须属于该配置的模型列表（配置可挂多个模型，AIConfig.model 只带首个）
  const [row] = config?.id
    ? await db.select({ model: schema.aiServiceConfigs.model }).from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.id, config.id))
    : []
  const models = configModelList(row ?? null)
  const requested = c.req.query('model')
  const requestedModel = requested && models.includes(requested) ? requested : (models[0] || '')

  if (config && isH3JobsTask(provider)) {
    // 与提交同一口径：4–15 的整数秒、项目档位 + 画幅的尺寸；有参考图即参考图模式（视频页恒有首帧参考）
    const durationS = Math.min(15, Math.max(4, Math.round(duration)))
    const references = Math.max(0, Math.floor(Number(c.req.query('references') || 0)))
    try {
      const [width, height] = pickResolution(c.req.query('resolution'), c.req.query('aspect'))
      const estimate = await getH3Estimate(config, {
        mode: references ? 'reference' : 't2v',
        durationSeconds: durationS,
        width,
        height,
        references,
      })
      return success(c, {
        supported: true,
        provider,
        requested_model: requestedModel,
        source_model: null,
        duration: durationS,
        duration_key: estimate.duration_key,
        run_seconds: estimate.run_seconds,
        samples: estimate.samples,
        basis: estimate.basis,
        queue_wait_seconds: estimate.queue_wait_seconds,
        estimated_finish_seconds: estimate.estimated_finish_seconds,
      })
    } catch {
      // 队列不可达：前端回落「暂无预估」
      return success(c, { ...selectVideoEstimate([], provider, requestedModel, duration), supported: false })
    }
  }

  if (!config || !SAMPLED_PROVIDERS[provider]) {
    return success(c, selectVideoEstimate([], provider, requestedModel, duration))
  }
  return success(c, selectVideoEstimate(loadVideoEstimateSamples(), provider, requestedModel, duration))
})

/**
 * GET /video-queue/overview?config_id= —— 队列整体「运行/排队/空闲卡/新任务预计等待」+ 火宝自己的明细。
 * 其他客户端的条目只计入总数（队列对他人只给形状不给 job id）。非队列配置或队列不可达 → available:false。
 */
app.get('/overview', async (c) => {
  const config = await resolveVideoConfig(c.req.query('config_id'))
  if (!config || !isH3JobsTask(config.provider)) return success(c, { available: false, reason: 'not_queue' })
  let queue: H3QueueOverview
  try {
    queue = await getH3Queue(config)
  } catch (err) {
    return success(c, { available: false, reason: 'unreachable', error: err instanceof Error ? err.message : String(err) })
  }
  const mineIds = [...queue.running, ...queue.queued].filter(entry => entry.mine && entry.job_id).map(entry => entry.job_id as string)
  const tasks = mineIds.length
    ? (await db.select({ id: schema.sysTask.id, taskId: schema.sysTask.taskId, storyboardId: schema.sysTask.storyboardId })
      .from(schema.sysTask).where(eq(schema.sysTask.type, 'video'))).filter(task => task.taskId && mineIds.includes(task.taskId))
    : []
  const mine = (entries: H3QueueEntry[]) => entries.filter(entry => entry.mine).map(entry => {
    const task = tasks.find(row => row.taskId === entry.job_id)
    return { ...entry, sys_task_id: task?.id ?? null, storyboard_id: task?.storyboardId ?? null }
  })
  return success(c, {
    available: true,
    counts: queue.counts,
    workers: queue.workers,
    estimated_wait_seconds: queue.estimated_wait_seconds,
    mine: { running: mine(queue.running), queued: mine(queue.queued) },
  })
})

export default app
