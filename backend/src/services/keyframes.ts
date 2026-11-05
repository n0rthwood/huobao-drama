/**
 * 分镜关键帧规则 — 后端唯一实现（关键帧生成、确认门槛、视频组装、Agent 上下文共用）
 *
 * 每个分镜有首帧/中间帧/尾帧三个槽位，各自有提示词与多个版本，选定版本记在
 * storyboards.first_frame_image / mid_frame_image / last_frame_image。
 * “上一镜”指同一集内、未删除、按 storyboard_number 排序的前一镜；第一镜永远不继承。
 * 承接分镜（continuity_boundary='continue'）自己没有首帧图时，直接用上一镜选定的尾帧图。
 *
 * ## 衔接帧锁定（Issue #58，契约 §3.3）
 * C 组合的生成段首帧 = 图层段末帧，D 组合的尾帧 = 图层段首帧——这两张**不单独出图**，
 * 由图层段渲染产出。锁定槽位的列保持 NULL，生效图一律取衔接帧：
 * - `locked`：本镜的衔接帧（`{slot, source, t, path, hash, stale}`），没有衔接帧时为 null；
 * - `locked_slots`：真正不可写/不可生成的槽位——衔接帧锁 + 「D + 承接」时的首帧承接锁；
 * - `ready`：锁定槽有**非 stale** 的衔接帧 + 其余槽按原规则（槽位图还要**文件真的在**）；
 * - `stale_reason`：确认被自动作废的原因（目前只有 `junction_updated`），下次确认时清空。
 */
import fs from 'fs'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { toCombo } from './design-card.js'
import { junctionFramesOfEpisode, type JunctionFrame } from './junction-frame.js'

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

/**
 * 槽位的**可用**图：列里有路径还不够，文件必须真的在（与衔接帧同口径，
 * 见 junction-frame.ts 的 `fileExists`）。文件被清理后列里残留的死路径不算就绪，
 * 前端据此显示空位占位而不是破图（#58）。
 */
function usableImage(raw: string | null): string | null {
  if (!raw) return null
  return fs.existsSync(getAbsolutePath(raw)) ? raw : null
}

export interface StoryboardKeyframeState {
  storyboardId: number
  previousId: number | null
  /** 承接上一镜且自己没有首帧图：首帧用上一镜的尾帧 */
  inheritsFirst: boolean
  /** 生效首帧（自有优先，其次继承，D+承接时是衔接帧） */
  first: string | null
  mid: string | null
  last: string | null
  /** 有中间帧提示词 = 这一镜应该有中间帧图 */
  midRequired: boolean
  ready: boolean
  confirmed: boolean
  /** 本镜的衔接帧（C = 图层段末帧、D = 图层段首帧）；没有则为 null */
  locked: {
    slot: KeyframeSlot
    source: 'layer_last' | 'layer_first'
    t: number
    path: string | null
    hash: string | null
    stale: boolean
  } | null
  /** 锁定槽位（每槽各自的来源：C 首帧 / D 尾帧取衔接帧；D + 承接的首帧取上一镜尾帧） */
  lockedSlots: KeyframeSlot[]
  /** 逐槽的锁定来源（前端据此显示「继承自图层段末帧@Xs」/「承接上一镜尾帧」） */
  slotLocks: StoryboardSlotLock[]
  /** 上次确认时快照的衔接帧 hash */
  junctionHash: string | null
  /** 确认被自动作废的原因（`junction_updated`） */
  staleReason: string | null
}

export interface StoryboardSlotLock {
  slot: KeyframeSlot
  /** `layer_last` = 图层段末帧（C），`layer_first` = 图层段首帧（D），`previous_last` = 上一镜尾帧（D+承接） */
  source: 'layer_last' | 'layer_first' | 'previous_last'
  t: number | null
  path: string | null
  hash: string | null
  stale: boolean
}

function lockedSlotsOf(row: StoryboardRow, inheritsFirst: boolean): KeyframeSlot[] {
  const out: KeyframeSlot[] = []
  const combo = toCombo(row.combo)
  if (combo === 'C') out.push('first')
  if (combo === 'D') out.push('last')
  // D + 承接：生成段首尾双锁——首帧承接上一镜尾帧、尾帧继承图层段首帧，只有中间帧可出图。
  // 第一镜没有上一镜时按硬切处理（与 inheritsFirst 同口径）。
  if (combo === 'D' && inheritsFirst) out.unshift('first')
  return out
}

function buildState(
  row: StoryboardRow,
  previous: StoryboardRow | null,
  junction: JunctionFrame | undefined,
): StoryboardKeyframeState {
  const combo = toCombo(row.combo)
  // 生效图一律过一道「文件还在吗」：列里残留的死路径不能算图（否则前端是破图、确认还放行）
  const ownFirst = usableImage(slotOwnImage(row, 'first'))
  // 第一镜没有上一镜，即使被标成 continue 也按硬切处理
  const inheritsFirst = !ownFirst && !!previous && row.continuityBoundary === 'continue'
  const lockedSlots = lockedSlotsOf(row, inheritsFirst)
  const junctionUsable = Boolean(junction && !junction.stale && junction.path)
  const lock = junction && junction.source
    ? {
      slot: junction.source === 'layer_last' ? 'first' as KeyframeSlot : 'last' as KeyframeSlot,
      source: junction.source,
      t: junction.t,
      path: junction.path,
      hash: junction.hash,
      stale: junction.stale,
    }
    : null
  const firstIsLocked = lockedSlots.includes('first')
  const lastIsLocked = lockedSlots.includes('last')
  const previousLast = previous ? usableImage(slotOwnImage(previous, 'last')) : null
  // 每个锁定槽的生效图来源不同：C 首帧与 D 尾帧取衔接帧；D + 承接的首帧取**上一镜尾帧**。
  // 只有「D + 承接」的首帧锁取上一镜尾帧；C 的首帧锁永远是图层段末帧（与承接无关）
  const firstLockFromPrevious = combo === 'D' && inheritsFirst
  const lockedFirst = firstLockFromPrevious ? previousLast : (junctionUsable ? junction!.path : null)
  const first = firstIsLocked ? lockedFirst : ownFirst || (inheritsFirst ? previousLast : null)
  const mid = usableImage(slotOwnImage(row, 'mid'))
  const last = lastIsLocked ? (junctionUsable ? junction!.path : null) : usableImage(slotOwnImage(row, 'last'))
  const midRequired = !!slotPrompt(row, 'mid')
  // 就绪：锁定槽各自的来源都要可用（承接首帧要有上一镜尾帧；衔接帧锁要有非 stale 的衔接帧）
  const lockedReady = lockedSlots.every((slot) => {
    // D + 承接的首帧锁靠上一镜尾帧；其余锁定槽（C 首帧 / D 尾帧）靠衔接帧
    if (firstLockFromPrevious && slot === 'first') return Boolean(previousLast)
    return junctionUsable
  })
  const ready = lockedReady && !!first && !!last && (!midRequired || !!mid)
  const slotLocks: StoryboardSlotLock[] = lockedSlots.map((slot) => {
    if (firstLockFromPrevious && slot === 'first') {
      return { slot, source: 'previous_last', t: null, path: previousLast, hash: null, stale: !previousLast }
    }
    return {
      slot,
      source: slot === 'first' ? 'layer_last' : 'layer_first',
      t: junction?.t ?? null,
      path: junction?.path ?? null,
      hash: junction?.hash ?? null,
      stale: !junctionUsable,
    }
  })
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
    locked: firstIsLocked || lastIsLocked ? lock : null,
    lockedSlots,
    slotLocks,
    junctionHash: row.keyframesJunctionHash ?? null,
    staleReason: row.keyframesStaleReason ?? null,
  }
}

/** 本集未删除的分镜（按分镜号排序） */
async function listStoryboards(episodeId: number): Promise<StoryboardRow[]> {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)
}

/** 一次性算出整集的关键帧状态（含衔接帧锁定），避免逐镜重复查询 */
export async function loadEpisodeKeyframes(episodeId: number): Promise<Map<number, StoryboardKeyframeState>> {
  const [rows, junctions] = await Promise.all([
    listStoryboards(episodeId),
    junctionFramesOfEpisode(episodeId),
  ])
  const result = new Map<number, StoryboardKeyframeState>()
  rows.forEach((row, index) => {
    result.set(row.id, buildState(row, index > 0 ? rows[index - 1]! : null, junctions.get(row.id)))
  })
  return result
}

/** 单镜关键帧状态（内部仍按整集计算，继承关系依赖上一镜） */
export async function loadStoryboardKeyframes(storyboardId: number): Promise<StoryboardKeyframeState | null> {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) return null
  const map = await loadEpisodeKeyframes(row.episodeId)
  return map.get(storyboardId) ?? buildState(row, null, undefined)
}

/**
 * 槽位被锁定时抛出的错误：路由统一转成 `400 { error, code: 'slot_locked' }`（契约 §3.3）。
 */
export class SlotLockedError extends Error {
  readonly code = 'slot_locked'
  readonly slot: KeyframeSlot
  constructor(slot: KeyframeSlot, message: string) {
    super(message)
    this.name = 'SlotLockedError'
    this.slot = slot
  }
}

/** 写锁定槽位前的唯一检查（PUT 选图继承 / POST 生成 共用） */
export async function assertSlotWritable(storyboardId: number, slot: KeyframeSlot): Promise<StoryboardKeyframeState> {
  const state = await loadStoryboardKeyframes(storyboardId)
  if (!state) throw new Error('镜头不存在')
  if (!state.lockedSlots.includes(slot)) return state
  if (slot === state.locked?.slot) {
    throw new SlotLockedError(slot, '该槽位由衔接帧锁定继承，请在图层段调整')
  }
  throw new SlotLockedError(slot, '该槽位由承接上一镜尾帧锁定（D 组合 + 承接），请在上一镜或设计卡调整')
}

/**
 * 任一槽位选定图变化（新图生成完成、切换版本、改为继承/取消继承）就取消人工确认；
 * 尾帧变化还会影响继承它的下一镜，连带取消。
 * `reason` 记录**为什么**被作废（衔接帧更新 → `junction_updated`），前端据此给提示条。
 */
export async function invalidateKeyframeConfirmation(storyboardId: number, reason?: string): Promise<void> {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) return
  if (row.keyframesConfirmed) {
    await db.update(schema.storyboards)
      .set({
        keyframesConfirmed: false,
        keyframesStaleReason: reason ?? null,
        updatedAt: now(),
      })
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
    .set({
      keyframesConfirmed: false,
      keyframesStaleReason: reason ?? null,
      updatedAt: now(),
    })
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
    // 衔接帧锁定（#58）
    locked: state?.locked ?? null,
    locked_slots: state?.lockedSlots ?? [],
    slot_locks: state?.slotLocks ?? [],
    stale_reason: state?.staleReason ?? null,
    junction_hash: state?.junctionHash ?? null,
  }
}
