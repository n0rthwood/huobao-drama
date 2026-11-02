/**
 * 资产最终提示词失效规则（Issue #24，纯函数）：最终提示词是 Agent 按资产信息写的，
 * 影响画面的信息字段一旦改了值，旧提示词就和新信息对不上，必须置空，下次生成/出图时重写。
 * 请求同时显式写入（与已存值不同的）提示词时，以手写为准。
 */

export type PromptAssetKind = 'character' | 'scene' | 'prop'

/** 影响画面的信息字段（Drizzle 列名）；场景 time 另有 #21 规则（scene-time.ts） */
export const PROMPT_SOURCE_FIELDS: Record<PromptAssetKind, readonly string[]> = {
  character: ['appearance', 'styling', 'description'],
  scene: ['location', 'prompt', 'lighting'],
  prop: ['name', 'type', 'description'],
}

/** updates 里是否有影响画面的字段真的改了值（null 与 '' 视为相同） */
export function promptSourceChanged(kind: PromptAssetKind, current: Record<string, unknown>, updates: Record<string, unknown>): boolean {
  return PROMPT_SOURCE_FIELDS[kind].some(field => field in updates && (updates[field] ?? '') !== (current[field] ?? ''))
}

/**
 * final_prompt 的落库决定：
 * - 请求写入了提示词且与已存值不同 → 以写入为准（'' / null = 清空）；
 * - 否则来源字段变化 → 置空；
 * - 否则不动（返回 {}）。
 *
 * 同时写来源标记（Issue #32）：外部直写一律记 'external'，UI 据此显示「非 Agent 生成」
 * 徽标并提供「交给 Agent 重写」；清空时把标记一并清掉。
 * Agent 自己保存走 save_*_final_prompt，在那里记 'agent'。
 */
export function planFinalPromptWrite(input: {
  currentFinalPrompt: string | null
  /** 请求体里的 final_prompt；undefined = 未传 */
  finalPrompt?: string | null
  sourceChanged: boolean
  /** 写入时间戳（ISO）；由调用方传入，保持本模块是纯函数 */
  at: string
}): { finalPrompt?: string | null; finalPromptSource?: string | null; finalPromptUpdatedAt?: string | null } {
  const current = input.currentFinalPrompt || null
  const next = input.finalPrompt === undefined ? undefined : (input.finalPrompt || null)
  if (next !== undefined && next !== current) {
    return next
      ? { finalPrompt: next, finalPromptSource: 'external', finalPromptUpdatedAt: input.at }
      : { finalPrompt: null, finalPromptSource: null, finalPromptUpdatedAt: null }
  }
  if (input.sourceChanged && current) return { finalPrompt: null, finalPromptSource: null, finalPromptUpdatedAt: null }
  return {}
}
