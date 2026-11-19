/**
 * 地图「画中画」资产的宿主侧登记（Issue #107 / #110 / #125）。
 *
 * 全览与细节是**独立资产**：全览 = 原地图道具；每个细节 = 一条独立的地图道具（asset_type='map'、faithful），
 * 与全览同项目、同剧集关联。联系与用法存在 `props.map_pip`（JSON）：
 * - 全览：`{role:'overview', layout, overview_bbox, frames:[{no,label,role,reason,bbox,focus_bbox,detail_prop_id}], composite_path, usage}`
 * - 细节：`{role:'detail', parent_prop_id, frame:{no,label,role,reason,bbox,focus_bbox}, overview_bbox, usage, stale?, content_changed_at?}`
 * 细节图的 `parent_frame` 就是 `frame.bbox`（大图中的位置，经纬度）。
 *
 * 身份与引用（Issue #125）：
 * - **镜号不再入库**。`storyboard_numbers` 是某个别的集的快照，跨集会误读；引用关系由
 *   `services/map-asset-references.ts` 读时反查（分镜引用资产，资产侧动态显示）。
 * - 复用一个旧细节行的判据是**取景重合**（新 `frame.bbox` 与旧 `meta.frame.bbox` 的 IoU ≥ 0.5，
 *   贪心一对一）：取景整体换了就是一颗新资产，绝不把旧语义/旧名字套到新取景上。
 * - 字段所有权：几何与图片归交付；`description`/`keywords` 是条目级人工字段（`manual`），
 *   资产名被人工改过时记 `map_pip.name_manual`，交付不再覆盖。
 * - 复用行的语义要素 id 集合发生变化 = 资产地理内容换了 → 在 meta 里记 `content_changed_at`，
 *   宿主据此让引用它的设计卡、组规划与图层段显式过期（见 `map-studio-host.ts`）。
 *
 * 细节资产的语义（#110）：细节图是同一份 map_spec 的局部渲染，登记时把全览语义要素按细节取景
 * 投影成细节图像素坐标（`semantic_id` 与全览一致），写进细节道具的 `props.semantics`，
 * 设计卡才能在细节底图上 anchor / must_mark。
 */
import { sqlite } from '../db/index.js'
import {
  normalizeSemantics,
  parseSemantics,
  withGeneratedSupplements,
  type AssetSemantics,
  type SemanticSupplement,
} from './asset-semantics.js'
import { iou, type MapBbox } from '../modules/map-studio/pip/frames.js'
import { semanticAnnotationsOf } from './map-semantic-annotations.js'
import type { MapStudioDeliverable } from '../modules/map-studio/contract.js'

/** 复用旧细节行的最小取景重合（与 `pip/frames.ts` 的细节框互斥校验同一口径） */
export const PIP_DETAIL_MATCH_IOU = 0.5

export interface PipMetaOverview {
  version: 1
  role: 'overview'
  layout: unknown
  frames: Array<Record<string, unknown>>
  composite_path: string | null
  /** 全览取景（经纬度）：细节在图上的位置只有配合全览范围才读得懂 */
  overview_bbox?: [number, number, number, number]
  usage: string
  /** 本资产的语义要素 id 集合变过（内容换了）：引用它的组规划/设计卡读时过期（#125） */
  content_changed_at?: string
}
export interface PipMetaDetail {
  version: 1
  role: 'detail'
  parent_prop_id: number
  parent_name: string
  frame: Record<string, unknown>
  overview_bbox: [number, number, number, number]
  usage: string
  /** 最新方案里已经没有这个细节（资产保留，分镜可能已引用） */
  stale?: boolean
  /** 本行被复用但语义要素 id 集合变过（内容换了）：读时让引用它的东西过期（#125） */
  content_changed_at?: string
  /** 交付时算不出投影语义（保留旧值）：界面标「待人工修正」 */
  needs_review?: boolean
  /** 资产名被人工改过：交付不再覆盖系统命名（#125） */
  name_manual?: boolean
}
export type PipMeta = PipMetaOverview | PipMetaDetail

export function parsePipMeta(raw: string | null | undefined): PipMeta | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as PipMeta
    return v && (v.role === 'overview' || v.role === 'detail') ? v : null
  } catch { return null }
}

/** 细节图所属的全览道具 id；不是细节返回 null */
export function pipParentOf(propId: number): number | null {
  const row = sqlite.prepare('SELECT map_pip FROM props WHERE id = ?').get(propId) as { map_pip: string | null } | undefined
  const meta = parsePipMeta(row?.map_pip)
  return meta?.role === 'detail' ? meta.parent_prop_id : null
}

// ─── 细节资产身份：一对一 IoU 匹配（Issue #125）──────────────────────────

function usableBbox(value: unknown): value is MapBbox {
  return Array.isArray(value) && value.length === 4
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && value[0] < value[2] && value[1] < value[3]
}

export interface PipMatchResult {
  /** `no` = 新细节框编号，`prop_id` = 复用的旧细节资产 */
  matches: Array<{ no: number; prop_id: number; iou: number }>
  /** 没有可复用旧行的新细节框（新建资产） */
  unmatched_frames: number[]
  /** 没有被任何新框复用的旧细节资产（标记过期，不删除） */
  unmatched_props: number[]
}

/**
 * 细节资产的**一对一 IoU 匹配**（纯函数）：新框 × 旧行按 IoU 降序贪心配对，≥0.5 复用。
 * 零面积/非法 bbox 一律新建（不参与比较）——宁可多一颗资产，也不把旧内容套到新取景上。
 * 用任务 4 的真实帧对校准过：0.5 阈值下恰好恢复 1→1、2→3、3→4，新细节 2 新建。
 */
export function matchPipDetailRows(
  frames: Array<{ no: number; bbox: unknown }>,
  prior: Array<{ prop_id: number; bbox: unknown }>,
): PipMatchResult {
  const candidates: Array<{ no: number; prop_id: number; score: number }> = []
  for (const frame of frames) {
    if (!usableBbox(frame.bbox)) continue
    for (const row of prior) {
      if (!usableBbox(row.bbox)) continue
      const score = iou(frame.bbox, row.bbox)
      if (score >= PIP_DETAIL_MATCH_IOU) candidates.push({ no: frame.no, prop_id: row.prop_id, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.no - b.no)
  const matches: PipMatchResult['matches'] = []
  const usedFrames = new Set<number>()
  const usedProps = new Set<number>()
  for (const candidate of candidates) {
    if (usedFrames.has(candidate.no) || usedProps.has(candidate.prop_id)) continue
    usedFrames.add(candidate.no)
    usedProps.add(candidate.prop_id)
    matches.push({ no: candidate.no, prop_id: candidate.prop_id, iou: Math.round(candidate.score * 1000) / 1000 })
  }
  return {
    matches,
    unmatched_frames: frames.map(frame => frame.no).filter(no => !usedFrames.has(no)),
    unmatched_props: prior.map(row => row.prop_id).filter(id => !usedProps.has(id)),
  }
}

// ─── 登记 ────────────────────────────────────────────────────────────

interface ParentRow { id: number; name: string; drama_id: number }

interface PriorDetail {
  prop_id: number
  name: string
  meta: PipMetaDetail
  semantics: AssetSemantics | null
}

/** 登记结果：`contentChanged` = 内容换了（语义要素 id 集合变化）的资产 id，供失效传播使用 */
export interface PipRegisterOutcome {
  contentChanged: number[]
  /** 每个细节框复用/新建的配对（交付留痕） */
  matches: PipMatchResult
}

/** 语义文档里的全部条目 id（内容是否换了一批地理对象的判据） */
export function semanticIdSet(doc: AssetSemantics | null): Set<string> {
  const ids = new Set<string>()
  if (!doc) return ids
  for (const entry of [...doc.points, ...doc.lines, ...doc.regions, ...doc.labels]) ids.add(entry.id)
  return ids
}

/** 两个 id 集合是否完全一致 */
export function sameSemanticIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** 交付语义几何（`delivery.semantics`）里的要素 id：points/lines/regions */
export function geometrySemanticIds(geometry: unknown): Set<string> {
  const ids = new Set<string>()
  const doc = geometry as { points?: Array<{ id?: unknown }>; lines?: Array<{ id?: unknown }>; regions?: Array<{ id?: unknown }> } | null
  if (!doc || typeof doc !== 'object') return ids
  for (const item of [...(doc.points ?? []), ...(doc.lines ?? []), ...(doc.regions ?? [])]) {
    if (typeof item?.id === 'string' && item.id) ids.add(item.id)
  }
  return ids
}

/**
 * 在交付事务内登记：按取景重合覆盖/新建细节资产、版本、剧集关联，并写全览的 `map_pip`。
 *
 * `parentContentChanged`：全览自己的语义要素 id 集合变了（宿主在覆盖 `props.semantics` 之前比对）。
 * 返回内容变更的资产 id（含全览），交给宿主做显式失效传播。
 */
export function registerPipAssets(
  parent: ParentRow,
  d: MapStudioDeliverable,
  ts: string,
  options: { parentContentChanged?: boolean } = {},
): PipRegisterOutcome {
  const pip = d.pip
  const existing = sqlite.prepare("SELECT id, name, map_pip, semantics FROM props WHERE drama_id = ? AND deleted_at IS NULL AND map_pip LIKE '%\"role\":\"detail\"%'").all(parent.drama_id) as Array<{ id: number; name: string; map_pip: string; semantics: string | null }>
  const prior: PriorDetail[] = []
  for (const row of existing) {
    const meta = parsePipMeta(row.map_pip)
    if (meta?.role !== 'detail' || meta.parent_prop_id !== parent.id) continue
    prior.push({ prop_id: row.id, name: row.name, meta, semantics: parseSemantics(row.semantics) })
  }
  const priorById = new Map(prior.map(row => [row.prop_id, row]))
  const annotations: Map<string, SemanticSupplement> = semanticAnnotationsOf(d.features ?? [], d.sources ?? [])

  const insertTask = sqlite.prepare(`INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at, completed_at, generated_at)
    VALUES ('image', ?, ?, 'map-render', 'map-studio-detail', ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
  const epoch = Math.floor(Date.parse(ts) / 1000)
  const parentEpisodes = sqlite.prepare('SELECT DISTINCT episode_id FROM episode_props WHERE prop_id = ?').all(parent.id) as Array<{ episode_id: number }>
  const link = sqlite.prepare('INSERT INTO episode_props (episode_id, prop_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM episode_props WHERE episode_id = ? AND prop_id = ?)')

  const frameRows: Array<Record<string, unknown>> = []
  const contentChanged: number[] = []
  const matches = pip
    ? matchPipDetailRows(
      pip.frames.map(frame => ({ no: frame.no, bbox: frame.bbox })),
      prior.map(row => ({ prop_id: row.prop_id, bbox: row.meta.frame?.bbox })),
    )
    : { matches: [], unmatched_frames: [], unmatched_props: [] }
  const matchByNo = new Map(matches.matches.map(item => [item.no, item.prop_id]))
  if (pip) {
    for (const frame of pip.frames) {
      const image = pip.details.find(item => item.no === frame.no)
      if (!image) continue
      // #125：镜号不再落库（资产先于分镜设计，引用关系读时反查）
      const frameMeta = { no: frame.no, label: frame.label, role: frame.role, reason: frame.reason, bbox: frame.bbox, focus_bbox: frame.focus_bbox }
      const usage = `${pip.usage}\n\n本资产是细节${frame.no}「${frame.label}」，隶属全览《${parent.name}》（资产 #${parent.id}）；它在全览中的位置（经纬度）：${JSON.stringify(frame.bbox)}。`
      const generatedName = `${parent.name} · 细节${frame.no}（${frame.label}）`
      const previous = matchByNo.has(frame.no) ? priorById.get(matchByNo.get(frame.no)!) ?? null : null
      // 字段所有权（#125）：人工改过的名字保留，其余沿用系统命名
      const name = previous?.meta.name_manual ? previous.name : generatedName
      const previousIds = semanticIdSet(previous?.semantics ?? null)
      const projectedIds = image.semantics ? geometrySemanticIds(image.semantics) : new Set<string>()
      const contentGone = !!previous && previousIds.size > 0 && projectedIds.size > 0 && !sameSemanticIdSet(previousIds, projectedIds)
      const meta: PipMetaDetail = {
        version: 1, role: 'detail', parent_prop_id: parent.id, parent_name: parent.name, frame: frameMeta,
        overview_bbox: pip.overview_bbox, usage,
        ...(previous?.meta.name_manual ? { name_manual: true } : {}),
        ...(contentGone ? { content_changed_at: ts } : {}),
        ...(!image.semantics && previous ? { needs_review: true } : {}),
      }
      const description = `地图细节图：${frame.label}。${frame.reason}\n\n用法：\n${usage}`
      let childId: number
      if (previous) childId = previous.prop_id
      else {
        childId = Number(sqlite.prepare(`INSERT INTO props (drama_id, name, type, description, faithful, asset_type, created_at, updated_at) VALUES (?, ?, '地图细节图', ?, 1, 'map', ?, ?)`)
          .run(parent.drama_id, name, description, ts, ts).lastInsertRowid)
      }
      const versionId = Number(insertTask.run(childId, parent.drama_id, `地图细节图：${name}`,
        JSON.stringify({ source: 'map-studio', map_studio_task_id: d.task_id, role: 'detail', parent_prop_id: parent.id, frame: frameMeta, png_sha256: image.sha256, ...(image.provenance ? { provenance: image.provenance } : {}) }),
        image.path, image.path, ts, ts, ts, epoch).lastInsertRowid)
      // #110：细节图上的语义 = 全览语义要素按本帧取景投影到细节像素（id 与全览一致）。
      // #125：投影缺失时保留旧值并标 needs_review；文字字段只覆盖无人工标记的条目。
      const semantics = image.semantics
        ? semanticsJsonOf(image.semantics, versionId, ts, annotations, previous?.semantics ?? null)
        : previous?.semantics
          ? JSON.stringify(normalizeSemantics({ ...previous.semantics, needs_review: true, warnings: [...(previous.semantics.warnings ?? []), '本次交付算不出投影语义：保留旧语义，请人工核对取景'] }))
          : null
      sqlite.prepare('UPDATE props SET name = ?, type = ?, description = ?, image_url = ?, local_path = ?, faithful = 1, faithful_source = ?, map_pip = ?, semantics = ?, updated_at = ? WHERE id = ?')
        .run(name, '地图细节图', description, image.path, image.path, versionId, JSON.stringify(meta), semantics, ts, childId)
      for (const ep of parentEpisodes) link.run(ep.episode_id, childId, ts, ep.episode_id, childId)
      if (contentGone) contentChanged.push(childId)
      frameRows.push({ ...frameMeta, detail_prop_id: childId })
    }
  }
  // 不再出现在最新方案里的旧细节：保留资产（分镜可能已引用），只标记过期，不静默删除。
  // `content_changed_at` 只在第一次过期时记下（重新交付不能每次把时间往后推，否则引用它的组规划永远显旧）
  for (const propId of matches.unmatched_props) {
    const child = priorById.get(propId)
    if (!child) continue
    const staleMeta: PipMetaDetail = {
      ...child.meta,
      stale: true,
      content_changed_at: child.meta.content_changed_at ?? ts,
    }
    sqlite.prepare('UPDATE props SET map_pip = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(staleMeta), ts, child.prop_id)
  }
  const overview: PipMetaOverview | null = pip && frameRows.length
    ? {
      version: 1, role: 'overview', layout: pip.layout, overview_bbox: pip.overview_bbox, frames: frameRows,
      composite_path: pip.composite?.path ?? null, usage: pip.usage,
      ...(options.parentContentChanged ? { content_changed_at: ts } : {}),
    }
    : null
  sqlite.prepare('UPDATE props SET map_pip = ?, updated_at = ? WHERE id = ?').run(overview ? JSON.stringify(overview) : null, ts, parent.id)
  if (options.parentContentChanged) contentChanged.push(parent.id)
  return { contentChanged, matches }
}

// ─── 读路径（#110）────────────────────────────────────────────────────

/** 通用用法文本：剔除按镜号写的行（那些镜号属于某个别的集，跨集会误导设计） */
export function pipGenericUsage(usage: string): string {
  return usage.split('\n').map(line => line.trim())
    .filter(line => line && !/分镜\s*#|对应分镜/.test(line))
    .join('\n')
}

/** 经纬度框 → 可读文本；不是 4 个数字时为 null（不编造范围） */
function bboxText(bbox: unknown): string | null {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === 'number' && Number.isFinite(value))) return null
  return `[${bbox.map(value => Math.round(value * 100) / 100).join(', ')}]`
}

/**
 * 设计卡读写上下文里的画中画摘要（`read_storyboard_context` 的 `map_pip`）：
 * 每个细节给 `label` + `bbox`/`focus_bbox`（经纬度）+ 全览范围，供规划与设计判断「细节覆盖哪里」；
 * **不含** `storyboard_numbers`（别集镜号），`usage` 只保留通用用法。
 */
export function pipSummary(raw: string | null | undefined): Record<string, unknown> | null {
  const meta = parsePipMeta(raw)
  if (!meta) return null
  if (meta.role === 'overview') {
    return {
      role: 'overview',
      layout: (meta.layout as { id?: string } | null)?.id ?? null,
      overview_bbox: meta.overview_bbox ?? null,
      details: meta.frames.map(frame => ({
        no: frame.no,
        label: frame.label,
        role: frame.role,
        bbox: frame.bbox ?? null,
        focus_bbox: frame.focus_bbox ?? null,
        asset_id: frame.detail_prop_id,
      })),
      usage: pipGenericUsage(meta.usage),
    }
  }
  const frame = meta.frame
  return {
    role: 'detail',
    parent_asset_id: meta.parent_prop_id,
    parent_name: meta.parent_name,
    label: frame.label ?? null,
    bbox: frame.bbox ?? null,
    focus_bbox: frame.focus_bbox ?? null,
    overview_bbox: meta.overview_bbox,
    usage: pipGenericUsage(meta.usage),
    stale: meta.stale === true,
    ...(meta.needs_review === true ? { needs_review: true } : {}),
  }
}

/**
 * 组规划资产清单里的画中画说明（一行）：全览报自己的范围与各细节取景；细节报自己的取景+重点范围
 * 与所属全览范围——规划器据此判断某镜的旁白地理是否落在该细节内。同样不含镜号。
 */
export function pipAssetLine(raw: string | null | undefined): string | null {
  const meta = parsePipMeta(raw)
  if (!meta) return null
  if (meta.role === 'overview') {
    const overview = bboxText(meta.overview_bbox)
    const details = meta.frames.map(frame => {
      const bbox = bboxText(frame.bbox)
      return `prop#${frame.detail_prop_id ?? '?'}「${frame.label ?? ''}」取景 ${bbox ?? '范围未知'}`
    })
    return `全览${overview ? `范围 ${overview}` : '范围未知'}${details.length ? `；细节：${details.join('、')}` : '；没有细节'}`
  }
  const frame = meta.frame
  const bbox = bboxText(frame.bbox)
  const focus = bboxText(frame.focus_bbox)
  const overview = bboxText(meta.overview_bbox)
  return `细节「${frame.label ?? ''}」取景 ${bbox ?? '范围未知'}${focus && focus !== bbox ? `（重点 ${focus}）` : ''}`
    + `；所属全览 prop#${meta.parent_prop_id}${overview ? ` 范围 ${overview}` : ''}${meta.stale ? '；已过期（最新方案里没有这个细节）' : ''}`
}

// ─── 细节语义（#110 / #125）───────────────────────────────────────────

/**
 * 像素几何 → `props.semantics` JSON（与成图语义同一套规范化口径：source=cv、confidence=1）。
 *
 * `supplements`（#125）把研究阶段的坐标依据 + 原文摘录 + 来源名写进条目 `description`、类别写进
 * `keywords`；`previous` 提供人工标记——人写过的描述/关键词/名称不被覆盖。
 */
export function semanticsJsonOf(
  geometry: unknown,
  sourceTaskId: number,
  ts: string,
  supplements: Map<string, SemanticSupplement> = new Map(),
  previous: AssetSemantics | null = null,
): string {
  const { width, height, points, lines, regions } = geometry as {
    width: number; height: number; points: unknown[]; lines: unknown[]; regions: unknown[]
  }
  const mark = (items: unknown[]) => items.map(item => ({ ...(item as object), source: 'cv', confidence: 1 }))
  const doc = withGeneratedSupplements({
    image: { width, height, source_task_id: sourceTaskId },
    points: mark(points),
    regions: mark(regions),
    lines: mark(lines),
    warnings: [], generated_at: ts, model: 'map-pip-detail',
  }, previous, supplements)
  return JSON.stringify(doc)
}

/** 需要补算语义的细节资产（`map-pip-detail-semantics.ts` 的输入；投影在宿主侧单独做） */
export interface PipSemanticsTarget {
  propId: number
  parentId: number
  /** 全览道具自己的语义文档（原始 JSON 解析结果） */
  parentSemantics: unknown
  /** 细节在全览中的取景框（经纬度） */
  bbox: unknown
  imagePath: string | null
  versionTaskId: number | null
}

/** 存量细节里「没有语义几何」的那些（幂等回填的候选；解析不到的字段留给调用方跳过） */
export function backfillSemanticsTargets(): PipSemanticsTarget[] {
  const rows = sqlite.prepare("SELECT id, map_pip, semantics FROM props WHERE map_pip LIKE '%\"role\":\"detail\"%' AND deleted_at IS NULL").all() as Array<{ id: number; map_pip: string; semantics: string | null }>
  const out: PipSemanticsTarget[] = []
  for (const row of rows) {
    const meta = parsePipMeta(row.map_pip)
    if (meta?.role !== 'detail' || semanticsHasGeometry(row.semantics)) continue
    const parent = sqlite.prepare('SELECT semantics FROM props WHERE id = ? AND deleted_at IS NULL').get(meta.parent_prop_id) as { semantics: string | null } | undefined
    if (!parent) continue
    let parentSemantics: unknown = null
    try { parentSemantics = JSON.parse(parent.semantics ?? '') } catch { parentSemantics = null }
    const image = sqlite.prepare("SELECT id, local_path FROM sys_task WHERE prop_id = ? AND model = 'map-studio-detail' AND status = 'completed' ORDER BY id DESC LIMIT 1").get(row.id) as { id: number; local_path: string | null } | undefined
    out.push({
      propId: row.id,
      parentId: meta.parent_prop_id,
      parentSemantics,
      bbox: meta.frame.bbox,
      imagePath: image?.local_path ?? null,
      versionTaskId: image?.id ?? null,
    })
  }
  return out
}

/** 语义文档里有没有可用的几何（空标注 = 需要回填） */
function semanticsHasGeometry(raw: string | null | undefined): boolean {
  try {
    const doc = JSON.parse(raw ?? '') as { points?: unknown[]; lines?: unknown[]; regions?: unknown[] } | null
    if (!doc || typeof doc !== 'object') return false
    return Boolean(doc.points?.length || doc.lines?.length || doc.regions?.length)
  } catch { return false }
}
