/**
 * 存量 PiP 细节资产补算图层文档（Issue #127，接入 #117 复用）。
 *
 * 背景：细节图过去只登记烧录 PNG（provider='map-render'、params 只有 frame/png_sha256），
 * 以细节为底图的图层段因此退回「烧录底图 + 语义重画」。交付侧的修复（`pip/render.ts` 落盘渲染快照底图、
 * `delivery.ts` 生成投影 `editable_source`）只对**新交付**生效；本脚本给存量细节补同一份数据：
 *
 *   1. 渲染快照底图：`renderReliefBase` 程序底图 + 角标定位图，内容寻址落盘
 *      `static/map-bases/pip-detail{no}-<render_key>.png`（已存在则复用，不重渲染）；
 *   2. 投影图层文档：全览成图版本的 `editable_source.layer_doc` 按本细节取景投影（几何不裁剪），
 *      `pipLabels` 注记转锚定 label 层，`layer_options` 沿用；
 *   3. 写进细节版本 `sys_task.params.editable_source`（provider 保持 `map-render`）；
 *   4. touch 资产 `props.updated_at`：`mapAssetLayersOf` 的缓存键含它，段读路径/解析缓存因此失效。
 *
 * 来源判据（绝不编造）：全览必须有一个 `provider='map-workflow'` 的完成版本，其
 * `params.editable_source` 同时带 `layer_doc` 与 `map_spec`，且与资产当前图（`props.local_path`）
 * 一致；缺失的细节列为「不可迁移」并计数。旧地图工作流资产（只有 `props.map_workflow.outputs.layer_doc`）
 * 没有 map_spec → 不可迁移，交给 #125 的修复脚本框架。
 *
 * 用法（在 backend 下，数据目录与线上一致即可）：
 *   npx tsx scripts/backfill-pip-layer-docs.ts                      # dry-run（默认）：只报告，不写库/不落盘
 *   npx tsx scripts/backfill-pip-layer-docs.ts --dry-run --json     # 机器可读计划（含底图文件名）
 *   npx tsx scripts/backfill-pip-layer-docs.ts --apply              # 先自动备份 DB，再写入
 *   npx tsx scripts/backfill-pip-layer-docs.ts --apply --backup /path/to/backup.sqlite3
 *   npx tsx scripts/backfill-pip-layer-docs.ts --apply --no-backup  # 明确跳过备份（会打印警告）
 *
 * 幂等：已有 `params.editable_source` 的版本一律跳过；第二次 `--apply` 写入计数为 0。
 */
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { dbPath, sqlite } from '../src/db/index.js'
import { STORAGE_ROOT } from '../src/utils/paths.js'
import { getAbsolutePath } from '../src/utils/storage.js'
import { now } from '../src/utils/response.js'
import { normalizeMapSpec } from '../src/modules/map-studio/geo/base-render.js'
import type { MapPipFrame } from '../src/modules/map-studio/pip/frames.js'
import {
  buildDetailEditableSource, pipDetailBaseName, pipDetailRenderKey, type PipDetailBase,
} from '../src/modules/map-studio/pip/layer-doc.js'
import { renderDetailBaseImage } from '../src/modules/map-studio/pip/render.js'

const APPLY = process.argv.includes('--apply')
const JSON_OUT = process.argv.includes('--json')
const NO_BACKUP = process.argv.includes('--no-backup')
const backupFlag = process.argv.find(arg => arg.startsWith('--backup='))?.slice('--backup='.length)

interface PropRow { id: number; name: string; local_path: string | null; image_url: string | null; map_pip: string | null }
interface TaskRow { id: number; params: string | null; local_path: string | null }

interface ParentSource {
  version_task_id: number
  layer_doc: unknown
  map_spec: unknown
  layer_options: unknown
  base_image: { path: string; width: number; height: number }
  locator_width: number
  label_tier: 'full' | 'reduced' | 'focus_only'
}

type EntryStatus = 'already' | 'migratable' | 'unmigratable'

interface PlanEntry {
  prop_id: number
  name: string
  parent_prop_id: number
  version_task_id: number | null
  frame_no: number | null
  status: EntryStatus
  reason?: string
  base_path?: string
  base_exists?: boolean
  render_key?: string
  warnings?: string[]
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function bboxOf(raw: unknown): [number, number, number, number] | null {
  return Array.isArray(raw) && raw.length === 4 && raw.every(value => typeof value === 'number' && Number.isFinite(value))
    ? raw as [number, number, number, number]
    : null
}

/** 全览成图版本的 `editable_source`（layer_doc + map_spec + 属于当前图）——补算的唯一来源 */
function parentSourceOf(parent: PropRow): { source: ParentSource | null; reason?: string } {
  const current = parent.local_path || parent.image_url || ''
  if (!current) return { source: null, reason: 'parent_image_missing' }
  const meta = parseJson(parent.map_pip) as { layout?: { locator?: { width?: number } | null; label_tier?: string } } | null
  const locatorWidth = meta?.layout?.locator?.width
  const rawTier = meta?.layout?.label_tier
  const labelTier = rawTier === 'full' || rawTier === 'reduced' || rawTier === 'focus_only' ? rawTier : 'full'
  const rows = sqlite.prepare(`SELECT id, params, local_path FROM sys_task WHERE prop_id = ? AND provider = 'map-workflow' AND status = 'completed'
    AND (local_path = ? OR result_url = ?) ORDER BY id DESC`).all(parent.id, current, current) as TaskRow[]
  for (const row of rows) {
    const params = parseJson(row.params) as { editable_source?: Record<string, unknown> } | null
    const source = params?.editable_source
    if (!source || typeof source !== 'object') continue
    const doc = source.layer_doc as { base?: { path?: unknown; width?: unknown; height?: unknown } } | undefined
    if (!doc || typeof doc !== 'object' || typeof doc.base?.path !== 'string' || !doc.base.path) continue
    if (!source.map_spec) return { source: null, reason: 'parent_spec_missing' }
    const width = Number(doc.base.width)
    const height = Number(doc.base.height)
    return {
      source: {
        version_task_id: row.id,
        layer_doc: doc,
        map_spec: source.map_spec,
        layer_options: source.layer_options ?? null,
        base_image: { path: doc.base.path, width: Number.isFinite(width) && width > 0 ? width : 0, height: Number.isFinite(height) && height > 0 ? height : 0 },
        locator_width: typeof locatorWidth === 'number' && locatorWidth > 0
          ? Math.round(locatorWidth)
          : Math.round(Math.max(Number(doc.base.width) || 3840, Number(doc.base.height) || 2160) * 0.2),
        label_tier: labelTier,
      },
    }
  }
  return { source: null, reason: 'parent_source_unavailable' }
}

async function imageSize(relativePath: string | null): Promise<{ width: number; height: number } | null> {
  if (!relativePath) return null
  try {
    const meta = await sharp(getAbsolutePath(relativePath)).metadata()
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null
  } catch { return null }
}

/** 一个细节的补算计划：只读，不写库、不落盘（底图存在则标 exists，缺则由 apply 渲染） */
export async function planBackfill(): Promise<PlanEntry[]> {
  const details = sqlite.prepare("SELECT id, name, local_path, image_url, map_pip FROM props WHERE map_pip LIKE '%\"role\":\"detail\"%' AND deleted_at IS NULL ORDER BY id").all() as PropRow[]
  const entries: PlanEntry[] = []
  for (const detail of details) {
    const meta = parseJson(detail.map_pip) as { parent_prop_id?: number; frame?: Record<string, unknown> } | null
    const parentId = Number(meta?.parent_prop_id)
    const version = sqlite.prepare("SELECT id, params, local_path FROM sys_task WHERE prop_id = ? AND model = 'map-studio-detail' AND status = 'completed' ORDER BY id DESC LIMIT 1")
      .get(detail.id) as TaskRow | undefined
    const base = { prop_id: detail.id, name: detail.name, parent_prop_id: Number.isFinite(parentId) ? parentId : 0, version_task_id: version?.id ?? null, frame_no: Number(meta?.frame?.no) || null }
    if (!version) { entries.push({ ...base, status: 'unmigratable', reason: 'version_missing' }); continue }
    const params = parseJson(version.params) as Record<string, unknown> | null
    if (params?.editable_source) { entries.push({ ...base, status: 'already' }); continue }
    const bbox = bboxOf(meta?.frame?.bbox)
    if (!bbox) { entries.push({ ...base, status: 'unmigratable', reason: 'frame_bbox_missing' }); continue }
    const parent = sqlite.prepare('SELECT id, name, local_path, image_url, map_pip FROM props WHERE id = ? AND deleted_at IS NULL').get(base.parent_prop_id) as PropRow | undefined
    if (!parent) { entries.push({ ...base, status: 'unmigratable', reason: 'parent_missing' }); continue }
    const { source, reason } = parentSourceOf(parent)
    if (!source) { entries.push({ ...base, status: 'unmigratable', reason }); continue }
    const size = await imageSize(version.local_path ?? detail.local_path)
    if (!size) { entries.push({ ...base, status: 'unmigratable', reason: 'detail_image_missing' }); continue }
    const renderKey = pipDetailRenderKey(source.map_spec, bbox, size)
    const basePath = `static/map-bases/${pipDetailBaseName(base.frame_no ?? 0, renderKey)}`
    const warnings: string[] = []
    if (source.base_image.width <= 0 || source.base_image.height <= 0) warnings.push('parent_base_size_missing')
    if (!fs.existsSync(getAbsolutePath(source.base_image.path))) warnings.push('parent_base_missing_locator_skipped')
    entries.push({ ...base, status: 'migratable', base_path: basePath, base_exists: fs.existsSync(getAbsolutePath(basePath)), render_key: renderKey, ...(warnings.length ? { warnings } : {}) })
  }
  return entries
}

interface ApplyResult {
  written: number
  rendered_base: number
  reused_base: number
  failures: Array<{ prop_id: number; reason: string }>
}

async function applyEntry(entry: PlanEntry, ts: string): Promise<'rendered' | 'reused'> {
  const detail = sqlite.prepare('SELECT id, local_path, map_pip FROM props WHERE id = ?').get(entry.prop_id) as PropRow
  const meta = parseJson(detail.map_pip) as { frame?: Record<string, unknown> } | null
  const bbox = bboxOf(meta?.frame?.bbox)!
  const version = sqlite.prepare('SELECT id, params, local_path FROM sys_task WHERE id = ?').get(entry.version_task_id) as TaskRow
  const parent = sqlite.prepare('SELECT id, name, local_path, image_url, map_pip FROM props WHERE id = ?').get(entry.parent_prop_id) as PropRow
  const { source } = parentSourceOf(parent)
  if (!source) throw new Error('parent_source_unavailable')
  const size = (await imageSize(version.local_path ?? detail.local_path))!
  const frame: MapPipFrame = {
    no: entry.frame_no ?? 0, label: '', reason: '', role: 'aux',
    focus_bbox: bbox, bbox, storyboard_numbers: [],
  }
  const basePath = entry.base_path!
  let outcome: 'rendered' | 'reused' = 'reused'
  if (!fs.existsSync(getAbsolutePath(basePath))) {
    const overviewBase = fs.existsSync(getAbsolutePath(source.base_image.path))
      ? { path: source.base_image.path, width: source.base_image.width, height: source.base_image.height }
      : undefined
    await renderDetailBaseImage({
      spec: normalizeMapSpec(source.map_spec), frame, bbox, size,
      locatorWidth: source.locator_width, withLocator: Boolean(overviewBase), overviewBase,
    })
    if (!fs.existsSync(getAbsolutePath(basePath))) throw new Error('base_render_failed')
    outcome = 'rendered'
  }
  const baseAbs = getAbsolutePath(basePath)
  const base: PipDetailBase = {
    path: basePath, width: size.width, height: size.height,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(baseAbs)).digest('hex'),
    render_key: entry.render_key!,
  }
  const editable = buildDetailEditableSource({
    spec: source.map_spec, layer_doc: source.layer_doc, layer_options: source.layer_options,
    frame: { no: entry.frame_no ?? 0, bbox }, size, base,
    tier: source.label_tier, locatorWidth: source.locator_width, withLocator: true,
  })
  if (!editable) throw new Error('layer_doc_unresolved')
  const params = parseJson(version.params) as Record<string, unknown> ?? {}
  const tx = sqlite.transaction(() => {
    sqlite.prepare('UPDATE sys_task SET params = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...params, editable_source: editable }), ts, version.id)
    // touch 资产：mapAssetLayersOf 的缓存键含 props.updated_at，段解析缓存同样按它取指纹
    sqlite.prepare('UPDATE props SET updated_at = ? WHERE id = ?').run(ts, entry.prop_id)
  })
  tx()
  return outcome
}

async function main() {
  const entries = await planBackfill()
  const counted = (status: EntryStatus) => entries.filter(entry => entry.status === status).length
  const counts = {
    details: entries.length,
    already: counted('already'),
    migratable: counted('migratable'),
    unmigratable: counted('unmigratable'),
    rendered_base: 0,
    reused_base: 0,
    written: 0,
    failed: 0,
  }
  let backupPath: string | null = null
  if (APPLY && counted('migratable') > 0) {
    if (NO_BACKUP) {
      console.warn('[backfill-pip-layer-docs] 警告：--no-backup，未备份数据库')
    } else {
      backupPath = path.resolve(backupFlag ?? `${dbPath}.bak-pip-layer-docs-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      await sqlite.backup(backupPath)
      console.log(`[backfill-pip-layer-docs] 已备份数据库 → ${backupPath}`)
    }
  }
  const result: ApplyResult = { written: 0, rendered_base: 0, reused_base: 0, failures: [] }
  if (APPLY) {
    for (const entry of entries) {
      if (entry.status !== 'migratable') continue
      try {
        const outcome = await applyEntry(entry, now())
        result.written++
        if (outcome === 'rendered') result.rendered_base++
        else result.reused_base++
      } catch (err) {
        result.failures.push({ prop_id: entry.prop_id, reason: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  counts.written = result.written
  counts.rendered_base = result.rendered_base
  counts.reused_base = result.reused_base
  counts.failed = result.failures.length
  if (JSON_OUT) {
    console.log(JSON.stringify({ apply: APPLY, data_dir: STORAGE_ROOT, db: dbPath, backup: backupPath, counts, entries, failures: result.failures }, null, 2))
    return
  }
  console.log(`[backfill-pip-layer-docs] ${APPLY ? 'apply' : 'dry-run'}：细节 ${counts.details} 个 —— 已接入 ${counts.already}、可迁移 ${counts.migratable}、不可迁移 ${counts.unmigratable}`)
  for (const entry of entries) {
    const suffix = entry.status === 'migratable'
      ? `底图 ${entry.base_exists ? '已存在' : '待渲染'} ${entry.base_path}${entry.warnings?.length ? `（${entry.warnings.join('、')}）` : ''}`
      : entry.status === 'unmigratable' ? `不可迁移：${entry.reason}` : '已带 editable_source'
    console.log(`  prop#${entry.prop_id} 细节${entry.frame_no ?? '?'} 版本#${entry.version_task_id ?? '-'} → ${suffix}`)
  }
  if (APPLY) console.log(`[backfill-pip-layer-docs] 写入 ${counts.written}（重渲染底图 ${counts.rendered_base}、复用 ${counts.reused_base}、失败 ${counts.failed}）`)
  for (const failure of result.failures) console.log(`  prop#${failure.prop_id} 失败：${failure.reason}`)
}

await main()
