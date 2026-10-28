import type { Agent, AgentExecutionOptionsBase } from '@mastra/core/agent'
import { runWithReasoningSink, type ReasoningSink } from './reasoning-sink.js'

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
export async function runAgent(
  agent: Agent,
  messages: Parameters<Agent['generate']>[0],
  options: AgentExecutionOptionsBase<unknown>,
  sink?: ReasoningSink,
) {
  const exec = async () => {
    const output = await agent.stream(messages, options)
    const full = await output.getFullOutput()
    if (full.error) throw full.error
    return full
  }
  if (!sink) return exec()
  return runWithReasoningSink(sink, async () => {
    try {
      return await exec()
    } finally {
      await sink.flush().catch(() => { /* 落盘失败不影响任务结果 */ })
    }
  })
}
