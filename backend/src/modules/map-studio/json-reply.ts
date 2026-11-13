/**
 * 模型回复 → JSON（Issue #99：从 `services/asset-pipeline/prompts.ts` 的 `parseJsonReply` 复制）
 *
 * 模块不能 import 火宝的业务流水线；这一步是纯文本解析，复制一份比在业务模块间拉依赖更安全。
 * 口径不变：允许 ```json 围栏与尾部解释文字，其余一律当作解析失败抛错（绝不猜内容）。
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const body = fenced ? fenced[1]! : trimmed
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error(`模型没有返回 JSON：${trimmed.slice(0, 200)}`)
  const candidate = body.slice(start)
  try {
    return JSON.parse(candidate)
  } catch {
    // 尾部可能多出解释性文字：回退到最后一个闭合括号
    const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (lastBrace > 0) return JSON.parse(candidate.slice(0, lastBrace + 1))
    throw new Error(`模型返回的 JSON 无法解析：${candidate.slice(0, 200)}`)
  }
}
