import { resolveStageModel } from '../ai-stages.js'
import { callTextChat } from '../vision-chat.js'

export interface NarrationFinding { text: string; reason: string; locatable: boolean }

/** A malformed or truncated model response is a failed inspection, never a clean result. */
export function parseNarrationInspection(reply: string, draft: string): NarrationFinding[] {
  const parsed: unknown = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  if (!parsed || typeof parsed !== 'object' || !('findings' in parsed) || !Array.isArray(parsed.findings)) throw new Error('Invalid inspection response')
  return parsed.findings.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('text' in item) || !('reason' in item)) throw new Error('Invalid inspection finding')
    const { text, reason } = item
    if (typeof text !== 'string' || !text.trim() || typeof reason !== 'string' || !reason.trim()) throw new Error('Invalid inspection finding')
    return { text, reason, locatable: draft.includes(text) }
  })
}

export async function inspectNarration(draft: string, options: { configId?: number; model?: string } = {}): Promise<NarrationFinding[]> {
  const model = await resolveStageModel('script_rewriter', options)
  const result = await callTextChat(model, draft, {
    systemPrompt: '检查用户提供的纪录片旁白稿，只识别不应朗读的出处块、版权许可、URL、贡献者及编辑历史、书目引用尾注、模板编辑说明和“不作为朗读稿”的声明。正文中可朗读的归属表述如“据《异域录》记载”必须保留。【】节拍标记不是杂质。只返回 JSON：{"findings":[{"text":"从当前稿逐字复制的完整片段","reason":"理由"}]}；没有问题返回 {"findings":[]}。不要改写正文。',
    temperature: 0,
    maxTokens: Number(process.env.AI_MAX_TOKENS || 16384),
    timeoutMs: 120000,
  })
  if (result.finishReason === 'length') throw new Error('Inspection response truncated')
  return parseNarrationInspection(result.text, draft)
}
