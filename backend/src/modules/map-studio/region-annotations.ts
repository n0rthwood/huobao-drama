import type { Layer, LayerDoc } from '../../services/layer-doc.js'
import type { MapSpec } from './geo/base-render.js'
import type { MapRegistration } from './geo/geometry.js'
import { strictMapLayerDocProblems } from './layer-doc.js'
import { labelProblems } from './layout/labels.js'
import { projectedLabelFeatures, specFeatures } from './validate.js'

/** Add the disclaimer only to non-dataset region labels. If longer labels do not
 * fit, retain their original text and place one explicit legend instead. */
export function annotateRegionLabels(doc: LayerDoc, spec: MapSpec, registration: MapRegistration): { doc: LayerDoc; error?: string } {
  const ids = new Set(spec.regions.filter(region => region.origin !== 'dataset').map(region => region.id))
  const targets = doc.layers.filter(layer => layer.type === 'label' && layer.visible && !!layer.anchor?.semantic_id && ids.has(layer.anchor.semantic_id))
  if (!targets.length) return { doc: { ...doc, layers: doc.layers.filter(layer => !(layer.id === 'region-schematic-note' && layer.name === '区域示意说明')) } }
  const noteId = 'region-schematic-note'
  const existingNote = doc.layers.find(layer => layer.id === noteId)
  if (existingNote && (existingNote.type !== 'label' || existingNote.name !== '区域示意说明')) return { doc, error: `图层 ID ${noteId} 已被占用，请重命名后再添加示意说明。` }
  const original = { ...doc, layers: doc.layers.filter(layer => layer.id !== noteId) }
  const appended: LayerDoc = { ...original, layers: original.layers.map(layer => layer.type === 'label' && targets.some(target => target.id === layer.id)
    ? { ...layer, text: /（示意）$/.test(layer.text) ? layer.text : `${layer.text}（示意）` } : layer) }
  const features = specFeatures(spec), projected = projectedLabelFeatures(features, registration)
  const valid = (candidate: LayerDoc, watched: Set<string>) => !strictMapLayerDocProblems(candidate, { features, registration }).problems.length
    && !labelProblems(candidate, candidate.base, projected).some(problem => watched.has(problem.layer_id))
  if (valid(appended, new Set(targets.map(layer => layer.id)))) return { doc: appended }
  const withoutSuffix: LayerDoc = { ...original, layers: original.layers.map(layer => layer.type === 'label' && targets.some(target => target.id === layer.id)
    ? { ...layer, text: layer.text.replace(/（示意）$/, '') } : layer) }
  const existingLegend = withoutSuffix.layers.find(layer => layer.type === 'label' && layer.visible && layer.text.includes('区域为示意范围'))
  if (existingLegend && valid(withoutSuffix, new Set([existingLegend.id]))) return { doc: withoutSuffix }
  for (let y = .04; y <= .91; y += .05) for (let x = .03; x <= .67; x += .08) {
    const note: Layer = { id: noteId, type: 'label', name: '区域示意说明', text: '区域为示意范围', box: { x, y, w: .3, h: .055 }, visible: true, locked: false, z: 9999, opacity: 1, rotation: 0, style: { size: .021, bg_opacity: 0 } }
    const candidate = { ...withoutSuffix, layers: [...withoutSuffix.layers, note] }
    if (valid(candidate, new Set([noteId]))) return { doc: candidate }
  }
  return { doc, error: '区域示意标注与图例均放不下，请调整标签或腾出图例空间。' }
}
