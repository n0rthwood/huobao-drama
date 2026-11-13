/**
 * 地图需求的充分性判断（Issue #84）
 *
 * 判的是**语义是否足以唯一确定一张图**，不是「字段填没填」。
 * 「时代＝古代」「地域＝中国」「用途＝地图」都非空，但谁都画不出来：模型要把这类值
 * 标成 ambiguous，程序照样阻塞。反过来，「殷墟车马坑」隐含商代晚期 + 安阳 + 遗址位置图，
 * 模型可以补，但必须逐条给依据与置信度，落在 `brief.inferred` 里让人看见。
 *
 * 三条硬规则：
 * 1. 低置信度推断**不算补上**：宁可阻塞让人确认，也不让猜测以「已研究」的姿态进入底图；
 * 2. 模型调用失败 / 回复不成形 **不等于通过**：阻塞并说明怎么解决（重试、换模型或人工补齐）；
 * 3. 不写任何关键词/正则特例（没有「运河」「殷墟」白名单），判断全部来自模型的结构化结论。
 */
import { resolveStageModel } from '../../services/ai-stages.js'
import { callTextChat } from '../../services/vision-chat.js'
import { parseJsonReply } from './json-reply.js'
import { logTaskWarn } from '../../utils/task-logger.js'
import { MapStageExhaustedError } from './agent-loop.js'
import { MAP_MAX_STAGE_ROUNDS } from './types.js'
import type { MapBrief, MapBriefInference, MapWorkflowIssue } from './types.js'

const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS) || 32768
const TEXT_TIMEOUT_MS = 180_000

/** 必须语义明确才能开工的四个维度 */
const REQUIRED_FIELDS = ['subject', 'era', 'location', 'purpose'] as const
type RequiredField = typeof REQUIRED_FIELDS[number]

const FIELD_LABEL: Record<RequiredField, string> = {
  subject: '地图对象',
  era: '时代',
  location: '地域范围',
  purpose: '用途',
}

/** 缺这一项为什么画不出来——直接显示给用户，不写「参数缺失」这种废话 */
const FIELD_WHY: Record<RequiredField, string> = {
  subject: '不知道要画什么对象，无法确定地图上该出现哪些地点与线路。',
  era: '同一地名在不同时代的位置、河道与疆界可能完全不同，没有明确时代就只能猜。',
  location: '没有明确的地域范围就无法确定底图的经纬度范围（bbox），画出来的可能是整个东亚或一个街区。',
  purpose: '用途决定详略与取舍（路线示意图、遗址位置图、战役态势图的画法不同）。',
}

const SYSTEM = `你在审核一张历史地图的需求，判断它是否**足以唯一确定一张图**。审两件事：

A. 已填的值是否够明确。填了不等于够：
   - 「古代」「近代」这种跨越多个形制时期的说法 → 列进 ambiguous；
   - 「中国」「华北」这种与对象实际范围差一个数量级的地域 → 列进 ambiguous；
   - 「地图」「展示」这种没有说明画法取舍的用途 → 列进 ambiguous。
   能唯一确定的（如「商代晚期」「河南安阳小屯一带」「遗址位置图」）不要列。
B. 空着的值能否由对象本身唯一推出。只有唯一指向时才补：
   例「殷墟车马坑」→ 时代：商代晚期；地域：河南安阳小屯一带；用途：遗址位置图。
   对象横跨多个时代且形态不同（河道改道、城址迁移等）→ 不要补，列进 missing，
   写明为什么必须由人确定，并给出可选项提示。

不确定就给 low 置信度，不要把猜测写成考证结论。配色、是否标注现代地名等次要细节不要列进 missing/ambiguous，放 notes。

只返回 JSON（四个键都要有，没有内容就给空数组）：
{"inferred":[{"field":"era","value":"商代晚期（约前13—前11世纪）","basis":"殷墟是商代晚期都城遗址","confidence":"high"}],
"ambiguous":[{"field":"era","reason":"「古代」跨越的时期里河道与疆界差别很大","hint":"请指明具体朝代或世纪"}],
"missing":[{"field":"era","reason":"该河段在元、明、清三代多次改道","hint":"请指明元代 / 明代 / 清末其中之一"}],
"notes":["次要的不确定之处"]}`

function briefText(brief: MapBrief): string {
  return [
    `地图对象（subject）：${brief.subject || '（空）'}`,
    `时代（era）：${brief.era || '（空）'}`,
    `地域（location）：${brief.location || '（空）'}`,
    `用途（purpose）：${brief.purpose || '（空）'}`,
    `详略：${brief.detail_level}；示意图模式：${brief.schematic ? '开启' : '关闭'}；底图方式：${brief.base_mode}`,
    brief.notes ? `补充说明：${brief.notes}` : '',
  ].filter(Boolean).join('\n')
}

/** 对某个字段的否决：缺失或语义不够明确 */
export interface BriefGap {
  field: RequiredField
  reason: string
  hint: string
}

/** 模型给出的结构化结论（已校验成形） */
export interface BriefVerdict {
  inferred: MapBriefInference[]
  ambiguous: BriefGap[]
  missing: BriefGap[]
  notes: string[]
}

const CONFIDENCES = ['high', 'medium', 'low'] as const

/** 否决条目列表；**任何一条不成形就整份作废**（返回 null），不做静默过滤 */
function gapList(raw: unknown): BriefGap[] | null {
  if (!Array.isArray(raw)) return null
  const out: BriefGap[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const field = 'field' in item ? String(item.field) : ''
    if (!(REQUIRED_FIELDS as readonly string[]).includes(field)) return null
    out.push({
      field: field as RequiredField,
      reason: 'reason' in item ? String(item.reason ?? '') : '',
      hint: 'hint' in item ? String(item.hint ?? '') : '',
    })
  }
  return out
}

/** 推断条目列表；同样严格：字段名非法、值为空、置信度不在枚举里 → 整份作废 */
function inferenceList(raw: unknown): MapBriefInference[] | null {
  if (!Array.isArray(raw)) return null
  const out: MapBriefInference[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const field = 'field' in item ? String(item.field) : ''
    const value = 'value' in item ? String(item.value ?? '').trim() : ''
    const confidence = 'confidence' in item ? String(item.confidence) : ''
    if (!(REQUIRED_FIELDS as readonly string[]).includes(field)) return null
    if (!value) return null
    if (!(CONFIDENCES as readonly string[]).includes(confidence)) return null
    out.push({ field, value, basis: 'basis' in item ? String(item.basis ?? '') : '', confidence: confidence as MapBriefInference['confidence'] })
  }
  return out
}

/**
 * 模型回复 → 结构化结论。**不成形就返回 null**（调用方按「没判成」处理，阻塞）。
 * 成形的判据：对象，且 inferred / ambiguous / missing / notes 四个键**全部存在且都是数组**，
 * 每个条目也都成形。半截回复（比如只回了 notes）绝不能被当成「四个维度都通过」。
 */
export function parseBriefVerdict(raw: unknown): BriefVerdict | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record: Record<string, unknown> = { ...raw }
  for (const key of ['inferred', 'ambiguous', 'missing', 'notes'] as const) {
    if (!(key in record) || !Array.isArray(record[key])) return null
  }
  const inferred = inferenceList(record.inferred)
  const ambiguous = gapList(record.ambiguous)
  const missing = gapList(record.missing)
  if (!inferred || !ambiguous || !missing) return null
  const notes: string[] = []
  for (const item of record.notes as unknown[]) {
    if (typeof item !== 'string') return null
    if (item.trim()) notes.push(item.trim())
  }
  return { inferred, ambiguous, missing, notes }
}

export interface BriefCheckResult {
  brief: MapBrief
  issues: MapWorkflowIssue[]
}

/**
 * 纯判定：brief + 模型结论 → 补全后的 brief 与问题清单。
 * `verdict === null` 表示这一次**没有判成**（调用失败或回复不成形）：一律阻塞，
 * 绝不因为「字段都非空」就放行——那就退回成了字段存在性检查。
 */
export function judgeBrief(brief: MapBrief, verdict: BriefVerdict | null, failureReason?: string): BriefCheckResult {
  const issues: MapWorkflowIssue[] = []
  const next: MapBrief = { ...brief, inferred: [] }

  if (!brief.subject) {
    issues.push({
      field: 'subject', code: 'missing_subject', blocking: true,
      message: `缺少${FIELD_LABEL.subject}：${FIELD_WHY.subject}请先填写要画的对象（如「邗沟（春秋吴国运河）」）。`,
    })
    return { brief: next, issues }
  }

  if (!verdict) {
    issues.push({
      field: 'brief', code: 'sufficiency_check_failed', blocking: true,
      message: `需求的语义充分性未能判定${failureReason ? `（${failureReason}）` : '（模型回复不是可用的结构化结论）'}：`
        + '这一步决定底图的时代与范围，不能跳过。请重新开始（可在顶栏换一个文本模型），'
        + '或把时代/地域/用途写成唯一可确定的表述后重试。',
    })
    return { brief: next, issues }
  }

  for (const note of verdict.notes) {
    // 次要不确定项：可见但不阻塞（用户确认：允许带着次要不确定继续，但必须显式告知）
    issues.push({ field: 'notes', code: 'minor_uncertainty', blocking: false, message: note })
  }

  const gapOf = (field: RequiredField) => ({
    missing: verdict.missing.find(item => item.field === field),
    ambiguous: verdict.ambiguous.find(item => item.field === field),
  })

  for (const field of REQUIRED_FIELDS) {
    const { missing, ambiguous } = gapOf(field)
    const value = brief[field]

    // 已填但语义不够明确：非空不等于可用，照样阻塞
    if (value && ambiguous) {
      issues.push({
        field, code: `ambiguous_${field}`, blocking: true,
        message: `${FIELD_LABEL[field]}「${value}」还不足以唯一确定这张图：${ambiguous.reason || FIELD_WHY[field]}`
          + `${ambiguous.hint ? `${ambiguous.hint}。` : ''}请改写得更具体后重试。`,
      })
      continue
    }
    if (value && missing) {
      issues.push({
        field, code: `missing_${field}`, blocking: true,
        message: `${FIELD_LABEL[field]}「${value}」无法作为开工依据：${missing.reason || FIELD_WHY[field]}`
          + `${missing.hint ? `${missing.hint}。` : ''}`,
      })
      continue
    }
    if (value) continue

    const hit = verdict.inferred.find(item => item.field === field)
    // 低置信度推断不算补上：它和「没填」一样危险，只是更不容易被发现
    if (hit && hit.confidence !== 'low' && !missing && !ambiguous) {
      next[field] = hit.value
      next.inferred.push(hit)
      issues.push({
        field, code: 'inferred_field', blocking: false,
        message: `${FIELD_LABEL[field]}由 AI 据「${hit.basis || '对象本身'}」推断为「${hit.value}」（置信度 ${hit.confidence}），请确认或改写。`,
      })
      continue
    }
    const gap = missing ?? ambiguous
    const detail = [gap?.reason, gap?.hint].filter(Boolean).join('；')
    const lowNote = hit && hit.confidence === 'low' ? `（AI 只能低置信度猜测「${hit.value}」，不予采纳）` : ''
    issues.push({
      field, code: `missing_${field}`, blocking: true,
      message: `缺少${FIELD_LABEL[field]}${lowNote}：${FIELD_WHY[field]}${detail ? `${detail}。` : ''}请补充后重新开始。`,
    })
  }

  return { brief: next, issues }
}

const VERDICT_CONTRACT = '回复必须是一个 JSON 对象，inferred / ambiguous / missing / notes 四个键都存在且都是数组；'
  + 'field 只能是 subject / era / location / purpose；inferred 的 value 不能为空、confidence 只能是 high / medium / low；notes 只能是字符串'

export interface BriefRoundRecorder {
  (round: number, outcome: 'accepted' | 'rejected' | 'error', problems: string[]): Promise<void>
}

/**
 * 调模型做语义充分性判断，再交给纯函数 `judgeBrief` 定夺（Issue #90）。
 *
 * 调用失败或回复不合约**回给模型重答**（计入本阶段轮次），不再静默按「没判成」处理；
 * 轮次用完抛 MapStageExhaustedError 交人。判定逻辑与「阻断项交人」不变。
 */
export async function checkBriefSufficiency(brief: MapBrief, opts: {
  textConfigId?: number
  startRounds?: number
  feedback?: string | null
  record?: BriefRoundRecorder
} = {}): Promise<BriefCheckResult> {
  if (!brief.subject) return judgeBrief(brief, { inferred: [], ambiguous: [], missing: [], notes: [] })
  const model = await resolveStageModel('asset_research', { configId: opts.textConfigId })
  let round = opts.startRounds ?? 0
  let feedback = opts.feedback ?? null
  let problems: string[] = []
  while (round < MAP_MAX_STAGE_ROUNDS) {
    round += 1
    let replyText = ''
    let verdict: BriefVerdict | null = null
    let outcome: 'rejected' | 'error' = 'rejected'
    try {
      const reply = await callTextChat(model, [briefText(brief), feedback ? `\n上一轮的情况（请据此修正）：\n${feedback}` : ''].join(''), {
        systemPrompt: SYSTEM, temperature: 0.1, maxTokens: MAX_TOKENS, timeoutMs: TEXT_TIMEOUT_MS, interactive: true,
      })
      replyText = reply.text
      let parsed: unknown = null
      let parseError = ''
      try {
        parsed = parseJsonReply(reply.text)
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err)
      }
      verdict = parseBriefVerdict(parsed)
      problems = verdict ? [] : [`回复不符合约定${parseError ? `（${parseError}）` : ''}：${VERDICT_CONTRACT}`]
    } catch (err) {
      outcome = 'error'
      problems = [`本轮调用出错：${err instanceof Error ? err.message : String(err)}`]
      logTaskWarn('MapWorkflow', 'brief-check-failed', { round, error: problems[0] })
    }
    // 记录在 try 之外：工作流被取消（Stale）必须终止执行，而不是被当成一次调用出错回给模型
    await opts.record?.(round, verdict ? 'accepted' : outcome, problems)
    if (verdict) return judgeBrief(brief, verdict)
    feedback = [...problems, replyText ? `你上一轮的回复原文：${replyText.slice(0, 2000)}` : ''].filter(Boolean).join('\n')
  }
  throw new MapStageExhaustedError('brief', problems)
}
