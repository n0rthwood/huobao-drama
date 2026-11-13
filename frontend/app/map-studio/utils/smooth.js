/**
 * 渲染期平滑（Issue #99 阶段③ §1）——后端 `modules/map-studio/render/smooth.ts` 的同源实现。
 *
 * 存储仍是原始控制点；平滑参数在 `layer_options: { [图层 id 或要素 id]: { smooth: 0..1 } }`。
 * 曲线是向心 Catmull-Rom（α=0.5）的 Hermite 形式：过全部控制点、面闭合、开放折线首尾不外推，
 * 每段按输出像素长度自适应细分；strength 只缩放切线，0 = 关闭（直线），绝不改存储与控制点。
 *
 * 两个实现必须逐函数等价（`backend/tests/map-studio-smoothing.test.mjs` 对照），所以这里的数值顺序、
 * 常量、采样步数都与后端保持一致：改一边就必须改另一边。
 */

/** @typedef {[number, number]} Point */
/** @typedef {{ smooth: number }} SmoothEntry */
/** @typedef {Record<string, SmoothEntry>} LayerOptions */
/** @typedef {{ closed: boolean, strength: number, width: number, height: number }} SmoothOptions */
/** @typedef {{ segment: number, deviation: number, limit: number, suggested: number }} DeviationInfo */
/** @typedef {{ path: string, message: string, code: 'smoothing_invalid' | 'smoothing_deviation', layer_id?: string }} SmoothProblem */

/** 验收口径（SKILL drawing §平滑）：锚定容差 max(6px, 长边 0.4%)，段容差 max(锚定容差, 段长 12%) */
export const SMOOTHING_LIMITS = { minPx: 6, frameRatio: 0.004, segmentRatio: 0.12 }

/** 每段采样目标间距（输出像素） */
const SAMPLE_TARGET_PX = 10
/** 每段最少 4 个采样（含端点） */
const MIN_STEPS = 4
/** 单段最多 96 个采样 */
const MAX_STEPS = 96
/** 整条线/面的总点数上限，只防极端输入，不对应任何存储钳制（240 点属于 normalizeLayerDoc） */
const MAX_OUTPUT_POINTS = 20000
const EPS = 1e-9

/**
 * 闭合环去掉重复的收尾顶点（存储里允许首点重复一次），曲线只处理唯一环；
 * 多边形在 SVG 里本来就隐式闭合，删掉重复点不改变画出来的形状。
 * @param {Point[]} points
 * @param {boolean} closed
 * @returns {Point[]}
 */
export function ringPoints(points, closed) {
  const copy = points.map(point => [point[0], point[1]])
  if (!closed || copy.length < 2) return copy
  const first = copy[0]
  const last = copy[copy.length - 1]
  return first[0] === last[0] && first[1] === last[1] ? copy.slice(0, -1) : copy
}

/** 输出像素上的两点距离：归一化坐标乘画布尺寸，换尺寸不改形状 */
function pixelLength(a, b, width, height) {
  return Math.hypot((b[0] - a[0]) * width, (b[1] - a[1]) * height)
}

/** 向心参数化（α=0.5）：结点间距 = 像素弦长的平方根 */
function knot(a, b, width, height) {
  return Math.sqrt(pixelLength(a, b, width, height))
}

/**
 * 顶点切线（按这一段的参数长度缩放）：非均匀 Catmull-Rom 三点公式。
 * 开放折线的端点没有第二个邻点，切线就是唯一相邻那一段本身——首尾段不会外推。
 */
function vertexTangent(ring, index, closed, width, height, segmentKnot) {
  const n = ring.length
  const value = ring[index]
  const hasPrev = closed || index > 0
  const hasNext = closed || index < n - 1
  const prev = hasPrev ? ring[(index - 1 + n) % n] : value
  const next = hasNext ? ring[(index + 1) % n] : value
  const prevKnot = hasPrev ? knot(prev, value, width, height) : 0
  const nextKnot = hasNext ? knot(value, next, width, height) : 0
  if (!hasPrev) {
    const scale = nextKnot > EPS ? segmentKnot / nextKnot : 0
    return [(next[0] - value[0]) * scale, (next[1] - value[1]) * scale]
  }
  if (!hasNext) {
    const scale = prevKnot > EPS ? segmentKnot / prevKnot : 0
    return [(value[0] - prev[0]) * scale, (value[1] - prev[1]) * scale]
  }
  // 重复点会让结点间距为 0：退化成单侧差，绝不除以 0
  if (prevKnot <= EPS || nextKnot <= EPS) {
    const from = prevKnot > EPS ? prev : value
    const to = nextKnot > EPS ? next : value
    const spacing = Math.max(prevKnot, nextKnot, EPS)
    const scale = segmentKnot / spacing
    return [(to[0] - from[0]) * scale, (to[1] - from[1]) * scale]
  }
  return [
    ((value[0] - prev[0]) / prevKnot - (next[0] - prev[0]) / (prevKnot + nextKnot) + (next[0] - value[0]) / nextKnot) * segmentKnot,
    ((value[1] - prev[1]) / prevKnot - (next[1] - prev[1]) / (prevKnot + nextKnot) + (next[1] - value[1]) / nextKnot) * segmentKnot,
  ]
}

/** 三次 Hermite：s∈[0,1] 从 p1 到 p2，切线按 strength 缩放（0 = 直线，1 = 标准向心 CR） */
function hermitePoint(p1, p2, tangent1, tangent2, s, strength) {
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  const t1x = tangent1[0] * strength
  const t1y = tangent1[1] * strength
  const t2x = tangent2[0] * strength
  const t2y = tangent2[1] * strength
  return [h00 * p1[0] + h10 * t1x + h01 * p2[0] + h11 * t2x, h00 * p1[1] + h10 * t1y + h01 * p2[1] + h11 * t2y]
}

function stepsFor(pixels) {
  if (!(pixels > EPS)) return 0
  return Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.ceil(pixels / SAMPLE_TARGET_PX)))
}

/** 一段一段的采样点（不含起点；终点由下一段/闭包给出） */
function sampleSegment(ring, index, closed, width, height, strength, steps) {
  const n = ring.length
  const p1 = ring[index]
  const p2 = ring[(index + 1) % n]
  const segmentKnot = knot(p1, p2, width, height)
  const tangent1 = vertexTangent(ring, index, closed, width, height, segmentKnot)
  const tangent2 = vertexTangent(ring, (index + 1) % n, closed, width, height, segmentKnot)
  const out = []
  for (let k = 1; k < steps; k++) out.push(hermitePoint(p1, p2, tangent1, tangent2, k / steps, strength))
  return out
}


/**
 * 归一化控制点 → 归一化平滑点（过全部控制点、闭合环闭合、开放折线端点不外推）。
 * strength=0 returns a copy; invalid explicit strengths are rejected, never clamped or disabled.
 * @param {Point[]} points
 * @param {SmoothOptions} options
 * @returns {Point[]}
 */
export function smoothPoints(points, options) {
  const copy = points.map(point => [point[0], point[1]])
  const strength = options?.strength
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError('smooth 必须是 0..1 的有限数字，不会自动改强度')
  if (strength === 0 || points.length < 3) return copy
  const { width, height } = options
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new RangeError('平滑需要真实的正数画布尺寸，不猜测默认尺寸')
  const closed = options.closed === true
  const ring = ringPoints(points, closed)
  const n = ring.length
  const segments = closed ? n : n - 1
  if (n < 3 || segments < 1) return copy

  const lengths = Array.from({ length: segments }, (_, index) => pixelLength(ring[index], ring[(index + 1) % n], width, height))
  let steps = lengths.map(stepsFor)
  // 极端输入（超长环 × 大画布）按比例降密度，仍然每段至少 1 个采样，绝不删控制点
  const planned = steps.reduce((sum, value) => sum + Math.max(1, value), 0) + 1
  if (planned > MAX_OUTPUT_POINTS) {
    const factor = (MAX_OUTPUT_POINTS - n) / planned
    steps = steps.map(value => Math.max(1, Math.floor(value * factor)))
  }

  const out = []
  for (let index = 0; index < segments; index++) {
    out.push([ring[index][0], ring[index][1]])
    if (steps[index] > 0) out.push(...sampleSegment(ring, index, closed, width, height, strength, steps[index]))
  }
  const end = ring[closed ? 0 : n - 1]
  out.push([end[0], end[1]])
  return out
}

/** 点到线段的距离（曲线偏离用「到两端控制点连线」的距离） */
function distanceToSegment(point, a, b, width, height) {
  const ax = a[0] * width, ay = a[1] * height
  const bx = b[0] * width, by = b[1] * height
  const px = point[0] * width, py = point[1] * height
  const dx = bx - ax, dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

/** 该段的验收上限：三个口径取最大，短段不吃锚定容差的亏，长段不会被 6px 放过 */
function segmentLimit(segmentPixels, width, height) {
  const anchor = Math.max(SMOOTHING_LIMITS.minPx, SMOOTHING_LIMITS.frameRatio * Math.max(width, height))
  return Math.max(anchor, segmentPixels * SMOOTHING_LIMITS.segmentRatio)
}

function segmentDeviation(ring, index, closed, width, height, strength) {
  const n = ring.length
  const p1 = ring[index]
  const p2 = ring[(index + 1) % n]
  const segmentPixels = pixelLength(p1, p2, width, height)
  const limit = segmentLimit(segmentPixels, width, height)
  if (!(segmentPixels > EPS)) return { deviation: 0, limit }
  const steps = Math.max(MIN_STEPS, stepsFor(segmentPixels))
  let deviation = 0
  for (const point of sampleSegment(ring, index, closed, width, height, strength, steps)) {
    deviation = Math.max(deviation, distanceToSegment(point, p1, p2, width, height))
  }
  return { deviation, limit }
}

/** 不超上限的最大强度（0.05 滑杆步长）；连 0.05 都超就只能关掉 */
function suggestedStrength(ring, index, closed, width, height, limit) {
  let low = 0
  let high = 1
  for (let step = 0; step < 14; step++) {
    const mid = (low + high) / 2
    if (segmentDeviation(ring, index, closed, width, height, mid).deviation <= limit) low = mid
    else high = mid
  }
  const rounded = Math.floor(low * 20) / 20
  return rounded < 0.05 ? 0 : rounded
}

/**
 * 逐段检查偏离口径。返回所有超限的段（segment 从 1 起）及其上限、可行强度；strength ≤ 0 时没有曲线。
 * @param {Point[]} points
 * @param {SmoothOptions} options
 * @returns {DeviationInfo[]}
 */
export function deviationProblems(points, options) {
  const strength = options?.strength
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError('smooth 必须是 0..1 的有限数字，不会自动改强度')
  if (strength === 0 || points.length < 3) return []
  const { width, height } = options
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new RangeError('平滑需要真实的正数画布尺寸，不猜测默认尺寸')
  const closed = options.closed === true
  const ring = ringPoints(points, closed)
  const n = ring.length
  const segments = closed ? n : n - 1
  if (n < 3 || segments < 1) return []
  const problems = []
  for (let index = 0; index < segments; index++) {
    const info = segmentDeviation(ring, index, closed, width, height, strength)
    if (info.deviation <= info.limit + 1e-6) continue
    problems.push({
      segment: index + 1,
      deviation: info.deviation,
      limit: info.limit,
      suggested: suggestedStrength(ring, index, closed, width, height, info.limit),
    })
  }
  return problems
}

/** 只有 polygon/polyline 有可平滑的点 */
function smoothable(layer) {
  return layer.type === 'polygon' || layer.type === 'polyline'
}

/**
 * 渲染副本：只替换显式给出且 strength>0 的线/面点，其余图层保持同一引用，从不改传入文档。
 * @param {object} doc
 * @param {LayerOptions} [options]
 * @returns {object}
 */
export function renderCopyWithSmoothing(doc, options = {}) {
  const width = doc.base?.width
  const height = doc.base?.height
  let changed = false
  const layers = doc.layers.map(layer => {
    if (!smoothable(layer)) return layer
    const entry = options ? options[layer.id] : undefined
    const strength = entry && typeof entry.smooth === 'number' ? entry.smooth : 0
    if (!(strength > 0)) return layer
    const points = smoothPoints(layer.points, { closed: layer.type === 'polygon', strength, width, height })
    const unchanged = points.length === layer.points.length && points.every((point, index) => point[0] === layer.points[index][0] && point[1] === layer.points[index][1])
    if (unchanged) return layer
    changed = true
    return { ...layer, points }
  })
  return changed ? { ...doc, layers } : doc
}

/**
 * 缺省强度：只有锚定到真实路线/面要素的线面才 1；origin=dataset 的要素 0；
 * 标题框、装饰框、图例线这类没有要素锚定的线面也是 0——它们不是地理走向。
 * @param {object} doc
 * @param {Array<{id: string, origin?: string}>} features
 * @returns {LayerOptions}
 */
export function defaultLayerOptions(doc, features) {
  const origins = new Map(features.map(feature => [feature.id, feature.origin]))
  const options = {}
  for (const layer of doc.layers) {
    if (!smoothable(layer)) continue
    const semanticId = layer.anchor?.semantic_id
    const anchored = !!semanticId && origins.has(semanticId)
    options[layer.id] = { smooth: anchored && origins.get(semanticId) !== 'dataset' ? 1 : 0 }
  }
  return options
}

const describeValue = (value) => {
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  return typeof value === 'object' ? '对象' : JSON.stringify(value) ?? 'undefined'
}

/**
 * 严格校验 layer_options：只认 { smooth: 0..1 }，不钳制、不补默认、不吞多余字段。
 * 没给 doc / doc 还没有图层时允许要素 id 暂存（调用方再按 map_spec 核对存在性）；
 * 已有文档只接受现有线/面图层 id 或它的要素锚定 id，未知键和非线面图层都拒收。
 * @param {unknown} raw
 * @param {object} [doc]
 * @returns {{ options: LayerOptions, problems: SmoothProblem[] }}
 */
export function validateLayerOptions(raw, doc) {
  const problems = []
  if (raw === undefined) return { options: {}, problems }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
    problems.push({ path: 'layer_options', code: 'smoothing_invalid', message: 'layer_options 必须是对象：{ "图层或要素 id": { "smooth": 0..1 } }' })
    return { options: {}, problems }
  }
  const layerTypes = new Map()
  const semanticTypes = new Map()
  const semanticLayerIds = new Map()
  if (doc) {
    for (const layer of doc.layers) {
      layerTypes.set(layer.id, layer.type)
      const semanticId = layer.anchor?.semantic_id
      if (semanticId && (smoothable(layer) || !semanticTypes.has(semanticId))) {
        semanticTypes.set(semanticId, layer.type)
        semanticLayerIds.set(semanticId, layer.id)
      }
    }
  }
  const options = {}
  for (const [key, value] of Object.entries(raw)) {
    const path = `layer_options.${key}`
    if (key.length === 0 || key !== key.trim()) {
      problems.push({ path, code: 'smoothing_invalid', message: `键 ${JSON.stringify(key)} 前后有空白，必须是图层 id 或要素 id 原文` })
      continue
    }
    if (key.length > 64) {
      problems.push({ path, code: 'smoothing_invalid', message: `键 ${key.slice(0, 16)}… 长 ${key.length} 字符，图层与要素 id 最长 64` })
      continue
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      problems.push({ path, code: 'smoothing_invalid', message: `${key} 是保留键，不能作为平滑图层或要素 id` })
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      problems.push({ path: `${path}.smooth`, code: 'smoothing_invalid', message: `平滑参数必须是对象 { "smooth": 0..1 }，当前是 ${describeValue(value)}` })
      continue
    }
    const extra = Object.keys(value).filter(name => name !== 'smooth')
    if (extra.length) {
      problems.push({ path, code: 'smoothing_invalid', message: `只接受 smooth 字段，${extra.join('、')} 不是平滑参数（不要塞进 layer_options）` })
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'smooth')) {
      problems.push({ path: `${path}.smooth`, code: 'smoothing_invalid', message: '缺少 smooth：必须是 0..1 的数字（0=关闭，1=最强），代码不补默认值' })
      continue
    }
    const smooth = value.smooth
    if (typeof smooth !== 'number' || !Number.isFinite(smooth)) {
      problems.push({ path: `${path}.smooth`, code: 'smoothing_invalid', message: `smooth 必须是数字，当前是 ${describeValue(smooth)}` })
      continue
    }
    if (smooth < 0 || smooth > 1) {
      problems.push({ path: `${path}.smooth`, code: 'smoothing_invalid', message: `smooth 必须在 0..1（0=关闭，1=最强），当前是 ${smooth}；不钳制、不四舍五入` })
      continue
    }
    const layerType = layerTypes.get(key) ?? semanticTypes.get(key)
    if (doc && doc.layers.length > 0 && !layerType) {
      problems.push({ path, code: 'smoothing_invalid', message: `${key} 不是现有线/面图层 id 或其要素 id；请使用当前文档的图层键，不会忽略未知参数` })
      continue
    }
    if (layerType && layerType !== 'polygon' && layerType !== 'polyline') {
      problems.push({ path, code: 'smoothing_invalid', message: `${key} 是 ${layerType} 图层，只有 polygon/polyline 可以平滑` })
      continue
    }
    const canonicalKey = layerTypes.has(key) ? key : semanticLayerIds.get(key) ?? key
    if (Object.prototype.hasOwnProperty.call(options, canonicalKey) && options[canonicalKey].smooth !== smooth) {
      problems.push({ path, code: 'smoothing_invalid', message: `${key} 与图层键 ${canonicalKey} 指向同一图层但强度不同，请只保留一个明确值` })
      continue
    }
    options[canonicalKey] = { smooth }
  }
  return { options, problems }
}

/**
 * 交付/保存前的偏离校验：显式开启平滑的线面逐段比对口径，超限即拒收并给出可行强度。
 * 只报告，不改强度、不改文档。
 * @param {object} doc
 * @param {LayerOptions} [options]
 * @returns {SmoothProblem[]}
 */
export function smoothingProblems(doc, options = {}) {
  const width = doc.base?.width
  const height = doc.base?.height
  const problems = []
  for (const layer of doc.layers) {
    if (!smoothable(layer)) continue
    const entry = options ? options[layer.id] : undefined
    const strength = entry && typeof entry.smooth === 'number' ? entry.smooth : 0
    if (!(strength > 0)) continue
    const closed = layer.type === 'polygon'
    const anchor = Math.max(SMOOTHING_LIMITS.minPx, SMOOTHING_LIMITS.frameRatio * Math.max(width, height))
    for (const info of deviationProblems(layer.points, { closed, strength, width, height })) {
      const label = layer.name ? `「${layer.name}」(${layer.id})` : layer.id
      problems.push({
        path: `layer_options.${layer.id}.smooth`,
        code: 'smoothing_deviation',
        layer_id: layer.id,
        message: `smoothing_deviation：图层 ${label} 第 ${info.segment} 段的平滑曲线偏离两端控制点连线 ${info.deviation.toFixed(1)}px，`
          + `上限 ${info.limit.toFixed(1)}px（max(锚定容差 ${anchor.toFixed(1)}px, 段长×${SMOOTHING_LIMITS.segmentRatio})）；`
          + `请把 smooth 从 ${strength} 调到 ${info.suggested}${info.suggested ? ' 以下' : '（关闭）'} 或设为 0，代码不会自动改强度`,
      })
    }
  }
  return problems
}

/**
 * 几何编辑器用的键：线/面图层锚定到该要素时写图层 id（后端就用这个键），还没画出图层时用要素 id 暂存
 * （作图阶段会把要素键映射到落地图层 id）。
 * @param {{ layers?: any[] } | null | undefined} doc
 * @param {string} featureId
 * @returns {string}
 */
export function smoothKeyFor(doc, featureId) {
  const layer = doc?.layers?.find(item => smoothable(item) && item.anchor?.semantic_id === featureId)
  return layer ? layer.id : featureId
}

/**
 * 在控制点环的 `segment` 段中点插入一个顶点（纯函数，供编辑器与测试共用）。
 * 原有控制点一个不动、顺序不变；闭合环重复的收尾点继续留在最后。
 * @param {Point[]} points
 * @param {number} segment 段序号（0 起，指 vertex segment → 下一个环顶点）
 * @param {Point} point 新控制点（调用方按像素中点反投影得到）
 * @param {boolean} closed
 * @returns {Point[]}
 */
export function insertVertex(points, segment, point, closed) {
  const closedRing = closed && points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]
  const uniqueCount = closedRing ? points.length - 1 : points.length
  const lastSegment = closed ? uniqueCount - 1 : uniqueCount - 2
  if (!Number.isInteger(segment) || segment < 0 || segment > lastSegment) {
    throw new Error(`段序号 ${segment} 不在 0..${lastSegment}`)
  }
  const copy = points.map(item => [item[0], item[1]])
  copy.splice(segment + 1, 0, [point[0], point[1]])
  return copy
}
