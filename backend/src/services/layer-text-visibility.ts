/**
 * 模板文本框的可见性（Issue #96）：屏幕文字按「位置区」互斥，锚定图层仍然累计可见。
 *
 * 规则（DESIGN.md §5 的「一拍一个主信息框」）：
 * - 同一 zone 的框**后出现的替换先出现的**（heading → statement → bullets 是一条主叙事线，
 *   `primary` 里永远只有一个）；`date` 在 `context` 区，另一条时间锚出现时才换；`keyword` 在 `emphasis` 区同理。
 * - `at`（显现时刻）相同的层是**同一次出现**，互不替换：同区同刻就是冲突，必须报出来，不能靠「后到的赢」掩盖。
 * - 没有 zone 的层（`zone = null`，即 polygon / polyline / marker / label / card / image）保持累计可见。
 *
 * 草稿关键帧（`layer-segment-draft.ts`）与设计卡校验（`design-card.ts` 的 `textPlanBeats`）共用这一份实现，
 * 读时结论与成片画面不会漂移。
 */
import { textLayoutById } from './layer-text.js'

/**
 * 文本层所在的位置区：选中的套里这个 role 的 `slot.zone`。
 * 套未知 / 槽位缺失时把类型本身当作它的区（同类型互斥，仍然不会叠在一起）。
 */
export function textZoneOf(layoutId: string | undefined | null, role: string): string {
  const located = textLayoutById(layoutId)
  const slot = located?.layout.slots.find(item => item.role === role)
  return slot?.zone || role
}

/** 一次「显现」：`at` 是显现时刻（秒，已按两段精度取整），`zone` 为 null 表示累计可见 */
export interface RevealStep {
  id: string
  zone: string | null
  at: number
}

/**
 * 逐层显现 → 每一拍同一时刻可见的图层 id 集合（第一拍是空集合，对应 t=0 的干净底图）。
 * 返回数组与 `steps` 一一对应（下标 i+1 = 第 i 层出现之后的画面）。
 */
export function revealBeats(steps: RevealStep[]): string[][] {
  const beats: string[][] = [[]]
  const visible: Array<{ id: string; zone: string | null; at: number }> = []
  for (const step of steps) {
    if (step.zone) {
      for (let index = visible.length - 1; index >= 0; index--) {
        // 只替换**更早时刻**的同区框；同一时刻出现的同区框留在画面里，交给检查报冲突
        if (visible[index].zone === step.zone && visible[index].at < step.at) visible.splice(index, 1)
      }
    }
    visible.push({ id: step.id, zone: step.zone, at: step.at })
    beats.push(visible.map(item => item.id))
  }
  return beats
}
