/**
 * 旁白状态（Issue #30）—— storyboards.narration_meta 的唯一读写方。
 *
 * 设计对齐 #11 的 transition_review：一个 JSON blob 存本镜旁白链路的全部派生状态
 * （配音实测时长、字幕条数、合成签名），业务字段（文本/开关/音频地址）仍是独立列。
 *
 * 本文件只做纯函数 + blob 解析，不碰 ffmpeg、不发网络请求，便于单测。
 */
import crypto from 'crypto'
import type { VoiceParams } from './narration-voice-params.js'
import { parseNarrationMarkup, pauseSeconds, phonemeDisablesNormalize, spokenText } from './narration-markup.js'

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
  /** 本次合成实际请求的参数（#37）；更早的音频没有，比较时按当时事实重建（narration-voice-params.ts） */
  params?: VoiceParams
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

/**
 * 合成产物记录。`inputs` 是合成当时真正生效的输入分项快照（#42），
 * `signature_version` 标出快照格式：版本不一致的旧记录只能判「无法比较」，
 * 绝不能当成「最新」回填。
 */
export interface NarrationComposedMeta {
  video_src: string
  audio_src: string | null
  subtitle_src: string | null
  burned: boolean
  duration_ms: number
  signature: string
  signature_version?: number
  inputs?: ComposeInputParts
  composed_at: string
  /** 合成采用的转场偏移量 T（秒）与它的来源 */
  transition_t: number
  transition_t_source: 'task' | 'review' | 'none'
}

/** 一段确定性片段在快照里的身份：渲染产物路径 + 渲染签名（#50） */
export interface ComposeClipPart {
  src: string
  signature: string
}

/** 影响本镜产出的输入分项（#42）：合成、状态计算、批量预览、导出校验共用同一份口径 */
export interface ComposeInputParts {
  /** 当前采用的画面文件（uuid 文件名，重生成必然换路径） */
  video_src: string
  /** 参与合成的旁白音频；纯画面镜头为 null */
  audio_src: string | null
  /** 参与烧录的字幕文件；不烧录为 null */
  subtitle_src: string | null
  /** 字幕是否真的被烧进画面 */
  burned: boolean
  /** 旁白文本哈希；纯画面镜头为空串的哈希 */
  text_sha256: string
  /** 生效的匹配参数键（留白/倍速/音轨模式/底音增益中真正生效的部分） */
  fit_key: string
  /** 生效的转场偏移 T（秒）；纯画面镜头不做偏移，恒为 0 */
  transition_t: number
  /**
   * 确定性片段（#50）：三个位置各一项，`{ src, signature }`，没有片段为 null。
   * `replace` 时 `video_src` 指向片段文件本身；`pre`/`post` 时 `video_src` 仍是模型视频，
   * 所以**必须**把片段单独记进快照——否则只换片段不换模型视频就看不出变化。
   * v2 快照没有这三项（读出来是 undefined），按 null 比较。
   */
  replace_clip?: ComposeClipPart | null
  pre_clip?: ComposeClipPart | null
  post_clip?: ComposeClipPart | null
}

export interface NarrationMeta {
  text_sha256?: string
  audio?: NarrationAudioMeta
  subtitle?: NarrationSubtitleMeta
  composed?: NarrationComposedMeta
}

/** 配音侧状态：文本写了没、配音生成了没、是否被文本改动作废 */
export type NarrationVoiceStatus =
  | 'disabled'
  | 'missing'
  | 'text_only'
  | 'voiced'
  | 'voice_stale'

/** 对外的旁白链路状态（服务端算好，前端不自己推）：配音侧状态 + 合成是否最新 */
export type NarrationStatus = NarrationVoiceStatus | 'composed' | 'compose_stale'

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

/** 有效字数：按念出来的纯文字算（发音标记不计，#38），忽略空白，标点计入 */
export function narrationCharCount(text: string | null | undefined): number {
  return spokenText(text).replace(/\s+/g, '').length
}

/** 按 4.5 字/秒估算的预计配音时长（秒）+ 精确停顿（#38），用于还没配音时的 UI 展示与拆分镜时的时长估算 */
export function estimateNarrationSeconds(text: string | null | undefined): number {
  const chars = narrationCharCount(text)
  if (!chars) return 0
  return Math.round((chars / NARRATION_CHARS_PER_SECOND + pauseSeconds(text)) * 10) / 10
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
 * 旁白**配音侧**的状态（#42 起只管文本/配音，不再自行推断合成新鲜度）。
 * 合成是否最新由 compose-state 的输入快照比较得出，再由它合成最终对外状态，
 * 避免同一个判断在两处用不同的输入各算一遍。
 */
export interface NarrationStatusInput {
  episodeNarrationEnabled: boolean
  shotNarrationEnabled: boolean
  narrationText: string | null | undefined
  narrationAudioUrl: string | null | undefined
  meta: NarrationMeta
}

export function narrationStatus(input: NarrationStatusInput): NarrationVoiceStatus {
  if (!input.episodeNarrationEnabled) return 'disabled'
  const text = (input.narrationText || '').trim()
  // 纯画面镜头：没有配音链路，有没有文本只决定展示，不影响合成
  if (!input.shotNarrationEnabled) return text ? 'text_only' : 'missing'
  if (!text) return 'missing'
  if (!input.narrationAudioUrl || !input.meta.audio) return 'text_only'
  if (isVoiceStale(text, input.meta)) return 'voice_stale'
  return 'voiced'
}

export interface NarrationBlockIssue {
  code: 'narration_too_long' | 'narration_voice_stale' | 'narration_markup_invalid' | 'narration_phoneme_no_normalize'
  severity: 'block' | 'warn'
  message: string
  fields: string[]
}

/**
 * 旁白侧的问题（与 storyboard-assets 的 ref_issues 同形状，直接并进那条展示链路）。
 * - `narration_too_long`：字数超 TTS 单段上限，或「实测配音 + 尾部留白」超过 15 秒内容段预算
 * - `narration_voice_stale`：文本改过、配音未重生成
 * - `narration_markup_invalid`（#38）：发音标记写错，阻断配音
 * - `narration_phoneme_no_normalize`（#38，警告）：有拼音注音 + 阿拉伯数字 + 规范化开，VoxCPM 会关掉规范化
 */
export function narrationIssues(input: {
  episodeNarrationEnabled: boolean
  shotNarrationEnabled: boolean
  narrationText: string | null | undefined
  meta: NarrationMeta
  tailPadSeconds?: number
  /** 本镜生效的文本规范化（#35）；不传则不检查规范化相关警告 */
  normalize?: boolean
}): NarrationBlockIssue[] {
  if (!input.episodeNarrationEnabled || !input.shotNarrationEnabled) return []
  const issues: NarrationBlockIssue[] = []
  const text = (input.narrationText || '').trim()
  if (!text) return issues
  for (const err of parseNarrationMarkup(text).errors) {
    issues.push({ code: 'narration_markup_invalid', severity: 'block', message: `发音标记有误：${err.message}`, fields: ['narration_text'] })
  }
  if (input.normalize && phonemeDisablesNormalize(text)) {
    issues.push({
      code: 'narration_phoneme_no_normalize',
      severity: 'warn',
      message: '本镜有拼音注音，语音服务会因此关闭文本规范化，阿拉伯数字将按字面念：数字处的多音字请改用同音字注音',
      fields: ['narration_text'],
    })
  }
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

/**
 * 生效的文本规范化（#35）：镜级覆盖（null = 继承）> 集级默认（默认开）。
 * 开启后 TTS 会把 1720年 / 5月8日 / 189人 展开成读法；关闭则按字面念。
 */
export function resolveNarrationNormalize(
  episodeNormalize: boolean | null | undefined,
  shotNormalize: boolean | null | undefined,
): boolean {
  if (shotNormalize === true || shotNormalize === false) return shotNormalize
  return episodeNormalize !== false
}
