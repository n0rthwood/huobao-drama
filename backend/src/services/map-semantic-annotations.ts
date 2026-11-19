/**
 * 地图语义条目的 `description` / `keywords` 生成（Issue #125）——**代码拼接，不调模型、不猜测**。
 *
 * 研究阶段已经为每个要素产出了两件事实：`basis`（坐标是怎么推理出来的）与 `supporting_excerpt`
 * （检索正文里的原文摘录），以及出处来源。此前交付时这些全部丢弃，设计模型只看得到要素名字，
 * 无法判断「这个名字指的具体是哪块地方」。这里把它们拼成一句话写进语义条目的 `description`，
 * 关键词只取要素 `category`（数据源没有别名词表，不做分词、不造别名）。
 *
 * 字段所有权：生成值只在条目没有人工标记时写入（`manual` / `name_manual` 由 `asset-semantics.ts`
 * 负责保护），人工值永远不被覆盖。
 */
import type { SemanticSupplement } from './asset-semantics.js'

/** 描述上限（字）：够写一句推理 + 一句原文，再多模型也不会读 */
export const SEMANTIC_DESCRIPTION_MAX = 500
/** 关键词条数上限 */
export const SEMANTIC_KEYWORDS_MAX = 12
/** 单个关键词长度上限（字） */
export const SEMANTIC_KEYWORD_MAX_CHARS = 20

/** 研究要素的类别 → 人读关键词；未知类别原样使用（不猜中文名） */
const CATEGORY_LABELS: Record<string, string> = {
  river: '河流',
  lake: '湖泊',
  coast: '海岸',
  mountain: '山脉',
  settlement: '城镇',
  route: '路线',
  territory: '疆域',
  other: '其他',
}

/** 坐标依据的人话（`MapCoordinateBasis`）；缺省/未知省略 */
const BASIS_NOTE: Record<string, string> = {
  excerpt: '按来源正文逐字核对',
  well_known: '按现代地名公认位置定位',
  approximate_schematic: '示意定位（不精确）',
}

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function sourceTitles(sources: unknown[]): Map<string, string> {
  const titles = new Map<string, string>()
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const title = textOf(row.title, 120)
    if (id && title) titles.set(id, title)
  }
  return titles
}

function keywordOf(category: unknown): string | null {
  const value = typeof category === 'string' ? category.trim() : ''
  if (!value) return null
  return (CATEGORY_LABELS[value] ?? value).slice(0, SEMANTIC_KEYWORD_MAX_CHARS)
}

/**
 * 交付里的 `features`（`buildDeliverable` 装配：含 `basis` / `excerpt` / `source_ids` / `source_title`）
 * → 语义条目 id（= feature_id）对应的 description/keywords。
 * 没有任何可用事实的要素不生成（省略字段，而不是写一句空话）。
 */
export function semanticAnnotationsOf(features: unknown[], sources: unknown[]): Map<string, SemanticSupplement> {
  const titles = sourceTitles(sources)
  const out = new Map<string, SemanticSupplement>()
  for (const raw of features) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = typeof row.feature_id === 'string' ? row.feature_id : ''
    if (!id) continue
    const parts: string[] = []
    const basis = textOf(row.basis, 240)
    if (basis) parts.push(`坐标依据：${basis}`)
    const note = typeof row.coordinate_basis === 'string' ? BASIS_NOTE[row.coordinate_basis] : undefined
    if (note) parts.push(note)
    const excerpt = textOf(row.excerpt, 240)
    if (excerpt) parts.push(`原文摘录：${excerpt}`)
    const names: string[] = []
    const ids = Array.isArray(row.source_ids) ? row.source_ids : []
    for (const sourceId of ids) {
      const title = typeof sourceId === 'string' ? titles.get(sourceId) : undefined
      if (title && !names.includes(title)) names.push(title)
    }
    const ownTitle = textOf(row.source_title, 120)
    if (ownTitle && !names.includes(ownTitle)) names.push(ownTitle)
    if (names.length) parts.push(`来源：${names.slice(0, 3).join(' / ')}`)
    const description = parts.join('；').slice(0, SEMANTIC_DESCRIPTION_MAX)
    const keyword = keywordOf(row.category)
    if (!description && !keyword) continue
    out.set(id, {
      ...(description ? { description } : {}),
      ...(keyword ? { keywords: [keyword] } : {}),
    })
  }
  return out
}
