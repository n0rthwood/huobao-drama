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
 * 配音请求体。
 * - 绝不含 speed —— VoxCPM2 实测拒绝变速，倍速匹配在合成阶段用 atempo 做。
 * - normalize（#35）：服务端的文本规范化，把 1720 年 / 5月8日 / 189人 展开成读法。
 *   不传时服务端默认 false，1720 会被念错，所以这里总是显式传。
 */
export function buildSpeechBody(text: string, settings: TtsSettings, normalize: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { input: text, response_format: 'wav', normalize }
  if (settings.voice) body.voice = settings.voice
  if (settings.seed !== null) body.seed = settings.seed
  if (settings.instructions) body.instructions = settings.instructions
  if (settings.cfgValue !== null) body.cfg_value = settings.cfgValue
  if (settings.inferenceTimesteps !== null) body.inference_timesteps = settings.inferenceTimesteps
  return body
}

/**
 * 合成一段旁白并落盘。
 * 整镜一次合成（不按句分段），所以单镜文本必须在服务端单段上限内，超限由调用方提前阻断。
 */
export async function synthesizeNarration(
  config: AIConfig & { settings?: string | null },
  text: string,
  /** 文本规范化（#35）：把 1720年 / 5月8日 / 189人 展开成读法；集级默认开，镜级可覆盖 */
  normalize: boolean,
): Promise<SynthesisResult> {
  const provider = (config.provider || '').toLowerCase()
  if (provider !== 'voxcpm') throw new Error(`不支持的语音合成服务：${config.provider || '(未配置)'}`)

  const settings = parseTtsSettings(config.settings)
  // 不带 voice 时服务端会用随机音色，整集听感会漂；音色必须由人在设置页选定（#35）
  if (!settings.voice) {
    throw new Error('该语音合成配置还没有选定音色：请到「设置 → AI 服务」编辑这条 TTS 配置，在「音色」里选一个再保存')
  }
  const url = joinProviderUrl(config.baseUrl, '', '/v1/audio/speech')
  logTaskProgress('TTS', 'synthesize-begin', { provider, chars: text.length, voice: settings.voice, normalize })

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(buildSpeechBody(text, settings, normalize)),
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

  return { wavPath, durationMs, jobId, voice: settings.voice, seed: settings.seed, provider }
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
