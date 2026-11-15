/**
 * 步骤状态的统一视觉口径（Issue #105）。
 *
 * roadmap 给出 6 种状态；界面只允许用这一套符号 + 颜色表达，避免同一个词在不同的面板里
 * 长得不一样（用户抱怨：「桥句改写显示完成，却没有绿色或其他完成标识」）。
 * - done      绿色 ✓ + 绿色文字
 * - in_progress 脉冲点（进行中）
 * - available 空心 ○（可开始）
 * - locked    锁图标 + 原因 tooltip
 * - stale     琥珀色 ! + 文字「需复核」
 * - skipped   ⤼（确有跳过事实）
 * roadmap 尚未取到（ready=false）时为 checking：只显示「校验中」，绝不与任何完成/锁定态叠加。
 */

export const STEP_STATUS_GLYPHS = {
  done: '✓',
  skipped: '⤼',
  stale: '!',
  available: '○',
  in_progress: '',
  locked: '',
  checking: '',
}

/** 完成或跳过都算这一步已经走完（父步骤 done = 子步骤 ∈ {done, skipped}） */
export function isStepComplete(status) {
  return status === 'done' || status === 'skipped'
}

/**
 * 一组步骤的汇总状态（侧栏分区、进度条分组共用）：
 * 全部完成 → done；有需复核 → stale；有进行中或部分完成 → in_progress；全锁 → locked。
 */
export function aggregateStepStatus(statuses) {
  const list = (statuses || []).filter(Boolean)
  if (!list.length) return 'available'
  if (list.every(isStepComplete)) return 'done'
  if (list.includes('stale')) return 'stale'
  if (list.includes('in_progress')) return 'in_progress'
  if (list.some(isStepComplete)) return 'in_progress'
  if (list.every(status => status === 'locked')) return 'locked'
  return 'available'
}

/** 步骤名/标签的文字色：只有完成与需复核改变文字颜色，其余保持中性 */
export function stepTextClass(status) {
  if (status === 'done') return 'step-text-done'
  if (status === 'stale') return 'step-text-stale'
  return ''
}
