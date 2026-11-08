/**
 * 任务级持久调用观测（Issue #87 C 段）
 *
 * 口径（三种时间互不混用）：
 * - 任务墙钟：sys_task.created_at → completed_at，由 sys-task.ts 负责，这里不重复。
 * - 服务调用耗时 model_ms：**拿到调度槽位之后**的实际请求发出 → 响应流结束。它是应用侧观测，
 *   不声称供应商的纯 GPU 计算时间；排队等待 queue_ms 单独记，工具/文件处理不算进来。
 * - 媒体长度：音频时长属于产物属性，绝不拿来冒充 TTS 合成耗时。
 *
 * 落盘范围：只有被 runObservedWork 包住的工作项（本轮 = 旁白骨架 / 配音 / 设计卡）才采集，
 * 其余 LLM harness 留给后续 Issue #88 统一接入——这里用 AsyncLocalStorage 是否存在工作项做门禁。
 *
 * 公开对话的完整性：实际发出的全部公开角色消息（system/user/assistant/tool）、注入的技能全文、
 * 工具定义、工具调用参数与工具返回（含失败返回）都逐字保存，不摘要、不差分、不截断。
 * 只对三类内容做替换：凭据（Authorization/api_key/URL 签名）、图片与二进制（占位 + 体积），
 * 以及模型的隐藏思维——后者本就不采集（既有 provider reasoning 展示链路保持原样）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { getInsertId, sqlite } from '../db/index.js'

// ─── 对外类型 ────────────────────────────────────────────────────────────

export type ObservedStage = 'skeleton' | 'voice' | 'design_card'
export type ObservedStatus = 'processing' | 'completed' | 'failed' | 'interrupted'

export interface ObservedWorkInput {
  taskId: number
  stage: ObservedStage
  /** 源旁白字数（骨架 = 整集剧本字数，设计卡/配音 = 本镜旁白字数），**不是**提示词字数 */
  sourceChars: number
  /** 同口径样本分组键：阶段 + 实际配置/模型（配音再加合成参数），由调用方构造 */
  sampleKey: string
  storyboardId?: number
  storyboardNumber?: number
}

export interface ObservedWorkRow {
  id: number
  task_id: number
  stage: ObservedStage
  source_chars: number
  sample_key: string
  storyboard_id: number | null
  storyboard_number: number | null
  started_at: number
  finished_at: number | null
  status: ObservedStatus
  /** 已结束调用的耗时之和（中断工作项另含被心跳确认的那段）；进行中的那次要自己加上 */
  model_ms: number
  queue_ms: number
  work_ms: number
  call_count: number
  heartbeat_at: number
  error_msg: string | null
  created_at: number
  /** 当前这次仍在进行的调用的开始时刻；工作项不是 processing 时恒为 null（读表时推导，不落列） */
  active_call_started_at: number | null
  /** 该调用最后一次持久心跳；崩溃后的冻结值就是它 */
  active_call_heartbeat_at: number | null
}

export interface ObservedCallRow {
  id: number
  work_id: number
  task_id: number
  kind: 'llm' | 'vision_chat' | 'tts'
  config_id: number | null
  config_name: string | null
  provider: string | null
  model: string | null
  url: string | null
  stream: number
  status: ObservedStatus
  http_status: number | null
  queued_at: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  queue_ms: number
  request_chars: number
  response_chars: number
  prompt_tokens: number | null
  completion_tokens: number | null
  finish_reason: string | null
  error_msg: string | null
  heartbeat_at: number
  created_at: number
}

export interface ObservedMessageRow {
  id: number
  call_id: number
  work_id: number
  task_id: number
  seq: number
  /** request = 本次真实发出的消息；response = 服务端返回；final = 无后续模型调用的收尾工具结果 */
  phase: 'request' | 'response' | 'final'
  /** system | user | assistant | tool | tool_call | tool_result | tool_definitions | request_params | request | result | error | raw_response */
  role: string
  name: string | null
  tool_call_id: string | null
  body: string
  chars: number
  streaming: number
  created_at: number
}

/** 调用归属：哪条配置/模型真的发出了这次请求 */
export interface ObservedCallMeta {
  kind: 'llm' | 'vision_chat'
  configId: number | null
  configName?: string | null
  provider?: string | null
  model: string
  baseUrl?: string | null
}

// ─── 脱敏与占位（公开文本绝不截断）─────────────────────────────────────────

const CREDENTIAL = '[已脱敏凭据]'
const SECRET_KEY_RE = /^(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token|signature)$/i

/**
 * 公开文本入库前的唯一处理：凭据脱敏 + 图片/二进制占位。
 * 绝不截断正文——旧 task-logger 的 sanitizeValue 会砍普通字符串，不能用于完整对话。
 */
export function sanitizeObservedText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${CREDENTIAL}`)
    .replace(/\b(?:sk|sk-proj|sk-ant|xai|gsk|ak|pat)[-_][A-Za-z0-9._-]{12,}/gi, CREDENTIAL)
    .replace(/\b(https?:\/\/)[^\s/?#@"']+@/gi, `$1${CREDENTIAL}@`)
    .replace(/(\bauthorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/gi, `$1${CREDENTIAL}`)
    // 完整与尚未闭合的 JSON 凭据值都在落盘前遮蔽；转义引号不算字段结束。
    .replace(
      /("(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token|signature)"\s*:\s*")(?:\\[\s\S]|[^"\\])*("|\\?$)/gi,
      (_match: string, prefix: string, ending: string) => `${prefix}${CREDENTIAL}${ending === '"' ? '"' : ''}`,
    )
    .replace(
      /("(?:password|passwd|token|secret|api[_-]?key)"\s*:\s*)(-?\d+(?:\.\d+)?|true|false|null)\b/gi,
      `$1"${CREDENTIAL}"`,
    )
    .replace(
      /([?&](?:key|token|api[_-]?key|access[_-]?token|signature|sign|sig|secret|password)=)[^&\s"'<>]+/gi,
      `$1${CREDENTIAL}`,
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]*$/i, `$1${CREDENTIAL}`)
    // 只替换**明确**是二进制的东西：data:URL 的 base64 载荷（长度不限，短图也占位）。
    // 绝不按「一长串字母数字」猜二进制——合法正文与工具参数里有的是长 ASCII 串，
    // 猜一次就等于悄悄删掉真实对话内容。结构化字段里的 Buffer/TypedArray 由 normalizeForJson 处理。
    .replace(
      /data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g,
      (_m, mime: string, payload: string) => `[${mime} 二进制占位：base64 ${payload.length} 字符未入库]`,
    )
}

/**
 * 结构化值入库前的归一化：必须在 JSON.stringify 之前做。
 * JSON.stringify 会先调用 toJSON 再交给 replacer，Buffer 那时已经变成
 * `{type:'Buffer',data:[...字节...]}`——靠 replacer 拦不住，字节会被原样写进库。
 */
const BINARY_KEY_RE = /(?:base64|b64)$|^b64_json$/i

function normalizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '[函数未入库]'
  if (value instanceof ArrayBuffer) return `[二进制占位：${value.byteLength} 字节未入库]`
  if (ArrayBuffer.isView(value)) return `[二进制占位：${value.byteLength} 字节未入库]`
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[循环引用]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => normalizeForJson(item, seen))
  if ('toJSON' in value) {
    const toJson = value.toJSON
    if (typeof toJson === 'function') return normalizeForJson(toJson.call(value), seen)
  }
  const obj = value as Record<string, unknown>
  // 已经被序列化过的 Buffer 形状同样是字节，不能入库
  if (obj.type === 'Buffer' && Array.isArray(obj.data)) return `[二进制占位：${obj.data.length} 字节未入库]`
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(obj)) {
    out[key] = SECRET_KEY_RE.test(key) ? CREDENTIAL
      : BINARY_KEY_RE.test(key) && typeof item === 'string' ? `[二进制占位：${item.length} 个 base64 字符未入库]`
      : normalizeForJson(item, seen)
  }
  return out
}

/** 任意结构 → 可读 JSON 文本（脱敏 + 二进制占位，不截断） */
function safeJsonText(value: unknown): string {
  if (typeof value === 'string') return sanitizeObservedText(value)
  let json: string
  try {
    json = JSON.stringify(normalizeForJson(value, new WeakSet()), null, 2) ?? String(value)
  } catch {
    // 归一化之后仍失败（极端自定义 getter 抛错）：退回可读描述，绝不打断真实任务
    json = String(value)
  }
  return sanitizeObservedText(json)
}

/** 工具调用参数：模型回传的是 JSON 字符串，不能再包一层引号 */
function argumentsText(args: unknown): string {
  return typeof args === 'string' ? sanitizeObservedText(args) : safeJsonText(args)
}

function errorText(err: unknown): string {
  return sanitizeObservedText(err instanceof Error ? (err.message || err.name) : String(err))
}

// ─── 语句（同一连接，同步执行）───────────────────────────────────────────

const insertWorkStmt = sqlite.prepare(
  `INSERT INTO task_observed_work
    (task_id, stage, source_chars, sample_key, storyboard_id, storyboard_number, started_at, status, heartbeat_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
)
const finishWorkStmt = sqlite.prepare(
  `UPDATE task_observed_work SET status = ?, finished_at = ?, work_ms = MAX(0, ? - started_at), heartbeat_at = ?, error_msg = ?
   WHERE id = ?`,
)
const beatWorkStmt = sqlite.prepare(
  'UPDATE task_observed_work SET heartbeat_at = ?, work_ms = MAX(0, ? - started_at) WHERE id = ? AND status = \'processing\'',
)
const beatCallsStmt = sqlite.prepare(
  'UPDATE task_observed_call SET heartbeat_at = ? WHERE work_id = ? AND status = \'processing\'',
)
const addCallTimeStmt = sqlite.prepare(
  `UPDATE task_observed_work
     SET model_ms = model_ms + ?, queue_ms = queue_ms + ?, call_count = call_count + 1,
         heartbeat_at = ?, work_ms = MAX(work_ms, MAX(0, ? - started_at))
   WHERE id = ?`,
)
const insertCallStmt = sqlite.prepare(
  `INSERT INTO task_observed_call
    (work_id, task_id, kind, config_id, config_name, provider, model, url, stream, status, queued_at, started_at, queue_ms, heartbeat_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`,
)
const setCallHttpStmt = sqlite.prepare('UPDATE task_observed_call SET http_status = ?, stream = ?, heartbeat_at = ? WHERE id = ?')
const addRequestCharsStmt = sqlite.prepare('UPDATE task_observed_call SET request_chars = request_chars + ?, heartbeat_at = ? WHERE id = ?')
const finishCallStmt = sqlite.prepare(
  `UPDATE task_observed_call
     SET status = ?, finished_at = ?, duration_ms = ?, response_chars = ?,
         prompt_tokens = ?, completion_tokens = ?, finish_reason = ?, error_msg = ?, heartbeat_at = ?
   WHERE id = ?`,
)
const lastCallStmt = sqlite.prepare('SELECT id FROM task_observed_call WHERE work_id = ? ORDER BY id DESC LIMIT 1')
const toolCallOriginStmt = sqlite.prepare(
  "SELECT call_id AS id FROM task_observed_message WHERE work_id = ? AND tool_call_id = ? AND role = 'tool_call' AND phase = 'response' ORDER BY task_observed_message.id DESC LIMIT 1",
)
const insertTextStmt = sqlite.prepare('INSERT OR IGNORE INTO task_observed_text (hash, body, chars, created_at) VALUES (?, ?, ?, ?)')
const insertMessageStmt = sqlite.prepare(
  `INSERT INTO task_observed_message
    (call_id, work_id, task_id, seq, phase, role, name, tool_call_id, body, text_hash, chars, streaming, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
const updateStreamingStmt = sqlite.prepare('UPDATE task_observed_message SET body = ?, chars = ? WHERE id = ?')
// 流式工具调用的 id/name 可能晚于第一段参数到达：行先建好，身份后补
const setMessageIdentityStmt = sqlite.prepare('UPDATE task_observed_message SET name = ?, tool_call_id = ? WHERE id = ?')
const finalizeMessageStmt = sqlite.prepare('UPDATE task_observed_message SET body = NULL, text_hash = ?, chars = ?, streaming = 0 WHERE id = ?')
const deleteMessageStmt = sqlite.prepare('DELETE FROM task_observed_message WHERE id = ?')
const hasToolMessageStmt = sqlite.prepare(
  `SELECT 1 AS hit FROM task_observed_message
   WHERE work_id = ? AND tool_call_id = ? AND role IN ('tool', 'tool_result') LIMIT 1`,
)
// 进行中的那一次调用（work 自身也在跑时才有）：ETA 要用「已完成调用之和 + 当前这次已跑多久」，
// 只读 model_ms 会让一条跑了 40s 的流显示 0.0s。终态 work 一律返回 null，由冻结值兜底。
const WORK_SELECT = `SELECT w.*,
    (SELECT c.started_at FROM task_observed_call c
      WHERE c.work_id = w.id AND c.status = 'processing' AND w.status = 'processing'
      ORDER BY c.id DESC LIMIT 1) AS active_call_started_at,
    (SELECT c.heartbeat_at FROM task_observed_call c
      WHERE c.work_id = w.id AND c.status = 'processing' AND w.status = 'processing'
      ORDER BY c.id DESC LIMIT 1) AS active_call_heartbeat_at
  FROM task_observed_work w`
const worksByTaskStmt = sqlite.prepare(`${WORK_SELECT} WHERE w.task_id = ? ORDER BY w.id ASC`)
const worksBySampleStmt = sqlite.prepare(`${WORK_SELECT} WHERE w.stage = ? AND w.sample_key = ? ORDER BY w.id DESC LIMIT ?`)
const callByIdStmt = sqlite.prepare('SELECT * FROM task_observed_call WHERE id = ?')
const callPageStmt = sqlite.prepare('SELECT * FROM task_observed_call WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
const callPageByWorkStmt = sqlite.prepare('SELECT * FROM task_observed_call WHERE task_id = ? AND id > ? AND work_id = ? ORDER BY id ASC LIMIT ?')
const countMessagesStmt = sqlite.prepare('SELECT COUNT(*) AS n FROM task_observed_message WHERE call_id = ?')
// 正文走内容寻址表，流式进行中的那条还在 body 里：读的时候合并两处
const messagePageStmt = sqlite.prepare(
  `SELECT m.id, m.call_id, m.work_id, m.task_id, m.seq, m.phase, m.role, m.name, m.tool_call_id,
      COALESCE(m.body, t.body, '') AS body, m.chars, m.streaming, m.created_at
    FROM task_observed_message m LEFT JOIN task_observed_text t ON t.hash = m.text_hash
   WHERE m.call_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`,
)

// ─── 工作项上下文（ALS 门禁 + 归属）───────────────────────────────────────

interface WorkContext {
  workId: number
  taskId: number
  stage: ObservedStage
  /** 流式采集是异步的：工作项终态提交前必须等它们落盘，否则会丢最后一段公开正文 */
  pending: Set<Promise<void>>
  captureErrors: unknown[]
}

const workALS = new AsyncLocalStorage<WorkContext>()
const queueALS = new AsyncLocalStorage<{ queuedAt: number }>()

const HEARTBEAT_MS = 5_000

function track(ctx: WorkContext, call: CallHandle, promise: Promise<void>): void {
  const wrapped = promise.catch(error => {
    ctx.captureErrors.push(error)
    try {
      if (getObservedCall(call.id)?.status === 'processing') {
        const partial = sqlite.prepare("SELECT COALESCE(SUM(chars), 0) AS n FROM task_observed_message WHERE call_id = ? AND phase <> 'request'").get(call.id) as { n: number }
        completeCall(call, { status: 'failed', responseChars: partial.n, errorMsg: `公开响应采集失败：${errorText(error)}` })
      }
    } catch (persistenceError) {
      ctx.captureErrors.push(persistenceError)
    }
  })
  ctx.pending.add(wrapped)
  void wrapped.then(() => ctx.pending.delete(wrapped))
}

/**
 * 包住一个被观测的工作项（骨架整集 / 设计卡逐镜 / 配音逐镜）。
 * - 持久化开始/结束/源字数/状态，完成与失败的历史都保留（追加写，不覆盖）。
 * - 通过 ALS 把归属传给嵌套的真实模型调用（Agent fetch、read_image 直连、TTS 操作）。
 * - 心跳每 5s 落盘一次：进程崩了也能把耗时冻结在最后一次确认时间，不用重启时间编造尾巴。
 */
export async function runObservedWork<T>(input: ObservedWorkInput, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  const workId = getInsertId(insertWorkStmt.run(
    input.taskId,
    input.stage,
    Math.max(0, Math.trunc(input.sourceChars) || 0),
    input.sampleKey,
    input.storyboardId ?? null,
    input.storyboardNumber ?? null,
    startedAt,
    startedAt,
    startedAt,
  ))
  const ctx: WorkContext = { workId, taskId: input.taskId, stage: input.stage, pending: new Set(), captureErrors: [] }
  const beat = setInterval(() => {
    try {
      const at = Date.now()
      beatWorkStmt.run(at, at, workId)
      beatCallsStmt.run(at, workId)
    } catch (error) {
      ctx.captureErrors.push(error)
      clearInterval(beat)
    }
  }, HEARTBEAT_MS)
  beat.unref()
  try {
    const result = await workALS.run(ctx, fn)
    // 终态提交前必须等流式采集真正落盘：否则最后一段公开正文/工具参数会丢
    while (ctx.pending.size) await Promise.all([...ctx.pending])
    if (ctx.captureErrors.length) throw ctx.captureErrors[0]
    const at = Date.now()
    finishWorkStmt.run('completed', at, at, at, null, workId)
    return result
  } catch (err) {
    while (ctx.pending.size) await Promise.all([...ctx.pending])
    const at = Date.now()
    const captureError = ctx.captureErrors[0]
    const failure = ctx.captureErrors.length
      ? new Error(`公开调用记录持久化失败：${errorText(captureError)}${err === captureError ? '' : `；任务错误：${errorText(err)}`}`, { cause: err })
      : err
    finishWorkStmt.run('failed', at, at, at, errorText(failure), workId)
    throw failure
  } finally {
    clearInterval(beat)
  }
}

// ─── 调用记录 ────────────────────────────────────────────────────────────

interface CallHandle {
  id: number
  ctx: WorkContext
  startedAt: number
  queueMs: number
  seq: number
}

interface CallMetaInternal {
  kind: ObservedCallRow['kind']
  configId: number | null
  configName?: string | null
  provider?: string | null
  model: string | null
  url?: string | null
  queuedAt: number
  startedAt: number
}

function beginCall(ctx: WorkContext, meta: CallMetaInternal): CallHandle {
  const queueMs = Math.max(0, meta.startedAt - meta.queuedAt)
  const id = getInsertId(insertCallStmt.run(
    ctx.workId,
    ctx.taskId,
    meta.kind,
    meta.configId,
    meta.configName ?? null,
    meta.provider ?? null,
    meta.model,
    meta.url ? sanitizeObservedText(meta.url) : null,
    0,
    meta.queuedAt,
    meta.startedAt,
    queueMs,
    meta.startedAt,
    meta.startedAt,
  ))
  return { id, ctx, startedAt: meta.startedAt, queueMs, seq: 0 }
}

interface CapturedMessage {
  role: string
  name?: string | null
  toolCallId?: string | null
  body: string
}

function appendMessage(call: CallHandle, phase: ObservedMessageRow['phase'], msg: CapturedMessage): void {
  const body = msg.body ?? ''
  const hash = createHash('sha256').update(body).digest('hex')
  const at = Date.now()
  insertTextStmt.run(hash, body, body.length, at)
  insertMessageStmt.run(
    call.id, call.ctx.workId, call.ctx.taskId, call.seq++, phase, msg.role,
    msg.name ?? null, msg.toolCallId ?? null, null, hash, body.length, 0, at,
  )
}

/** 流式正文：先按 body 增量落盘（崩溃也留得住已收到的部分），收尾时转内容寻址 */
interface StreamingMessage { id: number; text: string; flushedChars: number; timer: NodeJS.Timeout | null; ctx: WorkContext }

/** 停流也要落盘：到达后 500ms 内没有新分片就把已收到的正文写进去 */
const STREAM_FLUSH_MS = 500
const STREAM_FLUSH_CHARS = 2_048

function beginStreamingMessage(call: CallHandle, phase: ObservedMessageRow['phase'], role: string): StreamingMessage {
  const id = getInsertId(insertMessageStmt.run(
    call.id, call.ctx.workId, call.ctx.taskId, call.seq++, phase, role, null, null, '', null, 0, 1, Date.now(),
  ))
  return { id, text: '', flushedChars: 0, timer: null, ctx: call.ctx }
}

function flushStreaming(msg: StreamingMessage): void {
  if (msg.timer) { clearTimeout(msg.timer); msg.timer = null }
  if (msg.flushedChars === msg.text.length) return
  const body = sanitizeObservedText(msg.text)
  updateStreamingStmt.run(body, body.length, msg.id)
  msg.flushedChars = msg.text.length
}

/**
 * 增量落盘：首段与大块立即写（崩溃时至少留得住开头），
 * 其余靠 500ms 定时器兜底——模型常常先吐一小段再长时间静默（实测 DeepSeek 可静默 20s+），
 * 只在「下一片到达时」判断就会让这段正文一直留在内存里。
 */
function pushStreaming(msg: StreamingMessage, delta: string): void {
  msg.text += delta
  if (!msg.flushedChars || msg.text.length - msg.flushedChars >= STREAM_FLUSH_CHARS) {
    flushStreaming(msg)
    return
  }
  if (msg.timer) return
  msg.timer = setTimeout(() => {
    msg.timer = null
    try { flushStreaming(msg) } catch (error) { msg.ctx.captureErrors.push(error) }
  }, STREAM_FLUSH_MS)
  msg.timer.unref()
}

/** 收尾：返回落盘字符数；空正文由调用方决定删行（助手纯工具步）还是保留（空参数工具调用） */
function finalizeStreaming(msg: StreamingMessage): number {
  if (msg.timer) { clearTimeout(msg.timer); msg.timer = null }
  const body = sanitizeObservedText(msg.text)
  const hash = createHash('sha256').update(body).digest('hex')
  insertTextStmt.run(hash, body, body.length, Date.now())
  finalizeMessageStmt.run(hash, body.length, msg.id)
  return body.length
}

interface CallOutcome {
  status: ObservedStatus
  responseChars: number
  promptTokens?: number | null
  completionTokens?: number | null
  finishReason?: string | null
  errorMsg?: string | null
}

function completeCall(call: CallHandle, outcome: CallOutcome): void {
  const at = Date.now()
  const durationMs = Math.max(0, at - call.startedAt)
  finishCallStmt.run(
    outcome.status, at, durationMs, outcome.responseChars,
    outcome.promptTokens ?? null, outcome.completionTokens ?? null,
    outcome.finishReason ?? null, outcome.errorMsg ?? null, at, call.id,
  )
  addCallTimeStmt.run(durationMs, call.queueMs, at, at, call.ctx.workId)
}

// ─── 请求体 → 公开消息 ───────────────────────────────────────────────────

function partToText(part: unknown): string {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return safeJsonText(part)
  // 供应商消息片段是外部 JSON，结构按 OpenAI / Gemini 两族已知形状读取
  const p = part as Record<string, unknown>
  // 隐藏思维不进公开对话（#87 明确不索取）：Gemini 的 thought 片段与思考型 part 一律跳过
  if (p.thought === true || p.type === 'thinking' || p.type === 'reasoning') return ''
  const type = typeof p.type === 'string' ? p.type : ''
  if (typeof p.text === 'string' && (!type || type === 'text')) return p.text
  if (type === 'image_url' || p.image_url) {
    const holder = p.image_url
    const url = String((holder && typeof holder === 'object' && 'url' in holder ? holder.url : holder) ?? '')
    if (url.startsWith('data:')) {
      const semi = url.indexOf(';')
      const mime = semi > 5 ? url.slice(5, semi) : 'image'
      return `[图片占位：${mime}，base64 ${url.slice(url.indexOf(',') + 1).length} 字符未入库]`
    }
    return `[图片引用：${sanitizeObservedText(url)}]`
  }
  const inlineHolder = p.inlineData ?? p.inline_data
  if (type === 'image' || inlineHolder) {
    const inline = (inlineHolder && typeof inlineHolder === 'object' ? inlineHolder : {}) as Record<string, unknown>
    const mime = inline.mimeType ?? inline.mime_type ?? 'image'
    return `[图片占位：${String(mime)}，base64 ${String(inline.data ?? '').length} 字符未入库]`
  }
  if (type === 'input_audio' || p.audio) return '[音频占位：二进制未入库]'
  return safeJsonText(p)
}

function contentToText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join('\n')
  return safeJsonText(content)
}

function openAiRequestMessages(body: Record<string, unknown>): CapturedMessage[] {
  const out: CapturedMessage[] = []
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length) out.push({ role: 'tool_definitions', name: String(tools.length), body: safeJsonText(tools) })
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const role = typeof m.role === 'string' ? m.role : 'user'
    const text = sanitizeObservedText(contentToText(m.content))
    const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : []
    if (text || !toolCalls.length) {
      out.push({
        role,
        name: typeof m.name === 'string' ? m.name : null,
        toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : null,
        body: text,
      })
    }
    for (const entry of toolCalls) {
      const call = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const fn = (call.function && typeof call.function === 'object' ? call.function : {}) as Record<string, unknown>
      out.push({
        role: 'tool_call',
        name: typeof fn.name === 'string' ? fn.name : (typeof call.name === 'string' ? call.name : null),
        toolCallId: typeof call.id === 'string' ? call.id : null,
        body: argumentsText(fn.arguments ?? call.arguments ?? call),
      })
    }
  }
  return out
}

function geminiRequestMessages(body: Record<string, unknown>): CapturedMessage[] {
  const out: CapturedMessage[] = []
  if (body.systemInstruction && typeof body.systemInstruction === 'object') {
    const sys = body.systemInstruction as Record<string, unknown>
    out.push({ role: 'system', body: sanitizeObservedText(contentToText(sys.parts ?? sys)) })
  }
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length) out.push({ role: 'tool_definitions', name: String(tools.length), body: safeJsonText(tools) })
  for (const entry of Array.isArray(body.contents) ? body.contents : []) {
    if (!entry || typeof entry !== 'object') continue
    const content = entry as Record<string, unknown>
    const role = content.role === 'model' ? 'assistant' : (typeof content.role === 'string' ? content.role : 'user')
    let buffer = ''
    const flush = () => {
      if (!buffer) return
      out.push({ role, body: sanitizeObservedText(buffer) })
      buffer = ''
    }
    for (const rawPart of Array.isArray(content.parts) ? content.parts : []) {
      const part = (rawPart && typeof rawPart === 'object' ? rawPart : {}) as Record<string, unknown>
      const fnCall = part.functionCall
      const fnResponse = part.functionResponse
      if (fnCall && typeof fnCall === 'object') {
        flush()
        const fc = fnCall as Record<string, unknown>
        out.push({ role: 'tool_call', name: typeof fc.name === 'string' ? fc.name : null, body: argumentsText(fc.args) })
      } else if (fnResponse && typeof fnResponse === 'object') {
        flush()
        const fr = fnResponse as Record<string, unknown>
        out.push({ role: 'tool', name: typeof fr.name === 'string' ? fr.name : null, body: safeJsonText(fr.response) })
      } else {
        buffer += (buffer ? '\n' : '') + partToText(rawPart)
      }
    }
    flush()
  }
  return out
}

/** 落盘本次真实发出的请求；返回请求体是否声明了流式 */
function recordRequest(call: CallHandle, rawBody: unknown): boolean {
  let stream = false
  let messages: CapturedMessage[]
  if (typeof rawBody === 'string' && rawBody.length) {
    let parsed: Record<string, unknown> | null = null
    try {
      // 请求体是本进程刚序列化的 JSON：解析失败就原样留文本，不猜结构
      parsed = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      parsed = null
    }
    if (parsed) {
      stream = parsed.stream === true
      messages = Array.isArray(parsed.contents) ? geminiRequestMessages(parsed) : openAiRequestMessages(parsed)
      const params = { ...parsed }
      delete params.messages
      delete params.contents
      delete params.tools
      delete params.systemInstruction
      messages.push({ role: 'request_params', body: safeJsonText(params) })
    } else {
      messages = [{ role: 'request', body: sanitizeObservedText(rawBody) }]
    }
  } else {
    messages = rawBody == null ? [] : [{ role: 'request', body: '[二进制请求体未入库]' }]
  }
  let chars = 0
  for (const msg of messages) {
    appendMessage(call, 'request', msg)
    chars += msg.body.length
  }
  addRequestCharsStmt.run(chars, Date.now(), call.id)
  return stream
}

// ─── 响应采集 ────────────────────────────────────────────────────────────

interface ToolCallAccumulator { id: string | null; name: string | null; args: unknown }

function writeToolCalls(call: CallHandle, calls: Iterable<ToolCallAccumulator>): number {
  let chars = 0
  for (const entry of calls) {
    const body = argumentsText(entry.args)
    appendMessage(call, 'response', { role: 'tool_call', name: entry.name, toolCallId: entry.id, body })
    chars += body.length
  }
  return chars
}

/**
 * SSE 增量采集：公开正文与 tool_calls 边收边落盘，不等整次 Agent 成功。
 * 流中途失败时保留已收到的部分正文与已收到的工具参数，并标 failed。
 */
async function captureSseStream(call: CallHandle, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const assistant = beginStreamingMessage(call, 'response', 'assistant')
  // 工具参数同样边收边落盘：进程崩在参数生成途中（实测 DeepSeek 可以 20s 不下发数据）
  // 也要留下已收到的那段。index 是动态下标且要保序，所以用 Map。
  const toolCalls = new Map<number, { msg: StreamingMessage; id: string | null; name: string | null }>()
  let buffer = ''
  let promptTokens: number | null = null
  let completionTokens: number | null = null
  let finishReason: string | null = null
  let failure: string | null = null
  const streamErrors: string[] = []

  const consumeChunk = (payload: string) => {
    if (!payload || payload === '[DONE]') return
    let chunk: Record<string, unknown>
    try {
      // SSE 分片是外部 JSON；读不懂的分片直接跳过，绝不影响 SDK 那一路
      chunk = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    // 200 + {"error": ...} 是中转站/供应商常见的「流里报错然后正常 EOF」：
    // 不认它就会把一次失败记成 completed 并丢掉错误正文。
    if (chunk.error != null) {
      streamErrors.push(safeJsonText(chunk.error))
      return
    }
    const usage = chunk.usage && typeof chunk.usage === 'object' ? chunk.usage as Record<string, unknown> : null
    if (usage) {
      promptTokens = Number(usage.prompt_tokens) || promptTokens
      completionTokens = Number(usage.completion_tokens) || completionTokens
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = (choices[0] && typeof choices[0] === 'object' ? choices[0] : null) as Record<string, unknown> | null
    if (choice) {
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      const deltaRaw = choice.delta ?? choice.message
      const delta = (deltaRaw && typeof deltaRaw === 'object' ? deltaRaw : {}) as Record<string, unknown>
      if (typeof delta.content === 'string' && delta.content) pushStreaming(assistant, delta.content)
      else if (Array.isArray(delta.content)) pushStreaming(assistant, contentToText(delta.content))
      for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const tc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
        const index = Number(tc.index ?? toolCalls.size) || 0
        let entry = toolCalls.get(index)
        if (!entry) {
          entry = { msg: beginStreamingMessage(call, 'response', 'tool_call'), id: null, name: null }
          toolCalls.set(index, entry)
        }
        const fn = (tc.function && typeof tc.function === 'object' ? tc.function : {}) as Record<string, unknown>
        if (typeof tc.id === 'string') entry.id = tc.id
        if (typeof fn.name === 'string') entry.name = fn.name
        if (typeof tc.id === 'string' || typeof fn.name === 'string') {
          setMessageIdentityStmt.run(entry.name, entry.id, entry.msg.id)
        }
        if (typeof fn.arguments === 'string' && fn.arguments) pushStreaming(entry.msg, fn.arguments)
      }
    }
    // Gemini 原生流
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : []
    const candidate = (candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : null) as Record<string, unknown> | null
    if (candidate) {
      if (typeof candidate.finishReason === 'string') finishReason = candidate.finishReason
      const content = (candidate.content && typeof candidate.content === 'object' ? candidate.content : {}) as Record<string, unknown>
      for (const rawPart of Array.isArray(content.parts) ? content.parts : []) {
        const part = (rawPart && typeof rawPart === 'object' ? rawPart : {}) as Record<string, unknown>
        // 隐藏思维片段不落盘
        if (part.thought === true) continue
        if (typeof part.text === 'string' && part.text) pushStreaming(assistant, part.text)
        else if (part.functionCall && typeof part.functionCall === 'object') {
          const fc = part.functionCall as Record<string, unknown>
          const index = toolCalls.size
          const entry = { msg: beginStreamingMessage(call, 'response', 'tool_call'), id: null, name: typeof fc.name === 'string' ? fc.name : null }
          toolCalls.set(index, entry)
          setMessageIdentityStmt.run(entry.name, null, entry.msg.id)
          pushStreaming(entry.msg, typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {}))
        }
      }
    }
    const usageMeta = chunk.usageMetadata && typeof chunk.usageMetadata === 'object'
      ? chunk.usageMetadata as Record<string, unknown>
      : null
    if (usageMeta) {
      promptTokens = Number(usageMeta.promptTokenCount) || promptTokens
      completionTokens = Number(usageMeta.candidatesTokenCount) || completionTokens
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) consumeChunk(line.slice(5).trim())
        else if (line.startsWith('{')) consumeChunk(line)
        newline = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) consumeChunk(tail.slice(5).trim())
    else if (tail.startsWith('{')) consumeChunk(tail)
  } catch (err) {
    failure = errorText(err)
  }

  let chars = finalizeStreaming(assistant)
  // 助手那一步没有正文（纯工具调用）就删掉空行；工具参数为空是真实事实，保留
  if (!chars) deleteMessageStmt.run(assistant.id)
  for (const entry of toolCalls.values()) chars += finalizeStreaming(entry.msg)
  for (const streamError of streamErrors) {
    appendMessage(call, 'response', { role: 'error', body: streamError })
    chars += streamError.length
  }
  const errorMsg = failure ?? (streamErrors.length ? streamErrors.join('\n') : null)
  completeCall(call, {
    status: errorMsg ? 'failed' : 'completed',
    responseChars: chars,
    promptTokens,
    completionTokens,
    finishReason,
    errorMsg,
  })
}

/** 非流式响应（read_image 直连等）：整体 JSON 解析；失败响应保留完整错误正文 */
async function captureJsonBody(call: CallHandle, stream: ReadableStream<Uint8Array>, ok: boolean): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let failure: string | null = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (err) {
    failure = errorText(err)
  }

  if (!ok) {
    const errorBody = sanitizeObservedText(text)
    appendMessage(call, 'response', { role: 'error', body: errorBody })
    completeCall(call, { status: 'failed', responseChars: errorBody.length, errorMsg: failure ?? errorBody })
    return
  }

  let parsed: Record<string, unknown> | null = null
  try {
    // 供应商响应是外部 JSON：解析不了就原样留全文，不编造结构
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = null
  }
  if (!parsed) {
    const raw = sanitizeObservedText(text)
    appendMessage(call, 'response', { role: 'raw_response', body: raw })
    completeCall(call, { status: failure ? 'failed' : 'completed', responseChars: raw.length, errorMsg: failure })
    return
  }

  let chars = 0
  const choices = Array.isArray(parsed.choices) ? parsed.choices : []
  const choice = (choices[0] && typeof choices[0] === 'object' ? choices[0] : null) as Record<string, unknown> | null
  const message = (choice?.message && typeof choice.message === 'object' ? choice.message : null) as Record<string, unknown> | null
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : []
  const candidate = (candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : null) as Record<string, unknown> | null
  const candidateContent = (candidate?.content && typeof candidate.content === 'object' ? candidate.content : null) as Record<string, unknown> | null
  if (message) {
    const content = sanitizeObservedText(contentToText(message.content))
    if (content) {
      appendMessage(call, 'response', { role: 'assistant', body: content })
      chars += content.length
    }
    const toolCalls: ToolCallAccumulator[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(raw => {
      const tc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const fn = (tc.function && typeof tc.function === 'object' ? tc.function : {}) as Record<string, unknown>
      return {
        id: typeof tc.id === 'string' ? tc.id : null,
        name: typeof fn.name === 'string' ? fn.name : null,
        args: fn.arguments ?? tc.arguments ?? {},
      }
    })
    chars += writeToolCalls(call, toolCalls)
  } else if (candidateContent && Array.isArray(candidateContent.parts)) {
    const content = sanitizeObservedText(contentToText(candidateContent.parts))
    if (content) {
      appendMessage(call, 'response', { role: 'assistant', body: content })
      chars += content.length
    }
  } else {
    const raw = safeJsonText(parsed)
    appendMessage(call, 'response', { role: 'raw_response', body: raw })
    chars += raw.length
  }
  const usage = (parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : {}) as Record<string, unknown>
  const usageMeta = (parsed.usageMetadata && typeof parsed.usageMetadata === 'object' ? parsed.usageMetadata : {}) as Record<string, unknown>
  completeCall(call, {
    status: failure ? 'failed' : 'completed',
    responseChars: chars,
    promptTokens: Number(usage.prompt_tokens ?? usageMeta.promptTokenCount) || null,
    completionTokens: Number(usage.completion_tokens ?? usageMeta.candidatesTokenCount) || null,
    finishReason: typeof choice?.finish_reason === 'string'
      ? choice.finish_reason
      : (typeof candidate?.finishReason === 'string' ? candidate.finishReason : null),
    errorMsg: failure,
  })
}

// ─── fetch 包装 ──────────────────────────────────────────────────────────

/** 标记「开始排队」：必须包在取槽位（withTextSlot）之外，槽位内的那一刻才是调用开始 */
export function observeQueueWait<T>(fn: () => Promise<T>): Promise<T> {
  return queueALS.run({ queuedAt: Date.now() }, fn)
}

/**
 * 真实模型调用的采集层：必须装在**取到槽位之后**（createScheduledFetch 的 inner），
 * 这样 started_at 就是实际开始传输的时刻，排队等待单独计入 queue_ms。
 * 不在被观测工作项内时原样透传——本轮不做全局铺开（后续 Issue #88）。
 */
export function observeTextCall(meta: ObservedCallMeta, inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ctx = workALS.getStore()
    if (!ctx) return inner(input, init)
    const requestUrl = meta.baseUrl
      || (typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const call = beginCall(ctx, {
      kind: meta.kind,
      configId: meta.configId,
      configName: meta.configName ?? null,
      provider: meta.provider ?? null,
      model: meta.model,
      url: requestUrl,
      queuedAt: queueALS.getStore()?.queuedAt ?? Date.now(),
      startedAt: Date.now(),
    })
    let stream = false
    try {
      stream = recordRequest(call, init?.body)
    } catch (err) {
      ctx.captureErrors.push(err)
      appendMessage(call, 'request', { role: 'error', body: `请求体采集失败：${errorText(err)}` })
    }

    let response: Response
    try {
      response = await inner(input, init)
    } catch (err) {
      completeCall(call, { status: 'failed', responseChars: 0, errorMsg: errorText(err) })
      throw err
    }
    const isSse = (response.headers.get('content-type') || '').includes('text/event-stream')
    setCallHttpStmt.run(response.status, stream || isSse ? 1 : 0, Date.now(), call.id)
    if (!response.body) {
      completeCall(call, {
        status: response.ok ? 'completed' : 'failed',
        responseChars: 0,
        errorMsg: response.ok ? null : `HTTP ${response.status}`,
      })
      return response
    }
    const [forCaller, forCapture] = response.body.tee()
    // 非 2xx 一律当错误正文整体读：429/500 也可能带 text/event-stream 头，
    // 走 SSE 解析会把错误体当成空流、记成 completed。
    track(ctx, call, response.ok && isSse
      ? captureSseStream(call, forCapture)
      : captureJsonBody(call, forCapture, response.ok))
    return new Response(forCaller, { status: response.status, statusText: response.statusText, headers: response.headers })
  }) as typeof fetch
}

// ─── 非 LLM 的真实操作（TTS）──────────────────────────────────────────────

/**
 * 记录一次真实 TTS 合成操作：请求正文/参数、结果元信息与**真实合成用时**。
 * 注意 model_ms 是合成服务耗时，不是音频长度；音频字节绝不序列化。
 */
export async function observeTaskOperation<T>(
  input: { kind: 'tts'; configId: number | null; model: string; request: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = workALS.getStore()
  if (!ctx) return fn()
  const at = Date.now()
  const call = beginCall(ctx, {
    kind: input.kind,
    configId: input.configId,
    model: input.model,
    queuedAt: queueALS.getStore()?.queuedAt ?? at,
    startedAt: at,
  })
  appendMessage(call, 'request', { role: 'request', name: input.kind, body: safeJsonText(input.request) })
  try {
    const result = await fn()
    const body = safeJsonText(result)
    appendMessage(call, 'response', { role: 'result', name: input.kind, body })
    completeCall(call, { status: 'completed', responseChars: body.length })
    return result
  } catch (err) {
    const body = errorText(err)
    appendMessage(call, 'response', { role: 'error', name: input.kind, body })
    completeCall(call, { status: 'failed', responseChars: body.length, errorMsg: body })
    throw err
  }
}

// ─── 收尾工具结果 ────────────────────────────────────────────────────────

/**
 * 每个 Agent 步骤结束就记工具结果，不等下一次模型取槽或整个 Agent 返回。
 * 先等待该步骤已收响应的持久化，再按 tool_call_id 关联发起工具的模型调用；
 * read_image 的嵌套调用不能抢走父工具结果的归属。最后一步同样补记。
 * 已经出现过同 tool_call_id 的 tool/tool_result 消息就跳过，避免重复。
 */
export async function recordFinalToolResults(output: unknown): Promise<void> {
  const ctx = workALS.getStore()
  if (!ctx || !output || typeof output !== 'object' || !('toolResults' in output)) return
  while (ctx.pending.size) await Promise.all([...ctx.pending])
  if (ctx.captureErrors.length) throw ctx.captureErrors[0]
  const results = output.toolResults
  if (!Array.isArray(results) || !results.length) return
  for (const chunk of results) {
    if (!chunk || typeof chunk !== 'object') continue
    const payloadRaw = 'payload' in chunk ? chunk.payload : chunk
    if (!payloadRaw || typeof payloadRaw !== 'object') continue
    const payload = payloadRaw as Record<string, unknown>
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null
    if (toolCallId && hasToolMessageStmt.get(ctx.workId, toolCallId)) continue
    const owner = (toolCallId ? toolCallOriginStmt.get(ctx.workId, toolCallId) : undefined) as { id: number } | undefined
    const target = owner ?? lastCallStmt.get(ctx.workId) as { id: number } | undefined
    if (!target) continue
    const counted = countMessagesStmt.get(target.id) as { n: number } | undefined
    const call: CallHandle = { id: target.id, ctx, startedAt: 0, queueMs: 0, seq: counted?.n ?? 0 }
    appendMessage(call, 'final', {
      role: 'tool_result',
      name: typeof payload.toolName === 'string' ? payload.toolName : null,
      toolCallId,
      body: safeJsonText(payload.result ?? payload),
    })
  }
}

// ─── 重启冻结 ────────────────────────────────────────────────────────────

const INTERRUPT_NOTE = '服务重启，调用中断（计时冻结在最后一次持久心跳）'

const freezeInterrupted = sqlite.transaction(() => {
  const calls = sqlite.prepare(
    `UPDATE task_observed_call
       SET status = 'interrupted',
           finished_at = COALESCE(heartbeat_at, started_at),
           duration_ms = MAX(0, COALESCE(heartbeat_at, started_at) - started_at),
           error_msg = COALESCE(error_msg, ?)
     WHERE status = 'processing'`,
  ).run(INTERRUPT_NOTE).changes
  // 从已持久调用事实重算被中断工作项，保留已确认耗时、等待和调用数；
  // 直接赋值而非累加使恢复幂等，已完成工作项与成功样本均不被改写。
  sqlite.prepare(
    `UPDATE task_observed_work
        SET model_ms = COALESCE((SELECT SUM(c.duration_ms) FROM task_observed_call c WHERE c.work_id = task_observed_work.id), 0),
            queue_ms = COALESCE((SELECT SUM(c.queue_ms) FROM task_observed_call c WHERE c.work_id = task_observed_work.id), 0),
            call_count = (SELECT COUNT(*) FROM task_observed_call c WHERE c.work_id = task_observed_work.id)
      WHERE status = 'processing'`,
  ).run()
  sqlite.prepare(
    `UPDATE task_observed_message SET streaming = 0
      WHERE streaming = 1 AND call_id IN (SELECT id FROM task_observed_call WHERE status = 'interrupted')`,
  ).run()
  const works = sqlite.prepare(
    `UPDATE task_observed_work
       SET status = 'interrupted',
           finished_at = COALESCE(heartbeat_at, started_at),
           work_ms = MAX(0, COALESCE(heartbeat_at, started_at) - started_at),
           error_msg = COALESCE(error_msg, ?)
     WHERE status = 'processing'`,
  ).run(INTERRUPT_NOTE).changes
  return { works, calls }
})

/**
 * 启动恢复：在飞的工作项/调用标 interrupted，耗时冻结到**最后一次持久心跳**，
 * 不拿重启时刻当结束时间。已完成/已失败的历史一律不动。
 * 被冻结调用「心跳之前」那段已确认的耗时会计入 work.model_ms（不抹掉已知事实），
 * 心跳之后的尾巴永不补；中断样本本身由估算方排除在成功样本之外。
 */
export function freezeInterruptedObservations(): { works: number; calls: number } {
  const result = freezeInterrupted()
  if (result.works || result.calls) {
    console.log(`⏸️ 任务观测：${result.works} 个工作项 / ${result.calls} 次调用标记为中断（耗时冻结在最后心跳）`)
  }
  return result
}

// ─── 读取 ────────────────────────────────────────────────────────────────

export function listObservedWork(taskId: number): ObservedWorkRow[] {
  return worksByTaskStmt.all(taskId) as ObservedWorkRow[]
}

/** 同阶段同口径的历史样本（最新在前，上限 500 行）；状态不过滤，由估算方自行取舍 */
export function listObservedSamples(stage: ObservedStage, sampleKey: string): ObservedWorkRow[] {
  return worksBySampleStmt.all(stage, sampleKey, 500) as ObservedWorkRow[]
}

export function listObservedCalls(
  taskId: number,
  opts: { workId?: number; afterId?: number; limit?: number } = {},
): ObservedCallRow[] {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 50)), 200)
  const after = Math.max(0, Math.trunc(opts.afterId ?? 0))
  return (opts.workId != null
    ? callPageByWorkStmt.all(taskId, after, opts.workId, limit)
    : callPageStmt.all(taskId, after, limit)) as ObservedCallRow[]
}

export function getObservedCall(callId: number): ObservedCallRow | null {
  return (callByIdStmt.get(callId) as ObservedCallRow | undefined) ?? null
}

export function listObservedMessages(
  callId: number,
  opts: { afterId?: number; limit?: number } = {},
): ObservedMessageRow[] {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 40)), 200)
  const after = Math.max(0, Math.trunc(opts.afterId ?? 0))
  return messagePageStmt.all(callId, after, limit) as ObservedMessageRow[]
}

export function countObservedMessages(callId: number): number {
  return (countMessagesStmt.get(callId) as { n: number } | undefined)?.n ?? 0
}
