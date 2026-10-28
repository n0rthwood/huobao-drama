/**
 * 承接镜头的开场转场（Issue #11）— 审核、生成与时长规则的唯一实现
 *
 * 转场只针对 inherits_first 的镜头：它的首帧就是上一镜的尾帧，视频模型会把上一镜结尾的
 * 状态（手持物、姿态、光线）带进本镜，所以必须显式写出 0–T 秒的开场转场段。
 * 手法目录（合法 technique_id）只从 workspace/skills/prompt-generator/transition-prompt/catalog.json 读取。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { loadEpisodeKeyframes } from './keyframes.js'
import { loadEpisodeAssets } from './storyboard-assets.js'
import { stampFieldSavedAt } from './storyboard-fields.js'
import { getConfigById, getActiveConfig } from './ai.js'

type StoryboardRow = typeof schema.storyboards.$inferSelect

export type TransitionVerdict = 'scene_time' | 'continuity' | 'none'

/** storyboards.transition_review 的 JSON 形状 */
export interface TransitionReview {
  verdict: TransitionVerdict
  changes: string[]
  hazards: string[]
  /** 目录里的 technique_id；verdict=none 时为 null */
  technique: string | null
  /** 转场秒数 T */
  seconds: number
  /** 审核输入的哈希，输入变了审核即失效 */
  input_signature: string
  reviewed_at: number
  /** 用户手动编辑过转场文本（AI 生成保存时为 false） */
  edited_manually: boolean
  reason: string
}

// ─── 手法目录 ──────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_DIR = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.resolve(__dirname, '../../workspace')
const CATALOG_PATH = path.join(WORKSPACE_DIR, 'skills/prompt-generator/transition-prompt/catalog.json')

interface CatalogTechnique {
  technique_id: string
  name_zh?: string
  name_en?: string
  category?: string
  is_fast?: boolean
  seconds_min?: number
  seconds_max?: number
}

interface TransitionCatalog {
  techniques: CatalogTechnique[]
  defaults?: Record<string, unknown>
}

let catalogCache: { mtimeMs: number; catalog: TransitionCatalog } | null = null

/** 读取手法目录（按 mtime 缓存；设置页改了文件无需重启） */
export function loadTransitionCatalog(): TransitionCatalog {
  const stat = fs.statSync(CATALOG_PATH)
  if (catalogCache && catalogCache.mtimeMs === stat.mtimeMs) return catalogCache.catalog
  const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as TransitionCatalog
  if (!Array.isArray(parsed.techniques) || !parsed.techniques.length) {
    throw new Error('转场手法目录为空（catalog.json）')
  }
  catalogCache = { mtimeMs: stat.mtimeMs, catalog: parsed }
  return parsed
}

/** 合法 technique_id 集合 —— 代码只认目录里的 id */
export function legalTechniqueIds(): string[] {
  return loadTransitionCatalog().techniques.map(item => item.technique_id).filter(Boolean)
}


/** 某手法的秒数范围（目录缺省时按 1–3 秒） */
export function techniqueSecondsRange(techniqueId: string | null): { min: number; max: number } {
  const item = techniqueId ? loadTransitionCatalog().techniques.find(t => t.technique_id === techniqueId) : null
  return { min: item?.seconds_min ?? 1, max: item?.seconds_max ?? 3 }
}

// ─── 审核结果读写 ───────────────────────────────────────────────

export function parseTransitionReview(raw: string | null | undefined): TransitionReview | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<TransitionReview>
    if (!value || typeof value !== 'object') return null
    const verdict = value.verdict
    if (verdict !== 'scene_time' && verdict !== 'continuity' && verdict !== 'none') return null
    return {
      verdict,
      changes: Array.isArray(value.changes) ? value.changes.map(String) : [],
      hazards: Array.isArray(value.hazards) ? value.hazards.map(String) : [],
      technique: typeof value.technique === 'string' ? value.technique : null,
      seconds: Number(value.seconds) || 0,
      input_signature: String(value.input_signature || ''),
      reviewed_at: Number(value.reviewed_at) || 0,
      edited_manually: value.edited_manually === true,
      reason: String(value.reason || ''),
    }
  } catch {
    return null
  }
}

/**
 * 审核输入签名（实施细节补充）：不含任何一镜的 video_prompt，
 * 避免「先写转场、后写视频提示词」时刚审核完就失效。
 */
export function transitionInputSignature(
  prev: StoryboardRow,
  prevLastFrameImage: string | null,
  current: StoryboardRow,
): string {
  const payload = [
    prev.sceneId ?? null,
    (prev.location || '').trim(),
    (prev.time || '').trim(),
    (prev.description || '').trim(),
    (prev.lastFramePrompt || '').trim(),
    prevLastFrameImage || '',
    current.sceneId ?? null,
    (current.location || '').trim(),
    (current.time || '').trim(),
    (current.description || '').trim(),
    (current.firstFramePrompt || '').trim(),
    Number(current.duration || 0),
    current.midFrameTime ?? null,
  ]
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** 本镜当前的审核输入签名；非承接镜头返回 null */
export async function currentTransitionSignature(storyboardId: number): Promise<string | null> {
  const ctx = await loadTransitionPair(storyboardId)
  if (!ctx) return null
  return transitionInputSignature(ctx.previous, ctx.previousLastFrame, ctx.current)
}

export interface TransitionPair {
  current: StoryboardRow
  previous: StoryboardRow
  previousLastFrame: string | null
  episodeId: number
  dramaId: number
}

/** 承接镜头的「上一镜 + 本镜」；非承接（或第一镜）返回 null */
export async function loadTransitionPair(storyboardId: number): Promise<TransitionPair | null> {
  const [current] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!current || current.deletedAt) return null
  const keyframes = await loadEpisodeKeyframes(current.episodeId)
  const state = keyframes.get(storyboardId)
  if (!state?.inheritsFirst || !state.previousId) return null
  const [previous] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, state.previousId))
  if (!previous) return null
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, current.episodeId))
  return {
    current,
    previous,
    previousLastFrame: keyframes.get(previous.id)?.last ?? null,
    episodeId: current.episodeId,
    dramaId: episode?.dramaId ?? 0,
  }
}

// ─── Agent 上下文 ──────────────────────────────────────────────

const MEMORY_KEYWORDS = ['回忆', '闪回', '往事', 'flashback', 'memory']
const DREAM_KEYWORDS = ['梦境', '做梦', '幻想', 'dream']

function narrativeOf(sb: StoryboardRow): string {
  const text = `${sb.description || ''} ${sb.atmosphere || ''}`.toLowerCase()
  if (DREAM_KEYWORDS.some(k => text.includes(k))) return 'dream'
  if (MEMORY_KEYWORDS.some(k => text.includes(k))) return 'memory'
  return 'normal'
}

/** 当前集生效的视频模型标签（给 agent 判断手法可执行性） */
async function videoModelLabel(episodeId: number): Promise<string> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  const config = (ep?.videoConfigId ? await getConfigById(ep.videoConfigId) : null) || await getActiveConfig('video')
  if (!config) return 'h3'
  const provider = (config.provider || '').toLowerCase()
  if (provider === 'comfyui') return 'h3'
  return provider
}

async function sceneNameOf(sceneId: number | null | undefined): Promise<string> {
  if (!sceneId) return ''
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
  return (scene?.location || '').trim()
}

/** read_transition_context 的返回体 */
export async function buildTransitionContext(storyboardId: number): Promise<Record<string, unknown>> {
  const pair = await loadTransitionPair(storyboardId)
  if (!pair) throw new Error('该镜头不是承接镜头（没有继承上一镜尾帧），无需转场')
  const { current, previous } = pair
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, pair.episodeId))
  const assets = await loadEpisodeAssets(pair.episodeId)
  const boundCharacterIds = (await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, current.id))).map(link => link.characterId)
  const boundPropIds = (await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, current.id))).map(link => link.propId)

  const thisAssets = assets.filter(asset => asset.kind === 'scene'
    ? asset.id === current.sceneId
    : (asset.kind === 'character' ? boundCharacterIds : boundPropIds).includes(asset.id))

  return {
    prev_shot: {
      shot_number: previous.storyboardNumber,
      scene: await sceneNameOf(previous.sceneId),
      location: previous.location || '',
      time: previous.time || '',
      description: previous.description || '',
      atmosphere: previous.atmosphere || '',
      result: previous.result || '',
      last_frame_prompt: previous.lastFramePrompt || '',
      video_prompt: previous.videoPrompt || '',
    },
    /** 上一镜结尾画面状态（尾帧提示词 + result 是唯一可靠来源） */
    prev_end: [previous.lastFramePrompt || '', previous.result || ''].filter(Boolean).join('\n'),
    this_shot: {
      shot_number: current.storyboardNumber,
      scene: await sceneNameOf(current.sceneId),
      location: current.location || '',
      time: current.time || '',
      description: current.description || '',
      atmosphere: current.atmosphere || '',
      first_frame_prompt: current.firstFramePrompt || '',
      mid_frame_prompt: current.midFramePrompt || '',
      last_frame_prompt: current.lastFramePrompt || '',
      video_prompt: current.videoPrompt || '',
    },
    /** 本镜开场画面：承接镜头自己没有首帧提示词时，开场画面写在 description 的【镜头1】里 */
    this_start: [current.firstFramePrompt || '', current.description || ''].filter(Boolean).join('\n'),
    this_assets: thisAssets.map(asset => ({ kind: asset.kind, name: asset.name })),
    duration: Number(current.duration || 0),
    mid_frame_time: current.midFrameTime ?? null,
    video_model: await videoModelLabel(pair.episodeId),
    narrative: narrativeOf(current),
    episode_script: episode?.scriptContent || episode?.content || '',
  }
}

// ─── 时长规则 ──────────────────────────────────────────────────

const MAX_SUBMIT_DURATION = 15

/** 向下取 0.5 的倍数 */
function floorHalf(value: number): number {
  return Math.floor(value * 2) / 2
}

export interface TransitionPlan {
  /** 转场秒数（收缩后） */
  seconds: number
  /** 实际加长量 E = 提交时长 − 内容时长 */
  extra: number
  /** 提交给视频模型的时长 */
  submitDuration: number
  /** 中间帧引导时间（没有中间帧时为 null） */
  midGuideTime: number | null
  /** 时长约束下无法安排转场时的原因 */
  dropReason: string | null
}

/**
 * 时长规则（Issue「时长规则」+「实施细节补充 · 时间段写法」）：
 * 提交时长 = min(内容时长 + T, 15)，E = 提交时长 − 内容时长，中间帧引导 = mid_frame_time + E，
 * 且必须 ≥ T + 0.5；不满足时把 T 缩到 mid_frame_time + E − 0.5（最少 1 秒），仍不足则不带转场。
 */
export function planTransitionTiming(
  requestedSeconds: number,
  duration: number,
  midFrameTime: number | null | undefined,
): TransitionPlan {
  const content = Math.max(0, Number(duration) || 0)
  let seconds = Math.max(1, floorHalf(Number(requestedSeconds) || 0))
  for (let i = 0; i < 8; i++) {
    const submitDuration = Math.min(content + seconds, MAX_SUBMIT_DURATION)
    const extra = Math.max(0, submitDuration - content)
    if (midFrameTime == null) {
      return { seconds, extra, submitDuration, midGuideTime: null, dropReason: null }
    }
    const midGuideTime = midFrameTime + extra
    if (midGuideTime >= seconds + 0.5) {
      return { seconds, extra, submitDuration, midGuideTime, dropReason: null }
    }
    const shrunk = floorHalf(midGuideTime - 0.5)
    if (shrunk < 1 || shrunk >= seconds) {
      return {
        seconds: 0,
        extra: 0,
        submitDuration: content,
        midGuideTime: midFrameTime,
        dropReason: `中间帧时间点 ${midFrameTime} 秒距离开头太近，转场至少需要 1 秒且必须在中间帧前 0.5 秒结束，本次不带转场提交`,
      }
    }
    seconds = shrunk
  }
  return {
    seconds: 0,
    extra: 0,
    submitDuration: content,
    midGuideTime: midFrameTime ?? null,
    dropReason: '转场时长无法满足中间帧约束，本次不带转场提交',
  }
}

/** 最终提示词的拼接（实施细节补充 · 时间段写法）；秒数写成 3 而不是 3.0 */
export function composeTransitionPrompt(transition: string, videoPrompt: string, seconds: number, extra: number): string {
  const t = String(seconds)
  const head = `开场转场（0–${t} 秒）：${transition.trim()}`
  const body = `随后（自 ${t} 秒起，下列描述的时间整体后移 ${String(extra)} 秒）：${videoPrompt.trim()}`
  return `${head}\n${body}`
}

// ─── 保存 ─────────────────────────────────────────────────────

/** 保存一次 AI 审核结果（edited_manually=false） */
export async function saveTransitionReview(
  storyboardId: number,
  decision: {
    verdict: TransitionVerdict
    changes: string[]
    hazards: string[]
    technique: string | null
    seconds: number
    transitionPrompt: string
    reason: string
  },
): Promise<TransitionReview> {
  const pair = await loadTransitionPair(storyboardId)
  if (!pair) throw new Error('该镜头不是承接镜头，无法保存转场审核')
  const review: TransitionReview = {
    verdict: decision.verdict,
    changes: decision.changes,
    hazards: decision.hazards,
    technique: decision.technique,
    seconds: decision.seconds,
    input_signature: transitionInputSignature(pair.previous, pair.previousLastFrame, pair.current),
    reviewed_at: Math.floor(Date.now() / 1000),
    edited_manually: false,
    reason: decision.reason,
  }
  const stamp = stampFieldSavedAt(pair.current.fieldSavedAt, ['transition_prompt'])
  await db.update(schema.storyboards)
    .set({
      transitionPrompt: decision.transitionPrompt,
      transitionReview: JSON.stringify(review),
      ...(stamp.json ? { fieldSavedAt: stamp.json } : {}),
      updatedAt: now(),
    })
    .where(eq(schema.storyboards.id, storyboardId))
  return review
}

/** 用户手动保存转场文本：沿用最后一次 AI 审核结论，只把 edited_manually 置 true */
export async function markTransitionEditedManually(storyboard: StoryboardRow): Promise<void> {
  const existing = parseTransitionReview(storyboard.transitionReview)
  const pair = await loadTransitionPair(storyboard.id)
  const signature = pair
    ? transitionInputSignature(pair.previous, pair.previousLastFrame, pair.current)
    : existing?.input_signature || ''
  const review: TransitionReview = {
    verdict: existing?.verdict ?? 'continuity',
    changes: existing?.changes ?? [],
    hazards: existing?.hazards ?? [],
    technique: existing?.technique ?? null,
    seconds: existing?.seconds || 3,
    input_signature: signature,
    reviewed_at: existing?.reviewed_at || Math.floor(Date.now() / 1000),
    edited_manually: true,
    reason: existing?.reason || '',
  }
  await db.update(schema.storyboards)
    .set({ transitionReview: JSON.stringify(review), updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboard.id))
}

// ─── 状态判定 ──────────────────────────────────────────────────

export type TransitionState = 'not_inheriting' | 'disabled' | 'missing' | 'stale' | 'manual' | 'ready' | 'none'

export interface TransitionStatus {
  state: TransitionState
  review: TransitionReview | null
  /** 需要在提交前跑一次审核 */
  needsReview: boolean
}

/** 某镜此刻的转场状态（预览清单与提交共用） */
export async function transitionStatus(storyboard: StoryboardRow, inheritsFirst: boolean): Promise<TransitionStatus> {
  const review = parseTransitionReview(storyboard.transitionReview)
  if (!inheritsFirst) return { state: 'not_inheriting', review, needsReview: false }
  if (storyboard.transitionEnabled === false) return { state: 'disabled', review, needsReview: false }
  // 手动编辑过的转场不自动重审、不自动覆盖
  if (review?.edited_manually) return { state: 'manual', review, needsReview: false }
  if (!review) return { state: 'missing', review, needsReview: true }
  const signature = await currentTransitionSignature(storyboard.id)
  if (!signature || signature !== review.input_signature) return { state: 'stale', review, needsReview: true }
  if (review.verdict === 'none') return { state: 'none', review, needsReview: false }
  if (!(storyboard.transitionPrompt || '').trim()) return { state: 'missing', review, needsReview: true }
  return { state: 'ready', review, needsReview: false }
}
