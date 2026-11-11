/**
 * 剧集 Poster 接口（Issue #39 / #72），挂载在 /api/v1/episodes 下。
 * 校验失败以 400 + 中文原因返回；provenance 冲突用 409 `manual_edit_conflict`，
 * 前端据此显示「有手动编辑，是否需要覆盖？」。
 */
import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import {
  applyPosterConcept,
  applyPosterLayerPlan,
  createPosterGeneration,
  generateConceptCompositions,
  getPosterBundle,
  loadPosterVersion,
  PosterConflictError,
  PosterNotFoundError,
  registerCompositeVersion,
  savePosterDraft,
  selectPosterVersion,
} from '../services/posters.js'
import { startPosterConcept, PosterPlanLegacyError } from '../services/poster-concept.js'
import { TextLayerError } from '../services/layer-text.js'
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
  if (err instanceof PosterConflictError) {
    logTaskError('PosterAPI', action, { error: err.message, fields: err.fields })
    return c.json({
      code: 409,
      error: 'manual_edit_conflict',
      message: err.message,
      fields: err.fields,
    }, 409)
  }
  // 模板文本框有阻断问题（溢出/缺字段/同位冲突…）：拒绝出成品并逐条回给编辑器（Issue #96）
  if (err instanceof TextLayerError) {
    logTaskError('PosterAPI', action, { error: err.message, problems: err.problems.length })
    return c.json({
      code: 400,
      error: 'text_layer_invalid',
      message: err.message,
      problems: err.problems,
    }, 400)
  }
  // 旧构想（模型坐标/样式）不迁移：明确请用户重新生成（Issue #96）
  if (err instanceof PosterPlanLegacyError) {
    logTaskError('PosterAPI', action, { error: err.message })
    return badRequest(c, err.message, { error: 'layer_plan_legacy' })
  }
  if (err instanceof PosterNotFoundError) {
    logTaskError('PosterAPI', action, { error: err.message })
    return notFound(c, err.message)
  }
  const message = err instanceof Error ? err.message : String(err)
  logTaskError('PosterAPI', action, { error: message })
  return badRequest(c, message)
}

// GET /episodes/:id/poster — 编辑工程 + 变量 + 构想 + 版本
app.get('/:id/poster', async (c) => {
  const episodeId = Number(c.req.param('id'))
  try {
    return success(c, await getPosterBundle(episodeId))
  } catch (err) {
    return failure(c, err, 'get')
  }
})

// PUT /episodes/:id/poster — 保存 prompt / 文字描述 / 文案 / 参考图 / 底图 / 图层文档
app.put('/:id/poster', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await savePosterDraft(episodeId, body))
  } catch (err) {
    return failure(c, err, 'save')
  }
})

// POST /episodes/:id/poster/generate — 首次生图 / 合成图再生成 / 服务端图层再生成
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

// POST /episodes/:id/poster/concept — AI 构想（异步文本任务）
app.post('/:id/poster/concept', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    const result = await startPosterConcept(episodeId, {
      model: typeof body.model === 'string' ? body.model : undefined,
      configId: Number(body.config_id || 0) || undefined,
    })
    if (result.reason === 'running') return c.json({ code: 409, error: 'concept_running', message: '该集的 Poster 构想正在运行，请等它结束' }, 409)
    if (result.reason === 'empty_script') return badRequest(c, '请先完成剧本改写/拆分，并且本集至少有一个带图的资产')
    logTaskStart('PosterAPI', 'concept', { episodeId, taskId: result.task_id })
    return success(c, { task_id: result.task_id })
  } catch (err) {
    return failure(c, err, 'concept')
  }
})

// POST /episodes/:id/poster/concept/generate — 三个方案各提交一张冻结快照底图
app.post('/:id/poster/concept/generate', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    const items = await generateConceptCompositions(episodeId, body)
    return success(c, { items })
  } catch (err) {
    return failure(c, err, 'concept-generate')
  }
})

// POST /episodes/:id/poster/concept/apply — 应用方案字段（手动字段默认 409）
app.post('/:id/poster/concept/apply', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await applyPosterConcept(episodeId, body))
  } catch (err) {
    return failure(c, err, 'concept-apply')
  }
})

// POST /episodes/:id/poster/concept/apply-layer-plan — 只替换 AI 文字层
app.post('/:id/poster/concept/apply-layer-plan', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await applyPosterLayerPlan(episodeId, body))
  } catch (err) {
    return failure(c, err, 'concept-apply-layer')
  }
})

// POST /episodes/:id/poster/versions — 服务端从 LayerDoc 渲染合成图并登记最终版本
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

// POST /episodes/:id/poster/load-version — 把某版本的 layer_doc 载入当前工程
app.post('/:id/poster/load-version', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    return success(c, await loadPosterVersion(episodeId, body.version_id))
  } catch (err) {
    return failure(c, err, 'load-version')
  }
})

export default app
