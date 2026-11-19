/**
 * 地图资产的**动态反查引用**（Issue #125）— 「分镜引用资产；资产侧读时现算被哪些分镜引用」。
 *
 * 资产先于分镜设计：做地图时不知道分镜，所以镜号（`storyboard_numbers`）既不能当资产身份，
 * 也不能当引用依据。唯一的引用事实是分镜自己写下的引用：
 *
 * 计划态（design_card，读时解析，不落快照）：
 * - `layer_plan.base` → `base`
 * - `layer_plan.must_mark[]` → `mark`
 * - `layer_plan.planned_layers[].anchor` → `layer`
 * - `gen_plan.reference_assets[]` → `gen`（键是 `id`，不是 `asset_id`）
 * 已落态（成品事实）：
 * - `storyboard_layer_segments.base_ref`（旧行无 base_ref 时退 `layer_doc.base.ref`）→ `segment`
 * - `storyboard_target_assets(kind, asset_id)` → `target`
 *
 * 扫描范围 = 本资产所属项目内未删除分镜（同步读库 + JSON.parse，与设计卡上下文同口径）。
 * 返回按分镜聚合、`vias` 去重，并显式分开 `planned` / `materialized` —— 界面据此显示
 * 「已落段 n / 仅规划 m」，失效传播据此只对已落段追加 `layer_segment` 理由。
 *
 * 纯函数（`referenceViasOf` / `segmentBaseAssetId` / `aggregateReferences`）单独导出给行为测试。
 */
import { sqlite } from '../db/index.js'
import { parseDesignCard, type DesignCard } from './design-card.js'

export const MAP_REFERENCE_VIAS = ['base', 'mark', 'layer', 'gen', 'segment', 'target'] as const
export type MapReferenceVia = typeof MAP_REFERENCE_VIAS[number]
/** 设计卡里的引用（还没落成段） */
export const PLANNED_VIAS: readonly MapReferenceVia[] = ['base', 'mark', 'layer', 'gen']
/** 已落成段/目标资产的引用 */
export const MATERIALIZED_VIAS: readonly MapReferenceVia[] = ['segment', 'target']

export interface MapAssetReference {
  episode_id: number
  episode_number: number
  storyboard_id: number
  storyboard_number: number
  /** 去重后的引用路径（顺序按 MAP_REFERENCE_VIAS） */
  vias: MapReferenceVia[]
  planned: boolean
  materialized: boolean
}

export interface MapAssetReferences {
  asset_id: number
  drama_id: number
  /** 引用该资产的分镜条数（= references.length） */
  total: number
  /** 只有设计卡计划、还没落段的分镜条数 */
  planned: number
  /** 已有图层段 / 目标资产引用该资产的分镜条数 */
  materialized: number
  references: MapAssetReference[]
}

/** 单条反查输入（读库行；纯函数测试直接构造） */
export interface ReferenceRowInput {
  episode_id: number
  episode_number: number
  storyboard_id: number
  storyboard_number: number
  design_card: string | null
  /** `storyboard_layer_segments.base_ref` 原文；没有段时 null */
  segment_base_ref: string | null
  /** `storyboard_layer_segments.layer_doc` 原文（仅当 base_ref 缺失时用来找 `base.ref`） */
  segment_layer_doc: string | null
  /** `storyboard_target_assets` 里指向该资产的行数 */
  target_rows: number
}

/** 设计卡里指向该资产的全部引用路径（纯函数；`card` 用 `parseDesignCard` 解析，不需要上下文） */
export function referenceViasOf(card: DesignCard | null, assetId: number): MapReferenceVia[] {
  const vias = new Set<MapReferenceVia>()
  const plan = card?.layer_plan
  if (plan) {
    if (plan.base?.kind === 'asset' && plan.base.asset_id === assetId) vias.add('base')
    for (const ref of plan.must_mark ?? []) if (ref.asset_id === assetId) vias.add('mark')
    for (const layer of plan.planned_layers ?? []) {
      if (layer.anchor && layer.anchor.asset_id === assetId) vias.add('layer')
    }
  }
  for (const ref of card?.gen_plan?.reference_assets ?? []) if (ref.id === assetId) vias.add('gen')
  return MAP_REFERENCE_VIAS.filter(via => vias.has(via))
}

/**
 * 图层段的底图资产 id（纯函数）：`base_ref` 与 `layer_doc.base.ref` 同口径，
 * 与 `segment-source-refresh.ts` 的 `baseReference()` 一致（`layer_doc` 里的更精确，优先）。
 */
export function segmentBaseAssetId(baseRefJson: string | null, layerDocJson: string | null): number | null {
  const parse = (raw: string | null): unknown => {
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  /** 设计卡/段底图引用（`{kind:'asset', asset_id}`）→ id；其余形状（`inherit_prev`、缺字段）返回 null */
  const assetIdOf = (ref: unknown): number | null => {
    if (!ref || typeof ref !== 'object') return null
    const row = ref as Record<string, unknown>
    return row.kind === 'asset' && typeof row.asset_id === 'number' && Number.isInteger(row.asset_id) && row.asset_id > 0
      ? row.asset_id
      : null
  }
  /**
   * `layer_doc.base.ref` 的形状是 `{asset_id, asset_kind, version_task_id}`（没有 `kind`，
   * 见 `layer-doc.ts` 的 LayerAssetRef）：有 asset_kind 就是指向某个资产。
   */
  const layerRefIdOf = (ref: unknown): number | null => {
    if (!ref || typeof ref !== 'object') return null
    const row = ref as Record<string, unknown>
    return typeof row.asset_kind === 'string' && row.asset_kind
      && typeof row.asset_id === 'number' && Number.isInteger(row.asset_id) && row.asset_id > 0
      ? row.asset_id
      : null
  }
  const doc = parse(layerDocJson)
  const docBase = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).base : null
  const docRef = docBase && typeof docBase === 'object' ? (docBase as Record<string, unknown>).ref : null
  const fromDoc = layerRefIdOf(docRef)
  if (fromDoc !== null) return fromDoc
  return assetIdOf(parse(baseRefJson))
}

/** 设计卡 + 段 + 目标资产 → 单镜的引用路径（纯函数） */
export function viasOfRow(row: ReferenceRowInput, assetId: number): MapReferenceVia[] {
  const vias = new Set<MapReferenceVia>(referenceViasOf(parseDesignCard(row.design_card), assetId))
  if (segmentBaseAssetId(row.segment_base_ref, row.segment_layer_doc) === assetId) vias.add('segment')
  if (row.target_rows > 0) vias.add('target')
  return MAP_REFERENCE_VIAS.filter(via => vias.has(via))
}

/**
 * 聚合（纯函数）：按镜一条、`vias` 去重、按集号/镜号排序；去掉没有任何引用的镜。
 * `planned` / `materialized` 是两条独立的布尔值——一镜可以两者都是（卡已填且段已落）。
 */
export function aggregateReferences(rows: ReferenceRowInput[], assetId: number): MapAssetReferences {
  const references: MapAssetReference[] = []
  for (const row of rows) {
    const vias = viasOfRow(row, assetId)
    if (!vias.length) continue
    references.push({
      episode_id: row.episode_id,
      episode_number: row.episode_number,
      storyboard_id: row.storyboard_id,
      storyboard_number: row.storyboard_number,
      vias,
      planned: vias.some(via => PLANNED_VIAS.includes(via)),
      materialized: vias.some(via => MATERIALIZED_VIAS.includes(via)),
    })
  }
  references.sort((a, b) => a.episode_number - b.episode_number || a.storyboard_number - b.storyboard_number)
  return {
    asset_id: assetId,
    drama_id: 0,
    total: references.length,
    planned: references.filter(item => item.planned && !item.materialized).length,
    materialized: references.filter(item => item.materialized).length,
    references,
  }
}

/** 引用扫描的读库行：本资产所属项目内未删除分镜 + 段底图引用 + 目标资产命中数 */
function referenceRows(dramaId: number, assetId: number): ReferenceRowInput[] {
  const rows = sqlite.prepare(`
    SELECT s.id AS storyboard_id, s.storyboard_number, s.episode_id, e.episode_number, s.design_card,
      ls.base_ref AS segment_base_ref, ls.layer_doc AS segment_layer_doc,
      (SELECT COUNT(*) FROM storyboard_target_assets t WHERE t.storyboard_id = s.id AND t.asset_id = ? AND t.kind = 'prop') AS target_rows
    FROM storyboards s
    JOIN episodes e ON e.id = s.episode_id
    LEFT JOIN storyboard_layer_segments ls ON ls.storyboard_id = s.id
    WHERE s.deleted_at IS NULL AND e.deleted_at IS NULL AND e.drama_id = ?
    ORDER BY e.episode_number, s.storyboard_number
  `).all(assetId, dramaId) as Array<{
    storyboard_id: number; storyboard_number: number; episode_id: number; episode_number: number
    design_card: string | null; segment_base_ref: string | null; segment_layer_doc: string | null; target_rows: number
  }>
  return rows
}

function propOf(propId: number): { id: number; drama_id: number; deleted: number; asset_type: string | null } | null {
  const row = sqlite.prepare('SELECT id, drama_id, deleted_at, asset_type FROM props WHERE id = ?').get(propId) as
    { id: number; drama_id: number; deleted_at: string | null; asset_type: string | null } | undefined
  return row ? { id: row.id, drama_id: row.drama_id, deleted: row.deleted_at ? 1 : 0, asset_type: row.asset_type } : null
}

/** `GET /props/:id/map-references` 的数据体；不是地图资产/已删除时返回 null */
export function mapAssetReferences(propId: number): MapAssetReferences | null {
  const prop = propOf(propId)
  if (!prop || prop.deleted || prop.asset_type !== 'map') return null
  const refs = aggregateReferences(referenceRows(prop.drama_id, prop.id), prop.id)
  return { ...refs, drama_id: prop.drama_id }
}

/**
 * 被该资产引用的分镜 id（失效传播用）：`planned` = 设计卡计划，`materialized` = 已落段/目标资产。
 * 资产不存在时返回空集合。
 */
export function storyboardsReferencing(propId: number): { planned: number[]; materialized: number[] } {
  const prop = propOf(propId)
  if (!prop) return { planned: [], materialized: [] }
  const refs = aggregateReferences(referenceRows(prop.drama_id, prop.id), prop.id).references
  return {
    planned: refs.filter(item => item.planned).map(item => item.storyboard_id),
    materialized: refs.filter(item => item.materialized).map(item => item.storyboard_id),
  }
}

/**
 * 设计卡/图层段里对某个资产的**语义条目 id** 引用（修复脚本的 unresolved 排查用，纯函数）。
 * 返回 `{ storyboard_id, asset_id, semantic_ids }`，`semantic_ids` 去重。
 */
export function semanticRefsOfRow(row: ReferenceRowInput, assetId: number): string[] {
  const ids = new Set<string>()
  const card = parseDesignCard(row.design_card)
  const add = (ref: { asset_id?: number; semantic_id?: string } | undefined) => {
    if (!ref || ref.asset_id !== assetId) return
    const id = typeof ref.semantic_id === 'string' ? ref.semantic_id.trim() : ''
    if (id) ids.add(id)
  }
  for (const ref of card?.layer_plan?.must_mark ?? []) add(ref)
  for (const layer of card?.layer_plan?.planned_layers ?? []) add(layer.anchor)
  return [...ids]
}

/** 读库版：某资产被引用的语义条目 id 清单（`storyboard_id → ids`） */
export function semanticRefsByStoryboard(propId: number): Array<{ storyboard_id: number; semantic_ids: string[] }> {
  const prop = propOf(propId)
  if (!prop) return []
  return referenceRows(prop.drama_id, prop.id)
    .map(row => ({ storyboard_id: row.storyboard_id, semantic_ids: semanticRefsOfRow(row, prop.id) }))
    .filter(item => item.semantic_ids.length > 0)
}

// ─── 资产内容变更时间（组规划新鲜的读时判据）──────────────────────────

/**
 * 资产「内容已被交付改写」的时间戳：写在 `props.map_pip` 里（全览与细节）。
 * 只在复用的细节行**语义要素 id 集合变化**时写入（内容换了一批地理对象）；
 * 过期（最新方案里没有这个细节）的行同样算内容变化，取 `updated_at`。
 * 这张表只读已有列，组规划新鲜度在读取时现算，不落新列。
 */
export function assetContentChangedAt(propId: number): string | null {
  const row = sqlite.prepare('SELECT map_pip, updated_at FROM props WHERE id = ?').get(propId) as
    { map_pip: string | null; updated_at: string | null } | undefined
  if (!row) return null
  let meta: { content_changed_at?: unknown; stale?: unknown } | null
  try { meta = JSON.parse(row.map_pip ?? 'null') as { content_changed_at?: unknown; stale?: unknown } | null } catch { meta = null }
  const at = typeof meta?.content_changed_at === 'string' && meta.content_changed_at ? meta.content_changed_at : null
  if (at) return at
  return meta?.stale === true ? row.updated_at ?? null : null
}

// ─── 图层段横幅（Issue #125 §4）───────────────────────────────────────

/** 让段底图失效的理由（段自己的 stale_reasons；不新增列、不用快照） */
export const BASE_ASSET_STALE_REASONS = ['base_version_changed', 'asset_version_changed', 'semantic_changed'] as const

export interface BaseAssetUpdateNotice {
  asset_kind: 'prop' | 'scene' | 'character'
  asset_id: number
  asset_name: string
  /** 资产行更新时间（横幅里给人看的时间） */
  updated_at: string
  /** 当前生效的图片版本（sys_task id）；没有版本时为 null */
  version_task_id: number | null
  /** 命中的失效理由 */
  reasons: string[]
  /**
   * 底图是地图「细节」资产：细节段在 #117 接入前仍是烧录 PNG + 语义重绘，
   * 横幅只写实际可做的动作（重渲段 / 换底图资产 / 重选细节资产），不写「换回旧版本」。
   */
  detail_asset: boolean
}

/**
 * 图层段顶部横幅的数据（纯读库）；没有命中资产失效理由时返回 null。
 * 动作由前端决定：重渲段 / 换底图 / 重选细节资产——都是编辑器里已有的操作。
 */
export function baseAssetUpdateNotice(
  baseRef: { kind?: string; asset_kind?: string; asset_id?: number } | null | undefined,
  staleReasons: string[],
): BaseAssetUpdateNotice | null {
  if (!baseRef || baseRef.kind !== 'asset' || typeof baseRef.asset_id !== 'number') return null
  const reasons = staleReasons.filter(reason => (BASE_ASSET_STALE_REASONS as readonly string[]).includes(reason))
  if (!reasons.length) return null
  const row = sqlite.prepare("SELECT id, name, updated_at, faithful_source, asset_type, map_pip FROM props WHERE id = ? AND deleted_at IS NULL").get(baseRef.asset_id) as
    { id: number; name: string; updated_at: string | null; faithful_source: number | null; asset_type: string | null; map_pip: string | null } | undefined
  if (!row) return null
  const version = row.faithful_source ?? (sqlite.prepare("SELECT id FROM sys_task WHERE prop_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1").get(row.id) as { id: number } | undefined)?.id ?? null
  let detail = false
  try { detail = (JSON.parse(row.map_pip ?? 'null') as { role?: string } | null)?.role === 'detail' } catch { detail = false }
  const kind = baseRef.asset_kind === 'scene' || baseRef.asset_kind === 'character' ? baseRef.asset_kind : 'prop'
  return {
    asset_kind: kind,
    asset_id: row.id,
    asset_name: row.name,
    updated_at: row.updated_at ?? '',
    version_task_id: version,
    reasons,
    detail_asset: detail && row.asset_type === 'map',
  }
}
