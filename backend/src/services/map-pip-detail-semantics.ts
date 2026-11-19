/**
 * 画中画细节语义的启动回填（Issue #110）——宿主侧，独立成文件是为了不把 map-studio 运行时
 * 拉进 `agents/tools` 的 import 图（`map-pip-assets.ts` 被分镜工具直接引用，只导出纯读路径）。
 *
 * 细节资产是同一份 map_spec 的局部渲染：登记时模块已在交付里算好语义；存量资产（升级前登记、
 * `props.semantics` 为空）在这里按同样的投影补算一次，幂等——有几何就不再算。
 *
 * 数据来源都是已有事实：细节取景框来自 `props.map_pip.frame.bbox`，画幅来自细节 PNG 的实际像素，
 * 地图几何来自全览道具最新一版成图任务的 `params.editable_source.map_spec`（即交付事务里
 * map_studio_task 的 map_spec），要素 id 取自全览自己的 `props.semantics`——与全览语义逐条对应。
 * 任一项缺失就跳过该资产（不编造几何），下次启动再试。
 */
import fs from 'node:fs'
import { sqlite } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { logTaskSuccess } from '../utils/task-logger.js'
import { projectDetailSemantics } from '../modules/map-studio/index.js'
import { backfillSemanticsTargets, semanticsJsonOf } from './map-pip-assets.js'
import { semanticAnnotationsOf } from './map-semantic-annotations.js'

/** 交付语义文档 / 已存语义里的要素 id（points/routes/lines/regions）；细节只投影这些要素 */
function semanticIdsOf(raw: unknown): string[] {
  const doc = raw as { points?: Array<{ id?: unknown }>; routes?: Array<{ id?: unknown }>; lines?: Array<{ id?: unknown }>; regions?: Array<{ id?: unknown }> } | null
  if (!doc || typeof doc !== 'object') return []
  const ids: string[] = []
  for (const item of [...(doc.points ?? []), ...(doc.routes ?? []), ...(doc.lines ?? []), ...(doc.regions ?? [])]) {
    if (typeof item?.id === 'string' && item.id && !ids.includes(item.id)) ids.push(item.id)
  }
  return ids
}

/** PNG 头里的宽高（同步读 24 字节；读不到返回 null，绝不猜画幅） */
export function pngSizeOf(relativePath: string | null | undefined): { width: number; height: number } | null {
  if (!relativePath) return null
  try {
    const fd = fs.openSync(getAbsolutePath(relativePath), 'r')
    try {
      const header = Buffer.alloc(24)
      if (fs.readSync(fd, header, 0, 24, 0) < 24) return null
      if (header.toString('ascii', 12, 16) !== 'IHDR') return null
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

/** 全览道具交付时写下的 map_spec（最新一版 completed 成图任务的 editable_source） */
export function overviewMapSpecOf(parentId: number): unknown {
  const version = sqlite.prepare("SELECT params FROM sys_task WHERE prop_id = ? AND provider = 'map-workflow' AND status = 'completed' ORDER BY id DESC LIMIT 1").get(parentId) as { params: string | null } | undefined
  try {
    const params = JSON.parse(version?.params ?? '{}') as { editable_source?: { map_spec?: unknown } }
    return params.editable_source?.map_spec ?? null
  } catch { return null }
}

/** 全览最新一版交付的 `params.features` / `params.sources`（语义 description 的拼接素材） */
export function overviewDeliveryFactsOf(parentId: number): { features: unknown[]; sources: unknown[] } {
  const version = sqlite.prepare("SELECT params FROM sys_task WHERE prop_id = ? AND provider = 'map-workflow' AND status = 'completed' ORDER BY id DESC LIMIT 1").get(parentId) as { params: string | null } | undefined
  try {
    const params = JSON.parse(version?.params ?? '{}') as { features?: unknown[]; sources?: unknown[] }
    return { features: Array.isArray(params.features) ? params.features : [], sources: Array.isArray(params.sources) ? params.sources : [] }
  } catch { return { features: [], sources: [] } }
}

/** 投影 + 规范化；投影失败（坏 map_spec / 这一帧没有任何要素）返回 null，不写空语义 */
function projectSemantics(
  mapSpec: unknown,
  bbox: unknown,
  size: { width: number; height: number },
  ids: string[],
  sourceTaskId: number,
  ts: string,
  facts: { features: unknown[]; sources: unknown[] },
): string | null {
  try {
    const geometry = projectDetailSemantics(mapSpec, bbox, size, ids)
    if (!geometry.points.length && !geometry.lines.length && !geometry.regions.length) return null
    return semanticsJsonOf(geometry, sourceTaskId, ts, semanticAnnotationsOf(facts.features, facts.sources))
  } catch { return null }
}

/** 启动回填（幂等）：给 `role='detail'` 且语义没有几何的细节资产补算语义。 */
export function backfillPipDetailSemantics(): number {
  const ts = now()
  let updated = 0
  for (const target of backfillSemanticsTargets()) {
    const overviewIds = semanticIdsOf(target.parentSemantics)
    const mapSpec = overviewMapSpecOf(target.parentId)
    if (!overviewIds.length || !mapSpec) continue
    const size = pngSizeOf(target.imagePath)
    if (!size || !target.versionTaskId) continue
    const semantics = projectSemantics(mapSpec, target.bbox, size, overviewIds, target.versionTaskId, ts, overviewDeliveryFactsOf(target.parentId))
    if (!semantics) continue
    sqlite.prepare('UPDATE props SET semantics = ?, updated_at = ? WHERE id = ?').run(semantics, ts, target.propId)
    updated++
  }
  if (updated) logTaskSuccess('MapPip', 'backfill-detail-semantics', { props: updated })
  return updated
}
