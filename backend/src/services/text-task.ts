/**
 * 文本任务（提取 / 提示词批量 / 剧本改写 / 拆分分镜）的持久化 —— 统一落在 sys_task(type='text')。
 *
 * 进程内内存态不再是状态来源：刷新、切页、重启后都从库里读。
 * - params.kind：文本任务种类
 * - params.progress：{ completed, total, failed?, current_storyboard_id? }（不复用 remote_state，那是 qwen-jobs 追踪器的）
 * - provider/model：实际使用的文本模型，供任务中心展示与换模型重试
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { stageModelUsed, type AiStage, type StageModel, type StageModelUsed } from './ai-stages.js'
import { completionStamp } from './media-time.js'
import { isModelError } from './text-model-errors.js'
import { ACTIVE_TASK_STATUSES, type SysTaskRow } from './sys-task.js'
import type { BatchScope } from './batch-scope.js'
import type { VoiceParams } from './narration-voice-params.js'

export type TextTaskKind =
  | 'extract_characters'
  | 'extract_scenes'
  | 'extract_props'
  | 'keyframe_prompts'
  | 'video_prompts'
  | 'script_rewrite'
  | 'storyboard_breaker'
  | 'narration_script'
  | 'narration_tts'
  | 'shot_compose'
  | 'layer_render_batch'
  // 按史料画像补充角色外貌（Issue #32）：按「集 × 类型」判重，与提取任务互不阻塞
  | 'portrait_appearance'
  /** 资产批量生成的父任务（Issue #33）：详细进度在 params.asset_batch */
  | 'asset_batch'
  /** 证据素材的语义自动标注（Issue #47）：VLM 锚点 + CV 几何，结果写 props.semantics */
  | 'asset_semantics'
  /** 设计卡填写（Issue #57）：按镜产出 design_card（信息点/图层段计划/生成段计划/预算） */
  | 'design_card'
  /** 补全剩余（Issue #52）：只把旁白覆盖缺口补成新分镜，既有分镜原样保留 */
  | 'storyboard_fill_gaps'
  /**
   * 资产「精确 → 美化」流水线（Issue #56）：run 容器就是这条任务行，
   * `params.mastra_run_id` 指向 Mastra 工作流快照，`params.progress.step` 是当前步名。
   * 它可以长时间停在「等待人工审批」上，因此被 `failInterruptedTextTasks()` 显式排除。
   */
  | 'asset_pipeline'
  /** 资产审核清单（Issue #55）：逐段对照旁白稿列「信息点 → 需要的素材 → 有/缺」 */
  | 'asset_review'
  /** Poster AI 构想（Issue #72）：只写 episode_posters.concept，不写当前编辑字段 */
  | 'poster_concept'
  /** 资产资料检索（Issue #79）：多来源检索 + 视觉筛选，结果落 params.asset_research，供面板入库与事实表引用 */
  | 'asset_research'
  /**
   * 地图资产工作流（Issue #84）：需求 → 检索 → 底图 → 底纹 → 标注 → 完成。
   * 状态本体在 `props.map_workflow`，这条任务只是执行容器：`params.map_prop_id` 指向地图资产，
   * `params.map_stage` 是当前步名。扩散模型只在「底纹」那一步出一张纸纹，不碰几何。
   */
  | 'map_workflow'
  /** 图层底图视觉验证（Issue #94）：渲染后核验裁切/留白的取景画面，结论写 storyboard_layer_segments.base_check */
  | 'layer_base_check'

export const TEXT_TASK_KINDS: TextTaskKind[] = [
  'extract_characters', 'extract_scenes', 'extract_props',
  'keyframe_prompts', 'video_prompts', 'script_rewrite', 'storyboard_breaker',
  'narration_script', 'narration_tts', 'shot_compose',
  'layer_render_batch',
  'portrait_appearance',
  'asset_batch',
  'asset_semantics',
  'design_card',
  'storyboard_fill_gaps',
  'asset_pipeline',
  'asset_review',
  'poster_concept',
  'asset_research',
  'map_workflow',
  'layer_base_check',
]

/**
 * 批量任务的逐项结果（#42）：落在 sys_task.params.progress 里，
 * 浏览器刷新后重新读取即可恢复「哪几镜成功 / 失败 / 被跳过以及为什么」。
 */
export interface TextTaskProgressItem {
  storyboard_id: number
  storyboard_number: number
  state: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  reason: string | null
}

export interface TextTaskProgress {
  completed: number
  total: number
  failed: number
  /** 执行时依赖已变化而未执行的镜头数（不计失败） */
  skipped?: number
  current_storyboard_id?: number
  /** 分阶段任务的当前阶段（#35 旁白写作：spine = 规划主线，shots = 分块写镜） */
  phase?: 'spine' | 'shots'
  /** 资产流水线（#56）的当前步名：research/curate/spec/prompt/generate/qc/gate/approval/finalize */
  step?: string
  items?: TextTaskProgressItem[]
}

/** 分阶段改写（Issue #70）的任务侧进度快照：阶段条与任务详情时间线读同一份 */
export interface RewriteTaskParams {
  run_id: number
  stage_key: string | null
  stage_index: number
  stage_total: number
  stages: Array<{ key: string; status: string; version_id: number | null; error: string | null }>
}

export interface TextTaskRestart {
  kind: TextTaskKind
  args: Record<string, unknown>
}

export interface TextTaskParams {
  kind: TextTaskKind
  progress?: TextTaskProgress
  scope?: BatchScope
  voice_settings?: VoiceParams
  /** 批量任务的处理范围（重试时按同一范围重跑；空表示按默认规则重新挑选） */
  storyboardIds?: number[]
  configId?: number
  retry_of?: number
  /** 本次用的 AI 环节（Issue #51，AI_STAGES 的键）；任务详情据此显示「是否需要视觉」 */
  stage?: AiStage
  /** 本次实际落到哪条配置/模型上（顶栏选非视觉模型时，视觉环节会被换成视觉配置） */
  model_used?: StageModelUsed
  /** 纪录片角色花名册（Issue #32）：先定人再提取，保证多次运行的角色覆盖一致 */
  roster?: { name: string; basis?: string; reason?: string }[]
  /** 补提取（Issue #55）：该提取任务是为哪条审核清单条目发起的，完成后按它回链 */
  assetReviewItemId?: number
  /**
   * 分阶段剧本改写（Issue #70）的运行与阶段进度：任务中心用一个父项 + 详情时间线展示，
   * 不再实现页面私有轮询。`run_id` 也是「换模型重试」续跑的入口。
   */
  rewrite?: RewriteTaskParams
  [key: string]: unknown
}

export function parseTextTaskParams(raw: string | null | undefined): TextTaskParams | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as TextTaskParams : null
  } catch {
    return null
  }
}

export function textTaskKindOf(row: Pick<SysTaskRow, 'type' | 'params'>): TextTaskKind | null {
  if (row.type !== 'text') return null
  const kind = parseTextTaskParams(row.params)?.kind
  return kind && TEXT_TASK_KINDS.includes(kind) ? kind : null
}

export async function createTextTask(input: {
  kind: TextTaskKind
  /** 集级任务必填；资产级任务（地图工作流 #84）没有归属集，传 null */
  episodeId: number | null
  dramaId?: number | null
  storyboardId?: number | null
  /** 资产级任务的归属道具（地图工作流）：任务中心据此回链资产 */
  propId?: number | null
  prompt?: string | null
  /** 本次解析出来的环节模型（Issue #51）：provider/model/configId 与 params.stage/model_used 都由它来 */
  stageModel?: StageModel
  provider?: string | null
  model?: string | null
  configId?: number | null
  storyboardIds?: number[]
  /** 批量范围快照（Issue #58）：`{included, excluded[{id, reason}]}`，重试/续跑按同一份口径 */
  scope?: { included: Array<{ storyboard_id: number; storyboard_number: number }>; excluded: Array<{ storyboard_id: number; storyboard_number: number; reason: string }> }
  progress?: TextTaskProgress
  retryOf?: number
  queued?: boolean
  restart?: TextTaskRestart
}): Promise<number> {
  const ts = now()
  const stage = input.stageModel
  const params: TextTaskParams = { kind: input.kind }
  if (input.progress) params.progress = input.progress
  if (input.storyboardIds?.length) params.storyboardIds = input.storyboardIds
  if (input.scope) params.scope = input.scope
  const configId = stage ? stage.configId : input.configId
  if (configId) params.configId = configId
  if (stage) {
    params.stage = stage.stage
    params.model_used = stageModelUsed(stage)
  }
  if (input.retryOf) params.retry_of = input.retryOf
  if (input.restart) params.restart = input.restart
  if (input.retryOf) {
    const parent = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, input.retryOf)).get()
    if (parseTextTaskParams(parent?.params)?.requeued === true) {
      params.requeued = true
      params.auto_retry = 1
    }
  }

  const res = await db.insert(schema.sysTask).values({
    type: 'text',
    episodeId: input.episodeId,
    dramaId: input.dramaId ?? null,
    storyboardId: input.storyboardId ?? null,
    propId: input.propId ?? null,
    provider: stage ? stage.provider : (input.provider ?? null),
    model: stage ? stage.model : (input.model ?? null),
    prompt: input.prompt ?? null,
    params: JSON.stringify(params),
    status: input.queued ? 'queued' : 'processing',
    createdAt: ts,
    updatedAt: ts,
  })
  return getInsertId(res)
}

/** Only the first admitted LLM call transitions a queued task into processing. */
export async function markTextTaskStarted(id: number): Promise<void> {
  await db.update(schema.sysTask)
    .set({ status: 'processing', updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.status, 'queued')))
}

/** 合并写 params（保留 kind/storyboardIds 等其它键）；花名册与画像外貌等任务也复用这套读-合-写 */
export async function patchTextTaskParams(id: number, patch: Partial<TextTaskParams>): Promise<void> {
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!row) return
  const merged = { ...(parseTextTaskParams(row.params) || {}), ...patch }
  await db.update(schema.sysTask)
    .set({ params: JSON.stringify(merged), updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
}

/** Persist the endpoint actually used for the task's primary model call. */
export async function recordTextTaskAttempt(
  id: number,
  _attempt: { config_id: number; model: string; error_class: string | null },
  actual?: { configId: number; provider: string; model: string; name: string; vision: boolean },
): Promise<void> {
  if (!actual) return
  const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!row) return
  const params = parseTextTaskParams(row.params)
  if (!params) return
  params.model_used = {
    config_id: actual.configId, provider: actual.provider, model: actual.model,
    name: actual.name, vision: actual.vision,
  }
  db.update(schema.sysTask).set({
    params: JSON.stringify(params), updatedAt: now(),
    provider: actual.provider, model: actual.model,
  }).where(eq(schema.sysTask.id, id)).run()
}

export async function updateTextTaskProgress(id: number, progress: TextTaskProgress): Promise<void> {
  await patchTextTaskParams(id, { progress })
}

/** 思考内容落盘进度（Issue #19）：reasoning_chars 为累计字符数，由 reasoning-sink 节流调用 */
export async function updateTextTaskReasoningChars(id: number, chars: number): Promise<void> {
  await patchTextTaskParams(id, { reasoning_chars: chars })
}

export async function finishTextTask(
  id: number,
  status: 'completed' | 'failed',
  extra: { errorMsg?: string | null; error?: unknown; progress?: TextTaskProgress; outputText?: string } = {},
): Promise<void> {
  if (extra.progress) await patchTextTaskParams(id, { progress: extra.progress })
  // 最终正文全文保存（Issue #19，Q5 不截断），只在详情接口透出，不进任务列表
  if (typeof extra.outputText === 'string' && extra.outputText) {
    await patchTextTaskParams(id, { output_text: extra.outputText })
  }
  if (status === 'failed') {
    const row = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    const params = row ? parseTextTaskParams(row.params) : null
    // 模型类错误自动换模型重排一次（#77）；auto_retry_from 标记保证最多两次尝试
    if (row && params?.restart && !params.auto_retry_from
      && (isModelError(extra.error) || isModelError(extra.errorMsg ?? ''))) {
      // 静态 import 会形成 text-task ⇄ text-task-autoretry 的循环（后者依赖本文件的解析/写入），
      // 这里按运行时需要延迟加载。
      const { requeueFirstModelFailure } = await import('./text-task-autoretry.js')
      if (await requeueFirstModelFailure(id, extra.error ?? extra.errorMsg ?? '', true)) {
        await db.update(schema.sysTask)
          .set({ status: 'cancelled', errorMsg: '模型错误，已换模型重新排队', updatedAt: now() })
          .where(eq(schema.sysTask.id, id))
        return
      }
    }
  }
  const ts = now()
  // 文本任务没有媒体产物：只有成功完成才算一次「产出」，失败行不写生成时间
  const stamp = status === 'completed' ? completionStamp(ts) : { completedAt: ts }
  await db.update(schema.sysTask)
    .set({ status, errorMsg: extra.errorMsg ?? null, updatedAt: ts, ...stamp })
    .where(eq(schema.sysTask.id, id))
}

/** Cancel a text task without recording it as a successful output. */
export async function cancelTextTask(id: number, reason: string): Promise<void> {
  const ts = now()
  await db.update(schema.sysTask)
    .set({ status: 'cancelled', errorMsg: reason, completedAt: ts, updatedAt: ts })
    .where(and(eq(schema.sysTask.id, id), inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES)))
}

/** 该集该类型是否有正在运行的文本任务（取代原来的内存 Map 判重） */
export async function findActiveTextTask(episodeId: number, kind: TextTaskKind, excludeId?: number): Promise<SysTaskRow | null> {
  const rows = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'text'),
    eq(schema.sysTask.episodeId, episodeId),
    inArray(schema.sysTask.status, ACTIVE_TASK_STATUSES),
  ))
  return rows.find(r => r.id !== excludeId && textTaskKindOf(r) === kind) ?? null
}

/** 该集该类型最近一次任务（状态页展示用；从未跑过为 null） */
export async function findLatestTextTask(episodeId: number, kind: TextTaskKind): Promise<SysTaskRow | null> {
  const rows = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'text'), eq(schema.sysTask.episodeId, episodeId)))
    .orderBy(desc(schema.sysTask.id))
  return rows.find(r => textTaskKindOf(r) === kind) ?? null
}

/** sys_task 状态 → 文本任务对外状态（历史接口的 running/done/error 三态） */
export function textTaskOutcome(status: string | null | undefined): 'running' | 'done' | 'error' {
  if (status === 'queued' || status === 'processing') return 'running'
  if (status === 'completed') return 'done'
  return 'error'
}

/** 批量提示词任务的对外状态（关键帧 / 视频提示词共用，接口结构与改造前保持一致） */
export interface PromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  phase?: 'spine' | 'shots'
  started_at: string
  finished_at?: string
  error?: string
}

export function promptBatchStatusFrom(row: SysTaskRow | null): PromptBatchStatus | null {
  if (!row) return null
  const progress = parseTextTaskParams(row.params)?.progress
  return {
    status: textTaskOutcome(row.status),
    total: progress?.total ?? 0,
    completed: progress?.completed ?? 0,
    failed: progress?.failed ?? 0,
    current_storyboard_id: progress?.current_storyboard_id,
    phase: progress?.phase,
    started_at: row.createdAt,
    finished_at: row.completedAt || undefined,
    error: row.errorMsg || undefined,
  }
}
