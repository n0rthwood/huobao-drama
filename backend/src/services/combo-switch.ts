/**
 * 段组合切换（Issue #58，契约 §5 + Fabel §4.5）。
 *
 * 组合的真源仍是设计卡 `storyboards.combo`，但**已有制作产物**时切换会波及槽位图、
 * 图层段与视频，所以必须先给出影响清单、再由人确认。执行原则：
 * **只归档不删除**——被替换的槽位版本写 `params.archived_reason`、对应列置 NULL，
 * 图层段行保留并回到 `status='draft'`，视频版本标过期；历史版本永远还能列出、随时恢复。
 *
 * 影响矩阵（Fabel §4.5）按「切换前组合 → 切换后组合」静态给出，不猜内容：
 * - B→C：保留中/尾帧与提示词、素材池；归档原首帧及版本（被衔接帧替换）、已生成视频；需要新做图层段；
 * - B→D：保留首/中帧；归档原尾帧、视频；需要新做图层段；
 * - A→C / A→D：图层段全部保留；归档成品；需要新做生成段（锁定槽已就位）；
 * - C→B：保留中/尾帧；首帧锁定解除（空槽，可用原衔接帧作参考图）；归档视频；需要重出首帧；
 * - C↔D：两段内容保留；原锁定槽解锁清空；归档视频；新锁定槽自动继承；检查精确帧顺序；
 * - 任意→A：图层段保留；生成段全部归档（含视频与成品）；无需新做。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { hasGenSegment, hasLayerSegment, parseDesignCard, serializeDesignCard, toCombo, type Combo } from './design-card.js'
import { getLayerSegment, markSegmentStatus } from './layer-segment.js'

export const COMBO_ARCHIVE_REASONS = {
  replacedByJunction: 'replaced_by_junction',
  comboSwitch: 'combo_switch',
} as const

export interface ComboImpactItem {
  /** 稳定的机器码（前端按码映射文案，不依赖中文） */
  code: string
  /** 中文描述（对话框直接显示） */
  text: string
}

export interface ComboImpact {
  from: Combo | null
  to: Combo
  keep: ComboImpactItem[]
  archive: ComboImpactItem[]
  redo: ComboImpactItem[]
}

const LAYER = { code: 'layer_segment', text: '图层段（底图、图层、精确关键帧）' }
const FIRST = { code: 'keyframe_first', text: '首帧图及其版本' }
const MID = { code: 'keyframe_mid', text: '中间帧、提示词与素材池' }
const LAST = { code: 'keyframe_last', text: '尾帧图及其版本' }
const VIDEO = { code: 'video', text: '已生成视频' }
const COMPOSED = { code: 'composed', text: '已合成成品' }

/** Fabel §4.5 的矩阵：`null`（未选组合）等同于「什么都没做」 */
export function comboImpactMatrix(from: Combo | null, to: Combo): ComboImpact {
  if (from === to) return { from, to, keep: [], archive: [], redo: [] }
  const impact: ComboImpact = { from, to, keep: [], archive: [], redo: [] }
  if (to === 'A') {
    impact.keep.push(LAYER)
    impact.archive.push({ ...FIRST, text: '首帧图及其版本（标「组合切换」）' }, { ...MID, text: '中间帧、提示词与素材池（保留在库里）' },
      { ...LAST, text: '尾帧图及其版本（标「组合切换」）' }, VIDEO, COMPOSED)
    return impact
  }
  if (from === 'B' && to === 'C') {
    impact.keep.push(MID, LAST)
    impact.archive.push({ ...FIRST, text: '原首帧图及其版本（标记「被衔接帧替换」）' }, VIDEO)
    impact.redo.push({ code: 'layer_segment', text: '新建图层段（渲染后衔接帧自动成为生成段首帧）' })
    return impact
  }
  if (from === 'B' && to === 'D') {
    impact.keep.push(FIRST, MID)
    impact.archive.push({ ...LAST, text: '原尾帧图及其版本（标记「被衔接帧替换」）' }, VIDEO)
    impact.redo.push({ code: 'layer_segment', text: '新建图层段（渲染后衔接帧自动成为生成段尾帧）' })
    return impact
  }
  if (from === 'A' && (to === 'C' || to === 'D')) {
    impact.keep.push(LAYER)
    impact.archive.push(COMPOSED)
    impact.redo.push({
      code: 'generated_segment',
      text: to === 'C'
        ? '新做生成段：首帧由衔接帧锁定继承，中间/尾帧待出图'
        : '新做生成段：尾帧由衔接帧锁定继承，首帧/中间帧待出图',
    })
    return impact
  }
  if (from === 'C' && to === 'B') {
    impact.keep.push(MID, LAST)
    impact.archive.push({ ...FIRST, text: '首帧锁定解除：原衔接帧进入图层段历史，可「用原衔接帧作参考图」' }, VIDEO)
    impact.redo.push({ code: 'keyframe_first', text: '重出首帧' })
    return impact
  }
  if (from === 'D' && to === 'B') {
    impact.keep.push(FIRST, MID)
    impact.archive.push({ ...LAST, text: '尾帧锁定解除：原衔接帧进入图层段历史，可「用原衔接帧作参考图」' }, VIDEO)
    impact.redo.push({ code: 'keyframe_last', text: '重出尾帧' })
    return impact
  }
  if ((from === 'C' || from === 'D') && (to === 'C' || to === 'D')) {
    impact.keep.push(LAYER, MID)
    impact.archive.push({ ...FIRST, text: '原锁定槽解锁清空（历史版本仍可列出）' }, VIDEO)
    impact.redo.push({
      code: 'locked_slot',
      text: `新锁定槽自动继承图层段${to === 'C' ? '末' : '首'}帧；请检查精确关键帧顺序是否仍然合理`,
    })
    return impact
  }
  // 其余（B→A、C/D→A 已在上方处理；B→C/D 已处理）按通用保守口径
  impact.keep.push(LAYER)
  impact.archive.push(FIRST, MID, LAST, VIDEO)
  return impact
}

export class ComboSwitchError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ComboSwitchError'
    this.code = code
  }
}

/** 影响清单（GET）：当前 combo 取库里的值，`to` 由查询参数给 */
export async function comboImpactOf(storyboardId: number, to: unknown): Promise<ComboImpact> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new ComboSwitchError('not_found', '分镜不存在')
  const target = toCombo(to)
  if (!target) throw new ComboSwitchError('bad_combo', '组合只能是 A / B / C / D')
  const from = toCombo(sb.combo)
  if (from === target) throw new ComboSwitchError('same_combo', '当前组合已经是 ' + target)
  return comboImpactMatrix(from, target)
}

/** 槽位列（首/尾）与 frameType 的对应 */
const SLOT_COLUMNS = {
  first: { column: 'firstFrameImage' as const, frameType: 'first_frame' },
  mid: { column: 'midFrameImage' as const, frameType: 'mid_frame' },
  last: { column: 'lastFrameImage' as const, frameType: 'last_frame' },
}

/**
 * 执行切换：只归档不删除。
 * 1. 被替换的槽位：该槽位的 completed 图片任务写 `params.archived_reason`，列置 NULL；
 * 2. 图层段行保留；`combo=B` 时回到 `status='draft'`（切回来时原内容还在）；
 * 3. 视频与成品版本标过期：已采用视频写归档原因并保留 `videoUrl`（历史在 sys_task 里），
 *    `composedVideoUrl` 置 NULL —— 组合变了成品必然要重合成（R7 的签名 v4 也会判过期）；
 * 4. 设计卡状态回 `pending`（组合改了，卡要重新确认）；
 * 5. 写一条 `storyboard_change_log(kind='combo')`。
 */
export async function applyComboSwitch(storyboardId: number, to: unknown): Promise<{ from: Combo | null; to: Combo; archived: string[] }> {
  const impact = await comboImpactOf(storyboardId, to)
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const target = impact.to
  const archived: string[] = []

  /** 归档某槽位的全部已完成版本（只改 params，不动图文件） */
  const archiveSlot = async (slot: 'first' | 'mid' | 'last', reason: string): Promise<void> => {
    const { column, frameType } = SLOT_COLUMNS[slot]
    const tasks = (await db.select().from(schema.sysTask))
      .filter(task => task.type === 'image' && task.status === 'completed' && task.storyboardId === storyboardId)
    for (const task of tasks) {
      let params: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(task.params || '{}')
        params = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      } catch {
        continue
      }
      if (params.frameType !== frameType) continue
      if (params.archived_reason) continue
      await db.update(schema.sysTask)
        .set({ params: JSON.stringify({ ...params, archived_reason: reason }), updatedAt: now() })
        .where(eq(schema.sysTask.id, task.id))
    }
    await db.update(schema.storyboards)
      .set({ [column]: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
    archived.push(`keyframe_${slot}`)
  }

  const from = impact.from
  const firstArchived = from === 'B' && (target === 'C' || target === 'D')
  const lastArchived = from === 'B' && target === 'D'
  if (firstArchived) await archiveSlot('first', COMBO_ARCHIVE_REASONS.replacedByJunction)
  if (lastArchived) await archiveSlot('last', COMBO_ARCHIVE_REASONS.replacedByJunction)
  // C↔D / C→B / D→B：原锁定槽解锁清空（衔接帧不再继承它），历史版本仍可列出
  if ((from === 'C' || from === 'D') && target !== 'A' && target !== from) {
    if (from === 'C' && target === 'B') await archiveSlot('first', COMBO_ARCHIVE_REASONS.comboSwitch)
    if (from === 'C' && target === 'D') await archiveSlot('first', COMBO_ARCHIVE_REASONS.comboSwitch)
    if (from === 'D' && target === 'B') await archiveSlot('last', COMBO_ARCHIVE_REASONS.comboSwitch)
    if (from === 'D' && target === 'C') await archiveSlot('last', COMBO_ARCHIVE_REASONS.comboSwitch)
  }
  // 任意 → A：生成段全部归档（首/中/尾 + 视频 + 成品）
  if (target === 'A') {
    await archiveSlot('first', COMBO_ARCHIVE_REASONS.comboSwitch)
    await archiveSlot('mid', COMBO_ARCHIVE_REASONS.comboSwitch)
    await archiveSlot('last', COMBO_ARCHIVE_REASONS.comboSwitch)
  }

  // 视频与成品的归档痕迹：sys_task 里的视频版本写原因（不删 row），已采用成片置 NULL
  const videoTasks = (await db.select().from(schema.sysTask))
    .filter(task => task.type === 'video' && task.storyboardId === storyboardId
      && task.status === 'completed' && task.provider !== 'layer-segment')
  if (hasGenSegment(target) === false || from !== target) {
    for (const task of videoTasks) {
      let params: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(task.params || '{}')
        params = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      } catch {
        continue
      }
      if (params.archived_reason) continue
      await db.update(schema.sysTask)
        .set({ params: JSON.stringify({ ...params, archived_reason: COMBO_ARCHIVE_REASONS.comboSwitch }), updatedAt: now() })
        .where(eq(schema.sysTask.id, task.id))
    }
    if (sb.composedVideoUrl) {
      await db.update(schema.storyboards)
        .set({ composedVideoUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId))
      archived.push('composed')
    }
  }

  // 图层段行保留；离开图层段组合回到草稿态（切回来时内容还在，只需重新渲染）
  if (!hasLayerSegment(target)) {
    const segment = await getLayerSegment(storyboardId)
    if (segment && segment.status !== 'draft') {
      await markSegmentStatus(segment.id, 'draft')
      archived.push('layer_segment_status')
    }
  }

  // 设计卡状态回 pending（组合改了，卡要重审）
  const card = parseDesignCard(sb.designCard)
  await db.update(schema.storyboards).set({
    combo: target,
    designCard: card ? serializeDesignCard(card) : sb.designCard,
    designCardStatus: sb.designCardStatus === 'blank' || sb.designCardStatus === 'ai_filling'
      ? sb.designCardStatus
      : 'pending',
    designCardConfirmedAt: null,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, storyboardId))

  await db.insert(schema.storyboardChangeLog).values({
    storyboardId,
    kind: 'combo',
    fromValue: from,
    toValue: target,
    detail: JSON.stringify({
      keep: impact.keep.map(item => item.code),
      archive: impact.archive.map(item => item.code),
      redo: impact.redo.map(item => item.code),
      archived,
    }),
    createdAt: now(),
  })
  console.log(`🔀 combo(${storyboardId})：${from ?? '—'} → ${target}，归档 ${archived.length} 项（全部可恢复）`)
  return { from, to: target, archived }
}

/** 本镜的变更日志（按时间倒序），供界面「切换历史」与验收核对 */
export async function comboChangeLogOf(storyboardId: number): Promise<Array<{
  id: number
  kind: string
  from: string | null
  to: string | null
  detail: unknown
  created_at: string
}>> {
  const rows = await db.select().from(schema.storyboardChangeLog)
    .where(eq(schema.storyboardChangeLog.storyboardId, storyboardId))
  return rows
    .sort((a, b) => b.id - a.id)
    .map((row) => {
      let detail: unknown = null
      try {
        detail = row.detail ? JSON.parse(row.detail) : null
      } catch {
        detail = row.detail
      }
      return { id: row.id, kind: row.kind, from: row.fromValue, to: row.toValue, detail, created_at: row.createdAt }
    })
}
