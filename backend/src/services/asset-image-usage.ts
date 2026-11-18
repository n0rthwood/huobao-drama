/**
 * 资产图片用途分类与原件采用（Issue #121）
 *
 * 分类：参考图上传/素材库选入后异步跑一次视觉判定（vision-chat 同一通路），
 * 规则唯一来源 = workspace/skills/asset-image-usage（四语）。判 direct → 自动采用为
 * 资产当前图并打 faithful 保护；判 reference/unknown → 保持参考，绝不自动采用。
 *
 * 采用唯一写入口 adoptDirectImage：写当前图 + 登记 upload 版本行 + faithful/faithful_source。
 * 并发边界：已有 faithful 当前图不覆盖；分类启动后用户手动改过当前图则放弃自动采用。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { loadSkillDoc } from '../agents/skills.js'
import { getContentLanguage } from './app-settings.js'
import { resolveVisionTextConfig } from './vision-capability.js'
import { callTextChat, imageContentPart } from './vision-chat.js'
import { parseJsonReply } from './asset-pipeline/prompts.js'
import { ASSET_LABELS, loadReferences, persistReferences, type AssetKind } from './reference-images.js'

const ASSET_TABLES = {
  character: schema.characters,
  scene: schema.scenes,
  prop: schema.props,
} as unknown as Record<AssetKind, typeof schema.characters>

export interface ImageUsageVerdict {
  verdict: 'direct' | 'reference' | 'unknown'
  reason: string
}

/** 单次视觉判定；无视觉配置/失败 → unknown（调用方不得据此采用） */
export async function classifyAssetImage(kind: AssetKind, assetId: number, imagePath: string): Promise<ImageUsageVerdict> {
  const config = await resolveVisionTextConfig()
  if (!config) return { verdict: 'unknown', reason: '无可用视觉文本配置，未分类' }
  const table = ASSET_TABLES[kind]
  const [row] = await db.select().from(table).where(eq(table.id, assetId))
  const record = (row ?? {}) as unknown as Record<string, unknown>
  const name = String(record.name ?? record.location ?? '')
  const description = String(record.description ?? record.prompt ?? '')
  try {
    const skill = await loadSkillDoc('asset-image-usage', getContentLanguage())
    const image = await imageContentPart(imagePath, { maxSide: 1280, quality: 85 })
    const result = await callTextChat(config, [
      { type: 'text', text: `资产类型：${ASSET_LABELS[kind]}\n名称：${name}\n描述：${description || '（无）'}` },
      image.part,
    ], { systemPrompt: skill, temperature: 0.1, maxTokens: 1024, timeoutMs: 120_000 })
    const parsed = parseJsonReply(result.text) as Record<string, unknown>
    const verdict = parsed.verdict === 'direct' || parsed.verdict === 'reference' ? parsed.verdict : 'unknown'
    return { verdict, reason: String(parsed.reason ?? '').slice(0, 300) }
  } catch (err) {
    logTaskWarn('AssetImageUsage', 'classify-failed', { kind, assetId, error: err instanceof Error ? err.message : String(err) })
    return { verdict: 'unknown', reason: '视觉判定失败，未分类' }
  }
}

export interface AdoptResult {
  adopted: boolean
  reason?: string
  versionTaskId?: number
}

/**
 * 采用原件为资产当前图（唯一写入口）。`force=false`（自动采用）时：
 * 已有 faithful 当前图 → 不覆盖；当前图与 expectedCurrent 不一致（用户已手动改过）→ 放弃。
 * `force=true`（用户显式点「采用为资产图」）不受这两条限制。
 */
export async function adoptDirectImage(
  kind: AssetKind,
  assetId: number,
  imagePath: string,
  opts: { force?: boolean; expectedCurrent?: string | null; source?: string } = {},
): Promise<AdoptResult> {
  const table = ASSET_TABLES[kind]
  const [row] = await db.select().from(table).where(eq(table.id, assetId))
  if (!row || (row as unknown as Record<string, unknown>).deletedAt) return { adopted: false, reason: '资产不存在' }
  const record = row as unknown as Record<string, unknown>
  const current = String(record.imageUrl ?? '')
  if (!opts.force) {
    if (Number(record.faithful) === 1 && current) return { adopted: false, reason: '已有受保护的当前图，不覆盖' }
    if (opts.expectedCurrent !== undefined && current !== (opts.expectedCurrent ?? '')) {
      return { adopted: false, reason: '用户已手动更换当前图，放弃自动采用' }
    }
  }
  const ts = now()
  const result = await db.insert(schema.sysTask).values({
    type: 'image',
    ...(kind === 'character' ? { characterId: assetId } : kind === 'scene' ? { sceneId: assetId } : { propId: assetId }),
    dramaId: Number(record.dramaId),
    provider: 'upload',
    model: 'direct-adopt',
    params: JSON.stringify({ source: opts.source ?? 'direct-adopt', adopted_from: imagePath }),
    resultUrl: imagePath,
    localPath: imagePath,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
    generatedAt: Math.floor(Date.now() / 1000),
  })
  const versionTaskId = Number(result.lastInsertRowid)
  await db.update(table).set({
    imageUrl: imagePath,
    localPath: imagePath,
    faithful: 1,
    faithfulSource: versionTaskId,
    ...(kind === 'scene' ? { status: 'completed' } : {}),
    updatedAt: ts,
  }).where(eq(table.id, assetId))
  logTaskProgress('AssetImageUsage', 'adopted', { kind, assetId, versionTaskId, imagePath })
  return { adopted: true, versionTaskId }
}

/**
 * 参考图入库后的异步分类 + 自动采用（上传/素材库选入触发）。
 * 不抛错：分类失败只记 unknown；采用失败只记日志。条目按 path 定位（期间列表可能变化）。
 */
export function classifyReferenceInBackground(kind: AssetKind, assetId: number, imagePath: string): void {
  void (async () => {
    const table = ASSET_TABLES[kind]
    const [before] = await db.select().from(table).where(eq(table.id, assetId))
    const expectedCurrent = String((before as unknown as Record<string, unknown> | undefined)?.imageUrl ?? '')
    const verdict = await classifyAssetImage(kind, assetId, imagePath)
    const refs = await loadReferences(kind, assetId)
    const index = refs.findIndex(entry => entry.path === imagePath)
    if (index < 0) return // 分类期间已被删除
    const at = Math.floor(Date.now() / 1000)
    refs[index] = {
      ...refs[index],
      usage: verdict.verdict === 'direct' ? 'direct' : 'reference',
      classification: { verdict: verdict.verdict, reason: verdict.reason, at },
    }
    await persistReferences(kind, assetId, refs)
    if (verdict.verdict === 'direct') {
      const adopted = await adoptDirectImage(kind, assetId, imagePath, { expectedCurrent, source: 'auto-classify' })
      if (!adopted.adopted) logTaskProgress('AssetImageUsage', 'auto-adopt-skipped', { kind, assetId, reason: adopted.reason })
    }
  })().catch(err => logTaskWarn('AssetImageUsage', 'background-failed', { kind, assetId, error: err instanceof Error ? err.message : String(err) }))
}