import {runObservedWork,listObservedWork} from '../../services/task-observability.js'
/**
 * 流水线各步的执行体（Issue #56）
 *
 * 每一步可重入：research/spec 复用运行参数与版本化事实表；
 * generate 由 (run_id, round_no) 与 prev_run_id 链认领既有图片任务；
 * QC 每轮追加记录，不覆盖历史人工裁决。
 *
 * 模型调用一律走 `resolveStageModel()` + `callTextChat()`，不引入新的模型抽象。
 */
import crypto from 'crypto'
import fs from 'fs'
import sharp from 'sharp'
import {getRun,stmt,parseParams as parseTextTaskParams,patchParams as patchTextTaskParams} from './db.js'
import {getHost,getPlatform} from './registry.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { logTaskProgress, logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel, type StageModel } from '../../services/ai-stages.js'
import { callTextChat, imageContentPart, type ChatContent } from '../../services/vision-chat.js'
import { evaluateGate, normalizeScore, type GateMetric, type GateResult, type SpecForbidden, type SpecMustHave } from './gate.js'
import { sizeBucketFor } from './generator.js'
import { abortableSleep } from './deadline.js'
import { canonicalReferencePath, type ReferenceOrigin } from './references.js'
import {
  parseJsonReply,
  QC_SYSTEM,
  qcUserPrompt,
  SPEC_SYSTEM,
  specUserPrompt,
} from './prompts.js'
import type { AssetResearchResult } from './research/run.js'
import {
  ensureRound,
  getRound,
  getSpec,
  insertQcRecord,
  insertSpec,
  listSources,
  patchRound,
  type AssetKind,
  type AssetRoundRow,
  type AssetSourceRow,
  type AssetSpecRow,
  type QcVerdicts,
  type RoundPurpose,
} from './store.js'

const TEXT_TIMEOUT_MS = 300_000
/**
 * GLM-5.x 的推理与正文共享 `max_tokens`（AGENTS.md「本机后端 · 文本」）：给小了会先
 * 把预算烧在思考上、正文一个字都不剩——实测 6000 时 research 步返回空串。
 * 与既有 Agent 链路同口径读 `AI_MAX_TOKENS`（本机 .env = 131072）。
 */
const TEXT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768
const TEXT_TEMPERATURE = 0.2
const QC_MAX_SIDE = 1600
const QC_JPEG_QUALITY = 85
/** 单轮出图等待上限：qwen-jobs 排队 + 出图实测 1–5 分钟，给到 20 分钟 */
const IMAGE_WAIT_TIMEOUT_MS = 20 * 60_000
const IMAGE_POLL_INTERVAL_MS = 5_000

const METRICS: GateMetric[] = ['count', 'arrangement', 'color', 'shape', 'other']


/**
 * 要 JSON 的模型调用。GLM-5.3 偶发返回**半截合法**的 JSON（实测 spec 步在 position 986
 * 处缺一个逗号，同一提示词下一次又完全正常），一次抖动就让整条 run 失败太脆。
 * 失败时带上解析错误重问一次，仍然不合法才抛——不自己猜着补字符。
 */
async function callJsonChat(
  stageModel: StageModel,
  content: ChatContent,
  opts: { systemPrompt: string; temperature: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const call = async (body: ChatContent): Promise<string> => {
    const reply = await callTextChat(stageModel, body, {
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxTokens: TEXT_MAX_TOKENS,
      timeoutMs: TEXT_TIMEOUT_MS,
      // 步骤时限到期 → 这条请求当场被 abort，而不是留在连接池里空转
      signal: opts.signal,
    })
    return reply.text
  }
  const first = await call(content)
  try {
    return parseJsonReply(first) as Record<string, unknown>
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logTaskWarn('AssetPipeline', 'json-retry', { stage: stageModel.stage, reason })
    const retryText = `上一次的回答不是合法 JSON（解析报错：${reason}）。请**只**输出一个合法的 JSON 对象，不要任何解释、不要 Markdown 代码块、字符串内不要出现未转义的换行或引号。`
    const retryContent: ChatContent = typeof content === 'string'
      ? `${content}\n\n${retryText}`
      : [...content, { type: 'text', text: retryText }]
    return parseJsonReply(await call(retryContent)) as Record<string, unknown>
  }
}

export interface AssetTarget {
  kind: AssetKind
  id: number
  dramaId: number
  name: string
  description: string | null
  imageUrl: string | null
  faithful: boolean
}

/** 三类资产的最小公共视图：流水线对角色/场景/道具一视同仁（用户确认目标 4） */
export async function loadAssetTarget(kind: AssetKind, id: number, runId?: number): Promise<AssetTarget | null> {
  const frozen = runId ? parseTextTaskParams(getRun(runId)?.params).snapshot as AssetTarget | undefined : undefined
  return frozen ?? getHost().readAsset(`${kind}:${id}`)
}

export async function writeStep(pipelineTaskId: number, step: string): Promise<void> {
  const row = getRun(pipelineTaskId)
  const params = parseTextTaskParams(row?.params)
  await patchTextTaskParams(pipelineTaskId, {
    progress: { completed: params?.progress?.completed ?? 0, total: params?.progress?.total ?? 0, failed: 0, step },
  })
  if(row)stmt('UPDATE asset_studio_task SET updated_at=? WHERE id=?').run(new Date().toISOString(),row.task_id)
  logTaskProgress('AssetPipeline', 'step', { taskId: pipelineTaskId, step })
}


// ─── research ────────────────────────────────────────────────

/**
 * 流水线冻结的资料：#79 起是真实检索结果（文字摘录 + 视觉判断过的图像候选）；
 * #79 之前的 run 冻结的是模型凭记忆列的线索（candidates/key_facts/notes），重放时原样交给事实表。
 */
export type ResearchResult = AssetResearchResult | Record<string, unknown>

// 资料研究步已删（Issue #123）：精确草稿显式选用检索记录，未选则无检索输入，不再内联兜底。

// ─── spec ────────────────────────────────────────────────────

function normalizeMustHave(raw: unknown): SpecMustHave[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, index): SpecMustHave[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const element = String(record.element ?? '').trim()
    if (!element) return []
    const metric = String(record.metric ?? '').trim() as GateMetric
    return [{
      id: String(record.id ?? `mh${index + 1}`).trim() || `mh${index + 1}`,
      element,
      why: String(record.why ?? ''),
      check: String(record.check ?? ''),
      metric: METRICS.includes(metric) ? metric : 'other',
    }]
  })
}

function normalizeForbidden(raw: unknown): SpecForbidden[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, index): SpecForbidden[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const error = String(record.error ?? '').trim()
    if (!error) return []
    return [{
      id: String(record.id ?? `fb${index + 1}`).trim() || `fb${index + 1}`,
      error,
      why: String(record.why ?? ''),
    }]
  })
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(item => String(item).trim()).filter(Boolean) : []
}

export interface RunSpecInput {
  pipelineTaskId: number
  target: AssetTarget
  research: ResearchResult
  textConfigId?: number
  signal?: AbortSignal
  /** 草稿展开传选中素材行，覆盖默认全量 listSources（Issue #123） */
  sources?: AssetSourceRow[]
  /** 观测隔离：draft 展开传 'asset_studio_draft'，taskId=draft.id（与 run.id 各自自增会撞号） */
  scope?: string
  /** 草稿阶段无 run 行：跳过 run.params 读写，spec_id 由调用方落 draft */
  skipRunParams?: boolean
}

async function runSpecBody(input: RunSpecInput): Promise<AssetSpecRow> {
  if (!input.skipRunParams) {
    const row = getRun(input.pipelineTaskId)
    const specId = parseTextTaskParams(row?.params)?.asset_spec_id as number | undefined
    if (specId) {
      const existing = await getSpec(specId)
      if (existing) return existing
    }
  }

  const stageModel = await resolveStageModel('asset_spec', { configId: input.textConfigId })
  const sources = input.sources ?? await listSources(input.target.kind, input.target.id)
  const parsed = await callJsonChat(stageModel, specUserPrompt({
    assetKind: input.target.kind,
    name: input.target.name,
    description: input.target.description,
    research: input.research,
    sources,
  }), { systemPrompt: SPEC_SYSTEM, temperature: TEXT_TEMPERATURE, signal: input.signal })
  const mustHave = normalizeMustHave(parsed.must_have)
  if (!mustHave.length) throw new Error('事实表为空：模型没有给出任何 must_have 条目')

  const spec = await insertSpec({
    assetKind: input.target.kind,
    assetId: input.target.id,
    summary: String(parsed.summary ?? ''),
    mustHave,
    forbidden: normalizeForbidden(parsed.forbidden),
    tolerances: stringList(parsed.tolerances),
    uncertainties: stringList(parsed.uncertainties),
    palette: typeof parsed.palette === 'string' ? parsed.palette : null,
    composition: typeof parsed.composition === 'string' ? parsed.composition : null,
    sources: sources.map(item => ({
      source_id: item.id,
      kind: item.url ? (item.url.includes('wikipedia.org') ? 'wikipedia' as const : item.url.includes('wikimedia.org') ? 'commons' as const : 'web' as const) : 'local' as const,
      url: item.url,
      license: item.license,
      artist: item.artist,
      sha256: item.sha256,
      local_path: item.local_path,
      role: item.role,
      ...(item.why_excluded ? { why_excluded: item.why_excluded } : {}),
      ...(item.era ? { era: item.era } : {}),
    })),
    createdByStage: 'asset_spec',
  })
  if (!input.skipRunParams) {
    await patchTextTaskParams(input.pipelineTaskId, { asset_spec_id: spec.id, asset_spec_version: spec.version })
    await invalidateFinalPromptForSpec(input.target, spec.version)
  }
  return spec
}

/**
 * 事实表出新版本 → 该资产的最终提示词失效（Issue #56 验收 14）。
 * 走既有的 `planFinalPromptWrite()` 出口，不另起一套清空逻辑。
 * `faithful=1` 的证据素材不进生图链路（final-prompt.ts:130 的 skipped），一律不动。
 */
async function invalidateFinalPromptForSpec(target: AssetTarget, version: number): Promise<void> {
  await getHost().invalidateFinalPrompt(`${target.kind}:${target.id}`,version)
}

// ─── generate ────────────────────────────────────────────────

async function waitForImageTask(
  taskId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; path: string | null; error: string | null }> {
  const deadline = Date.now() + IMAGE_WAIT_TIMEOUT_MS
  for (;;) {
    const task=await getPlatform().pollImage(taskId)
    if(task.status==='completed')return {ok:true,path:task.path,error:null}
    if(['failed','cancelled','missing'].includes(task.status))return {ok:false,path:null,error:task.error??'生成失败'}
    if (Date.now() > deadline) return { ok: false, path: null, error: '等待生成超时' }
    // 本步时限到期：停止轮询并说明原因（生图任务本身不作废，重跑时按幂等守卫认领）
    if (signal?.aborted) return { ok: false, path: null, error: '已超出本步时限，停止等待生成' }
    await abortableSleep(IMAGE_POLL_INTERVAL_MS, signal)
  }
}

/**
 * 冻结输入的一次生图（Issue #123，取代 runGenerateBody）：prompt/参考图/spec 全部由
 * generateFromDraft 冻结传入——不重建 prompt、不读 spec、不做 faithful 拦截（isMap 保留）。
 * **幂等**：先按 `(pipeline_task_id, round_no)` 查轮次行，已下过单只继续等那条生图任务。
 * **取消守卫**：每个写回点检查 run.status，非 running 即中止（取消后不得复活）。
 */
export async function runGenerateFrozen(input: {
  pipelineTaskId: number
  episodeId: number
  target: AssetTarget
  roundNo: number
  purpose: RoundPurpose
  prompt: string
  negativePrompt: string | null
  referenceImages: string[]
  referenceOrigins: ReferenceOrigin[]
  specId: number | null
  configId?: number | null
  model?: string | null
  signal?: AbortSignal
}): Promise<AssetRoundRow> {
  const latestTarget = await getHost().readAsset(`${input.target.kind}:${input.target.id}`)
  if (!latestTarget || latestTarget.isMap) throw new Error('地图资产请走地图工作室，不能进入生图')
  const assertRunning = () => {
    const run = getRun(input.pipelineTaskId)
    if (!run || run.status !== 'running') throw new Error('运行已取消或中断，停止生图')
  }
  assertRunning()
  const generator = await getPlatform().imageSelection({ configId: input.configId, model: input.model })
  const referenceIds = input.referenceOrigins.flatMap(item => item.type === 'source' ? [item.source_id] : [])

  const { round, created } = await ensureRound({
    pipelineTaskId: input.pipelineTaskId,
    assetKind: input.target.kind,
    assetId: input.target.id,
    specId: input.specId,
    roundNo: input.roundNo,
    purpose: input.purpose,
    generator: generator.generator,
    configId: generator.configId,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    referenceIds,
  })
  if (!created && round.status === 'generated' && round.image_path) return round

  let imageTaskId = round.image_task_id
  if (!imageTaskId && round.status === 'generating') {
    // 崩溃窗口（下单成功但 image_task_id 还没落库）：按 owner + 提示词 + 轮次创建时间认领，绝不重复下单
    imageTaskId = await adoptOrphanImageTask(input.target, input.prompt, round.created_at)
    if (imageTaskId) {
      await patchRound(round.id, { imageTaskId })
      logTaskProgress('AssetPipeline', 'adopted-orphan-image-task', { roundId: round.id, imageTaskId })
    }
  }
  if (!imageTaskId) {
    assertRunning()
    // 尺寸政策（评审 P2-9）：美化一律按所选版本图的宽高取 bucket（含场景，保持构图画幅）；
    // 精确：场景按项目画幅锁定（#94），角色/道具按首张参考图取 bucket（语义坐标不变量）。
    const scene = input.target.kind === 'scene'
    const followBase = input.purpose === 'beautify' || !scene
    let size: string | undefined = scene && input.purpose !== 'beautify' ? await getPlatform().sceneSize(input.target.dramaId) : undefined
    const aspectLocked = scene && input.purpose !== 'beautify'
    const base = followBase && input.referenceImages[0] ? canonicalReferencePath(input.referenceImages[0]) : null
    if (base) {
      try {
        const meta = await sharp(base).metadata()
        if (meta.width && meta.height) size = sizeBucketFor(meta.width, meta.height)
      } catch (err) {
        logTaskWarn('AssetPipeline', 'base-metadata-failed', { base, error: err instanceof Error ? err.message : String(err) })
      }
    }
    await patchRound(round.id, { status: 'generating', generator: generator.generator, configId: generator.configId })
    imageTaskId = (await getPlatform().submitImage({
      hostRef: `${input.target.kind}:${input.target.id}`, episodeId: input.episodeId, prompt: input.prompt, negativePrompt: input.negativePrompt ?? undefined,
      size, aspectLocked, model: generator.model, configId: generator.configId,
      referenceImages: input.referenceImages, referenceOrigins: input.referenceOrigins, roundKey: `${input.pipelineTaskId}:${input.roundNo}`,
    })).taskId
    await patchRound(round.id, { imageTaskId })
  }

  const waited = await waitForImageTask(imageTaskId, input.signal)
  assertRunning()
  if (!waited.ok || !waited.path) {
    await patchRound(round.id, { status: 'failed', errorMsg: waited.error })
    throw new Error(`第 ${input.roundNo} 轮出图失败：${waited.error}`)
  }
  const absolute = getAbsolutePath(waited.path)
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
  const meta = await sharp(absolute).metadata()
  await patchRound(round.id, {
    status: 'generated',
    imagePath: waited.path,
    imageSha256: sha256,
    width: meta.width ?? null,
    height: meta.height ?? null,
    errorMsg: null,
  })
  return (await getRound(round.id))!
}

/**
 * 认领「已下单但没来得及记 id」的生图任务。
 * `generateImage()` 返回之前进程被杀 → 轮次行停在 `generating` 且 `image_task_id` 为空；
 * 重放时如果直接再下一单，就会白烧一张图。按 owner + 完全相同的提示词 + 时间窗认领。
 */
async function adoptOrphanImageTask(target: AssetTarget, prompt: string, since: string): Promise<number | null> {
  return getPlatform().adoptOrphanImage(`${target.kind}:${target.id}`,prompt,since)
}

// ─── qc + gate ───────────────────────────────────────────────

function normalizeQcVerdicts(raw: Record<string, unknown>): QcVerdicts {
  const mustHave = Array.isArray(raw.must_have) ? raw.must_have as QcVerdicts['must_have'] : []
  const forbidden = Array.isArray(raw.forbidden) ? raw.forbidden as QcVerdicts['forbidden'] : []
  const text = raw.text_in_image && typeof raw.text_in_image === 'object'
    ? raw.text_in_image as { present?: unknown; overlay?: unknown; evidence?: unknown }
    : {}
  return {
    must_have: mustHave,
    forbidden,
    text_in_image: {
      present: typeof text.present === 'boolean' ? text.present : null,
      // 模型没给 overlay 就是 null：闸门据此判「清单不完整」，不替它猜是不是额外标注
      overlay: typeof text.overlay === 'boolean' ? text.overlay : null,
      evidence: String(text.evidence ?? ''),
    },
    locate: Array.isArray(raw.locate) ? raw.locate as QcVerdicts['locate'] : [],
    overall: typeof raw.overall === 'string' ? raw.overall : undefined,
  }
}

export interface QcOutcome { gate: GateResult; verdicts: QcVerdicts; qcId: number }

export interface RunQcInput {
  target: AssetTarget
  spec: AssetSpecRow
  round: AssetRoundRow
  /** 位置一致性的期望坐标（地图来自投影；没有就不做定位核对） */
  expected?: Array<{ id: string; name: string; at: [number, number] }>
  textConfigId?: number
  signal?: AbortSignal
  scope?: string
}

async function runQcBody(input: RunQcInput): Promise<QcOutcome> {
  if (!input.round.image_path) throw new Error('该轮没有产出图，无法质检')
  const stageModel = await resolveStageModel('asset_qc', { configId: input.textConfigId })
  const prepared = await imageContentPart(input.round.image_path, { maxSide: QC_MAX_SIDE, quality: QC_JPEG_QUALITY })
  const context=await getHost().semanticsContext(`${input.target.kind}:${input.target.id}`)
  const labels=context.labels
  const framing = `这是一张 ${prepared.width}×${prepared.height} 像素的图片（原点在左上角）。`
  const labelQuestion = labels.length
    ? `\n另外回答 labels_readable：对下列文字逐条给 {"text":"","readable":true/false}，表示它在这张图上是否仍清晰可读：${labels.join('、')}`
    : ''

  const parsed = await callJsonChat(stageModel, [
    { type: 'text', text: qcUserPrompt(input.spec, framing) + labelQuestion },
    prepared.part,
  ], { systemPrompt: QC_SYSTEM, temperature: 0.1, signal: input.signal })
  const verdicts = normalizeQcVerdicts(parsed)
  const labelsReadable = Array.isArray(parsed.labels_readable)
    ? (parsed.labels_readable as Array<{ text: string; readable: boolean }>)
    : undefined

  const semanticsPreserved = await getPlatform().checkSemantics({
    hostRef:`${input.target.kind}:${input.target.id}`,
    absPath: getAbsolutePath(input.round.image_path),
    labelsReadable,
  })

  const gate = evaluateGate(
    {
      must_have: input.spec.must_have,
      forbidden: input.spec.forbidden,
      tolerances: input.spec.tolerances,
      locate_targets: input.spec.locate_targets,
      locate_anchors: input.spec.locate_anchors,
    },
    {
      must_have: verdicts.must_have,
      forbidden: verdicts.forbidden,
      text_in_image: verdicts.text_in_image,
      locate: verdicts.locate,
      overall: verdicts.overall,
    },
    { expected: input.expected??context.expected, semanticsPreserved },
  )

  const record = await insertQcRecord({
    roundId: input.round.id,
    assetKind: input.target.kind,
    assetId: input.target.id,
    modelConfigId: stageModel.configId,
    verdicts,
    gate,
    fidelityScore: normalizeScore(parsed.fidelity_score),
    beautyScore: normalizeScore(parsed.beauty_score),
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
  })
  logTaskProgress('AssetPipeline', 'gate', {
    roundId: input.round.id,
    pass: gate.pass,
    coverage: gate.coverage,
    invalid: gate.invalid.length,
    violations: gate.violations.length,
  })
  return { gate, verdicts, qcId: record.id }
}

async function observed<T>(runId:number,stage:string,fn:()=>Promise<T>,scope='asset_studio',skipRunParams=false):Promise<T>{
  const startedAt=Date.now()
  const before=listObservedWork(runId,scope)
  const after=Math.max(0,...before.map(work=>work.id))
  const params=skipRunParams?{}:parseTextTaskParams(getRun(runId)?.params)
  const prior=Array.isArray(params.stage_spans)?params.stage_spans:[]
  const span={stage,started_at:startedAt,finished_at:null,status:'running',after_work_id:after,work_ids:[]}
  if(!skipRunParams)await patchTextTaskParams(runId,{stage_spans:[...prior,span]})
  let status='completed'
  try{
    return await runObservedWork({
      taskId:runId,scope,stage:'asset_studio',
      sourceChars:String(params.snapshot?.description??'').length,
      sampleKey:`asset_studio:${stage}`,
    },fn)
  }catch(error){
    status='failed'
    throw error
  }finally{
    if(!skipRunParams){
      const latest=parseTextTaskParams(getRun(runId)?.params)
      const workIds=listObservedWork(runId,scope).filter(work=>work.id>after).map(work=>work.id)
      await patchTextTaskParams(runId,{stage_spans:latest.stage_spans.map((entry:typeof span)=>
        entry.started_at===startedAt&&entry.stage===stage
          ? {...entry,finished_at:Date.now(),status,work_ids:workIds}:entry)})
    }
  }
}
export function runSpec(input: RunSpecInput): Promise<AssetSpecRow> { return observed(input.pipelineTaskId, 'spec', () => runSpecBody(input), input.scope ?? 'asset_studio', input.skipRunParams ?? false) }
export function runQc(input: RunQcInput): Promise<QcOutcome> { return observed(input.round.pipeline_task_id, 'qc', () => runQcBody(input), input.scope ?? 'asset_studio') }
