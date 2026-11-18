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
  loadReferences,
  persistReferences,
  ReferenceImageError,
  removeReferenceImage,
} from '../services/reference-images.js'
import { adoptDirectImage, classifyReferenceInBackground } from '../services/asset-image-usage.js'
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
      const before = await loadReferences(kind, id)
      const refs = await addReferenceImage(kind, id, file)
      // #121：新入库的参考图异步视觉分类；判 direct 自动采用为资产图（受保护）
      const added = refs.filter(entry => !before.some(old => old.path === entry.path))
      for (const entry of added) classifyReferenceInBackground(kind, id, entry.path)
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
      const before = await loadReferences(kind, id)
      const result = await addReferenceImagesFromLibrary(kind, id, urls)
      // #121：素材库选入同样触发分类与自动采用
      const added = result.entries.filter(entry => !before.some(old => old.path === entry.path))
      for (const entry of added) classifyReferenceInBackground(kind, id, entry.path)
      return success(c, { reference_images: result.entries, added: result.added, skipped: result.skipped })
    } catch (err) {
      if (err instanceof ReferenceImageError) return fail(c, err)
      return libraryFail(c, err)
    }
  })

  // #121：人工改判参考图用途（direct = 可直接采用为资产图，仍可被引用）
  app.put('/:id/reference-images/usage', async (c) => {
    const id = Number(c.req.param('id'))
    const body: unknown = await c.req.json().catch(() => ({}))
    const url = String((body as Record<string, unknown>)?.url ?? '').trim()
    const usage = String((body as Record<string, unknown>)?.usage ?? '')
    if (!url) return badRequest(c, 'url 必填')
    if (usage !== 'reference' && usage !== 'direct') return badRequest(c, 'usage 必须是 reference / direct')
    try {
      const refs = await loadReferences(kind, id)
      const index = refs.findIndex(entry => entry.path === url)
      if (index < 0) return notFound(c, '参考图不存在')
      refs[index] = {
        ...refs[index],
        usage,
        classification: { verdict: usage, reason: '人工改判', at: Math.floor(Date.now() / 1000), manual: true },
      }
      const saved = await persistReferences(kind, id, refs)
      return success(c, { reference_images: saved })
    } catch (err) {
      return fail(c, err)
    }
  })

  // #121：把 direct 参考图显式采用为资产当前图（登记版本 + faithful 保护）
  app.post('/:id/reference-images/adopt', async (c) => {
    const id = Number(c.req.param('id'))
    const body: unknown = await c.req.json().catch(() => ({}))
    const url = String((body as Record<string, unknown>)?.url ?? '').trim()
    if (!url) return badRequest(c, 'url 必填')
    try {
      const refs = await loadReferences(kind, id)
      const entry = refs.find(item => item.path === url)
      if (!entry) return notFound(c, '参考图不存在')
      if (entry.usage !== 'direct') return badRequest(c, '该参考图不是 direct 用途，请先改判用途')
      const result = await adoptDirectImage(kind, id, url, { force: true, source: 'manual-adopt' })
      if (!result.adopted) return badRequest(c, result.reason || '采用失败')
      return success(c, { adopted: true, version_task_id: result.versionTaskId })
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
