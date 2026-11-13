/**
 * h3-central（.102 双卡 MiniMax-H3 视频任务队列）HTTP 客户端，公共 API 契约 v1。
 *
 * 形态与图片的 qwen-jobs 一致：应用只传参数不传工作流，队列自己调度两张卡、记录按时长分桶的实测耗时。
 *   契约核对:   GET  /healthz                          -> { service:'h3-central', version:'1', … }
 *   上传图片:   POST /v1/files (multipart file)        -> { id: "file_…" }（同内容去重）
 *   建任务:     POST /v1/jobs + Idempotency-Key        -> 202 任务对象（同 key 同体重放，异体 409）
 *   批量查询:   GET  /v1/jobs?ids=a,b,c（≤100）        -> { data: [job…] }
 *   取消/删除:  POST /v1/jobs/{id}/cancel、DELETE /v1/jobs/{id}
 *   取件:       GET  /v1/jobs/{id}/outputs/{n}         -> video/mp4；全部取回后服务端立即删除（再取 410）
 *   概览/估计:  GET  /v1/queue、GET /v1/estimate
 * base URL 为队列地址（loopback，无鉴权）；api_key 非空时按网关 Basic 携带，与 qwen-jobs 同口径。
 */
import { createHash } from 'node:crypto'
import type { AIConfig } from './types'

/** 队列契约：客户端依赖的字段以本文件的类型为准，队列改字段必须同步改这里 */
export const H3_CONTRACT_SERVICE = 'h3-central'
export const H3_CONTRACT_VERSION = '1'
/** 批量查询一次最多 100 个 id */
export const H3_JOBS_IDS_CHUNK = 100
/** 参考图上限（契约 reference_images 1..9） */
export const H3_MAX_REFS = 9

export type H3JobMode = 't2v' | 'firstlast' | 'reference'
export type H3JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type H3QueueModel = 'minimax-h3-int8' | 'minimax-h3-fasth3-omni-int8'

export interface H3JobRequest {
  mode: H3JobMode
  model: H3QueueModel
  prompt: string
  width: number
  height: number
  duration_seconds: number
  seed?: number
  first_frame?: string
  mid_frame?: { file: string; time_seconds: number }
  last_frame?: string
  reference_images?: string[]
  metadata?: Record<string, string | number>
}

export interface H3JobQueueInfo {
  position: number
  length: number
  estimated_start_seconds: number | null
}

export interface H3JobProgress {
  phase: string
  step?: number | null
  total_steps?: number | null
  fraction: number
  elapsed_seconds: number
  remaining_seconds: number | null
}

export interface H3JobEstimate {
  run_seconds: number
  basis: string
  samples: number
  duration_key: number
}

export interface H3Job {
  id: string
  status: H3JobStatus
  input?: Partial<H3JobRequest> & { steps?: number; seed?: number }
  duration_key?: number
  queue: H3JobQueueInfo | null
  progress: H3JobProgress | null
  estimate: H3JobEstimate | null
  estimated_finish_seconds: number | null
  cancel_requested: boolean
  outputs?: { index: number; url: string; content_type: string; width: number; height: number; bytes: number; duration_seconds?: number }[]
  outputs_deleted?: boolean
  error?: { code: string; message: string } | null
}

export interface H3QueueEntry {
  job_id: string | null
  client: string
  mine: boolean
  mode: H3JobMode
  duration_key: number
  started_at?: string
  progress?: H3JobProgress | null
  position?: number
  estimated_start_seconds?: number | null
  estimated_finish_seconds: number | null
}

export interface H3QueueOverview {
  counts: { running: number; queued: number }
  running: H3QueueEntry[]
  queued: H3QueueEntry[]
  workers: { total: number; idle: number; busy: number; offline: number }
  estimated_wait_seconds: number
}

export interface H3EstimateResult {
  duration_key: number
  run_seconds: number
  basis: string
  samples: number
  queue_wait_seconds: number
  estimated_finish_seconds: number
}

/** 远端返回的非 2xx：status 用于区分终态（404/409/410/422）与可重试的网络/5xx/429 */
export class H3JobsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'H3JobsError'
  }

  /** 网络中断、5xx、429 queue_full：任务仍然有效，下一轮按同一请求体与幂等键重发 */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

/** 队列公平调度与任务/文件归属用的客户端身份（契约沿用 qwen 队列的头名） */
const H3_CLIENT_ID = 'huobao'

/** 火宝配置里的模型显示名 → 队列模型 id（未知模型报错，不静默降级） */
const QUEUE_MODELS: Record<string, H3QueueModel> = {
  'minimax-h3-int8-comfyui': 'minimax-h3-int8',
  'minimax-h3-int8': 'minimax-h3-int8',
  'minimax-h3-fasth3-omni-int8': 'minimax-h3-fasth3-omni-int8',
}

export function h3QueueModel(model: string | null | undefined): H3QueueModel {
  const queueModel = QUEUE_MODELS[(model || '').trim().toLowerCase()]
  if (!queueModel) {
    throw new Error(`H3 视频队列不支持该模型：${model || '（空）'}（可用：MiniMax-H3-INT8-ComfyUI、MiniMax-H3-FastH3-Omni-INT8）`)
  }
  return queueModel
}

function baseOf(config: AIConfig): string {
  return config.baseUrl.replace(/\/+$/, '')
}

async function toError(resp: Response): Promise<H3JobsError> {
  const text = await resp.text().catch(() => '')
  let code = 'http_error'
  let message = text.slice(0, 300)
  try {
    const parsed = JSON.parse(text)
    if (parsed?.error?.code) code = String(parsed.error.code)
    if (parsed?.error?.message) message = String(parsed.error.message)
  } catch {
    // 非 JSON（反代 502 的 HTML 页面）：保留截断文本
  }
  return new H3JobsError(resp.status, code, `h3-jobs ${resp.status} ${code}: ${message}`)
}

async function request(
  config: AIConfig,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit; timeoutMs?: number } = {},
): Promise<Response> {
  const auth: Record<string, string> = config.apiKey
    ? { Authorization: `Basic ${Buffer.from(config.apiKey, 'utf8').toString('base64')}` }
    : {}
  let resp: Response
  try {
    resp = await fetch(`${baseOf(config)}${path}`, {
      method: init.method || 'GET',
      headers: { 'X-Qwen-Client': H3_CLIENT_ID, ...auth, ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
  } catch (err) {
    throw new H3JobsError(0, 'network_error', `h3-jobs 网络错误: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!resp.ok) throw await toError(resp)
  return resp
}

/** 已核对过契约版本的队列地址（进程内）；核对失败不缓存，下次提交重新核对 */
const verifiedBases = new Set<string>()

/**
 * 契约版本核对：service 与 version 不符即抛终态错误（任务失败，不降级）；
 * 网络/5xx 抛可重试的 H3JobsError，由调用方按暂时性故障处理。
 */
export async function assertH3Contract(config: AIConfig): Promise<void> {
  const base = baseOf(config)
  if (verifiedBases.has(base)) return
  const resp = await request(config, '/healthz', { timeoutMs: 15_000 })
  const health = (await resp.json()) as { service?: unknown; version?: unknown }
  if (health.service !== H3_CONTRACT_SERVICE || String(health.version) !== H3_CONTRACT_VERSION) {
    throw new Error(
      `视频队列契约版本不匹配（期望 ${H3_CONTRACT_SERVICE} v${H3_CONTRACT_VERSION}，实际 ${String(health.service)} v${String(health.version)}），请更新火宝或队列`,
    )
  }
  verifiedBases.add(base)
}

/** 进程内 sha256 → file id 缓存：同一组参考图跨任务只上传一次 */
const fileIdCache = new Map<string, string>()

/** 服务端回收了未被引用的文件（422 unknown file）：按 file id 清掉缓存，下一次提交重新上传 */
export function evictH3FileIds(ids: readonly string[]): number {
  let removed = 0
  if (!ids.length) return removed
  const drop = new Set(ids)
  for (const [key, value] of fileIdCache) {
    if (!drop.has(value)) continue
    fileIdCache.delete(key)
    removed++
  }
  return removed
}

/** 上传一张图片（data URL / http(s)），返回服务端 file id */
export async function uploadH3File(config: AIConfig, source: string): Promise<string> {
  let bytes: Buffer
  let mime = 'image/png'
  const dataUrl = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(source)
  if (dataUrl) {
    mime = dataUrl[1]!
    bytes = dataUrl[2] ? Buffer.from(dataUrl[3]!, 'base64') : Buffer.from(decodeURIComponent(dataUrl[3]!))
  } else if (/^https?:\/\//.test(source)) {
    const resp = await fetch(source, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) throw new Error(`参考图下载失败 ${resp.status}: ${source}`)
    mime = resp.headers.get('content-type')?.split(';')[0] || mime
    bytes = Buffer.from(await resp.arrayBuffer())
  } else {
    throw new Error(`参考图无法读取: ${source.slice(0, 80)}`)
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const cacheKey = `${baseOf(config)}|${config.apiKey}|${sha256}`
  const cached = fileIdCache.get(cacheKey)
  if (cached) return cached

  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `ref_${sha256.slice(0, 16)}.${ext}`)
  const resp = await request(config, '/v1/files', { method: 'POST', body: form, timeoutMs: 120_000 })
  const uploaded = (await resp.json()) as { id?: string }
  if (!uploaded.id) throw new Error('h3-jobs 上传响应缺少 file id')
  fileIdCache.set(cacheKey, uploaded.id)
  return uploaded.id
}

/** 请求体里引用的全部 file id（422 时按此清缓存） */
export function h3RequestFileIds(body: H3JobRequest): string[] {
  return [
    body.first_frame,
    body.mid_frame?.file,
    body.last_frame,
    ...(body.reference_images ?? []),
  ].filter((id): id is string => !!id)
}

export async function createH3Job(config: AIConfig, body: H3JobRequest, idempotencyKey: string): Promise<H3Job> {
  const resp = await request(config, '/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
    timeoutMs: 60_000,
  })
  return (await resp.json()) as H3Job
}

export async function listH3Jobs(config: AIConfig, ids: string[]): Promise<H3Job[]> {
  if (!ids.length) return []
  const resp = await request(config, `/v1/jobs?ids=${encodeURIComponent(ids.join(','))}`)
  const parsed = (await resp.json()) as { data?: H3Job[] }
  return parsed.data ?? []
}

export async function cancelH3Job(config: AIConfig, id: string): Promise<H3Job> {
  const resp = await request(config, `/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  return (await resp.json()) as H3Job
}

export async function deleteH3Job(config: AIConfig, id: string): Promise<void> {
  await request(config, `/v1/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 取回输出视频字节（必须先落盘再标完成：服务端在全部取回后立即删除文件） */
export async function downloadH3Output(config: AIConfig, jobId: string, index: number): Promise<Buffer> {
  const resp = await request(config, `/v1/jobs/${encodeURIComponent(jobId)}/outputs/${index}`, { timeoutMs: 300_000 })
  return Buffer.from(await resp.arrayBuffer())
}

export async function getH3Queue(config: AIConfig): Promise<H3QueueOverview> {
  const resp = await request(config, '/v1/queue', { timeoutMs: 15_000 })
  return (await resp.json()) as H3QueueOverview
}

export async function getH3Estimate(
  config: AIConfig,
  params: { mode: H3JobMode; durationSeconds: number; width: number; height: number; references: number },
): Promise<H3EstimateResult> {
  const query = new URLSearchParams({
    mode: params.mode,
    duration_seconds: String(params.durationSeconds),
    width: String(params.width),
    height: String(params.height),
    references: String(params.references),
  })
  const resp = await request(config, `/v1/estimate?${query}`, { timeoutMs: 15_000 })
  return (await resp.json()) as H3EstimateResult
}
