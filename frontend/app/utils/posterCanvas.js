/**
 * Poster 本地合成（Issue #39）：按底图原始分辨率绘制文字图层，导出 PNG。
 * transparent = true 时只输出文字图层（透明背景），用于「底图＋文字图层」二次生成。
 */
import { fitFontSize, fontStackOf, resolveBoxText } from './posterLayout.js'

export function loadImage(src) {
  const { promise, resolve, reject } = Promise.withResolvers()
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('底图加载失败'))
  image.src = src
  return promise
}

export function fontStringOf(box, sizePx) {
  return `${box.italic ? 'italic ' : ''}${box.bold ? '700 ' : '400 '}${sizePx}px ${fontStackOf(box.fontFamily)}`
}

/** 按字符换行（中文与英文都安全），保留显式换行。 */
export function wrapText(ctx, text, maxWidth) {
  const lines = []
  for (const paragraph of String(text || '').split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    for (const char of paragraph) {
      const trial = line + char
      if (line && ctx.measureText(trial).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line = trial
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function drawTextBox(ctx, box, vars, width, height) {
  const value = resolveBoxText(box, vars).trim()
  if (!value) return
  const maxWidth = Math.max(1, box.width * width)
  const baseSize = box.fontSize * height
  const measureAt = (text, size) => {
    ctx.font = fontStringOf(box, size)
    return ctx.measureText(text).width
  }
  const sizePx = fitFontSize(measureAt, value, baseSize, maxWidth)
  ctx.font = fontStringOf(box, sizePx)
  ctx.textBaseline = 'top'
  ctx.textAlign = box.align
  ctx.lineJoin = 'round'
  ctx.fillStyle = box.color
  ctx.strokeStyle = box.strokeColor
  ctx.lineWidth = Math.max(0, box.strokeWidth * sizePx)

  const left = box.x * width
  const anchorX = box.align === 'left' ? left : box.align === 'right' ? left + maxWidth : left + maxWidth / 2
  const lines = wrapText(ctx, value, maxWidth)
  const lineHeight = sizePx * 1.2
  const top = box.y * height

  lines.forEach((line, index) => {
    const y = top + index * lineHeight
    if (box.shadow) {
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)'
      ctx.shadowBlur = Math.max(1, sizePx * 0.18)
      ctx.shadowOffsetY = sizePx * 0.05
      ctx.fillText(line, anchorX, y)
      ctx.restore()
    }
    if (ctx.lineWidth > 0) ctx.strokeText(line, anchorX, y)
    ctx.fillText(line, anchorX, y)
  })
}

/**
 * 在 canvas 上绘制 Poster：底图（transparent=false）+ 文字图层。
 * 返回 canvas 供调用方编码。
 */
export function drawPoster(canvas, image, layout, vars, { transparent = false, size = '' } = {}) {
  const [targetWidth, targetHeight] = String(size).split('x').map(Number)
  const width = targetWidth || image?.naturalWidth || image?.width || 0
  const height = targetHeight || image?.naturalHeight || image?.height || 0
  if (!width || !height) throw new Error('底图尺寸无效')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  if (!transparent && image) {
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    const scale = Math.min(width / sourceWidth, height / sourceHeight)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(image, (width - sourceWidth * scale) / 2, (height - sourceHeight * scale) / 2, sourceWidth * scale, sourceHeight * scale)
  }
  for (const box of layout.texts || []) drawTextBox(ctx, box, vars, width, height)
  return canvas
}

/** 生成 PNG Blob（合成图或透明文字图层）。 */
export async function renderPosterBlob(imageSrc, layout, vars, { transparent = false, size = '' } = {}) {
  await document.fonts.ready
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  drawPoster(canvas, image, layout, vars, { transparent, size })
  const { promise, resolve, reject } = Promise.withResolvers()
  canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG 导出失败'))), 'image/png')
  return promise
}

/** Blob → File，供 uploadAPI.image 使用。 */
export function posterFile(blob, name) {
  return new File([blob], name, { type: 'image/png' })
}
