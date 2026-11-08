import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/generation.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensurePropFinalPrompt, savedPromptOf } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { deleteAllReferenceImages, partitionMissingReferences, resolveReferenceImages } from '../services/reference-images.js'
import { deleteAssetLinks } from '../services/asset-links.js'
import { mountReferenceImageRoutes } from './reference-images.js'
import { EMPTY_ASSET_NAME_MESSAGE, normalizeAssetName } from '../services/asset-name.js'
import { planFinalPromptWrite, promptSourceChanged } from '../services/asset-prompt-invalidation.js'
import { mountReExtractRoute } from './asset-reextract.js'
import { FAITHFUL_PROVIDERS } from '../services/asset-batch-select.js'
import {
  countSemantics,
  normalizeSemantics,
  parseSemantics,
  resolveSemanticsBase,
  savePropSemantics,
  SemanticsValidationError,
} from '../services/asset-semantics.js'
import { getSemanticsAutoStatus, startSemanticsAuto } from '../services/asset-semantics-auto.js'
import { resolveStageModel, StageVisionUnavailableError } from '../services/ai-stages.js'
import { bindCreatedAssetToReviewItem, findReviewItemAssetDuplicate, onAssetLibraryChanged, onAssetRemoved, onEpisodeAssetLinkChanged } from '../services/asset-review.js'
import { getAbsolutePath } from '../utils/storage.js'
import { parseAssetType } from '../services/map-workflow/types.js'
import { isMapAsset, serializeProp } from '../services/map-workflow/store.js'

const app = new Hono()
// 道具图：白底单品静物，方形画布
const PROP_IMAGE_SIZE = '1024x1024'
/** 证据素材不进生图链路时的统一口径（路由 400 与批量 skip_faithful 同义） */
const FAITHFUL_BLOCKED_MESSAGE = '该素材已标记为证据素材（忠实素材），不能重绘；如需风格化请用「美化」生成派生版本，或先关闭忠实标记'
/**
 * 地图资产（Issue #84）永远不进扩散生图链路：几何必须由程序确定性渲染。
 * 这条拦截比 faithful 更早也更硬——刚建的地图还没有底图、faithful 还是 0，
 * 正是这个窗口期最容易把地图送进重绘。
 */
const MAP_DIFFUSION_BLOCKED_MESSAGE = '地图资产的画面由地图工作流确定性渲染，不能走通用生图；请在地图工作流里生成底图与成图（扩散模型只用于质感底纹）'

// POST/DELETE /props/:id/reference-images — 道具参考图（生图输入，与成片图互不影响）
mountReferenceImageRoutes(app, 'prop')
// POST /props/:id/re-extract — 单资产重新提取（Issue #32）
mountReExtractRoute(app, 'prop')

// POST /props — 手动新增道具（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  const name = normalizeAssetName(body.name)
  if (!name) return badRequest(c, EMPTY_ASSET_NAME_MESSAGE)
  if (Number.isInteger(Number(body.asset_review_item_id)) && Number(body.asset_review_item_id) > 0) {
    const candidate = findReviewItemAssetDuplicate(Number(body.asset_review_item_id), 'prop', name)
    if (candidate) return c.json({ code: 409, error: 'duplicate_asset', message: '本集已有同名资产', candidate }, 409)
  }
  const assetType = parseAssetType(body.asset_type ?? body.assetType, 'prop')
  if (!assetType) return badRequest(c, 'asset_type 只能是 prop 或 map', { error: 'invalid_asset_type', field: 'asset_type' })
  const ts = now()
  const res = await db.insert(schema.props).values({
    assetType,
    name,
    type: body.type || '',
    description: body.description || '',
    dramaId: body.drama_id,
    // 证据素材可以在建卡时就标好（Issue #47）；默认 0，与既有行为一致
    faithful: body.faithful === true || body.faithful === 1 ? 1 : 0,
    createdAt: ts,
    updatedAt: ts,
  })
  const propId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeProps)
      .where(and(eq(schema.episodeProps.episodeId, Number(body.episode_id)), eq(schema.episodeProps.propId, propId)))
    if (!existing.length) {
      await db.insert(schema.episodeProps).values({ episodeId: Number(body.episode_id), propId, createdAt: ts })
    }
  }
  // 审核清单（#55）：带 asset_review_item_id 的新建 = 「上传 / AI 生成」补齐路径，
  // 保存成功即把那条缺失项置 added 并绑定；否则只记一次资产库变更横幅。
  if (body.episode_id) {
    const itemId = Number(body.asset_review_item_id)
    if (Number.isInteger(itemId) && itemId > 0) await bindCreatedAssetToReviewItem(itemId, 'prop', propId)
    else await onEpisodeAssetLinkChanged(Number(body.episode_id), 'asset_linked')
  }
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
  return created(c, serializeProp(row))
})

// DELETE /props/:id — 软删除
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.props).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.props.id, id))
  // 参考图是道具私有的生图输入，随道具一起清理（成片图保留，与既有行为一致）
  deleteAllReferenceImages('prop', id)
  // 集关联/分镜绑定不保留：残留行会让提取与 @引用 继续看到已删道具（Issue #15）
  await deleteAssetLinks('prop', id)
  // 审核清单（#55）：绑定目标消失 → 相关条目回 missing，门禁重新上锁
  await onAssetRemoved('prop', id)
  return success(c)
})

// PUT /props/:id — 更新道具（物品外貌/类型/最终提示词）
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) {
    updates.name = normalizeAssetName(body.name)
    if (!updates.name) return badRequest(c, EMPTY_ASSET_NAME_MESSAGE)
  }
  if (body.type !== undefined) updates.type = body.type
  if (body.description !== undefined) updates.description = body.description
  // 资产类别（Issue #84）：prop ↔ map 显式切换。切回普通道具必须确认——地图资产的几何
  // 与工作流数据**不删**（随时可以再切回来），但它从此会重新进入通用生图链路。
  if (body.asset_type !== undefined || body.assetType !== undefined) {
    const nextType = parseAssetType(body.asset_type ?? body.assetType, prop.assetType === 'map' ? 'map' : 'prop')
    if (!nextType) return badRequest(c, 'asset_type 只能是 prop 或 map', { error: 'invalid_asset_type', field: 'asset_type' })
    const hasMapData = !!prop.mapSpec || !!prop.mapWorkflow
    if (nextType === 'prop' && prop.assetType === 'map' && hasMapData && body.confirm_asset_type_change !== true) {
      return badRequest(c, '该地图已有地图数据（几何/工作流）。切回普通道具后它会重新进入通用生图链路；数据会保留，请传 confirm_asset_type_change=true 显式确认', { error: 'asset_type_change_needs_confirm' })
    }
    updates.assetType = nextType
  }
  // 忠实标记（Issue #47）：打开随手可做，关掉必须显式确认——关掉就等于把证据素材
  // 重新放回扩散模型的射程里，事故正是这样发生的
  if (body.faithful !== undefined) {
    const next = body.faithful === true || body.faithful === 1 ? 1 : 0
    if (next === 0 && Number(prop.faithful) === 1 && body.confirm_unfaithful !== true) {
      return badRequest(c, '关闭忠实标记会让该素材重新进入生图/批量重绘，请传 confirm_unfaithful=true 显式确认')
    }
    updates.faithful = next
  }
  // 用户上传道具图：直接写入图片地址与本地路径
  if (body.image_url !== undefined) updates.imageUrl = body.image_url
  else if (body.imageUrl !== undefined) updates.imageUrl = body.imageUrl
  if (body.local_path !== undefined) updates.localPath = body.local_path
  else if (body.localPath !== undefined) updates.localPath = body.localPath
  // 手写最终提示词以传入值为准；否则名称/类型/描述改了值 → 旧提示词失效（Issue #24）
  Object.assign(updates, planFinalPromptWrite({
    currentFinalPrompt: prop.finalPrompt,
    finalPrompt: body.final_prompt !== undefined ? body.final_prompt : body.finalPrompt,
    sourceChanged: promptSourceChanged('prop', prop, updates),
    at: updates.updatedAt,
  }))
  await db.update(schema.props).set(updates).where(eq(schema.props.id, id))
  // 审核清单（#55）：关掉忠实标记会让 prop_faithful 条目的绑定失效（硬退化）
  if (updates.faithful === 0 && Number(prop.faithful) === 1) await onAssetRemoved('prop', id)
  const [updated] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  return success(c, serializeProp(updated))
})

/** 本地兜底提示词：白底单品，不掺杂其他元素 */
function propImagePrompt(prop: typeof schema.props.$inferSelect, stylePrompt = '') {
  return [
    stylePrompt || '',
    `single product photo of ${prop.name}`,
    prop.description || '',
    'isolated on a pure white background',
    'no other objects, no people, no scenery',
    'soft even studio lighting',
    'high detail',
    'no text, no watermark',
  ].filter(Boolean).join(', ')
}

// POST /props/:id/generate-prompt — 独立生成/重新生成白底单品最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  if (isMapAsset(prop)) return badRequest(c, MAP_DIFFUSION_BLOCKED_MESSAGE, { error: 'map_asset' })
  if (Number(prop.faithful) === 1) return badRequest(c, FAITHFUL_BLOCKED_MESSAGE)
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  logTaskStart('FinalPrompt', 'prop-generate', { propId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = savedPromptOf(await ensurePropFinalPrompt(prop, ep.id, !!body.force, { model: body.text_model, configId: body.text_config_id ?? undefined }))
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'prop-generate', { propId: id })
  return success(c, { final_prompt: finalPrompt })
})

// POST /props/:id/generate-image — 生成道具白底单品图
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  if (isMapAsset(prop)) return badRequest(c, MAP_DIFFUSION_BLOCKED_MESSAGE, { error: 'map_asset' })
  if (Number(prop.faithful) === 1) return badRequest(c, FAITHFUL_BLOCKED_MESSAGE)
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  const stylePrompt = await getDramaStylePrompt(prop.dramaId)
  const finalPrompt = savedPromptOf(await ensurePropFinalPrompt(prop, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined }))
  const prompt = finalPrompt || propImagePrompt(prop, stylePrompt)
  // 默认用道具自己保存的参考图；请求显式传 reference_images（含空数组）时以请求为准
  const resolved = resolveReferenceImages(prop.referenceImages, body.reference_images)
  const { present: referenceImages, missing } = partitionMissingReferences(resolved)
  if (missing.length) logTaskWarn('PropImage', 'reference-missing', { propId: id, missing })
  try {
    logTaskStart('PropImage', 'generate', { propId: id, episodeId: ep.id, dramaId: prop.dramaId, references: referenceImages.length })
    const genId = await generateImage({ propId: id, episodeId: ep.id, dramaId: prop.dramaId, prompt, model: body.model, size: PROP_IMAGE_SIZE, referenceImages: referenceImages.length ? referenceImages : undefined, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('PropImage', 'generate', { propId: id, generationId: genId })
    return success(c, { image_generation_id: genId, reference_images: referenceImages, missing_reference_images: missing })
  } catch (err: any) {
    logTaskError('PropImage', 'generate', { propId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// ─── 证据素材（Issue #47） ──────────────────────────────────────

/**
 * PUT /props/:id/faithful-source — 显式把当前图切回某条原件版本。
 *
 * 迁移只打 `faithful` 标记、不动 `image_url`（用户确认 Q1），回退由人在这里执行：
 * 切回原图会让引用该素材的关键帧签名标「已变化」，这是人的决定，不能由升级代劳。
 */
app.put('/:id/faithful-source', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const versionTaskId = Number(body.version_task_id)
  if (!versionTaskId) return badRequest(c, 'version_task_id 必填')
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')

  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, versionTaskId))
  if (!task || task.propId !== id || task.type !== 'image' || task.status !== 'completed') {
    return badRequest(c, '指定的版本不属于该道具，或还没有完成')
  }
  if (!FAITHFUL_PROVIDERS.includes(task.provider || '')) {
    return badRequest(c, `只能把上传/导入的原件设为忠实底图（该版本来自 ${task.provider || '未知来源'}）`)
  }
  const path = task.localPath || task.resultUrl
  if (!path) return badRequest(c, '该版本没有可用的图片地址')

  await db.update(schema.props).set({
    imageUrl: path,
    localPath: task.localPath || null,
    faithful: 1,
    faithfulSource: versionTaskId,
    updatedAt: now(),
  }).where(eq(schema.props.id, id))
  logTaskSuccess('Faithful', 'source-selected', { propId: id, versionTaskId, path })
  const [updated] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  return success(c, serializeProp(updated))
})

// GET /props/:id/semantics — 语义标注 + 坐标所针对的底图
app.get('/:id/semantics', async (c) => {
  const id = Number(c.req.param('id'))
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  const base = await resolveSemanticsBase(prop)
  return success(c, {
    faithful: Number(prop.faithful) === 1 ? 1 : 0,
    faithful_source: prop.faithfulSource ?? null,
    base_image_url: base.path,
    semantics: parseSemantics(prop.semantics),
  })
})

// PUT /props/:id/semantics — 人工全量覆盖（服务端校验坐标与形状）
app.put('/:id/semantics', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  const raw = body.semantics ?? body
  try {
    const doc = normalizeSemantics(raw)
    await savePropSemantics(id, doc)
    logTaskSuccess('Semantics', 'manual-save', { propId: id, ...countSemantics(doc) })
    // 审核清单（#55）：语义条目变了 → 相关条目重新校验 + 记横幅理由
    await onAssetLibraryChanged('prop', id, 'semantics_changed')
    return success(c, { semantics: doc })
  } catch (err) {
    if (err instanceof SemanticsValidationError) return badRequest(c, err.message)
    throw err
  }
})

// POST /props/:id/semantics/auto — VLM 锚点 + CV 几何的自动标注（文本任务，进任务中心）
app.post('/:id/semantics/auto', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const base = await resolveSemanticsBase(prop)
  if (!base.path) return badRequest(c, '该素材还没有图片，无法标注；请先上传原件')

  try {
    const result = await startSemanticsAuto({
      propId: id,
      episodeId: Number(body.episode_id),
      dramaId: prop.dramaId,
      propName: prop.name,
      absPath: getAbsolutePath(base.path),
      sourceTaskId: base.taskId,
      configId: body.config_id ?? undefined,
    })
    return success(c, { started: result.started, task_id: result.taskId })
  } catch (err) {
    // 视觉环节无可用视觉配置（#51）：明确 400，不建一条注定失败的任务
    if (err instanceof StageVisionUnavailableError) return badRequest(c, err.message)
    throw err
  }
})

// GET /props/:id/semantics/auto/status — 最近一次自动标注的状态与告警
app.get('/:id/semantics/auto/status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getSemanticsAutoStatus(id))
})

// ─── 地图资产（Issue #84）────────────────────────────────────────────────
// #56 的 `GET/PUT /props/:id/map-spec`、`POST /props/:id/map-render`、
// `POST /props/:id/map-suggest` 已全部移除：地图状态的唯一写入口是
// `/props/:id/map-workflow`（routes/map-workflow.ts）。
//
// 原因不是整洁，而是正确性：那三个接口绕过工作流的 CAS 与失效规则，
// 能在一次执行进行中直接改写 map_spec / 当前图 / 语义，正是 #84 要根治的覆盖事故。
// 几何读取走 `GET /props/:id/map-workflow` 的 `map_spec`，几何写入走它的 `PUT`，
// 坐标建议由工作流的「资料检索」步给出（带出处与不确定度，不再是裸坐标）。

export default app
