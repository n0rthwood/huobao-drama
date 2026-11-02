/**
 * 语音合成（TTS）服务 — Issue #30
 *
 * adapter 边界就是本文件导出的 `synthesizeNarration()`：目前只有 `voxcpm` 一个 provider
 * （用户确认 Q13），新增 provider 只在这里加分支，调用方（旁白配音、合成）不变。
 *
 * 服务地址与参数属版本库外配置，存在 ai_service_configs(service_type='tts') 行里。
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { ffmpeg } from '../utils/ffmpeg.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { joinProviderUrl } from './adapters/url.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import type { AIConfig } from './ai.js'
import type { VoiceParams } from './narration-voice-params.js'

/** 旁白音频/字幕的落盘子目录 */
export const NARRATION_SUBDIR = 'narration'

export interface TtsSettings {
  /** 整集复用的音色（Q11：TTS 服务默认音色，配置保存时固定） */
  voice: string | null
  seed: number | null
  instructions: string | null
  cfgValue: number | null
  inferenceTimesteps: number | null
}

export function parseTtsSettings(settingsRaw: string | null | undefined): TtsSettings {
  const empty: TtsSettings = { voice: null, seed: null, instructions: null, cfgValue: null, inferenceTimesteps: null }
  if (!settingsRaw) return empty
  try {
    const s = JSON.parse(settingsRaw) || {}
    return {
      voice: typeof s.voice === 'string' && s.voice.trim() ? s.voice.trim() : null,
      seed: Number.isFinite(s.seed) ? Number(s.seed) : null,
      instructions: typeof s.instructions === 'string' && s.instructions.trim() ? s.instructions.trim() : null,
      cfgValue: Number.isFinite(s.cfg_value) ? Number(s.cfg_value) : null,
      inferenceTimesteps: Number.isFinite(s.inference_timesteps) ? Number(s.inference_timesteps) : null,
    }
  } catch {
    return empty
  }
}

export interface SynthesisResult {
  /** 相对路径 static/narration/<uuid>.wav */
  wavPath: string
  durationMs: number
  jobId: string | null
  voice: string | null
  seed: number | null
  provider: string
}

/** ffprobe 实测时长（毫秒）；生成引擎的请求时长不可信，所有时长一律实测 */
export function probeDurationMs(absPath: string): Promise<number> {
  // 本仓 tsconfig 的 lib 低于 es2024，没有 Promise.withResolvers，这里只能用 executor 形式
  return new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(absPath, (err, data) => {
      if (err) return reject(err)
      const seconds = Number(data?.format?.duration)
      if (!Number.isFinite(seconds)) return reject(new Error(`无法读取音视频时长：${absPath}`))
      resolve(Math.round(seconds * 1000))
    })
  })
}

/**
 * 列出该 TTS 服务可用的音色（#35）。
 * VoxCPM Studio 的 `GET /v1/audio/voices` 返回 `{voices: string[]}`（按创建时间倒序），
 * 没有「默认项」概念 —— 列表首项曾经是英文女声，拿它当默认会把整集中文纪录片配错音色，
 * 所以这里只负责把完整列表交给设置页，由人明确选定。
 */
export async function fetchVoices(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = joinProviderUrl(baseUrl, '', '/v1/audio/voices')
  const resp = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`读取音色列表失败：HTTP ${resp.status}`)
  const data = await resp.json() as { voices?: unknown }
  return Array.isArray(data?.voices) ? data.voices.filter(v => typeof v === 'string') as string[] : []
}

/**
 * VoxCPM Studio 的完整音色条目（`GET /api/voices`，带分类标签），供配音弹窗分组展示（#37）。
 * 这是 Studio 自有接口（非 OpenAI 兼容），TTS 目前只有 voxcpm 一个 provider。
 */
export async function fetchVoiceItems(baseUrl: string, apiKey?: string): Promise<{ name: string; tags?: unknown; created_at?: string }[]> {
  const url = joinProviderUrl(baseUrl, '', '/api/voices')
  const resp = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`读取音色列表失败：HTTP ${resp.status}`)
  const data: unknown = await resp.json()
  const items = data && typeof data === 'object' && 'items' in data && Array.isArray(data.items) ? data.items : []
  return items.filter((v): v is { name: string; tags?: unknown; created_at?: string } =>
    !!v && typeof v === 'object' && 'name' in v && typeof v.name === 'string')
}

/**
 * 配音请求体（#37：参数全部显式传，取值由 narration-voice-params.ts 解析）。
 * - 绝不含 speed —— VoxCPM2 实测拒绝变速，倍速匹配在合成阶段用 atempo 做。
 * - normalize（#35）：服务端的文本规范化，把 1720 年 / 5月8日 / 189人 展开成读法；服务端默认 false。
 * - seed 为 null 时不传 = 服务端随机。
 */
export function buildSpeechBody(text: string, params: VoiceParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: text,
    response_format: 'wav',
    voice: params.voice,
    normalize: params.normalize,
    cfg_value: params.cfg_value,
    inference_timesteps: params.inference_timesteps,
  }
  if (params.seed !== null) body.seed = params.seed
  if (params.instructions) body.instructions = params.instructions
  return body
}

/**
 * 合成一段旁白并落盘。
 * 整镜一次合成（不按句分段），所以单镜文本必须在服务端单段上限内，超限由调用方提前阻断。
 */
export async function synthesizeNarration(
  config: AIConfig,
  text: string,
  params: VoiceParams,
): Promise<SynthesisResult> {
  const provider = (config.provider || '').toLowerCase()
  if (provider !== 'voxcpm') throw new Error(`不支持的语音合成服务：${config.provider || '(未配置)'}`)

  // 不带 voice 时服务端会用随机音色，整集听感会漂；音色必须由人选定（#35）
  if (!params.voice) {
    throw new Error('还没有选定音色：请在配音弹窗里选一个音色，或到「设置 → AI 服务」给这条 TTS 配置选定音色')
  }
  const url = joinProviderUrl(config.baseUrl, '', '/v1/audio/speech')
  logTaskProgress('TTS', 'synthesize-begin', { provider, chars: text.length, ...params })

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(buildSpeechBody(text, params)),
      signal: AbortSignal.timeout(600_000),
    })
  } catch (err) {
    logTaskError('TTS', 'synthesize', { error: err instanceof Error ? err.message : String(err) })
    throw new Error(`语音合成服务不可达：${err instanceof Error ? err.message : String(err)}`)
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`语音合成失败（HTTP ${resp.status}）：${detail.slice(0, 300) || '无响应内容'}`)
  }

  const bytes = Buffer.from(await resp.arrayBuffer())
  if (!bytes.length) throw new Error('语音合成返回空音频')

  const dir = path.join(STORAGE_ROOT, NARRATION_SUBDIR)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${uuid()}.wav`
  fs.writeFileSync(path.join(dir, filename), bytes)
  const wavPath = `static/${NARRATION_SUBDIR}/${filename}`

  const durationMs = await probeDurationMs(path.join(dir, filename))
  const jobId = resp.headers.get('x-job-id')
  logTaskSuccess('TTS', 'synthesize', { wavPath, durationMs, jobId: jobId || undefined })

  return { wavPath, durationMs, jobId, voice: params.voice, seed: params.seed, provider }
}

/**
 * 让 VoxCPM Studio 按它自己的规则解析一段文本（`POST /api/markup/preview`，#38）：
 * 返回它认出的「念出来的字」与解析错误，合成前用来确认标记转换没有歧义。
 */
export async function previewMarkup(config: AIConfig, text: string): Promise<{ spoken: string; errors: string[] }> {
  const resp = await fetch(joinProviderUrl(config.baseUrl, '', '/api/markup/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`语音服务标记预检失败：HTTP ${resp.status}`)
  const data: unknown = await resp.json()
  if (!data || typeof data !== 'object' || !('spoken' in data) || typeof data.spoken !== 'string') {
    throw new Error('语音服务标记预检返回格式异常')
  }
  const errors = 'errors' in data && Array.isArray(data.errors) ? data.errors.map(String) : []
  return { spoken: data.spoken, errors }
}

/**
 * VoxCPM Studio 的标记目录（`GET /api/markup/catalog`）：语气标签（含中文名与分组）与常见多音字候选，
 * 供旁白编辑器的「语气」「注音」弹窗使用（#38）。
 */
export async function fetchMarkupCatalog(config: AIConfig): Promise<{
  tags: { tag: string; label: string; group: string }[]
  polyphones: Record<string, [string, string][]>
}> {
  const resp = await fetch(joinProviderUrl(config.baseUrl, '', '/api/markup/catalog'), {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) throw new Error(`读取语音服务的标记目录失败：HTTP ${resp.status}`)
  const data: unknown = await resp.json()
  const tags = data && typeof data === 'object' && 'tags' in data && Array.isArray(data.tags) ? data.tags : []
  const polyphones = data && typeof data === 'object' && 'polyphones' in data && data.polyphones && typeof data.polyphones === 'object'
    ? data.polyphones as Record<string, [string, string][]> // Studio presets/polyphones.json：{字: [[拼音, 例词]]}
    : {}
  return {
    tags: tags.filter((t): t is { tag: string; label: string; group: string } =>
      !!t && typeof t === 'object' && 'tag' in t && typeof t.tag === 'string' && 'label' in t && typeof t.label === 'string'),
    polyphones,
  }
}

export interface AlignItem {
  start: number
  end: number
  text: string
}
/**
 * 读取某次合成 job 的逐字对齐数据（`GET <base>/api/jobs/<job_id>/timestamps?level=char`）。
 *
 * 服务端只支持 `level=word|char`（实测 `level=sentence` → `400 {"detail":"level 只能是 word 或 char"}`），
 * 所以**两种字幕模式都走逐字对齐**：sentence 模式由 `buildSubtitleCues` 把逐字时间戳按句聚合。
 * 一次失败后重试一次（对齐器可能还在落盘）；仍失败返回 null，由字幕生成回落按字数比例分配。
 */
export async function fetchCharAlign(
  config: AIConfig,
  jobId: string,
  attempts = 2,
): Promise<AlignItem[] | null> {
  // joinProviderUrl 把整段写进 url.pathname，查询串里的 ? 会被百分号编码进路径（实测 404），
  // 所以路径与查询分开拼
  const url = `${joinProviderUrl(config.baseUrl, '', `/api/jobs/${encodeURIComponent(jobId)}/timestamps`)}?level=char`
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(300_000),
      })
      if (!resp.ok) {
        logTaskProgress('TTS', 'align-unavailable', { jobId, attempt: String(attempt), status: String(resp.status) })
      } else {
        const data = await resp.json() as { items?: unknown }
        const items = Array.isArray(data?.items) ? data.items : []
        const parsed: AlignItem[] = []
        for (const raw of items) {
          const item = raw as { start?: unknown; end?: unknown; text?: unknown }
          if (!Number.isFinite(item?.start) || !Number.isFinite(item?.end)) continue
          parsed.push({ start: Number(item.start), end: Number(item.end), text: String(item.text ?? '') })
        }
        if (parsed.length) return parsed
        logTaskProgress('TTS', 'align-empty', { jobId, attempt: String(attempt) })
      }
    } catch (err) {
      logTaskProgress('TTS', 'align-failed', { jobId, attempt: String(attempt), error: err instanceof Error ? err.message : String(err) })
    }
  }
  return null
}
