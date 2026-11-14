/**
 * 三阶段（旁白骨架 / 配音 / 设计卡）的真实计量与批量 ETA（Issue #87 §D）。
 *
 * 唯一事实来源是 `services/task-observability.ts` 持久化的从属工作项：
 * 每个工作项记录源旁白字数、开始/结束、状态、**实际模型调用耗时**与排队等待。
 * 这里只做读取与推算，不写观测库、不碰 `sys_task.updatedAt`
 * （它会被每次进度刷新覆盖，推不出首次开始时间，更推不出排队时长）。
 *
 * 口径硬约束（评审采纳）：
 * - 分组不混池：阶段 + 实际配置/模型（TTS 再加合成参数）构成 sampleKey，骨架整集与设计卡逐镜分开；
 * - 速率按**源旁白字数**缩放，不是提示词字数，更不是音频长度；
 * - 串行剩余 = 当前项预计总耗时 − 当前项同口径已用 + 未开始项预测；
 * - 当前项超过预计时不返回 0，而是 `overrun=true` 由界面显示「超过预估/更新中」；
 * - 没有样本就是没有估计（`eta=null` + `eta_unknown_reason`），绝不编固定秒数；
 * - 失败/中断样本不进成功样本池；任务终态后不再倒计时。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  listObservedSamples,
  listObservedWork,
  type ObservedStage,
  type ObservedWorkRow,
} from './task-observability.js'
import { parseTextTaskParams } from './text-task.js'
import type { VoiceParams } from './narration-voice-params.js'

export type { ObservedStage } from './task-observability.js'

/** 批量计划里的一项（骨架整集只有一项，storyboard_id 为 null） */
export interface WorkPlanItem {
  storyboard_id: number | null
  storyboard_number: number | null
  source_chars: number
  /**
   * 这一项**实际生效**的分组键。配音的 normalize 是镜级覆盖，同一批里可以一半开一半关，
   * 一次合成的参数档案才是分组依据，所以逐项落键；缺省时才退回计划级的 sample_key。
   */
  sample_key?: string
}

/** 开跑前就落库的批量计划（`sys_task.params.work_plan`）：刷新/重启后计数不归零 */
export interface TaskWorkPlan {
  stage: ObservedStage
  /** 骨架整集 = episode；设计卡/配音逐镜 = shot */
  unit: 'episode' | 'shot'
  /** 批次的主分组键（逐项可覆盖） */
  sample_key: string
  planned_units: number
  planned_source_chars: number
  items: WorkPlanItem[]
}

export interface WorkRate {
  ms_per_char: number | null
  /** 没有字数可依据（例如纯画面镜）时按「每项中位耗时」估 */
  per_unit_ms: number | null
  sample_count: number
  basis: 'current_batch' | 'history'
}

export interface WorkEstimate {
  estimate_ms: number
  source_chars: number
  sample_count: number
  basis: 'current_batch' | 'history'
  scale: 'per_char' | 'per_unit'
}

export interface TaskWorkSummaryItem {
  storyboard_id: number | null
  storyboard_number: number | null
  source_chars: number
  state: 'pending' | 'processing' | 'completed' | 'failed' | 'interrupted'
  /** 这一项的实际服务调用耗时（模型 / TTS 请求传输到响应结束之和） */
  call_ms: number
  /** 这一项的工作墙钟（含工具与文件处理）；和 call_ms、队列等待分开命名 */
  work_ms: number
}

export interface TaskWorkSummaryCurrent {
  storyboard_id: number | null
  storyboard_number: number | null
  source_chars: number
  started_at: number
  /** 当前项墙钟已用（真实观测起点，不是任务创建时间，也不是 sys_task.updated_at） */
  elapsed_ms: number
  /** 当前项已完成调用的实际服务调用耗时合计 */
  call_ms: number
  estimate_ms: number | null
  overrun: boolean
}

export interface TaskWorkSummary {
  task_id: number
  stage: ObservedStage
  unit: 'episode' | 'shot'
  sample_key: string | null
  /** sys_task 状态；终态后不再倒计时 */
  task_status: string
  terminal: boolean
  planned_units: number
  planned_source_chars: number
  completed_units: number
  failed_units: number
  interrupted_units: number
  remaining_units: number
  completed_source_chars: number
  remaining_source_chars: number
  /** 本任务全部工作项的实际服务调用耗时之和（并发时不是墙钟，也不是音频长度） */
  actual_call_ms: number
  /** 已记录的排队等待之和；外部供应商队列不可知时 queue_wait_known=false */
  actual_queue_ms: number
  queue_wait_known: boolean
  /** 工作项墙钟之和（含工具/文件处理，和模型调用耗时分开） */
  work_wall_ms: number
  current: TaskWorkSummaryCurrent | null
  rate: WorkRate | null
  eta: { remaining_ms: number; finish_at: number; overrun: boolean; basis: 'current_batch' | 'history'; sample_count: number } | null
  eta_unknown_reason: 'no_samples' | 'terminal' | 'not_started' | null
  items: TaskWorkSummaryItem[]
  updated_at: number
}

const TERMINAL_TASK_STATUS: Record<string, true> = {
  completed: true,
  failed: true,
  cancelled: true,
  canceled: true,
}
/** 历史样本只回看最近这么多条，够稳也不会被远古慢模型拖偏 */
const HISTORY_SAMPLE_LIMIT = 60

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * 一个工作项的「同口径耗时」：工作项墙钟优先（含工具/文件处理），
 * 缺失时退回实际模型调用耗时，再退回起止差。中断行的 work_ms 已被观测层冻结。
 */
export function workDurationMs(row: ObservedWorkRow): number {
  const work = Number(row.work_ms) || 0
  if (work > 0) return work
  const model = Number(row.model_ms) || 0
  if (model > 0) return model
  if (row.finished_at && row.started_at && row.finished_at > row.started_at) return row.finished_at - row.started_at
  return 0
}

// ─── 分组键 ─────────────────────────────────────────────────

/**
 * 分组键：阶段 + 实际配置 + 实际模型（TTS 再加合成参数）。
 * 骨架整集与设计卡逐镜天然因 stage 不同而不混池。
 */
export function buildSampleKey(input: {
  stage: ObservedStage
  configId?: number | null
  model?: string | null
  /** TTS 专用：同一模型下不同合成参数耗时差异明显，必须分开 */
  voice?: VoiceParams | null
}): string {
  const config = Number.isInteger(input.configId) && Number(input.configId) > 0 ? String(input.configId) : 'none'
  const base = `${input.stage}|cfg:${config}|model:${(input.model || '').trim() || 'unknown'}`
  if (input.stage !== 'voice') return base
  const v = input.voice
  if (!v) return `${base}|voice:unknown`
  // 合成参数档案要完整：音色 / 步数 / cfg / 规范化（镜级可覆盖）/ 指令 / 种子，
  // 任一项不同都可能改变语速、音频长度与一次合成的耗时，混在同一池里就会给出假的 ETA。
  // 指令可能很长，用「长度 + FNV-1a」规范化成定长标记（纯文本参数，不含任何凭据）；
  // 种子沿 #37 语义：null = 每次随机，其余是用户显式固定值。
  const instructions = (v.instructions || '').trim()
  let hash = 2166136261
  for (let i = 0; i < instructions.length; i++) {
    hash = Math.imul(hash ^ instructions.charCodeAt(i), 16777619) >>> 0
  }
  const inst = instructions ? `${instructions.length}.${hash.toString(36)}` : 'none'
  const seed = v.seed === null || v.seed === undefined ? 'random' : String(v.seed)
  return `${base}|voice:${v.voice || 'unknown'}|steps:${v.inference_timesteps}|cfgv:${v.cfg_value}`
    + `|norm:${v.normalize ? 1 : 0}|inst:${inst}|seed:${seed}`
}

// ─── 速率与单项预测 ───────────────────────────────────────────

function rateFrom(samples: ObservedWorkRow[], basis: 'current_batch' | 'history'): WorkRate | null {
  const usable = samples.filter(row => row.status === 'completed' && workDurationMs(row) > 0)
  if (!usable.length) return null
  return {
    ms_per_char: median(usable
      .filter(row => (Number(row.source_chars) || 0) > 0)
      .map(row => workDurationMs(row) / Number(row.source_chars))),
    per_unit_ms: median(usable.map(row => workDurationMs(row))),
    sample_count: usable.length,
    basis,
  }
}

function estimateWith(rate: WorkRate | null, sourceChars: number): WorkEstimate | null {
  if (!rate) return null
  if (sourceChars > 0 && rate.ms_per_char !== null) {
    return {
      estimate_ms: Math.round(rate.ms_per_char * sourceChars),
      source_chars: sourceChars,
      sample_count: rate.sample_count,
      basis: rate.basis,
      scale: 'per_char',
    }
  }
  if (rate.per_unit_ms !== null) {
    return {
      estimate_ms: Math.round(rate.per_unit_ms),
      source_chars: sourceChars,
      sample_count: rate.sample_count,
      basis: rate.basis,
      scale: 'per_unit',
    }
  }
  return null
}

/** 历史同阶段同实际模型（TTS 同参数）的成功样本速率；没有样本返回 null */
export function historyRate(stage: ObservedStage, sampleKey: string, excludeTaskId?: number): WorkRate | null {
  if (!sampleKey) return null
  const rows = listObservedSamples(stage, sampleKey)
    .filter(row => row.status === 'completed' && (!excludeTaskId || row.task_id !== excludeTaskId))
    .slice(0, HISTORY_SAMPLE_LIMIT)
  return rateFrom(rows, 'history')
}

/**
 * 开跑前的计划预估（界面「开始前显示字数 + 历史 ETA」）：
 * 只用历史成功样本，没有样本就返回 null（界面显示「暂无估计」）。
 */
export function estimateObservedWork(input: {
  stage: ObservedStage
  sampleKey: string
  sourceChars: number
  excludeTaskId?: number
}): WorkEstimate | null {
  return estimateWith(historyRate(input.stage, input.sampleKey, input.excludeTaskId), input.sourceChars)
}

/**
 * 批量计划的总预估：逐项按**各自的分组键**取历史速率再按源字数缩放求和
 * （串行执行，所以是和不是最大值）。任一项没有同键样本，整批就是「暂无估计」。
 */
export function estimateWorkPlan(plan: TaskWorkPlan, excludeTaskId?: number): {
  estimate_ms: number | null
  sample_count: number
  basis: 'history' | null
} {
  const rates = new Map<string, WorkRate | null>()
  let total = 0
  let samples = 0
  for (const item of plan.items) {
    const key = item.sample_key || plan.sample_key
    if (!rates.has(key)) rates.set(key, historyRate(plan.stage, key, excludeTaskId))
    const rate = rates.get(key) ?? null
    const est = estimateWith(rate, item.source_chars)
    if (!est || !rate) return { estimate_ms: null, sample_count: rate?.sample_count ?? 0, basis: null }
    total += est.estimate_ms
    samples = Math.max(samples, rate.sample_count)
  }
  if (!plan.items.length) return { estimate_ms: null, sample_count: 0, basis: null }
  return { estimate_ms: Math.round(total), sample_count: samples, basis: 'history' }
}

/** 「开始前」给界面的一份阶段预估：计划字数 + 历史样本 ETA（没有样本就是 null） */
export interface StageWorkEstimate {
  stage: ObservedStage
  unit: 'episode' | 'shot'
  sample_key: string
  config_id: number | null
  model: string | null
  planned_units: number
  planned_source_chars: number
  estimate_ms: number | null
  sample_count: number
  basis: 'history' | null
  /** 被前置门禁挡住、本次不会进模型的项数（设计卡的配音门禁等） */
  blocked_units: number
}

export function stageEstimateOf(plan: TaskWorkPlan, configId: number | null, model: string | null): StageWorkEstimate {
  return {
    stage: plan.stage,
    unit: plan.unit,
    sample_key: plan.sample_key,
    config_id: configId,
    model,
    planned_units: plan.planned_units,
    planned_source_chars: plan.planned_source_chars,
    ...estimateWorkPlan(plan),
    blocked_units: 0,
  }
}

// ─── 任务汇总 ─────────────────────────────────────────────────

/** 会写 `params.work_plan` 的观测阶段（任务窗口按计划显示进度与 ETA） */
const WORK_PLAN_STAGES: Record<string, true> = {
  skeleton: true, voice: true, design_card: true, keyframe_prompts: true, video_prompts: true,
}

function readPlan(params: Record<string, unknown> | null): TaskWorkPlan | null {
  const raw = params?.work_plan
  if (!raw || typeof raw !== 'object') return null
  const plan = raw as Partial<TaskWorkPlan>
  if (!(typeof plan.stage === 'string' && plan.stage in WORK_PLAN_STAGES)) return null
  const items = Array.isArray(plan.items) ? plan.items as WorkPlanItem[] : []
  return {
    stage: plan.stage,
    unit: plan.unit === 'episode' ? 'episode' : 'shot',
    sample_key: typeof plan.sample_key === 'string' ? plan.sample_key : '',
    planned_units: Number.isFinite(plan.planned_units) ? Number(plan.planned_units) : items.length,
    planned_source_chars: Number.isFinite(plan.planned_source_chars)
      ? Number(plan.planned_source_chars)
      : items.reduce((sum, item) => sum + (Number(item.source_chars) || 0), 0),
    items,
  }
}

/**
 * 一次列表请求内的历史样本缓存：任务中心一页可能有上百行，
 * 同阶段同分组的历史速率只该算一次。生命周期仅限本次请求，不做常驻缓存。
 */
export type WorkSampleCache = Map<string, WorkRate | null>

/**
 * 任务详情与三阶段界面读的是同一个对象（由 task-center 挂成 `task.observation_summary`）。
 * `nowMs` 仅用于计算「当前项已用」，便于单测；终态任务的时间字段全部取自已落库事实，
 * 不随 `Date.now()` 继续增长。
 */
export function getTaskWorkSummary(taskId: number, nowMs: number = Date.now(), cache?: WorkSampleCache): TaskWorkSummary | null {
  const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
  if (!row) return null
  const params = parseTextTaskParams(row.params) as Record<string, unknown> | null
  const plan = readPlan(params)
  // 同一任务可能夹带别的阶段的工作项（视频提示词批次先跑衔接帧描述 junction_caption）：
  // 有计划时进度/ETA 只按计划阶段统计，其余工作项照常留在观测明细里
  const allWorks = listObservedWork(taskId)
  const works = plan ? allWorks.filter(w => w.stage === plan.stage) : allWorks
  if (!plan && !works.length) return null

  const stage: ObservedStage = plan?.stage ?? works[0]!.stage
  const sampleKey = plan?.sample_key || works[0]?.sample_key || ''
  const taskStatus = row.status || 'processing'
  const terminal = TERMINAL_TASK_STATUS[taskStatus] === true

  const completed = works.filter(w => w.status === 'completed')
  const failedCount = works.filter(w => w.status === 'failed').length
  const interruptedCount = works.filter(w => w.status === 'interrupted').length
  // 在飞工作项：重启后由观测层标 interrupted，终态任务不再把任何行当「运行中」
  const currentRow = terminal
    ? null
    : works.filter(w => w.status === 'processing').sort((a, b) => b.started_at - a.started_at)[0] ?? null

  /**
   * 在飞调用的已用时长：`model_ms` 只累计**已结束**的调用，
   * 否则一次跑几十秒的首个请求会一直显示「调用 0.0s」。
   * 只对仍在跑的工作项按「现在 − 该调用持久化的开始时间」派生；
   * 终态/中断行的 `active_call_started_at` 为 null，一律只用冻结值，绝不编造未落盘的尾巴。
   */
  const callMsOf = (w: ObservedWorkRow): number => {
    const finished = Number(w.model_ms) || 0
    if (terminal || w.status !== 'processing') return finished
    // 观测层为运行中的工作项提供当前调用的持久化起点；没有这个字段就只报已结束的调用
    const activeStart = 'active_call_started_at' in w ? Number(w.active_call_started_at) : 0
    return Number.isFinite(activeStart) && activeStart > 0 ? finished + Math.max(0, nowMs - activeStart) : finished
  }

  const itemKey = (storyboardId: number | null | undefined): string =>
    storyboardId === null || storyboardId === undefined ? 'episode' : `sb:${storyboardId}`
  const attempted = new Set(works.filter(w => w.status !== 'processing').map(w => itemKey(w.storyboard_id)))
  const planItems = plan?.items ?? []
  const plannedUnits = plan?.planned_units ?? works.length
  const plannedChars = plan?.planned_source_chars ?? works.reduce((sum, w) => sum + (Number(w.source_chars) || 0), 0)

  const notStarted = planItems.filter(item => !attempted.has(itemKey(item.storyboard_id))
    && (!currentRow || itemKey(item.storyboard_id) !== itemKey(currentRow.storyboard_id)))

  /**
   * 速率按**分组键**取，不是整批一个池：同一批配音里镜级 normalize 覆盖会产生两种参数档案，
   * 混在一起算中位数就是假的 ETA。先用本批同键已完成项，不足再退回历史同键成功样本。
   */
  const rateByKey = new Map<string, WorkRate | null>()
  const rateFor = (key: string): WorkRate | null => {
    const group = key || sampleKey
    if (rateByKey.has(group)) return rateByKey.get(group) ?? null
    const batch = rateFrom(completed.filter(w => (w.sample_key || sampleKey) === group), 'current_batch')
    let resolved = batch
    if (!resolved) {
      const cacheKey = `${stage}|${group}|${taskId}`
      if (cache?.has(cacheKey)) {
        resolved = cache.get(cacheKey) ?? null
      } else {
        resolved = historyRate(stage, group, taskId)
        cache?.set(cacheKey, resolved)
      }
    }
    rateByKey.set(group, resolved)
    return resolved
  }
  // 汇总行展示的速率：当前项所用的那一组；没有当前项时用批次主键
  const rate = rateFor(currentRow?.sample_key || sampleKey)

  const currentEstimate = currentRow
    ? estimateWith(rateFor(currentRow.sample_key || sampleKey), Number(currentRow.source_chars) || 0)
    : null
  const current: TaskWorkSummaryCurrent | null = currentRow
    ? {
      storyboard_id: currentRow.storyboard_id ?? null,
      storyboard_number: currentRow.storyboard_number ?? null,
      source_chars: Number(currentRow.source_chars) || 0,
      started_at: currentRow.started_at,
      elapsed_ms: Math.max(0, nowMs - currentRow.started_at),
      call_ms: callMsOf(currentRow),
      estimate_ms: currentEstimate ? currentEstimate.estimate_ms : null,
      overrun: !!currentEstimate && nowMs - currentRow.started_at > currentEstimate.estimate_ms,
    }
    : null

  let eta: TaskWorkSummary['eta'] = null
  let etaReason: TaskWorkSummary['eta_unknown_reason'] = null
  if (terminal) {
    etaReason = 'terminal'
  } else if (!rate) {
    etaReason = 'no_samples'
  } else if (!current && !notStarted.length) {
    etaReason = works.length ? 'terminal' : 'not_started'
  } else {
    // 串行剩余：当前项（预计总耗时 − 已用，封底 0）+ 未开始项逐项预测
    let remaining = current && current.estimate_ms !== null
      ? Math.max(0, current.estimate_ms - current.elapsed_ms)
      : 0
    let complete = true
    for (const item of notStarted) {
      const est = estimateWith(rateFor(item.sample_key || sampleKey), item.source_chars)
      if (!est) { complete = false; break }
      remaining += est.estimate_ms
    }
    if (!complete) {
      etaReason = 'no_samples'
    } else {
      eta = {
        remaining_ms: Math.round(remaining),
        finish_at: nowMs + Math.round(remaining),
        overrun: !!current?.overrun,
        basis: rate.basis,
        sample_count: rate.sample_count,
      }
    }
  }

  const latestByItem = new Map<string, ObservedWorkRow>()
  for (const w of works) {
    const key = itemKey(w.storyboard_id)
    const prev = latestByItem.get(key)
    if (!prev || w.started_at >= prev.started_at) latestByItem.set(key, w)
  }
  const items: TaskWorkSummaryItem[] = planItems.length
    ? planItems.map((item) => {
      const w = latestByItem.get(itemKey(item.storyboard_id))
      return {
        storyboard_id: item.storyboard_id ?? null,
        storyboard_number: item.storyboard_number ?? null,
        source_chars: Number(item.source_chars) || 0,
        state: (w?.status ?? 'pending') as TaskWorkSummaryItem['state'],
        call_ms: w ? callMsOf(w) : 0,
        work_ms: w ? workDurationMs(w) : 0,
      }
    })
    : works.map(w => ({
      storyboard_id: w.storyboard_id ?? null,
      storyboard_number: w.storyboard_number ?? null,
      source_chars: Number(w.source_chars) || 0,
      state: w.status as TaskWorkSummaryItem['state'],
      call_ms: callMsOf(w),
      work_ms: workDurationMs(w),
    }))

  return {
    task_id: taskId,
    stage,
    unit: plan?.unit ?? (stage === 'skeleton' ? 'episode' : 'shot'),
    sample_key: sampleKey || null,
    task_status: taskStatus,
    terminal,
    planned_units: plannedUnits,
    planned_source_chars: plannedChars,
    completed_units: completed.length,
    failed_units: failedCount,
    interrupted_units: interruptedCount,
    remaining_units: Math.max(0, plannedUnits - completed.length - failedCount - interruptedCount),
    completed_source_chars: completed.reduce((sum, w) => sum + (Number(w.source_chars) || 0), 0),
    remaining_source_chars: notStarted.reduce((sum, item) => sum + (Number(item.source_chars) || 0), 0)
      + (current ? current.source_chars : 0),
    actual_call_ms: works.reduce((sum, w) => sum + callMsOf(w), 0),
    actual_queue_ms: works.reduce((sum, w) => sum + (Number(w.queue_ms) || 0), 0),
    // 已观测到的排队等待才算「已知」；供应商侧外部队列本轮不可知，界面照实说明
    queue_wait_known: works.some(w => (Number(w.queue_ms) || 0) > 0),
    work_wall_ms: works.reduce((sum, w) => sum + workDurationMs(w), 0),
    current,
    rate,
    eta,
    eta_unknown_reason: etaReason,
    items,
    // 终态任务的汇总必须是冻结事实：不能让 Date.now() 把它变成一直在走的数字
    updated_at: terminal
      ? works.reduce((latest, w) => Math.max(latest, w.finished_at ?? w.started_at), 0) || nowMs
      : nowMs,
  }
}

/** 把计划写进任务参数（开跑前调用，刷新/重启都能复原批量口径） */
export function buildWorkPlan(input: {
  stage: ObservedStage
  unit: 'episode' | 'shot'
  sampleKey: string
  items: WorkPlanItem[]
}): TaskWorkPlan {
  return {
    stage: input.stage,
    unit: input.unit,
    sample_key: input.sampleKey,
    planned_units: input.items.length,
    planned_source_chars: input.items.reduce((sum, item) => sum + (Number(item.source_chars) || 0), 0),
    items: input.items,
  }
}
