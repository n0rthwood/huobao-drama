import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import imageQueue from './routes/imageQueue.js'
import videoQueue from './routes/videoQueue.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import mapWorkflow from './routes/map-workflow.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import assetLibrary from './routes/asset-library.js'
import mediaLibrary from './routes/media-library.js'
import research from './routes/research.js'
import posters from './routes/posters.js'
import layerDocs from './routes/layer-docs.js'
import layerSegments from './routes/layer-segments.js'
import assetPipeline from './routes/asset-pipeline.js'
import designCards, { designCardShots } from './routes/design-cards.js'
import { episodeAssetReview, assetReviewItems } from './routes/asset-review.js'
import scriptRewrite from './routes/script-rewrite.js'
import narrationSkeleton from './routes/narration-skeleton.js'
import { TtsRequiredError } from './services/narration-tts-gate.js'
import { SkeletonNotConfirmedError } from './services/narration-skeleton.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { db, schema } from './db/index.js'
import { and, eq, isNull, ne, notInArray, or } from 'drizzle-orm'
import { now } from './utils/response.js'
import { DATA_ROOT } from './utils/paths.js'
import { resumeVideoBatches } from './services/video-batch.js'
import { resumeKeyframeBatches } from './services/keyframe-batch.js'
import { resumeAssetPipelines } from './services/asset-pipeline/run.js'
import { startQwenJobsTracker } from './services/qwen-jobs.js'
import { startH3JobsTracker } from './services/h3-jobs.js'
import { JOB_QUEUE_PROVIDERS } from './services/adapters/registry.js'
import { backfillTaskEpisodeIds, failInterruptedTextTasks } from './services/task-center.js'
import { resumeQueuedTextTasks } from './services/text-task-restart.js'
import { freezeInterruptedObservations } from './services/task-observability.js'
import { releaseInterruptedDesignCardShots } from './services/design-card-batch.js'
import { failInterruptedRewriteRuns } from './services/script-rewrite/run.js'
import { failInterruptedMapWorkflows } from './services/map-workflow/run.js'
import { backfillGeneratedAt } from './services/media-time.js'
import { migrateReferenceImages } from './services/reference-images.js'
import { migrateAssetNames } from './services/asset-name-migration.js'
import { migrateIntentToDesignCard } from './services/design-card-migration.js'
import { migrateClipsToLayerSegments } from './services/layer-segment-migration.js'
import { backfillPoolProjection } from './services/storyboard-assets.js'
import { logLayerFontStatus } from './services/layer-fonts.js'
import { backfillScriptConfirmation, GateBlockedError } from './services/workflow-gates.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// 步骤门禁（#54）统一出口：任何路由里 assertGate 失败都在这里转成 400 {error, gate, reason}，
// 各路由不自己 try/catch，避免响应形状漂移。其余异常仍由 errorHandler 处理。
app.onError((err, c) => {
  if (err instanceof GateBlockedError) {
    return c.json({ code: 400, error: 'gate_blocked', gate: err.gate, reason: err.reason, message: err.reason }, 400)
  }
  if (err instanceof TtsRequiredError) {
    return c.json({ code: 400, error: 'tts_required', message: err.message, blocked: err.blocked }, 400)
  }
  if (err instanceof SkeletonNotConfirmedError) {
    return c.json({ code: 400, error: 'skeleton_unconfirmed', message: err.message }, 400)
  }
  console.error(err.stack || err.message || err)
  return c.json({ code: 500, message: err.message || 'Internal Server Error' }, 500)
})

// Health check（version 供部署巡检/更新检查核对当前运行版本）
app.get('/api/v1/health', (c) => c.json({
  status: 'ok',
  version: process.env.HUOBAO_VERSION || undefined,
  timestamp: new Date().toISOString(),
}))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/episodes', posters)
api.route('/episodes', designCards)
api.route('/episodes', episodeAssetReview)
api.route('/episodes', scriptRewrite)
api.route('/episodes', narrationSkeleton)
api.route('/storyboards', storyboards)
api.route('/storyboards', designCardShots)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/image-queue', imageQueue)
api.route('/video-queue', videoQueue)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
// 地图资产工作流（#84）：/props/:id/map-workflow/*，与道具路由同前缀、分文件
api.route('/props', mapWorkflow)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)
api.route('/asset-library', assetLibrary)
api.route('/media-library', mediaLibrary)
api.route('/research', research)
api.route('/layer-docs', layerDocs)
api.route('/layer-segments', layerSegments)
api.route('/asset-pipeline', assetPipeline)
api.route('/asset-review', assetReviewItems)

app.route('/api/v1', api)

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))

// release 产物每次文件名带 hash，但 index.html 必须立刻生效：HTML 一律 no-store，
// 避免浏览器拿旧 index.html 去请求已删除的 /_nuxt/* 资源。
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('content-type')?.includes('text/html')) {
    c.header('Cache-Control', 'no-store')
  }
})

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)
// 进程重启后内存中的轮询线程全部丢失,残留的 processing 任务永远不会完成,
// 启动时统一标记为 failed,避免前端一直显示"生成中"。
// 任务队列（图片 qwen-jobs / 视频 h3-jobs）的任务由服务端排队执行，重启不影响它们：交给各自追踪器按远端 id 继续跟。
db.update(schema.sysTask)
  .set({ status: 'failed', errorMsg: '服务重启，生成任务中断，请重试', updatedAt: now() })
  .where(and(
    eq(schema.sysTask.status, 'processing'),
    ne(schema.sysTask.type, 'text'),
    or(isNull(schema.sysTask.provider), notInArray(schema.sysTask.provider, [...JOB_QUEUE_PROVIDERS])),
  ))
  .then(res => {
    const affected = res?.changes ?? 0
    if (affected > 0) console.log(`🔁 已清理 ${affected} 个中断的生成任务`)
  })
  .catch(err => console.error('清理中断任务失败:', err?.message))
  // 文本任务（提取 / 提示词批量 / 剧本改写 / 拆分分镜）的执行线程同样随重启丢失，标记为失败供一键重试
  .then(() => failInterruptedTextTasks())
  // 在飞的观测调用（#87）：标中断并把耗时冻结到最后一次持久心跳，不拿重启时刻当结束时间
  .then(() => freezeInterruptedObservations())
  // 被重启打断的设计卡镜（#87）：ai_filling 永远卡死会让后续 PUT/确认一律 409，
  // 按已落盘事实释放（已保存→pending，未保存→任务里记录的原状态），不补跑、不改卡
  .then(() => releaseInterruptedDesignCardShots())
  .then(n => { if (n > 0) console.log(`🔓 已释放 ${n} 个被中断的设计卡镜`) })
  .then(() => failInterruptedRewriteRuns())
  // 地图工作流（#84）：running 的工作流标失败并说明原因，产出保留，绝不自动重放模型与出图
  .then(() => failInterruptedMapWorkflows())
  .then(() => resumeQueuedTextTasks())
  // 存量任务补归属集：全局任务中心按剧/集筛选与编号
  .then(() => backfillTaskEpisodeIds())
  // 存量媒体补生成时间（unix 秒，按 completed_at || created_at），幂等
  .then(() => backfillGeneratedAt())
  // 参考图存储结构迁移：字符串路径 → { path, uploaded_at }，幂等
  .then(() => migrateReferenceImages())
  // 资产名规范化迁移（Issue #34）：非法名改成合法名并重写分镜 @引用，幂等
  .then(() => migrateAssetNames())
  // 表达设计 → 分镜设计卡（Issue #57）：按行转换 combo/design_card 后自行 DROP COLUMN intent，幂等
  .then(() => migrateIntentToDesignCard())
  // 图层段迁移（Issue #58）必须在 design-card 迁移之后：后者回填 storyboards.combo，
  // 本迁移据此判断「有 clip 行但 combo 为空」→ stale_reasons=['combo_missing']
  .then(() => migrateClipsToLayerSegments())
  // 本镜资产池投影补齐（Issue #43）：角色/道具关联 = 手选 ∪ 当前 @，幂等
  .then(() => backfillPoolProjection())
  // 存量纪录片集补剧本确认（Issue #54）：升级前已拆出分镜的集视为已确认，否则新门禁会把它们锁死，幂等
  .then(() => backfillScriptConfirmation())
  // 清理完成后再恢复批量任务：被重启打断的那一张/那一镜此时已是 failed，由批次重新提交
  .then(() => startQwenJobsTracker())
  .then(() => startH3JobsTracker())
  .then(() => resumeKeyframeBatches())
  .then(() => resumeVideoBatches())
  // 资产流水线恢复（Issue #56）：suspended 的 run 保持等待人工，running 的原地重放
  .then(() => resumeAssetPipelines())
  // 叠加图层渲染字体自检（Issue #48）：失败只告警，渲染时才阻断（绝不出豆腐块）
  .then(() => logLayerFontStatus())

serve({ fetch: app.fetch, port })
