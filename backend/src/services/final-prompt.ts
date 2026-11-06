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
import { runAgent, type AgentRunOutput } from '../agents/run.js'
import { logTaskError, logTaskProgress } from '../utils/task-logger.js'
import { sceneFinalPromptCoversTime } from './scene-time.js'
import { resolveStageModel } from './ai-stages.js'

type CharacterRow = typeof schema.characters.$inferSelect
type SceneRow = typeof schema.scenes.$inferSelect
type PropRow = typeof schema.props.$inferSelect
type PromptKind = 'character' | 'scene' | 'prop'
type PromptAgentOutput = AgentRunOutput

interface PromptSnapshot {
  prompt: string | null | undefined
  time?: string | null
}

interface PromptRecoverySpec {
  kind: PromptKind
  id: number
  episodeId: number
  dramaId: number
  message: string
  before: string | null
  force: boolean
  readTool: string
  saveTool: string
  readSnapshot: () => Promise<PromptSnapshot>
  accepts: (snapshot: PromptSnapshot) => boolean
  opts?: PromptAgentOptions
}

/** 顶栏选择的文本模型/配置覆盖（不传则跟随 Agent 与文本配置默认） */
export interface PromptAgentOptions { model?: string; configId?: number }

const PROMPT_AGENT_MAX_STEPS = 12
const MIN_CORRECTION_STEPS = 2

function outputDiagnostics(output: PromptAgentOutput) {
  return {
    finishReason: output.finishReason,
    steps: output.steps.length,
    toolCalls: output.toolCalls.map(call => call.payload.toolName),
    toolResults: output.toolResults.map((toolResult) => {
      const result = toolResult.payload.result as { error?: unknown; saved?: unknown } | undefined
      return {
        tool: toolResult.payload.toolName,
        ok: !result?.error,
        ...(result?.saved === true ? { saved: true } : {}),
      }
    }),
    textSummary: output.text.replace(/\s+/g, ' ').trim().slice(0, 240),
  }
}

function correctionMessage(
  language: string | null,
  spec: Pick<PromptRecoverySpec, 'kind' | 'id' | 'before' | 'readTool' | 'saveTool'>,
  snapshot: PromptSnapshot,
  first: PromptAgentOutput,
) {
  const diagnostics = outputDiagnostics(first)
  const tools = diagnostics.toolCalls.length ? diagnostics.toolCalls.join(', ') : 'none'
  const results = diagnostics.toolResults.length
    ? diagnostics.toolResults.map(result => `${result.tool}:${result.saved ? 'saved=true' : result.ok ? 'ok' : 'error'}`).join(', ')
    : 'none'
  const field = spec.kind === 'character' ? 'characters.final_prompt'
    : spec.kind === 'scene' ? 'scenes.final_prompt' : 'props.final_prompt'
  const target = `${field} (${spec.kind}_id=${spec.id})`
  const postcondition = !snapshot.prompt ? 'empty'
    : snapshot.prompt === spec.before ? 'unchanged'
      : spec.kind === 'scene' && !sceneFinalPromptCoversTime(snapshot.prompt, snapshot.time) ? 'scene_time_missing'
        : 'invalid'

  if (language === 'en') {
    return `Huobao rejected the previous result with HTTP 400: final prompt generation failed. Call chain: the prompt_generator run ended with finishReason=${diagnostics.finishReason ?? 'unknown'}, recognized tools=[${tools}], and recognized tool results=[${results}]; after the Agent returned, Huobao re-read ${target} and got postcondition=${postcondition}, which did not satisfy the existing success condition, so ${spec.saveTool} did not produce an effective save. Plain-text DSML/XML/JSON pseudo-calls are never executed. This is Huobao's only corrective user turn. The applicable skills are already injected into system instructions and there is no skill tool. Use the native tool/function-call channel: call ${spec.readTool}, then ${spec.saveTool}. The task succeeds only when the save tool returns saved=true; otherwise Huobao will classify it as a model failure.`
  }
  if (language === 'ja') {
    return `火宝は前回の結果を HTTP 400（最終プロンプト生成失敗）として却下しました。呼び出し経路：prompt_generator は finishReason=${diagnostics.finishReason ?? 'unknown'}、認識済みツール=[${tools}]、認識済みツール結果=[${results}] で終了し、Agent 終了後に火宝が ${target} を再読込した結果は postcondition=${postcondition} で、既存の成功条件を満たしていませんでした。したがって ${spec.saveTool} による有効な保存は発生していません。通常テキスト内の DSML/XML/JSON 擬似ツール呼び出しは実行されません。これは火宝からの唯一の訂正 user turn です。適用スキルは system instructions に注入済みで、skill ツールは存在しません。ネイティブ tool/function-call 経路で ${spec.readTool}、続いて ${spec.saveTool} を呼び出してください。保存ツールが saved=true を返した場合のみ成功です。再度失敗した場合はモデル失敗として終了します。`
  }
  if (language === 'ko') {
    return `화보가 이전 결과를 HTTP 400(최종 프롬프트 생성 실패)으로 거부했습니다. 호출 흐름: prompt_generator가 finishReason=${diagnostics.finishReason ?? 'unknown'}, 인식된 도구=[${tools}], 인식된 도구 결과=[${results}] 상태로 끝난 뒤 화보가 ${target}를 다시 읽은 결과는 postcondition=${postcondition}로 기존 성공 조건을 충족하지 못했습니다. 따라서 ${spec.saveTool}의 유효한 저장이 발생하지 않았습니다. 일반 본문의 DSML/XML/JSON 의사 도구 호출은 실행되지 않습니다. 이것은 화보가 보내는 유일한 교정 user turn입니다. 적용 스킬은 system instructions에 이미 주입되어 있으며 skill 도구는 없습니다. 네이티브 tool/function-call 채널로 ${spec.readTool}을 호출한 다음 ${spec.saveTool}을 호출하세요. 저장 도구가 saved=true를 반환해야만 성공이며, 다시 실패하면 모델 실패로 종료합니다.`
  }
  return `火宝拒绝了上一轮结果并返回 HTTP 400：最终提示词生成失败。调用链：prompt_generator 以 finishReason=${diagnostics.finishReason ?? 'unknown'}、可识别工具=[${tools}]、可识别工具结果=[${results}] 结束；Agent 返回后，火宝重新读取 ${target}，结果为 postcondition=${postcondition}，不满足现有成功条件，因此 ${spec.saveTool} 没有产生有效保存。普通正文中的 DSML/XML/JSON 伪工具调用不会被执行。这是火宝唯一一次纠正 user turn。适用技能已经完整注入 system instructions，不存在 skill 工具。必须通过原生 tool/function-call 通道先调用 ${spec.readTool}，再调用 ${spec.saveTool}。只有保存工具返回 saved=true 才算成功；再次失败将被判定为模型失败。`
}

async function runPromptAgentWithOneCorrection(spec: PromptRecoverySpec): Promise<PromptSnapshot> {
  const agent = mastra.getAgent('prompt_generator')
  if (!agent) throw new Error('图片提示词 Agent 不可用')
  const resolved = await resolveStageModel('final_prompt', spec.opts || {})
  const requestContext = buildAgentRequestContext({
    episodeId: spec.episodeId,
    dramaId: spec.dramaId,
    modelOverride: resolved.model,
    textConfigId: resolved.configId ?? undefined,
  })
  const initialMessages = [{ role: 'user' as const, content: spec.message }]
  const first = await runAgent(agent, initialMessages, {
    maxSteps: PROMPT_AGENT_MAX_STEPS,
    requestContext,
  })
  let snapshot = await spec.readSnapshot()
  if (spec.accepts(snapshot)) return snapshot

  const firstSteps = Math.max(1, first.steps.length)
  const remainingSteps = PROMPT_AGENT_MAX_STEPS - firstSteps
  if (remainingSteps < MIN_CORRECTION_STEPS) {
    logTaskError('FinalPrompt', `${spec.kind}-correction-skipped`, {
      [`${spec.kind}Id`]: spec.id,
      reason: 'insufficient remaining agent steps',
      remainingSteps,
      first: outputDiagnostics(first),
    })
    return snapshot
  }

  const responseMessages = first.response.messages?.length
    ? first.response.messages
    : [{ role: 'assistant' as const, content: first.text }]
  const correction = correctionMessage(requestContext.get('language') ?? null, spec, snapshot, first)
  logTaskProgress('FinalPrompt', `${spec.kind}-correction`, {
    [`${spec.kind}Id`]: spec.id,
    remainingSteps,
    first: outputDiagnostics(first),
  })
  const second = await runAgent(agent, [
    ...initialMessages,
    ...responseMessages,
    { role: 'user' as const, content: correction },
  ], {
    maxSteps: remainingSteps,
    requestContext,
  })
  snapshot = await spec.readSnapshot()
  if (!spec.accepts(snapshot)) {
    logTaskError('FinalPrompt', `${spec.kind}-correction-failed`, {
      [`${spec.kind}Id`]: spec.id,
      first: outputDiagnostics(first),
      second: outputDiagnostics(second),
    })
  }
  return snapshot
}

/**
 * 提示词阶段逐项结论：`failed` 与 `skipped` 都禁止出图（Issue #33 Q4/Q12、Issue #47）。
 * `skipped` 专指证据素材——不是生成失败，而是这类资产根本不该有生图提示词。
 */
export type FinalPromptOutcome = 'reused' | 'regenerated' | 'unchanged_after_rewrite' | 'failed' | 'skipped'

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
function classifyPromptOutcome(before: string | null, after: string | null | undefined, force: boolean): FinalPromptResult {
  if (after) {
    if (after !== before) return { prompt: after, outcome: 'regenerated' }
    if (force) return { prompt: after, outcome: 'unchanged_after_rewrite' }
  }
  return FAILED_PROMPT
}

function promptOutcome(kind: string, id: number, before: string | null, after: string | null | undefined, force: boolean): FinalPromptResult {
  const result = classifyPromptOutcome(before, after, force)
  if (result.outcome === 'failed') {
    logTaskError('FinalPrompt', `${kind}-generate`, { [`${kind}Id`]: id, error: 'agent did not save a new final prompt' })
  }
  return result
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
    const snapshot = await runPromptAgentWithOneCorrection({
      kind: 'character',
      id: char.id,
      episodeId,
      dramaId: char.dramaId,
      message: `为角色「${char.name}」(character_id=${char.id}) 生成三视图最终提示词，并调用 saveCharacterFinalPrompt 保存。`,
      before: char.finalPrompt,
      force,
      readTool: 'readCharacters',
      saveTool: 'saveCharacterFinalPrompt',
      readSnapshot: async () => {
        const [fresh] = await db.select().from(schema.characters).where(eq(schema.characters.id, char.id))
        return { prompt: fresh?.finalPrompt }
      },
      accepts: snapshot => Boolean(savedPromptOf(classifyPromptOutcome(char.finalPrompt, snapshot.prompt, force))),
      opts,
    })
    return promptOutcome('character', char.id, char.finalPrompt, snapshot.prompt, force)
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
    const snapshot = await runPromptAgentWithOneCorrection({
      kind: 'scene',
      id: scene.id,
      episodeId,
      dramaId: scene.dramaId,
      message: `为场景「${scene.location}」(scene_id=${scene.id}) 生成固定视角（前景/中景/后景）最终提示词，并调用 saveSceneFinalPrompt 保存。注意：这是无人物空镜——场景图中不能出现任何的人（含背影、剪影、倒影、照片里的人），即使场景描述提到人物活动也必须剔除，只保留场景本身。${time ? `场景时间是「${time}」：提示词必须原样写出「${time}」，光线按该时段描写。` : ''}`,
      before: scene.finalPrompt,
      force,
      readTool: 'readScenes',
      saveTool: 'saveSceneFinalPrompt',
      readSnapshot: async () => {
        const [fresh] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.id))
        return { prompt: fresh?.finalPrompt, time: fresh?.time }
      },
      accepts: snapshot => Boolean(
        savedPromptOf(classifyPromptOutcome(scene.finalPrompt, snapshot.prompt, force))
        && sceneFinalPromptCoversTime(snapshot.prompt || '', snapshot.time),
      ),
      opts,
    })
    const result = promptOutcome('scene', scene.id, scene.finalPrompt, snapshot.prompt, force)
    // Agent 没能保存引用时间的提示词时记失败，交给调用方回退拼接（回退拼接包含 time）
    if (result.prompt && !sceneFinalPromptCoversTime(result.prompt, snapshot.time)) {
      logTaskError('FinalPrompt', 'scene-generate', { sceneId: scene.id, error: 'final prompt does not cover scene time' })
      return FAILED_PROMPT
    }
    return result
  } catch (err: unknown) {
    logTaskError('FinalPrompt', 'scene-generate', { sceneId: scene.id, error: err instanceof Error ? err.message : String(err) })
    return FAILED_PROMPT
  }
}

/**
 * 确保道具拥有白底单品最终提示词；force 时忽略已有提示词强制重新生成。
 *
 * 证据素材（`faithful=1`，Issue #47）直接返回 `skipped`：白底单品提示词是给扩散模型
 * 重画用的，而证据素材只能作为原图 + 叠加层使用，给它写风格词没有任何下游会读，
 * 反而会让批量界面显示「已就绪」误导人去出图。
 */
export async function ensurePropFinalPrompt(prop: PropRow, episodeId: number, force = false, opts?: PromptAgentOptions): Promise<FinalPromptResult> {
  if (Number(prop.faithful) === 1) return { prompt: prop.finalPrompt ?? '', outcome: 'skipped' }
  if (prop.finalPrompt && !force) return { prompt: prop.finalPrompt, outcome: 'reused' }
  try {
    logTaskProgress('FinalPrompt', 'prop-generate', { propId: prop.id, episodeId })
    const snapshot = await runPromptAgentWithOneCorrection({
      kind: 'prop',
      id: prop.id,
      episodeId,
      dramaId: prop.dramaId,
      message: `为道具「${prop.name}」(prop_id=${prop.id}) 生成白底单品最终提示词，并调用 savePropFinalPrompt 保存。`,
      before: prop.finalPrompt,
      force,
      readTool: 'readProps',
      saveTool: 'savePropFinalPrompt',
      readSnapshot: async () => {
        const [fresh] = await db.select().from(schema.props).where(eq(schema.props.id, prop.id))
        return { prompt: fresh?.finalPrompt }
      },
      accepts: snapshot => Boolean(savedPromptOf(classifyPromptOutcome(prop.finalPrompt, snapshot.prompt, force))),
      opts,
    })
    return promptOutcome('prop', prop.id, prop.finalPrompt, snapshot.prompt, force)
  } catch (err: unknown) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: prop.id, error: err instanceof Error ? err.message : String(err) })
    return FAILED_PROMPT
  }
}
