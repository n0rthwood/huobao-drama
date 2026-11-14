/**
 * 地图工作室的模型阶段循环（Issue #99，迁移自 #90 的旧地图工作流阶段循环，旧代码已在 #99 删除）
 *
 * 分工不变：**代码强制流程，阶段内的工作由模型在工具循环里自己做。**
 * - 阶段内的一切工作经由工具执行；工具内部任何异常都转成结构化错误作为工具结果回给模型，不中断循环；
 * - 交付走 `deliver()`：每次交付消耗一轮，校验只判收/拒，拒收原因原样回给模型；
 * - 一次 Agent 运行没有交付就结束（或运行本身出错）也消耗一轮，错误与上轮拒收原因写进下一轮的提示；
 * - 轮次耗尽才判阶段失败交人；回退由模型调用 `request_rollback` 发起，计数在运行层管理；
 * - 每一轮的结果写进任务文档的 `agent` 记录（不进修订历史），重启后不归零。
 *
 * 迁移后的差别只有容器：任务 id = `map_studio_task.id`，运行 id = `map_studio_run.id`；
 * 技能文档从模块自己的 `skills/` 读，思考内容不再写火宝的文本任务文件（模块没有 sys_task 行）。
 */
import { Agent, type AgentExecutionOptionsBase, type MastraDBMessage, type ToolsInput } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getModel } from '../../agents/index.js'
import { runAgent } from '../../agents/run.js'
import { buildAgentRequestContext } from '../../agents/context.js'
import { now } from '../../utils/response.js'
import { logTaskWarn } from '../../utils/task-logger.js'
import type { StageModel } from '../../services/ai-stages.js'
import { loadTask, mutateTask, stageIndex, MapStudioConflictError, MapStudioStaleError } from './store.js'
import { loadMapStudioSkill } from './skills.js'
import {
  MAP_AGENT_STAGES,
  MAP_MAX_ROLLBACKS,
  MAP_MAX_STAGE_ROUNDS,
  STAGE_LABEL,
  type MapAgentAttempt,
  type MapAgentStage,
  type MapBrief,
  type MapWorkflowStage,
} from './types.js'

const MAX_ATTEMPT_RECORDS = 80

/** 阶段轮次耗尽：交人。message 汇总最后一轮的问题 */
export class MapStageExhaustedError extends Error {
  stage: MapAgentStage
  problems: string[]
  constructor(stage: MapAgentStage, problems: string[]) {
    super(`「${STAGE_LABEL[stage]}」已用完 ${MAP_MAX_STAGE_ROUNDS} 轮交付仍未通过校验，需要人工处理。最后一轮的问题：${problems.join('；') || '（无交付）'}`)
    this.name = 'MapStageExhaustedError'
    this.stage = stage
    this.problems = problems
  }
}

/** 记一条尝试；同时更新本阶段已用轮次。任务已不是当前运行时抛 Stale（由执行线程整体收尾） */
export async function recordAttempt(
  taskId: number,
  runId: number,
  attempt: Omit<MapAgentAttempt, 'run_id' | 'at'>,
  rounds?: number,
): Promise<void> {
  await mutateTask(taskId, {
    expectedRunId: runId,
    action: `agent_${attempt.outcome}:${attempt.stage}`,
    actor: 'auto',
    history: false,
    mutate: (ctx) => {
      const agent = ctx.state.agent
      if (agent.run_id !== runId) {
        agent.run_id = runId
        agent.rounds = {}
        agent.rollbacks = 0
      }
      if (rounds !== undefined) agent.rounds[attempt.stage as MapAgentStage] = rounds
      agent.attempts = [...agent.attempts, { ...attempt, problems: attempt.problems.map(p => p.slice(0, 1200)), run_id: runId, at: now() }]
        .slice(-MAX_ATTEMPT_RECORDS)
    },
  })
}

export interface StageSession<T> {
  readonly stage: MapAgentStage
  rounds: number
  accepted: T | null
  rollback: { stage: MapWorkflowStage; reason: string } | null
  /** 运行已被取消/接管等致命情况：停止整个阶段，不回馈模型 */
  fatal: unknown
  exhausted: boolean
  lastProblems: string[]
  /** 本次 Agent 运行里是否已交付过（交付过的运行结束时不再额外扣轮） */
  deliveredThisRun: boolean
  /**
   * 交付一次：消耗一轮。problems 非空即拒收，原样回给模型；为空才调用 accept 收下结果。
   * 返回给模型的工具结果说明本轮编号、剩余轮次与全部问题。
   */
  deliver(problems: string[], accept: () => T): Promise<Record<string, unknown>>
}

/**
 * 单次工具调用的墙钟上限：外部检索、渲染等任何一个工具卡住都不能把整个阶段挂死
 * （生产验收任务 1 / run 6：四个并行检索里有一个 34 分钟没有返回，阶段停在原地）。
 * 超时只放弃本次调用并把原因回给模型；底层请求若无法中止会在后台自行结束，结果被丢弃。
 */
const TOOL_TIMEOUT_MS = 180_000

/**
 * 压缩：每一步只保留最近 K 步的工具结果原文，更早的换成一句占位。
 *
 * 为什么是 3：生产 run 7–10 的作图阶段里，模型只在一两步内消费一个工具结果（render_draft 的路径与
 * submit_check、刚读到的正文、刚渲染的底图）；更早的结果永远只是被重读，重读就是重付费。
 * K=3 覆盖「刚做的事 + 上一次检查 + 上上次检查」，同时把最贵的单项（read_source 的 6000 字正文、
 * render_base 的 frame 明细）在历史里限制在最多 3 份。
 */
const KEEP_RECENT_STEPS = 3

/** 压缩后结果的开头标记：已压缩的结果不再压缩，也不会被当成这一步的新结果 */
const COMPACTED_PREFIX = '[已压缩：'

/** 状态消息用固定 id：每一步替换上一步的那条，历史里永远只有一份最新状态 */
const STATE_MESSAGE_ID = 'map-studio-state'

/** read_image 的结论是视觉判断的唯一记录：压缩时保留结论文本，截到这个字数 */
const READ_IMAGE_KEEP_CHARS = 600

/** 工具可选的压缩摘要：result 是该工具 execute 的返回值；只说状态，不复述原文 */
export type ToolSummarize = (result: Record<string, unknown>) => string

/** 没有 summarize 的工具：只按结果形状写一句状态，原文不再重发 */
function fallbackStatus(result: unknown): string {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return result === undefined ? '没有返回内容' : `返回 ${typeof result}`
  }
  if ('error' in result && typeof result.error === 'string') return `返回错误：${result.error.replace(/\s+/g, ' ').slice(0, 80)}`
  const problemCount = 'problems' in result && Array.isArray(result.problems) ? result.problems.length : 0
  if ('accepted' in result && result.accepted === false) return `交付被拒收，${problemCount} 个问题`
  if ('accepted' in result && result.accepted === true) return '交付已接受'
  if (problemCount) return `${problemCount} 个问题`
  const keys = Object.keys(result)
  return keys.length ? `字段 ${keys.slice(0, 6).join(' / ')}` : '空结果'
}

/**
 * 不经 stageTool 建的共享工具（read_image）的压缩摘要放在这里。
 * 读图结论必须留在历史里：它是视觉判断的唯一记录，压缩掉就只能重新看图（多一次计费的视觉调用）；
 * 但只留结论，不留模型的完整长描述。
 */
const DEFAULT_SUMMARIZERS: Record<string, ToolSummarize> = {
  read_image: (result) => {
    const raw = typeof result.text === 'string' ? result.text : result.json === undefined ? '' : JSON.stringify(result.json)
    const conclusion = raw.replace(/\s+/g, ' ').trim().slice(0, READ_IMAGE_KEEP_CHARS)
    return conclusion ? `看图结论：${conclusion}` : '没有结论文本'
  },
}

/** 从工具集合里取各工具挂在实例上的 summarize（stageTool 负责挂） */
function summarizersOf(tools: ToolsInput): Map<string, ToolSummarize> {
  const map = new Map<string, ToolSummarize>(Object.entries(DEFAULT_SUMMARIZERS))
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool !== 'object' || !('summarize' in tool)) continue
    const summarize = tool.summarize
    // stageTool 用 Object.assign 挂上去的就是 ToolSummarize
    if (typeof summarize === 'function') map.set(name, summarize as ToolSummarize)
  }
  return map
}

function compactedResultText(tool: string | undefined, result: unknown, summarize: ToolSummarize | undefined): string {
  const chars = typeof result === 'string' ? result.length : result === undefined ? 0 : JSON.stringify(result)?.length ?? 0
  // stageTool 的 execute 约定返回对象，工具结果按这个约定就是 Record
  const record = typeof result === 'object' && result !== null && !Array.isArray(result) ? result as Record<string, unknown> : null
  const status = summarize && record ? summarize(record) : fallbackStatus(result)
  return `${COMPACTED_PREFIX}${tool ?? '工具'} 的结果（${chars} 字）。${status}]`
}

/**
 * 改写历史消息：更早的工具结果换成占位，工具调用本身（名称+参数）与最近 K 步的结果原文保留。
 *
 * 直接改消息对象里的 result（消息对象身份不变），Mastra 只在身份变化时才把消息重新排到末尾，
 * 原地改不会打乱历史顺序；返回压缩条数供状态消息说明。
 */
function compactToolResults(messages: readonly MastraDBMessage[], summarizeOf: (tool: string) => ToolSummarize | undefined): number {
  // step-start 标记下一步开始：它之前的工具调用属于上一步
  let step = 0
  const stepOf = new Map<string, number>()
  for (const message of messages) {
    if (message.id === STATE_MESSAGE_ID) continue
    for (const part of message.content?.parts ?? []) {
      if (part.type === 'step-start') { step += 1; continue }
      if (part.type !== 'tool-invocation') continue
      if (part.toolInvocation.toolCallId) stepOf.set(part.toolInvocation.toolCallId, step)
    }
  }
  const keepFrom = step + 1 - KEEP_RECENT_STEPS
  let compacted = 0
  for (const message of messages) {
    if (message.id === STATE_MESSAGE_ID) continue
    for (const part of message.content?.parts ?? []) {
      if (part.type !== 'tool-invocation') continue
      const invocation = part.toolInvocation
      if (invocation.state !== 'result' || !invocation.toolCallId) continue
      if (typeof invocation.result === 'string' && invocation.result.startsWith(COMPACTED_PREFIX)) continue
      if ((stepOf.get(invocation.toolCallId) ?? 0) >= keepFrom) continue
      invocation.result = compactedResultText(invocation.toolName, invocation.result, summarizeOf(invocation.toolName))
      compacted += 1
    }
  }
  return compacted
}

/** 每步注入的「当前状态」：阶段代码给的状态 + 本轮拒收原因，都由代码从会话状态生成 */
function buildStateText(session: StageSession<unknown>, stageState: string, compacted: number): string {
  return [
    `当前状态（代码生成，每步更新）：阶段「${STAGE_LABEL[session.stage]}」，已用 ${session.rounds}/${MAP_MAX_STAGE_ROUNDS} 轮交付；本次运行已把 ${compacted} 条更早的工具结果换成了占位。`,
    stageState,
    session.lastProblems.length
      ? `最近一次交付被拒收的原因（必须逐条修正，不能当作已经解决）：\n${session.lastProblems.map((problem, index) => `${index + 1}. ${problem}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n')
}

function stateMessage(text: string): MastraDBMessage {
  return { id: STATE_MESSAGE_ID, role: 'user', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text }] } }
}

/**
 * 包一层：工具的任何异常（含超时）都回给模型（结构化 error），不打断循环。
 * 只有任务已被取消/接管（Stale/Conflict）才记为致命并让本阶段停下。
 */
export function stageTool<S extends z.ZodTypeAny>(
  session: { readonly stage: MapAgentStage; fatal: unknown },
  spec: {
    id: string
    description: string
    inputSchema: S
    timeoutMs?: number
    /** 压缩历史时的一句话状态（不含原文）；不提供则只为结果给出通用形状摘要 */
    summarize?: ToolSummarize
    execute: (input: z.infer<S>) => Promise<Record<string, unknown>>
  },
) {
  const timeoutMs = spec.timeoutMs ?? TOOL_TIMEOUT_MS
  const tool = createTool({
    id: spec.id,
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (input) => {
      let timer: NodeJS.Timeout | undefined
      try {
        // Mastra 已按 inputSchema 校验过入参（不合格的调用由 Mastra 把校验错误回给模型）
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`工具 ${spec.id} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已放弃这次调用；可以换参数或换来源重试`)), timeoutMs)
        })
        return await Promise.race([spec.execute(input as z.infer<S>), timedOut])
      } catch (err) {
        if (err instanceof MapStudioStaleError || err instanceof MapStudioConflictError) {
          session.fatal = err
          return { error: '地图任务已被取消或由其他操作接管，本次执行停止' }
        }
        const message = err instanceof Error ? err.message : String(err)
        logTaskWarn('MapStudio', `tool-error:${spec.id}`, { stage: session.stage, error: message })
        return { error: message, hint: '这是工具执行时出现的错误；请阅读错误原因，修正参数或做法后继续' }
      } finally {
        clearTimeout(timer)
      }
    },
  })
  // Mastra 的 Tool 是普通对象：摘要挂在实例上，runStageAgent 按工具 id 取回；工具语义与入参不变
  return spec.summarize ? Object.assign(tool, { summarize: spec.summarize }) : tool
}

/** 给各阶段模型看的需求摘要（brief 是本次地图的唯一需求来源） */
export function mapBriefText(brief: MapBrief): string {
  return [
    `地图主题：${brief.subject || '（未填）'}`,
    `时代：${brief.era || '（未填）'}`,
    `地域：${brief.location || '（未填）'}`,
    `用途：${brief.purpose || '（未填）'}`,
    `详略：${brief.detail_level}；示意图模式：${brief.schematic ? '是' : '否'}；旧主题：${brief.style}；制图主题：${brief.map_style ?? (Object.hasOwn(brief, 'map_style') ? '跟随模块默认' : '沿用旧主题')}`,
    `用户填写的底图偏好：${brief.base_mode}${brief.reference_image ? `（附外部参考图 ${brief.reference_image.path}，控制点 ${brief.reference_image.control_points.length} 个）` : ''}`,
    brief.notes ? `补充：${brief.notes}` : '',
  ].filter(Boolean).join('\n')
}

/**
 * 模型发起的跨阶段回退：只能回到当前阶段之前的模型阶段，整次运行最多 MAP_MAX_ROLLBACKS 次。
 * 登记成功后本阶段立即结束（不扣本阶段轮次），由运行层把原因交给目标阶段。
 */
export function rollbackTool(session: StageSession<unknown>, spec: { taskId: number; runId: number }) {
  const allowed = MAP_AGENT_STAGES.filter(stage => stageIndex(stage) < stageIndex(session.stage))
  return stageTool(session, {
    id: 'request_rollback',
    description: `上游阶段的产物本身有错、在本阶段无法修正时，回退到上游阶段重做。可回退到：${allowed.join(' / ')}。`
      + `整次运行最多回退 ${MAP_MAX_ROLLBACKS} 次；不消耗本阶段轮次。reason 会原样交给目标阶段，请写清楚哪里错、应该怎么改。`,
    inputSchema: z.object({
      stage: z.string().describe(`回退目标阶段：${allowed.join(' / ')}`),
      reason: z.string().describe('上游错在哪里、目标阶段应该怎么改（会原样交给目标阶段的模型）'),
    }),
    execute: async (input) => {
      const target = String(input.stage) as MapWorkflowStage
      const reason = String(input.reason ?? '').trim()
      if (!(allowed as readonly string[]).includes(target)) return { error: `不能回退到 ${JSON.stringify(input.stage)}；可回退到：${allowed.join(' / ') || '（无，本阶段是第一个模型阶段）'}` }
      if (reason.length < 8) return { error: 'reason 必须具体说明上游哪里错、目标阶段应该怎么改（至少 8 个字）' }
      const loaded = await loadTask(spec.taskId)
      const used = loaded?.state.agent.run_id === spec.runId ? loaded.state.agent.rollbacks : 0
      if (used >= MAP_MAX_ROLLBACKS) {
        return { error: `本次运行的跨阶段回退已用完（${used}/${MAP_MAX_ROLLBACKS}）；请在本阶段内处理，或如实交付并说明无法解决的问题` }
      }
      session.rollback = { stage: target, reason }
      return { accepted: true, next: `已登记回退到「${STAGE_LABEL[target]}」（第 ${used + 1}/${MAP_MAX_ROLLBACKS} 次），本阶段结束；请直接结束回答` }
    },
  })
}

const COMMON_RULES = `你是地图工作室里负责一个阶段的执行者。流程由代码控制，阶段内的工作由你用工具完成。
规则：
1. 只能用模型原生的工具调用通道调用工具，不要在正文里模拟工具调用。
2. 工具返回 error 或 problems 时，逐条阅读并修正后再继续；代码不会替你修正任何东西。
3. 交付工具每调用一次就消耗本阶段的一轮（共 ${MAP_MAX_STAGE_ROUNDS} 轮）。交付前先用检查/预览类工具把问题改干净。
4. 交付被接受后本阶段立即结束；如果发现上游阶段的数据本身有错、在本阶段无法修正，调用 request_rollback 说明原因。
5. 不要编造资料、坐标或来源；不确定就如实写出不确定性。`

export interface StageAgentSpec<T> {
  taskId: number
  runId: number
  stage: MapAgentStage
  stageModel: StageModel
  /** 模块内 `skills/<name>/SKILL.md` */
  skill: string
  maxSteps: number
  /** 起始轮次（回退后为 0；人工重跑也从 0 开始） */
  startRounds: number
  /** 首轮附带的回馈：回退原因、上次失败原因等 */
  initialFeedback: string | null
  prompt: () => Promise<string> | string
  /**
   * 每一步注入的「当前状态」：由阶段代码从自己的会话状态生成（草稿摘要、已登记来源、已渲染底图…），
   * 不靠模型记忆。工具结果被压缩后，模型只能从这里看到早先工作的结果。
   */
  state: () => string
  tools: (session: StageSession<T>) => ToolsInput
}

export type StageAgentResult<T> =
  | { kind: 'accepted'; result: T; rounds: number }
  | { kind: 'rollback'; stage: MapWorkflowStage; reason: string; rounds: number }

/**
 * 跑一个模型阶段直到：交付被接受 / 模型请求回退 / 轮次耗尽（抛 MapStageExhaustedError）/ 任务被取消（抛 Stale）。
 */
export async function runStageAgent<T>(spec: StageAgentSpec<T>): Promise<StageAgentResult<T>> {
  const session: StageSession<T> = {
    stage: spec.stage,
    rounds: spec.startRounds,
    accepted: null,
    rollback: null,
    fatal: null,
    exhausted: false,
    lastProblems: [],
    deliveredThisRun: false,
    async deliver(problems, accept) {
      session.rounds += 1
      session.deliveredThisRun = true
      const round = session.rounds
      if (problems.length) {
        session.lastProblems = problems
        session.exhausted = round >= MAP_MAX_STAGE_ROUNDS
        await recordAttempt(spec.taskId, spec.runId, { stage: spec.stage, round, outcome: 'rejected', problems }, round)
        return {
          accepted: false,
          round,
          rounds_left: Math.max(0, MAP_MAX_STAGE_ROUNDS - round),
          problems,
          ...(session.exhausted ? { final: `本阶段 ${MAP_MAX_STAGE_ROUNDS} 轮已用完，阶段判失败并交给人工；请停止调用工具` } : {
            next: '逐条修正上面的问题后再交付；交付前可先用检查/预览工具确认',
          }),
        }
      }
      session.accepted = accept()
      await recordAttempt(spec.taskId, spec.runId, { stage: spec.stage, round, outcome: 'accepted', problems: [] }, round)
      return { accepted: true, round, next: '交付已接受，本阶段结束；请直接结束回答' }
    },
  }

  const model = await getModel(undefined, spec.stageModel.model, spec.stageModel.configId ?? undefined)
  const skillDoc = await loadMapStudioSkill(spec.skill)
  const tools = spec.tools(session)
  const summarizers = summarizersOf(tools)
  const agent = new Agent({
    id: `map_studio_${spec.stage}`,
    name: `地图工作室 · ${STAGE_LABEL[spec.stage]}`,
    instructions: [COMMON_RULES, skillDoc].filter(Boolean).join('\n\n'),
    model,
    tools,
  })
  // 每一步发送前压缩历史：更早的工具结果换占位、最近 K 步保留原文、末尾重写一条当前状态。
  // system/技能全文、初始 user 提示、阶段回馈与每个工具调用本身都不动（删掉调用参数模型会重复操作）。
  const prepareStep: NonNullable<AgentExecutionOptionsBase<unknown>['prepareStep']> = (args) => {
    const compacted = compactToolResults(args.messages, tool => summarizers.get(tool))
    const kept = args.messages.filter(message => message.id !== STATE_MESSAGE_ID)
    return { messages: [...kept, stateMessage(buildStateText(session, spec.state(), compacted))] }
  }
  // 模块没有火宝的剧集上下文：episodeId/dramaId 传 0，语言与（空的）题材规则按全局设置解析；
  // 不传 textTaskId —— 模块的运行 id 与 sys_task id 不是一个号段，不能让工具把计量写进别人的任务行。
  const requestContext = buildAgentRequestContext({
    episodeId: 0,
    dramaId: 0,
    textConfigId: spec.stageModel.configId ?? undefined,
    modelOverride: spec.stageModel.model,
  })

  let feedback = spec.initialFeedback
  while (session.rounds < MAP_MAX_STAGE_ROUNDS) {
    session.deliveredThisRun = false
    const controller = new AbortController()
    const roundNote = `这是「${STAGE_LABEL[spec.stage]}」阶段，已用 ${session.rounds}/${MAP_MAX_STAGE_ROUNDS} 轮交付。`
    const message = [roundNote, feedback ? `上一轮的情况（请据此修正）：\n${feedback}` : '', await spec.prompt()]
      .filter(Boolean).join('\n\n')
    let runError: string | null = null
    try {
      await runAgent(agent, [{ role: 'user', content: message }], {
        maxSteps: spec.maxSteps,
        requestContext,
        abortSignal: controller.signal,
        prepareStep,
        onStepFinish: async () => {
          if (!session.fatal) {
            const current = await loadTask(spec.taskId)
            if (current?.state.run_id !== spec.runId) session.fatal = new MapStudioStaleError('地图任务已被取消或由其他运行接管')
          }
          if (session.accepted || session.rollback || session.exhausted || session.fatal) controller.abort()
        },
      })
    } catch (err) {
      if (!controller.signal.aborted) runError = err instanceof Error ? err.message : String(err)
    }
    if (session.fatal) throw session.fatal
    if (session.accepted) return { kind: 'accepted', result: session.accepted, rounds: session.rounds }
    if (session.rollback) return { kind: 'rollback', ...session.rollback, rounds: session.rounds }
    if (session.exhausted) throw new MapStageExhaustedError(spec.stage, session.lastProblems)
    if (!session.deliveredThisRun) {
      session.rounds += 1
      const problems = [runError ? `本轮调用出错：${runError}` : '本轮结束时没有调用交付工具（或步数用完仍未交付）']
      session.lastProblems = problems
      await recordAttempt(spec.taskId, spec.runId, {
        stage: spec.stage, round: session.rounds, outcome: runError ? 'error' : 'no_delivery', problems,
      }, session.rounds)
    }
    feedback = session.lastProblems.map((problem, index) => `${index + 1}. ${problem}`).join('\n')
  }
  throw new MapStageExhaustedError(spec.stage, session.lastProblems)
}
