import type { Agent, AgentExecutionOptionsBase } from '@mastra/core/agent'
import type { FullOutput } from '@mastra/core/stream'
import { runWithReasoningSink, type ReasoningSink } from './reasoning-sink.js'
import { markAgentFailureIfSafe, runWithAgentTextCall } from '../services/text-task-context.js'
import { recordAgentGateWait, recordFinalToolResults } from '../services/task-observability.js'
import { agentGate, isInteractiveAgentRun } from './agent-gate.js'
import { logTaskProgress } from '../utils/task-logger.js'

/**
 * 以流式方式执行 Agent，读完整个流后返回与 agent.generate() 相同结构的结果
 *
 * 背景：generate() 走非流式请求，模型（GLM 等推理模型）要把推理 + 全部输出生成完才返回响应头，
 * 长输出（如拆分分镜一次产出全部分镜）会超过 undici 默认 headersTimeout=300s（任务 #281）。
 * 流式下响应头秒级返回，推理/正文分块持续到达；Mastra 的 generate 内部也是 getFullOutput + 抛 error。
 *
 * 传入 sink 时（有 sys_task 的文本任务），本次运行的思考内容会被截取落盘（Issue #19）；
 * sink 的 flush 在成功/失败路径都执行，保证 reasoning_chars 与文件一致。
 */
export type AgentRunOutput = FullOutput<unknown>

export async function runAgent(
  agent: Agent,
  messages: Parameters<Agent['generate']>[0],
  options: AgentExecutionOptionsBase<unknown>,
  sink?: ReasoningSink,
): Promise<AgentRunOutput> {
  const exec = async () => {
    const output = await agent.stream(messages, {
      ...options,
      onStepFinish: async (step) => {
        await recordFinalToolResults(step)
        await options.onStepFinish?.(step)
      },
    })
    const full = await output.getFullOutput()
    // 无后续模型请求的最后一步同样补记；失败也不丢已经发生的公开工具返回。
    await recordFinalToolResults(full)
    if (full.error) throw full.error
    return full
  }
  // 全局 agent 并发闸（Issue #118 B）：先全局闸再端点槽；交互请求下一空槽优先（非抢占），
  // 排队等待单独记 agent_gate_ms，取消（abortSignal）即出队不占槽。
  const queuedAt = Date.now()
  const interactive = isInteractiveAgentRun()
  const signal = options.abortSignal
  if (agentGate.stats().active >= agentGate.limit) {
    logTaskProgress('AgentGate', 'queue', { ...agentGate.stats(), interactive })
  }
  return agentGate.run({ interactive, signal }, async () => {
    const gateWaitMs = Date.now() - queuedAt
    recordAgentGateWait(gateWaitMs)
    logTaskProgress('AgentGate', 'acquired', { ...agentGate.stats(), interactive, gateWaitMs })
    return runWithAgentTextCall(async () => {
      try {
        if (!sink) return await exec()
        return await runWithReasoningSink(sink, async () => {
          try {
            return await exec()
          } finally {
            await sink.flush().catch(() => { /* 落盘失败不影响任务结果 */ })
          }
        })
      } catch (err) {
        markAgentFailureIfSafe(err)
        throw err
      }
    })
  })
}
