/**
 * 设计卡的上下文窗口（Issue #102）
 *
 * 设计卡是逐镜填写的：整集 113 镜的设计卡 + 提示词一次塞给模型约 16 万 token，每一步工具往返都要重发，
 * 既慢又会把共享的文本引擎压到超时挂起（2026-11-13 生产 config 10）。填一镜只需要「本镜 + 前后各
 * DESIGN_CARD_CONTEXT_RADIUS 镜」就能判断承接、避免重复与剧透（实验见 docs/qa/exp-design-card-window-20261113）。
 */

/** 本镜前后各取几镜 */
export const DESIGN_CARD_CONTEXT_RADIUS = 3

export interface DesignCardWindow {
  /** 窗口内的分镜 id，保持入参顺序 */
  ids: number[]
  /** 实际取到的前后镜数（首尾镜会少于半径） */
  before: number
  after: number
}

/**
 * 纯函数：在**已按镜号排好序**的存活分镜 id 列表里，取目标镜前后各 `radius` 镜。
 * 目标不在列表里返回 null（调用方回退整集，不静默挑另一镜）。
 */
export function designCardWindow(orderedIds: number[], targetId: number, radius = DESIGN_CARD_CONTEXT_RADIUS): DesignCardWindow | null {
  const index = orderedIds.indexOf(targetId)
  if (index < 0) return null
  const start = Math.max(0, index - radius)
  const end = Math.min(orderedIds.length, index + radius + 1)
  return { ids: orderedIds.slice(start, end), before: index - start, after: end - index - 1 }
}
