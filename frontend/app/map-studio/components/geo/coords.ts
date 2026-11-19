/**
 * 画布 zoom/pan 与三级坐标换算（Issue #126 阶段 2，设计 03 §3）。
 *
 * 几何真值是 viewBox 里的底图像素，经纬度只经该底图 registration 的反投影得到。
 * 一次指针坐标换算严格按三步：
 *   1. 屏幕 client px → 内容区（扣视口偏移、边框、padding；client 坐标本来就是 CSS px，
 *      不重复处理 DPR——只有截图物理像素才先除 DPR）；
 *   2. 内容区 → viewBox：先撤销屏幕 pan（折进中心的归一化 value），再围绕画布中心撤销 zoom，
 *      再扣 `xMidYMid meet` 信箱边距，最后除以适配比例；
 *   3. viewBox → 经纬度：使用 registration 的逆映射，绝不按 bbox 插值代替。
 *
 * 视图的可恢复表示只有 { zoom, cx, cy }：zoom=1 为完整底图适配内容区，cx/cy 是显示在
 * 画布中心的 viewBox 归一化坐标（0..1）。屏幕 pan 是依赖容器尺寸的像素量，不进 URL。
 */

export interface GeoView {
  /** 1..16，1 = 完整底图适配内容区 */
  zoom: number
  /** 画布中心对应的 viewBox 归一化 x（0..1） */
  cx: number
  /** 画布中心对应的 viewBox 归一化 y（0..1） */
  cy: number
}

export interface CanvasSize {
  width: number
  height: number
}

/** 内容区（CSS px，客户坐标系）：已扣除边框与 padding */
export interface CanvasBox {
  left: number
  top: number
  width: number
  height: number
}

/** 未扣除边框/padding 的布局矩形，getBoundingClientRect 的形状 */
export interface LayoutRect {
  left?: number
  top?: number
  width: number
  height: number
  border?: number
  padding?: number
}

export const ZOOM_MIN = 1
export const ZOOM_MAX = 16
export const ZOOM_STEP = 1.2
export const PAN_STEP_PX = 40
/** 底部浮层/删除按钮的屏幕命中半径（44×44 的最小命中区） */
export const HIT_RADIUS_PX = 22
export const DRAG_THRESHOLD_MOUSE_PX = 4
export const DRAG_THRESHOLD_TOUCH_PX = 8

export const DEFAULT_VIEW: GeoView = { zoom: 1, cx: 0.5, cy: 0.5 }

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** zoom 合法范围 1..16；非法/非有限按 1 处理 */
export function clampZoom(value: number): number {
  return finite(value) === null ? ZOOM_MIN : clamp(value as number, ZOOM_MIN, ZOOM_MAX)
}

/** 中心归一化 0..1；非法回 0.5 */
export function clampCenter(value: unknown): number {
  const n = finite(value)
  return n === null ? 0.5 : clamp(n, 0, 1)
}

/**
 * 从 URL 读取的视图：有限越界 clamp，非法/非有限回 1 / 0.5。
 * adjusted 为 true 时调用方要提示「链接中的缩放值超出范围，已调整为 {zoom}%」。
 */
export function normalizeView(raw: { zoom?: unknown; cx?: unknown; cy?: unknown }): { view: GeoView; adjustedZoom: boolean } {
  const zoom = finite(raw.zoom)
  const cx = finite(raw.cx), cy = finite(raw.cy)
  const view: GeoView = {
    zoom: clampZoom(zoom ?? ZOOM_MIN),
    cx: cx !== null && cy !== null ? clampCenter(cx) : 0.5,
    cy: cx !== null && cy !== null ? clampCenter(cy) : 0.5,
  }
  const adjustedZoom = zoom === null || clampZoom(zoom) !== zoom
  return { view, adjustedZoom }
}

/** 布局矩形 → 内容区：client 坐标减去 left/top，尺寸扣掉 border + padding */
export function contentArea(rect: LayoutRect): CanvasBox {
  const border = Math.max(0, finite(rect.border) ?? 0)
  const padding = Math.max(0, finite(rect.padding) ?? 0)
  const inset = border + padding
  return {
    left: (finite(rect.left) ?? 0) + inset,
    top: (finite(rect.top) ?? 0) + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
  }
}

/**
 * `xMidYMid meet` 适配：等比缩放到内容区，居中留下信箱边距。
 * origin 是 viewBox 中心 (W/2, H/2) 在内容区里的 CSS 坐标。
 */
export function fittedFrame(size: CanvasSize, box: CanvasBox): { scale: number; origin: [number, number]; letterbox: [number, number] } | null {
  if (!(size.width > 0) || !(size.height > 0) || !(box.width > 0) || !(box.height > 0)) return null
  const scale = Math.min(box.width / size.width, box.height / size.height)
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const letterbox: [number, number] = [
    (box.width - size.width * scale) / 2,
    (box.height - size.height * scale) / 2,
  ]
  return { scale, origin: [letterbox[0] + (size.width * scale) / 2, letterbox[1] + (size.height * scale) / 2], letterbox }
}

/** 屏幕（内容区 CSS px）→ viewBox 像素；指针在信箱区域也返回一个值，由调用方判定是否在图像内 */
export function contentToViewBox(point: { x: number; y: number }, size: CanvasSize, view: GeoView, frame: { scale: number; origin: [number, number] }): [number, number] {
  const center: [number, number] = [view.cx * size.width, view.cy * size.height]
  return [
    center[0] + (point.x - frame.origin[0]) / (frame.scale * view.zoom),
    center[1] + (point.y - frame.origin[1]) / (frame.scale * view.zoom),
  ]
}

/** client 指针 → 内容区（客户坐标） */
export function clientToContent(client: { x: number; y: number }, box: CanvasBox): { x: number; y: number } {
  return { x: client.x - box.left, y: client.y - box.top }
}

/** 一步到位：client 指针 → viewBox */
export function screenToViewBox(client: { x: number; y: number }, rect: LayoutRect, size: CanvasSize, view: GeoView): [number, number] | null {
  const box = contentArea(rect)
  const frame = fittedFrame(size, box)
  if (!frame) return null
  return contentToViewBox(clientToContent(client, box), size, view, frame)
}

/** viewBox → 屏幕 client 坐标（浮层定位用） */
export function viewBoxToScreen(vb: [number, number], rect: LayoutRect, size: CanvasSize, view: GeoView): [number, number] | null {
  const box = contentArea(rect)
  const frame = fittedFrame(size, box)
  if (!frame) return null
  const center: [number, number] = [view.cx * size.width, view.cy * size.height]
  return [
    box.left + frame.origin[0] + (vb[0] - center[0]) * frame.scale * view.zoom,
    box.top + frame.origin[1] + (vb[1] - center[1]) * frame.scale * view.zoom,
  ]
}

/** SVG 共用变换：viewBox 坐标 u 显示在 center + (u - c) * zoom 的位置 */
export function viewTransform(size: CanvasSize, view: GeoView): string {
  const tx = size.width / 2 - view.zoom * view.cx * size.width
  const ty = size.height / 2 - view.zoom * view.cy * size.height
  return `translate(${tx} ${ty}) scale(${view.zoom})`
}

/** 围绕指针缩放：指针下的 viewBox 坐标不动；保持中心归一化 0..1 内 */
export function zoomAround(raw: { x: number; y: number }, rect: LayoutRect, size: CanvasSize, view: GeoView, nextZoom: number): GeoView {
  const box = contentArea(rect)
  const frame = fittedFrame(size, box)
  const zoom = clampZoom(nextZoom)
  if (!frame) return { ...view, zoom }
  const point = contentToViewBox(clientToContent(raw, box), size, view, frame)
  const cx = point[0] / size.width
  const cy = point[1] / size.height
  return {
    zoom,
    cx: clamp(cx - (raw.x - box.left - frame.origin[0]) / (frame.scale * zoom * size.width), 0, 1),
    cy: clamp(cy - (raw.y - box.top - frame.origin[1]) / (frame.scale * zoom * size.height), 0, 1),
  }
}

/** 按钮缩放围绕内容区中心 */
export function zoomAtCenter(rect: LayoutRect, size: CanvasSize, view: GeoView, nextZoom: number): GeoView {
  const box = contentArea(rect)
  return zoomAround({ x: box.left + box.width / 2, y: box.top + box.height / 2 }, rect, size, view, nextZoom)
}

/** 拖拽平移：dx/dy 为内容区 CSS px 位移（手指/指针向右拖 → 中心左移） */
export function panBy(dxCss: number, dyCss: number, rect: LayoutRect, size: CanvasSize, view: GeoView): GeoView {
  const box = contentArea(rect)
  const frame = fittedFrame(size, box)
  if (!frame || !(size.width > 0) || !(size.height > 0)) return { ...view }
  const perUnit = frame.scale * view.zoom
  return {
    zoom: view.zoom,
    cx: clamp(view.cx - dxCss / (perUnit * size.width), 0, 1),
    cy: clamp(view.cy - dyCss / (perUnit * size.height), 0, 1),
  }
}

/** 适配选中：把目标要素的像素包围盒放到视图中心并尽量放大（留 24px 边距），无包围盒时回整图 */
export function fitBox(box: { x: number; y: number; width: number; height: number }, rect: LayoutRect, size: CanvasSize): GeoView {
  const area = contentArea(rect)
  const frame = fittedFrame(size, area)
  if (!frame) return { ...DEFAULT_VIEW }
  const usableW = Math.max(1, area.width - 48)
  const usableH = Math.max(1, area.height - 48)
  const zoom = clampZoom(Math.min(usableW / (Math.max(1, box.width) * frame.scale), usableH / (Math.max(1, box.height) * frame.scale)))
  return {
    zoom,
    cx: clamp((box.x + box.width / 2) / size.width, 0, 1),
    cy: clamp((box.y + box.height / 2) / size.height, 0, 1),
  }
}
