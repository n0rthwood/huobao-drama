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
import { createTextTask, finishTextTask, patchTextTaskParams, type TextTaskKind } from '../services/text-task.js'
import { runWithTextTask } from '../services/text-task-context.js'
import { buildEvidenceImages, evidenceMessageParts } from '../services/evidence-images.js'
import { agentChatStage, resolveStageModel, StageVisionUnavailableError, type StageModel } from '../services/ai-stages.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { skeletonAcceptanceProblems } from '../services/narration-skeleton.js'
import { resolveDramaProjectType } from '../services/project-type.js'
import { assertGate } from '../services/workflow-gates.js'
import { consumeStoryboardStopReason } from '../agents/tools/storyboard-tools.js'

const app = new Hono()

/** 同步 chat 跑的文本任务：只有这两类进任务中心（提取/提示词有各自的批量入口） */
const CHAT_TASK_KINDS: Record<string, TextTaskKind> = {
  script_rewriter: 'script_rewrite',
  storyboard_breaker: 'storyboard_breaker',
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

  // 按环节选模型（#51）：纪录片拆分分镜要看证据素材，顶栏即使选了 GLM 也会被换成视觉配置
  const projectType = resolveDramaProjectType(Number(drama_id))
  const stage = agentChatStage(agentType, projectType)
  // 纪录片剧本改写已切到分阶段流水线（#70）：旧的同步 chat 入口不再处理纪录片项目。
  // 放在建任务之前，避免留下一条必定失败的任务行与一次白烧的模型调用。
  if (agentType === 'script_rewriter' && projectType === 'documentary') {
    return badRequest(c, '纪录片剧本改写已改为分阶段流程：请使用 POST /episodes/:id/script-rewrite（自动过滤非旁白内容 → 忠实改写 → 桥句润色），本接口不再处理纪录片项目')
  }

  // 门禁（#54）：纪录片拆分分镜要求剧本已确认 + 资产审核清单已通过（七步门禁不变）。
  // 放在建 sys_task 之前：被拦时不留任务行，GateBlockedError 由全局 onError 转 400 {gate, reason}。
  if (agentType === 'storyboard_breaker' && projectType === 'documentary') {
    await assertGate(Number(episode_id), 'design')
  }
  let resolved: StageModel
  try {
    resolved = await resolveStageModel(stage, { model: body.model || undefined, configId: body.config_id || undefined })
  } catch (err) {
    if (err instanceof StageVisionUnavailableError) {
      logTaskError('Agent', agentType, { stage, error: err.message })
      return badRequest(c, err.message)
    }
    throw err
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: resolved.model,
    textConfigId: resolved.configId ?? undefined,
    narrationEnabled: ep?.narrationEnabled === true,
  })

  // 同步 chat 也进任务中心：开始建 text 任务，结束写 completed/failed（HTTP 交互不变）
  const kind = CHAT_TASK_KINDS[agentType]
  let taskId: number | null = null
  if (kind) {
    taskId = await createTextTask({
      kind,
      episodeId: Number(episode_id),
      dramaId: Number(drama_id),
      prompt: typeof message === 'string' ? message : null,
      stageModel: resolved,
      queued: true,
    })
  }
  // 工具计量（#46 read_image）要知道写进哪条任务：任务行建在 rc 之后，这里补注入
  if (taskId) requestContext.set('textTaskId' as never, taskId as never)

  const sink = taskId ? createReasoningSink(taskId) : undefined
  const startTime = performance.now()

  // 纪录片拆分分镜直接附证据图（#51）：只靠 read_image 工具提示，模型实测一次都不调用
  const evidence = stage === 'storyboard_breaker_documentary'
    ? await buildEvidenceImages(Number(episode_id))
    : []
  if (evidence.length && taskId) {
    await patchTextTaskParams(taskId, {
      evidence_images: evidence.map(image => ({ prop_id: image.propId, name: image.name, kind: image.kind, marks: image.legend.length })),
    })
  }

  try {
    const result = await runWithTextTask(taskId, () => runAgent(
      agent,
      [{ role: 'user', content: evidenceMessageParts(String(message), evidence) }],
      { maxSteps: 20, requestContext },
      sink,
    ))

    // 镜头数硬上限的止损（#57）：连续两批整批被拒就不再让模型重试，把任务判失败并给出合并建议
    if (agentType === 'storyboard_breaker' && kind) {
      const stop = consumeStoryboardStopReason(Number(episode_id))
      if (stop) {
        if (taskId) await finishTextTask(taskId, 'failed', { errorMsg: stop, outputText: result.text || '' })
        logTaskError('Agent', agentType, { episodeId: episode_id, error: stop })
        return badRequest(c, stop)
      }
    }

    // 骨架验收（#49 + #70）：纪录片拆分分镜必须把剧本正文**整篇、有序、不重不漏**地切进各镜旁白。
    // 只看缺口挡不住「同一句被两镜重复领走」或顺序颠倒——两者都会让骨架无法确认，
    // 任务却显示成功。验收口径与确认骨架完全一致；分镜保留，由人按问题清单修边界。
    if (agentType === 'storyboard_breaker' && kind) {
      const problems = await skeletonAcceptanceProblems(Number(episode_id))
      if (problems.length) {
        const detail = `旁白骨架不合法：${problems.slice(0, 3).map(p => p.message).join('；')}${problems.length > 3 ? `（共 ${problems.length} 处）` : ''}。分镜已保留，请在「旁白骨架」里调整边界或重新拆分。`
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
