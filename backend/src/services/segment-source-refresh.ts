import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseDesignCard, type PlannedLayer } from './design-card.js'
import { normalizeLayerDoc } from './layer-doc.js'
import { layerFromPlannedLayer } from './layer-segment-draft.js'
import { getLayerSegment, listEpisodeLayerSegments, loadDraftAssets, saveLayerSegment } from './layer-segment.js'
import { markStale } from './staleness.js'

/** Source events are consumed by a successful render; quality_warnings are never gates. */
export const RENDER_CONSUMED_SOURCE_REASONS = ['base_version_changed', 'asset_version_changed', 'semantic_changed'] as const

/** Refresh attached geometry with the same projection used by design-card drafting. Manual detached layers stay untouched. */
export async function refreshLayerSegmentSources(storyboardId: number): Promise<boolean> {
  const segment = await getLayerSegment(storyboardId)
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const card = parseDesignCard(sb?.designCard)
  if (!segment || !sb || !card) return false
  const anchored: PlannedLayer[] = segment.layer_doc.layers.filter(layer => layer.anchor?.asset_id && !layer.anchor.detached).map(layer => ({
    type: layer.type, at_s: 0,
    anchor: { asset_id: layer.anchor!.asset_id!, semantic_id: layer.anchor!.semantic_id || '', name: layer.name || '' },
  }))
  const baseRef = segment.base_ref
  const imageRefs = segment.layer_doc.layers.filter(layer => layer.type === 'image' && layer.anchor?.asset_id).map(layer => {
    const id = layer.anchor!.asset_id!
    const reference = card.gen_plan?.reference_assets.find(ref => ref.id === id)
    const kind = reference?.kind ?? (baseRef?.kind === 'asset' && baseRef.asset_id === id ? baseRef.asset_kind : 'character')
    return { id, kind, name: layer.name || '' }
  })
  const sourceCard = { ...card, layer_plan: { ...card.layer_plan, base: baseRef, must_mark: card.layer_plan?.must_mark || [], planned_layers: anchored }, gen_plan: { ...card.gen_plan, reference_assets: [...(card.gen_plan?.reference_assets || []), ...imageRefs] } }
  const assets = await loadDraftAssets(sourceCard)
  const base = baseRef?.kind === 'asset' ? assets.find(asset => asset.kind === baseRef.asset_kind && asset.id === baseRef.asset_id) || null : null
  let doc = normalizeLayerDoc(segment.layer_doc)
  let unresolved = false
  // An explicit historical version remains pinned. Only an unversioned base follows the asset's current image.
  if (baseRef?.kind === 'asset' && baseRef.version_task_id === null) {
    if (!base?.image_path) unresolved = true
    else if (base.image_path !== doc.base.path) doc = { ...doc, base: { ...doc.base, path: base.image_path, source_width: undefined, source_height: undefined } }
  }
  const context = { assets, base, base_path: doc.base.path, base_ref: baseRef, duration: segment.duration, width: doc.base.width, height: doc.base.height }
  doc = normalizeLayerDoc({ ...doc, layers: doc.layers.map((layer, index) => {
    const anchor = layer.anchor
    if (!anchor?.asset_id || anchor.detached) return layer
    if (layer.type === 'image') {
      const reference = card.gen_plan?.reference_assets.find(ref => ref.id === anchor.asset_id)
      const assetKind = reference?.kind ?? (baseRef?.kind === 'asset' && baseRef.asset_id === anchor.asset_id ? baseRef.asset_kind : 'character')
      const asset = assets.find(item => item.id === anchor.asset_id && item.kind === assetKind)
      if (!asset?.image_path) { unresolved = true; return layer }
      return { ...layer, src: { ...layer.src, path: asset.image_path } }
    }
    if (!anchor.semantic_id) return layer
    const projected = layerFromPlannedLayer({ type: layer.type, at_s: 0, anchor: { asset_id: anchor.asset_id, semantic_id: anchor.semantic_id, name: layer.name || '' } }, index, context, [])
    if (!projected) { unresolved = true; return layer }
    const geometry = projected.layer
    return { ...layer, ...('points' in geometry ? { points: geometry.points } : {}), ...('at' in geometry ? { at: geometry.at } : {}), ...('box' in geometry ? { box: geometry.box } : {}) }
  }) })
  if (JSON.stringify(doc) !== JSON.stringify(segment.layer_doc)) await saveLayerSegment(storyboardId, { layer_doc: doc })
  const latest = await getLayerSegment(storyboardId)
  if (!latest) return false
  const reasons = latest.stale_reasons.filter(reason => reason !== 'source_unresolved')
  if (unresolved) reasons.push('source_unresolved')
  await db.update(schema.storyboardLayerSegments).set({ staleReasons: JSON.stringify(reasons), updatedAt: now() }).where(eq(schema.storyboardLayerSegments.id, latest.id))
  return !unresolved
}

/** Called only for episodes already associated with the changed asset, never a global scan. */
export async function onLayerSourceAssetChanged(episodeId: number, kind: 'prop' | 'scene' | 'character', assetId: number, event: 'version_registered' | 'semantics_changed'): Promise<void> {
  const rows = await db.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
  const byStoryboard = new Map(rows.map(row => [row.id, row]))
  const segments = await listEpisodeLayerSegments(episodeId)
  for (const segment of segments) {
    if (!byStoryboard.has(segment.storyboard_id)) continue
    const base = segment.base_ref
    const baseAffected = base?.kind === 'asset' && base.asset_kind === kind && base.asset_id === assetId && (event === 'semantics_changed' || base.version_task_id === null)
    const card = parseDesignCard(byStoryboard.get(segment.storyboard_id)?.designCard)
    const anchorAffected = segment.layer_doc.layers.some(layer => {
      if (layer.anchor?.asset_id !== assetId || layer.anchor.detached) return false
      if (layer.type !== 'image') return kind === 'prop'
      const reference = card?.gen_plan?.reference_assets.find(ref => ref.id === assetId)
      const assetKind = reference?.kind ?? (base?.kind === 'asset' && base.asset_id === assetId ? base.asset_kind : 'character')
      return kind === assetKind
    })
    if (!baseAffected && !anchorAffected) continue
    await markStale('layer_segment', [segment.storyboard_id], event === 'semantics_changed' ? 'semantic_changed' : 'asset_version_changed')
    await refreshLayerSegmentSources(segment.storyboard_id)
  }
}
