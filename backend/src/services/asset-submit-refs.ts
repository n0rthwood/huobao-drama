/**
 * 资产生图提交的引用装配（Issue #121）——三条 generate-image 路由与资产批量共用。
 *
 * 发送集合只按 final_prompt 最终文本引用的参考图（资产编号 → 请求编号连续映射）；
 * 零引用 = 一张不发。提交前再核验一次（保存时通过 ≠ 提交时仍有效）：
 * 越界引用、描述引用未落地、被引用文件缺失都 400，不静默排除后继续生成。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  checkReferenceCitations,
  citationIssueMessage,
  citedReferenceIndices,
  referenceNameIndex,
} from './asset-reference-prompt.js'
import { effectiveReferenceImages, partitionMissingReferences, resolveReferenceImages, type AssetKind } from './reference-images.js'

const ASSET_TABLES = {
  character: schema.characters,
  scene: schema.scenes,
  prop: schema.props,
} as unknown as Record<AssetKind, typeof schema.characters>

/** 各资产类型里允许写 @参考图N 的描述字段（与 reference-images.ts 的 CITABLE_FIELDS 同口径） */
const DESCRIPTION_FIELDS: Record<AssetKind, string[]> = {
  character: ['description', 'appearance', 'styling'],
  scene: ['prompt', 'lighting'],
  prop: ['description'],
}

/** 资产描述字段里的引用集合（去重升序，含越界——越界由核验报错） */
export function descriptionCitationsOf(kind: AssetKind, row: Record<string, unknown>): number[] {
  const found = new Set<number>()
  for (const field of DESCRIPTION_FIELDS[kind]) {
    const value = row[field]
    if (typeof value === 'string') for (const n of citedReferenceIndices(value)) found.add(n)
  }
  return [...found].sort((a, b) => a - b)
}

export interface AssetReferencePlan {
  /** 实际发送的参考图路径（请求编号 1..M 顺序） */
  referenceImages: string[]
  /** 资产编号 → 请求编号（落盘 refNameIndex，重试用） */
  refNameIndex: Record<string, number>
  /** 磁盘缺失但未被引用的参考图（只提示，不阻断） */
  missing: string[]
}

export class AssetReferenceError extends Error {}

/**
 * 装配发送计划。`prompt` = 本次生图的最终提示词（含风格前缀）；
 * `override` = 请求显式传入的 reference_images（含空数组 = 以请求为准，此时不做引用过滤，
 * 因为调用方显式指定了发送集合——保留旧语义供调试/特殊入口）。
 */
export async function planAssetReferences(
  kind: AssetKind,
  assetId: number,
  prompt: string,
  override?: unknown,
): Promise<AssetReferencePlan> {
  const table = ASSET_TABLES[kind]
  const [row] = await db.select().from(table).where(eq(table.id, assetId))
  if (!row) throw new AssetReferenceError('资产不存在')
  const record = row as unknown as Record<string, unknown>
  const present = effectiveReferenceImages(record.referenceImages)
  const descCites = descriptionCitationsOf(kind, record)

  if (override !== undefined && override !== null) {
    const resolved = resolveReferenceImages(record.referenceImages, override)
    const { present: refs, missing } = partitionMissingReferences(resolved)
    return { referenceImages: refs, refNameIndex: referenceNameIndex(refs.length), missing }
  }

  // 编号口径 = 在盘列表（与读工具/保存闸门一致）；库内存在但磁盘缺失的图不在编号内，
  // 引用它会以「越界」报错。缺失清单只作提示返回。
  const check = checkReferenceCitations(prompt, { refCount: present.length, descriptionCitations: descCites })
  const issue = citationIssueMessage(check, present.length)
  if (issue) throw new AssetReferenceError(issue)
  const { missing } = partitionMissingReferences(resolveReferenceImages(record.referenceImages))
  const indices = check.willSend
  return {
    referenceImages: indices.map(n => present[n - 1]!),
    refNameIndex: referenceNameIndex(present.length, indices),
    missing,
  }
}