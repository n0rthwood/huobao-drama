/**
 * 地图「画中画」资产的宿主侧登记（Issue #107）。
 *
 * 全览与细节是**独立资产**：全览 = 原地图道具；每个细节 = 一条独立的地图道具（asset_type='map'、faithful），
 * 与全览同项目、同剧集关联。联系与用法存在 `props.map_pip`（JSON）：
 * - 全览：`{role:'overview', layout, frames:[{no,label,role,reason,bbox,focus_bbox,storyboard_numbers,detail_prop_id}], composite_path, usage}`
 * - 细节：`{role:'detail', parent_prop_id, frame:{no,label,role,reason,bbox,focus_bbox}, overview_bbox, usage}`
 * 细节图的 `parent_frame` 就是 `frame.bbox`（大图中的位置，经纬度）。分镜设计读 `usage` 决定怎么引用。
 * 本文件是 map_pip 的唯一读写口；调用方在 map-studio-host 的交付事务里同步调用 registerPipAssets。
 */
import { sqlite } from '../db/index.js'
import type { MapStudioDeliverable } from '../modules/map-studio/contract.js'

export interface PipMetaOverview {
  version: 1
  role: 'overview'
  layout: unknown
  frames: Array<Record<string, unknown>>
  composite_path: string | null
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
      sqlite.prepare('UPDATE props SET name = ?, type = ?, description = ?, image_url = ?, local_path = ?, faithful = 1, faithful_source = ?, map_pip = ?, updated_at = ? WHERE id = ?')
        .run(name, '地图细节图', description, image.path, image.path, versionId, JSON.stringify(meta), ts, childId)
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
    ? { version: 1, role: 'overview', layout: pip.layout, frames: frameRows, composite_path: pip.composite?.path ?? null, usage: pip.usage }
    : null
  sqlite.prepare('UPDATE props SET map_pip = ?, updated_at = ? WHERE id = ?').run(overview ? JSON.stringify(overview) : null, ts, parent.id)
}
