import { isFirstAgentFailureSafe, runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-autoretry.js'

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
  parseTextTaskParams,
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
import { narrationCharCount } from './narration.js'
import { runObservedWork } from './task-observability.js'
import { buildSampleKey, buildWorkPlan, stageEstimateOf, type StageWorkEstimate } from './task-estimate.js'
import { buildDesignCardGroundingInstruction } from './design-card-grounding.js'

export type DesignCardBatchStatus = PromptBatchStatus

const FILLABLE: DesignCardStatus[] = ['blank', 'stale']

/**
 * 模型跑完但没有落下一张可实现的设计卡（依据不足被写工具拒绝，或根本没调用保存）。
 * 这一镜按失败计：旧卡不动，原因进逐镜结果，观测样本也标失败，不参与 ETA 速率。
 */
export class DesignCardNotSavedError extends Error {}

/** 设计卡批量的启动结果：total=-1 表示本集已有同类任务在跑 */
export interface DesignCardBatchStart {
  started: boolean
  total: number
}

/** 本次批量真正会进模型的镜头（启动与「开始前预估」共用同一份口径，避免两套计数） */
async function selectDesignCardPending(episodeId: number, documentary: boolean, storyboardIds?: number[]): Promise<{
  requested: typeof schema.storyboards.$inferSelect[]
  pending: typeof schema.storyboards.$inferSelect[]
  measured: Map<number, number>
  blocked: TtsBlockedShot[]
}> {
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const alive = rows.filter(sb => !sb.deletedAt)
  // 省略 storyboardIds = 默认范围（空白/过期，纪录片再加缺 combo 的）；
  // **显式传数组**只在这几镜里挑，显式空数组就是「一镜都不处理」——
  // 绝不把「选了 0 镜」悄悄扩大成整集（预算 6 镜的请求不能变成整集）。
  const requested = storyboardIds !== undefined
    ? alive.filter(sb => storyboardIds.includes(sb.id))
    : alive.filter(sb => FILLABLE.includes(toDesignCardStatus(sb.designCardStatus))
      || (documentary && !sb.combo && toDesignCardStatus(sb.designCardStatus) === 'pending'))

  // 没有当前有效配音的镜一个都不进批次：不调模型、不置 ai_filling、不写卡。
  // 部分失败只挡住受影响的镜，其余镜照常填（契约：partial failure only blocks affected shots）。
  const measured = new Map<number, number>()
  const blocked: TtsBlockedShot[] = []
  let pending = requested
  if (documentary && requested.length) {
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
  }
  return { requested, pending, measured, blocked }
}

/**
 * 「开始前」的字数与历史 ETA（#87 §D）：本次会填哪几镜、共多少源字数，
 * 以及同阶段同实际模型的历史成功样本给出的预计耗时。没有样本就返回 null，不编固定秒数。
 */
export async function designCardWorkEstimate(
  episodeId: number,
  dramaId: number,
  storyboardIds?: number[],
  opts: { model?: string; configId?: number } = {},
): Promise<StageWorkEstimate> {
  const documentary = resolveDramaProjectType(dramaId) === 'documentary'
  const { pending, blocked } = await selectDesignCardPending(episodeId, documentary, storyboardIds)
  const resolved = await resolveStageModel('design_card', opts)
  const plan = buildWorkPlan({
    stage: 'design_card',
    unit: 'shot',
    sampleKey: buildSampleKey({ stage: 'design_card', configId: resolved.configId, model: resolved.model }),
    items: pending.map(sb => ({
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      source_chars: narrationCharCount(sb.narrationText),
    })),
  })
  return { ...stageEstimateOf(plan, resolved.configId ?? null, resolved.model), blocked_units: blocked.length }
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

  const { requested, pending, measured, blocked } = await selectDesignCardPending(episodeId, documentary, storyboardIds)
  if (!requested.length) return { started: false, total: 0 }
  if (documentary && !pending.length) throw new TtsRequiredError(blocked)

  const resolved = await resolveStageModel('design_card', opts)
  // 计量分组（#87 §D）：设计卡逐镜一项，按「阶段 + 实际配置/模型」分池，绝不与骨架整集混在一起
  const sampleKey = buildSampleKey({ stage: 'design_card', configId: resolved.configId, model: resolved.model })
  const sourceChars = new Map<number, number>(pending.map(sb => [sb.id, narrationCharCount(sb.narrationText)]))
  const progress: TextTaskProgress = {
    completed: 0,
    failed: 0,
    total: pending.length,
    items: pending.map(sb => ({
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      state: 'pending' as const,
      reason: null,
    })),
  }
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
  // work_plan 必须在开跑**之前**落库：浏览器刷新与后端重启都按它复原「总量 / 源字数 / 分组口径」。
  await patchTextTaskParams(taskId, {
    previous_card: pending.map(sb => ({
      storyboard_id: sb.id,
      combo: sb.combo ?? null,
      design_card: sb.designCard ?? null,
      design_card_status: toDesignCardStatus(sb.designCardStatus),
    })),
    tts_blocked: blocked,
    work_plan: buildWorkPlan({
      stage: 'design_card',
      unit: 'shot',
      sampleKey,
      items: pending.map(sb => ({
        storyboard_id: sb.id,
        storyboard_number: sb.storyboardNumber,
        source_chars: sourceChars.get(sb.id) ?? 0,
      })),
    }),
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
      const progressItem = progress.items!.find(item => item.storyboard_id === sb.id)!
      requestContext.set('storyboardId', sb.id)
      const comboOnly = documentary && !!sb.designCard && !sb.combo && previousStatus === 'pending'
      requestContext.set('designCardComboOnly' as never, comboOnly as never)
      requestContext.set('designCardSaved' as never, false as never)
      requestContext.set('designCardError' as never, null as never)
      progress.current_storyboard_id = sb.id
      progressItem.state = 'processing'
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
        // 观测窗口 = 这一镜的全部真实工作（取证图、模型调用、工具往返、落库判定）。
        // 没保存成可实现的卡就抛错：这一项按失败计，不进成功样本池，也不污染 ETA 速率。
        const result = await runObservedWork({
          taskId,
          stage: 'design_card',
          sourceChars: sourceChars.get(sb.id) ?? 0,
          sampleKey,
          storyboardId: sb.id,
          storyboardNumber: sb.storyboardNumber,
        }, async () => {
          const evidence = await buildEvidenceImages(episodeId, { storyboardIds: [sb.id] })
          const agentResult = await runAgent(agent, [{
            role: 'user',
            content: evidenceMessageParts(`请为分镜 #${sb.storyboardNumber}(ID:${sb.id}) 填写设计卡（design_card），严格遵循 documentary-storyboard 技能里「设计卡」一节与 layer-text-design 技能的模板文本框规则。${measuredSeconds === undefined ? '' : `
本镜旁白的**实测配音时长是 ${measuredSeconds} 秒**（已经配音完成，不是估算）：时长预算 budget 必须以这个实测值为准，不要再按字数估算。`}
先调用 read_storyboard_context，读取本镜旁白、前后镜设计卡及资产，并读取其中的 text_spec（成套位置 layouts、类型 roles、逐字段容量 capacity）：屏幕文字一律用 type:'text' 模板文本框 + layer_plan.text_layout，字数上限只能取自 text_spec.capacity。
${buildDesignCardGroundingInstruction(loadDesignCardContext(episodeId).assets)}
${comboOnly ? `本卡已有人工内容，只补选 combo，不重写卡片。现有卡：${sb.designCard}` : `规划信息点、图层段、生成段与预算（${budgetRule}），并填写 rationale。`}
填写 combo（A 只图层 / B 只生成 / C 图层→生成 / D 生成→图层），同时可填写 suggested_combo；已有组合将保留。
最后调用 update_storyboard 保存，参数只传 storyboard_id 和 design_card 两个键。`, evidence),
          }], { maxSteps: 10, requestContext }, sink)
          // 以实际落库为准判定成败：模型说完话不等于卡已保存
          const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
          const saved = requestContext.get('designCardSaved' as never) === true
            && !!(fresh?.designCard || '').trim()
            && (!comboOnly || !!fresh?.combo)
          if (!saved) {
            const reason = requestContext.get('designCardError' as never) as unknown
            throw new DesignCardNotSavedError(typeof reason === 'string' && reason.trim()
              ? reason
              : '模型结束但没有保存可实现的设计卡（依据不足时这一镜按失败计，旧卡原样保留）')
          }
          return agentResult
        })
        outputs.push(`分镜 #${sb.storyboardNumber}：${result.text || ''}`)
        progress.completed++
        progressItem.state = 'completed'
        progressItem.reason = null
        await db.update(schema.storyboards)
          .set({ designCardStatus: 'pending', designCardConfirmedAt: null, updatedAt: now() })
          .where(eq(schema.storyboards.id, sb.id))
      } catch (err: unknown) {
        progress.failed++
        progressItem.state = 'failed'
        progressItem.reason = err instanceof Error ? err.message : String(err)
        if (err instanceof DesignCardNotSavedError) {
          // 什么都没写进去：旧卡与旧状态原样保留，只记下这一镜为什么没成
          await db.update(schema.storyboards)
            .set({ designCardStatus: previousStatus, designCardStaleReason: err.message, updatedAt: now() })
            .where(eq(schema.storyboards.id, sb.id))
          logTaskError('DesignCard', 'batch-shot', { storyboardId: sb.id, error: err.message })
        } else {
          await db.update(schema.storyboards)
            .set({ designCardStatus: previousStatus, updatedAt: now() })
            .where(eq(schema.storyboards.id, sb.id))
          if (!progress.completed && isFirstAgentFailureSafe(err)) throw err
          logTaskError('DesignCard', 'batch-shot', { storyboardId: sb.id, error: progressItem.reason })
        }
      }
      await updateTextTaskProgress(taskId, progress)
    }
  })
    .then(async () => {
      progress.current_storyboard_id = undefined
      // 模型跑完 ≠ 批次成功：一镜都没保存成就是整批失败，不用 100% 掩盖失败
      const allFailed = progress.completed === 0 && progress.failed > 0
      await finishTextTask(taskId, allFailed ? 'failed' : 'completed', {
        progress,
        outputText: outputs.filter(s => s.trim()).join('\n\n'),
        errorMsg: progress.failed ? `${progress.failed}/${progress.total} 个镜头未能保存可实现的设计卡` : null,
      })
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

/**
 * 启动恢复（#87 验收 5）：进程在填卡途中被杀，镜头会永远停在 `ai_filling`，
 * 之后所有 PUT / confirm 都 409。这里按**已落库事实**把它们放回可审状态：
 *
 * - 这一镜在中断前已经保存了新卡 → `pending`（待人工审阅），不谎称已确认；
 * - 没保存 → 恢复任务 `params.previous_card` 里留痕的旧状态，旧卡原样保留；
 * - 没有留痕可依据 → 有卡按 `pending`、无卡按 `blank`。
 *
 * 只改状态，不重跑、不删层、不覆盖任何已完成镜（不新增自动重试策略）。
 * 由启动恢复链调用（index.ts），与观测层把在飞工作项标 interrupted 是两件独立的事。
 */
export async function releaseInterruptedDesignCardShots(): Promise<number> {
  const stuck = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.designCardStatus, 'ai_filling'))
  const alive = stuck.filter(sb => !sb.deletedAt)
  if (!alive.length) return 0

  const previousByShot = new Map<number, { design_card: string | null; design_card_status: DesignCardStatus }>()
  const episodeIds = [...new Set(alive.map(sb => sb.episodeId))]
  for (const episodeId of episodeIds) {
    // 还在跑的批次不碰：恢复只针对执行线程已经丢失的任务
    if (await findActiveTextTask(episodeId, 'design_card')) continue
    const task = await findLatestTextTask(episodeId, 'design_card')
    const previous = parseTextTaskParams(task?.params)?.previous_card
    if (!Array.isArray(previous)) continue
    for (const entry of previous as Array<{ storyboard_id?: number; design_card?: string | null; design_card_status?: DesignCardStatus }>) {
      if (!Number.isInteger(entry?.storyboard_id)) continue
      previousByShot.set(entry.storyboard_id!, {
        design_card: entry.design_card ?? null,
        design_card_status: toDesignCardStatus(entry.design_card_status),
      })
    }
  }

  let released = 0
  for (const sb of alive) {
    if (await findActiveTextTask(sb.episodeId, 'design_card')) continue
    const prev = previousByShot.get(sb.id)
    const card = (sb.designCard || '').trim()
    const saved = !!card && card !== (prev?.design_card || '').trim()
    const status: DesignCardStatus = saved
      ? 'pending'
      : prev?.design_card_status ?? (card ? 'pending' : 'blank')
    await db.update(schema.storyboards)
      .set({
        designCardStatus: status,
        // 中断的镜绝不冒充已确认
        designCardConfirmedAt: status === 'confirmed' ? sb.designCardConfirmedAt : null,
        updatedAt: now(),
      })
      .where(eq(schema.storyboards.id, sb.id))
    released++
    logTaskError('DesignCard', 'startup-release', { storyboardId: sb.id, status, saved })
  }
  return released
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
  unresolved_layers: Array<{
    index: number; type: string; text: string; asset_id: number; asset_name: string | null
    asset_exists: boolean; semantic_id: string; semantic_name: string; available_semantics: Array<{ id: string; name: string; group: string }>
  }>
  video_generated: boolean
  /** 当前有效配音的实测秒数；没有当前有效配音时为 null（#70：不给估算） */
  narration_measured_s: number | null
  tts: { valid: boolean; reason: string | null; message: string | null; duration_ms: number | null }
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
    const unresolvedLayers = (card?.layer_plan?.planned_layers || []).flatMap((layer, index) => {
      const ref = layer.anchor
      if (!ref?.unresolved) return []
      const matches = ctx.assets.filter(asset => asset.id === ref.asset_id)
      const asset = matches.length === 1 ? matches[0] : undefined
      return [{
        index, type: layer.type, text: layer.text || '', asset_id: ref.asset_id,
        asset_name: asset?.name ?? null, asset_exists: !!asset,
        semantic_id: ref.semantic_id, semantic_name: ref.name,
        available_semantics: asset?.semantics ?? [],
      }]
    })
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
      unresolved_layers: unresolvedLayers,
      video_generated: !!sb.videoUrl,
      issues: issues.map(issue => ({ code: issue.code, severity: issue.severity, message: issue.message })),
      narration_measured_s: measured,
      tts: { valid: tts?.valid === true, reason: tts?.reason ?? null, message: tts?.message ?? null, duration_ms: tts?.duration_ms ?? null },
      budget: { layer_s: budget.layer_s, gen_s: budget.gen_s },
    }
  })
}
