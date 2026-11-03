/**
 * Agent 聊天路由 — HTTP 非流式：服务端以流式调用模型（runAgent），读完后一次性返回
 */
import { Hono } from 'hono'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { createTextTask, finishTextTask, resolveTextModel, type TextTaskKind } from '../services/text-task.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { describeNarrationGaps, narrationCoverage, type NarrationGap } from '../services/narration-first.js'
import { resolveDramaProjectType } from '../services/project-type.js'

const app = new Hono()

/** 同步 chat 跑的文本任务：只有这两类进任务中心（提取/提示词有各自的批量入口） */
const CHAT_TASK_KINDS: Record<string, TextTaskKind> = {
  script_rewriter: 'script_rewrite',
  storyboard_breaker: 'storyboard_breaker',
}

/** 纪录片项目本集剧本还没有被任何分镜领走的片段；非纪录片项目恒为空 */
async function narrationCoverageGaps(episodeId: number): Promise<NarrationGap[]> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep || resolveDramaProjectType(ep.dramaId) !== 'documentary') return []
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
  const narrations = rows.filter(sb => !sb.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    .map(sb => sb.narrationText)
  return narrationCoverage(ep.scriptContent || ep.content, narrations).gaps
}

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  // 旁白开关（#30）：拆分分镜的条件技能据此注入；关闭时注入内容与改动前逐字相同
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(episode_id)))
  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
    narrationEnabled: ep?.narrationEnabled === true,
  })

  // 同步 chat 也进任务中心：开始建 text 任务，结束写 completed/failed（HTTP 交互不变）
  const kind = CHAT_TASK_KINDS[agentType]
  let taskId: number | null = null
  if (kind) {
    const resolved = await resolveTextModel({ model: body.model || undefined, configId: body.config_id || undefined })
    taskId = await createTextTask({
      kind,
      episodeId: Number(episode_id),
      dramaId: Number(drama_id),
      prompt: typeof message === 'string' ? message : null,
      provider: resolved.provider,
      model: resolved.model,
      configId: body.config_id || resolved.configId || undefined,
    })
  }
  // 工具计量（#46 read_image）要知道写进哪条任务：任务行建在 rc 之后，这里补注入
  if (taskId) requestContext.set('textTaskId' as never, taskId as never)

  const sink = taskId ? createReasoningSink(taskId) : undefined
  const startTime = performance.now()

  try {
    const result = await runAgent(
      agent,
      [{ role: 'user', content: message }],
      { maxSteps: 20, requestContext },
      sink,
    )

    // narration-first 闸门（#49）：纪录片拆分分镜必须把剧本正文**整篇**切进各镜旁白。
    // 只看「写下来的话是否出自剧本」挡不住整段被跳过——实测 93 镜漏 746 字，S13 的句子
    // 连镜头都没有。有缺口就把任务标失败并列出前几处，绝不静默成功。
    if (agentType === 'storyboard_breaker' && kind) {
      const gaps = await narrationCoverageGaps(Number(episode_id))
      if (gaps.length) {
        const detail = `旁白覆盖缺口：剧本有 ${gaps.length} 段未被任何分镜领走（${describeNarrationGaps(gaps)}）。请重新拆分或补镜。`
        if (taskId) await finishTextTask(taskId, 'failed', { errorMsg: detail, outputText: result.text || '' })
        logTaskError('Agent', agentType, { episodeId: episode_id, error: detail })
        return badRequest(c, detail)
      }
    }
    if (taskId) await finishTextTask(taskId, 'completed', { outputText: result.text || '' })

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : 'Agent 执行失败'
    if (taskId) await finishTextTask(taskId, 'failed', { errorMsg: errMessage })
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: errMessage })
    console.error(err instanceof Error ? err.stack || err.message : String(err))
    return badRequest(c, errMessage)
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
