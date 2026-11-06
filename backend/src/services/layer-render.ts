/**
 * 图层文档 → PNG（Issue #48）。
 *
 * 管线：底图 → 确定性风格化（纸纹/偏色/暗角，sharp composite + 共享 SVG）
 * → 叠加层 SVG（`layerDocToSvg`，与编辑器同源）→ PNG。
 * 字体自检失败或文字超出打包字体覆盖范围时直接抛错，不输出豆腐块。
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { getAbsolutePath } from '../utils/storage.js'
import type { LayerDoc, LayerVariables } from './layer-doc.js'
import { baseFilterLayers, layerDocToSvg, resolvedText } from './layer-svg.js'
import { assertRenderableText, ensureLayerFonts } from './layer-fonts.js'
import { cropRectOf } from './layer-quality.js'

export interface LayerRenderOptions {
  width?: number
  height?: number
  visibleIds?: string[]
  /** Poster 固定文本变量（Issue #72）：变量层按剧集数据现场解析 */
  variables?: LayerVariables
  /** 只输出透明叠加层 PNG（Poster 的 layers 二次生成用），不要求底图 */
  transparent?: boolean
}

export interface LayerRenderResult {
  buffer: Buffer
  width: number
  height: number
  ms: number
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}

/** 只允许读数据根内的本地图片：防止用 ../ 把服务器任意文件渲染出去。 */
function resolveLocalImage(relativePath: string, what: string): string {
  if (/^(https?:|data:)/i.test(relativePath)) {
    throw new Error(`${what}只支持本地 static 路径，收到：${relativePath.slice(0, 80)}`)
  }
  const root = path.resolve(DATA_ROOT)
  const absolute = path.resolve(getAbsolutePath(relativePath))
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`${what}路径越界：${relativePath}`)
  }
  if (!fs.existsSync(absolute)) {
    throw new Error(`${what}文件不存在：${relativePath}`)
  }
  return absolute
}

function collectTexts(doc: LayerDoc, variables?: LayerVariables): string[] {
  const texts: string[] = []
  for (const layer of doc.layers) {
    if (!layer.visible) continue
    if (layer.type === 'label' || layer.type === 'marker') texts.push(resolvedText(layer, variables))
    if (layer.type === 'card') texts.push(layer.fields.title, layer.fields.sub, layer.fields.meta, layer.fields.years)
  }
  return texts.filter(Boolean)
}

/**
 * 渲染一帧：默认用 `doc.base` 的尺寸，可按输出尺寸覆盖（图层坐标归一化，不用改文档）。
 * `visibleIds` 只画给定图层（逐层显现的确定性片段用，#50）。
 */
export async function renderLayerDoc(doc: LayerDoc, options: LayerRenderOptions = {}): Promise<LayerRenderResult> {
  const started = Date.now()
  await ensureLayerFonts()
  assertRenderableText(collectTexts(doc, options.variables))

  const width = Math.max(16, Math.min(8192, Math.trunc(options.width || doc.base.width)))
  const height = Math.max(16, Math.min(8192, Math.trunc(options.height || doc.base.height)))
  if (options.transparent) {
    const inlined: Record<string, string> = {}
    const svg = layerDocToSvg(doc, { width, height }, {
      visibleIds: options.visibleIds,
      variables: options.variables,
      resolveImage: (relativePath: string) => {
        if (!inlined[relativePath]) {
          const absolute = resolveLocalImage(relativePath, '图片图层')
          const mime = MIME_BY_EXT[path.extname(absolute).toLowerCase()] || 'image/png'
          inlined[relativePath] = `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`
        }
        return inlined[relativePath]
      },
    })
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer()
    return { buffer, width, height, ms: Date.now() - started }
  }
  if (!doc.base.path) throw new Error('图层文档缺少底图路径 base.path')
  const basePath = resolveLocalImage(doc.base.path, '底图')
  const metadata = doc.base.crop ? await sharp(basePath).metadata() : null
  const renderDoc = metadata?.width && metadata.height
    ? { ...doc, base: { ...doc.base, source_width: metadata.width, source_height: metadata.height } }
    : doc

  const inlined: Record<string, string> = {}
  const svg = layerDocToSvg(renderDoc, { width, height }, {
    visibleIds: options.visibleIds,
    variables: options.variables,
    resolveImage: (relativePath: string) => {
      if (!inlined[relativePath]) {
        const absolute = resolveLocalImage(relativePath, '图片图层')
        const mime = MIME_BY_EXT[path.extname(absolute).toLowerCase()] || 'image/png'
        inlined[relativePath] = `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`
      }
      return inlined[relativePath]
    },
  })

  let buffer: Buffer
  if (doc.base.crop) {
    // Precompose filters on the WHOLE image, as the editor and segment renderer do.
    // A single viewport extraction follows; crop is never a second coordinate system.
    const scale = Math.min(2.5, Math.max(1, 1 / doc.base.crop.w, 1 / doc.base.crop.h))
    const canvas = { width: Math.round(width * scale), height: Math.round(height * scale) }
    const base = await sharp(basePath)
      .resize(canvas.width, canvas.height, { fit: 'fill' })
      .composite(baseFilterLayers(doc.base.filter, canvas).map(layer => ({ input: Buffer.from(layer.svg) })))
      .removeAlpha().raw().toBuffer()
    buffer = await sharp(base, { raw: { ...canvas, channels: 3 } })
      .extract(cropRectOf(doc.base, canvas.width, canvas.height))
      .resize(width, height, { fit: 'fill' })
      .composite([{ input: Buffer.from(svg) }])
      .png().toBuffer()
  } else {
    // Preserve the uncropped pipeline and its pixels exactly.
    const composites: sharp.OverlayOptions[] = baseFilterLayers(doc.base.filter, { width, height }).map(layer => ({
      input: Buffer.from(layer.svg),
    }))
    composites.push({ input: Buffer.from(svg) })
    buffer = await sharp(basePath)
      .resize(width, height, { fit: 'fill' })
      .composite(composites)
      .png().toBuffer()
  }

  return { buffer, width, height, ms: Date.now() - started }
}

/** 渲染并落盘到 `static/overlays/<uuid>.png`，返回前端可直接用的相对地址。 */
export async function renderLayerDocToFile(
  doc: LayerDoc,
  options: LayerRenderOptions = {},
): Promise<{ url: string; width: number; height: number; ms: number }> {
  const result = await renderLayerDoc(doc, options)
  const dir = path.join(STORAGE_ROOT, 'overlays')
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${uuid()}.png`
  fs.writeFileSync(path.join(dir, filename), result.buffer)
  return { url: `static/overlays/${filename}`, width: result.width, height: result.height, ms: result.ms }
}
