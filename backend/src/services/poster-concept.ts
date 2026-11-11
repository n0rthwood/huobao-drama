import { runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-autoretry.js'

/**
 * Poster AI 构想（Issue #72）：只用 AI 改写/拆分后的剧本 + 本集资产描述，
 * 一次产出三个有实质差异的构图方案（中心思想、选中资产、画面 prompt、文字描述、
 * 海报文案、文字图层规划），推荐项仅供参考。
 *
 * Issue #96 起文字层不再由模型写坐标与样式：`layer_plan` = `{text_layout, items:[{role, fields}]}`，
 * 只允许 poster_project / poster_title / poster_details 三类模板文本框，位置/字号/断行/缩小由
 * `services/layer-text.ts` 的规范引擎决定。模型输出先用引擎校验（临时 LayerDoc + `textLayerProblems`），
 * 阻断问题连同该槽位基准容量一起回给模型做同一任务内的唯一一次纠正；仍不合格则任务失败并保留原文。
 * DB 里的旧构想（label/card 数组 + 模型坐标）继续可读可显示，但应用时返回 400 要求重新生成。
 *
 * 本文件不写当前编辑字段：构想结果只落 `episode_posters.concept`，
 * 应用方案必须走 `POST /poster/concept/apply`（provenance 保护在 posters.ts）。
 */
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getContentLanguage } from './app-settings.js'
import { loadEpisodeAssets, parseMentions } from './storyboard-assets.js'
import { parseStylingVersion } from './styling-version.js'
import { resolveStageModel, type StageModel } from './ai-stages.js'
import { normalizeLayerDoc, LAYER_VARIABLES, type Layer, type LayerVariable } from './layer-doc.js'
import {
  POSTER_ONLY_ROLES,
  TEXT_CANONICAL_SIZES,
  TEXT_FIELD_MAX,
  TEXT_LIST_MAX,
  TEXT_SPEC,
  textCapacity,
  textFamilyOf,
  textLayerProblems,
  textLayoutById,
  textLayoutsFor,
  type TextFamily,
  type TextProblem,
} from './layer-text.js'
import { KEYFRAME_SIZES } from './storyboard-keyframes.js'
import { QWEN_MAX_REFS } from './adapters/qwen-jobs-client.js'
import { callTextChat } from './vision-chat.js'
import {
  createTextTask,
  findActiveTextTask,
  finishTextTask,
  patchTextTaskParams,
  updateTextTaskProgress,
} from './text-task.js'
import {
  loadPosterContext,
  ensurePosterRow,
  parseJsonObject,
  normalizeProvenance,
  posterEpisodeLabel,
  posterEpisodeNumberLabel,
  posterVariablesOf,
  type PosterContext,
  type PosterVariables,
} from './poster-store.js'
import { getDramaStylePrompt } from './style-preset.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export const POSTER_CONCEPT_VERSION = 1
/** 三个方案是用户确认的硬要求（Q11） */
export const POSTER_CONCEPT_COUNT = 3
/** 剧本超过这个长度才分批提炼，先不静默截断。 */
const SCRIPT_BUDGET_CHARS = 24_000
const SCRIPT_CHUNK_CHARS = 8_000
const CONCEPT_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16_384)
const CONCEPT_TIMEOUT_MS = 15 * 60_000

const KIND_LABEL: Record<string, string> = { character: '角色', scene: '场景', prop: '道具' }

const clipped = (max: number, fallback = '') =>
  z.preprocess(value => (typeof value === 'string' ? value.slice(0, max).trim() || fallback : fallback), z.string())

const bounded = (min: number, max: number, fallback: number) =>
  z.preprocess(value => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }, z.number())

const copySchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : {}),
  z.object({
    title: clipped(80),
    subtitle: clipped(120),
    era: clipped(60),
    place: clipped(80),
    notes: z.preprocess(
      value => (Array.isArray(value) ? value.slice(0, 12) : []),
      z.array(clipped(120)),
    ),
  }),
)

const assetSchema = z.object({
  kind: z.preprocess(value => (['character', 'scene', 'prop'].includes(String(value)) ? value : ''), z.string()),
  id: bounded(1, Number.MAX_SAFE_INTEGER, 0),
  name: clipped(60),
  role_in_poster: clipped(120),
  reason: clipped(400),
  // 方案应用时的不可变参考快照（Issue #72）：资产后续换图不能悄悄改变已生成的候选
  path: clipped(512),
  version_task_id: z.preprocess(
    value => (Number.isSafeInteger(value) && Number(value) > 0 ? value : null),
    z.number().nullable(),
  ),
})

/**
 * 旧版 layer_plan 条目（label/card + 模型坐标/样式，Issue #72）。
 * Issue #96 起不再生成，只用于读取旧构想（不迁移、继续可显示），应用时会被拒绝并提示重新生成。
 */
const legacyPlanItemSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : {}),
  z.object({
    type: z.preprocess(v => (v === 'card' ? 'card' : 'label'), z.enum(['label', 'card'])),
    name: clipped(60, '文字'),
    box: z.preprocess(
      value => (value && typeof value === 'object' ? value : {}),
      z.object({
        x: bounded(0, 1, 0.08),
        y: bounded(0, 1, 0.08),
        w: bounded(0.005, 2, 0.4),
        h: bounded(0.005, 2, 0.1),
      }),
    ),
    text: clipped(400),
    variable: z.preprocess(
      v => (typeof v === 'string' && (LAYER_VARIABLES as readonly string[]).includes(v) ? v : undefined),
      z.string().optional(),
    ),
    template: z.preprocess(v => (['name', 'year', 'chapter'].includes(String(v)) ? v : 'name'), z.enum(['name', 'year', 'chapter'])),
    fields: z.preprocess(
      value => (value && typeof value === 'object' ? value : {}),
      z.object({
        title: clipped(60),
        sub: clipped(60),
        meta: clipped(60),
        years: clipped(60),
      }),
    ),
    style: z.preprocess(value => (value && typeof value === 'object' ? value : {}), z.record(z.string(), z.unknown())),
  }).nullable(),
)

const compositionSchema = z.preprocess(
  value => (value && typeof value === 'object' ? value : null),
  z.object({
    id: clipped(48),
    approach: clipped(80),
    rationale: clipped(600),
    recommended: z.preprocess(v => v === true, z.boolean()),
    assets: z.preprocess(value => (Array.isArray(value) ? value.slice(0, QWEN_MAX_REFS) : []), z.array(assetSchema)),
    image_prompt: clipped(2000),
    text_description: clipped(1000),
    copy: copySchema,
    /** 原样保留，解析后由 `shapeStoredLayerPlan` 归一：新形状 = {text_layout, items}，旧形状 = label/card 数组 */
    layer_plan: z.unknown(),
  }).nullable(),
)

const conceptSchema = z.object({
  theme: clipped(300),
  theme_reason: clipped(600),
  compositions: z.preprocess(value => (Array.isArray(value) ? value : []), z.array(compositionSchema)),
})

export interface PosterCopy {
  title: string
  subtitle: string
  era: string
  place: string
  notes: string[]
}

export interface PosterAssetSnapshot {
  kind: 'character' | 'scene' | 'prop'
  id: number
  name: string
  role_in_poster: string
  reason: string
  path: string
  version_task_id: number | null
}

/**
 * 旧版 layer_plan 条目（Issue #72）：label/card + 模型坐标与样式。
 * 只用于读取旧构想，Issue #96 起不再生成、不迁移。
 */
export interface PosterLayerPlanItem {
  type: 'label' | 'card'
  name: string
  box: { x: number; y: number; w: number; h: number }
  text: string
  variable?: LayerVariable
  template: 'name' | 'year' | 'chapter'
  fields: { title: string; sub: string; meta: string; years: string }
  style: Record<string, unknown>
}

/** 构想里的模板文本框条目：只选类型、填字段，位置与样式由规范决定。 */
export interface PosterTextPlanItem {
  /** poster_project / poster_title / poster_details（结构校验在 `normalizePosterLayerPlan`） */
  role: string
  fields: Record<string, string | string[]>
}

/** 新版 layer_plan：一套 Poster 版式 + 每个 Poster 专用类型一条。 */
export interface PosterLayerPlan {
  text_layout: string
  items: PosterTextPlanItem[]
}

/** DB 里可能出现的两种形状：新对象，或旧构想里的 label/card 数组（原样保留以便显示）。 */
export type PosterStoredLayerPlan = PosterLayerPlan | PosterLayerPlanItem[]

export interface PosterComposition {
  id: string
  approach: string
  rationale: string
  recommended: boolean
  assets: PosterAssetSnapshot[]
  image_prompt: string
  text_description: string
  copy: PosterCopy
  layer_plan: PosterStoredLayerPlan
}

export interface PosterConcept {
  version: number
  theme: string
  theme_reason: string
  compositions: PosterComposition[]
  selected_composition_id: string | null
  model: string
  config_id: number | null
  generated_at: string
  script_segments_used: number
}

export interface PosterConceptAsset {
  kind: 'character' | 'scene' | 'prop'
  id: number
  name: string
  description: string
  path: string
  version_task_id: number | null
  has_image: boolean
}

// ─── 纯函数 ────────────────────────────────────────────────────────

/**
 * AI 改写稿可能保留“原始材料/永久链接/原作者/许可/说明”出处块（`说明：` 明确声明不作朗读稿）。
 * 只在首行以 `原始材料：` 开头时剔除到 `说明：` 行为止，然后从第一个 `【` 起保留正文；
 * 不用通用正则删 URL/许可字样，避免误删正文。
 */
export function stripProvenanceBlock(script: string | null | undefined): string {
  const raw = String(script || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return ''
  const lines = raw.split('\n')
  const first = lines.findIndex(line => line.trim())
  if (first < 0) return ''
  if (!/^原始材料\s*[：:]/.test(lines[first].trim())) return raw
  let cut = -1
  for (let i = first; i < lines.length; i++) {
    if (/^说明\s*[：:]/.test(lines[i].trim())) { cut = i; break }
  }
  if (cut < 0) return raw
  const body = lines.slice(cut + 1).join('\n').trim()
  const start = body.indexOf('【')
  return start >= 0 ? body.slice(start).trim() : body
}

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象')
  return JSON.parse(text.slice(start, end + 1))
}

function assetKey(kind: string, id: number): string {
  return `${kind}:${id}`
}

/** 资产引用校验：只能选本集有图的资产；同名不得同时进入参考集；prompt 必须 @ 到每个被选资产。 */
export function validateComposition(
  raw: PosterComposition,
  assets: PosterConceptAsset[],
): { errors: string[]; composition: PosterComposition | null } {
  const byKey = new Map(assets.map(asset => [assetKey(asset.kind, asset.id), asset]))
  const errors: string[] = []
  const seenNames = new Set<string>()
  const selected: PosterAssetSnapshot[] = []
  for (const item of raw.assets) {
    const asset = byKey.get(assetKey(item.kind, item.id))
    if (!asset) { errors.push(`资产「${item.name || item.kind + '#' + item.id}」不属于本集`); continue }
    if (!asset.has_image) { errors.push(`资产「${asset.name}」没有可用图片，不能作为参考图`); continue }
    if (seenNames.has(asset.name)) { errors.push(`同名资产「${asset.name}」不能同时进入参考集`); continue }
    seenNames.add(asset.name)
    selected.push({
      kind: asset.kind,
      id: asset.id,
      name: asset.name,
      role_in_poster: item.role_in_poster,
      reason: item.reason,
      path: asset.path,
      version_task_id: asset.version_task_id,
    })
  }
  if (!selected.length) errors.push('至少要选择一只有图的资产')
  const names = selected.map(item => item.name)
  const mentions = parseMentions(raw.image_prompt, names)
  for (const unknown of mentions.unknown) errors.push(`画面 prompt 引用了未选中的资产「@${unknown}」`)
  for (const name of names) {
    if (!mentions.matched.includes(name)) errors.push(`画面 prompt 没有用 @${name} 引用所选资产`)
  }
  return {
    errors,
    composition: errors.length ? null : { ...raw, assets: selected },
  }
}

// ─── 模板文本框规划（Issue #96） ───────────────────────────────────

/** Poster 成片尺寸与画幅家族：与关键帧同档位（16:9 → 1344×768，9:16 → 768×1344）。 */
export interface PosterFrame {
  key: string
  width: number
  height: number
  family: TextFamily
}

export function posterFrameOf(aspectRatio: unknown): PosterFrame {
  const key = String(aspectRatio || '16:9').trim()
  const [parsedWidth, parsedHeight] = String(KEYFRAME_SIZES[key] || KEYFRAME_SIZES['16:9']!).split('x').map(Number)
  const width = parsedWidth || 1344
  const height = parsedHeight || 768
  return { key, width, height, family: textFamilyOf(width, height) }
}

/** 构想文字层的上下文：项目变量 + 集号行（`poster_project` 由系统覆盖，模型只负责容量与套）。 */
export interface PosterTextContext {
  variables: PosterVariables
  /** 集号行：`第1集 · 漕运兴衰`（`posterEpisodeLabel`） */
  episodeLabel: string
  /** 集号行的兜底：`第1集`（`posterEpisodeNumberLabel`），槽位放不下整行时用它 */
  episodeLabelShort?: string
}

export interface PosterPlanContext extends PosterTextContext {
  family: TextFamily
  /** 容量口径的成片尺寸；缺省用该家族的 Poster 规范尺寸 */
  size?: { width: number; height: number }
}

/** 旧构想（label/card 数组）不迁移、不可应用：返回明确的重新生成提示。 */
export class PosterPlanLegacyError extends Error {
  constructor() {
    super('这套构想的文字图层是旧版格式（模型坐标/样式），已不再支持应用；请重新生成 Poster 构想')
    this.name = 'PosterPlanLegacyError'
  }
}

/** 新形状的 layer_plan；旧数组或缺失时返回 null。 */
export function posterLayerPlanOf(composition: PosterComposition | null): PosterLayerPlan | null {
  const plan = composition?.layer_plan
  if (!plan || Array.isArray(plan)) return null
  return plan
}

function cleanFieldValue(value: unknown): string {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  return raw.replace(/\r\n?/g, '\n').slice(0, TEXT_FIELD_MAX).trim()
}

/** 字段是否列表：规范任一样式里该字段的行为 list（与 layer-doc 的规范化同源）。 */
function posterFieldIsList(role: string, key: string): boolean {
  const def = TEXT_SPEC.roles[role]
  if (!def) return false
  return Object.values(def.styles).some(style => style.rows.some(row => row.field === key && row.type === 'list'))
}

function shapePlanFields(role: string, raw: unknown): Record<string, string | string[]> {
  const def = TEXT_SPEC.roles[role]
  if (!def) return {}
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const fields: Record<string, string | string[]> = {}
  for (const field of def.fields) {
    const value = source[field.key]
    if (posterFieldIsList(role, field.key)) {
      const items = (Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [])
        .map(cleanFieldValue)
        .filter(item => item !== '')
        .slice(0, TEXT_LIST_MAX)
      if (items.length) fields[field.key] = items
    } else {
      const text = cleanFieldValue(value)
      if (text) fields[field.key] = text
    }
  }
  return fields
}

function shapeTextPlanItem(raw: unknown): PosterTextPlanItem | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const role = typeof source.role === 'string' ? source.role.trim().slice(0, 40) : ''
  if (!role) return null
  return { role, fields: shapePlanFields(role, source.fields) }
}

/**
 * DB 里的 `layer_plan` → 两种形状之一：
 * - 数组 = 旧构想（label/card 条目，原样保留以便前端继续显示，不迁移）；
 * - 对象 = 新构想 `{text_layout, items}`（条目按规范字段白名单规范化）。
 * 缺失/非法一律按空数组处理：旧构想的显示与「不可应用」语义都靠数组形状判断。
 */
export function shapeStoredLayerPlan(raw: unknown): PosterStoredLayerPlan {
  if (Array.isArray(raw)) {
    const items: PosterLayerPlanItem[] = []
    for (const entry of raw) {
      const parsed = legacyPlanItemSchema.safeParse(entry)
      if (parsed.success && parsed.data) items.push(parsed.data as PosterLayerPlanItem)
    }
    return items
  }
  if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>
    // 不在这里截断：多出来的 role 要交给校验报告，落库的规划只会保留合法的三类
    const items = (Array.isArray(source.items) ? source.items : [])
      .map(shapeTextPlanItem)
      .filter((item): item is PosterTextPlanItem => Boolean(item))
    return {
      text_layout: typeof source.text_layout === 'string' ? source.text_layout.trim().slice(0, 40) : '',
      items,
    }
  }
  return []
}

/**
 * `poster_project` 由系统写死：main = 项目名（绑变量），sub = 集号行（`posterEpisodeLabel`）。
 * 集号行整行放不下该槽位时退到 `第N集`（规范要求的写法），再放不下就省略（该字段可选）。
 * 这样长集名不会让整次构想因为模型无法修改的字段而失败。
 */
export function posterProjectFields(
  ctx: PosterTextContext,
  layoutId?: string,
  size?: { width: number; height: number },
): Record<string, string> {
  const fields = { main: ctx.variables.project_title, sub: ctx.episodeLabel }
  if (!layoutId || !size) return fields
  const sub = textCapacity(layoutId, 'poster_project', size).find(cap => cap.field === 'sub')
  if (!sub) return fields
  if (Array.from(fields.sub).length <= sub.chars_per_line) return fields
  const short = ctx.episodeLabelShort || ''
  fields.sub = Array.from(short).length <= sub.chars_per_line ? short : ''
  return fields
}

/** 规划 → text 图层（每类一条，`ai:` 前缀固定 id；未知类型与重复条目丢弃，由调用方校验完整性）。 */
function planTextLayers(
  plan: PosterLayerPlan,
  ctx: PosterTextContext,
  size?: { width: number; height: number },
): Record<string, unknown>[] {
  const byRole: Record<string, PosterTextPlanItem> = {}
  for (const item of plan.items) {
    if (POSTER_ONLY_ROLES.indexOf(item.role) === -1) continue
    byRole[item.role] = item
  }
  const projectFields = posterProjectFields(ctx, plan.text_layout, size)
  const layers: Record<string, unknown>[] = []
  for (const role of POSTER_ONLY_ROLES) {
    const item = byRole[role]
    if (!item) continue
    const fields = role === 'poster_project' ? { ...item.fields, ...projectFields } : { ...item.fields }
    const layer: Record<string, unknown> = {
      id: `ai:${role}`,
      type: 'text',
      role,
      name: TEXT_SPEC.roles[role]?.name || role,
      visible: true,
      locked: false,
      z: layers.length,
      opacity: 1,
      rotation: 0,
      fields,
    }
    if (role === 'poster_project') layer.field_vars = { main: 'project_title' }
    layers.push(layer)
  }
  return layers
}

/**
 * 构想 → 文字图层（Issue #96）：只产 text 层，id 固定 `ai:poster_project|ai:poster_title|ai:poster_details`，
 * 重复应用原位替换；`poster_project.main` 绑 `project_title` 变量。旧形状抛 `PosterPlanLegacyError`。
 */
export function compositionToLayers(
  composition: PosterComposition,
  base: { width: number; height: number },
  ctx: PosterTextContext,
): Layer[] {
  const plan = posterLayerPlanOf(composition)
  if (!plan) throw new PosterPlanLegacyError()
  return normalizeLayerDoc({
    base: { ...base, path: '' },
    theme: 'archival',
    text_layout: plan.text_layout,
    layers: planTextLayers(plan, ctx, base),
  }).layers
}

/** 纠正提示里的容量文案：必须给出具体字数，模型才知道改到哪里。 */
function capacityNote(layoutId: string, role: string, field: string | undefined, size: { width: number; height: number }): string {
  if (!role) return ''
  const caps = textCapacity(layoutId, role, size)
  const cap = caps.find(item => item.field === field) || caps.find(item => item.field === 'main') || caps[0]
  if (!cap) return ''
  const base = cap.kind === 'list'
    ? `最多 ${cap.max_items} 条、每条 ${cap.chars_per_line} 字×${cap.max_lines} 行`
    : `${cap.chars_per_line} 字×${cap.max_lines} 行（共 ${cap.max_chars} 字）`
  const fallback = cap.chars_per_line_at_min > cap.chars_per_line ? `；缩到下限每行 ${cap.chars_per_line_at_min} 字只是兜底` : ''
  return `（${role}.${cap.field}「${cap.label}」基准容量：${base}${fallback}）`
}

export interface PosterLayerPlanCheck {
  plan: PosterLayerPlan | null
  errors: string[]
  problems: TextProblem[]
}

/**
 * 校验并规范化模型输出的 `layer_plan`（Issue #96）。阻断问题连同该套该槽位的基准容量一起返回，
 * 供「同一任务内纠正一次」的反馈；仍不合格则任务失败并保留模型原文。
 */
export function normalizePosterLayerPlan(raw: unknown, ctx: PosterPlanContext): PosterLayerPlanCheck {
  const shaped = shapeStoredLayerPlan(raw)
  if (Array.isArray(shaped)) {
    return {
      plan: null,
      errors: ['layer_plan 必须是 {"text_layout": 套 id, "items":[{"role":"poster_project|poster_title|poster_details","fields":{...}}]}；旧版坐标/样式格式不再接受'],
      problems: [],
    }
  }
  const errors: string[] = []
  const located = textLayoutById(shaped.text_layout)
  if (!shaped.text_layout) errors.push('layer_plan.text_layout 必填：从给出的 Poster 套里选一个')
  else if (!located) errors.push(`未知的版式套「${shaped.text_layout}」`)
  else if (located.medium !== 'poster') errors.push(`「${located.layout.name}」是图层段（视频）套，Poster 只能用给出的 Poster 套`)
  else if (located.family !== ctx.family) errors.push(`版式套「${located.layout.name}」属于 ${located.family} 规范，当前项目画幅是 ${ctx.family}，请换套`)
  const size = ctx.size
    || (located ? TEXT_CANONICAL_SIZES[located.key] : TEXT_CANONICAL_SIZES[`${ctx.family}/poster`])
  const items: PosterTextPlanItem[] = []
  const seen = new Set<string>()
  for (const item of shaped.items) {
    if (POSTER_ONLY_ROLES.indexOf(item.role) === -1) {
      errors.push(`items 只允许 ${POSTER_ONLY_ROLES.join(' / ')}；收到「${item.role}」`)
      continue
    }
    if (seen.has(item.role)) {
      errors.push(`role「${item.role}」只能出现一次`)
      continue
    }
    seen.add(item.role)
    items.push(item)
  }
  for (const role of POSTER_ONLY_ROLES) {
    if (!seen.has(role)) errors.push(`items 缺少 role「${role}」（${TEXT_SPEC.roles[role]?.name || role}），三类必须各一条`)
  }
  if (errors.length) return { plan: null, errors, problems: [] }
  const projectFields = posterProjectFields(ctx, shaped.text_layout, size)
  const plan: PosterLayerPlan = {
    text_layout: shaped.text_layout,
    items: items.map(item => (item.role === 'poster_project'
      ? { role: item.role, fields: { ...item.fields, ...projectFields } }
      : item)),
  }
  const doc = normalizeLayerDoc({
    base: { ...size, path: '' },
    theme: 'archival',
    text_layout: plan.text_layout,
    layers: planTextLayers(plan, ctx, size),
  })
  const problems = textLayerProblems(doc, size, { variables: ctx.variables })
  const blocking = problems.filter(problem => problem.level === 'error')
  for (const problem of blocking) {
    const layer = doc.layers.find(item => item.id === problem.layer_id)
    const role = layer && layer.type === 'text' ? layer.role : ''
    errors.push(`${problem.message}${capacityNote(plan.text_layout, role, problem.field, size)}`)
  }
  return { plan: errors.length ? null : plan, errors, problems }
}

export function parsePosterConcept(raw: unknown): PosterConcept | null {
  const source = parseJsonObject(raw)
  if (!source || !Array.isArray(source.compositions)) return null
  const compositions: PosterComposition[] = []
  for (const item of source.compositions) {
    const parsed = compositionSchema.safeParse(item)
    if (parsed.success && parsed.data) {
      // 旧构想（label/card 数组）原样保留以便继续显示；新构想归一为 {text_layout, items}
      compositions.push({ ...parsed.data, layer_plan: shapeStoredLayerPlan(parsed.data.layer_plan) } as PosterComposition)
    }
  }
  if (!compositions.length) return null
  return {
    version: POSTER_CONCEPT_VERSION,
    theme: String(source.theme || ''),
    theme_reason: String(source.theme_reason || ''),
    compositions,
    selected_composition_id: typeof source.selected_composition_id === 'string' ? source.selected_composition_id : null,
    model: String(source.model || ''),
    config_id: Number.isInteger(source.config_id) ? Number(source.config_id) : null,
    generated_at: String(source.generated_at || ''),
    script_segments_used: Number(source.script_segments_used) || 0,
  }
}

export function compositionOf(concept: PosterConcept | null, compositionId: unknown): PosterComposition | null {
  if (!concept) return null
  const id = String(compositionId || '')
  return concept.compositions.find(item => item.id === id) || null
}

// ─── 输入装载 ──────────────────────────────────────────────────────

async function loadConceptAssets(episodeId: number): Promise<PosterConceptAsset[]> {
  const entries = await loadEpisodeAssets(episodeId)
  const links = await db.select().from(schema.episodeCharacters)
  const chars = await db.select().from(schema.characters)
  const scenes = await db.select().from(schema.scenes)
  const props = await db.select().from(schema.props)
  const charById = new Map(chars.map(row => [row.id, row]))
  const sceneById = new Map(scenes.map(row => [row.id, row]))
  const propById = new Map(props.map(row => [row.id, row]))
  const styling = new Map(links.map(link => [link.characterId, parseStylingVersion(link.stylingVersion)]))

  const tasks = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'image'),
    eq(schema.sysTask.status, 'completed'),
  ))
  const versionOf = (kind: string, id: number, image: string): number | null => {
    const matching = tasks.filter(task => task.localPath === image && (
      kind === 'character' ? task.characterId === id : kind === 'scene' ? task.sceneId === id : task.propId === id
    ))
    return matching.length ? Math.max(...matching.map(task => task.id)) : null
  }

  return entries.map(entry => {
    let description = ''
    if (entry.kind === 'character') {
      const row = charById.get(entry.id)
      const version = styling.get(entry.id)
      description = [
        row?.role && `角色：${row.role}`,
        row?.description && `描述：${row.description}`,
        row?.appearance && `外貌：${row.appearance}`,
        row?.styling && `造型：${row.styling}`,
        row?.finalPrompt && `造型提示词：${row.finalPrompt}`,
        version?.name && `本集造型：${version.name}`,
        version?.description && `本集造型描述：${version.description}`,
      ].filter(Boolean).join('\n')
    } else if (entry.kind === 'scene') {
      const row = sceneById.get(entry.id)
      description = [
        `地点：${row?.location || entry.name}`,
        row?.time && `时间：${row.time}`,
        row?.lighting && `光线：${row.lighting}`,
        row?.prompt && `场景描述：${row.prompt}`,
        row?.finalPrompt && `场景提示词：${row.finalPrompt}`,
        row?.exposition ? '（背景信息载体）' : '',
      ].filter(Boolean).join('\n')
    } else {
      const row = propById.get(entry.id)
      description = [
        row?.type && `类型：${row.type}`,
        row?.description && `描述：${row.description}`,
        row?.prompt && `道具描述：${row.prompt}`,
        row?.finalPrompt && `道具提示词：${row.finalPrompt}`,
        row?.faithful ? '（证据素材/原件）' : '',
        row?.exposition ? '（背景信息载体）' : '',
      ].filter(Boolean).join('\n')
    }
    return {
      kind: entry.kind,
      id: entry.id,
      name: entry.name,
      description: description.slice(0, 1600),
      path: entry.defaultImage,
      has_image: Boolean(entry.defaultImage),
      version_task_id: entry.defaultImage ? versionOf(entry.kind, entry.id, entry.defaultImage) : null,
    }
  })
}

function assetLines(assets: PosterConceptAsset[]): string {
  return assets.map(asset => {
    const head = `- ${asset.name}（${KIND_LABEL[asset.kind]} #${asset.id}${asset.has_image ? '' : ' · 无图，不能作参考'}）`
    return asset.description ? `${head}\n${asset.description}` : head
  }).join('\n')
}

/** Poster 套的选取建议（只描述主体位置，容量数字一律来自引擎）。 */
const POSTER_LAYOUT_GUIDANCE: Record<string, string> = {
  'p-vertical-left': '主体在画面中轴或右侧、左侧留白时选；栏目、片名、档案信息都落在左侧',
  'p-vertical-right': '主体在左侧、右侧留白时选；栏目、片名、档案信息都落在右侧',
  'p-vertical-top': '顶部没有人物或器物主体、上方连续留空时选；档案信息走左下',
  'p-vertical-bottom': '上方连续留空、下部没有关键主体时选；档案信息走下部',
  'p-landscape-left': '主体或纵深线在右侧、左侧留空时选',
  'p-landscape-right': '主体在左侧、右下没有时长角标时选',
  'p-landscape-bottom': '主体在中轴偏上、左下留空时选；档案信息收窄放在左下',
  'p-landscape-top': '主体在下方、顶部天空留空时选；档案信息走左下',
}

/** 三类 Poster 专用文本框的用途与字段（直接读规范，不写死文案）。 */
export function posterTextRolesPrompt(): string[] {
  return POSTER_ONLY_ROLES.map(role => {
    const def = TEXT_SPEC.roles[role]
    if (!def) return `- ${role}`
    const fields = def.fields.map(field => `${field.key}（${field.label}${field.optional ? '，可选' : '，必填'}）`).join('、')
    return `- ${role} ${def.name}：${def.purpose} 写作要求：${def.extract} 字段：${fields}`
  })
}

/** 一个画幅家族的 Poster 套与按槽位容量（每个数字都来自 `textCapacity`）。 */
export function posterTextLayoutsPrompt(family: TextFamily, size: { width: number; height: number }): string[] {
  const lines: string[] = []
  for (const layout of textLayoutsFor(family, 'poster')) {
    lines.push(`- ${layout.id}「${layout.name}」：${POSTER_LAYOUT_GUIDANCE[layout.id] || layout.name}`)
    for (const role of POSTER_ONLY_ROLES) {
      const caps = textCapacity(layout.id, role, size)
      if (!caps.length) continue
      const parts = caps.map(cap => {
        const atMin = cap.chars_per_line_at_min > cap.chars_per_line ? `（缩到下限 ${cap.chars_per_line_at_min} 字/行只是兜底）` : ''
        return cap.kind === 'list'
          ? `${cap.field}「${cap.label}」最多 ${cap.max_items} 条，每条 ${cap.chars_per_line} 字×${cap.max_lines} 行${atMin}`
          : `${cap.field}「${cap.label}」${cap.chars_per_line} 字×${cap.max_lines} 行${atMin}`
      })
      lines.push(`  - ${role}：${parts.join('；')}`)
    }
  }
  return lines
}

/** 系统提示词里的文字图层段落：类型、套、按槽位容量与写作规则。 */
export function posterTextPrompt(frame: PosterFrame): string[] {
  return [
    '# 文字：模板文本框（只写 layer_plan，不写坐标、字体、字号、颜色、底板）',
    '海报文字只有三类 Poster 专用模板文本框；位置、字号、断行、底板与缩小全部由设计规范按所选「套」决定。',
    ...posterTextRolesPrompt(),
    '',
    `# Poster 套（${frame.family === '16:9' ? '横版' : '竖版'}规范 · 成片 ${frame.width}×${frame.height}；text_layout 必须选其中一个，按底图主体位置选）`,
    ...posterTextLayoutsPrompt(frame.family, frame),
    '',
    '文字硬规则（系统会用引擎逐条校验，不合格会退回重写）：',
    '- poster_project：main 原样照抄输入的项目名（服务端会绑定项目变量），sub 原样照抄输入的集号行；不写营销语。',
    '- poster_title：本集唯一的主叙事钩子，全图最大字；按语义短语断行（fields.main 可写 \\n），不得切开词组；不得复现项目名中连续 4 个字以上。',
    '- poster_details：subtitle、era、place、items 四个字段都必须填；items 三条同级、可核实、语法平行；年代与地点只写剧本里有依据的内容，不编造（没有确切年代就写可核实的时段，如「清康熙年间」）。',
    '- 超出容量时按顺序处理：改短 → 换更宽的套 → 减少要点；自动缩小只是兜底，不当作常规容量。',
    '- 同一拍三类文字不得互相重复（连续 6 个字相同即重复）；copy 里的主标题/副标题/年代/地点/要点必须与 layer_plan 中的文字完全相同，不要写两套。',
  ]
}

function systemPrompt(lang: string, textPlanLines: string[]): string {
  const language = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }[lang] || '中文'
  return [
    '你是一名纪录片/剧情片海报美术指导。只输出一个 JSON 对象，不要 Markdown、不要解释。',
    `除 image_prompt 固定用中文外，其余文字用${language}。`,
    '任务：从本集剧本提炼中心思想，并从本集资产里选出最贴近中心思想、且**有图**的场景/道具/人物，构思三套有实质差异的海报构图。',
    '三套方案必须覆盖不同角度，例如：多时代蒙太奇/时间轴式拼接；重点场景 + 多人物群像与姿态；关键物件特写 + 人物/场景。示例不是固定模板。',
    ...textPlanLines,
    '',
    'JSON 结构：',
    '{"theme":"中心思想一句话","theme_reason":"依据","compositions":[{"id":"c1","approach":"构图角度","rationale":"为什么","recommended":true,"assets":[{"kind":"scene|character|prop","id":数字,"name":"资产名","role_in_poster":"在画面里承担什么","reason":"选择理由"}],"image_prompt":"中文画面提示词","text_description":"排版/文字描述","copy":{"title":"主标题","subtitle":"副标题","era":"年代","place":"地点","notes":["关键标注"]},"layer_plan":{"text_layout":"从上面给出的 Poster 套 id 里选一个","items":[{"role":"poster_project","fields":{"main":"项目名","sub":"第1集 · 集名"}},{"role":"poster_title","fields":{"main":"本集主标题"}},{"role":"poster_details","fields":{"subtitle":"副标题","era":"年代","place":"地点","items":["要点一","要点二","要点三"]}}]}}]}',
    '硬规则：',
    '1. compositions 必须是三个；recommended 只能有一个为 true。',
    '2. assets 只能从输入的「本集资产」里按 kind + id 选择，且必须有图；不要选没有图的资产。',
    '3. image_prompt 必须逐个用 @资产名 引用所选资产（名字逐字照抄）；不得引用未选资产；不得虚构资产未描述的外形、衣着、颜色。姿态、相对位置、构图、光线、时代氛围可以写。',
    '4. **image_prompt 不得包含任何文字/字母/标语/标题**：底图不带字。文字描述 text_description 与海报文案 copy 只用于图层与二次生成，不能进入 image_prompt。',
    '5. layer_plan 只写 {"text_layout":套 id,"items":[...]}：items 恰好三条，poster_project / poster_title / poster_details 各一条；不输出 box/坐标/字体/字号/颜色/style/template/variable，也不产出图片层或几何层。',
    '6. 蒙太奇/多节点组合是允许且鼓励的；每个方案都要说明它如何表现本集重心。',
    '7. 不要输出与资产无关的泛泛描述：prompt 必须落到具体场景、人物、道具。',
  ].join('\n')
}

function conceptUserPrompt(args: {
  drama: string
  episode: string
  episodeNo: string
  episodeLabel: string
  projectType: string
  style: string
  aspect: string
  frame: PosterFrame
  script: string
  assets: PosterConceptAsset[]
  summarized: boolean
}): string {
  return [
    `# 项目\n${args.drama}（${args.projectType === 'documentary' ? '纪录片' : '剧情片'} · 画幅 ${args.aspect} · Poster 成片 ${args.frame.width}×${args.frame.height}）`,
    args.style ? `项目风格词：${args.style}` : '',
    `项目名（poster_project.main 原样照抄）：${args.drama}`,
    '',
    `# 本集\n${args.episodeNo} ${args.episode}`,
    `集号（poster_project.sub 原样照抄）：${args.episodeLabel}`,
    '',
    '# 剧本（AI 改写/拆分稿）',
    args.script,
    '',
    args.summarized ? '（剧本过长，已按段落分批提炼；以上是覆盖全篇的中心思想与关键节点摘要）' : '',
    '',
    `# 本集资产（只能从这里选择，共 ${args.assets.length} 项）`,
    assetLines(args.assets),
    '',
    '请输出 JSON。',
  ].filter(line => line !== '').join('\n')
}

function summarizeChunksPrompt(chunks: string[], lang: string): string {
  const language = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }[lang] || '中文'
  return [
    `你是纪录片资料整理助手。下面是一部片子按顺序切分的 ${chunks.length} 段剧本。`,
    '请逐段提炼：本段中心思想、关键历史节点、具体人物/地点/年代、可用于海报的视觉母题。',
    `用${language}输出纯文本，按「第 N 段」分段；保留专名与年份的原写法，不要编造。`,
    ...chunks.map((chunk, index) => `\n第 ${index + 1} 段：\n${chunk}`),
  ].join('\n')
}

async function summarizeLongScript(
  script: string,
  stage: StageModel,
  lang: string,
  progress: (done: number, total: number) => Promise<void>,
): Promise<{ text: string; chunks: number }> {
  const paragraphs = script.split(/\n{2,}/)
  const chunks: string[] = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > SCRIPT_CHUNK_CHARS) {
      chunks.push(buffer)
      buffer = ''
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
  }
  if (buffer) chunks.push(buffer)
  const parts: string[] = []
  for (let index = 0; index < chunks.length; index++) {
    const { text } = await callTextChat(stage, `第 ${index + 1} 段：\n${chunks[index]}`, {
      systemPrompt: summarizeChunksPrompt([], lang),
      temperature: 0.2,
      maxTokens: CONCEPT_MAX_TOKENS,
      timeoutMs: CONCEPT_TIMEOUT_MS,
    })
    parts.push(`第 ${index + 1} 段摘要：\n${text}`)
    await progress(index + 1, chunks.length + 1)
    logTaskProgress('PosterConcept', 'chunk', { index: index + 1, total: chunks.length })
  }
  return { text: parts.join('\n\n'), chunks: chunks.length }
}

/** 模型输出两次都不会用：任务失败时保留原文，便于排查（存进文本任务 params.output_text）。 */
class PosterConceptOutputError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message)
    this.name = 'PosterConceptOutputError'
  }
}

async function callConcept(args: {
  stage: StageModel
  lang: string
  userPrompt: string
  textPlanLines: string[]
  /** 解析后的结构 + 文字图层校验；返回阻断问题（空数组 = 通过） */
  validate: (concept: PosterConcept) => string[]
  onFirstResponse: () => void
}): Promise<PosterConcept> {
  const system = systemPrompt(args.lang, args.textPlanLines)
  const first = await callTextChat(args.stage, args.userPrompt, {
    systemPrompt: system,
    temperature: 0.4,
    maxTokens: CONCEPT_MAX_TOKENS,
    timeoutMs: CONCEPT_TIMEOUT_MS,
  })
  args.onFirstResponse()
  let reply = first.text
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = conceptSchema.safeParse(extractJsonObject(reply))
      if (!parsed.success) throw new Error(`JSON 结构不符：${parsed.error.issues.slice(0, 6).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}`)
      const concept = {
        ...parsed.data,
        compositions: parsed.data.compositions.map(item => (item
          ? { ...item, layer_plan: shapeStoredLayerPlan(item.layer_plan) }
          : item)),
      } as PosterConcept
      const problems = args.validate(concept)
      if (problems.length) throw new Error(`文字图层规划不合格：${problems.slice(0, 8).join('；')}`)
      return concept
    } catch (err) {
      if (attempt === 1) throw new PosterConceptOutputError(err instanceof Error ? err.message : String(err), reply)
      const message = err instanceof Error ? err.message : String(err)
      reply = (await callTextChat(args.stage, [
        '# 上一次输出（需要修正）',
        reply.slice(0, 8000),
        '',
        '# 问题',
        message,
        '',
        '请只输出修正后的完整 JSON，结构必须与要求一致。',
      ].join('\n'), {
        systemPrompt: system,
        temperature: 0.2,
        maxTokens: CONCEPT_MAX_TOKENS,
        timeoutMs: CONCEPT_TIMEOUT_MS,
      })).text
    }
  }
  throw new PosterConceptOutputError('Poster 构想没有产出合法 JSON', reply)
}

// ─── 任务入口 ──────────────────────────────────────────────────────

export interface StartPosterConceptResult {
  started: boolean
  reason?: 'running' | 'empty_script'
  task_id?: number
}

export async function startPosterConcept(
  episodeId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<StartPosterConceptResult> {
  const context = await loadPosterContext(episodeId)
  const poster = await ensurePosterRow(context)
  if (await findActiveTextTask(episodeId, 'poster_concept', opts.retryOf)) return { started: false, reason: 'running' }
  const script = stripProvenanceBlock(context.episode.scriptContent)
  if (!script) return { started: false, reason: 'empty_script' }
  const assets = await loadConceptAssets(episodeId)
  if (!assets.some(asset => asset.has_image)) return { started: false, reason: 'empty_script' }

  const stage = await resolveStageModel('poster_concept', opts)
  const taskId = await createTextTask({
    kind: 'poster_concept',
    episodeId,
    dramaId: context.drama.id,
    prompt: `Poster 构想：${context.episode.title}`,
    stageModel: stage,
    progress: { completed: 0, total: 1, failed: 0 },
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'poster_concept', args: { episodeId, opts } },
  })
  logTaskStart('PosterConcept', 'run', { episodeId, posterId: poster.id, model: stage.model })

  const lang = await getContentLanguage()
  void runWithTextTask(taskId, () => runPosterConcept({ taskId, episodeId, posterId: poster.id, context, script, assets, stage, lang }))
  return { started: true, task_id: taskId }
}

async function runPosterConcept(args: {
  taskId: number
  episodeId: number
  posterId: number
  context: PosterContext
  script: string
  assets: PosterConceptAsset[]
  stage: StageModel
  lang: string
}): Promise<void> {
  const progress = { completed: 0, total: 1, failed: 0 }
  let firstResponse = false
  try {
    const style = await getDramaStylePrompt(args.context.drama.id)
    let script = args.script
    let segments = 1
    if (script.length > SCRIPT_BUDGET_CHARS) {
      const summarized = await summarizeLongScript(script, args.stage, args.lang, async (done, total) => {
        firstResponse = true
        progress.total = total
        progress.completed = done
        await updateTextTaskProgress(args.taskId, { ...progress })
      })
      script = summarized.text
      segments = summarized.chunks + 1
    }
    const frame = posterFrameOf(args.context.drama.aspectRatio)
    const planContext: PosterPlanContext = {
      family: frame.family,
      size: { width: frame.width, height: frame.height },
      variables: posterVariablesOf(args.context),
      episodeLabel: posterEpisodeLabel(args.context.episode),
      episodeLabelShort: posterEpisodeNumberLabel(args.context.episode),
    }
    const userPrompt = conceptUserPrompt({
      drama: args.context.drama.title,
      episode: args.context.episode.title,
      episodeNo: `EP${String(args.context.episode.episodeNumber || 0).padStart(2, '0')}`,
      episodeLabel: planContext.episodeLabel,
      projectType: args.context.drama.projectType || 'drama',
      style,
      aspect: args.context.drama.aspectRatio || '16:9',
      frame,
      script,
      assets: args.assets,
      summarized: segments > 1,
    })
    const parsed = await callConcept({
      stage: args.stage,
      lang: args.lang,
      userPrompt,
      textPlanLines: posterTextPrompt(frame),
      validate: concept => {
        const problems: string[] = []
        for (const composition of concept.compositions) {
          if (!composition) continue
          const label = composition.id || composition.approach || '方案'
          const checked = normalizePosterLayerPlan(composition.layer_plan, planContext)
          problems.push(...checked.errors.map(error => `${label}：${error}`))
          // 项目名/集号由服务端写死，模型原文只用于容量判断，落库前统一覆盖
          if (checked.plan) composition.layer_plan = checked.plan
        }
        return problems
      },
      onFirstResponse: () => { firstResponse = true },
    })
    const compositions = parsed.compositions.filter((item): item is PosterComposition => Boolean(item)).slice(0, POSTER_CONCEPT_COUNT)
    const validated: PosterComposition[] = []
    const errors: string[] = []
    for (const composition of compositions) {
      const result = validateComposition(composition, args.assets)
      if (result.composition) validated.push(result.composition)
      else errors.push(`${composition.id || composition.approach}：${result.errors.join('；')}`)
    }
    if (validated.length !== POSTER_CONCEPT_COUNT) {
      throw new Error(`三个构图方案没有全部通过资产校验：${errors.join('；') || '模型返回的方案数量不足'}`)
    }
    // 推荐只能一个；模型没标时按第一个兜底，避免前端出现三个“推荐”
    const recommendedIndex = validated.findIndex(item => item.recommended)
    validated.forEach((item, index) => { item.recommended = index === (recommendedIndex < 0 ? 0 : recommendedIndex) })

    const concept: PosterConcept = {
      version: POSTER_CONCEPT_VERSION,
      theme: parsed.theme,
      theme_reason: parsed.theme_reason,
      compositions: validated,
      selected_composition_id: validated.find(item => item.recommended)?.id || validated[0].id,
      model: args.stage.model,
      config_id: args.stage.configId,
      generated_at: now(),
      script_segments_used: segments,
    }
    // 任务只写 concept；当前编辑字段由显式 apply 写入（provenance 保护）
    const [poster] = await db.select().from(schema.episodePosters).where(eq(schema.episodePosters.id, args.posterId))
    if (poster) {
      const provenance = normalizeProvenance(poster.provenance)
      await db.update(schema.episodePosters).set({
        concept: JSON.stringify(concept),
        conceptUpdatedAt: concept.generated_at,
        provenance: JSON.stringify({ ...provenance, concept: 'ai' }),
        updatedAt: now(),
      }).where(eq(schema.episodePosters.id, args.posterId))
    }
    await patchTextTaskParams(args.taskId, {
      concept_theme: concept.theme,
      concept_compositions: concept.compositions.map(item => ({ id: item.id, approach: item.approach, recommended: item.recommended })),
    })
    await finishTextTask(args.taskId, 'completed', {
      progress: { completed: progress.total, total: progress.total, failed: 0 },
      outputText: JSON.stringify(concept),
    })
    logTaskSuccess('PosterConcept', 'run', { episodeId: args.episodeId, compositions: concept.compositions.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishTextTask(args.taskId, 'failed', {
      errorMsg: `Poster 构想失败：${message}`,
      progress: { ...progress },
      // 两次输出都不合格：保留模型原文，便于从任务详情排查（Issue #96）
      ...(err instanceof PosterConceptOutputError && err.raw ? { outputText: err.raw } : {}),
    })
    await requeueFirstModelFailure(args.taskId, err, !firstResponse)
    logTaskError('PosterConcept', 'run', { episodeId: args.episodeId, error: message })
  }
}
