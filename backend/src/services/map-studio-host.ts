import crypto from 'crypto'
import { sqlite } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseSemantics, withGeneratedSupplements, type AssetSemantics } from './asset-semantics.js'
import { onAssetLibraryChanged } from './asset-review.js'
import { registerPipAssets, geometrySemanticIds, sameSemanticIdSet, semanticIdSet } from './map-pip-assets.js'
import { mapAssetReferences, storyboardsReferencing } from './map-asset-references.js'
import { markStale } from './staleness.js'
import { semanticAnnotationsOf } from './map-semantic-annotations.js'
import { parseReferenceImages, referenceImagePaths } from './reference-images.js'
import { MAP_ASPECTS, type MapAspect, type MapStudioHost, type MapStudioDeliverable, type MapStudioDeliveryResult, type MapBrief } from '../modules/map-studio/index.js'

interface HostProp {
  id: number
  name: string
  description: string | null
  drama_id: number
  map_brief: string | null
  /** 覆盖前读一次：用来判「内容是否换了一批地理对象」（#125） */
  semantics: string | null
  reference_images: string | null
}

const MAP_ASPECT_WHITELIST: readonly MapAspect[] = MAP_ASPECTS
/** 项目画幅（#107）：legacy 值（如 adaptive）不在白名单，按缺省 16:9 处理。 */
function dramaAspect(dramaId: number): MapAspect | undefined {
  const row = sqlite.prepare('SELECT aspect_ratio FROM dramas WHERE id = ?').get(dramaId) as { aspect_ratio: string | null } | undefined
  return MAP_ASPECT_WHITELIST.find(item => item === row?.aspect_ratio)
}
function propOf(ref: string): HostProp | null {
  const match = /^prop:([1-9]\d*)$/.exec(ref)
  if (!match) return null
  return sqlite.prepare("SELECT id, name, description, drama_id, map_brief, semantics, reference_images FROM props WHERE id = ? AND asset_type = 'map' AND deleted_at IS NULL").get(Number(match[1])) as HostProp | undefined ?? null
}

/** Transactional registration: same task + PNG hash returns the existing base/final pair. */
const registerDelivery = sqlite.transaction((prop: HostProp, d: MapStudioDeliverable): {
  result: MapStudioDeliveryResult
  inserted: boolean
  /** 内容换了的资产（语义要素 id 集合变化）：宿主据此让设计卡/组规划/图层段过期（#125） */
  contentChanged: number[]
  /** 本次登记涉及的地图资产（全览 + 细节）：失效传播要覆盖全部引用面 */
  assetIds: number[]
} => {
  // Resolve again inside the transaction: deleting/demoting a prop must not accept a late result.
  if (!propOf(`prop:${prop.id}`)) throw new Error('宿主目标已删除或已不再是地图资产')
  const pipKey = d.pip ? crypto.createHash('sha256').update(JSON.stringify(d.pip.details.map(x => x.sha256))).digest('hex') : null
  const prior = sqlite.prepare("SELECT id, params FROM sys_task WHERE prop_id = ? AND provider = 'map-workflow' AND status = 'completed' ORDER BY id DESC").all(prop.id) as { id: number; params: string | null }[]
  for (const row of prior) {
    let params: Record<string, unknown>
    try { params = JSON.parse(row.params ?? '{}') } catch { continue }
    if (params.source === 'map-studio' && params.map_studio_task_id === d.task_id && params.png_sha256 === d.final_image.sha256 && (params.pip_key ?? null) === pipKey) {
      return {
        inserted: false,
        contentChanged: [],
        assetIds: [prop.id],
        result: { version_ids: [Number(params.base_task_id), row.id], message: `成果已登记（底图 #${params.base_task_id}、成图 #${row.id}），无需重复交付` },
      }
    }
  }
  const ts = now()
  const insert = sqlite.prepare(`INSERT INTO sys_task (type, prop_id, drama_id, provider, model, prompt, params, result_url, local_path, status, created_at, updated_at, completed_at, generated_at)
    VALUES ('image', ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
  const baseId = Number(insert.run(prop.id, prop.drama_id, 'map-render', 'map-studio-base', `地图底图：${prop.name}`,
    JSON.stringify({ source: 'map-studio', map_studio_task_id: d.task_id, base_mode: d.base_image.mode, provenance: d.base_image.provenance }),
    d.base_image.path, d.base_image.path, ts, ts, ts, Math.floor(Date.parse(ts) / 1000)).lastInsertRowid)
  const finalId = Number(insert.run(prop.id, prop.drama_id, 'map-workflow', d.manual_edit ? 'map-layer-doc-manual' : 'map-layer-doc', `地图成图：${prop.name}`,
    JSON.stringify({ source: 'map-studio', map_studio_task_id: d.task_id, png_sha256: d.final_image.sha256, pip_key: pipKey, base_task_id: baseId,
      base_mode: d.base_image.mode, provenance: d.base_image.provenance, geometry: d.semantics, features: d.features, sources: d.sources,
      kmz: d.kmz, editable_source: d.editable_source, texture_image: d.texture_image, manual_edit: d.manual_edit }),
    d.final_image.path, d.final_image.path, ts, ts, ts, Math.floor(Date.parse(ts) / 1000)).lastInsertRowid)
  const g = d.semantics as { width: number; height: number; points?: unknown[]; lines?: unknown[]; routes?: unknown[]; regions?: unknown[]; labels?: unknown[]; warnings?: string[] }
  const mark = (items: unknown[]) => items.map(item => ({ ...(item as object), source: 'cv', confidence: 1 }))
  const previousDoc: AssetSemantics | null = parseSemantics(prop.semantics)
  const previousIds = semanticIdSet(previousDoc)
  const nextIds = geometrySemanticIds(d.semantics)
  // #125：内容换了一批地理对象 = 语义要素 id 集合变了（首版没有旧语义不算变化）
  const parentContentChanged = previousIds.size > 0 && nextIds.size > 0 && !sameSemanticIdSet(previousIds, nextIds)
  // #125：description/keywords 由代码拼接研究事实；人工标记的条目不被覆盖
  const semantics = withGeneratedSupplements({
    image: { width: g.width, height: g.height, source_task_id: finalId },
    labels: mark(g.labels ?? []), points: mark(g.points ?? []), regions: mark(g.regions ?? []),
    lines: mark(g.lines ?? g.routes ?? []).map(item => ({ ...item, kind: 'route' })),
    warnings: g.warnings ?? [], generated_at: ts, model: 'map-workflow',
  }, previousDoc, semanticAnnotationsOf(d.features ?? [], d.sources ?? []))
  sqlite.prepare('UPDATE props SET image_url = ?, local_path = ?, faithful = 1, faithful_source = ?, semantics = ?, updated_at = ? WHERE id = ?')
    .run(d.final_image.path, d.final_image.path, baseId, JSON.stringify(semantics), ts, prop.id)
  registerSourceCitations(prop, d.sources, ts)
  const pipOutcome = registerPipAssets({ id: prop.id, name: prop.name, drama_id: prop.drama_id }, d, ts, { parentContentChanged })
  const refs = mapAssetReferences(prop.id)
  const notice = refs && refs.total
    ? `；引用该资产的分镜：已落段 ${refs.materialized} / 仅规划 ${refs.planned}（设计卡或图层段需按新内容更新）`
    : ''
  return {
    inserted: true,
    contentChanged: pipOutcome.contentChanged,
    assetIds: [prop.id, ...pipOutcome.matches.matches.map(item => item.prop_id), ...pipOutcome.matches.unmatched_props],
    result: { version_ids: [baseId, finalId], message: `已采用成图（版本 #${finalId}）与忠实底图（版本 #${baseId}）：${d.summary}${notice}` },
  }
})

/**
 * 交付的出处同步进资产「资料来源」面板（research_citations，Issue #32 的唯一读取口）。
 * 同一资产同一出处（URL，缺 URL 时按标题）只记一次；来源本身仍完整存在成图版本的 params.sources 里。
 */
function registerSourceCitations(prop: HostProp, sources: unknown[], ts: string): void {
  const exists = sqlite.prepare("SELECT 1 FROM research_citations WHERE asset_kind = 'prop' AND asset_id = ? AND tool = 'map-studio' AND COALESCE(source_url, '') = ? AND COALESCE(title, '') = ? LIMIT 1")
  const insert = sqlite.prepare(`INSERT INTO research_citations (drama_id, episode_id, asset_kind, asset_id, asset_name, tool, query, title, source_url, lang, snippet, status, retrieved_at)
    VALUES (?, NULL, 'prop', ?, ?, 'map-studio', NULL, ?, ?, ?, ?, 'ok', ?)`)
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object') continue
    const source = raw as { title?: unknown; url?: unknown; adapter?: unknown; excerpt?: unknown }
    const title = typeof source.title === 'string' ? source.title : ''
    const url = typeof source.url === 'string' ? source.url : ''
    if (!title && !url) continue
    if (exists.get(prop.id, url, title)) continue
    const adapter = typeof source.adapter === 'string' ? source.adapter : ''
    const lang = adapter.endsWith('-zh') ? 'zh' : adapter.endsWith('-en') ? 'en' : null
    const snippet = typeof source.excerpt === 'string' && source.excerpt ? source.excerpt.slice(0, 500) : null
    insert.run(prop.drama_id, prop.id, prop.name, title || null, url || null, lang, snippet, ts)
  }
}

export const huobaoMapStudioHost: MapStudioHost = {
  id: 'huobao',
  async describe(ref) {
    const prop = propOf(ref)
    if (!prop) return null
    const drama = sqlite.prepare('SELECT title FROM dramas WHERE id = ?').get(prop.drama_id) as { title: string } | undefined
    const episode = sqlite.prepare('SELECT e.episode_number FROM episodes e JOIN episode_props ep ON ep.episode_id = e.id WHERE ep.prop_id = ? AND e.deleted_at IS NULL ORDER BY e.episode_number LIMIT 1').get(prop.id) as { episode_number: number } | undefined
    return { title: prop.name, subtitle: drama ? `《${drama.title}》${episode ? `E${String(episode.episode_number).padStart(2, '0')}` : ''}` : null,
      return_path: episode ? `/drama/${prop.drama_id}/episode/${episode.episode_number}?panel=production&tab=assets&extract=props&asset=prop-${prop.id}` : `/drama/${prop.drama_id}`,
      description: prop.description,
      reference_images: referenceImagePaths(parseReferenceImages(prop.reference_images)) }
  },
  async readBrief(ref) {
    const prop = propOf(ref)
    if (!prop) return null
    const aspect_ratio = dramaAspect(prop.drama_id)
    const withAspect = (brief: MapBrief): MapBrief => aspect_ratio ? { ...brief, aspect_ratio } : brief
    if (prop.map_brief) return withAspect(JSON.parse(prop.map_brief) as MapBrief)
    return withAspect({ subject: prop.name, era: '', location: '', purpose: '', detail_level: 'regional', schematic: false, base_mode: 'program', style: 'archival', notes: prop.description ?? '', reference_image: null, inferred: [] })
  },
  async readContext(ref) {
    const prop = propOf(ref)
    if (!prop) return null
    const rows = sqlite.prepare(`SELECT s.storyboard_number AS number, s.narration_text AS narration, s.design_card AS card
      FROM storyboards s JOIN episode_props ep ON ep.episode_id = s.episode_id
      WHERE ep.prop_id = ? AND s.deleted_at IS NULL AND s.design_card LIKE ? ORDER BY s.episode_id, s.storyboard_number`).all(prop.id, `%"asset_id":${prop.id}%`) as Array<{ number: number; narration: string | null; card: string }>
    const shots = rows.flatMap(row => {
      let card: { info_points?: Array<{ text?: string }>; layer_plan?: { base?: { asset_id?: number }; must_mark?: Array<{ name?: string }> } }
      try { card = JSON.parse(row.card) } catch { return [] }
      if (card.layer_plan?.base?.asset_id !== prop.id) return []
      return [{
        number: row.number,
        narration: row.narration ?? '',
        info_points: (card.info_points ?? []).map(p => p.text ?? '').filter(Boolean),
        must_mark: (card.layer_plan?.must_mark ?? []).map(m => m.name ?? '').filter(Boolean),
      }]
    })
    return { shots }
  },
  async writeBrief(ref, brief) {
    const prop = propOf(ref)
    if (!prop) throw new Error('宿主目标不存在或不是地图资产')
    // 画幅属于项目设置，由 readBrief 每次现读，不写进资产需求
    const { aspect_ratio: _aspect, ...persisted } = brief
    sqlite.prepare('UPDATE props SET map_brief = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(persisted), now(), prop.id)
  },
  async deliver(ref, d) {
    const prop = propOf(ref)
    if (!prop) throw new Error('宿主目标不存在或不是地图资产')
    const { result, inserted, contentChanged, assetIds } = registerDelivery(prop, d)
    if (inserted) {
      await onAssetLibraryChanged('prop', prop.id, 'version_registered')
      await onAssetLibraryChanged('prop', prop.id, 'semantics_changed')
      // #125 §4：交付后对反查命中的**已落段**显式标过期（幂等），并让内容换了的资产上的设计卡过期。
      // 只按反查结果传播，不做全库扫描。
      for (const assetId of assetIds) {
        const refs = storyboardsReferencing(assetId)
        await markStale('layer_segment', refs.materialized, 'asset_version_changed')
        if (contentChanged.includes(assetId)) await markStale('design_card', refs.planned, 'asset_content_changed')
      }
    }
    return result
  },
}
