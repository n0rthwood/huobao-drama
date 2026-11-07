import { runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-restart.js'

/**
 * 证据素材的自动语义标注（Issue #47）— VLM 语义锚点 + CV 几何
 *
 * 分工是实测逼出来的（#44 正文）：
 * - **视觉模型**只回答「什么在哪里」：图上可读的地名、每个地名的像素框、线条的名字与颜色、
 *   区域的名字与一个落在区域空白处的种子点。一次问太多会让框的质量明显下降，所以按小批提问。
 * - **CV** 负责几何：标签框吸附到墨迹、按模型报的颜色抽线、深色线膨胀闭合后从种子泛洪出区域。
 * - 模型给的框只是**种子**：实测小字号地名（斋桑湖/西宁/成都/拉萨）系统性偏上约一个字高，
 *   吸附成功的条目 `source` 记 `cv`（坐标由程序确定），沿用模型的 confidence。
 *
 * 任何一步失败都**如实记 warning 并留空**，绝不伪造几何（验收 3b 的硬要求）。
 * 任务行是 sys_task(type='text', kind='asset_semantics')，进任务中心。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveStageModel, type StageModel } from './ai-stages.js'
import { onAssetLibraryChanged } from './asset-review.js'
import { callTextChat, imageContentPart } from './vision-chat.js'
import { extractFirstJson } from '../agents/tools/vision-tools.js'
import {
  createTextTask,
  finishTextTask,
  parseTextTaskParams,
  patchTextTaskParams,
  textTaskKindOf,
  textTaskOutcome,
} from './text-task.js'
import {
  countSemantics,
  NEEDS_REVIEW_CONFIDENCE,
  loadPropSemantics,
  mergeSemantics,
  normalizeSemantics,
  savePropSemantics,
  type AssetSemantics,
  type SemanticLabel,
  type SemanticLine,
  type SemanticPoint,
  type SemanticRegion,
} from './asset-semantics.js'
import {
  colorMask,
  floodRegion,
  GEOMETRY_MAX_SIDE,
  loadRaster,
  maskToPolyline,
  isExtractableLineColor,
  lineMaskQuality,
  largestComponent,
  MAX_LINE_JUMP,
  MAX_LINE_THICKNESS,
  parseHexColor,
  simplifyPolyline,
  snapBoxToInk,
  type Bbox,
  type Point,
  type RgbRaster,
} from './semantics-geometry.js'

/** 一次问几个地名的像素框：实测一次问 10 个时小字号明显偏移，4 个一批质量稳定 */
const LABEL_BATCH = 4
/** 读图比纯文本慢；每次调用给 3 分钟 */
const VISION_TIMEOUT_MS = 180_000
const VISION_TEMPERATURE = 0.1
const VISION_MAX_TOKENS = 3000
/** 地名上限：超过这个数的「地名表」基本是模型在编 */
const MAX_NAMES = 40

export interface SemanticsAutoStatus {
  status: 'running' | 'done' | 'error' | 'none'
  task_id: number | null
  error: string | null
  warnings: string[]
  counts: { labels: number; points: number; regions: number; lines: number }
}

// ─── 模型问答（每一步都只问「是什么/在哪」） ──────────────────

interface VisionAsk {
  config: StageModel
  part: Record<string, unknown>
  framing: string
}

async function askJson(ask: VisionAsk, question: string): Promise<unknown> {
  const { text } = await callTextChat(
    ask.config,
    [{ type: 'text', text: ask.framing + question }, ask.part],
    { temperature: VISION_TEMPERATURE, maxTokens: VISION_MAX_TOKENS, timeoutMs: VISION_TIMEOUT_MS },
  )
  const parsed = extractFirstJson(text)
  if ('error' in parsed) throw new Error(`模型返回无法解析为 JSON：${parsed.error}`)
  return parsed.json
}

function asArray(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner
  }
  return []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBbox(value: unknown): Bbox | null {
  if (!Array.isArray(value) || value.length < 4) return null
  const nums = value.slice(0, 4).map(Number)
  if (nums.some(n => !Number.isFinite(n))) return null
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
}

function asPoint(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const x = Number(value[0])
  const y = Number(value[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return [x, y]
}

/** 第 1 问：图上有哪些可读的地名/注记，各自是「文字注记」还是「聚落点」 */
async function askNames(ask: VisionAsk): Promise<Array<{ text: string; kind: 'label' | 'point' }>> {
  const json = await askJson(ask, [
    '请只做一件事：把这张图上**实际印着的、你能读清楚**的地名与注记文字逐条列出来。',
    '不要推测图上没写的地名，不要给坐标。',
    '每条标 kind：文字注记写 "label"；带城市/聚落符号（圆点、方块、星号）的写 "point"。',
    '只输出 JSON：{"names":[{"text":"...","kind":"label"}]}',
  ].join('\n'))
  const out: Array<{ text: string; kind: 'label' | 'point' }> = []
  const seen = new Set<string>()
  for (const item of asArray(json, 'names')) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const text = asString(record.text) || asString(record.name)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push({ text, kind: asString(record.kind) === 'point' ? 'point' : 'label' })
    if (out.length >= MAX_NAMES) break
  }
  return out
}

/** 第 2 问（小批）：这几个地名各自的像素框 */
async function askBoxes(ask: VisionAsk, names: string[]): Promise<Map<string, { bbox: Bbox; confidence: number }>> {
  const json = await askJson(ask, [
    `请给出下面这些文字在图上的像素框（左上角原点）：${names.map(n => `「${n}」`).join('、')}。`,
    'bbox 为 [x1,y1,x2,y2]，要紧紧框住**文字本身**，不要框周围的图形。',
    '读不到的条目直接不要出现在结果里，不要猜。',
    '只输出 JSON：{"labels":[{"text":"...","bbox":[x1,y1,x2,y2],"confidence":0.9}]}',
  ].join('\n'))
  const result = new Map<string, { bbox: Bbox; confidence: number }>()
  for (const item of asArray(json, 'labels')) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const text = asString(record.text) || asString(record.name)
    const bbox = asBbox(record.bbox)
    if (!text || !bbox) continue
    const confidence = Number(record.confidence)
    result.set(text, { bbox, confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.6 })
  }
  return result
}

interface LineSeed {
  name: string
  kind: 'river' | 'route' | 'border'
  color: string
  endpoints: Point[]
  confidence: number
}

/** 第 3 问：图上有哪些线状要素（河流/路线/边界），各自什么颜色、两端大致在哪 */
async function askLines(ask: VisionAsk): Promise<LineSeed[]> {
  const json = await askJson(ask, [
    '请列出这张图上的**线状要素**：河流水系、行军/交通路线、政权边界线。',
    '每条写：name（图上标注的名字，没有名字就写它连接的两地）、kind（river/route/border）、',
    'color（这条线在图上的颜色，必须是 #rrggbb 十六进制，按你看到的实际印刷色给）、',
    'endpoints（这条线两端的大致像素坐标 [[x1,y1],[x2,y2]]）、confidence。',
    '**不要**描摹整条线的折线点，只给两端。图上没有的线不要编。',
    '只输出 JSON：{"lines":[{"name":"...","kind":"river","color":"#3a6fb0","endpoints":[[x,y],[x,y]],"confidence":0.8}]}',
  ].join('\n'))
  const out: LineSeed[] = []
  for (const item of asArray(json, 'lines')) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = asString(record.name)
    if (!name) continue
    const kindRaw = asString(record.kind)
    const endpoints = asArray(record.endpoints, 'endpoints').map(asPoint).filter((p): p is Point => !!p)
    const confidence = Number(record.confidence)
    out.push({
      name,
      kind: kindRaw === 'river' || kindRaw === 'border' ? kindRaw : 'route',
      color: asString(record.color),
      endpoints,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.6,
    })
  }
  return out
}

interface RegionSeed {
  name: string
  seed: Point | null
  confidence: number
}

/** 第 4 问：图上有哪些成片的范围，各给一个落在范围内空白处的种子点 */
async function askRegions(ask: VisionAsk): Promise<RegionSeed[]> {
  const json = await askJson(ask, [
    '请列出这张图上被边界线围起来的**地域范围**（政权辖地、势力范围、行政区）。',
    '每条写：name（范围的名字）、seed（一个确定落在该范围**内部空白处**的像素坐标 [x,y]，',
    '务必避开文字、边界线、城市符号——落在线或字上会导致填充失败）、confidence。',
    '**不要**给多边形顶点，只给种子点。',
    '只输出 JSON：{"regions":[{"name":"...","seed":[x,y],"confidence":0.8}]}',
  ].join('\n'))
  const out: RegionSeed[] = []
  for (const item of asArray(json, 'regions')) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = asString(record.name)
    if (!name) continue
    const confidence = Number(record.confidence)
    out.push({
      name,
      seed: asPoint(record.seed),
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.6,
    })
  }
  return out
}

// ─── 管线 ────────────────────────────────────────────────────

export interface SemanticsAutoResult {
  semantics: AssetSemantics
  warnings: string[]
}

/**
 * 跑完整条管线（纯服务逻辑，任务外壳在下面）。坐标全程在**分析光栅**的像素系里算，
 * 最后一次性按 1/scale 换算回原图像素再落库。
 */
export async function runSemanticsPipeline(input: {
  absPath: string
  config: StageModel
  sourceTaskId: number | null
  onProgress?: (phase: string) => void
}): Promise<SemanticsAutoResult> {
  const warnings: string[] = []
  const { raster, scale, sourceWidth, sourceHeight } = await loadRaster(input.absPath, GEOMETRY_MAX_SIDE)
  const prepared = await imageContentPart(relativeOf(input.absPath), { maxSide: GEOMETRY_MAX_SIDE, quality: 85 })
  // 模型看到的 JPEG 与分析光栅用同一个 maxSide，两边像素系一致，不需要二次换算
  const ask: VisionAsk = {
    config: input.config,
    part: prepared.part,
    framing: `这是一张 ${prepared.width}×${prepared.height} 像素的图片，所有像素坐标都以这个尺寸为准（原点在左上角）。\n`,
  }

  input.onProgress?.('names')
  const names = await askNames(ask)
  if (!names.length) warnings.push('视觉模型没有读出任何地名')

  input.onProgress?.('boxes')
  const boxes = new Map<string, { bbox: Bbox; confidence: number }>()
  for (let i = 0; i < names.length; i += LABEL_BATCH) {
    const batch = names.slice(i, i + LABEL_BATCH).map(n => n.text)
    try {
      for (const [text, box] of await askBoxes(ask, batch)) boxes.set(text, box)
    } catch (err) {
      warnings.push(`地名定位失败（${batch.join('、')}）：${messageOf(err)}`)
    }
  }

  const labels: SemanticLabel[] = []
  const points: SemanticPoint[] = []
  for (const name of names) {
    const box = boxes.get(name.text)
    if (!box) {
      warnings.push(`「${name.text}」没有拿到像素框，已跳过`)
      continue
    }
    const snapped = snapBoxToInk(raster, box.bbox)
    const bbox = snapped ?? box.bbox
    // 没吸附成功的条目坐标还是 VLM 原框，实测小字号会整体偏上一个字高：
    // 不丢弃（位置大致可用），但标成待人工修正
    const needsReview = !snapped || box.confidence < NEEDS_REVIEW_CONFIDENCE
    if (needsReview) {
      warnings.push(`「${name.text}」的框没能吸附到墨迹（置信度 ${box.confidence}），坐标仍是视觉模型原框，已标为待人工修正`)
    }
    if (name.kind === 'point') {
      points.push({
        id: `pt-${points.length + 1}`,
        name: name.text,
        at: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
        source: snapped ? 'cv' : 'vlm',
        confidence: box.confidence,
        ...(needsReview ? { needs_review: true } : {}),
      })
    } else {
      labels.push({
        id: `lbl-${labels.length + 1}`,
        text: name.text,
        bbox,
        source: snapped ? 'cv' : 'vlm',
        confidence: box.confidence,
        ...(needsReview ? { needs_review: true } : {}),
      })
    }
  }

  input.onProgress?.('lines')
  const lines: SemanticLine[] = []
  let lineSeeds: LineSeed[] = []
  try {
    lineSeeds = await askLines(ask)
  } catch (err) {
    warnings.push(`线状要素提问失败：${messageOf(err)}`)
  }
  for (const seed of lineSeeds) {
    const color = parseHexColor(seed.color)
    if (!color) {
      warnings.push(`「${seed.name}」没有可用的颜色（模型给的是 ${seed.color || '空'}），无法按色域抽线`)
      continue
    }
    // 开图核对发现：模型把黑色国界报成 #000000，黑色色域会选中全图墨迹，
    // 分箱后得到一条横跨全图的锯齿线。这种颜色一律不抽，如实记 warning。
    if (!isExtractableLineColor(color)) {
      warnings.push(`「${seed.name}」的颜色 ${seed.color} 是黑/白/灰，与图上的文字和其它墨迹无法区分，不能按色域抽线，未写入 lines，请人工标注`)
      continue
    }
    // 上传截图（Google Earth 等屏幕捕获）里同一条水体沿程亮度跨度极大，严格色域判据
    // 一个像素都命中不了（Issue #56 验收 10）。先按原判据抽，抽不出再按「同通道序」
    // 的放宽判据重试一次——扫描印刷图通常第一次就成功，不受影响。
    let extracted = extractLine(raster, color, seed.endpoints)
    let relaxed = false
    if ('reason' in extracted) {
      const strictReason = extracted.reason
      const retry = extractLine(raster, color, seed.endpoints, { hueOnly: true })
      if ('reason' in retry) {
        // 两条判据都没抽出来：把**两个**理由都写出来，否则看到的永远是严格判据那一条，
        // 排查时完全看不出放宽后卡在了哪一步
        extracted = { reason: `严格色域「${strictReason}」；放宽后「${retry.reason}」` }
      } else {
        extracted = retry
        relaxed = true
      }
    }
    if ('reason' in extracted) {
      warnings.push(`「${seed.name}」按颜色 ${seed.color} 抽线失败：${extracted.reason}；未写入 lines，请人工标注`)
      continue
    }
    if (relaxed) {
      warnings.push(`「${seed.name}」按严格色域抽不到线，已按截图放宽判据（同通道序 + 最小彩度）重新抽取，请人工核对走向`)
    }
    // 勉强过关的几何仍然留作草稿，但必须显式标出来（评审决议）：
    // 用户确认的方案是「VLM + CV + 人工修正」，所以不删，只标 needs_review 并进 warnings
    const shaky = extracted.quality.thickness > MAX_LINE_THICKNESS / 2
      || extracted.quality.jump > MAX_LINE_JUMP / 2
    const needsReview = shaky || seed.confidence < NEEDS_REVIEW_CONFIDENCE
    if (needsReview) {
      warnings.push(`线条「${seed.name}」的自动结果质量存疑（粗细 ${(extracted.quality.thickness * 100).toFixed(1)}%、跳变 ${(extracted.quality.jump * 100).toFixed(1)}%、置信度 ${seed.confidence}），已标为待人工修正`)
    }
    lines.push({
      id: `ln-${lines.length + 1}`,
      name: seed.name,
      points: extracted.points,
      kind: seed.kind,
      source: 'cv',
      confidence: seed.confidence,
      color: seed.color.toLowerCase().startsWith('#') ? seed.color.toLowerCase() : `#${seed.color.toLowerCase()}`,
      ...(needsReview ? { needs_review: true } : {}),
    })
  }

  input.onProgress?.('regions')
  const regions: SemanticRegion[] = []
  let regionSeeds: RegionSeed[] = []
  try {
    regionSeeds = await askRegions(ask)
  } catch (err) {
    warnings.push(`地域范围提问失败：${messageOf(err)}`)
  }
  for (const seed of regionSeeds) {
    const candidates: Point[] = []
    if (seed.seed) candidates.push(seed.seed)
    // 模型给的种子常落在它自己刚报过的那行字上；标签正下方一个字高是实测可用的备选
    const label = labels.find(item => item.text === seed.name)
    if (label) candidates.push([(label.bbox[0] + label.bbox[2]) / 2, label.bbox[3] + (label.bbox[3] - label.bbox[1]) + 10])
    let polygon: Point[] | null = null
    let ratio = 0
    let reason = '模型没有给种子点'
    for (const candidate of candidates) {
      const result = floodRegion(raster, candidate)
      if (result.polygon) { polygon = result.polygon; ratio = result.ratio; break }
      reason = result.reason ?? '填充失败'
    }
    if (!polygon) {
      warnings.push(`「${seed.name}」区域填充失败（${reason}），未写入 regions，请人工标注`)
      continue
    }
    // 占掉三成以上画幅的「某一国范围」多半是从缺口漏出去的，留作草稿但标出来
    const needsReview = ratio > 0.3 || seed.confidence < NEEDS_REVIEW_CONFIDENCE
    if (needsReview) {
      warnings.push(`区域「${seed.name}」的自动结果质量存疑（占画幅 ${(ratio * 100).toFixed(1)}%、置信度 ${seed.confidence}），已标为待人工修正`)
    }
    regions.push({
      id: `rg-${regions.length + 1}`,
      name: seed.name,
      points: polygon,
      source: 'cv',
      confidence: seed.confidence,
      ...(needsReview ? { needs_review: true } : {}),
    })
  }

  // 分析光栅像素 → 原图像素
  const back = 1 / scale
  const toSource = (p: Point): Point => [Math.round(p[0] * back), Math.round(p[1] * back)]
  const semantics = normalizeSemantics({
    image: { width: sourceWidth, height: sourceHeight, source_task_id: input.sourceTaskId },
    labels: labels.map(item => ({
      ...item,
      bbox: [
        Math.round(item.bbox[0] * back), Math.round(item.bbox[1] * back),
        Math.round(item.bbox[2] * back), Math.round(item.bbox[3] * back),
      ],
    })),
    points: points.map(item => ({ ...item, at: toSource(item.at) })),
    regions: regions.map(item => ({ ...item, points: item.points.map(toSource) })),
    lines: lines.map(item => ({ ...item, points: item.points.map(toSource) })),
    warnings,
    generated_at: new Date().toISOString(),
    model: input.config.model,
  })
  return { semantics, warnings }
}

/**
 * 按颜色抽一条线：色域掩膜 → 长轴分箱中位数 → Douglas–Peucker。
 * 模型给的两个端点只用来**裁掉画幅里同色的其它东西**（图例、另一条同色线、湖面色块）：
 * 掩膜先限制在两端点的外扩包围盒里，再分箱。点数太少视为失败，返回 null 让调用方记 warning。
 */
function extractLine(
  raster: RgbRaster,
  color: { r: number; g: number; b: number },
  endpoints: Point[],
  opts: { hueOnly?: boolean } = {},
): { points: Point[]; quality: { thickness: number; jump: number } } | { reason: string } {
  let mask = colorMask(raster, color, 90, { hueOnly: opts.hueOnly })
  if (endpoints.length >= 2) {
    const pad = Math.round(Math.max(raster.width, raster.height) * 0.08)
    const x0 = Math.min(endpoints[0]![0], endpoints[1]![0]) - pad
    const x1 = Math.max(endpoints[0]![0], endpoints[1]![0]) + pad
    const y0 = Math.min(endpoints[0]![1], endpoints[1]![1]) - pad
    const y1 = Math.max(endpoints[0]![1], endpoints[1]![1]) + pad
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue
      const x = i % raster.width
      const y = (i - x) / raster.width
      if (x < x0 || x > x1 || y < y0 || y > y1) mask[i] = 0
    }
  }
  // 放宽判据必然连带选中画面上其它同色水体：先只留最大连通块，再交给原来的质量判据
  if (opts.hueOnly) mask = largestComponent(mask, raster.width, raster.height)
  const raw = maskToPolyline(mask, raster.width)
  const polyline = simplifyPolyline(raw, 3)
  if (polyline.length < 2) return { reason: '该色域下取不到足够的采样点' }
  // 色块填充型地图（资产 41）会让色域掩膜命中整片底色与图例文字，
  // 分箱中位数画出来是锯齿。这里按「粗细 + 跳变」判掉，宁可留空让人工标注
  const quality = lineMaskQuality(mask, raster.width, raw)
  if (quality.thickness > MAX_LINE_THICKNESS) {
    return { reason: `该颜色在图上是成片的色块而不是细线（分箱宽度约占图幅 ${(quality.thickness * 100).toFixed(1)}%）` }
  }
  if (quality.jump > MAX_LINE_JUMP) {
    return { reason: `同色像素分散在互不相连的区域，采样点出现 ${(quality.jump * 100).toFixed(1)}% 图幅的跳变` }
  }
  return { points: polyline, quality }
}

/** static/ 绝对路径 → 相对路径（imageContentPart 只收相对路径） */
function relativeOf(absPath: string): string {
  const index = absPath.lastIndexOf('static/')
  return index >= 0 ? absPath.slice(index) : absPath
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─── 任务外壳 ────────────────────────────────────────────────

export interface StartSemanticsAutoResult {
  started: boolean
  taskId: number
}

/**
 * 启动自动标注。没有能看图的配置时**仍然建任务行再立刻失败**：
 * 用户要能在任务中心看到「为什么没标注成功」，而不是一个静默的 400。
 */
export async function startSemanticsAuto(input: {
  propId: number
  episodeId: number
  dramaId: number
  propName: string
  absPath: string
  sourceTaskId: number | null
  configId?: number
  retryOf?: number
  excludeConfigIds?: number[]
}): Promise<StartSemanticsAutoResult> {
  // 视觉环节（#51）：没有标定为视觉的配置就直接 400，不建一条注定失败的任务，
  // 更不拿纯文本模型硬编坐标。错误由路由层转成 400。
  const config = await resolveStageModel('asset_semantics', { configId: input.configId, excludeConfigIds: input.excludeConfigIds })
  const taskId = await createTextTask({
    kind: 'asset_semantics',
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    prompt: `为证据素材「${input.propName}」自动标注语义`,
    stageModel: config,
    retryOf: input.retryOf,
    queued: true,
    restart: { kind: 'asset_semantics', args: { input } },
  })
  // 任务行按「集」落库；状态接口要据此只回本道具的那次任务
  await patchTextTaskParams(taskId, { prop_id: input.propId, semantics_phase: 'start' })

  logTaskStart('Semantics', 'auto', { propId: input.propId, model: config.model, path: input.absPath })
  void runWithTextTask(taskId, () => runSemanticsTask(taskId, { ...input, config }))
  return { started: true, taskId }
}

async function runSemanticsTask(taskId: number, ctx: {
  propId: number
  absPath: string
  sourceTaskId: number | null
  config: StageModel
}): Promise<void> {
  let phase = ''
  try {
    const { semantics, warnings } = await runSemanticsPipeline({
      absPath: ctx.absPath,
      config: ctx.config,
      sourceTaskId: ctx.sourceTaskId,
      onProgress: (phaseName) => {
        phase = phaseName
        logTaskProgress('Semantics', 'phase', { propId: ctx.propId, phase: phaseName })
        void patchTextTaskParams(taskId, { semantics_phase: phaseName })
      },
    })
    const merged = mergeSemantics(await loadPropSemantics(ctx.propId), semantics)
    await savePropSemantics(ctx.propId, merged)
    // 审核清单（#55）：自动标注写回语义 = 资产库变更，逐集校验绑定并记横幅理由
    await onAssetLibraryChanged('prop', ctx.propId, 'semantics_changed')
    const counts = countSemantics(merged)
    await patchTextTaskParams(taskId, { semantics_warnings: warnings, semantics_counts: counts, semantics_phase: 'done' })
    await finishTextTask(taskId, 'completed', {
      outputText: JSON.stringify({ counts, warnings }),
    })
    logTaskSuccess('Semantics', 'auto', { propId: ctx.propId, ...counts, warnings: warnings.length })
  } catch (err) {
    const message = messageOf(err)
    logTaskError('Semantics', 'auto', { propId: ctx.propId, error: message })
    await finishTextTask(taskId, 'failed', { errorMsg: `自动标注失败：${message}` })
    await requeueFirstModelFailure(taskId, err, phase === 'names')
  }
}

/** 该道具最近一次自动标注任务的状态（进行中的优先） */
export async function getSemanticsAutoStatus(propId: number): Promise<SemanticsAutoStatus> {
  const rows = (await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.type, 'text'))
    .orderBy(desc(schema.sysTask.id)))
    .filter(row => textTaskKindOf(row) === 'asset_semantics'
      && Number(parseTextTaskParams(row.params)?.prop_id) === propId)
  const running = rows.find(row => textTaskOutcome(row.status) === 'running')
  const row = running ?? rows[0]
  if (!row) {
    return { status: 'none', task_id: null, error: null, warnings: [], counts: { labels: 0, points: 0, regions: 0, lines: 0 } }
  }
  const raw: unknown = parseTextTaskParams(row.params)?.semantics_warnings
  const warnings = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  const counts = countSemantics(await loadPropSemantics(propId))
  return {
    status: textTaskOutcome(row.status),
    task_id: row.id,
    error: row.errorMsg ?? null,
    warnings,
    counts,
  }
}
