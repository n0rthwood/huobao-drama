/**
 * ComfyUI（无头）通用客户端 —— 图片/视频 adapter 共用。
 *
 * ComfyUI 不是「传 prompt 返回文件」的 HTTP API，而是执行一整张 API 格式节点图：
 *   上传: POST /upload/image (multipart)      -> { name, subfolder }
 *   提交: POST /prompt {prompt, client_id}    -> { prompt_id, node_errors }
 *   轮询: GET  /history/{prompt_id}           -> { <id>: { status, outputs } }（未完成为 {}）
 *   取件: GET  /view?filename=&subfolder=&type=output
 * 经 Caddy 网关暴露时 base URL 带前缀（如 http://host/image），所有路径都拼在其后。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { AIConfig, ProviderRequest } from './types'

export interface WorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
}
export type Workflow = Record<string, WorkflowNode>

/** 模板 JSON 的形状固定为 Workflow；import 的推断类型过宽，这里一次性收窄 */
export function asWorkflow(template: unknown): Workflow {
  return template as Workflow
}

export function cloneNode(wf: Workflow, id: string): WorkflowNode {
  const found = wf[id]
  if (!found) throw new Error(`工作流模板缺少节点 ${id}`)
  return found
}

export function randomSeed(seed: number | null | undefined): number {
  return typeof seed === 'number' && Number.isFinite(seed) && seed >= 0
    ? Math.floor(seed)
    : Math.floor(Math.random() * 2 ** 53)
}

export function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string' && u.trim() !== '') : []
  } catch {
    return []
  }
}

export function baseOf(config: AIConfig): string {
  return config.baseUrl.replace(/\/+$/, '')
}

/**
 * ComfyUI 网关鉴权头。api_key 为空 → 不带鉴权（LAN/ZeroTier 直连入口）；
 * api_key 形如 "user:password"（含冒号）→ Caddy 公网入口的 HTTP Basic auth；
 * 其它 → Bearer token（兼容旧用法）。凭据只存 ai_service_configs，不进 URL
 * （Node fetch 拒绝 URL 内嵌 user:pass）、不进日志（task-logger 会打码 Authorization）。
 */
export function authHeaders(config: AIConfig): Record<string, string> {
  if (!config.apiKey) return {}
  if (config.apiKey.includes(':')) {
    const basic = Buffer.from(config.apiKey, 'utf8').toString('base64')
    return { Authorization: `Basic ${basic}` }
  }
  return { Authorization: `Bearer ${config.apiKey}` }
}

/** 引擎串行执行：提交前等队列清空，最长等待 30 分钟 */
const ENGINE_WAIT_MS = 30 * 60 * 1000
const ENGINE_POLL_MS = 5000

interface QueueResponse {
  queue_running?: unknown[]
  queue_pending?: unknown[]
}

export async function waitEngineIdle(config: AIConfig): Promise<void> {
  const deadline = Date.now() + ENGINE_WAIT_MS
  while (true) {
    const resp = await fetch(`${baseOf(config)}/queue`, { headers: authHeaders(config), signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) throw new Error(`ComfyUI /queue ${resp.status}`)
    const queue = (await resp.json()) as QueueResponse
    if (!queue.queue_running?.length && !queue.queue_pending?.length) return
    if (Date.now() >= deadline) throw new Error('ComfyUI 引擎繁忙：等待超过 30 分钟')
    await sleep(ENGINE_POLL_MS)
  }
}

/** 把 data URL / http(s) 图片上传到 ComfyUI input 目录，返回 LoadImage 可用的文件名 */
export async function uploadImage(config: AIConfig, source: string, filename: string): Promise<string> {
  let bytes: Buffer
  let mime = 'image/png'
  if (source.startsWith('data:')) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(source)
    if (!match) throw new Error('参考图 data URL 格式错误')
    mime = match[1]
    bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
  } else if (/^https?:\/\//.test(source)) {
    const resp = await fetch(source, { signal: AbortSignal.timeout(60_000) })
    if (!resp.ok) throw new Error(`参考图下载失败 ${resp.status}: ${source}`)
    mime = resp.headers.get('content-type')?.split(';')[0] || mime
    bytes = Buffer.from(await resp.arrayBuffer())
  } else {
    throw new Error(`参考图无法读取: ${source.slice(0, 80)}`)
  }

  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), `${filename}.${ext}`)
  form.append('overwrite', 'true')
  const resp = await fetch(`${baseOf(config)}/upload/image`, {
    method: 'POST',
    headers: authHeaders(config),
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) throw new Error(`ComfyUI 上传失败 ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const uploaded = (await resp.json()) as { name?: string; subfolder?: string }
  if (!uploaded.name) throw new Error('ComfyUI 上传响应缺少 name')
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
}

export function buildPromptRequest(config: AIConfig, workflow: Workflow): ProviderRequest {
  return {
    url: `${baseOf(config)}/prompt`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
    body: { prompt: workflow, client_id: 'huobao-drama' },
  }
}

interface NodeErrors {
  [nodeId: string]: { class_type?: string; errors?: Array<{ message?: string; details?: string }> }
}

/** 解析 /prompt 响应：校验失败抛错（带节点信息），成功返回 prompt_id */
export function parseSubmitResponse(result: { prompt_id?: string; node_errors?: NodeErrors }): string {
  const messages = Object.entries(result.node_errors ?? {}).flatMap(([id, err]) =>
    (err.errors ?? []).map((e) => `node ${id}(${err.class_type ?? '?'}): ${e.message ?? ''} ${e.details ?? ''}`.trim()))
  if (messages.length) throw new Error(`ComfyUI 工作流校验失败: ${messages.join('; ')}`)
  if (!result.prompt_id) throw new Error('No prompt_id in ComfyUI response')
  return result.prompt_id
}

export function buildHistoryRequest(config: AIConfig, taskId: string): ProviderRequest {
  return { url: `${baseOf(config)}/history/${taskId}`, method: 'GET', headers: authHeaders(config), body: undefined }
}

interface ComfyOutputFile {
  filename: string
  subfolder?: string
  type?: string
}

interface HistoryEntry {
  status?: {
    status_str?: string
    completed?: boolean
    messages?: Array<[string, Record<string, unknown>]>
  }
  outputs?: Record<string, Record<string, unknown>>
}

export type HistoryOutcome =
  | { state: 'processing' }
  | { state: 'failed'; error: string }
  | { state: 'completed'; url: string }

/** 在 history 所有节点输出里找 type=output 的文件，优先匹配 preferred 扩展名 */
export function parseHistory(result: Record<string, HistoryEntry>, config: AIConfig, preferred: RegExp, noFileError: string): HistoryOutcome {
  const entry = Object.values(result ?? {})[0]
  if (!entry) return { state: 'processing' } // 排队/执行中 history 为 {}

  if (entry.status?.status_str === 'error') {
    const failure = entry.status.messages?.find(([kind]) => kind === 'execution_error')?.[1]
    const detail = typeof failure?.exception_message === 'string' ? failure.exception_message : 'ComfyUI 执行失败'
    return { state: 'failed', error: detail }
  }
  if (!entry.status?.completed) return { state: 'processing' }

  const files: ComfyOutputFile[] = []
  for (const nodeOutput of Object.values(entry.outputs ?? {})) {
    for (const items of Object.values(nodeOutput)) {
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (item && typeof item === 'object' && 'filename' in item && (item as ComfyOutputFile).type === 'output') {
          files.push(item as ComfyOutputFile)
        }
      }
    }
  }
  const file = files.find((f) => preferred.test(f.filename)) ?? files[0]
  if (!file) return { state: 'failed', error: noFileError }
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: 'output' })
  return { state: 'completed', url: `${baseOf(config)}/view?${query}` }
}
