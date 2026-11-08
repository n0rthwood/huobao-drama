/**
 * 分阶段剧本改写的 HTTP 接口（Issue #70）。挂在 /episodes 下，由 index.ts 注册。
 *
 * 读一个 GET 就能恢复整页状态（运行、版本、阶段、修订号），执行进度复用全局任务轮询，
 * 不再有页面私有轮询。所有写入口都带修订号 CAS，冲突一律 409 并把当前值回给前端去比较。
 */
import { Hono } from 'hono'

import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { badRequest, notFound, success } from '../utils/response.js'
import { resolveDramaProjectType } from '../services/project-type.js'
import {
  RewriteRequestError,
  adoptVersion,
  disableAutoAdopt,
  holdAutoAdoptForManualEdit,
  startRewriteRun,
  type StartRunOptions,
} from '../services/script-rewrite/run.js'
import {
  RevisionConflictError,
  episodeRevisions,
  getRun,
  listStages,
  rewriteState,
  serializeRun,
  writeCanonicalFinal,
} from '../services/script-rewrite/store.js'
import type { RewriteStageKey } from '../services/script-rewrite/stages.js'
import { inspectNarration } from '../services/script-rewrite/narration-inspection.js'

const app = new Hono()

function numberOr(value: unknown, fallback?: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** 服务层错误 → HTTP：状态码与 body.code 一致，错误码机器可读 */
function fail(c: Parameters<typeof badRequest>[0], err: unknown) {
  if (err instanceof RewriteRequestError) {
    // hono 的 c.json 要求字面量状态码；服务层只会抛这四种
    const status = err.status === 409 ? 409 : err.status === 404 ? 404 : err.status === 500 ? 500 : 400
    return c.json({ code: status, error: err.code, message: err.message, ...(err.extra ?? {}) }, status)
  }
  if (err instanceof RevisionConflictError) {
    return c.json({ code: 409, error: 'revision_conflict', message: err.message, ...err.current }, 409)
  }
  throw err
}

// GET /episodes/:id/script-rewrite — 整页状态（运行 / 版本 / 阶段 / 修订号）
app.get('/:id/script-rewrite', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const state = await rewriteState(episodeId)
  if (!state) return notFound(c, '剧集不存在')
  return success(c, state)
})

// POST /episodes/:id/script-rewrite — 执行全部 / 从某阶段重跑 / 跳过某些阶段（异步）
app.post('/:id/script-rewrite', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const options: StartRunOptions = {
    startStage: typeof body.start_stage === 'string' ? body.start_stage as RewriteStageKey : undefined,
    predecessorVersionId: numberOr(body.predecessor_version_id),
    skipStages: Array.isArray(body.skip_stages) ? body.skip_stages.filter((key: unknown): key is string => typeof key === 'string') : undefined,
    configId: numberOr(body.config_id),
    model: typeof body.model === 'string' && body.model ? body.model : undefined,
    autoAdopt: body.auto_adopt === false ? false : undefined,
    sourceRevision: numberOr(body.source_revision),
    finalRevision: numberOr(body.final_revision),
    acknowledgeSourceChange: body.acknowledge_source_change === true,
  }
  try {
    return success(c, await startRewriteRun(episodeId, options))
  } catch (err) {
    return fail(c, err)
  }
})

// POST /episodes/:id/script-rewrite/runs/:runId/manual — 运行期间开始手改：先关掉自动采用
app.post('/:id/script-rewrite/runs/:runId/manual', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const runId = Number(c.req.param('runId'))
  try {
    const run = await getRun(runId)
    if (!run || run.episodeId !== episodeId) return notFound(c, '运行不存在')
    const updated = await disableAutoAdopt(runId)
    return success(c, { run_id: updated.id, auto_adopt: updated.autoAdopt === 1 })
  } catch (err) {
    return fail(c, err)
  }
})

// POST /episodes/:id/script-rewrite/versions/:versionId/adopt — 显式采用候选或历史版本
app.post('/:id/script-rewrite/versions/:versionId/adopt', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const versionId = Number(c.req.param('versionId'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  try {
    const result = await adoptVersion(episodeId, versionId, {
      sourceRevision: numberOr(body.source_revision),
      finalRevision: numberOr(body.final_revision),
    })
    const state = await rewriteState(episodeId)
    return success(c, { ...state, adopted_version_id: versionId, changed: result.changed })
  } catch (err) {
    return fail(c, err)
  }
})
// Inspect the submitted draft, not a previous rewrite report. This endpoint never writes it.
app.post('/:id/script-rewrite/inspect-narration', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  if (typeof body.content !== 'string') return badRequest(c, 'content 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return notFound(c, '剧集不存在')
  if (resolveDramaProjectType(ep.dramaId ?? 0) !== 'documentary') return badRequest(c, '仅纪录片可检查旁白稿')
  try {
    const findings = await inspectNarration(body.content, {
      configId: numberOr(body.config_id),
      model: typeof body.model === 'string' && body.model ? body.model : undefined,
    })
    return success(c, { findings })
  } catch {
    return c.json({ code: 502, error: 'inspection_failed', message: '旁白稿检测失败' }, 502)
  }
})


// PUT /episodes/:id/script-rewrite/final — 人工保存最终稿（产生 manual 不可变版本 + CAS 写入）
app.put('/:id/script-rewrite/final', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  if (typeof body.content !== 'string') return badRequest(c, 'content 必填')
  const finalRevision = numberOr(body.final_revision)
  if (finalRevision == null) return badRequest(c, 'final_revision 必填（用于并发保护）')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return notFound(c, '剧集不存在')
  // 人工保存优先：活跃运行降级为「只留候选」，不会在保存之后把结果盖上去
  await holdAutoAdoptForManualEdit(episodeId)
  try {
    const result = await writeCanonicalFinal({
      episodeId,
      content: body.content,
      expectedFinalRevision: finalRevision,
      expectedSourceRevision: numberOr(body.source_revision),
      reason: 'PUT /episodes/:id/script-rewrite/final 人工保存最终稿',
    })
    return success(c, {
      changed: result.changed,
      source_revision: result.source_revision,
      final_revision: result.final_revision,
      version_id: result.version_id,
    })
  } catch (err) {
    return fail(c, err)
  }
})

// GET /episodes/:id/script-rewrite/runs/:runId — 单个运行（任务详情时间线按它展开）
app.get('/:id/script-rewrite/runs/:runId', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const runId = Number(c.req.param('runId'))
  const run = await getRun(runId)
  if (!run || run.episodeId !== episodeId) return notFound(c, '运行不存在')
  const stages = await listStages([run.id])
  const revisions = await episodeRevisions(episodeId)
  return success(c, {
    run: serializeRun(run, stages),
    project_type: resolveDramaProjectType(run.dramaId ?? 0),
    source_revision: revisions?.source_revision ?? 1,
    final_revision: revisions?.final_revision ?? 1,
  })
})

export default app
