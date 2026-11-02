/**
 * 资料检索记录（Issue #32）— 「火宝查了哪些资料」的唯一事实来源
 *
 * 写入点只有检索工具（agents/tools/research-tools.ts）；读取点是资产详情的
 * 「资料来源」面板。记录与资产字段严格分开：URL/来源标注绝不进 appearance/styling/
 * description，否则会顺着提示词链污染 final_prompt（Fabel 第 11 点）。
 *
 * 提取阶段资产行可能还不存在，先按 asset_name 落库；save_dedup_* 保存资产后
 * 调用 linkCitationsToAsset 回填 asset_id。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { AssetKind } from './reference-images.js'

export interface CitationInput {
  dramaId: number | null
  episodeId: number | null
  assetKind: AssetKind | null
  assetName: string | null
  tool: string
  query: string | null
  title: string | null
  sourceUrl: string | null
  lang: string | null
  snippet: string | null
  status: 'ok' | 'failed'
}

export async function recordCitation(input: CitationInput): Promise<void> {
  await db.insert(schema.researchCitations).values({
    dramaId: input.dramaId,
    episodeId: input.episodeId,
    assetKind: input.assetKind,
    assetId: null,
    assetName: input.assetName,
    tool: input.tool,
    query: input.query,
    title: input.title,
    sourceUrl: input.sourceUrl,
    lang: input.lang,
    snippet: input.snippet ? input.snippet.slice(0, 500) : null,
    status: input.status,
    retrievedAt: new Date().toISOString(),
  })
}

/**
 * 资产落库后回填 asset_id：同集同类型、尚未关联、名字能对上的记录归属到该资产。
 * 名字匹配做了归一化与包含判定——Agent 检索时常写简称（「康熙」对「康熙帝」），
 * 要求逐字相同会让这些记录永远挂空，资产详情的「资料来源」就是空的。
 */
export async function linkCitationsToAsset(
  episodeId: number,
  kind: AssetKind,
  assetName: string,
  assetId: number,
): Promise<void> {
  const target = normalizeCitationName(assetName)
  if (!target) return
  const pending = await db.select().from(schema.researchCitations)
    .where(and(
      eq(schema.researchCitations.episodeId, episodeId),
      eq(schema.researchCitations.assetKind, kind),
      isNull(schema.researchCitations.assetId),
    ))
  for (const row of pending) {
    const name = normalizeCitationName(row.assetName)
    if (!name) continue
    if (name === target || target.includes(name) || name.includes(target)) {
      await db.update(schema.researchCitations)
        .set({ assetId })
        .where(eq(schema.researchCitations.id, row.id))
    }
  }
}

/**
 * 名字归一化：去空白、下划线与括号定语，大小写无关（与提取工具的近名复用同口径）。
 * 下划线必须一起去掉：Issue #34 的 `normalizeAssetName` 把资产名里的空白换成 `_`，
 * 而检索记录落的是 Agent 当时写的原名（含空白），不去掉就永远匹配不上。
 */
function normalizeCitationName(name: string | null | undefined): string {
  return (name || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　_]+/g, '')
    .toLowerCase()
    .trim()
}

/** 某个资产的检索记录（最新在前） */
export async function listAssetCitations(kind: AssetKind, assetId: number) {
  const rows = await db.select().from(schema.researchCitations)
    .where(and(
      eq(schema.researchCitations.assetKind, kind),
      eq(schema.researchCitations.assetId, assetId),
    ))
  return rows.sort((a, b) => (b.retrievedAt || '').localeCompare(a.retrievedAt || '') || b.id - a.id)
}
