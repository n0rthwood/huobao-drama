/**
 * 画中画取景框（Issue #107）：模型按分镜重点提出细节框，代码只校验与规整，不替模型选地点。
 *
 * 规则（不合格整批拒收并逐条说明，回给模型；与 #90 的原则一致）：
 * - 最多 4 个细节；每个框必须落在全览范围内（中心距边 ≥2%），且大小合理：
 *   经度跨度占全览的 3%–60%（太小没有地理语境，太大就不是细节）；
 * - 框与框不得高度重叠（IoU < 0.5）；
 * - 至多一个 primary（重点）；≥2 个细节而没有 primary 时，第一个自动为 primary；
 * - 细节图出图时按版式槽位的宽高比扩框（只扩不裁，中心不变），所以 focus_bbox 是模型要看清的范围，
 *   bbox 是实际渲染范围。
 */
import type { MapAspect } from '../types.js'
import { PIP_MAX_DETAILS, type PipLayout } from './layouts.js'

export type MapBbox = [number, number, number, number]
export type MapPipRole = 'primary' | 'aux'

export interface MapPipFrameInput {
  label: string
  reason: string
  bbox: MapBbox
  role?: MapPipRole
  storyboard_numbers?: number[]
}

export interface MapPipFrame {
  no: number
  label: string
  reason: string
  role: MapPipRole
  /** 模型要看清的范围 */
  focus_bbox: MapBbox
  /** 实际渲染范围：按资产画幅（整屏细节）扩出的框，也是 parent_frame */
  bbox: MapBbox
  storyboard_numbers: number[]
}

export const PIP_COLORS = ['#6b2c91', '#c46a00', '#00796b', '#b3272d'] as const

const FRAME_MARGIN = 0.02
const MIN_SPAN = 0.03
const MAX_SPAN = 0.6
const MAX_IOU = 0.5

const rad = (d: number): number => d * Math.PI / 180
const merc = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + rad(Math.max(-84, Math.min(84, lat))) / 2))
const unmerc = (y: number): number => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI

export function aspectRatioOf(aspect: MapAspect): number {
  const [w, h] = aspect.split(':').map(Number) as [number, number]
  return w / h
}

/** 保持中心、只扩不裁地把 bbox 扩到目标宽高比（墨卡托平面内）。 */
export function expandBboxToAspect(bbox: MapBbox, wOverH: number): MapBbox {
  const [w, s, e, n] = bbox
  const cx = (w + e) / 2
  const cy = (merc(s) + merc(n)) / 2
  let halfW = rad(e - w) / 2
  let halfH = (merc(n) - merc(s)) / 2
  if (halfW / halfH < wOverH) halfW = halfH * wOverH
  else halfH = halfW / wOverH
  const west = Math.max(-180, cx - halfW * 180 / Math.PI)
  const east = Math.min(180, cx + halfW * 180 / Math.PI)
  return [round(west), round(unmerc(cy - halfH)), round(east), round(unmerc(cy + halfH))]
}

const round = (v: number): number => Math.round(v * 10000) / 10000

function iou(a: MapBbox, b: MapBbox): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const inter = w * h
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
  return union > 0 ? inter / union : 0
}

function isBbox(v: unknown): v is MapBbox {
  return Array.isArray(v) && v.length === 4 && v.every(x => typeof x === 'number' && Number.isFinite(x))
}

export interface FrameValidation { frames: MapPipFrame[]; problems: string[] }

export function validateFrames(overview: MapBbox, raw: unknown, assetAspect: MapAspect): FrameValidation {
  const problems: string[] = []
  if (!Array.isArray(raw)) return { frames: [], problems: ['frames 必须是数组（没有细节框时传空数组并在 reason 里说明）'] }
  if (raw.length > PIP_MAX_DETAILS) problems.push(`细节框最多 ${PIP_MAX_DETAILS} 个，收到 ${raw.length} 个；把次要的合并进重点框或舍去`)
  const [ow, os, oe, on] = overview
  const spanLon = oe - ow
  const inputs: MapPipFrameInput[] = []
  raw.slice(0, PIP_MAX_DETAILS).forEach((item, index) => {
    const tag = `frames[${index}]`
    if (!item || typeof item !== 'object') { problems.push(`${tag} 必须是对象`); return }
    const rec = item as Record<string, unknown>
    const label = typeof rec.label === 'string' ? rec.label.trim() : ''
    const reason = typeof rec.reason === 'string' ? rec.reason.trim() : ''
    if (!label) problems.push(`${tag}.label 不能为空（例如「乌格拉河口」）`)
    if (!reason) problems.push(`${tag}.reason 不能为空：说明这个细节支撑哪几个分镜、要让观众看清什么地理特征`)
    if (!isBbox(rec.bbox)) { problems.push(`${tag}.bbox 必须是 4 个数字 [west, south, east, north]`); return }
    const b = rec.bbox
    if (!(b[0] < b[2] && b[1] < b[3])) { problems.push(`${tag}.bbox 必须满足 west<east 且 south<north`); return }
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2
    const mx = spanLon * FRAME_MARGIN, my = (on - os) * FRAME_MARGIN
    if (cx < ow + mx || cx > oe - mx || cy < os + my || cy > on - my) problems.push(`${tag}「${label}」的中心 (${cx.toFixed(2)}, ${cy.toFixed(2)}) 不在全览范围 ${JSON.stringify(overview)} 内（距边需 ≥2%）；先确认全览取景能包住它`)
    const ratio = (b[2] - b[0]) / spanLon
    if (ratio < MIN_SPAN) problems.push(`${tag}「${label}」经度跨度只占全览的 ${(ratio * 100).toFixed(1)}%，小于 ${MIN_SPAN * 100}%：范围太小，没有地理语境，请放大框`)
    if (ratio > MAX_SPAN) problems.push(`${tag}「${label}」经度跨度占全览的 ${(ratio * 100).toFixed(0)}%，超过 ${MAX_SPAN * 100}%：这不是细节，请缩小框或改为不设细节`)
    const role = rec.role === 'primary' || rec.role === 'aux' ? rec.role : undefined
    const numbers = Array.isArray(rec.storyboard_numbers) ? rec.storyboard_numbers.filter((x): x is number => Number.isInteger(x)) : []
    inputs.push({ label, reason, bbox: b, ...(role ? { role } : {}), storyboard_numbers: numbers })
  })
  for (let i = 0; i < inputs.length; i++) for (let j = i + 1; j < inputs.length; j++) {
    if (iou(inputs[i]!.bbox, inputs[j]!.bbox) >= MAX_IOU) problems.push(`细节框「${inputs[i]!.label}」与「${inputs[j]!.label}」重叠过半，请合并为一个框`)
  }
  if (inputs.filter(i => i.role === 'primary').length > 1) problems.push('至多一个 role=primary（重点），其余为 aux')
  if (problems.length) return { frames: [], problems }
  const hasPrimary = inputs.some(i => i.role === 'primary')
  const ratio = aspectRatioOf(assetAspect)
  const frames = inputs.map((item, index): MapPipFrame => ({
    no: index + 1,
    label: item.label,
    reason: item.reason,
    role: item.role ?? (index === 0 && inputs.length >= 2 && !hasPrimary ? 'primary' : 'aux'),
    focus_bbox: item.bbox,
    bbox: expandBboxToAspect(item.bbox, ratio),
    storyboard_numbers: item.storyboard_numbers ?? [],
  }))
  return { frames, problems: [] }
}

export interface MapPipImage { path: string; width: number; height: number; sha256: string }

/**
 * 画中画产出（三件套：全览 + 细节 + 布局 spec）。details/composite 在「完成登记」前由确定性渲染补齐。
 * `details[].semantics`（Issue #110）是细节图上的语义几何（像素坐标，id 与全览语义一致），
 * 交付时由 `projectDetailSemantics` 按同一 map_spec 投影得到；宿主据此写入细节资产的 `props.semantics`。
 */
export interface MapPipOutput {
  version: 1
  /** 全览取景（经纬度） */
  overview_bbox: MapBbox
  aspect: MapAspect
  layout: Pick<PipLayout, 'id' | 'family' | 'canvas' | 'slots' | 'locator' | 'label_tier' | 'min_slot_short_side'>
  frames: MapPipFrame[]
  details: Array<MapPipImage & { no: number; semantics?: unknown }>
  composite: MapPipImage | null
  /** 写进资产 meta 的用法说明：分镜设计据此决定引用大图/细节图/哪种版式 */
  usage: string
}
