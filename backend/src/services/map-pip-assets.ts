/**
 * 地图「画中画」资产的宿主侧登记（Issue #107 / #110）。
 *
 * 全览与细节是**独立资产**：全览 = 原地图道具；每个细节 = 一条独立的地图道具（asset_type='map'、faithful），
 * 与全览同项目、同剧集关联。联系与用法存在 `props.map_pip`（JSON）：
 * - 全览：`{role:'overview', layout, overview_bbox, frames:[{no,label,role,reason,bbox,focus_bbox,storyboard_numbers,detail_prop_id}], composite_path, usage}`
 * - 细节：`{role:'detail', parent_prop_id, frame:{no,label,role,reason,bbox,focus_bbox}, overview_bbox, usage}`
 * 细节图的 `parent_frame` 就是 `frame.bbox`（大图中的位置，经纬度）。
 *
 * 读路径（`pipSummary` / `pipAssetLine`）只输出通用事实：`label` + `bbox`/`focus_bbox`（经纬度）+ 全览范围，
 * 并**剔除** `storyboard_numbers` 与 usage 里按镜号写的那几行——那些镜号是某个别的集的分镜，跨集会误读。
 * `props.map_pip` 的存量数据照旧保留（溯源信息不丢）。
 *
 * 细节资产的语义（#110）：细节图是同一份 map_spec 的局部渲染，登记时把全览语义要素按细节取景
 * 投影成细节图像素坐标（`semantic_id` 与全览一致），写进细节道具的 `props.semantics`，
 * 设计卡才能在细节底图上 anchor / must_mark。存量细节由启动时的幂等回填补算。
 */
import { sqlite } from '../db/index.js'
import { normalizeSemantics } from './asset-semantics.js'
import type { MapStudioDeliverable } from '../modules/map-studio/contract.js'

export interface PipMetaOverview {
  version: 1
  role: 'overview'
  layout: unknown
  frames: Array<Record<string, unknown>>
  composite_path: string | null
  /** 全览取景（经纬度）：细节在图上的位置只有配合全览范围才读得懂 */
  overview_bbox?: [number, number, number, number]
  usage: string
}
export interface PipMetaDetail {
  version: 1
  role: 'detail'
  parent_prop_id: number
  parent_name: string
  frame: Record<string, unknown>
  overview_bbox: [number, number, number, number]
  usage: string
  stale?: boolean
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

interface ParentRow { id: number; name: string; drama_id: number }

/** 在交付事务内登记：覆盖/新增细节资产、版本、剧集关联，并写全览的 map_pip。 */
export function registerPipAssets(parent: ParentRow, d: MapStudioDeliverable, ts: string): void {
  const pip = d.pip
  const existing = sqlite.prepare("SELECT id, map_pip FROM props WHERE drama_id = ? AND deleted_at IS NULL AND map_pip LIKE '%\"role\":\"detail\"%'").all(parent.drama_id) as Array<{ id: number; map_pip: string }>
  const children = new Map<number, { id: number; meta: PipMetaDetail }>()
  for (const row of existing) {
    const meta = parsePipMeta(row.map_pip)
    if (meta?.role === 'detail' && meta.parent_prop_id === parent.id) children.set(Number(meta.frame.no), { id: row.id, meta })
  }
  const insertTask = sqlite.prepare(`INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at, completed_at, generated_at)
    VALUES ('image', ?, ?, 'map-render', 'map-studio-detail', ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
  const epoch = Math.floor(Date.parse(ts) / 1000)
  const parentEpisodes = sqlite.prepare('SELECT DISTINCT episode_id FROM episode_props WHERE prop_id = ?').all(parent.id) as Array<{ episode_id: number }>
  const link = sqlite.prepare('INSERT INTO episode_props (episode_id, prop_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM episode_props WHERE episode_id = ? AND prop_id = ?)')

  const frameRows: Array<Record<string, unknown>> = []
  const keep = new Set<number>()
  if (pip) {
    for (const frame of pip.frames) {
      const image = pip.details.find(item => item.no === frame.no)
      if (!image) continue
      keep.add(frame.no)
      const frameMeta = { no: frame.no, label: frame.label, role: frame.role, reason: frame.reason, bbox: frame.bbox, focus_bbox: frame.focus_bbox, storyboard_numbers: frame.storyboard_numbers }
      const usage = `${pip.usage}\n\n本资产是细节${frame.no}「${frame.label}」，隶属全览《${parent.name}》（资产 #${parent.id}）；它在全览中的位置（经纬度）：${JSON.stringify(frame.bbox)}。`
      const name = `${parent.name} · 细节${frame.no}（${frame.label}）`
      const meta: PipMetaDetail = { version: 1, role: 'detail', parent_prop_id: parent.id, parent_name: parent.name, frame: frameMeta, overview_bbox: pip.overview_bbox, usage }
      const prior = children.get(frame.no)
      let childId: number
      const description = `地图细节图：${frame.label}。${frame.reason}\n\n用法：\n${usage}`
      if (prior) {
        childId = prior.id
      } else {
        childId = Number(sqlite.prepare(`INSERT INTO props (drama_id, name, type, description, faithful, asset_type, created_at, updated_at) VALUES (?, ?, '地图细节图', ?, 1, 'map', ?, ?)`)
          .run(parent.drama_id, name, description, ts, ts).lastInsertRowid)
      }
      const versionId = Number(insertTask.run(childId, parent.drama_id, `地图细节图：${name}`,
        JSON.stringify({ source: 'map-studio', map_studio_task_id: d.task_id, role: 'detail', parent_prop_id: parent.id, frame: frameMeta, png_sha256: image.sha256 }),
        image.path, image.path, ts, ts, ts, epoch).lastInsertRowid)
      // #110：细节图上的语义 = 全览语义要素按本帧取景投影到细节像素（id 与全览一致）。
      // 投影在模块侧交付时就算好了（`MapPipOutput.details[].semantics`）：宿主这里只做规范化落库，
      // 不 import map-studio 运行时（否则 agents 工具图会拉进整个模块）。
      const semantics = image.semantics ? semanticsJsonOf(image.semantics, versionId, ts) : null
      sqlite.prepare('UPDATE props SET name = ?, type = ?, description = ?, image_url = ?, local_path = ?, faithful = 1, faithful_source = ?, map_pip = ?, semantics = COALESCE(?, semantics), updated_at = ? WHERE id = ?')
        .run(name, '地图细节图', description, image.path, image.path, versionId, JSON.stringify(meta), semantics, ts, childId)
      for (const ep of parentEpisodes) link.run(ep.episode_id, childId, ts, ep.episode_id, childId)
      frameRows.push({ ...frameMeta, detail_prop_id: childId })
    }
  }
  // 不再出现在最新方案里的旧细节：保留资产（分镜可能已引用），只标记过期，不静默删除
  for (const [no, child] of children) {
    if (keep.has(no)) continue
    sqlite.prepare('UPDATE props SET map_pip = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...child.meta, stale: true }), ts, child.id)
  }
  const overview: PipMetaOverview | null = pip && frameRows.length
    ? { version: 1, role: 'overview', layout: pip.layout, overview_bbox: pip.overview_bbox, frames: frameRows, composite_path: pip.composite?.path ?? null, usage: pip.usage }
    : null
  sqlite.prepare('UPDATE props SET map_pip = ?, updated_at = ? WHERE id = ?').run(overview ? JSON.stringify(overview) : null, ts, parent.id)
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

// ─── 细节语义（#110）───────────────────────────────────────────────────

/** 像素几何 → `props.semantics` JSON（与成图语义同一套规范化口径：source=cv、confidence=1） */
export function semanticsJsonOf(
  geometry: unknown,
  sourceTaskId: number,
  ts: string,
): string {
  const { width, height, points, lines, regions } = geometry as {
    width: number; height: number; points: unknown[]; lines: unknown[]; regions: unknown[]
  }
  const mark = (items: unknown[]) => items.map(item => ({ ...(item as object), source: 'cv', confidence: 1 }))
  return JSON.stringify(normalizeSemantics({
    image: { width, height, source_task_id: sourceTaskId },
    points: mark(points),
    regions: mark(regions),
    lines: mark(lines),
    warnings: [], generated_at: ts, model: 'map-pip-detail',
  }))
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
