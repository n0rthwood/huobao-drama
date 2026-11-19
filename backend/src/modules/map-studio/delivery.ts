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
import { projectDetailSemantics } from './pip/semantics.js'
import { buildDetailEditableSource } from './pip/layer-doc.js'

/** One immutable payload drives both host delivery and standalone downloads. */
export function buildDeliverable(loaded: LoadedTask): MapStudioDeliverable {
  const { state, mapSpec } = loaded
  const { final_image: final, base_image: base, layer_doc: doc } = state.outputs
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
      approximate: feature.approximate === true, omitted: feature.missing === true,
      coordinate_basis: source?.coordinate_basis ?? null, excerpt: source?.supporting_excerpt ?? '',
    }
  })
  const warnings = final.provenance && 'warnings' in final.provenance && Array.isArray(final.provenance.warnings) ? final.provenance.warnings.map(String) : []
  // #110：细节图上的语义 = 全览语义要素按细节取景投影（id 与全览一致），宿主据此写细节资产的 props.semantics
  // #127：细节版本同时带投影后的 editable_source（#117 复用口径）——底图/文档/版本共享同一渲染快照 render_key
  const overviewIds = [...geometry.points, ...geometry.routes, ...geometry.regions].map(item => item.id)
  const pip = state.outputs.pip && state.outputs.pip.details.length
    ? {
      ...state.outputs.pip,
      details: state.outputs.pip.details.map(detail => {
        const frame = state.outputs.pip!.frames.find(item => item.no === detail.no)
        if (!frame) return detail
        const semantics = projectDetailSemantics(mapSpec, frame.bbox, { width: detail.width, height: detail.height }, overviewIds)
        const editable = detail.base
          ? buildDetailEditableSource({
            spec: mapSpec, layer_doc: doc, layer_options: state.outputs.layer_options ?? null,
            frame: { no: frame.no, bbox: frame.bbox }, size: { width: detail.width, height: detail.height },
            base: detail.base, tier: state.outputs.pip!.layout.label_tier,
            locatorWidth: state.outputs.pip!.layout.locator?.width ?? Math.round(Math.max(detail.width, detail.height) * 0.2),
            withLocator: true,
          })
          : null
        return { ...detail, semantics, ...(editable ? { editable_source: editable } : {}) }
      }),
    }
    : null
  return {
    task_id: loaded.row.id,
    final_image: { path: final.path, width: final.width, height: final.height, sha256: crypto.createHash('sha256').update(fs.readFileSync(getAbsolutePath(final.path))).digest('hex') },
    base_image: { path: base.path, width: base.width, height: base.height, mode: baseMode, provenance: base.provenance },
    texture_image: state.outputs.texture_image ? { path: state.outputs.texture_image.path } : null,
    semantics: { width: geometry.width, height: geometry.height, points: geometry.points, lines: geometry.routes, regions: geometry.regions, labels: [], warnings, approximate: features.some(feature => feature.approximate), omitted: features.filter(feature => feature.omitted).map(feature => ({ feature_id: feature.feature_id, name: feature.name, reason: '数据集中没有几何，暂不绘制' })), missing_geometry: state.research?.missing_geometry ?? [] },
    features, sources: state.research?.sources ?? [], kmz: state.outputs.kmz ? { path: state.outputs.kmz.path } : null,
    editable_source: { version: 1, map_style: mapSpec.style.map_style ?? null, map_spec: mapSpec, layer_doc: doc, layer_options: options },
    manual_edit: final.source === 'map-drawing-manual',
    summary: `${geometry.points.length} 点 / ${geometry.routes.length} 线 / ${geometry.regions.length} 面，底图路线 ${baseMode}${pip ? `；画中画 ${pip.details.length} 个细节` : ''}`,
    pip,
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
  // 同一张成图但细节/组合图变了（重新取景）必须重新交付
  const deliveryKey = d.pip ? crypto.createHash('sha256').update(JSON.stringify([d.final_image.sha256, d.pip.details.map(x => x.sha256), d.pip.composite?.sha256 ?? null])).digest('hex') : d.final_image.sha256
  const previous = selectDeliveryBySha(taskId, deliveryKey)
  if (previous?.result) return JSON.parse(previous.result) as MapStudioDeliveryResult
  const result = await loaded.host.deliver(loaded.row.host_ref, d)
  insertDelivery({ taskId, runId: loaded.state.run_id, host: loaded.row.host, hostRef: loaded.row.host_ref, finalSha256: deliveryKey, result })
  return result
}
