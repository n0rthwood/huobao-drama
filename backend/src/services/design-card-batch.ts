import { isFirstAgentFailureSafe, runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-restart.js'

/**
 * 设计卡填写（Issue #57，替换 #49 的 `shot-intent-batch.ts`）— 为纪录片分镜逐镜跑
 * `storyboard_breaker`，只写 `design_card`。
 *
 * 与关键帧/视频提示词批量同形：落 `sys_task(type='text', params.kind='design_card')`，
 * 进度写 `params.progress`，前端轮询。
 * 工具集用 `storyboardPromptScope='design_card'` 收窄：模型只能看上下文、读图、写设计卡，
 * **不能**调用 `save_storyboards` 重拆整集（重算一镜把整集旁白冲掉是最贵的事故）。
 *
 * 续跑语义：指定 ids 就重算这几镜，否则只补 `blank` / `stale` 的镜（已 pending/confirmed 的不动）。
 * 覆盖前把旧卡写进本次任务的 `params.previous_card`（主进程裁决 S2：不存 `__prev`）。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { loadDesignCardContext, resolveDesignCard } from './design-card-context.js'
import { estimateCardBudget, toDesignCardStatus, type DesignCardStatus } from './design-card.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  patchTextTaskParams,
  promptBatchStatusFrom,
  updateTextTaskProgress,
  type PromptBatchStatus,
  type TextTaskProgress,
} from './text-task.js'
import { resolveStageModel } from './ai-stages.js'
import { resolveDramaProjectType } from './project-type.js'
import { requireConfirmedSkeleton } from './narration-skeleton.js'
import { episodeTtsValidity, toBlocked, TtsRequiredError, type TtsBlockedShot } from './narration-tts-gate.js'
import { buildEvidenceImages, evidenceMessageParts } from './evidence-images.js'
import { now } from '../utils/response.js'

export type DesignCardBatchStatus = PromptBatchStatus

const FILLABLE: DesignCardStatus[] = ['blank', 'stale']

/** 设计卡批量的启动结果：total=-1 表示本集已有同类任务在跑 */
export interface DesignCardBatchStart {
  started: boolean
  total: number
}

/** 指定 storyboardIds 时只重填这几镜（即使已确认）；否则补齐所有空白 / 过期的镜头 */
export async function startDesignCardBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<DesignCardBatchStart> {
  if (await findActiveTextTask(episodeId, 'design_card', opts.retryOf)) return { started: false, total: -1 }
  const documentary = resolveDramaProjectType(dramaId) === 'documentary'
  // 设计卡是按**实测配音时长**填的（#70）：骨架必须已确认，逐镜必须有当前有效配音。
  // 剧情项目没有这条链路，行为与改动前逐字相同。
  if (documentary) await requireConfirmedSkeleton(episodeId)

  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const alive = rows.filter(sb => !sb.deletedAt)
  const requested = storyboardIds?.length
    ? alive.filter(sb => storyboardIds.includes(sb.id))
    : alive.filter(sb => FILLABLE.includes(toDesignCardStatus(sb.designCardStatus)))
  if (!requested.length) return { started: false, total: 0 }

  // 没有当前有效配音的镜一个都不进批次：不调模型、不置 ai_filling、不写卡。
  // 部分失败只挡住受影响的镜，其余镜照常填（契约：partial failure only blocks affected shots）。
  const measured = new Map<number, number>()
  const blocked: TtsBlockedShot[] = []
  let pending = requested
  if (documentary) {
    const validity = await episodeTtsValidity(episodeId, { rows: alive, storyboardIds: requested.map(sb => sb.id) })
    pending = requested.filter((sb) => {
      const item = validity.get(sb.id)
      if (item?.valid && item.duration_s !== null) {
        measured.set(sb.id, item.duration_s)
        return true
      }
      if (item) blocked.push(toBlocked(item))
      return false
    })
    if (!pending.length) throw new TtsRequiredError(blocked)
  }

  const resolved = await resolveStageModel('design_card', opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: pending.length }
  const taskId = await createTextTask({
    kind: 'design_card',
    episodeId,
    dramaId,
    stageModel: resolved,
    storyboardIds: pending.map(sb => sb.id),
    progress,
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'design_card', args: { episodeId, dramaId, opts, storyboardIds } },
  })
  // 覆盖前留痕：这一批每镜的旧卡原样存进本次任务参数，人工可据此回退。
  // 被配音门禁挡掉的镜也记下来：任务详情要能说清「哪几镜没进这一批、为什么」。
  await patchTextTaskParams(taskId, {
    previous_card: pending.map(sb => ({
      storyboard_id: sb.id,
      combo: sb.combo ?? null,
      design_card: sb.designCard ?? null,
      design_card_status: toDesignCardStatus(sb.designCardStatus),
    })),
    tts_blocked: blocked,
  })

  const outputs: string[] = []
  logTaskStart('DesignCard', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  void runWithTextTask(taskId, async () => {
    const agent = mastra.getAgent('storyboard_breaker')
    if (!agent) throw new Error('分镜 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      textTaskId: taskId,
      storyboardPromptScope: 'design_card',
      modelOverride: resolved.model,
      textConfigId: resolved.configId ?? undefined,
    })
    const sink = createReasoningSink(taskId)
    for (const sb of pending) {
      const previousStatus = toDesignCardStatus(sb.designCardStatus)
      requestContext.set('storyboardId', sb.id)
      progress.current_storyboard_id = sb.id
      await updateTextTaskProgress(taskId, progress)
      logTaskProgress('DesignCard', 'batch-shot', {
        episodeId, storyboardId: sb.id,
        index: progress.completed + progress.failed + 1, total: progress.total,
      })
      sink.heading(`分镜 #${sb.storyboardNumber}`)
      // 运行期置 ai_filling：界面显示 loader，对同一镜的 PUT / confirm 返回 409 card_busy
      await db.update(schema.storyboards)
        .set({ designCardStatus: 'ai_filling', updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
      const measuredSeconds = measured.get(sb.id)
      const budgetRule = measuredSeconds === undefined
        ? '两段之和必须装得下旁白'
        : `两段之和必须 ≥ 实测配音 ${measuredSeconds} 秒`
      try {
        const evidence = await buildEvidenceImages(episodeId, { storyboardIds: [sb.id] })
        const result = await runAgent(agent, [{
          role: 'user',
          content: evidenceMessageParts(`请为分镜 #${sb.storyboardNumber}(ID:${sb.id}) 填写设计卡（design_card），严格遵循 documentary-storyboard 技能里「设计卡」一节。${measuredSeconds === undefined ? '' : `
本镜旁白的**实测配音时长是 ${measuredSeconds} 秒**（已经配音完成，不是估算）：时长预算 budget 必须以这个实测值为准，不要再按字数估算。`}
先调用 read_storyboard_context：读本镜的 narration_text（旁白原文），读前后镜的设计卡（同一段落要共用底图与图层状态，不要各写各的），读 props 里每张证据素材的 semantics（只有名称与 id，没有坐标）与 exposition_assets。
然后按这个顺序想：这一镜要让观众 get 到哪几个信息点（info_points，每条标明 via=layer/generated/narration_only）→ 图层段计划（layer_plan：底图 base、必须标注 must_mark、计划图层 planned_layers 与各自出现时刻 at_s）→ 生成段计划（gen_plan：参考素材 reference_assets、首/中/尾各一句话）→ 两段的时长预算 budget（layer_s ≤30，gen_s ≤15，${budgetRule}）→ rationale 写明理由。
段组合只写 suggested_combo（A 只图层 / B 只生成 / C 图层→生成 / D 生成→图层），**绝不自己决定 combo**：组合由人确认，服务端会忽略模型给的 combo。
必要时用 read_image 打开证据素材的局部细节；图上没有的东西就在 rationale 里写明并降级，不要凭空写一个不存在的要素。
最后调用 update_storyboard 保存，参数只传 storyboard_id 和 design_card 两个键。`, evidence),
        }], { maxSteps: 10, requestContext }, sink)
        outputs.push(`分镜 #${sb.storyboardNumber}：${result.text || ''}`)
        // 以实际落库为准判定成败
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        if ((fresh?.designCard || '').trim()) {
          progress.completed++
          await db.update(schema.storyboards)
            .set({ designCardStatus: 'pending', designCardConfirmedAt: null, updatedAt: now() })
            .where(eq(schema.storyboards.id, sb.id))
        } else {
          progress.failed++
          await db.update(schema.storyboards)
            .set({ designCardStatus: previousStatus, updatedAt: now() })
            .where(eq(schema.storyboards.id, sb.id))
          logTaskError('DesignCard', 'batch-shot', { storyboardId: sb.id, error: 'agent finished but design_card is empty' })
        }
      } catch (err: unknown) {
        progress.failed++
        await db.update(schema.storyboards)
          .set({ designCardStatus: previousStatus, updatedAt: now() })
          .where(eq(schema.storyboards.id, sb.id))
        if (!progress.completed && isFirstAgentFailureSafe(err)) throw err
        logTaskError('DesignCard', 'batch-shot', { storyboardId: sb.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
    .then(async () => {
      progress.current_storyboard_id = undefined
      await finishTextTask(taskId, 'completed', { progress, outputText: outputs.filter(s => s.trim()).join('\n\n') })
      logTaskSuccess('DesignCard', 'batch', { episodeId, total: progress.total, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : '设计卡填写失败'
      progress.current_storyboard_id = undefined
      // 进程级异常：把还挂在 ai_filling 的镜放回去，否则整集永远 409
      for (const sb of pending) {
        await db.update(schema.storyboards)
          .set({ designCardStatus: toDesignCardStatus(sb.designCardStatus), updatedAt: now() })
          .where(eq(schema.storyboards.id, sb.id))
      }
      await finishTextTask(taskId, 'failed', { errorMsg: message, progress })
      await requeueFirstModelFailure(taskId, err, isFirstAgentFailureSafe(err))
      logTaskError('DesignCard', 'batch', { episodeId, error: message })
    })
  return { started: true, total: pending.length }
}

export async function getDesignCardBatchStatus(episodeId: number): Promise<DesignCardBatchStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'design_card'))
}

export interface DesignCardAuditItem {
  storyboard_id: number
  shot_number: number
  narration_text: string
  combo: string | null
  suggested_combo: string | null
  status: DesignCardStatus
  confirmed_at: string | null
  stale_reason: string | null
  has_card: boolean
  unresolved: number
  issues: { code: string; severity: string; message: string }[]
  /** 当前有效配音的实测秒数；没有当前有效配音时为 null（#70：不给估算） */
  narration_measured_s: number | null
  tts: { valid: boolean; reason: string | null; message: string | null }
  budget: { layer_s: number | null; gen_s: number | null }
}

/** 整集设计卡的结构机检（验收 1 / 批量范围清单的同一份快照） */
export async function auditEpisodeDesignCards(episodeId: number): Promise<DesignCardAuditItem[]> {
  const ctx = loadDesignCardContext(episodeId)
  const validity = await episodeTtsValidity(episodeId)
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  return rows.filter(sb => !sb.deletedAt).map((sb) => {
    const tts = validity.get(sb.id)
    // 预算一律按**当前有效配音的实测秒数**算；没有有效配音时不给估算，列出 null 让界面显示「待配音」
    const measured = tts?.valid ? tts.duration_s : null
    const { combo, card, issues } = resolveDesignCard(sb, ctx, null, measured)
    const budget = estimateCardBudget(card, sb.narrationText, measured)
    return {
      storyboard_id: sb.id,
      shot_number: sb.storyboardNumber,
      narration_text: sb.narrationText || '',
      combo,
      suggested_combo: card?.suggested_combo ?? null,
      status: toDesignCardStatus(sb.designCardStatus),
      confirmed_at: sb.designCardConfirmedAt ?? null,
      stale_reason: sb.designCardStaleReason ?? null,
      has_card: !!card,
      unresolved: issues.filter(issue => issue.code === 'unresolved_ref').length,
      issues: issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      narration_measured_s: measured,
      tts: { valid: tts?.valid === true, reason: tts?.reason ?? null, message: tts?.message ?? null },
      budget: { layer_s: budget.layer_s, gen_s: budget.gen_s },
    }
  })
}
