/**
 * 场景时间不变量（Issue #21）：场景 time 非空时，它的最终提示词必须原样包含 time 文本，
 * 否则视为无效——保存时拒绝（Agent 工具 / PUT /scenes/:id），使用时重新生成（ensureSceneFinalPrompt）。
 * 判定 = trim 后忽略大小写的包含判断。
 */
import { planFinalPromptWrite } from './asset-prompt-invalidation.js'

/** 最终提示词是否引用了场景时间；time 为空时不做要求 */
export function sceneFinalPromptCoversTime(finalPrompt: string | null | undefined, time: string | null | undefined): boolean {
  const period = (time || '').trim().toLowerCase()
  if (!period) return true
  return (finalPrompt || '').toLowerCase().includes(period)
}

export function sceneTimeMissingMessage(time: string): string {
  return `场景最终提示词必须原样包含场景时间「${time.trim()}」，并按该时段描写光线`
}


export type SceneTimePatch =
  | { error: string }
  | { time?: string; finalPrompt?: string | null }

/**
 * PUT /scenes/:id 的时间 / 最终提示词写入规则（纯函数）：
 * - time 不能从非空改成空；
 * - 显式写入的非空最终提示词必须引用（新的）time，否则拒绝；与已存值相同视为未写入；
 * - time 变化或画面字段变化（sourceChanged，Issue #24）且本次没有写入新提示词 → 旧提示词失效（置空，下次出图重写）。
 * 返回需要落库的字段（undefined = 不动）。
 */
export function planSceneTimePatch(input: {
  currentTime: string | null
  currentFinalPrompt: string | null
  /** 请求体里的 time；undefined = 未传 */
  time?: string | null
  /** 请求体里的 final_prompt；undefined = 未传，null/'' = 清空 */
  finalPrompt?: string | null
  /** location / prompt / lighting 是否改了值（asset-prompt-invalidation.ts） */
  sourceChanged?: boolean
}): SceneTimePatch {
  const currentTime = (input.currentTime || '').trim()
  const nextTime = input.time === undefined ? currentTime : (input.time || '').trim()
  if (!nextTime && currentTime) return { error: '场景时间不能清空' }

  const promptPlan = planFinalPromptWrite({
    currentFinalPrompt: input.currentFinalPrompt,
    finalPrompt: input.finalPrompt,
    sourceChanged: nextTime !== currentTime || !!input.sourceChanged,
  })
  if (promptPlan.finalPrompt && !sceneFinalPromptCoversTime(promptPlan.finalPrompt, nextTime)) return { error: sceneTimeMissingMessage(nextTime) }

  const patch: { time?: string; finalPrompt?: string | null } = { ...promptPlan }
  if (input.time !== undefined) patch.time = nextTime
  return patch
}