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
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import serverUpdate from './routes/serverUpdate.js'
import assetLibrary from './routes/asset-library.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { db, schema } from './db/index.js'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { now } from './utils/response.js'
import { DATA_ROOT } from './utils/paths.js'
import { resumeVideoBatches } from './services/video-batch.js'
import { resumeKeyframeBatches } from './services/keyframe-batch.js'
import { startQwenJobsTracker } from './services/qwen-jobs.js'
import { QWEN_JOBS_PROVIDER } from './services/sys-task.js'
import { backfillTaskEpisodeIds, failInterruptedTextTasks } from './services/task-center.js'
import { backfillGeneratedAt } from './services/media-time.js'
import { migrateReferenceImages } from './services/reference-images.js'

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
api.route('/storyboards', storyboards)
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
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/server-update', serverUpdate)
api.route('/asset-library', assetLibrary)

app.route('/api/v1', api)

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)
// 进程重启后内存中的轮询线程全部丢失,残留的 processing 任务永远不会完成,
// 启动时统一标记为 failed,避免前端一直显示"生成中"。
// qwen-jobs 的任务由服务端排队执行，重启不影响它们：交给追踪器按远端 id 继续跟。
db.update(schema.sysTask)
  .set({ status: 'failed', errorMsg: '服务重启，生成任务中断，请重试', updatedAt: now() })
  .where(and(
    eq(schema.sysTask.status, 'processing'),
    ne(schema.sysTask.type, 'text'),
    or(isNull(schema.sysTask.provider), ne(schema.sysTask.provider, QWEN_JOBS_PROVIDER)),
  ))
  .then(res => {
    const affected = res?.changes ?? 0
    if (affected > 0) console.log(`🔁 已清理 ${affected} 个中断的生成任务`)
  })
  .catch(err => console.error('清理中断任务失败:', err?.message))
  // 文本任务（提取 / 提示词批量 / 剧本改写 / 拆分分镜）的执行线程同样随重启丢失，标记为失败供一键重试
  .then(() => failInterruptedTextTasks())
  // 存量任务补归属集：全局任务中心按剧/集筛选与编号
  .then(() => backfillTaskEpisodeIds())
  // 存量媒体补生成时间（unix 秒，按 completed_at || created_at），幂等
  .then(() => backfillGeneratedAt())
  // 参考图存储结构迁移：字符串路径 → { path, uploaded_at }，幂等
  .then(() => migrateReferenceImages())
  // 清理完成后再恢复批量任务：被重启打断的那一张/那一镜此时已是 failed，由批次重新提交
  .then(() => startQwenJobsTracker())
  .then(() => resumeKeyframeBatches())
  .then(() => resumeVideoBatches())

serve({ fetch: app.fetch, port })
