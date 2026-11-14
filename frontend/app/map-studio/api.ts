/**
 * 地图工作室（Map Studio，Issue #99）自有 API 客户端。
 *
 * 模块不得 import 火宝业务代码（composables/useApi.ts、任务中心、剧集/资产服务…），
 * 所以这里自带一层最小请求封装：只依赖 `utils/url.ts` 的 `apiBase()`。
 *
 * 口径与后端 `/api/v1/map-studio` 一致（snake_case）：
 * - 成功体 `{ code: 200, data: <below>, message }`，这里拆出 `data`；
 * - 失败体 `{ code, error, message, ... }`，原样挂在 `MapStudioApiError.body` 上，
 *   409 带 `revision`/`run_id`，400 校验带 `problems[]`，调用方按字段渲染。
 * 时间：任务/运行行是 ISO 字符串，观测行（task_observed_*）是毫秒时间戳；
 * model_ms / queue_ms / work_ms / wall_ms 是服务端事实，前端不重算、不猜。
 */

import { apiBase } from '~/utils/url'

export interface MapStudioApiError extends Error {
  status?: number
  body?: Record<string, unknown>
}

function endpoint(path: string): string {
  return `${apiBase()}/map-studio${path}`
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const resp = await fetch(endpoint(path), init)
  let json: Record<string, unknown> = {}
  try {
    json = await resp.json() as Record<string, unknown>
  } catch {
    json = {}
  }
  const code = Number(json.code)
  if (!resp.ok || (Number.isFinite(code) && code >= 400)) {
    const err: MapStudioApiError = new Error(String(json.message || resp.status))
    err.status = resp.status
    err.body = json
    throw err
  }
  return (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json) as T
}

/* ===== 需求 / 几何（与后端 MapBrief / MapSpec 逐字段一致） ===== */

export type MapStudioStage = 'brief' | 'research' | 'base' | 'style' | 'drawing' | 'complete'
export type MapStudioStatus = 'idle' | 'running' | 'awaiting_review' | 'blocked' | 'failed' | 'completed'
export type MapBaseMode = 'program' | 'earth' | 'image'
export type MapStyleTheme = 'archival' | 'clean' | 'ink'

export interface MapControlPoint { x: number; y: number; lon: number; lat: number }
export interface MapReferenceImage {
  path: string
  source_url: string
  license: string
  control_points: MapControlPoint[]
}
export interface MapBriefInference {
  field: string
  value: string
  basis: string
  confidence: 'high' | 'medium' | 'low'
}
export interface MapBrief {
  subject: string
  era: string
  location: string
  purpose: string
  detail_level: 'overview' | 'regional' | 'site'
  schematic: boolean
  base_mode: MapBaseMode
  style: MapStyleTheme
  /** null follows module settings; absent preserves a legacy archival/clean/ink brief. */
  map_style?: string | null
  notes: string
  reference_image: MapReferenceImage | null
  inferred: MapBriefInference[]
}

/** Issue #99 阶段 ②：要素的类别、几何来源、核验结论与相对位置证据（后端原样存进 map_spec） */
export type MapFeatureCategory = 'river' | 'lake' | 'coast' | 'mountain' | 'settlement' | 'route' | 'territory' | 'other'
export type MapFeatureOrigin = 'dataset' | 'source' | 'model' | 'manual'
export type MapVerificationStatus = 'verified' | 'unverified' | 'conflict' | 'needs_user' | 'confirmed'
export interface MapVerification { status: MapVerificationStatus, reasons: string[] }
export interface MapDatasetReference { ref: string, clip_bbox?: [number, number, number, number] }
export type MapRelationKind = 'distance_km' | 'east_of' | 'west_of' | 'north_of' | 'south_of' | 'near_river'
/** 声明的相对位置证据 + 服务端按坐标算出的结果（computed/message 缺省时按「未计算」显示，不猜） */
export interface MapRelation {
  id: string
  subject: string
  object: string
  relation: MapRelationKind
  value_km?: number
  tolerance_km?: number
  excerpt: string
  source_id: string
  computed?: { value_km?: number, consistent: boolean }
  message?: string
}

/** 所有几何条目共有的阶段 ② 元数据；缺省即「未标注」，绝不按 AI 候选脑补来源 */
export interface MapFeatureMetadata {
  category?: MapFeatureCategory
  origin?: MapFeatureOrigin
  verification?: MapVerification
  dataset_ref?: MapDatasetReference
  relations?: MapRelation[]
}

export interface MapPlace extends MapFeatureMetadata { id: string; name: string; lon: number; lat: number; proposed?: boolean }
export interface MapRoute extends MapFeatureMetadata { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
/** 面要素：首尾由后端自动闭合，前端按开放环编辑 */
export interface MapRegion extends MapFeatureMetadata { id: string; name: string; points: Array<[number, number]>; proposed?: boolean }
export interface MapSpec {
  version: 1
  projection: { type: 'mercator' | 'equirectangular' }
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  /**
   * 制图细节级别（阶段 ②）：决定底图河道取 10m 还是 50m，以及取景精度。
   * 保存几何时原样带回；缺省就是真的没有这个字段，不补默认值。
   */
  detail_level?: 'overview' | 'regional' | 'site'
  layers: { land: boolean; coastline: boolean; rivers: boolean; lakes: boolean; countries: boolean }
  places: MapPlace[]
  routes: MapRoute[]
  regions: MapRegion[]
  style: { theme: MapStyleTheme; map_style?: string }
}

/* ===== 详情 ===== */

export interface MapStudioStep {
  id: MapStudioStage
  label: string
  status: 'pending' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'skipped'
  message: string | null
  started_at: string | null
  finished_at: string | null
}
/** 输入充分性问题：blocking=true 时后端拒绝推进，message 必须直接显示给人看 */
export interface MapStudioIssue { field: string; code: string; message: string; blocking: boolean }

export interface MapResearchSource {
  adapter: string
  title: string
  url: string | null
  institution: string
  date: string
  license: string
  tier: 'A' | 'B'
  excerpt: string
}
export interface MapResearchFeature extends MapFeatureMetadata {
  /** 服务端要素 id（`features[i]` 之外的稳定引用） */
  id?: string
  kind: 'place' | 'route' | 'region'
  name: string
  lon?: number
  lat?: number
  points?: Array<[number, number]>
  /** 数据集折线不连通时保留多段；并入 map_spec 时拆成 `name (i/N)` 的同前缀条目 */
  parts?: Array<Array<[number, number]>>
  dataset_missing?: { queries: string[], reason: string }
  source_url: string | null
  source_title: string
  uncertainty: 'high' | 'medium' | 'low'
  basis: string
  coordinate_basis?: string
  supporting_excerpt?: string
  excerpt_verified?: boolean
  approximate?: boolean
}
export interface MapDatasetQuery { layer: string, query: string, bbox?: [number, number, number, number], hits: number, refs: string[] }
export interface MapResearch {
  queries: Array<{ adapter: string; query: string; hits: number; error: string | null }>
  /** 本阶段 search_dataset 的登记（服务端核对 dataset_missing 用）；老记录没有这个字段 */
  dataset_queries?: MapDatasetQuery[]
  /** 该图的空间范围 [west, south, east, north]；阶段 ② 起必填 */
  extent?: [number, number, number, number]
  /** 本次提交的相对位置证据及服务端按坐标算出的结论 */
  relations?: MapRelation[]
  sources: MapResearchSource[]
  features: MapResearchFeature[]
  uncertainties: string[]
  notes: string[]
  searched_at: string
}

/** path 是 STORAGE_ROOT 相对路径（与 prop.image_url 同口径），显示前过 mediaUrl() */
export interface MapImageRef {
  path: string
  width: number
  height: number
  source: string
  /** 产出它的那次运行（旧字段名 task_id 已改为 run_id） */
  run_id: number | null
  provenance: Record<string, unknown> | null
}
/**
 * 阶段 ③：线面渲染平滑参数，键是图层 id（绘制前是要素 id），`smooth: 0` 关闭、`0 < s <= 1` 是强度。
 * 只改渲染副本，不改存储的控制点；老记录没有这个字段，缺省按要素默认值计算。
 */
export type MapLayerSmoothing = Record<string, { smooth: number }>

export interface MapStudioOutputs {
  base_image: MapImageRef | null
  texture_image: MapImageRef | null
  final_image: MapImageRef | null
  kmz: { path: string; provenance: Record<string, unknown> } | null
  layer_doc: Record<string, unknown> | null
  layer_options?: MapLayerSmoothing
}

/** 严格校验 / 标签检查逐条问题：label_* 与 smoothing_* 带图层 id，其余按字段路径定位 */
export interface MapLayerProblem {
  path: string
  message: string
  layer_id?: string
  code?: string
}

/** 只读检查与自动排布的回执；两者都不保存草稿、不消耗模型轮次 */
export interface MapLayerCheck { problems: MapLayerProblem[] }
export interface MapLayerAutoLayout {
  layer_doc: Record<string, unknown>
  layer_options: MapLayerSmoothing
  unresolved: Array<{ layer_id: string; message: string }>
  problems: MapLayerProblem[]
}

export interface MapStudioHistoryEntry {
  revision: number
  at: string
  stage: string
  status: string
  action: string
  actor: 'auto' | 'manual' | 'system'
  note: string | null
}

/** 模型阶段每轮交付的结论；rollback 另记目标阶段 */
export type MapAgentOutcome = 'accepted' | 'rejected' | 'no_delivery' | 'error' | 'rollback' | 'infra_retry'
export interface MapAgentAttempt {
  /** 所属运行 id（服务端在 run 容器里记录的 run id） */
  run_id: number
  stage: MapStudioStage
  round: number
  outcome: MapAgentOutcome
  /** 已脱敏的中文原因，直接展示，禁止 v-html */
  problems: string[]
  target_stage?: string
  at: string
}
/**
 * 模型工具循环的轮次账本：计数属于一次运行（run_id），新运行重新计数，
 * attempts 保留历史（服务端封顶）。
 */
export interface MapAgentState {
  run_id: number | null
  rounds: Partial<Record<'brief' | 'research' | 'base' | 'drawing', number>>
  rollbacks: number
  /** 上限由契约固定（3 轮 / 2 次回退）；服务端没回传时前端按常量显示，不编造别的数字 */
  max_rounds?: number
  max_rollbacks?: number
  attempts: MapAgentAttempt[]
}

/** 火宝侧宿主目标：target 为 null = 目标已删除/不再是地图，UI 只读提示 */
export interface MapStudioHostTarget {
  title: string
  subtitle: string | null
  /** 火宝内的 SPA 路径（不含 baseURL 前缀），如 /drama/20/episode/1?panel=assets */
  return_path: string | null
}
export interface MapStudioHostRef {
  id: string
  ref: string
  target: MapStudioHostTarget | null
  error: string | null
}

export interface MapStudioDeliveryRow {
  id: number
  at: string
  run_id: number | null
  host: string | null
  host_ref: string | null
  final_sha256: string
  version_ids: number[]
  message: string
}

export interface MapStudioLatestRun {
  id: number
  stage: MapStudioStage
  status: MapStudioRunStatus
  mode: 'auto' | 'manual'
  created_at: string
  finished_at: string | null
  error_msg: string | null
}
export interface MapStudioRunsSummary {
  latest: MapStudioLatestRun | null
  count: number
}

export interface MapStudioDetail {
  task_id: number
  title: string
  host: MapStudioHostRef | null
  stage: MapStudioStage
  status: MapStudioStatus
  mode: 'auto' | 'manual'
  revision: number
  busy: boolean
  /** 最新一次运行容器 id（旧 state.task_id） */
  run_id: number | null
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  error: string | null
  updated_at: string | null
  brief: MapBrief
  steps: MapStudioStep[]
  issues: MapStudioIssue[]
  research: MapResearch | null
  map_spec: MapSpec | null
  outputs: MapStudioOutputs
  history: MapStudioHistoryEntry[]
  agent: MapAgentState
  deliveries: MapStudioDeliveryRow[]
  runs_summary: MapStudioRunsSummary
}

export interface MapStudioRunOptions {
  mode: 'auto' | 'manual'
  text_config_id?: number
  image_config_id?: number
  image_model?: string
  expected_revision?: number
}

/* ===== 运行 / 观测（#87 口径，scope='map_studio'） ===== */

export type MapStudioRunStatus = 'processing' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface MapStudioRun {
  id: number
  mode: 'auto' | 'manual'
  start_stage: MapStudioStage
  stage: MapStudioStage
  status: MapStudioRunStatus
  error_msg: string | null
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  /** ISO；running 时 finished_at/wall_ms 为 null，UI 用本地时钟补「已用」但不冒充服务端事实 */
  started_at: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
  wall_ms: number | null
  model_ms: number
  queue_ms: number
  work_ms: number
  call_count: number
  observed_work_ids?: number[]
}

export interface MapStudioRunObserved {
  run: Omit<MapStudioRun, 'observed_work_ids'>
  works: ObservedWorkRow[]
  calls: ObservedCallRow[]
  next_work_cursor: number | null
  next_call_cursor: number | null
  has_more_works: boolean
  has_more_calls: boolean
}

export interface ObservedWorkRow {
  id: number
  task_id: number
  stage: string
  status: 'processing' | 'completed' | 'failed' | 'interrupted'
  source_chars: number
  sample_key: string
  storyboard_id: number | null
  storyboard_number: number | null
  started_at: number
  finished_at: number | null
  model_ms: number
  queue_ms: number
  work_ms: number
  call_count: number
  heartbeat_at: number
  error_msg: string | null
  created_at: number
  active_call_started_at: number | null
  active_call_heartbeat_at: number | null
}

export type ObservedCallKind = 'llm' | 'vision_chat' | 'tts'

export interface ObservedCallRow {
  id: number
  work_id: number
  task_id: number
  kind: ObservedCallKind
  config_id: number | null
  config_name: string | null
  provider: string | null
  model: string | null
  url: string | null
  stream: number
  status: 'processing' | 'completed' | 'failed' | 'interrupted'
  http_status: number | null
  queued_at: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  queue_ms: number
  request_chars: number
  response_chars: number
  prompt_tokens: number | null
  completion_tokens: number | null
  finish_reason: string | null
  error_msg: string | null
  message_count: number
  heartbeat_at?: number | null
  created_at?: number
  /**
   * 阶段归属：调用 started_at 落在哪个阶段跨度内；没有任何跨度覆盖时为 null
   * （不按阶段顺序猜，也不把无归属的调用塞给当前阶段）。
   */
  stage: MapStudioStage | null
}

export interface ObservedMessageRow {
  id: number
  call_id: number
  work_id: number
  task_id: number
  seq: number
  phase: 'request' | 'response' | 'final'
  role: string
  name: string | null
  tool_call_id: string | null
  /** 公开正文（工具定义 / 工具参数与结果 / 模型公开文本）：纯文本渲染，禁止 v-html */
  body: string
  chars: number
  streaming: number
  created_at: number
}

export interface MapStudioCallMessages {
  call: ObservedCallRow
  total: number
  messages: ObservedMessageRow[]
  next_cursor: number | null
  has_more: boolean
}

/* ===== 设置 / 模型 / 列表 ===== */

export interface MapStudioModelOptionText { config_id: number; name: string; models: string[]; vision: boolean }
export interface MapStudioModelOptionImage { config_id: number; name: string; models: string[] }
export interface MapStudioModelOptions {
  text: MapStudioModelOptionText[]
  image: MapStudioModelOptionImage[]
}

export type ResearchKeyId = 'europeana' | 'smithsonian'
export interface MapStudioResearchKey {
  id: ResearchKeyId
  label: string
  configured: boolean
  /** 只给末 4 位（短于 12 位不给），永不返回完整 key */
  last4: string | null
}
export interface MapStudioSettingsModels {
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
}
export interface MapStudioStyleFamily {
  id: string
  name: string
  purpose: string
  theme_mapping: MapStyleTheme
  palette: Record<string, string>
  preview: string
  reference: { title: string; license: string; source: string }
}
export interface MapStudioStyles { default_style: string; families: MapStudioStyleFamily[] }
export interface MapStudioSettings {
  research_keys: MapStudioResearchKey[]
  models: MapStudioSettingsModels
  default_style: string
}

export interface MapStudioTaskListItem {
  id: number
  title: string
  host: string | null
  host_ref: string | null
  stage: MapStudioStage
  status: MapStudioStatus
  updated_at: string
  final_image: { path: string; width: number; height: number } | null
}

export type MapStudioDownloadKind = 'final' | 'semantics' | 'kmz' | 'source'

/* ===== 客户端 ===== */

export const mapStudioAPI = {
  /** host omitted = all; host='' = standalone. */
  listTasks: (params: { host?: string, q?: string } = {}) => {
    const query = new URLSearchParams()
    if (params.host !== undefined) query.set('host', params.host)
    if (params.q) query.set('q', params.q)
    return request<{ tasks: MapStudioTaskListItem[] }>('GET', `/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  createTask: (data: { title: string, brief?: Partial<MapBrief> }) => request<MapStudioDetail>('POST', '/tasks', data),
  get: (taskId: number) => request<MapStudioDetail>('GET', `/tasks/${taskId}`),
  /** brief 按字段合并，map_spec 整份替换；layer_options 与几何同一次 CAS 提交，纯几何修改保留底图/纹理只重绘 */
  save: (taskId: number, data: { expected_revision?: number, brief?: Partial<MapBrief>, map_spec?: MapSpec, layer_options?: MapLayerSmoothing }) =>
    request<MapStudioDetail>('PUT', `/tasks/${taskId}`, data),
  run: (taskId: number, options: MapStudioRunOptions) => request<MapStudioDetail>('POST', `/tasks/${taskId}/run`, options),
  advance: (taskId: number, options: Omit<MapStudioRunOptions, 'mode'> = {}) =>
    request<MapStudioDetail>('POST', `/tasks/${taskId}/advance`, options),
  rollback: (taskId: number, stage: MapStudioStage, expectedRevision?: number) =>
    request<MapStudioDetail>('POST', `/tasks/${taskId}/rollback`, { stage, expected_revision: expectedRevision }),
  cancel: (taskId: number) => request<MapStudioDetail>('POST', `/tasks/${taskId}/cancel`, {}),
  /**
   * 人工在图层编辑器里改完的 LayerDoc：服务端严格校验（normalizeLayerDoc 会改动即拒收）、
   * 用同一条 renderLayerDoc 链重绘；宿主任务保存即交付。
   * layerOptions 只按调用方给的值提交，**不**在这里补默认值——补出来的默认会被当成人工改动。
   */
  saveLayerDoc: (taskId: number, layerDoc: Record<string, unknown>, expectedRevision?: number, layerOptions?: MapLayerSmoothing) =>
    request<MapStudioDetail>('PUT', `/tasks/${taskId}/layer-doc`, {
      layer_doc: layerDoc,
      expected_revision: expectedRevision,
      ...(layerOptions !== undefined ? { layer_options: layerOptions } : {}),
    }),
  /** 纯读取检查：严格校验 + 平滑偏离 + 标签排版问题，不保存、不重绘、不消耗轮次 */
  checkLayerDoc: (taskId: number, layerDoc: Record<string, unknown>, layerOptions?: MapLayerSmoothing) =>
    request<MapLayerCheck>('POST', `/tasks/${taskId}/layer-doc/check`, {
      layer_doc: layerDoc,
      ...(layerOptions !== undefined ? { layer_options: layerOptions } : {}),
    }),
  /** 纯函数自动排布标签：返回调整后的文档与排不下的条目；不删除标签、不缩字号 */
  autoLayoutLayerDoc: (taskId: number, layerDoc: Record<string, unknown>, layerOptions?: MapLayerSmoothing) =>
    request<MapLayerAutoLayout>('POST', `/tasks/${taskId}/layer-doc/auto-layout`, {
      layer_doc: layerDoc,
      ...(layerOptions !== undefined ? { layer_options: layerOptions } : {}),
    }),
  restyleLayerDoc: (taskId: number, layerDoc: Record<string, unknown>, layerOptions?: MapLayerSmoothing) =>
    request<MapLayerCheck & { layer_doc: Record<string, unknown>; map_style: string | null }>('POST', `/tasks/${taskId}/layer-doc/restyle`, { layer_doc: layerDoc, ...(layerOptions !== undefined ? { layer_options: layerOptions } : {}) }),
  /** 宿主任务：把当前成图重新交付（幂等，同一 sha256 不重复登记）；独立任务 400 standalone_task */
  deliver: (taskId: number) => request<{ delivered: boolean, version_ids: number[], message: string, deliveries: MapStudioDeliveryRow[] }>('POST', `/tasks/${taskId}/deliver`, {}),
  /** 文件流端点：直接给 <a download>，不要用 fetch（正文是二进制/附件） */
  downloadUrl: (taskId: number, kind: MapStudioDownloadKind) => endpoint(`/tasks/${taskId}/download/${kind}`),

  /** 每次运行一行：墙钟 / 模型调用耗时 / 排队耗时 / 调用数分列（服务端事实） */
  runs: (taskId: number) => request<{ runs: MapStudioRun[] }>('GET', `/tasks/${taskId}/runs`),
  /** 工作项 + 调用分页；cursor 同时作为 work_cursor/call_cursor */
  observed: (runId: number, opts: { cursor?: number, work_cursor?: number, call_cursor?: number, limit?: number } = {}) => {
    const query = new URLSearchParams()
    if (opts.cursor) query.set('cursor', String(opts.cursor))
    if (opts.work_cursor !== undefined) query.set('work_cursor', String(opts.work_cursor))
    if (opts.call_cursor !== undefined) query.set('call_cursor', String(opts.call_cursor))
    if (opts.limit) query.set('limit', String(opts.limit))
    return request<MapStudioRunObserved>('GET', `/runs/${runId}/observed${query.size ? `?${query.toString()}` : ''}`)
  },
  /** 单次调用的完整公开消息（游标分页，不截断正文） */
  messages: (callId: number, opts: { cursor?: number, limit?: number } = {}) => {
    const query = new URLSearchParams()
    if (opts.cursor) query.set('cursor', String(opts.cursor))
    if (opts.limit) query.set('limit', String(opts.limit))
    return request<MapStudioCallMessages>('GET', `/calls/${callId}/messages${query.size ? `?${query.toString()}` : ''}`)
  },

  settings: () => request<MapStudioSettings>('GET', '/settings'),
  saveSettings: (data: { research_keys?: Partial<Record<ResearchKeyId, string | null>>, models?: Partial<MapStudioSettingsModels>, default_style?: string }) =>
    request<MapStudioSettings>('PUT', '/settings', data),
  modelOptions: () => request<MapStudioModelOptions>('GET', '/model-options'),
  styles: () => request<MapStudioStyles>('GET', '/styles'),
  stylePreviewUrl: (id: string) => endpoint(`/styles/${encodeURIComponent(id)}/preview`),

  /**
   * 外部底图原件上传：走通用上传端点（模块没有自己的上传路由）。
   * 与通用上传同口径：multipart 字段名 file，返回 STORAGE_ROOT 相对 path。
   */
  uploadImage: async (file: File): Promise<{ path: string, url: string }> => {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch(`${apiBase()}/upload/image`, { method: 'POST', body: form })
    let json: Record<string, unknown> = {}
    try { json = await resp.json() as Record<string, unknown> } catch { json = {} }
    if (!resp.ok || Number(json.code) >= 400) {
      const err: MapStudioApiError = new Error(String(json.message || resp.status))
      err.status = resp.status
      err.body = json
      throw err
    }
    const data = (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json) as { path?: string, url?: string }
    return { path: String(data?.path ?? ''), url: String(data?.url ?? '') }
  },
}

/** 409 冲突体：修订号冲突 / 阶段正在执行；两者都不会改服务端状态，本地草稿保留 */
export function mapStudioConflictOf(err: unknown): { kind: 'revision' | 'busy', revision?: number, runId?: number, message: string } | null {
  const body = (err as MapStudioApiError)?.body
  if (!body) return null
  if (body.error === 'revision_conflict') {
    return { kind: 'revision', revision: Number(body.revision) || undefined, message: String(body.message || '') }
  }
  if (body.error === 'workflow_busy' || body.error === 'run_busy') {
    const runId = Number(body.run_id) || Number(body.task_id) || undefined
    return { kind: 'busy', runId, message: String(body.message || '') }
  }
  return null
}

/** 400 layer_doc_invalid：严格校验/标签排版逐条指出「哪里不行」，草稿一律保留由人改 */
export function mapLayerDocProblemsOf(err: unknown): { message: string, problems: MapLayerProblem[] } | null {
  const body = (err as MapStudioApiError)?.body
  if (!body || body.error !== 'layer_doc_invalid') return null
  const raw = Array.isArray(body.problems) ? body.problems : []
  return {
    message: String(body.message || ''),
    problems: raw.map((item: unknown) => {
      const row = (item ?? {}) as Record<string, unknown>
      const problem: MapLayerProblem = { path: String(row.path ?? ''), message: String(row.message ?? '') }
      if (row.layer_id !== undefined && row.layer_id !== null && String(row.layer_id)) problem.layer_id = String(row.layer_id)
      if (row.code !== undefined && row.code !== null && String(row.code)) problem.code = String(row.code)
      return problem
    }),
  }
}

/**
 * 问题 → 可点击选中的图层：优先用服务端给的 layer_id，其次按 `layers[N]` 路径取当前文档里的
 * 图层（这份文档就是服务端校验的那份），都定位不到就返回 null——不猜一个「大概相关」的图层。
 */
export function mapLayerProblemLayerId(problem: MapLayerProblem, layers: Array<{ id: string }>): string | null {
  if (problem.layer_id && layers.some(layer => layer.id === problem.layer_id)) return problem.layer_id
  const match = /^layers\[(\d+)\]/.exec(problem.path || '')
  if (!match) return null
  const layer = layers[Number(match[1])]
  return layer ? layer.id : null
}

/* ===== 阶段 ② 几何核验（纯读取与挑选用；闸门永远在服务端） ===== */

export type MapSpecFeatureKind = 'place' | 'route' | 'region'

/** 挑选「待确认」条目时用的键；map_spec 三类几何的 id 各自唯一 */
export function mapSpecFeatureKey(kind: MapSpecFeatureKind, id: string): string {
  return `${kind}:${id}`
}

export interface MapPendingGeometry { kind: MapSpecFeatureKind, id: string, name: string, reasons: string[] }

/**
 * 列出「AI 提议且既不 verified 也不 confirmed」的几何条目——与服务端 research/base/drawing/complete
 * 闸门的判定同一条件，只用来在界面上挑出待确认行；**放行与否一律以服务端回执为准**
 * （400 geometry_unverified 的 message 原样显示，不在这里自行放行）。
 * 服务端把这些要素拆成 `name (i/N)` 同前缀条目时，每一条都会独立出现。
 */
export function mapPendingGeometry(spec: MapSpec | null): MapPendingGeometry[] {
  if (!spec) return []
  const row = (kind: MapSpecFeatureKind, item: MapPlace | MapRoute | MapRegion): MapPendingGeometry => ({
    kind,
    id: item.id,
    name: item.name,
    reasons: item.verification?.reasons?.length ? item.verification.reasons : ['AI 提议的坐标缺少可核验依据，请人工确认'],
  })
  const pending: MapPendingGeometry[] = []
  for (const [kind, list] of [
    ['place', spec.places ?? []],
    ['route', spec.routes ?? []],
    ['region', spec.regions ?? []],
  ] as Array<[MapSpecFeatureKind, Array<MapPlace | MapRoute | MapRegion>]>) {
    for (const item of list) {
      // 人工编辑过的条目不算 AI 提议；已经核验过（数据集或逐字坐标证据）也不必再确认
      if (item.proposed !== true || item.origin === 'manual') continue
      if (item.verification?.status === 'verified' && item.origin !== undefined) continue
      pending.push(row(kind, item))
    }
  }
  return pending
}

export interface MapConfirmTarget { kind: MapSpecFeatureKind, id: string }

/**
 * 确认 = 去掉 `proposed`（现有 CAS 语义），其余元数据（category / origin / verification / dataset_ref /
 * relations）逐字保留；核验状态由服务端在保存时改写为 confirmed，前端不替它编结论。
 * 返回新的 spec 对象，绝不原地改服务端快照。
 */
export function confirmSpecFeatures(spec: MapSpec, targets: MapConfirmTarget[]): MapSpec {
  const wanted = new Set(targets.map(target => mapSpecFeatureKey(target.kind, target.id)))
  const strip = <T extends { id: string }>(kind: MapSpecFeatureKind, list: T[]): T[] => list.map((item) => {
    if (!wanted.has(mapSpecFeatureKey(kind, item.id))) return { ...item }
    const copy = { ...item } as T & { proposed?: boolean }
    delete copy.proposed
    return copy
  })
  return {
    ...spec,
    places: strip('place', spec.places ?? []),
    routes: strip('route', spec.routes ?? []),
    regions: strip('region', spec.regions ?? []),
  }
}
