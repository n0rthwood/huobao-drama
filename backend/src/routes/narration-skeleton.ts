/**
 * 逐镜旁白骨架（Issue #70）的 HTTP 入口，挂在 `/episodes` 下。
 *
 * 读：`GET /episodes/:id/narration-skeleton` 一次给齐「骨架 + 覆盖 + 逐镜当前配音有效性 + 设计可填性」，
 * 写：生成（异步）/ 编辑边界 / 确认 / 撤销确认。所有写操作都返回同一份状态对象，前端不必再拉一次。
 */
import { Hono } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import {
  confirmNarrationSkeleton,
  narrationSkeletonState,
  saveNarrationSkeleton,
  startSkeletonGeneration,
  unconfirmNarrationSkeleton,
  validateNarrationSkeletonDraft,
  SkeletonConflictError,
  SkeletonInvalidError,
  type SkeletonShotInput,
} from '../services/narration-skeleton.js'

const app = new Hono()

const GENERATE_REASONS: Record<string, string> = {
  not_documentary: '只有纪录片项目有旁白骨架这一步',
  running: '本集已有拆分/补镜任务在跑：请等它结束再生成骨架',
  script_missing: '本集还没有剧本正文：请先完成并确认旁白稿',
}

function parseShots(raw: unknown): SkeletonShotInput[] | null {
  if (!Array.isArray(raw)) return null
  const shots: SkeletonShotInput[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (typeof row.narration_text !== 'string') return null
    const id = row.id === undefined || row.id === null ? null : Number(row.id)
    if (id !== null && !Number.isInteger(id)) return null
    shots.push({
      id,
      narration_text: row.narration_text,
      title: row.title === undefined ? undefined : (typeof row.title === 'string' ? row.title : null),
    })
  }
  return shots
}

// GET /episodes/:id/narration-skeleton — 骨架状态（含逐镜当前配音有效性）
app.get('/:id/narration-skeleton', async (c) => {
  try {
    return success(c, await narrationSkeletonState(Number(c.req.param('id'))))
  } catch (err) {
    return notFound(c, err instanceof Error ? err.message : '剧集不存在')
  }
})

// POST /episodes/:id/narration-skeleton/generate {model?, config_id?} — 只拆旁白，不填设计卡
app.post('/:id/narration-skeleton/generate', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  try {
    const result = await startSkeletonGeneration(id, {
      model: typeof body.model === 'string' ? body.model : undefined,
      configId: body.config_id === undefined || body.config_id === null ? undefined : Number(body.config_id),
    })
    if (!result.started) {
      return badRequest(c, GENERATE_REASONS[result.reason ?? ''] || '无法发起旁白骨架生成')
    }
    return success(c, { ...await narrationSkeletonState(id), task_id: result.task_id })
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '旁白骨架生成失败')
  }
})

// PUT /episodes/:id/narration-skeleton {revision, shots[]} — 拆分 / 合并 / 调边界
app.put('/:id/narration-skeleton', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const shots = parseShots(body.shots)
  if (!shots) return badRequest(c, 'shots 必须是 [{id?, narration_text, title?}] 数组')
  if (typeof body.revision !== 'string' || !body.revision) return badRequest(c, '缺少 revision：请带上刚读到的骨架修订号')
  try {
    if (body.validate_only === true) {
      return success(c, await validateNarrationSkeletonDraft(id, body.revision, shots))
    }
    return success(c, await saveNarrationSkeleton(id, body.revision, shots))
  } catch (err) {
    if (err instanceof SkeletonConflictError) {
      return c.json({ code: 409, error: 'revision_conflict', revision: err.revision, message: err.message }, 409)
    }
    if (err instanceof SkeletonInvalidError) {
      return c.json({ code: 400, error: 'skeleton_invalid', message: err.message, problems: err.problems }, 400)
    }
    return badRequest(c, err instanceof Error ? err.message : '保存旁白骨架失败')
  }
})

// POST /episodes/:id/narration-skeleton/confirm {revision}
app.post('/:id/narration-skeleton/confirm', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  if (typeof body.revision !== 'string' || !body.revision) return badRequest(c, '缺少 revision：请带上刚读到的骨架修订号')
  try {
    return success(c, await confirmNarrationSkeleton(id, body.revision))
  } catch (err) {
    if (err instanceof SkeletonConflictError) {
      return c.json({ code: 409, error: 'revision_conflict', revision: err.revision, message: err.message }, 409)
    }
    return badRequest(c, err instanceof Error ? err.message : '确认旁白骨架失败')
  }
})

// POST /episodes/:id/narration-skeleton/unconfirm
app.post('/:id/narration-skeleton/unconfirm', async (c) => {
  try {
    return success(c, await unconfirmNarrationSkeleton(Number(c.req.param('id'))))
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : '撤销确认失败')
  }
})

export default app
