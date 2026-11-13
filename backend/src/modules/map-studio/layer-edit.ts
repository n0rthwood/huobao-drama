import type { LayerDoc, LayerDocProblem } from '../../services/layer-doc.js'
import { strictMapLayerDocProblems } from './layer-doc.js'
import { parseRegistration, type MapRegistration } from './geo/geometry.js'
import type { MapSpec } from './geo/base-render.js'
import type { MapWorkflowOutputs } from './types.js'
import { optionsForDrawing } from './drawing.js'
import { labelFeaturesOf, labelProblems } from './layout/labels.js'
import { projectedLabelFeatures, specFeatures, type SpecFeature } from './validate.js'
import { renderCopyWithSmoothing, smoothingProblems, validateLayerOptions, type LayerOptions } from './render/smooth.js'

/** Read the module's registered background; no geographic mapping is guessed. */
export function layerDraftContext(spec: MapSpec | null, outputs: MapWorkflowOutputs) {
  const final = outputs.final_image?.provenance, base = outputs.base_image?.provenance
  const registration = parseRegistration(final && 'registration' in final ? final.registration : base && 'registration' in base ? base.registration : null)
  // Previously accepted module documents are the trusted snapshot when old records lack a registration.
  const trustedDoc = outputs.layer_doc as LayerDoc | null
  return { features: spec ? specFeatures(spec) : [], layerOptions: outputs.layer_options, registration: registration ?? undefined, trustedDoc: trustedDoc ?? undefined }
}

/** One pure editor inspection: no writes, rendering, model calls, or automatic correction. */
export function inspectLayerDraft(rawDoc: unknown, rawOptions: unknown, context: {
  features: SpecFeature[]; layerOptions?: LayerOptions; registration?: MapRegistration; trustedDoc?: LayerDoc
}) {
  const strict = strictMapLayerDocProblems(rawDoc, context)
  const parsed = validateLayerOptions(rawOptions ?? {}, strict.doc)
  const layerOptions = { ...optionsForDrawing(strict.doc, context.features, context.layerOptions), ...parsed.options }
  const renderable: LayerDocProblem[] = [...strict.problems, ...parsed.problems, ...smoothingProblems(strict.doc, layerOptions)]
  const renderDoc = renderCopyWithSmoothing(strict.doc, layerOptions)
  const features = context.registration ? projectedLabelFeatures(context.features, context.registration) : labelFeaturesOf(renderDoc)
  return { doc: strict.doc, layerOptions, features, renderable, problems: [...renderable, ...labelProblems(renderDoc, renderDoc.base, features)] }
}
