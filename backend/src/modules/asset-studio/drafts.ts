/**
 * 草稿引擎（Issue #123，取代 Mastra 工作流）：草稿 → 人工编辑确认 → 一次生图 → 版本。
 *
 * 状态机：drafting（展开中）→ ready（可编辑/确认）→ generating（原子认领）→ consumed（已生图）；
 * drafting 失败 → failed（可 retry 重新展开）；consumed/ready 可 edit（consumed 复活为 ready）。
 * 观测隔离：展开一律 scope='asset_studio_draft'、taskId=draft.id（与 run.id 各自自增会撞号）。
 * 并发保护：generateFromDraft 用条件 UPDATE 原子认领；run INSERT 撞 idx_asset_studio_active_run → 409。
 */
import fs from 'fs'
import { stmt, getTask, getRun, parseParams, patchParams, finishRun, type RunRow } from './db.js'
import { getHost, getPlatform } from './registry.js'
import { now } from '../../utils/response.js'
import { logTaskWarn } from '../../utils/task-logger.js'
import { resolveStageModel } from '../../services/ai-stages.js'
import { callTextChat, imageContentPart } from '../../services/vision-chat.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { withStepDeadline } from './deadline.js'
import { findActiveRun, PipelineConflictError, PipelineStateError } from './run.js'
import { loadAssetTarget, runGenerateFrozen, runQc, runSpec, writeStep, type AssetTarget } from './steps.js'
import { draftReferenceImages, type ReferenceOrigin } from './references.js'
import { addAssetSource } from './sources.js'
import { researchRows, type AssetResearchResult } from './research/run.js'
import { getSpec, listRounds, listSources, type AssetKind, type AssetSourceRow } from './store.js'
import { settings } from './settings.js'
import {
  DraftInputError,
  validateDraftInputs,
  type AssetStudioAssetSnapshot,
  type BeautifyDraftInputs,
  type DraftInputs,
  type DraftResearchSelection,
  type DraftTab,
  type PrecisionDraftInputs,
  type ResearchRecordView,
} from './contract.js'
import { BEAUTIFY_SYSTEM, beautifyUser, buildNegativePrompt, expandPromptUser, PROMPT_EXPAND_SYSTEM } from './prompts.js'

const TEXT_TIMEOUT_MS = 300_000
const TEXT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768

export type DraftStatus = 'drafting' | 'ready' | 'failed' | 'generating' | 'consumed'

export interface DraftRow {
  id: number
  task_id: number
  asset_kind: AssetKind
  asset_id: number
  tab: DraftTab
  status: DraftStatus
  inputs: string
  spec_id: number | null
  prompt: string | null
  negative_prompt: string | null
  error_msg: string | null
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  created_at: string
  updated_at: string
}

export function getDraft(id: number): DraftRow | undefined {
  return stmt('SELECT * FROM asset_studio_draft WHERE id=?').get(id) as DraftRow | undefined
}

function requireDraft(id: number): DraftRow {
  const draft = getDraft(id)
  if (!draft) throw new PipelineStateError('草稿不存在')
  return draft
}

function patchDraft(id: number, patch: Record<string, unknown>): void {
  const entries = Object.entries({ ...patch, updated_at: now() })
  stmt(`UPDATE asset_studio_draft SET ${entries.map(([k]) => k + '=?').join(',')} WHERE id=?`).run(...entries.map(([, v]) => v), id)
}

function splitRef(ref: string): { kind: AssetKind; id: number } {
  const [kind, id] = ref.split(':')
  return { kind: kind as AssetKind, id: Number(id) }
}

/** 该资产的检索记录视图（validate 用）：全部行 DESC，completed 带 result */
function researchViews(kind: AssetKind, assetId: number): ResearchRecordView[] {
  return researchRows(kind, assetId).map(row => ({
    id: row.id,
    status: row.status,
    result: row.status === 'completed' && row.result ? JSON.parse(row.result) as AssetResearchResult : null,
  }))
}

/** 组装选中的检索子集为 ResearchResult 形状（spec/扩写输入） */
function selectedResearch(kind: AssetKind, assetId: number, selections: DraftResearchSelection[]): AssetResearchResult {
  const views = researchViews(kind, assetId)
  const texts: AssetResearchResult['texts'] = []
  const candidates: AssetResearchResult['candidates'] = []
  for (const selection of selections) {
    const view = views.find(item => item.id === Number(selection.research_id))
    const result = view?.result
    if (!result) continue
    for (const sha of selection.candidate_shas ?? []) {
      const candidate = (result.candidates ?? []).find(item => item.sha256 === sha)
      if (candidate) candidates.push(candidate)
    }
    for (const index of selection.text_indexes ?? []) {
      const text = (result.texts ?? [])[Number(index)]
      if (text) texts.push(text)
    }
  }
  return { asset_kind: kind, asset_id: assetId, queries: [], texts, candidates, dropped: 0 }
}

export interface CreateDraftBody {
  tab: DraftTab
  inputs: DraftInputs
  text_config_id?: number | null
}

/**
 * 创建草稿：校验输入 → 冻结 resolved inputs（含内容快照）→ INSERT drafting → fire-and-forget 展开。
 * 美化 version_task_id=null 在此解析为具体版本行 id（legacy 当前图冻结路径）。
 */
export async function createDraft(taskId: number, body: CreateDraftBody): Promise<DraftRow> {
  const task = getTask(taskId)
  if (!task) throw new PipelineStateError('工作室任务不存在')
  if (body.tab !== 'precision' && body.tab !== 'beautify') throw new DraftInputError('tab 必须是 precision / beautify')
  const { kind, id: assetId } = splitRef(task.host_ref)
  const asset = await getHost().readAsset(task.host_ref)
  if (!asset) throw new PipelineStateError('资产不存在')
  if (asset.isMap) throw new DraftInputError('地图资产请走地图工作室')

  const sources = await listSources(kind, assetId)
  const versions = await getHost().listVersions(task.host_ref)
  const resolved = validateDraftInputs(body.tab, body.inputs, {
    kind, assetId, sources, researchRecords: researchViews(kind, assetId), versions, currentImageUrl: asset.imageUrl,
  })

  // 冻结 inputs：精确=source_ids+research 选择+notes+候选/文本快照；美化=解析后的版本+notes
  const frozen: Record<string, unknown> = body.tab === 'precision'
    ? {
        source_ids: (body.inputs as PrecisionDraftInputs).source_ids ?? [],
        research: (body.inputs as PrecisionDraftInputs).research ?? [],
        notes: String((body.inputs as PrecisionDraftInputs).notes ?? ''),
        resolved_candidates: resolved.candidates,
        resolved_texts: resolved.texts,
        source_shas: resolved.sources.map(item => ({ id: item.id, sha256: item.sha256 ?? null, local_path: item.local_path })),
      }
    : { version_task_id: resolved.beautify!.version_task_id, version_path: resolved.beautify!.path, notes: String((body.inputs as BeautifyDraftInputs).notes ?? '') }

  const defaults = settings()
  const textConfigId = body.text_config_id ?? (Number(defaults.text_config_id) || null)
  const ts = now()
  const id = Number(stmt('INSERT INTO asset_studio_draft (task_id,asset_kind,asset_id,tab,status,inputs,text_config_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(taskId, kind, assetId, body.tab, 'drafting', JSON.stringify(frozen), textConfigId, ts, ts).lastInsertRowid)
  void expandDraft(id).catch(err => {
    logTaskWarn('AssetStudioDraft', 'expand-unhandled', { draftId: id, error: err instanceof Error ? err.message : String(err) })
  })
  return getDraft(id)!
}

/** 展开草稿（drafting → ready / failed）。墙钟时限 + AbortSignal 传到底层 fetch（评审 P1-4）。 */
async function expandDraft(draftId: number): Promise<void> {
  const draft = requireDraft(draftId)
  const task = getTask(draft.task_id)
  if (!task) { patchDraft(draftId, { status: 'failed', error_msg: '工作室任务不存在' }); return }
  const ref = task.host_ref
  const asset = await getHost().readAsset(ref)
  const target = await loadAssetTarget(draft.asset_kind, draft.asset_id)
  if (!asset || !target) { patchDraft(draftId, { status: 'failed', error_msg: '资产不存在' }); return }
  const inputs = JSON.parse(draft.inputs) as Record<string, unknown>
  try {
    if (draft.tab === 'precision') {
      const selections = (inputs.research ?? []) as DraftResearchSelection[]
      const research = selectedResearch(draft.asset_kind, draft.asset_id, selections)
      const sourceIds = (inputs.source_ids ?? []) as number[]
      const allSources = await listSources(draft.asset_kind, draft.asset_id)
      const selectedSources = sourceIds.map(id => allSources.find(item => item.id === Number(id))).filter((item): item is AssetSourceRow => Boolean(item))
      const spec = await withStepDeadline('spec', signal => runSpec({
        pipelineTaskId: draftId, target, research, textConfigId: draft.text_config_id ?? undefined,
        sources: selectedSources, scope: 'asset_studio_draft', skipRunParams: true, signal,
      }))
      const stageModel = await resolveStageModel('asset_studio_prompt', { configId: draft.text_config_id ?? undefined })
      const reply = await withStepDeadline('spec', signal => callTextChat(stageModel, expandPromptUser({
        assetKind: draft.asset_kind, name: asset.name, subtype: asset.subtype, description: asset.description,
        appearance: asset.appearance, styling: asset.styling, scenePrompt: asset.prompt, lighting: asset.lighting,
        finalPrompt: asset.finalPrompt, spec, sources: selectedSources, research, notes: String(inputs.notes ?? ''),
      }), { systemPrompt: PROMPT_EXPAND_SYSTEM, temperature: 0.3, maxTokens: TEXT_MAX_TOKENS, timeoutMs: TEXT_TIMEOUT_MS, signal }))
      const prompt = reply.text.trim()
      if (!prompt) throw new Error('提示词扩写返回空内容')
      const image = await getPlatform().imageSelection({ configId: Number(settings().image_config_id) || undefined, model: settings().image_model || undefined })
      patchDraft(draftId, { status: 'ready', spec_id: spec.id, prompt, negative_prompt: buildNegativePrompt(spec), image_config_id: image.configId, image_model: image.model, error_msg: null })
    } else {
      const versionPath = String(inputs.version_path ?? '')
      if (!versionPath || !fs.existsSync(getAbsolutePath(versionPath))) throw new DraftInputError('美化需要已有资产图；请先在精确流程生成或上传资产图')
      const stageModel = await resolveStageModel('asset_beautify')
      const prepared = await imageContentPart(versionPath, { maxSide: 1600, quality: 85 })
      const stylePrompt = await getPlatform().stylePrompt(target.dramaId)
      const reply = await withStepDeadline('spec', signal => callTextChat(stageModel, [
        { type: 'text', text: beautifyUser({ assetKind: draft.asset_kind, name: asset.name, subtype: asset.subtype, description: asset.description, notes: String(inputs.notes ?? ''), stylePrompt, framing: `这是一张 ${prepared.width}×${prepared.height} 像素的资产图。` }) },
        prepared.part,
      ], { systemPrompt: BEAUTIFY_SYSTEM, temperature: 0.3, maxTokens: TEXT_MAX_TOKENS, timeoutMs: TEXT_TIMEOUT_MS, signal }))
      const prompt = reply.text.trim()
      if (!prompt) throw new Error('美化描述返回空内容')
      const image = await getPlatform().imageSelection({ configId: Number(settings().image_config_id) || undefined, model: settings().image_model || undefined })
      patchDraft(draftId, { status: 'ready', spec_id: null, prompt, negative_prompt: null, image_config_id: image.configId, image_model: image.model, error_msg: null })
    }
  } catch (err) {
    patchDraft(draftId, { status: 'failed', error_msg: err instanceof Error ? err.message : String(err) })
  }
}

/** 重新展开失败的草稿（inputs 不变；评审 P1-6：failed 无 prompt 可编辑，只能重展开） */
export async function retryDraft(id: number): Promise<DraftRow> {
  const draft = requireDraft(id)
  if (draft.status !== 'failed') throw new PipelineStateError('只有展开失败的草稿可以重新展开')
  patchDraft(id, { status: 'drafting', error_msg: null })
  void expandDraft(id).catch(err => {
    logTaskWarn('AssetStudioDraft', 'retry-unhandled', { draftId: id, error: err instanceof Error ? err.message : String(err) })
  })
  return getDraft(id)!
}

/** 编辑 prompt（仅 ready/consumed；consumed 复活为 ready，支持「改 prompt 再来一次」） */
export function editDraft(id: number, patch: { prompt: string; negative_prompt?: string | null }): DraftRow {
  const draft = requireDraft(id)
  if (draft.status !== 'ready' && draft.status !== 'consumed') throw new PipelineStateError('只有待确认或已生成的草稿可以编辑提示词')
  const prompt = String(patch.prompt ?? '').trim()
  if (!prompt) throw new DraftInputError('提示词不能为空')
  patchDraft(id, { status: 'ready', prompt, negative_prompt: patch.negative_prompt ?? draft.negative_prompt, error_msg: null })
  return getDraft(id)!
}

/** 生成前校验冻结输入仍然成立（文件存在；素材 sha 未变）。漂移 → 400 要求重新展开（评审 P1-5）。 */
function assertInputsIntact(draft: DraftRow, sources: AssetSourceRow[]): void {
  const inputs = JSON.parse(draft.inputs) as Record<string, unknown>
  if (draft.tab === 'beautify') {
    const path = String(inputs.version_path ?? '')
    if (!path || !fs.existsSync(getAbsolutePath(path))) throw new DraftInputError('选中的版本图已不存在，请重新选择版本生成草稿')
    return
  }
  for (const snapshot of (inputs.source_shas ?? []) as Array<{ id: number; sha256: string | null; local_path: string }>) {
    const row = sources.find(item => item.id === snapshot.id)
    if (!row) throw new DraftInputError(`参考素材 #${snapshot.id} 已被删除，请重新生成草稿`)
    if (snapshot.sha256 && row.sha256 !== snapshot.sha256) throw new DraftInputError(`参考素材 #${snapshot.id} 内容已变化，请重新生成草稿`)
    if (!fs.existsSync(getAbsolutePath(row.local_path))) throw new DraftInputError(`参考素材 #${snapshot.id} 文件缺失，请重新生成草稿`)
  }
  for (const candidate of (inputs.resolved_candidates ?? []) as Array<{ local_path: string }>) {
    if (!fs.existsSync(getAbsolutePath(candidate.local_path))) throw new DraftInputError('选中的检索候选文件缺失，请重新生成草稿')
  }
}

export interface GenerateDraftOptions {
  config_id?: number | null
  model?: string | null
  /** 确认框显示的草稿修订时间；不匹配 → 409（防「确认新稿、生成旧稿」） */
  expected_updated_at?: string | null
}

/**
 * 从草稿生图：原子认领（ready → generating）→ 冻结 run.params → INSERT run + round 0 →
 * runGenerateFrozen → 精确追加顾问性 QC（失败不污染出图成功）→ finishRun(completed) → consumed。
 */
export async function generateFromDraft(id: number, opts: GenerateDraftOptions = {}): Promise<{ runId: number; draft: DraftRow }> {
  const draft = requireDraft(id)
  if (draft.status !== 'ready') throw new PipelineStateError('草稿不在待确认状态，不能生图')
  if (opts.expected_updated_at && opts.expected_updated_at !== draft.updated_at) {
    throw new PipelineConflictError('草稿已被修改，请刷新确认摘要后再生图')
  }
  const task = getTask(draft.task_id)
  if (!task) throw new PipelineStateError('工作室任务不存在')
  const ref = task.host_ref
  const asset = await getHost().readAsset(ref)
  if (!asset) throw new PipelineStateError('资产不存在')
  if (asset.isMap) throw new DraftInputError('地图资产请走地图工作室')

  const active = await findActiveRun(draft.asset_kind, draft.asset_id)
  if (active) throw new PipelineConflictError(`该资产已有进行中的生成（运行 #${active}），请先完成或取消它`)

  const sources = await listSources(draft.asset_kind, draft.asset_id)
  assertInputsIntact(draft, sources)
  const inputs = JSON.parse(draft.inputs) as Record<string, unknown>

  // 检索候选被选为生图参考 → 先入库（origin='research'）拿 source id，origins 全部 source（审计链路不变）
  const candidatePaths: string[] = []
  const candidateSourceIds: number[] = []
  if (draft.tab === 'precision') {
    const views = researchViews(draft.asset_kind, draft.asset_id)
    for (const candidate of (inputs.resolved_candidates ?? []) as Array<{ research_id: number; sha256: string; local_path: string }>) {
      const view = views.find(item => item.id === candidate.research_id)
      const meta = view?.result?.candidates?.find(item => item.sha256 === candidate.sha256)
      const row = await addAssetSource({
        assetKind: draft.asset_kind, assetId: draft.asset_id, localPath: candidate.local_path,
        sourceUrl: meta?.url ?? null, title: meta?.title ?? '检索候选', license: meta?.license?.trim() || '检索候选（许可未注明）',
        role: 'generation_reference', origin: 'research',
      })
      candidatePaths.push(candidate.local_path)
      candidateSourceIds.push(row.id)
    }
  }

  const beautifyPath = draft.tab === 'beautify' ? String(inputs.version_path ?? '') : null
  const referenceImages = draftReferenceImages(
    draft.tab === 'precision'
      ? { source_ids: (inputs.source_ids ?? []) as number[], research: (inputs.research ?? []) as DraftResearchSelection[], notes: String(inputs.notes ?? '') }
      : { version_task_id: (inputs.version_task_id ?? null) as number | null, notes: String(inputs.notes ?? '') },
    sources, candidatePaths, beautifyPath,
  )
  const sourceIdsOrdered = draft.tab === 'precision'
    ? [...((inputs.source_ids ?? []) as number[]).map(Number), ...candidateSourceIds]
    : []
  const referenceOrigins: ReferenceOrigin[] = draft.tab === 'precision'
    ? referenceImages.map((_, index) => ({ type: 'source', source_id: sourceIdsOrdered[index]! }))
    : referenceImages.map(() => ({ type: 'unknown' }))

  // 显式覆盖配置时重新校验并更新冻结值；否则用草稿冻结的配置（确认摘要=实际提交）
  let imageConfigId = draft.image_config_id
  let imageModel = draft.image_model
  if (opts.config_id || opts.model) {
    const image = await getPlatform().imageSelection({ configId: opts.config_id ?? draft.image_config_id, model: opts.model ?? draft.image_model })
    imageConfigId = image.configId
    imageModel = image.model
    patchDraft(id, { image_config_id: imageConfigId, image_model: imageModel })
  }

  // 原子认领：双击/重发只有一个能成功（评审 P1-3）
  const claimed = stmt("UPDATE asset_studio_draft SET status='generating',updated_at=? WHERE id=? AND status='ready'").run(now(), id)
  if (!claimed.changes) throw new PipelineConflictError('草稿正在生图或状态已变化，请勿重复提交')

  const target = await loadAssetTarget(draft.asset_kind, draft.asset_id)
  if (!target) { patchDraft(id, { status: 'ready' }); throw new PipelineStateError('资产不存在') }
  const prompt = draft.prompt!
  const negativePrompt = draft.negative_prompt
  const ts = now()
  let runId: number
  try {
    runId = Number(stmt("INSERT INTO asset_studio_run (task_id,status,purpose,params,created_at,updated_at) VALUES (?,'running',?,'{}',?,?)")
      .run(draft.task_id, draft.tab, ts, ts).lastInsertRowid)
  } catch (err) {
    patchDraft(id, { status: 'ready' })
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new PipelineConflictError('该资产已有进行中的生成，请先完成或取消它')
    }
    throw err
  }
  await patchParams(runId, {
    draft_id: id, snapshot: asset, fingerprint: asset.fingerprint, episode_id: asset.episodeId ?? 0,
    asset_kind: draft.asset_kind, asset_id: draft.asset_id, purpose: draft.tab,
    inputs, prompt, negative_prompt: negativePrompt,
    reference_source_ids: sourceIdsOrdered, image_config_id: imageConfigId, image_model: imageModel,
    text_config_id: draft.text_config_id, asset_spec_id: draft.spec_id,
    progress: { completed: 0, total: 1, failed: 0, step: 'generate' },
  })

  void executeGeneration(runId, id, {
    target, episodeId: asset.episodeId ?? 0, tab: draft.tab, prompt, negativePrompt,
    referenceImages, referenceOrigins, specId: draft.spec_id, configId: imageConfigId, model: imageModel,
    textConfigId: draft.text_config_id,
  }).catch(err => {
    logTaskWarn('AssetStudioDraft', 'generate-unhandled', { runId, draftId: id, error: err instanceof Error ? err.message : String(err) })
  })
  return { runId, draft: getDraft(id)! }
}

async function executeGeneration(runId: number, draftId: number, input: {
  target: AssetTarget
  episodeId: number
  tab: DraftTab
  prompt: string
  negativePrompt: string | null
  referenceImages: string[]
  referenceOrigins: ReferenceOrigin[]
  specId: number | null
  configId: number | null
  model: string | null
  textConfigId: number | null
}): Promise<void> {
  try {
    await writeStep(runId, 'generate')
    const round = await withStepDeadline('generate', signal => runGenerateFrozen({
      pipelineTaskId: runId, episodeId: input.episodeId, target: input.target, roundNo: 0, purpose: input.tab,
      prompt: input.prompt, negativePrompt: input.negativePrompt, referenceImages: input.referenceImages,
      referenceOrigins: input.referenceOrigins, specId: input.specId, configId: input.configId, model: input.model, signal,
    }))
    // 顾问性 QC（评审 P1-6）：出图已成功，QC 失败只记 qc_error，run 仍 completed，绝不诱导重新买图
    if (input.tab === 'precision' && input.specId) {
      const spec = await getSpec(input.specId)
      if (spec) {
        try {
          await withStepDeadline('qc', signal => runQc({ target: input.target, spec, round, textConfigId: input.textConfigId ?? undefined, signal }))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logTaskWarn('AssetStudioDraft', 'qc-advisory-failed', { runId, roundId: round.id, error: message })
          await patchParams(runId, { qc_error: message })
        }
      }
    }
    await finishRun(runId, 'completed')
    patchDraft(draftId, { status: 'consumed' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const run = getRun(runId)
    // 取消/中断的 run 不被复活（finishRun 本身也有守卫）；草稿回 ready 可编辑重试
    if (run && run.status === 'running') await finishRun(runId, 'failed', { errorMsg: message })
    patchDraft(draftId, { status: 'consumed', error_msg: message })
  }
}

/** 任务的全部草稿（DESC） */
export function listDrafts(taskId: number): DraftRow[] {
  return stmt('SELECT * FROM asset_studio_draft WHERE task_id=? ORDER BY id DESC').all(taskId) as DraftRow[]
}

/** 草稿详情视图：draft + 解析 inputs + spec（前端 DraftPanel 用） */
export async function draftView(draft: DraftRow) {
  const spec = draft.spec_id ? await getSpec(draft.spec_id) : null
  return { ...draft, inputs: JSON.parse(draft.inputs) as Record<string, unknown>, spec }
}