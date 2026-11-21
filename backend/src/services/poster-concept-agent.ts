/**
 * Poster 构想的 harness 工具循环（Issue #128）。
 *
 * 旧实现是两次裸 callTextChat + 一次盲改（截断 8000 字），资产校验还在反馈环之外；
 * 现在模型在同一个会话里用 `submit_poster_concept` 提交完整三方案，校验工具返回
 * 接受/拒绝：拒绝带逐条中文问题（含槽位容量与换套提示），模型据此继续下一轮；
 * 接受即完成。轮次上限 8（用户确认），步数预算 24；失败分型
 * rounds_exhausted / steps_exhausted / no_submission，全部带已完成轮次与逐轮摘要。
 *
 * 校验链与旧实现逐字同源（poster-concept.ts 的 conceptSchema / normalizePosterLayerPlan /
 * validateComposition），本文件只负责会话与轮次，不另写校验规则。
 */
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { getModel } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { buildLanguageDirective } from '../agents/language.js'
import { runAgent } from '../agents/run.js'
import type { ReasoningSink } from '../agents/reasoning-sink.js'
import type { StageModel } from './ai-stages.js'
import type { ContentLanguage } from './app-settings.js'
import { patchTextTaskParams } from './text-task.js'
import {
  POSTER_CONCEPT_COUNT,
  POSTER_CONCEPT_VERSION,
  conceptSchema,
  extractJsonObject,
  normalizePosterLayerPlan,
  posterTextPrompt,
  shapeStoredLayerPlan,
  systemPrompt,
  validateComposition,
  type PosterComposition,
  type PosterConcept,
  type PosterConceptAsset,
  type PosterFrame,
  type PosterPlanContext,
} from './poster-concept.js'
import { logTaskProgress } from '../utils/task-logger.js'

/** 提交轮次上限（用户 2026-11-21 确认 = 8）：每次调用提交工具消耗一轮，拒收后模型继续修正。 */
export const POSTER_CONCEPT_MAX_ROUNDS = 8
/** 步数预算：8 轮提交 + 修正/正文纠偏余量。 */
export const POSTER_CONCEPT_MAX_STEPS = 24

export type PosterConceptFailureKind = 'rounds_exhausted' | 'steps_exhausted' | 'no_submission'

/** 任务失败：保留最后一次提交原文（没有提交则保留模型正文），便于任务详情排查。 */
export class PosterConceptAgentError extends Error {
  constructor(readonly kind: PosterConceptFailureKind, message: string, readonly raw: string) {
    super(message)
    this.name = 'PosterConceptAgentError'
  }
}

export interface PosterConceptRound {
  round: number
  outcome: 'rejected' | 'accepted'
  problems: string[]
}

/**
 * 校验模型提交（与旧 runPosterConcept 的校验链同源）：
 * 结构 → 逐方案 layer_plan 引擎校验（项目名/集号行服务端覆盖）→ 逐方案资产校验 →
 * 恰好三个方案全过 → 推荐项归一。返回逐条中文问题；全过时给出可直接落库的三方案。
 */
export function checkConceptSubmission(raw: unknown, planContext: PosterPlanContext, assets: PosterConceptAsset[]): {
  problems: string[]
  theme: string
  themeReason: string
  compositions: PosterComposition[]
} {
  const parsed = conceptSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      problems: [`JSON 结构不符：${parsed.error.issues.slice(0, 6).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}`],
      theme: '', themeReason: '', compositions: [],
    }
  }
  const problems: string[] = []
  const shaped = parsed.data.compositions.map(item => (item
    ? { ...item, layer_plan: shapeStoredLayerPlan(item.layer_plan) }
    : item)) as (PosterComposition | null)[]
  for (const composition of shaped) {
    if (!composition) continue
    const label = composition.id || composition.approach || '方案'
    const checked = normalizePosterLayerPlan(composition.layer_plan, planContext)
    problems.push(...checked.errors.map(error => `${label}：${error}`))
    // 项目名/集号由服务端写死，模型原文只用于容量判断，落库前统一覆盖
    if (checked.plan) composition.layer_plan = checked.plan
  }
  const compositions = shaped.filter((item): item is PosterComposition => Boolean(item)).slice(0, POSTER_CONCEPT_COUNT)
  const validated: PosterComposition[] = []
  for (const composition of compositions) {
    const result = validateComposition(composition, assets)
    if (result.composition) validated.push(result.composition)
    else problems.push(`${composition.id || composition.approach}：${result.errors.join('；')}`)
  }
  if (validated.length !== POSTER_CONCEPT_COUNT) {
    problems.push(`三个构图方案没有全部通过校验（合格 ${validated.length}/${POSTER_CONCEPT_COUNT}）：compositions 必须是三个且逐个合格`)
  }
  // 推荐只能一个；模型没标时按第一个兜底，避免前端出现三个“推荐”
  const recommendedIndex = validated.findIndex(item => item.recommended)
  validated.forEach((item, index) => { item.recommended = index === (recommendedIndex < 0 ? 0 : recommendedIndex) })
  return { problems, theme: parsed.data.theme, themeReason: parsed.data.theme_reason, compositions: validated }
}

/** 逐轮摘要：所有失败路径的 error_msg 都带它（#124 教训：笼统文案导致误诊）。 */
function roundsSummary(rounds: PosterConceptRound[]): string {
  if (!rounds.length) return '尚未提交过'
  return rounds.map(entry => `第${entry.round}轮${entry.outcome === 'accepted' ? '接受' : '拒收'}${entry.problems.length ? `：${entry.problems.slice(0, 4).join('；')}${entry.problems.length > 4 ? '；…' : ''}` : ''}`).join(' | ')
}

const TOOL_PROTOCOL = [
  '# 提交协议（必须遵守）',
  `1. 构思完成后调用 submit_poster_concept 提交**完整**构想 JSON（theme / theme_reason / compositions 三方案）。不要把 JSON 写在正文里——正文不会被保存。`,
  `2. 工具返回 accepted=false 时，逐条阅读 problems 并修正，然后再次调用 submit_poster_concept 提交修正后的**完整三方案**（不是只交改动部分）。每次提交消耗一轮，共 ${POSTER_CONCEPT_MAX_ROUNDS} 轮。`,
  '3. 工具返回 accepted=true 后立即结束回答，不要再调用任何工具。',
  '4. 只能使用模型原生工具调用通道；严禁在正文里模拟工具调用。',
].join('\n')

export interface PosterConceptAgentArgs {
  taskId: number
  episodeId: number
  dramaId: number
  stage: StageModel
  lang: ContentLanguage
  frame: PosterFrame
  planContext: PosterPlanContext
  assets: PosterConceptAsset[]
  userPrompt: string
  signal?: AbortSignal
  sink?: ReasoningSink
}

/**
 * 跑一次构想会话直到：提交被接受 / 轮次或步数耗尽 / 模型始终不提交（抛 PosterConceptAgentError）/
 * 外部取消（signal 触发，错误原样上抛由调用方按取消处理）。
 */
export async function runPosterConceptAgent(args: PosterConceptAgentArgs): Promise<PosterConcept> {
  const rounds: PosterConceptRound[] = []
  const session: { accepted: { theme: string; themeReason: string; compositions: PosterComposition[] } | null } = { accepted: null }
  let lastSubmission = ''
  let exhausted = false

  const persistRounds = async () => {
    await patchTextTaskParams(args.taskId, { concept_rounds: rounds })
  }

  const submit = createTool({
    id: 'submit_poster_concept',
    description: '提交完整的 Poster 构想（theme/theme_reason/compositions 三方案）并运行服务端校验。'
      + '返回 accepted=true 表示通过、任务完成；accepted=false 时按 problems 逐条修正后重新提交完整三方案。'
      + 'compositions 每项字段：id, approach, rationale, recommended, assets[{kind,id,name,role_in_poster,reason}], '
      + 'image_prompt, text_description, copy{title,subtitle,era,place,notes[]}, layer_plan{text_layout,items[{role,fields}]}。',
    // 入参刻意宽松：全部校验收进 execute，保证不合格一律走中文 {accepted:false, problems} 并计轮
    // （Mastra 框架级入参校验失败是英文文案且不占轮次）。
    inputSchema: z.object({
      theme: z.string().default(''),
      theme_reason: z.string().default(''),
      compositions: z.array(z.unknown()).default([]),
    }),
    execute: async (input) => {
      if (session.accepted) return { accepted: true, round: rounds.length, next: '构想已被接受，请直接结束回答' }
      if (exhausted) return { accepted: false, final: `${POSTER_CONCEPT_MAX_ROUNDS} 轮已用完，任务判失败；请停止调用工具` }
      lastSubmission = JSON.stringify(input)
      const round = rounds.length + 1
      const checked = checkConceptSubmission(input, args.planContext, args.assets)
      if (checked.problems.length) {
        rounds.push({ round, outcome: 'rejected', problems: checked.problems })
        exhausted = round >= POSTER_CONCEPT_MAX_ROUNDS
        await persistRounds()
        logTaskProgress('PosterConcept', 'round-rejected', { taskId: args.taskId, round, problems: checked.problems.length })
        return {
          accepted: false,
          round,
          rounds_left: Math.max(0, POSTER_CONCEPT_MAX_ROUNDS - round),
          problems: checked.problems,
          ...(exhausted
            ? { final: `${POSTER_CONCEPT_MAX_ROUNDS} 轮已用完，任务判失败并交给人工；请停止调用工具` }
            : { next: '逐条修正上面的问题后，重新调用 submit_poster_concept 提交完整三方案' }),
        }
      }
      session.accepted = { theme: checked.theme, themeReason: checked.themeReason, compositions: checked.compositions }
      rounds.push({ round, outcome: 'accepted', problems: [] })
      await persistRounds()
      logTaskProgress('PosterConcept', 'round-accepted', { taskId: args.taskId, round })
      return { accepted: true, round, next: '构想已被接受，任务完成；请直接结束回答' }
    },
  })

  const model = await getModel(undefined, args.stage.model, args.stage.configId ?? undefined)
  const agent = new Agent({
    id: 'poster_concept',
    name: 'Poster 构想',
    instructions: [systemPrompt(args.lang, posterTextPrompt(args.frame)), TOOL_PROTOCOL, buildLanguageDirective(args.lang)]
      .filter(Boolean).join('\n\n'),
    model,
    tools: { submitPosterConcept: submit },
  })
  const requestContext = buildAgentRequestContext({
    episodeId: args.episodeId,
    dramaId: args.dramaId,
    textTaskId: args.taskId,
    modelOverride: args.stage.model,
    textConfigId: args.stage.configId ?? undefined,
    language: args.lang,
  })

  // 接受/轮次耗尽后中止会话，防止模型继续提交；外部取消走同一 signal 语义。
  const controller = new AbortController()
  const signal = args.signal ? AbortSignal.any([args.signal, controller.signal]) : controller.signal
  const ask = { role: 'user' as const, content: args.userPrompt }
  let stepsUsed = 0
  let text = ''
  const runOptions = {
    requestContext,
    abortSignal: signal,
    onStepFinish: async () => {
      stepsUsed += 1
      if (session.accepted || exhausted) controller.abort()
    },
  }
  try {
    const result = await runAgent(agent, [ask], { ...runOptions, maxSteps: POSTER_CONCEPT_MAX_STEPS }, args.sink)
    text = result.text || ''
  } catch (err) {
    if (session.accepted) { /* 接受后的中止不是错误 */ }
    else if (exhausted) { /* 轮次耗尽后的中止按 rounds_exhausted 收尾 */ }
    else if (args.signal?.aborted) throw err
    else throw err
  }
  // 正文纠偏一次（转场 Agent 先例，transition-agent.ts）：DeepSeek 倾向把 JSON 写正文不调工具。
  // 没有任何提交且正文里有 JSON 时，把正文回给它、要求用工具提交一次（不占提交轮次）。
  if (!session.accepted && !exhausted && !args.signal?.aborted && rounds.length === 0 && text.trim()) {
    let hasJson = false
    try { hasJson = Boolean(extractJsonObject(text)) } catch { /* 正文没有 JSON 就不纠偏 */ }
    if (hasJson) {
      try {
        const retry = await runAgent(agent, [
          ask,
          { role: 'assistant' as const, content: text },
          { role: 'user' as const, content: '你只在正文里写了构想 JSON，没有调用 submit_poster_concept，构想没有保存。请现在调用 submit_poster_concept 提交这份完整构想（三个方案），不要再输出正文。' },
        ], { ...runOptions, maxSteps: 4 }, args.sink)
        text = retry.text || text
      } catch (err) {
        if (!session.accepted && !exhausted && args.signal?.aborted) throw err
        if (!session.accepted && !exhausted && !controller.signal.aborted) throw err
      }
    }
  }

  if (session.accepted) {
    const chosen = session.accepted
    return {
      version: POSTER_CONCEPT_VERSION,
      theme: chosen.theme,
      theme_reason: chosen.themeReason,
      compositions: chosen.compositions,
      selected_composition_id: chosen.compositions.find(item => item.recommended)?.id || chosen.compositions[0].id,
      model: args.stage.model,
      config_id: args.stage.configId,
      generated_at: '',
      script_segments_used: 0,
    }
  }
  const summary = roundsSummary(rounds)
  if (exhausted) {
    throw new PosterConceptAgentError('rounds_exhausted',
      `Poster 构想 ${POSTER_CONCEPT_MAX_ROUNDS} 轮提交均未通过校验（${summary}）`, lastSubmission || text)
  }
  if (rounds.length === 0) {
    throw new PosterConceptAgentError('no_submission',
      `模型没有调用 submit_poster_concept 提交构想（${summary}）；正文已保留在任务详情`, text)
  }
  throw new PosterConceptAgentError('steps_exhausted',
    `Poster 构想步数预算（${POSTER_CONCEPT_MAX_STEPS} 步，已用 ${stepsUsed}）用完仍未通过校验（${summary}）`, lastSubmission || text)
}
