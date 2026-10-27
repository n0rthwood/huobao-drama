/**
 * 资产参考图路由（角色 / 场景 / 道具三套完全一致的行为，挂到各自的 Hono app）
 *
 *   POST   /:id/reference-images   multipart file=<图片>  → 追加一张，返回最新数组
 *   DELETE /:id/reference-images?url=<已保存的相对路径>    → 删除一张，返回最新数组
 *
 * 三处独立实现必然漂移，故共用本挂载函数；成片图 image_url/local_path 不受这两个接口影响。
 */
import type { Context, Hono } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import {
  addReferenceImage,
  type AssetKind,
  ReferenceImageError,
  removeReferenceImage,
} from '../services/reference-images.js'
import { addReferenceImagesFromLibrary } from '../services/media-library.js'
import { libraryFail } from './media-library.js'

function fail(c: Context, err: unknown) {
  if (err instanceof ReferenceImageError) {
    return err.status === 404 ? notFound(c, err.message) : badRequest(c, err.message)
  }
  return badRequest(c, (err as Error).message)
}

export function mountReferenceImageRoutes(app: Hono, kind: AssetKind) {
  app.post('/:id/reference-images', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || !(file instanceof File)) return badRequest(c, '文件必填')
    try {
      const refs = await addReferenceImage(kind, id, file)
      return success(c, { reference_images: refs })
    } catch (err) {
      return fail(c, err)
    }
  })

  // 从素材库选择已有图片作为参考图：复制文件（新 uuid），uploaded_at = 选择当时
  app.post('/:id/reference-images/from-library', async (c) => {
    const id = Number(c.req.param('id'))
    const body: unknown = await c.req.json().catch(() => ({}))
    const urls = body && typeof body === 'object' && 'urls' in body ? body.urls : undefined
    try {
      const result = await addReferenceImagesFromLibrary(kind, id, urls)
      return success(c, { reference_images: result.entries, added: result.added, skipped: result.skipped })
    } catch (err) {
      if (err instanceof ReferenceImageError) return fail(c, err)
      return libraryFail(c, err)
    }
  })

  app.delete('/:id/reference-images', async (c) => {
    const id = Number(c.req.param('id'))
    const url = c.req.query('url') || ''
    try {
      const refs = await removeReferenceImage(kind, id, url)
      return success(c, { reference_images: refs })
    } catch (err) {
      return fail(c, err)
    }
  })
}
