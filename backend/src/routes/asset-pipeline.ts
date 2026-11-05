/**
 * 资产流水线接口（Issue #56），挂载前缀 `/api/v1/asset-pipeline`
 *
 * 底图候选也开在这里而不是 `routes/episodes.ts`：R1/R2/R4 同期都在改那个文件，
 * 单独开口可以把合并冲突面降到零；服务端内部消费仍直接调 `listBaseCandidates()`，
 * 两者互不绑定。
 */
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, created, success } from '../utils/response.js'
import { logTaskError } from '../utils/task-logger.js'
import { StageVisionUnavailableError } from '../services/ai-stages.js'
import { ACTIVE_TASK_STATUSES } from '../services/sys-task.js'
import { parseTextTaskParams } from '../services/text-task.js'
import { listBaseCandidates } from '../services/asset-pipeline/base-candidates.js'
import { decideRound } from '../services/asset-pipeline/gate.js'
import {
  approveRound,
  ASSET_PIPELINE_KIND,
  cancelRun,
  PipelineConflictError,
  PipelineStateError,
  startAssetPipeline,
  suspendedApproval,
} from '../services/asset-pipeline/run.js'
import { addAssetSource, AssetSourceError, deleteAssetSource } from '../services/asset-pipeline/sources.js'
import {
  ASSET_KINDS,
  getSpec,
  latestQcByRound,
  listRounds,
  listSources,
  SOURCE_ROLES,
  type AssetKind,
  type SourceRole,
} from '../services/asset-pipeline/store.js'

const app = new Hono()

function parseKind(raw: unknown): AssetKind | null {
  const value = String(raw ?? '')
  return ASSET_KINDS.includes(value as AssetKind) ? value as AssetKind : null
}

async function serializeRun(row: typeof schema.sysTask.$inferSelect) {
  const params = parseTextTaskParams(row.params)
  return {
    id: row.id,
    status: row.status,
    purpose: params?.purpose ?? 'precision',
    step: params?.progress?.step ?? null,
    asset_kind: params?.asset_kind ?? null,
    asset_id: params?.asset_id ?? null,
    episode_id: row.episodeId,
    mastra_run_id: params?.mastra_run_id ?? null,
    error: row.errorMsg,
    result: params?.result ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

// POST /asset-pipeline/runs — 启动一条流水线
app.post('/runs', async (c) => {
  const body = await c.req.json()
  const kind = parseKind(body.asset_kind)
  if (!kind) return badRequest(c, 'asset_kind 必须是 character / scene / prop')
  const assetId = Number(body.asset_id)
  const episodeId = Number(body.episode_id)
  if (!assetId || !episodeId) return badRequest(c, 'asset_id 与 episode_id 必填')
  const purpose = body.purpose === 'beautify' ? 'beautify' as const : 'precision' as const
  try {
    const result = await startAssetPipeline({
      assetKind: kind,
      assetId,
      episodeId,
      purpose,
      configId: body.config_id ?? null,
      model: body.model ?? null,
      textConfigId: body.text_config_id ?? null,
    })
    return created(c, { run_id: result.runId, mastra_run_id: result.mastraRunId })
  } catch (err) {
    if (err instanceof PipelineConflictError) return c.json({ success: false, error: err.message }, 409)
    if (err instanceof StageVisionUnavailableError) return badRequest(c, err.message)
    if (err instanceof PipelineStateError) return badRequest(c, err.message)
    logTaskError('AssetPipelineAPI', 'start', { error: err instanceof Error ? err.message : String(err) })
    return badRequest(c, err instanceof Error ? err.message : '启动流水线失败')
  }
})

// GET /asset-pipeline/runs?asset_kind=&asset_id= — 某资产的 run 列表
app.get('/runs', async (c) => {
  const kind = parseKind(c.req.query('asset_kind'))
  const assetId = Number(c.req.query('asset_id') || 0)
  const rows = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.type, 'text'))
    .orderBy(desc(schema.sysTask.id))
  const runs = []
  for (const row of rows) {
    const params = parseTextTaskParams(row.params)
    if (params?.kind !== ASSET_PIPELINE_KIND) continue
    if (kind && params.asset_kind !== kind) continue
    if (assetId && Number(params.asset_id) !== assetId) continue
    runs.push(await serializeRun(row))
  }
  return success(c, { runs })
})

// GET /asset-pipeline/episodes/:id/base-candidates — 底图候选（R4/R5 的 HTTP 口）
app.get('/episodes/:id/base-candidates', async (c) => {
  const episodeId = Number(c.req.param('id'))
  if (!episodeId) return badRequest(c, 'episode id 非法')
  return success(c, { candidates: await listBaseCandidates(episodeId) })
})

// GET /asset-pipeline/assets/:kind/:id/sources — 素材缓存列表
app.get('/assets/:kind/:id/sources', async (c) => {
  const kind = parseKind(c.req.param('kind'))
  if (!kind) return badRequest(c, 'kind 必须是 character / scene / prop')
  return success(c, { sources: await listSources(kind, Number(c.req.param('id'))) })
})

/**
 * POST /asset-pipeline/asset-sources — 人工入库一条素材。
 * 两种提交方式：JSON（`url` 由服务端下载 / `local_path` 复用已上传文件）与
 * multipart（`file` 直接上传）。两条路径都按内容 sha256 落 `static/asset-sources/`，
 * 所以同一张图无论怎么进来都只有一份文件、一个哈希。
 */
app.post('/asset-sources', async (c) => {
  const multipart = (c.req.header('content-type') || '').includes('multipart/form-data')
  let file: { bytes: Buffer; filename: string } | null = null
  let body: Record<string, unknown>
  if (multipart) {
    const form = await c.req.parseBody()
    const uploaded = form.file
    if (!(uploaded instanceof File)) return badRequest(c, 'file 必填')
    file = { bytes: Buffer.from(await uploaded.arrayBuffer()), filename: uploaded.name || 'source.bin' }
    body = form as Record<string, unknown>
  } else {
    body = await c.req.json()
  }
  const kind = parseKind(body.asset_kind)
  if (!kind) return badRequest(c, 'asset_kind 必须是 character / scene / prop')
  const assetId = Number(body.asset_id)
  if (!assetId) return badRequest(c, 'asset_id 必填')
  const role = String(body.role ?? '') as SourceRole
  if (!SOURCE_ROLES.includes(role)) return badRequest(c, 'role 必须是 generation_reference / shape_only / rejected')
  try {
    const source = await addAssetSource({
      assetKind: kind,
      assetId,
      url: body.url ? String(body.url) : null,
      file,
      localPath: body.local_path ? String(body.local_path) : null,
      title: body.title ? String(body.title) : null,
      artist: body.artist ? String(body.artist) : null,
      license: String(body.license ?? ''),
      role,
      era: body.era ? String(body.era) : null,
      whyExcluded: body.why_excluded ? String(body.why_excluded) : null,
    })
    return created(c, { source })
  } catch (err) {
    if (err instanceof AssetSourceError) return badRequest(c, err.message)
    throw err
  }
})

// DELETE /asset-pipeline/asset-sources/:id
app.delete('/asset-sources/:id', async (c) => {
  const deleted = await deleteAssetSource(Number(c.req.param('id')))
  if (!deleted) return badRequest(c, '素材不存在')
  return success(c, { deleted: true })
})

// GET /asset-pipeline/runs/:id — run 详情（事实表 + 轮次 + QC + 闸门）
app.get('/runs/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!row) return badRequest(c, '流水线任务不存在')
  const params = parseTextTaskParams(row.params)
  if (params?.kind !== ASSET_PIPELINE_KIND) return badRequest(c, '该任务不是资产流水线')

  const kind = parseKind(params.asset_kind) ?? 'prop'
  const assetId = Number(params.asset_id)
  const spec = params.asset_spec_id ? await getSpec(Number(params.asset_spec_id)) : null
  const rounds = await listRounds(id)
  const qcByRound = await latestQcByRound(rounds.map(round => round.id))
  const history = rounds.map(round => ({
    round_no: round.round_no,
    purpose: round.purpose,
    gate_pass: qcByRound.get(round.id) ? qcByRound.get(round.id)!.gate_pass === 1 : null,
    human_verdict: qcByRound.get(round.id)?.human_verdict ?? null,
    status: round.status,
  }))

  const detail = rounds.map((round) => {
    const qc = qcByRound.get(round.id) ?? null
    return {
      ...round,
      qc,
      gate: qc
        ? {
            pass: qc.gate_pass === 1,
            coverage: qc.checklist_coverage,
            invalid: qc.gate_invalid,
            violations: (qc.verdicts?.must_have ?? [])
              .filter(item => item.verdict === 'violation')
              .map(item => ({
                id: item.id,
                element: spec?.must_have.find(need => need.id === item.id)?.element ?? item.id,
                verdict: item.verdict,
                evidence: item.evidence ?? '',
              })),
            forbidden_hits: (qc.verdicts?.forbidden ?? [])
              .filter(item => item.detected)
              .map(item => ({
                id: item.id,
                error: spec?.forbidden.find(ban => ban.id === item.id)?.error ?? item.id,
                evidence: item.evidence ?? '',
              })),
            text_in_image: qc.verdicts?.text_in_image ?? { present: null, evidence: '' },
            locate_checks: qc.locate_checks,
          }
        : null,
      suggestion: qc ? decideRound(history.filter(item => item.round_no <= round.round_no)) : null,
    }
  })

  const mastraRunId = String(params.mastra_run_id ?? '')
  const suspended = mastraRunId && ACTIVE_TASK_STATUSES.includes(row.status as typeof ACTIVE_TASK_STATUSES[number])
    ? await suspendedApproval(mastraRunId)
    : null

  return success(c, {
    run: await serializeRun(row),
    spec,
    rounds: detail,
    awaiting: suspended ? { round_id: suspended.payload.round_id, round_no: suspended.payload.round_no } : null,
    sources: await listSources(kind, assetId),
  })
})

// POST /asset-pipeline/runs/:id/approve — 人工审批（通过 / 打回重修 / 回退 / 终止）
app.post('/runs/:id/approve', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const verdict = String(body.verdict ?? '')
  if (!['approve', 'revise', 'rollback', 'abort'].includes(verdict)) {
    return badRequest(c, 'verdict 必须是 approve / revise / rollback / abort')
  }
  const opened = Array.isArray(body.opened)
    ? body.opened.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('path' in item) || !('sha256' in item)) return []
        return [{ path: String(item.path), sha256: String(item.sha256) }]
      })
    : []
  if (!opened.length) return badRequest(c, '审批必须附上已打开查看的图片（opened: [{path, sha256}]）')
  try {
    await approveRound({
      runId: id,
      roundId: Number(body.round_id),
      verdict: verdict as 'approve' | 'revise' | 'rollback' | 'abort',
      selectedViolations: Array.isArray(body.selected_violations) ? body.selected_violations.map(String) : [],
      notes: body.notes ? String(body.notes) : null,
      opened,
      overrideGate: body.override_gate === true,
    })
    return success(c, { status: 'ok' })
  } catch (err) {
    if (err instanceof PipelineStateError) return badRequest(c, err.message)
    throw err
  }
})

// POST /asset-pipeline/runs/:id/cancel
app.post('/runs/:id/cancel', async (c) => {
  try {
    await cancelRun(Number(c.req.param('id')))
    return success(c, { cancelled: true })
  } catch (err) {
    if (err instanceof PipelineStateError) return badRequest(c, err.message)
    throw err
  }
})

export default app
