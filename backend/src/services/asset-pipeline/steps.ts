/**
 * 流水线各步的执行体（Issue #56）
 *
 * 每一步都**可重入**：重启后整条 run 会从头重放一遍，昂贵步必须先查库再决定要不要干活。
 * - research / spec：结果已落在 `sys_task.params` / `asset_spec` 里就直接复用，绝不重算；
 * - generate：`asset_round(pipeline_task_id, round_no)` 唯一索引是幂等落点，已有行只继续轮询；
 * - qc：10–20 s 的便宜步，允许重算，每次追加一条 `asset_qc_record`。
 *
 * 模型调用一律走 `resolveStageModel()` + `callTextChat()`，不引入新的模型抽象。
 */
import crypto from 'crypto'
import fs from 'fs'
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db, schema } from '../../db/index.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { logTaskProgress, logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel, type StageModel } from '../ai-stages.js'
import { callTextChat, imageContentPart, type ChatContent } from '../vision-chat.js'
import { generateImage } from '../generation.js'
import { getDramaStylePrompt } from '../style-preset.js'
import { patchTextTaskParams, parseTextTaskParams } from '../text-task.js'
import { classifyPromptInvalidation, planFinalPromptWrite } from '../asset-prompt-invalidation.js'
import { evaluateGate, normalizeScore, type GateMetric, type GateResult, type SpecForbidden, type SpecMustHave } from './gate.js'
import { pickGenerator, sizeBucketFor } from './generator.js'
import { abortableSleep } from './deadline.js'
import { canonicalReferencePath, resolveReferenceOrigins, type ReferenceOrigin } from './references.js'
import {
  buildImagePrompt,
  buildNegativePrompt,
  parseJsonReply,
  QC_SYSTEM,
  qcUserPrompt,
  RESEARCH_SYSTEM,
  researchUserPrompt,
  SPEC_SYSTEM,
  specUserPrompt,
} from './prompts.js'
import { checkSemanticsPreserved, semanticsLabelsToCheck } from './semantics-check.js'
import {
  ensureRound,
  getSpec,
  insertQcRecord,
  insertSpec,
  listSources,
  listAssetRounds,
  patchRound,
  type AssetKind,
  type AssetRoundRow,
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
export async function loadAssetTarget(kind: AssetKind, id: number): Promise<AssetTarget | null> {
  if (kind === 'character') {
    const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    if (!row || row.deletedAt) return null
    return {
      kind, id, dramaId: row.dramaId, name: row.name,
      description: [row.appearance, row.styling, row.description].filter(Boolean).join('；') || null,
      imageUrl: row.localPath || row.imageUrl || null, faithful: false,
    }
  }
  if (kind === 'scene') {
    const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
    if (!row || row.deletedAt) return null
    return {
      // 场景没有 name 列，地点就是它的名字（schema.ts scenes.location）
      kind, id, dramaId: row.dramaId, name: row.location,
      description: [row.time, row.lighting, row.prompt].filter(Boolean).join('；') || null,
      imageUrl: row.localPath || row.imageUrl || null, faithful: false,
    }
  }
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!row || row.deletedAt) return null
  return {
    kind, id, dramaId: row.dramaId, name: row.name,
    description: [row.type, row.description].filter(Boolean).join('；') || null,
    imageUrl: row.localPath || row.imageUrl || null, faithful: row.faithful === 1,
  }
}

export async function writeStep(pipelineTaskId: number, step: string): Promise<void> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, pipelineTaskId))
  const params = parseTextTaskParams(row?.params)
  await patchTextTaskParams(pipelineTaskId, {
    progress: { completed: params?.progress?.completed ?? 0, total: params?.progress?.total ?? 0, failed: 0, step },
  })
  logTaskProgress('AssetPipeline', 'step', { taskId: pipelineTaskId, step })
}


// ─── research ────────────────────────────────────────────────

export interface ResearchResult {
  candidates: Array<{ url: string; title?: string; artist?: string; license_hint?: string; era?: string; what_it_proves?: string }>
  key_facts: string[]
  notes: string
}

/**
 * 资料研究：只产出**候选线索**，绝不自动抓取（主进程裁决「必须改 1」）。
 * 维基系对本机 429/403，自动抓取既不可靠也绕过了许可核对。
 */
export async function runResearch(input: {
  pipelineTaskId: number
  target: AssetTarget
  textConfigId?: number
  signal?: AbortSignal
}): Promise<{ result: ResearchResult; stageModel: StageModel }> {
  const stageModel = await resolveStageModel('asset_research', { configId: input.textConfigId })
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, input.pipelineTaskId))
  const cached = parseTextTaskParams(row?.params)?.asset_research as ResearchResult | undefined
  if (cached?.key_facts) return { result: cached, stageModel }

  const sources = await listSources(input.target.kind, input.target.id)
  const parsed = await callJsonChat(stageModel, researchUserPrompt({
    assetKind: input.target.kind,
    name: input.target.name,
    description: input.target.description,
    era: null,
    existing: sources,
  }), { systemPrompt: RESEARCH_SYSTEM, temperature: TEXT_TEMPERATURE, signal: input.signal }) as Partial<ResearchResult>
  const result: ResearchResult = {
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    key_facts: Array.isArray(parsed.key_facts) ? parsed.key_facts : [],
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
  }
  await patchTextTaskParams(input.pipelineTaskId, { asset_research: result })
  return { result, stageModel }
}

// ─── curate ──────────────────────────────────────────────────

/** 素材筛选：角色由人工在面板上定，这里只汇总并把缺口写成告警 */
export async function runCurate(target: AssetTarget): Promise<{ usable: number; rejected: number; warnings: string[] }> {
  const sources = await listSources(target.kind, target.id)
  const usable = sources.filter(item => item.role !== 'rejected')
  const rejected = sources.filter(item => item.role === 'rejected')
  const warnings: string[] = []
  if (!usable.length) {
    warnings.push('没有任何可用素材：事实表只能依据文字资料，图像佐证缺失已记入 uncertainties')
  }
  if (usable.some(item => !item.license.trim())) warnings.push('有素材缺少许可信息')
  return { usable: usable.length, rejected: rejected.length, warnings }
}

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

export async function runSpec(input: {
  pipelineTaskId: number
  target: AssetTarget
  research: ResearchResult
  textConfigId?: number
  signal?: AbortSignal
}): Promise<AssetSpecRow> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, input.pipelineTaskId))
  const specId = parseTextTaskParams(row?.params)?.asset_spec_id as number | undefined
  if (specId) {
    const existing = await getSpec(specId)
    if (existing) return existing
  }

  const stageModel = await resolveStageModel('asset_spec', { configId: input.textConfigId })
  const sources = await listSources(input.target.kind, input.target.id)
  const parsed = await callJsonChat(stageModel, specUserPrompt({
    assetKind: input.target.kind,
    name: input.target.name,
    description: input.target.description,
    research: JSON.stringify(input.research),
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
  await patchTextTaskParams(input.pipelineTaskId, { asset_spec_id: spec.id, asset_spec_version: spec.version })
  await invalidateFinalPromptForSpec(input.target, spec.version)
  return spec
}

/**
 * 事实表出新版本 → 该资产的最终提示词失效（Issue #56 验收 14）。
 * 走既有的 `planFinalPromptWrite()` 出口，不另起一套清空逻辑。
 * `faithful=1` 的证据素材不进生图链路（final-prompt.ts:130 的 skipped），一律不动。
 */
async function invalidateFinalPromptForSpec(target: AssetTarget, version: number): Promise<void> {
  if (version <= 1) return
  if (target.kind === 'prop' && target.faithful) return
  const decision = classifyPromptInvalidation({ kind: target.kind, current: {}, updates: {}, specVersionChanged: true })
  if (!decision.changed) return
  const table = target.kind === 'character' ? schema.characters : target.kind === 'scene' ? schema.scenes : schema.props
  const [row] = await db.select().from(table).where(eq(table.id, target.id))
  const write = planFinalPromptWrite({
    currentFinalPrompt: row?.finalPrompt ?? null,
    sourceChanged: true,
    at: new Date().toISOString(),
  })
  if (!Object.keys(write).length) return
  await db.update(table).set({ ...write, updatedAt: new Date().toISOString() }).where(eq(table.id, target.id))
  logTaskProgress('AssetPipeline', 'final-prompt-invalidated', {
    assetKind: target.kind, assetId: target.id, specVersion: version, source: decision.source,
  })
}

// ─── generate ────────────────────────────────────────────────

async function waitForImageTask(
  taskId: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; path: string | null; error: string | null }> {
  const deadline = Date.now() + IMAGE_WAIT_TIMEOUT_MS
  for (;;) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) return { ok: false, path: null, error: '生成任务记录丢失' }
    if (task.status === 'completed') return { ok: true, path: task.localPath || task.resultUrl || null, error: null }
    if (task.status === 'failed' || task.status === 'cancelled') {
      return { ok: false, path: null, error: task.errorMsg || '生成失败' }
    }
    if (Date.now() > deadline) return { ok: false, path: null, error: '等待生成超时' }
    // 本步时限到期：停止轮询并说明原因（生图任务本身不作废，重跑时按幂等守卫认领）
    if (signal?.aborted) return { ok: false, path: null, error: '已超出本步时限，停止等待生成' }
    await abortableSleep(IMAGE_POLL_INTERVAL_MS, signal)
  }
}

/**
 * 出一轮图。**幂等**：先按 `(pipeline_task_id, round_no)` 查轮次行，已经下过单就只继续等那条
 * 生图任务（重启重放时绝不重复下单——那是最贵的一步）。
 */
export async function runGenerate(input: {
  pipelineTaskId: number
  episodeId: number
  target: AssetTarget
  spec: AssetSpecRow
  roundNo: number
  purpose: RoundPurpose
  /** 上一轮被勾中的 violation 文本，拼进本轮提示词 */
  reviseNotes: string[]
  /** 参考图（精确轮用素材，美化轮用上一轮产出图） */
  referenceImages: string[]
  /** IDs carried forward from selection; omitted callers use unique path lookup only. */
  referenceOrigins?: ReferenceOrigin[]
  configId?: number | null
  model?: string | null
  signal?: AbortSignal
}): Promise<AssetRoundRow> {
  const generator = await pickGenerator({
    assetKind: input.target.kind,
    purpose: input.purpose,
    configId: input.configId,
    model: input.model,
  })
  const stylePrompt = input.purpose === 'beautify' ? await getDramaStylePrompt(input.target.dramaId) : null
  const prompt = buildImagePrompt(input.spec, {
    name: input.target.name,
    purpose: input.purpose,
    reviseNotes: input.reviseNotes,
    stylePrompt,
  })
  const negativePrompt = buildNegativePrompt(input.spec)

  const referenceOrigins = resolveReferenceOrigins(
    input.referenceImages,
    await listSources(input.target.kind, input.target.id),
    (await listAssetRounds(input.target.kind, input.target.id)).filter(round =>
      round.pipeline_task_id !== input.pipelineTaskId || round.round_no < input.roundNo),
    input.referenceOrigins,
  )
  const referenceIds = referenceOrigins.flatMap(item => item.type === 'source' ? [item.source_id] : [])

  const { round, created } = await ensureRound({
    pipelineTaskId: input.pipelineTaskId,
    assetKind: input.target.kind,
    assetId: input.target.id,
    specId: input.spec.id,
    roundNo: input.roundNo,
    purpose: input.purpose,
    generator: generator.generator,
    configId: generator.configId,
    prompt,
    negativePrompt,
    referenceIds,
  })
  if (!created && round.status === 'generated' && round.image_path) return round

  let imageTaskId = round.image_task_id
  if (!imageTaskId && round.status === 'generating') {
    // 崩溃窗口（下单成功但 image_task_id 还没落库）：按 owner + 提示词 + 轮次创建时间
    // 认领已经存在的那条生图任务，绝不重复下单
    imageTaskId = await adoptOrphanImageTask(input.target, prompt, round.created_at)
    if (imageTaskId) {
      await patchRound(round.id, { imageTaskId })
      logTaskProgress('AssetPipeline', 'adopted-orphan-image-task', { roundId: round.id, imageTaskId })
    }
  }
  if (!imageTaskId) {
    // 派生图必须与底图同画幅，否则既有语义坐标全部错位（prop-beautify.ts:62 的不变量）
    let size: string | undefined
    const base = input.referenceImages[0] ? canonicalReferencePath(input.referenceImages[0]) : null
    if (base) {
      try {
        const meta = await sharp(base).metadata()
        if (meta.width && meta.height) size = sizeBucketFor(meta.width, meta.height)
      } catch (err) {
        logTaskWarn('AssetPipeline', 'base-metadata-failed', { base, error: err instanceof Error ? err.message : String(err) })
      }
    }
    await patchRound(round.id, { status: 'generating', generator: generator.generator, configId: generator.configId })
    imageTaskId = await generateImage({
      ...(input.target.kind === 'character' ? { characterId: input.target.id } : {}),
      ...(input.target.kind === 'scene' ? { sceneId: input.target.id } : {}),
      ...(input.target.kind === 'prop' ? { propId: input.target.id } : {}),
      episodeId: input.episodeId,
      dramaId: input.target.dramaId,
      prompt,
      model: generator.model,
      size,
      referenceImages: input.referenceImages.length ? input.referenceImages : undefined,
      pipelineReferenceOrigins: referenceOrigins,
      configId: generator.configId ?? undefined,
      pipelineRound: true,
    })
    await patchRound(round.id, { imageTaskId })
  }

  const waited = await waitForImageTask(imageTaskId, input.signal)
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
  const updated = await ensureRound({
    pipelineTaskId: input.pipelineTaskId,
    assetKind: input.target.kind,
    assetId: input.target.id,
    specId: input.spec.id,
    roundNo: input.roundNo,
    purpose: input.purpose,
    generator: generator.generator,
    configId: generator.configId,
    prompt,
    negativePrompt,
    referenceIds,
  })
  return updated.round
}

/**
 * 认领「已下单但没来得及记 id」的生图任务。
 * `generateImage()` 返回之前进程被杀 → 轮次行停在 `generating` 且 `image_task_id` 为空；
 * 重放时如果直接再下一单，就会白烧一张图。按 owner + 完全相同的提示词 + 时间窗认领。
 */
async function adoptOrphanImageTask(target: AssetTarget, prompt: string, since: string): Promise<number | null> {
  const ownerColumn = target.kind === 'character'
    ? schema.sysTask.characterId
    : target.kind === 'scene' ? schema.sysTask.sceneId : schema.sysTask.propId
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'image'),
    eq(ownerColumn, target.id),
  ))
  const candidates = rows
    .filter(row => row.prompt === prompt && row.createdAt >= since)
    .sort((a, b) => a.id - b.id)
  return candidates[0]?.id ?? null
}

// ─── qc + gate ───────────────────────────────────────────────

function normalizeQcVerdicts(raw: Record<string, unknown>): QcVerdicts {
  const mustHave = Array.isArray(raw.must_have) ? raw.must_have as QcVerdicts['must_have'] : []
  const forbidden = Array.isArray(raw.forbidden) ? raw.forbidden as QcVerdicts['forbidden'] : []
  const text = raw.text_in_image && typeof raw.text_in_image === 'object'
    ? raw.text_in_image as { present?: unknown; evidence?: unknown }
    : {}
  return {
    must_have: mustHave,
    forbidden,
    text_in_image: {
      present: typeof text.present === 'boolean' ? text.present : null,
      evidence: String(text.evidence ?? ''),
    },
    locate: Array.isArray(raw.locate) ? raw.locate as QcVerdicts['locate'] : [],
    overall: typeof raw.overall === 'string' ? raw.overall : undefined,
  }
}

export async function runQc(input: {
  target: AssetTarget
  spec: AssetSpecRow
  round: AssetRoundRow
  /** 位置一致性的期望坐标（地图来自投影；没有就不做定位核对） */
  expected?: Array<{ id: string; name: string; at: [number, number] }>
  textConfigId?: number
  signal?: AbortSignal
}): Promise<{ gate: GateResult; verdicts: QcVerdicts; qcId: number }> {
  if (!input.round.image_path) throw new Error('该轮没有产出图，无法质检')
  const stageModel = await resolveStageModel('asset_qc', { configId: input.textConfigId })
  const prepared = await imageContentPart(input.round.image_path, { maxSide: QC_MAX_SIDE, quality: QC_JPEG_QUALITY })
  const labels = await semanticsLabelsToCheck(input.target.kind, input.target.id)
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

  const semanticsPreserved = await checkSemanticsPreserved({
    assetKind: input.target.kind,
    assetId: input.target.id,
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
    { expected: input.expected, semanticsPreserved },
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
