/**
 * 确定性片段的唯一读写口（Issue #50）。
 *
 * - 持久化：`storyboard_clips`（每镜每个 position 至多一条，库级 UNIQUE 兜底）。
 * - 渲染签名：`clipSignatureOf()` = 图层文档 + 时间线 + 时长 + 底图/图片图层字节 sha + 画幅。
 *   改了图层而没重渲染 → 签名不等 → 合成状态判「已变化·确定性片段」（见 compose-state v3）。
 * - 草稿：把库里的资产/语义标注装配成 `ClipDraftContext`，交给纯函数 `draftClip()`。
 *
 * 片段画幅 = 本集成片画幅（沿用 `probeIntroSpec` 的口径：按已有模型视频实测），
 * 帧率由时间线决定（默认 25）；两者都进签名，改了就要重渲染。
 */
import fs from 'fs'
import crypto from 'crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { probeVideoSpec } from './media-probe.js'
import { normalizeLayerDoc, type LayerDoc } from './layer-doc.js'
import {
  CLIP_DEFAULT_FPS,
  MAX_CLIP_SECONDS,
  clampClipDuration,
  normalizeTimeline,
  type ClipTimeline,
} from './clip-timeline.js'
import { draftClip, type ClipDraft, type ClipDraftAsset } from './clip-draft.js'
import { parseSemantics, resolveSemanticsBase } from './asset-semantics.js'
import { parseDesignCard, toCombo, type Combo, type DesignCard } from './design-card.js'
import { MAX_SHOT_SECONDS } from './narration.js'

/** 确定性片段相对模型视频的位置（`none` = 本镜没有图层段） */
export const CLIP_POSITIONS = ['replace', 'pre', 'post', 'none'] as const
export type ClipPosition = typeof CLIP_POSITIONS[number]

/** 真正落库的位置（`none` 表示本镜没有确定性片段，不写行） */
export const PERSISTED_CLIP_POSITIONS = ['replace', 'pre', 'post'] as const
export type PersistedClipPosition = (typeof PERSISTED_CLIP_POSITIONS)[number]

export type ClipStatus = 'draft' | 'rendering' | 'ready' | 'failed'

export interface StoryboardClip {
  id: number
  storyboard_id: number
  position: PersistedClipPosition
  layer_doc: LayerDoc
  timeline: ClipTimeline
  duration: number
  render_path: string | null
  render_signature: string | null
  rendered_at: string | null
  status: ClipStatus
}

/**
 * 本集成片规格：片段必须与模型视频**同画幅同帧率**，否则拼接与最终 merge 会花屏/时基错乱。
 * 协调者裁决（2026-11-03）：fps 与画幅都实测自本集首条已有视频（与 `probeIntroSpec` 同口径），
 * 本集还没有任何视频时才回落 25 fps + 按画幅比例的内置默认尺寸。
 * 因此 `timeline.fps` 是**派生值**（保存片段时同步写入），不是用户可选项。
 */
export interface ClipSpec {
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

type ClipRow = typeof schema.storyboardClips.$inferSelect

function parseClipRow(row: ClipRow): StoryboardClip {
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
  return {
    id: row.id,
    storyboard_id: row.storyboardId,
    position: row.position as PersistedClipPosition,
    layer_doc: normalizeLayerDoc(layerDoc),
    timeline: normalizeTimeline(timeline),
    duration: row.duration,
    render_path: row.renderPath,
    render_signature: row.renderSignature,
    rendered_at: row.renderedAt,
    status: (row.status as ClipStatus) || 'draft',
  }
}

export async function listStoryboardClips(storyboardId: number): Promise<StoryboardClip[]> {
  const rows = await db.select().from(schema.storyboardClips)
    .where(eq(schema.storyboardClips.storyboardId, storyboardId))
  return rows.map(parseClipRow)
}

/** 整集一次查完：合成状态与批量预览都要逐镜看片段，不能每镜发一次查询 */
export async function clipsByStoryboard(storyboardIds: number[]): Promise<Map<number, StoryboardClip[]>> {
  const out = new Map<number, StoryboardClip[]>()
  if (!storyboardIds.length) return out
  const rows = await db.select().from(schema.storyboardClips)
    .where(inArray(schema.storyboardClips.storyboardId, storyboardIds))
  for (const row of rows) {
    const clip = parseClipRow(row)
    const list = out.get(clip.storyboard_id)
    if (list) list.push(clip)
    else out.set(clip.storyboard_id, [clip])
  }
  return out
}

export async function getStoryboardClip(
  storyboardId: number,
  position: PersistedClipPosition,
): Promise<StoryboardClip | null> {
  const [row] = await db.select().from(schema.storyboardClips).where(and(
    eq(schema.storyboardClips.storyboardId, storyboardId),
    eq(schema.storyboardClips.position, position),
  ))
  return row ? parseClipRow(row) : null
}

export interface ClipWriteInput {
  layer_doc?: unknown
  timeline?: unknown
  duration?: number
}

/**
 * 写入（新建或整体替换）一条片段草稿。改动图层/时间线/时长都会让已渲染的成品过期：
 * 这里只保留 `render_path`（界面还能播旧的），`render_signature` 不动——
 * 新鲜度一律由 `clipIsFresh()` 现算，不靠状态位记账。
 */
export async function saveStoryboardClip(
  storyboardId: number,
  position: PersistedClipPosition,
  input: ClipWriteInput,
): Promise<StoryboardClip> {
  const existing = await getStoryboardClip(storyboardId, position)
  const layerDoc = normalizeLayerDoc('layer_doc' in input ? input.layer_doc : existing?.layer_doc)
  // fps 是派生值：始终跟随本集成片规格，用户在时间线里改不了
  const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const spec = await resolveEpisodeClipSpec(row?.episodeId ?? 0)
  const timeline = normalizeTimeline({
    ...normalizeTimeline('timeline' in input ? input.timeline : existing?.timeline),
    fps: spec.fps,
  })
  const maxSeconds = position === 'replace' ? MAX_CLIP_SECONDS : MAX_SHOT_SECONDS
  const duration = clampClipDuration(
    input.duration !== undefined ? Number(input.duration) : (existing?.duration ?? 0),
    maxSeconds,
  )
  const ts = now()
  if (existing) {
    await db.update(schema.storyboardClips).set({
      layerDoc: JSON.stringify(layerDoc),
      timeline: JSON.stringify(timeline),
      duration,
      updatedAt: ts,
    }).where(eq(schema.storyboardClips.id, existing.id))
    return { ...existing, layer_doc: layerDoc, timeline, duration }
  }
  const result = await db.insert(schema.storyboardClips).values({
    storyboardId,
    position,
    layerDoc: JSON.stringify(layerDoc),
    timeline: JSON.stringify(timeline),
    duration,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  })
  return {
    id: getInsertId(result),
    storyboard_id: storyboardId,
    position,
    layer_doc: layerDoc,
    timeline,
    duration,
    render_path: null,
    render_signature: null,
    rendered_at: null,
    status: 'draft',
  }
}

export async function deleteStoryboardClip(storyboardId: number, position: PersistedClipPosition): Promise<void> {
  await db.delete(schema.storyboardClips).where(and(
    eq(schema.storyboardClips.storyboardId, storyboardId),
    eq(schema.storyboardClips.position, position),
  ))
}

export async function markClipRendered(
  clipId: number,
  patch: { render_path: string; render_signature: string; status: ClipStatus },
): Promise<void> {
  await db.update(schema.storyboardClips).set({
    renderPath: patch.render_path,
    renderSignature: patch.render_signature,
    renderedAt: now(),
    status: patch.status,
    updatedAt: now(),
  }).where(eq(schema.storyboardClips.id, clipId))
}

export async function markClipStatus(clipId: number, status: ClipStatus): Promise<void> {
  await db.update(schema.storyboardClips)
    .set({ status, updatedAt: now() })
    .where(eq(schema.storyboardClips.id, clipId))
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

/** 片段渲染签名：输入任何一处变化（含底图文件本身被换掉）都要重渲染 */
export function clipSignatureOf(
  clip: Pick<StoryboardClip, 'layer_doc' | 'timeline' | 'duration' | 'position'>,
  spec: Pick<ClipSpec, 'width' | 'height' | 'fps'>,
): string {
  const images = [clip.layer_doc.base.path]
  for (const layer of clip.layer_doc.layers) {
    if (layer.type === 'image') images.push(layer.src.path)
  }
  return crypto.createHash('sha256').update([
    'clip-v1',
    clip.position,
    JSON.stringify(clip.layer_doc),
    JSON.stringify(clip.timeline),
    clip.duration.toFixed(3),
    `${spec.width}x${spec.height}@${spec.fps}`,
    ...images.map(path => `${path}@${fileSha256(path)}`),
  ].join('\u0000'), 'utf8').digest('hex')
}

/** 已渲染的成品是否仍对得上当前输入（文件在 + 签名一致） */
export function clipIsFresh(clip: StoryboardClip, spec: Pick<ClipSpec, 'width' | 'height' | 'fps'>): boolean {
  if (!clip.render_path || !clip.render_signature) return false
  if (!fs.existsSync(getAbsolutePath(clip.render_path))) return false
  return clip.render_signature === clipSignatureOf(clip, spec)
}

// ─── 画幅 ────────────────────────────────────────────────────

const specCache = new Map<number, ClipSpec>()

/**
 * 本集片段规格：优先实测本集已有的模型视频 / 成片（与 `probeIntroSpec` 同口径），
 * 画幅与帧率都取它；本集一条视频都没有时回落 25 fps + 按画幅比例的内置默认尺寸。
 * 这样 pre/post 拼接不必重采样模型视频，整集 merge 的帧率也是同质的。
 */
export async function resolveEpisodeClipSpec(episodeId: number): Promise<ClipSpec> {
  const cached = specCache.get(episodeId)
  if (cached) return cached
  const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  for (const row of rows.sort((a, b) => a.storyboardNumber - b.storyboardNumber)) {
    // 只看模型视频：成片（composed）是由片段**产出**的，拿它定规格会形成
    // 「渲染→合成→规格变→签名变→片段被判过期」的循环（merge 阻断实测踩到过）
    const candidate = row.videoUrl
    if (!candidate) continue
    const probed = await probeVideoSpec(getAbsolutePath(candidate))
    if (!probed) continue
    const spec: ClipSpec = {
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
  return { ...fallback, fps: CLIP_DEFAULT_FPS, source: 'default' }
}

/** 片段文件换过/新建过之后让画幅缓存失效（新建首条视频会改变本集画幅来源） */
export function invalidateClipSpec(episodeId: number): void {
  specCache.delete(episodeId)
}

// ─── 草稿 ────────────────────────────────────────────────────

/** 装配草稿上下文：本镜设计卡引用到的资产 + 它们的忠实原图与语义标注 */
async function loadDraftAssets(episodeId: number, card: DesignCard): Promise<ClipDraftAsset[]> {
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

  const assets: ClipDraftAsset[] = []
  if (propIds.size) {
    const props = await db.select().from(schema.props).where(inArray(schema.props.id, [...propIds]))
    for (const prop of props) {
      const base = await resolveSemanticsBase(prop)
      assets.push({
        kind: 'prop',
        id: prop.id,
        name: prop.name,
        image_path: base.path,
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

export interface ClipDraftResult {
  draft: ClipDraft
  spec: ClipSpec
}

/**
 * 按设计卡生成片段草稿（不落库）。返回 null = 本镜没有图层段（combo = B 或未选）、
 * 没有设计卡，或找不到任何可用底图。
 */
export async function buildClipDraft(storyboardId: number): Promise<ClipDraftResult | null> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const card = parseDesignCard(sb.designCard)
  if (!card) return null
  const spec = await resolveEpisodeClipSpec(sb.episodeId)
  const assets = await loadDraftAssets(sb.episodeId, card)
  const draft = draftClip(card, toCombo(sb.combo), {
    assets,
    duration: sb.duration || 0,
    width: spec.width,
    height: spec.height,
  })
  return draft ? { draft, spec } : null
}

/** 生成草稿并落库（覆盖该 position 的既有草稿） */
export async function saveClipDraft(storyboardId: number): Promise<StoryboardClip | null> {
  const result = await buildClipDraft(storyboardId)
  if (!result) return null
  const { draft } = result
  if (draft.position === 'none') return null
  return saveStoryboardClip(storyboardId, draft.position, {
    layer_doc: draft.layer_doc,
    timeline: draft.timeline,
    duration: draft.duration,
  })
}

/** 本镜段组合要求的片段位置：A 整镜替代、C 在模型视频之前、D 在之后、B/未选 = 没有图层段 */
export function clipPositionOfCombo(combo: Combo | string | null | undefined): ClipPosition {
  switch (toCombo(combo)) {
    case 'A': return 'replace'
    case 'C': return 'pre'
    case 'D': return 'post'
    default: return 'none'
  }
}
