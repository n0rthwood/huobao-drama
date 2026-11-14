import fs from 'node:fs'
import { Hono, type Context } from 'hono'
import { success, created, badRequest, notFound } from '../../utils/response.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { listConfigModelChoices } from '../../services/ai.js'
import { stageSelectionErrorPayload } from '../../services/ai-stages.js'
import { listObservedWork, listObservedCalls, listObservedMessages, countObservedMessages, getObservedCall } from '../../services/task-observability.js'
import { selectTask, selectTasks, selectRunsByTask, selectRun, type RunRow } from './db.js'
import { loadTask, parseWorkflow, serializeDetail, runView, MapStudioConflictError, MapStudioRequestError, requireHostTarget } from './store.js'
import { startMapWorkflow, advanceMapWorkflow, rollbackMapWorkflow, saveMapWorkflowDraft, cancelMapWorkflow, saveMapLayerDoc, MapLayerDocInvalidError } from './run.js'
import { MapWorkflowValidationError, MAP_WORKFLOW_STAGES, type MapWorkflowStage } from './types.js'
import { MapSpecValidationError } from './geo/base-render.js'
import { readStageSpans, stageForCallInSpans } from './stage-spans.js'
import { createStandaloneTask } from './tasks.js'
import { buildDeliverable, deliverCurrent } from './delivery.js'
import { RESEARCH_KEY_IDS, researchKeyStatus, readModels, writeModels, setResearchKey, readDefaultStyle, writeDefaultStyle } from './settings.js'
import { inspectLayerDraft, layerDraftContext } from './layer-edit.js'
import { autoPlaceLabels } from './layout/labels.js'
import { mapStyleFamilyViews, isMapStyleFamilyId, MapStyleValidationError, resolveMapStyle } from './styles/index.js'
import { restyleMapLayers } from './styles/restyle.js'
import { specFeatures } from './validate.js'
import { THEME_PRESETS } from '../../services/layer-svg.js'

export const mapStudioRoutes = new Hono()
const app = mapStudioRoutes

app.onError((err, c) => {
  if (err instanceof MapStudioConflictError) return c.json({ code: 409, error: err.code, message: err.message, revision: err.revision, run_id: err.runId }, 409)
  if (err instanceof MapWorkflowValidationError) return badRequest(c, err.message, { error: err.code, field: err.field })
  if (err instanceof MapStyleValidationError) return badRequest(c, err.message, { error: 'invalid_map_style', field: err.field })
  if (err instanceof MapSpecValidationError) return badRequest(c, err.message, { error: 'invalid_map_spec' })
  if (err instanceof MapLayerDocInvalidError) return badRequest(c, err.message, { error: err.code, problems: err.problems })
  if (err instanceof MapStudioRequestError) return err.code === 'not_found' ? notFound(c, err.message) : badRequest(c, err.message, { error: err.code })
  const selection = stageSelectionErrorPayload(err)
  if (selection) return c.json(selection, 400)
  throw err
})

function idOf(c: Context): number {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) throw new MapStudioRequestError('id 必须是正整数')
  return id
}
function optionalNumber(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) throw new MapWorkflowValidationError(`${field} 必须是非负整数`, { field })
  return n
}
async function body(c: Context): Promise<Record<string, unknown>> {
  let parsed: unknown
  try { parsed = await c.req.json() } catch { throw new MapWorkflowValidationError('请求体必须是合法 JSON 对象', { code: 'invalid_body' }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MapWorkflowValidationError('请求体必须是 JSON 对象', { code: 'invalid_body' })
  return parsed as Record<string, unknown>
}
function runOptions(p: Record<string, unknown>) {
  return { textConfigId: optionalNumber(p.text_config_id, 'text_config_id'), imageConfigId: optionalNumber(p.image_config_id, 'image_config_id'), imageModel: p.image_model === undefined ? undefined : String(p.image_model), expectedRevision: optionalNumber(p.expected_revision, 'expected_revision') }
}
function runSummary(row: RunRow) {
  const works = listObservedWork(row.id, 'map_studio')
  return runView(row, { model_ms: works.reduce((n, w) => n + w.model_ms, 0), queue_ms: works.reduce((n, w) => n + w.queue_ms, 0), work_ms: works.reduce((n, w) => n + w.work_ms, 0), call_count: works.reduce((n, w) => n + w.call_count, 0), work_ids: works.map(w => w.id) })
}

app.get('/tasks', c => success(c, { tasks: selectTasks({ host: c.req.query('host'), q: c.req.query('q') }).map(row => {
  const state = parseWorkflow(row.state)
  const final = state.outputs?.final_image
  return { id: row.id, title: row.title, host: row.host, host_ref: row.host_ref, stage: state.stage, status: state.status, updated_at: row.updated_at, final_image: final ? { path: final.path, width: final.width, height: final.height } : null }
}) }))
app.post('/tasks', async c => {
  const p = await body(c)
  return created(c, await createStandaloneTask({ title: typeof p.title === 'string' ? p.title : '', brief: p.brief }))
})
app.get('/tasks/:id', async c => {
  const loaded = await loadTask(idOf(c))
  return loaded ? success(c, serializeDetail(loaded)) : notFound(c, '任务不存在')
})
app.put('/tasks/:id', async c => {
  const p = await body(c)
  const loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  requireHostTarget(loaded)
  if (p.mode !== undefined && p.mode !== 'auto' && p.mode !== 'manual') return badRequest(c, 'mode 只能是 auto 或 manual', { error: 'invalid_mode' })
  return success(c, await saveMapWorkflowDraft(loaded.row.id, { expectedRevision: optionalNumber(p.expected_revision, 'expected_revision'), ...(p.brief !== undefined ? { brief: p.brief } : {}), ...(p.map_spec !== undefined ? { mapSpec: p.map_spec } : {}), ...(p.layer_options !== undefined ? { layerOptions: p.layer_options } : {}), ...(p.mode ? { mode: p.mode as 'auto' | 'manual' } : {}) }))
})
app.post('/tasks/:id/run', async c => {
  const p = await body(c)
  if (p.mode !== 'auto' && p.mode !== 'manual') return badRequest(c, 'mode 必须明确选择 auto 或 manual', { error: 'invalid_mode' })
  return success(c, await startMapWorkflow(idOf(c), { mode: p.mode, ...runOptions(p) }))
})
app.post('/tasks/:id/advance', async c => {
  const p = await body(c)
  return success(c, await advanceMapWorkflow(idOf(c), { ...runOptions(p), skip: p.skip === true }))
})
app.post('/tasks/:id/rollback', async c => {
  const p = await body(c)
  if (!(MAP_WORKFLOW_STAGES as readonly unknown[]).includes(p.stage)) return badRequest(c, `stage 只能是 ${MAP_WORKFLOW_STAGES.join(' / ')}`, { error: 'invalid_stage' })
  const loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  requireHostTarget(loaded)
  return success(c, await rollbackMapWorkflow(loaded.row.id, p.stage as MapWorkflowStage, optionalNumber(p.expected_revision, 'expected_revision')))
})
app.post('/tasks/:id/cancel', async c => success(c, await cancelMapWorkflow(idOf(c))))
app.put('/tasks/:id/layer-doc', async c => {
  const p = await body(c)
  if (p.layer_doc === undefined) return badRequest(c, '缺少 layer_doc', { error: 'invalid_body', field: 'layer_doc' })
  return success(c, await saveMapLayerDoc(idOf(c), { layerDoc: p.layer_doc, layerOptions: p.layer_options, expectedRevision: optionalNumber(p.expected_revision, 'expected_revision') }))
})
app.post('/tasks/:id/layer-doc/restyle', async c => {
  const p = await body(c), loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  const context = layerDraftContext(loaded.mapSpec, loaded.state.outputs)
  const checked = inspectLayerDraft(p.layer_doc, p.layer_options, context)
  if (checked.renderable.length) throw new MapLayerDocInvalidError(checked.renderable)
  const selected = resolveMapStyle(loaded.mapSpec?.style.map_style ? { map_style: loaded.mapSpec.style.map_style } : loaded.brief, { default_style: readDefaultStyle() })
  const doc = selected ? restyleMapLayers(checked.doc, selected.family, loaded.mapSpec ? specFeatures(loaded.mapSpec) : [])
    : { ...checked.doc, theme: loaded.brief.style, layers: checked.doc.layers.map(layer => ({ ...layer, style: { ...THEME_PRESETS[loaded.brief.style][layer.type] } })) }
  const inspected = inspectLayerDraft(doc, checked.layerOptions, context)
  return success(c, { layer_doc: doc, layer_options: checked.layerOptions, map_style: selected?.id ?? null, problems: inspected.problems })
})
// Read-only editor operations. Neither inspection nor auto-layout saves a draft or consumes a round.
app.post('/tasks/:id/layer-doc/check', async c => {
  const p = await body(c), loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  const checked = inspectLayerDraft(p.layer_doc, p.layer_options, layerDraftContext(loaded.mapSpec, loaded.state.outputs))
  return success(c, { problems: checked.problems })
})
app.post('/tasks/:id/layer-doc/auto-layout', async c => {
  const p = await body(c), loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  const context = layerDraftContext(loaded.mapSpec, loaded.state.outputs)
  const checked = inspectLayerDraft(p.layer_doc, p.layer_options, context)
  if (checked.renderable.length) throw new MapLayerDocInvalidError(checked.renderable)
  const result = autoPlaceLabels(checked.doc, checked.doc.base, checked.features)
  const inspected = inspectLayerDraft(result.doc, checked.layerOptions, context)
  return success(c, { layer_doc: result.doc, layer_options: checked.layerOptions, unresolved: result.unresolved, problems: inspected.problems })
})
app.post('/tasks/:id/deliver', async c => {
  const loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  if (!loaded.row.host) return badRequest(c, '独立任务不需要宿主交付，请下载成果', { error: 'standalone_task' })
  requireHostTarget(loaded)
  if (loaded.state.status === 'running') throw new MapStudioConflictError('请等待运行完成后再交付', { code: 'workflow_busy', revision: loaded.state.revision, runId: loaded.state.run_id })
  const result = await deliverCurrent(loaded.row.id)
  return success(c, { delivered: true, ...result, deliveries: serializeDetail(loaded).deliveries })
})
app.get('/tasks/:id/download/:kind', async c => {
  const loaded = await loadTask(idOf(c))
  if (!loaded) return notFound(c, '任务不存在')
  const kind = c.req.param('kind')
  const d = buildDeliverable(loaded)
  if (kind === 'source' || kind === 'semantics') {
    c.header('Content-Type', 'application/json; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="map-${loaded.row.id}-${kind}.json"`)
    return c.body(JSON.stringify(kind === 'source' ? d.editable_source : d.semantics, null, 2))
  }
  const file = kind === 'final' ? d.final_image.path : kind === 'kmz' ? d.kmz?.path : null
  if (!file || !fs.existsSync(getAbsolutePath(file))) return badRequest(c, '该成果文件尚不可下载', { error: 'download_unavailable' })
  c.header('Content-Type', kind === 'final' ? 'image/png' : 'application/vnd.google-earth.kmz')
  c.header('Content-Disposition', `attachment; filename="map-${loaded.row.id}-${kind}.${kind === 'final' ? 'png' : 'kmz'}"`)
  return c.body(new Uint8Array(fs.readFileSync(getAbsolutePath(file))))
})
app.get('/tasks/:id/runs', c => selectTask(idOf(c)) ? success(c, { runs: selectRunsByTask(idOf(c)).map(runSummary) }) : notFound(c, '任务不存在'))
app.get('/runs/:id/observed', c => {
  const run = selectRun(idOf(c))
  if (!run || !selectTask(run.task_id)) return notFound(c, '运行不存在')
  const limit = Math.min(200, Math.max(1, optionalNumber(c.req.query('limit'), 'limit') ?? 50))
  const wc = optionalNumber(c.req.query('work_cursor') ?? c.req.query('cursor'), 'cursor') ?? 0
  const cc = optionalNumber(c.req.query('call_cursor') ?? c.req.query('cursor'), 'cursor') ?? 0
  const pendingWorks = listObservedWork(run.id, 'map_studio').filter(w => w.id > wc)
  const works = pendingWorks.slice(0, limit)
  const rawCalls = listObservedCalls(run.id, { scope: 'map_studio', afterId: cc, limit })
  // 阶段归属是纯包含判定：跨度读一次，逐条调用对齐；没有跨度覆盖就是 null（不按阶段顺序猜）
  const spans = readStageSpans(run.id)
  const calls = rawCalls.map(call => ({ ...call, stage: stageForCallInSpans(spans, call.started_at) }))
  const hasMoreCalls = calls.length > 0 && listObservedCalls(run.id, { scope: 'map_studio', afterId: calls[calls.length - 1]!.id, limit: 1 }).length > 0
  const hasMoreWorks = pendingWorks.length > works.length
  return success(c, { run: runSummary(run), works, calls, next_work_cursor: hasMoreWorks ? works[works.length - 1]!.id : null, next_call_cursor: hasMoreCalls ? calls[calls.length - 1]!.id : null, has_more_works: hasMoreWorks, has_more_calls: hasMoreCalls })
})
app.get('/calls/:id/messages', c => {
  const call = getObservedCall(idOf(c), 'map_studio')
  if (!call) return notFound(c, '调用不存在')
  const limit = Math.min(200, Math.max(1, optionalNumber(c.req.query('limit'), 'limit') ?? 40))
  const cursor = optionalNumber(c.req.query('cursor'), 'cursor') ?? 0
  const messages = listObservedMessages(call.id, { scope: 'map_studio', afterId: cursor, limit })
  const hasMore = messages.length > 0 && listObservedMessages(call.id, { scope: 'map_studio', afterId: messages[messages.length - 1]!.id, limit: 1 }).length > 0
  return success(c, { call, total: countObservedMessages(call.id, 'map_studio'), messages, next_cursor: hasMore ? messages[messages.length - 1]!.id : null, has_more: hasMore })
})
app.get('/styles', c => success(c, { default_style: readDefaultStyle(), families: mapStyleFamilyViews() }))
app.get('/styles/:style/preview', c => {
  const id = c.req.param('style')
  if (!isMapStyleFamilyId(id)) return badRequest(c, '未知制图主题', { error: 'invalid_map_style' })
  c.header('Content-Type', 'image/jpeg')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(new Uint8Array(fs.readFileSync(new URL(`../../../assets/map-studio-styles/${id}.jpg`, import.meta.url))))
})
app.get('/settings', c => success(c, { research_keys: researchKeyStatus(), models: readModels(), default_style: readDefaultStyle() }))
app.put('/settings', async c => {
  const p = await body(c)
  const keys = p.research_keys
  if (p.default_style !== undefined && !isMapStyleFamilyId(p.default_style)) return badRequest(c, 'default_style 必须是已采纳的主题 id', { error: 'invalid_map_style', field: 'default_style' })
  if (keys !== undefined && (!keys || typeof keys !== 'object' || Array.isArray(keys))) return badRequest(c, 'research_keys 必须是对象', { error: 'invalid_settings' })
  for (const id of RESEARCH_KEY_IDS) {
    const value = keys && (keys as Record<string, unknown>)[id]
    if (value !== undefined && value !== null && typeof value !== 'string') return badRequest(c, `${id} key 必须是字符串或 null`, { error: 'invalid_settings' })
  }
  if (p.models !== undefined) {
    if (!p.models || typeof p.models !== 'object' || Array.isArray(p.models)) return badRequest(c, 'models 必须是对象', { error: 'invalid_settings' })
    const m = p.models as Record<string, unknown>
    for (const field of ['text_config_id', 'image_config_id']) if (m[field] !== undefined && m[field] !== null && (!Number.isSafeInteger(m[field]) || Number(m[field]) <= 0)) return badRequest(c, `${field} 必须是正整数或 null`, { error: 'invalid_settings' })
    if (m.image_model !== undefined && m.image_model !== null && typeof m.image_model !== 'string') return badRequest(c, 'image_model 必须是字符串或 null', { error: 'invalid_settings' })
    const models = { ...readModels(), ...m }
    for (const [field, kind] of [['text_config_id', 'text'], ['image_config_id', 'image']] as const) {
      if (models[field] != null && !(await listConfigModelChoices(kind)).some(choice => choice.config_id === models[field])) return badRequest(c, `${field} 不属于当前可用配置`, { error: 'invalid_settings' })
    }
    if (models.image_model && models.image_config_id && !(await listConfigModelChoices('image')).some(choice => choice.config_id === models.image_config_id && choice.models.includes(String(models.image_model)))) return badRequest(c, '图片模型不属于所选配置', { error: 'invalid_settings' })
  }
  if (keys) for (const id of RESEARCH_KEY_IDS) if (id in (keys as object)) setResearchKey(id, (keys as Record<string, string | null>)[id]!)
  if (p.models !== undefined) writeModels(p.models)
  if (p.default_style !== undefined) writeDefaultStyle(p.default_style)
  return success(c, { research_keys: researchKeyStatus(), models: readModels(), default_style: readDefaultStyle() })
})
app.get('/model-options', async c => success(c, { text: await listConfigModelChoices('text'), image: (await listConfigModelChoices('image')).map(({ vision: _vision, ...choice }) => choice) }))
