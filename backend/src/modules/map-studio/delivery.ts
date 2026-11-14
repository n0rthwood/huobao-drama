import crypto from 'node:crypto'
import fs from 'node:fs'
import { getAbsolutePath } from '../../utils/storage.js'
import type { LayerDoc } from '../../services/layer-doc.js'
import { insertDelivery, selectDeliveryBySha } from './db.js'
import type { MapStudioDeliverable, MapStudioDeliveryResult } from './contract.js'
import { loadTask, requireHostTarget, briefHash, MapStudioRequestError, MapStudioStaleError, type LoadedTask } from './store.js'
import { drawnGeometryOf, projectedLabelFeatures, specFeatures } from './validate.js'
import { renderCopyWithSmoothing, smoothingProblems } from './render/smooth.js'
import { labelFeaturesOf, labelProblems } from './layout/labels.js'
import { layerDraftContext } from './layer-edit.js'
import { geometryUnverified } from './accuracy.js'

/** One immutable payload drives both host delivery and standalone downloads. */
export function buildDeliverable(loaded: LoadedTask): MapStudioDeliverable {
  const { state, mapSpec } = loaded
  const { final_image: final, base_image: base, layer_doc: doc } = state.outputs
  const pending = mapSpec ? geometryUnverified(mapSpec) : []
  if (pending.length) throw new MapStudioRequestError(`geometry_unverified：${pending.map(f => `「${f.name}」：${f.reasons.join('；')}`).join(' / ')}`, 'geometry_unverified')
  if (!final || !base || !doc || !mapSpec) throw new MapStudioRequestError('缺少成图、底图、图层文档或地图几何，请先完成标注绘制', 'missing_drawing')
  const controlDoc = doc as LayerDoc
  const options = state.outputs.layer_options ?? {}
  const renderDoc = renderCopyWithSmoothing(controlDoc, options)
  const context = layerDraftContext(mapSpec, state.outputs)
  const anchors = context.registration ? projectedLabelFeatures(context.features, context.registration) : labelFeaturesOf(renderDoc)
  const problems = [...smoothingProblems(controlDoc, options), ...labelProblems(renderDoc, renderDoc.base, anchors)]
  if (problems.length) throw new MapStudioRequestError(problems.map(p => p.message).join('；'), 'drawing_invalid')
  const geometry = drawnGeometryOf(renderDoc, specFeatures(mapSpec))
  const mode = base.provenance && 'mode' in base.provenance ? base.provenance.mode : loaded.brief.base_mode
  const baseMode = mode === 'image' || mode === 'earth' ? mode : 'program'
  const features = specFeatures(mapSpec).map(feature => {
    const item = [...mapSpec.places, ...mapSpec.routes, ...(mapSpec.regions ?? [])].find(item => item.id === feature.id)
    const source = state.research?.features.find(source => source.kind === feature.kind && (source.name === feature.name || !!item?.dataset_ref && source.dataset_ref?.ref === item.dataset_ref.ref))
    return {
      feature_id: feature.id, name: feature.name, kind: feature.kind,
      origin: item?.origin ?? (item?.proposed !== true ? 'manual' : 'model'),
      verification: item?.proposed !== true ? { status: 'confirmed', reasons: ['人工确认或编辑'] } : item?.verification,
      relations: item?.relations ?? [], dataset_ref: item?.dataset_ref ?? null, category: item?.category ?? null,
      proposed: item?.proposed === true, source_ids: source?.source_ids ?? [],
      coordinate_basis: source?.coordinate_basis ?? null, excerpt: source?.supporting_excerpt ?? '',
    }
  })
  const warnings = final.provenance && 'warnings' in final.provenance && Array.isArray(final.provenance.warnings) ? final.provenance.warnings.map(String) : []
  return {
    task_id: loaded.row.id,
    final_image: { path: final.path, width: final.width, height: final.height, sha256: crypto.createHash('sha256').update(fs.readFileSync(getAbsolutePath(final.path))).digest('hex') },
    base_image: { path: base.path, width: base.width, height: base.height, mode: baseMode, provenance: base.provenance },
    texture_image: state.outputs.texture_image ? { path: state.outputs.texture_image.path } : null,
    semantics: { width: geometry.width, height: geometry.height, points: geometry.points, lines: geometry.routes, regions: geometry.regions, labels: [], warnings },
    features, sources: state.research?.sources ?? [], kmz: state.outputs.kmz ? { path: state.outputs.kmz.path } : null,
    editable_source: { version: 1, map_style: mapSpec.style.map_style ?? null, map_spec: mapSpec, layer_doc: doc, layer_options: options },
    manual_edit: final.source === 'map-drawing-manual',
    summary: `${geometry.points.length} 点 / ${geometry.routes.length} 线 / ${geometry.regions.length} 面，底图路线 ${baseMode}`,
  }
}

export async function deliverCurrent(taskId: number, expected?: { runId?: number; briefHash?: string | null }): Promise<MapStudioDeliveryResult> {
  const loaded = await loadTask(taskId)
  if (!loaded) throw new MapStudioRequestError('任务不存在', 'not_found')
  requireHostTarget(loaded)
  if (expected?.runId !== undefined && loaded.state.run_id !== expected.runId || expected?.briefHash && briefHash(loaded.brief) !== expected.briefHash) {
    throw new MapStudioStaleError('本次成果已过期：运行或需求已改变，不交付到宿主')
  }
  if (loaded.state.stage !== 'complete') throw new MapStudioRequestError('当前成果尚未进入交付阶段，请先完成标注绘制', 'delivery_not_ready')
  const d = buildDeliverable(loaded)
  if (!loaded.row.host || !loaded.row.host_ref || !loaded.host) return { version_ids: [], message: `独立地图已完成：${d.summary}；可下载成图、语义与源文件` }
  const previous = selectDeliveryBySha(taskId, d.final_image.sha256)
  if (previous?.result) return JSON.parse(previous.result) as MapStudioDeliveryResult
  const result = await loaded.host.deliver(loaded.row.host_ref, d)
  insertDelivery({ taskId, runId: loaded.state.run_id, host: loaded.row.host, hostRef: loaded.row.host_ref, finalSha256: d.final_image.sha256, result })
  return result
}
