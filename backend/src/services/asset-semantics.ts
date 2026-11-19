/**
 * 证据素材的语义标注（Issue #47）— `props.semantics` 的唯一读写口
 *
 * 为什么是 JSON 列而不是第 4 类资产：资产 kind 三元联合在 15 处硬编码
 * （reference-images / asset-library / storyboard-assets / asset-batch / media-library …），
 * 加一类的代价远高于收益；证据素材用 `props.type` 子类型 + 本 JSON 列表达。
 *
 * 坐标口径（跨 Issue 契约，#48/#49/#50 消费）：
 * - 全部是**原图像素**（`faithful_source` 指向的那张上传原件），原点左上角；
 * - 视觉模型只看缩放后的图，它给的框要先按比例换算回原图再进这里；
 * - 美化派生图与原图同画幅（`image_edit` 跟随第 1 张参考图尺寸），渲染时按比例换算即可。
 *
 * `source` 说明每一项的来源可信度：`vlm` = 视觉模型直接给的（只当锚点用，几何不可信）、
 * `cv` = 程序从像素里算出来的、`manual` = 人工改过的。人改过的项目在重跑自动标注时
 * 不会被覆盖（见 mergeSemantics）。
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

/** 几何点数上限：防止把一条抖动的 CV 折线原样灌进库（简化后正常在 20–80 点） */
const MAX_GEOMETRY_POINTS = 2000
/** 单组条目上限：一张图上 200 个地名已经远超实际，超出必然是模型/算法失控 */
const MAX_ITEMS_PER_GROUP = 200

export type SemanticSource = 'vlm' | 'cv' | 'manual'
export type SemanticLineKind = 'river' | 'route' | 'border'

export const SEMANTIC_SOURCES: SemanticSource[] = ['vlm', 'cv', 'manual']
export const SEMANTIC_LINE_KINDS: SemanticLineKind[] = ['river', 'route', 'border']

/**
 * 自动结果的置信门槛（Issue #47 评审决议）：低于此值的条目一律标 `needs_review`。
 * 用户确认的方案是「VLM 锚点 + CV 几何 + **人工修正**」，所以质量不达标的几何
 * 不是删掉而是**留作草稿并显式标记**，由人在语义面板里改——但绝不能悄悄混进
 * 看起来已经标好的结果里。
 */
export const NEEDS_REVIEW_CONFIDENCE = 0.6

/** 条目描述上限（字）：够写一句坐标推理 + 一句原文，再多读路径也不会带进提示词 */
export const SEMANTIC_DESCRIPTION_MAX = 500
/** 条目关键词条数上限 */
export const SEMANTIC_KEYWORDS_MAX = 12
/** 单个关键词长度上限（字） */
export const SEMANTIC_KEYWORD_MAX_CHARS = 20

/** 四类条目共有的审阅标记字段 */
export interface SemanticReviewable {
  /** true = 自动产出的质量存疑，界面标「待人工修正」，`warnings` 里有对应说明 */
  needs_review?: boolean
  /**
   * 条目的一句话说明（Issue #125）：地图交付时由代码拼接研究的坐标依据 + 原文摘录 + 来源名；
   * 设计模型据此判断这个名称指的具体是哪块地方——**佐证/否决用，不当选取依据**。
   */
  description?: string
  /** 检索关键词（Issue #125）：交付时取要素 category，人工可编辑 */
  keywords?: string[]
  /** true = `description`/`keywords` 被人工改过：交付不再覆盖（几何/图片仍归交付） */
  manual?: boolean
  /** true = 名称被人工改过：交付不再覆盖系统命名 */
  name_manual?: boolean
}

/** 地图交付为语义条目补充的 description/keywords（缺字段 = 没有可写的事实） */
export interface SemanticSupplement {
  description?: string
  keywords?: string[]
}

export interface SemanticLabel extends SemanticReviewable {
  id: string
  text: string
  /** [x1, y1, x2, y2]，原图像素，左上 → 右下 */
  bbox: [number, number, number, number]
  source: SemanticSource
  confidence: number
}

export interface SemanticPoint extends SemanticReviewable {
  id: string
  name: string
  at: [number, number]
  source: SemanticSource
  confidence: number
}

export interface SemanticRegion extends SemanticReviewable {
  id: string
  name: string
  points: Array<[number, number]>
  source: SemanticSource
  confidence: number
}

export interface SemanticLine extends SemanticReviewable {
  id: string
  name: string
  points: Array<[number, number]>
  kind: SemanticLineKind
  source: SemanticSource
  confidence: number
  /** 该线在原图上的颜色（#rrggbb）：CV 抽线用的色域，#48 渲染高亮时复用（附加字段） */
  color?: string
}

export interface SemanticsImageMeta {
  width: number
  height: number
  /** 坐标所针对的那张图的 sys_task id；人工手填时可为 null */
  source_task_id: number | null
}

export interface AssetSemantics {
  image: SemanticsImageMeta
  labels: SemanticLabel[]
  points: SemanticPoint[]
  regions: SemanticRegion[]
  lines: SemanticLine[]
  /** 自动标注没做成的部分（例如抽线失败）：必须留痕，不许伪造几何（附加字段） */
  warnings?: string[]
  /**
   * 整张图是否还有待人工修正的条目（派生字段，由规范化统一算出）。
   * 界面与下游（#48/#49）绑这一个布尔值即可；`needs_review_count` 只补充「还有几项」。
   */
  needs_review?: boolean
  needs_review_count?: number
  /** 最近一次自动标注的时间与模型（附加字段，纯展示） */
  generated_at?: string
  model?: string
}

// ─── 校验 ────────────────────────────────────────────────────

const sourceSchema = z.enum(['vlm', 'cv', 'manual'])
const confidenceSchema = z.number().min(0).max(1)
const coordSchema = z.number().finite()
const pointSchema = z.tuple([coordSchema, coordSchema])

/** 四类条目共有的补充字段（Issue #125）：描述 / 关键词 / 人工标记 */
const supplementSchema = {
  description: z.string().max(SEMANTIC_DESCRIPTION_MAX).optional(),
  keywords: z.array(z.string().min(1).max(SEMANTIC_KEYWORD_MAX_CHARS)).max(SEMANTIC_KEYWORDS_MAX).optional(),
  manual: z.boolean().optional(),
  name_manual: z.boolean().optional(),
}

const semanticsSchema = z.object({
  image: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    source_task_id: z.number().int().positive().nullable().optional(),
  }),
  labels: z.array(z.object({
    id: z.string().optional(),
    text: z.string().min(1),
    bbox: z.tuple([coordSchema, coordSchema, coordSchema, coordSchema]),
    source: sourceSchema.optional(),
    confidence: confidenceSchema.optional(),
    needs_review: z.boolean().optional(),
    ...supplementSchema,
  })).max(MAX_ITEMS_PER_GROUP).optional(),
  points: z.array(z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    at: pointSchema,
    source: sourceSchema.optional(),
    confidence: confidenceSchema.optional(),
    needs_review: z.boolean().optional(),
    ...supplementSchema,
  })).max(MAX_ITEMS_PER_GROUP).optional(),
  regions: z.array(z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    points: z.array(pointSchema).min(3).max(MAX_GEOMETRY_POINTS),
    source: sourceSchema.optional(),
    confidence: confidenceSchema.optional(),
    needs_review: z.boolean().optional(),
    ...supplementSchema,
  })).max(MAX_ITEMS_PER_GROUP).optional(),
  lines: z.array(z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    points: z.array(pointSchema).min(2).max(MAX_GEOMETRY_POINTS),
    kind: z.enum(['river', 'route', 'border']).optional(),
    source: sourceSchema.optional(),
    confidence: confidenceSchema.optional(),
    needs_review: z.boolean().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    ...supplementSchema,
  })).max(MAX_ITEMS_PER_GROUP).optional(),
  warnings: z.array(z.string()).optional(),
  // 根级审阅标记是派生字段：接受传入（库里存的就带着），但一律按条目与 warnings 重算
  needs_review: z.boolean().optional(),
  needs_review_count: z.number().int().min(0).optional(),
  generated_at: z.string().optional(),
  model: z.string().optional(),
})

export class SemanticsValidationError extends Error {}

/** 坐标钳制到画幅内：模型给的框常溢出几个像素，整条丢弃比钳制更糟 */
function clamp(value: number, max: number): number {
  return Math.min(Math.max(Math.round(value), 0), max)
}

function clampPoint(p: [number, number], w: number, h: number): [number, number] {
  return [clamp(p[0], w), clamp(p[1], h)]
}

/**
 * 坐标**落在画幅外**（而不是只超出边界一点）视为非法：模型偶尔会把整张图的坐标
 * 按另一个尺寸给出，这类错误必须报错而不是悄悄钳制成一条贴边的线。
 */
function assertInFrame(coords: number[], limit: number, what: string): void {
  for (const value of coords) {
    if (!Number.isFinite(value)) throw new SemanticsValidationError(`${what} 含非数值坐标`)
    if (value < -limit * 0.1 || value > limit * 1.1) {
      throw new SemanticsValidationError(`${what} 的坐标 ${Math.round(value)} 超出图片范围（0–${limit}）`)
    }
  }
}

let idCounter = 0
/** 稳定、可读的 id（#48 的图层 anchor.semantic_id 引用它）：`lbl-3`、`ln-1` */
function ensureId(prefix: string, raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text) return text
  idCounter += 1
  return `${prefix}-${idCounter}`
}

/**
 * 校验 + 规范化。失败抛 `SemanticsValidationError`（路由翻成 400）。
 * 规范化做三件事：补 id/source/confidence 默认值、坐标取整并钳到画幅内、去掉空组。
 */
export function normalizeSemantics(raw: unknown): AssetSemantics {
  const parsed = semanticsSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || 'semantics'
    throw new SemanticsValidationError(`语义标注格式非法：${where} ${issue?.message ?? ''}`.trim())
  }
  const doc = parsed.data
  const w = doc.image.width
  const h = doc.image.height
  /**
   * 审阅标记：显式传了就以传入为准（自动管线据质量启发式标记），
   * 否则按置信度兜底——`manual` 条目是人自己填/改的，永远不标。
   */
  const reviewOf = (item: { source?: SemanticSource; confidence?: number; needs_review?: boolean }): boolean => {
    if (item.source === 'manual') return false
    if (item.needs_review !== undefined) return item.needs_review
    return (item.confidence ?? 1) < NEEDS_REVIEW_CONFIDENCE
  }
  /**
   * 补充字段（#125）白名单：描述去空白截断、关键词去重截断、人工标记原样保留。
   * 只保留非空字段——空串/空数组不落库，读路径据此「有则透出」。
   */
  const supplementOf = (item: {
    description?: string; keywords?: string[]; manual?: boolean; name_manual?: boolean
  }): Pick<SemanticReviewable, 'description' | 'keywords' | 'manual' | 'name_manual'> => {
    const out: Pick<SemanticReviewable, 'description' | 'keywords' | 'manual' | 'name_manual'> = {}
    const description = (item.description ?? '').replace(/\s+/g, ' ').trim().slice(0, SEMANTIC_DESCRIPTION_MAX)
    if (description) out.description = description
    const keywords: string[] = []
    for (const raw of item.keywords ?? []) {
      const word = raw.replace(/\s+/g, ' ').trim().slice(0, SEMANTIC_KEYWORD_MAX_CHARS)
      if (word && !keywords.includes(word)) keywords.push(word)
      if (keywords.length >= SEMANTIC_KEYWORDS_MAX) break
    }
    if (keywords.length) out.keywords = keywords
    if (item.manual === true) out.manual = true
    if (item.name_manual === true) out.name_manual = true
    return out
  }
  const labels: SemanticLabel[] = (doc.labels ?? []).map((item) => {
    assertInFrame([item.bbox[0], item.bbox[2]], w, `标签「${item.text}」`)
    assertInFrame([item.bbox[1], item.bbox[3]], h, `标签「${item.text}」`)
    const x1 = clamp(Math.min(item.bbox[0], item.bbox[2]), w)
    const y1 = clamp(Math.min(item.bbox[1], item.bbox[3]), h)
    const x2 = clamp(Math.max(item.bbox[0], item.bbox[2]), w)
    const y2 = clamp(Math.max(item.bbox[1], item.bbox[3]), h)
    return {
      id: ensureId('lbl', item.id),
      text: item.text.trim(),
      bbox: [x1, y1, x2, y2],
      source: item.source ?? 'manual',
      confidence: item.confidence ?? 1,
      ...(reviewOf(item) ? { needs_review: true } : {}),
      ...supplementOf(item),
    }
  })

  const points: SemanticPoint[] = (doc.points ?? []).map((item) => {
    assertInFrame([item.at[0]], w, `地点「${item.name}」`)
    assertInFrame([item.at[1]], h, `地点「${item.name}」`)
    return {
      id: ensureId('pt', item.id),
      name: item.name.trim(),
      at: clampPoint(item.at, w, h),
      source: item.source ?? 'manual',
      confidence: item.confidence ?? 1,
      ...(reviewOf(item) ? { needs_review: true } : {}),
      ...supplementOf(item),
    }
  })

  const regions: SemanticRegion[] = (doc.regions ?? []).map((item) => {
    assertInFrame(item.points.map(p => p[0]), w, `区域「${item.name}」`)
    assertInFrame(item.points.map(p => p[1]), h, `区域「${item.name}」`)
    return {
      id: ensureId('rg', item.id),
      name: item.name.trim(),
      points: item.points.map(p => clampPoint(p, w, h)),
      source: item.source ?? 'manual',
      confidence: item.confidence ?? 1,
      ...(reviewOf(item) ? { needs_review: true } : {}),
      ...supplementOf(item),
    }
  })

  const lines: SemanticLine[] = (doc.lines ?? []).map((item) => {
    assertInFrame(item.points.map(p => p[0]), w, `线条「${item.name}」`)
    assertInFrame(item.points.map(p => p[1]), h, `线条「${item.name}」`)
    const line: SemanticLine = {
      id: ensureId('ln', item.id),
      name: item.name.trim(),
      points: item.points.map(p => clampPoint(p, w, h)),
      kind: item.kind ?? 'route',
      source: item.source ?? 'manual',
      confidence: item.confidence ?? 1,
      ...(reviewOf(item) ? { needs_review: true } : {}),
      ...supplementOf(item),
    }
    if (item.color) line.color = item.color.toLowerCase()
    return line
  })

  const out: AssetSemantics = {
    image: {
      width: w,
      height: h,
      source_task_id: doc.image.source_task_id ?? null,
    },
    labels,
    points,
    regions,
    lines,
  }
  // 派生字段统一在这里算，保证自动管线、人工 PUT、库里读回三条路径口径一致。
  // 注意 warnings 也算「需要人看」：被判掉的线条/填充失败的区域没有条目可标，
  // 只有 warning 文本，漏掉它们会让面板在恰恰最该提醒的时候不提醒。
  const pending = [...labels, ...points, ...regions, ...lines].filter(item => item.needs_review).length
  if (pending || doc.warnings?.length) out.needs_review = true
  if (pending) out.needs_review_count = pending
  if (doc.warnings?.length) out.warnings = doc.warnings
  if (doc.generated_at) out.generated_at = doc.generated_at
  if (doc.model) out.model = doc.model
  return out
}

/** 库里的 JSON 文本 → 文档；非法/为空一律返回 null（读路径不抛错） */
export function parseSemantics(raw: string | null | undefined): AssetSemantics | null {
  if (!raw || !raw.trim()) return null
  try {
    return normalizeSemantics(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 条目在多组里的统一形状：labels 用 `text` 作名称，其余用 `name` */
function entryName(entry: SemanticLabel | SemanticPoint | SemanticRegion | SemanticLine): string {
  return 'text' in entry ? entry.text : entry.name
}

function sameKeywords(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((word, index) => word === right[index])
}

/**
 * 人工 PUT 语义时的**字段打点**（Issue #125）：与库里上一份标注逐条比对，只把真正被改过的
 * 字段标成人工所有。
 *
 * - `description` / `keywords` 与旧值不同（或这条是新加的）→ `manual: true`；
 * - 名称（`name` / labels 的 `text`）与旧值不同 → `name_manual: true`；
 * - 没改的字段沿用旧条目的标记（人之前改过的仍算人工所有）。
 *
 * 这样交付重新生成文字时只覆盖没人碰过的条目，人工值永远不会被冲掉。
 */
export function markManualSupplements(next: AssetSemantics, previous: AssetSemantics | null): AssetSemantics {
  const previousById = new Map<string, SemanticLabel | SemanticPoint | SemanticRegion | SemanticLine>()
  if (previous) {
    for (const entry of [...previous.labels, ...previous.points, ...previous.regions, ...previous.lines]) {
      previousById.set(entry.id, entry)
    }
  }
  const mark = <T extends SemanticLabel | SemanticPoint | SemanticRegion | SemanticLine>(entry: T): T => {
    const prior = previousById.get(entry.id)
    const descriptionChanged = (prior?.description ?? '') !== (entry.description ?? '')
    const keywordsChanged = !sameKeywords(prior?.keywords, entry.keywords)
    const nameChanged = !prior || entryName(prior) !== entryName(entry)
    return {
      ...entry,
      ...(prior?.manual || descriptionChanged || keywordsChanged ? { manual: true } : {}),
      ...(prior?.name_manual || nameChanged ? { name_manual: true } : {}),
    }
  }
  return {
    ...next,
    labels: next.labels.map(mark),
    points: next.points.map(mark),
    regions: next.regions.map(mark),
    lines: next.lines.map(mark),
  }
}

/**
 * 交付生成的 description/keywords 写进语义文档（Issue #125）——**字段所有权**：
 *
 * - 几何/图片归交付（本函数只动文字字段）；
 * - `manual` 条目的 description/keywords 保留旧值，`name_manual` 条目的名称保留旧值；
 * - 没有人工标记的条目接受本次生成值；生成值缺该字段时保持原样（不清空）。
 *
 * 结果再过一次 `normalizeSemantics`：读路径、面板与提示词共用同一份白名单口径。
 */
export function withGeneratedSupplements(
  raw: unknown,
  previous: AssetSemantics | null,
  supplements: Map<string, SemanticSupplement>,
): AssetSemantics {
  const doc = normalizeSemantics(raw)
  const previousById = new Map<string, SemanticLabel | SemanticPoint | SemanticRegion | SemanticLine>()
  if (previous) {
    for (const entry of [...previous.labels, ...previous.points, ...previous.regions, ...previous.lines]) {
      previousById.set(entry.id, entry)
    }
  }
  const apply = <T extends SemanticLabel | SemanticPoint | SemanticRegion | SemanticLine>(entry: T): T => {
    const prior = previousById.get(entry.id)
    const generated = supplements.get(entry.id)
    const out = { ...entry } as T & { text?: string; name?: string }
    if (prior?.name_manual) {
      // labels 用 text 作名称，其余三组用 name
      const priorName = 'text' in prior ? prior.text : prior.name
      if ('text' in entry) out.text = priorName
      else out.name = priorName
    }
    if (prior?.manual) {
      if (prior.description) out.description = prior.description
      else delete out.description
      if (prior.keywords?.length) out.keywords = prior.keywords
      else delete out.keywords
      out.manual = true
      return out
    }
    if (generated?.description) out.description = generated.description
    if (generated?.keywords?.length) out.keywords = generated.keywords
    return out
  }
  return normalizeSemantics({
    image: doc.image,
    labels: doc.labels.map(apply),
    points: doc.points.map(apply),
    regions: doc.regions.map(apply),
    lines: doc.lines.map(apply),
    ...(doc.warnings?.length ? { warnings: doc.warnings } : {}),
    ...(doc.generated_at ? { generated_at: doc.generated_at } : {}),
    ...(doc.model ? { model: doc.model } : {}),
  })
}

/**
 * 自动标注结果与既有标注合并：**人工改过的项（source='manual'）永远保留**，
 * 自动结果里同 id 的条目让位。这是「自动标注不保证一次正确，人工修正是流程的一部分」
 * 的落地——重跑自动标注不能抹掉人刚修好的那条线。
 *
 * 合并结果再过一次 `normalizeSemantics`：`needs_review` / `needs_review_count`
 * 是派生字段，必须按**合并后**的条目重算，否则人工改掉一半后徽标还停在旧数字。
 */
export function mergeSemantics(existing: AssetSemantics | null, fresh: AssetSemantics): AssetSemantics {
  if (!existing) return normalizeSemantics(fresh)
  const keepManual = <T extends { id: string; source: SemanticSource; manual?: boolean; name_manual?: boolean }>(prev: T[], next: T[]): T[] => {
    // 人工改过的名称/描述（#125 的条目级标记）与 source='manual' 同等保护
    const manual = prev.filter(item => item.source === 'manual' || item.manual === true || item.name_manual === true)
    const manualIds = new Set(manual.map(item => item.id))
    return [...manual, ...next.filter(item => !manualIds.has(item.id))]
  }
  return normalizeSemantics({
    image: fresh.image,
    labels: keepManual(existing.labels, fresh.labels),
    points: keepManual(existing.points, fresh.points),
    regions: keepManual(existing.regions, fresh.regions),
    lines: keepManual(existing.lines, fresh.lines),
    ...(fresh.warnings?.length ? { warnings: fresh.warnings } : {}),
    ...(fresh.generated_at ? { generated_at: fresh.generated_at } : {}),
    ...(fresh.model ? { model: fresh.model } : {}),
  })
}

/** 条目计数（状态接口与界面统计共用） */
export function countSemantics(doc: AssetSemantics | null): { labels: number; points: number; regions: number; lines: number } {
  return {
    labels: doc?.labels.length ?? 0,
    points: doc?.points.length ?? 0,
    regions: doc?.regions.length ?? 0,
    lines: doc?.lines.length ?? 0,
  }
}

// ─── 持久化 ──────────────────────────────────────────────────

export async function loadPropSemantics(propId: number): Promise<AssetSemantics | null> {
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
  return parseSemantics(prop?.semantics)
}

/** 写入（已规范化的文档）；调用方负责先 normalizeSemantics */
export async function savePropSemantics(propId: number, doc: AssetSemantics): Promise<void> {
  await db.update(schema.props)
    .set({ semantics: JSON.stringify(doc), updatedAt: now() })
    .where(eq(schema.props.id, propId))
}

/**
 * 语义标注 / 确定性片段的底图：优先 `faithful_source` 指向的那条原件版本，否则退当前图。
 * 坐标永远针对这张图——界面预览、CV 抽线（#47）与片段底图（#50）必须用同一张，
 * 否则像素坐标会落在被美化版改过的画面上。
 */
export async function resolveSemanticsBase(
  prop: typeof schema.props.$inferSelect,
): Promise<{ path: string | null; taskId: number | null }> {
  if (prop.faithfulSource) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, prop.faithfulSource))
    const path = task?.localPath || task?.resultUrl || null
    if (path) return { path, taskId: task!.id }
  }
  const current = prop.localPath || prop.imageUrl || null
  if (!current) return { path: null, taskId: null }
  // 当前图如果本身就是某条版本行，把那条行的 id 记进 semantics.image.source_task_id
  const tasks = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'image'), eq(schema.sysTask.propId, prop.id)))
  const match = tasks.find(task => (task.localPath || task.resultUrl || '') === current)
  return { path: current, taskId: match?.id ?? null }
}
