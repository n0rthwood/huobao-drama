/**
 * 资产画幅版本（Issue #94）——「以当前图为参考，按项目画幅重出一版并成为当前图」。
 *
 * 为什么需要它：场景/道具/角色都可能被图层用作底图，底图比例与成片不符时渲染只能
 * contain 留白（永不拉伸）。留白能看但不好看，所以给一个**手动**入口重出项目画幅版本——
 * 手动是刻意的：重绘要烧算力，也会改变画面，不能自动发生。
 *
 * 不能重绘的两类素材直接 400：
 * - 忠实素材（跨项目导入 / 上传原件 / `props.faithful=1`）：重绘就不再是原件；
 * - 地图道具（`asset_type='map'`）：几何由地图工作流确定性渲染，扩散模型一画就错。
 * 它们只能裁切或留白，并由底图视觉验证把关。
 */
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { generateImage } from './generation.js'
import { isFaithfulCurrentImage } from './asset-batch-select.js'
import { assetImageSizeFor, parseImageSize, resolveDramaAspect } from './asset-image-size.js'
import { compositionOf } from './aspect.js'
import { ensureCharacterFinalPrompt, ensurePropFinalPrompt, ensureSceneFinalPrompt, savedPromptOf } from './final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export type AspectVersionKind = 'scene' | 'prop' | 'character'

/** 当前图比例与项目画幅的允许偏差：差在 1% 以内视为已经是项目画幅 */
const SAME_ASPECT_TOLERANCE = 0.01

/** 400 的统一口径：拒绝重绘时告诉用户还能怎么做 */
export const FAITHFUL_REFUSAL = '该素材不能重绘，请裁切到成片比例或留白，并通过视觉验证'
export const MAP_REFUSAL = '地图资产的画面由地图工作流确定性渲染，不能重绘；请裁切到成片比例或留白，并通过视觉验证'
export const NO_IMAGE_REFUSAL = '该资产还没有当前图，画幅版本要以当前图为参考，请先生成或上传图片'
export const ALREADY_ASPECT_REFUSAL = '当前图已经是项目画幅，不需要生成画幅版本'

export interface AspectVersionRefusalInput {
  /** 忠实素材（isFaithfulCurrentImage） */
  faithful: boolean
  /** 地图道具（props.asset_type='map'） */
  isMap: boolean
  /** 是否有当前图 */
  hasImage: boolean
  /** 当前图比例是否已是项目画幅（探测不到尺寸时传 false，照常重出） */
  alreadyProjectAspect: boolean
}

/** 画幅版本的拒绝判定（纯函数）：返回 400 文案，放行时返回 null */
export function aspectVersionRefusal(input: AspectVersionRefusalInput): string | null {
  if (input.isMap) return MAP_REFUSAL
  if (input.faithful) return FAITHFUL_REFUSAL
  if (!input.hasImage) return NO_IMAGE_REFUSAL
  if (input.alreadyProjectAspect) return ALREADY_ASPECT_REFUSAL
  return null
}

/** 画幅版本提示词后缀：参考图只用来保住主体，构图必须换成项目画幅 */
export function aspectVersionPromptSuffix(aspect: string): string {
  return `保持参考图中的主体、造型、材质与风格不变，重新构图为 ${aspect} ${compositionOf(aspect)}，延展补全画面，不裁掉主体`
}

/** 调用方可直接当 400 文案用的错误 */
export class AspectVersionError extends Error {}

export interface StartAspectVersionOptions {
  episodeId: number
  configId?: number
}

export interface StartAspectVersionResult {
  task_id: number
  size: string
}

interface AssetSnapshot {
  id: number
  dramaId: number
  name: string
  imageUrl: string | null
  isMap: boolean
  faithfulFlag: number
}

async function loadAsset(kind: AspectVersionKind, assetId: number): Promise<AssetSnapshot | null> {
  if (kind === 'scene') {
    const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, assetId))
    if (!row || row.deletedAt) return null
    return { id: row.id, dramaId: row.dramaId, name: row.location, imageUrl: row.imageUrl, isMap: false, faithfulFlag: 0 }
  }
  if (kind === 'prop') {
    const [row] = await db.select().from(schema.props).where(eq(schema.props.id, assetId))
    if (!row || row.deletedAt) return null
    return { id: row.id, dramaId: row.dramaId, name: row.name, imageUrl: row.imageUrl, isMap: row.assetType === 'map', faithfulFlag: Number(row.faithful) }
  }
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, assetId))
  if (!row || row.deletedAt) return null
  return { id: row.id, dramaId: row.dramaId, name: row.name, imageUrl: row.imageUrl, isMap: false, faithfulFlag: 0 }
}

/** 该资产已完成的图像任务行（判忠实素材要看当前图属于哪一版） */
async function loadVersionRows(kind: AspectVersionKind, assetId: number) {
  const owner = kind === 'scene' ? schema.sysTask.sceneId : kind === 'prop' ? schema.sysTask.propId : schema.sysTask.characterId
  const rows = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'image'), eq(owner, assetId), eq(schema.sysTask.status, 'completed')))
  return rows.map(row => ({ provider: row.provider, resultUrl: row.resultUrl, localPath: row.localPath }))
}

/** 当前图比例是否已是目标画幅；图读不出来时按「不是」处理（照常重出，不白白拦住用户） */
async function currentImageMatchesSize(imagePath: string, size: string): Promise<boolean> {
  const want = parseImageSize(size)
  if (!want) return false
  try {
    const meta = await sharp(getAbsolutePath(imagePath)).metadata()
    if (!meta.width || !meta.height) return false
    const target = want.width / want.height
    return Math.abs(meta.width / meta.height - target) / target <= SAME_ASPECT_TOLERANCE
  } catch {
    return false
  }
}

/** 资产最终提示词（缺失时按既有链路补生成）；文本模型用阶段默认配置，不借用图像 config_id */
async function ensureFinalPrompt(kind: AspectVersionKind, assetId: number, episodeId: number): Promise<string> {
  const opts = undefined
  if (kind === 'scene') {
    const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, assetId))
    return row ? savedPromptOf(await ensureSceneFinalPrompt(row, episodeId, false, opts)) : ''
  }
  if (kind === 'prop') {
    const [row] = await db.select().from(schema.props).where(eq(schema.props.id, assetId))
    return row ? savedPromptOf(await ensurePropFinalPrompt(row, episodeId, false, opts)) : ''
  }
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, assetId))
  return row ? savedPromptOf(await ensureCharacterFinalPrompt(row, episodeId, false, opts)) : ''
}

/**
 * 以当前图为唯一参考，按项目画幅重出一版。
 * 完成后走 generation.ts 的常规回写：成为资产当前图并触发 onAssetLibraryChanged，
 * 跟随当前图的图层段底图随之刷新（segment-source-refresh.ts）。
 */
export async function startAspectVersion(
  kind: AspectVersionKind,
  assetId: number,
  opts: StartAspectVersionOptions,
): Promise<StartAspectVersionResult> {
  const asset = await loadAsset(kind, assetId)
  if (!asset) throw new AspectVersionError('资产不存在')
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(opts.episodeId)))
  if (!episode) throw new AspectVersionError('剧集不存在')

  const aspect = await resolveDramaAspect(asset.dramaId)
  // 道具/角色的画幅版本也按场景尺寸表出：它此刻的用途是图层底图，不再是参考图
  const size = assetImageSizeFor('scene', aspect)
  const current = (asset.imageUrl || '').trim()
  const refusal = aspectVersionRefusal({
    isMap: asset.isMap,
    faithful: isFaithfulCurrentImage(
      { imageUrl: asset.imageUrl, localPath: null, faithful: asset.faithfulFlag },
      await loadVersionRows(kind, assetId),
    ),
    hasImage: !!current,
    alreadyProjectAspect: !!current && await currentImageMatchesSize(current, size),
  })
  if (refusal) throw new AspectVersionError(refusal)

  const finalPrompt = await ensureFinalPrompt(kind, assetId, episode.id)
  if (!finalPrompt) throw new AspectVersionError('该资产的最终提示词生成失败，请先在资产页生成提示词再重试')

  logTaskStart('AspectVersion', 'generate', { kind, assetId, episodeId: episode.id, aspect, size })
  if (kind === 'scene') {
    await db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, assetId))
  }
  try {
    const taskId = await generateImage({
      sceneId: kind === 'scene' ? assetId : undefined,
      propId: kind === 'prop' ? assetId : undefined,
      characterId: kind === 'character' ? assetId : undefined,
      episodeId: episode.id,
      dramaId: asset.dramaId,
      prompt: `${finalPrompt}，${aspectVersionPromptSuffix(aspect)}`,
      size,
      aspectLocked: true,
      aspectVersion: true,
      referenceImages: [current],
      configId: opts.configId ?? episode.imageConfigId ?? undefined,
    })
    logTaskSuccess('AspectVersion', 'generate', { kind, assetId, taskId, size })
    return { task_id: taskId, size }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logTaskError('AspectVersion', 'generate', { kind, assetId, error: message })
    if (kind === 'scene') {
      await db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, assetId))
    }
    throw new AspectVersionError(message)
  }
}
