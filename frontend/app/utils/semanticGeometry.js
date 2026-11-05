/** Semantic source pixels → whole-image normalized layer geometry (never crop-relative). */
export function semanticEntries(raw) {
  let doc = raw
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc) } catch { return [] }
  }
  if (!doc || !(doc.image?.width > 0) || !(doc.image?.height > 0)) return []
  return ['points', 'regions', 'lines', 'labels'].flatMap(group => (doc[group] || []).map(item => ({
    ...item, group, name: String(item.name || item.text || item.id),
    image: doc.image,
  })))
}

export function semanticLayerPatch(entry, assetId) {
  const width = Number(entry.image?.width)
  const height = Number(entry.image?.height)
  if (!(width > 0 && height > 0) || !Number.isFinite(Number(assetId)) || Number(assetId) <= 0) return null
  const unit = n => Math.max(0, Math.min(1, n))
  const point = pair => [unit(Number(pair[0]) / width), unit(Number(pair[1]) / height)]
  const common = { name: entry.name, anchor: { asset_id: Number(assetId), semantic_id: String(entry.id), semantic_name: String(entry.name).trim().slice(0, 60), detached: false } }
  if (entry.group === 'points' && Array.isArray(entry.at)) return { ...common, type: 'marker', at: point(entry.at), text: entry.name }
  if (entry.group === 'labels' && Array.isArray(entry.bbox)) {
    const [x1, y1, x2, y2] = entry.bbox
    return { ...common, type: 'marker', at: point([(x1 + x2) / 2, (y1 + y2) / 2]), text: entry.name }
  }
  if (['regions', 'lines'].includes(entry.group) && Array.isArray(entry.points)) {
    const points = entry.points.filter(pair => Array.isArray(pair) && pair.length >= 2 && pair.every(Number.isFinite)).map(point)
    const type = entry.group === 'regions' ? 'polygon' : 'polyline'
    if (points.length < (type === 'polygon' ? 3 : 2)) return null
    return { ...common, type, points }
  }
  return null
}

/** Unknown source data is not an invalid anchor; only a loaded source can prove deletion/rename. */
export function anchorState(layer, entries, loaded = true, assetId = null) {
  if (!layer.anchor?.semantic_id || layer.anchor.detached) return 'manual'
  if (!loaded) return 'anchored'
  const entry = entries.find(item => String(item.id) === String(layer.anchor.semantic_id))
  const renamed = layer.anchor.semantic_name && entry && String(entry.name).trim().slice(0, 60) !== layer.anchor.semantic_name
  if ((assetId !== null && String(layer.anchor.asset_id) !== String(assetId)) || !entry || renamed) return 'unlink'
  return 'anchored'
}
