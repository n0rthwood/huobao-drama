/**
 * 旁白状态（Issue #30）—— storyboards.narration_meta 的唯一读写方。
 *
 * 设计对齐 #11 的 transition_review：一个 JSON blob 存本镜旁白链路的全部派生状态
 * （配音实测时长、字幕条数、合成签名），业务字段（文本/开关/音频地址）仍是独立列。
 *
 * 本文件只做纯函数 + blob 解析，不碰 ffmpeg、不发网络请求，便于单测。
 */
import crypto from 'crypto'

/** TTS 服务实测的单段字数硬上限（VoxCPM2 `limits.max_segment_chars`） */
export const MAX_NARRATION_CHARS = 80
/** 视频生成引擎的镜头时长上下限（与 adapters/comfyui-video.ts 的 clampDuration 对齐） */
export const MIN_SHOT_SECONDS = 4
export const MAX_SHOT_SECONDS = 15
/** 旁白说完后的默认尾部留白（秒）；#31 把它变成用户可选项 */
export const DEFAULT_TAIL_PAD_SECONDS = 0.8
/** 纪录片解说的语速区间（字/秒），用于字数预算与预计时长 */
export const NARRATION_CHARS_PER_SECOND = 4.5
export const NARRATION_CPS_MIN = 3.8
export const NARRATION_CPS_MAX = 5.1

export interface NarrationAudioMeta {
  duration_ms: number
  chars: number
  voice: string | null
  seed: number | null
  job_id: string | null
  provider: string
  config_id: number | null
  generated_at: string
  text_sha256: string
}

/** 字幕时间码模式（#30 Q10）：sentence = 分句边界（默认），char = 逐字时间戳 */
export type SubtitleTiming = 'sentence' | 'char'
export const DEFAULT_SUBTITLE_TIMING: SubtitleTiming = 'sentence'

export interface NarrationSubtitleMeta {
  cues: number
  /** 实际采用的时间码来源；对齐数据取不到时为 proportional_fallback */
  source: 'sentence' | 'char' | 'proportional_fallback'
  /** 请求的模式（便于 UI 说明「请求 sentence，实际回退估算」） */
  timing: SubtitleTiming
  generated_at: string
}

export interface NarrationComposedMeta {
  video_src: string
  audio_src: string | null
  subtitle_src: string | null
  burned: boolean
  duration_ms: number
  signature: string
  composed_at: string
  /** 合成采用的转场偏移量 T（秒）与它的来源 */
  transition_t: number
  transition_t_source: 'task' | 'review' | 'none'
}

export interface NarrationMeta {
  text_sha256?: string
  audio?: NarrationAudioMeta
  subtitle?: NarrationSubtitleMeta
  composed?: NarrationComposedMeta
}

/** 旁白链路对外状态（服务端算好，前端不自己推） */
export type NarrationStatus =
  | 'disabled'
  | 'missing'
  | 'text_only'
  | 'voiced'
  | 'voice_stale'
  | 'composed'
  | 'compose_stale'

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export function parseNarrationMeta(raw: string | null | undefined): NarrationMeta {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as NarrationMeta
  } catch {
    return {}
  }
}

/** 有效字数：忽略空白，标点计入（TTS 的 max_segment_chars 按原文字符数算） */
export function narrationCharCount(text: string | null | undefined): number {
  return (text || '').replace(/\s+/g, '').length
}

/** 按 4.5 字/秒估算的预计配音时长（秒），用于还没配音时的 UI 展示与拆分镜时的时长估算 */
export function estimateNarrationSeconds(text: string | null | undefined): number {
  const chars = narrationCharCount(text)
  if (!chars) return 0
  return Math.round((chars / NARRATION_CHARS_PER_SECOND) * 10) / 10
}

/** 某段时长下建议的旁白字数上限（取语速上限，再受 TTS 单段 80 字约束） */
export function suggestedCharsFor(seconds: number): number {
  const byRate = Math.floor(Math.max(0, seconds) * NARRATION_CPS_MAX)
  return Math.max(0, Math.min(byRate, MAX_NARRATION_CHARS))
}

/** 配音是否过期：文本改过但没重新配音 */
export function isVoiceStale(text: string | null | undefined, meta: NarrationMeta): boolean {
  if (!meta.audio) return false
  return meta.audio.text_sha256 !== sha256(text || '')
}

/**
 * 合成签名：画面 + 旁白音频 + 字幕 + 是否烧录 + 旁白文本 + 匹配参数（#31）。
 * 所有落盘媒体文件名都是 uuid（utils/storage.ts），重生成必然换路径，所以 URL 入签可靠。
 */
export function composeSignature(input: {
  videoUrl: string
  audioUrl: string | null
  subtitleUrl: string | null
  burned: boolean
  textSha256: string
  /** #31 的生效匹配参数（留白/倍速/音轨模式）序列化后的稳定字符串，无则空串 */
  fitKey?: string
}): string {
  return sha256([
    input.videoUrl,
    input.audioUrl || '',
    input.subtitleUrl || '',
    input.burned ? '1' : '0',
    input.textSha256,
    input.fitKey || '',
  ].join('\u0000'))
}

export interface NarrationStatusInput {
  episodeNarrationEnabled: boolean
  shotNarrationEnabled: boolean
  narrationText: string | null | undefined
  narrationAudioUrl: string | null | undefined
  videoUrl: string | null | undefined
  composedVideoUrl: string | null | undefined
  subtitleUrl: string | null | undefined
  meta: NarrationMeta
  /** #31 的生效匹配参数键，参与合成过期判定 */
  fitKey?: string
}

export function narrationStatus(input: NarrationStatusInput): NarrationStatus {
  if (!input.episodeNarrationEnabled) return 'disabled'
  // 纯画面镜头：仍要走合成（去掉模型音轨），所以合成状态照常判定
  const wantsVoice = input.shotNarrationEnabled
  const text = (input.narrationText || '').trim()

  if (input.composedVideoUrl && input.meta.composed) {
    const expected = composeSignature({
      videoUrl: input.videoUrl || '',
      audioUrl: wantsVoice ? (input.narrationAudioUrl || null) : null,
      subtitleUrl: wantsVoice ? (input.subtitleUrl || null) : null,
      burned: wantsVoice,
      textSha256: sha256(wantsVoice ? text : ''),
      fitKey: input.fitKey,
    })
    if (expected === input.meta.composed.signature) return 'composed'
    return 'compose_stale'
  }

  if (!wantsVoice) return text ? 'text_only' : 'missing'
  if (!text) return 'missing'
  if (!input.narrationAudioUrl || !input.meta.audio) return 'text_only'
  if (isVoiceStale(text, input.meta)) return 'voice_stale'
  return 'voiced'
}

export interface NarrationBlockIssue {
  code: 'narration_too_long' | 'narration_voice_stale'
  severity: 'block'
  message: string
  fields: string[]
}

/**
 * 旁白侧的阻断问题（与 storyboard-assets 的 ref_issues 同形状，直接并进那条展示链路）。
 * - `narration_too_long`：字数超 TTS 单段上限，或「实测配音 + 尾部留白」超过 15 秒内容段预算
 * - `narration_voice_stale`：文本改过、配音未重生成
 */
export function narrationIssues(input: {
  episodeNarrationEnabled: boolean
  shotNarrationEnabled: boolean
  narrationText: string | null | undefined
  meta: NarrationMeta
  tailPadSeconds?: number
}): NarrationBlockIssue[] {
  if (!input.episodeNarrationEnabled || !input.shotNarrationEnabled) return []
  const issues: NarrationBlockIssue[] = []
  const text = (input.narrationText || '').trim()
  if (!text) return issues
  const chars = narrationCharCount(text)
  const tailPad = input.tailPadSeconds ?? DEFAULT_TAIL_PAD_SECONDS

  if (chars > MAX_NARRATION_CHARS) {
    issues.push({
      code: 'narration_too_long',
      severity: 'block',
      message: `旁白 ${chars} 字，超过语音合成单段上限 ${MAX_NARRATION_CHARS} 字：请改写精简到 ${MAX_NARRATION_CHARS} 字以内`,
      fields: ['narration_text'],
    })
  } else if (input.meta.audio && !isVoiceStale(text, input.meta)) {
    const budget = input.meta.audio.duration_ms / 1000 + tailPad
    if (budget > MAX_SHOT_SECONDS + 1e-6) {
      issues.push({
        code: 'narration_too_long',
        severity: 'block',
        message: `实测配音 ${(input.meta.audio.duration_ms / 1000).toFixed(1)} 秒 + 尾部留白 ${tailPad} 秒 = ${budget.toFixed(1)} 秒，超过镜头上限 ${MAX_SHOT_SECONDS} 秒：请改写旁白文本（建议 ≤${suggestedCharsFor(MAX_SHOT_SECONDS - tailPad)} 字），或用倍速匹配贴合画面`,
        fields: ['narration_text'],
      })
    }
  }

  if (isVoiceStale(text, input.meta)) {
    issues.push({
      code: 'narration_voice_stale',
      severity: 'block',
      message: '旁白文本已修改，配音尚未重新生成',
      fields: ['narration_text'],
    })
  }
  return issues
}

/** 配音生成成功后回写的内容段时长（秒）：不含转场 T，由视频提交时再加一次 */
export function durationFromAudio(durationMs: number, tailPadSeconds = DEFAULT_TAIL_PAD_SECONDS): number {
  const seconds = Math.ceil(durationMs / 1000 + tailPadSeconds)
  return Math.max(MIN_SHOT_SECONDS, Math.min(MAX_SHOT_SECONDS, seconds))
}
