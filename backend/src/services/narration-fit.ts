/**
 * 旁白与画面的时长匹配（Issue #30 的默认口径 + Issue #31 的用户可选项）。
 *
 * 纯函数，不碰数据库也不碰 ffmpeg：30% 规则与 15 秒上限只在这里实现一次。
 * `Dv` / `Da` 一律由调用方用 ffprobe 实测后传入——生成引擎的请求时长与产出时长有偏差，
 * 用请求时长算可用时长会把误差直接灌进合成结果。
 */
import { MAX_NARRATION_CHARS, MAX_SHOT_SECONDS, MIN_SHOT_SECONDS, NARRATION_CPS_MAX } from './narration.js'

/** 某段可用时长下建议的旁白字数上限（语速上限，再受 TTS 单段 80 字约束） */
export function suggestedCharsForAvail(availSeconds: number): number {
  return Math.max(0, Math.min(Math.floor(Math.max(0, availSeconds) * NARRATION_CPS_MAX), MAX_NARRATION_CHARS))
}

/** 允许的变速区间：与目标时长差距 ≤30%（用户确认 #30 Q9 / #31 Q4） */
export const MAX_TEMPO = 1.3
export const MIN_TEMPO = 1 / 1.3
/** 混音模式下模型音轨的默认增益（dB，#31 Q1 推荐值） */
export const DEFAULT_BED_GAIN_DB = -18
/** 留白可调上限（秒，#31 Q2 推荐值） */
export const MAX_PAD_SECONDS = 3

/**
 * 合成被阻断（#31）：带结构化字段，路由原样返回给前端渲染
 * 「当前 X.X 秒 / 可用 Y.Y 秒 / 超出 Z% / 建议 ≤N 字」，前端不解析中文文案。
 * 与 `planCompose` 同模块：阻断口径只有这一处，状态计算与真正合成抛的是同一个错。
 */
export class ComposeBlockedError extends Error {
  readonly blockReason: NonNullable<ComposePlan['blockReason']>
  readonly gapRatio: number
  readonly currentSec: number
  readonly availSec: number
  readonly suggestedChars: number

  constructor(plan: ComposePlan, shotNumber: number) {
    const gapPercent = Math.round(Math.abs(plan.gapRatio) * 100)
    const suggested = suggestedCharsForAvail(plan.availSeconds)
    super(plan.blockReason === 'narration_gap_too_large'
      ? `分镜 #${shotNumber} 的旁白比画面可用时长${plan.gapRatio > 0 ? '长' : '短'} ${gapPercent}%，超过 30% 的调速上限：请改写旁白文本（建议 ≤${suggested} 字）`
      : `分镜 #${shotNumber} 的旁白（${plan.daScaled.toFixed(1)} 秒）放不进 ${plan.availSeconds.toFixed(1)} 秒可用时长（转场 ${plan.t} 秒）：请改写旁白文本（建议 ≤${suggested} 字）或提高倍速匹配`)
    this.name = 'ComposeBlockedError'
    this.blockReason = plan.blockReason ?? 'narration_too_long'
    this.gapRatio = plan.gapRatio
    this.currentSec = plan.daScaled
    this.availSec = plan.availSeconds
    this.suggestedChars = suggested
  }
}

/** 合成时的匹配参数（#30 只用默认值，#31 把它接到用户可选项上） */
export interface ComposeFit {
  /** 匹配方式：pad = 留白，tempo = 倍速贴合（30% 闸只对 tempo 生效） */
  mode?: 'pad' | 'tempo'
  /** 旁白前的留白（秒） */
  padHeadSeconds: number
  /** 旁白后的留白（秒） */
  padTailSeconds: number
  /** 旁白变速倍率（>1 = 加快）；1 = 不变速 */
  tempo: number
  /** 模型自带音轨：replace = 丢弃，mix = 压成底音 */
  audioMixMode: 'replace' | 'mix'
  /** 混音模式下底音增益（dB，负值） */
  bedGainDb: number
  /** 参与合成签名的稳定键；变更即让该镜「合成已过期」 */
  key: string
}

export const DEFAULT_COMPOSE_FIT: ComposeFit = {
  padHeadSeconds: 0,
  padTailSeconds: 0.8,
  tempo: 1,
  audioMixMode: 'replace',
  bedGainDb: DEFAULT_BED_GAIN_DB,
  key: '',
}

export interface ComposePlan {
  /** 画面实测时长（秒） */
  dv: number
  /** 旁白实测时长（秒，变速前） */
  da: number
  /** 变速后的旁白时长（秒） */
  daScaled: number
  /** 转场偏移（秒） */
  t: number
  /** 目标成片时长（秒） */
  d: number
  /** 旁白起播点（秒） = T + 头部留白 */
  narrationStart: number
  /** 画面不足时要冻结末帧的秒数 */
  freezeSeconds: number
  /** 画面是否需要裁尾 */
  trim: boolean
  /** 画面可用于旁白的时长（秒） = min(Dv, 15) − T */
  availSeconds: number
  /** 旁白与可用时长的差距；正 = 旁白偏长，负 = 旁白偏短 */
  gapRatio: number
  /** 是否阻断（阻断优先于裁剪，旁白永不被截断） */
  blocked: boolean
  blockReason: 'narration_too_long' | 'narration_gap_too_large' | null
}

/**
 * 由实测时长与匹配参数算出合成计划。
 * 总则：**阻断优先于裁剪** —— 画面不够长就冻结末帧，旁白不够短就让用户提速或改文本，
 * 任何分支都不得为了凑时长截断旁白音频。
 *
 * `maxSeconds` 默认 `MAX_SHOT_SECONDS=15`（模型视频镜头）；整镜由确定性片段替代的
 * 镜头传 `MAX_CLIP_SECONDS=30`（用户确认 #44 Q5）——15 秒是生成模型的约束，
 * 确定性渲染没有这个限制。
 */
export function planCompose(input: {
  dv: number
  da: number | null
  t: number
  fit: ComposeFit
  maxSeconds?: number
}): ComposePlan {
  const { dv, t, fit } = input
  const maxSeconds = input.maxSeconds ?? MAX_SHOT_SECONDS
  const availSeconds = Math.max(0, Math.min(dv, maxSeconds) - t)

  if (input.da === null) {
    // 无旁白镜头：画面原样输出，只替换音轨
    return {
      dv, da: 0, daScaled: 0, t, d: dv, narrationStart: 0,
      freezeSeconds: 0, trim: false, availSeconds, gapRatio: 0,
      blocked: false, blockReason: null,
    }
  }

  const tempo = fit.tempo > 0 ? fit.tempo : 1
  const daScaled = input.da / tempo
  const gapRatio = availSeconds > 0 ? (input.da - availSeconds) / availSeconds : 1
  const content = Math.max(fit.padHeadSeconds + daScaled + fit.padTailSeconds, MIN_SHOT_SECONDS)
  const d = Math.min(t + content, maxSeconds)

  // 旁白说完的时间点必须落在上限内（尾部留白可以被压缩，语音不可以）
  const speechEnd = t + fit.padHeadSeconds + daScaled
  let blocked = speechEnd > maxSeconds + 1e-6
  let blockReason: ComposePlan['blockReason'] = blocked ? 'narration_too_long' : null
  // 30% 规则的唯一实现点：倍速模式下旁白比可用时长长出 >30% 时只能改文本
  // （偏短方向是常态，用户确认 Q5：不拦，钳到 1/1.3 后余量走留白）
  if (!blocked && fit.mode === 'tempo' && gapRatio > 0.3 + 1e-9) {
    blocked = true
    blockReason = 'narration_gap_too_large'
  }
  // 变速后仍放不下（手调了不贴合的倍率）→ 阻断，绝不 atrim 截断旁白
  if (!blocked && daScaled > availSeconds + 1e-6) {
    blocked = true
    blockReason = 'narration_too_long'
  }
  return {
    dv,
    da: input.da,
    daScaled,
    t,
    d,
    narrationStart: t + fit.padHeadSeconds,
    freezeSeconds: Math.max(0, d - dv),
    trim: dv > d + 1e-6,
    availSeconds,
    gapRatio,
    blocked,
    blockReason,
  }
}

/** 本镜的匹配方式（#31）：pad = 留白，tempo = 倍速贴合 */
export type FitMode = 'pad' | 'tempo'

/** 存库形状（episodes.narration_fit_default / storyboards.narration_fit） */
export interface NarrationFitRecord {
  mode: FitMode
  pad_ms?: number
  pad_position?: 'head' | 'tail'
  /** 用户手调的倍率；留空 = 合成时按实测 Da/Davail 现算 */
  tempo_override?: number
  audio_mix_mode?: 'replace' | 'mix'
  updated_at?: string
}

export const DEFAULT_FIT_RECORD: NarrationFitRecord = {
  mode: 'pad',
  pad_ms: 800,
  pad_position: 'tail',
}

export function parseFitRecord(raw: string | null | undefined): NarrationFitRecord | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const mode = record.mode === 'tempo' ? 'tempo' : 'pad'
    const out: NarrationFitRecord = { mode }
    if (Number.isFinite(record.pad_ms)) out.pad_ms = Number(record.pad_ms)
    if (record.pad_position === 'head' || record.pad_position === 'tail') out.pad_position = record.pad_position
    if (Number.isFinite(record.tempo_override)) out.tempo_override = Number(record.tempo_override)
    if (record.audio_mix_mode === 'mix' || record.audio_mix_mode === 'replace') out.audio_mix_mode = record.audio_mix_mode
    if (typeof record.updated_at === 'string') out.updated_at = record.updated_at
    return out
  } catch {
    return null
  }
}

/** 校验用户提交的匹配参数；返回中文错误信息，合法时返回 null */
export function validateFitRecord(record: NarrationFitRecord): string | null {
  if (record.pad_ms !== undefined) {
    if (!Number.isFinite(record.pad_ms) || record.pad_ms < 0 || record.pad_ms > MAX_PAD_SECONDS * 1000) {
      return `留白长度必须在 0 到 ${MAX_PAD_SECONDS} 秒之间`
    }
  }
  if (record.tempo_override !== undefined) {
    const tempo = record.tempo_override
    if (!Number.isFinite(tempo) || tempo < MIN_TEMPO - 1e-6 || tempo > MAX_TEMPO + 1e-6) {
      return `倍速必须在 ${MIN_TEMPO.toFixed(2)} 到 ${MAX_TEMPO.toFixed(2)} 之间（与目标时长差距不超过 30%）`
    }
  }
  return null
}

/**
 * 把「集级默认 + 镜级覆盖 + 实测时长」解析成合成用的 ComposeFit。
 * 倍速默认不持久化：`mode='tempo'` 且没有 tempo_override 时按当时实测 Da/Davail 现算，
 * 所以旁白重新配音后自动跟上（用户确认 #31 Q3）。
 *
 * `key` 是并进合成签名的生效参数键（#42）：只收录**真正影响本镜产出**的参数。
 * 纯画面镜头的留白/倍速、替代模式下的底音增益都不进入输出，改了它们不应让成片失效。
 * 源视频没有音轨时混音无底音可混，这里就地降级为替代——降级后的模式入键，
 * 保证「状态计算」与「真正合成」看到同一套参数，不会刚合成就被判过期。
 */
export function resolveComposeFit(input: {
  episodeDefault: string | null | undefined
  shotFit: string | null | undefined
  episodeMixMode: string | null | undefined
  episodeBedGainDb: number | null | undefined
  /** 实测旁白时长（秒）；没有配音时传 null */
  da: number | null
  /** 画面可用时长（秒） = min(Dv, 15) − T */
  availSeconds: number
  /** 源视频是否带音轨（实测）；false 时混音模式降级为替代 */
  videoHasAudio: boolean
}): ComposeFit & { mode: FitMode } {
  const record = parseFitRecord(input.shotFit)
    || parseFitRecord(input.episodeDefault)
    || DEFAULT_FIT_RECORD
  const padMs = record.pad_ms ?? DEFAULT_FIT_RECORD.pad_ms!
  const padHead = record.pad_position === 'head' ? padMs / 1000 : 0
  const padTail = record.pad_position === 'head' ? 0 : padMs / 1000

  let tempo = 1
  if (record.mode === 'tempo') {
    tempo = record.tempo_override
      ?? (input.da && input.availSeconds > 0 ? input.da / input.availSeconds : 1)
    tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, tempo))
  }

  const requestedMixMode = record.audio_mix_mode
    ?? (input.episodeMixMode === 'mix' ? 'mix' : 'replace')
  const audioMixMode = requestedMixMode === 'mix' && !input.videoHasAudio ? 'replace' : requestedMixMode
  const bedGainDb = Number.isFinite(input.episodeBedGainDb)
    ? Number(input.episodeBedGainDb)
    : DEFAULT_BED_GAIN_DB

  const narrated = input.da !== null
  const keyParts: unknown[] = [audioMixMode]
  if (audioMixMode === 'mix') keyParts.push(bedGainDb)
  if (narrated) keyParts.push(record.mode, padHead, padTail, record.tempo_override ?? null)

  return {
    mode: record.mode,
    padHeadSeconds: padHead,
    padTailSeconds: padTail,
    tempo,
    audioMixMode,
    bedGainDb,
    key: JSON.stringify(keyParts),
  }
}
