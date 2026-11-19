/**
 * 单资产「删除图片版本」（Issue #123）— 角色 / 场景 / 道具共用一套实现
 *
 *   DELETE /:id/image-versions/:taskId → { deleted, id, files_removed }
 *
 * 版本 = sys_task 中 type='image' AND status='completed' 且 owner 指向该资产的行
 * （与 asset-library.loadImageVersions 同口径）。守卫顺序固定：
 * 归属/完成态 → 受保护原件来源 → 当前生效图 → 下游钉选/活跃草稿输入。
 * DB 事务先提交，文件清理 best-effort（跨 DB/FS 无原子性，响应带 files_removed）。
 */
import fs from 'fs'
import path from 'path'
import type { Context, Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema, sqlite } from '../db/index.js'
import { badRequest, notFound, success } from '../utils/response.js'
import { getAbsolutePath, thumbPathFor } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { logTaskWarn } from '../utils/task-logger.js'
import { countVersionPins } from '../services/asset-library.js'
import type { AssetKind } from '../services/reference-images.js'

const TABLES = { character: schema.characters, scene: schema.scenes, prop: schema.props } as const
const OWNER_COLUMN = { character: 'character_id', scene: 'scene_id', prop: 'prop_id' } as const

export function mountImageVersionRoutes(app: Hono, kind: AssetKind) {
  app.delete('/:id/image-versions/:taskId', async (c: Context) => {
    const id = Number(c.req.param('id'))
    const taskId = Number(c.req.param('taskId'))
    const table = TABLES[kind]
    const [asset] = await db.select().from(table).where(eq(table.id, id))
    if (!asset || asset.deletedAt) return notFound(c, '资产不存在')
    const task = sqlite.prepare(`SELECT id,type,status,local_path,result_url,${OWNER_COLUMN[kind]} AS owner_id FROM sys_task WHERE id=?`).get(taskId) as
      { id: number; type: string; status: string; local_path: string | null; result_url: string | null; owner_id: number | null } | undefined
    if (!task || task.type !== 'image' || task.status !== 'completed' || task.owner_id !== id) {
      return notFound(c, '版本不存在或不属于该资产')
    }
    if (taskId === asset.faithfulSource) return badRequest(c, '该版本是受保护原件的来源，不能删除')
    const versionPath = task.local_path || task.result_url
    const currentPath = asset.localPath || asset.imageUrl
    if (versionPath && versionPath === currentPath) return badRequest(c, '当前生效版本不能删除，请先切换到其他版本')
    const pins = countVersionPins(kind, id, taskId, versionPath)
    if (pins > 0) return badRequest(c, `该版本被 ${pins} 处分镜/图层引用，请先解除引用后再删除`)
    // 活跃草稿（展开中/待确认）把该版本冻结为输入：删除会让草稿静默失效，拒删
    const drafts = sqlite.prepare("SELECT inputs FROM asset_studio_draft WHERE asset_kind=? AND asset_id=? AND status IN ('drafting','ready')").all(kind, id) as { inputs: string }[]
    for (const draft of drafts) {
      try {
        const inputs = JSON.parse(draft.inputs) as { version_task_id?: number | null }
        if (inputs.version_task_id === taskId) return badRequest(c, '该版本正被工作室草稿用作输入，请先完成或删除草稿')
      } catch { /* 坏 JSON 视为无引用 */ }
    }
    // DB 先提交：版本行删除 + 交付历史指针置空（交付行保留审计）
    sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM sys_task WHERE id=?').run(taskId)
      sqlite.prepare('UPDATE asset_studio_delivery SET version_id=NULL WHERE version_id=?').run(taskId)
    })()
    // 文件清理 best-effort：只删 static 根内的路径（防目录穿越/误删），失败只告警
    let filesRemoved = false
    if (versionPath) {
      const staticRoot = path.resolve(path.join(STORAGE_ROOT, '..', 'static'))
      const absolute = path.resolve(getAbsolutePath(versionPath))
      if (absolute.startsWith(staticRoot + path.sep)) {
        try {
          fs.rmSync(absolute, { force: true })
          fs.rmSync(path.resolve(getAbsolutePath(thumbPathFor(versionPath))), { force: true })
          filesRemoved = true
        } catch (err) {
          logTaskWarn('AssetVersion', 'delete-file', { taskId, path: versionPath, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    return success(c, { deleted: true, id: taskId, files_removed: filesRemoved })
  })
}