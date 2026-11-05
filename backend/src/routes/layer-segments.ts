/**
 * 图层段接口（Issue #58），挂载在 /api/v1/layer-segments。
 *
 * GET 列表（规格、段、衔接帧、设计卡门禁与一致性检查）/ PUT 保存 / DELETE / 草稿 / 渲染 /
 * 缩略图（`first|last|frame-<index>`）/ 衔接帧 PNG。
 * 「批量渲染图层段」不在本 Issue（契约 §10 裁决 M1：归 R7 的 `services/layer-render-batch.ts`）。
 */
import fs from 'fs'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { logTaskError } from '../utils/task-logger.js'
import { getAbsolutePath } from '../utils/storage.js'
import { renderSegmentFrame } from '../services/layer-segment-render.js'
import { startLayerSegmentRenderTask } from '../services/layer-segment-task.js'
import { junctionFrameOf } from '../services/junction-frame.js'
import { assertShotGate, productionGateReason } from '../services/workflow-gates.js'
import { parseDesignCard, toCombo, toDesignCardStatus } from '../services/design-card.js'
import { segmentIssuesOf } from '../services/segment-issues.js'
import {
  deleteLayerSegment,
  getLayerSegment,
  layerSegmentIsFresh,
  resolveEpisodeSegmentSpec,
  saveLayerSegment,
  saveSegmentDraft,
  type SegmentDraftOutcome,
} from '../services/layer-segment.js'

const app = new Hono()

/** 缩略图按需渲染 + 进程内 LRU（≤200 帧，契约 §10 裁决 10）：预演帧条一次要十几张 */
const thumbnailCache = new Map<string, Buffer>()
const THUMBNAIL_CACHE_LIMIT = 200

async function storyboardOf(storyboardId: number) {
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  return row ?? null
}

function rememberThumbnail(key: string, png: Buffer): Buffer {
  thumbnailCache.delete(key)
  thumbnailCache.set(key, png)
  if (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailCache.keys().next().value
    if (oldest) thumbnailCache.delete(oldest)
  }
  return png
}

/** 设计卡门禁的事实：本镜卡是否 confirmed（剧情项目恒放行） */
async function gateStateOf(storyboardId: number) {
  const sb = await storyboardOf(storyboardId)
  if (!sb) return null
  const status = toDesignCardStatus(sb.designCardStatus)
  const unlocked = await productionGateReason(sb.episodeId, { storyboardId, status })
  return { sb, status, unlocked }
}

/** 统一的 GET 体：规格 + 段（含新鲜度）+ 衔接帧 + 设计卡门禁 + 一致性检查 */
async function segmentPayload(storyboardId: number) {
  const sb = await storyboardOf(storyboardId)
  if (!sb) return null
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
  const segment = await getLayerSegment(storyboardId)
  const junction = await junctionFrameOf(storyboardId)
  const status = toDesignCardStatus(sb.designCardStatus)
  const gate = await productionGateReason(sb.episodeId, { storyboardId, status })
  return {
    spec,
    combo: toCombo(sb.combo),
    design_card_status: status,
    production_unlocked: gate.unlocked,
    gate_reason: gate.reason,
    segment: segment ? { ...segment, fresh: layerSegmentIsFresh(segment, spec) } : null,
    junction,
    issues: segmentIssuesOf({
      card: parseDesignCard(sb.designCard),
      combo: toCombo(sb.combo),
      segment,
      storyboardPrompts: {
        first: sb.firstFramePrompt || '',
        mid: sb.midFramePrompt || '',
        last: sb.lastFramePrompt || '',
        video: sb.videoPrompt || '',
      },
    }),
  }
}

app.get('/storyboards/:id', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const payload = await segmentPayload(storyboardId)
  if (!payload) return notFound(c, '分镜不存在')
  return success(c, payload)
})

/** 保存人工编辑后的图层文档 / 时间线 / 时长 / 底图引用（设计卡未确认 → 400 gate） */
app.put('/storyboards/:id', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const sb = await storyboardOf(storyboardId)
  if (!sb) return notFound(c, '分镜不存在')
  await assertShotGate(storyboardId, 'production')
  let body: Record<string, unknown> = {}
  try {
    const parsed = await c.req.json()
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }
  try {
    await saveLayerSegment(storyboardId, {
      ...('layer_doc' in body ? { layer_doc: body.layer_doc } : {}),
      ...('timeline' in body ? { timeline: body.timeline } : {}),
      ...(body.duration !== undefined ? { duration: Number(body.duration) } : {}),
      ...('base_ref' in body ? { base_ref: body.base_ref as never } : {}),
    })
    return success(c, await segmentPayload(storyboardId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('LayerSegmentAPI', 'save', { storyboardId, error: message })
    return badRequest(c, message)
  }
})

app.delete('/storyboards/:id', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const deleted = await deleteLayerSegment(storyboardId)
  if (!deleted) return notFound(c, '本镜还没有图层段')
  return success(c, { deleted: true })
})

/** 按设计卡 `layer_plan` 生成图层段草稿（覆盖既有段）；无合格底图 → 400 code=missing_base */
app.post('/storyboards/:id/draft', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const sb = await storyboardOf(storyboardId)
  if (!sb) return notFound(c, '分镜不存在')
  await assertShotGate(storyboardId, 'production')
  try {
    const outcome: SegmentDraftOutcome = await saveSegmentDraft(storyboardId)
    if (!outcome.ok) {
      // 机器可读的错误码（前端据此提示「回设计卡指定底图」）
      return c.json({ code: 'missing_base', field: outcome.issue, message: outcome.message }, 400)
    }
    return success(c, { ...(await segmentPayload(storyboardId)), warnings: outcome.result.draft.warnings })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('LayerSegmentAPI', 'draft', { storyboardId, error: message })
    return badRequest(c, message)
  }
})

/** 渲染（同步，几秒级）：建 sys_task、出 mp4 + 衔接帧、必要时作废关键帧确认 */
app.post('/storyboards/:id/render', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const sb = await storyboardOf(storyboardId)
  if (!sb) return notFound(c, '分镜不存在')
  await assertShotGate(storyboardId, 'production')
  try {
    const outcome = await startLayerSegmentRenderTask(storyboardId)
    const payload = await segmentPayload(storyboardId)
    return success(c, {
      task_id: outcome.task_id,
      spec: payload?.spec,
      segment: payload?.segment,
      junction: payload?.junction,
      keyframes_invalidated: outcome.keyframes_invalidated,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('LayerSegmentAPI', 'render', { storyboardId, error: message })
    return badRequest(c, message)
  }
})

/**
 * 缩略图：`first` / `last` / `frame-<index>`（index 从 0 起，按本集帧率取时刻）。
 * 按需渲染 + LRU；段没渲染过也能看（编辑器要「所见即所渲」）。
 */
app.get('/storyboards/:id/thumbnail/:which', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const sb = await storyboardOf(storyboardId)
  if (!sb) return notFound(c, '分镜不存在')
  const segment = await getLayerSegment(storyboardId)
  if (!segment) return notFound(c, '本镜还没有图层段')
  const which = c.req.param('which')
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
  const frameIndex = which.startsWith('frame-') ? Number(which.slice('frame-'.length)) : null
  if (frameIndex === null && which !== 'first' && which !== 'last') {
    return badRequest(c, 'which 只能是 first / last / frame-<index>')
  }
  if (frameIndex !== null && (!Number.isInteger(frameIndex) || frameIndex < 0)) {
    return badRequest(c, 'frame-<index> 的 index 必须是非负整数')
  }
  const key = `${segment.id}:${segment.render_signature || 'draft'}:${which}:${spec.width}x${spec.height}@${spec.fps}`
  const cached = thumbnailCache.get(key)
  if (cached) return servePng(c, rememberThumbnail(key, cached))
  const durationMs = segment.duration * 1000
  const frameMs = 1000 / spec.fps
  const t = frameIndex !== null
    ? Math.min(durationMs, frameIndex * frameMs) / 1000
    : which === 'last'
      ? Math.max(0, segment.duration - 1 / spec.fps)
      : 0
  try {
    const png = await renderSegmentFrame(segment, spec, t)
    return servePng(c, rememberThumbnail(key, png))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('LayerSegmentAPI', 'thumbnail', { storyboardId, which, error: message })
    return badRequest(c, message)
  }
})

function servePng(c: { header: (key: string, value: string) => void; body: (body: Uint8Array) => Response }, png: Buffer): Response {
  c.header('Content-Type', 'image/png')
  c.header('Cache-Control', 'no-store')
  return c.body(new Uint8Array(png))
}

/** 衔接帧 PNG（C = 末帧、D = 首帧，均不含文字图层）；没有就 404 */
app.get('/storyboards/:id/junction', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const junction = await junctionFrameOf(storyboardId)
  if (!junction.path) return notFound(c, '本镜还没有衔接帧（组合 A/B 或图层段未渲染）')
  const abs = getAbsolutePath(junction.path)
  if (!fs.existsSync(abs)) return notFound(c, '衔接帧文件不存在，请重新渲染图层段')
  c.header('Content-Type', 'image/png')
  c.header('Cache-Control', 'no-store')
  return c.body(new Uint8Array(fs.readFileSync(abs)))
})

export default app
