import { apiBase } from '~/utils/url'

export interface AssetStudioApiError extends Error {
  status?: number
  body?: Record<string, unknown>
}

function endpoint(path: string): string {
  return `${apiBase()}/asset-studio${path}`
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body instanceof FormData) { delete (init.headers as Record<string, string>)['Content-Type']; init.body = body }
  else if (body !== undefined) init.body = JSON.stringify(body)
  const resp = await fetch(endpoint(path), init)
  let json: Record<string, unknown> = {}
  try {
    json = await resp.json() as Record<string, unknown>
  } catch {
    json = {}
  }
  const code = Number(json.code)
  if (!resp.ok || (Number.isFinite(code) && code >= 400)) {
    const err: AssetStudioApiError = new Error(String(json.message || resp.status))
    err.status = resp.status
    err.body = json
    throw err
  }
  return (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json) as T
}

export type AssetPipelineKind = 'character' | 'scene' | 'prop'
// original（Issue #121）：历史原件，入库即自动采用为受保护资产图
export type AssetSourceRole = 'original' | 'generation_reference' | 'shape_only' | 'rejected'
export interface AssetSourceRow {
  id: number
  asset_kind: string
  asset_id: number
  url: string | null
  title: string | null
  artist: string | null
  license: string
  sha256: string
  local_path: string
  role: AssetSourceRole
  origin: 'user_reference' | 'research' | 'upload' | 'manual'
  why_excluded: string | null
  era: string | null
  fetched_at: string | null
  created_at: string
}
export interface AssetPipelineOpenedImage { path: string; sha256: string }
export interface SpecSourceSnapshot {
  source_id: number | null
  kind: 'wikipedia' | 'commons' | 'web' | 'local'
  url: string | null
  license: string
  artist: string | null
  sha256: string
  local_path: string
  role: string
  why_excluded?: string
  era?: string
}
export interface AssetSpecRow {
  id: number
  asset_kind: string
  asset_id: number
  version: number
  summary: string
  must_have: Array<{ id: string; element: string; why: string; check: string; metric: 'count' | 'arrangement' | 'color' | 'shape' | 'other' }>
  forbidden: Array<{ id: string; error: string; why: string }>
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
export interface LocateCheck { id: string; name: string; status: 'ok' | 'off' | 'not_comparable'; distance: number | null; detail: string }
export interface GateResult {
  pass: boolean
  coverage: number
  invalid: string[]
  violations: Array<{ id: string; element: string; verdict: string; evidence: string }>
  forbidden_hits: Array<{ id: string; error: string; evidence: string }>
  /** overlay=生成器额外叠加的标签/图例/字幕/水印（违规）；器物自身铭文 overlay=false；旧记录为 null */
  text_in_image: { present: boolean | null; overlay: boolean | null; evidence: string }
  locate_checks: LocateCheck[]
  semantics_preserved: { status: 'pass' | 'fail' | 'not_applicable' | 'unknown'; detail: string }
  model_overall?: string | null
}
export interface QcRecordRow {
  id: number
  round_id: number
  model_config_id: number | null
  checklist_coverage: number
  verdicts: {
    must_have: Array<{ id: string; verdict: 'ok' | 'minor' | 'violation'; evidence: string }>
    forbidden: Array<{ id: string; detected: boolean; evidence: string }>
    text_in_image: { present: boolean | null; overlay: boolean | null; evidence: string }
  }
  locate_checks: LocateCheck[]
  gate_pass: 0 | 1
  gate_invalid: string[]
  fidelity_score: number | null
  beauty_score: number | null
  suggestions: string[]
  human_verdict: string | null
  human_notes: string | null
  human_opened: AssetPipelineOpenedImage[] | null
  created_at: string
}
export interface AssetPipelineRound {
  id: number
  pipeline_task_id: number
  asset_kind: string
  asset_id: number
  spec_id: number
  round_no: number
  purpose: 'precision' | 'beautify'
  generator: string | null
  config_id: number | null
  prompt: string
  negative_prompt: string | null
  reference_ids: number[]
  reference_images: {path: string; type: 'source' | 'prev_round' | 'unknown'; source_id?: number; round_id?: number}[]
  image_task_id: number | null
  image_path: string | null
  image_sha256: string | null
  width: number | null
  height: number | null
  status: 'pending' | 'generating' | 'generated' | 'failed' | 'discarded'
  error_msg: string | null
  created_at: string
  updated_at: string
  qc: QcRecordRow | null
  gate: GateResult | null
  version_deleted: boolean
}
export interface AssetPipelineState {
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
  asset_kind: string
  asset_id: number
}
export interface AssetPipelineRunSummary {
  id: number
  status: 'running' | 'suspended' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
  purpose: 'precision' | 'beautify'
  params?: Record<string, unknown>
  prev_run_id?: number | null
  step: string | null
  asset_kind: string
  asset_id: number
  pipeline: AssetPipelineState
  created_at: string
  updated_at: string
}
export interface AssetPipelineRunDetail {
  run: AssetPipelineRunSummary & {
    episode_id: number
    error: string | null
    qc_error: string | null
    result: Record<string, unknown> | null
  }
  spec: AssetSpecRow | null
  rounds: AssetPipelineRound[]
  sources: AssetSourceRow[]
}
export type AssetResearchRole = 'original' | 'generation_reference' | 'shape_only' | 'text_source' | 'reject'
export interface AssetResearchCandidate {
  adapter: string
  title: string
  url: string | null
  image: string | null
  license: string
  institution: string
  date: string
  snippet: string
  tier: 'A' | 'B'
  local_path: string
  sha256: string
  role: AssetResearchRole
  depicts: string
  what_it_proves: string[]
  cautions: string[]
}
export interface AssetResearchResult {
  queries: Array<{ adapter: string; query: string; hits: number; error?: string }>
  texts: Array<{ adapter: string; title: string; url: string | null; excerpt: string }>
  candidates: AssetResearchCandidate[]
  dropped: number
}
/** 检索记录（Issue #123）：每次检索一行，全部可见，可单独/联合选用 */
export interface AssetResearchRecord {
  id: number
  status: 'running' | 'completed' | 'failed'
  step: string | null
  instruction: string | null
  keywords: string | null
  error: string | null
  created_at: string
  completed_at: string | null
  result: AssetResearchResult | null
  works?: Record<string, unknown>[]
  calls?: ObservedCall[]
  has_more?: boolean
  next_after_id?: number
}
/** 草稿（Issue #123）：drafting → ready → generating → consumed；failed 可 retry */
export type DraftStatus = 'drafting' | 'ready' | 'failed' | 'generating' | 'consumed'
export interface DraftResearchSelection { research_id: number; candidate_shas: string[]; text_indexes: number[] }
export interface PrecisionDraftInputs { source_ids: number[]; research: DraftResearchSelection[]; notes: string }
export interface BeautifyDraftInputs { version_task_id: number | null; notes: string }
export interface AssetStudioDraft {
  id: number
  task_id: number
  asset_kind: AssetPipelineKind
  asset_id: number
  tab: 'precision' | 'beautify'
  status: DraftStatus
  inputs: Record<string, unknown>
  spec_id: number | null
  prompt: string | null
  negative_prompt: string | null
  error_msg: string | null
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  created_at: string
  updated_at: string
  spec?: AssetSpecRow | null
}
export interface AssetImageVersion { id: number | null; url: string | null; provider: string; model: string | null; prompt: string | null; created_at: string | null; generated_at: number | null; is_current: boolean; fidelity: 'verified' | 'failed' | null; fidelity_reason: string | null }


export interface AssetStudioTask { id: number; host_ref: string; title: string; updated_at: string }
export interface AssetStudioAsset { kind: AssetPipelineKind; id: number; name: string; description: string | null; appearance?: string | null; styling?: string | null; prompt?: string | null; lighting?: string | null; subtype: string | null; finalPrompt: string | null; imageUrl: string | null; faithful: boolean; isMap: boolean; referenceImages: {path: string; usage?: string}[] }
export interface AssetStudioDelivery { id: number; run_id: number; round_id: number; image_sha256: string; version_id: number | null; set_as_current: boolean | number; created_at: string }
export interface AssetStudioDetail { task: AssetStudioTask; asset: AssetStudioAsset | null; target: {title: string; subtitle: string | null; return_path: string | null} | null; run: AssetPipelineRunDetail['run'] | null; rounds: AssetPipelineRound[]; drafts: AssetStudioDraft[]; spec: AssetSpecRow | null; sources: AssetSourceRow[]; deliveries: AssetStudioDelivery[] }
export interface ModelChoice { config_id: number; config_name: string; provider: string; model: string; priority?: number }
export interface ObservedCall { id: number; status: string; stage?: string; model?: string; error_msg?: string; [key: string]: unknown }
export interface ObservedMessage { id: number; role: string; content?: unknown; text?: string; [key: string]: unknown }
export const assetStudioAPI = {
 listTasks: () => request<{tasks: AssetStudioTask[]}>('GET', '/tasks'),
 open: (host_ref: string) => request<{task_id: number}>('POST', '/tasks/open', {host_ref}),
 task: (id: number, runId?: number) => request<AssetStudioDetail>('GET', `/tasks/${id}${runId ? `?run_id=${runId}` : ''}`),
 runs: (id: number) => request<{runs: AssetPipelineRunSummary[]}>('GET', `/tasks/${id}/runs`),
 sync: (id: number) => request<{sources: AssetSourceRow[]}>('POST', `/tasks/${id}/sync`),
 versions: (id: number) => request<{versions: AssetImageVersion[]}>('GET', `/tasks/${id}/versions`),
 uploadReference: (id: number, data: FormData) => request<{reference_images: {path: string; usage?: string}[]; sources: AssetSourceRow[]}>('POST', `/tasks/${id}/reference-images`, data),
 deleteReference: (id: number, url: string) => request<{reference_images: {path: string; usage?: string}[]; sources: AssetSourceRow[]}>('DELETE', `/tasks/${id}/reference-images?url=${encodeURIComponent(url)}`),
 cancel: (id: number) => request('POST', `/runs/${id}/cancel`),
 listSources: (id: number) => request<{sources: AssetSourceRow[]}>('GET', `/tasks/${id}/sources`),
 addSource: (data: {task_id: number; host_ref?: string; url?: string; local_path?: string; source_url?: string; title?: string; artist?: string; license: string; role: AssetSourceRole; origin?: 'user_reference'|'research'|'upload'|'manual'; era?: string}) => request('POST', '/sources', data),
 uploadSource: (data: FormData) => request('POST', '/sources', data),
 deleteSource: (id: number) => request('DELETE', `/sources/${id}`),
 researchRecords: (id: number, afterId = 0) => request<{records: AssetResearchRecord[]}>('GET', `/tasks/${id}/research?after_id=${afterId}`),
 startResearch: (id: number, data: {instruction?: string; keywords?: string; text_config_id?: number} = {}) => request<{task_id: number}>('POST', `/tasks/${id}/research`, data),
 createDraft: (id: number, data: {tab: 'precision'|'beautify'; inputs: PrecisionDraftInputs | BeautifyDraftInputs; text_config_id?: number}) => request<AssetStudioDraft>('POST', `/tasks/${id}/drafts`, data),
 drafts: (id: number) => request<{drafts: AssetStudioDraft[]}>('GET', `/tasks/${id}/drafts`),
 draft: (id: number) => request<AssetStudioDraft>('GET', `/drafts/${id}`),
 editDraft: (id: number, data: {prompt: string; negative_prompt?: string | null}) => request<AssetStudioDraft>('PUT', `/drafts/${id}`, data),
 retryDraft: (id: number) => request<AssetStudioDraft>('POST', `/drafts/${id}/retry`),
 generateDraft: (id: number, data: {config_id?: number; model?: string; expected_updated_at?: string} = {}) => request<{run_id: number; draft: AssetStudioDraft}>('POST', `/drafts/${id}/generate`, data),
 deliver: (id: number, round_id: number, set_as_current: boolean) => request('POST', `/runs/${id}/deliver`, {round_id, set_as_current}),
 settings: () => request<{settings: Record<string, string>}>('GET', '/settings'),
 saveSettings: (settings: Record<string, string>) => request('PUT', '/settings', {settings}),
 modelOptions: async () => {
   const result = await request<{models: {service_type: 'image' | 'text'; config_id: number; name: string; models: string[]; vision: boolean}[]}>('GET', '/model-options')
   const choices = (type: 'image' | 'text'): ModelChoice[] => result.models.filter(row => row.service_type === type).flatMap(row => row.models.map(model => ({config_id: row.config_id, config_name: row.name, provider: '', model})))
   return {image: choices('image'), text: choices('text')}
 },
 observed: (id: number, afterId = 0) => request<{works: Record<string, unknown>[]; calls: ObservedCall[]; stage_spans: Record<string, unknown>[]; has_more: boolean; next_after_id: number}>('GET', `/runs/${id}/observed?after_id=${afterId}`),
 messages: (id: number, afterId = 0) => request<{messages: ObservedMessage[]; total: number}>('GET', `/calls/${id}/messages?after_id=${afterId}&limit=100`),
}
