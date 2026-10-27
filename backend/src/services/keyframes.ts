/**
 * 分镜关键帧规则 — 后端唯一实现（关键帧生成、确认门槛、视频组装、Agent 上下文共用）
 *
 * 每个分镜有首帧/中间帧/尾帧三个槽位，各自有提示词与多个版本，选定版本记在
 * storyboards.first_frame_image / mid_frame_image / last_frame_image。
 * “上一镜”指同一集内、未删除、按 storyboard_number 排序的前一镜；第一镜永远不继承。
 * 承接分镜（continuity_boundary='continue'）自己没有首帧图时，直接用上一镜选定的尾帧图。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export type KeyframeSlot = 'first' | 'mid' | 'last'

export const KEYFRAME_SLOTS: KeyframeSlot[] = ['first', 'mid', 'last']

/** 槽位 → sys_task 的 params.frameType（图片完成后据此写回对应列） */
export const SLOT_FRAME_TYPE: Record<KeyframeSlot, 'first_frame' | 'mid_frame' | 'last_frame'> = {
  first: 'first_frame',
  mid: 'mid_frame',
  last: 'last_frame',
}

/** sys_task 的 params.frameType → 槽位；其余 frameType 仍写回 composed_image */
export const FRAME_TYPE_SLOT: Record<string, KeyframeSlot> = {
  first_frame: 'first',
  mid_frame: 'mid',
  last_frame: 'last',
}

export const SLOT_LABEL: Record<KeyframeSlot, string> = {
  first: '首帧',
  mid: '中间帧',
  last: '尾帧',
}

export function isKeyframeSlot(value: unknown): value is KeyframeSlot {
  return value === 'first' || value === 'mid' || value === 'last'
}

type StoryboardRow = typeof schema.storyboards.$inferSelect

export function slotPrompt(sb: StoryboardRow, slot: KeyframeSlot): string {
  const raw = slot === 'first' ? sb.firstFramePrompt : slot === 'mid' ? sb.midFramePrompt : sb.lastFramePrompt
  return (raw || '').trim()
}

/** 该槽位自有的选定图（不含继承） */
export function slotOwnImage(sb: StoryboardRow, slot: KeyframeSlot): string | null {
  const raw = slot === 'first' ? sb.firstFrameImage : slot === 'mid' ? sb.midFrameImage : sb.lastFrameImage
  return (raw || '').trim() || null
}

export interface StoryboardKeyframeState {
  storyboardId: number
  previousId: number | null
  /** 承接上一镜且自己没有首帧图：首帧用上一镜的尾帧 */
  inheritsFirst: boolean
  /** 生效首帧（自有优先，其次继承） */
  first: string | null
  mid: string | null
  last: string | null
  /** 有中间帧提示词 = 这一镜应该有中间帧图 */
  midRequired: boolean
  ready: boolean
  confirmed: boolean
}

function buildState(row: StoryboardRow, previous: StoryboardRow | null): StoryboardKeyframeState {
  const ownFirst = slotOwnImage(row, 'first')
  // 第一镜没有上一镜，即使被标成 continue 也按硬切处理
  const inheritsFirst = !ownFirst && !!previous && row.continuityBoundary === 'continue'
  const first = ownFirst || (inheritsFirst ? slotOwnImage(previous!, 'last') : null)
  const mid = slotOwnImage(row, 'mid')
  const last = slotOwnImage(row, 'last')
  const midRequired = !!slotPrompt(row, 'mid')
  const ready = !!first && !!last && (!midRequired || !!mid)
  return {
    storyboardId: row.id,
    previousId: previous?.id ?? null,
    inheritsFirst,
    first,
    mid,
    last,
    midRequired,
    ready,
    confirmed: row.keyframesConfirmed === true && ready,
  }
}

/** 本集未删除的分镜（按分镜号排序） */
async function listStoryboards(episodeId: number): Promise<StoryboardRow[]> {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
}

/** 一次性算出整集的关键帧状态，避免逐镜重复查询 */
export async function loadEpisodeKeyframes(episodeId: number): Promise<Map<number, StoryboardKeyframeState>> {
  const rows = await listStoryboards(episodeId)
  const result = new Map<number, StoryboardKeyframeState>()
  rows.forEach((row, index) => {
    result.set(row.id, buildState(row, index > 0 ? rows[index - 1]! : null))
  })
  return result
}

/** 单镜关键帧状态（内部仍按整集计算，继承关系依赖上一镜） */
export async function loadStoryboardKeyframes(storyboardId: number): Promise<StoryboardKeyframeState | null> {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) return null
  const map = await loadEpisodeKeyframes(row.episodeId)
  return map.get(storyboardId) ?? buildState(row, null)
}

/**
 * 任一槽位选定图变化（新图生成完成、切换版本、改为继承/取消继承）就取消人工确认；
 * 尾帧变化还会影响继承它的下一镜，连带取消。
 */
export async function invalidateKeyframeConfirmation(storyboardId: number): Promise<void> {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) return
  if (row.keyframesConfirmed) {
    await db.update(schema.storyboards)
      .set({ keyframesConfirmed: false, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
  }
  const rows = await listStoryboards(row.episodeId)
  const index = rows.findIndex(item => item.id === storyboardId)
  const next = index >= 0 ? rows[index + 1] : undefined
  if (!next || !next.keyframesConfirmed) return
  // 下一镜继承本镜尾帧时，本镜任何关键帧变化都可能让它的首帧失效
  const inheritsFirst = !slotOwnImage(next, 'first') && next.continuityBoundary === 'continue'
  if (!inheritsFirst) return
  await db.update(schema.storyboards)
    .set({ keyframesConfirmed: false, updatedAt: now() })
    .where(eq(schema.storyboards.id, next.id))
}

/** 关键帧状态的 API 形态（分镜 JSON 的 keyframes 字段） */
export function keyframesJson(state: StoryboardKeyframeState | undefined | null) {
  return {
    inherits_first: !!state?.inheritsFirst,
    first_image: state?.first ?? null,
    mid_image: state?.mid ?? null,
    last_image: state?.last ?? null,
    mid_required: !!state?.midRequired,
    ready: !!state?.ready,
    confirmed: !!state?.confirmed,
  }
}
