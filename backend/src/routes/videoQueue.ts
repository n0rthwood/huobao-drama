/**
 * 视频队列估计（Issue #28）——视频工单「预计完成/总耗时」的唯一数据源。
 * 样本取近 30 天 type='video' AND status='completed' 的 sys_task，
 * elapsed = completed_at - created_at（墙钟，含排队/上传/下载），时长取 params.duration。
 */
import { Hono } from 'hono'
import { and, eq, isNotNull, gte, sql } from 'drizzle-orm'
import { success, badRequest } from '../utils/response.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { db, schema } from '../db/index.js'
import { configModelList, selectVideoEstimate, type VideoEstimateSample } from '../services/video-estimate.js'

const app = new Hono()

/** 有本地实测样本的视频 provider */
const SAMPLED_PROVIDERS: Record<string, true> = { comfyui: true, minimax: true }

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

// GET /video-queue/estimate?config_id=&model=&duration=
app.get('/estimate', async (c) => {
  const duration = Number(c.req.query('duration'))
  if (!Number.isFinite(duration) || duration <= 0) return badRequest(c, 'duration 必须为正数（秒）')

  const configIdRaw = c.req.query('config_id')
  const configId = configIdRaw ? Number(configIdRaw) : undefined
  const config = configId
    ? (await getConfigById(configId)) ?? await getActiveConfig('video')
    : await getActiveConfig('video')
  const provider = (config?.provider || '').toLowerCase()
  // 生效模型来自前端选择，但必须属于该配置的模型列表（配置可挂多个模型，AIConfig.model 只带首个）
  const [row] = config?.id
    ? await db.select({ model: schema.aiServiceConfigs.model }).from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.id, config.id))
    : []
  const models = configModelList(row ?? null)
  const requested = c.req.query('model')
  const requestedModel = requested && models.includes(requested) ? requested : (models[0] || '')
  if (!config || !SAMPLED_PROVIDERS[provider]) {
    return success(c, selectVideoEstimate([], provider, requestedModel, duration))
  }

  return success(c, selectVideoEstimate(loadVideoEstimateSamples(), provider, requestedModel, duration))
})

export default app
