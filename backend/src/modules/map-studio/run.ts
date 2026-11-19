/** Map Studio stage engine. Ported from #84/#90; module runs own execution records. */
import crypto from 'node:crypto'
import { now } from '../../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel, StageVisionUnavailableError } from '../../services/ai-stages.js'
import { runObservedWork, type ObservedWorkInput } from '../../services/task-observability.js'
import { buildSampleKey } from '../../services/task-estimate.js'
import { normalizeMapSpec, type MapSpec } from './geo/base-render.js'
import { prepareMapBackground } from './geo/geometry.js'
import type { LayerDoc, LayerDocProblem } from '../../services/layer-doc.js'
import { checkBriefSufficiency } from './brief.js'
import { runResearchStage } from './research.js'
import { runBaseStage } from './base.js'
import { backgroundProblems, renderMapLayerDoc, runDrawingStage } from './drawing.js'
import { MapStageExhaustedError, recordAttempt } from './agent-loop.js'
import { buildDeliverable, deliverCurrent } from './delivery.js'
import { getHost } from './registry.js'
import { renderPipAssets } from './pip/render.js'
import { activeRunOfTask, insertRun, finishRun, updateRunStage } from './db.js'
import { readModels } from './settings.js'
import { MapStudioConflictError, MapStudioStaleError, MapStudioRequestError, briefHash, loadTask, mutateTask, serializeDetail, setStep, stageIndex, restoreSnapshot, requireHostTarget, type MapStudioDetail, type MutateContext } from './store.js'
import { MAP_INFRA_RETRIES, MAP_MAX_ROLLBACKS, MAP_RUN_STOP_AT, MAP_WORKFLOW_STAGES, STAGE_LABEL, isMapAgentStage, normalizeBrief, type MapBrief, type MapResearch, type MapResearchFeature, type MapRunStopAt, type MapWorkflowIssue, type MapWorkflowMode, type MapWorkflowStage } from './types.js'
import { geometryUnverified, confirmedVerification, validExtent } from './accuracy.js'
import { inspectLayerDraft, layerDraftContext } from './layer-edit.js'
import { validateLayerOptions } from './render/smooth.js'
import { MapWorkflowValidationError } from './types.js'
import { beginStageSpan, endStageSpan } from './stage-spans.js'
import { resolveMapStyle } from './styles/index.js'
import { annotateRegionLabels } from './region-annotations.js'

export interface MapRunOptions { textConfigId?: number; imageConfigId?: number; imageModel?: string }
export interface MapRunBoundary { mode: MapWorkflowMode; stopAt?: MapRunStopAt | null }

/** guided 的合法起点：base 终点之前（brief/research/base），drawing 终点只从 style/drawing 起（不跨过 base 停靠） */
const GUIDED_START: Record<MapRunStopAt, readonly MapWorkflowStage[]> = {
  base: ['brief', 'research', 'base'],
  drawing: ['style', 'drawing'],
}
const GUIDED_TARGET: Record<MapRunStopAt, MapWorkflowStage> = { base: 'base', drawing: 'drawing' }

/**
 * 校验 mode / stop_at 组合。manual、auto 不接受 stop_at；guided 必须给出合法终点。
 * 拒绝发生在创建 run 之前，非法组合绝不静默降级成 manual。
 */
export function checkRunBoundary(mode: MapWorkflowMode, stopAt: unknown): MapRunStopAt | null {
  if (mode === 'guided') {
    if (!(MAP_RUN_STOP_AT as readonly unknown[]).includes(stopAt)) {
      throw new MapStudioRequestError('有界运行（guided）必须给出 stop_at=base 或 drawing', 'invalid_stop_at')
    }
    return stopAt as MapRunStopAt
  }
  if (stopAt !== undefined && stopAt !== null) throw new MapStudioRequestError(`${mode} 运行不接受 stop_at`, 'invalid_stop_at')
  return null
}

/** guided 只从自己终点之前的合法阶段启动；要重做更早的阶段必须先显式回退 */
export function checkGuidedStart(mode: MapWorkflowMode, stopAt: MapRunStopAt | null, startStage: MapWorkflowStage): void {
  if (mode !== 'guided' || !stopAt) return
  if (GUIDED_START[stopAt].includes(startStage)) return
  throw new MapStudioRequestError(`有界运行 guided/${stopAt} 不能从「${STAGE_LABEL[startStage]}」启动；需要重做早期阶段时先执行服务端回退`, 'invalid_start_stage')
}

/**
 * 本次运行在执行完 `stage` 之后是否继续、以及继续到哪一步。null = 本次运行结束。
 * - manual：一个阶段后结束（含执行器回退）；
 * - auto：按执行器返回继续，直到不出下一步；
 * - guided：跨过目标之前的阶段，目标阶段成功即停；绝不执行目标之后的步骤（base 不跑 style/drawing，drawing 不跑 complete）。
 * 执行器回退（proceed=false）在 guided 里同样结束本次运行，由人按返回状态重新选择动作。
 */
export function nextStageOfRun(input: {
  mode: MapWorkflowMode
  stopAt: MapRunStopAt | null
  stage: MapWorkflowStage
  outcome: { proceed: boolean; next?: MapWorkflowStage }
}): MapWorkflowStage | null {
  if (!input.outcome.proceed || input.mode === 'manual') return null
  if (input.mode === 'auto') return input.outcome.next ?? nextStage(input.stage)
  if (!input.stopAt) return null
  const target = GUIDED_TARGET[input.stopAt]
  if (input.stage === target) return null
  const next = input.outcome.next ?? nextStage(input.stage)
  if (!next || stageIndex(next) > stageIndex(target)) return null
  return next
}

function runAction(mode: MapWorkflowMode, stopAt: MapRunStopAt | null, startStage: MapWorkflowStage): string {
  if (mode === 'auto') return `run:${startStage}`
  if (mode === 'guided') return `run:guided/${stopAt ?? 'unknown'}:${startStage}`
  return `advance:${startStage}`
}

function nextStage(stage: MapWorkflowStage): MapWorkflowStage | null {
  const idx = stageIndex(stage)
  return idx >= 0 && idx < MAP_WORKFLOW_STAGES.length - 1 ? MAP_WORKFLOW_STAGES[idx + 1]! : null
}

/** 稳定 id：同名地物在多次检索里拿到同一个 id，重跑才不会把人工确认过的那条变成新条目 */
function featureId(prefix: string, name: string): string {
  return `${prefix}_${crypto.createHash('sha1').update(name, 'utf8').digest('hex').slice(0, 8)}`
}

// ───────────────────────────── 检索结果 → 几何 ─────────────────────────────

function bboxOf(coords: Array<[number, number]>): [number, number, number, number] {
  const lons = coords.map(item => item[0])
  const lats = coords.map(item => item[1])
  const west = Math.min(...lons)
  const east = Math.max(...lons)
  const south = Math.min(...lats)
  const north = Math.max(...lats)
  // 最小跨度 0.5°（单点地图不能退化成一条线），四周各留 15% 余量
  const padLon = Math.max((east - west) * 0.15, 0.25)
  const padLat = Math.max((north - south) * 0.15, 0.25)
  return [
    Math.max(-180, west - padLon),
    Math.max(-85, south - padLat),
    Math.min(180, east + padLon),
    Math.min(85, north + padLat),
  ]
}
function missingResearchGeometry(research: MapResearch): NonNullable<MapResearch['missing_geometry']> {
  return research.features.flatMap(feature => {
    const reason = feature.dataset_missing?.reason ?? feature.verification?.reasons?.find(value => value.includes('dataset_missing'))
    if (!reason || !feature.category || (feature.kind === 'place' ? feature.lon != null && feature.lat != null : feature.points.length > 0)) return []
    return [{ name: feature.name, category: feature.category, queries: feature.dataset_missing?.queries ?? [], reason }]
  })
}


/**
 * 把检索到的地物并进 map_spec。
 * **人工确认过的几何（proposed !== true）永远不被覆盖**：重跑检索只会补充新条目，
 * 并把分歧记成说明文字，由人决定要不要改。
 */
export function adoptResearchIntoSpec(spec: MapSpec | null, research: MapResearch, brief: MapBrief): { spec: MapSpec; notes: string[] } {
  const notes: string[] = []
  const selectedStyle = resolveMapStyle(brief)
  const places = spec ? [...spec.places] : []
  const routes = spec ? [...spec.routes] : []
  const regions = spec ? [...spec.regions] : []
  for (const feature of research.features) {
    if ((feature.dataset_missing || feature.verification?.reasons?.some(reason => reason.includes('dataset_missing'))) && (feature.kind === 'place' ? feature.lon == null || feature.lat == null : !feature.points.length)) continue
    const metadata = { category: feature.category, origin: feature.origin, verification: feature.verification, dataset_ref: feature.dataset_ref, relations: feature.relations }
    if (feature.kind === 'place' && feature.lon !== null && feature.lat !== null) {
      const id = featureId('p', feature.name)
      const existing = places.find(item => item.id === id || item.name === feature.name)
      if (existing?.proposed !== true && existing) { notes.push(`「${feature.name}」已有人工确认坐标，保留人工值`); continue }
      const entry = { id, name: feature.name, lon: feature.lon, lat: feature.lat, proposed: true as const, ...metadata }
      if (existing) places.splice(places.indexOf(existing), 1, entry)
      else places.push(entry)
      continue
    }
    if (feature.kind === 'region' && !brief.schematic && feature.origin !== 'dataset') {
      notes.push(`范围「${feature.name}」未并入：未开启示意图模式时不绘制历史疆域边界`); continue
    }
    const target = feature.kind === 'route' ? routes : regions
    const prefix = featureId(feature.kind === 'route' ? 'r' : 'g', feature.name)
    const previous = target.filter(item => item.id === prefix || item.id.startsWith(`${prefix}__`) || item.name === feature.name)
    if (previous.some(item => item.proposed !== true)) { notes.push(`「${feature.name}」已有人工确认几何，保留人工值`); continue }
    for (const item of previous) target.splice(target.indexOf(item), 1)
    const parts = feature.parts ?? [feature.points]
    parts.forEach((points, index) => target.push({
      id: index ? `${prefix}__${index + 1}` : prefix,
      name: parts.length > 1 ? `${feature.name} (${index + 1}/${parts.length})` : feature.name,
      points, proposed: true, ...metadata,
    }))
  }
  const coords: Array<[number, number]> = [...places.map((p): [number, number] => [p.lon, p.lat]), ...routes.flatMap(r => r.points), ...regions.flatMap(r => r.points)]
  if (!coords.length) throw new MapStudioRequestError('检索没有得到任何可定位的几何', 'map_spec_missing')
  return {
    spec: normalizeMapSpec({
      version: 1, projection: spec?.projection ?? { type: 'mercator' },
      bbox: spec?.bbox ?? research.extent ?? bboxOf(coords), detail_level: brief.detail_level,
      layers: spec?.layers ?? { land: true, coastline: true, rivers: true, lakes: true, countries: true },
      places, routes, regions, style: { theme: selectedStyle.theme, map_style: selectedStyle.id },
    }),
    notes,
  }
}


/** 项目画幅与底图画布比例不符（项目设置改过画幅）：底图要按新画幅重做 */
function canvasMismatch(brief: MapBrief, base: { width: number; height: number }): string | null {
  if (!brief.aspect_ratio) return null
  const [w, h] = brief.aspect_ratio.split(':').map(Number) as [number, number]
  const wanted = w / h, actual = base.width / base.height
  return Math.abs(actual - wanted) / wanted > 0.02 ? `项目画幅已是 ${brief.aspect_ratio}，当前底图 ${base.width}×${base.height} 比例不符，底图需要按新画幅重做` : null
}

interface StageOutcome { proceed: boolean; message: string; next?: MapWorkflowStage }
async function withInfraRetry<T>(taskId: number, runId: number, stage: MapWorkflowStage, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work() } catch (err) {
      if (err instanceof MapStudioStaleError || err instanceof MapStudioRequestError || attempt >= MAP_INFRA_RETRIES) throw err
      if (runId > 0) await recordAttempt(taskId, runId, { stage, round: 0, outcome: 'infra_retry', problems: [`第 ${attempt + 1} 次失败，自动重试（共 ${MAP_INFRA_RETRIES} 次）：${err instanceof Error ? err.message : String(err)}`] })
    }
  }
}

async function applyRollback(input: { taskId: number; runId: number; from: MapWorkflowStage; target: MapWorkflowStage; reason: string; mode: MapWorkflowMode }): Promise<StageOutcome> {
  const loaded = await loadTask(input.taskId)
  const used = loaded?.state.agent.run_id === input.runId ? loaded.state.agent.rollbacks : 0
  if (used >= MAP_MAX_ROLLBACKS) throw new MapStudioRequestError(`跨阶段回退已用完（${used}/${MAP_MAX_ROLLBACKS}）：${input.reason}`, 'rollbacks_exhausted')
  await mutateTask(input.taskId, {
    expectedRunId: input.runId, action: `agent_rollback:${input.from}->${input.target}`, actor: 'auto', note: input.reason, snapshot: true,
    mutate: ctx => {
      const agent = ctx.state.agent
      agent.rollbacks = used + 1
      if (isMapAgentStage(input.target)) agent.rounds[input.target] = 0
      agent.feedback[input.target] = `来自「${STAGE_LABEL[input.from]}」的回退（第 ${used + 1}/${MAP_MAX_ROLLBACKS} 次）：${input.reason}`
      agent.attempts = [...agent.attempts, { run_id: input.runId, stage: input.from, round: 0, outcome: 'rollback' as const, problems: [input.reason], target_stage: input.target, at: now() }].slice(-80)
      const target = stageIndex(input.target)
      if (target <= stageIndex('base')) { ctx.state.outputs.base_image = null; ctx.state.outputs.kmz = null; ctx.state.outputs.pip = null }
      // Texture depends only on theme; preserve its claim and output across rollbacks.
      ctx.state.outputs.final_image = null
      ctx.state.outputs.layer_doc = null
      for (const step of ctx.state.steps) if (stageIndex(step.id) >= target) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
      setStep(ctx.state, input.from, { message: `已回退到「${STAGE_LABEL[input.target]}」：${input.reason}` })
      ctx.state.stage = input.target
      ctx.state.status = input.mode === 'auto' ? 'running' : 'awaiting_review'
    },
  })
  return { proceed: input.mode === 'auto', next: input.target, message: `已回退到「${STAGE_LABEL[input.target]}」：${input.reason}` }
}

function requireMapSpec(spec: MapSpec | null): void {
  if (!spec) throw new MapStudioRequestError('还没有地图几何，请先完成资料检索或人工填写地点', 'map_spec_missing')
  if (!validExtent(spec.bbox)) throw new MapStudioRequestError('地图范围无效，请先修正 extent', 'invalid_extent')
}

async function executeStageWork(taskId: number, runId: number, stage: MapWorkflowStage): Promise<StageOutcome> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  if (stage === 'base' || stage === 'drawing' || stage === 'complete') requireMapSpec(loaded.mapSpec)
  const { state, brief } = loaded
  const opts = { textConfigId: state.text_config_id ?? undefined, imageConfigId: state.image_config_id ?? undefined, imageModel: state.image_model ?? undefined }
  const hashAtStart = briefHash(brief)
  // 需求里的主题（或模块默认）是唯一来源；map_spec.style 只记录底图当时用的主题。
  // 换主题会把流程退回底图（见 saveMapWorkflowDraft），所以底图与作图始终同一主题。
  const selectedStyle = resolveMapStyle(brief)
  const mode = state.mode
  const feedback = state.agent.feedback[stage] ?? null
  const startRounds = isMapAgentStage(stage) && state.agent.run_id === runId ? state.agent.rounds[stage] ?? 0 : 0
  await mutateTask(taskId, { expectedRunId: runId, expectedBriefHash: hashAtStart, action: `stage_start:${stage}`, actor: mode === 'auto' ? 'auto' : 'manual', mutate: ctx => {
    ctx.state.stage = stage; ctx.state.status = 'running'; ctx.state.error = null; ctx.state.error_detail = null
    delete ctx.state.agent.feedback[stage]
    setStep(ctx.state, stage, { status: 'running', message: null, started_at: now(), finished_at: null })
  } })
  updateRunStage(runId, { stage })
  const finish = async (apply: (ctx: MutateContext) => void | Promise<void>, outcome: StageOutcome, blocked = false) => {
    await mutateTask(taskId, { expectedRunId: runId, expectedBriefHash: hashAtStart, action: `stage_done:${stage}`, actor: mode === 'auto' ? 'auto' : 'manual', note: outcome.message, snapshot: true, mutate: async ctx => {
      await apply(ctx)
      setStep(ctx.state, stage, { status: blocked ? 'awaiting_review' : 'completed', message: outcome.message, finished_at: now() })
      if (blocked) { ctx.state.status = 'blocked'; ctx.state.stage = stage; return }
      const next = nextStage(stage)
      ctx.state.stage = next ?? 'complete'
      ctx.state.status = next ? (mode === 'auto' ? 'running' : 'awaiting_review') : 'completed'
    } })
    return outcome
  }
  const rollback = (result: { stage: MapWorkflowStage; reason: string }) => applyRollback({ taskId, runId, from: stage, target: result.stage, reason: result.reason, mode })
  const agentInput = async () => ({ taskId, runId, stageModel: await resolveStageModel(stage === 'base' || stage === 'drawing' ? 'read_image' : 'asset_research', { configId: opts.textConfigId }), brief, startRounds, feedback })
  if (stage === 'brief') {
    const checked = await checkBriefSufficiency(brief, { textConfigId: opts.textConfigId, startRounds, feedback, record: (round, outcome, problems) => recordAttempt(taskId, runId, { stage: 'brief', round, outcome, problems }, round) })
    const blocking = checked.issues.filter(issue => issue.blocking)
    return finish(ctx => { ctx.brief = checked.brief; ctx.state.issues = checked.issues }, { proceed: !blocking.length, message: blocking.length ? blocking.map(issue => issue.message).join(' ') : `需求已确认（${checked.brief.inferred.length} 项由 AI 补全）` }, !!blocking.length)
  }
  if (stage === 'research') {
    const progress = state.research_progress?.brief_hash === hashAtStart ? state.research_progress : null
    const outcome = await runResearchStage({ ...await agentInput(), spec: loaded.mapSpec, progress })
    if (outcome.kind === 'rollback') return rollback(outcome)
    const research = outcome.result
    research.missing_geometry = missingResearchGeometry(research)
    const adopted = adoptResearchIntoSpec(loaded.mapSpec, research, brief)
    const pending = geometryUnverified(adopted.spec)
    return finish(ctx => {
      ctx.state.research = research; ctx.state.research_progress = null; ctx.mapSpec = adopted.spec
      ctx.state.issues = [
        ...ctx.state.issues.filter(issue => !['research_note', 'approximate_position', 'geometry_unverified', 'geometry_approximate', 'geometry_missing'].includes(issue.code)),
        ...pending.map((feature): MapWorkflowIssue => ({ field: 'research', code: feature.reasons.some(reason => reason.includes('dataset_missing')) ? 'geometry_missing' : 'geometry_approximate', blocking: false, message: `「${feature.name}」：${feature.reasons.join('；')}` })),
        ...(research.missing_geometry ?? []).map((feature): MapWorkflowIssue => ({ field: 'research', code: 'geometry_missing', blocking: false, message: `「${feature.name}」：${feature.reason}；数据集中没有几何，暂不绘制` })),
        ...[...adopted.notes, ...research.notes].map((message): MapWorkflowIssue => ({ field: 'research', code: 'research_note', message, blocking: false })),
        ...research.features.filter(feature => feature.approximate).map((feature): MapWorkflowIssue => ({ field: 'research', code: 'approximate_position', blocking: false, message: `「${feature.name}」为${feature.coordinate_basis === 'approximate_schematic' ? '示意' : '公认'}位置（不确定度 ${feature.uncertainty}）：${feature.basis || '无逐字出处'}` })),
      ]
    }, { proceed: true, message: pending.length ? `${pending.length} 个要素为示意或暂不绘制，可选查看` : `检索到 ${research.sources.length} 条来源、${research.features.length} 个地理要素，几何核验通过` })
  }
  if (stage === 'base') {
    if (!loaded.mapSpec) throw new MapStudioRequestError('还没有地图几何，请先完成资料检索或人工填写地点', 'missing_map_spec')
    const host = loaded.row.host ? getHost(loaded.row.host) : null
    const context = host?.readContext && loaded.row.host_ref ? await host.readContext(loaded.row.host_ref) : null
    const outcome = await runBaseStage({ ...await agentInput(), spec: loaded.mapSpec, context })
    if (outcome.kind === 'rollback') return rollback(outcome)
    const { artifact, mode: baseMode, spec, pip } = outcome.result
    return finish(ctx => {
      ctx.state.outputs.base_image = { path: artifact.path, width: artifact.width, height: artifact.height, source: `map-base:${baseMode}`, run_id: runId, provenance: artifact.provenance }
      ctx.state.outputs.kmz = artifact.kmz_path ? { path: artifact.kmz_path, provenance: artifact.provenance } : null
      ctx.state.outputs.pip = pip
      ctx.mapSpec = spec
    }, { proceed: true, message: `底图已生成（${baseMode}，bbox ${JSON.stringify(spec.bbox)}，${artifact.width}×${artifact.height}）${pip ? `；细节框 ${pip.frames.length} 个，版式 ${pip.layout.id}` : ''}；版本将在交付时登记` })
  }
  if (stage === 'style') {
    // #107：新底图以高程晕渲与分级水系取得对比度，不再叠纸纹；质感底纹步骤保留在流程里但不再出图（不占图片额度）。
    return finish(ctx => { ctx.state.outputs.texture_image = null }, { proceed: true, message: '已跳过质感底纹：新底图不叠纸纹' })
  }
  if (stage === 'drawing') {
    const spec = loaded.mapSpec
    const base = state.outputs.base_image
    if (!spec || !base) throw new MapStudioRequestError('缺少底图或地图几何，请先完成底图步骤', 'missing_base')
    const mismatch = canvasMismatch(brief, base)
    if (mismatch) return rollback({ stage: 'base', reason: mismatch })
    // Issue #126 / #107：新 drawing 不消费旧纸纹。历史 texture 引用仍留在 outputs 里作为旧图事实，
    // 但本次合成只叠底图（固定色板），provenance 如实记 texture: null。
    const background = await prepareMapBackground({ basePath: base.path, registration: base.provenance && 'registration' in base.provenance ? base.provenance.registration : undefined })
    const outcome = await runDrawingStage({ ...await agentInput(), spec, background, layerOptions: state.outputs.layer_options })
    if (outcome.kind === 'rollback') return rollback(outcome)
    const { doc, rendered, omitted, layerOptions } = outcome.result
    return finish(ctx => {
      ctx.state.outputs.final_image = { path: rendered.path, width: rendered.width, height: rendered.height, source: 'map-drawing', run_id: runId, provenance: { map_style: selectedStyle.id, registration: background.registration, warnings: [...background.warnings, ...(rendered.region_composition === 'bottom-layer' ? ['非程序底图不支持水系下合成；区域填充降级到最底图层。'] : [])], region_composition: rendered.region_composition, omitted, base: base.path, base_mode: brief.base_mode, texture: null, background: background.path, attribution: base.provenance && 'attribution' in base.provenance ? base.provenance.attribution : null } }
      ctx.state.outputs.layer_doc = doc
      ctx.state.outputs.layer_options = layerOptions
      ctx.state.issues = [...ctx.state.issues.filter(issue => issue.code !== 'drawing_warning' && issue.code !== 'drawing_omitted'), ...background.warnings.map((message): MapWorkflowIssue => ({ field: 'drawing', code: 'drawing_warning', message, blocking: false })), ...omitted.map((item): MapWorkflowIssue => ({ field: 'drawing', code: 'drawing_omitted', blocking: false, message: `要素 ${item.feature_id} 未画入成图：${item.reason}` }))]
    }, { proceed: true, message: `已用图层文档作图（${doc.layers.length} 个图层，${rendered.width}×${rendered.height}）；待交付后成为宿主当前图` })
  }
  // 画中画：交付前确定性渲染各细节整屏图与组合图（同 spec + 取景 + 版式 => 同像素；失败按基础设施失败自动重试）
  let deliverable = loaded
  const plan = loaded.state.outputs.pip
  if (plan?.frames.length && loaded.mapSpec && loaded.state.outputs.base_image && loaded.state.outputs.final_image) {
    const base = loaded.state.outputs.base_image, final = loaded.state.outputs.final_image
    const rendered = await withInfraRetry(taskId, runId, stage, () => renderPipAssets({ spec: loaded.mapSpec!, pip: plan, overviewBase: base, overviewFinal: final }))
    await mutateTask(taskId, { expectedRunId: runId, expectedBriefHash: hashAtStart, action: 'pip_rendered', actor: mode === 'auto' ? 'auto' : 'manual', note: `细节 ${rendered.details.length} 个，版式 ${rendered.layout.id}`, mutate: ctx => { ctx.state.outputs.pip = rendered } })
    deliverable = (await loadTask(taskId)) ?? loaded
  }
  try { buildDeliverable(deliverable) } catch (err) { return rollback({ stage: 'drawing', reason: err instanceof Error ? err.message : String(err) }) }
  return withInfraRetry(taskId, runId, stage, async () => {
    const delivered = await deliverCurrent(taskId, { runId, briefHash: hashAtStart })
    return finish(() => {}, { proceed: false, message: delivered.message })
  })
}

async function executeStage(taskId: number, runId: number, stage: MapWorkflowStage): Promise<StageOutcome> {
  beginStageSpan(runId, stage)
  try {
    const result = await executeStageWork(taskId, runId, stage)
    endStageSpan(runId, stage, result.next ? 'rollback' : !result.proceed && stage !== 'complete' ? 'blocked' : 'completed')
    return result
  } catch (err) {
    endStageSpan(runId, stage, err instanceof MapStudioStaleError ? 'interrupted' : 'failed')
    throw err
  }
}

function runStages(taskId: number, runId: number, mode: MapWorkflowMode, stopAt: MapRunStopAt | null, startStage: MapWorkflowStage, observation: ObservedWorkInput): void {
  void (async () => {
    let stage: MapWorkflowStage | null = startStage
    let lastMessage = ''
    try {
      await runObservedWork(observation, async () => {
        while (stage) {
          const outcome = await executeStage(taskId, runId, stage)
          lastMessage = outcome.message
          stage = nextStageOfRun({ mode, stopAt, stage, outcome })
        }
      })
      const final = await loadTask(taskId)
      finishRun(runId, final?.state.status === 'blocked' ? 'failed' : 'completed', final?.state.status === 'blocked' ? lastMessage : null)
      logTaskSuccess('MapStudio', 'run', { taskId, runId, status: final?.state.status })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof MapStudioStaleError || err instanceof MapStudioConflictError) {
        logTaskWarn('MapStudio', 'stale-result', { taskId, runId, error: message })
        finishRun(runId, 'failed', `本次执行的结果已作废：${message}`)
        return
      }
      logTaskError('MapStudio', 'run', { taskId, runId, error: message })
      try {
        await mutateTask(taskId, { expectedRunId: runId, action: 'stage_failed', actor: 'system', note: message, mutate: ctx => {
          ctx.state.status = 'failed'; ctx.state.error = message
          ctx.state.error_detail = err instanceof MapStageExhaustedError ? {
            kind: err.kind, rounds: err.rounds.map(round => ({ round: round.round, outcome: round.outcome, problems: round.problems, steps_used: round.stepsUsed })), at: now(),
          } : null
          setStep(ctx.state, ctx.state.stage, { status: 'failed', message, finished_at: now() })
          ctx.state.agent.feedback[ctx.state.stage] = `上一次执行失败：${message}`
        } })
      } catch (nested) { logTaskWarn('MapStudio', 'fail-write-skipped', { taskId, runId, error: String(nested) }) }
      finishRun(runId, 'failed', message)
    }
  })()
}

async function startRun(taskId: number, input: { mode: MapWorkflowMode; stopAt?: unknown; expectedRevision?: number | null; opts: MapRunOptions; skip?: boolean }): Promise<MapStudioDetail> {
  // 边界先校验：非法 mode/stop_at 组合不创建 run、不改任何状态。
  const stopAt = checkRunBoundary(input.mode, input.stopAt)
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  const existing = activeRunOfTask(taskId)
  if (existing) throw new MapStudioConflictError(`该地图已有正在执行的运行（#${existing.id}），请先等待完成或取消`, { code: 'workflow_busy', runId: existing.id })
  if (loaded.state.status === 'completed' && loaded.state.stage === 'complete') throw new MapStudioRequestError('任务已完成；如需修改请先回退到要重做的步骤', 'already_completed')
  const brief = loaded.brief
  if (!brief.subject) throw new MapStudioRequestError('请在需求里填写地图主题', 'missing_brief')
  const startStage = loaded.state.stage === 'research' && loaded.state.status === 'blocked' && loaded.state.research && loaded.state.issues.some(issue => issue.code === 'geometry_unverified') ? 'base' : loaded.state.stage
  checkGuidedStart(input.mode, stopAt, startStage)
  if (startStage === 'base' || startStage === 'drawing' || startStage === 'complete') requireMapSpec(loaded.mapSpec)
  const defaults = readModels()
  const opts = {
    textConfigId: input.opts.textConfigId ?? loaded.state.text_config_id ?? defaults.text_config_id ?? undefined,
    imageConfigId: input.opts.imageConfigId ?? loaded.state.image_config_id ?? defaults.image_config_id ?? undefined,
    imageModel: input.opts.imageModel ?? loaded.state.image_model ?? defaults.image_model ?? undefined,
  }
  // guided 的终点是 base 或 drawing，两者都需要能看图的文本配置（起点在更早的阶段也一样）。
  const reachesVision = startStage === 'base' || startStage === 'drawing' || input.mode === 'guided' || (input.mode === 'auto' && stageIndex(startStage) < stageIndex('complete'))
  if (reachesVision && !input.skip) {
    try { await resolveStageModel('read_image', { configId: opts.textConfigId }) } catch (err) {
      if (err instanceof StageVisionUnavailableError || (err instanceof Error && 'facts' in err && (err.facts as { reason?: string }).reason === 'not_vision')) throw new MapStudioRequestError(`底图与作图阶段需要能看图的文本配置：${err.message}`, 'vision_config_unavailable')
      throw err
    }
  }
  if (input.skip) {
    if (startStage !== 'style') throw new MapStudioRequestError(`「${STAGE_LABEL[startStage]}」不能跳过，只有质感底纹是可选的`, 'stage_not_skippable')
    return serializeDetail(await mutateTask(taskId, { expectedRevision: input.expectedRevision, requireIdle: true, action: 'stage_skip:style', actor: 'manual', note: '人工跳过质感底纹', mutate: ctx => {
      setStep(ctx.state, 'style', { status: 'skipped', message: '人工跳过：成图直接使用底图', finished_at: now() })
      ctx.state.stage = 'drawing'; ctx.state.status = 'awaiting_review'; ctx.state.outputs.texture_image = null
    } }))
  }
  const stageModel = await resolveStageModel(startStage === 'base' || startStage === 'drawing' ? 'read_image' : 'asset_research', { configId: opts.textConfigId })
  const runId = insertRun({ taskId, mode: input.mode, startStage, stage: startStage, textConfigId: opts.textConfigId ?? null, imageConfigId: opts.imageConfigId ?? null, imageModel: opts.imageModel ?? null, params: stopAt ? { stop_at: stopAt } : null })
  let detail: MapStudioDetail
  try {
    detail = serializeDetail(await mutateTask(taskId, { expectedRevision: input.expectedRevision, requireIdle: true, action: runAction(input.mode, stopAt, startStage), actor: 'manual', note: stopAt ? `有界运行 guided/${stopAt}` : `模式 ${input.mode}`, mutate: ctx => {
      if (ctx.state.research && !ctx.state.research.missing_geometry) ctx.state.research.missing_geometry = missingResearchGeometry(ctx.state.research)
      ctx.state.issues = [
        ...ctx.state.issues.filter(issue => !['geometry_unverified', 'geometry_approximate', 'geometry_missing'].includes(issue.code)),
        ...geometryUnverified(ctx.mapSpec).map(f => ({ field: 'research', code: f.reasons.some(reason => reason.includes('dataset_missing')) ? 'geometry_missing' : 'geometry_approximate', blocking: false, message: `「${f.name}」：${f.reasons.join('；')}` })),
        ...(ctx.state.research?.missing_geometry ?? []).map(f => ({ field: 'research', code: 'geometry_missing', blocking: false, message: `「${f.name}」：${f.reason}；数据集中没有几何，暂不绘制` })),
      ]
      if (startStage === 'base' && ctx.state.research) setStep(ctx.state, 'research', { status: 'completed', message: '示意要素可选查看', finished_at: now() })
      ctx.state.mode = input.mode; ctx.state.stop_at = stopAt; ctx.state.run_id = runId
      ctx.state.agent = { ...ctx.state.agent, run_id: runId, rounds: {}, rollbacks: 0 }
      ctx.state.status = 'running'; ctx.state.error = null; ctx.state.stage = startStage
      ctx.state.text_config_id = opts.textConfigId ?? null; ctx.state.image_config_id = opts.imageConfigId ?? null; ctx.state.image_model = opts.imageModel ?? null
      for (const step of ctx.state.steps) if (stageIndex(step.id) >= stageIndex(startStage)) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
    } }))
  } catch (err) { finishRun(runId, 'cancelled', String(err)); throw err }
  logTaskStart('MapStudio', 'run', { taskId, runId, mode: input.mode, stage: startStage })
  runStages(taskId, runId, input.mode, stopAt, startStage, { taskId: runId, scope: 'map_studio', stage: 'map_studio', sourceChars: brief.subject.length + brief.era.length + brief.location.length + brief.purpose.length + brief.notes.length, sampleKey: `${buildSampleKey({ stage: 'map_studio', configId: stageModel.configId, model: stageModel.model })}|start:${startStage}|base:${brief.base_mode}` })
  return detail
}

export async function startMapWorkflow(taskId: number, input: { mode: MapWorkflowMode; stopAt?: unknown; expectedRevision?: number | null } & MapRunOptions): Promise<MapStudioDetail> {
  const { mode, stopAt, expectedRevision, ...opts } = input
  return startRun(taskId, { mode, stopAt, expectedRevision, opts })
}
export async function advanceMapWorkflow(taskId: number, input: { expectedRevision?: number | null; skip?: boolean } & MapRunOptions): Promise<MapStudioDetail> {
  const { expectedRevision, skip, ...opts } = input
  return startRun(taskId, { mode: 'manual', expectedRevision, opts, skip })
}
export async function rollbackMapWorkflow(taskId: number, stage: MapWorkflowStage, expectedRevision?: number | null): Promise<MapStudioDetail> {
  const updated = await mutateTask(taskId, {
    expectedRevision,
    requireIdle: true,
    action: `rollback:${stage}`,
    actor: 'manual',
    note: `回退到「${STAGE_LABEL[stage]}」`,
    snapshot: true,
    mutate: (ctx) => {
      const restored = restoreSnapshot(ctx, stage)
      ctx.state.stage = stage
      ctx.state.status = 'idle'
      ctx.state.run_id = null
      ctx.state.error = null
      for (const step of ctx.state.steps) {
        if (stageIndex(step.id) >= stageIndex(stage)) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
      }
      ctx.state.issues = ctx.state.issues.filter(issue => !issue.blocking)
      if (restored) {
        ctx.state.issues = [...ctx.state.issues, { field: 'history', code: 'rolled_back', message: restored, blocking: false }]
      }
    },
  })
  return serializeDetail(updated)
}

/**
 * 人工保存：顶层字段按需更新，brief 内合并；mapSpec 传入时整份替换。
 *
 * 失效规则（用户确认「关键选择显式」）：
 * - 改需求 → 回到需求步重新核查，下游步骤标记为待执行；既有产出留在 outputs 与历史里不丢；
 * - 改几何 → 成图失效；仅取景/背景层变化才重做底图，已有底纹可复用；
 *   人工在面板上确认的地点/路线会把 proposed 去掉，重跑检索不会再覆盖它们。
 */
export async function saveMapWorkflowDraft(taskId: number, body: {
  expectedRevision?: number | null
  brief?: unknown
  mapSpec?: unknown
  layerOptions?: unknown
  mode?: MapWorkflowMode
}): Promise<MapStudioDetail> {
  const hasBrief = body.brief !== undefined
  const hasSpec = body.mapSpec !== undefined
  const hasOptions = body.layerOptions !== undefined
  const parsedOptions = hasOptions ? validateLayerOptions(body.layerOptions) : undefined
  if (parsedOptions?.problems.length) throw new MapLayerDocInvalidError(parsedOptions.problems)
  if (hasOptions) {
    const loaded = await loadTask(taskId)
    if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
    const nextSpec = hasSpec ? body.mapSpec === null ? null : normalizeMapSpec(body.mapSpec) : loaded.mapSpec
    const knownIds = new Set([...(nextSpec ? [...nextSpec.places, ...nextSpec.routes, ...nextSpec.regions].map(f => f.id) : []), ...(loaded.state.outputs.layer_doc && 'layers' in loaded.state.outputs.layer_doc && Array.isArray(loaded.state.outputs.layer_doc.layers) ? loaded.state.outputs.layer_doc.layers.map(l => l.id) : [])])
    for (const id of Object.keys(parsedOptions!.options)) if (!knownIds.has(id)) throw new MapWorkflowValidationError(`layer_options.${id} 不是现有几何要素或图层`, { field: 'layer_options' })
  }
  if (!hasBrief && !hasSpec && !hasOptions && body.mode === undefined) {
    throw new MapStudioRequestError('请求里没有任何可保存的内容（brief / map_spec / layer_options / mode 至少给一个）', 'empty_request')
  }
  const updated = await mutateTask(taskId, {
    expectedRevision: body.expectedRevision,
    requireIdle: true,
    action: hasSpec ? 'edit_map_spec' : 'edit_brief',
    actor: 'manual',
    note: [hasBrief ? '需求' : '', hasSpec ? '几何' : ''].filter(Boolean).join(' + ') || '模式',
    snapshot: true,
    mutate: (ctx) => {
      if (body.mode) ctx.state.mode = body.mode
      if (parsedOptions) {
        const optionsChanged = JSON.stringify(ctx.state.outputs.layer_options ?? {}) !== JSON.stringify(parsedOptions.options)
        ctx.state.outputs.layer_options = parsedOptions.options
        // Issue #126：几何区的选项保存只持久化并标成图过期，绝不借道重渲/交付。
        // 人工图层文档的高级命令（PUT /layer-doc）保留既有重渲交付副作用，按钮文案单独标注。
        if (optionsChanged && !hasSpec && ctx.state.outputs.base_image) {
          ctx.state.outputs.final_image = null
          if (stageIndex(ctx.state.stage) > stageIndex('drawing')) ctx.state.stage = 'drawing'
          ctx.state.status = 'idle'
          ctx.state.error = null
          for (const step of ctx.state.steps) if (stageIndex(step.id) >= stageIndex('drawing')) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
          ctx.state.issues = [...ctx.state.issues.filter(issue => issue.code !== 'layer_options_changed'), {
            field: 'layer_options', code: 'layer_options_changed', blocking: false,
            message: '图层设置已变更：已保存，重新渲染成图后才会更新',
          }]
        }
      }
      if (hasBrief) {
        const previous = ctx.brief
        const next = normalizeBrief(body.brief, previous)
        // briefHash 只算有效生产输入（不含主题记录）：只改主题时 changed=false，既不回退阶段也不失效产物。
        const changed = briefHash(next) !== ctx.state.brief_hash
        ctx.brief = next
        ctx.state.brief_hash = briefHash(next)
        if (changed) {
          ctx.state.stage = 'brief'
          ctx.state.status = 'idle'
          ctx.state.error = null
          for (const step of ctx.state.steps) {
            if (stageIndex(step.id) >= stageIndex('brief')) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
          }
          ctx.state.issues = [{
            field: 'brief', code: 'brief_changed', blocking: false,
            message: '需求已修改：请重新开始工作流以按新需求检索与出图；此前的底图/成图仍保留在产出与历史中',
          }]
        }
      }
      if (hasSpec) {
        const previous = ctx.mapSpec
        const next = body.mapSpec === null ? null : normalizeMapSpec(body.mapSpec)
        if (JSON.stringify(previous) === JSON.stringify(next)) return
        // 只有 style 记录不同 = 主题字段的历史变化（Issue #126）：保存记录，不失效底图/成图、不挪阶段。
        const styleOnly = !!previous && !!next && JSON.stringify({ ...previous, style: null }) === JSON.stringify({ ...next, style: null })
        if (next) {
          const oldItems = [...previous?.places ?? [], ...previous?.routes ?? [], ...previous?.regions ?? []]
          for (const item of [...next.places, ...next.routes, ...next.regions]) {
            const old = oldItems.find(f => f.id === item.id)
            const changed = !old || JSON.stringify('lon' in item ? [item.lon, item.lat] : item.points) !== JSON.stringify('lon' in old ? [old.lon, old.lat] : old.points)
            if (changed) { item.origin = 'manual'; delete item.proposed; item.verification = confirmedVerification(); delete item.dataset_ref }
            else if (item.proposed !== true) item.verification = confirmedVerification()
          }
          for (const feature of ctx.state.research?.features ?? []) {
            const entries = [...next.places, ...next.routes, ...next.regions].filter(item => item.name === feature.name || item.name.startsWith(`${feature.name} (`))
            if (!entries.length) continue
            if (entries.every(item => item.proposed !== true)) feature.verification = confirmedVerification()
            if (entries.some(item => item.origin === 'manual')) {
              feature.origin = 'manual'
              delete feature.dataset_ref
              if (feature.kind === 'place' && 'lon' in entries[0]!) { feature.lon = entries[0].lon; feature.lat = entries[0].lat }
              else {
                feature.parts = entries.flatMap(item => 'points' in item ? [item.points] : [])
                feature.points = feature.parts[0] ?? []
              }
            }
          }
        }
        ctx.mapSpec = next
        if (styleOnly) return
        // 取景或背景层变更才重做底图；拖点/改线只重绘标注，避免无关的外部请求与模型账单。
        // 主题（spec.style）只是历史记录（Issue #126），不参与底图像素，也不单独触发重建。
        const reframed = !previous || !next
          || previous.projection.type !== next.projection.type
          || previous.bbox.some((value, index) => value !== next.bbox[index])
          || JSON.stringify(previous.layers) !== JSON.stringify(next.layers)
          || previous.detail_level !== next.detail_level
        // 底纹只跟风格有关，与几何无关：取景变了也接着用
        const keptTexture = ctx.state.outputs.texture_image
        // Keep per-feature smoothing choices while drawing layer ids are invalidated.
        const previousDoc = ctx.state.outputs.layer_doc as LayerDoc | null
        const keptOptions = { ...ctx.state.outputs.layer_options }
        for (const layer of previousDoc?.layers ?? []) {
          const option = keptOptions[layer.id]
          if (option && layer.anchor?.semantic_id) {
            keptOptions[layer.anchor.semantic_id] = option
            delete keptOptions[layer.id]
          }
        }
        ctx.state.outputs = {
          base_image: reframed ? null : ctx.state.outputs.base_image,
          texture_image: keptTexture,
          kmz: reframed ? null : ctx.state.outputs.kmz,
          // 成图与图层文档一定失效：它们画的是旧几何
          final_image: null,
          layer_doc: null,
          layer_options: keptOptions,
          // 细节框落在全览取景内：取景改了就要重新提出；只改几何（不重做底图）时沿用
          pip: reframed ? null : ctx.state.outputs.pip ?? null,
        }
        const resumeFrom: MapWorkflowStage = reframed ? 'base' : 'drawing'
        ctx.state.stage = stageIndex(ctx.state.stage) > stageIndex(resumeFrom) ? resumeFrom : ctx.state.stage
        ctx.state.status = 'idle'
        ctx.state.error = null
        for (const step of ctx.state.steps) {
          if (stageIndex(step.id) >= stageIndex(resumeFrom)) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
        }
        if (keptTexture) setStep(ctx.state, 'style', { status: 'completed', message: '沿用已生成的质感底纹（几何改动不影响底纹）' })
        ctx.state.issues = [
          ...ctx.state.issues.filter(issue => issue.code !== 'drawing_warning'),
          {
            field: 'map_spec', code: 'geometry_changed', blocking: false,
            message: reframed
              ? '取景（投影 / 范围）已修改：底图与成图需要重新生成（旧产出保留在历史快照中，可回退）'
              : '地图几何已修改：沿用现有底图与底纹，只需重新绘制标注',
          },
        ]
        const pending = geometryUnverified(next)
        ctx.state.issues = [...ctx.state.issues.filter(issue => !['geometry_unverified', 'geometry_approximate', 'geometry_missing'].includes(issue.code)), ...pending.map(f => ({ field: 'research', code: f.reasons.some(reason => reason.includes('dataset_missing')) ? 'geometry_missing' : 'geometry_approximate', blocking: false, message: `「${f.name}」：${f.reasons.join('；')}` })), ...(ctx.state.research?.missing_geometry ?? []).map(f => ({ field: 'research', code: 'geometry_missing', blocking: false, message: `「${f.name}」：${f.reason}；数据集中没有几何，暂不绘制` }))]
        if (ctx.state.stage === 'research' && ctx.state.research) {
          setStep(ctx.state, 'research', { status: 'completed', message: pending.length ? `${pending.length} 个要素为示意或暂不绘制` : '研究几何已核验或经人工确认' })
          ctx.state.stage = 'base'; ctx.state.status = 'awaiting_review'
        }
      }
    },
  })
  return serializeDetail(updated)
}


export async function cancelMapWorkflow(taskId: number): Promise<MapStudioDetail> {
  const active = activeRunOfTask(taskId)
  if (active) {
    const stage = MAP_WORKFLOW_STAGES.find(stage => stage === active.stage)
    if (stage) endStageSpan(active.id, stage, 'cancelled')
    finishRun(active.id, 'cancelled', '人工取消地图任务')
  }
  return serializeDetail(await mutateTask(taskId, { action: 'cancel', actor: 'manual', note: active ? `取消运行 #${active.id}` : '无运行中的任务', mutate: ctx => {
    for (const step of ctx.state.steps) if (step.status === 'running') Object.assign(step, { status: 'pending', message: '已取消', finished_at: now() })
    ctx.state.run_id = null; ctx.state.stop_at = null; ctx.state.status = ctx.state.status === 'completed' ? 'completed' : 'idle'; ctx.state.error = null
  } }))
}

export class MapLayerDocInvalidError extends Error {
  code = 'layer_doc_invalid'
  constructor(public problems: LayerDocProblem[]) {
    super(`图层文档不合法（${problems.length} 处）：${problems.slice(0, 3).map(item => `${item.path || '(文档)'} ${item.message}`).join('；')}`)
    this.name = 'MapLayerDocInvalidError'
  }
}

/** Manual and agent images share exactly the same strict validator/render chain. */
export async function saveMapLayerDoc(taskId: number, body: { layerDoc: unknown; layerOptions?: unknown; expectedRevision?: number | null }): Promise<MapStudioDetail> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  if (body.expectedRevision != null && body.expectedRevision !== loaded.state.revision) throw new MapStudioConflictError('任务已更新，请刷新后重试', { code: 'revision_conflict', revision: loaded.state.revision })
  if (loaded.state.status === 'running') throw new MapStudioConflictError('任务正在执行，请先等待或取消', { code: 'workflow_busy', revision: loaded.state.revision, runId: loaded.state.run_id })
  const current = loaded.state.outputs.layer_doc as { base?: { path?: string; width?: number; height?: number } } | null
  if (!current?.base?.path || !loaded.state.outputs.base_image || !loaded.mapSpec) throw new MapStudioRequestError('还没有图层文档，请先完成标注绘制', 'missing_drawing')
  const strict = inspectLayerDraft(body.layerDoc, body.layerOptions, layerDraftContext(loaded.mapSpec, loaded.state.outputs))
  const problems = [...strict.problems, ...backgroundProblems(strict.doc, { path: current.base.path, width: Number(current.base.width), height: Number(current.base.height) }).map(message => ({ path: 'base', message }))]
  if (problems.length) throw new MapLayerDocInvalidError(problems)
  const base = loaded.state.outputs.base_image
  const background = await prepareMapBackground({ basePath: base.path, registration: base.provenance && 'registration' in base.provenance ? base.provenance.registration : undefined, texturePath: loaded.state.outputs.texture_image?.path })
  const annotated = annotateRegionLabels(strict.doc, loaded.mapSpec, background.registration)
  if (annotated.error) throw new MapLayerDocInvalidError([{ path: 'layers', message: annotated.error }])
  const checked = inspectLayerDraft(annotated.doc, strict.layerOptions, layerDraftContext(loaded.mapSpec, loaded.state.outputs))
  if (checked.problems.length) throw new MapLayerDocInvalidError(checked.problems)
  const rendered = await renderMapLayerDoc(checked.doc, checked.layerOptions, { spec: loaded.mapSpec, background, texturePath: loaded.state.outputs.texture_image?.path })
  const updated = await mutateTask(taskId, { expectedRevision: loaded.state.revision, expectedBriefHash: briefHash(loaded.brief), requireIdle: true, action: 'edit_layer_doc', actor: 'manual', note: `人工编辑图层（${checked.doc.layers.length} 个图层）`, snapshot: true, mutate: ctx => {
    ctx.state.outputs.final_image = { path: rendered.path, width: rendered.width, height: rendered.height, source: 'map-drawing-manual', run_id: ctx.state.run_id, provenance: { ...ctx.state.outputs.final_image?.provenance, background: current.base!.path, manual_edit: true, region_composition: rendered.region_composition, ...(rendered.region_composition === 'bottom-layer' ? { region_composition_warning: '非程序底图不支持水系下合成；区域填充降级到最底图层。' } : {}) } }
    ctx.state.outputs.layer_doc = checked.doc
    ctx.state.outputs.layer_options = checked.layerOptions
    ctx.state.stage = 'complete'; ctx.state.status = 'awaiting_review'; ctx.state.error = null
  } })
  const delivered = await withInfraRetry(taskId, updated.state.run_id ?? 0, 'complete', () => deliverCurrent(taskId, { briefHash: briefHash(updated.brief) }))
  return serializeDetail(await mutateTask(taskId, { expectedBriefHash: briefHash(updated.brief), requireIdle: true, action: 'manual_delivery', actor: 'manual', mutate: ctx => {
    if (ctx.state.outputs.final_image?.path !== rendered.path) throw new MapStudioStaleError('人工编辑成果已被其他操作替换，不覆盖最新状态')
    setStep(ctx.state, 'drawing', { status: 'completed', message: delivered.message, finished_at: now() })
    setStep(ctx.state, 'complete', { status: 'completed', message: delivered.message, finished_at: now() })
    ctx.state.stage = 'complete'; ctx.state.status = 'completed'; ctx.state.error = null
  } }))
}
