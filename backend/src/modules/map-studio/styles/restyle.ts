import type { LayerDoc } from '../../../services/layer-doc.js'
import { featureStyleFor, labelStyleFor, MAP_LABEL_TIERS, MAP_MARKER_TIERS, type MapLabelTier, type MapStyleFamily } from './index.js'
import type { SpecFeature } from '../validate.js'

/** Pure style-only edit. IDs, text, boxes, coordinates, anchors, ordering and smoothing stay untouched. */
export function restyleMapLayers(doc: LayerDoc, family: MapStyleFamily, features: SpecFeature[]): LayerDoc {
  return { ...doc, theme: family.theme_mapping, layers: doc.layers.map(layer => {
    const feature = features.find(item => item.id === layer.anchor?.semantic_id)
    if (layer.type === 'label') {
      const encoded = /^theme-(title|region|city|river|note)-/.exec(layer.id)?.[1]
      const tier: MapLabelTier = MAP_LABEL_TIERS.includes(encoded as MapLabelTier) ? encoded as MapLabelTier
        : feature?.category === 'river' ? 'river' : feature?.kind === 'region' ? 'region'
          : feature?.kind === 'place' ? 'city' : layer.style.bold ? 'title' : 'note'
      return { ...layer, style: labelStyleFor(family, tier) }
    }
    if (layer.type === 'card') return { ...layer, style: { font: family.labels.region.font, scale: layer.style.scale ?? 1, bg: family.palette.background, bg_opacity: .9, color: family.palette.ink, accent: family.palette.accent, align: layer.style.align ?? 'left' } }
    if (layer.type !== 'marker' && layer.type !== 'polyline' && layer.type !== 'polygon') return layer
    const kind = layer.type === 'marker' ? 'place' : layer.type === 'polygon' ? 'region' : 'route'
    const markerTier = MAP_MARKER_TIERS.reduce((best, tier) => Math.abs(Number(layer.style.dot_radius ?? family.markers.city.dot_radius) - family.markers[tier].dot_radius) < Math.abs(Number(layer.style.dot_radius ?? family.markers.city.dot_radius) - family.markers[best].dot_radius) ? tier : best, 'city')
    return { ...layer, style: featureStyleFor(family, { kind, category: feature?.category, markerTier }) }
  }) }
}
