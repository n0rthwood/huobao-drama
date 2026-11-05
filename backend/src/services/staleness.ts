/**
 * 过期传播的单一写入口（契约 §2）。事件名由 R1 定义，这里逐步落地：
 * - `script_changed → design_card.stale`（本 Issue #57）
 * - `review_rerun → design_card.stale`（仅波及项，消费 R2 的 `changed_item_ids`）
 * - `asset_version_changed | semantic_changed → layer_segment.stale → …`（R5/R7 续写）
 *
 * 不做隐式批量扫描：每个写入口显式调用，传入自己知道的范围。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseDesignCard, toDesignCardStatus } from './design-card.js'

/** 会被置为过期的对象类型；R5/R7 在此追加 `layer_segment` / `composite` 等 */
export type StaleKind = 'design_card'

/**
 * 把若干分镜的设计卡置为 `stale` 并记下原因。
 * `blank` 的镜头没有卡可过期，`ai_filling` 的镜头正在被 AI 写，两者都跳过。
 * 返回实际被置为过期的镜数。
 */
export async function markStale(kind: StaleKind, storyboardIds: number[], reason: string): Promise<number> {
  if (kind !== 'design_card' || !storyboardIds.length) return 0
  const rows = await db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.id, storyboardIds))
  let marked = 0
  for (const row of rows) {
    const status = toDesignCardStatus(row.designCardStatus)
    if (status === 'blank' || status === 'ai_filling' || status === 'stale') continue
    await db.update(schema.storyboards)
      .set({ designCardStatus: 'stale', designCardStaleReason: reason, updatedAt: now() })
      .where(eq(schema.storyboards.id, row.id))
    marked++
  }
  return marked
}

/** `script_changed`：旁白稿变了，整集设计卡全部需要重审 */
export async function markEpisodeDesignCardsStale(episodeId: number, reason: string): Promise<number> {
  const rows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
  return markStale('design_card', rows.map(row => row.id), reason)
}

/** 设计卡里引用到的资产 / 语义条目（判断某次清单重对照波及了哪几镜） */
function cardReferences(designCard: string | null): { assets: Set<number>; semantics: Set<string> } {
  const assets = new Set<number>()
  const semantics = new Set<string>()
  const card = parseDesignCard(designCard)
  if (!card) return { assets, semantics }
  const base = card.layer_plan?.base
  if (base && base.kind === 'asset') assets.add(base.asset_id)
  for (const ref of card.layer_plan?.must_mark || []) {
    assets.add(ref.asset_id)
    if (ref.semantic_id) semantics.add(`${ref.asset_id}:${ref.semantic_id}`)
  }
  for (const layer of card.layer_plan?.planned_layers || []) {
    if (!layer.anchor) continue
    assets.add(layer.anchor.asset_id)
    if (layer.anchor.semantic_id) semantics.add(`${layer.anchor.asset_id}:${layer.anchor.semantic_id}`)
  }
  for (const ref of card.gen_plan?.reference_assets || []) assets.add(ref.id)
  return { assets, semantics }
}

interface ReviewItemBinding {
  asset_id: number | null
  semantic_id: string | null
}

/**
 * `review_rerun`：资产审核清单重对照后，只有**引用了被改动条目**的设计卡才置过期（契约 §6.1）。
 *
 * 与 R2 的集成点：条目绑定读自 R2 定义的 `asset_review_items`。该表还没合并时
 * （R2 与本 Issue 同波次并行实施）本函数直接返回 0 —— 表一出现就自动生效，不需要再改这里。
 */
export async function markDesignCardsStaleForReviewItems(
  episodeId: number,
  reviewItemIds: number[],
  reason = 'review_rerun',
): Promise<number> {
  if (!reviewItemIds.length) return 0
  const tables = db.all(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='asset_review_items'`) as Array<{ name: string }>
  if (!tables.length) return 0

  const ids = reviewItemIds.filter(id => Number.isInteger(id) && id > 0)
  if (!ids.length) return 0
  const items = db.all(sql`SELECT asset_id, semantic_id FROM asset_review_items
    WHERE episode_id = ${episodeId} AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`) as ReviewItemBinding[]
  if (!items.length) return 0

  const changedAssets = new Set(items.map(item => item.asset_id).filter((id): id is number => typeof id === 'number'))
  const changedSemantics = new Set(items
    .filter(item => typeof item.asset_id === 'number' && item.semantic_id)
    .map(item => `${item.asset_id}:${item.semantic_id}`))

  const rows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
  const affected = rows.filter((row) => {
    const refs = cardReferences(row.designCard)
    for (const assetId of refs.assets) if (changedAssets.has(assetId)) return true
    for (const key of refs.semantics) if (changedSemantics.has(key)) return true
    return false
  })
  return markStale('design_card', affected.map(row => row.id), reason)
}
