/**
 * 纪录片证据素材的「直接看图」消息片段（Issue #51）
 *
 * 纪录片拆分分镜与表达设计要判断「旁白说的东西这张图上到底有没有」。实测只给模型
 * `read_image` 工具是不够的——GLM 任务 865/866 一次都没调用，所有结论都是凭文字编的。
 * 这里把证据素材直接变成 AI SDK 的 image part 放进用户消息：模型不调用工具也必须看见图。
 *
 * 送的是**忠实原件**（`faithful_source` 指向的上传原图，不是被美化过、丢了额尔齐斯河的重绘版）；
 * 有语义标注的素材送「原图 + 编号标记」的叠加预览，编号与随图文字清单一一对应，
 * 模型可以直接按编号引用 `must_show`。叠加层只画 ASCII 数字与几何形状，不写中文——
 * 预览图里的中文要依赖打包字体，渲染失败就是豆腐块；名字放在文字部分里更可靠。
 */
import { and, eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { parseSemantics, resolveSemanticsBase, type AssetSemantics } from './asset-semantics.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'

/** 一次最多附几张图：再多既拖慢请求也超出模型对图片的有效注意力 */
export const EVIDENCE_IMAGE_LIMIT = 6
/** 送进模型前长边缩到多少像素（与 read_image 默认口径一致） */
export const EVIDENCE_IMAGE_MAX_SIDE = 1600
const EVIDENCE_IMAGE_QUALITY = 82

export interface EvidenceImage {
  propId: number
  name: string
  /** semantics = 带编号标记的叠加预览；original = 纯原件 */
  kind: 'semantics' | 'original'
  /** 发送图尺寸（叠加层坐标与这张图一致） */
  width: number
  height: number
  /** 语义坐标所在的原图尺寸（像素框要换算回这个口径） */
  sourceWidth: number
  sourceHeight: number
  /** 「1 = 额尔齐斯河（线·河流，id=line_1）」 */
  legend: string[]
  buffer: Buffer
}

/** AI SDK 的用户消息片段：文字 + 若干图片 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Buffer; mimeType: string }

const LINE_COLOR: Record<string, string> = {
  river: '#1d6fd0',
  route: '#d03a1d',
  border: '#6b3fb5',
}

/** 语义条目 → 编号标记 SVG（纯几何 + ASCII 数字，不依赖中文字体） */
function semanticsOverlaySvg(doc: AssetSemantics, width: number, height: number, scaleX: number, scaleY: number): { svg: string; legend: string[] } {
  const legend: string[] = []
  const marks: string[] = []
  let index = 0
  const marker = (x: number, y: number) => {
    const cx = Math.max(12, Math.min(width - 12, x))
    const cy = Math.max(12, Math.min(height - 12, y))
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="11" fill="#ffffff" stroke="#111111" stroke-width="2"/>`
      + `<text x="${cx.toFixed(1)}" y="${(cy + 5).toFixed(1)}" font-size="15" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="#111111">${index}</text>`
  }

  for (const label of doc.labels) {
    index++
    const [x, y, w, h] = label.bbox
    marks.push(`<rect x="${(x * scaleX).toFixed(1)}" y="${(y * scaleY).toFixed(1)}" width="${(w * scaleX).toFixed(1)}" height="${(h * scaleY).toFixed(1)}" fill="none" stroke="#e8b000" stroke-width="3"/>`)
    marks.push(marker((x + w) * scaleX, y * scaleY))
    legend.push(`${index} = ${label.text}（标注文字，id=${label.id}）`)
  }
  for (const point of doc.points) {
    index++
    marks.push(`<circle cx="${(point.at[0] * scaleX).toFixed(1)}" cy="${(point.at[1] * scaleY).toFixed(1)}" r="6" fill="#e8b000" stroke="#111111" stroke-width="2"/>`)
    marks.push(marker(point.at[0] * scaleX + 16, point.at[1] * scaleY - 14))
    legend.push(`${index} = ${point.name}（地点，id=${point.id}）`)
  }
  for (const region of doc.regions) {
    index++
    const pts = region.points.map(([px, py]) => `${(px * scaleX).toFixed(1)},${(py * scaleY).toFixed(1)}`).join(' ')
    marks.push(`<polygon points="${pts}" fill="#34a85333" stroke="#34a853" stroke-width="3"/>`)
    const head = region.points[0] || [0, 0]
    marks.push(marker(head[0] * scaleX, head[1] * scaleY))
    legend.push(`${index} = ${region.name}（范围，id=${region.id}）`)
  }
  for (const line of doc.lines) {
    index++
    const color = line.color || LINE_COLOR[line.kind] || '#1d6fd0'
    const pts = line.points.map(([px, py]) => `${(px * scaleX).toFixed(1)},${(py * scaleY).toFixed(1)}`).join(' ')
    marks.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>`)
    const head = line.points[0] || [0, 0]
    marks.push(marker(head[0] * scaleX, head[1] * scaleY))
    legend.push(`${index} = ${line.name}（线·${line.kind}，id=${line.id}）`)
  }
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks.join('')}</svg>`,
    legend,
  }
}

/** 单个道具 → 一张可发送的证据图（有语义标注就叠编号标记） */
async function buildEvidenceImage(prop: typeof schema.props.$inferSelect): Promise<EvidenceImage | null> {
  const base = await resolveSemanticsBase(prop)
  if (!base.path) return null
  let absolute: string
  try {
    absolute = getAbsolutePath(base.path)
  } catch {
    logTaskWarn('Evidence', 'image-path-rejected', { propId: prop.id, path: base.path })
    return null
  }

  const source = sharp(absolute)
  const meta = await source.metadata()
  const sourceWidth = meta.width || 0
  const sourceHeight = meta.height || 0
  if (!sourceWidth || !sourceHeight) return null

  const resized = sharp(absolute).resize({
    width: EVIDENCE_IMAGE_MAX_SIDE,
    height: EVIDENCE_IMAGE_MAX_SIDE,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const flat = await resized.jpeg({ quality: EVIDENCE_IMAGE_QUALITY }).toBuffer({ resolveWithObject: true })
  const width = flat.info.width
  const height = flat.info.height

  const doc = parseSemantics(prop.semantics)
  if (!doc) {
    return {
      propId: prop.id, name: prop.name, kind: 'original',
      width, height, sourceWidth, sourceHeight, legend: [], buffer: flat.data,
    }
  }

  // 语义坐标的口径是 semantics.image（标注时那张图），与发送图之间按比例换算
  const refWidth = doc.image?.width || sourceWidth
  const refHeight = doc.image?.height || sourceHeight
  const { svg, legend } = semanticsOverlaySvg(doc, width, height, width / refWidth, height / refHeight)
  const composed = await sharp(flat.data)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: EVIDENCE_IMAGE_QUALITY })
    .toBuffer()
  return {
    propId: prop.id, name: prop.name, kind: 'semantics',
    width, height, sourceWidth, sourceHeight, legend, buffer: composed,
  }
}

/**
 * 本集的忠实证据素材按「被分镜引用的次数」从多到少取前 N 张。
 * `storyboardIds` 非空时优先取这些镜头自己绑定的素材（表达设计逐镜重算用），
 * 不足再用全集高频素材补齐。
 */
export async function buildEvidenceImages(
  episodeId: number,
  opts: { storyboardIds?: number[]; limit?: number } = {},
): Promise<EvidenceImage[]> {
  const limit = opts.limit ?? EVIDENCE_IMAGE_LIMIT
  const propIds = (await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))).map(link => link.propId)
  if (!propIds.length) return []

  const props = (await db.select().from(schema.props).where(inArray(schema.props.id, propIds)))
    .filter(row => !row.deletedAt && Number(row.faithful) === 1)
  if (!props.length) return []

  const episodeShots = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))).filter(sb => !sb.deletedAt)
  const shotIds = episodeShots.map(sb => sb.id)
  const links = shotIds.length
    ? await db.select().from(schema.storyboardTargetAssets)
      .where(and(eq(schema.storyboardTargetAssets.kind, 'prop'), inArray(schema.storyboardTargetAssets.storyboardId, shotIds)))
    : []

  const uses = new Map<number, number>()
  for (const link of links) uses.set(link.assetId, (uses.get(link.assetId) || 0) + 1)
  const focused = new Set(
    opts.storyboardIds?.length
      ? links.filter(link => opts.storyboardIds!.includes(link.storyboardId)).map(link => link.assetId)
      : [],
  )

  const ordered = [...props].sort((a, b) => {
    const focusDiff = Number(focused.has(b.id)) - Number(focused.has(a.id))
    if (focusDiff) return focusDiff
    const useDiff = (uses.get(b.id) || 0) - (uses.get(a.id) || 0)
    return useDiff || a.id - b.id
  })

  const images: EvidenceImage[] = []
  for (const prop of ordered) {
    if (images.length >= limit) break
    try {
      const image = await buildEvidenceImage(prop)
      if (image) images.push(image)
    } catch (err) {
      logTaskWarn('Evidence', 'image-build-failed', {
        propId: prop.id, error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  logTaskProgress('Evidence', 'images-attached', {
    episodeId, count: images.length,
    props: images.map(i => ({ id: i.propId, kind: i.kind, marks: i.legend.length })),
  })
  return images
}

/**
 * 文字 + 图片的用户消息。图片说明走文字片段（编号 → 语义名），
 * 并明写「以图片为准」——否则模型会继续照着文字描述编。
 */
export function evidenceMessageParts(text: string, images: EvidenceImage[]): MessagePart[] {
  if (!images.length) return [{ type: 'text', text }]
  const captions = images.map((image, i) => {
    const head = `图 ${i + 1}：${image.name}（道具 id=${image.propId}，${image.kind === 'semantics' ? '原件 + 语义编号标记' : '原件'}，`
      + `发送尺寸 ${image.width}×${image.height}，原图 ${image.sourceWidth}×${image.sourceHeight}）`
    return image.legend.length ? `${head}\n  ${image.legend.join('\n  ')}` : head
  })
  const preamble = `下面附上了本集的忠实证据素材原件共 ${images.length} 张。**判断以图片为准**：`
    + `旁白里提到的地名/河流/路线/范围，必须在图上真的找得到才能写进 must_show；图上没有的，`
    + `在 rationale 里写明并降级，不要凭空写一个不存在的要素。图上的白底数字标记对应下面的清单：\n`
    + captions.join('\n')
    + `\n需要看更细的局部时再调用 read_image。\n\n`
  return [
    { type: 'text', text: preamble + text },
    ...images.map(image => ({ type: 'image' as const, image: image.buffer, mimeType: 'image/jpeg' })),
  ]
}
