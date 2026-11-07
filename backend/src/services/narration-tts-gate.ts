/**
 * 当前有效配音（Issue #70）—— 纪录片「实测 TTS 是硬前置」的唯一判定实现。
 *
 * 新顺序是：最终剧本 → 逐镜旁白骨架 → 人工确认骨架 → 批量配音 → 按**实测时长**填设计卡。
 * 因此「这一镜现在有没有可用的配音」必须由一处回答，设计卡填写/确认与全部下游制作
 * （关键帧、图层段保存/渲染、视频提交、合成）共用同一份结论，不允许任何一条路径自己
 * 另算一套、或退回估算。
 *
 * 当前有效 = 下面七条同时成立：
 *   1. 本集开启旁白、本镜未被标记为纯画面；
 *   2. 旁白文本非空且 ≤80 个朗读字（TTS 单段硬上限）；
 *   3. 发音标记可解析（标记写错 = 合成出来的不是这段话）；
 *   4. 有音频元数据（从没配过音就不成立）；
 *   5. 元数据里的文本指纹 = 当前旁白文本指纹（改过字/改过标记就失效）；
 *   6. 当次合成用的参数 = 本镜**当前生效**的配音参数（换音色/步数/cfg/seed/风格/规范化都失效）；
 *   7. 音频文件在，且 ffprobe 实测出一个有限的正数时长。
 *
 * 第 7 条只认文件实测值：`narration_meta.audio.duration_ms` 是历史元数据，
 * 文件丢失/损坏时绝不拿它顶替当前事实。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { toAbsPath } from '../utils/paths.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { mediaFacts, type MediaFacts } from './media-probe.js'
import { parseTtsSettings, type TtsSettings } from './tts.js'
import { parseNarrationMarkup } from './narration-markup.js'
import {
  MAX_NARRATION_CHARS,
  narrationCharCount,
  parseNarrationMeta,
  resolveNarrationNormalize,
  sha256,
} from './narration.js'
import {
  paramsOfAudio,
  parseEpisodeVoiceSettings,
  resolveVoiceParams,
  sameVoiceParams,
  type VoiceParams,
} from './narration-voice-params.js'
import { resolveDramaProjectType } from './project-type.js'

type EpisodeRow = typeof schema.episodes.$inferSelect
type StoryboardRow = typeof schema.storyboards.$inferSelect

/** 本集生效的 TTS 配置：集锁定优先，其次当前启用的最高优先级配置 */
export async function resolveTtsConfig(episode: { ttsConfigId?: number | null }): Promise<AIConfig> {
  const locked = episode.ttsConfigId ? await getConfigById(episode.ttsConfigId) : null
  const config = locked || await getActiveConfig('tts')
  if (!config) {
    throw new Error('未配置语音合成（TTS）服务：请到「设置」页添加并启用一个语音合成配置后重试')
  }
  return config
}

/** 本镜生效的配音参数：集级 tts_settings → TTS 配置 → VoxCPM 默认；normalize 镜级覆盖 → 集级（#37） */
export function effectiveVoiceParams(
  ep: Pick<EpisodeRow, 'ttsSettings' | 'narrationNormalize'>,
  shotNormalize: boolean | null | undefined,
  config: AIConfig,
): VoiceParams {
  return resolveVoiceParams({
    episodeSettings: parseEpisodeVoiceSettings(ep.ttsSettings),
    configSettings: parseTtsSettings(config.settings),
    episodeNormalize: ep.narrationNormalize,
    shotNormalize,
  })
}

export const TTS_INVALID_REASONS = [
  'narration_disabled',
  'narration_empty',
  'narration_too_long',
  'markup_invalid',
  'audio_missing',
  'text_changed',
  'voice_params_changed',
  'audio_file_missing',
  'duration_invalid',
  'audio_no_stream',
  'tts_unavailable',
] as const
export type TtsInvalidReason = typeof TTS_INVALID_REASONS[number]

export interface ShotTtsValidity {
  storyboard_id: number
  storyboard_number: number
  valid: boolean
  reason: TtsInvalidReason | null
  message: string | null
  /** 当前音频文件的实测时长（毫秒）；只有 valid 时才有值 */
  duration_ms: number | null
  /** 实测秒数（一位小数），设计卡预算的唯一依据；只有 valid 时才有值 */
  duration_s: number | null
}

const MESSAGES: Record<TtsInvalidReason, string> = {
  narration_disabled: '本镜被标记为纯画面（或本集未开启旁白），没有旁白可配音',
  narration_empty: '本镜还没有旁白文本',
  narration_too_long: `本镜旁白超过语音合成单段上限 ${MAX_NARRATION_CHARS} 字：请先在旁白骨架里拆镜`,
  markup_invalid: '本镜的发音标记有误，无法合成',
  audio_missing: '本镜还没有生成配音',
  text_changed: '本镜旁白在配音之后被改过：旧音频不再是当前配音，请重新配音',
  voice_params_changed: '本镜当前生效的配音参数与旧音频不同：旧音频不再是当前配音，请重新配音',
  audio_file_missing: '本镜的配音文件不存在或无法读取：请重新配音',
  duration_invalid: '本镜的配音文件读不出有效时长：请重新配音',
  audio_no_stream: '本镜的配音文件里没有音轨（不是一段可播放的配音）：请重新配音',
  tts_unavailable: '未配置语音合成（TTS）服务：无法判断当前配音是否有效',
}

function invalid(sb: StoryboardRow, reason: TtsInvalidReason): ShotTtsValidity {
  return {
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    valid: false,
    reason,
    message: `#${String(sb.storyboardNumber).padStart(2, '0')} ${MESSAGES[reason]}`,
    duration_ms: null,
    duration_s: null,
  }
}

/** 文本/标记层面的前置（不碰文件，不需要 TTS 配置） */
function textReason(ep: EpisodeRow, sb: StoryboardRow): TtsInvalidReason | null {
  if (ep.narrationEnabled !== true || sb.narrationEnabled === false) return 'narration_disabled'
  const text = (sb.narrationText || '').trim()
  if (!text) return 'narration_empty'
  if (narrationCharCount(text) > MAX_NARRATION_CHARS) return 'narration_too_long'
  if (parseNarrationMarkup(text).errors.length) return 'markup_invalid'
  return null
}

async function evaluate(
  ep: EpisodeRow,
  sb: StoryboardRow,
  desired: VoiceParams | null,
  configSettings: TtsSettings | null,
): Promise<ShotTtsValidity> {
  const pre = textReason(ep, sb)
  if (pre) return invalid(sb, pre)
  const text = (sb.narrationText || '').trim()
  const meta = parseNarrationMeta(sb.narrationMeta)
  if (!meta.audio || !sb.narrationAudioUrl) return invalid(sb, 'audio_missing')
  if (meta.audio.text_sha256 !== sha256(text)) return invalid(sb, 'text_changed')
  if (!desired || !configSettings) return invalid(sb, 'tts_unavailable')
  const used = paramsOfAudio(meta.audio, configSettings)
  const want: VoiceParams = { ...desired, normalize: resolveNarrationNormalize(desired.normalize, sb.narrationNormalize) }
  if (!sameVoiceParams(used, want)) return invalid(sb, 'voice_params_changed')

  let facts: MediaFacts | null = null
  try {
    facts = await mediaFacts(toAbsPath(sb.narrationAudioUrl))
  } catch {
    facts = null
  }
  if (!facts) return invalid(sb, 'audio_file_missing')
  if (!Number.isFinite(facts.durationMs) || facts.durationMs <= 0) return invalid(sb, 'duration_invalid')
  // 可读 + 有时长还不够：必须真的是一段带音轨的音频（被换成视频/图片同样不算当前配音）
  if (!facts.hasAudio) return invalid(sb, 'audio_no_stream')

  return {
    storyboard_id: sb.id,
    storyboard_number: sb.storyboardNumber,
    valid: true,
    reason: null,
    message: null,
    duration_ms: facts.durationMs,
    duration_s: Math.round(facts.durationMs / 100) / 10,
  }
}



/** 本集逐镜的当前配音有效性（按 storyboard_id 索引）。非纪录片项目同样适用：口径只有一套。 */
export async function episodeTtsValidity(
  episodeId: number,
  opts: { rows?: StoryboardRow[]; episode?: EpisodeRow; storyboardIds?: number[] } = {},
): Promise<Map<number, ShotTtsValidity>> {
  const ep = opts.episode ?? (await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)))[0]
  const result = new Map<number, ShotTtsValidity>()
  if (!ep) return result
  const rows = (opts.rows ?? await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt)
    .filter(sb => !opts.storyboardIds || opts.storyboardIds.includes(sb.id))

  // TTS 配置取不到时不抛错：逐镜记 tts_unavailable，调用方照常得到「不可放行」的结论
  let desired: VoiceParams | null = null
  let configSettings: TtsSettings | null = null
  try {
    const config = await resolveTtsConfig(ep)
    configSettings = parseTtsSettings(config.settings)
    desired = effectiveVoiceParams(ep, null, config)
  } catch {
    desired = null
    configSettings = null
  }

  for (const sb of rows) {
    result.set(sb.id, await evaluate(ep, sb, desired, configSettings))
  }
  return result
}

/** 单镜的当前配音有效性；分镜不存在抛错 */
export async function shotTtsValidity(storyboardId: number): Promise<ShotTtsValidity> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
  if (!ep) throw new Error('剧集不存在')
  let desired: VoiceParams | null = null
  let configSettings: TtsSettings | null = null
  try {
    const config = await resolveTtsConfig(ep)
    configSettings = parseTtsSettings(config.settings)
    desired = effectiveVoiceParams(ep, null, config)
  } catch {
    desired = null
    configSettings = null
  }
  return evaluate(ep, sb, desired, configSettings)
}

export interface TtsBlockedShot {
  storyboard_id: number
  storyboard_number: number
  reason: TtsInvalidReason
  message: string
}

/**
 * 没有当前有效配音：由 `src/index.ts` 的全局 onError 统一转成
 * 400 `{code, error:'tts_required', message, blocked}`。
 */
export class TtsRequiredError extends Error {
  readonly blocked: TtsBlockedShot[]
  constructor(blocked: TtsBlockedShot[], message?: string) {
    const head = blocked[0]
    super(message || (blocked.length === 1 && head
      ? `${head.message}（纪录片要求先有当前有效配音，才能填写设计卡并进入制作）`
      : `${blocked.length} 个镜头还没有当前有效配音：纪录片要求先批量配音，再按实测时长填设计卡并进入制作`))
    this.name = 'TtsRequiredError'
    this.blocked = blocked
  }
}

export function toBlocked(item: ShotTtsValidity): TtsBlockedShot {
  return {
    storyboard_id: item.storyboard_id,
    storyboard_number: item.storyboard_number,
    reason: item.reason ?? 'audio_missing',
    message: item.message ?? MESSAGES[item.reason ?? 'audio_missing'],
  }
}

/**
 * 纪录片执行门禁：所选镜头必须全部有当前有效配音，否则抛 `TtsRequiredError`。
 * 剧情项目恒放行（它们没有这一步）。
 */
export async function assertShotsTtsReady(episodeId: number, storyboardIds: number[]): Promise<Map<number, ShotTtsValidity>> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const validity = await episodeTtsValidity(episodeId, { episode: ep, storyboardIds })
  if (resolveDramaProjectType(ep.dramaId) !== 'documentary') return validity
  const blocked: TtsBlockedShot[] = []
  for (const id of storyboardIds) {
    const item = validity.get(id)
    if (!item) continue
    if (!item.valid) blocked.push(toBlocked(item))
  }
  if (blocked.length) throw new TtsRequiredError(blocked)
  return validity
}

/** 单镜版本的执行门禁（关键帧/图层段/视频提交等逐镜入口共用） */
export async function assertShotTtsReady(storyboardId: number): Promise<ShotTtsValidity> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const validity = await assertShotsTtsReady(sb.episodeId, [storyboardId])
  return validity.get(storyboardId)!
}

/** 多镜查询的便捷包装（批量预览用，不抛错） */
export async function ttsValidityFor(storyboardIds: number[]): Promise<Map<number, ShotTtsValidity>> {
  const result = new Map<number, ShotTtsValidity>()
  if (!storyboardIds.length) return result
  const rows = await db.select().from(schema.storyboards).where(inArray(schema.storyboards.id, storyboardIds))
  const byEpisode = new Map<number, number[]>()
  for (const sb of rows) {
    const list = byEpisode.get(sb.episodeId) ?? []
    list.push(sb.id)
    byEpisode.set(sb.episodeId, list)
  }
  for (const [episodeId, ids] of byEpisode) {
    const part = await episodeTtsValidity(episodeId, { storyboardIds: ids })
    for (const [id, item] of part) result.set(id, item)
  }
  return result
}
