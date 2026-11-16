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
import { narrationCharCount } from '../narration.js'
import { scriptParagraphs } from '../narration-first.js'
import { splitSentences } from '../subtitle.js'
import { guardStageOutput, type RemovedSpan } from './source-filter.js'
import {
  BridgeContractError,
  composeBridged,
  paragraphsAndBoundaries,
  parseBlocks,
  validateBridgeDecisions,
  SENTENCE_CHAR_LIMIT,
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
  /** 产出稿的自然段数（= 逻辑组数，#109） */
  paragraphs: number
  /** 输入稿（自动过滤后的正文）的自然段数：产出分段被拆碎/合并时与上面对不上 */
  paragraphs_source: number
  /** 超过单句上限的句子（自然段不限长度，句子才是 80 字硬上限） */
  over_limit_sentences: OverLimitSentence[]
  warnings: string[]
  post_filter: { removed: RemovedSpan[] }
  ai_exclusions: AiExcludedSpan[]
  adjusted_baseline_chars: number
}

export interface OverLimitSentence {
  /** 1 起的自然段号 */
  paragraph: number
  /** 段内 1 起的句号 */
  sentence: number
  chars: number
  /** 句首摘录（≤20 字），方便在长篇里定位 */
  excerpt: string
}

export interface AiExcludedSpan {
  text: string
  category: 'source' | 'license' | 'link' | 'contributor' | 'bibliography' | 'editorial' | 'not_narration'
  reason: string
  start: number
  end: number
}

/** Validate model-reported exclusions against the frozen input; never edit the input. */
export function parseFidelityOutput(reply: string, input: string): { content: string; exclusions: AiExcludedSpan[] } {
  const parsed: unknown = JSON.parse(stripFence(reply))
  if (!parsed || typeof parsed !== 'object' || !('content' in parsed) || typeof parsed.content !== 'string' || !('exclusions' in parsed) || !Array.isArray(parsed.exclusions)) throw new Error('忠实改写返回的正文或剔除清单格式不合法')
  const categories: Record<string, true> = { source: true, license: true, link: true, contributor: true, bibliography: true, editorial: true, not_narration: true }
  const exclusions: AiExcludedSpan[] = []
  for (const entry of parsed.exclusions) {
    if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || !entry.text.trim() || typeof entry.reason !== 'string' || !entry.reason.trim() || typeof entry.category !== 'string' || !Object.hasOwn(categories, entry.category)) throw new Error('非旁白剔除清单格式或类别不合法')
    let start = input.indexOf(entry.text)
    while (start >= 0 && exclusions.some(span => start < span.end && start + entry.text.length > span.start)) start = input.indexOf(entry.text, start + 1)
    if (start < 0 || parsed.content.includes(entry.text)) throw new Error('非旁白剔除片段无法在输入中唯一定位或仍在输出中')
    const category = entry.category as AiExcludedSpan['category'] // membership was validated above
    exclusions.push({ text: entry.text, reason: entry.reason, category, start, end: start + entry.text.length })
  }
  return { content: parsed.content, exclusions }
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
  '- 只返回 JSON：{"content":"整理后的旁白稿正文","exclusions":[{"text":"输入中逐字复制的被剔除片段","category":"source|license|link|contributor|bibliography|editorial|not_narration","reason":"非旁白理由"}]}。不得把清单写进正文；没有剔除时 exclusions 为 []。',
  '- 输入已经由系统自动剥离来源、许可证、永久链接、贡献者与使用说明等非旁白材料；',
  '  **不要把这类内容写回正文**，也不要补写输入里没有的事实。',
  '- 旁白稿必须剔除出处块、版权许可、URL/永久链接、贡献者或编辑历史、书目和引用尾注（含 ISBN、出版社）、模板或编辑说明以及不作为朗读稿的声明。',
  '- 正文中的可朗读归属表述（如「据《异域录》记载」）必须保留。',
  '- 分段保持原作者的自然段（一个自然段 = 一个意思，下游分镜按段做画面规划），不要把长段拆成碎片。',
  '- 自然段长度不限；但**每一句**必须不超过 ' + SENTENCE_CHAR_LIMIT + ' 字（每镜配音的单段上限）：超长句只在逗号层级改标点断句，不增删内容。',
].join('\n')

const fidelity: RewriteStageSpec = {
  key: 'fidelity',
  label: '忠实改写',
  revision: 'fidelity.v3',
  aiStage: 'script_rewriter',
  async run(ctx) {
    const lang = await getContentLanguage()
    // 与 Agent 路径逐字相同的技能注入（script-rewriter + documentary/documentary-script）
    const skills = await loadAgentSkills('script_rewriter', lang, { projectType: 'documentary' })
    const systemPrompt = `${skills}${FIDELITY_OUTPUT_CONTRACT}`
    const attempt = async (userContent: string) => {
      const { text } = await callTextChat(ctx.stageModel, userContent, {
        systemPrompt,
        temperature: ctx.stageModel.temperature ?? 0.2,
        maxTokens: MAX_TOKENS,
        timeoutMs: STAGE_TIMEOUT_MS,
      })
      const parsed = parseFidelityOutput(text, ctx.preparedText)
      if (!parsed.content.trim()) throw new Error('忠实改写阶段没有返回正文')
      // 二次防漏：模型即使抄回来源/许可/链接，也不会进入下游（验收 17）
      const guarded = guardStageOutput(parsed.content)
      if (!guarded.text.trim()) throw new Error('忠实改写阶段的产出里没有可朗读的正文')
      return { text, parsed, guarded }
    }
    const original = `【原始内容】\n${ctx.preparedText}`
    const first = await attempt(original)
    try {
      // 契约违例 = 阶段失败：不产生正式版本，下游不执行，最终稿不被采用。
      const report = evaluateFidelity(ctx.preparedText, first.guarded.text, first.guarded.removed, first.parsed.exclusions)
      return { content: first.guarded.text, report }
    } catch (err) {
      if (!(err instanceof FidelityContractError)) throw err
      // #109：段落不再限长后，最常见的违例是原文的长句没断开。把逐条违例（超长句给全文）回给模型纠正一次；
      // 仍不合格就判阶段失败，诊断完整留在任务错误信息里，不静默截断或改写。
      const longOnes = longSentences(first.guarded.text)
      const retry = await attempt([
        original,
        '',
        '# 你上一次的输出',
        first.text.trim(),
        '',
        '# 保真契约没有通过，请逐条改正后重新输出完整 JSON（只改标点断句，不增删内容，不改动其它段落）',
        `- ${err.message}`,
        ...longOnes.map(item => `- 第 ${item.paragraph} 段第 ${item.sentence} 句 ${item.chars} 字（上限 ${SENTENCE_CHAR_LIMIT}）：${item.text}`),
      ].join('\n'))
      const report = evaluateFidelity(ctx.preparedText, retry.guarded.text, retry.guarded.removed, retry.parsed.exclusions)
      return { content: retry.guarded.text, report }
    }
  },
}

/** 忠实改写的硬契约违例（±5% 与每句 80 字）：阶段判失败，绝不产生正式版本 */
export class FidelityContractError extends Error {
  constructor(message: string, public readonly report: FidelityReport) {
    super(message)
    this.name = 'FidelityContractError'
  }
}

/** 超过单句上限的句子（含全文，纠正提示要把整句给模型）；切点与计数口径见 `evaluateFidelity` */
function longSentences(content: string): Array<{ paragraph: number; sentence: number; chars: number; text: string }> {
  const found: Array<{ paragraph: number; sentence: number; chars: number; text: string }> = []
  scriptParagraphs(content).forEach((paragraph, paragraphIndex) => {
    splitSentences(paragraph).forEach((sentence, sentenceIndex) => {
      const chars = narrationCharCount(sentence)
      if (chars > SENTENCE_CHAR_LIMIT) found.push({ paragraph: paragraphIndex + 1, sentence: sentenceIndex + 1, chars, text: sentence.trim() })
    })
  })
  return found
}

/**
 * 保真计量：基线是**自动过滤后的正文**，两侧都去掉 `【节拍】` 标记与空白后再比，
 * 节拍标记只是分段锚点，不是朗读内容，算进去会让短稿出现假超标。
 * 超出 ±5% 或任一句超过 80 字 → 抛 `FidelityContractError`。
 *
 * 口径（#109）：自然段不限长度——一个自然段就是一个逻辑组，拆碎会让相邻镜头来回改画面；
 * 硬上限落在**句子**上，切点与旁白骨架一致（`splitSentences`：`。！？；!?;` 及段尾），
 * 字数用骨架同一把尺（`narrationCharCount`），所以通过这里的句子一定能成为一镜。
 */
export function evaluateFidelity(preparedText: string, content: string, removed: RemovedSpan[] = [], exclusions: AiExcludedSpan[] = []): FidelityReport {
  const narrationChars = (text: string) => text.replace(BEAT_MARKER, '').replace(/[\s\u3000]/g, '').length
  const baseline = narrationChars(preparedText)
  const excluded = exclusions.reduce((sum, span) => sum + narrationChars(span.text), 0)
  const adjustedBaseline = baseline - excluded
  const outputChars = narrationChars(content)
  const deltaRatio = baseline ? (outputChars - baseline) / baseline : 0
  const paragraphsSource = scriptParagraphs(preparedText).length
  const longOnes = longSentences(content)
  const overLimit: OverLimitSentence[] = longOnes.map(({ text, ...item }) => ({
    ...item,
    excerpt: text.replace(/[\s\u3000]/g, '').slice(0, 20),
  }))
  const paragraphs = scriptParagraphs(content)
  const withinTolerance = outputChars <= baseline * (1 + FIDELITY_TOLERANCE) && outputChars >= adjustedBaseline * (1 - FIDELITY_TOLERANCE)
  const warnings: string[] = []
  if (removed.length) warnings.push(`产出里带回了 ${removed.length} 处非旁白内容，已自动剥离（见过滤明细）`)

  const report: FidelityReport = {
    baseline_chars: baseline,
    output_chars: outputChars,
    delta_ratio: Number(deltaRatio.toFixed(4)),
    within_tolerance: withinTolerance,
    paragraphs: paragraphs.length,
    paragraphs_source: paragraphsSource,
    over_limit_sentences: overLimit,
    warnings,
    ai_exclusions: exclusions,
    adjusted_baseline_chars: adjustedBaseline,
    post_filter: { removed },
  }
  const violations: string[] = []
  if (!withinTolerance) {
    violations.push(`内容量相对过滤后正文变化 ${(deltaRatio * 100).toFixed(1)}%（${baseline} → ${outputChars} 字），超过 ±${FIDELITY_TOLERANCE * 100}%；缩短部分未由可定位的非旁白剔除清单充分解释`)
  }
  for (const sentence of overLimit) {
    violations.push(`第 ${sentence.paragraph} 段第 ${sentence.sentence} 句 ${sentence.chars} 字，超过单句 ${SENTENCE_CHAR_LIMIT} 字上限`)
  }
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
  revision: 'bridge.v2',
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
