import crypto from 'node:crypto'
import fs from 'node:fs'
import { getAbsolutePath } from '../../utils/storage.js'
import type { LayerDoc } from '../../services/layer-doc.js'
import { insertDelivery, selectDeliveryBySha } from './db.js'
import type { MapStudioDeliverable, MapStudioDeliveryResult } from './contract.js'
import { loadTask, requireHostTarget, briefHash, MapStudioRequestError, MapStudioStaleError, type LoadedTask } from './store.js'
import { drawnGeometryOf, specFeatures } from './validate.js'

/** One immutable payload drives both host delivery and standalone downloads. */
export function buildDeliverable(loaded: LoadedTask): MapStudioDeliverable {
  const { state, mapSpec } = loaded
  const { final_image: final, base_image: base, layer_doc: doc } = state.outputs
  if (!final || !base || !doc || !mapSpec) throw new MapStudioRequestError('缺少成图、底图、图层文档或地图几何，请先完成标注绘制', 'missing_drawing')
  const geometry = drawnGeometryOf(doc as LayerDoc, specFeatures(mapSpec))
  const mode = base.provenance && 'mode' in base.provenance ? base.provenance.mode : loaded.brief.base_mode
  const baseMode = mode === 'image' || mode === 'earth' ? mode : 'program'
  const features = specFeatures(mapSpec).map(feature => {
    const item = [...mapSpec.places, ...mapSpec.routes, ...(mapSpec.regions ?? [])].find(item => item.id === feature.id)
    const source = state.research?.features.find(item => item.name === feature.name && item.kind === feature.kind)
    return {
      feature_id: feature.id, name: feature.name, kind: feature.kind,
      origin: item?.proposed !== true ? 'manual' : source ? 'research' : 'model',
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
    editable_source: { version: 1, map_spec: mapSpec, layer_doc: doc },
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
