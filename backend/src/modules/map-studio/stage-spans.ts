/**
 * 阶段跨度（Issue #99 阶段②）：把一次运行里的阶段边界写进 `map_studio_run.params.stage_spans`。
 *
 * 为什么不用新表：观测表（task_observed_work / task_observed_call）只记工作项与调用，没有阶段边界；
 * 运行参数已经是这个运行自己的可写区域（`map_texture_ref` 也在那里），随运行行一起读写、重启后仍在，
 * 且不需要动表结构。
 *
 * 归属规则是**纯包含判定**，不猜：调用的 started_at 落在 [started_at_ms, finished_at_ms] 内才算该阶段；
 * 多条跨度同时包含时取开始最晚的一条（嵌套时就是最内层）；没有任何跨度包含就是 null ——
 * 不按阶段顺序推断「应该属于哪个阶段」，也不拿最近的跨度凑答案。
 *
 * 未结束的跨度（finished_at_ms=null）只允许出现在进程还在跑的时候。重启恢复链会把它们按已冻结的中断时刻
 * 结束成 interrupted（见 tasks.ts 的 initMapStudio），避免一个 null 结束时间无限吞掉重启后的调用。
 */
import { MAP_WORKFLOW_STAGES, type MapWorkflowStage } from './types.js'
import { patchRunParams, readRunParams } from './db.js'

/**
 * 终态取值与运行/步骤状态同一套词：completed / blocked / failed / interrupted / cancelled，
 * 另加 rollback（阶段被回退打断，本身既没完成也没失败）。running 只表示「还没结束」。
 * unknown 只可能出现在**读到的坏数据**里（已结束却写着不认识或 running 的 outcome），
 * 它不等于任何一种真实结局，所以永远不允许被写出来冒充结论。
 */
export const STAGE_SPAN_OUTCOMES = ['running', 'completed', 'blocked', 'rollback', 'failed', 'interrupted', 'cancelled', 'unknown'] as const
export type StageSpanOutcome = typeof STAGE_SPAN_OUTCOMES[number]
/** 写跨度只能用真实终态：running 由 finished_at_ms=null 表达，unknown 是读侧兜底。 */
export const STAGE_SPAN_END_OUTCOMES = ['completed', 'blocked', 'rollback', 'failed', 'interrupted', 'cancelled'] as const
export type StageSpanEndOutcome = typeof STAGE_SPAN_END_OUTCOMES[number]

export interface MapStudioStageSpan {
  stage: MapWorkflowStage
  /** 毫秒时间戳，与观测行同一口径 */
  started_at_ms: number
  /** null = 仍在执行；结束值永远 >= started_at_ms */
  finished_at_ms: number | null
  outcome: StageSpanOutcome
}

/**
 * 坏条目丢弃而不是整份拒绝：跨度只用于归属，丢一条最多让那次调用没有阶段（null），
 * 绝不会伪造一个阶段或改坏运行本身。时间与 outcome 会互相校正到自洽：结束时间不早于开始时间，
 * 未结束只能是 running，已结束但 outcome 不认识就记 unknown（不冒充 completed，也不冒充 failed）。
 */
function normalizeSpan(raw: unknown): MapStudioStageSpan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const stage = item.stage
  if (typeof stage !== 'string' || !(MAP_WORKFLOW_STAGES as readonly string[]).includes(stage)) return null
  const started = item.started_at_ms
  if (typeof started !== 'number' || !Number.isFinite(started) || started < 0) return null
  const finishedRaw = item.finished_at_ms ?? null
  if (finishedRaw !== null && (typeof finishedRaw !== 'number' || !Number.isFinite(finishedRaw))) return null
  const finished = finishedRaw === null ? null : Math.max(finishedRaw, started)
  const rawOutcome = item.outcome
  const outcome: StageSpanOutcome = finished === null
    ? 'running'
    : typeof rawOutcome === 'string' && (STAGE_SPAN_END_OUTCOMES as readonly string[]).includes(rawOutcome)
      ? rawOutcome as StageSpanEndOutcome
      : 'unknown'
  return { stage: stage as MapWorkflowStage, started_at_ms: started, finished_at_ms: finished, outcome }
}

/** 原始跨度（已规范化、按写入顺序）。读是纯的：不改库、不补默认值。 */
export function readStageSpans(runId: number): MapStudioStageSpan[] {
  const raw = readRunParams(runId).stage_spans
  if (!Array.isArray(raw)) return []
  const spans: MapStudioStageSpan[] = []
  for (const item of raw) {
    const normalized = normalizeSpan(item)
    if (normalized) spans.push(normalized)
  }
  return spans
}

/** 写跨度只接受真实终态（含 rollback）：running、unknown 或自造的词都是调用方错误，直接抛错而不是记账。 */
function endOutcomeOf(outcome: string): StageSpanEndOutcome {
  if (!(STAGE_SPAN_END_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new TypeError(`未知的阶段跨度终态：${outcome}`)
  }
  return outcome as StageSpanEndOutcome
}

/**
 * 开始一个阶段跨度。`at` 显式传入便于调用方与自己记录的时间对齐（测试也用它制造确定的时间边界）。
 * 返回 null 表示运行不存在（没有落库，调用方自己决定要不要当错误处理）；不会凭空造一个假运行。
 */
export function beginStageSpan(runId: number, stage: MapWorkflowStage, at: number = Date.now()): MapStudioStageSpan | null {
  const span: MapStudioStageSpan = { stage, started_at_ms: at, finished_at_ms: null, outcome: 'running' }
  const spans = [...readStageSpans(runId), span]
  return patchRunParams(runId, { stage_spans: spans }) !== null ? span : null
}

/**
 * 结束该阶段最近的一个**未结束**跨度。幂等且不回写历史：没有未结束跨度时返回 null 且不落库 ——
 * 重启/取消已经把跨度冻结成 interrupted/cancelled 之后，迟到的执行退出不会改写那个已冻结的结论。
 * 结束时间不会被写到开始时间之前。
 */
export function endStageSpan(runId: number, stage: MapWorkflowStage, outcome: string, at: number = Date.now()): MapStudioStageSpan | null {
  const terminal = endOutcomeOf(outcome)
  const spans = readStageSpans(runId)
  let index = -1
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!
    if (span.stage === stage && span.finished_at_ms === null) { index = i; break }
  }
  if (index < 0) return null
  const open = spans[index]!
  const closed: MapStudioStageSpan = { ...open, finished_at_ms: Math.max(at, open.started_at_ms), outcome: terminal }
  spans[index] = closed
  return patchRunParams(runId, { stage_spans: spans }) !== null ? closed : null
}

/**
 * 收尾所有未结束的跨度（重启恢复链用）：在已冻结的中断时刻结束，避免 null 区间吞掉重启后的调用；
 * 已经结束的跨度（含各自 end/outcome）原样保留。返回收尾条数；没有未结束跨度时不写库。
 */
export function closeOpenStageSpans(runId: number, outcome: string, at: number): number {
  const terminal = endOutcomeOf(outcome)
  const spans = readStageSpans(runId)
  let closed = 0
  for (const span of spans) {
    if (span.finished_at_ms !== null) continue
    span.finished_at_ms = Math.max(at, span.started_at_ms)
    span.outcome = terminal
    closed++
  }
  if (!closed) return 0
  return patchRunParams(runId, { stage_spans: spans }) !== null ? closed : 0
}

/**
 * 纯归属函数：给定跨度和调用开始时刻，返回包含它的阶段；没有包含关系就返回 null。
 * （同一批调用只需要读一次跨度，再对每条调用调用这个函数。）
 */
export function stageForCallInSpans(spans: readonly MapStudioStageSpan[], startedAt: number): MapWorkflowStage | null {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return null
  let best: MapStudioStageSpan | null = null
  for (const span of spans) {
    const end = span.finished_at_ms ?? Number.POSITIVE_INFINITY
    if (startedAt < span.started_at_ms || startedAt > end) continue
    if (!best || span.started_at_ms > best.started_at_ms) best = span
  }
  return best ? best.stage : null
}

/** 单条调用的归属（读库一次）。批量场景请用 readStageSpans + stageForCallInSpans，避免重复读。 */
export function stageForCall(runId: number, startedAt: number): MapWorkflowStage | null {
  return stageForCallInSpans(readStageSpans(runId), startedAt)
}
