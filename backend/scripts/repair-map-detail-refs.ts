/**
 * 地图细节资产引用修复（Issue #125）——**显式管理动作，不做启动自动迁移**。
 *
 * 用法（在 backend/ 下）：
 *   npx tsx scripts/repair-map-detail-refs.ts --dry-run   # 只报告，不写库
 *   npx tsx scripts/repair-map-detail-refs.ts --apply     # 备份 + 写入
 *
 * 做三件事：
 * a) 对每个画中画细节资产，按**当前**全览 `map_spec` + `map_pip.frame.bbox` 重算投影语义
 *    （幂等：内容没变就不写，第二次 `--apply` 输出 0 写入）；
 * b) 扫描设计卡里对细节资产的 `semantic_id` 引用，投影后解析不到的逐条列出，
 *    `--apply` 时把这些分镜的设计卡标 `asset_semantic_unresolved`（人工重新填卡）；
 * c) `--apply` 前用 better-sqlite3 的 SQLite backup API 备份数据库文件。
 *
 * 语义要素 id 集合发生变化的细节资产会在 `map_pip` 里记 `content_changed_at`
 * （交付路径同口径），组规划与引用它的设计卡读时因此判过期。
 */
import { sqlite, dbPath } from '../src/db/index.js'
import { now } from '../src/utils/response.js'
import { projectDetailSemantics } from '../src/modules/map-studio/index.js'
import type { PipDetailGeometry } from '../src/modules/map-studio/index.js'
import { parseSemantics } from '../src/services/asset-semantics.js'
import {
  geometrySemanticIds,
  parsePipMeta,
  sameSemanticIdSet,
  semanticIdSet,
  semanticsJsonOf,
} from '../src/services/map-pip-assets.js'
import { semanticAnnotationsOf } from '../src/services/map-semantic-annotations.js'
import { overviewDeliveryFactsOf, overviewMapSpecOf, pngSizeOf } from '../src/services/map-pip-detail-semantics.js'
import { semanticRefsByStoryboard } from '../src/services/map-asset-references.js'
import { markStale } from '../src/services/staleness.js'

const DRY_RUN = process.argv.includes('--dry-run')
const APPLY = process.argv.includes('--apply')
if (DRY_RUN === APPLY) {
  console.error('用法：npx tsx scripts/repair-map-detail-refs.ts --dry-run | --apply（二选一）')
  process.exit(2)
}

interface DetailRow {
  id: number
  name: string
  map_pip: string
  semantics: string | null
}

interface RepairPlan {
  prop_id: number
  name: string
  parent_prop_id: number
  /** 投影语义是否与库里的不同（不含 generated_at 等展示字段） */
  semanticsChanged: boolean
  /** 语义要素 id 集合是否变了（地理内容换了） */
  idSetChanged: boolean
  /** 投影后的语义 id 集合（unresolved 判据） */
  nextIds: Set<string>
  nextSemantics: string | null
  /** 投影失败的原因（跳过该资产，不写空语义） */
  skip: string | null
}

/** 语义内容的可比签名：忽略 generated_at / model / needs_review 这类展示与派生字段 */
function comparableSemantics(raw: string | null): string {
  const doc = parseSemantics(raw)
  if (!doc) return ''
  const strip = <T extends { needs_review?: boolean }>(items: T[]) => items.map(item => {
    const { needs_review: _flag, ...rest } = item
    return rest
  })
  return JSON.stringify({
    image: { width: doc.image.width, height: doc.image.height },
    labels: strip(doc.labels), points: strip(doc.points), regions: strip(doc.regions), lines: strip(doc.lines),
  })
}

function planFor(row: DetailRow, ts: string): RepairPlan {
  const meta = parsePipMeta(row.map_pip)
  const base: RepairPlan = {
    prop_id: row.id, name: row.name, parent_prop_id: 0, semanticsChanged: false, idSetChanged: false,
    nextIds: new Set(), nextSemantics: null, skip: null,
  }
  if (meta?.role !== 'detail') return { ...base, skip: 'map_pip 不是细节资产（形状不认识）' }
  base.parent_prop_id = meta.parent_prop_id
  const image = sqlite.prepare("SELECT id, local_path FROM sys_task WHERE prop_id = ? AND model = 'map-studio-detail' AND status = 'completed' ORDER BY id DESC LIMIT 1").get(row.id) as
    { id: number; local_path: string | null } | undefined
  const size = pngSizeOf(image?.local_path ?? null)
  if (!image?.id || !size) return { ...base, skip: '没有可用的细节图或读不到画幅' }
  const mapSpec = overviewMapSpecOf(meta.parent_prop_id)
  const parentSemantics = sqlite.prepare('SELECT semantics FROM props WHERE id = ? AND deleted_at IS NULL').get(meta.parent_prop_id) as { semantics: string | null } | undefined
  const ids = [...semanticIdSet(parseSemantics(parentSemantics?.semantics ?? null))]
  if (!mapSpec || !ids.length) return { ...base, skip: '全览没有 map_spec 或语义要素，无法投影' }
  let geometry: PipDetailGeometry
  try { geometry = projectDetailSemantics(mapSpec, meta.frame?.bbox, size, ids) } catch (err) {
    return { ...base, skip: `投影失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!geometry.points.length && !geometry.lines.length && !geometry.regions.length) {
    return { ...base, skip: '投影后这一帧没有任何要素（保留旧语义）' }
  }
  const facts = overviewDeliveryFactsOf(meta.parent_prop_id)
  const nextSemantics = semanticsJsonOf(geometry, image.id, ts, semanticAnnotationsOf(facts.features, facts.sources), parseSemantics(row.semantics))
  const previousIds = semanticIdSet(parseSemantics(row.semantics))
  return {
    ...base,
    semanticsChanged: comparableSemantics(nextSemantics) !== comparableSemantics(row.semantics),
    idSetChanged: previousIds.size > 0 && !sameSemanticIdSet(previousIds, geometrySemanticIds(geometry)),
    nextIds: geometrySemanticIds(geometry),
    nextSemantics,
  }
}

async function main() {
  const ts = now()
  const rows = sqlite.prepare("SELECT id, name, map_pip, semantics FROM props WHERE deleted_at IS NULL AND map_pip LIKE '%\"role\":\"detail\"%'").all() as DetailRow[]
  const plans = rows.map(row => planFor(row, ts))
  const changed = plans.filter(plan => !plan.skip && (plan.semanticsChanged || plan.idSetChanged))
  const unresolved: Array<{ prop_id: number; name: string; storyboard_id: number; storyboard_number: number; semantic_ids: string[] }> = []
  for (const plan of plans) {
    if (plan.skip) continue
    for (const ref of semanticRefsByStoryboard(plan.prop_id)) {
      const missing = ref.semantic_ids.filter(id => !plan.nextIds.has(id))
      if (!missing.length) continue
      const sb = sqlite.prepare('SELECT storyboard_number FROM storyboards WHERE id = ?').get(ref.storyboard_id) as { storyboard_number: number } | undefined
      unresolved.push({
        prop_id: plan.prop_id, name: plan.name, storyboard_id: ref.storyboard_id,
        storyboard_number: sb?.storyboard_number ?? 0, semantic_ids: missing,
      })
    }
  }

  console.log(`细节资产 ${rows.length} 个；需要改写语义 ${changed.length} 个；投影跳过 ${plans.filter(plan => plan.skip).length} 个`)
  for (const plan of plans) {
    if (plan.skip) console.log(`  跳过 #${plan.prop_id}「${plan.name}」：${plan.skip}`)
    else if (plan.semanticsChanged || plan.idSetChanged) {
      console.log(`  ${DRY_RUN ? '将改写' : '改写'} #${plan.prop_id}「${plan.name}」：语义${plan.semanticsChanged ? '变化（几何投影或新增 description/keywords）' : '不变'}${plan.idSetChanged ? '，要素 id 集合变化（内容换了）' : ''}`)
    }
  }
  if (unresolved.length) {
    console.log(`解析不到的语义引用 ${unresolved.length} 条：`)
    for (const item of unresolved) {
      console.log(`  镜 #${item.storyboard_number}（storyboard ${item.storyboard_id}）引用了 #${item.prop_id}「${item.name}」的 ${item.semantic_ids.join('、')}`)
    }
  } else {
    console.log('解析不到的语义引用：0 条')
  }

  if (DRY_RUN) {
    console.log('dry-run：未写入任何数据。')
    return
  }

  const backupPath = `${dbPath}.pre-repair-${ts.replace(/[:.]/g, '-')}.bak`
  await sqlite.backup(backupPath)
  console.log(`已备份数据库 → ${backupPath}`)

  let written = 0
  for (const plan of changed) {
    const row = rows.find(item => item.id === plan.prop_id)!
    // 内容换了：记 content_changed_at（交付路径同口径），组规划/设计卡读时据此过期
    if (plan.idSetChanged) {
      const meta = parsePipMeta(row.map_pip)
      if (meta?.role === 'detail') {
        sqlite.prepare('UPDATE props SET map_pip = ? WHERE id = ?').run(JSON.stringify({ ...meta, content_changed_at: ts }), plan.prop_id)
      }
    }
    if (plan.semanticsChanged && plan.nextSemantics) {
      sqlite.prepare('UPDATE props SET semantics = ?, updated_at = ? WHERE id = ?').run(plan.nextSemantics, ts, plan.prop_id)
      written++
    }
  }
  // 解析不到的引用：设计卡必须人工重新填（stale 幂等，已 stale 的不重复计）
  const unresolvedStoryboards = [...new Set(unresolved.map(item => item.storyboard_id))]
  const marked = await markStale('design_card', unresolvedStoryboards, 'asset_semantic_unresolved')
  console.log(`写入完成：语义 ${written} 个资产；设计卡标过期 ${marked} 镜（候选 ${unresolvedStoryboards.length}）。`)
  console.log('再次运行 --apply 应当输出「需要改写语义 0 个」以验证幂等。')
}

await main()
