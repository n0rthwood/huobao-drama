/**
 * 图片队列估计 —— 批量确认框等待时间提示的唯一数据源（来自 qwen-jobs 实测）。
 * 单张秒数走 /v1/estimate，当前等待与在线卡数走 /v1/capacity；
 * 整批 = 当前等待 + ⌈张数 / 在线卡数⌉ × 单张。卡全部离线时没有估计。
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { isQwenJobsTask } from '../services/sys-task.js'
import { getQwenCapacity, getQwenEstimate, isFluxJobsConfig, pickQwenSize, type QwenJobMode } from '../services/adapters/qwen-jobs-client.js'

const app = new Hono()

// GET /image-queue/estimate?config_id=&size=WxH&references=&count=
app.get('/estimate', async (c) => {
  const configIdRaw = c.req.query('config_id')
  const configId = configIdRaw ? Number(configIdRaw) : undefined
  const config = configId
    ? (await getConfigById(configId)) ?? await getActiveConfig('image')
    : await getActiveConfig('image')
  if (!config) return badRequest(c, '未配置图片模型，请先到「设置」页添加并启用 AI 服务')
  if (!isQwenJobsTask(config.provider)) return success(c, { supported: false })

  const references = Math.max(0, Number(c.req.query('references') || 0))
  const count = Math.max(1, Number(c.req.query('count') || 1))
  const size = c.req.query('size')
  // 有参考图且指定画幅 = 关键帧（reference_to_image）；只有参考图 = 角色/道具编辑
  // FLUX 服务不支持 image_edit：估计与提交一样按 reference_to_image（默认 1024²）算
  let mode: QwenJobMode = !references ? 'text_to_image' : size ? 'reference_to_image' : 'image_edit'
  if (isFluxJobsConfig(config) && mode === 'image_edit') mode = 'reference_to_image'
  const [width, height] = pickQwenSize(mode === 'reference_to_image' && !size ? '1024x1024' : size)

  try {
    const [estimate, capacity] = await Promise.all([
      getQwenEstimate(config, mode === 'image_edit'
        ? { mode, references }
        : { mode, width, height, references }),
      getQwenCapacity(config),
    ])
    const onlineWorkers = Math.max(0, capacity.total - capacity.offline)
    const queueWait = estimate.queue_wait_seconds ?? capacity.estimated_wait_seconds ?? 0
    return success(c, {
      supported: true,
      per_image_seconds: estimate.run_seconds,
      basis: estimate.basis,
      queue_wait_seconds: queueWait,
      online_workers: onlineWorkers,
      total_seconds: onlineWorkers ? queueWait + Math.ceil(count / onlineWorkers) * estimate.run_seconds : null,
    })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '获取生成时间估计失败')
  }
})

export default app
