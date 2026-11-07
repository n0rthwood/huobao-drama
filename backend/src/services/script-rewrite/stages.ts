/**
 * 分阶段改写的静态阶段注册表（Issue #70 §1）。
 *
 * 阶段是**代码发布**出来的：有稳定 key、固定顺序、各自的输入/提示词/输出校验与阶段定义修订号。
 * 首版不做运行时插件、数据库可配置工作流或任意依赖图——未来加第三、第四个润色阶段，
 * 只需要在这张表后面再追加一项，旧运行冻结的 `stage_plan` 不受影响。
 *
 * 两个阶段是**两次独立的真实模型调用**：
 * - `fidelity` 沿用现有纪录片保真改写提示词（技能注入与 Agent 路径逐字相同），输入是
 *   自动过滤后的正文，不是含来源/许可的原始资料；
 * - `bridge` 同时读冻结原文与忠实改写稿，逐边界判断该不该补一句承接；正文由服务端按
 *   申报的桥句插入，模型改不动前驱正文。
 */
import { loadAgentSkills, loadSkillDoc } from '../../agents/skills.js'
import { getContentLanguage } from '../app-settings.js'
import { callTextChat } from '../vision-chat.js'
import { logTaskProgress } from '../../utils/task-logger.js'
import type { AiStage, StageModel } from '../ai-stages.js'
import { guardStageOutput, type RemovedSpan } from './source-filter.js'
import {
  BridgeContractError,
  composeBridged,
  paragraphsAndBoundaries,
  parseBlocks,
  validateBridgeDecisions,
  PARAGRAPH_CHAR_LIMIT,
  type BridgeReport,
} from './bridge.js'

const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16_384)
const STAGE_TIMEOUT_MS = 15 * 60_000
/** 忠实改写的 ±5% 内容量基线容差（以自动过滤后的正文为分母） */
export const FIDELITY_TOLERANCE = 0.05
/** 叙事节拍标记（【开场】…）：分段锚点，不是朗读内容，两侧计量都要先去掉 */
const BEAT_MARKER = /【[^】\n]*】/g

export type RewriteStageKey = 'fidelity' | 'bridge'

export interface StageRunContext {
  /** 本轮冻结的原始资料全文（桥句阶段核对事实边界用；忠实阶段不读它） */
  rawSource: string
  /** 自动过滤后的旁白正文（第一个 AI 阶段的前驱） */
  preparedText: string
  /** 本阶段的直接前驱文本 */
  predecessorText: string
  stageModel: StageModel
  taskId: number | null
}

export interface StageRunResult {
  content: string
  /** 结构化阶段报告，原样 JSON 落进版本行（保真计量 / 逐边界桥句决策 / 跳过说明） */
  report: unknown
}

export interface RewriteStageSpec {
  key: RewriteStageKey
  label: string
  /** 阶段定义修订号：提示词/校验规则改变时手工 +1，旧运行按自己冻结的值解释 */
  revision: string
  aiStage: AiStage
  run(ctx: StageRunContext): Promise<StageRunResult>
}

export interface FidelityReport {
  baseline_chars: number
  output_chars: number
  delta_ratio: number
  within_tolerance: boolean
  paragraphs: number
  over_limit_paragraphs: Array<{ index: number; chars: number }>
  warnings: string[]
  post_filter: { removed: RemovedSpan[] }
}

/** 模型爱把正文包进 ```；统一剥掉围栏，其它字节不动 */
function stripFence(text: string): string {
  const trimmed = (text || '').trim()
  const fenced = /^```(?:[a-z]*)\n([\s\S]*?)\n?```$/i.exec(trimmed)
  return (fenced ? fenced[1]! : trimmed).trim()
}

const FIDELITY_OUTPUT_CONTRACT = [
  '',
  '# 本次输出要求（覆盖技能里关于工具调用的步骤说明）',
  '- 你**不要**调用任何工具，也不要解释、不要前言、不要 Markdown 代码块。',
  '- 直接输出整理后的旁白稿正文本身；它会被逐字保存为本阶段的不可变版本。',
  '- 输入已经由系统自动剥离来源、许可证、永久链接、贡献者与使用说明等非旁白材料；',
  '  **不要把这类内容写回正文**，也不要补写输入里没有的事实。',
].join('\n')

const fidelity: RewriteStageSpec = {
  key: 'fidelity',
  label: '忠实改写',
  revision: 'fidelity.v1',
  aiStage: 'script_rewriter',
  async run(ctx) {
    const lang = await getContentLanguage()
    // 与 Agent 路径逐字相同的技能注入（script-rewriter + documentary/documentary-script）
    const skills = await loadAgentSkills('script_rewriter', lang, { projectType: 'documentary' })
    const systemPrompt = `${skills}${FIDELITY_OUTPUT_CONTRACT}`
    const { text } = await callTextChat(ctx.stageModel, `【原始内容】\n${ctx.preparedText}`, {
      systemPrompt,
      temperature: ctx.stageModel.temperature ?? 0.2,
      maxTokens: MAX_TOKENS,
      timeoutMs: STAGE_TIMEOUT_MS,
    })
    const raw = stripFence(text)
    if (!raw) throw new Error('忠实改写阶段没有返回正文')
    // 二次防漏：模型即使抄回来源/许可/链接，也不会进入下游（验收 17）
    const guarded = guardStageOutput(raw)
    const content = guarded.text
    if (!content.trim()) throw new Error('忠实改写阶段的产出里没有可朗读的正文')

    // 契约违例 = 阶段失败：不产生正式版本，下游不执行，最终稿不被采用。
    // 诊断仍然完整地留在任务错误信息里，供重试或跳过时查看。
    const report = evaluateFidelity(ctx.preparedText, content, guarded.removed)
    return { content, report }
  },
}

/** 忠实改写的硬契约违例（±5% 与每段 80 字）：阶段判失败，绝不产生正式版本 */
export class FidelityContractError extends Error {
  constructor(message: string, public readonly report: FidelityReport) {
    super(message)
    this.name = 'FidelityContractError'
  }
}

/**
 * 保真计量：基线是**自动过滤后的正文**，两侧都去掉 `【节拍】` 标记与空白后再比，
 * 节拍标记只是分段锚点，不是朗读内容，算进去会让短稿出现假超标。
 * 超出 ±5% 或任一段超过 80 字 → 抛 `FidelityContractError`。
 */
export function evaluateFidelity(preparedText: string, content: string, removed: RemovedSpan[] = []): FidelityReport {
  const narrationChars = (text: string) => text.replace(BEAT_MARKER, '').replace(/[\s\u3000]/g, '').length
  const baseline = narrationChars(preparedText)
  const outputChars = narrationChars(content)
  const deltaRatio = baseline ? (outputChars - baseline) / baseline : 0
  const blocks = parseBlocks(content)
  const { paragraphs } = paragraphsAndBoundaries(content, blocks)
  const overLimit = paragraphs
    .map((p, index) => ({ index: index + 1, chars: narrationChars(p.text) }))
    .filter(p => p.chars > PARAGRAPH_CHAR_LIMIT)
  const withinTolerance = Math.abs(deltaRatio) <= FIDELITY_TOLERANCE
  const warnings: string[] = []
  if (removed.length) warnings.push(`产出里带回了 ${removed.length} 处非旁白内容，已自动剥离（见过滤明细）`)

  const report: FidelityReport = {
    baseline_chars: baseline,
    output_chars: outputChars,
    delta_ratio: Number(deltaRatio.toFixed(4)),
    within_tolerance: withinTolerance,
    paragraphs: paragraphs.length,
    over_limit_paragraphs: overLimit,
    warnings,
    post_filter: { removed },
  }
  const violations: string[] = []
  if (!withinTolerance) {
    violations.push(`内容量相对过滤后正文变化 ${(deltaRatio * 100).toFixed(1)}%（${baseline} → ${outputChars} 字），超过 ±${FIDELITY_TOLERANCE * 100}%`)
  }
  for (const p of overLimit) violations.push(`第 ${p.index} 段 ${p.chars} 字，超过每段 ${PARAGRAPH_CHAR_LIMIT} 字上限`)
  if (violations.length) throw new FidelityContractError(`忠实改写不符合保真契约：${violations.join('；')}`, report)
  return report
}

function bridgeUserPrompt(ctx: StageRunContext, paragraphs: Array<{ id: string; text: string }>, boundaries: Array<{ boundary_id: string; left_paragraph: string; right_paragraph: string }>): string {
  return [
    '# 本轮冻结的原始资料（只用于核对事实边界，不得从中引入新事实，也不得把其中的来源/许可/链接写进桥句）',
    ctx.rawSource,
    '',
    '# 阶段 1 的忠实改写稿（正文段落，编号在本版本内稳定）',
    ...paragraphs.map(p => `${p.id}：${p.text}`),
    '',
    `# 需要逐一判断的 ${boundaries.length} 个相邻边界`,
    ...boundaries.map(b => `${b.boundary_id}：${b.left_paragraph} → ${b.right_paragraph}`),
    '',
    '只返回 JSON：{"boundaries":[{"boundary_id":"","left_paragraph":"","right_paragraph":"","relation":"","decision":"no_bridge|inserted|needed_but_unsafe","reason":"","bridge_text":null,"placement":null,"shot_attribution":null}]}',
  ].join('\n')
}

const bridge: RewriteStageSpec = {
  key: 'bridge',
  label: '桥句润色',
  revision: 'bridge.v1',
  aiStage: 'script_bridge',
  async run(ctx) {
    const blocks = parseBlocks(ctx.predecessorText)
    const { paragraphs, boundaries } = paragraphsAndBoundaries(ctx.predecessorText, blocks)
    if (!boundaries.length) {
      // 只有一个正文段落：没有相邻边界可审，照原样落版本并说明，不发无意义的请求
      const report: BridgeReport = {
        decisions: [], boundary_count: 0, inserted_count: 0, needed_but_unsafe_count: 0,
        warnings: ['前驱只有一个正文段落，没有相邻边界需要审校'],
      }
      return { content: ctx.predecessorText, report }
    }

    const lang = await getContentLanguage()
    const systemPrompt = await loadSkillDoc('documentary/documentary-bridge', lang)
    if (!systemPrompt) throw new Error('桥句润色技能（documentary/documentary-bridge）缺失，无法执行该阶段')
    const userPrompt = bridgeUserPrompt(ctx, paragraphs, boundaries)

    let reply = ''
    let lastError: Error | null = null
    // 一次结构修复机会：把具体违规回喂给模型；仍不合格就判阶段失败，不产生有效版本
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = attempt === 0
        ? userPrompt
        : `${userPrompt}\n\n# 上一次输出不合格，请修正后重新输出完整 JSON\n${lastError?.message ?? ''}\n\n${reply.slice(0, 4000)}`
      const result = await callTextChat(ctx.stageModel, content, {
        systemPrompt,
        temperature: ctx.stageModel.temperature ?? 0.2,
        maxTokens: MAX_TOKENS,
        timeoutMs: STAGE_TIMEOUT_MS,
      })
      reply = result.text || ''
      try {
        const parsed = JSON.parse(stripJsonFence(reply))
        const report = validateBridgeDecisions(paragraphs, boundaries, parsed)
        const composed = composeBridged(ctx.predecessorText, paragraphs, report.decisions)
        return { content: composed, report }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!(lastError instanceof BridgeContractError) && !(lastError instanceof SyntaxError)) throw lastError
        logTaskProgress('ScriptRewrite', 'bridge-retry', { taskId: ctx.taskId, attempt, error: lastError.message })
      }
    }
    throw new Error(`桥句阶段的逐边界报告不符合契约：${lastError?.message ?? '未知原因'}`)
  },
}

/** ```json 围栏 / 前后解释文字里取出第一个 JSON 对象 */
function stripJsonFence(text: string): string {
  const body = (text || '').replace(/```[a-z]*\s*|```/gi, '').trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

/** 静态阶段注册表：顺序就是执行顺序 */
export const REWRITE_STAGES: RewriteStageSpec[] = [fidelity, bridge]
