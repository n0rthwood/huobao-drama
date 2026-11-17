/**
 * 画中画细节图与组合图的确定性渲染（Issue #107）。
 *
 * 全览 = 绘制阶段的成图；细节 = 每个取景框按项目画幅整屏渲染的独立图（地形/水系同底图管线，
 * 地点/河名/示意区域来自已核验的 map_spec，自带角标定位图）；组合图 = 版式预案把全览与细节拼成一屏。
 * 不调用模型：重跑得到逐像素相同的结果（同 spec + 同取景 + 同版式）。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { STORAGE_ROOT } from '../../../utils/paths.js'
import { getAbsolutePath, generateImageThumb } from '../../../utils/storage.js'
import { mapProjectionFor, type MapSpec } from '../geo/base-render.js'
import { renderReliefBase } from '../geo/relief-render.js'
import { chooseDemZoom, ensureDemTiles, type DemTileFetcher } from '../geo/terrain-cache.js'
import { datasetSourceInfo } from '../geo/datasets.js'
import { expandBboxToAspect, frameRectOn, PIP_COLORS, type MapPipFrame, type MapPipImage, type MapPipOutput } from './frames.js'
import { pipLabels } from './labels.js'
import type { PipSlot } from './layouts.js'

const PAPER = '#efe6d0'
const FONT = 'font-family="Noto Serif SC"'

type Rect = [number, number, number, number]
type Bbox = [number, number, number, number]
interface Size { width: number; height: number }

export interface RenderPipInput {
  spec: MapSpec
  pip: MapPipOutput
  /** 全览底图（无标注）：角标定位图的缩略来源 */
  overviewBase: { path: string; width: number; height: number }
  /** 全览成图（含标注）：A 族组合图的大图 */
  overviewFinal: { path: string; width: number; height: number }
  demCacheDir?: string
  fetchTile?: DemTileFetcher
}

async function writeImage(buffer: Buffer, prefix: string): Promise<MapPipImage> {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  const dir = path.join(STORAGE_ROOT, 'map-drawings')
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, `${prefix}-${sha256.slice(0, 32)}.png`)
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer)
  const rel = `static/${path.relative(STORAGE_ROOT, abs).split(path.sep).join('/')}`
  await generateImageThumb(rel)
  const meta = await sharp(buffer).metadata()
  return { path: rel, width: meta.width ?? 0, height: meta.height ?? 0, sha256 }
}


const badge = (cx: number, cy: number, r: number, color: string, no: number): string =>
  `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" stroke="#f7f2e4" stroke-width="4"/>`
  + `<text x="${cx.toFixed(1)}" y="${(cy + r * 0.36).toFixed(1)}" text-anchor="middle" ${FONT} font-weight="700" font-size="${Math.round(r * 1.15)}" fill="#fff">${no}</text>`

/** 角标定位图：全览缩略 + 框外压暗 + 同色取景框 + 编号，贴在细节图上 */
async function locatorPng(input: RenderPipInput, frame: MapPipFrame, size: Size): Promise<Buffer> {
  const base = await sharp(getAbsolutePath(input.overviewBase.path)).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer()
  const k = size.width / input.overviewBase.width
  const [x0, y0, x1, y1] = frameRectOn(input.spec, input.overviewBase, frame.bbox).map(v => v * k) as Rect
  const color = PIP_COLORS[(frame.no - 1) % PIP_COLORS.length]!
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">`
    + `<path fill-rule="evenodd" fill="#000" fill-opacity=".2" d="M0,0H${size.width}V${size.height}H0Z M${x0.toFixed(1)},${y0.toFixed(1)}H${x1.toFixed(1)}V${y1.toFixed(1)}H${x0.toFixed(1)}Z"/>`
    + `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" fill="none" stroke="#f7f2e4" stroke-width="9"/>`
    + `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" fill="none" stroke="${color}" stroke-width="5"/>`
    + badge(x1, y0, Math.max(14, Math.round(size.width * 0.045)), color, frame.no)
    + `<rect x="1.5" y="1.5" width="${size.width - 3}" height="${size.height - 3}" fill="none" stroke="#5a4634" stroke-width="3"/></svg>`
  return await sharp(base).composite([{ input: Buffer.from(svg) }]).png().toBuffer()
}

/** 叙事豁免河：spec 里引用了数据集河流组的名字，整条河永远画出 */
function riverExemptions(spec: MapSpec): string[] {
  const names = new Set<string>()
  for (const route of spec.routes) {
    const group = /^ne-group:[^:]+:(.+)$/.exec(route.dataset_ref?.ref ?? '')?.[1]
    if (group) names.add(group.charAt(0).toUpperCase() + group.slice(1))
  }
  return [...names]
}

async function renderDetail(input: RenderPipInput, frame: MapPipFrame, bbox: Bbox, size: Size, withLocator: boolean, locatorWidth: number): Promise<{ buffer: Buffer; provenance: MapPipImage['provenance'] }> {
  const spec: MapSpec = { ...input.spec, bbox, detail_level: 'regional' }
  const projection = mapProjectionFor(spec, size)
  const zoom = chooseDemZoom(bbox, size, 'detail')
  await ensureDemTiles({ projection, width: size.width, height: size.height, zoom, cacheDir: input.demCacheDir, fetchTile: input.fetchTile })
  const k = Math.max(size.width, size.height) / 3840
  const loc = { width: Math.round(locatorWidth), height: Math.round(locatorWidth * 9 / 16) }
  const margin = Math.round(40 * k)
  const locRect: Rect = [margin - 14, size.height - margin - loc.height - 14, margin + loc.width + 14, size.height - margin + 14]
  const scale = Math.max(0.55, Math.min(size.width, size.height) / 2160)
  const labels = pipLabels(spec, projection, size, {
    tier: input.pip.layout.label_tier,
    fontScale: Math.min(1, Math.max(0.8, Math.min(size.width, size.height) / 1400)),
    reserved: withLocator ? [locRect] : [],
  })
  const namedRivers = spec.routes.flatMap(route => route.dataset_ref?.ref.startsWith('osm:') ? [route.dataset_ref.ref] : [])
  const rendered = await renderReliefBase(spec, size, {
    role: 'detail', anchors: null, exemptRivers: riverExemptions(spec), namedRivers,
    lineScale: scale * 1.1, demZoom: zoom, demCacheDir: input.demCacheDir,
    underSvg: labels.under, overSvg: labels.over,
  })
  const attribution = 'Natural Earth（公共领域）· AWS Terrain Tiles，SRTM / GMTED2010 / ETOPO1（公共领域）'
    + (rendered.summary.named_rivers_used.length ? ' · 河流补充 © OpenStreetMap contributors（ODbL 1.0）' : '')
  const provenance = { attribution, sources: rendered.summary.named_rivers_used.length
    ? [{ name: 'OSM 命名河流', url: 'https://www.openstreetmap.org/', license: 'ODbL 1.0', sha256: datasetSourceInfo(namedRivers[0]!).sha256 }]
    : [] }
  if (!withLocator) return { buffer: rendered.buffer, provenance }
  const locator = await locatorPng(input, frame, loc)
  return { buffer: await sharp(rendered.buffer).composite([{ input: locator, left: margin, top: size.height - margin - loc.height }]).png().toBuffer(), provenance }
}

function tileAspectMatches(slot: PipSlot, canvas: Size): boolean {
  const target = canvas.width / canvas.height
  return Math.abs(slot.w / slot.h - target) / target < 0.03
}

export async function renderPipAssets(input: RenderPipInput): Promise<MapPipOutput> {
  const { pip } = input
  const canvas = pip.layout.canvas
  const locatorWidth = pip.layout.locator?.width ?? Math.round(Math.max(canvas.width, canvas.height) * 0.2)

  // 1) 每个细节：整屏独立资产（自带角标定位图）
  const details: MapPipOutput['details'] = []
  const detailBuffers = new Map<number, Buffer>()
  for (const frame of pip.frames) {
    const detail = await renderDetail(input, frame, frame.bbox, canvas, true, locatorWidth)
    detailBuffers.set(frame.no, detail.buffer)
    const image = await writeImage(detail.buffer, `pip-detail${frame.no}`)
    details.push({ no: frame.no, ...image, provenance: detail.provenance })
  }
  if (pip.layout.id === 'L1' || !pip.frames.length) return { ...pip, details, composite: null }

  // 2) 组合图：按版式槽位拼接
  const comps: sharp.OverlayOptions[] = []
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">`
  for (const slot of pip.layout.slots) {
    let tile: Buffer
    if (slot.key === 'overview') {
      const letterboxed = await sharp(getAbsolutePath(input.overviewFinal.path)).resize(slot.w, slot.h, { fit: 'contain', background: PAPER }).png().toBuffer()
      // 框按全览成图的 contain 布局换算到槽位内
      const scale = Math.min(slot.w / input.overviewFinal.width, slot.h / input.overviewFinal.height)
      const offX = (slot.w - input.overviewFinal.width * scale) / 2
      const offY = (slot.h - input.overviewFinal.height * scale) / 2
      let overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${slot.w}" height="${slot.h}">`
      for (const frame of pip.frames) {
        const [x0, y0, x1, y1] = frameRectOn(input.spec, input.overviewFinal, frame.bbox)
        const color = PIP_COLORS[(frame.no - 1) % PIP_COLORS.length]!
        const rx = offX + x0 * scale, ry = offY + y0 * scale, rw = (x1 - x0) * scale, rh = (y1 - y0) * scale
        overlay += `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="none" stroke="#f7f2e4" stroke-width="11"/>`
          + `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="none" stroke="${color}" stroke-width="6"/>${badge(rx + rw, ry, 28, color, frame.no)}`
      }
      tile = await sharp(letterboxed).composite([{ input: Buffer.from(`${overlay}</svg>`) }]).png().toBuffer()
    } else {
      const no = Number(slot.key.slice(1))
      const frame = pip.frames.find(item => item.no === no)!
      if (tileAspectMatches(slot, canvas)) {
        tile = await sharp(detailBuffers.get(no)!).resize(slot.w, slot.h, { fit: 'fill' }).png().toBuffer()
      } else {
        // 槽位宽高比不同：按槽位比例重扩框（中心不变、只扩不裁）后单独渲染，保证标注不被裁切
        const bbox = expandBboxToAspect(frame.focus_bbox, slot.w / slot.h)
        const withLoc = pip.layout.family === 'B' && Math.min(slot.w, slot.h) >= 700
        tile = (await renderDetail(input, frame, bbox, { width: slot.w, height: slot.h }, withLoc, Math.round(slot.w * (frame.role === 'primary' ? 0.26 : 0.3)))).buffer
      }
      const color = PIP_COLORS[(no - 1) % PIP_COLORS.length]!
      svg += `<rect x="${slot.x}" y="${slot.y}" width="${slot.w}" height="${slot.h}" fill="none" stroke="${color}" stroke-width="6"/>${badge(slot.x + 60, slot.y + 60, 36, color, no)}`
    }
    comps.push({ input: tile, left: slot.x, top: slot.y })
    svg += `<rect x="${slot.x}" y="${slot.y}" width="${slot.w}" height="${slot.h}" fill="none" stroke="#5a4634" stroke-width="3"/>`
  }
  comps.push({ input: Buffer.from(`${svg}</svg>`), left: 0, top: 0 })
  const composite = await sharp({ create: { width: canvas.width, height: canvas.height, channels: 3, background: PAPER } }).composite(comps).png().toBuffer()
  const image = await writeImage(composite, `pip-composite-${pip.layout.id}`)
  return { ...pip, details, composite: image }
}
