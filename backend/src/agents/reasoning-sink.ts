/**
 * 文本任务思考内容接收器（Issue #19）
 *
 * GLM / DeepSeek 的流式响应里 `delta.reasoning_content` 会被 @ai-sdk/openai 丢弃，
 * 这里在 fetch 层 tee 一路 SSE 自行解析（agents/index.ts createReasoningCaptureFetch），
 * 把思考文本按任务落盘到 `DATA_ROOT/text-tasks/<taskId>.reasoning.txt`，
 * 并节流把累计字数写进 sys_task.params.reasoning_chars 供任务中心显示。
 *
 * 无 sink（final-prompt / transition 等无任务行）时 fetch 层原样透传，零开销。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'
import { updateTextTaskReasoningChars } from '../services/text-task.js'

const REASONING_DIR = path.join(DATA_ROOT, 'text-tasks')
const RUN_SEPARATOR = '\n\n—— 新一次运行 ——\n'
const TOOL_MARK = '\n[提交工具调用…]\n'

/** 缓冲写盘间隔（ms）与批量阈值（字符） */
const FLUSH_INTERVAL_MS = 1_000
const FLUSH_THRESHOLD = 2_048
/** params.reasoning_chars 的更新间隔（ms） */
const PARAMS_INTERVAL_MS = 3_000

export interface ReasoningSink {
  /** 追加思考文本 */
  append(text: string): void
  /** 写入一个小节标题（批量任务逐镜分隔，本身也充当运行分隔） */
  heading(text: string): void
  /** 首个工具调用出现时打一次标记（工具参数缓冲期用户能看到发生了什么） */
  markToolCall(): void
  /** 写完剩余缓冲并落最终 reasoning_chars */
  flush(): Promise<void>
}

function reasoningFilePath(taskId: number): string {
  return path.join(REASONING_DIR, `${taskId}.reasoning.txt`)
}

export function createReasoningSink(taskId: number): ReasoningSink {
  let chars = 0
  let initialized = false
  let separatorPending = true
  let toolMarked = false
  let buffer = ''
  let flushTimer: NodeJS.Timeout | null = null
  let lastFlushAt = 0
  let lastParamsAt = 0
  let writeChain: Promise<void> = Promise.resolve()

  const persist = (data: string): void => {
    writeChain = writeChain
      .then(async () => {
        if (!initialized) {
          initialized = true
          await mkdir(REASONING_DIR, { recursive: true })
          const existing = await stat(reasoningFilePath(taskId)).then(s => s.size).catch(() => 0)
          if (existing > 0) buffer = RUN_SEPARATOR + buffer
        }
        await appendFile(reasoningFilePath(taskId), data, 'utf8')
      })
      .catch(() => { /* 落盘失败不中断生成 */ })
  }

  const syncParams = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastParamsAt < PARAMS_INTERVAL_MS) return
    lastParamsAt = now
    void updateTextTaskReasoningChars(taskId, chars).catch(() => { /* 进度展示缺失可接受 */ })
  }

  const maybeScheduleFlush = (): void => {
    const now = Date.now()
    if (buffer.length >= FLUSH_THRESHOLD || now - lastFlushAt >= FLUSH_INTERVAL_MS) {
      void flush()
      return
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; void flush() }, FLUSH_INTERVAL_MS - (now - lastFlushAt))
    }
  }

  const appendRaw = (text: string): void => {
    buffer += text
    maybeScheduleFlush()
  }

  async function flush(): Promise<void> {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (buffer) {
      const data = buffer
      buffer = ''
      lastFlushAt = Date.now()
      chars += data.length
      persist(data)
    }
    await writeChain
    syncParams(true)
  }

  return {
    append(text) {
      if (!text) return
      separatorPending = false
      appendRaw(text)
    },
    heading(text) {
      separatorPending = false
      appendRaw(`\n\n—— ${text} ——\n`)
    },
    markToolCall() {
      if (toolMarked) return
      toolMarked = true
      appendRaw(TOOL_MARK)
    },
    flush,
  }
}

// ─── AsyncLocalStorage：fetch 层与 runAgent 之间传递 sink ─────────────────

const reasoningALS = new AsyncLocalStorage<ReasoningSink>()

export function runWithReasoningSink<T>(sink: ReasoningSink, fn: () => Promise<T>): Promise<T> {
  return reasoningALS.run(sink, fn)
}

export function getActiveReasoningSink(): ReasoningSink | undefined {
  return reasoningALS.getStore()
}

// ─── SSE 解析：从 tee 出来的响应流里取 reasoning_content ──────────────────

interface ChatStreamChunk {
  choices?: Array<{ delta?: { reasoning_content?: unknown; tool_calls?: unknown } }>
}

function isChatStreamChunk(value: unknown): value is ChatStreamChunk {
  return typeof value === 'object' && value !== null && 'choices' in value
}

/**
 * 持续消费 tee 出来的 SSE 流（不消费会导致 tee 缓冲积压），
 * 把 `choices[0].delta.reasoning_content` 喂给 sink；任何解析错误静默忽略。
 */
export async function captureReasoningFromStream(body: ReadableStream<Uint8Array>, sink: ReasoningSink): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch { return }
    if (!isChatStreamChunk(parsed)) return
    const delta = parsed.choices?.[0]?.delta
    if (!delta) return
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) sink.append(delta.reasoning_content)
    if (delta.tool_calls != null) sink.markToolCall()
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuffer += decoder.decode(value, { stream: true })
      let newlineIndex = lineBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        handleLine(lineBuffer.slice(0, newlineIndex))
        lineBuffer = lineBuffer.slice(newlineIndex + 1)
        newlineIndex = lineBuffer.indexOf('\n')
      }
    }
    if (lineBuffer) handleLine(lineBuffer)
  } catch {
    /* 捕获分支失败不影响主流程 */
  }
}

// ─── 读取（GET /tasks/:id/reasoning） ────────────────────────────────────

export interface ReasoningRange { tail?: number; offset?: number; limit?: number }

/** 读取任务的思考文本；chars 恒为全文字符数，text 为请求区间的内容 */
export async function readReasoningFile(taskId: number, range: ReasoningRange): Promise<{ chars: number; text: string; offset: number }> {
  const content = await readFile(reasoningFilePath(taskId), 'utf8').catch(() => '')
  const chars = content.length
  if (range.offset != null) {
    const limit = range.limit ?? 4096
    const offset = Math.min(range.offset, chars)
    return { chars, text: content.slice(offset, offset + limit), offset }
  }
  const tail = Math.min(range.tail ?? 4096, chars)
  return { chars, text: tail > 0 ? content.slice(chars - tail) : '', offset: Math.max(0, chars - tail) }
}
