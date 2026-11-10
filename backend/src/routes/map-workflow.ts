/**
 * 地图资产工作流的 HTTP 接口（Issue #84）。挂在 /props 下，由 index.ts 注册。
 *
 * 口径：
 * - 一律先全量校验再写；任何非法请求都**不改动**已有工作（400/409 之后库里原样）；
 * - 并发冲突 409（revision_conflict / workflow_busy），前端据此保留本地草稿并提示刷新；
 * - 非地图资产访问这些接口一律 400 not_a_map：普通道具没有地图流程，也不会被送进地图链路。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import {
  MapAssetTypeError,
  MapWorkflowConflictError,
  loadWorkflow,
  serializeDetail,
} from '../services/map-workflow/store.js'
import {
  MapLayerDocInvalidError,
  MapWorkflowRequestError,
  advanceMapWorkflow,
  cancelMapWorkflow,
  rollbackMapWorkflow,
  saveMapLayerDoc,
  saveMapWorkflowDraft,
  startMapWorkflow,
} from '../services/map-workflow/run.js'
import { MapWorkflowValidationError, MAP_WORKFLOW_STAGES, type MapWorkflowStage } from '../services/map-workflow/types.js'
import { MapSpecValidationError } from '../services/map-base-render.js'

const app = new Hono()

type Ctx = Context

/** 服务层错误 → HTTP；错误码机器可读，消息直接可展示（几何/地球/外部配准的报错原样透传） */
function fail(c: Ctx, err: unknown) {
  if (err instanceof MapWorkflowConflictError) {
    return c.json({ code: 409, error: err.code, message: err.message, revision: err.revision, task_id: err.taskId }, 409)
  }
  if (err instanceof MapAssetTypeError) return badRequest(c, err.message, { error: err.code })
  if (err instanceof MapWorkflowValidationError) return badRequest(c, err.message, { error: err.code, field: err.field })
  if (err instanceof MapSpecValidationError) return badRequest(c, err.message, { error: 'invalid_map_spec' })
  if (err instanceof MapLayerDocInvalidError) return badRequest(c, err.message, { error: err.code, problems: err.problems })
  if (err instanceof MapWorkflowRequestError) {
    if (err.code === 'not_found') return notFound(c, err.message)
    return badRequest(c, err.message, { error: err.code })
  }
  throw err
}

function propId(c: Ctx): number {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) throw new MapWorkflowRequestError('道具 id 非法', 'invalid_request')
  return id
}

function optionalNumber(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new MapWorkflowValidationError(`${field} 必须是非负整数`, { field })
  return value
}

/**
 * 请求体解析。坏 JSON 直接 400：悄悄当成 `{}` 会让「mode 拼错」变成「按默认模式开跑」，
 * 那是在用户没表达的意图上花钱。`allowEmpty` 只给 cancel 这种无参数接口。
 */
async function body(c: Ctx, allowEmpty = false): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (!raw.trim()) {
    if (allowEmpty) return {}
    throw new MapWorkflowValidationError('请求体必须是 JSON 对象', { code: 'invalid_body' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new MapWorkflowValidationError('请求体不是合法 JSON', { code: 'invalid_body' })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MapWorkflowValidationError('请求体必须是 JSON 对象', { code: 'invalid_body' })
  }
  return parsed as Record<string, unknown>
}

/** 模式解析：缺省沿用当前值（undefined），非法值一律拒绝，绝不静默回落成 manual */
function parseMode(raw: unknown): 'auto' | 'manual' | null | undefined {
  if (raw === undefined) return undefined
  if (raw === 'auto' || raw === 'manual') return raw
  return null
}

/** 运行参数（文本/图片配置）三个接口共用，解析一次 */
function runOptions(payload: Record<string, unknown>) {
  return {
    textConfigId: optionalNumber(payload.text_config_id, 'text_config_id'),
    imageConfigId: optionalNumber(payload.image_config_id, 'image_config_id'),
    imageModel: payload.image_model === undefined ? undefined : String(payload.image_model),
    expectedRevision: optionalNumber(payload.expected_revision, 'expected_revision') ?? null,
  }
}

// GET /props/:id/map-workflow — 整页状态（需求 / 步骤 / 问题 / 检索证据 / 产出 / 历史）
app.get('/:id/map-workflow', async (c) => {
  try {
    const loaded = await loadWorkflow(propId(c))
    if (!loaded) return notFound(c, '道具不存在')
    return success(c, serializeDetail(loaded))
  } catch (err) {
    return fail(c, err)
  }
})

// PUT /props/:id/map-workflow — 人工保存需求 / 几何（部分更新）
app.put('/:id/map-workflow', async (c) => {
  try {
    const payload = await body(c)
    const mode = parseMode(payload.mode)
    if (mode === null) return badRequest(c, 'mode 只能是 auto 或 manual', { error: 'invalid_mode', field: 'mode' })
    return success(c, await saveMapWorkflowDraft(propId(c), {
      expectedRevision: optionalNumber(payload.expected_revision, 'expected_revision') ?? null,
      ...(payload.brief !== undefined ? { brief: payload.brief } : {}),
      ...(payload.map_spec !== undefined ? { mapSpec: payload.map_spec } : {}),
      ...(mode ? { mode } : {}),
    }))
  } catch (err) {
    return fail(c, err)
  }
})

// POST /props/:id/map-workflow/run — 继续当前阶段（auto 跑到下一阻断 / manual 跑一步）；重跑需显式回退
app.post('/:id/map-workflow/run', async (c) => {
  try {
    const payload = await body(c)
    const mode = parseMode(payload.mode)
    if (mode === null) return badRequest(c, 'mode 只能是 auto 或 manual', { error: 'invalid_mode', field: 'mode' })
    return success(c, await startMapWorkflow(propId(c), { mode: mode ?? 'manual', ...runOptions(payload) }))
  } catch (err) {
    return fail(c, err)
  }
})

// POST /props/:id/map-workflow/advance — 手动推进一步（skip=true 仅可跳过可选的底纹步）
app.post('/:id/map-workflow/advance', async (c) => {
  try {
    const payload = await body(c)
    return success(c, await advanceMapWorkflow(propId(c), { skip: payload.skip === true, ...runOptions(payload) }))
  } catch (err) {
    return fail(c, err)
  }
})

// POST /props/:id/map-workflow/rollback — 回退到某一步（按历史快照恢复需求/几何/产出）
app.post('/:id/map-workflow/rollback', async (c) => {
  try {
    const payload = await body(c)
    const stage = String(payload.stage ?? '')
    if (!(MAP_WORKFLOW_STAGES as readonly string[]).includes(stage)) {
      return badRequest(c, `stage 只能是 ${MAP_WORKFLOW_STAGES.join(' / ')}`, { error: 'invalid_stage', field: 'stage' })
    }
    const expected = optionalNumber(payload.expected_revision, 'expected_revision') ?? null
    return success(c, await rollbackMapWorkflow(propId(c), stage as MapWorkflowStage, expected))
  } catch (err) {
    return fail(c, err)
  }
})

// POST /props/:id/map-workflow/cancel — 取消当前执行（已产出的内容保留）
app.post('/:id/map-workflow/cancel', async (c) => {
  try {
    return success(c, await cancelMapWorkflow(propId(c)))
  } catch (err) {
    return fail(c, err)
  }
})

// PUT /props/:id/map-workflow/layer-doc — 人工编辑地图图层后保存：严格校验 → 同一渲染链出图 → 成图与语义一次性采用（#90）
app.put('/:id/map-workflow/layer-doc', async (c) => {
  try {
    const payload = await body(c)
    if (payload.layer_doc === undefined) return badRequest(c, '缺少 layer_doc', { error: 'invalid_body', field: 'layer_doc' })
    return success(c, await saveMapLayerDoc(propId(c), {
      layerDoc: payload.layer_doc,
      expectedRevision: optionalNumber(payload.expected_revision, 'expected_revision') ?? null,
    }))
  } catch (err) {
    return fail(c, err)
  }
})

export default app
