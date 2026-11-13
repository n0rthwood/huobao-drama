import type { schema } from '../db/index.js'
import { toSnakeCase } from '../utils/transform.js'

export type PropRow = typeof schema.props.$inferSelect
export const PROP_ASSET_TYPES = ['prop', 'map'] as const
export type PropAssetType = typeof PROP_ASSET_TYPES[number]

/** Explicit identity, never inferred from a name, legacy spec, or faithful flag. */
export function isMapAsset(prop: Pick<PropRow, 'assetType'>): boolean {
  return (prop.assetType ?? 'prop') === 'map'
}

export function parseAssetType(raw: unknown, fallback: PropAssetType): PropAssetType | null {
  if (raw === undefined || raw === null || raw === '') return fallback
  return (PROP_ASSET_TYPES as readonly string[]).includes(String(raw)) ? String(raw) as PropAssetType : null
}

/** Host owns a brief and a module task reference, not the module's state or geometry. */
export function serializeProp(row: PropRow): Record<string, unknown> {
  const payload = toSnakeCase(row)
  delete payload.map_workflow
  delete payload.map_spec
  payload.asset_type = row.assetType ?? 'prop'
  if (isMapAsset(row)) {
    try { payload.map_brief = row.mapBrief ? JSON.parse(row.mapBrief) : null } catch { payload.map_brief = null }
    payload.map_studio_task_id = row.mapStudioTaskId ?? null
  } else {
    delete payload.map_brief
    delete payload.map_studio_task_id
  }
  return payload
}
