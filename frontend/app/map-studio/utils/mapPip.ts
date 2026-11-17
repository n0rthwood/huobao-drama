/**
 * 画中画资产徽标（Issue #107）：宿主侧 `props.map_pip` 的只读解读。
 *
 * map_pip 有两种形状（后端 map-pip-assets.ts 是唯一读写口）：
 * - 全览：`{role:'overview', frames:[…], layout, composite_path, usage}`
 * - 细节：`{role:'detail', parent_prop_id, parent_name, frame:{no,label,…}, usage, stale?}`
 *
 * 这里只做「读得懂就说，读不懂就不说」：形状不对或 role 不是这两种一律返回 null，
 * 绝不按名字或 faithful 猜这是不是画中画资产。
 */
import { geoEquirectangular, geoMercator } from 'd3-geo'

type Bbox = [number, number, number, number]

/** Same d3 fitExtent and corner projection as the backend's pip/frames.ts. */
export function pipFrameRect(overview: unknown, focus: unknown, width: number, height: number, projectionType = 'mercator'): Bbox | null {
  const valid = (v: unknown): v is Bbox => Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v[0] < v[2] && v[1] < v[3]
  if (!valid(overview) || !valid(focus) || width <= 0 || height <= 0) return null
  const [w, s, e, n] = overview
  const projection = projectionType === 'equirectangular' ? geoEquirectangular() : geoMercator()
  projection.fitExtent([[0, 0], [width, height]], { type: 'Polygon', coordinates: [[[w, s], [w, n], [e, n], [e, s], [w, s]]] })
  const a = projection([focus[0], focus[3]])
  const b = projection([focus[2], focus[1]])
  if (!a || !b) return null
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
}

export interface PipMetaOverview {
  version?: number
  role: 'overview'
  layout?: unknown
  frames?: unknown
  composite_path?: string | null
  usage?: string
}

export interface PipMetaDetail {
  version?: number
  role: 'detail'
  parent_prop_id?: number
  parent_name?: string
  frame?: unknown
  overview_bbox?: unknown
  usage?: string
  stale?: boolean
}

export type PipMeta = PipMetaOverview | PipMetaDetail

/** 与 backend/src/modules/map-studio/pip/frames.ts 的 PIP_COLORS 一致：细节编号 1 起按顺序取色 */
export const PIP_COLORS = ['#6b2c91', '#c46a00', '#00796b', '#b3272d'] as const

/** 细节编号 → 角标颜色；编号不是正整数时返回 null（不猜一个近似编号去配色） */
export function pipFrameColor(no: unknown): string | null {
  if (typeof no !== 'number' || !Number.isInteger(no) || no < 1) return null
  return PIP_COLORS[(no - 1) % PIP_COLORS.length] ?? null
}

/** 列表接口可能给已解析对象，也可能给原样 JSON 字符串；两种都认，其他一律 null */
export function parsePipMeta(raw: unknown): PipMeta | null {
  let value: unknown = raw
  if (typeof value === 'string') {
    if (!value.trim()) return null
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const role = (value as Record<string, unknown>).role
  return role === 'overview' || role === 'detail' ? value as PipMeta : null
}

export interface PipBadge {
  role: 'overview' | 'detail'
  /** 全览：细节帧个数（frames.length） */
  detailCount: number
  /** 细节：细节编号 frame.no；缺失为 null */
  frameNo: number | null
  /** 细节：所属全览资产名 */
  parentName: string
  /** 细节：全览重跑后本图未重绘，已过期 */
  stale: boolean
  /** 用法说明原文（后端写入，非本地拼装） */
  usage: string
  /** 细节：帧标题；全览为空串 */
  label: string
}

export type PipTranslate = (key: string, params?: Record<string, unknown>) => string

/**
 * 徽标数据：全览给细节个数，细节给编号/所属全览/过期标记。
 * 输入不是合法的 map_pip（或还没登记 frames）时返回 null，UI 就不显示这一行。
 */
export function pipBadgeOf(raw: unknown): PipBadge | null {
  const meta = parsePipMeta(raw)
  if (!meta) return null
  const usage = typeof meta.usage === 'string' ? meta.usage : ''
  if (meta.role === 'overview') {
    const frames = Array.isArray(meta.frames) ? meta.frames : []
    return { role: 'overview', detailCount: frames.length, frameNo: null, parentName: '', stale: false, usage, label: '' }
  }
  const rawFrame = meta.frame
  const frame = rawFrame && typeof rawFrame === 'object' && !Array.isArray(rawFrame) ? rawFrame as Record<string, unknown> : null
  const no = frame?.no
  return {
    role: 'detail',
    detailCount: 0,
    frameNo: typeof no === 'number' && Number.isInteger(no) ? no : null,
    parentName: typeof meta.parent_name === 'string' ? meta.parent_name.trim() : '',
    stale: meta.stale === true,
    usage,
    label: typeof frame?.label === 'string' ? frame.label.trim() : '',
  }
}

/**
 * 徽标文字：翻译函数由调用方传入（与 useTour 同一口径），本函数只决定选哪个 key、带什么参数。
 * 形状不认识时返回空串，调用方据此不渲染这一行。
 */
export function pipBadgeText(raw: unknown, t: PipTranslate): string {
  const badge = pipBadgeOf(raw)
  if (!badge) return ''
  if (badge.role === 'overview') return t('mapStudio.pip.overviewBadge', { n: badge.detailCount })
  // 细节缺编号（形状不完整）时写「-」而不是留空，标题里的编号位置永远有可见内容
  const line = t('mapStudio.pip.detailBadge', { no: badge.frameNo ?? '-', name: badge.parentName })
  return badge.stale ? `${line} · ${t('mapStudio.pip.stale')}` : line
}
