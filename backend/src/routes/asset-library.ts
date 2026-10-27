/**
 * 资产库浏览接口（Issue #9）——资产管理器对话框的数据源。
 * 关联接口挂在 /episodes/:id/assets/link，导入接口挂在 /dramas/:id/assets/import。
 */
import { Hono } from 'hono'
import { success, badRequest, notFound } from '../utils/response.js'
import {
  AssetLibraryError,
  getLibraryAsset,
  isAssetKind,
  listAssetLibrary,
  suggestUniqueName,
  takenAssetNames,
} from '../services/asset-library.js'

const app = new Hono()

/** GET /asset-library?drama_id=&kind=&q= — 列出可浏览的资产（省略 drama_id = 全部项目） */
app.get('/', async (c) => {
  const kindParam = c.req.query('kind')
  if (kindParam && !isAssetKind(kindParam)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const dramaIdParam = c.req.query('drama_id')
  const dramaId = dramaIdParam ? Number(dramaIdParam) : undefined
  if (dramaIdParam && !Number.isInteger(dramaId)) return badRequest(c, 'drama_id 必须是整数')

  const data = await listAssetLibrary({
    dramaId,
    kind: isAssetKind(kindParam) ? kindParam : undefined,
    keyword: c.req.query('q') || undefined,
  })

  // 目标项目已占用的名字：前端据此预填改名输入框（与后端同一 suggestUniqueName 规则）
  const targetDramaId = c.req.query('target_drama_id') ? Number(c.req.query('target_drama_id')) : undefined
  const takenNames = targetDramaId && Number.isInteger(targetDramaId)
    ? {
      character: await takenAssetNames('character', targetDramaId),
      scene: await takenAssetNames('scene', targetDramaId),
      prop: await takenAssetNames('prop', targetDramaId),
    }
    : undefined
  return success(c, { ...data, taken_names: takenNames })
})

/** GET /asset-library/:kind/:id — 单个资产详情（文本字段 + 全部历史版本 + 参考图） */
app.get('/:kind/:id', async (c) => {
  const kind = c.req.param('kind')
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, 'id 必须是正整数')
  try {
    return success(c, await getLibraryAsset(kind, id))
  } catch (err) {
    if (err instanceof AssetLibraryError) {
      return err.status === 404 ? notFound(c, err.message) : badRequest(c, err.message)
    }
    throw err
  }
})

/** GET /asset-library/suggest-name?drama_id=&kind=&name= — 同名时的建议新名（名字-2…） */
app.get('/suggest-name', async (c) => {
  const kind = c.req.query('kind')
  if (!isAssetKind(kind)) return badRequest(c, 'kind 必须是 character / scene / prop')
  const dramaId = Number(c.req.query('drama_id'))
  if (!Number.isInteger(dramaId) || dramaId <= 0) return badRequest(c, 'drama_id 必填')
  const name = String(c.req.query('name') || '').trim()
  if (!name) return badRequest(c, 'name 必填')
  const taken = await takenAssetNames(kind, dramaId)
  return success(c, { name: suggestUniqueName(name, taken), taken })
})

export default app
