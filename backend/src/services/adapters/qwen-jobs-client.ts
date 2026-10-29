/**
 * qwen-jobs（110 上的 Qwen-Image 2.1 多租户任务服务）HTTP 客户端。
 *
 * 服务端自己排队、调度两张卡、按分辨率记录实测耗时，应用只传参数不传工作流：
 *   上传参考图: POST /v1/files (multipart file)        -> { id: "file_…" }（同内容去重）
 *   建任务:     POST /v1/jobs + Idempotency-Key        -> 202 任务对象（同 key 同体重放返回原任务）
 *   批量查询:   GET  /v1/jobs?ids=a,b,c（≤100）        -> { data: [job…] }
 *   取消/删除:  POST /v1/jobs/{id}/cancel、DELETE /v1/jobs/{id}
 *   取件:       GET  /v1/jobs/{id}/outputs/{n}         -> 图片字节；全部取回后服务端立即删除（再取 410）
 *   容量/估计:  GET  /v1/capacity、GET /v1/estimate
 * base URL 为网关地址（如 https://110.joyai.dev/image），凭据是 api_key 里的 "user:password"。
 */
import { createHash } from 'node:crypto'
import type { AIConfig } from './types'

/** 单任务参考图上限（与服务端 16 张上限相比更保守，沿用火宝既有规则） */
export const QWEN_MAX_REFS = 9
const MAX_PIXELS = 2048 * 2048
const MIN_SIDE = 256
/** 批量查询一次最多 100 个 id */
export const QWEN_JOBS_IDS_CHUNK = 100

export type QwenJobMode = 'text_to_image' | 'image_edit' | 'reference_to_image'
export type QwenJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface QwenJobRequest {
  mode: QwenJobMode
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  reference_images?: string[]
  seed?: number
  denoising_strength?: number
  steps?: number
  metadata?: Record<string, string>
}

export interface QwenJobQueueInfo {
  position: number
  length: number
  estimated_start_seconds: number | null
}

export interface QwenJobProgress {
  fraction: number
  elapsed_seconds: number
  remaining_seconds: number | null
  phase: string
  step?: number
  total_steps?: number
}

export interface QwenJobEstimate {
  run_seconds: number
  basis: string
  samples: number
}

export interface QwenJob {
  id: string
  status: QwenJobStatus
  mode: QwenJobMode
  queue: QwenJobQueueInfo | null
  progress: QwenJobProgress | null
  estimate: QwenJobEstimate | null
  estimated_finish_seconds: number | null
  cancel_requested: boolean
  outputs?: { index: number; url: string; content_type: string; width: number; height: number; bytes: number }[]
  outputs_deleted?: boolean
  error?: { code: string; message: string } | null
}

export interface QwenCapacity {
  workers: { id: string; state: 'idle' | 'busy' | 'offline'; job_id: string | null }[]
  total: number
  idle: number
  busy: number
  offline: number
  queue: { length: number; by_client: Record<string, number> }
  estimated_wait_seconds: number
}

export interface QwenEstimateResult {
  run_seconds: number
  basis: string
  samples: number
  queue_wait_seconds: number
}

/** 远端返回的非 2xx：status 用于区分终态（404/410/409/422）与可重试的网络/5xx 错误 */
export class QwenJobsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'QwenJobsError'
  }

  /**
   * 网络中断、网关抖动（530/502）、5xx：任务仍然有效，下一轮重试。
   * 429 queue_full 同样是暂时的：服务端队列满时请求体没有被记账（幂等键未落盘），
   * 原样重发同一个 body + Idempotency-Key 即可，不该让任务失败。
   */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

/** qwen-jobs 公平调度与任务/文件归属用的客户端身份，由应用自己声明（网关不再写入） */
const QWEN_CLIENT_ID = 'huobao'

function baseOf(config: AIConfig): string {
  return config.baseUrl.replace(/\/+$/, '')
}

/** 网关 Basic 鉴权（api_key 形如 "user:password"）；无 key 时走 LAN 免鉴权入口 */
export function qwenAuthHeaders(config: AIConfig): Record<string, string> {
  if (!config.apiKey) return {}
  return { Authorization: `Basic ${Buffer.from(config.apiKey, 'utf8').toString('base64')}` }
}

/** "WxH" → 对齐到 32 的宽高，总像素不超过 2048²；无法解析时返回 1024x1024 */
export function pickQwenSize(size: string | null | undefined): [number, number] {
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec((size || '').trim())
  if (!match) return [1024, 1024]
  let w = Number(match[1])
  let h = Number(match[2])
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)))
  w *= scale
  h *= scale
  const snap = (v: number) => Math.max(MIN_SIDE, Math.round(v / 32) * 32)
  return [snap(w), snap(h)]
}

/** 提示词没有显式引用参考图时，补一句让模型知道要以参考图为基础 */
export function withReferenceHint(prompt: string, refCount: number): string {
  if (!refCount || /<image\d+>/i.test(prompt)) return prompt
  const tags = Array.from({ length: refCount }, (_, i) => `<image${i + 1}>`).join('、')
  return `以 ${tags} 为参考：${prompt}`
}

/** FLUX 任务服务（qwen-jobs v1 克隆）的参考图 img2img 去噪强度：服务端默认一致 */
export const FLUX_DENOISING_STRENGTH = 0.75

/**
 * 是否 FLUX 任务服务（qwen-jobs 协议克隆，模型名 flux-dev / flux-schnell）。
 * FLUX 不支持 image_edit，reference_to_image 只接受恰好 1 张参考图（img2img），
 * 请求体字段也不容忍任何多余字段，提交前必须走 FLUX 专用的 body 组装。
 */
export function isFluxJobsConfig(config: AIConfig): boolean {
  return /(^|[,;\s])flux/i.test(` ${config.model || ''} `)
}

export interface ImageJobBodyOptions {
  prompt: string
  /** 已上传的参考图 file id（FLUX 只用第 1 张） */
  fileIds: string[]
  /** 关键帧槽位任务（按剧集画幅出图） */
  isKeyframe: boolean
  /** "WxH" 画幅 */
  size: string | null | undefined
  flux: boolean
}

/** 多参考图在 FLUX 下被降级为第 1 张时的说明，写入任务 metadata（远端任务详情可查） */
export const FLUX_REFS_DROPPED_NOTE = 'flux_reference_to_image_only_takes_1_reference'

/**
 * qwen-jobs 图片任务请求体组装（generation.ts 唯一构造点）。
 * - Qwen：无参考图 text_to_image；关键帧 reference_to_image（带画幅）；其余 image_edit（跟随第 1 张参考图，不带画幅），提示词补 <imageN> 标记。
 * - FLUX：无参考图 text_to_image；有参考图一律 reference_to_image（img2img，只带第 1 张参考图，
 *   画幅照常、显式 denoising_strength），提示词不加 <imageN>（FLUX 不解析）。
 */
export function buildImageJobBody(opts: ImageJobBodyOptions): QwenJobRequest {
  const { prompt, fileIds, isKeyframe, size, flux } = opts
  const [width, height] = pickQwenSize(size)
  if (flux) {
    const refs = fileIds.slice(0, 1)
    const mode: QwenJobMode = refs.length ? 'reference_to_image' : 'text_to_image'
    return {
      mode,
      prompt,
      metadata: {},
      width,
      height,
      ...(refs.length ? { reference_images: refs, denoising_strength: FLUX_DENOISING_STRENGTH } : {}),
    }
  }
  const mode: QwenJobMode = !fileIds.length ? 'text_to_image' : isKeyframe ? 'reference_to_image' : 'image_edit'
  return {
    mode,
    prompt: withReferenceHint(prompt, fileIds.length),
    metadata: {},
    ...(mode === 'image_edit' ? {} : { width, height }),
    ...(fileIds.length ? { reference_images: fileIds } : {}),
  }
}

async function toError(resp: Response): Promise<QwenJobsError> {
  const text = await resp.text().catch(() => '')
  let code = 'http_error'
  let message = text.slice(0, 300)
  try {
    const parsed = JSON.parse(text)
    if (parsed?.error?.code) code = String(parsed.error.code)
    if (parsed?.error?.message) message = String(parsed.error.message)
  } catch {
    // 非 JSON（网关 502/530 的 HTML 页面）：保留截断文本
  }
  return new QwenJobsError(resp.status, code, `qwen-jobs ${resp.status} ${code}: ${message}`)
}

async function request(
  config: AIConfig,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit; timeoutMs?: number } = {},
): Promise<Response> {
  let resp: Response
  try {
    resp = await fetch(`${baseOf(config)}${path}`, {
      method: init.method || 'GET',
      headers: { 'X-Qwen-Client': QWEN_CLIENT_ID, ...qwenAuthHeaders(config), ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
  } catch (err) {
    // 网络层失败（tunnel 抖动、超时）：标记为可重试
    throw new QwenJobsError(0, 'network_error', `qwen-jobs 网络错误: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!resp.ok) throw await toError(resp)
  return resp
}

/** 进程内 sha256 → file id 缓存：同一组参考图（角色三视图等）跨任务只上传一次 */
const fileIdCache = new Map<string, string>()

/**
 * 服务端在没有任何排队/运行任务引用某个文件后会把它删除，缓存里的 id 随之失效
 * （再提交会得到 422 unknown reference image）。按 file id 清掉对应缓存，
 * 下一次提交会重新上传（同内容会拿回同一个 id，只是多一次上传）。
 */
export function evictQwenFileIds(ids: readonly string[]): number {
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

function decodeSource(source: string): { bytes: Buffer; mime: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(source)
  if (!match) throw new Error('参考图 data URL 格式错误')
  const mime = match[1]!
  const bytes = match[2] ? Buffer.from(match[3]!, 'base64') : Buffer.from(decodeURIComponent(match[3]!))
  return { bytes, mime }
}

/** 上传一张参考图（data URL / http(s)），返回服务端 file id */
export async function uploadReferenceImage(config: AIConfig, source: string): Promise<string> {
  let bytes: Buffer
  let mime = 'image/png'
  if (source.startsWith('data:')) {
    ({ bytes, mime } = decodeSource(source))
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
  if (!uploaded.id) throw new Error('qwen-jobs 上传响应缺少 file id')
  fileIdCache.set(cacheKey, uploaded.id)
  return uploaded.id
}

export async function createQwenJob(config: AIConfig, body: QwenJobRequest, idempotencyKey: string): Promise<QwenJob> {
  const resp = await request(config, '/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
    timeoutMs: 60_000,
  })
  return (await resp.json()) as QwenJob
}

export async function listQwenJobs(config: AIConfig, ids: string[]): Promise<QwenJob[]> {
  if (!ids.length) return []
  const resp = await request(config, `/v1/jobs?ids=${encodeURIComponent(ids.join(','))}`)
  const parsed = (await resp.json()) as { data?: QwenJob[] }
  return parsed.data ?? []
}

export async function cancelQwenJob(config: AIConfig, id: string): Promise<QwenJob> {
  const resp = await request(config, `/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  return (await resp.json()) as QwenJob
}

export async function deleteQwenJob(config: AIConfig, id: string): Promise<void> {
  await request(config, `/v1/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 取回输出字节（必须先落盘再标完成：服务端在全部取回后立即删除文件） */
export async function downloadQwenOutput(
  config: AIConfig,
  jobId: string,
  index: number,
): Promise<{ bytes: Buffer; contentType: string }> {
  const resp = await request(config, `/v1/jobs/${encodeURIComponent(jobId)}/outputs/${index}`, { timeoutMs: 120_000 })
  return {
    bytes: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get('content-type')?.split(';')[0] || 'image/png',
  }
}

export async function getQwenCapacity(config: AIConfig): Promise<QwenCapacity> {
  const resp = await request(config, '/v1/capacity', { timeoutMs: 15_000 })
  return (await resp.json()) as QwenCapacity
}

export async function getQwenEstimate(
  config: AIConfig,
  params: { mode: QwenJobMode; width?: number; height?: number; references: number },
): Promise<QwenEstimateResult> {
  const query = new URLSearchParams({ mode: params.mode, references: String(params.references) })
  if (params.width) query.set('width', String(params.width))
  if (params.height) query.set('height', String(params.height))
  const resp = await request(config, `/v1/estimate?${query}`, { timeoutMs: 15_000 })
  return (await resp.json()) as QwenEstimateResult
}
