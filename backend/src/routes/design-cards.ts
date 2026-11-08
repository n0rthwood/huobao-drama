/**
 * 分镜设计卡接口（Issue #57）。契约 §10 的裁决：新建独立文件，按 `api.route('/episodes', posters)`
 * 的双挂载先例分别挂到 `/api/v1/episodes` 与 `/api/v1/storyboards`，`routes/episodes.ts`
 * 只负责删掉旧的四条 intent 路由，冲突面最小。
 *
 * 状态机：任何写入 → `pending`；AI 填写中 → `ai_filling`（对同一镜的 PUT / confirm 返回 409 `card_busy`）；
 * `confirm` 要求 0 阻断，有警告需 `acknowledge:true`。段组合**没有默认值**，不选就确认不了。
 */
import { Hono } from 'hono'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, now, success } from '../utils/response.js'
import { logTaskError, logTaskSuccess } from '../utils/task-logger.js'
import { resolveDramaProjectType } from '../services/project-type.js'
import { assertGate } from '../services/workflow-gates.js'
import {
  COMBOS,
  INFO_POINT_VIAS,
  MAX_GEN_SEGMENT_SECONDS,
  MAX_LAYER_SEGMENT_SECONDS,
  PLANNED_LAYER_TYPES,
  serializeDesignCard,
  toCombo,
  toDesignCardStatus,
  type Combo,
  type DesignCardStatus,
} from '../services/design-card.js'
import { NARRATION_CHARS_PER_SECOND } from '../services/narration.js'
import {
  listBaseCandidates,
  loadDesignCardContext,
  resolveDesignCard,
  resolveDesignCardFrom,
} from '../services/design-card-context.js'
import { assertShotTtsReady, shotTtsValidity } from '../services/narration-tts-gate.js'
import { SkeletonNotConfirmedError } from '../services/narration-skeleton.js'
import {
  auditEpisodeDesignCards,
  getDesignCardBatchStatus,
  startDesignCardBatch,
  type DesignCardBatchStart,
} from '../services/design-card-batch.js'
import { reorderStoryboards } from '../services/storyboard-fill-gaps.js'
import { parseFillModelSelection, stageSelectionErrorPayload } from '../services/ai-stages.js'

type Ctx = Parameters<typeof badRequest>[0]

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function conflict(c: Ctx, message: string, code: string) {
  return c.json({ code: 409, error: code, message }, 409)
}

function rejected(c: Ctx, message: string, code: string, issues?: unknown) {
  return c.json({ code: 400, error: code, message, ...(issues ? { issues } : {}) }, 400)
}

/** 本镜对外的设计卡状态（PUT / confirm / unconfirm 三者同形） */
async function shotState(storyboardId: number) {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) return null
  const ctx = loadDesignCardContext(row.episodeId)
  // 时长口径只有一个：当前有效配音的实测秒数（#70）。没有有效配音就是 null，
  // 界面显示「待配音」，校验与展示都不给估算数字冒充实测。
  const tts = await shotTtsValidity(storyboardId)
  const measured = tts.valid ? tts.duration_s : null
  const { combo, card, issues } = resolveDesignCard(row, ctx, null, measured)
  return {
    storyboard_id: row.id,
    shot_number: row.storyboardNumber,
    narration_text: row.narrationText || '',
    combo,
    design_card: card,
    design_card_status: toDesignCardStatus(row.designCardStatus),
    design_card_confirmed_at: row.designCardConfirmedAt ?? null,
    design_card_stale_reason: row.designCardStaleReason ?? null,
    issues,
    narration_measured_s: tts.valid ? tts.duration_s : null,
    tts: { valid: tts.valid, reason: tts.reason, message: tts.message, duration_ms: tts.duration_ms },
  }
}

/** 已经有制作产物（渲染过的图层段 / 关键帧 / 视频）：改组合必须走 R5 的组合切换流程 */
async function hasProductionArtifacts(storyboardId: number): Promise<boolean> {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) return false
  if (row.firstFrameImage || row.midFrameImage || row.lastFrameImage || row.videoUrl || row.composedVideoUrl) return true
  const [segment] = await db.select().from(schema.storyboardLayerSegments)
    .where(eq(schema.storyboardLayerSegments.storyboardId, storyboardId))
  return !!segment?.renderPath
}

async function loadDocumentaryShot(c: Ctx, storyboardId: number) {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row || row.deletedAt) return { error: notFound(c, '分镜不存在') }
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, row.episodeId))
  if (resolveDramaProjectType(episode?.dramaId ?? 0) !== 'documentary') {
    return { error: badRequest(c, '只有纪录片项目的分镜才有设计卡') }
  }
  return { row }
}

// ─── /api/v1/storyboards ──────────────────────────────────────

const shots = new Hono()

// PUT /storyboards/:id/design-card — 覆盖写段组合与设计卡；任何写入置 pending
shots.put('/:id/design-card', async (c) => {
  const id = Number(c.req.param('id'))
  const loaded = await loadDocumentaryShot(c, id)
  if ('error' in loaded) return loaded.error
  const { row } = loaded
  const status = toDesignCardStatus(row.designCardStatus)
  if (status === 'ai_filling') return conflict(c, 'AI 正在填写这一镜的设计卡，请等它跑完再改', 'card_busy')
  // 设计卡写入的硬前置（#70）：本镜必须有当前有效配音——卡里的段时长是按实测时长排的
  const tts = await assertShotTtsReady(id)

  const body = await readJson(c)
  const wantsCombo = 'combo' in body
  const wantsCard = 'design_card' in body
  if (!wantsCombo && !wantsCard) return badRequest(c, '请至少传 combo 或 design_card')

  const combo: Combo | null = wantsCombo ? toCombo(body.combo) : toCombo(row.combo)
  if (wantsCombo && body.combo != null && body.combo !== '' && !combo) {
    return badRequest(c, 'combo 只支持 A / B / C / D，或留空表示还没选')
  }
  // 已确认 + 有制作产物时改组合：归 R5 的组合切换流程，这里只拦住并指路
  if (status === 'confirmed' && wantsCombo && combo !== toCombo(row.combo) && await hasProductionArtifacts(id)) {
    return c.json({
      code: 400,
      error: 'gate_blocked',
      gate: 'combo_switch',
      message: '本镜已确认且已有制作产物，改段组合要走「组合切换」流程（会影响已出的关键帧 / 片段 / 视频）',
    }, 400)
  }

  const ctx = loadDesignCardContext(row.episodeId)
  const rawCard = wantsCard ? body.design_card : (row.designCard ? JSON.parse(row.designCard) : null)
  const resolved = resolveDesignCardFrom(rawCard, combo, ctx, row, tts.duration_s)
  // 预算硬上限超限直接拒存：段条一旦存进库，下游（图层段 / 视频档位）就会按它排期
  const overLayer = resolved.issues.find(issue => issue.code === 'budget_over_layer')
  if (overLayer) return rejected(c, overLayer.message, 'budget_over_layer', resolved.issues)
  const overGen = resolved.issues.find(issue => issue.code === 'budget_over_gen')
  if (overGen) return rejected(c, overGen.message, 'budget_over_gen', resolved.issues)

  await db.update(schema.storyboards).set({
    combo,
    ...(wantsCard ? { designCard: serializeDesignCard(resolved.card) } : {}),
    designCardStatus: 'pending' satisfies DesignCardStatus,
    designCardConfirmedAt: null,
    designCardStaleReason: null,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))

  logTaskSuccess('DesignCardAPI', 'save', { storyboardId: id, combo: combo ?? 'none', issues: resolved.issues.length })
  return success(c, await shotState(id))
})

// POST /storyboards/:id/design-card/confirm — 人工背书；0 阻断才放行，有警告需 acknowledge
shots.post('/:id/design-card/confirm', async (c) => {
  const id = Number(c.req.param('id'))
  const loaded = await loadDocumentaryShot(c, id)
  if ('error' in loaded) return loaded.error
  const { row } = loaded
  if (toDesignCardStatus(row.designCardStatus) === 'ai_filling') {
    return conflict(c, 'AI 正在填写这一镜的设计卡，请等它跑完再确认', 'card_busy')
  }
  // 确认也要有当前有效配音（#70）：音频换了/失效了，卡里的时长关系就不再成立
  const tts = await assertShotTtsReady(id)
  const body = await readJson(c)
  const ctx = loadDesignCardContext(row.episodeId)
  const { card, issues } = resolveDesignCard(row, ctx, null, tts.duration_s)

  const blocking = issues.filter(issue => issue.severity === 'block')
  if (blocking.length) {
    return rejected(c, `设计卡未通过结构校验：${blocking.map(issue => issue.message).join('；')}`, 'blocked', issues)
  }
  if (!card) return rejected(c, '本镜还没有设计卡，无法确认', 'blocked', issues)
  const warnings = issues.filter(issue => issue.severity === 'warn')
  if (warnings.length && body.acknowledge !== true) {
    return rejected(c, `设计卡还有 ${warnings.length} 条提醒，确认前请勾选「已知悉」`, 'needs_acknowledge', issues)
  }

  await db.update(schema.storyboards).set({
    designCardStatus: 'confirmed' satisfies DesignCardStatus,
    designCardConfirmedAt: now(),
    designCardStaleReason: null,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))
  logTaskSuccess('DesignCardAPI', 'confirm', { storyboardId: id, acknowledged: warnings.length > 0 })
  return success(c, await shotState(id))
})

// POST /storyboards/:id/design-card/unconfirm — 撤销确认，回到待审
shots.post('/:id/design-card/unconfirm', async (c) => {
  const id = Number(c.req.param('id'))
  const loaded = await loadDocumentaryShot(c, id)
  if ('error' in loaded) return loaded.error
  if (toDesignCardStatus(loaded.row.designCardStatus) === 'ai_filling') {
    return conflict(c, 'AI 正在填写这一镜的设计卡，请等它跑完', 'card_busy')
  }
  await db.update(schema.storyboards).set({
    designCardStatus: 'pending' satisfies DesignCardStatus,
    designCardConfirmedAt: null,
    updatedAt: now(),
  }).where(eq(schema.storyboards.id, id))
  return success(c, await shotState(id))
})

// ─── /api/v1/episodes ─────────────────────────────────────────

const app = new Hono()

// GET /episodes/:id/design-card-context — 设计卡页的候选项：资产 + 语义条目 + 底图候选 + 上限
app.get('/:id/design-card-context', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  return success(c, {
    assets: loadDesignCardContext(id).assets,
    base_candidates: await listBaseCandidates(id),
    combos: COMBOS,
    info_point_vias: INFO_POINT_VIAS,
    planned_layer_types: PLANNED_LAYER_TYPES,
    limits: {
      layer_s: MAX_LAYER_SEGMENT_SECONDS,
      gen_s: MAX_GEN_SEGMENT_SECONDS,
      narration_cps: NARRATION_CHARS_PER_SECOND,
    },
  })
})

// GET /episodes/:id/design-cards/audit — 整集设计卡的结构机检（批量范围清单同一份快照）
app.get('/:id/design-cards/audit', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  return success(c, await auditEpisodeDesignCards(id))
})

// GET /episodes/:id/design-cards/status — 查询 AI 填卡任务状态
app.get('/:id/design-cards/status', async (c) => {
  const id = Number(c.req.param('id'))
  return success(c, await getDesignCardBatchStatus(id))
})

// POST /episodes/:id/design-cards/fill — 异步填写设计卡（不带 storyboard_ids = 只补空白/过期）
app.post('/:id/design-cards/fill', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await readJson(c)
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') return badRequest(c, '只有纪录片项目才有设计卡')
  // 门禁（#54）：资产审核清单未通过不得 AI 填卡（只对纪录片生效）
  await assertGate(id, 'design')
  const storyboardIds = Array.isArray(body.storyboard_ids)
    ? body.storyboard_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : undefined
  const selection = parseFillModelSelection(body)
  if ('error' in selection) return badRequest(c, selection.error)
  // 骨架未确认是预期中的操作顺序问题（#70），不是服务端异常。
  // 全局 onError 也映射了 SkeletonNotConfirmedError；这里保留同形状的路由级映射，
  // 让这个子应用被单独挂载/直接调用时也不会退化成 500。
  let result: DesignCardBatchStart
  try {
    result = await startDesignCardBatch(
      ep.id, ep.dramaId,
      {
        model: selection.model,
        configId: selection.configId,
      },
      storyboardIds,
    )
  } catch (err) {
    if (err instanceof SkeletonNotConfirmedError) {
      return c.json({ code: 400, error: 'skeleton_unconfirmed', message: err.message }, 400)
    }
    // 选不到模型是用户可处理的选择问题（指定的配置暂停/非视觉/停用/不存在，或确实一条视觉
    // 配置都没有），不是服务端异常：返回指名原因与可用候选，不再逃逸成 500。
    const payload = stageSelectionErrorPayload(err)
    if (payload) {
      logTaskError('DesignCardAPI', 'fill-model-unavailable', {
        episodeId: id, error: payload.error, configId: payload.config_id, reason: payload.reason,
      })
      return c.json(payload, 400)
    }
    throw err
  }
  if (result.total === -1) return success(c, { status: 'running', already_running: true })
  if (!result.started) return success(c, { status: 'idle', total: 0 })
  return success(c, { status: 'running', total: result.total })
})

// PUT /episodes/:id/storyboards/order — 人工重排（ids 必须是本集存活分镜的全集）
app.put('/:id/storyboards/order', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await readJson(c)
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, id))
  if (!ep) return notFound(c, '剧集不存在')
  if (!Array.isArray(body.ids) || !body.ids.length) return badRequest(c, 'ids 必须是分镜 id 数组')
  const ids = body.ids.map(Number)
  if (ids.some((value: number) => !Number.isInteger(value) || value <= 0)) return badRequest(c, 'ids 必须全是正整数')
  if (new Set(ids).size !== ids.length) return badRequest(c, 'ids 里有重复的分镜')
  // 他集分镜混进来：按「不是本集全集」拒绝，避免跨集改号
  const owned = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, id), isNull(schema.storyboards.deletedAt), inArray(schema.storyboards.id, ids)))
  if (owned.length !== ids.length) return badRequest(c, 'ids 里有不属于本集的分镜')
  try {
    return success(c, await reorderStoryboards(id, ids))
  } catch (err) {
    const message = err instanceof Error ? err.message : '重排失败'
    logTaskError('DesignCardAPI', 'reorder', { episodeId: id, error: message })
    return badRequest(c, message)
  }
})

export default app
export { shots as designCardShots }
