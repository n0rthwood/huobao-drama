/**
 * 资产关联清理（Issue #15）
 *
 * 角色/场景/道具是软删（deleted_at），但集关联与分镜绑定行不删，
 * 残留行会让提取 Agent、@引用 解析和参考图装配继续看到已删资产。
 * 删除资产时同步清掉关联（含关键帧/视频级绑定，Issue #18）；启动时另有一次幂等的存量清理（db/sqlite-schema.ts）。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { deleteTargetBindings, type AssetKind } from './storyboard-assets.js'

/** 删除某资产的全部集关联与分镜绑定（幂等） */
export async function deleteAssetLinks(kind: AssetKind, assetId: number): Promise<void> {
  await deleteTargetBindings({ kind, assetIds: [assetId] })
  if (kind === 'character') {
    await db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.characterId, assetId))
    await db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.characterId, assetId))
    return
  }
  if (kind === 'prop') {
    await db.delete(schema.episodeProps).where(eq(schema.episodeProps.propId, assetId))
    await db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.propId, assetId))
    return
  }
  await db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.sceneId, assetId))
}
