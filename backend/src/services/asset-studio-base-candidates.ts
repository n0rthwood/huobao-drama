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
import { db, schema, sqlite } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { latestQcByRound, listAssetRounds, type AssetKind } from '../modules/asset-studio/index.js'

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

export type FidelityVerdict = 'verified' | 'failed'

export interface FidelityReadout {
  fidelity: FidelityVerdict | null
  reason: string | null
}

/** 版本行 params → 存量核验结论 */
export function fidelityOf(params: string | null | undefined): FidelityReadout {
  if (!params) return { fidelity: null, reason: null }
  try {
    const parsed: unknown = JSON.parse(params)
    if (!parsed || typeof parsed !== 'object') return { fidelity: null, reason: null }
    const record = parsed as Record<string, unknown>
    const fidelity = record.fidelity === 'verified' || record.fidelity === 'failed' ? record.fidelity : null
    return { fidelity, reason: typeof record.fidelity_reason === 'string' ? record.fidelity_reason : null }
  } catch {
    return { fidelity: null, reason: null }
  }
}

/**
 * 批量取流水线轮次的结论：生图 sys_task id → 结论。
 * 版本装配是同步 map，所以这里一次性把整批查出来，不在循环里打库。
 */
export async function loadPipelineFidelity(imageTaskIds: number[]): Promise<Map<number, FidelityReadout>> {
  const result = new Map<number, FidelityReadout>()
  const ids = [...new Set(imageTaskIds.filter(id => Number.isFinite(id) && id > 0))]
  if (!ids.length) return result

  const placeholders=ids.map(()=>'?').join(',')
  const rounds=sqlite.prepare(`SELECT image_task_id AS imageTaskId,round_no AS roundNo,id FROM asset_studio_round WHERE image_task_id IN (${placeholders})`).all(...ids) as {imageTaskId:number;roundNo:number;id:number}[]
  if(!rounds.length)return result
  const records=sqlite.prepare(`SELECT round_id AS roundId,id,human_verdict AS humanVerdict,human_notes AS humanNotes,gate_pass AS gatePass,checklist_coverage AS checklistCoverage FROM asset_studio_qc_record WHERE round_id IN (${rounds.map(()=>'?').join(',')})`).all(...rounds.map(r=>r.id)) as {roundId:number;id:number;humanVerdict:string|null;humanNotes:string|null;gatePass:number;checklistCoverage:number|null}[]
  // 同一轮可追加多条 QC（便宜步允许重算）：以最新一条为准（主进程裁决「疑问 2」）
  const latestByRound = new Map<number, typeof records[number]>()
  for (const record of records) {
    const prev = latestByRound.get(record.roundId)
    if (!prev || record.id > prev.id) latestByRound.set(record.roundId, record)
  }

  // 新模型（Issue #123）：人工「采用为当前图」= 显式确认 → verified；仅保存不改写 QC 结论。
  // 历史 human_verdict 仍按历史事实读取（上面两个分支）。version_id 已置空的交付行不作为采用证据。
  const adopted=sqlite.prepare(`SELECT round_id FROM asset_studio_delivery WHERE round_id IN (${rounds.map(()=>'?').join(',')}) AND set_as_current=1 AND version_id IS NOT NULL`).all(...rounds.map(r=>r.id)) as {round_id:number}[]
  const adoptedRounds=new Set(adopted.map(row=>row.round_id))
  for (const round of rounds) {
    const record = latestByRound.get(round.id)
    if (!record) {
      result.set(round.imageTaskId!, { fidelity: null, reason: `流水线第 ${round.roundNo} 轮，尚未核验` })
      continue
    }
    const human = record.humanVerdict
    if (human === 'approve') {
      result.set(round.imageTaskId!, {
        fidelity: 'verified',
        reason: `人工通过（第 ${round.roundNo} 轮，闸门${record.gatePass ? '通过' : '未通过'}）${record.humanNotes ? `：${record.humanNotes}` : ''}`,
      })
      continue
    }
    if (human === 'revise' || human === 'rollback' || human === 'abort') {
      result.set(round.imageTaskId!, {
        fidelity: 'failed',
        reason: `人工判为不可用（第 ${round.roundNo} 轮，动作 ${human}）${record.humanNotes ? `：${record.humanNotes}` : ''}`,
      })
      continue
    }
    if (adoptedRounds.has(round.id)) {
      result.set(round.imageTaskId!, {
        fidelity: 'verified',
        reason: `人工已采用为当前图（第 ${round.roundNo} 轮，闸门${record.gatePass ? '通过' : '未通过'}，采用即人工确认）`,
      })
      continue
    }
    result.set(round.imageTaskId!, {
      fidelity: record.gatePass ? 'verified' : 'failed',
      reason: `程序闸门${record.gatePass ? '通过' : '未通过'}（第 ${round.roundNo} 轮，清单覆盖率 ${Math.round((record.checklistCoverage ?? 0) * 100)}%，顾问性），采用即人工确认`,
    })
  }
  return result
}
