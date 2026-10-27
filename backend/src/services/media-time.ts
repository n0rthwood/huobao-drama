/**
 * 媒体生成时间（unix 秒）——所有「生成/上传的图片与视频」的时间来源。
 *
 * 口径（Issue #14 用户决策 #3）：生成时间 = 产出时刻，即任务完成时刻。
 * - 落库：`sys_task.generated_at` / `video_merges.generated_at`，INTEGER unix 秒。
 * - 单一写入点：完成时统一用 `completionStamp()` 生成 `completed_at` + `generated_at`，
 *   避免两个字段漂移。
 * - 资产 / 分镜的「当前选中媒体」不另存列：按 `local_path`（兼容远端 `result_url`）
 *   批量反查 `sys_task`；反查不到（版本任务已被删除）→ 不显示时间，不报错、不占位。
 */
import { inArray, isNull, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

/** ISO 字符串 → unix 秒；非法/空值 → null */
export function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * 任务/成片完成时的时间戳组合——所有完成写入点必须用它，保证两列同源。
 * 传入 ts 可复用调用方已有的时间串。
 */
export function completionStamp(ts: string = now()): { completedAt: string; generatedAt: number } {
  return { completedAt: ts, generatedAt: toUnixSeconds(ts)! }
}

/**
 * 存量行回填：`generated_at` 为空时按 `completed_at || created_at` 换算。
 * 幂等：已有值的行不动。启动时执行一次。
 */
export async function backfillGeneratedAt(): Promise<number> {
  let filled = 0

  const tasks = await db.select().from(schema.sysTask).where(isNull(schema.sysTask.generatedAt))
  for (const row of tasks) {
    const seconds = toUnixSeconds(row.completedAt) ?? toUnixSeconds(row.createdAt)
    if (seconds == null) continue
    await db.update(schema.sysTask).set({ generatedAt: seconds })
      .where(inArray(schema.sysTask.id, [row.id]))
    filled += 1
  }

  const merges = await db.select().from(schema.videoMerges).where(isNull(schema.videoMerges.generatedAt))
  for (const row of merges) {
    const seconds = toUnixSeconds(row.completedAt) ?? toUnixSeconds(row.createdAt)
    if (seconds == null) continue
    await db.update(schema.videoMerges).set({ generatedAt: seconds })
      .where(inArray(schema.videoMerges.id, [row.id]))
    filled += 1
  }

  if (filled > 0) console.log(`🕒 已回填 ${filled} 行媒体生成时间`)
  return filled
}

/**
 * 「当前媒体」路径 → 生成时间（unix 秒）。每次调用一次批量 IN 查询。
 * 同一路径命中多条任务时取最大的 generated_at（最后一次产出该文件的任务）。
 */
export async function lookupGeneratedAt(paths: Array<string | null | undefined>): Promise<Map<string, number>> {
  const wantedSet = new Set(paths.filter((p): p is string => !!p))
  const wanted = [...wantedSet]
  const result = new Map<string, number>()
  if (!wanted.length) return result

  const rows = await db.select().from(schema.sysTask).where(or(
    inArray(schema.sysTask.localPath, wanted),
    inArray(schema.sysTask.resultUrl, wanted),
  ))
  for (const row of rows) {
    if (row.generatedAt == null) continue
    for (const key of [row.localPath, row.resultUrl]) {
      if (!key || !wantedSet.has(key)) continue
      const prev = result.get(key)
      if (prev == null || row.generatedAt > prev) result.set(key, row.generatedAt)
    }
  }
  return result
}
