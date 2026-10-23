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
