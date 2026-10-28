import { Hono } from 'hono'
import { and, eq, isNull, like, desc } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now, serverError } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { lookupGeneratedAt } from '../services/media-time.js'
import { logTaskError } from '../utils/task-logger.js'
import { AssetLibraryError, importAsset, isAssetKind } from '../services/asset-library.js'

const app = new Hono()

/** 项目画幅白名单：与关键帧 KEYFRAME_SIZES / H3 pickResolution 支持的档位一致 */
const ASPECT_RATIOS: Record<string, true> = { '16:9': true, '9:16': true, '4:3': true, '3:4': true, '1:1': true }
const ASPECT_RATIO_MESSAGE = '请选择画面比例（16:9 / 9:16 / 4:3 / 3:4 / 1:1）'

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  const allRows = await db.select().from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .orderBy(desc(schema.dramas.updatedAt))
  let filtered = allRows

  if (status) filtered = filtered.filter(d => d.status === status)
  if (keyword) filtered = filtered.filter(d => d.title.includes(keyword))

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Attach episode/character/scene counts
  const enriched = await Promise.all(items.map(async (drama) => {
    const eps = await db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, drama.id), isNull(schema.episodes.deletedAt)))
    const chars = await db.select().from(schema.characters)
      .where(and(eq(schema.characters.dramaId, drama.id), isNull(schema.characters.deletedAt)))
    const scns = await db.select().from(schema.scenes)
      .where(and(eq(schema.scenes.dramaId, drama.id), isNull(schema.scenes.deletedAt)))
    return {
      ...toSnakeCase(drama),
      tags: drama.tags ? JSON.parse(drama.tags) : [],
      total_episodes: eps.length,
      episodes: toSnakeCaseArray(eps),
      characters: toSnakeCaseArray(chars),
      scenes: toSnakeCaseArray(scns),
    }
  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  const body = await c.req.json()
  if (ASPECT_RATIOS[body.aspect_ratio] !== true) return badRequest(c, ASPECT_RATIO_MESSAGE)
  const ts = now()
  const res = await db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: body.style,
    aspectRatio: body.aspect_ratio,
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: body.metadata,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  })

  const [result] = await db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, getInsertId(res)))

  // 不再预建集 — 用户通过「添加集」流程创建（该流程会锁定图片/视频生成配置）
  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const all = await db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))
  const byStatus = Object.entries(
    all.reduce((acc, d) => {
      acc[d.status || 'draft'] = (acc[d.status || 'draft'] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({ status, count }))
  return success(c, { total: all.length, by_status: byStatus })
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = await db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, id), isNull(schema.dramas.deletedAt)))
  if (!drama) return notFound(c, '剧本不存在')

  const eps = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, id), isNull(schema.episodes.deletedAt)))
  const chars = await db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, id), isNull(schema.characters.deletedAt)))
  const scns = await db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.dramaId, id), isNull(schema.scenes.deletedAt)))
  const prps = await db.select().from(schema.props)
    .where(and(eq(schema.props.dramaId, id), isNull(schema.props.deletedAt)))

  // 当前成片图的生成时间：一次批量反查 sys_task（反查不到 → 不带时间字段）
  const assets = [...chars, ...scns, ...prps]
  const generatedAt = await lookupGeneratedAt(assets.map(row => row.imageUrl))
  const withTime = <T extends { imageUrl: string | null }>(rows: T[]) =>
    rows.map(row => ({
      ...toSnakeCase(row),
      image_generated_at: (row.imageUrl ? generatedAt.get(row.imageUrl) : undefined) ?? null,
    }))

  return success(c, {
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    episodes: toSnakeCaseArray(eps),
    characters: withTime(chars),
    scenes: withTime(scns),
    props: withTime(prps),
  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [current] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, id))
  if (!current) return notFound(c, '项目不存在')
  if (body.aspect_ratio !== undefined && ASPECT_RATIOS[body.aspect_ratio] !== true) {
    return badRequest(c, ASPECT_RATIO_MESSAGE)
  }
  const ts = now()
  const updates: Record<string, any> = { updatedAt: ts }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.aspect_ratio !== undefined) updates.aspectRatio = body.aspect_ratio
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = body.metadata
  await db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id))

  // 资产的 final_prompt 烘焙了旧风格词：换风格后全部清空，下次生图由 ensure*FinalPrompt 按新风格重写
  if (body.style !== undefined && body.style !== current.style) {
    for (const table of [schema.characters, schema.scenes, schema.props]) {
      await db.update(table).set({ finalPrompt: null, updatedAt: ts }).where(eq(table.dramaId, id))
    }
  }
  return success(c)
})

// DELETE /dramas/:id - Soft delete
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.dramas).set({ deletedAt: now() }).where(eq(schema.dramas.id, id))
  return success(c)
})

// POST /dramas/:id/assets/import — 跨项目全量复制导入一个资产（可选同时关联到某一集）
// 文本字段 + 当前图 + 全部历史版本 + 参考图都复制成新行/新文件，源与副本此后互不影响。
app.post('/:id/assets/import', async (c) => {
  const targetDramaId = Number(c.req.param('id'))
  const raw: unknown = await c.req.json()
  const body = raw && typeof raw === 'object' ? raw : null
  const kind = body && 'kind' in body ? body.kind : undefined
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const sourceId = Number(body && 'source_id' in body ? body.source_id : undefined)
  if (!Number.isInteger(sourceId) || sourceId <= 0) return badRequest(c, 'source_id 必填')
  const nameRaw = body && 'name' in body ? body.name : undefined
  const episodeIdRaw = body && 'episode_id' in body ? body.episode_id : undefined
  try {
    return success(c, await importAsset({
      targetDramaId,
      kind,
      sourceId,
      name: typeof nameRaw === 'string' ? nameRaw : undefined,
      episodeId: episodeIdRaw == null ? null : Number(episodeIdRaw),
    }))
  } catch (err) {
    if (err instanceof AssetLibraryError) {
      if (err.status === 404) return notFound(c, err.message)
      // 同名冲突：带上建议名，前端直接填进改名输入框
      return c.json({ code: 400, message: err.message, data: { suggestion: err.suggestion ?? null } }, 400)
    }
    // 文件复制等 IO 失败：importAsset 已尽力回滚；详细原因（含服务器路径）只进日志，不回给客户端
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('AssetImport', 'import-failed', { dramaId: targetDramaId, kind, sourceId, error: message })
    return serverError(c, '导入失败，已回滚本次复制的数据与文件，请重试或联系管理员')
  }
})

// PUT /dramas/:id/characters - Save characters
app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    // 参考图只由 /characters/:id/reference-images 维护（单写者），批量保存不碰这一列
    const { reference_images, referenceImages, ...fields } = char
    if (char.id) {
      await db.update(schema.characters).set({ ...fields, updatedAt: ts }).where(eq(schema.characters.id, char.id))
    } else {
      await db.insert(schema.characters).values({ ...fields, dramaId, createdAt: ts, updatedAt: ts })
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      await db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id))
    } else {
      await db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }
  return success(c)
})

export default app
