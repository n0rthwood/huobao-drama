/**
 * 资产流水线的落库口（Issue #56）—— 四张表的唯一读写处
 *
 * 面板与下游（`listBaseCandidates`、版本列表、R4/R5）只认这里导出的 DTO：
 * JSON 列在这一层解析成对象，调用方不再各自 `JSON.parse` 一遍（#47 的 semantics 就是
 * 因为到处散着解析才出现口径分叉）。
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import type { GateResult, SpecForbidden, SpecMustHave } from './gate.js'

export type AssetKind = 'character' | 'scene' | 'prop'
export const ASSET_KINDS: AssetKind[] = ['character', 'scene', 'prop']

export type RoundPurpose = 'precision' | 'beautify'
export type RoundStatus = 'pending' | 'generating' | 'generated' | 'failed' | 'discarded'
export type SourceRole = 'generation_reference' | 'shape_only' | 'rejected'
export const SOURCE_ROLES: SourceRole[] = ['generation_reference', 'shape_only', 'rejected']

export interface SpecSourceSnapshot {
  source_id: number | null
  kind: 'wikipedia' | 'commons' | 'web' | 'local'
  url: string | null
  license: string
  artist: string | null
  sha256: string
  local_path: string
  role: SourceRole
  why_excluded?: string
  era?: string
}

export interface AssetSpecRow {
  id: number
  asset_kind: AssetKind
  asset_id: number
  version: number
  summary: string
  must_have: SpecMustHave[]
  forbidden: SpecForbidden[]
  tolerances: string[]
  uncertainties: string[]
  palette: string | null
  composition: string | null
  locate_targets: Array<{ id: string; name: string }>
  locate_anchors: Array<{ id: string; name: string }>
  sources: SpecSourceSnapshot[]
  created_by_stage: string
  created_at: string
}

export interface AssetSourceRow {
  id: number
  asset_kind: AssetKind
  asset_id: number
  url: string | null
  title: string | null
  artist: string | null
  license: string
  sha256: string
  local_path: string
  role: SourceRole
  why_excluded: string | null
  era: string | null
  fetched_at: string | null
  created_at: string
}

export interface AssetRoundRow {
  id: number
  pipeline_task_id: number
  asset_kind: AssetKind
  asset_id: number
  spec_id: number | null
  round_no: number
  purpose: RoundPurpose
  generator: string | null
  config_id: number | null
  prompt: string
  negative_prompt: string | null
  /** Selected asset_source cache IDs only; never task IDs or previous-round IDs. */
  reference_ids: number[]
  image_task_id: number | null
  image_path: string | null
  image_sha256: string | null
  width: number | null
  height: number | null
  status: RoundStatus
  error_msg: string | null
  created_at: string
  updated_at: string
}

export interface QcVerdicts {
  must_have: Array<{ id: string; verdict: string; evidence?: string; tolerance?: string }>
  forbidden: Array<{ id: string; detected: boolean; evidence?: string }>
  text_in_image: { present: boolean | null; evidence: string }
  locate?: Array<{ id: string; name?: string; at?: [number, number] | null }>
  overall?: string
  gate_result?: GateResult
}

export interface AssetQcRecordRow {
  id: number
  round_id: number
  asset_kind: AssetKind
  asset_id: number
  model_config_id: number | null
  checklist_coverage: number
  verdicts: QcVerdicts | null
  locate_checks: GateResult['locate_checks']
  gate_pass: 0 | 1
  gate_invalid: string[]
  fidelity_score: number | null
  beauty_score: number | null
  suggestions: string[]
  human_verdict: string | null
  human_notes: string | null
  human_opened: Array<{ path: string; sha256: string }> | null
  created_at: string
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

function toSpecRow(row: typeof schema.assetSpec.$inferSelect): AssetSpecRow {
  return {
    id: row.id,
    asset_kind: row.assetKind as AssetKind,
    asset_id: row.assetId,
    version: row.version,
    summary: row.summary ?? '',
    must_have: parseJson<SpecMustHave[]>(row.mustHave, []),
    forbidden: parseJson<SpecForbidden[]>(row.forbidden, []),
    tolerances: parseJson<string[]>(row.tolerances, []),
    uncertainties: parseJson<string[]>(row.uncertainties, []),
    palette: row.palette ?? null,
    composition: row.composition ?? null,
    locate_targets: parseJson<Array<{ id: string; name: string }>>(row.locateTargets, []),
    locate_anchors: parseJson<Array<{ id: string; name: string }>>(row.locateAnchors, []),
    sources: parseJson<SpecSourceSnapshot[]>(row.sources, []),
    created_by_stage: row.createdByStage ?? '',
    created_at: row.createdAt,
  }
}

function toRoundRow(row: typeof schema.assetRound.$inferSelect): AssetRoundRow {
  return {
    id: row.id,
    pipeline_task_id: row.pipelineTaskId,
    asset_kind: row.assetKind as AssetKind,
    asset_id: row.assetId,
    spec_id: row.specId ?? null,
    round_no: row.roundNo,
    purpose: row.purpose as RoundPurpose,
    generator: row.generator ?? null,
    config_id: row.configId ?? null,
    prompt: row.prompt ?? '',
    negative_prompt: row.negativePrompt ?? null,
    reference_ids: parseJson<number[]>(row.referenceIds, []),
    image_task_id: row.imageTaskId ?? null,
    image_path: row.imagePath ?? null,
    image_sha256: row.imageSha256 ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    status: row.status as RoundStatus,
    error_msg: row.errorMsg ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toQcRow(row: typeof schema.assetQcRecord.$inferSelect): AssetQcRecordRow {
  return {
    id: row.id,
    round_id: row.roundId,
    asset_kind: row.assetKind as AssetKind,
    asset_id: row.assetId,
    model_config_id: row.modelConfigId ?? null,
    checklist_coverage: row.checklistCoverage ?? 0,
    verdicts: parseJson<QcVerdicts | null>(row.verdicts, null),
    locate_checks: parseJson<GateResult['locate_checks']>(row.locateChecks, []),
    gate_pass: row.gatePass ? 1 : 0,
    gate_invalid: parseJson<string[]>(row.gateInvalid, []),
    fidelity_score: row.fidelityScore ?? null,
    beauty_score: row.beautyScore ?? null,
    suggestions: parseJson<string[]>(row.suggestions, []),
    human_verdict: row.humanVerdict ?? null,
    human_notes: row.humanNotes ?? null,
    human_opened: parseJson<Array<{ path: string; sha256: string }> | null>(row.humanOpened, null),
    created_at: row.createdAt,
  }
}

export { toQcRow, toRoundRow, toSpecRow }

// ─── asset_spec ──────────────────────────────────────────────

export async function latestSpec(kind: AssetKind, assetId: number): Promise<AssetSpecRow | null> {
  const rows = await db.select().from(schema.assetSpec)
    .where(and(eq(schema.assetSpec.assetKind, kind), eq(schema.assetSpec.assetId, assetId)))
    .orderBy(desc(schema.assetSpec.version))
  return rows[0] ? toSpecRow(rows[0]) : null
}

export async function getSpec(id: number): Promise<AssetSpecRow | null> {
  const [row] = await db.select().from(schema.assetSpec).where(eq(schema.assetSpec.id, id))
  return row ? toSpecRow(row) : null
}

export async function insertSpec(input: {
  assetKind: AssetKind
  assetId: number
  summary: string
  mustHave: SpecMustHave[]
  forbidden: SpecForbidden[]
  tolerances: string[]
  uncertainties: string[]
  palette?: string | null
  composition?: string | null
  locateTargets?: Array<{ id: string; name: string }>
  locateAnchors?: Array<{ id: string; name: string }>
  sources: SpecSourceSnapshot[]
  createdByStage: string
}): Promise<AssetSpecRow> {
  const previous = await latestSpec(input.assetKind, input.assetId)
  const version = (previous?.version ?? 0) + 1
  const res = await db.insert(schema.assetSpec).values({
    assetKind: input.assetKind,
    assetId: input.assetId,
    version,
    summary: input.summary,
    mustHave: JSON.stringify(input.mustHave),
    forbidden: JSON.stringify(input.forbidden),
    tolerances: JSON.stringify(input.tolerances),
    uncertainties: JSON.stringify(input.uncertainties),
    palette: input.palette ?? null,
    composition: input.composition ?? null,
    locateTargets: JSON.stringify(input.locateTargets ?? []),
    locateAnchors: JSON.stringify(input.locateAnchors ?? []),
    sources: JSON.stringify(input.sources),
    createdByStage: input.createdByStage,
    createdAt: now(),
  })
  const created = await getSpec(getInsertId(res))
  if (!created) throw new Error('事实表写入后读不回来')
  return created
}

// ─── asset_round ─────────────────────────────────────────────

export async function listRounds(pipelineTaskId: number): Promise<AssetRoundRow[]> {
  const rows = await db.select().from(schema.assetRound)
    .where(eq(schema.assetRound.pipelineTaskId, pipelineTaskId))
    .orderBy(asc(schema.assetRound.roundNo))
  return rows.map(toRoundRow)
}

export async function listAssetRounds(kind: AssetKind, assetId: number): Promise<AssetRoundRow[]> {
  const rows = await db.select().from(schema.assetRound)
    .where(and(eq(schema.assetRound.assetKind, kind), eq(schema.assetRound.assetId, assetId)))
    .orderBy(asc(schema.assetRound.id))
  return rows.map(toRoundRow)
}

export async function getRound(id: number): Promise<AssetRoundRow | null> {
  const [row] = await db.select().from(schema.assetRound).where(eq(schema.assetRound.id, id))
  return row ? toRoundRow(row) : null
}

export async function findRound(pipelineTaskId: number, roundNo: number): Promise<AssetRoundRow | null> {
  const [row] = await db.select().from(schema.assetRound).where(and(
    eq(schema.assetRound.pipelineTaskId, pipelineTaskId),
    eq(schema.assetRound.roundNo, roundNo),
  ))
  return row ? toRoundRow(row) : null
}

/**
 * 昂贵步的幂等落点：`(pipeline_task_id, round_no)` 唯一，已存在就原样返回。
 * 重启续跑走到同一步时绝不会重复下单生图——只会继续轮询已有的 `image_task_id`。
 */
export async function ensureRound(input: {
  pipelineTaskId: number
  assetKind: AssetKind
  assetId: number
  specId: number | null
  roundNo: number
  purpose: RoundPurpose
  generator: string
  configId: number | null
  prompt: string
  negativePrompt: string | null
  referenceIds: number[]
}): Promise<{ round: AssetRoundRow; created: boolean }> {
  const existing = await findRound(input.pipelineTaskId, input.roundNo)
  if (existing) return { round: existing, created: false }
  const ts = now()
  const res = await db.insert(schema.assetRound).values({
    pipelineTaskId: input.pipelineTaskId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    specId: input.specId,
    roundNo: input.roundNo,
    purpose: input.purpose,
    generator: input.generator,
    configId: input.configId,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    referenceIds: JSON.stringify(input.referenceIds),
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  })
  const round = await getRound(getInsertId(res))
  if (!round) throw new Error('轮次写入后读不回来')
  return { round, created: true }
}

export async function patchRound(id: number, patch: Partial<{
  imageTaskId: number | null
  imagePath: string | null
  imageSha256: string | null
  width: number | null
  height: number | null
  status: RoundStatus
  errorMsg: string | null
  generator: string
  configId: number | null
}>): Promise<void> {
  await db.update(schema.assetRound)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.assetRound.id, id))
}

// ─── asset_qc_record ─────────────────────────────────────────

export async function insertQcRecord(input: {
  roundId: number
  assetKind: AssetKind
  assetId: number
  modelConfigId: number | null
  verdicts: QcVerdicts
  gate: GateResult
  fidelityScore: number | null
  beautyScore: number | null
  suggestions: string[]
}): Promise<AssetQcRecordRow> {
  const res = await db.insert(schema.assetQcRecord).values({
    roundId: input.roundId,
    assetKind: input.assetKind,
    assetId: input.assetId,
    modelConfigId: input.modelConfigId,
    checklistCoverage: input.gate.coverage,
    verdicts: JSON.stringify({ ...input.verdicts, gate_result: input.gate }),
    locateChecks: JSON.stringify(input.gate.locate_checks),
    gatePass: input.gate.pass ? 1 : 0,
    gateInvalid: JSON.stringify(input.gate.invalid),
    fidelityScore: input.fidelityScore,
    beautyScore: input.beautyScore,
    suggestions: JSON.stringify(input.suggestions),
    createdAt: now(),
  })
  const [row] = await db.select().from(schema.assetQcRecord).where(eq(schema.assetQcRecord.id, getInsertId(res)))
  if (!row) throw new Error('QC 记录写入后读不回来')
  return toQcRow(row)
}

/** 每轮的最新一条 QC（闸门与版本列表都以它为准） */
export async function latestQcByRound(roundIds: number[]): Promise<Map<number, AssetQcRecordRow>> {
  const result = new Map<number, AssetQcRecordRow>()
  if (!roundIds.length) return result
  const rows = await db.select().from(schema.assetQcRecord)
    .where(inArray(schema.assetQcRecord.roundId, roundIds))
  for (const row of rows) {
    const prev = result.get(row.roundId)
    if (!prev || row.id > prev.id) result.set(row.roundId, toQcRow(row))
  }
  return result
}

export async function recordHumanVerdict(qcId: number, input: {
  verdict: string
  notes: string | null
  opened: Array<{ path: string; sha256: string }>
}): Promise<void> {
  await db.update(schema.assetQcRecord).set({
    humanVerdict: input.verdict,
    humanNotes: input.notes,
    humanOpened: JSON.stringify(input.opened),
  }).where(eq(schema.assetQcRecord.id, qcId))
}

// ─── asset_source ────────────────────────────────────────────

function toSourceRow(row: typeof schema.assetSource.$inferSelect): AssetSourceRow {
  return {
    id: row.id,
    asset_kind: row.assetKind as AssetKind,
    asset_id: row.assetId,
    url: row.url ?? null,
    title: row.title ?? null,
    artist: row.artist ?? null,
    license: row.license,
    sha256: row.sha256,
    local_path: row.localPath,
    role: row.role as SourceRole,
    why_excluded: row.whyExcluded ?? null,
    era: row.era ?? null,
    fetched_at: row.fetchedAt ?? null,
    created_at: row.createdAt,
  }
}

export { toSourceRow }

export async function listSources(kind: AssetKind, assetId: number): Promise<AssetSourceRow[]> {
  const rows = await db.select().from(schema.assetSource)
    .where(and(eq(schema.assetSource.assetKind, kind), eq(schema.assetSource.assetId, assetId)))
    .orderBy(asc(schema.assetSource.id))
  return rows.map(toSourceRow)
}
