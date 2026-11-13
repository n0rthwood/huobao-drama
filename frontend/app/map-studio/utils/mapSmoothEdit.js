/**
 * 图层编辑器的平滑预览适配（Issue #99 阶段 ③）。
 *
 * 画布必须显示**平滑后的渲染副本**（renderCopyWithSmoothing），但编辑的对象永远是存储里的
 * **原始控制点**：LayerCanvas 在拖动/缩放时按它看到的几何算出整份点数组回调，
 * 如果直接把回调写回文档，采样点就会被当成控制点持久化，下一次平滑再平滑一遍。
 *
 * 这里把回调解回控制点：画布给的 `next` 点是渲染点经过同一个整层仿射变换（平移/缩放）得到的，
 * 所以从 `渲染点 → next 点` 拟合出仿射参数，再把同一变换施加到控制点。退化几何（所有点某一轴相同）
 * 无法拟合缩放时按平移处理——绝不做「用渲染点覆盖控制点」的兜底。
 *
 * 纯函数、无 DOM 依赖，前端行为测试可直接 import。
 */

/** 图层平滑参数表：键是图层 id（绘制前是要素 id） */
const EPS = 1e-9

/** 平滑参数的键：已绘制文档按图层 id，未重映射的记录仍可能是要素 id */
export function optionKeyForLayer(layer, options = {}) {
  if (!layer || !options) return ''
  if (layer.id !== undefined && Object.prototype.hasOwnProperty.call(options, layer.id)) return String(layer.id)
  const semantic = layer.anchor && layer.anchor.semantic_id
  if (semantic && Object.prototype.hasOwnProperty.call(options, semantic)) return String(semantic)
  return layer.id === undefined || layer.id === null ? '' : String(layer.id)
}

/** Missing means off; invalid explicit values are rejected, never coerced or clamped. */
export function smoothingOf(layer, options = {}) {
  const key = optionKeyForLayer(layer, options)
  if (!key || !Object.prototype.hasOwnProperty.call(options, key)) return 0
  const raw = options[key]?.smooth
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null
}

function pairOnAxis(from, to, axis) {
  const limit = Math.min(from.length, to.length)
  if (limit < 2) return null
  // 单次扫描找第一个与该轴不同的点：O(n)，密集几何（上千采样点）不会退化成平方复杂度
  const base = from[0][axis]
  for (let index = 1; index < limit; index += 1) {
    const delta = from[index][axis] - base
    if (Math.abs(delta) <= EPS) continue
    const scale = (to[index][axis] - to[0][axis]) / delta
    if (!Number.isFinite(scale) || Math.abs(scale) <= EPS) continue
    return { scale, offset: to[0][axis] - scale * base }
  }
  return null
}

/**
 * 用渲染点 → 画布回调点拟合整层仿射，把同一变换施加到控制点。
 * 返回与 controlPoints 等长的新数组；控制点一个都不丢、顺序不变。
 */
export function mapControlPointsThroughCanvas(controlPoints, renderedPoints, nextPoints) {
  if (!Array.isArray(controlPoints) || !Array.isArray(renderedPoints) || !Array.isArray(nextPoints)) return null
  if (!controlPoints.length || renderedPoints.length !== nextPoints.length || !renderedPoints.length) return null
  const x = pairOnAxis(renderedPoints, nextPoints, 0)
  const y = pairOnAxis(renderedPoints, nextPoints, 1)
  // 某一轴退化（竖线/水平线）时无法从两点拟合缩放：按该轴平移处理
  const fallbackX = nextPoints[0][0] - renderedPoints[0][0]
  const fallbackY = nextPoints[0][1] - renderedPoints[0][1]
  // Reject non-affine edits (including a single sampled vertex) instead of inventing control points.
  for (let i = 0; i < renderedPoints.length; i += 1) {
    const [rx, ry] = renderedPoints[i]
    const [nx, ny] = nextPoints[i]
    const px = x ? x.scale * rx + x.offset : rx + fallbackX
    const py = y ? y.scale * ry + y.offset : ry + fallbackY
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || Math.abs(px - nx) > 1e-7 || Math.abs(py - ny) > 1e-7) return null
  }
  return controlPoints.map(([cx, cy]) => {
    const px = x ? x.scale * cx + x.offset : cx + fallbackX
    const py = y ? y.scale * cy + y.offset : cy + fallbackY
    return [px, py]
  })
}

/**
 * 把 LayerCanvas 的几何回调映射回控制文档。
 * - 未开启平滑的图层：渲染点即控制点，原样返回（保留 LayerCanvas 自己的整数化/吸附结果）；
 * - 开启平滑的图层：`points` 用仿射反解到控制点，`at` / `box` / `rotation` / `style` 原样透传
 *   （这些图层类型没有平滑几何）；
 * - 点数组对不上（画布与文档点数不一致）时返回 **null**，调用方必须明确告知本次改动没有写入，
 *   绝不把采样点当控制点提交，也不静默丢改动。
 */
export function remapCanvasPatch(patch, controlLayer, renderedLayer, layerOptions = {}) {
  if (!patch || typeof patch !== 'object') return patch
  if (!controlLayer || !renderedLayer) return null
  if (!patch.points || !Array.isArray(patch.points)) return patch
  const strength = smoothingOf(controlLayer, layerOptions)
  if (strength === null) return null
  if (strength === 0) return patch
  const points = mapControlPointsThroughCanvas(controlLayer.points || [], renderedLayer.points || [], patch.points)
  return points ? { ...patch, points } : null
}
