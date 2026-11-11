/**
 * 底图取景框画布（Issue #94）：**唯一**的底图栅格化入口，图层静帧（含海报）与图层段
 * 共用它，所以两条渲染路径不可能出现「一边留白一边拉伸」。
 *
 * 画布 = 取景框 F（`baseFrameOf`），尺寸由调用方按成片比例给（预放大倍数各自决定）：
 * 1. 底图边界 B（crop，缺省整图）等比落到它在 F 中的位置；
 * 2. B 盖不满 F 时，先铺一张「B 放大 + 模糊」的垫底（contain 留白，用户确认的方案）；
 * 3. 再叠底图风格化滤镜（纸纹/偏色/暗角，按 F 的画布算）。
 * 比例一致且无裁切时直接整图铺满画布——与 Issue #94 之前的像素完全一致。
 */
import sharp from 'sharp'
import type { LayerDocBase } from './layer-doc.js'
import { baseFrameOf, cropRectOf, type BaseFrame } from './layer-quality.js'
import { baseFilterLayers } from './layer-svg.js'

/** 垫底模糊强度：画布短边的 1/24（544×960 下 σ≈23px），看不出内容又不会出现色带 */
const BLUR_SIGMA_DIVISOR = 24

export interface FrameCanvas extends BaseFrame {
  /** 已合过滤镜的取景框画布，raw RGB */
  buffer: Buffer
  width: number
  height: number
}

/**
 * 预合成取景框画布，返回 raw RGB（sharp 的算子顺序固定，底图必须是**已经**合过滤镜的缓冲：
 * 同一条管线里「先 composite 再 extract」会被重排成先裁后叠）。
 * 源图尺寸一律现场读：少读一次就会把横图当成 cover 拉伸。
 */
export async function renderFrameCanvas(
  base: Pick<LayerDocBase, 'crop' | 'filter' | 'source_width' | 'source_height'>,
  basePath: string,
  spec: { width: number; height: number },
  canvas: { width: number; height: number },
): Promise<FrameCanvas> {
  const width = Math.max(1, Math.trunc(canvas.width))
  const height = Math.max(1, Math.trunc(canvas.height))
  const metadata = await sharp(basePath).metadata()
  if (!metadata.width || !metadata.height) throw new Error(`底图无法读取尺寸：${basePath}`)
  const filters = baseFilterLayers(base.filter, { width, height }).map(layer => ({ input: Buffer.from(layer.svg) }))
  const measured = baseFrameOf({ ...base, source_width: metadata.width, source_height: metadata.height }, spec)
  const { bounds, frame } = measured
  if (!base.crop && bounds.w === frame.w && bounds.h === frame.h) {
    const buffer = await sharp(basePath).resize(width, height, { fit: 'fill' }).composite(filters).removeAlpha().raw().toBuffer()
    return { ...measured, buffer, width, height }
  }

  const region = sharp(basePath).extract(cropRectOf({ crop: bounds }, metadata.width, metadata.height))
  // B 在画布上的位置与大小：画布比例 = F 的像素比例，所以这里天然是等比缩放
  const boxWidth = Math.min(width, Math.max(1, Math.round((bounds.w / frame.w) * width)))
  const boxHeight = Math.min(height, Math.max(1, Math.round((bounds.h / frame.h) * height)))
  const left = Math.min(width - boxWidth, Math.max(0, Math.round(((bounds.x - frame.x) / frame.w) * width)))
  const top = Math.min(height - boxHeight, Math.max(0, Math.round(((bounds.y - frame.y) / frame.h) * height)))
  const crisp = await region.clone().resize(boxWidth, boxHeight, { fit: 'fill' }).png().toBuffer()
  if (boxWidth >= width && boxHeight >= height) {
    const buffer = await sharp(crisp).composite(filters).removeAlpha().raw().toBuffer()
    return { ...measured, buffer, width, height }
  }

  const scale = Math.max(width / boxWidth, height / boxHeight)
  const fillWidth = Math.max(width, Math.ceil(boxWidth * scale))
  const fillHeight = Math.max(height, Math.ceil(boxHeight * scale))
  const backdrop = await region.clone()
    .resize(fillWidth, fillHeight, { fit: 'fill' })
    .blur(Math.max(2, Math.round(Math.min(width, height) / BLUR_SIGMA_DIVISOR)))
    .extract({ left: Math.round((fillWidth - width) / 2), top: Math.round((fillHeight - height) / 2), width, height })
    .png().toBuffer()
  const buffer = await sharp(backdrop).composite([{ input: crisp, left, top }, ...filters]).removeAlpha().raw().toBuffer()
  return { ...measured, buffer, width, height }
}

/**
 * 整幅取景框 + 叠加层 → PNG（图层静帧与海报走这条）。
 * cover 且无裁切时底图、滤镜、叠加层在**同一条** sharp 管线里合成：这正是 #94 之前的管线，
 * 所以比例一致的文档逐像素不变；其余情况用上面的取景框画布（contain 自带模糊垫底）。
 */
export async function renderFramePng(
  base: Pick<LayerDocBase, 'crop' | 'filter' | 'source_width' | 'source_height'>,
  basePath: string,
  size: { width: number; height: number },
  overlay: Buffer,
): Promise<Buffer> {
  if (!base.crop && baseFrameOf(base, size).mode === 'cover') {
    const composites: sharp.OverlayOptions[] = baseFilterLayers(base.filter, size).map(layer => ({ input: Buffer.from(layer.svg) }))
    composites.push({ input: overlay })
    return sharp(basePath).resize(size.width, size.height, { fit: 'fill' }).composite(composites).png().toBuffer()
  }
  const canvas = await renderFrameCanvas(base, basePath, size, size)
  return sharp(canvas.buffer, { raw: { width: canvas.width, height: canvas.height, channels: 3 } })
    .composite([{ input: overlay }])
    .png().toBuffer()
}
