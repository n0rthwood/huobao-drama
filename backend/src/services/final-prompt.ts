/**
 * 最终提示词服务
 * 生图前确保角色/场景/道具已有「最终提示词」：
 * - 角色 → 三视图（character turnaround：正面/侧面/背面）
 * - 场景 → 固定视角 + 前景/中景/后景
 * - 道具 → 白底单品静物（single product shot on pure white background）
 * 缺失时运行 prompt_generator Agent 创作并保存。
 *
 * 三个 ensure* 返回 `{ prompt, outcome }`（Issue #33）：
 * - `reused`：没要求重写、原本就有有效提示词，直接复用；
 * - `regenerated`：本次 Agent 确实保存了新稿（读回非空且与运行前不同，Issue #24 的成功判据）；
 * - `unchanged_after_rewrite`：force 重写、Agent 正常结束，但读回与运行前逐字相同；
 * - `failed`：Agent 抛错、读回为空，或场景提示词没写到场景时间。
 *
 * 失败时 `prompt` 一定是空串——**绝不把库里残留的旧稿当本次结果返回**，
 * 批量生成据此禁止出图（Issue #33 验收 5b）。单发入口用 `savedPromptOf()`
 * 取「复用/新稿」两态的提示词，其余回退到本地拼接提示词（沿用 Issue #24 语义）。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'
import { sceneFinalPromptCoversTime } from './scene-time.js'

type CharacterRow = typeof schema.characters.$inferSelect
type SceneRow = typeof schema.scenes.$inferSelect
type PropRow = typeof schema.props.$inferSelect

/** 顶栏选择的文本模型/配置覆盖（不传则跟随 Agent 与文本配置默认） */
export interface PromptAgentOptions { model?: string; configId?: number }

async function runPromptAgent(episodeId: number, dramaId: number, message: string, opts?: PromptAgentOptions) {
  const agent = mastra.getAgent('prompt_generator')
  if (!agent) throw new Error('图片提示词 Agent 不可用')
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId,
    modelOverride: opts?.model || undefined,
    textConfigId: opts?.configId || undefined,
  })
  await runAgent(agent, [{ role: 'user', content: message }], { maxSteps: 12, requestContext })
}

/** 提示词阶段逐项结论：只有 failed 禁止出图（Issue #33 Q4/Q12） */
export type FinalPromptOutcome = 'reused' | 'regenerated' | 'unchanged_after_rewrite' | 'failed'

export interface FinalPromptResult {
  /** 可用于出图的提示词；outcome='failed' 时恒为空串 */
  prompt: string
  outcome: FinalPromptOutcome
}

const FAILED_PROMPT: FinalPromptResult = { prompt: '', outcome: 'failed' }

/**
 * Agent 运行后读回的提示词 → 结论。
 * 非 force 时「读回与运行前相同」说明 Agent 没保存新稿（而旧稿本来就无效，否则不会跑到这里），记失败。
 */
function promptOutcome(kind: string, id: number, before: string | null, after: string | null | undefined, force: boolean): FinalPromptResult {
  if (after) {
    if (after !== before) return { prompt: after, outcome: 'regenerated' }
    if (force) return { prompt: after, outcome: 'unchanged_after_rewrite' }
  }
  logTaskError('FinalPrompt', `${kind}-generate`, { [`${kind}Id`]: id, error: 'agent did not save a new final prompt' })
  return FAILED_PROMPT
}

/** 单发入口的提示词：只有复用或本次保存了新稿才用，其余交给调用方回退本地拼接（Issue #24 语义不变） */
export function savedPromptOf(result: FinalPromptResult): string {
  return result.outcome === 'reused' || result.outcome === 'regenerated' ? result.prompt : ''
}

/** 确保角色拥有三视图最终提示词；force 时忽略已有提示词强制重新生成 */
export async function ensureCharacterFinalPrompt(char: CharacterRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<FinalPromptResult> {
  if (char.finalPrompt && !force) return { prompt: char.finalPrompt, outcome: 'reused' }
  try {
    logTaskProgress('FinalPrompt', 'character-generate', { characterId: char.id, episodeId })
    await runPromptAgent(episodeId, char.dramaId,
      `为角色「${char.name}」(character_id=${char.id}) 生成三视图最终提示词，并调用 save_character_final_prompt 保存。`, opts)
    const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, char.id))
    return promptOutcome('character', char.id, char.finalPrompt, fresh?.finalPrompt, force)
  } catch (err: unknown) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: char.id, error: err instanceof Error ? err.message : String(err) })
    return FAILED_PROMPT
  }
}

/**
 * 确保场景拥有固定视角（前中后景）最终提示词；force 时忽略已有提示词强制重新生成。
 * 已存提示词没有引用当前场景时间（Issue #21）视为无效，重新生成；新稿同样没写到时间时记失败。
 */
export async function ensureSceneFinalPrompt(scene: SceneRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<FinalPromptResult> {
  if (scene.finalPrompt && !force && sceneFinalPromptCoversTime(scene.finalPrompt, scene.time)) {
    return { prompt: scene.finalPrompt, outcome: 'reused' }
  }
  const time = (scene.time || '').trim()
  try {
    logTaskProgress('FinalPrompt', 'scene-generate', { sceneId: scene.id, episodeId, time: time || undefined })
    await runPromptAgent(episodeId, scene.dramaId,
      `为场景「${scene.location}」(scene_id=${scene.id}) 生成固定视角（前景/中景/后景）最终提示词，并调用 save_scene_final_prompt 保存。注意：这是无人物空镜——场景图中不能出现任何的人（含背影、剪影、倒影、照片里的人），即使场景描述提到人物活动也必须剔除，只保留场景本身。${time ? `场景时间是「${time}」：提示词必须原样写出「${time}」，光线按该时段描写。` : ''}`, opts)
    const [fresh] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.id))
    const result = promptOutcome('scene', scene.id, scene.finalPrompt, fresh?.finalPrompt, force)
    // Agent 没能保存引用时间的提示词时记失败，交给调用方回退拼接（回退拼接包含 time）
    if (result.prompt && !sceneFinalPromptCoversTime(result.prompt, fresh?.time)) {
      logTaskError('FinalPrompt', 'scene-generate', { sceneId: scene.id, error: 'final prompt does not cover scene time' })
      return FAILED_PROMPT
    }
    return result
  } catch (err: unknown) {
    logTaskError('FinalPrompt', 'scene-generate', { sceneId: scene.id, error: err instanceof Error ? err.message : String(err) })
    return FAILED_PROMPT
  }
}

/** 确保道具拥有白底单品最终提示词；force 时忽略已有提示词强制重新生成 */
export async function ensurePropFinalPrompt(prop: PropRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<FinalPromptResult> {
  if (prop.finalPrompt && !force) return { prompt: prop.finalPrompt, outcome: 'reused' }
  try {
    logTaskProgress('FinalPrompt', 'prop-generate', { propId: prop.id, episodeId })
    await runPromptAgent(episodeId, prop.dramaId,
      `为道具「${prop.name}」(prop_id=${prop.id}) 生成白底单品最终提示词，并调用 save_prop_final_prompt 保存。`, opts)
    const [fresh] = await db.select().from(schema.props).where(eq(schema.props.id, prop.id))
    return promptOutcome('prop', prop.id, prop.finalPrompt, fresh?.finalPrompt, force)
  } catch (err: unknown) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: prop.id, error: err instanceof Error ? err.message : String(err) })
    return FAILED_PROMPT
  }
}
