/**
 * 资产提取任务 — 异步执行，按「集 × 类型」粒度跟踪
 * 角色 / 场景 / 道具 可分别单独提取，同一集的不同类型可并行
 * 任务状态持久化在 sys_task(type='text', params.kind=extract_*)：刷新/切页可恢复，后端重启时标记为失败
 */
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  resolveTextModel,
  textTaskOutcome,
  type TextTaskKind,
} from './text-task.js'

export type ExtractTarget = 'characters' | 'scenes' | 'props'
export const EXTRACT_TARGETS: ExtractTarget[] = ['characters', 'scenes', 'props']

export const EXTRACT_TASK_KINDS: Record<ExtractTarget, TextTaskKind> = {
  characters: 'extract_characters',
  scenes: 'extract_scenes',
  props: 'extract_props',
}

export interface ExtractTask {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  error?: string
}

/**
 * 每类资产的提取指令 —— 只说"提取什么类型"，不写任何判定规则（Issue #15）。
 * 判定标准、必提类别、命名与描述写法的唯一事实来源是 extractor 系统提示词与注入的技能
 * （extractor / extractor/prop-extraction）；以前这里重复写了一套"0-3 个、日常物品不提"的
 * 规则，与提示词/技能互相矛盾，直接导致整部剧 0 个道具。
 */
const EXTRACT_MESSAGES: Record<ExtractTarget, string> = {
  characters: '请从本集剧本中提取角色信息并保存，本次只提取角色；提取与去重规范以系统提示词与技能为准。',
  scenes: '请从本集剧本中提取场景信息并保存，本次只提取场景；提取与去重规范以系统提示词与技能为准。',
  props: '请从本集剧本中提取道具信息并保存，本次只提取道具；提取与去重规范以系统提示词与技能为准。',
}

/** 启动异步提取任务（立即返回）；同集同类型已在运行时返回 false；可指定文本模型覆盖 */
export async function startExtraction(
  episodeId: number,
  dramaId: number,
  target: ExtractTarget,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<boolean> {
  return startExtractorRun(episodeId, dramaId, target, EXTRACT_MESSAGES[target], opts)
}

/**
 * 单资产重新提取（Issue #32）：迭代规则时只想重跑一个人物（如彼得一世），
 * 不必整集重跑。调用方先清空该资产的提取字段，再用指名道姓的指令跑同一个提取 Agent——
 * save_dedup_* 的「只补空白」合并语义因此不用改（那是 Issue #15 的刻意设计）。
 */
export async function startSingleAssetExtraction(
  episodeId: number,
  dramaId: number,
  target: ExtractTarget,
  assetName: string,
  opts: { model?: string; configId?: number } = {},
): Promise<boolean> {
  const label = { characters: '角色', scenes: '场景', props: '道具' }[target]
  const message = `请只针对本集剧本中的${label}「${assetName}」重新提取信息并保存，不要处理其它${label}；`
    + `提取与去重规范以系统提示词与技能为准。该${label}的既有字段已被清空，请完整重写。`
  return startExtractorRun(episodeId, dramaId, target, message, opts)
}

/** 提取 Agent 的统一运行入口（整集提取与单资产重提取共用） */
async function startExtractorRun(
  episodeId: number,
  dramaId: number,
  target: ExtractTarget,
  message: string,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<boolean> {
  const kind = EXTRACT_TASK_KINDS[target]
  if (await findActiveTextTask(episodeId, kind)) return false

  const resolved = await resolveTextModel(opts)
  const taskId = await createTextTask({
    kind,
    episodeId,
    dramaId,
    prompt: message,
    provider: resolved.provider,
    model: resolved.model,
    configId: opts.configId ?? resolved.configId ?? undefined,
    retryOf: opts.retryOf,
  })

  logTaskStart('Extract', target, { episodeId, dramaId, model: opts.model || undefined, configId: opts.configId || undefined })
  ;(async () => {
    const agent = mastra.getAgent('extractor')
    if (!agent) throw new Error('提取 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    return runAgent(agent, [{ role: 'user', content: message }], {
      maxSteps: 20,
      requestContext,
      // 逐步打印 Agent 进展：调用了哪些工具、输出了什么
      onStepFinish: (step: any) => {
        const tools = (step?.toolCalls || [])
          .map((t: any) => t?.payload?.toolName)
          .filter(Boolean)
        logTaskProgress('Extract', `${target}-step`, {
          episodeId,
          tools: tools.length ? tools.join(',') : undefined,
          text: (step?.text || '').slice(0, 200) || undefined,
        })
      },
    }, createReasoningSink(taskId))
  })()
    .then(async (result) => {
      await finishTextTask(taskId, 'completed', { outputText: result?.text || '' })
      const toolNames = (result?.toolCalls || []).map(t => t?.payload?.toolName).filter(Boolean)
      logTaskSuccess('Extract', target, {
        episodeId,
        steps: result?.steps?.length,
        toolCalls: toolNames.join(',') || undefined,
        reply: (result?.text || '').slice(0, 300) || undefined,
      })
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : '提取失败'
      await finishTextTask(taskId, 'failed', { errorMsg: message })
      logTaskError('Extract', target, { episodeId, error: message })
    })
  return true
}

/** 查询某集三类资产的提取任务状态（未启动过的类型为 null） */
export async function getExtractionStatus(episodeId: number): Promise<Record<ExtractTarget, ExtractTask | null>> {
  const result = {} as Record<ExtractTarget, ExtractTask | null>
  for (const target of EXTRACT_TARGETS) {
    const row = await findLatestTextTask(episodeId, EXTRACT_TASK_KINDS[target])
    result[target] = row
      ? {
        status: textTaskOutcome(row.status),
        started_at: row.createdAt,
        finished_at: row.completedAt || undefined,
        error: row.errorMsg || undefined,
      }
      : null
  }
  return result
}
