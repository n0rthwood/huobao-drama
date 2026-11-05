import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
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
import { MapSpecValidationError, normalizeMapSpec, parseMapSpec } from '../services/map-base-render.js'
import { renderAndRegisterMapBase, suggestMapPlaces } from '../services/asset-pipeline/map-asset.js'
import { getAbsolutePath } from '../utils/storage.js'

const app = new Hono()
// 道具图：白底单品静物，方形画布
const PROP_IMAGE_SIZE = '1024x1024'
/** 证据素材不进生图链路时的统一口径（路由 400 与批量 skip_faithful 同义） */
const FAITHFUL_BLOCKED_MESSAGE = '该素材已标记为证据素材（忠实素材），不能重绘；如需风格化请用「美化」生成派生版本，或先关闭忠实标记'

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
  const ts = now()
  const res = await db.insert(schema.props).values({
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
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
  return created(c, toSnakeCase(row))
})

// DELETE /props/:id — 软删除
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.props).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.props.id, id))
  // 参考图是道具私有的生图输入，随道具一起清理（成片图保留，与既有行为一致）
  deleteAllReferenceImages('prop', id)
  // 集关联/分镜绑定不保留：残留行会让提取与 @引用 继续看到已删道具（Issue #15）
  await deleteAssetLinks('prop', id)
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
  const [updated] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  return success(c, toSnakeCase(updated))
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
  return success(c, toSnakeCase(updated))
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

// ─── 地图底图（Issue #56）────────────────────────────────────
// 地图/图示类证据素材的几何由程序确定性渲染，扩散模型绝不参与；
// 这里替换掉 #47 的一次性 `POST /props/:id/beautify`（美化改由资产流水线承担）。

// GET /props/:id/map-spec
app.get('/:id/map-spec', async (c) => {
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, Number(c.req.param('id'))))
  if (!prop) return badRequest(c, '道具不存在')
  return success(c, { map_spec: parseMapSpec(prop.mapSpec) })
})

// PUT /props/:id/map-spec
app.put('/:id/map-spec', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  try {
    const spec = normalizeMapSpec(body.map_spec)
    await db.update(schema.props)
      .set({ mapSpec: JSON.stringify(spec), updatedAt: now() })
      .where(eq(schema.props.id, id))
    return success(c, { map_spec: spec })
  } catch (err) {
    if (err instanceof MapSpecValidationError) return badRequest(c, err.message)
    throw err
  }
})

// POST /props/:id/map-render — 渲染底图、登记成原件版本、按投影写语义
app.post('/:id/map-render', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  const raw = body.map_spec ?? prop.mapSpec
  if (!raw) return badRequest(c, '该道具还没有地图规格（map_spec）')
  try {
    const spec = typeof raw === 'string' ? normalizeMapSpec(JSON.parse(raw)) : normalizeMapSpec(raw)
    const result = await renderAndRegisterMapBase({
      propId: id,
      spec,
      width: body.width ? Number(body.width) : undefined,
    })
    return success(c, result)
  } catch (err) {
    if (err instanceof MapSpecValidationError) return badRequest(c, err.message)
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('MapBase', 'render', { propId: id, error: message })
    throw err
  }
})

/**
 * POST /props/:id/map-suggest — AI 建议地点经纬度。
 * 返回的一律是**候选**（`proposed: true`）：人工勾选确认后前端才写进 map_spec。
 * 坐标是关键选择，不允许模型直接落库（用户确认的「关键选择显式」）。
 */
app.post('/:id/map-suggest', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  const names: string[] = Array.isArray(body.names) ? body.names.map(String).filter(Boolean) : []
  if (!names.length) return badRequest(c, '请先填写要定位的地名（names）')
  try {
    const places = await suggestMapPlaces({
      name: prop.name,
      description: prop.description,
      names,
      textConfigId: body.text_config_id ?? undefined,
    })
    return success(c, { places })
  } catch (err) {
    if (err instanceof StageVisionUnavailableError) return badRequest(c, err.message)
    return badRequest(c, err instanceof Error ? err.message : '建议坐标失败')
  }
})

export default app
