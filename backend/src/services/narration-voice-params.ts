/**
 * 旁白配音参数（Issue #37）—— 弹窗选项、生效参数解析与「已变化」判断的唯一实现。
 *
 * 参数来源优先级：集级 `episodes.tts_settings` → TTS 配置行 settings → VoxCPM 默认值；
 * 文本规范化沿用 #35：镜级覆盖 → 集级 `episodes.narration_normalize`。
 * 合成模型（#108）只取 TTS 配置行的模型列表首项（空 = voxcpm2），不进集级设置、不由弹窗提交。
 * 本文件只有纯函数，不碰数据库与网络，便于单测。
 */
import type { TtsSettings } from './tts.js'
import type { NarrationAudioMeta } from './narration.js'
import { resolveNarrationNormalize, sha256 } from './narration.js'

/** VoxCPM Studio `common.build_params` 的范围与默认值 */
export const VOXCPM_STEPS = { min: 2, max: 30, default: 10 }
export const VOXCPM_CFG = { min: 1, max: 3, default: 2 }
/** Studio 合成台的三个质量预设与实测 RTF（4070；`static/core.js RTF_TABLE`） */
export const VOXCPM_STEP_PRESETS = [
  { steps: 4, rtf: 0.35 },
  { steps: 10, rtf: 0.49 },
  { steps: 30, rtf: 0.93 },
] as const

/** VoxCPM Studio `v1/audio/speech` 认的模型名（#108）；请求体总是显式带上，不依赖 Studio 端默认 */
export const TTS_MODELS = ['voxcpm2', 'cosyvoice3'] as const
export type TtsModel = typeof TTS_MODELS[number]
export const DEFAULT_TTS_MODEL: TtsModel = 'voxcpm2'
export const TTS_MODEL_LABELS: Record<TtsModel, string> = { voxcpm2: 'VoxCPM2', cosyvoice3: 'CosyVoice3' }
/** CosyVoice3 的 RTF：2026-11-16 .202 RTX 4070 实测热生成 0.31–0.35（91 条试听批次）；不随步数变化 */
export const COSYVOICE3_RTF = 0.35

/** 与 Studio `app/tts_models.py ALIASES` 同口径的别名（如老配置/测试里填的 `voxcpm`） */
const TTS_MODEL_ALIASES: Record<string, TtsModel> = {
  voxcpm2: 'voxcpm2', voxcpm: 'voxcpm2', 'voxcpm-2': 'voxcpm2',
  cosyvoice3: 'cosyvoice3', cosyvoice: 'cosyvoice3', 'cosyvoice-3': 'cosyvoice3', cv3: 'cosyvoice3',
  'fun-cosyvoice3': 'cosyvoice3', 'fun-cosyvoice3-0.5b-2512': 'cosyvoice3',
}

/** 配置行模型（`AIConfig.model` = 模型列表首项）→ 规范模型名；空 = voxcpm2，不认识的名字抛错 */
export function ttsModelOf(model: string | null | undefined): TtsModel {
  const m = (model || '').trim().toLowerCase()
  if (!m) return DEFAULT_TTS_MODEL
  const hit = TTS_MODEL_ALIASES[m]
  if (hit) return hit
  throw new Error(`不支持的语音合成模型：${model}（只支持 ${TTS_MODELS.join(' / ')}）`)
}

/** 一次合成实际请求的参数（seed 为 null = 每次随机） */
export interface VoiceParams {
  /** 合成模型（#108）：来自 TTS 配置行 */
  model: TtsModel
  voice: string
  inference_timesteps: number
  cfg_value: number
  seed: number | null
  instructions: string
  normalize: boolean
}

/** 集级保存的部分（规范化单独存 narration_normalize；模型属于配置行，不在集级保存） */
export type EpisodeVoiceSettings = Omit<VoiceParams, 'normalize' | 'model'>

/** 步数 → RTF（与 Studio 相同的分段线性插值） */
export function rtfForSteps(steps: number): number {
  const s = Number(steps) || VOXCPM_STEPS.default
  const table = VOXCPM_STEP_PRESETS
  if (s <= table[0].steps) return table[0].rtf
  if (s >= table[table.length - 1].steps) return table[table.length - 1].rtf
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i]
    const b = table[i + 1]
    if (s >= a.steps && s <= b.steps) return a.rtf + ((b.rtf - a.rtf) * (s - a.steps)) / (b.steps - a.steps)
  }
  return 0.49
}

function clamp(value: unknown, lo: number, hi: number): number | null {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(hi, Math.max(lo, n))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `episodes.tts_settings` 原值 → 已保存的部分（缺项/坏值视为未设置） */
export function parseEpisodeVoiceSettings(raw: string | null | undefined): Partial<EpisodeVoiceSettings> {
  if (!raw) return {}
  let s: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    s = parsed as Record<string, unknown>
  } catch {
    return {}
  }
  const out: Partial<EpisodeVoiceSettings> = {}
  if (text(s.voice)) out.voice = text(s.voice)
  const steps = clamp(s.inference_timesteps, VOXCPM_STEPS.min, VOXCPM_STEPS.max)
  if (steps !== null) out.inference_timesteps = Math.round(steps)
  const cfg = clamp(s.cfg_value, VOXCPM_CFG.min, VOXCPM_CFG.max)
  if (cfg !== null) out.cfg_value = cfg
  if ('seed' in s) out.seed = Number.isInteger(s.seed) ? Number(s.seed) : null
  if ('instructions' in s) out.instructions = text(s.instructions)
  return out
}

/**
 * 本镜生效参数：每项依次取 集级 → TTS 配置 → VoxCPM 默认；normalize = 镜级覆盖 → 集级；model = 配置行（#108）。
 * 音色没有默认值（#35：必须由人选定），缺失时返回空串，由调用方报错。
 */
export function resolveVoiceParams(input: {
  model: TtsModel
  episodeSettings: Partial<EpisodeVoiceSettings>
  configSettings: TtsSettings
  episodeNormalize: boolean | null | undefined
  shotNormalize: boolean | null | undefined
}): VoiceParams {
  const ep = input.episodeSettings
  const cfg = input.configSettings
  return {
    model: input.model,
    voice: ep.voice ?? cfg.voice ?? '',
    inference_timesteps: ep.inference_timesteps ?? cfg.inferenceTimesteps ?? VOXCPM_STEPS.default,
    cfg_value: ep.cfg_value ?? cfg.cfgValue ?? VOXCPM_CFG.default,
    seed: ep.seed !== undefined ? ep.seed : cfg.seed,
    instructions: ep.instructions ?? cfg.instructions ?? '',
    normalize: resolveNarrationNormalize(input.episodeNormalize, input.shotNormalize),
  }
}

export class VoiceSettingsError extends Error {}

/**
 * 弹窗提交的参数 → 合法化后的完整参数。范围钳制到 VoxCPM 的区间；
 * 音色必须在服务端当前的音色列表里（传入 null 表示不校验，仅供单测）。
 * model 不接受弹窗提交，由调用方按 TTS 配置行传入（#108）。
 */
export function sanitizeVoiceSettings(raw: unknown, voices: string[] | null, model: TtsModel): VoiceParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VoiceSettingsError('配音参数格式不正确')
  const s = raw as Record<string, unknown>
  const voice = text(s.voice)
  if (!voice) throw new VoiceSettingsError('请选择音色')
  if (voices && !voices.includes(voice)) throw new VoiceSettingsError(`音色不存在：${voice}（请刷新音色列表后重选）`)
  const steps = clamp(s.inference_timesteps, VOXCPM_STEPS.min, VOXCPM_STEPS.max)
  const cfg = clamp(s.cfg_value, VOXCPM_CFG.min, VOXCPM_CFG.max)
  let seed: number | null = null
  if (s.seed !== null && s.seed !== undefined && s.seed !== '') {
    const n = Number(s.seed)
    if (!Number.isInteger(n) || n < 0) throw new VoiceSettingsError('seed 必须是非负整数，留空表示随机')
    seed = n
  }
  return {
    model,
    voice,
    inference_timesteps: Math.round(steps ?? VOXCPM_STEPS.default),
    cfg_value: Math.round((cfg ?? VOXCPM_CFG.default) * 10) / 10,
    seed,
    instructions: text(s.instructions),
    normalize: s.normalize === true,
  }
}

export function episodeSettingsOf(params: VoiceParams): EpisodeVoiceSettings {
  const { normalize: _normalize, model: _model, ...rest } = params
  return rest
}

/**
 * 已生成音频当时用的参数。#37 之后记在 `meta.audio.params`；更早的音频按当时的事实重建：
 * 音色/seed 取 meta.audio，normalize=false（#35 之前从未发送；宁多配不漏配），
 * 步数/cfg/风格取当前 TTS 配置（缺省 = VoxCPM 默认）。
 * #108 之前的 params 没有 model：火宝当时只调用 Studio 默认模型 = VoxCPM2。
 */
export function paramsOfAudio(audio: NarrationAudioMeta, configSettings: TtsSettings): VoiceParams {
  if (audio.params) return { ...audio.params, model: audio.params.model ?? DEFAULT_TTS_MODEL }
  return {
    model: DEFAULT_TTS_MODEL,
    voice: audio.voice || '',
    inference_timesteps: configSettings.inferenceTimesteps ?? VOXCPM_STEPS.default,
    cfg_value: configSettings.cfgValue ?? VOXCPM_CFG.default,
    seed: audio.seed ?? null,
    instructions: configSettings.instructions ?? '',
    normalize: false,
  }
}

/** CosyVoice3 不使用步数/cfg/风格描述/规范化（Studio 忽略），只比较 model/voice/seed，改那些参数不触发重配（#108） */
export function sameVoiceParams(a: VoiceParams, b: VoiceParams): boolean {
  const ma = a.model ?? DEFAULT_TTS_MODEL
  const mb = b.model ?? DEFAULT_TTS_MODEL
  if (ma !== mb || a.voice !== b.voice || a.seed !== b.seed) return false
  if (ma === 'cosyvoice3') return true
  return a.inference_timesteps === b.inference_timesteps
    && Math.abs(a.cfg_value - b.cfg_value) < 1e-6
    && a.instructions === b.instructions
    && a.normalize === b.normalize
}

export type VoicePlanStatus = 'missing' | 'changed' | 'unchanged' | 'skipped'

/**
 * 批量配音的逐镜分类（preview 与执行共用）：
 * - skipped：纯画面 / 没有旁白 / 阻断（超长等）
 * - missing：还没有配音
 * - changed：旁白原文变了，或已生成音频的参数与本次要用的参数不同
 * - unchanged：其余
 */
export function classifyVoiceShot(input: {
  narrationEnabled: boolean
  text: string
  blocked: boolean
  audio: NarrationAudioMeta | undefined
  desired: VoiceParams
  configSettings: TtsSettings
}): VoicePlanStatus {
  const textValue = input.text.trim()
  if (!input.narrationEnabled || !textValue || input.blocked) return 'skipped'
  if (!input.audio) return 'missing'
  if (input.audio.text_sha256 !== sha256(textValue)) return 'changed'
  return sameVoiceParams(paramsOfAudio(input.audio, input.configSettings), input.desired) ? 'unchanged' : 'changed'
}

/** VoxCPM Studio `/api/voices` 条目 → 弹窗分组（与 Studio 的「我的音色」+「预置 · 分类」一致） */
export interface VoiceOption { name: string; group: string }
export function groupVoices(items: { name: string; tags?: unknown; created_at?: string }[]): VoiceOption[] {
  const PRESET = '预置'
  const tagsOf = (v: { tags?: unknown }) => (Array.isArray(v.tags) ? v.tags.filter(t => typeof t === 'string') as string[] : [])
  const mine = items.filter(v => !tagsOf(v).includes(PRESET)).map(v => ({ name: v.name, group: '我的音色' }))
  const presets = items
    .filter(v => tagsOf(v).includes(PRESET))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map(v => ({ name: v.name, group: `预置 · ${tagsOf(v).find(t => t !== PRESET) || '其他'}` }))
  // 同一分组连在一起，分组按首次出现的顺序
  const order: string[] = []
  for (const v of presets) if (!order.includes(v.group)) order.push(v.group)
  return [...mine, ...order.flatMap(g => presets.filter(v => v.group === g))]
}
