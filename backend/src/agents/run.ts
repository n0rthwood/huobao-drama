import type { Agent, AgentExecutionOptionsBase } from '@mastra/core/agent'

/**
 * 以流式方式执行 Agent，读完整个流后返回与 agent.generate() 相同结构的结果
 *
 * 背景：generate() 走非流式请求，模型（GLM 等推理模型）要把推理 + 全部输出生成完才返回响应头，
 * 长输出（如拆分分镜一次产出全部分镜）会超过 undici 默认 headersTimeout=300s（任务 #281）。
 * 流式下响应头秒级返回，推理/正文分块持续到达；Mastra 的 generate 内部也是 getFullOutput + 抛 error。
 */
export async function runAgent(
  agent: Agent,
  messages: Parameters<Agent['generate']>[0],
  options: AgentExecutionOptionsBase<unknown>,
) {
  const output = await agent.stream(messages, options)
  const full = await output.getFullOutput()
  if (full.error) throw full.error
  return full
}
