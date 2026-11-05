/**
 * 底图候选（Issue #56，契约 §6.2 末条；R4 的 `BaseRef`、R5 的 `base_ref` 消费）
 *
 * 只认三类可用图，顺序即可信度：
 * 1. `faithful` 原件版本（上传的证据素材本身）；
 * 2. 通过程序闸门的流水线轮次图；
 * 3. 资产当前已生成图。
 *
 * **未过闸门的美化轮不可选**：允许它当底图等于让一张已知失真的图进入成片链路，
 * 那正是第一轮事故的形态（扩散重画的地图被当成底图继续用下去）。
 */
import { and, eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'
import { db, schema } from '../../db/index.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { latestQcByRound, listAssetRounds, type AssetKind } from './store.js'

export interface BaseCandidate {
  asset_kind: AssetKind
  asset_id: number
  asset_name: string
  /** 该图对应的 sys_task 版本行 id；当前图没有版本行时为 null */
  version_task_id: number | null
  path: string
  width: number | null
  height: number | null
  verified: 'faithful' | 'gate_passed' | 'generated'
}

interface AssetRef {
  kind: AssetKind
  id: number
  name: string
  imageUrl: string | null
  faithfulSource: number | null
}

async function episodeAssets(episodeId: number): Promise<AssetRef[]> {
  const out: AssetRef[] = []

  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  if (characterLinks.length) {
    const rows = await db.select().from(schema.characters)
      .where(inArray(schema.characters.id, characterLinks.map(link => link.characterId)))
    for (const row of rows) {
      if (row.deletedAt) continue
      out.push({ kind: 'character', id: row.id, name: row.name, imageUrl: row.localPath || row.imageUrl || null, faithfulSource: null })
    }
  }

  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  if (sceneLinks.length) {
    const rows = await db.select().from(schema.scenes)
      .where(inArray(schema.scenes.id, sceneLinks.map(link => link.sceneId)))
    for (const row of rows) {
      if (row.deletedAt) continue
      out.push({ kind: 'scene', id: row.id, name: row.location, imageUrl: row.localPath || row.imageUrl || null, faithfulSource: null })
    }
  }

  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  if (propLinks.length) {
    const rows = await db.select().from(schema.props)
      .where(inArray(schema.props.id, propLinks.map(link => link.propId)))
    for (const row of rows) {
      if (row.deletedAt) continue
      out.push({
        kind: 'prop',
        id: row.id,
        name: row.name,
        imageUrl: row.localPath || row.imageUrl || null,
        faithfulSource: row.faithful === 1 ? row.faithfulSource ?? null : null,
      })
    }
  }
  return out
}

export async function listBaseCandidates(episodeId: number): Promise<BaseCandidate[]> {
  const assets = await episodeAssets(episodeId)
  const candidates: BaseCandidate[] = []

  for (const asset of assets) {
    const seen = new Set<string>()

    if (asset.faithfulSource) {
      const [task] = await db.select().from(schema.sysTask)
        .where(and(eq(schema.sysTask.id, asset.faithfulSource), eq(schema.sysTask.type, 'image')))
      const path = task?.localPath || task?.resultUrl || null
      if (path) {
        const size = await imageSize(path)
        candidates.push({
          asset_kind: asset.kind, asset_id: asset.id, asset_name: asset.name,
          version_task_id: task!.id, path, width: size.width, height: size.height, verified: 'faithful',
        })
        seen.add(path)
      }
    }

    const allRounds = await listAssetRounds(asset.kind, asset.id)
    // 任何流水线轮次产出的图都**只能**走闸门/人工这条判定，绝不能再从「资产当前图」
    // 兜底混进候选——否则一张被打回的美化图只要碰巧是当前图就又回到候选里。
    const pipelinePaths = new Set(allRounds.map(round => round.image_path).filter(Boolean) as string[])
    const rounds = allRounds.filter(round => round.status === 'generated' && round.image_path)
    const qcByRound = await latestQcByRound(rounds.map(round => round.id))
    for (const round of rounds) {
      const qc = qcByRound.get(round.id)
      // 人工裁决优先于程序闸门：打回 / 回退 / 终止一律不可选，哪怕闸门判过
      const human = qc?.human_verdict ?? null
      const passed = human
        ? human === 'approve'
        : qc?.gate_pass === 1
      if (!passed || seen.has(round.image_path!)) continue
      candidates.push({
        asset_kind: asset.kind, asset_id: asset.id, asset_name: asset.name,
        version_task_id: round.image_task_id,
        path: round.image_path!,
        width: round.width,
        height: round.height,
        verified: 'gate_passed',
      })
      seen.add(round.image_path!)
    }

    if (asset.imageUrl && !seen.has(asset.imageUrl) && !pipelinePaths.has(asset.imageUrl)) {
      const size = await imageSize(asset.imageUrl)
      candidates.push({
        asset_kind: asset.kind, asset_id: asset.id, asset_name: asset.name,
        version_task_id: null, path: asset.imageUrl, width: size.width, height: size.height, verified: 'generated',
      })
    }
  }
  return candidates
}

/** 版本行没有宽高列，只能探测一次（轮次图的宽高在 asset_round 上，不走这里） */
async function imageSize(relativePath: string): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(getAbsolutePath(relativePath)).metadata()
    return { width: meta.width ?? null, height: meta.height ?? null }
  } catch {
    return { width: null, height: null }
  }
}
