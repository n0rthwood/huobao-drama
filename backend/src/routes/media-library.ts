/**
 * 素材管理器路由
 *
 *   GET  /media-library/dramas              项目列表（含图片计数）
 *   GET  /media-library/tree?drama_id=      单个项目的浏览树（懒加载第二层）
 *   GET  /media-library/images?...          分页图片列表
 *   POST /media-library/copy { url }        复制库内图片，返回 { url, path }（结构同 /upload/image）
 *
 * 复制类接口一律经白名单校验（见 services/media-library.ts assertLibraryImage），
 * 任意服务器路径无法被插入为参考图或资产图。
 */
import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { badRequest, success } from '../utils/response.js'
import {
  assertLibraryImage,
  buildLibraryTree,
  collectLibraryImages,
  copyLibraryImage,
  filterLibraryImages,
  listLibraryDramas,
  MediaLibraryError,
  sortLibraryImages,
  type KeyframeSlot,
  type LibraryOwnerKind,
} from '../services/media-library.js'

const app = new Hono()

const OWNER_KINDS: Record<string, true> = { character: true, scene: true, prop: true, storyboard: true }
const SLOTS: Record<string, true> = { first_frame: true, mid_frame: true, last_frame: true }

/** MediaLibraryError 带自定义状态（403 = 不在素材库内），其余按 400 返回 */
export function libraryFail(c: Context, err: unknown) {
  if (err instanceof MediaLibraryError) {
    return c.json({ code: err.status, message: err.message }, err.status as ContentfulStatusCode)
  }
  return badRequest(c, (err as Error).message)
}

app.get('/dramas', async c => success(c, { items: await listLibraryDramas() }))

app.get('/tree', async (c) => {
  const dramaId = Number(c.req.query('drama_id'))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  return success(c, await buildLibraryTree(dramaId))
})

app.get('/images', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('page_size')) || 60))
  const kind = c.req.query('kind')
  const slot = c.req.query('slot')
  const episodeId = c.req.query('episode_id')

  const filtered = sortLibraryImages(filterLibraryImages(await collectLibraryImages(), {
    dramaId: Number(c.req.query('drama_id')) || undefined,
    episodeId: episodeId === 'unassigned' ? undefined : Number(episodeId) || undefined,
    episodeScope: episodeId === 'unassigned' ? 'unassigned' : undefined,
    kind: kind && OWNER_KINDS[kind] ? kind as LibraryOwnerKind : undefined,
    ownerId: Number(c.req.query('owner_id')) || undefined,
    slot: slot && SLOTS[slot] ? slot as KeyframeSlot : undefined,
  }))

  return success(c, {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    page_size: pageSize,
  })
})

app.post('/copy', async (c) => {
  const body: unknown = await c.req.json().catch(() => ({}))
  const url = body && typeof body === 'object' && 'url' in body ? body.url : undefined
  try {
    const source = await assertLibraryImage(url)
    // 资产图统一落 static/images，与生图产物同目录，后续 registerUpload 注册为版本
    const stored = await copyLibraryImage(source, 'images')
    return success(c, { url: `/${stored}`, path: stored, copied_from: source.path })
  } catch (err) {
    return libraryFail(c, err)
  }
})

export default app
