/**
 * 锁定衔接帧：画面描述 + 上下文事实 + 保存校验（Issue #95）
 *
 * 为什么存在：C/D 组合的生成段有一个槽位被图层段衔接帧锁死（C = 首帧 = 图层段末帧，
 * D = 尾帧 = 图层段首帧）。写视频提示词的模型只拿到关键帧提示词，不知道这个槽位的画面
 * 只能来自那张 PNG，于是把 0 秒/末段写成切镜；H3 跟着文字走，丢掉输入的引导帧。
 *
 * 口径：
 * - 画面描述来自**实际的衔接帧 PNG**（视觉模型看一眼），不是底图资产提示词的转述：
 *   末关键帧可能推近，末帧 ≠ 整张底图；衔接帧本身也不含文字类图层。
 * - 描述按 `junction_hash` 缓存（`storyboard_layer_segments.junction_caption`）：同一张
 *   衔接帧只烧一次视觉调用，重渲后 hash 变了才重算。失败结论允许重算（视觉配置修好后
 *   不必等重渲），成功结论只在 hash 变化时重算。
 * - 没有视觉配置 / 调用失败 → `caption: null` + 原因，绝不编画面。
 * - 保存校验只做可机检的事实：C 的首段时间分段必须是 0–1.5 秒的**空镜**（不许 @ 角色、不许切镜、
 *   不许场景过渡写法，Issue #95 二次返工），D 的末段不许切镜；时间分段本身必须是正区间。
 *   退回信息带上 caption，让模型按真实构图重写，而不是只报一个错。
 *   为什么 C 的首段必须短且空：ep 21 实测 7/22 镜首段在 0–3 秒内就写了「@子婴 走向画外」「长卷过渡为山脊」，
 *   H3 把第一段内容画在第 0 帧，衔接帧被整段替换掉。
 */
import fs from 'fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { logTaskError } from '../utils/task-logger.js'
import { resolveStageModel, type StageModel } from './ai-stages.js'
import { callTextChat, imageContentPart } from './vision-chat.js'
import { extractFirstJson } from '../agents/tools/vision-tools.js'
import { runObservedWork } from './task-observability.js'
import { buildSampleKey } from './task-estimate.js'
import { baseFrameOf, normalizeCrop } from './layer-quality.js'
import { frameStateAt } from './segment-timeline.js'
import { assetNameOf } from './layer-base-check.js'
import {
  getLayerSegment,
  resolveEpisodeSegmentSpec,
  segmentsByStoryboard,
  type LayerSegment,
  type SegmentSpec,
} from './layer-segment.js'
import { junctionFrameOf, junctionFramesOfEpisode, type JunctionFrame } from './junction-frame.js'
import { lockedGenSlot, toCombo, type BaseRef } from './design-card.js'
import { loadEpisodeAssets, parseMentions } from './storyboard-assets.js'
import type { LayerDocBase } from './layer-doc.js'

export const LOCKED_FRAMINGS = ['full', 'crop', 'contain', 'zoomed'] as const
export type LockedFraming = typeof LOCKED_FRAMINGS[number]

export interface LockedFrameBaseAsset {
  kind: 'asset'
  asset_kind: 'character' | 'scene' | 'prop'
  asset_id: number
  name: string
}

/** 底图的来源；`null` = 段上没有底图引用（旧草稿/上传底图），画面描述仍会给出 */
export type LockedFrameBase = LockedFrameBaseAsset | { kind: 'inherit_prev' } | null

/**
 * 交给模型的一条锁定槽位事实。
 * `slot` 是分镜上的槽位名（C 锁首帧、D 锁尾帧），`source` 是衔接帧取自图层段的哪一端。
 */
export interface LockedFrame {
  slot: 'first' | 'last'
  source: 'layer_last' | 'layer_first'
  base: LockedFrameBase
  /** 衔接帧的取景：留白 / 裁切 / 推近 / 整图（见 `framingOf`） */
  framing: LockedFraming
  caption: string | null
  /** 为什么没有 caption（或衔接帧为什么不可用）；可同时有 caption（描述仍准确，但帧不可用） */
  caption_note?: string
}

/** `storyboard_layer_segments.junction_caption` 列的 JSON 形状 */
export interface JunctionCaptionCache {
  /** 描述对应的衔接帧 hash；与段当前 hash 不一致即作废 */
  hash: string
  caption: string | null
  error: string | null
  config_id: number | null
  model: string | null
  at: string
}

export interface JunctionCaptionResult {
  hash: string | null
  caption: string | null
  note: string | null
  /** 本次是否真的调用了视觉模型（缓存命中 = false） */
  called: boolean
}

// ─── 取景口径 ────────────────────────────────────────────────

const FULL_CROP_TOLERANCE = 0.001
/** 取景比取景框小 2% 以上才算「推近」：一两像素的取整漂移不是构图变化 */
const ZOOM_TOLERANCE = 0.98

function cropIsFull(base: Pick<LayerDocBase, 'crop'>): boolean {
  const crop = normalizeCrop(base.crop)
  return Math.abs(crop.x) < FULL_CROP_TOLERANCE && Math.abs(crop.y) < FULL_CROP_TOLERANCE
    && Math.abs(crop.w - 1) < FULL_CROP_TOLERANCE && Math.abs(crop.h - 1) < FULL_CROP_TOLERANCE
}

/**
 * 衔接帧的取景：模型据此知道「这张图是不是整张底图、有没有留白、是不是推近了」。
 * 优先级 contain > zoomed > crop > full：留白带是画面里真实存在的部分，必须先说；
 * 推近时裁切与否都已不重要，观众看到的是推近后的构图。
 */
export function framingOf(
  base: Pick<LayerDocBase, 'crop' | 'source_width' | 'source_height'>,
  spec: { width: number; height: number },
  viewport: { w: number; h: number },
): LockedFraming {
  const { mode, frame } = baseFrameOf(base, spec)
  if (mode === 'contain') return 'contain'
  if (viewport.w < frame.w * ZOOM_TOLERANCE || viewport.h < frame.h * ZOOM_TOLERANCE) return 'zoomed'
  if (!cropIsFull(base)) return 'crop'
  return 'full'
}

// ─── 上下文事实 ──────────────────────────────────────────────

/** 缓存里与当前衔接帧 hash 对得上的描述；hash 变了就当没有 */
export function junctionCaptionText(segment: LayerSegment | null): string | null {
  const cache = segment?.junction_caption
  if (!cache || !cache.caption || !segment?.junction_hash) return null
  return cache.hash === segment.junction_hash ? cache.caption : null
}

function captionNote(junction: JunctionFrame, cache: JunctionCaptionCache | null): string | undefined {
  if (!junction.hash || !junction.path || junction.stale) {
    if (junction.base_check_reason) return `衔接帧未就绪：${junction.base_check_reason}`
    if (junction.stale) return '衔接帧未就绪：图层段输入已变化，需要重新渲染'
    return '衔接帧还没有渲染（先渲染图层段）'
  }
  if (cache && cache.hash === junction.hash && cache.error) return `衔接帧画面描述不可用：${cache.error}`
  if (!cache || cache.hash !== junction.hash) return '衔接帧画面描述尚未计算（生成视频提示词前会自动计算）'
  return undefined
}

async function lockedBaseOf(baseRef: BaseRef | null): Promise<LockedFrameBase> {
  if (!baseRef) return null
  if (baseRef.kind === 'inherit_prev') return { kind: 'inherit_prev' }
  return {
    kind: 'asset',
    asset_kind: baseRef.asset_kind,
    asset_id: baseRef.asset_id,
    name: await assetNameOf(baseRef.asset_kind, baseRef.asset_id),
  }
}

/** C 的衔接帧取自图层段末帧（t = duration），D 取自首帧（t = 0） */
export function lockedFrameEntryOf(
  segment: LayerSegment,
  junction: JunctionFrame,
  spec: SegmentSpec,
  base: LockedFrameBase,
): LockedFrame {
  const viewport = frameStateAt(segment.timeline, junction.t).viewport
  return {
    slot: junction.source === 'layer_last' ? 'first' : 'last',
    source: junction.source as 'layer_last' | 'layer_first',
    base,
    framing: framingOf(segment.layer_doc.base, spec, viewport),
    caption: junctionCaptionText(segment),
    caption_note: captionNote(junction, segment.junction_caption),
  }
}

/**
 * 整集一次算完（`read_storyboard_context` 用）：只有 C/D 且已有图层段的镜头才有锁定槽位，
 * 其余镜头不出现在结果里。每集只探一次规格，避免逐镜重复 probe 视频。
 */
export async function lockedFramesOfEpisode(episodeId: number): Promise<Map<number, LockedFrame[]>> {
  const out = new Map<number, LockedFrame[]>()
  const rows = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(row => !row.deletedAt && lockedGenSlot(toCombo(row.combo)))
  if (!rows.length) return out
  const [spec, segments, junctions] = await Promise.all([
    resolveEpisodeSegmentSpec(episodeId),
    segmentsByStoryboard(rows.map(row => row.id)),
    junctionFramesOfEpisode(episodeId),
  ])
  for (const row of rows) {
    const segment = segments.get(row.id)
    const junction = junctions.get(row.id)
    if (!segment || !junction?.source) continue
    out.set(row.id, [lockedFrameEntryOf(segment, junction, spec, await lockedBaseOf(segment.base_ref))])
  }
  return out
}

// ─── 视觉描述 ────────────────────────────────────────────────

const CAPTION_MAX_SIDE = 1024
const CAPTION_QUALITY = 85
const CAPTION_TEMPERATURE = 0.1
const CAPTION_MAX_TOKENS = 400
const CAPTION_TIMEOUT_MS = 120_000

const SYSTEM_PROMPT = '你是影视分镜的画面描述员。只依据看到的画面回答，不臆测画面外的内容，输出严格 JSON。'

export async function writeJunctionCaption(segmentId: number, cache: JunctionCaptionCache): Promise<void> {
  await db.update(schema.storyboardLayerSegments)
    .set({ junctionCaption: JSON.stringify(cache), updatedAt: now() })
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
}

/**
 * 确保本镜的衔接帧画面描述存在（缓存命中就不调模型）。
 *
 * 调用方是 `generate-video-prompts` 批次：必须**在 Agent 开跑之前**算好，这样
 * `read_storyboard_context` 的 `locked_frames.caption` 与批次话术都读得到同一份描述。
 */
export async function ensureJunctionCaption(
  storyboardId: number,
  opts: { taskId?: number; storyboardNumber?: number; configId?: number; excludeConfigIds?: number[] } = {},
): Promise<JunctionCaptionResult> {
  const junction = await junctionFrameOf(storyboardId)
  if (!junction.combo || !lockedGenSlot(junction.combo)) {
    return { hash: junction.hash, caption: null, note: '本镜不是 C/D 组合，没有锁定衔接帧', called: false }
  }
  const segment = await getLayerSegment(storyboardId)
  if (!segment) return { hash: null, caption: null, note: '本镜还没有图层段', called: false }
  const cached = segment.junction_caption
  if (junction.hash && cached?.hash === junction.hash && cached.caption) {
    return { hash: junction.hash, caption: cached.caption, note: captionNote(junction, cached) ?? null, called: false }
  }
  const note = captionNote(junction, cached)
  // 衔接帧不可用（未渲染 / 输入已变化 / 底图验证未过）时不描述它：
  // 描述一张马上要被覆盖的画面只会让模型按错的构图写提示词
  if (!junction.hash || !junction.path || junction.stale || !fs.existsSync(getAbsolutePath(junction.path))) {
    return { hash: junction.hash, caption: null, note: note ?? '衔接帧未就绪', called: false }
  }

  let config: StageModel
  try {
    config = await resolveStageModel('junction_caption', { configId: opts.configId, excludeConfigIds: opts.excludeConfigIds })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const reason = `没有可用的视觉配置：${message}`
    await writeJunctionCaption(segment.id, {
      hash: junction.hash, caption: null, error: reason, config_id: null, model: null, at: now(),
    })
    return { hash: junction.hash, caption: null, note: `衔接帧画面描述不可用：${reason}`, called: false }
  }

  try {
    const image = await imageContentPart(junction.path, { maxSide: CAPTION_MAX_SIDE, quality: CAPTION_QUALITY })
    const question = [
      `这是分镜 #${opts.storyboardNumber ?? storyboardId} 的衔接帧：它是图层段渲染出的画面，不含任何文字类图层，`,
      `会被当成 AI 视频生成段的${junction.source === 'layer_last' ? '第一帧（C 组合：图层段之后接生成段）' : '最后一帧（D 组合：生成段之后接图层段）'}。`,
      '',
      '请只描述这张静态画面本身：',
      '1. 景别与机位（远景/全景/中景/近景/特写；平视/俯拍/仰拍）；',
      '2. 画面里有什么：主体及其位置（有无人、人在画面哪一处、什么建筑/地形/物件占哪块）；',
      '3. 光线与色调，留白在哪一侧；',
      '4. 一句话 50–120 字，纯客观；不写镜头外的内容，不写动作趋势，不写字幕或文字内容。',
      '',
      '只输出 JSON：{"caption": "…"}。',
    ].join('\n')
    const call = () => callTextChat(config, [{ type: 'text', text: question }, image.part], {
      systemPrompt: SYSTEM_PROMPT, temperature: CAPTION_TEMPERATURE, maxTokens: CAPTION_MAX_TOKENS, timeoutMs: CAPTION_TIMEOUT_MS,
    })
    // 视频提示词批次里跑在 video_prompts 任务内：观测窗口包住真实视觉调用，任务中心可回看
    const { text } = opts.taskId != null
      ? await runObservedWork({
          taskId: opts.taskId,
          stage: 'junction_caption',
          sourceChars: question.length,
          sampleKey: buildSampleKey({ stage: 'junction_caption', configId: config.configId, model: config.model }),
          storyboardId,
          storyboardNumber: opts.storyboardNumber,
        }, call)
      : await call()
    const parsed = extractFirstJson(text)
    if ('error' in parsed) throw new Error(`模型返回无法解析为 JSON：${parsed.error}`)
    const raw = (parsed.json as Record<string, unknown>).caption
    const caption = typeof raw === 'string' ? raw.trim() : ''
    if (!caption) throw new Error('模型没有给出画面描述')
    await writeJunctionCaption(segment.id, {
      hash: junction.hash, caption, error: null, config_id: config.configId ?? null, model: config.model ?? null, at: now(),
    })
    return { hash: junction.hash, caption, note: null, called: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeJunctionCaption(segment.id, {
      hash: junction.hash, caption: null, error: message, config_id: config.configId ?? null, model: config.model ?? null, at: now(),
    })
    logTaskError('JunctionCaption', 'ensure', { storyboardId, error: message })
    return { hash: junction.hash, caption: null, note: `衔接帧画面描述不可用：${message}`, called: false }
  }
}

/** 批次话术里的一小段事实：锁定槽位 + 描述 + 该段不许切镜 */
export function lockedFramePromptHint(frame: LockedFrame): string {
  const first = frame.slot === 'first'
  const anchor = first
    ? '锁定衔接帧（C 组合）：本镜生成段的首帧 = 图层段末帧，这张衔接帧已锁定、不单独出图，视频第一帧就是它。'
    : '锁定衔接帧（D 组合）：本镜生成段的尾帧 = 图层段首帧，这张衔接帧已锁定、不单独出图，视频最后一帧就是它。'
  const caption = frame.caption
    ? `锁定画面：${frame.caption}`
    : `锁定画面描述不可用（${frame.caption_note || '尚未计算'}）：仍按衔接帧构图写，不要凭空描写画面里没有的东西。`
  const rule = first
    ? '第一段必须是 0-1 秒的空镜：只复述它的机位/景别/画面里有什么，静止或极缓推，不出现人物（不许 @ 角色）、不切镜、不做场景过渡（过渡为/叠化/dissolve 等）；人物入画、切镜与转场只能从第二段（1 秒以后）开始。'
    : '最后一段必须收束到这个画面（停在它的机位/景别/主体位置与光线），最后一段内不许切镜；切镜只能出现在更早的段落。'
  return `${anchor}\n${caption}\n${rule}`
}

// ─── 保存校验（AI 写入路径）──────────────────────────────────

/**
 * 时间分段行：`0-3秒：`、`0-2.5秒:`、`0-3s:`、`0–3 s：`、`0-3초:` 都算。行首的时间范围就是分段边界，
 * 模型按技能要求一行一段；找不到任何分段行说明格式不合规（校验无从下手）。
 * 起始/结束秒数要取出来：C 的首段必须 ≤1.5 秒，任何分段都不许是 0 长或倒序（`3-3秒`、`5-3秒`）。
 */
const SEGMENT_LINE = /^\s*[【\[]?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|~)\s*(\d+(?:\.\d+)?)\s*(?:秒|초|s|sec|seconds)?\s*[】\]]?\s*[:：]/

/**
 * 切镜写法（zh / en / ja / ko）。`切换为` 与 `切换到` 是同一个意思的两种写法，都收；
 * 只在这一条时间分段里找，不跨段。
 */
const CUT_PATTERNS: RegExp[] = [
  /切到/, /切回/, /切换为/, /切换到/, /转到/, /硬切/,
  /\bcut to\b/i, /\bcuts to\b/i,
  /カット/, /切り替え/,
  /컷/, /전환/,
]

/**
 * 场景过渡写法：画面「渐变」成另一处空间。它和切镜一样会让 H3 把第 0 帧画成第二处空间，
 * 衔接帧被整段替换；C 的首段只允许静止或极缓推。
 */
const TRANSITION_PATTERNS: RegExp[] = [
  /过渡为/, /过渡到/, /转入/, /化为/, /变为/, /叠化/,
  /\bdissolv(?:e|es|ed|ing)\b/i, /\btransition to\b/i, /\bmorphs? into\b/i,
  /ディゾルブ/, /移り変わ/,
  /디졸브/, /디졀브/, /바뀌어/,
]

/** C 的首段上限（秒）：第一段只复述空镜衔接帧，人物与转场必须落到第二段 */
const FIRST_SEGMENT_MAX_END = 1.5

function firstHit(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return null
}

interface PromptSegment {
  index: number
  /** 该段的起始秒数（时间范围左边） */
  start: number
  /** 该段的结束秒数（时间范围右边） */
  end: number
  /** 行首时间范围的原文（去掉冒号），退回信息里原样引用 */
  time: string
  /** 去掉时间前缀后的正文，含该段后续被折行的续行（遇到下一个分段行或空行结束） */
  body: string
}

function promptSegments(text: string): PromptSegment[] {
  const lines = text.split(/\r?\n/)
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) if (SEGMENT_LINE.test(lines[i])) starts.push(i)
  const startSet = new Set(starts)
  return starts.map((start, index) => {
    const matched = SEGMENT_LINE.exec(lines[start])!
    const body: string[] = [lines[start].replace(SEGMENT_LINE, '')]
    for (let i = start + 1; i < lines.length; i++) {
      if (startSet.has(i) || !lines[i].trim()) break
      body.push(lines[i])
    }
    return {
      index,
      start: Number(matched[1]),
      end: Number(matched[2]),
      time: matched[0].replace(/\s*[:：]\s*$/, '').trim(),
      body: body.join('\n'),
    }
  })
}

/** 本集可被 @ 的资产（名字 + 种类），C 首段据此判断有没有 @ 到角色 */
export interface PromptMentionAsset {
  kind: 'character' | 'scene' | 'prop'
  name: string
}

/**
 * 一段正文里 @ 到的角色：按资产名**最长优先**解析（与 `parseMentions` / 参考图装配同口径），
 * 场景与道具不算——首段照常 @ 场景。
 */
function mentionedCharacters(body: string, assets: PromptMentionAsset[]): string[] {
  const kindByName = new Map<string, string>()
  for (const asset of assets) {
    const name = (asset.name || '').trim()
    // 同名资产以先出现者为准（场景 → 角色 → 道具），与参考图编号同口径
    if (name && !kindByName.has(name)) kindByName.set(name, asset.kind)
  }
  return parseMentions(body, [...kindByName.keys()]).matched
    .filter(name => kindByName.get(name) === 'character')
}

/**
 * C 的首段必须是 0–1.5 秒的空镜（复述 caption、不许 @ 角色、不许切镜、不许场景过渡），D 的末段不许切镜；
 * 时间分段本身必须是正区间。A/B 与剧情镜头（无 combo）一律不校验。
 * 返回空数组 = 放行；否则每条是一句带 caption 的退回说明。
 */
export function junctionPromptReasons(
  text: string,
  slot: 'first' | 'last',
  caption: string | null,
  assets: PromptMentionAsset[] = [],
): string[] {
  const segments = promptSegments(text)
  const label = slot === 'first' ? '第一段' : '最后一段'
  const anchor = slot === 'first'
    ? '本镜是 C 组合：生成段的首帧由图层段末帧（衔接帧）锁定，视频必须从这张画面开始'
    : '本镜是 D 组合：生成段的尾帧由图层段首帧（衔接帧）锁定，视频必须收在这张画面'
  const captionLine = caption ? `锁定衔接帧的画面是：${caption}。` : '锁定衔接帧的画面描述当前不可用（见 read_storyboard_context 的 caption_note）。'
  if (!segments.length) {
    return [`视频提示词里找不到时间分段行（格式如「0-3秒：…」），无法确认${label}是否从锁定衔接帧继续。${anchor}；请按技能要求逐段写「0-3秒：」「3-6秒：」后重新调用 update_storyboard。`]
  }
  // 时间轴先要能读数：0 长或倒序的分段（`3-3秒`、`5-3秒`）说明模型没有按连续时间轴写
  const badRanges = segments.filter(segment => segment.end <= segment.start)
  if (badRanges.length) {
    return badRanges.map(segment => `${anchor}；时间分段「${segment.time}」的结束秒数必须大于起始秒数（分段要连续递进，如「0-1秒：」「1-4秒：」）。${captionLine}请改好时间范围后重新调用 update_storyboard。`)
  }
  const target = slot === 'first' ? segments[0] : segments[segments.length - 1]
  if (slot === 'last') {
    const hit = firstHit(CUT_PATTERNS, target.body)
    if (!hit) return []
    return [`${anchor}；${label}里出现切镜写法「${hit}」，视频模型会把它当成新镜头、丢掉衔接帧。${captionLine}请把最后一段写回收束到该画面（停在它的构图），把切镜挪到更早的段落后重新调用 update_storyboard。`]
  }
  const problems: string[] = []
  if (target.end > FIRST_SEGMENT_MAX_END) {
    problems.push(`首段是「${target.time}」、到 ${target.end} 秒才结束，必须 ≤1.5 秒（写成「0-1秒：」）`)
  }
  const characters = mentionedCharacters(target.body, assets)
  if (characters.length) {
    problems.push(`首段 @ 到了人物 ${characters.map(name => `@${name}`).join('、')}，而 C 的首帧是空镜衔接帧，人物只能从第二段起入画`)
  }
  const transition = firstHit(TRANSITION_PATTERNS, target.body)
  if (transition) problems.push(`首段出现场景过渡写法「${transition}」`)
  const cut = firstHit(CUT_PATTERNS, target.body)
  if (cut) problems.push(`首段出现切镜写法「${cut}」`)
  if (!problems.length) return []
  return [`${anchor}；${label}里${problems.join('；')}——H3 会把这段内容画在第 0 帧、把衔接帧整段替换掉。${captionLine}请把第一段写成 0-1 秒的空镜：只复述 caption 的机位/景别/画面与光线，静止或极缓推，不出现人物、不切镜、不转场；人物入画与转场放到第二段（切镜挪到第二段之后）后重新调用 update_storyboard。`]
}

/** 按分镜当前 combo、缓存的衔接帧描述与本集角色资产判断本次写入是否合规（不调模型） */
export async function junctionPromptRejections(storyboardId: number, videoPrompt: string): Promise<string[]> {
  const text = (videoPrompt || '').trim()
  if (!text) return []
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const slot = lockedGenSlot(toCombo(sb?.combo))
  if (!slot) return []
  const segment = await getLayerSegment(storyboardId)
  // C 的首段必须空镜：要知道哪些 @ 是本集的角色（场景/道具不算）
  const assets = sb ? await loadEpisodeAssets(sb.episodeId) : []
  return junctionPromptReasons(text, slot, junctionCaptionText(segment), assets)
}
