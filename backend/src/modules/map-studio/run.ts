/** Map Studio stage engine. Ported from #84/#90; module runs own execution records. */
import crypto from 'node:crypto'
import sharp from 'sharp'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAbsolutePath } from '../../utils/storage.js'
import { now } from '../../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel, StageVisionUnavailableError } from '../../services/ai-stages.js'
import { runObservedWork, type ObservedWorkInput } from '../../services/task-observability.js'
import { buildSampleKey } from '../../services/task-estimate.js'
import { normalizeMapSpec, type MapSpec } from './geo/base-render.js'
import { prepareMapBackground } from './geo/geometry.js'
import { strictLayerDocProblems, type LayerDocProblem } from '../../services/layer-doc.js'
import { checkBriefSufficiency } from './brief.js'
import { runResearchStage } from './research.js'
import { runBaseStage } from './base.js'
import { backgroundProblems, renderMapLayerDoc, runDrawingStage } from './drawing.js'
import { recordAttempt } from './agent-loop.js'
import { buildDeliverable, deliverCurrent } from './delivery.js'
import { getMapStudioPlatform } from './registry.js'
import { activeRunOfTask, insertRun, finishRun, readRunParams, patchRunParams, updateRunStage, selectRunsByTask } from './db.js'
import { readModels } from './settings.js'
import { MapStudioConflictError, MapStudioStaleError, MapStudioRequestError, briefHash, loadTask, mutateTask, serializeDetail, setStep, stageIndex, restoreSnapshot, requireHostTarget, type MapStudioDetail, type MutateContext } from './store.js'
import { MAP_INFRA_RETRIES, MAP_MAX_ROLLBACKS, MAP_WORKFLOW_STAGES, STAGE_LABEL, isMapAgentStage, normalizeBrief, type MapBrief, type MapResearch, type MapResearchFeature, type MapWorkflowIssue, type MapWorkflowMode, type MapWorkflowStage } from './types.js'
import { geometryUnverified, labelOverflowProblems, confirmedVerification } from './accuracy.js'
import { beginStageSpan, endStageSpan } from './stage-spans.js'

export interface MapRunOptions { textConfigId?: number; imageConfigId?: number; imageModel?: string }
const IMAGE_WAIT_TIMEOUT_MS = 20 * 60_000
const IMAGE_POLL_INTERVAL_MS = 5000
const TEXTURE_PROMPT = 'seamless aged paper texture background only, parchment fiber grain, subtle ink wash stains, soft vignette, uniform tone, absolutely no map, no coastline, no rivers, no borders, no roads, no landmass, no continents, no text, no letters, no numbers, no symbols, no compass, no illustration, no objects'
const TEXTURE_THEME_HINT: Record<MapSpec['style']['theme'], string> = { archival: 'warm sepia archival parchment tone', clean: 'light neutral paper tone, very low contrast grain', ink: 'cool grey rice-paper tone with faint ink diffusion' }
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

/**
 * 把检索到的地物并进 map_spec。
 * **人工确认过的几何（proposed !== true）永远不被覆盖**：重跑检索只会补充新条目，
 * 并把分歧记成说明文字，由人决定要不要改。
 */
export function adoptResearchIntoSpec(spec: MapSpec | null, research: MapResearch, brief: MapBrief): { spec: MapSpec; notes: string[] } {
  const notes: string[] = []
  const places = spec ? [...spec.places] : []
  const routes = spec ? [...spec.routes] : []
  const regions = spec ? [...spec.regions] : []
  for (const feature of research.features) {
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
  if (!coords.length) throw new MapStudioRequestError('检索没有得到任何可定位的几何', 'missing_geometry')
  return {
    spec: normalizeMapSpec({
      version: 1, projection: spec?.projection ?? { type: 'mercator' },
      bbox: spec?.bbox ?? research.extent ?? bboxOf(coords), detail_level: brief.detail_level,
      layers: spec?.layers ?? { land: true, coastline: true, rivers: true, lakes: true, countries: true },
      places, routes, regions, style: { theme: brief.style },
    }),
    notes,
  }
}


/** Claim opaque image references in run.params before waiting; restarts/retries reuse paid texture. */
async function generateTexture(input: { taskId: number; runId: number; theme: MapSpec['style']['theme']; opts: MapRunOptions }): Promise<{ path: string }> {
  const loaded = await loadTask(input.taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  const platform = getMapStudioPlatform()
  const params = readRunParams(input.runId)
  let ref = typeof params.map_texture_ref === 'string' && params.map_texture_theme === input.theme ? params.map_texture_ref : null
  if (ref) {
    const previous = await platform.pollImage(ref)
    if (previous.status !== 'pending' && previous.status !== 'completed') ref = null
  }
  if (!ref) {
    const submitted = await platform.submitImage({ prompt: `${TEXTURE_PROMPT}, ${TEXTURE_THEME_HINT[input.theme]}`, size: '1920x1080', configId: input.opts.imageConfigId, model: input.opts.imageModel, label: loaded.row.title, hostRef: loaded.row.host_ref })
    ref = submitted.ref
    patchRunParams(input.runId, { map_texture_ref: ref, map_texture_theme: input.theme })
  }
  const deadline = Date.now() + IMAGE_WAIT_TIMEOUT_MS
  for (;;) {
    const current = await loadTask(input.taskId)
    if (current?.state.run_id !== input.runId) throw new MapStudioStaleError('底纹等待已取消或由其他运行接管')
    const image = await platform.pollImage(ref)
    if (image.status === 'completed' && image.path) return { path: image.path }
    if (image.status !== 'pending' && image.status !== 'completed') throw new Error(`质感底纹生成失败：${image.error || image.status}；可换图片模型后重试，或跳过底纹`)
    if (Date.now() > deadline) throw new Error('等待底纹生成超时（20 分钟）')
    await sleep(IMAGE_POLL_INTERVAL_MS)
  }
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
      if (target <= stageIndex('base')) { ctx.state.outputs.base_image = null; ctx.state.outputs.kmz = null }
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

function requireVerifiedGeometry(spec: MapSpec | null): void {
  const pending = geometryUnverified(spec)
  if (pending.length) throw new MapStudioRequestError(`geometry_unverified：${pending.map(f => `「${f.name}」：${f.reasons.join('；')}`).join(' / ')}`, 'geometry_unverified')
}

async function executeStageWork(taskId: number, runId: number, stage: MapWorkflowStage): Promise<StageOutcome> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  if (stage === 'base' || stage === 'drawing' || stage === 'complete') requireVerifiedGeometry(loaded.mapSpec)
  const { state, brief } = loaded
  const opts = { textConfigId: state.text_config_id ?? undefined, imageConfigId: state.image_config_id ?? undefined, imageModel: state.image_model ?? undefined }
  const hashAtStart = briefHash(brief)
  const mode = state.mode
  const feedback = state.agent.feedback[stage] ?? null
  const startRounds = isMapAgentStage(stage) && state.agent.run_id === runId ? state.agent.rounds[stage] ?? 0 : 0
  await mutateTask(taskId, { expectedRunId: runId, expectedBriefHash: hashAtStart, action: `stage_start:${stage}`, actor: mode === 'auto' ? 'auto' : 'manual', mutate: ctx => {
    ctx.state.stage = stage; ctx.state.status = 'running'; ctx.state.error = null
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
    const outcome = await runResearchStage({ ...await agentInput(), spec: loaded.mapSpec })
    if (outcome.kind === 'rollback') return rollback(outcome)
    const research = outcome.result
    const adopted = adoptResearchIntoSpec(loaded.mapSpec, research, brief)
    const pending = geometryUnverified(adopted.spec)
    return finish(ctx => {
      ctx.state.research = research; ctx.mapSpec = adopted.spec
      ctx.state.issues = [
        ...ctx.state.issues.filter(issue => !['research_note', 'approximate_position', 'geometry_unverified'].includes(issue.code)),
        ...pending.map((feature): MapWorkflowIssue => ({ field: 'research', code: 'geometry_unverified', blocking: true, message: `「${feature.name}」：${feature.reasons.join('；')}` })),
        ...[...adopted.notes, ...research.notes].map((message): MapWorkflowIssue => ({ field: 'research', code: 'research_note', message, blocking: false })),
        ...research.features.filter(feature => feature.approximate).map((feature): MapWorkflowIssue => ({ field: 'research', code: 'approximate_position', blocking: false, message: `「${feature.name}」为${feature.coordinate_basis === 'approximate_schematic' ? '示意' : '公认'}位置（不确定度 ${feature.uncertainty}）：${feature.basis || '无逐字出处'}` })),
      ]
    }, { proceed: !pending.length, message: pending.length ? `geometry_unverified：${pending.map(f => `「${f.name}」${f.reasons.join('；')}`).join(' / ')}` : `检索到 ${research.sources.length} 条来源、${research.features.length} 个地理要素，几何核验通过` }, pending.length > 0)
  }
  if (stage === 'base') {
    if (!loaded.mapSpec) throw new MapStudioRequestError('还没有地图几何，请先完成资料检索或人工填写地点', 'missing_map_spec')
    const outcome = await runBaseStage({ ...await agentInput(), spec: loaded.mapSpec })
    if (outcome.kind === 'rollback') return rollback(outcome)
    const { artifact, mode: baseMode, spec } = outcome.result
    return finish(ctx => {
      ctx.state.outputs.base_image = { path: artifact.path, width: artifact.width, height: artifact.height, source: `map-base:${baseMode}`, run_id: runId, provenance: artifact.provenance }
      ctx.state.outputs.kmz = artifact.kmz_path ? { path: artifact.kmz_path, provenance: artifact.provenance } : null
      ctx.mapSpec = spec
    }, { proceed: true, message: `底图已生成（${baseMode}，bbox ${JSON.stringify(spec.bbox)}，${artifact.width}×${artifact.height}）；版本将在交付时登记` })
  }
  if (stage === 'style') {
    const texture = await withInfraRetry(taskId, runId, stage, () => generateTexture({ taskId, runId, theme: brief.style, opts }))
    const meta = await sharp(getAbsolutePath(texture.path)).metadata()
    return finish(ctx => { ctx.state.outputs.texture_image = { path: texture.path, width: meta.width ?? 0, height: meta.height ?? 0, source: 'diffusion-texture', run_id: runId, provenance: { note: '扩散模型只生成纸张/底纹质感，不参与任何地理几何', prompt: TEXTURE_PROMPT } } }, { proceed: true, message: '质感底纹已生成（只铺背景，不覆盖地理）' })
  }
  if (stage === 'drawing') {
    const spec = loaded.mapSpec
    const base = state.outputs.base_image
    if (!spec || !base) throw new MapStudioRequestError('缺少底图或地图几何，请先完成底图步骤', 'missing_base')
    const background = await prepareMapBackground({ basePath: base.path, registration: base.provenance && 'registration' in base.provenance ? base.provenance.registration : undefined, texturePath: state.outputs.texture_image?.path })
    const outcome = await runDrawingStage({ ...await agentInput(), spec, background })
    if (outcome.kind === 'rollback') return rollback(outcome)
    const { doc, rendered, omitted } = outcome.result
    return finish(ctx => {
      ctx.state.outputs.final_image = { path: rendered.path, width: rendered.width, height: rendered.height, source: 'map-drawing', run_id: runId, provenance: { registration: background.registration, warnings: background.warnings, omitted, base: base.path, base_mode: brief.base_mode, texture: state.outputs.texture_image?.path ?? null, background: background.path, attribution: base.provenance && 'attribution' in base.provenance ? base.provenance.attribution : null } }
      ctx.state.outputs.layer_doc = doc
      ctx.state.issues = [...ctx.state.issues.filter(issue => issue.code !== 'drawing_warning' && issue.code !== 'drawing_omitted'), ...background.warnings.map((message): MapWorkflowIssue => ({ field: 'drawing', code: 'drawing_warning', message, blocking: false })), ...omitted.map((item): MapWorkflowIssue => ({ field: 'drawing', code: 'drawing_omitted', blocking: false, message: `要素 ${item.feature_id} 未画入成图：${item.reason}` }))]
    }, { proceed: true, message: `已用图层文档作图（${doc.layers.length} 个图层，${rendered.width}×${rendered.height}）；待交付后成为宿主当前图` })
  }
  try { buildDeliverable(loaded) } catch (err) { return rollback({ stage: 'drawing', reason: err instanceof Error ? err.message : String(err) }) }
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

function runStages(taskId: number, runId: number, mode: MapWorkflowMode, startStage: MapWorkflowStage, observation: ObservedWorkInput): void {
  void (async () => {
    let stage: MapWorkflowStage | null = startStage
    let lastMessage = ''
    try {
      await runObservedWork(observation, async () => {
        while (stage) {
          const outcome = await executeStage(taskId, runId, stage)
          lastMessage = outcome.message
          if (!outcome.proceed || mode !== 'auto') break
          stage = outcome.next ?? nextStage(stage)
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
          setStep(ctx.state, ctx.state.stage, { status: 'failed', message, finished_at: now() })
          ctx.state.agent.feedback[ctx.state.stage] = `上一次执行失败：${message}`
        } })
      } catch (nested) { logTaskWarn('MapStudio', 'fail-write-skipped', { taskId, runId, error: String(nested) }) }
      finishRun(runId, 'failed', message)
    }
  })()
}

async function startRun(taskId: number, input: { mode: MapWorkflowMode; expectedRevision?: number | null; opts: MapRunOptions; skip?: boolean }): Promise<MapStudioDetail> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  const existing = activeRunOfTask(taskId)
  if (existing) throw new MapStudioConflictError(`该地图已有正在执行的运行（#${existing.id}），请先等待完成或取消`, { code: 'workflow_busy', runId: existing.id })
  if (loaded.state.status === 'completed' && loaded.state.stage === 'complete') throw new MapStudioRequestError('任务已完成；如需修改请先回退到要重做的步骤', 'already_completed')
  const brief = loaded.brief
  if (!brief.subject) throw new MapStudioRequestError('请在需求里填写地图主题', 'missing_brief')
  const startStage = loaded.state.stage
  if (startStage === 'base' || startStage === 'drawing' || startStage === 'complete') requireVerifiedGeometry(loaded.mapSpec)
  const defaults = readModels()
  const opts = {
    textConfigId: input.opts.textConfigId ?? loaded.state.text_config_id ?? defaults.text_config_id ?? undefined,
    imageConfigId: input.opts.imageConfigId ?? loaded.state.image_config_id ?? defaults.image_config_id ?? undefined,
    imageModel: input.opts.imageModel ?? loaded.state.image_model ?? defaults.image_model ?? undefined,
  }
  const reachesVision = startStage === 'base' || startStage === 'drawing' || (input.mode === 'auto' && stageIndex(startStage) < stageIndex('complete'))
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
  const previousRunId = loaded.state.run_id ?? selectRunsByTask(taskId, 1)[0]?.id
  const previousParams = previousRunId ? readRunParams(previousRunId) : {}
  const reuseTexture = (opts.imageConfigId ?? null) === loaded.state.image_config_id && (opts.imageModel ?? null) === loaded.state.image_model
  const runId = insertRun({ taskId, mode: input.mode, startStage, stage: startStage, textConfigId: opts.textConfigId ?? null, imageConfigId: opts.imageConfigId ?? null, imageModel: opts.imageModel ?? null, params: reuseTexture ? { map_texture_ref: previousParams.map_texture_ref ?? null, map_texture_theme: previousParams.map_texture_theme ?? null } : {} })
  let detail: MapStudioDetail
  try {
    detail = serializeDetail(await mutateTask(taskId, { expectedRevision: input.expectedRevision, requireIdle: true, action: input.mode === 'auto' ? `run:${startStage}` : `advance:${startStage}`, actor: 'manual', note: `模式 ${input.mode}`, mutate: ctx => {
      ctx.state.mode = input.mode; ctx.state.run_id = runId
      ctx.state.agent = { ...ctx.state.agent, run_id: runId, rounds: {}, rollbacks: 0 }
      ctx.state.status = 'running'; ctx.state.error = null; ctx.state.stage = startStage
      ctx.state.text_config_id = opts.textConfigId ?? null; ctx.state.image_config_id = opts.imageConfigId ?? null; ctx.state.image_model = opts.imageModel ?? null
      for (const step of ctx.state.steps) if (stageIndex(step.id) >= stageIndex(startStage)) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
    } }))
  } catch (err) { finishRun(runId, 'cancelled', String(err)); throw err }
  logTaskStart('MapStudio', 'run', { taskId, runId, mode: input.mode, stage: startStage })
  runStages(taskId, runId, input.mode, startStage, { taskId: runId, scope: 'map_studio', stage: 'map_studio', sourceChars: brief.subject.length + brief.era.length + brief.location.length + brief.purpose.length + brief.notes.length, sampleKey: `${buildSampleKey({ stage: 'map_studio', configId: stageModel.configId, model: stageModel.model })}|start:${startStage}|base:${brief.base_mode}` })
  return detail
}

export async function startMapWorkflow(taskId: number, input: { mode: MapWorkflowMode; expectedRevision?: number | null } & MapRunOptions): Promise<MapStudioDetail> {
  const { mode, expectedRevision, ...opts } = input
  return startRun(taskId, { mode, expectedRevision, opts })
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
  mode?: MapWorkflowMode
}): Promise<MapStudioDetail> {
  const hasBrief = body.brief !== undefined
  const hasSpec = body.mapSpec !== undefined
  if (!hasBrief && !hasSpec && body.mode === undefined) {
    throw new MapStudioRequestError('请求里没有任何可保存的内容（brief / map_spec / mode 至少给一个）', 'empty_request')
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
      if (hasBrief) {
        const next = normalizeBrief(body.brief, ctx.brief)
        const changed = briefHash(next) !== ctx.state.brief_hash
        ctx.brief = next
        ctx.state.brief_hash = briefHash(next)
        if (changed) {
          ctx.state.stage = 'brief'
          ctx.state.status = 'idle'
          ctx.state.error = null
          for (const step of ctx.state.steps) {
            Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
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
        // 取景或背景层变更才重做底图；拖点/改线只重绘标注，避免无关的外部请求与模型账单。
        const reframed = !previous || !next
          || previous.projection.type !== next.projection.type
          || previous.bbox.some((value, index) => value !== next.bbox[index])
          || JSON.stringify(previous.layers) !== JSON.stringify(next.layers)
          || previous.detail_level !== next.detail_level
        // 底纹只跟风格有关，与几何无关：取景变了也接着用，除非主题换了
        const styleChanged = !!previous && !!next && previous.style.theme !== next.style.theme
        const keptTexture = styleChanged ? null : ctx.state.outputs.texture_image
        ctx.state.outputs = {
          base_image: reframed ? null : ctx.state.outputs.base_image,
          texture_image: keptTexture,
          kmz: reframed ? null : ctx.state.outputs.kmz,
          // 成图与图层文档一定失效：它们画的是旧几何
          final_image: null,
          layer_doc: null,
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
        if (ctx.state.stage === 'research' && ctx.state.research) {
          const pending = geometryUnverified(next)
          ctx.state.issues = [...ctx.state.issues.filter(issue => issue.code !== 'geometry_unverified'), ...pending.map(f => ({ field: 'research', code: 'geometry_unverified', blocking: true, message: `「${f.name}」：${f.reasons.join('；')}` }))]
          if (pending.length) ctx.state.status = 'blocked'
          else {
            setStep(ctx.state, 'research', { status: 'completed', message: '研究几何已核验或经人工确认' })
            ctx.state.stage = 'base'; ctx.state.status = 'awaiting_review'
          }
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
    ctx.state.run_id = null; ctx.state.status = ctx.state.status === 'completed' ? 'completed' : 'idle'; ctx.state.error = null
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
export async function saveMapLayerDoc(taskId: number, body: { layerDoc: unknown; expectedRevision?: number | null }): Promise<MapStudioDetail> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  requireVerifiedGeometry(loaded.mapSpec)
  if (body.expectedRevision != null && body.expectedRevision !== loaded.state.revision) throw new MapStudioConflictError('任务已更新，请刷新后重试', { code: 'revision_conflict', revision: loaded.state.revision })
  if (loaded.state.status === 'running') throw new MapStudioConflictError('任务正在执行，请先等待或取消', { code: 'workflow_busy', revision: loaded.state.revision, runId: loaded.state.run_id })
  const current = loaded.state.outputs.layer_doc as { base?: { path?: string; width?: number; height?: number } } | null
  if (!current?.base?.path || !loaded.state.outputs.base_image || !loaded.mapSpec) throw new MapStudioRequestError('还没有图层文档，请先完成标注绘制', 'missing_drawing')
  const strict = strictLayerDocProblems(body.layerDoc)
  const problems = [...strict.problems, ...labelOverflowProblems(strict.doc), ...backgroundProblems(strict.doc, { path: current.base.path, width: Number(current.base.width), height: Number(current.base.height) }).map(message => ({ path: 'base', message }))]
  if (problems.length) throw new MapLayerDocInvalidError(problems)
  const rendered = await renderMapLayerDoc(strict.doc)
  const updated = await mutateTask(taskId, { expectedRevision: loaded.state.revision, expectedBriefHash: briefHash(loaded.brief), requireIdle: true, action: 'edit_layer_doc', actor: 'manual', note: `人工编辑图层（${strict.doc.layers.length} 个图层）`, snapshot: true, mutate: ctx => {
    ctx.state.outputs.final_image = { path: rendered.path, width: rendered.width, height: rendered.height, source: 'map-drawing-manual', run_id: ctx.state.run_id, provenance: { ...ctx.state.outputs.final_image?.provenance, background: current.base!.path, manual_edit: true } }
    ctx.state.outputs.layer_doc = strict.doc
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
