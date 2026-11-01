/**
 * 旁白与画面的时长匹配（Issue #30 的默认口径 + Issue #31 的用户可选项）。
 *
 * 纯函数，不碰数据库也不碰 ffmpeg：30% 规则与 15 秒上限只在这里实现一次。
 * `Dv` / `Da` 一律由调用方用 ffprobe 实测后传入——生成引擎的请求时长与产出时长有偏差，
 * 用请求时长算可用时长会把误差直接灌进合成结果。
 */
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from './narration.js'

/** 允许的变速区间：与目标时长差距 ≤30%（用户确认 #30 Q9 / #31 Q4） */
export const MAX_TEMPO = 1.3
export const MIN_TEMPO = 1 / 1.3
/** 混音模式下模型音轨的默认增益（dB，#31 Q1 推荐值） */
export const DEFAULT_BED_GAIN_DB = -18
/** 留白可调上限（秒，#31 Q2 推荐值） */
export const MAX_PAD_SECONDS = 3

/** 合成时的匹配参数（#30 只用默认值，#31 把它接到用户可选项上） */
export interface ComposeFit {
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
 */
export function planCompose(input: {
  dv: number
  da: number | null
  t: number
  fit: ComposeFit
}): ComposePlan {
  const { dv, t, fit } = input
  const availSeconds = Math.max(0, Math.min(dv, MAX_SHOT_SECONDS) - t)

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
  const d = Math.min(t + content, MAX_SHOT_SECONDS)

  // 旁白说完的时间点必须落在 15 秒内（尾部留白可以被压缩，语音不可以）
  const speechEnd = t + fit.padHeadSeconds + daScaled
  const blocked = speechEnd > MAX_SHOT_SECONDS + 1e-6
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
    blockReason: blocked ? 'narration_too_long' : null,
  }
}
