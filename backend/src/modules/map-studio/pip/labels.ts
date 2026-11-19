/**
 * 细节图的确定性标注（Issue #107）：把 map_spec 里落在取景内的地点/河名/示意区域排成 SVG 片段。
 *
 * 细节图不走模型作图：标注全部来自已核验的 map_spec，位置由代码按固定规则排布（贪心避让、
 * 八方位 × 三档距离），区域用软边色块 + 「（示意）」，不画硬边界。返回的 over/under 片段交给底图渲染器合成。
 */
import type { GeoProjection } from 'd3-geo'
import type { MapSpec } from '../geo/base-render.js'

const SERIF = "font-family=\"Noto Serif SC\""
const HALO = 'stroke="#f7f2e4" stroke-linejoin="round" paint-order="stroke"'
const REGION_COLORS: ReadonlyArray<[number, number, number]> = [[168, 90, 40], [40, 100, 160], [48, 128, 70], [150, 60, 90], [110, 70, 150], [190, 120, 30]]

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
export const textWidth = (s: string, fs: number): number => [...s].reduce((a, c) => a + (/[\x00-\x7f]/.test(c) ? fs * 0.55 : fs), 0)

export type Rect = [number, number, number, number]
const hits = (r: Rect, others: Rect[]): boolean => others.some(q => !(r[2] < q[0] || r[0] > q[2] || r[3] < q[1] || r[1] > q[3]))

export interface PipLabelOptions {
  /** 标注层级：full 全部；reduced 去掉河名与次要地点；focus_only 只留地点与区域名 */
  tier: 'full' | 'reduced' | 'focus_only'
  fontScale: number
  /** 已被占用的矩形（定位图、徽章等） */
  reserved?: Rect[]
}

/**
 * 已排进画面的注记（Issue #127）：文字、包围盒、字号与对齐。
 * `semantic_id` 是全览语义要素 id（与 `props.semantics` 一致），交付时据此把注记转成锚定的 label 层，
 * 所以细节图去掉烧录文字后，这些注记仍由资产自己的图层文档承载。
 */
export interface PipNote {
  semantic_id: string
  /** 画面上的文字（地点可能带「（示意）」后缀，河名已去掉「(n/m)」分段后缀） */
  name: string
  kind: 'place' | 'route' | 'region' | 'river'
  /** 纯文字包围盒（像素，与防碰撞的 `placed` 同口径，不含圆点/箭头） */
  rect: Rect
  /** 文字字号（像素） */
  font: number
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
}

export interface PipLabelResult { under: string; over: string; placed: Rect[]; dropped: string[]; notes: PipNote[] }

export function pipLabels(spec: MapSpec, projection: GeoProjection, size: { width: number; height: number }, opts: PipLabelOptions): PipLabelResult {
  const { width: w, height: h } = size
  const fs = (v: number): number => Math.round(v * opts.fontScale)
  const placed: Rect[] = [...(opts.reserved ?? [])]
  const dropped: string[] = []
  const notes: PipNote[] = []
  const inside = (p: [number, number] | null, m = 30): p is [number, number] => !!p && p[0] > m && p[0] < w - m && p[1] > m && p[1] < h - m
  const px = (ll: [number, number]): [number, number] | null => { const p = projection(ll); return p ? [p[0], p[1]] : null }
  let under = ''
  let over = ''

  // 示意区域：软边色块（多边形模糊）+ 名称 +「（示意）」，画在山河之下
  spec.regions.forEach((region, i) => {
    if (region.verification?.reasons?.some(reason => reason.includes('dataset_missing'))) return
    const pts = region.points.map(px).filter((p): p is [number, number] => !!p)
    if (pts.length < 3 || !pts.some(p => p[0] > -100 && p[0] < w + 100 && p[1] > -100 && p[1] < h + 100)) return
    const [r, g, b] = REGION_COLORS[i % REGION_COLORS.length]!
    const blur = Math.max(18, Math.round(Math.min(w, h) * 0.02))
    under += `<filter id="pipreg${i}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blur}"/></filter>`
      + `<polygon points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="rgb(${r},${g},${b})" fill-opacity=".16" filter="url(#pipreg${i})"/>`
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length
    if (!inside([cx, cy], 60)) return
    const f = fs(50)
    const col = `rgb(${Math.round(r * .7)},${Math.round(g * .7)},${Math.round(b * .7)})`
    for (const off of [0, -90, 90, -180, 180]) {
      const rect: Rect = [cx - textWidth(region.name, f) / 2 - 6, cy + off - f, cx + textWidth(region.name, f) / 2 + 6, cy + off + f * 0.95]
      if (rect[0] < 10 || rect[2] > w - 10 || rect[1] < 10 || rect[3] > h - 10 || hits(rect, placed)) continue
      over += `<text x="${cx.toFixed(1)}" y="${(cy + off).toFixed(1)}" text-anchor="middle" ${SERIF} font-weight="700" font-size="${f}" letter-spacing="${(f * .1).toFixed(1)}" fill="${col}" ${HALO} stroke-width="${(f * .18).toFixed(1)}">${esc(region.name)}</text>`
        + (region.proposed === true && region.origin !== 'manual' && region.verification?.status !== 'verified' && region.verification?.status !== 'confirmed' && !region.name.endsWith('（示意）') ? `<text x="${cx.toFixed(1)}" y="${(cy + off + f * .62).toFixed(1)}" text-anchor="middle" ${SERIF} font-size="${fs(26)}" fill="${col}" ${HALO} stroke-width="5">（示意）</text>` : '')
      placed.push(rect)
      notes.push({ semantic_id: region.id, name: region.name, kind: 'region', rect, font: f, bold: true, italic: false, align: 'center' })
      return
    }
    dropped.push(region.name)
  })

  // 非河流路线（方向/进军线）：虚线 + 末端箭头；河流路线的几何已由水系层绘制，这里只标名
  const riverNames: Array<{ id: string; name: string; pts: Array<[number, number]> }> = []
  for (const route of spec.routes) {
    if (route.verification?.reasons?.some(reason => reason.includes('dataset_missing'))) continue
    const pts = route.points.map(px).filter((p): p is [number, number] => !!p)
    const isRiver = route.category === 'river' || !!route.dataset_ref
    if (isRiver) { if (opts.tier === 'full') riverNames.push({ id: route.id, name: route.name.replace(/\s*\(\d+\/\d+\)$/, ''), pts }); continue }
    if (pts.length < 2) continue
    const d = 'M' + pts.map(p => p.map(v => v.toFixed(1)).join(',')).join('L')
    over += `<path d="${d}" fill="none" stroke="#f7f2e4" stroke-width="${fs(13)}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#a8321f" stroke-width="${fs(7)}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${fs(22)} ${fs(12)}"/>`
    const a = pts[pts.length - 2]!, b = pts[pts.length - 1]!
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), ah = fs(30)
    const tip: [number, number] = [b[0], b[1]]
    over += `<polygon points="${tip.join(',')} ${[tip[0] - Math.cos(ang - .45) * ah, tip[1] - Math.sin(ang - .45) * ah].join(',')} ${[tip[0] - Math.cos(ang + .45) * ah, tip[1] - Math.sin(ang + .45) * ah].join(',')}" fill="#a8321f" stroke="#f7f2e4" stroke-width="3"/>`
    const mid = pts[Math.floor(pts.length / 2)]!
    if (inside(mid)) {
      const f = fs(36), rect: Rect = [mid[0] + 12, mid[1] - f * 1.4, mid[0] + 12 + textWidth(route.name, f), mid[1] - f * .3]
      if (!hits(rect, placed)) {
        over += `<text x="${(mid[0] + 12).toFixed(1)}" y="${(mid[1] - f * .5).toFixed(1)}" ${SERIF} font-weight="700" font-size="${f}" fill="#a8321f" ${HALO} stroke-width="${(f * .2).toFixed(1)}">${esc(route.name)}</text>`
        placed.push(rect)
        notes.push({ semantic_id: route.id, name: route.name, kind: 'route', rect, font: f, bold: true, italic: false, align: 'left' })
      }
    }
  }

  // 地点：圆点 + 名称，按 spec 顺序视为重要性，八方位 × 三档距离贪心避让
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]]
  spec.places.forEach((place, index) => {
    if (place.verification?.reasons?.some(reason => reason.includes('dataset_missing'))) return
    const pt = px([place.lon, place.lat])
    if (!inside(pt)) return
    const major = index < 3
    if (opts.tier === 'focus_only' && index >= 4) return
    const approximate = place.proposed === true && place.origin !== 'manual' && place.verification?.status !== 'verified' && place.verification?.status !== 'confirmed'
    const name = approximate && !place.name.endsWith('（示意）') ? `${place.name}（示意）` : place.name
    const f = fs(major ? 46 : 36), dot = fs(major ? 12 : 9), wd = textWidth(name, f)
    let ok = false
    outer: for (const mult of [1, 2.4, 3.8]) for (const [dx, dy] of dirs) {
      const gap = (dot + fs(8)) * mult
      const x0 = dx > 0 ? pt[0] + gap : dx < 0 ? pt[0] - gap - wd : pt[0] - wd / 2
      const y0 = dy > 0 ? pt[1] + gap + f * .85 : dy < 0 ? pt[1] - gap : pt[1] + f * .35
      const rect: Rect = [x0 - 4, y0 - f, x0 + wd + 4, y0 + f * .28]
      if (rect[0] < 10 || rect[2] > w - 10 || rect[1] < 10 || rect[3] > h - 10 || hits(rect, placed)) continue
      placed.push(rect, [pt[0] - dot, pt[1] - dot, pt[0] + dot, pt[1] + dot])
      notes.push({ semantic_id: place.id, name, kind: 'place', rect, font: f, bold: major, italic: false, align: 'left' })
      over += `<text x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" ${SERIF} font-weight="${major ? 700 : 500}" font-size="${f}" fill="#2b2118" ${HALO} stroke-width="${(f * .2).toFixed(1)}">${esc(name)}</text>`
        + `<circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="${dot}" fill="${approximate ? 'none' : major ? '#2b2118' : '#5a4634'}" stroke="${approximate ? '#2b2118' : '#f7f2e4'}" stroke-width="3"/>`
      ok = true
      break outer
    }
    if (!ok) dropped.push(place.name)
  })

  // 河名：沿河取画面内最长一段，顺切线方向旋转，放在线旁
  for (const river of riverNames) {
    const seg = river.pts.filter(p => inside(p, 40))
    if (seg.length < 3) continue
    const f = fs(40), need = textWidth(river.name, f) * 1.15
    const total = seg.reduce((a, p, i) => i ? a + Math.hypot(p[0] - seg[i - 1]![0], p[1] - seg[i - 1]![1]) : 0, 0)
    if (total < need) continue
    const mid = seg[Math.floor(seg.length / 2)]!, i0 = Math.max(0, Math.floor(seg.length / 2) - 2), i1 = Math.min(seg.length - 1, Math.floor(seg.length / 2) + 2)
    let ang = Math.atan2(seg[i1]![1] - seg[i0]![1], seg[i1]![0] - seg[i0]![0])
    if (Math.cos(ang) < 0) ang += Math.PI
    const cx = mid[0] + Math.sin(ang) * f * .9, cy = mid[1] - Math.cos(ang) * f * .9
    const rect: Rect = [cx - need / 2, cy - f, cx + need / 2, cy + f * .4]
    if (hits(rect, placed)) continue
    placed.push(rect)
    notes.push({ semantic_id: river.id, name: river.name, kind: 'river', rect, font: f, bold: false, italic: true, align: 'center' })
    over += `<text transform="translate(${cx.toFixed(1)},${cy.toFixed(1)}) rotate(${(ang * 180 / Math.PI).toFixed(1)})" text-anchor="middle" ${SERIF} font-style="italic" font-size="${f}" fill="#1c4f7a" ${HALO} stroke-width="${(f * .2).toFixed(1)}">${esc(river.name)}</text>`
  }
  return { under, over, placed, dropped, notes }
}
