/**
 * 画中画版式预案（Issue #107）：全览 + 1~4 个细节图的固定排版。
 *
 * 规则来自实验评审与用户确认：
 * - A 族「全览为主」只用于 ≤2 个细节（建立镜头）；≥3 个细节一律 B 族（细节为主，全览缩成角标定位图）；
 * - 竖屏画幅一律 B 族；
 * - 2、3 个细节时含「重点 + 辅助」排版，4 个细节用 2×2 等分（每块够大，避免 <700px 的小面板）；
 * - 长引线弃用：联系靠同色取景框 + 编号 + 角标定位图。
 * 坐标以画布像素表示，间距按长边 / 3840 缩放（4K 基准：边距 64、沟槽 32）。
 */
import type { MapAspect } from '../types.js'

export type PipFamily = 'A' | 'B'
export interface PipSlot {
  /** `overview` 或 `D1`…`D4`（与 frame.no 对应） */
  key: string
  x: number
  y: number
  w: number
  h: number
}
export interface PipLayout {
  id: string
  family: PipFamily
  canvas: { width: number; height: number }
  slots: PipSlot[]
  /** B 族：角标定位图尺寸（全览缩略 + 取景框），贴在各细节块左下/右下 */
  locator: { width: number; height: number; margin: number } | null
  /** 最小面板短边（4K 基准 900；低于 700 禁用，700–900 降为二级标注） */
  min_slot_short_side: number
  label_tier: 'full' | 'reduced' | 'focus_only'
}

export const PIP_MAX_DETAILS = 4
const LANDSCAPE_ASPECTS: readonly MapAspect[] = ['16:9', '4:3', '1:1']

export function isPortraitAspect(aspect: MapAspect): boolean { return !LANDSCAPE_ASPECTS.includes(aspect) }

interface Box { x: number; y: number; w: number; h: number }
const box = (x: number, y: number, w: number, h: number): Box => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })

/** 按细节数、画幅与是否有重点图选择版式 id；单一来源，前后端/技能都不复制这张表。 */
export function chooseLayoutId(input: { detailCount: number; aspect: MapAspect; hasPrimary: boolean }): string {
  const n = Math.max(0, Math.min(PIP_MAX_DETAILS, Math.trunc(input.detailCount)))
  const portrait = isPortraitAspect(input.aspect)
  if (n === 0) return 'L1'
  if (n === 1) return portrait ? 'L1b-B' : 'L1b-A'
  if (n === 2) return portrait ? 'L2b-B' : input.hasPrimary ? 'L2b-A' : 'L2a-A'
  if (n === 3) return input.hasPrimary ? 'L3b-B' : 'L3a-B'
  return 'L4a-B'
}

export function layoutFor(id: string, canvas: { width: number; height: number }): PipLayout {
  const { width: W, height: H } = canvas
  const k = Math.max(W, H) / 3840
  const m = Math.round(64 * k), g = Math.round(32 * k)
  const inner = { x: m, y: m, w: W - 2 * m, h: H - 2 * m }
  const slot = (key: string, b: Box): PipSlot => ({ key, ...b })
  const loc = { width: Math.round(Math.max(W, H) * (W >= H ? 0.2 : 0.3)), height: 0, margin: Math.round(40 * k) }
  loc.height = Math.round(loc.width * (W >= H ? 9 / 16 : 9 / 16))
  let slots: PipSlot[]
  let family: PipFamily = 'B'
  switch (id) {
    case 'L1':
      slots = [slot('overview', box(0, 0, W, H))]
      family = 'A'
      return { id, family, canvas, slots, locator: null, min_slot_short_side: 0, label_tier: 'full' }
    case 'L1b-A': { // 横版：左大全览 + 右 1 个细节
      family = 'A'
      const rw = Math.round(inner.w * 0.34)
      slots = [slot('overview', box(inner.x, inner.y, inner.w - rw - g, inner.h)), slot('D1', box(inner.x + inner.w - rw, inner.y, rw, inner.h))]
      break
    }
    case 'L1b-B': { // 竖版/细节为主：整屏细节 + 角标
      slots = [slot('D1', box(inner.x, inner.y, inner.w, inner.h))]
      break
    }
    case 'L2a-A': {
      family = 'A'
      const rw = Math.round(inner.w * 0.34), hh = (inner.h - g) / 2
      slots = [slot('overview', box(inner.x, inner.y, inner.w - rw - g, inner.h)), slot('D1', box(inner.x + inner.w - rw, inner.y, rw, hh)), slot('D2', box(inner.x + inner.w - rw, inner.y + hh + g, rw, hh))]
      break
    }
    case 'L2b-A': {
      family = 'A'
      const rw = Math.round(inner.w * 0.34), h1 = Math.round((inner.h - g) * 0.56), h2 = inner.h - g - h1
      slots = [slot('overview', box(inner.x, inner.y, inner.w - rw - g, inner.h)), slot('D1', box(inner.x + inner.w - rw, inner.y, rw, h1)), slot('D2', box(inner.x + inner.w - rw, inner.y + h1 + g, rw, h2))]
      break
    }
    case 'L2b-B': {
      if (W >= H) {
        const w1 = Math.round((inner.w - g) * 0.66)
        slots = [slot('D1', box(inner.x, inner.y, w1, inner.h)), slot('D2', box(inner.x + w1 + g, inner.y, inner.w - w1 - g, inner.h))]
      } else {
        const h1 = Math.round((inner.h - g) * 0.55)
        slots = [slot('D1', box(inner.x, inner.y, inner.w, h1)), slot('D2', box(inner.x, inner.y + h1 + g, inner.w, inner.h - h1 - g))]
      }
      break
    }
    case 'L3a-B': {
      if (W >= H) {
        const cw = (inner.w - 2 * g) / 3
        slots = [0, 1, 2].map(i => slot(`D${i + 1}`, box(inner.x + i * (cw + g), inner.y, cw, inner.h)))
      } else {
        const ch = (inner.h - 2 * g) / 3
        slots = [0, 1, 2].map(i => slot(`D${i + 1}`, box(inner.x, inner.y + i * (ch + g), inner.w, ch)))
      }
      break
    }
    case 'L3b-B': {
      if (W >= H) {
        const w1 = Math.round((inner.w - g) * 0.66), hh = (inner.h - g) / 2
        slots = [slot('D1', box(inner.x, inner.y, w1, inner.h)), slot('D2', box(inner.x + w1 + g, inner.y, inner.w - w1 - g, hh)), slot('D3', box(inner.x + w1 + g, inner.y + hh + g, inner.w - w1 - g, hh))]
      } else {
        const h1 = Math.round((inner.h - g) * 0.55), cw = (inner.w - g) / 2
        slots = [slot('D1', box(inner.x, inner.y, inner.w, h1)), slot('D2', box(inner.x, inner.y + h1 + g, cw, inner.h - h1 - g)), slot('D3', box(inner.x + cw + g, inner.y + h1 + g, cw, inner.h - h1 - g))]
      }
      break
    }
    case 'L4a-B': {
      const cw = (inner.w - g) / 2, ch = (inner.h - g) / 2
      slots = [0, 1, 2, 3].map(i => slot(`D${i + 1}`, box(inner.x + (i % 2) * (cw + g), inner.y + Math.floor(i / 2) * (ch + g), cw, ch)))
      break
    }
    default:
      throw new Error(`未知画中画版式：${id}`)
  }
  const details = slots.filter(s => s.key !== 'overview')
  const shortest = Math.min(...details.map(s => Math.min(s.w, s.h)))
  const scaled = shortest / k
  return {
    id, family, canvas, slots,
    locator: family === 'B' ? loc : null,
    min_slot_short_side: Math.round(shortest),
    label_tier: scaled >= 900 ? 'full' : scaled >= 700 ? 'reduced' : 'focus_only',
  }
}
