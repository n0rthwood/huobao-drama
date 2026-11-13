import { sqlite } from '../db/index.js'
import { now } from '../utils/response.js'
import { normalizeSemantics } from './asset-semantics.js'
import { onAssetLibraryChanged } from './asset-review.js'
import type { MapStudioHost, MapStudioDeliverable, MapStudioDeliveryResult, MapBrief } from '../modules/map-studio/index.js'

interface HostProp { id: number; name: string; description: string | null; drama_id: number; map_brief: string | null }
function propOf(ref: string): HostProp | null {
  const match = /^prop:([1-9]\d*)$/.exec(ref)
  if (!match) return null
  return sqlite.prepare("SELECT id, name, description, drama_id, map_brief FROM props WHERE id = ? AND asset_type = 'map' AND deleted_at IS NULL").get(Number(match[1])) as HostProp | undefined ?? null
}

/** Transactional registration: same task + PNG hash returns the existing base/final pair. */
const registerDelivery = sqlite.transaction((prop: HostProp, d: MapStudioDeliverable): { result: MapStudioDeliveryResult; inserted: boolean } => {
  // Resolve again inside the transaction: deleting/demoting a prop must not accept a late result.
  if (!propOf(`prop:${prop.id}`)) throw new Error('宿主目标已删除或已不再是地图资产')
  const prior = sqlite.prepare("SELECT id, params FROM sys_task WHERE prop_id = ? AND provider = 'map-workflow' AND status = 'completed' ORDER BY id DESC").all(prop.id) as { id: number; params: string | null }[]
  for (const row of prior) {
    let params: Record<string, unknown>
    try { params = JSON.parse(row.params ?? '{}') } catch { continue }
    if (params.source === 'map-studio' && params.map_studio_task_id === d.task_id && params.png_sha256 === d.final_image.sha256) {
      return { inserted: false, result: { version_ids: [Number(params.base_task_id), row.id], message: `成果已登记（底图 #${params.base_task_id}、成图 #${row.id}），无需重复交付` } }
    }
  }
  const ts = now()
  const insert = sqlite.prepare(`INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at, completed_at, generated_at)
    VALUES ('image', ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
  const baseId = Number(insert.run(prop.id, prop.drama_id, 'map-render', 'map-studio-base', `地图底图：${prop.name}`,
    JSON.stringify({ source: 'map-studio', map_studio_task_id: d.task_id, base_mode: d.base_image.mode, provenance: d.base_image.provenance }),
    d.base_image.path, d.base_image.path, ts, ts, ts, Math.floor(Date.parse(ts) / 1000)).lastInsertRowid)
  const finalId = Number(insert.run(prop.id, prop.drama_id, 'map-workflow', d.manual_edit ? 'map-layer-doc-manual' : 'map-layer-doc', `地图成图：${prop.name}`,
    JSON.stringify({ source: 'map-studio', map_studio_task_id: d.task_id, png_sha256: d.final_image.sha256, base_task_id: baseId,
      base_mode: d.base_image.mode, provenance: d.base_image.provenance, geometry: d.semantics, features: d.features, sources: d.sources,
      kmz: d.kmz, editable_source: d.editable_source, texture_image: d.texture_image, manual_edit: d.manual_edit }),
    d.final_image.path, d.final_image.path, ts, ts, ts, Math.floor(Date.parse(ts) / 1000)).lastInsertRowid)
  const g = d.semantics as { width: number; height: number; points?: unknown[]; lines?: unknown[]; routes?: unknown[]; regions?: unknown[]; labels?: unknown[]; warnings?: string[] }
  const mark = (items: unknown[]) => items.map(item => ({ ...(item as object), source: 'cv', confidence: 1 }))
  const semantics = normalizeSemantics({
    image: { width: g.width, height: g.height, source_task_id: finalId },
    labels: mark(g.labels ?? []), points: mark(g.points ?? []), regions: mark(g.regions ?? []),
    lines: mark(g.lines ?? g.routes ?? []).map(item => ({ ...item, kind: 'route' })),
    warnings: g.warnings ?? [], generated_at: ts, model: 'map-workflow',
  })
  sqlite.prepare('UPDATE props SET image_url = ?, local_path = ?, faithful = 1, faithful_source = ?, semantics = ?, updated_at = ? WHERE id = ?')
    .run(d.final_image.path, d.final_image.path, baseId, JSON.stringify(semantics), ts, prop.id)
  return { inserted: true, result: { version_ids: [baseId, finalId], message: `已采用成图（版本 #${finalId}）与忠实底图（版本 #${baseId}）：${d.summary}` } }
})

export const huobaoMapStudioHost: MapStudioHost = {
  id: 'huobao',
  async describe(ref) {
    const prop = propOf(ref)
    if (!prop) return null
    const drama = sqlite.prepare('SELECT title FROM dramas WHERE id = ?').get(prop.drama_id) as { title: string } | undefined
    const episode = sqlite.prepare('SELECT e.episode_number FROM episodes e JOIN episode_props ep ON ep.episode_id = e.id WHERE ep.prop_id = ? AND e.deleted_at IS NULL ORDER BY e.episode_number LIMIT 1').get(prop.id) as { episode_number: number } | undefined
    return { title: prop.name, subtitle: drama ? `《${drama.title}》${episode ? `E${String(episode.episode_number).padStart(2, '0')}` : ''}` : null,
      return_path: episode ? `/drama/${prop.drama_id}/episode/${episode.episode_number}?panel=production&tab=assets&extract=props&asset=prop-${prop.id}` : `/drama/${prop.drama_id}` }
  },
  async readBrief(ref) {
    const prop = propOf(ref)
    if (!prop) return null
    if (prop.map_brief) return JSON.parse(prop.map_brief) as MapBrief
    return { subject: prop.name, era: '', location: '', purpose: '', detail_level: 'regional', schematic: false, base_mode: 'program', style: 'archival', notes: prop.description ?? '', reference_image: null, inferred: [] }
  },
  async writeBrief(ref, brief) {
    const prop = propOf(ref)
    if (!prop) throw new Error('宿主目标不存在或不是地图资产')
    sqlite.prepare('UPDATE props SET map_brief = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(brief), now(), prop.id)
  },
  async deliver(ref, d) {
    const prop = propOf(ref)
    if (!prop) throw new Error('宿主目标不存在或不是地图资产')
    const { result, inserted } = registerDelivery(prop, d)
    if (inserted) {
      await onAssetLibraryChanged('prop', prop.id, 'version_registered')
      await onAssetLibraryChanged('prop', prop.id, 'semantics_changed')
    }
    return result
  },
}
