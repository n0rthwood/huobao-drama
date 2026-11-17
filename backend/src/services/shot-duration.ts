import { parseDesignCard } from './design-card.js'

/** Match documentary video submission, including its legacy nullish fallback. */
export function generatedSegmentSeconds(designCard: string | null | undefined, duration: number | null | undefined): number {
  return Number(parseDesignCard(designCard)?.budget.gen_s ?? duration ?? 10)
}

/**
 * 整镜上限（Issue #110）：只有扩散视频模型有 15 秒约束——
 * - `B`（整镜都是生成段）≤ 15 秒；
 * - `A` / `C` / `D` 的图层段是确定性渲染，**没有上限**（长旁白靠加长图层段承载），
 *   这两类镜头的整镜时长也就没有上限，返回 `Infinity`（调用方的比较/取小运算天然放行）。
 * - 没有 combo（非纪录片 / 旧数据）沿用历史口径 15 秒。
 */
export function shotMaxSeconds(combo: string | null | undefined): number {
  if (combo === 'A' || combo === 'C' || combo === 'D') return Number.POSITIVE_INFINITY
  return 15
}
