/**
 * 资产审核清单接口（Issue #55）
 *
 * 集级路由挂在 `/api/v1/episodes`（先例：posters），条目级路由挂在 `/api/v1/asset-review`。
 * 业务判断全在 `services/asset-review.ts`，这里只做入参校验与错误码转换；
 * 剧情项目一律 400 `not_documentary`。
 */
import { Hono } from 'hono'

import { success, badRequest } from '../utils/response.js'
import {
  AssetReviewError,
  getAssetReview,
  reviewExtractionPlan,
  startAssetReview,
  updateAssetReviewItem,
} from '../services/asset-review.js'
import { startSingleAssetExtraction } from '../services/extraction.js'
import { logTaskStart } from '../utils/task-logger.js'

export const episodeAssetReview = new Hono()
export const assetReviewItems = new Hono()

type Ctx = Parameters<typeof badRequest>[0]

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** AssetReviewError → 对应 HTTP 码 + `{error: code}`，前端据 code 分支（如 not_documentary） */
function failure(c: Ctx, err: unknown) {
  if (err instanceof AssetReviewError) {
    return c.json({ code: err.status, error: err.code, message: err.message }, err.status as 400)
  }
  throw err
}

// POST /episodes/:id/asset-review/run — AI 对照旁白稿生成 / 刷新清单
episodeAssetReview.post('/:id/asset-review/run', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await readJson(c)
  try {
    const result = await startAssetReview(episodeId, {
      model: typeof body.model === 'string' ? body.model : undefined,
      configId: body.config_id ? Number(body.config_id) : undefined,
    })
    if (!result.started) {
      const message = result.reason === 'not_documentary'
        ? '资产审核清单只用于纪录片项目'
        : result.reason === 'running'
          ? '本集的资产审核清单正在对照中'
          : '本集还没有旁白稿正文，无法对照'
      return c.json({ code: result.reason === 'running' ? 409 : 400, error: result.reason, message },
        result.reason === 'running' ? 409 : 400)
    }
    logTaskStart('AssetReviewAPI', 'run', { episodeId, taskId: result.taskId })
    return success(c, { started: true, task_id: result.taskId })
  } catch (err) {
    return failure(c, err)
  }
})

// GET /episodes/:id/asset-review — 清单全量（按段分组）
episodeAssetReview.get('/:id/asset-review', async (c) => {
  try {
    return success(c, await getAssetReview(Number(c.req.param('id'))))
  } catch (err) {
    return failure(c, err)
  }
})

// PUT /asset-review/items/:id — 处置一条（have / added / ignored / not_needed / 撤销回 missing）
assetReviewItems.put('/items/:id', async (c) => {
  const itemId = Number(c.req.param('id'))
  if (!Number.isInteger(itemId) || itemId <= 0) return badRequest(c, '条目 id 非法')
  const body = await readJson(c)
  if (typeof body.status !== 'string') return badRequest(c, 'status 必填')
  try {
    return success(c, await updateAssetReviewItem(itemId, {
      status: body.status as never,
      asset_kind: typeof body.asset_kind === 'string' ? body.asset_kind : null,
      asset_id: body.asset_id == null ? null : Number(body.asset_id),
      semantic_id: typeof body.semantic_id === 'string' ? body.semantic_id : null,
      reason: typeof body.reason === 'string' ? body.reason : null,
    }))
  } catch (err) {
    return failure(c, err)
  }
})

// POST /asset-review/items/:id/extract — 对这条缺失项补提取（单资产重提取，完成后自动回链）
assetReviewItems.post('/items/:id/extract', async (c) => {
  const itemId = Number(c.req.param('id'))
  if (!Number.isInteger(itemId) || itemId <= 0) return badRequest(c, '条目 id 非法')
  try {
    const plan = reviewExtractionPlan(itemId)
    const taskId = await startSingleAssetExtraction(plan.episodeId, plan.dramaId, plan.target, plan.assetName, {
      assetReviewItemId: itemId,
    })
    if (taskId === null) throw new Error('补提取任务未创建')
    return success(c, { task_id: taskId, asset_name: plan.assetName })
  } catch (err) {
    return failure(c, err)
  }
})

export default episodeAssetReview
