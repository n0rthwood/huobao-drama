/**
 * 地图工作室的类型与校验（Issue #99，从 #84/#90 的 `services/map-workflow` 迁移而来）
 *
 * 这一层只做**纯数据**：形状、枚举、输入清洗、文件路径围栏。它不碰数据库、不发请求，
 * 所以每条规则都能单测，也不会在半路写坏模块里的任务文档。
 *
 * 口径（用户确认，迁移时不变）：
 * - 几何是确定性的：扩散模型只产生**底纹**，绝不重画地理；
 * - 坐标必须有出处；拿不准就显式标成「近似/示意」，不允许伪装成考证结论。
 * - 这里不认识「道具/资产类别」这些火宝概念：地图任务只是模块自己的任务行。
 */
import fs from 'fs'
import { toAbsPath } from '../../utils/paths.js'
import type { MapSpec } from './geo/base-render.js'

export const MAP_WORKFLOW_STAGES = ['brief', 'research', 'base', 'style', 'drawing', 'complete'] as const
export type MapWorkflowStage = typeof MAP_WORKFLOW_STAGES[number]

export const STAGE_LABEL: Record<MapWorkflowStage, string> = {
  brief: '地图需求',
  research: '资料检索',
  base: '底图生产',
  style: '质感底纹',
  drawing: '标注绘制',
  complete: '完成登记',
}

export type MapWorkflowStatus = 'idle' | 'running' | 'awaiting_review' | 'blocked' | 'failed' | 'completed'
export type MapWorkflowMode = 'auto' | 'manual'
export type MapStepStatus = 'pending' | 'running' | 'awaiting_review' | 'completed' | 'failed' | 'skipped'

export type MapBaseMode = 'program' | 'earth' | 'image'
export const MAP_BASE_MODES: MapBaseMode[] = ['program', 'earth', 'image']
export type MapDetailLevel = 'overview' | 'regional' | 'site'
export const MAP_DETAIL_LEVELS: MapDetailLevel[] = ['overview', 'regional', 'site']
export type MapStyleTheme = 'archival' | 'clean' | 'ink'
export const MAP_STYLE_THEMES: MapStyleTheme[] = ['archival', 'clean', 'ink']

export class MapWorkflowValidationError extends Error {
  code: string
  field: string
  constructor(message: string, opts: { code?: string; field?: string } = {}) {
    super(message)
    this.name = 'MapWorkflowValidationError'
    this.code = opts.code ?? 'invalid_request'
    this.field = opts.field ?? ''
  }
}

export interface MapControlPoint { x: number; y: number; lon: number; lat: number }

export interface MapBriefReferenceImage {
  /** 仓库数据目录内的相对路径（`static/...`）；绝不接受 URL 或绝对路径 */
  path: string
  source_url: string
  license: string
  control_points: MapControlPoint[]
}

/** AI 对隐含信息的补全：每一条都要能解释「凭什么这么认为」 */
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
  detail_level: MapDetailLevel
  schematic: boolean
  base_mode: MapBaseMode
  style: MapStyleTheme
  notes: string
  reference_image: MapBriefReferenceImage | null
  inferred: MapBriefInference[]
}

export interface MapWorkflowIssue {
  field: string
  code: string
  message: string
  blocking: boolean
}

export interface MapWorkflowStep {
  id: MapWorkflowStage
  label: string
  status: MapStepStatus
  message: string | null
  started_at: string | null
  finished_at: string | null
}

export interface MapResearchQuery {
  adapter: string
  query: string
  hits: number
  error: string | null
}

export interface MapResearchSource {
  /** 工作流内稳定引用号（S1、S2…），feature.source_ids 指向它 */
  id: string
  adapter: string
  title: string
  url: string | null
  institution: string
  date: string
  license: string
  tier: 'A' | 'B'
  /** 实际抓到的正文摘录；图像类来源为空串（空摘录不能支撑坐标） */
  excerpt: string
}

export type MapFeatureKind = 'place' | 'route' | 'region'
/**
 * 坐标依据：
 * - `excerpt`：检索正文里确有支撑原文（`supporting_excerpt` 能在摘录里逐字找到）；
 * - `well_known`：现代地名的公认位置，没有逐字出处，按常识给出；
 * - `approximate_schematic`：示意位置，只能用于示意图，必须高不确定度可见。
 */
export type MapCoordinateBasis = 'excerpt' | 'well_known' | 'approximate_schematic'

export interface MapFeatureConflict {
  source_id: string
  lon: number | null
  lat: number | null
  note: string
}

export type MapFeatureCategory = 'river' | 'lake' | 'coast' | 'mountain' | 'settlement' | 'route' | 'territory' | 'other'
export type MapFeatureOrigin = 'dataset' | 'source' | 'model' | 'manual'
export interface MapVerification {
  status: 'verified' | 'unverified' | 'conflict' | 'needs_user' | 'confirmed'
  reasons: string[]
}
export interface MapDatasetReference { ref: string; clip_bbox?: [number, number, number, number] }
export interface MapDatasetQuery {
  layer: string
  query: string
  bbox?: [number, number, number, number]
  hits: number
  refs: string[]
  error?: string | null
}
export interface MapRelation {
  id: string
  subject: string
  object: string
  relation: 'distance_km' | 'east_of' | 'west_of' | 'north_of' | 'south_of' | 'near_river'
  value_km?: number
  tolerance_km?: number
  excerpt: string
  source_id: string
  computed: { value_km?: number; consistent: boolean }
  message: string
}

export interface MapResearchFeature {
  id: string
  kind: MapFeatureKind
  name: string
  lon: number | null
  lat: number | null
  points: Array<[number, number]>
  /** Disconnected dataset chains remain separate; adoption emits separate spec entries. */
  parts?: Array<Array<[number, number]>>
  category?: MapFeatureCategory
  origin?: MapFeatureOrigin
  verification?: MapVerification
  dataset_ref?: MapDatasetReference
  relations?: MapRelation[]
  coordinate_basis: MapCoordinateBasis
  /** 坐标是怎么来的（与 supporting_excerpt 区分：后者是原文，这里是推理） */
  basis: string
  supporting_excerpt: string
  /** supporting_excerpt 是否真的在某条来源摘录里找到了 */
  excerpt_verified: boolean
  source_ids: string[]
  source_url: string | null
  source_title: string
  uncertainty: 'high' | 'medium' | 'low'
  approximate: boolean
  conflicts: MapFeatureConflict[]
}

export interface MapResearch {
  queries: MapResearchQuery[]
  dataset_queries?: MapDatasetQuery[]
  extent?: [number, number, number, number]
  relations?: MapRelation[]
  sources: MapResearchSource[]
  features: MapResearchFeature[]
  uncertainties: string[]
  notes: string[]
  searched_at: string
}

export interface MapImageRef {
  path: string
  width: number
  height: number
  source: string
  run_id: number | null
  /**
   * 产出溯源：几何侧返回的 provenance（registration / attribution / sources…）原样存着。
   * 类型用 `object` 而非 `Record<string, unknown>`——后者要求索引签名，具名接口赋不进来；
   * 读取一律用 `'key' in provenance` 收窄，不用类型断言。
   */
  provenance: object | null
}

export interface MapWorkflowOutputs {
  base_image: MapImageRef | null
  texture_image: MapImageRef | null
  final_image: MapImageRef | null
  kmz: { path: string; provenance: object | null } | null
  /** 几何侧的 LayerDoc（可编辑图层文档），原样透传给前端 */
  layer_doc: object | null
}

export interface MapWorkflowHistoryEntry {
  revision: number
  at: string
  stage: MapWorkflowStage
  status: MapWorkflowStatus
  action: string
  actor: 'auto' | 'manual' | 'system'
  note: string | null
  /** 回退用快照：该修订之前的 brief / map_spec / 产出 */
  snapshot?: {
    /** 快照取自变更之前，不能用 history.stage（变更之后）代替。旧记录由 action 判定。 */
    stage?: MapWorkflowStage
    brief: MapBrief | null
    map_spec: MapSpec | null
    outputs: MapWorkflowOutputs
    research: MapResearch | null
  }
}

/**
 * 模型阶段的交付轮次与跨阶段回退（Issue #90）。
 *
 * 计数属于一次运行（run_id）：新的运行重新计数，历史尝试记录保留供回看。
 * 记录与计数随工作流文档落库，后端重启后不归零。
 */
export const MAP_AGENT_STAGES = ['brief', 'research', 'base', 'drawing'] as const
export type MapAgentStage = typeof MAP_AGENT_STAGES[number]
/** 每个模型阶段最多交付 3 轮（含被拒后的重交） */
export const MAP_MAX_STAGE_ROUNDS = 3
/** 一次运行跨阶段回退最多 2 次 */
export const MAP_MAX_ROLLBACKS = 2
/** 非模型阶段（质感底纹 / 完成登记）的基础设施失败自动重试次数 */
export const MAP_INFRA_RETRIES = 2

export type MapAgentOutcome = 'accepted' | 'rejected' | 'no_delivery' | 'error' | 'rollback' | 'infra_retry'

export interface MapAgentAttempt {
  run_id: number
  stage: MapWorkflowStage
  /** 1 起的交付轮次；非轮次类记录（回退、基础设施重试）为 0 */
  round: number
  outcome: MapAgentOutcome
  problems: string[]
  target_stage?: MapWorkflowStage
  at: string
}

export interface MapAgentState {
  run_id: number | null
  rounds: Partial<Record<MapAgentStage, number>>
  rollbacks: number
  /** 交给某阶段模型的回馈（回退原因、上次失败原因），该阶段下一次执行时读出 */
  feedback: Partial<Record<MapWorkflowStage, string>>
  attempts: MapAgentAttempt[]
}

export function emptyAgentState(): MapAgentState {
  return { run_id: null, rounds: {}, rollbacks: 0, feedback: {}, attempts: [] }
}

export function isMapAgentStage(stage: MapWorkflowStage): stage is MapAgentStage {
  return (MAP_AGENT_STAGES as readonly string[]).includes(stage)
}

/** 落库的工作流文档（props.map_workflow 的 JSON 根） */
export interface MapWorkflowState {
  version: 1
  stage: MapWorkflowStage
  status: MapWorkflowStatus
  mode: MapWorkflowMode
  revision: number
  run_id: number | null
  error: string | null
  brief: MapBrief | null
  /** brief 内容指纹：异步阶段结果落库前比对，人工改过 brief 就不覆盖 */
  brief_hash: string | null
  steps: MapWorkflowStep[]
  issues: MapWorkflowIssue[]
  research: MapResearch | null
  outputs: MapWorkflowOutputs
  history: MapWorkflowHistoryEntry[]
  text_config_id: number | null
  image_config_id: number | null
  image_model: string | null
  updated_at: string | null
  agent: MapAgentState
}

export const EMPTY_OUTPUTS: MapWorkflowOutputs = {
  base_image: null, texture_image: null, final_image: null, kmz: null, layer_doc: null,
}

export function emptySteps(): MapWorkflowStep[] {
  return MAP_WORKFLOW_STAGES.map(stage => ({
    id: stage, label: STAGE_LABEL[stage], status: 'pending' as MapStepStatus,
    message: null, started_at: null, finished_at: null,
  }))
}

export function emptyWorkflow(): MapWorkflowState {
  return {
    version: 1,
    stage: 'brief',
    status: 'idle',
    mode: 'manual',
    revision: 0,
    run_id: null,
    error: null,
    brief: null,
    brief_hash: null,
    steps: emptySteps(),
    issues: [],
    research: null,
    outputs: { ...EMPTY_OUTPUTS },
    history: [],
    text_config_id: null,
    image_config_id: null,
    image_model: null,
    updated_at: null,
    agent: emptyAgentState(),
  }
}

export function emptyBrief(): MapBrief {
  return {
    subject: '', era: '', location: '', purpose: '',
    detail_level: 'regional', schematic: false, base_mode: 'program', style: 'archival',
    notes: '', reference_image: null, inferred: [],
  }
}

// ─────────────────────────────── 输入清洗 ───────────────────────────────

const MAX_TEXT = 2000
const MAX_CONTROL_POINTS = 60

function text(raw: unknown, field: string, max = MAX_TEXT): string {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new MapWorkflowValidationError(`${field} 必须是字符串`, { field })
  const value = raw.trim()
  if (value.length > max) throw new MapWorkflowValidationError(`${field} 超过 ${max} 字上限`, { field })
  return value
}

function enumOf<T extends string>(raw: unknown, allowed: T[], field: string, fallback: T): T {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = String(raw)
  if (!(allowed as string[]).includes(value)) {
    throw new MapWorkflowValidationError(`${field} 只能是 ${allowed.join(' / ')}，收到「${value}」`, { field })
  }
  return value as T
}

function finite(raw: unknown, field: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new MapWorkflowValidationError(`${field} 必须是数字`, { field })
  return value
}

/**
 * 参考底图路径围栏：只接受数据目录内的 `static/...` 相对路径，且文件必须真实存在。
 * `toAbsPath()` 同时拦住 `..`、绝对路径与指向目录外的软链。
 */
export function assertSafeStaticPath(raw: unknown, field: string): string {
  const value = text(raw, field, 500)
  if (!value) throw new MapWorkflowValidationError(`${field} 必填`, { code: 'bad_reference_path', field })
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith('/') || value.includes('..') || value.includes('\0')) {
    throw new MapWorkflowValidationError(`${field} 必须是本项目内的相对路径（如 static/uploads/xxx.png），不接受 URL 或绝对路径`, { code: 'bad_reference_path', field })
  }
  let abs: string
  try {
    abs = toAbsPath(value)
  } catch (err) {
    throw new MapWorkflowValidationError(`${field} 非法：${err instanceof Error ? err.message : String(err)}`, { code: 'bad_reference_path', field })
  }
  if (!fs.existsSync(abs)) {
    throw new MapWorkflowValidationError(`${field} 指向的文件不存在：${value}`, { code: 'bad_reference_path', field })
  }
  return value
}

function normalizeControlPoints(raw: unknown): MapControlPoint[] {
  if (!Array.isArray(raw)) {
    throw new MapWorkflowValidationError('reference_image.control_points 必须是数组', { code: 'bad_control_points', field: 'reference_image.control_points' })
  }
  if (raw.length > MAX_CONTROL_POINTS) {
    throw new MapWorkflowValidationError(`reference_image.control_points 最多 ${MAX_CONTROL_POINTS} 个`, { code: 'bad_control_points', field: 'reference_image.control_points' })
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new MapWorkflowValidationError(`reference_image.control_points[${idx}] 必须是对象`, { code: 'bad_control_points', field: 'reference_image.control_points' })
    }
    const record = item as Record<string, unknown>
    const point: MapControlPoint = {
      x: finite(record.x, `control_points[${idx}].x`),
      y: finite(record.y, `control_points[${idx}].y`),
      lon: finite(record.lon, `control_points[${idx}].lon`),
      lat: finite(record.lat, `control_points[${idx}].lat`),
    }
    if (point.lon < -180 || point.lon > 180 || point.lat < -90 || point.lat > 90) {
      throw new MapWorkflowValidationError(`control_points[${idx}] 经纬度越界（lon ∈ [-180,180]，lat ∈ [-90,90]）`, { code: 'bad_control_points', field: 'reference_image.control_points' })
    }
    return point
  })
}

/**
 * 控制点是否全部共线（像素侧与经纬侧都要有展开面积）。
 * 判据：任取一点为原点，其余点与它构成的向量叉积最大值接近 0。
 */
function collinear(points: MapControlPoint[]): boolean {
  const [origin, ...rest] = points
  if (!origin || rest.length < 2) return true
  const area = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax * by - ay * bx)
  let pixelArea = 0
  let geoArea = 0
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      const a = rest[i]!
      const b = rest[j]!
      pixelArea = Math.max(pixelArea, area(a.x - origin.x, a.y - origin.y, b.x - origin.x, b.y - origin.y))
      geoArea = Math.max(geoArea, area(a.lon - origin.lon, a.lat - origin.lat, b.lon - origin.lon, b.lat - origin.lat))
    }
  }
  return pixelArea < 1e-6 || geoArea < 1e-9
}

export function normalizeReferenceImage(raw: unknown): MapBriefReferenceImage | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'object') throw new MapWorkflowValidationError('reference_image 必须是对象或 null', { field: 'reference_image' })
  const record = raw as Record<string, unknown>
  const sourceUrl = text(record.source_url, 'reference_image.source_url', 1000)
  const license = text(record.license, 'reference_image.license', 500)
  if (!sourceUrl) throw new MapWorkflowValidationError('外部底图必须填写 source_url（出处），不能匿名引用', { code: 'missing_provenance', field: 'reference_image.source_url' })
  if (!license) throw new MapWorkflowValidationError('外部底图必须填写 license（授权），不能匿名引用', { code: 'missing_provenance', field: 'reference_image.license' })
  const controlPoints = normalizeControlPoints(record.control_points ?? [])
  // 仿射配准至少要 3 个不共线的控制点：少于 3 个无解，共线则矩阵奇异。
  // 在这里就拒绝，坏 brief 不会先落库再到渲染时才炸。
  if (controlPoints.length < 3) {
    throw new MapWorkflowValidationError(
      `外部底图需要至少 3 个控制点来求解配准（当前 ${controlPoints.length} 个）：请在图上点 3 个以上已知经纬度的位置`,
      { code: 'bad_control_points', field: 'reference_image.control_points' },
    )
  }
  if (collinear(controlPoints)) {
    throw new MapWorkflowValidationError(
      '外部底图的控制点共线（全在一条直线上），无法求解配准：请挑选分布成三角形的 3 个以上位置',
      { code: 'bad_control_points', field: 'reference_image.control_points' },
    )
  }
  return {
    path: assertSafeStaticPath(record.path, 'reference_image.path'),
    source_url: sourceUrl,
    license,
    control_points: controlPoints,
  }
}

function normalizeInferred(raw: unknown): MapBriefInference[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const field = text(record.field, 'inferred.field', 100)
    if (!field) return []
    return [{
      field,
      value: text(record.value, 'inferred.value', 500),
      basis: text(record.basis, 'inferred.basis', 1000),
      confidence: enumOf(record.confidence, ['high', 'medium', 'low'] as const, 'inferred.confidence', 'medium'),
    }]
  })
}

/**
 * 合并式 brief 规范化：只覆盖请求里出现的键，其余保持原值。
 * 任何一个字段非法就整体抛错——半写入的 brief 比没写更危险。
 */
export function normalizeBrief(raw: unknown, previous: MapBrief | null): MapBrief {
  if (raw === null || raw === undefined) return previous ?? emptyBrief()
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new MapWorkflowValidationError('brief 必须是对象', { field: 'brief' })
  const record = raw as Record<string, unknown>
  const base = previous ?? emptyBrief()
  const next: MapBrief = { ...base, inferred: [...base.inferred] }
  if ('subject' in record) next.subject = text(record.subject, 'brief.subject')
  if ('era' in record) next.era = text(record.era, 'brief.era')
  if ('location' in record) next.location = text(record.location, 'brief.location')
  if ('purpose' in record) next.purpose = text(record.purpose, 'brief.purpose')
  if ('notes' in record) next.notes = text(record.notes, 'brief.notes', 4000)
  if ('detail_level' in record) next.detail_level = enumOf(record.detail_level, MAP_DETAIL_LEVELS, 'brief.detail_level', base.detail_level)
  if ('base_mode' in record) next.base_mode = enumOf(record.base_mode, MAP_BASE_MODES, 'brief.base_mode', base.base_mode)
  if ('style' in record) next.style = enumOf(record.style, MAP_STYLE_THEMES, 'brief.style', base.style)
  if ('schematic' in record) next.schematic = record.schematic === true || record.schematic === 1 || record.schematic === 'true'
  if ('reference_image' in record) next.reference_image = normalizeReferenceImage(record.reference_image)
  if ('inferred' in record) next.inferred = normalizeInferred(record.inferred)
  if (next.base_mode === 'image' && !next.reference_image) {
    throw new MapWorkflowValidationError('底图方式选「外部图像」时必须提供 reference_image（路径 + 出处 + 授权 + 控制点）', { code: 'missing_reference_image', field: 'brief.reference_image' })
  }
  return next
}
