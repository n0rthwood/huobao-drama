/**
 * 地图工作流的执行引擎（Issue #84，#90 改为「代码强制流程、模型在工具循环里完成阶段工作」）
 *
 * 阶段：需求 → 资料检索 → 底图 → 质感底纹 → 标注绘制 → 完成登记。
 * 自动模式一口气跑到底（遇阻塞/失败停住），手动模式一次只推进一步，随时可回退。
 *
 * 不可动摇的红线：
 * 1. **错误回给模型**：需求 / 检索 / 底图 / 作图是模型阶段，工具异常与交付校验失败都回给模型自我修正；
 *    每阶段最多 3 轮交付、每次运行最多 2 次跨阶段回退，用完才交人。代码只判收/拒，不修正模型产出。
 * 2. **同一渲染链**：模型用 LayerDoc 作图，预览、成图与人工编辑都走 renderLayerDoc；
 *    扩散模型只产一张底纹，绝不参与地理；底纹只铺在背景层。
 * 3. **证据优先**：检索是真的去维基/Europeana/Smithsonian 拉数据，近似位置必须显式可见。
 * 4. **写入安全**：每次落库都走 store 的 CAS；期间人工改过 brief、回退过阶段、
 *    或任务已被取消，迟到的异步结果一律作废，既有产出原样保留。
 */
import { eq } from 'drizzle-orm'
import crypto from 'crypto'
import sharp from 'sharp'
import { setTimeout as sleep } from 'node:timers/promises'
import { getAbsolutePath } from '../../utils/storage.js'
import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { completionStamp } from '../media-time.js'
import { generateImage } from '../generation.js'
import { resolveStageModel, StageVisionUnavailableError } from '../ai-stages.js'
import {
  createTextTask,
  cancelTextTask,
  finishTextTask,
  parseTextTaskParams,
  patchTextTaskParams,
  textTaskKindOf,
  textTaskOutcome,
} from '../text-task.js'
import { runWithTextTask } from '../text-task-context.js'
import { runObservedWork, type ObservedWorkInput } from '../task-observability.js'
import { buildSampleKey } from '../task-estimate.js'
import { normalizeMapSpec, type MapSpec } from '../map-base-render.js'
import { normalizeSemantics, type AssetSemantics } from '../asset-semantics.js'
import { onAssetLibraryChanged } from '../asset-review.js'
import { prepareMapBackground } from '../map-geometry.js'
import { strictLayerDocProblems, type LayerDocProblem } from '../layer-doc.js'
import { checkBriefSufficiency } from './brief.js'
import { runResearchStage } from './research.js'
import { runBaseStage } from './base.js'
import { backgroundProblems, renderMapLayerDoc, runDrawingStage, type RenderedMapDoc } from './drawing.js'
import { recordAttempt } from './agent-loop.js'
import { drawnGeometryOf, specFeatures, type DrawnGeometry } from './validate.js'
import {
  MapWorkflowConflictError,
  MapWorkflowStaleError,
  briefHash,
  briefOfProp,
  getProp,
  loadWorkflow,
  mutateWorkflow,
  parseWorkflow,
  serializeDetail,
  setStep,
  stageIndex,
  restoreSnapshot,
  type MapWorkflowDetail,
  type MutateContext,
} from './store.js'
import {
  MAP_INFRA_RETRIES,
  MAP_MAX_ROLLBACKS,
  MAP_WORKFLOW_STAGES,
  STAGE_LABEL,
  isMapAgentStage,
  normalizeBrief,
  type MapBrief,
  type MapResearch,
  type MapResearchFeature,
  type MapWorkflowIssue,
  type MapWorkflowMode,
  type MapWorkflowStage,
} from './types.js'

/** 底纹生成的等待上限与轮询节奏（与资产流水线一致） */
const IMAGE_WAIT_TIMEOUT_MS = 20 * 60_000
const IMAGE_POLL_INTERVAL_MS = 5000
const TEXTURE_SIZE = '1920x1080'
/** 底纹提示词里**不允许**出现任何地理要素——这是扩散模型唯一被允许做的事 */
const TEXTURE_PROMPT = [
  'seamless aged paper texture background only, parchment fiber grain, subtle ink wash stains, soft vignette, uniform tone',
  'absolutely no map, no coastline, no rivers, no borders, no roads, no landmass, no continents, no text, no letters, no numbers, no symbols, no compass, no illustration, no objects',
].join(', ')

const TEXTURE_THEME_HINT: Record<MapSpec['style']['theme'], string> = {
  archival: 'warm sepia archival parchment tone',
  clean: 'light neutral paper tone, very low contrast grain',
  ink: 'cool grey rice-paper tone with faint ink diffusion',
}

/** 确定性底图版本，保留原 map-render 历史标识。 */
const MAP_RENDER_PROVIDER = 'map-render'

/** 成图版本行的 provider：与 upload / map-render / qwen-jobs 区分开，版本卡片一眼看出来源 */
export const MAP_WORKFLOW_PROVIDER = 'map-workflow'

export class MapWorkflowRequestError extends Error {
  code: string
  constructor(message: string, code = 'invalid_request') {
    super(message)
    this.name = 'MapWorkflowRequestError'
    this.code = code
  }
}

export interface MapRunOptions {
  textConfigId?: number
  imageConfigId?: number
  imageModel?: string
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

/**
 * 把检索到的地物并进 map_spec。
 * **人工确认过的几何（proposed !== true）永远不被覆盖**：重跑检索只会补充新条目，
 * 并把分歧记成说明文字，由人决定要不要改。
 */
export function adoptResearchIntoSpec(spec: MapSpec | null, research: MapResearch, brief: MapBrief): { spec: MapSpec; notes: string[] } {
  const notes: string[] = []
  const places = spec ? [...spec.places] : []
  const routes = spec ? [...spec.routes] : []
  const regions = spec && Array.isArray(spec.regions) ? [...spec.regions] : []

  const adopt = (feature: MapResearchFeature) => {
    if (feature.kind === 'place' && feature.lon !== null && feature.lat !== null) {
      const id = featureId('p', feature.name)
      const existing = places.find(item => item.id === id || item.name === feature.name)
      if (existing && existing.proposed !== true) {
        if (Math.abs(existing.lon - feature.lon) > 0.01 || Math.abs(existing.lat - feature.lat) > 0.01) {
          notes.push(`「${feature.name}」已有人工确认坐标（${existing.lon.toFixed(3)}, ${existing.lat.toFixed(3)}），本次检索给出的是（${feature.lon.toFixed(3)}, ${feature.lat.toFixed(3)}），保留人工值`)
        }
        return
      }
      const entry = { id, name: feature.name, lon: feature.lon, lat: feature.lat, proposed: true as const }
      if (existing) places.splice(places.indexOf(existing), 1, entry)
      else places.push(entry)
      return
    }
    if (feature.kind === 'route' && feature.points.length >= 2) {
      const id = featureId('r', feature.name)
      const existing = routes.find(item => item.id === id || item.name === feature.name)
      if (existing && existing.proposed !== true) {
        notes.push(`路线「${feature.name}」已有人工确认走向，本次检索结果未覆盖`)
        return
      }
      const entry = { id, name: feature.name, points: feature.points, proposed: true as const }
      if (existing) routes.splice(routes.indexOf(existing), 1, entry)
      else routes.push(entry)
      return
    }
    if (feature.kind === 'region' && feature.points.length >= 3) {
      // 历史疆域不虚构：只有显式示意图模式才允许面状边界进入几何。
      // 这是写几何的唯一一条路径，所以这道闸门放在这里，而不是只在检索解析时拦一次。
      if (!brief.schematic) {
        notes.push(`范围「${feature.name}」未并入：未开启示意图模式时不绘制历史疆域边界（不虚构）`)
        return
      }
      const id = featureId('g', feature.name)
      const existing = regions.find(item => item.id === id || item.name === feature.name)
      if (existing && existing.proposed !== true) {
        notes.push(`范围「${feature.name}」已有人工确认边界，本次检索结果未覆盖`)
        return
      }
      const entry = { id, name: feature.name, points: feature.points, proposed: true as const }
      if (existing) regions.splice(regions.indexOf(existing), 1, entry)
      else regions.push(entry)
    }
  }
  for (const feature of research.features) adopt(feature)

  const coords: Array<[number, number]> = [
    ...places.map((item): [number, number] => [item.lon, item.lat]),
    ...routes.flatMap(item => item.points),
    ...regions.flatMap(item => item.points),
  ]
  // 已有 bbox 只是底图阶段模型的参考（#90）：取景由底图阶段的模型决定并经取景校验，这里不判越界。
  let bbox = spec?.bbox
  if (!bbox) {
    if (!coords.length) {
      throw new MapWorkflowRequestError('检索没有得到任何可定位的地点，无法确定底图范围；请人工补充至少一个地点坐标后再继续', 'missing_geometry')
    }
    bbox = bboxOf(coords)
  }

  return {
    spec: normalizeMapSpec({
      version: 1,
      projection: spec?.projection ?? { type: 'mercator' },
      bbox,
      layers: spec?.layers ?? { land: true, coastline: true, rivers: true, lakes: true, countries: true },
      places,
      routes,
      regions,
      style: { theme: brief.style },
    }),
    notes,
  }
}

// ───────────────────────────── 底纹（唯一的扩散模型调用） ─────────────────────────────

async function waitForImageTask(taskId: number): Promise<{ ok: boolean; path: string | null; error: string | null }> {
  const deadline = Date.now() + IMAGE_WAIT_TIMEOUT_MS
  for (;;) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) return { ok: false, path: null, error: '底纹生成任务记录丢失' }
    if (task.status === 'completed') return { ok: true, path: task.localPath || task.resultUrl || null, error: null }
    if (task.status === 'failed' || task.status === 'cancelled') return { ok: false, path: null, error: task.errorMsg || '底纹生成失败' }
    if (Date.now() > deadline) return { ok: false, path: null, error: '等待底纹生成超时（20 分钟）' }
    await sleep(IMAGE_POLL_INTERVAL_MS)
  }
}

async function generateTexture(input: { propId: number; dramaId: number; propName: string; workflowTaskId: number; theme: MapSpec['style']['theme']; opts: MapRunOptions }): Promise<{ path: string; taskId: number }> {
  const [owner] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, input.workflowTaskId))
  const saved = parseTextTaskParams(owner?.params)
  const previousId = Number(saved?.map_texture_task_id)
  const [previous] = Number.isInteger(previousId) && previousId > 0
    ? await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, previousId))
    : []
  const marker = parseTextTaskParams(previous?.params)?.map_texture as { prop_id?: number } | undefined
  let taskId = previous?.type === 'image' && marker?.prop_id === input.propId
    && saved?.map_texture_theme === input.theme
    && (previous.status === 'queued' || previous.status === 'processing' || previous.status === 'completed')
    ? previous.id : null
  if (taskId === null) {
    const prompt = `${TEXTURE_PROMPT}, ${TEXTURE_THEME_HINT[input.theme]}`
    taskId = await generateImage({
      dramaId: input.dramaId,
      prompt,
      size: TEXTURE_SIZE,
      configId: input.opts.imageConfigId,
      model: input.opts.imageModel,
      // 独立产物：不挂在道具上，完成回调不覆盖地图当前图。
      mapTexture: { propId: input.propId, propName: input.propName },
    })
  }
  // 等图之前立即持久化归属：重启/等待超时后认领同一张在飞或已完成底纹，不重复计费。
  await patchTextTaskParams(input.workflowTaskId, { map_texture_task_id: taskId, map_texture_theme: input.theme })
  const waited = await waitForImageTask(taskId)
  if (!waited.ok || !waited.path) throw new Error(`质感底纹生成失败：${waited.error}；可改选图片模型后重试，或跳过这一步直接出图`)
  return { path: waited.path, taskId }
}

// ───────────────────────────── 阶段执行 ─────────────────────────────

interface StageOutcome {
  /** 自动模式是否继续下一阶段 */
  proceed: boolean
  message: string
  /** 回退时自动模式接着执行的阶段（缺省为顺序的下一阶段） */
  next?: MapWorkflowStage
}

async function imageMeta(path: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(getAbsolutePath(path)).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

/**
 * CAS 落空（人工已改/已回退/已取消）时，刚登记的那条版本行不能留在历史里冒充有效产出：
 * 标成 cancelled 并写明原因。文件本身留在磁盘（内容寻址，重跑会复用），但它不是「当前工作」。
 */
async function discardVersion(taskId: number, err: unknown): Promise<void> {
  const stale = err instanceof MapWorkflowStaleError || err instanceof MapWorkflowConflictError
  if (!stale) return
  await db.update(schema.sysTask).set({
    status: 'cancelled',
    errorMsg: `结果已作废：${err instanceof Error ? err.message : String(err)}`,
    updatedAt: now(),
  }).where(eq(schema.sysTask.id, taskId))
}

/**
 * 从成图版本行里读回像素几何，组装语义文档。
 * 几何从模型（或人工）交付的那份 LayerDoc 的锚定图层导出（#90），随版本行存在 params 里，
 * 于是「采用成图」与「写语义」能在同一次 CAS 里完成，不会出现图换了而坐标没换的中间态。
 */
async function semanticsOfVersion(versionTaskId: number): Promise<AssetSemantics | null> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, versionTaskId))
  if (!row?.params) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.params)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !('geometry' in parsed)) return null
  const geometry = parsed.geometry
  if (!geometry || typeof geometry !== 'object') return null
  const g = geometry as {
    width?: number; height?: number
    points?: Array<{ id: string; name: string; at: [number, number] }>
    routes?: Array<{ id: string; name: string; points: Array<[number, number]>; color?: string }>
    regions?: Array<{ id: string; name: string; points: Array<[number, number]> }>
  }
  const warnings = 'warnings' in parsed && Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []
  return normalizeSemantics({
    image: { width: g.width ?? 0, height: g.height ?? 0, source_task_id: versionTaskId },
    labels: [],
    points: (g.points ?? []).map(point => ({ id: point.id, name: point.name, at: point.at, source: 'cv' as const, confidence: 1 })),
    regions: (g.regions ?? []).map(region => ({ id: region.id, name: region.name, points: region.points, source: 'cv' as const, confidence: 1 })),
    lines: (g.routes ?? []).map(route => ({
      id: route.id, name: route.name, points: route.points, kind: 'route' as const,
      source: 'cv' as const, confidence: 1, ...(route.color ? { color: route.color } : {}),
    })),
    warnings,
    generated_at: new Date().toISOString(),
    model: MAP_WORKFLOW_PROVIDER,
  })
}

/**
 * 跨阶段回退（Issue #90）：由模型的 request_rollback 或 complete 发现成图不合法时发起。
 * 目标阶段之后的产物在本运行内作废（不进入 complete），目标阶段轮次重置，回退原因交给目标阶段的模型。
 */
async function applyRollback(input: {
  propId: number
  taskId: number
  from: MapWorkflowStage
  target: MapWorkflowStage
  reason: string
  mode: MapWorkflowMode
}): Promise<StageOutcome> {
  const loaded = await loadWorkflow(input.propId)
  const used = loaded?.state.agent.task_id === input.taskId ? loaded.state.agent.rollbacks : 0
  if (used >= MAP_MAX_ROLLBACKS) {
    throw new MapWorkflowRequestError(`跨阶段回退已用完（${used}/${MAP_MAX_ROLLBACKS}），无法回到「${STAGE_LABEL[input.target]}」：${input.reason}`, 'rollbacks_exhausted')
  }
  const nth = used + 1
  const discarded: number[] = []
  await mutateWorkflow(input.propId, {
    expectedTaskId: input.taskId,
    action: `agent_rollback:${input.from}->${input.target}`,
    actor: 'auto',
    note: input.reason,
    snapshot: true,
    mutate: (ctx) => {
      const agent = ctx.state.agent
      agent.rollbacks = nth
      if (isMapAgentStage(input.target)) agent.rounds[input.target] = 0
      agent.feedback[input.target] = `来自「${STAGE_LABEL[input.from]}」的回退（第 ${nth}/${MAP_MAX_ROLLBACKS} 次）：${input.reason}`
      agent.attempts = [...agent.attempts, {
        task_id: input.taskId, stage: input.from, round: 0, outcome: 'rollback' as const,
        problems: [input.reason], target_stage: input.target, at: now(),
      }].slice(-80)
      const outputs = ctx.state.outputs
      const target = stageIndex(input.target)
      if (target <= stageIndex('base') && outputs.base_image?.task_id) discarded.push(outputs.base_image.task_id)
      if (outputs.final_image?.task_id) discarded.push(outputs.final_image.task_id)
      if (target <= stageIndex('base')) {
        outputs.base_image = null
        outputs.kmz = null
      }
      // 底纹只取决于风格主题，与检索/取景无关：回退不作废它；style 重跑时按本运行登记的底纹任务认领，不重复计费
      outputs.final_image = null
      outputs.layer_doc = null
      for (const step of ctx.state.steps) {
        if (stageIndex(step.id) >= target) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
      }
      setStep(ctx.state, input.from, { message: `已回退到「${STAGE_LABEL[input.target]}」：${input.reason}` })
      ctx.state.stage = input.target
      ctx.state.status = input.mode === 'auto' ? 'running' : 'awaiting_review'
    },
  })
  await cancelDiscardedVersions(input.propId, discarded, `回退到「${STAGE_LABEL[input.target]}」后作废：${input.reason}`)
  return {
    proceed: input.mode === 'auto',
    next: input.target,
    message: `已回退到「${STAGE_LABEL[input.target]}」（第 ${nth}/${MAP_MAX_ROLLBACKS} 次）：${input.reason}`,
  }
}

/** 回退作废的版本行标 cancelled；仍被资产当前图/语义引用的行（上一次采用的成果）不动 */
async function cancelDiscardedVersions(propId: number, ids: number[], reason: string): Promise<void> {
  if (!ids.length) return
  const prop = await getProp(propId)
  let semanticsSource: number | null = null
  try {
    semanticsSource = Number(JSON.parse(prop?.semantics ?? 'null')?.image?.source_task_id) || null
  } catch { /* 坏语义不阻止作废 */ }
  for (const id of ids) {
    if (id === prop?.faithfulSource || id === semanticsSource) continue
    await db.update(schema.sysTask).set({ status: 'cancelled', errorMsg: reason, updatedAt: now() }).where(eq(schema.sysTask.id, id))
  }
}

/** 底纹 / 完成登记是基础设施阶段：失败自动重试 MAP_INFRA_RETRIES 次，仍失败交人（文本模型修不了生图服务或写库冲突） */
async function withInfraRetry<T>(propId: number, taskId: number, stage: MapWorkflowStage, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      if (err instanceof MapWorkflowStaleError || attempt >= MAP_INFRA_RETRIES) throw err
      if (err instanceof MapWorkflowRequestError) throw err
      await recordAttempt(propId, taskId, {
        stage, round: 0, outcome: 'infra_retry',
        problems: [`第 ${attempt + 1} 次失败，自动重试（共 ${MAP_INFRA_RETRIES} 次）：${err instanceof Error ? err.message : String(err)}`],
      })
    }
  }
}

/** 登记一条成图版本行（模型交付与人工保存共用）；几何从 LayerDoc 导出，随行存进 params */
async function registerDrawingVersion(input: {
  propId: number
  dramaId: number
  subject: string
  stage: 'drawing' | 'manual_edit'
  rendered: RenderedMapDoc
  geometry: DrawnGeometry
  extra: Record<string, unknown>
}): Promise<number> {
  const ts = now()
  return getInsertId(await db.insert(schema.sysTask).values({
    type: 'image',
    propId: input.propId,
    dramaId: input.dramaId,
    provider: MAP_WORKFLOW_PROVIDER,
    model: input.stage === 'drawing' ? 'map-layer-doc' : 'map-layer-doc-manual',
    prompt: `地图成图：${input.subject}`,
    params: JSON.stringify({
      source: 'map-workflow',
      stage: input.stage,
      png_sha256: input.rendered.sha256,
      ...input.extra,
      geometry: input.geometry,
    }),
    resultUrl: input.rendered.path,
    localPath: input.rendered.path,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    ...completionStamp(ts),
  }))
}

/**
 * 执行一个阶段：加锁标记 running（CAS）→ 在锁外做真正的长活 → 带 task/brief 指纹 CAS 回写。
 * 模型阶段（brief / research / base / drawing）在工具循环里完成，错误回给模型；
 * 回写落空（人改了 brief / 回退了 / 取消了）只记日志，绝不推进阶段，也绝不盖掉现有产出。
 */
async function executeStage(propId: number, taskId: number, stage: MapWorkflowStage): Promise<StageOutcome> {
  const loaded = await loadWorkflow(propId)
  if (!loaded) throw new MapWorkflowRequestError('道具不存在', 'not_found')
  const state = loaded.state
  const brief = briefOfProp(loaded.prop, state)
  const opts: MapRunOptions = {
    textConfigId: state.text_config_id ?? undefined,
    imageConfigId: state.image_config_id ?? undefined,
    imageModel: state.image_model ?? undefined,
  }
  const hashAtStart = state.brief_hash
  const mode = state.mode
  // 回馈只交给本阶段这一次执行：读出后清掉，避免下次运行重复喂旧原因
  const feedback = state.agent.feedback[stage] ?? null
  const startRounds = isMapAgentStage(stage) && state.agent.task_id === taskId ? state.agent.rounds[stage] ?? 0 : 0

  await mutateWorkflow(propId, {
    expectedTaskId: taskId,
    action: `stage_start:${stage}`,
    actor: mode === 'auto' ? 'auto' : 'manual',
    mutate: (ctx) => {
      ctx.state.stage = stage
      ctx.state.status = 'running'
      ctx.state.error = null
      delete ctx.state.agent.feedback[stage]
      setStep(ctx.state, stage, { status: 'running', message: null, started_at: now(), finished_at: null })
    },
  })
  await patchTextTaskParams(taskId, { map_stage: stage })

  const finish = async (apply: (ctx: MutateContext) => void | Promise<void>, outcome: StageOutcome, opts2: { blocked?: boolean } = {}) => {
    await mutateWorkflow(propId, {
      // brief 阶段本身就是写 brief 的那一步，不比对 brief 指纹
      expectedTaskId: taskId,
      expectedBriefHash: stage === 'brief' ? null : hashAtStart,
      action: `stage_done:${stage}`,
      actor: mode === 'auto' ? 'auto' : 'manual',
      note: outcome.message,
      snapshot: true,
      mutate: async (ctx) => {
        await apply(ctx)
        if (opts2.blocked) {
          setStep(ctx.state, stage, { status: 'awaiting_review', message: outcome.message, finished_at: now() })
          ctx.state.status = 'blocked'
          ctx.state.stage = stage
          return
        }
        setStep(ctx.state, stage, { status: 'completed', message: outcome.message, finished_at: now() })
        const next = nextStage(stage)
        if (!next) {
          ctx.state.status = 'completed'
          ctx.state.stage = 'complete'
          return
        }
        ctx.state.stage = next
        ctx.state.status = mode === 'auto' ? 'running' : 'awaiting_review'
      },
    })
    return outcome
  }
  const rollback = (result: { stage: MapWorkflowStage; reason: string }) =>
    applyRollback({ propId, taskId, from: stage, target: result.stage, reason: result.reason, mode })
  const agentInput = async () => ({
    propId,
    taskId,
    dramaId: loaded.prop.dramaId,
    stageModel: await resolveStageModel('asset_research', { configId: opts.textConfigId }),
    brief,
    startRounds,
    feedback,
  })

  if (stage === 'brief') {
    const checked = await checkBriefSufficiency(brief, {
      textConfigId: opts.textConfigId,
      startRounds,
      feedback,
      record: (round, outcome, problems) => recordAttempt(propId, taskId, { stage: 'brief', round, outcome, problems }, round),
    })
    const blocking = checked.issues.filter(issue => issue.blocking)
    return await finish((ctx) => {
      ctx.state.brief = checked.brief
      ctx.state.brief_hash = briefHash(checked.brief)
      ctx.state.issues = checked.issues
    }, {
      proceed: blocking.length === 0,
      message: blocking.length ? blocking.map(issue => issue.message).join(' ') : `需求已确认（${checked.brief.inferred.length} 项由 AI 补全）`,
    }, { blocked: blocking.length > 0 })
  }

  if (stage === 'research') {
    const outcome = await runResearchStage({ ...await agentInput(), spec: loaded.mapSpec })
    if (outcome.kind === 'rollback') return await rollback(outcome)
    const research = outcome.result
    const adopted = adoptResearchIntoSpec(loaded.mapSpec, research, brief)
    return await finish((ctx) => {
      ctx.state.research = research
      ctx.mapSpec = adopted.spec
      ctx.state.issues = [
        ...ctx.state.issues.filter(issue => issue.code !== 'research_note' && issue.code !== 'approximate_position'),
        ...[...adopted.notes, ...research.notes].map((message): MapWorkflowIssue => ({ field: 'research', code: 'research_note', message, blocking: false })),
        ...research.features.filter(feature => feature.approximate).map((feature): MapWorkflowIssue => ({
          field: 'research', code: 'approximate_position', blocking: false,
          message: `「${feature.name}」为${feature.coordinate_basis === 'approximate_schematic' ? '示意' : '公认'}位置（不确定度 ${feature.uncertainty}）：${feature.basis || '无逐字出处'}`,
        })),
      ]
    }, {
      proceed: true,
      message: `检索到 ${research.sources.length} 条来源、${research.features.length} 个地理要素（${research.features.filter(f => f.excerpt_verified).length} 个有逐字出处）`,
    })
  }

  if (stage === 'base') {
    const spec = loaded.mapSpec
    if (!spec) throw new MapWorkflowRequestError('还没有地图几何（map_spec），无法生成底图；请先完成资料检索或人工填写地点', 'missing_map_spec')
    const outcome = await runBaseStage({ ...await agentInput(), spec })
    if (outcome.kind === 'rollback') return await rollback(outcome)
    const { artifact, mode: baseMode, spec: framed } = outcome.result
    // 只产文件，**不碰库**：所有资产写入都必须等 CAS 通过。否则一条迟到的底图回调
    // 会把人工已经编辑过/已经回退过的地图直接顶掉（这正是 #84 要根治的事故形态）。
    const ts = now()
    const baseTaskId = getInsertId(await db.insert(schema.sysTask).values({
      type: 'image',
      propId,
      dramaId: loaded.prop.dramaId,
      provider: MAP_RENDER_PROVIDER,
      model: String(artifact.provenance.renderer ?? baseMode),
      prompt: `地图底图：${brief.subject || loaded.prop.name}`,
      params: JSON.stringify({ source: 'map-workflow', stage: 'base', base_mode: baseMode, bbox: framed.bbox, provenance: artifact.provenance }),
      resultUrl: artifact.path,
      localPath: artifact.path,
      status: 'completed',
      createdAt: ts,
      updatedAt: ts,
      ...completionStamp(ts),
    }))
    try {
      return await finish((ctx) => {
        ctx.state.outputs.base_image = {
          path: artifact.path, width: artifact.width, height: artifact.height,
          source: `map-base:${baseMode}`, task_id: baseTaskId,
          provenance: artifact.provenance,
        }
        ctx.state.outputs.kmz = artifact.kmz_path ? { path: artifact.kmz_path, provenance: artifact.provenance } : null
        // 模型选定的取景写回几何：之后的绘制与人工几何编辑都以它为准
        ctx.mapSpec = framed
        // 底图只**登记版本**，不动资产当前图与语义：当前图与语义必须成对切换，
        // 真正的采用在 complete 那一步一次性完成。
      }, { proceed: true, message: `底图已生成（${baseMode}，bbox ${JSON.stringify(framed.bbox)}，${artifact.width}×${artifact.height}），已登记为版本 #${baseTaskId}` })
    } catch (err) {
      await discardVersion(baseTaskId, err)
      throw err
    }
  }

  if (stage === 'style') {
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop) throw new MapWorkflowRequestError('道具不存在', 'not_found')
    const texture = await withInfraRetry(propId, taskId, 'style', () => generateTexture({
      propId, dramaId: prop.dramaId, propName: prop.name, workflowTaskId: taskId,
      theme: brief.style, opts,
    }))
    const meta = await imageMeta(texture.path)
    return await finish((ctx) => {
      ctx.state.outputs.texture_image = {
        path: texture.path, width: meta.width, height: meta.height,
        source: 'diffusion-texture', task_id: texture.taskId,
        provenance: { note: '扩散模型只生成纸张/底纹质感，不参与任何地理几何', prompt: TEXTURE_PROMPT },
      }
    }, { proceed: true, message: '质感底纹已生成（只铺背景，不覆盖地理）' })
  }

  if (stage === 'drawing') {
    const spec = loaded.mapSpec
    const base = state.outputs.base_image
    if (!spec || !base) throw new MapWorkflowRequestError('缺少底图或地图几何，无法绘制标注；请先完成底图步骤', 'missing_base')
    const background = await prepareMapBackground({
      basePath: base.path,
      registration: base.provenance && 'registration' in base.provenance ? base.provenance.registration : undefined,
      texturePath: state.outputs.texture_image?.path,
    })
    const outcome = await runDrawingStage({ ...await agentInput(), spec, background })
    if (outcome.kind === 'rollback') return await rollback(outcome)
    const { doc, rendered, geometry, omitted } = outcome.result
    const baseMode = base.provenance && 'mode' in base.provenance ? String(base.provenance.mode) : brief.base_mode
    const versionTaskId = await registerDrawingVersion({
      propId,
      dramaId: loaded.prop.dramaId,
      subject: brief.subject || loaded.prop.name,
      stage: 'drawing',
      rendered,
      geometry,
      extra: {
        base_task_id: base.task_id,
        base_mode: baseMode,
        texture_task_id: state.outputs.texture_image?.task_id ?? null,
        registration: background.registration,
        warnings: background.warnings,
        omitted,
      },
    })
    try {
      const done = await finish((ctx) => {
        ctx.state.outputs.final_image = {
          path: rendered.path, width: rendered.width, height: rendered.height,
          source: 'map-drawing', task_id: versionTaskId,
          provenance: {
            registration: background.registration, warnings: background.warnings, omitted,
            base: base.path, base_mode: baseMode,
            texture: state.outputs.texture_image?.path ?? null,
            background: background.path,
            attribution: base.provenance && 'attribution' in base.provenance ? base.provenance.attribution : null,
          },
        }
        ctx.state.outputs.layer_doc = doc
        ctx.state.issues = [
          ...ctx.state.issues.filter(issue => issue.code !== 'drawing_warning' && issue.code !== 'drawing_omitted'),
          ...background.warnings.map((message): MapWorkflowIssue => ({ field: 'drawing', code: 'drawing_warning', message, blocking: false })),
          ...omitted.map((item): MapWorkflowIssue => ({
            field: 'drawing', code: 'drawing_omitted', blocking: false,
            message: `要素 ${item.feature_id} 未画入成图：${item.reason}`,
          })),
        ]
      }, {
        proceed: true,
        message: `模型已用图层文档作图（${doc.layers.length} 个图层，${rendered.width}×${rendered.height}${omitted.length ? `，省略 ${omitted.length} 个要素` : ''}），待「完成登记」后成为当前图`,
      })
      // 版本行落库成功才通知资产库：下游（图层段来源、审核清单绑定）据此失效重算
      await onAssetLibraryChanged('prop', propId, 'version_registered')
      return done
    } catch (err) {
      await discardVersion(versionTaskId, err)
      throw err
    }
  }

  // complete：当前图 / 忠实原件 / 语义**一次性成对采用**。
  const final = state.outputs.final_image
  const baseTaskId = state.outputs.base_image?.task_id ?? null
  const finalTaskId = final?.task_id ?? null
  const semantics = finalTaskId ? await semanticsOfVersion(finalTaskId) : null
  if (!final || !finalTaskId || !baseTaskId || !semantics) {
    // 成图或语义不合法属于 drawing 交付校验的漏网：回退到 drawing（计入回退次数），不在这里修补
    return await rollback({
      stage: 'drawing',
      reason: !final || !finalTaskId || !baseTaskId ? '完成登记时没有可采用的成图或底图版本' : '成图版本缺少像素几何，无法写语义',
    })
  }
  const completed = await withInfraRetry(propId, taskId, 'complete', () => finish((ctx) => {
    ctx.propPatch.imageUrl = final.path
    ctx.propPatch.localPath = final.path
    ctx.propPatch.faithful = 1
    ctx.propPatch.faithfulSource = baseTaskId
    ctx.propPatch.semantics = JSON.stringify(semantics)
  }, {
    proceed: false,
    message: `已采用成图（版本 #${finalTaskId}）：当前图、忠实底图（版本 #${baseTaskId}）与语义 ${semantics.points.length} 点 / ${semantics.lines.length} 线 / ${semantics.regions.length} 面 一次性生效`,
  }))
  await onAssetLibraryChanged('prop', propId, 'semantics_changed')
  return completed
}

// ───────────────────────────── 任务编排 ─────────────────────────────

async function activeWorkflowTask(propId: number): Promise<number | null> {
  const rows = await db.select().from(schema.sysTask).where(eq(schema.sysTask.type, 'text'))
  const active = rows.find(row => textTaskKindOf(row) === 'map_workflow'
    && Number(parseTextTaskParams(row.params)?.map_prop_id) === propId
    && textTaskOutcome(row.status) === 'running')
  return active?.id ?? null
}

/** 后台跑：auto 跑到底，manual 只跑一步 */
function runStages(propId: number, taskId: number, mode: MapWorkflowMode, startStage: MapWorkflowStage, observation: ObservedWorkInput): void {
  void runWithTextTask(taskId, async () => {
    let stage: MapWorkflowStage | null = startStage
    let lastMessage = ''
    try {
      await runObservedWork(observation, async () => {
        while (stage) {
          const outcome: StageOutcome = await executeStage(propId, taskId, stage)
          lastMessage = outcome.message
          if (!outcome.proceed || mode !== 'auto') break
          stage = outcome.next ?? nextStage(stage)
        }
      })
      const final = await loadWorkflow(propId)
      const status = final?.state.status
      if (status === 'blocked') {
        await finishTextTask(taskId, 'failed', { errorMsg: `地图工作流已阻塞：${lastMessage}` })
      } else {
        await finishTextTask(taskId, 'completed', { outputText: lastMessage || '地图工作流已推进' })
      }
      logTaskSuccess('MapWorkflow', 'run', { taskId, propId, status })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof MapWorkflowStaleError || err instanceof MapWorkflowConflictError) {
        // 结果过期：既有产出原样保留，任务按「已作废」收尾，绝不改状态机
        logTaskWarn('MapWorkflow', 'stale-result', { taskId, propId, error: message })
        await finishTextTask(taskId, 'failed', { errorMsg: `本次执行的结果已作废：${message}` })
        return
      }
      logTaskError('MapWorkflow', 'run', { taskId, propId, error: message })
      try {
        await mutateWorkflow(propId, {
          expectedTaskId: taskId,
          action: 'stage_failed',
          actor: 'system',
          note: message,
          mutate: (ctx) => {
            ctx.state.status = 'failed'
            ctx.state.error = message
            setStep(ctx.state, ctx.state.stage, { status: 'failed', message, finished_at: now() })
            // 人工从失败处重跑时，失败原因与轮次记录作为输入交给该阶段的模型
            ctx.state.agent.feedback[ctx.state.stage] = `上一次执行失败：${message}`
          },
        })
      } catch (nested) {
        logTaskWarn('MapWorkflow', 'fail-write-skipped', { taskId, propId, error: nested instanceof Error ? nested.message : String(nested) })
      }
      await finishTextTask(taskId, 'failed', { errorMsg: message, error: err })
    }
  })
}

async function startRun(propId: number, input: {
  mode: MapWorkflowMode
  expectedRevision?: number | null
  opts: MapRunOptions
  skip?: boolean
}): Promise<MapWorkflowDetail> {
  const existing = await activeWorkflowTask(propId)
  if (existing) {
    throw new MapWorkflowConflictError(`该地图已有正在执行的工作流任务（#${existing}），请等待完成或先取消`, { code: 'workflow_busy', taskId: existing })
  }
  const loaded = await loadWorkflow(propId)
  if (!loaded) throw new MapWorkflowRequestError('道具不存在', 'not_found')
  if (loaded.state.status === 'completed' && loaded.state.stage === 'complete') {
    throw new MapWorkflowRequestError('工作流已完成；如需修改请先回退到要重做的步骤', 'already_completed')
  }
  // 没保存过需求也能直接开跑：主题取资产名、补充说明取资产描述（第一次 CAS 时落库）。
  // 只有连资产名都是空的才拦——那是建卡时就该修的问题。
  const effectiveBrief = briefOfProp(loaded.prop, loaded.state)
  if (!effectiveBrief.subject) {
    throw new MapWorkflowRequestError('该地图资产没有名字，无法确定要画什么；请先补上资产名或在需求里填写主题', 'missing_brief')
  }

  // 继续当前待办；整条重跑必须由人显式回退到 brief，不能把一次拖点变成新的模型账单。
  const startStage = loaded.state.stage
  // 底图与作图阶段的模型要用 read_image 看自己的产物：没有视觉配置就在启动时说清楚，不降级为盲画
  const reachesVision = startStage === 'base' || startStage === 'drawing'
    || (input.mode === 'auto' && stageIndex(startStage) < stageIndex('complete'))
  if (reachesVision && !input.skip) {
    try {
      await resolveStageModel('read_image')
    } catch (err) {
      if (err instanceof StageVisionUnavailableError) {
        throw new MapWorkflowRequestError(`地图的底图与作图阶段需要能看图的文本配置（read_image）：${err.message}`, 'vision_config_unavailable')
      }
      throw err
    }
  }
  if (input.skip) {
    // 跳过只对可选步骤开放：底纹是唯一可以没有的产出
    if (startStage !== 'style') throw new MapWorkflowRequestError(`「${STAGE_LABEL[startStage]}」不能跳过，只有质感底纹是可选的`, 'stage_not_skippable')
    const skipped = await mutateWorkflow(propId, {
      expectedRevision: input.expectedRevision,
      requireIdle: true,
      action: 'stage_skip:style',
      actor: 'manual',
      note: '人工跳过质感底纹',
      mutate: (ctx) => {
        setStep(ctx.state, 'style', { status: 'skipped', message: '人工跳过：成图将直接使用底图，不叠底纹', finished_at: now() })
        ctx.state.stage = 'drawing'
        ctx.state.status = 'awaiting_review'
        ctx.state.outputs.texture_image = null
      },
    })
    return serializeDetail(skipped)
  }

  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
  const stageModel = await resolveStageModel('asset_research', { configId: input.opts.textConfigId ?? loaded.state.text_config_id ?? undefined })
  const taskId = await createTextTask({
    kind: 'map_workflow',
    episodeId: null,
    dramaId: prop?.dramaId ?? null,
    propId,
    stageModel,
    prompt: `地图工作流：${effectiveBrief.subject}`,
  })
  // 底纹认领沿运行链传递（#90）：本次运行若因回退重跑 style，可认领上一运行已付费的同主题底纹，不重复出图
  const [previousRun] = loaded.state.task_id
    ? await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, loaded.state.task_id))
    : []
  const previousParams = parseTextTaskParams(previousRun?.params)
  const reuseTexture = (input.opts.imageConfigId ?? loaded.state.image_config_id) === loaded.state.image_config_id
    && (input.opts.imageModel ?? loaded.state.image_model) === loaded.state.image_model
  await patchTextTaskParams(taskId, {
    map_prop_id: propId, map_stage: startStage, map_mode: input.mode,
    ...(reuseTexture ? {
      map_texture_task_id: previousParams?.map_texture_task_id ?? null,
      map_texture_theme: previousParams?.map_texture_theme ?? null,
    } : {}),
  })

  let detail: MapWorkflowDetail
  try {
    const updated = await mutateWorkflow(propId, {
      expectedRevision: input.expectedRevision,
      requireIdle: true,
      action: input.mode === 'auto' ? `run:${startStage}` : `advance:${startStage}`,
      actor: 'manual',
      note: `模式 ${input.mode}`,
      mutate: (ctx) => {
        ctx.state.mode = input.mode
        ctx.state.task_id = taskId
        // 轮次与回退按运行计数：新运行重新计数，历史尝试与待交给模型的回馈保留
        ctx.state.agent = { ...ctx.state.agent, task_id: taskId, rounds: {}, rollbacks: 0 }
        ctx.state.status = 'running'
        ctx.state.error = null
        ctx.state.stage = startStage
        if (input.opts.textConfigId !== undefined) ctx.state.text_config_id = input.opts.textConfigId ?? null
        if (input.opts.imageConfigId !== undefined) ctx.state.image_config_id = input.opts.imageConfigId ?? null
        if (input.opts.imageModel !== undefined) ctx.state.image_model = input.opts.imageModel ?? null
        // 首次运行把「资产名 + 描述」的初值真正落库；已保存过的需求原样不动
        if (!ctx.state.brief) ctx.state.brief = briefOfProp(ctx.prop, ctx.state)
        if (!ctx.state.brief_hash && ctx.state.brief) ctx.state.brief_hash = briefHash(ctx.state.brief)
        // 重跑：从本阶段起的步骤回到待执行，既有产出保留在 outputs/history 里
        for (const step of ctx.state.steps) {
          if (stageIndex(step.id) >= stageIndex(startStage)) Object.assign(step, { status: 'pending', message: null, started_at: null, finished_at: null })
        }
      },
    })
    detail = serializeDetail(updated)
  } catch (err) {
    // 状态没写成功就不留下孤儿任务
    await cancelTextTask(taskId, err instanceof Error ? err.message : String(err))
    throw err
  }

  logTaskStart('MapWorkflow', 'run', { taskId, propId, mode: input.mode, stage: startStage })
  runStages(propId, taskId, input.mode, startStage, {
    taskId,
    stage: 'map_workflow',
    sourceChars: effectiveBrief.subject.length + effectiveBrief.era.length + effectiveBrief.location.length
      + effectiveBrief.purpose.length + effectiveBrief.notes.length,
    sampleKey: `${buildSampleKey({ stage: 'map_workflow', configId: stageModel.configId, model: stageModel.model })}|start:${startStage}|base:${effectiveBrief.base_mode}`,
  })
  return detail
}

export async function startMapWorkflow(propId: number, input: { mode: MapWorkflowMode; expectedRevision?: number | null } & MapRunOptions): Promise<MapWorkflowDetail> {
  const { mode, expectedRevision, ...opts } = input
  return await startRun(propId, { mode, expectedRevision, opts })
}

export async function advanceMapWorkflow(propId: number, input: { expectedRevision?: number | null; skip?: boolean } & MapRunOptions): Promise<MapWorkflowDetail> {
  const { expectedRevision, skip, ...opts } = input
  return await startRun(propId, { mode: 'manual', expectedRevision, opts, skip })
}

export async function rollbackMapWorkflow(propId: number, stage: MapWorkflowStage, expectedRevision?: number | null): Promise<MapWorkflowDetail> {
  const updated = await mutateWorkflow(propId, {
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
      ctx.state.task_id = null
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
export async function saveMapWorkflowDraft(propId: number, body: {
  expectedRevision?: number | null
  brief?: unknown
  mapSpec?: unknown
  mode?: MapWorkflowMode
}): Promise<MapWorkflowDetail> {
  const hasBrief = body.brief !== undefined
  const hasSpec = body.mapSpec !== undefined
  if (!hasBrief && !hasSpec && body.mode === undefined) {
    throw new MapWorkflowRequestError('请求里没有任何可保存的内容（brief / map_spec / mode 至少给一个）', 'empty_request')
  }
  const updated = await mutateWorkflow(propId, {
    expectedRevision: body.expectedRevision,
    requireIdle: true,
    action: hasSpec ? 'edit_map_spec' : 'edit_brief',
    actor: 'manual',
    note: [hasBrief ? '需求' : '', hasSpec ? '几何' : ''].filter(Boolean).join(' + ') || '模式',
    snapshot: true,
    mutate: (ctx) => {
      if (body.mode) ctx.state.mode = body.mode
      if (hasBrief) {
        const next = normalizeBrief(body.brief, briefOfProp(ctx.prop, ctx.state))
        const changed = briefHash(next) !== ctx.state.brief_hash
        ctx.state.brief = next
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
        ctx.mapSpec = next
        if (JSON.stringify(previous) === JSON.stringify(next)) return
        // 取景或背景层变更才重做底图；拖点/改线只重绘标注，避免无关的外部请求与模型账单。
        const reframed = !previous || !next
          || previous.projection.type !== next.projection.type
          || previous.bbox.some((value, index) => value !== next.bbox[index])
          || JSON.stringify(previous.layers) !== JSON.stringify(next.layers)
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
      }
    },
  })
  return serializeDetail(updated)
}

export async function cancelMapWorkflow(propId: number): Promise<MapWorkflowDetail> {
  const taskId = await activeWorkflowTask(propId)
  if (taskId) await cancelTextTask(taskId, '人工取消地图工作流')
  const updated = await mutateWorkflow(propId, {
    action: 'cancel',
    actor: 'manual',
    note: taskId ? `取消任务 #${taskId}` : '无运行中的任务',
    mutate: (ctx) => {
      for (const step of ctx.state.steps) {
        if (step.status === 'running') Object.assign(step, { status: 'pending', message: '已取消', finished_at: now() })
      }
      // task_id 清空 → 还在跑的那条执行线程的回写会判定为过期，不会再改状态
      ctx.state.task_id = null
      ctx.state.status = ctx.state.status === 'completed' ? 'completed' : 'idle'
      ctx.state.error = null
    },
  })
  return serializeDetail(updated)
}

/** 人工保存的图层文档不合法：字段级问题原样返回给编辑器（不修正、不入库） */
export class MapLayerDocInvalidError extends Error {
  code = 'layer_doc_invalid'
  problems: LayerDocProblem[]
  constructor(problems: LayerDocProblem[]) {
    super(`图层文档不合法（${problems.length} 处）：${problems.slice(0, 3).map(item => `${item.path || '(文档)'} ${item.message}`).join('；')}`)
    this.name = 'MapLayerDocInvalidError'
    this.problems = problems
  }
}

/**
 * 人工在图层编辑器里保存地图成图（Issue #90）。
 *
 * 与模型交付走同一条链：严格校验（不修正）→ 同一 renderLayerDoc 出图 → 登记成图版本（语义从 LayerDoc 导出）
 * → 当前图 / 忠实底图 / 语义一次性 CAS 采用。人工保存不经过模型，校验失败直接返回字段级问题。
 */
export async function saveMapLayerDoc(propId: number, body: { layerDoc: unknown; expectedRevision?: number | null }): Promise<MapWorkflowDetail> {
  const loaded = await loadWorkflow(propId)
  if (!loaded) throw new MapWorkflowRequestError('道具不存在', 'not_found')
  const { state, mapSpec } = loaded
  const current = state.outputs.layer_doc as { base?: { path?: string; width?: number; height?: number } } | null
  const base = state.outputs.base_image
  if (!current?.base?.path || !base?.task_id || !mapSpec) {
    throw new MapWorkflowRequestError('这张地图还没有由工作流绘制出图层文档，不能编辑图层；请先完成「标注绘制」', 'missing_drawing')
  }
  const strict = strictLayerDocProblems(body.layerDoc)
  const problems = [
    ...strict.problems,
    ...backgroundProblems(strict.doc, { path: current.base.path, width: Number(current.base.width), height: Number(current.base.height) })
      .map(message => ({ path: 'base', message })),
  ]
  if (problems.length) throw new MapLayerDocInvalidError(problems)

  const doc = strict.doc
  const rendered = await renderMapLayerDoc(doc)
  const geometry: DrawnGeometry = drawnGeometryOf(doc, specFeatures(mapSpec))
  const finalProvenance = state.outputs.final_image?.provenance ?? {}
  const versionTaskId = await registerDrawingVersion({
    propId,
    dramaId: loaded.prop.dramaId,
    subject: state.brief?.subject || loaded.prop.name,
    stage: 'manual_edit',
    rendered,
    geometry,
    extra: { base_task_id: base.task_id, previous_final_task_id: state.outputs.final_image?.task_id ?? null },
  })
  try {
    const semantics = await semanticsOfVersion(versionTaskId)
    if (!semantics) throw new MapWorkflowRequestError('成图版本缺少像素几何，无法写语义', 'missing_geometry')
    const updated = await mutateWorkflow(propId, {
      expectedRevision: body.expectedRevision,
      requireIdle: true,
      action: 'edit_layer_doc',
      actor: 'manual',
      note: `人工编辑图层（${doc.layers.length} 个图层）`,
      snapshot: true,
      mutate: (ctx) => {
        ctx.state.outputs.final_image = {
          path: rendered.path, width: rendered.width, height: rendered.height,
          source: 'map-drawing-manual', task_id: versionTaskId,
          provenance: { ...finalProvenance, background: current.base!.path, manual_edit: true },
        }
        ctx.state.outputs.layer_doc = doc
        ctx.propPatch.imageUrl = rendered.path
        ctx.propPatch.localPath = rendered.path
        ctx.propPatch.faithful = 1
        ctx.propPatch.faithfulSource = base.task_id
        ctx.propPatch.semantics = JSON.stringify(semantics)
        const message = `人工编辑图层后已采用成图（版本 #${versionTaskId}，语义 ${semantics.points.length} 点 / ${semantics.lines.length} 线 / ${semantics.regions.length} 面）`
        setStep(ctx.state, 'drawing', { status: 'completed', message, finished_at: now() })
        setStep(ctx.state, 'complete', { status: 'completed', message, finished_at: now() })
        ctx.state.stage = 'complete'
        ctx.state.status = 'completed'
        ctx.state.error = null
      },
    })
    await onAssetLibraryChanged('prop', propId, 'version_registered')
    await onAssetLibraryChanged('prop', propId, 'semantics_changed')
    return serializeDetail(updated)
  } catch (err) {
    await discardVersion(versionTaskId, err)
    throw err
  }
}

/**
 * 启动钩子：进程重启后执行线程全部丢失，停在 running 的工作流原地变失败并说明原因。
 * 已产出的底图/底纹/成图全部保留，人决定从哪一步继续（绝不自动重放模型调用与出图）。
 */
export async function failInterruptedMapWorkflows(): Promise<void> {
  const rows = await db.select().from(schema.props)
  let fixed = 0
  for (const row of rows) {
    if (row.deletedAt || (row.assetType ?? 'prop') !== 'map' || !row.mapWorkflow) continue
    // 历史快照也可能含 running；只恢复顶层当前状态，不能让每次启动都污染已完成地图的修订。
    if (parseWorkflow(row.mapWorkflow).status !== 'running') continue
    try {
      await mutateWorkflow(row.id, {
        action: 'restart_interrupted',
        actor: 'system',
        note: '服务重启',
        mutate: (ctx) => {
          if (ctx.state.status !== 'running') return
          const message = '服务重启，地图工作流在执行中被中断；已产出的内容保留，请从当前步骤重新开始'
          ctx.state.status = 'failed'
          ctx.state.error = message
          for (const step of ctx.state.steps) {
            if (step.status === 'running') Object.assign(step, { status: 'failed', message, finished_at: now() })
          }
        },
      })
      fixed++
    } catch (err) {
      logTaskWarn('MapWorkflow', 'restart-cleanup', { propId: row.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (fixed) console.log(`🗺️ 地图工作流：${fixed} 条运行中状态因重启标记为失败（产出保留）`)
}
