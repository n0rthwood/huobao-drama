import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { getSpec, listAssetRounds, type AssetRoundRow } from './store.js'

/** Identity metadata aligned with sys_task.params.referenceImages; paths live only in that input. */
export type ReferenceOrigin =
  | { type: 'source'; source_id: number }
  | { type: 'prev_round'; round_id: number }
  | { type: 'unknown' }
export type RoundReferenceImage = ReferenceOrigin & { path: string }
type SourcePath = { id: number | null; local_path: string }

/** Never follow symlinks or inspect files outside static, including during provenance lookup. */
export function canonicalReferencePath(value: string): string | null {
  if (!value || value.includes('\0') || value.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null
  const root = path.resolve(STORAGE_ROOT)
  const relative = value.startsWith('/static/') ? value.slice(8)
    : value.startsWith('static/') ? value.slice(7) : value
  const absolute = path.resolve(root, relative)
  if (!absolute.startsWith(root + path.sep)) return null
  try {
    // Walk from the storage root so realpath/stat cannot follow an escaping intermediate symlink.
    if (fs.lstatSync(root).isSymbolicLink()) return null
    let current = root
    for (const part of path.relative(root, absolute).split(path.sep)) {
      current = path.join(current, part)
      if (fs.lstatSync(current).isSymbolicLink()) return null
    }
    return fs.statSync(absolute).isFile() ? fs.realpathSync(absolute) : null
  } catch {
    return null
  }
}

/** Known selection IDs take priority; path lookup is only a unique-match fallback. */
export function resolveReferenceOrigins(
  images: string[],
  sources: SourcePath[],
  previousRounds: AssetRoundRow[],
  selected?: ReferenceOrigin[],
): ReferenceOrigin[] {
  return images.map((image, index): ReferenceOrigin => {
    const canonical = canonicalReferencePath(image)
    if (!canonical) return { type: 'unknown' }
    const previous = previousRounds.filter(round => round.image_path && canonicalReferencePath(round.image_path) === canonical)
    const chosen = selected?.[index]
    // A round output must never masquerade as a source, even if registered under the same path.
    if (previous.length) {
      if (chosen?.type === 'prev_round' && previous.some(round => round.id === chosen.round_id)) return chosen
      return previous.length === 1 ? { type: 'prev_round', round_id: previous[0]!.id } : { type: 'unknown' }
    }
    if (chosen?.type === 'unknown' || chosen?.type === 'prev_round') return { type: 'unknown' }
    const matches = sources.filter(source => canonicalReferencePath(source.local_path) === canonical)
    if (chosen?.type === 'source') {
      return matches.some(source => source.id === chosen.source_id) ? chosen : { type: 'unknown' }
    }
    return matches.length === 1 && matches[0]!.id != null
      ? { type: 'source', source_id: matches[0]!.id! } : { type: 'unknown' }
  })
}

function readOrigin(value: unknown): ReferenceOrigin {
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    if (item.type === 'source' && Number.isSafeInteger(item.source_id) && Number(item.source_id) > 0) {
      return { type: 'source', source_id: Number(item.source_id) }
    }
    if (item.type === 'prev_round' && Number.isSafeInteger(item.round_id) && Number(item.round_id) > 0) {
      return { type: 'prev_round', round_id: Number(item.round_id) }
    }
  }
  return { type: 'unknown' }
}

/** Read-only assembly: never infer input paths from today's source selection, spec or asset image. */
export async function roundReferenceImages(round: AssetRoundRow): Promise<RoundReferenceImage[]> {
  const [task] = round.image_task_id
    ? await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, round.image_task_id)) : []
  let params: Record<string, unknown>
  try {
    params = JSON.parse(task?.params || '{}')
    if (!params || typeof params !== 'object') return [{ type: 'unknown', path: '' }]
  } catch {
    return [{ type: 'unknown', path: '' }]
  }
  if (!Array.isArray(params.referenceImages)) {
    // New explicit empty metadata distinguishes a real text-only input from missing historical params.
    return Array.isArray(params.pipeline_reference_origins) && !params.pipeline_reference_origins.length
      ? [] : [{ type: 'unknown', path: '' }]
  }
  const images = params.referenceImages.map(value => typeof value === 'string' ? value : '')
  let origins: ReferenceOrigin[]
  if (Array.isArray(params.pipeline_reference_origins)) {
    origins = images.map((_, index) => readOrigin((params.pipeline_reference_origins as unknown[])[index]))
  } else {
    // Legacy tasks have no identity metadata. Use only the round's frozen spec snapshot, never live sources.
    const spec = round.spec_id ? await getSpec(round.spec_id) : null
    const sources = (spec?.sources ?? []).map(source => ({ id: source.source_id, local_path: source.local_path }))
    const previous = (await listAssetRounds(round.asset_kind, round.asset_id)).filter(item => item.id < round.id)
    origins = resolveReferenceOrigins(images, sources, previous)
  }
  return images.map((image, index) => ({
    ...(canonicalReferencePath(image) ? origins[index]! : { type: 'unknown' as const }),
    path: image,
  }))
}
