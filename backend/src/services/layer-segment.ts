/**
 * 图层段的唯一读写口（Issue #58，契约 §3.2；由 #50 的 `storyboard-clips.ts` 改造而来）。
 *
 * - 持久化：`storyboard_layer_segments`，**一镜至多一行**（库级 UNIQUE 兜底）。
 *   是否参与由 `storyboards.combo ∈ {A,C,D}` 决定：combo=B 时行保留但不参与，切回时原样恢复。
 * - 渲染签名：`layerSegmentSignatureOf()` = `'seg-v1'` + 图层文档（含 crop）+ 精确关键帧时间线
 *   + 时长 + 末尾停留（派生值）+ 底图/图片图层字节 sha + 画幅。去掉了 #50 的 position：
 *   一镜只有一个图层段，位置由 combo 决定。
 * - 草稿：把设计卡 `layer_plan` 与资产/语义标注装配成上下文，交给纯函数 `draftSegment()`。
 *
 * 图层段画幅 = 本集成片画幅（沿用 `probeIntroSpec` 的口径：按已有**模型视频**实测），
 * 帧率由时间线决定（默认 25）；两者都进签名，改了就要重渲染。
 * **绝不把图层段产物纳入规格探测**：否则会出现「渲染→合成→规格变→签名变→判过期」的回环。
 */
import fs from 'fs'
import crypto from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { probeVideoSpec } from './media-probe.js'
import { normalizeLayerDoc, type LayerDoc } from './layer-doc.js'
import {
  MAX_LAYER_SEGMENT_SECONDS,
  SEGMENT_DEFAULT_FPS,
  SEGMENT_MIN_VIEWPORT,
  clampSegmentDuration,
  endHoldOf,
  normalizeTimeline,
  type SegmentTimeline,
} from './segment-timeline.js'
import { draftSegment, type SegmentDraft, type SegmentDraftAsset, type SegmentDraftIssue } from './layer-segment-draft.js'
import { parseSemantics, resolveSemanticsBase } from './asset-semantics.js'
import {
  hasLayerSegment,
  parseDesignCard,
  toCombo,
  type BaseRef,
  type Combo,
  type DesignCard,
} from './design-card.js'

export const LAYER_SEGMENT_STATUSES = ['draft', 'rendering', 'ready', 'failed'] as const
export type LayerSegmentStatus = typeof LAYER_SEGMENT_STATUSES[number]

/** 迁移与运行期写入的过期原因（JSON 数组，可同时存在多条） */
export const SEGMENT_STALE_REASONS = {
  migratedMultiClip: 'migrated_multi_clip',
  baseRefUnresolved: 'base_ref_unresolved',
  comboMissing: 'combo_missing',
  baseChanged: 'base_version_changed',
} as const
export type SegmentStaleReason = typeof SEGMENT_STALE_REASONS[keyof typeof SEGMENT_STALE_REASONS]

export interface SegmentQualityWarning {
  frame_index: number
  t: number
  effective_w: number
  effective_h: number
  output_w: number
  output_h: number
}

export interface LayerSegment {
  id: number
  storyboard_id: number
  layer_doc: LayerDoc
  timeline: SegmentTimeline
  duration: number
  /** 派生只读：`duration − 末个精确关键帧 t`（契约 §3.2 裁决 1，不设列） */
  end_hold: number
  base_ref: BaseRef | null
  quality_warnings: SegmentQualityWarning[]
  render_path: string | null
  render_signature: string | null
  rendered_at: string | null
  junction_path: string | null
  junction_hash: string | null
  status: LayerSegmentStatus
  stale_reasons: string[]
  created_at: string
  updated_at: string
}

/**
 * 本集图层段规格：图层段必须与模型视频**同画幅同帧率**，否则拼接与最终 merge 会花屏/时基错乱。
 * 画幅与帧率都实测自本集首条已有**模型视频**（与 `probeIntroSpec` 同口径），
 * 本集还没有任何视频时才回落 25 fps + 按画幅比例的内置默认尺寸。
 * 因此 `timeline.fps` 是**派生值**（保存时同步写入），不是用户可选项。
 */
export interface SegmentSpec {
  width: number
  height: number
  fps: number
  /** 规格来源：`video` = 实测本集已有视频，`default` = 内置默认 */
  source: 'video' | 'default'
}

/** 本集还没有任何视频时的兜底画幅 */
const DEFAULT_SPEC_BY_ASPECT: Record<string, { width: number; height: number }> = {
  '16:9': { width: 960, height: 544 },
  '9:16': { width: 544, height: 960 },
  '1:1': { width: 768, height: 768 },
  '4:3': { width: 960, height: 720 },
}

type SegmentRow = typeof schema.storyboardLayerSegments.$inferSelect

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseWarnings(raw: string | null): SegmentQualityWarning[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const nums = ['frame_index', 't', 'effective_w', 'effective_h', 'output_w', 'output_h']
        .map(key => Number(row[key]))
      if (nums.some(value => !Number.isFinite(value))) return []
      return [{
        frame_index: nums[0], t: nums[1], effective_w: nums[2],
        effective_h: nums[3], output_w: nums[4], output_h: nums[5],
      }]
    })
  } catch {
    return []
  }
}

function parseBaseRef(raw: string | null): BaseRef | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Record<string, unknown>
    if (value.kind === 'inherit_prev') return { kind: 'inherit_prev' }
    if (value.kind === 'asset' && Number.isInteger(value.asset_id)) {
      const kind = value.asset_kind === 'character' || value.asset_kind === 'scene' ? value.asset_kind : 'prop'
      return {
        kind: 'asset',
        asset_kind: kind,
        asset_id: Number(value.asset_id),
        version_task_id: Number.isInteger(value.version_task_id) ? Number(value.version_task_id) : null,
      }
    }
  } catch { /* 坏 JSON 视为没有底图引用 */ }
  return null
}

function parseSegmentRow(row: SegmentRow): LayerSegment {
  let layerDoc: unknown = null
  let timeline: unknown = null
  try {
    layerDoc = JSON.parse(row.layerDoc)
  } catch {
    layerDoc = null
  }
  try {
    timeline = JSON.parse(row.timeline)
  } catch {
    timeline = null
  }
  const normalized = normalizeTimeline(timeline)
  return {
    id: row.id,
    storyboard_id: row.storyboardId,
    layer_doc: normalizeLayerDoc(layerDoc),
    timeline: normalized,
    duration: row.duration,
    end_hold: endHoldOf(normalized, row.duration),
    base_ref: parseBaseRef(row.baseRef),
    quality_warnings: parseWarnings(row.qualityWarnings),
    render_path: row.renderPath,
    render_signature: row.renderSignature,
    rendered_at: row.renderedAt,
    junction_path: row.junctionPath,
    junction_hash: row.junctionHash,
    status: (row.status as LayerSegmentStatus) || 'draft',
    stale_reasons: parseStringArray(row.staleReasons),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export async function getLayerSegment(storyboardId: number): Promise<LayerSegment | null> {
  const [row] = await db.select().from(schema.storyboardLayerSegments)
    .where(eq(schema.storyboardLayerSegments.storyboardId, storyboardId))
  return row ? parseSegmentRow(row) : null
}

/** 整集一次查完：合成状态与批量预览都要逐镜看段，不能每镜发一次查询 */
export async function segmentsByStoryboard(storyboardIds: number[]): Promise<Map<number, LayerSegment>> {
  const out = new Map<number, LayerSegment>()
  if (!storyboardIds.length) return out
  const rows = await db.select().from(schema.storyboardLayerSegments)
    .where(inArray(schema.storyboardLayerSegments.storyboardId, storyboardIds))
  for (const row of rows) {
    const segment = parseSegmentRow(row)
    out.set(segment.storyboard_id, segment)
  }
  return out
}

export async function listEpisodeLayerSegments(episodeId: number): Promise<LayerSegment[]> {
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
  return [...(await segmentsByStoryboard(rows.map(row => row.id))).values()]
}

export interface LayerSegmentWriteInput {
  layer_doc?: unknown
  timeline?: unknown
  duration?: number
  base_ref?: BaseRef | null
}

/**
 * 写入（新建或整体替换）本镜的图层段。改动图层/时间线/时长都会让已渲染的成品过期：
 * 这里只保留 `render_path`（界面还能播旧的），`render_signature` 不动——
 * 新鲜度一律由 `layerSegmentIsFresh()` 现算，不靠状态位记账。
 *
 * 保存时同时算两件契约要求的事实：
 * - `quality_warnings`：逐精确关键帧「取景有效像素 < 输出分辨率」（契约 §3.2）；
 * - `base_ref`：底图引用（设计卡 `layer_plan.base`），资产版本变了就能靠它判过期。
 */
export async function saveLayerSegment(
  storyboardId: number,
  input: LayerSegmentWriteInput,
): Promise<LayerSegment> {
  const existing = await getLayerSegment(storyboardId)
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!row) throw new Error('分镜不存在')
  const layerDoc = await withBaseSourceSize(normalizeLayerDoc('layer_doc' in input ? input.layer_doc : existing?.layer_doc))
  // fps 是派生值：始终跟随本集成片规格，用户在时间线里改不了
  const spec = await resolveEpisodeSegmentSpec(row.episodeId)
  const timeline = normalizeTimeline({
    ...normalizeTimeline('timeline' in input ? input.timeline : existing?.timeline),
    fps: spec.fps,
  })
  const duration = clampSegmentDuration(
    input.duration !== undefined ? Number(input.duration) : (existing?.duration ?? 0),
    MAX_LAYER_SEGMENT_SECONDS,
  )
  const baseRef = 'base_ref' in input ? input.base_ref ?? null : existing?.base_ref ?? null
  const warnings = await qualityWarningsOf(layerDoc, timeline, { width: spec.width, height: spec.height })
  const ts = now()
  if (existing) {
    // 输入变了：旧渲染的签名自然对不上，不需要在这里改 render_signature（新鲜度为读时现算）
    await db.update(schema.storyboardLayerSegments).set({
      layerDoc: JSON.stringify(layerDoc),
      timeline: JSON.stringify(timeline),
      duration,
      baseRef: baseRef ? JSON.stringify(baseRef) : null,
      qualityWarnings: JSON.stringify(warnings),
      updatedAt: ts,
    }).where(eq(schema.storyboardLayerSegments.id, existing.id))
    return {
      ...existing,
      layer_doc: layerDoc,
      timeline,
      duration,
      end_hold: endHoldOf(timeline, duration),
      base_ref: baseRef,
      quality_warnings: warnings,
      updated_at: ts,
    }
  }
  const result = await db.insert(schema.storyboardLayerSegments).values({
    storyboardId,
    layerDoc: JSON.stringify(layerDoc),
    timeline: JSON.stringify(timeline),
    duration,
    baseRef: baseRef ? JSON.stringify(baseRef) : null,
    qualityWarnings: JSON.stringify(warnings),
    status: 'draft',
    staleReasons: JSON.stringify([]),
    createdAt: ts,
    updatedAt: ts,
  })
  return {
    id: getInsertId(result),
    storyboard_id: storyboardId,
    layer_doc: layerDoc,
    timeline,
    duration,
    end_hold: endHoldOf(timeline, duration),
    base_ref: baseRef,
    quality_warnings: warnings,
    render_path: null,
    render_signature: null,
    rendered_at: null,
    junction_path: null,
    junction_hash: null,
    status: 'draft',
    stale_reasons: [],
    created_at: ts,
    updated_at: ts,
  }
}

export async function deleteLayerSegment(storyboardId: number): Promise<boolean> {
  const existing = await getLayerSegment(storyboardId)
  if (!existing) return false
  await db.delete(schema.storyboardLayerSegments)
    .where(eq(schema.storyboardLayerSegments.storyboardId, storyboardId))
  await db.update(schema.storyboards)
    .set({ keyframesJunctionHash: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
  return true
}

export async function markSegmentRendered(
  segmentId: number,
  patch: {
    render_path: string
    render_signature: string
    status: LayerSegmentStatus
    junction_path: string | null
    junction_hash: string | null
  },
): Promise<void> {
  await db.update(schema.storyboardLayerSegments).set({
    renderPath: patch.render_path,
    renderSignature: patch.render_signature,
    renderedAt: now(),
    junctionPath: patch.junction_path,
    junctionHash: patch.junction_hash,
    status: patch.status,
    updatedAt: now(),
  }).where(eq(schema.storyboardLayerSegments.id, segmentId))
}

export async function markSegmentStatus(segmentId: number, status: LayerSegmentStatus): Promise<void> {
  await db.update(schema.storyboardLayerSegments)
    .set({ status, updatedAt: now() })
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
}

/** 追加过期原因（去重）；重渲染不会清掉它们——它们记录的是「这一段的输入不再可信」 */
export async function addSegmentStaleReason(segmentId: number, reason: string): Promise<void> {
  const [row] = await db.select().from(schema.storyboardLayerSegments)
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
  if (!row) return
  const reasons = parseStringArray(row.staleReasons)
  if (reasons.includes(reason)) return
  await db.update(schema.storyboardLayerSegments)
    .set({ staleReasons: JSON.stringify([...reasons, reason]), updatedAt: now() })
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
}

export async function clearSegmentStaleReason(segmentId: number, reason: string): Promise<void> {
  const [row] = await db.select().from(schema.storyboardLayerSegments)
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
  if (!row) return
  const reasons = parseStringArray(row.staleReasons)
  if (!reasons.includes(reason)) return
  await db.update(schema.storyboardLayerSegments)
    .set({ staleReasons: JSON.stringify(reasons.filter(item => item !== reason)), updatedAt: now() })
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
}

// ─── 清晰度警告 ──────────────────────────────────────────────

/**
 * 逐精确关键帧的清晰度警告（契约 §3.2：R5 建列并在保存时计算）：
 * 「取景区有效像素 < 输出分辨率」就提示减小推近或换更清晰的底图。
 *
 * 底图真实像素优先读 `layer_doc.base.source_width/height`（R6 的裁切真源），
 * 没有就用 sharp 读文件真实像素（迁移来的老段没有这两个字段）。
 */
async function qualityWarningsOf(
  layerDoc: LayerDoc,
  timeline: SegmentTimeline,
  output: { width: number; height: number },
): Promise<SegmentQualityWarning[]> {
  if (!layerDoc.base.path) return []
  const source = layerDoc.base.source_width && layerDoc.base.source_height
    ? { width: layerDoc.base.source_width, height: layerDoc.base.source_height }
    : await probeImageSize(layerDoc.base.path)
  if (!source) return []
  const warnings: SegmentQualityWarning[] = []
  // 取景框 w/h 已按 normalizeViewport 对齐（正方形取景），但宽高各按自己的轴换算更稳妥
  timeline.keyframes.forEach((frame, index) => {
    const effectiveW = Math.round(source.width * viewportSpan(frame.viewport.w))
    const effectiveH = Math.round(source.height * viewportSpan(frame.viewport.h))
    if (effectiveW >= output.width && effectiveH >= output.height) return
    warnings.push({
      frame_index: index,
      t: frame.t,
      effective_w: effectiveW,
      effective_h: effectiveH,
      output_w: output.width,
      output_h: output.height,
    })
  })
  return warnings
}

/**
 * 取景框某一边相对画面的占比（归一化，钳进 [最小值, 1]）。
 * 注意不能用 `SEGMENT_MIN_VIEWPORT` 当上限来源：宽高各自钳制，宽幅取景时 h 可能小于 w。
 */
function viewportSpan(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1))
}

async function probeImageSize(relativePath: string): Promise<{ width: number; height: number } | null> {
  const abs = getAbsolutePath(relativePath)
  if (!fs.existsSync(abs)) return null
  try {
    const meta = await sharp(abs).metadata()
    if (!meta.width || !meta.height) return null
    return { width: meta.width, height: meta.height }
  } catch {
    return null
  }
}

/** 保存图层段时刷新「底图真实分辨率」：R6 的 `layer_doc.base.source_width/height` 是裁切真源 */
export async function withBaseSourceSize(layerDoc: LayerDoc): Promise<LayerDoc> {
  if (layerDoc.base.source_width && layerDoc.base.source_height) return layerDoc
  const size = await probeImageSize(layerDoc.base.path)
  if (!size) return layerDoc
  return { ...layerDoc, base: { ...layerDoc.base, source_width: size.width, source_height: size.height } }
}

// ─── 签名 ────────────────────────────────────────────────────

/** 文件内容 sha，按 路径+大小+mtime 缓存：一次合成状态刷新会对同一张底图问很多遍 */
const fileShaCache = new Map<string, string>()

export function fileSha256(relativePath: string): string {
  const abs = getAbsolutePath(relativePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return 'missing'
  }
  const key = `${abs}:${stat.size}:${stat.mtimeMs}`
  const cached = fileShaCache.get(key)
  if (cached) return cached
  const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  fileShaCache.set(key, sha)
  return sha
}

/** 图层段渲染签名（`'seg-v1'`）：输入任何一处变化（含底图文件本身被换掉）都要重渲染 */
export function layerSegmentSignatureOf(
  segment: Pick<LayerSegment, 'layer_doc' | 'timeline' | 'duration'>,
  spec: Pick<SegmentSpec, 'width' | 'height' | 'fps'>,
): string {
  const images = [segment.layer_doc.base.path]
  for (const layer of segment.layer_doc.layers) {
    if (layer.type === 'image') images.push(layer.src.path)
  }
  return crypto.createHash('sha256').update([
    'seg-v1',
    JSON.stringify(segment.layer_doc),
    JSON.stringify(segment.timeline),
    segment.duration.toFixed(3),
    endHoldOf(segment.timeline, segment.duration).toFixed(3),
    `${spec.width}x${spec.height}@${spec.fps}`,
    ...images.map(path => `${path}@${fileSha256(path)}`),
  ].join('\u0000'), 'utf8').digest('hex')
}

/** 已渲染的成品是否仍对得上当前输入（文件在 + 签名一致） */
export function layerSegmentIsFresh(segment: LayerSegment, spec: Pick<SegmentSpec, 'width' | 'height' | 'fps'>): boolean {
  if (!segment.render_path || !segment.render_signature) return false
  if (!fs.existsSync(getAbsolutePath(segment.render_path))) return false
  return segment.render_signature === layerSegmentSignatureOf(segment, spec)
}

// ─── 画幅 ────────────────────────────────────────────────────

const specCache = new Map<number, SegmentSpec>()

/**
 * 本集图层段规格：优先实测本集已有的**模型视频**（与 `probeIntroSpec` 同口径），
 * 画幅与帧率都取它；本集一条视频都没有时回落 25 fps + 按画幅比例的内置默认尺寸。
 */
export async function resolveEpisodeSegmentSpec(episodeId: number): Promise<SegmentSpec> {
  const cached = specCache.get(episodeId)
  if (cached) return cached
  const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  for (const row of rows.sort((a, b) => a.storyboardNumber - b.storyboardNumber)) {
    // 只看模型视频：图层段与成片是由它**产出**的，拿它们定规格会形成回环（契约 §3.2 风险 4）
    const candidate = row.videoUrl
    if (!candidate) continue
    const probed = await probeVideoSpec(getAbsolutePath(candidate))
    if (!probed) continue
    const spec: SegmentSpec = {
      width: probed.width,
      height: probed.height,
      fps: Math.round(probed.fps * 1000) / 1000,
      source: 'video',
    }
    specCache.set(episodeId, spec)
    return spec
  }
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const [drama] = episode
    ? await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId))
    : []
  const fallback = DEFAULT_SPEC_BY_ASPECT[drama?.aspectRatio || '16:9'] || DEFAULT_SPEC_BY_ASPECT['16:9']
  return { ...fallback, fps: SEGMENT_DEFAULT_FPS, source: 'default' }
}

/** 视频文件换过/新建过之后让画幅缓存失效（新建首条视频会改变本集画幅来源） */
export function invalidateSegmentSpec(episodeId: number): void {
  specCache.delete(episodeId)
}

// ─── 草稿 ────────────────────────────────────────────────────

/** 装配草稿上下文：本镜设计卡引用到的资产 + 它们的忠实原图与语义标注 */
async function loadDraftAssets(card: DesignCard): Promise<SegmentDraftAsset[]> {
  const propIds = new Set<number>()
  const characterIds = new Set<number>()
  const sceneIds = new Set<number>()
  const collect = (assetId: number | undefined, kind: string | undefined, fallbackKind: 'prop' | 'character') => {
    if (!assetId) return
    const target = kind === 'character' ? characterIds : kind === 'scene' ? sceneIds : kind === 'prop' ? propIds : null
    if (target) target.add(assetId)
    else if (fallbackKind === 'character') characterIds.add(assetId)
    else propIds.add(assetId)
  }
  const base = card.layer_plan?.base
  if (base && base.kind === 'asset') collect(base.asset_id, base.asset_kind, 'prop')
  for (const ref of card.layer_plan?.must_mark || []) collect(ref.asset_id, 'prop', 'prop')
  for (const layer of card.layer_plan?.planned_layers || []) {
    collect(layer.anchor?.asset_id, 'prop', layer.type === 'image' ? 'character' : 'prop')
  }
  for (const ref of card.gen_plan?.reference_assets || []) collect(ref.id, ref.kind, 'character')

  const assets: SegmentDraftAsset[] = []
  if (propIds.size) {
    const props = await db.select().from(schema.props).where(inArray(schema.props.id, [...propIds]))
    for (const prop of props) {
      const semanticsBase = await resolveSemanticsBase(prop)
      assets.push({
        kind: 'prop',
        id: prop.id,
        name: prop.name,
        image_path: semanticsBase.path,
        semantics: parseSemantics(prop.semantics),
      })
    }
  }
  if (characterIds.size) {
    const characters = await db.select().from(schema.characters).where(inArray(schema.characters.id, [...characterIds]))
    for (const character of characters) {
      assets.push({
        kind: 'character',
        id: character.id,
        name: character.name,
        image_path: character.localPath || character.imageUrl || null,
        semantics: null,
      })
    }
  }
  if (sceneIds.size) {
    const scenes = await db.select().from(schema.scenes).where(inArray(schema.scenes.id, [...sceneIds]))
    for (const scene of scenes) {
      assets.push({
        kind: 'scene',
        id: scene.id,
        name: scene.location,
        image_path: scene.localPath || scene.imageUrl || null,
        semantics: null,
      })
    }
  }
  // 语义坐标是针对底图原件的像素；这里补上真实像素尺寸，草稿才能正确归一化
  for (const asset of assets) {
    if (!asset.image_path || !asset.semantics) continue
    asset.image_width = asset.semantics.image.width
    asset.image_height = asset.semantics.image.height
  }
  return assets
}

/** 底图解析结果：`kind:'inherit_prev'` 取上一镜尾帧；解析不到就是 `missing_base` */
async function resolveDraftBase(
  row: typeof schema.storyboards.$inferSelect,
  card: DesignCard,
  assets: SegmentDraftAsset[],
): Promise<{ baseRef: BaseRef | null; asset: SegmentDraftAsset | null; imagePath: string | null }> {
  const baseRef = card.layer_plan?.base ?? null
  if (!baseRef) return { baseRef: null, asset: null, imagePath: null }
  if (baseRef.kind === 'asset') {
    const asset = assets.find(item => item.id === baseRef.asset_id && item.kind === baseRef.asset_kind) ?? null
    if (asset?.image_path) return { baseRef, asset, imagePath: asset.image_path }
    // 指定了版本：直接取那张生成图（版本图不参与语义归一化，仍用资产原件像素）
    if (baseRef.version_task_id) {
      const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, baseRef.version_task_id))
      const image = task?.localPath || task?.resultUrl || null
      if (image) return { baseRef, asset, imagePath: image }
    }
    return { baseRef, asset, imagePath: null }
  }
  // inherit_prev：上一镜（同集、未删除、按分镜号排序）的生效尾帧（含承接）
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, row.episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  const usable = rows.filter(item => !item.deletedAt)
  const index = usable.findIndex(item => item.id === row.id)
  const prev = index > 0 ? usable[index - 1] : null
  const lastImage = (prev?.lastFrameImage || '').trim() || null
  if (!lastImage) return { baseRef, asset: null, imagePath: null }
  return {
    baseRef,
    asset: {
      kind: 'prop',
      id: -prev!.id,
      name: `#${prev!.storyboardNumber} 尾帧`,
      image_path: lastImage,
      semantics: null,
    },
    imagePath: lastImage,
  }
}

export interface SegmentDraftResult {
  draft: SegmentDraft
  spec: SegmentSpec
  base_ref: BaseRef | null
}

export type SegmentDraftOutcome =
  | { ok: true; result: SegmentDraftResult }
  | { ok: false; issue: SegmentDraftIssue; message: string }

/**
 * 按设计卡 `layer_plan` 生成图层段草稿（不落库）。
 * 失败原因结构化：`missing_base`（设计卡没指定底图或指定了但解析不到图）、
 * `no_layer_segment`（combo = B 或未选）、`no_design_card`。
 * **没有任何「随便找一张资产图当底图」的回退**（契约 §8 第 6 行）。
 */
export async function buildSegmentDraft(storyboardId: number): Promise<SegmentDraftOutcome> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const combo = toCombo(sb.combo)
  if (!hasLayerSegment(combo)) {
    return { ok: false, issue: 'no_layer_segment', message: '本镜的段组合没有图层段（A/C/D 才有），请先在分镜设计里选择组合' }
  }
  const card = parseDesignCard(sb.designCard)
  if (!card) return { ok: false, issue: 'no_design_card', message: '本镜还没有设计卡，请先在分镜设计里填写并确认' }
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
  const assets = await loadDraftAssets(card)
  const base = await resolveDraftBase(sb, card, assets)
  if (!base.imagePath) {
    return {
      ok: false,
      issue: 'missing_base',
      message: card.layer_plan?.base
        ? '设计卡指定的底图解析不到图片（资产被删、版本不存在，或上一镜还没有尾帧）：请回分镜设计重新指定底图'
        : '设计卡没有指定图层段底图：请回分镜设计为图层段选择底图',
    }
  }
  const draft = draftSegment(card, combo, {
    assets,
    base: base.asset,
    base_path: base.imagePath,
    base_ref: base.baseRef,
    duration: sb.duration || 0,
    width: spec.width,
    height: spec.height,
  })
  return { ok: true, result: { draft, spec, base_ref: base.baseRef } }
}

/** 生成草稿并落库（覆盖本镜既有图层段）；落库后旧衔接帧作废，一并清掉快照 hash */
export async function saveSegmentDraft(storyboardId: number): Promise<SegmentDraftOutcome> {
  const outcome = await buildSegmentDraft(storyboardId)
  if (!outcome.ok) return outcome
  const { draft, base_ref, spec } = outcome.result
  const layerDoc = await withBaseSourceSize(draft.layer_doc)
  const segment = await saveLayerSegment(storyboardId, {
    layer_doc: layerDoc,
    timeline: draft.timeline,
    duration: draft.duration,
    base_ref,
  })
  await db.update(schema.storyboards)
    .set({ keyframesJunctionHash: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
  return { ok: true, result: { draft: { ...draft, layer_doc: segment.layer_doc }, spec, base_ref } }
}

/** 段组合要求的图层段位置（机械换源用）：A 整镜替代、C 在模型视频之前、D 在之后、B/未选 = 没有图层段 */
export function segmentPositionOfCombo(combo: Combo | string | null | undefined): 'replace' | 'pre' | 'post' | 'none' {
  switch (toCombo(combo)) {
    case 'A': return 'replace'
    case 'C': return 'pre'
    case 'D': return 'post'
    default: return 'none'
  }
}
