/**
 * 剧集 Poster 接口（Issue #39），挂载在 /api/v1/episodes 下。
 * 所有校验失败都以 400 + 中文原因返回，前端直接展示。
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import {
  createPosterGeneration,
  getPosterBundle,
  registerCompositeVersion,
  savePosterDraft,
  selectPosterVersion,
} from '../services/posters.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

async function readJson(c: Parameters<typeof badRequest>[0]): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function failure(c: Parameters<typeof badRequest>[0], err: unknown, action: string) {
  const message = err instanceof Error ? err.message : String(err)
  logTaskError('PosterAPI', action, { error: message })
  return badRequest(c, message)
}

// GET /episodes/:id/poster — 编辑工程 + 变量 + 版本
app.get('/:id/poster', async (c) => {
  const episodeId = Number(c.req.param('id'))
  try {
    return success(c, await getPosterBundle(episodeId))
  } catch (err) {
    return failure(c, err, 'get')
  }
})

// PUT /episodes/:id/poster — 保存 prompt / 文字描述 / 参考图 / 底图 / 布局
app.put('/:id/poster', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await savePosterDraft(episodeId, body))
  } catch (err) {
    return failure(c, err, 'save')
  }
})

// POST /episodes/:id/poster/generate — 首次生图 / 合成图再生成 / 底图+图层再生成
app.post('/:id/poster/generate', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    logTaskStart('PosterAPI', 'generate', { episodeId, mode: body.mode })
    const result = await createPosterGeneration(episodeId, body)
    logTaskSuccess('PosterAPI', 'generate', { episodeId, taskId: result.task_id, mode: result.mode })
    return success(c, result)
  } catch (err) {
    return failure(c, err, 'generate')
  }
})

// POST /episodes/:id/poster/versions — 登记本地合成的 Poster（自动设为最终版本）
app.post('/:id/poster/versions', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await registerCompositeVersion(episodeId, body))
  } catch (err) {
    return failure(c, err, 'register-composite')
  }
})

// PUT /episodes/:id/poster/select — 选择最终版本
app.put('/:id/poster/select', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await selectPosterVersion(episodeId, body.version_id))
  } catch (err) {
    return failure(c, err, 'select')
  }
})

export default app
