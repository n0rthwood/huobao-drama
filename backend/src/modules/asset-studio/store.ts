import {stmt, getRun} from './db.js'
import {now} from '../../utils/response.js'
import type {GateResult,SpecForbidden,SpecMustHave} from './gate.js'
export type AssetKind = 'character' | 'scene' | 'prop'
export const ASSET_KINDS: AssetKind[] = ['character', 'scene', 'prop']

export type RoundPurpose = 'precision' | 'beautify'
export type RoundStatus = 'pending' | 'generating' | 'generated' | 'failed' | 'discarded'
// original（Issue #121）：图上就是目标资产的历史原件，入库即自动采用为资产当前图（受保护）
export type SourceRole = 'original' | 'generation_reference' | 'shape_only' | 'rejected'
// 素材来源（Issue #123）：user_reference=资产参考图同步 / research=检索候选入库 / upload=面板上传 / manual=手动入库
export type SourceOrigin = 'user_reference' | 'research' | 'upload' | 'manual'
export const SOURCE_ROLES: SourceRole[] = ['original', 'generation_reference', 'shape_only', 'rejected']

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
  origin: SourceOrigin
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
  /** `overlay` = 是否为生成器额外加上去的标注/说明/水印（Issue #73）；老记录里没有这一项 */
  text_in_image: { present: boolean | null; overlay?: boolean | null; evidence: string }
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

function toSpecRow(row: Record<string, any>): AssetSpecRow {
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

function toRoundRow(row: Record<string, any>): AssetRoundRow {
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

function toQcRow(row: Record<string, any>): AssetQcRecordRow {
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

function toSourceRow(row: Record<string, any>): AssetSourceRow {
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
    origin: (row.origin ?? 'manual') as SourceOrigin,
    why_excluded: row.whyExcluded ?? null,
    era: row.era ?? null,
    fetched_at: row.fetchedAt ?? null,
    created_at: row.createdAt,
  }
}

export { toSourceRow }


function camel(row:unknown):Record<string,any> {return Object.fromEntries(Object.entries(row as object).map(([k,v])=>[k==='run_id'?'pipelineTaskId':k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),v]))}
function rows(table:string,where:string,args:unknown[]=[],order='id') {return stmt(`SELECT * FROM asset_studio_${table} WHERE ${where} ORDER BY ${order}`).all(...args).map(camel)}
function insert(table:string,data:Record<string,unknown>) {const entries=Object.entries(data);return Number(stmt(`INSERT INTO asset_studio_${table} (${entries.map(([k])=>k).join(',')}) VALUES (${entries.map(()=>'?').join(',')})`).run(...entries.map(([,v])=>v)).lastInsertRowid)}
export async function latestSpec(kind: AssetKind, assetId: number): Promise<AssetSpecRow | null> {
return rows('spec','asset_kind=? AND asset_id=?',[kind,assetId],'version DESC').map(toSpecRow)[0]??null
}

export async function getSpec(id: number): Promise<AssetSpecRow | null> {
return rows('spec','id=?',[id]).map(toSpecRow)[0]??null
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
const previous=await latestSpec(input.assetKind,input.assetId);const id=insert('spec',{asset_kind:input.assetKind,asset_id:input.assetId,version:(previous?.version??0)+1,summary:input.summary,must_have:JSON.stringify(input.mustHave),forbidden:JSON.stringify(input.forbidden),tolerances:JSON.stringify(input.tolerances),uncertainties:JSON.stringify(input.uncertainties),palette:input.palette??null,composition:input.composition??null,locate_targets:JSON.stringify(input.locateTargets??[]),locate_anchors:JSON.stringify(input.locateAnchors??[]),sources:JSON.stringify(input.sources),created_by_stage:input.createdByStage,created_at:now()});return (await getSpec(id))!
}

export async function listRounds(pipelineTaskId: number): Promise<AssetRoundRow[]> {
return rows('round','run_id=?',[pipelineTaskId],'round_no').map(toRoundRow)
}

export async function listAssetRounds(kind: AssetKind, assetId: number): Promise<AssetRoundRow[]> {
return rows('round','asset_kind=? AND asset_id=?',[kind,assetId]).map(toRoundRow)
}

export async function getRound(id: number): Promise<AssetRoundRow | null> {
return rows('round','id=?',[id]).map(toRoundRow)[0]??null
}

export async function findRound(pipelineTaskId: number, roundNo: number): Promise<AssetRoundRow | null> {
return rows('round','run_id=? AND round_no=?',[pipelineTaskId,roundNo]).map(toRoundRow)[0]??null
}

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
const existing=await findRound(input.pipelineTaskId,input.roundNo);if(existing)return {round:existing,created:false};
 const run=getRun(input.pipelineTaskId); let prior=run?.prev_run_id; let inherited:AssetRoundRow|null=null;
 while(prior){const candidate=await findRound(prior,input.roundNo);if(candidate?.prompt===input.prompt && candidate.status!=='discarded'){inherited=candidate;break} prior=getRun(prior)?.prev_run_id}
 const id=insert('round',{run_id:input.pipelineTaskId,asset_kind:input.assetKind,asset_id:input.assetId,spec_id:input.specId,round_no:input.roundNo,purpose:input.purpose,generator:input.generator,config_id:input.configId,prompt:input.prompt,negative_prompt:input.negativePrompt,reference_ids:JSON.stringify(input.referenceIds),image_task_id:inherited?.image_task_id??null,image_path:inherited?.image_path??null,image_sha256:inherited?.image_sha256??null,width:inherited?.width??null,height:inherited?.height??null,status:inherited?.status??'pending',created_at:inherited?.created_at??now(),updated_at:now()});return {round:(await getRound(id))!,created:true}
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
const entries=Object.entries({...patch,updatedAt:now()});stmt(`UPDATE asset_studio_round SET ${entries.map(([k])=>k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())+'=?').join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id)
}

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
const id=insert('qc_record',{round_id:input.roundId,asset_kind:input.assetKind,asset_id:input.assetId,model_config_id:input.modelConfigId,checklist_coverage:input.gate.coverage,verdicts:JSON.stringify({...input.verdicts,gate_result:input.gate}),locate_checks:JSON.stringify(input.gate.locate_checks),gate_pass:input.gate.pass?1:0,gate_invalid:JSON.stringify(input.gate.invalid),fidelity_score:input.fidelityScore,beauty_score:input.beautyScore,suggestions:JSON.stringify(input.suggestions),created_at:now()});return toQcRow(rows('qc_record','id=?',[id])[0]!)
}

export async function latestQcByRound(roundIds: number[]): Promise<Map<number, AssetQcRecordRow>> {
const result=new Map<number,AssetQcRecordRow>();if(!roundIds.length)return result;for(const row of rows('qc_record',`round_id IN (${roundIds.map(()=>'?').join(',')})`,roundIds)){const qc=toQcRow(row);result.set(qc.round_id,qc)}return result
}

export async function recordHumanVerdict(qcId: number, input: {
  verdict: string
  notes: string | null
  opened: Array<{ path: string; sha256: string }>
}): Promise<void> {
stmt('UPDATE asset_studio_qc_record SET human_verdict=?,human_notes=?,human_opened=? WHERE id=?').run(input.verdict,input.notes,JSON.stringify(input.opened),qcId)
}

export async function listSources(kind: AssetKind, assetId: number): Promise<AssetSourceRow[]> {
return rows('source','asset_kind=? AND asset_id=?',[kind,assetId]).map(toSourceRow)
}
