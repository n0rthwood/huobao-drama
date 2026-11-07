import type { TaskRow, CenterRow } from '~/composables/useTasks'
import { apiBase } from '~/utils/url'

// 子路径部署：'/api/v1' 或 '/huobao/api/v1'（见 utils/url.ts）

/** 非 2xx 时抛出的错误：除 message 外保留原始响应体，供结构化错误（#31 阻断原因）渲染 */
export interface ApiError extends Error {
  status?: number
  body?: Record<string, unknown>
}

/** 纪录片步骤门禁（#54）：`GET /episodes/:id/gates`；剧情项目恒全解锁、reasons 为空 */
export type GateKey = 'assets' | 'design' | 'production' | 'final' | 'poster' | 'export'
export interface EpisodeGates {
  project_type: 'drama' | 'documentary'
  script: { confirmed: boolean; confirmed_at: string | null }
  assets: { review_status: 'none' | 'running' | 'pending' | 'passed'; stale_reasons: string[]; missing: number }
  design: { confirmed: number; total: number }
  production: { ready: number; total: number }
  final: { fresh: number; total: number }
  unlocked: Record<GateKey, boolean>
  reasons: Partial<Record<GateKey, string>>
  goto: Partial<Record<GateKey, 'script' | 'assets' | 'design' | 'production' | 'final'>>
}

/** 400 门禁拦截体：`{ error:'gate_blocked', gate, reason }`（由后端全局 onError 统一产出） */
export function gateBlockedOf(err: unknown): { gate: GateKey; reason: string } | null {
  const body = (err as ApiError)?.body
  if (!body || body.error !== 'gate_blocked') return null
  return { gate: body.gate as GateKey, reason: String(body.reason || '') }
}

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${apiBase()}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      // 结构化错误体（如 #31 的 block_reason / gap_ratio）挂在 err.body 上，调用方可按字段渲染
      const apiErr: ApiError = new Error(json.message || `${resp.status}`)
      apiErr.status = resp.status
      apiErr.body = json
      throw apiErr
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json !== null && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  // 纪录片选角名册（Issue #32）：谁该建卡的契约，人在集页面复核确认后提取才照它执行
  characterRoster: (id: number) => api.get(`/episodes/${id}/character-roster`),
  saveCharacterRoster: (id: number, cast: { name: string; basis?: string; reason?: string; source?: string }[], status: 'draft' | 'approved' = 'approved', expectedHash?: string) =>
    api.put(`/episodes/${id}/character-roster`, { cast, status, expected_hash: expectedHash || undefined }),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
  // 批量补齐关键帧提示词（首/中/尾三槽），与视频提示词批量同一套异步状态模型
  generateKeyframePrompts: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number } = {}) =>
    api.post(`/episodes/${id}/generate-keyframe-prompts`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  keyframePromptsStatus: (id: number) => api.get(`/episodes/${id}/keyframe-prompts-status`),
  // 「批量AI提示词」的范围清单（#58）：弹窗先拉这个，展示将处理/排除的镜与排除原因
  keyframePromptsScope: (id: number) =>
    api.get<{
      included: Array<{ storyboard_id: number; storyboard_number: number }>
      excluded: Array<{ storyboard_id: number; storyboard_number: number; reason: string }>
    }>(`/episodes/${id}/keyframe-prompts/scope`),
  // 批量关键帧预览：逐「分镜 × 槽位」给出 缺图/已变化/未变化(同第 N 版)/被拦截/跳过 与默认勾选
  keyframeBatchPreview: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number } = {}) =>
    api.post(`/episodes/${id}/keyframe-batch/preview`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  // 集级关键帧批量：按预览勾选的 items 显式提交，由服务端排队调度
  startKeyframeBatch: (id: number, data: { items: Array<{ storyboard_id: number; slot: 'first' | 'mid' | 'last' }>; model?: string; config_id?: number }) =>
    api.post(`/episodes/${id}/keyframe-batch`, {
      items: data.items,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  keyframeBatch: (id: number) => api.get(`/episodes/${id}/keyframe-batch`),
  cancelKeyframeBatch: (id: number) => api.post(`/episodes/${id}/keyframe-batch/cancel`),
  // 失败/已取消的关键帧项重新提交（每项新建 sys_task，不复用原任务）
  retryFailedKeyframeBatch: (id: number) => api.post(`/episodes/${id}/keyframe-batch/retry-failed`),
  // 批量视频预览：逐镜按输入签名列出 缺视频/已变化/未变化(同第N版)/无法判断/阻断/跳过
  previewVideoBatch: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number }) =>
    api.post(`/episodes/${id}/video-batch/preview`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  // 集级串行视频批量：按预览勾选的镜头，后端按分镜顺序生成
  startVideoBatch: (id: number, data: { storyboard_ids: number[]; model?: string; config_id?: number }) =>
    api.post(`/episodes/${id}/video-batch`, {
      storyboard_ids: data.storyboard_ids,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  videoBatch: (id: number) => api.get(`/episodes/${id}/video-batch`),
  cancelVideoBatch: (id: number) => api.post(`/episodes/${id}/video-batch/cancel`),
  // 旁白（#30）：旁白写作 / 批量配音 / 批量合成，都是集级文本任务，与视频提示词批量同一套状态模型
  generateNarration: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number } = {}) =>
    api.post(`/episodes/${id}/generate-narration`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  narrationStatus: (id: number) => api.get(`/episodes/${id}/narration-status`),
  // 分镜设计卡（#57，纪录片）：选择器数据源（资产 + 语义条目 + 底图候选 + 上限）、
  // 逐镜审计、批量填写（不带 storyboard_ids = 只补空白/过期）与批量状态、分镜重排。
  designCardContext: (id: number) => api.get<DesignCardContext>(`/episodes/${id}/design-card-context`),
  designCardAudit: (id: number) => api.get<DesignCardAuditItem[]>(`/episodes/${id}/design-cards/audit`),
  // 填卡进度统一走全局任务 store（sys_task kind='design_card'），不再单独查批次状态（#70）
  fillDesignCards: (id: number, data: { storyboard_ids?: number[]; model?: string; config_id?: number } = {}) =>
    api.post(`/episodes/${id}/design-cards/fill`, {
      storyboard_ids: data.storyboard_ids?.length ? data.storyboard_ids : undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  reorderStoryboards: (id: number, ids: number[]) =>
    api.put<{ changed: number; entries: Array<{ id: number; from: number; to: number }>; reconfirm: number[] }>(
      `/episodes/${id}/storyboards/order`,
      { ids },
    ),
  // 旁白覆盖与补全剩余（Issue #52）
  narrationCoverage: (id: number) =>
    api.get<{
      episode_id: number
      project_type: 'drama' | 'documentary'
      script_chars: number
      covered_chars: number
      uncovered_chars: number
      gaps: Array<{ start: number; end: number; chars: number; excerpt: string }>
      gap_count: number
      shots: number
      running: boolean
    }>(`/episodes/${id}/narration-coverage`),
  fillStoryboardGaps: (id: number, data: { model?: string; config_id?: number } = {}) =>
    api.post<{ status: 'running' | 'idle'; gaps: number; task_id?: number }>(`/episodes/${id}/storyboards/fill-gaps`, {
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  // 步骤门禁与剧本确认（Issue #54）
  gates: (id: number) => api.get<EpisodeGates>(`/episodes/${id}/gates`),
  confirmScript: (id: number) => api.post<EpisodeGates>(`/episodes/${id}/script/confirm`),
  unconfirmScript: (id: number) => api.post<EpisodeGates>(`/episodes/${id}/script/unconfirm`),
  // 旁白编辑器的语气 / 多音字 / 停顿选项（#38）
  narrationMarkupCatalog: (id: number) =>
    api.get<{
      tones: { tag: string; label: string; group: string }[]
      polyphones: Record<string, [string, string][]>
      pause: { min: number; max: number; presets: number[] }
    }>(`/episodes/${id}/narration-markup-catalog`),
  // 配音弹窗（#37）：选项与预填值 / 批量预览 / 批量执行（settings = 弹窗参数，保存为本集默认）
  ttsOptions: (id: number, storyboardId?: number) =>
    api.get<TtsOptions>(`/episodes/${id}/tts-options${storyboardId ? `?storyboard_id=${storyboardId}` : ''}`),
  narrationVoicePreview: (id: number, settings: VoiceSettings, storyboardIds?: number[]) =>
    api.post<{ items: VoicePlanItem[] }>(`/episodes/${id}/narration/voice-batch/preview`, {
      settings,
      storyboard_ids: storyboardIds,
    }),
  narrationVoiceBatch: (id: number, settings: VoiceSettings, storyboardIds?: number[]) =>
    api.post(`/episodes/${id}/narration/voice-batch`, { settings, storyboard_ids: storyboardIds }),
  narrationVoiceBatchStatus: (id: number) => api.get(`/episodes/${id}/narration/voice-batch-status`),
  /**
   * 批量融合（#42）：先预览分类，再按显式勾选的 id 执行。
   * 预览省略 storyboard_ids = 整集范围；执行必须传非空数组（显式勾选过的那批），
   * 空数组绝不等于全选。
   */
  composePreview: (id: number, storyboardIds?: number[]) =>
    api.post<{ items: ComposeState[] }>(
      `/episodes/${id}/compose-batch/preview`,
      storyboardIds === undefined ? {} : { storyboard_ids: storyboardIds },
    ),
  composeBatch: (id: number, storyboardIds: number[]) =>
    api.post<{ status: 'running' | 'idle'; total: number; already_running?: boolean }>(
      `/episodes/${id}/compose-batch`, { storyboard_ids: storyboardIds }),
  composeBatchStatus: (id: number) => api.get<ComposeBatchStatus | null>(`/episodes/${id}/compose-batch-status`),
  // 资产管理器（#9）：本项目已有资产关联到本集 / 取消关联（不删资产）
  linkAsset: (id: number, kind: AssetKindName, assetId: number) =>
    api.post(`/episodes/${id}/assets/link`, { kind, asset_id: assetId }),
  unlinkAsset: (id: number, kind: AssetKindName, assetId: number) =>
    api.del(`/episodes/${id}/assets/link?kind=${kind}&asset_id=${assetId}`),
}

export type AssetKindName = 'character' | 'scene' | 'prop'

export interface LibraryAsset {
  kind: AssetKindName
  id: number
  drama_id: number
  drama_title: string
  name: string
  subtitle: string
  image_url: string | null
  version_count: number
  reference_count: number
  episodes: Array<{ id: number; episode_number: number; title: string }>
}

/**
 * 资产管理器（#9）：浏览全部项目的资产、跨项目全量复制导入。
 * 本项目内复用走 episodeAPI.linkAsset（关联同一资产，不复制）。
 */
export const assetLibraryAPI = {
  list: (params: { drama_id?: number; kind?: AssetKindName; q?: string; target_drama_id?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.drama_id != null) query.set('drama_id', String(params.drama_id))
    if (params.kind) query.set('kind', params.kind)
    if (params.q) query.set('q', params.q)
    if (params.target_drama_id != null) query.set('target_drama_id', String(params.target_drama_id))
    const qs = query.toString()
    return api.get<{
      dramas: Array<{ id: number; title: string; asset_count: number }>
      items: LibraryAsset[]
      taken_names?: Record<AssetKindName, string[]>
    }>(`/asset-library${qs ? `?${qs}` : ''}`)
  },
  detail: (kind: AssetKindName, id: number) => api.get(`/asset-library/${kind}/${id}`),
  // 跨项目全量复制：文本 + 当前图 + 全部历史版本 + 参考图都复制一份，源与副本互不影响
  import: (dramaId: number, data: { kind: AssetKindName; source_id: number; name?: string; episode_id?: number | null }) =>
    api.post(`/dramas/${dramaId}/assets/import`, data),
}

/** 配音参数（#37）：seed 为 null = 随机 */
export interface VoiceSettings {
  voice: string
  inference_timesteps: number
  cfg_value: number
  seed: number | null
  instructions: string
  normalize: boolean
}

export interface TtsOptions {
  config_id: number | null
  config_name: string
  voices: { name: string; group: string }[]
  steps: { min: number; max: number; default: number; presets: { steps: number; rtf: number }[] }
  cfg: { min: number; max: number; default: number }
  chars_per_second: number
  current: VoiceSettings
}

export interface VoicePlanItem {
  storyboard_id: number
  storyboard_number: number
  status: 'missing' | 'changed' | 'unchanged' | 'skipped'
  audio_seconds: number
}

/** 单镜合成结果（#30，后端 ComposeResult 原样返回：camelCase） */
export interface ComposeResult {
  storyboardId: number
  composedVideoUrl: string
  durationMs: number
  plan: NarrationFitPlan
  burned: boolean
}

/**
 * 融合状态（#42）：分镜列表、批量预览、导出就绪三处同一份服务端口径。
 * unchanged + exportable = 当前融合片可直接拼接；missing/changed/unknown 可执行；
 * blocked（依赖缺失/文件丢失/配音过期/计划失败）与 skipped（排队或进行中）不可勾选；
 * disabled = 本集旁白关闭，走原视频拼接。
 */
export type ComposeStateStatus =
  | 'disabled' | 'missing' | 'changed' | 'unchanged' | 'unknown' | 'blocked' | 'skipped'

export interface ComposeState {
  storyboard_id: number
  storyboard_number: number
  title: string
  status: ComposeStateStatus
  selectable: boolean
  /** 预览默认勾选：缺失 / 已变化 */
  checked: boolean
  /** 可直接用于最终拼接 */
  exportable: boolean
  reason: string | null
  change_reasons: string[]
  signature: string | null
  plan: NarrationFitPlan | null
  /** 真实可用性（文件存在 / 可解析），不是 URL 是否非空 */
  inputs: { video: boolean; audio: boolean; subtitle: boolean; pure_visual: boolean }
  composed_video_url: string | null
}

export type ComposeBatchItemState = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'

/** 批量融合任务态（落在 sys_task.params.progress，刷新浏览器可重连） */
export interface ComposeBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  skipped: number
  current_storyboard_id?: number
  started_at?: number
  finished_at?: number
  error?: string
  items: {
    storyboard_id: number
    storyboard_number: number
    state: ComposeBatchItemState
    reason: string | null
  }[]
}

/** 拼接被拒时 400 响应体里的逐镜原因（err.body.blocked） */
export interface MergeBlockedItem {
  storyboard_id: number
  storyboard_number: number
  status: ComposeStateStatus
  reason: string
}

/** 匹配预览里的合成计划（#31，后端 narration-fit.ts 的 ComposePlan，单位秒） */
export interface NarrationFitPlan {
  dv: number
  da: number
  daScaled: number
  t: number
  d: number
  narrationStart: number
  freezeSeconds: number
  trim: boolean
  availSeconds: number
  /** 正 = 旁白偏长，负 = 旁白偏短 */
  gapRatio: number
  blocked: boolean
  blockReason: 'narration_too_long' | 'narration_gap_too_large' | null
}

/** 本镜旁白/画面匹配参数的生效值（#31），三个 narration-fit 接口共用的返回体 */
export interface NarrationFitPreview {
  storyboard_id: number
  mode: 'pad' | 'tempo'
  pad_ms: number
  pad_position: 'head' | 'tail'
  tempo: number
  /** null = 未手调，合成时按实测时长现算 */
  tempo_override: number | null
  audio_mix_mode: 'replace' | 'mix'
  bed_gain_db: number
  /** true = 本镜没有自己的覆盖，继承剧集默认 */
  inherited: boolean
  plan: NarrationFitPlan
  suggested_chars: number
  tempo_available: boolean
  limits: { min_tempo: number; max_tempo: number; max_pad_seconds: number }
}

/** PUT /narration-fit 的请求体；省略的键表示不改动（audio_mix_mode 省略 = 继承剧集） */
export interface NarrationFitBody {
  mode: 'pad' | 'tempo'
  pad_ms?: number
  pad_position?: 'head' | 'tail'
  tempo_override?: number | null
  audio_mix_mode?: 'replace' | 'mix'
}

/** 资产批量生成（#33）：角色 / 场景 / 道具 / 全部资产四个入口共用一个端点，只是 scope 不同 */
export type AssetBatchScope = 'characters' | 'scenes' | 'props' | 'all'

export interface AssetBatchParams {
  scope: AssetBatchScope
  episode_id: number
  rewrite_prompts: boolean
  overwrite_images: boolean
  model?: string
  config_id?: number
  text_model?: string
  text_config_id?: number
}

export interface AssetBatchPreview {
  total: number
  will_generate: { missing_prompt: number; reuse_prompt: number; rewrite_prompt: number }
  skipped: { has_image: number; running: number; faithful: number }
  running: AssetBatchStatus | null
}

export interface AssetBatchItem {
  kind: AssetKindName
  asset_id: number
  name: string
  selection: string
  state: string
  prompt_outcome: string | null
  task_id: number | null
  error: string | null
}

export interface AssetBatchStatus {
  id: number
  drama_id: number
  episode_id: number | null
  scope: AssetBatchScope
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  cancel_requested: boolean
  options: { rewrite_prompts: boolean; overwrite_images: boolean }
  counts: {
    total: number
    skipped: { has_image: number; running: number; faithful: number }
    prompt: { done: number; failed: number; reused: number; regenerated: number; unchanged_after_rewrite: number }
    image: { submitted: number; done: number; failed: number }
  }
  items: AssetBatchItem[]
  created_at: string
  updated_at: string
  error: string | null
}

export const assetBatchAPI = {
  preview: (dramaId: number, data: AssetBatchParams) =>
    api.post<AssetBatchPreview>(`/dramas/${dramaId}/assets/batch-generate/preview`, data),
  start: (dramaId: number, data: AssetBatchParams) =>
    api.post<AssetBatchStatus>(`/dramas/${dramaId}/assets/batch-generate`, data),
  status: (dramaId: number) => api.get<AssetBatchStatus | null>(`/dramas/${dramaId}/assets/batch-generate`),
  cancel: (dramaId: number) => api.post<AssetBatchStatus>(`/dramas/${dramaId}/assets/batch-generate/cancel`),
}

/** 分镜设计卡（#57）：与后端 services/design-card.ts 同形 */
export type Combo = 'A' | 'B' | 'C' | 'D'
export const COMBOS: readonly Combo[] = ['A', 'B', 'C', 'D']
export type DesignCardStatus = 'blank' | 'ai_filling' | 'pending' | 'confirmed' | 'stale'
export type InfoPointVia = 'layer' | 'generated' | 'narration_only'
export type PlannedLayerType = 'polygon' | 'polyline' | 'marker' | 'label' | 'card' | 'image'

export interface InfoPoint {
  id: string
  text: string
  via: InfoPointVia
}

export type BaseRef =
  | {
      kind: 'asset'
      asset_kind: AssetKindName
      asset_id: number
      version_task_id: number | null
      unresolved?: boolean
      unresolved_reason?: string
    }
  | { kind: 'inherit_prev' }

export interface SemanticRef {
  asset_id: number
  semantic_id: string
  name: string
  unresolved?: boolean
  unresolved_reason?: string
}

export interface AssetRef {
  kind: AssetKindName
  id: number
  name: string
  unresolved?: boolean
  unresolved_reason?: string
}

export interface PlannedLayer {
  type: PlannedLayerType
  text?: string
  anchor?: SemanticRef
  at_s: number
}

export type CardIssueCode =
  | 'combo_missing' | 'budget_over_layer' | 'budget_over_gen' | 'budget_under_narration'
  | 'missing_base' | 'gen_slot_missing'
  | 'info_point_unassigned' | 'must_mark_not_planned' | 'reference_not_mentioned'
  | 'budget_tight' | 'unresolved_ref'

export interface CardIssue {
  code: CardIssueCode
  severity: 'block' | 'warn'
  message: string
  index?: number
}

export interface DesignCard {
  version: 2
  info_points: InfoPoint[]
  budget: { layer_s: number | null; gen_s: number | null }
  layer_plan?: { base: BaseRef | null; must_mark: SemanticRef[]; planned_layers: PlannedLayer[] }
  gen_plan?: { reference_assets: AssetRef[]; first?: string; mid?: string; last?: string }
  rationale: string
  suggested_combo: Combo | null
  issues: CardIssue[]
}

/** 设计卡选择器数据源：GET /episodes/:id/design-card-context */
export interface DesignCardContext {
  assets: Array<{
    kind: AssetKindName
    id: number
    name: string
    exposition?: boolean
    faithful?: boolean
    image?: string | null
    semantics?: Array<{ id: string; name: string; group: 'label' | 'point' | 'region' | 'line' }>
  }>
  base_candidates: Array<{
    asset_kind: AssetKindName
    asset_id: number
    version_task_id: number | null
    path: string
    width: number
    height: number
    verified: boolean
    name: string
  }>
  combos: Combo[]
  info_point_vias: InfoPointVia[]
  planned_layer_types: PlannedLayerType[]
  limits: {
    layer_s: number
    gen_s: number
    narration_cps: number
    info_points: number
    planned_layers: number
    must_mark: number
    rationale: number
  }
}

/** 单镜写入 / 确认 / 取消确认的统一返回 */
export interface DesignCardShotState {
  storyboard_id: number
  shot_number: number
  narration_text: string
  combo: Combo | null
  design_card: DesignCard | null
  design_card_status: DesignCardStatus
  design_card_confirmed_at: string | null
  design_card_stale_reason: string | null
  issues: CardIssue[]
  narration_estimate_s: number
  narration_measured_s: number | null
}

/** GET /episodes/:id/design-cards/audit 的逐镜条目 */
export interface DesignCardAuditItem {
  storyboard_id: number
  shot_number: number
  narration_text: string
  combo: Combo | null
  suggested_combo: Combo | null
  status: DesignCardStatus
  confirmed_at: string | null
  stale_reason: string | null
  has_card: boolean
  unresolved: number
  issues: CardIssue[]
  narration_estimate_s: number
  narration_measured_s: number | null
  budget: { layer_s: number | null; gen_s: number | null }
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
  // 分镜设计卡（#57）：整份 design_card + combo 覆盖写（后端整份替换，不做字段级合并），
  // 写入即回到「待审」；确认 / 取消确认各一个动作，三者返回同形 DesignCardShotState。
  setDesignCard: (id: number, data: { combo?: Combo | null; design_card?: DesignCard | null }) =>
    api.put<DesignCardShotState>(`/storyboards/${id}/design-card`, data),
  confirmDesignCard: (id: number, acknowledge = false) =>
    api.post<DesignCardShotState>(`/storyboards/${id}/design-card/confirm`, acknowledge ? { acknowledge: true } : {}),
  unconfirmDesignCard: (id: number) =>
    api.post<DesignCardShotState>(`/storyboards/${id}/design-card/unconfirm`),
  // 段组合切换（#58）：先问影响（保留 / 失效归档 / 需要新做），确认后切换（只归档不删除）
  comboImpact: (id: number, to: 'A' | 'B' | 'C' | 'D') =>
    api.get<{
      from: 'A' | 'B' | 'C' | 'D' | null
      to: 'A' | 'B' | 'C' | 'D'
      keep: Array<{ code: string; text: string }>
      archive: Array<{ code: string; text: string }>
      redo: Array<{ code: string; text: string }>
    }>(`/storyboards/${id}/combo/impact?to=${to}`),
  setCombo: (id: number, combo: 'A' | 'B' | 'C' | 'D') =>
    api.post(`/storyboards/${id}/combo`, { combo }),
  // 视频生成参数（关键帧引导、参考图 / @图片N 映射 / 分辨率）全部由后端组装
  generateVideo: (id: number, data: { model?: string; config_id?: number }) =>
    api.post(`/storyboards/${id}/generate-video`, { model: data.model || undefined, config_id: data.config_id || undefined }),
  // 承接镜头的开场转场：AI 审核并生成，返回更新后的分镜（#11）
  generateTransition: (id: number, data: { model?: string; config_id?: number } = {}) =>
    api.post(`/storyboards/${id}/transition`, { model: data.model || undefined, config_id: data.config_id || undefined }),
  // 关键帧槽位：first | mid | last
  generateKeyframe: (id: number, slot: 'first' | 'mid' | 'last', data: { prompt?: string; model?: string; config_id?: number } = {}) =>
    api.post(`/storyboards/${id}/keyframes/${slot}/generate`, {
      prompt: data.prompt || undefined,
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  keyframeVersions: (id: number, slot: 'first' | 'mid' | 'last') => api.get(`/storyboards/${id}/keyframes/${slot}/versions`),
  // { image } 选定该槽位版本；{ inherit: true } 仅首帧：清除自有首帧改用上一镜尾帧
  selectKeyframe: (id: number, slot: 'first' | 'mid' | 'last', data: { image?: string; inherit?: boolean }) =>
    api.put(`/storyboards/${id}/keyframes/${slot}`, data),
  confirmKeyframes: (id: number, confirmed: boolean) => api.post(`/storyboards/${id}/confirm-keyframes`, { confirmed }),
  // 目标级（首/中/尾关键帧、视频）参考图选版：image 为 null 表示恢复默认
  setTargetAsset: (
    id: number,
    target: 'first' | 'mid' | 'last' | 'video',
    data: { kind: 'scene' | 'character' | 'prop'; asset_id: number; image: string | null },
  ) => api.put(`/storyboards/${id}/target-assets/${target}`, data),
  // 本镜资产池（#43）：单项手选/取消手选。被首/中/尾/视频/转场提示词 @ 引用的资产不可取消（后端 400）
  setPoolAsset: (
    id: number,
    data: { kind: 'character' | 'scene' | 'prop'; asset_id: number; selected: boolean },
  ) => api.put(`/storyboards/${id}/pool-assets`, data),
  // 单镜旁白写作/重写（#35，同步返回；上下文 = 剧本全文 + 主线 + 前后镜旁白）
  writeNarration: (id: number, data: { model?: string; config_id?: number } = {}) =>
    api.post<{ narration_text: string; narration_enabled: boolean; duration: number }>(
      `/storyboards/${id}/narration/write`,
      { model: data.model || undefined, config_id: data.config_id || undefined },
    ),
  // 旁白配音（#30，同步返回音频与字幕）/ 仅重出字幕（切换时间码模式后不重跑 TTS）/ 本镜合成
  generateNarrationVoice: (id: number, settings: VoiceSettings) =>
    api.post<{ audio_url: string; subtitle_url: string; duration_ms: number; duration: number; cues: number; subtitle_source: string }>(
      `/storyboards/${id}/narration/voice`, { settings }),
  regenerateSubtitle: (id: number) => api.post(`/storyboards/${id}/narration/subtitle`, {}),
  compose: (id: number) => api.post<ComposeResult>(`/storyboards/${id}/compose`, {}),
  // 旁白/画面时长与音轨匹配（#31）：预览是纯计算（不跑 ffmpeg），保存越界时抛带 body 的 400
  narrationFitPreview: (id: number) =>
    api.get<NarrationFitPreview>(`/storyboards/${id}/narration-fit/preview`),
  saveNarrationFit: (id: number, body: NarrationFitBody) =>
    api.put<NarrationFitPreview>(`/storyboards/${id}/narration-fit`, body),
  clearNarrationFit: (id: number) =>
    api.del<NarrationFitPreview>(`/storyboards/${id}/narration-fit`),
}

/**
 * 资产参考图（角色/场景/道具通用）：库里存 JSON 对象数组 `[{ path, uploaded_at }]`
 * （`uploaded_at` 为 unix 秒，存量数据缺文件时为 null）。
 * 参考图是「生成输入」，与成片图 image_url/local_path 互不影响。
 */
export interface ReferenceImage {
  path: string
  uploaded_at: number | null
  /** 从素材库选入时记录的源图相对路径，用于同一资产的重复选入去重 */
  copied_from?: string
}

export type ReferenceImagesResp = { reference_images: ReferenceImage[] }

/** 从素材库选入参考图：added = 实际复制数，skipped = 同源去重跳过数 */
export type LibraryRefsResp = ReferenceImagesResp & { added: number; skipped: number }

/** 宽容读取资产行里的参考图列：对象数组 / JSON 字符串都接受，其它一律空数组 */
export function parseReferenceImages(raw: unknown): ReferenceImage[] {
  const list = Array.isArray(raw)
    ? raw
    : (() => {
      if (typeof raw !== 'string') return []
      const text = raw.trim()
      if (!text.startsWith('[')) return []
      try {
        const parsed: unknown = JSON.parse(text)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })()
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      const path = String(entry.path ?? '').trim()
      if (!path) return null
      const uploadedAt = Number(entry.uploaded_at)
      const copiedFrom = String(entry.copied_from ?? '').trim()
      const parsed: ReferenceImage = { path, uploaded_at: Number.isFinite(uploadedAt) && uploadedAt > 0 ? uploadedAt : null }
      if (copiedFrom) parsed.copied_from = copiedFrom
      return parsed
    })
    .filter((entry): entry is ReferenceImage => !!entry)
}

/**
 * 纪录片/历史题材的资料检索与史料参考（Issue #32）。
 * 史料参考（archival_images）与参考图（reference_images）严格分离：前者只做出处留档，不参与生图。
 */
export interface ArchivalImage {
  path: string
  file_title?: string
  source_page_url?: string
  file_url?: string
  artist?: string
  work_date?: string
  license?: string
  license_url?: string
  retrieved_at?: string
}

export interface CommonsFile {
  file_title: string
  thumb_url?: string
  file_url?: string
  source_page_url?: string
  artist?: string
  work_date?: string
  license?: string
  license_url?: string
  mime?: string
  width?: number
  height?: number
}

export type CommonsSearchResp = { query: string; results: CommonsFile[]; retrieved_at: string }

export interface ResearchCitation {
  id: number
  drama_id: number
  episode_id: number | null
  asset_kind: AssetKindName
  asset_id: number
  asset_name: string
  tool: string
  query: string
  title: string
  source_url: string
  lang: string
  snippet: string
  // 'failed' = 检索不可用，该资产只用了剧本原文
  status: string
  retrieved_at: string
}

/** 「重新提取本资产信息」：先清空提取字段再跑提取 Agent，进度走 episodeAPI.extractStatus */
export type ReExtractResp = { started: boolean; asset_id: number; cleared_fields: string[] }

/**
 * 「按史料画像补充外貌」（Issue #32）：读该角色已入库的史料画像推出具体长相，写回 characters.appearance。
 * 史料画像始终只是「被读」的档案，绝不进 reference_images，否则三视图人设会被 image_edit 毁掉。
 * 能否读图取决于所选文本模型，后端实测探测，vision.used=false 时只用文字资料兜底。
 */
export type PortraitAppearanceResp = {
  started: boolean
  task_id: number
  vision: { used: boolean; config_name?: string; model?: string }
  portraits: number
}
export type PortraitAppearanceStatusResp = {
  status: 'running' | 'done' | 'error' | null
  source: 'vision' | 'text' | null
  model: string | null
  appearance: string | null
  error: string | null
  updated_at: string | null
}

export const researchAPI = {
  commonsSearch: (q: string, limit?: number) => api.get<CommonsSearchResp>(`/research/commons/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),
  citations: (assetKind: AssetKindName, assetId: number) => api.get<ResearchCitation[]>(`/research/citations?asset_kind=${assetKind}&asset_id=${assetId}`),
}

export const characterAPI = {
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  // referenceImages 省略 → 服务端用该资产已保存的参考图；传 [] → 明确不用参考图
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages }),
  // 本集造型版本（Issue #15）：文字保存与以基础形象图换装出图
  saveStylingVersion: (id: number, episodeId: number, name: string, description?: string) => api.put(`/characters/${id}/styling-version`, { episode_id: episodeId, name, description }),
  generateStylingVersionImage: (id: number, episodeId: number, model?: string, configId?: number) => api.post(`/characters/${id}/styling-version/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined }),
  addReference: (id: number, file: File) => uploadReq<ReferenceImagesResp>(`/characters/${id}/reference-images`, file),
  delReference: (id: number, url: string) => api.del<ReferenceImagesResp>(`/characters/${id}/reference-images?url=${encodeURIComponent(url)}`),
  addRefsFromLibrary: (id: number, urls: string[]) => api.post<LibraryRefsResp>(`/characters/${id}/reference-images/from-library`, { urls }),
  // 史料参考（Issue #32）：只做档案留存，严格不进生图链路
  addArchivalImage: (id: number, fileTitle: string) => api.post<ArchivalImage[]>(`/characters/${id}/archival-images`, { file_title: fileTitle }),
  removeArchivalImage: (id: number, path: string) => api.del<ArchivalImage[]>(`/characters/${id}/archival-images?path=${encodeURIComponent(path)}`),
  reExtract: (id: number, episodeId: number, textModel?: string, textConfigId?: number) => api.post<ReExtractResp>(`/characters/${id}/re-extract`, { episode_id: episodeId, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  appearanceFromPortrait: (id: number, episodeId: number, textConfigId?: number) => api.post<PortraitAppearanceResp>(`/characters/${id}/appearance-from-portrait`, { episode_id: episodeId, text_config_id: textConfigId || undefined }),
  appearanceFromPortraitStatus: (id: number, episodeId: number) => api.get<PortraitAppearanceStatusResp>(`/characters/${id}/appearance-from-portrait?episode_id=${episodeId}`),
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages }),
  addReference: (id: number, file: File) => uploadReq<ReferenceImagesResp>(`/scenes/${id}/reference-images`, file),
  delReference: (id: number, url: string) => api.del<ReferenceImagesResp>(`/scenes/${id}/reference-images?url=${encodeURIComponent(url)}`),
  addRefsFromLibrary: (id: number, urls: string[]) => api.post<LibraryRefsResp>(`/scenes/${id}/reference-images/from-library`, { urls }),
  reExtract: (id: number, episodeId: number, textModel?: string, textConfigId?: number) => api.post<ReExtractResp>(`/scenes/${id}/re-extract`, { episode_id: episodeId, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

/**
 * 证据素材语义标注（Issue #47）。坐标一律是 `faithful_source` 那张原图的像素坐标，
 * 前端只按 `image.width/height` 做 viewBox 缩放，不另存一套渲染尺寸。
 */
export type SemanticsSource = 'vlm' | 'cv' | 'manual'
export type SemanticsLineKind = 'river' | 'route' | 'border'
export interface SemanticsLabel { id: string; text: string; bbox: [number, number, number, number]; source: SemanticsSource; confidence: number }
export interface SemanticsPoint { id: string; name: string; at: [number, number]; source: SemanticsSource; confidence: number }
export interface SemanticsRegion { id: string; name: string; points: Array<[number, number]>; source: SemanticsSource; confidence: number }
export interface SemanticsLine { id: string; name: string; points: Array<[number, number]>; kind: SemanticsLineKind; source: SemanticsSource; confidence: number; color?: string }
export interface AssetSemanticsDoc {
  image: { width: number; height: number; source_task_id: number | null }
  labels: SemanticsLabel[]
  points: SemanticsPoint[]
  regions: SemanticsRegion[]
  lines: SemanticsLine[]
  warnings?: string[]
  generated_at?: string
  model?: string
}
export interface PropSemanticsResp {
  faithful: 0 | 1
  faithful_source: number | null
  /** 坐标所针对的底图（设了忠实原件就是那一版，否则是当前图） */
  base_image_url: string | null
  semantics: AssetSemanticsDoc | null
}
export interface PropSemanticsAutoResp { started: boolean; task_id: number }
export interface PropSemanticsAutoStatus {
  status: 'running' | 'done' | 'error' | 'none'
  task_id: number | null
  error: string | null
  warnings: string[]
  counts: { labels: number; points: number; regions: number; lines: number }
}
/** 资产行（道具）：接口按需返回，组件只读取自己关心的字段 */
export type PropRow = Record<string, unknown>

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, referenceImages?: string[]) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, reference_images: referenceImages }),
  addReference: (id: number, file: File) => uploadReq<ReferenceImagesResp>(`/props/${id}/reference-images`, file),
  delReference: (id: number, url: string) => api.del<ReferenceImagesResp>(`/props/${id}/reference-images?url=${encodeURIComponent(url)}`),
  addRefsFromLibrary: (id: number, urls: string[]) => api.post<LibraryRefsResp>(`/props/${id}/reference-images/from-library`, { urls }),
  reExtract: (id: number, episodeId: number, textModel?: string, textConfigId?: number) => api.post<ReExtractResp>(`/props/${id}/re-extract`, { episode_id: episodeId, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  // 证据素材与语义标注（Issue #47）：faithful=1 的道具永不进生图；语义坐标永远相对 faithful_source 那张原图
  setFaithful: (id: number, faithful: boolean) => api.put<PropRow>(`/props/${id}`, faithful ? { faithful: true } : { faithful: false, confirm_unfaithful: true }),
  setFaithfulSource: (id: number, versionTaskId: number) => api.put<PropRow>(`/props/${id}/faithful-source`, { version_task_id: versionTaskId }),
  semantics: (id: number) => api.get<PropSemanticsResp>(`/props/${id}/semantics`),
  saveSemantics: (id: number, semantics: AssetSemanticsDoc) => api.put<{ semantics: AssetSemanticsDoc }>(`/props/${id}/semantics`, { semantics }),
  autoSemantics: (id: number, episodeId: number, configId?: number) => api.post<PropSemanticsAutoResp>(`/props/${id}/semantics/auto`, { episode_id: episodeId, config_id: configId || undefined }),
  autoSemanticsStatus: (id: number) => api.get<PropSemanticsAutoStatus>(`/props/${id}/semantics/auto/status`),
  // 地图确定性底图（Issue #56）：map_spec 只存人工确认过的点，AI 建议一律 proposed，由前端勾选后才写回
  mapSpec: (id: number) => api.get<{ map_spec: MapSpec | null }>(`/props/${id}/map-spec`),
  saveMapSpec: (id: number, mapSpec: MapSpec) => api.put<{ map_spec: MapSpec }>(`/props/${id}/map-spec`, { map_spec: mapSpec }),
  renderMapBase: (id: number, episodeId: number, size?: { width?: number; height?: number }) =>
    api.post<MapRenderResp>(`/props/${id}/map-render`, { episode_id: episodeId, width: size?.width || undefined, height: size?.height || undefined }),
  suggestMapPlaces: (id: number, episodeId: number, names?: string[], textConfigId?: number) =>
    api.post<{ places: MapProposedPlace[] }>(`/props/${id}/map-suggest`, { episode_id: episodeId, names: names?.length ? names : undefined, text_config_id: textConfigId || undefined }),
}

// 资产「精确→美化」流水线（Issue #56）。闸门结论由后端按清单计算，前端只渲染，不复算也不采信模型自判。
export interface MapPlace { id: string; name: string; lon: number; lat: number; proposed?: boolean }
export interface MapRoute { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
export interface MapSpec {
  version: 1
  projection: { type: 'mercator' | 'equirectangular' }
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  layers: { land: boolean; coastline: boolean; rivers: boolean; lakes: boolean; countries: boolean }
  places: MapPlace[]
  routes: MapRoute[]
  style: { theme: 'archival' | 'clean' | 'ink' }
}
export interface MapRenderResp {
  path: string
  width: number
  height: number
  sha256: string
  task_id: number
  reused: boolean
  points: Array<{ id: string; name: string; at: [number, number] }>
  routes: Array<{ id: string; name: string; points: Array<[number, number]>; color: string }>
  context: { disclaimer: string; boundary_features: number; city_points: number; warnings: string[] }
}
export interface MapProposedPlace { name: string; lon: number; lat: number; source: string; proposed: true }

export type AssetPipelineKind = 'character' | 'scene' | 'prop'
export type AssetSourceRole = 'generation_reference' | 'shape_only' | 'rejected'
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
  suggestion: { action: 'pass' | 'revise' | 'rollback' | 'abort'; target_round_no: number | null; reason: string } | null
}
export interface AssetPipelineState {
  state: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  awaiting: { round_id: number; round_no: number } | null
  asset_kind: string
  asset_id: number
}
export interface AssetPipelineRunSummary {
  id: number
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
  purpose: 'precision' | 'beautify'
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
    mastra_run_id: string | null
    error: string | null
    result: { rollback_to: number | null; final_round_no: number | null } | null
  }
  spec: AssetSpecRow | null
  rounds: AssetPipelineRound[]
  /** 正在等人工审批的轮次（null = 不在等） */
  awaiting: { round_id: number; round_no: number } | null
  sources: AssetSourceRow[]
}
export interface AssetBaseCandidate {
  asset_kind: AssetPipelineKind
  asset_id: number
  asset_name: string
  version_task_id: number
  path: string
  width: number | null
  height: number | null
  verified: 'faithful' | 'gate_passed' | 'generated'
}

export const assetPipelineAPI = {
  /** source_ids 仅精确轮用：启动时人工选 1–3 张已入库参考图，后端冻结在任务参数里 */
  start: (data: { asset_kind: AssetPipelineKind; asset_id: number; episode_id: number; purpose?: 'precision' | 'beautify'; source_ids?: number[]; config_id?: number; model?: string; text_config_id?: number }) =>
    api.post<{ run_id: number; mastra_run_id: string }>('/asset-pipeline/runs', data),
  list: (assetKind: AssetPipelineKind, assetId: number) =>
    api.get<{ runs: AssetPipelineRunSummary[] }>(`/asset-pipeline/runs?asset_kind=${encodeURIComponent(assetKind)}&asset_id=${assetId}`),
  detail: (runId: number) => api.get<AssetPipelineRunDetail>(`/asset-pipeline/runs/${runId}`),
  approve: (runId: number, data: { round_id: number; verdict: 'approve' | 'revise' | 'rollback' | 'abort'; selected_violations?: string[]; notes?: string; opened: AssetPipelineOpenedImage[]; override_gate?: boolean; next_purpose?: 'precision' | 'beautify' }) =>
    api.post<{ status: string }>(`/asset-pipeline/runs/${runId}/approve`, data),
  cancel: (runId: number) => api.post<{ cancelled: boolean }>(`/asset-pipeline/runs/${runId}/cancel`),
  baseCandidates: (episodeId: number) => api.get<{ candidates: AssetBaseCandidate[] }>(`/asset-pipeline/episodes/${episodeId}/base-candidates`),
  listSources: (assetKind: AssetPipelineKind, assetId: number) =>
    api.get<{ sources: AssetSourceRow[] }>(`/asset-pipeline/assets/${assetKind}/${assetId}/sources`),
  addSource: (data: { asset_kind: AssetPipelineKind; asset_id: number; url?: string; local_path?: string; title?: string; artist?: string; license: string; role: AssetSourceRole; era?: string; why_excluded?: string }) =>
    api.post<{ source: AssetSourceRow }>('/asset-pipeline/asset-sources', data),
  /** multipart 上传：人工把本地原件直接入库，字段与 JSON 模式同名 */
  uploadSource: (fd: FormData) => formDataReq<{ source: AssetSourceRow }>('/asset-pipeline/asset-sources', fd),
  deleteSource: (sourceId: number) => api.del<{ deleted: boolean }>(`/asset-pipeline/asset-sources/${sourceId}`),
}

/** 资产审核清单（Issue #55）：纪录片「资产 · 审核清单」页签的全部接口 */
export type AssetReviewNeedKind = 'character' | 'scene' | 'prop' | 'prop_faithful' | 'exposition' | 'none'
export type AssetReviewItemStatus = 'missing' | 'have' | 'added' | 'ignored' | 'not_needed'
export interface AssetReviewItem {
  id: number
  segment_no: number
  info_point: string
  need_kind: AssetReviewNeedKind
  need_desc: string
  status: AssetReviewItemStatus
  asset_kind: 'character' | 'scene' | 'prop' | null
  asset_id: number | null
  asset_name: string | null
  semantic_id: string | null
  semantic_name: string | null
  semantics_needs_review: boolean
  reason: string | null
  decided_at: string | null
  extraction: { task_id: number; status: 'queued' | 'processing' } | null
}
export interface AssetReviewSegment {
  segment_no: number
  narration_excerpt: string
  counts: { total: number; missing: number; needs_review: number }
  items: AssetReviewItem[]
}
export interface AssetReviewPayload {
  status: 'none' | 'running' | 'pending' | 'passed'
  auto_segmented: boolean
  run: {
    task_id: number
    status: 'running' | 'done' | 'error'
    progress: { completed: number; failed: number; total: number } | null
    error: string | null
    diff: { kept: number; added: number; removed: number; changed_item_ids: number[] } | null
  } | null
  counts: Record<AssetReviewItemStatus | 'total', number>
  stale: { stale: boolean; reasons: string[] }
  segments: AssetReviewSegment[]
}
export interface AssetReviewItemPatch {
  status: AssetReviewItemStatus
  asset_kind?: 'character' | 'scene' | 'prop' | null
  asset_id?: number | null
  semantic_id?: string | null
  reason?: string | null
}

export interface AssetReviewBatchSkipped {
  item_id: number
  reason: string
  candidate?: { kind: 'character' | 'scene' | 'prop'; id: number; name: string }
}

export const assetReviewAPI = {
  get: (episodeId: number) => api.get<AssetReviewPayload>(`/episodes/${episodeId}/asset-review`),
  run: (episodeId: number, opts: { model?: string; configId?: number } = {}) =>
    api.post<{ started: boolean; task_id: number }>(`/episodes/${episodeId}/asset-review/run`, {
      model: opts.model || undefined,
      config_id: opts.configId || undefined,
    }),
  updateItem: (itemId: number, patch: AssetReviewItemPatch) => api.put<AssetReviewItem>(`/asset-review/items/${itemId}`, patch),
  extract: (itemId: number) => api.post<{ task_id: number | null; asset_name: string }>(`/asset-review/items/${itemId}/extract`),
  extractBatch: (episodeId: number, itemIds: number[]) =>
    api.post<{ queued: { item_id: number; task_id: number; asset_name: string; kind: string }[]; skipped: AssetReviewBatchSkipped[] }>(`/episodes/${episodeId}/asset-review/extract-batch`, { item_ids: itemIds }),
  createAssets: (episodeId: number, itemIds: number[]) =>
    api.post<{ created: { item_id: number; asset_kind: 'character' | 'scene' | 'prop'; asset_id: number; name: string }[]; skipped: AssetReviewBatchSkipped[] }>(`/episodes/${episodeId}/asset-review/create-assets`, { item_ids: itemIds }),
  batchStatus: (episodeId: number, itemIds: number[]) =>
    api.post<{ updated: number; skipped: AssetReviewBatchSkipped[] }>(`/episodes/${episodeId}/asset-review/batch-status`, { item_ids: itemIds, status: 'not_needed' }),
}

// 生成任务列表/详情（图片生成走各资产 API，视频生成走 storyboardAPI.generateVideo 与集级批量）
export const taskAPI = {
  // source='media-library' 时后端把 params 记为 { source:'media-library', copied_from }
  registerUpload: (assetType: 'character' | 'scene' | 'prop', assetId: number, localPath: string, copiedFrom?: string) =>
    api.post('/tasks/register-upload', {
      asset_type: assetType,
      asset_id: assetId,
      local_path: localPath,
      source: copiedFrom ? 'media-library' : undefined,
      copied_from: copiedFrom || undefined,
    }),
  get: (id: number) => api.get<TaskRow>(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  // 取消任务：qwen-jobs 调远端取消（排队中立即取消，运行中由服务端决定是否中断）
  cancel: (id: number) => api.post(`/tasks/${id}/cancel`),
  // 文本任务的思考内容（Issue #19）：tail 取尾部；offset+tail 翻看全文
  reasoning: (id: number, opts: { tail?: number; offset?: number } = {}) => {
    const query = new URLSearchParams()
    if (opts.offset != null) query.set('offset', String(opts.offset))
    query.set('tail', String(opts.tail ?? 4096))
    return api.get(`/tasks/${id}/reasoning?${query.toString()}`)
  },
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number; character_id?: number; scene_id?: number; prop_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    if (params?.character_id) query.set('character_id', String(params.character_id))
    if (params?.scene_id) query.set('scene_id', String(params.scene_id))
    if (params?.prop_id) query.set('prop_id', String(params.prop_id))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 任务中心列表（分页 + 筛选；批次作为可展开父行返回，子任务不在顶层重复）
  center: (params: { drama_id?: number; episode_id?: number; type?: string; status?: string; scope?: 'recent' | 'all'; page?: number; page_size?: number } = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    return api.get<{ items: CenterRow[]; total: number; page: number; page_size: number }>(`/tasks/center${query.size ? `?${query.toString()}` : ''}`)
  },
  // 全部活跃任务（含批次子任务与文本任务）+ 顶层进行中数量，供全局 store 轮询
  active: () => api.get<{ items: TaskRow[]; active_count: number }>('/tasks/active'),
  // 换模型重试：始终新建任务，返回新任务行
  retry: (id: number, data: { config_id?: number; model?: string } = {}) =>
    api.post<TaskRow>(`/tasks/${id}/retry`, { config_id: data.config_id || undefined, model: data.model || undefined }),
}

// 图片任务队列（qwen-jobs）：提交前的耗时预估。非 qwen-jobs 供应商返回 { supported: false }
export const imageQueueAPI = {
  estimate: (params: { config_id?: number; size?: string; references?: number; count?: number } = {}) => {
    const query = new URLSearchParams()
    if (params.config_id) query.set('config_id', String(params.config_id))
    if (params.size) query.set('size', params.size)
    if (params.references !== undefined) query.set('references', String(params.references))
    if (params.count) query.set('count', String(params.count))
    return api.get(`/image-queue/estimate${query.size ? `?${query.toString()}` : ''}`)
  },
}

// 视频任务耗时预估（#28）：墙钟 = 提交 → 完成，文案须称「预计完成/总耗时」
export const videoQueueAPI = {
  estimate: (params: { config_id?: number; model?: string; duration: number }) => {
    const query = new URLSearchParams()
    if (params.config_id) query.set('config_id', String(params.config_id))
    if (params.model) query.set('model', params.model)
    query.set('duration', String(params.duration))
    return api.get(`/video-queue/estimate?${query.toString()}`)
  },
}

async function uploadReq<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${apiBase()}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

/** multipart 自带 boundary：绝不能手工设 Content-Type，否则后端解析不出 field（见 uploadReq 同口径） */
async function formDataReq<T>(path: string, fd: FormData): Promise<T> {
  console.log(`%c[API] %cPOST %c${path} %cmultipart`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${apiBase()}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}

/** 素材管理器：按 项目 → 剧集 → 资产/分镜 → 版本/关键帧/参考图 浏览历史图片 */
export interface LibraryImage {
  path: string
  url: string
  thumb_url: string
  drama_id: number
  drama_title: string
  episode_ids: number[]
  kind: 'character' | 'scene' | 'prop' | 'storyboard'
  owner_id: number
  owner_name: string
  slot: 'first_frame' | 'mid_frame' | 'last_frame' | null
  source: 'version' | 'legacy' | 'reference'
  version_index: number | null
  generated_at: number | null
  provider: string | null
  model: string | null
  source_label: string
}

export interface LibraryTreeNode {
  id: number
  name: string
  kind: LibraryImage['kind']
  count: number
  slots?: Array<{ slot: 'first_frame' | 'mid_frame' | 'last_frame'; label: string; count: number }>
}

export interface LibraryTree {
  drama: { id: number; title: string; count: number }
  episodes: Array<{
    id: number
    episode_number: number
    title: string
    count: number
    characters: LibraryTreeNode[]
    scenes: LibraryTreeNode[]
    props: LibraryTreeNode[]
    storyboards: LibraryTreeNode[]
  }>
  unassigned: { count: number; characters: LibraryTreeNode[]; scenes: LibraryTreeNode[]; props: LibraryTreeNode[] }
}

export const mediaLibraryAPI = {
  dramas: () => api.get<{ items: Array<{ id: number; title: string; count: number }> }>('/media-library/dramas'),
  tree: (dramaId: number) => api.get<LibraryTree>(`/media-library/tree?drama_id=${dramaId}`),
  images: (params: { drama_id?: number; episode_id?: number | 'unassigned'; kind?: string; owner_id?: number; slot?: string; page?: number; page_size?: number } = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    return api.get<{ items: LibraryImage[]; total: number; page: number; page_size: number }>(`/media-library/images${query.size ? `?${query.toString()}` : ''}`)
  },
  // 复制库内图片为一次「新上传」，返回结构与 uploadAPI.image 一致（多带源图路径）
  copy: (url: string) => api.post<{ url: string; path: string; copied_from: string }>('/media-library/copy', { url }),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[], poster?: { versionId: number; duration: number }) => api.post(`/merge/episodes/${epId}/merge`, {
    ...(storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
    ...(poster?.versionId ? { poster_version_id: poster.versionId, poster_duration: poster.duration } : {}),
  }),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
  // 删除成片：软删记录 + 删除磁盘文件；返回回退后的 episodes.video_url
  del: (epId: number, mergeId: number) =>
    api.del<{ id: number; deleted: boolean; episode_video_url: string | null }>(`/merge/episodes/${epId}/merges/${mergeId}`),
}
export const posterAPI = {
  get: (epId: number) => api.get(`/episodes/${epId}/poster`),
  save: (epId: number, data: Record<string, unknown>) => api.put(`/episodes/${epId}/poster`, data),
  generate: (epId: number, data: Record<string, unknown>) => api.post(`/episodes/${epId}/poster/generate`, data),
  concept: (epId: number, data: Record<string, unknown>) => api.post(`/episodes/${epId}/poster/concept`, data),
  conceptGenerate: (epId: number, data: Record<string, unknown>) => api.post(`/episodes/${epId}/poster/concept/generate`, data),
  applyConcept: (epId: number, data: Record<string, unknown>) => api.post(`/episodes/${epId}/poster/concept/apply`, data),
  applyLayerPlan: (epId: number, data: Record<string, unknown>) => api.post(`/episodes/${epId}/poster/concept/apply-layer-plan`, data),
  registerVersion: (epId: number, data: Record<string, unknown>) => api.post(`/episodes/${epId}/poster/versions`, data),
  selectVersion: (epId: number, versionId: number) => api.put(`/episodes/${epId}/poster/select`, { version_id: versionId }),
  loadVersion: (epId: number, versionId: number) => api.post(`/episodes/${epId}/poster/load-version`, { version_id: versionId }),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  resume: (id: number) => api.post(`/ai-configs/${id}/resume`, {}),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  // TTS 音色列表（#35）：设置页据此让人选音色，程序不自动取第一个
  ttsVoices: (params: { config_id?: number; base_url?: string; api_key?: string }) => {
    const q = new URLSearchParams()
    if (params.config_id) q.set('config_id', String(params.config_id))
    if (params.base_url) q.set('base_url', params.base_url)
    if (params.api_key) q.set('api_key', params.api_key)
    return api.get<{ voices: string[] }>(`/ai-configs/tts-voices?${q.toString()}`)
  },
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

// ===== 图层段（#58）：一镜至多一段图层文档 + 时间线 → 同步渲染出 mp4 =====
export interface SegmentSpec { width: number; height: number; fps: number; source: 'video' | 'default' }
export interface SegmentViewport { x: number; y: number; w: number; h: number }
export interface SegmentKeyframe {
  t: number
  viewport: SegmentViewport
  visible: string[]
  /** 逐帧覆盖：本帧到下一帧的插值缓动 */
  ease?: 'linear' | 'inout'
  /** 逐帧覆盖：到达本帧时的淡入淡出时长 */
  fade_ms?: number
}
export interface SegmentTimeline { fps: number; ease: 'linear' | 'inout'; fade_ms: number; keyframes: SegmentKeyframe[] }
export interface LayerSegmentIssue {
  code: 'missing_base' | 'card_subtitle_overlap' | 'must_mark_not_marked' | 'reference_not_mentioned' | 'budget_mismatch'
  severity: 'warn' | 'block'
  message: string
  [key: string]: unknown
}
export interface LayerSegment {
  id: number
  storyboard_id: number
  layer_doc: Record<string, any>
  timeline: SegmentTimeline
  duration: number
  /** 派生只读 = duration − 末帧 t */
  end_hold: number
  base_ref: Record<string, any> | null
  quality_warnings: Array<Record<string, any>>
  render_path: string | null
  render_signature: string | null
  rendered_at: string | null
  junction_path: string | null
  junction_hash: string | null
  status: 'draft' | 'rendering' | 'ready' | 'failed'
  stale_reasons: string[]
  /** 已渲染且仍对得上当前图层/时间线/规格；false = 需要重新渲染 */
  fresh: boolean
}
export interface LayerSegmentJunction {
  source: 'layer_last' | 'layer_first' | null
  t: number
  path: string | null
  hash: string | null
  stale: boolean
}
export interface LayerSegmentState {
  spec: SegmentSpec
  combo: 'A' | 'B' | 'C' | 'D' | null
  design_card_status: string
  production_unlocked: boolean
  gate_reason: string | null
  segment: LayerSegment | null
  junction: LayerSegmentJunction
  issues: LayerSegmentIssue[]
}

export const layerSegmentAPI = {
  get: (storyboardId: number) =>
    api.get<LayerSegmentState>(`/layer-segments/storyboards/${storyboardId}`),
  save: (
    storyboardId: number,
    data: { layer_doc?: unknown; timeline?: unknown; duration?: number; base_ref?: unknown },
  ) => api.put<LayerSegmentState>(`/layer-segments/storyboards/${storyboardId}`, data),
  del: (storyboardId: number) => api.del<{ deleted: boolean }>(`/layer-segments/storyboards/${storyboardId}`),
  // 由设计卡 layer_plan 生成草稿并落库
  draft: (storyboardId: number) =>
    api.post<LayerSegmentState>(`/layer-segments/storyboards/${storyboardId}/draft`),
  // 同步渲染：30 秒段数秒返回；keyframes_invalidated = 衔接帧变了，本镜关键帧确认作废
  render: (storyboardId: number) =>
    api.post<{
      task_id: number
      spec: SegmentSpec
      segment: LayerSegment | null
      junction: LayerSegmentJunction
      keyframes_invalidated: boolean
    }>(`/layer-segments/storyboards/${storyboardId}/render`),
  // 帧缩略图/衔接帧都是 PNG 字节流，直接当 <img src> 用（后端 no-store，带 cache buster）
  thumbnailUrl: (storyboardId: number, which: 'first' | 'last' | `frame-${number}`, bust = 0) =>
    `${apiBase()}/layer-segments/storyboards/${storyboardId}/thumbnail/${which}${bust ? `?v=${bust}` : ''}`,
  junctionUrl: (storyboardId: number, bust: string | number = 0) =>
    `${apiBase()}/layer-segments/storyboards/${storyboardId}/junction${bust ? `?v=${bust}` : ''}`,
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

// ===== 分阶段改写（#70，纪录片）：运行是可变执行状态，版本是不可变文本 =====
/** 后端静态阶段注册表里的 AI 阶段；输入准备（prepared_source）不是 AI 阶段，不在其中 */
export type RewriteStageKey = 'fidelity' | 'bridge'
export type RewriteStageStatus = 'pending' | 'processing' | 'completed' | 'skipped' | 'failed'
export type RewriteRunStatus = 'queued' | 'processing' | 'completed' | 'failed'
/** 采用状态：pending=候选待采用，adopted=已写入最终稿，conflict=期间最终稿/原文被改，manual=本次运行只留候选 */
export type RewriteAdoptionStatus = 'pending' | 'adopted' | 'conflict' | 'manual'
/** 版本来源阶段：原文快照 / 过滤后正文 / 两个 AI 阶段 / 人工保存 */
export type RewriteVersionStage = 'source_snapshot' | 'prepared_source' | RewriteStageKey | 'manual'

export interface RewriteRunStage {
  key: RewriteStageKey
  status: RewriteStageStatus
  version_id?: number | null
  error?: string | null
}

export interface RewriteRun {
  id: number
  task_id: number | null
  status: RewriteRunStatus
  current_stage: RewriteStageKey | null
  stage_plan: Array<RewriteStageDef & { skipped: boolean }>
  source_revision: string | number
  base_final_revision: string | number
  adoption_status: RewriteAdoptionStatus
  auto_adopt: boolean
  candidate_version_id: number | null
  /** 本次运行冻结的原文快照与过滤后正文（必定存在，过滤不可跳过） */
  source_version_id: number | null
  prepared_version_id: number | null
  error: string | null
  created_at: string
  stages: RewriteRunStage[]
}

/** 输入准备报告：逐条「删了哪一段、属于哪类、为什么」，start/end 是原始资料里的字符区间 */
export type RemovedCategory =
  | 'source_link' | 'license' | 'contributor' | 'usage_note' | 'non_narration_note' | 'metadata_field'
export interface RewriteRemovedSpan {
  start: number
  end: number
  text: string
  category: RemovedCategory | string
  reason: string
}
export interface RewritePreparedReport {
  removed: RewriteRemovedSpan[]
  kept_notes?: string[]
  raw_chars?: number
  prepared_chars?: number
}

/** 忠实改写报告：±5% 基线按「过滤后正文」计，正文超限段单列 */
export interface RewriteFidelityReport {
  baseline_chars?: number
  output_chars?: number
  delta_ratio?: number
  within_tolerance?: boolean
  paragraphs?: number
  over_limit_paragraphs?: Array<{ index: number; chars: number }>
  warnings?: string[]
  post_filter?: { removed: RewriteRemovedSpan[] }
}

/** 桥句决策：no_bridge / inserted / needed_but_unsafe 三分，弃答绝不记成「无需补写」 */
export type BridgeDecision = 'no_bridge' | 'inserted' | 'needed_but_unsafe'
export type BridgePlacement = 'end_of_left' | 'start_of_right' | 'standalone'
export type BridgeAttribution = 'previous_tail' | 'next_head' | 'standalone'
export interface RewriteBridgeBoundary {
  boundary_id: string | number
  left_paragraph?: string
  right_paragraph?: string
  relation?: string
  decision: BridgeDecision
  reason?: string
  bridge_text: string | null
  placement: BridgePlacement | null
  shot_attribution: BridgeAttribution | null
  spoken_chars: number | null
  placement_adjusted?: boolean
}
export interface RewriteBridgeReport {
  decisions: RewriteBridgeBoundary[]
  inserted_count?: number
  needed_but_unsafe_count?: number
  boundary_count?: number
  warnings?: string[]
}

/** 跳过版：真实副本 + 跳过留痕，没有模型调用 */
export interface RewriteSkipReport { skipped: true; copied_from_version_id: number | null }

export type RewriteReport =
  | RewritePreparedReport | RewriteFidelityReport | RewriteBridgeReport | RewriteSkipReport | null

export type RewriteVersionSource = 'source_snapshot' | 'prepared_source' | 'agent' | 'skip_copy' | 'manual'

export interface RewriteVersion {
  id: number
  run_id: number | null
  stage_key: RewriteVersionStage
  stage_index: number | null
  source: RewriteVersionSource
  predecessor_id: number | null
  content: string
  content_hash?: string
  task_id?: number | null
  report: RewriteReport
  created_at: string
}

export interface RewriteStageDef {
  key: RewriteStageKey
  label: string
  revision: string
}

export interface ScriptRewriteState {
  runs: RewriteRun[]
  versions: RewriteVersion[]
  current_run: RewriteRun | null
  current_final_version_id: number | null
  source_revision: string | number
  final_revision: string | number
  stages: RewriteStageDef[]
}

export interface ScriptRewriteStartBody {
  start_stage?: RewriteStageKey
  predecessor_version_id?: number
  skip_stages?: RewriteStageKey[]
  config_id?: number
  model?: string
  auto_adopt?: boolean
  source_revision?: string | number
  final_revision?: string | number
  /** 前驱属于更早的原文快照时，后端先 409 source_changed，确认后带此标志重发 */
  acknowledge_source_change?: boolean
}

/** sys_task(kind='script_rewrite').params.rewrite：阶段进度的唯一来源（任务中心共用） */
export interface RewriteTaskProgress {
  run_id: number
  stage_key: RewriteStageKey | 'prepare'
  stage_index: number
  stage_total: number
  stages: RewriteRunStage[]
}

/** 后端错误体：所有 HTTP status 与 code 一致 */
export type RewriteErrorCode =
  | 'run_active' | 'revision_conflict' | 'source_changed' | 'prepared_source_empty'
  | 'not_documentary' | 'no_source' | 'predecessor_required' | 'invalid_predecessor' | 'invalid_stage'
export interface RewriteErrorInfo { error: RewriteErrorCode; body: Record<string, unknown> }
export function rewriteErrorOf(err: unknown): RewriteErrorInfo | null {
  const body = (err as ApiError)?.body as { error?: string } | undefined
  if (!body?.error) return null
  return { error: body.error as RewriteErrorCode, body: body as Record<string, unknown> }
}

export const scriptRewriteAPI = {
  state: (episodeId: number) => api.get<ScriptRewriteState>(`/episodes/${episodeId}/script-rewrite`),
  start: (episodeId: number, body: ScriptRewriteStartBody = {}) =>
    api.post<{ run_id: number; task_id: number }>(`/episodes/${episodeId}/script-rewrite`, body),
  /** 运行期间进入编辑前必须先落盘「本次不自动采用」，再放行输入 */
  manual: (episodeId: number, runId: number) =>
    api.post<{ run_id: number; auto_adopt: false }>(`/episodes/${episodeId}/script-rewrite/runs/${runId}/manual`),
  /** 显式采用某个版本（含历史版本）；修订不符时后端 409，绝不自动合并 */
  adopt: (episodeId: number, versionId: number, body: { source_revision: string | number; final_revision: string | number }) =>
    api.post<ScriptRewriteState & { adopted_version_id: number; changed: boolean }>(
      `/episodes/${episodeId}/script-rewrite/versions/${versionId}/adopt`, body),
  /** 人工保存最终稿：条件写入 + 产生一个人工版本；字节未变时 changed=false 且不推进修订 */
  saveFinal: (
    episodeId: number,
    body: { content: string; final_revision: string | number; source_revision?: string | number },
  ) => api.put<{ final_revision: string; source_revision: string; version_id: number; changed: boolean }>(
    `/episodes/${episodeId}/script-rewrite/final`, body),
}

// ===== 旁白骨架（#70）：最终稿 → 逐镜骨架 → 确认 → 批量配音 → 实测时长设计卡 =====
/** 配音有效性：按当前旁白 hash + 生效参数 + 实测时长判定，旧元数据一律不采信 */
export type TtsInvalidReason =
  | 'narration_disabled' | 'narration_empty' | 'narration_too_long' | 'markup_invalid'
  | 'audio_missing' | 'text_changed' | 'voice_params_changed' | 'audio_file_missing' | 'duration_invalid'
export interface SkeletonShotTts {
  valid: boolean
  reason: TtsInvalidReason | null
  /** 后端已本地化的原因文本；未知 reason 时作为兜底展示 */
  message?: string | null
  duration_ms: number | null
}
export interface NarrationSkeletonShot {
  storyboard_id: number
  storyboard_number: number
  narration_text: string
  narration_chars: number
  title: string | null
  tts: SkeletonShotTts
  design_card_status: DesignCardStatus
  /** 设计卡已确认且配音有效 */
  design_ready: boolean
  /** 配音有效，现在就能填/确认设计卡 */
  design_fillable: boolean
  blocked_reason: string | null
}
export interface NarrationSkeletonCoverage {
  script_chars: number
  covered_chars: number
  uncovered_chars: number
  gaps: Array<{ start: number; end: number; text: string }>
  complete: boolean
}
export interface NarrationSkeletonState {
  episode_id: number
  project_type: 'documentary' | 'drama'
  /** 剧情项目恒 false：骨架流程只属于纪录片，其余字段为空 */
  enabled: boolean
  confirmed: boolean
  revision: string
  confirmed_revision: string | null
  script_confirmed: boolean
  confirmable: boolean
  blocked_reason: string | null
  coverage: NarrationSkeletonCoverage | null
  tts: { valid: number; invalid: number; total: number }
  shots: NarrationSkeletonShot[]
  task_id?: number
}
/** 逐镜写入：id 缺省 = 新镜（拆分），少写某个 id = 删除该镜（合并）；顺序即最终顺序 */
export interface NarrationSkeletonShotInput {
  id?: number
  narration_text: string
  title?: string | null
}

/** PUT 校验失败的 400 体（problems 指向第几条、错在哪） */
export type SkeletonProblemCode =
  | 'empty' | 'too_long' | 'not_verbatim' | 'out_of_order' | 'overlap' | 'gap'
  | 'unknown_id' | 'duplicate_id' | 'script_missing' | 'card_busy'
export interface SkeletonProblem { index: number; code: SkeletonProblemCode; message: string }
export function skeletonProblemsOf(err: unknown): SkeletonProblem[] | null {
  const body = (err as ApiError)?.body as { error?: string; problems?: SkeletonProblem[] } | undefined
  if (!body || body.error !== 'skeleton_invalid') return null
  return Array.isArray(body.problems) ? body.problems : []
}

export const narrationSkeletonAPI = {
  state: (episodeId: number) => api.get<NarrationSkeletonState>(`/episodes/${episodeId}/narration-skeleton`),
  generate: (episodeId: number, data: { model?: string; config_id?: number } = {}) =>
    api.post<NarrationSkeletonState & { task_id: number }>(`/episodes/${episodeId}/narration-skeleton/generate`, {
      model: data.model || undefined,
      config_id: data.config_id || undefined,
    }),
  confirm: (episodeId: number, revision: string) =>
    api.post<NarrationSkeletonState>(`/episodes/${episodeId}/narration-skeleton/confirm`, { revision }),
  unconfirm: (episodeId: number) =>
    api.post<NarrationSkeletonState>(`/episodes/${episodeId}/narration-skeleton/unconfirm`),
  save: (episodeId: number, revision: string, shots: NarrationSkeletonShotInput[]) =>
    api.put<NarrationSkeletonState>(`/episodes/${episodeId}/narration-skeleton`, { revision, shots }),
}
export interface TtsRequiredBlock { storyboard_id: number; storyboard_number?: number; reason: TtsInvalidReason | string; message?: string }
export function ttsRequiredOf(err: unknown): TtsRequiredBlock[] | null {
  const body = (err as ApiError)?.body as { error?: string; blocked?: TtsRequiredBlock[] } | undefined
  if (body?.error !== 'tts_required') return null
  return Array.isArray(body.blocked) ? body.blocked : []
}
// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
