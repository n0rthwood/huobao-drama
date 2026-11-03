/**
 * 项目类型（Issue #45）— `dramas.project_type` 的唯一口径
 *
 * - `drama`（默认）：短剧，行为与 #45 之前完全一致；
 * - `documentary`：纪录片，剧本正文即旁白稿（narration-first），强制纪录片规则集，
 *   默认风格 `documentary-archival`、`documentary_rules='on'`、新建剧集默认开旁白。
 *
 * 类型在创建时确定，之后不可切换（父 Issue #44 Q6）：PUT /dramas/:id 直接拒绝改动。
 *
 * 层次约束：与 genre-ruleset.ts 同层，只依赖 db；严禁 import agents/*。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export const PROJECT_TYPES = ['drama', 'documentary'] as const
export type ProjectType = typeof PROJECT_TYPES[number]

/** 纪录片项目的默认风格预设（创建时未显式指定风格才用它） */
export const DOCUMENTARY_DEFAULT_STYLE = 'documentary-archival'
/** 纪录片项目的默认画幅（前端预选，后端仍按白名单校验） */
export const DOCUMENTARY_DEFAULT_ASPECT_RATIO = '16:9'

export function isProjectType(v: unknown): v is ProjectType {
  return typeof v === 'string' && (PROJECT_TYPES as readonly string[]).includes(v)
}

/** 存量行可能为 NULL（迁移前建的项目）：一律按 drama 处理 */
export function normalizeProjectType(v: unknown): ProjectType {
  return isProjectType(v) ? v : 'drama'
}

/** 同步读取项目类型（better-sqlite3 的 .get()）；项目不存在按 drama 处理 */
export function resolveDramaProjectType(dramaId: number | null | undefined): ProjectType {
  if (!dramaId) return 'drama'
  const row = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  return normalizeProjectType(row?.projectType)
}
