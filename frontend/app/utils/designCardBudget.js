/**
 * 设计卡时长预算（Issue #110）。
 *
 * 用户规则：**图层段不设上限**，只有扩散生成段受模型 15 s 限制（B 整镜同限）。所以预算「装不下
 * 实测旁白」不再交给人去拆字或加镜，而是把差额补到图层段——图层段是确定性渲染，加长即可。
 *
 * 与后端 `services/design-card.ts` 的 `fitBudgetToNarration` 同规则（只加不减、差额向上取整到
 * 0.5 s、总时长要留 0.5 s 余量）：服务端在 AI 写入设计卡时自动补足，前端一键「延长图层段」
 * 用同一个算法现场算一遍，两边不分叉。
 */

/** 生成段硬上限（秒）：扩散模型只吃 15 s；B 整镜只有生成段，所以整镜同限 */
export const GEN_MAX_SECONDS = 15
/** 余量容差（秒）：总时长 ≥ 实测旁白 + 0.5 s 才算不「偏紧」 */
export const BUDGET_SLACK_SECONDS = 0.5

/** 有图层段的组合：图层段承载旁白里「在哪里·是谁·哪一年」的部分，可以任意加长 */
export const LAYER_COMBOS = ['A', 'C', 'D']

function finite(value) {
  // null / undefined / '' 是「没填」，不是 0：预算为空与预算为零是两种状态
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 0.5 s 向上取整（1.1 → 1.5，1.0 → 1.0） */
export function roundUpHalf(seconds) {
  return Math.ceil((finite(seconds) ?? 0) * 2) / 2
}

/**
 * 显示用数值：≤2 位小数、不带浮点噪声。
 * 设计卡里的 `at_s` / 预算来自浮点运算，`0.20000000298023224` 这种值直接进输入框只会让人以为填错了。
 */
export function formatSeconds(value) {
  const n = finite(value)
  if (n === null) return ''
  return String(Math.round(n * 100) / 100)
}

/**
 * 按实测旁白补足预算，**只加不减**。
 *
 * - A/C/D：`layer_s + gen_s < 实测 + 0.5` 时把差额加到图层段（向上取整到 0.5 s），生成段不动；
 *   没有生成段的组合（A，或生成段还没填）按 0 参与计算，与后端 `fitBudgetToNarration` 一致；
 * - B：没有图层段，只能把生成段提到 `min(15, 实测 + 0.5)`。实测 > 15 s 的 B 镜顶到 15 s 也装不下，
 *   这时由服务端的 `budget_under_narration` 阻断消息说明「改用 C 或 D」，前端不再自己造一个状态。
 *
 * 返回 `{ budget, changed, reason, from, to }`，`reason ∈ '' | 'layer' | 'gen'`。
 */
export function fitBudgetToNarration(budget, combo, measuredSeconds) {
  const measured = finite(measuredSeconds)
  const layer = finite(budget?.layer_s)
  const gen = finite(budget?.gen_s)
  const unchanged = { budget: { ...(budget || {}) }, changed: false, reason: '', from: null, to: null }
  if (measured === null || measured <= 0) return unchanged
  if (!LAYER_COMBOS.includes(combo) && combo !== 'B') return unchanged

  const required = measured + BUDGET_SLACK_SECONDS
  if (LAYER_COMBOS.includes(combo)) {
    // 没有生成段（A 组合，或 C/D 还没填）时按 0 计算：总时长就是图层段的长度
    const genValue = gen ?? 0
    if (layer === null) return unchanged
    if (layer + genValue >= required) return unchanged
    const nextLayer = roundUpHalf(required - genValue)
    // 差额不足半秒时向上取整已经够；取整后仍不大于现值说明本来就不需要动
    if (nextLayer <= layer) return unchanged
    return { budget: { ...budget, layer_s: nextLayer }, changed: true, reason: 'layer', from: layer, to: nextLayer }
  }

  if (gen === null) return unchanged
  const nextGen = Math.min(GEN_MAX_SECONDS, roundUpHalf(required))
  // B 镜顶到 15 s 还是不够就是真装不下：不改预算，也不假装补成了
  if (nextGen <= gen) return unchanged
  return { budget: { ...budget, gen_s: nextGen }, changed: true, reason: 'gen', from: gen, to: nextGen }
}
