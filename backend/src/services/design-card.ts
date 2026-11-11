/**
 * 分镜设计卡（design card）— `storyboards.design_card` 的唯一 schema / 规范化 / 校验（Issue #57）
 *
 * 一镜最多由两段组成：▣ 图层段（确定性渲染，≤30s）与 ▶ 生成段（视频模型，≤15s），
 * 二者不互斥。段组合 A/B/C/D 没有默认值，可由 AI 填写并由人工审阅或修改。
 *
 * 设计卡是导演分镜单：叙事（信息点）→ 结构（组合 + 预算）→ 图层段计划 → 生成段计划 → 理由，
 * 每一组字段都对应下游的某一步，校验结论（`issues`）读时重算、不落库。
 *
 * 纯函数模块：不读库、不读文件，解析上下文由调用方装配（`loadDesignCardContext`）。
 */
import { estimateNarrationSeconds, MAX_NARRATION_CHARS, narrationCharCount } from './narration.js'
import { normalizeLayerDoc, type LayerDoc } from './layer-doc.js'
import { revealBeats, textZoneOf } from './layer-text-visibility.js'
import { orientationOf } from './aspect.js'
import {
  TEXT_CANONICAL_SIZES,
  TEXT_SPEC,
  textCapacity,
  textLayoutById,
  textLayerProblems,
  textRolesFor,
  type TextFieldCapacity,
  type TextProblem,
} from './layer-text.js'

/** 段组合：A 只图层 / B 只生成 / C 图层→生成 / D 生成→图层 */
export const COMBOS = ['A', 'B', 'C', 'D'] as const
export type Combo = typeof COMBOS[number]

/** 设计卡状态机（契约 §3.1） */
export const DESIGN_CARD_STATUSES = ['blank', 'ai_filling', 'pending', 'confirmed', 'stale'] as const
export type DesignCardStatus = typeof DESIGN_CARD_STATUSES[number]

/** 信息点的表达途径 */
export const INFO_POINT_VIAS = ['layer', 'generated', 'narration_only'] as const
export type InfoPointVia = typeof INFO_POINT_VIAS[number]

/** 计划图层类型（与 #48 LayerDoc 的图层类型同集合；`text` = #96 模板文本框） */
export const PLANNED_LAYER_TYPES = ['polygon', 'polyline', 'marker', 'label', 'card', 'image', 'text'] as const
export type PlannedLayerType = typeof PLANNED_LAYER_TYPES[number]

export type AssetKindName = 'character' | 'scene' | 'prop'

/** 图层段硬上限（秒）：确定性渲染 */
export const MAX_LAYER_SEGMENT_SECONDS = 30
/** 生成段硬上限（秒）：视频模型，与 comfyui-video 的 clampDuration 对齐 */
export const MAX_GEN_SEGMENT_SECONDS = 15
/** 预算余量低于这个值就提示「偏紧」 */
export const BUDGET_TIGHT_SECONDS = 0.5

const MAX_INFO_POINTS = 12
const MAX_INFO_POINT_TEXT = 200
const MAX_RATIONALE = 600
const MAX_MUST_MARK = 20
const MAX_PLANNED_LAYERS = 40
const MAX_FRAME_TEXT = 400

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
    /** 指定版本（生成图的 sys_task id）；null = 用当前生效图 */
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
  /** 该层出现的秒数（相对图层段开头） */
  at_s: number
  /** `type='text'`（#96）：模板文本框类型（layer-text-spec 的 role id） */
  role?: string
  /** `type='text'`（#96）：字段值；列表字段为字符串数组 */
  fields?: Record<string, string | string[]>
}

export interface LayerPlan {
  base: BaseRef | null
  must_mark: SemanticRef[]
  planned_layers: PlannedLayer[]
  /** #96：模板文本框的成套位置 id（有 text 计划层时必选） */
  text_layout?: string
}

export interface GenPlan {
  reference_assets: AssetRef[]
  /** 首/中/尾各一句话；锁定槽位（C 的 first / D 的 last）省略 */
  first?: string
  mid?: string
  last?: string
}

export interface DesignCard {
  version: 2
  info_points: InfoPoint[]
  budget: { layer_s: number | null; gen_s: number | null }
  layer_plan?: LayerPlan
  gen_plan?: GenPlan
  rationale: string
  /** AI 建议，仅展示；实际 combo 单独存于分镜列。 */
  suggested_combo: Combo | null
  /** 读时重算，不落库 */
  issues: CardIssue[]
}

export type CardIssueCode =
  // 阻断
  | 'combo_missing'
  | 'budget_over_layer'
  | 'budget_missing'
  | 'budget_over_gen'
  | 'budget_under_narration'
  | 'missing_base'
  | 'gen_slot_missing'
  // 阻断/警告（#96 模板文本框）
  | 'text_plan_invalid'
  | 'text_plan_warning'
  // 警告
  | 'info_point_unassigned'
  | 'must_mark_not_planned'
  | 'reference_not_mentioned'
  | 'budget_tight'
  | 'unresolved_ref'

export interface CardIssue {
  code: CardIssueCode
  severity: 'block' | 'warn'
  message: string
  index?: number
}

export interface DesignCardSemanticEntry {
  id: string
  name: string
  group: 'label' | 'point' | 'region' | 'line'
  /**
   * 这条语义实际带了几个几何点（label 的 bbox 记 1，point 的坐标记 1，region/line 记折点数）。
   * 设计卡的依据机检（#87）据此判断「ID 真实存在但几何为空」——那同样不能当作可实现的依据。
   * 旧调用方没填时为 undefined，机检按「几何未知」放行，只看组别相容性。
   */
  geometry_points?: number
}

export interface DesignCardAssetEntry {
  kind: AssetKindName
  id: number
  name: string
  exposition?: boolean
  faithful?: boolean
  image?: string | null
  semantics?: DesignCardSemanticEntry[]
  /**
   * 这份语义标注是针对哪张图（生成图的 sys_task id）做的；人工手填的标注可能为 null。
   * 设计卡的依据机检（#87）用它判断「底图指定的版本」与「语义坐标所依据的版本」是否相容。
   */
  semantics_source_task_id?: number | null
}

export interface DesignCardContext {
  assets: DesignCardAssetEntry[]
  /**
   * 项目画幅（#96）：模板文本框的规范家族（16:9 / 9:16）与容量都由它决定。
   * 没有这项事实时读写两侧都**跳过**文本框的排版判定（不猜横版，免得误伤竖屏套位）。
   */
  aspect?: string
}

const KIND_LABELS: Record<AssetKindName, string> = { character: '角色', scene: '场景', prop: '道具' }

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function toAssetKind(value: unknown): AssetKindName | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw === 'character' || raw === 'scene' || raw === 'prop' ? raw : null
}

/** 合法的 combo，否则 null —— **绝不回落默认值**（#49 的隐式默认表正是用户否决的行为） */
export function toCombo(value: unknown): Combo | null {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return (COMBOS as readonly string[]).includes(raw) ? raw as Combo : null
}

export function toDesignCardStatus(value: unknown): DesignCardStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (DESIGN_CARD_STATUSES as readonly string[]).includes(raw) ? raw as DesignCardStatus : 'blank'
}

/** 本镜有没有图层段 / 生成段 */
export function hasLayerSegment(combo: Combo | null): boolean {
  return combo === 'A' || combo === 'C' || combo === 'D'
}
export function hasGenSegment(combo: Combo | null): boolean {
  return combo === 'B' || combo === 'C' || combo === 'D'
}
/** 被衔接帧锁定的生成段槽位：C 的首帧来自图层段末帧，D 的尾帧来自图层段首帧 */
export function lockedGenSlot(combo: Combo | null): 'first' | 'last' | null {
  if (combo === 'C') return 'first'
  if (combo === 'D') return 'last'
  return null
}

/** 镜列表里的组合象形 */
export const COMBO_GLYPHS: Record<Combo, string> = { A: '▣', B: '▶', C: '▣▶', D: '▶▣' }

function findAsset(ctx: DesignCardContext | undefined, id: number, kind: AssetKindName | null): DesignCardAssetEntry | undefined {
  if (!ctx) return undefined
  if (kind) return ctx.assets.find(a => a.id === id && a.kind === kind)
  const matches = ctx.assets.filter(a => a.id === id)
  return matches.length === 1 ? matches[0] : undefined
}

function findSemantic(asset: DesignCardAssetEntry | undefined, ref: string): DesignCardSemanticEntry | undefined {
  if (!asset?.semantics?.length || !ref) return undefined
  const needle = ref.trim()
  return asset.semantics.find(s => s.id === needle)
    || asset.semantics.find(s => s.name === needle)
    || asset.semantics.find(s => s.name.replace(/\s+/g, '') === needle.replace(/\s+/g, ''))
}

function normalizeSeconds(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const clamped = Math.max(0, value)
  // 0.1s 精度；上限不在这里截断——超限必须变成阻断问题被用户看见，静默钳回去等于骗人
  return Math.min(Math.round(clamped * 10) / 10, Math.max(max * 4, max))
}

function normalizeInfoPoints(raw: unknown): InfoPoint[] {
  if (!Array.isArray(raw)) return []
  const items: InfoPoint[] = []
  for (const entry of raw.slice(0, MAX_INFO_POINTS)) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const body = text(row.text, MAX_INFO_POINT_TEXT)
    if (!body) continue
    const viaRaw = typeof row.via === 'string' ? row.via.trim().toLowerCase() : ''
    const via = (INFO_POINT_VIAS as readonly string[]).includes(viaRaw) ? viaRaw as InfoPointVia : 'narration_only'
    const id = text(row.id, 40) || `ip${items.length + 1}`
    items.push({ id, text: body, via })
  }
  return items
}

/** 语义条目引用：解析不到**保留并标 unresolved**（沿用 #49 的既有原则） */
function normalizeSemanticRef(raw: unknown, ctx: DesignCardContext | undefined): SemanticRef | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const assetId = Number.isInteger(row.asset_id) ? Number(row.asset_id) : NaN
  if (!Number.isInteger(assetId)) return null
  const semanticId = text(row.semantic_id ?? row.semantic, 120)
  const ref: SemanticRef = { asset_id: assetId, semantic_id: semanticId, name: text(row.name, 120) }
  if (!ctx) return ref
  const asset = findAsset(ctx, assetId, toAssetKind(row.asset_kind))
  if (!asset) {
    ref.unresolved = true
    ref.unresolved_reason = `资产 ${assetId} 不在本集`
    return ref
  }
  const semantic = findSemantic(asset, semanticId || ref.name)
  if (!semantic) {
    ref.unresolved = true
    ref.unresolved_reason = semanticId || ref.name
      ? `「${asset.name}」的语义标注里没有「${semanticId || ref.name}」`
      : `没有指定「${asset.name}」上的语义项`
    return ref
  }
  ref.semantic_id = semantic.id
  ref.name = semantic.name
  return ref
}

function normalizeAssetRef(raw: unknown, ctx: DesignCardContext | undefined): AssetRef | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = Number.isInteger(row.id) ? Number(row.id) : Number.isInteger(row.asset_id) ? Number(row.asset_id) : NaN
  if (!Number.isInteger(id)) return null
  const kind = toAssetKind(row.kind ?? row.asset_kind)
  const ref: AssetRef = { kind: kind ?? 'prop', id, name: text(row.name, 120) }
  if (!ctx) return ref
  const asset = findAsset(ctx, id, kind)
  if (!asset) {
    ref.unresolved = true
    ref.unresolved_reason = kind
      ? `本集没有 id 为 ${id} 的${KIND_LABELS[kind]}`
      : `资产 ${id} 不在本集（或在多个类别里都存在，请写明 kind）`
    return ref
  }
  ref.kind = asset.kind
  ref.name = asset.name
  return ref
}

function normalizeBaseRef(raw: unknown, ctx: DesignCardContext | undefined): BaseRef | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row.kind === 'inherit_prev') return { kind: 'inherit_prev' }
  const assetId = Number.isInteger(row.asset_id) ? Number(row.asset_id) : NaN
  if (!Number.isInteger(assetId)) return null
  const kind = toAssetKind(row.asset_kind) ?? 'prop'
  const versionTaskId = Number.isInteger(row.version_task_id) ? Number(row.version_task_id) : null
  const ref: BaseRef = { kind: 'asset', asset_kind: kind, asset_id: assetId, version_task_id: versionTaskId }
  if (ctx && !findAsset(ctx, assetId, kind)) {
    ref.unresolved = true
    ref.unresolved_reason = `本集没有 id 为 ${assetId} 的${KIND_LABELS[kind]}`
  }
  return ref
}

/**
 * 模板文本框的记录层字段：清洗口径必须与 #48 `normalizeLayerDoc` 完全一致（未知字段丢弃、
 * 列表字段切条、长度上限），所以直接借用它的 text 图层规范化，而不是再抄一份规则。
 * 未知 `role` 返回 null（整层丢弃：规范里没有这个类型，排版与容量都无从谈起）。
 */
function normalizePlannedTextFields(role: string, raw: unknown): Record<string, string | string[]> | null {
  const doc = normalizeLayerDoc({
    version: 1,
    base: { path: '', width: 1, height: 1 },
    layers: [{ id: 'probe', type: 'text', role, fields: raw }],
  })
  const layer = doc.layers[0]
  return layer && layer.type === 'text' ? layer.fields : null
}

function normalizePlannedLayers(raw: unknown, ctx: DesignCardContext | undefined): PlannedLayer[] {
  if (!Array.isArray(raw)) return []
  const items: PlannedLayer[] = []
  for (const entry of raw.slice(0, MAX_PLANNED_LAYERS)) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const typeRaw = typeof row.type === 'string' ? row.type.trim().toLowerCase() : ''
    if (!(PLANNED_LAYER_TYPES as readonly string[]).includes(typeRaw)) continue
    const item: PlannedLayer = {
      type: typeRaw as PlannedLayerType,
      at_s: typeof row.at_s === 'number' && Number.isFinite(row.at_s)
        ? Math.max(0, Math.round(Number(row.at_s) * 100) / 100)
        : 0,
    }
    if (item.type === 'text') {
      // #96：模板文本框只认类型 + 字段（位置与样式由规范决定，不锚定、不写自由文字）
      const role = typeof row.role === 'string' ? row.role.trim() : ''
      if (!role) continue
      const fields = normalizePlannedTextFields(role, row.fields)
      if (!fields) continue
      item.role = role
      item.fields = fields
      items.push(item)
      continue
    }
    const body = text(row.text, 200)
    if (body) item.text = body
    const anchor = normalizeSemanticRef(row.anchor, ctx)
    if (anchor) item.anchor = anchor
    items.push(item)
  }
  return items.sort((a, b) => a.at_s - b.at_s)
}

/**
 * 规范化。永远返回结构合法的设计卡（不抛错）：解析不到的引用保留并标 `unresolved`。
 * `raw` 不是对象时返回 `null`（视为「这一镜还没有设计卡」）。
 * `combo` 单独存于分镜列，由写入入口规范化；不写进设计卡 JSON。
 */
export function normalizeDesignCard(raw: unknown, ctx?: DesignCardContext): DesignCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>

  const layerRaw = row.layer_plan && typeof row.layer_plan === 'object' ? row.layer_plan as Record<string, unknown> : null
  const genRaw = row.gen_plan && typeof row.gen_plan === 'object' ? row.gen_plan as Record<string, unknown> : null
  const budgetRaw = row.budget && typeof row.budget === 'object' ? row.budget as Record<string, unknown> : {}

  const card: DesignCard = {
    version: 2,
    info_points: normalizeInfoPoints(row.info_points),
    budget: {
      layer_s: normalizeSeconds(budgetRaw.layer_s, MAX_LAYER_SEGMENT_SECONDS),
      gen_s: normalizeSeconds(budgetRaw.gen_s, MAX_GEN_SEGMENT_SECONDS),
    },
    rationale: text(row.rationale, MAX_RATIONALE),
    suggested_combo: toCombo(row.suggested_combo),
    issues: [],
  }

  if (layerRaw) {
    const mustMark: SemanticRef[] = []
    if (Array.isArray(layerRaw.must_mark)) {
      for (const entry of layerRaw.must_mark.slice(0, MAX_MUST_MARK)) {
        const ref = normalizeSemanticRef(entry, ctx)
        if (ref) mustMark.push(ref)
      }
    }
    card.layer_plan = {
      base: normalizeBaseRef(layerRaw.base, ctx),
      must_mark: mustMark,
      planned_layers: normalizePlannedLayers(layerRaw.planned_layers, ctx),
    }
    // #96：成套位置只认规范里的视频版式（Poster 版式不能被写进分镜设计卡）
    const located = textLayoutById(typeof layerRaw.text_layout === 'string' ? layerRaw.text_layout.trim() : null)
    if (located && located.medium === 'video') card.layer_plan.text_layout = located.layout.id
  }

  if (genRaw) {
    const refs: AssetRef[] = []
    if (Array.isArray(genRaw.reference_assets)) {
      for (const entry of genRaw.reference_assets.slice(0, MAX_MUST_MARK)) {
        const ref = normalizeAssetRef(entry, ctx)
        if (ref) refs.push(ref)
      }
    }
    const plan: GenPlan = { reference_assets: refs }
    const first = text(genRaw.first, MAX_FRAME_TEXT)
    const mid = text(genRaw.mid, MAX_FRAME_TEXT)
    const last = text(genRaw.last, MAX_FRAME_TEXT)
    if (first) plan.first = first
    if (mid) plan.mid = mid
    if (last) plan.last = last
    card.gen_plan = plan
  }

  return card
}

// ---------- 模板文本框（#96） ----------

/** 设计卡按项目画幅的规范家族排版：容量与自检都用这套标准成片尺寸（引擎口径）。 */
export function textPlanSize(aspect: string): { width: number; height: number } {
  const family = orientationOf(aspect) === 'portrait' ? '9:16' : '16:9'
  return TEXT_CANONICAL_SIZES[`${family}/video`]
}

/**
 * 设计卡里的模板文本框 → 临时图层文档（与草稿同构：id 按计划顺序、`text_layout` 取卡片值）。
 * 排版引擎据此判定溢出、缺字段、同拍冲突等；草稿阶段再用同一份数据落成真正的图层段。
 */
export function textPlanDoc(card: DesignCard | null): LayerDoc {
  const planned = (card?.layer_plan?.planned_layers || []).filter(layer => layer.type === 'text')
  const textLayout = card?.layer_plan?.text_layout
  return normalizeLayerDoc({
    version: 1,
    base: { path: '', width: 1, height: 1 },
    ...(textLayout ? { text_layout: textLayout } : {}),
    layers: planned.map((item, index) => ({
      id: `text-${index + 1}`,
      type: 'text',
      role: item.role,
      fields: item.fields,
    })),
  })
}

/**
 * 同屏拍 = 依次显现后同一时刻可见的文本框集合。与草稿共用 `layer-text-visibility` 的规则：
 * 同 zone 的框后出现的替换先出现的，`at_s` 相同的框同时出现（同区即冲突）。
 * id 与 `textPlanDoc` 一致（`text-{计划序号}`），两边的结论逐拍对得上。
 */
export function textPlanBeats(card: DesignCard | null): string[][] {
  const planned = (card?.layer_plan?.planned_layers || []).filter(layer => layer.type === 'text')
  return revealBeats(planned.map((item, index) => ({
    id: `text-${index + 1}`,
    zone: textZoneOf(card?.layer_plan?.text_layout, item.role || ''),
    at: item.at_s,
  })))
}

/**
 * 设计卡的模板文本框问题（引擎结论；阻断 = 出不了成品，警告 = 会被自动缩小或与标注重叠）。
 * `aspect` 是判定输入（画幅家族决定容量与套位是否合法），**没有画幅事实就不算**：
 * 猜一个横版会误伤竖屏项目的套位，而读到这条结论的路径都带着项目画幅（`DesignCardContext.aspect`）。
 */
export function textPlanProblems(card: DesignCard | null, aspect?: string | null): TextProblem[] {
  const doc = textPlanDoc(card)
  if (!doc.layers.some(layer => layer.type === 'text')) return []
  if (!aspect) return []
  return textLayerProblems(doc, textPlanSize(aspect), { beats: textPlanBeats(card) })
}

/** 某套某类型的字段容量（引擎数字，绝不在提示词里硬编码）：给模型「该写多短」的可执行上限。 */
function describeTextCapacity(layoutId: string, roleId: string): string {
  const capacity: TextFieldCapacity[] = textCapacity(layoutId, roleId)
  if (!capacity.length) return ''
  return capacity.map(item => {
    const limit = item.kind === 'list'
      ? `最多 ${item.max_items} 条，每条 ${item.chars_per_line} 字 × ${item.max_lines} 行`
      : `每行 ${item.chars_per_line} 字 × ${item.max_lines} 行 = 最多 ${item.max_chars} 字`
    return `${item.label}（${item.field}）${limit}${item.optional ? '，可选' : '，必填'}`
  }).join('；')
}

/** AI 写入路径的文本框硬规则（人工写入不受限，只吃读时问题） */
export interface TextPlanRejection {
  code: 'card_layer_rejected' | 'label_unanchored' | 'text_layout_missing' | 'text_role_invalid' | 'text_plan_invalid'
  layer_index: number | null
  message: string
}

/**
 * AI 写入路径的模板文本框硬规则：任何 `card`、没有锚点的 `label`、有文本框却没选成套位置、
 * 以及引擎的阻断级问题（溢出 / 缺必填字段 / 同拍冲突 / 画幅不符）都不许落库。
 * 拒信里带上引擎算出的字段容量，模型才知道该改多短（写作口径：改短 → 拆拍 → 换类型）。
 */
export function aiTextPlanRejections(
  card: DesignCard | null,
  aspect?: string | null,
  /**
   * 模型原始写进来的 `planned_layers`：规范化会把 `role` 缺失或未知的 text 层整层丢弃，
   * 从规范化结果里看不出模型写错了什么，所以规则按**原文**判一次，绝不静默丢文字。
   */
  rawPlanned?: unknown,
): TextPlanRejection[] {
  if (!card) return []
  const plan = card.layer_plan
  const out: TextPlanRejection[] = []
  if (Array.isArray(rawPlanned)) {
    rawPlanned.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return
      const row = entry as Record<string, unknown>
      if (String(row.type || '').trim().toLowerCase() !== 'text') return
      const role = typeof row.role === 'string' ? row.role.trim() : ''
      if (role && TEXT_SPEC.roles[role]) return
      out.push({
        code: 'text_role_invalid',
        layer_index: index,
        message: `第 ${index + 1} 层是 text，但 ${role ? `role「${role}」不在规范里` : '没有写 role'}。role 只能逐字取自 read_storyboard_context 的 text_spec.roles（${textRolesFor('video').join(' / ')}），字段必须按该类型的 fields 填写。`,
      })
    })
  }
  for (const [index, layer] of (plan?.planned_layers || []).entries()) {
    if (layer.type === 'card') {
      out.push({
        code: 'card_layer_rejected',
        layer_index: index,
        message: `第 ${index + 1} 层用了 card。分镜的屏幕文字现在只用模板文本框（type:'text' + role + fields + layer_plan.text_layout），card 不再允许：把它的标题/年代拆到 date、heading、statement 等类型里去。`,
      })
    }
    if (layer.type === 'label' && !layer.anchor) {
      out.push({
        code: 'label_unanchored',
        layer_index: index,
        message: `第 ${index + 1} 层是没有锚点的 label（「${layer.text || '无文字'}」）。屏幕排版文字一律用模板文本框；label 只用于把文字钉在底图某个语义位置上（必须带 anchor）。`,
      })
    }
  }
  const hasText = (plan?.planned_layers || []).some(layer => layer.type === 'text')
  if (hasText && !plan?.text_layout) {
    out.push({
      code: 'text_layout_missing',
      layer_index: null,
      message: '有计划文本框但没有选成套位置：layer_plan.text_layout 必须从 read_storyboard_context 的 text_spec.layouts 里按底图主体位置选一套。',
    })
  }
  const layoutId = plan?.text_layout
  for (const problem of textPlanProblems(card, aspect)) {
    if (problem.level !== 'error') continue
    // 缺套已经在上面报过一次，不重复
    if (problem.code === 'text_layout_missing') continue
    const index = problem.layer_id ? Number(problem.layer_id.replace(/^text-/, '')) - 1 : null
    const layer = index !== null ? (plan?.planned_layers || []).filter(item => item.type === 'text')[index] : undefined
    const capacity = layer?.role && layoutId ? describeTextCapacity(layoutId, layer.role) : ''
    out.push({
      code: 'text_plan_invalid',
      layer_index: index,
      message: `${problem.message}${capacity ? `。这一套里「${TEXT_SPEC.roles[layer!.role!]?.name ?? layer!.role}」的字段容量：${capacity}` : ''}。处置顺序：改短 → 拆成多拍（不同 at_s）→ 换成更合适的类型；自动缩小只是兜底，不能当常规容量。`,
    })
  }
  return out
}

/** 工具拒绝时回给模型的正文（与 groundingRejectionMessage 同形） */
export function textPlanRejectionMessage(rejections: TextPlanRejection[]): string {
  return [
    '设计卡没有保存：模板文本框的计划还不合法。',
    ...rejections.map((item, index) => `${index + 1}. ${item.message}`),
    '请按 read_storyboard_context 返回的 text_spec 改正后重新调用 update_storyboard：layouts 决定成套位置，'
    + 'roles 决定类型与字段，capacity 给出这一套每个字段的字数上限（numbers 来自引擎，不要凭记忆估算）。'
    + '不要用 card、不要在屏幕排版时用没有锚点的 label，也不要删掉文本框改成纯旁白。',
  ].join('\n')
}

export interface CardBudget {
  layer_s: number | null
  gen_s: number | null
  total_s: number
  /** 旁白时长：配音后用实测值，否则按 4.5 字/秒估算 */
  narration_s: number
  measured: boolean
  remain_s: number
}

/**
 * 预算与旁白的关系。配音后传实测值（`durationFromAudio` 的结果）——
 * 实测值**只重算问题**，绝不回写 `budget`（契约 §3.1）。
 */
export function estimateCardBudget(
  card: DesignCard | null,
  narrationText: string | null | undefined,
  measuredSeconds?: number | null,
): CardBudget {
  const layerS = card?.budget.layer_s ?? null
  const genS = card?.budget.gen_s ?? null
  const total = Math.round(((layerS ?? 0) + (genS ?? 0)) * 10) / 10
  const measured = typeof measuredSeconds === 'number' && Number.isFinite(measuredSeconds) && measuredSeconds > 0
  const narration = measured ? Math.round(measuredSeconds! * 10) / 10 : estimateNarrationSeconds(narrationText)
  return {
    layer_s: layerS,
    gen_s: genS,
    total_s: total,
    narration_s: narration,
    measured,
    remain_s: Math.round((total - narration) * 10) / 10,
  }
}

export interface CardValidateInput {
  card: DesignCard | null
  combo: Combo | null
  narrationText?: string | null
  /** 配音实测秒数；给了就按它判「装不装得下」 */
  measuredSeconds?: number | null
  /** 本镜提示词里已经 @ 到的资产；未提供时跳过 `reference_not_mentioned` */
  mentioned?: Array<{ kind: AssetKindName; id: number }> | null
  /** 项目画幅（#96）：模板文本框按它的规范家族排版与校验；缺省时跳过文本框判定 */
  aspect?: string | null
}

/**
 * 校验分级（契约 §3.1）：
 * 阻断 = 未选 combo / 预算超限 / 总时长 < 旁白 / A·C·D 无底图 / B·C·D 缺非锁定槽位描述 /
 *        模板文本框不合法（溢出、缺必填字段、同拍冲突、画幅不符）；
 * 警告 = 信息点无归属 / must_mark 未被计划图层锚定 / 参考素材未被 @ / 余量偏紧 / 引用解析不到 /
 *        文本框会被自动缩小或与锚定标注重叠。
 */
export function validateDesignCard(input: CardValidateInput): CardIssue[] {
  const { card, combo } = input
  const issues: CardIssue[] = []
  const add = (code: CardIssueCode, severity: 'block' | 'warn', message: string, index?: number) => {
    issues.push(index === undefined ? { code, severity, message } : { code, severity, message, index })
  }

  if (!combo) add('combo_missing', 'block', '还没有选段组合：A 只用图层 / B 只用生成 / C 图层→生成 / D 生成→图层，必须显式选一个')
  if (!card) return issues

  const budget = estimateCardBudget(card, input.narrationText, input.measuredSeconds)
  if ((budget.layer_s ?? 0) > MAX_LAYER_SEGMENT_SECONDS) {
    add('budget_over_layer', 'block', `图层段 ${budget.layer_s}s 超过硬上限 ${MAX_LAYER_SEGMENT_SECONDS}s`)
  }
  if ((budget.gen_s ?? 0) > MAX_GEN_SEGMENT_SECONDS) {
    add('budget_over_gen', 'block', `生成段 ${budget.gen_s}s 超过硬上限 ${MAX_GEN_SEGMENT_SECONDS}s`)
  }
  const budgetMissing = !combo
    || (hasLayerSegment(combo) && budget.layer_s === null)
    || (hasGenSegment(combo) && budget.gen_s === null)
  if (combo && budgetMissing) add('budget_missing', 'block', '请填写每个启用段的时长预算')
  if (!budgetMissing && budget.narration_s > 0 && budget.total_s < budget.narration_s) {
    add('budget_under_narration', 'block',
      `总时长 ${budget.total_s}s 装不下旁白（${budget.measured ? '实测' : '估'} ${budget.narration_s}s），需加长段或精简画面`)
  } else if (!budgetMissing && budget.narration_s > 0 && budget.remain_s < BUDGET_TIGHT_SECONDS) {
    add('budget_tight', 'warn', `余量只剩 ${budget.remain_s}s，偏紧`)
  }

  if (hasLayerSegment(combo) && !card.layer_plan?.base) {
    add('missing_base', 'block', '图层段没有底图：请选一张已核验的忠实原件/已生成图，或选择承接上一镜')
  }

  if (hasGenSegment(combo)) {
    const locked = lockedGenSlot(combo)
    const needed: Array<'first' | 'last'> = (['first', 'last'] as const).filter(slot => slot !== locked)
    for (const slot of needed) {
      if (!(card.gen_plan?.[slot] || '').trim()) {
        add('gen_slot_missing', 'block',
          `生成段缺${slot === 'first' ? '首' : '尾'}帧描述${locked ? `（${locked === 'first' ? '首' : '尾'}帧由衔接帧锁定继承）` : ''}`)
      }
    }
  }

  card.info_points.forEach((point, index) => {
    const ok = point.via === 'narration_only'
      || (point.via === 'layer' && hasLayerSegment(combo))
      || (point.via === 'generated' && hasGenSegment(combo))
    if (!ok) {
      add('info_point_unassigned', 'warn',
        `信息点「${point.text}」计划由${point.via === 'layer' ? '图层段' : '生成段'}表达，但本镜的段组合里没有这一段`, index)
    }
  })

  const plannedAnchors = new Set(
    (card.layer_plan?.planned_layers || [])
      .map(layer => layer.anchor ? `${layer.anchor.asset_id}:${layer.anchor.semantic_id}` : '')
      .filter(Boolean),
  )
  ;(card.layer_plan?.must_mark || []).forEach((ref, index) => {
    if (!plannedAnchors.has(`${ref.asset_id}:${ref.semantic_id}`)) {
      add('must_mark_not_planned', 'warn', `必须标注的「${ref.name || ref.semantic_id}」还没有任何计划图层锚定它`, index)
    }
  })

  if (input.mentioned) {
    const mentioned = new Set(input.mentioned.map(ref => `${ref.kind}:${ref.id}`))
    ;(card.gen_plan?.reference_assets || []).forEach((ref, index) => {
      if (ref.unresolved) return
      if (!mentioned.has(`${ref.kind}:${ref.id}`)) {
        add('reference_not_mentioned', 'warn', `参考素材「${ref.name}」还没有被本镜的关键帧提示词 @ 到`, index)
      }
    })
  }

  const unresolved: string[] = []
  const base = card.layer_plan?.base
  if (base && base.kind === 'asset' && base.unresolved) unresolved.push(base.unresolved_reason || '底图解析不到')
  for (const ref of card.layer_plan?.must_mark || []) if (ref.unresolved) unresolved.push(ref.unresolved_reason || `必须标注「${ref.name}」解析不到`)
  for (const layer of card.layer_plan?.planned_layers || []) {
    if (layer.anchor?.unresolved) unresolved.push(layer.anchor.unresolved_reason || '计划图层的锚点解析不到')
  }
  for (const ref of card.gen_plan?.reference_assets || []) if (ref.unresolved) unresolved.push(ref.unresolved_reason || `参考素材「${ref.name}」解析不到`)
  for (const [index, reason] of unresolved.entries()) add('unresolved_ref', 'warn', reason, index)

  // #96：模板文本框的引擎结论（溢出 / 缺必填字段 / 同拍冲突 / 画幅不符 = 阻断）
  for (const problem of textPlanProblems(card, input.aspect)) {
    if (problem.level === 'error') add('text_plan_invalid', 'block', problem.message)
    else add('text_plan_warning', 'warn', problem.message)
  }

  return issues
}

/** 库里的 JSON 文本 → 设计卡（坏数据返回 null，不抛） */
export function parseDesignCard(raw: string | null | undefined, ctx?: DesignCardContext): DesignCard | null {
  if (!raw) return null
  try {
    return normalizeDesignCard(JSON.parse(raw), ctx)
  } catch {
    return null
  }
}

/** 落库前去掉读时重算的 `issues` */
export function serializeDesignCard(card: DesignCard | null): string | null {
  if (!card) return null
  const { issues: _issues, ...rest } = card
  return JSON.stringify(rest)
}

/** 该镜要求关键帧/视频提示词必须 @ 到的资产（生成段的参考素材） */
export function referenceAssetRefs(card: DesignCard | null, combo: Combo | null): Array<{ kind: AssetKindName; id: number }> {
  if (!card || !hasGenSegment(combo)) return []
  const refs: Array<{ kind: AssetKindName; id: number }> = []
  for (const ref of card.gen_plan?.reference_assets || []) {
    if (ref.unresolved) continue
    if (!refs.some(r => r.kind === ref.kind && r.id === ref.id)) refs.push({ kind: ref.kind, id: ref.id })
  }
  return refs
}

/**
 * 保留短稿防过拆上限，同时容纳每段按单镜旁白字数上限合法切分所需的镜数。
 * 输入为去掉节拍标记、按空行切分的剧本段落；空稿返回 0（不启用）。
 */
export function storyboardCountCap(paragraphs: readonly string[]): number {
  if (!paragraphs.length) return 0
  const shortCap = Math.min(Math.ceil(paragraphs.length * 1.5), paragraphs.length + 3)
  const narrationMinimum = paragraphs.reduce((sum, paragraph) =>
    sum + Math.ceil(narrationCharCount(paragraph) / MAX_NARRATION_CHARS), 0)
  return Math.max(shortCap, narrationMinimum)
}
