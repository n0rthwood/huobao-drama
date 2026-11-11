/**
 * 单资产「生成项目画幅版本」（Issue #94）— 场景 / 道具 / 角色共用一套实现
 *
 *   POST /:id/aspect-version  { episode_id, config_id? } → { task_id, size }
 *
 * 入口在图层段编辑器的「底图比例与成片不符」提示里：被图层用作底图的资产按项目画幅
 * 重出一版（以当前图为唯一参考），完成后照常成为当前图。忠实素材与地图道具返回 400。
 */
import type { Context, Hono } from 'hono'
import { badRequest, success } from '../utils/response.js'
import { startAspectVersion, type AspectVersionKind } from '../services/asset-aspect-version.js'

export function mountAspectVersionRoute(app: Hono, kind: AspectVersionKind) {
  app.post('/:id/aspect-version', async (c: Context) => {
    const id = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const episodeId = Number((body as Record<string, unknown>).episode_id)
    if (!episodeId) return badRequest(c, 'episode_id 必填')
    const rawConfigId = Number((body as Record<string, unknown>).config_id)
    try {
      const result = await startAspectVersion(kind, id, {
        episodeId,
        configId: Number.isInteger(rawConfigId) && rawConfigId > 0 ? rawConfigId : undefined,
      })
      return success(c, result)
    } catch (err) {
      // 重绘拒绝的文案要直接显示在图层段编辑器里：message 之外再带一份 error，
      // 前端无需按状态码翻译
      const message = err instanceof Error ? err.message : String(err)
      return badRequest(c, message, { error: message })
    }
  })
}
