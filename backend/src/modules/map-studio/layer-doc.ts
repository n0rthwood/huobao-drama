import { LAYER_MAX_POINTS, strictLayerDocProblems, type LayerDoc, type LayerDocProblem } from '../../services/layer-doc.js'
import { forwardFor, type MapRegistration } from './geo/geometry.js'
import type { SpecFeature } from './validate.js'

/** Global LayerDoc limits stay intact. Only exact, server-projected stored feature geometry may be dense.
 * Validate its complete point sequence first, validate the remaining schema using a short shadow,
 * then restore the untouched sequence. Renderers consume this validated doc without normalizing it.
 */
export function strictMapLayerDocProblems(raw: unknown, context: { features: SpecFeature[]; registration?: MapRegistration; trustedDoc?: LayerDoc }): { doc: LayerDoc; problems: LayerDocProblem[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('layers' in raw) || !Array.isArray(raw.layers)) return strictLayerDocProblems(raw)
  // The shadow is schema-validated below before any caller receives a typed document.
  const source = raw as LayerDoc
  const forward = context.registration ? forwardFor(context.registration) : undefined
  const dense = new Map<string, [number, number][]>()
  const problems: LayerDocProblem[] = []
  const layers = source.layers.map((layer, index) => {
    if (layer?.anchor?.semantic_id && ['polygon', 'polyline', 'marker'].includes(layer.type) && layer.rotation !== 0) problems.push({ path: `layers[${index}].rotation`, message: '锚定的地理几何 rotation 必须为 0；旋转会偏离投影位置且无法交付对应语义' })
    if (!layer || (layer.type !== 'polygon' && layer.type !== 'polyline') || !Array.isArray(layer.points) || layer.points.length <= LAYER_MAX_POINTS) return layer
    const feature = context.features.find(f => f.id === layer.anchor?.semantic_id)
    const trusted = context.trustedDoc?.layers.find(l => l.id === layer.id && l.type === layer.type && l.anchor?.semantic_id === layer.anchor?.semantic_id)
    const expected = feature && forward && context.registration ? feature.coords.map(p => {
      const pixel = forward(p)
      return pixel ? [pixel[0] / context.registration!.width, pixel[1] / context.registration!.height] : null
    }) : feature && trusted && (trusted.type === 'polygon' || trusted.type === 'polyline') ? trusted.points : undefined
    const exact = expected && expected.length === layer.points.length && layer.points.every((point, i) => Array.isArray(point) && point.length === 2 && point.every((n, axis) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 && expected[i] && Math.abs(n - expected[i]![axis]!) <= 1e-12))
    if (!exact) {
      problems.push({ path: `layers[${index}].points`, message: '超过 240 点只允许已存储要素的完整、精确投影几何；不得截断、移动、重排或插值，请使用 add_feature_layers；人工顶点编辑请走几何编辑器' })
      return layer
    }
    dense.set(layer.id, layer.points)
    return { ...layer, points: layer.points.slice(0, LAYER_MAX_POINTS) }
  })
  const checked = strictLayerDocProblems({ ...source, layers })
  return { doc: { ...checked.doc, layers: checked.doc.layers.map(layer => {
    const points = dense.get(layer.id)
    return points && (layer.type === 'polygon' || layer.type === 'polyline') ? { ...layer, points } : layer
  }) }, problems: [...checked.problems, ...problems] }
}
