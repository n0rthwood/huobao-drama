/**
 * 尾帧承接生效规则 — 后端唯一实现（单镜生成、批量生成、Agent 上下文共用）
 *
 * “上一镜”指同一集内、未删除、按 storyboard_number 排序的前一镜；第一镜永远不承接。
 * 分镜三态 continuity_mode 覆盖剧集默认 continuity_enabled：
 *   previous_tail → 强制承接；none → 强制不承接；auto（或空）→ 剧集开启且 LLM 标注为 continue 才承接。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export type ContinuityMode = 'auto' | 'previous_tail' | 'none'
export type ContinuityBoundary = 'continue' | 'cut'

export function isContinuityEffective(
  sb: { continuityMode: string | null; continuityBoundary: string | null },
  hasPrevious: boolean,
  episodeEnabled: boolean,
): boolean {
  if (!hasPrevious) return false
  if (sb.continuityMode === 'previous_tail') return true
  if (sb.continuityMode === 'none') return false
  // auto（含历史空值）：跟随剧集开关 + LLM 标注；未标注（NULL）按硬切处理
  return episodeEnabled && sb.continuityBoundary === 'continue'
}

export interface EpisodeContinuityEntry {
  storyboardId: number
  previousId: number | null
  effective: boolean
}

/** 一次性算出整集的承接关系，避免逐镜重复查询 */
export async function loadEpisodeContinuity(episodeId: number): Promise<Map<number, EpisodeContinuityEntry>> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  // 列为后补，存量行可能是 NULL；默认开启
  const episodeEnabled = episode?.continuityEnabled !== false

  const rows = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)

  const result = new Map<number, EpisodeContinuityEntry>()
  rows.forEach((row, index) => {
    const previous = index > 0 ? rows[index - 1]! : null
    result.set(row.id, {
      storyboardId: row.id,
      previousId: previous?.id ?? null,
      effective: isContinuityEffective(row, !!previous, episodeEnabled),
    })
  })
  return result
}
