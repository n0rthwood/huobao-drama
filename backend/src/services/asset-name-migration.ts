/**
 * 存量资产名迁移（Issue #34）：把不符合 `normalizeAssetName` 的角色/道具/场景名改成合法名，
 * 并把所属项目各集分镜提示词里的 `@旧名` 改成 `@新名`，再按改动的字段重算生成目标绑定。
 * 启动时执行，幂等：没有非法名就什么都不做。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { suggestUniqueName } from './asset-library.js'
import { normalizeAssetName, rewriteAssetMentions, type AssetRename } from './asset-name.js'
import { syncStoryboardBindingsFromPrompts } from './storyboard-assets.js'

type NamedKind = 'character' | 'prop' | 'scene'

interface NamedRow { kind: NamedKind; id: number; dramaId: number; name: string }

const PROMPT_COLUMNS = [
  ['firstFramePrompt', 'first_frame_prompt'],
  ['midFramePrompt', 'mid_frame_prompt'],
  ['lastFramePrompt', 'last_frame_prompt'],
  ['videoPrompt', 'video_prompt'],
  ['transitionPrompt', 'transition_prompt'],
] as const

async function loadLiveNamedRows(): Promise<NamedRow[]> {
  const characters = await db.select().from(schema.characters).where(isNull(schema.characters.deletedAt))
  const props = await db.select().from(schema.props).where(isNull(schema.props.deletedAt))
  const scenes = await db.select().from(schema.scenes).where(isNull(schema.scenes.deletedAt))
  return [
    ...characters.map(row => ({ kind: 'character' as const, id: row.id, dramaId: row.dramaId, name: row.name || '' })),
    ...props.map(row => ({ kind: 'prop' as const, id: row.id, dramaId: row.dramaId, name: row.name || '' })),
    ...scenes.map(row => ({ kind: 'scene' as const, id: row.id, dramaId: row.dramaId, name: row.location || '' })),
  ]
}

async function renameRow(row: NamedRow, name: string): Promise<void> {
  const updatedAt = now()
  if (row.kind === 'character') {
    await db.update(schema.characters).set({ name, updatedAt }).where(eq(schema.characters.id, row.id))
  } else if (row.kind === 'prop') {
    await db.update(schema.props).set({ name, updatedAt }).where(eq(schema.props.id, row.id))
  } else {
    await db.update(schema.scenes).set({ location: name, updatedAt }).where(eq(schema.scenes.id, row.id))
  }
}

export async function migrateAssetNames(): Promise<void> {
  const rows = await loadLiveNamedRows()
  const illegal = rows.filter(row => row.name && normalizeAssetName(row.name) !== row.name)
  if (!illegal.length) return

  for (const dramaId of new Set(illegal.map(row => row.dramaId))) {
    const dramaRows = rows.filter(row => row.dramaId === dramaId)
    const renames: AssetRename[] = []
    for (const row of illegal.filter(item => item.dramaId === dramaId)) {
      const normalized = normalizeAssetName(row.name)
      if (!normalized) {
        logTaskWarn('AssetName', 'migrate-skip-empty', { kind: row.kind, id: row.id, name: row.name })
        continue
      }
      const taken = dramaRows.filter(other => other.kind === row.kind && other !== row).map(other => other.name)
      const name = suggestUniqueName(normalized, taken)
      await renameRow(row, name)
      renames.push({ from: row.name, to: name })
      logTaskProgress('AssetName', 'migrate-rename', { kind: row.kind, id: row.id, from: row.name, to: name })
      row.name = name
    }
    if (!renames.length) continue

    const legalNames = dramaRows.map(row => row.name).filter(name => name && normalizeAssetName(name) === name)
    const episodeIds = (await db.select({ id: schema.episodes.id }).from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))).map(row => row.id)
    if (!episodeIds.length) continue
    const storyboards = await db.select().from(schema.storyboards)
      .where(and(inArray(schema.storyboards.episodeId, episodeIds), isNull(schema.storyboards.deletedAt)))
    let rewritten = 0
    for (const storyboard of storyboards) {
      const updates: Record<string, string> = {}
      const fields: string[] = []
      for (const [column, field] of PROMPT_COLUMNS) {
        const before = storyboard[column] || ''
        const after = rewriteAssetMentions(before, renames, legalNames)
        if (after !== before) {
          updates[column] = after
          fields.push(field)
        }
      }
      if (!fields.length) continue
      await db.update(schema.storyboards).set({ ...updates, updatedAt: now() }).where(eq(schema.storyboards.id, storyboard.id))
      await syncStoryboardBindingsFromPrompts(storyboard.id, fields)
      rewritten++
    }
    logTaskProgress('AssetName', 'migrate-done', { dramaId, renamed: renames.length, storyboards: rewritten })
  }
}
