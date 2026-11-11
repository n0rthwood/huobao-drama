/**
 * 资产出图画幅（Issue #94）—— 全仓库唯一的资产尺寸表。
 *
 * 事故背景：场景资产永远按 1920x1080 出图（`generation.ts` 的隐式默认值），9:16 竖版项目
 * 拿横图当图层底图时被挤压。场景图现在按**项目画幅**出图，不再依赖任何隐式默认值。
 *
 * 场景尺寸表（与 16:9 等像素量，长短边都是 8 的倍数，qwen-jobs 再对齐到 32）：
 *   16:9 → 1920x1080、9:16 → 1080x1920、4:3 → 1664x1248、3:4 → 1248x1664、1:1 → 1440x1440
 * 角色（横版三视图定妆照）与道具（白底方图）主要作参考图，尺寸不随项目画幅变化；
 * 它们被图层用作底图且比例不符时走 `asset-aspect-version.ts` 单独出一版。
 *
 * 各 provider 怎么用这个尺寸（`aspect_locked` 任务尤其依赖它）：
 * - qwen-jobs：`buildImageJobBody` 把 size 对齐到 32 后作为 width/height。**有参考图时默认走
 *   `image_edit` 且完全不带画幅**（跟随第 1 张参考图），所以画幅锁定任务必须切到 `reference_to_image`；
 * - openai-image：gpt-image 按方向映射到 1024x1024 / 1536x1024 / 1024x1536；gpt-image-2 保留实际尺寸
 *   （夹到 256–4096 并对齐 16）；dall-e-* 按方向映射到 1024x1024 / 1792x1024 / 1024x1792
 *   （接口只认这三档）；其它 OpenAI 兼容模型尺寸能力未知，原样透传；`/images/edits` 用同一个 size；
 * - gemini-image：size 约分成 aspectRatio（1080x1920 → 9:16）+ imageSize 档位（1K/2K/4K），方向保留；
 * - volcengine-image：直接把 width/height 写进请求体。
 * 因此三个非 qwen 适配器都按自身支持的档位尊重方向，画幅锁定不需要为它们改提交模式；
 * 完成时的比例核验仍覆盖所有 provider。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { normalizeAspect } from './aspect.js'

export type AssetImageKind = 'scene' | 'prop' | 'character'

/** 场景出图尺寸：项目画幅 → "WxH"；画幅白名单见 routes/dramas.ts */
export const SCENE_IMAGE_SIZES: Record<string, string> = {
  '16:9': '1920x1080',
  '9:16': '1080x1920',
  '4:3': '1664x1248',
  '3:4': '1248x1664',
  '1:1': '1440x1440',
}

/** 角色定妆照（三视图）固定横版 */
export const CHARACTER_IMAGE_SIZE = '1920x1080'
/** 道具白底单品静物固定方图 */
export const PROP_IMAGE_SIZE = '1024x1024'

/** 资产出图尺寸；未知画幅按默认 16:9 处理（与 normalizeAspect 同口径） */
export function assetImageSizeFor(kind: AssetImageKind, aspect: string | null | undefined): string {
  if (kind === 'character') return CHARACTER_IMAGE_SIZE
  if (kind === 'prop') return PROP_IMAGE_SIZE
  return SCENE_IMAGE_SIZES[normalizeAspect(aspect)] || SCENE_IMAGE_SIZES['16:9']!
}

/** "WxH" → 像素尺寸；非法写法返回 null */
export function parseImageSize(size: string | null | undefined): { width: number; height: number } | null {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || '').trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return null
  return { width, height }
}

/** 画幅锁定任务允许的出图比例偏差（qwen-jobs 对齐 32 会让 1080x1920 变 1088x1920，约 0.7%） */
export const ASPECT_LOCKED_TOLERANCE = 0.02

/**
 * 画幅锁定任务的出图比例核验：不符时返回给用户看的失败原因，符合时返回 null。
 * 像素数不要求相等（厂商会按自身档位缩放），只要求**比例**一致——比例错了就是构图错了。
 */
export function aspectLockedMismatchMessage(
  requestedSize: string | null | undefined,
  actual: { width?: number | null; height?: number | null } | null | undefined,
): string | null {
  const requested = parseImageSize(requestedSize)
  if (!requested) return null
  const width = Number(actual?.width || 0)
  const height = Number(actual?.height || 0)
  // 探测不到尺寸时不拦截：核验是防线，不是新的失败来源
  if (!width || !height) return null
  const want = requested.width / requested.height
  const got = width / height
  if (Math.abs(got - want) / want <= ASPECT_LOCKED_TOLERANCE) return null
  return `出图比例 ${width}×${height} 与要求的 ${requested.width}×${requested.height} 不符，已拒绝回写为当前图；`
    + `该图像服务可能忽略了画幅参数（有参考图时尤其常见），请改用支持指定画幅的图像配置后重试`
}

/** 项目画幅（规范化）；剧不存在时按默认 16:9 */
export async function resolveDramaAspect(dramaId: number | null | undefined): Promise<string> {
  if (!dramaId) return normalizeAspect(null)
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, Number(dramaId)))
  return normalizeAspect(drama?.aspectRatio)
}

/** 资产出图尺寸（按剧查画幅） */
export async function assetImageSizeForDrama(kind: AssetImageKind, dramaId: number | null | undefined): Promise<string> {
  if (kind !== 'scene') return assetImageSizeFor(kind, null)
  return assetImageSizeFor(kind, await resolveDramaAspect(dramaId))
}
