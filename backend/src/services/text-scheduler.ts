import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { effectiveConcurrency, isOfficialProvider, listActiveTextConfigs } from './ai.js'
import { AI_STAGES, StageVisionUnavailableError, type AiStage, type StageModel } from './ai-stages.js'
import { currentTextTaskId } from './text-task-context.js'
import { markTextTaskStarted } from './text-task.js'

export interface TextEndpoint {
  configId: number
  provider: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  vision: boolean
  concurrency: number
  temperature: number | null
  settings: string | null
  suspended: boolean
  suspendedReason: string | null
}

type Waiter = { interactive: boolean; resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }
type Lane = { active: number; queue: Waiter[] }

/** In-process admission; persistence of endpoint health belongs to the registry. */
export class TextSlotQueue {
  private lanes = new Map<number, Lane>()
  constructor(private endpoints: () => Promise<TextEndpoint[]>, private onStart: () => Promise<void> = async () => {}) {}

  load(endpoint: TextEndpoint): number {
    const lane = this.lanes.get(endpoint.configId)
    return ((lane?.active ?? 0) + (lane?.queue.length ?? 0)) / endpoint.concurrency
  }

  async eligible(opts: { vision: boolean; configId?: number }): Promise<TextEndpoint[]> {
    return (await this.endpoints()).filter(e => !e.suspended && (!opts.vision || e.vision) && (opts.configId == null || e.configId === opts.configId))
  }

  async run<T>(args: { configId: number; interactive?: boolean; signal?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
    const endpoint = (await this.eligible({ vision: false, configId: args.configId }))[0]
    if (!endpoint) throw new Error('文本模型不可用、已停用或已暂停')
    if (args.signal?.aborted) throw args.signal.reason
    let lane = this.lanes.get(args.configId)
    if (!lane) { lane = { active: 0, queue: [] }; this.lanes.set(args.configId, lane) }
    const current = lane
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { interactive: !!args.interactive, resolve, reject, signal: args.signal }
      waiter.abort = () => {
        const index = current.queue.indexOf(waiter)
        if (index >= 0) { current.queue.splice(index, 1); reject(args.signal?.reason) }
      }
      args.signal?.addEventListener('abort', waiter.abort, { once: true })
      current.queue.push(waiter)
      this.pump(current, endpoint.concurrency)
    })
    try {
      await this.onStart()
      return await fn()
    } finally {
      current.active--
      this.pump(current, endpoint.concurrency)
    }
  }

  rejectQueued(configId: number): void {
    const lane = this.lanes.get(configId)
    if (!lane) return
    for (const waiter of lane.queue.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort!)
      waiter.reject(Object.assign(new Error('文本模型已暂停'), { status: 503 }))
    }
  }

  private pump(lane: Lane, limit: number): void {
    while (lane.active < limit && lane.queue.length) {
      const interactive = lane.queue.findIndex(w => w.interactive)
      const [waiter] = lane.queue.splice(interactive < 0 ? 0 : interactive, 1)
      waiter.signal?.removeEventListener('abort', waiter.abort!)
      lane.active++
      waiter.resolve()
    }
  }
}

async function readEndpoints(): Promise<TextEndpoint[]> {
  const configs = await listActiveTextConfigs()
  return configs.filter(c => c.id != null && isOfficialProvider('text', c.provider)).map(c => ({
    configId: c.id!, provider: c.provider, name: c.name || '', baseUrl: c.baseUrl,
    apiKey: c.apiKey, model: c.model, vision: !!c.vision, concurrency: effectiveConcurrency(c),
    temperature: c.temperature ?? null, settings: c.settings ?? null,
    suspended: !!c.suspendedAt, suspendedReason: c.suspendedReason ?? null,
  }))
}

const slots = new TextSlotQueue(readEndpoints, async () => {
  const id = currentTextTaskId()
  if (id != null) await markTextTaskStarted(id)
})

export async function listEligibleTextEndpoints(opts: { vision: boolean; configId?: number }): Promise<TextEndpoint[]> {
  return slots.eligible(opts)
}

export async function selectTextEndpoint(opts: { vision: boolean; excludeConfigIds?: number[] }): Promise<TextEndpoint | undefined> {
  const endpoints = (await listEligibleTextEndpoints({ vision: opts.vision }))
    .filter(endpoint => !opts.excludeConfigIds?.includes(endpoint.configId))
  endpoints.sort((a, b) => slots.load(a) - slots.load(b))
  return endpoints[0]
}

export async function assignTextEndpoint(stage: AiStage, opts: { configId?: number; model?: string; excludeConfigIds?: number[] } = {}): Promise<StageModel> {
  const spec = AI_STAGES[stage]
  if (!spec) throw new Error(`未登记的 AI 环节：${stage}`)
  const endpoints = (await listEligibleTextEndpoints({ vision: spec.vision, configId: opts.configId }))
    .filter(endpoint => !opts.excludeConfigIds?.includes(endpoint.configId))
  // Registry order is priority order; stable sort retains it on equal load.
  endpoints.sort((a, b) => slots.load(a) - slots.load(b))
  const endpoint = endpoints[0]
  if (!endpoint) {
    if (spec.vision) throw new StageVisionUnavailableError(stage, spec.label)
    throw new Error('未配置可用文本模型，或指定的文本模型已停用或暂停')
  }
  return { ...endpoint, stage, label: spec.label, vision: spec.vision,
    model: opts.model || endpoint.model, pinned: opts.configId != null }
}

export async function withTextSlot<T>(args: { configId: number; interactive?: boolean; signal?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
  return slots.run(args, fn)
}

export function isModelError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string; status?: number; statusCode?: number; code?: string; cause?: unknown }
  if (/content[_ -]?(filter|policy|moderation)|safety[_ -]?(filter|policy)|内容审核|内容安全/i.test(`${e.code ?? ''} ${e.message ?? ''}`)) return false
  const status = e.status ?? e.statusCode
  if (typeof status === 'number') return status === 401 || status === 403 || status === 429 || status >= 500 && status <= 599
  if (e.name === 'TimeoutError') return true
  if (e.name === 'AbortError' || e.name === 'SyntaxError') return false
  if (e.code && /^(ECONN|ENET|EHOST|ETIMEDOUT|EPIPE|UND_ERR_)/.test(e.code)) return true
  if (/\b(fetch failed|network error|socket hang up|timed?\s*out|timeout)\b/i.test(e.message || '')) return true
  return e.cause != null && e.cause !== err ? isModelError(e.cause) : false
}

export async function noteEndpointSuccess(configId: number): Promise<void> {
  await db.update(schema.aiServiceConfigs).set({ consecutiveErrors: 0 }).where(eq(schema.aiServiceConfigs.id, configId))
}

export async function noteEndpointError(configId: number, err: unknown): Promise<void> {
  if (!isModelError(err)) return
  const reason = err instanceof Error ? err.message.slice(0, 300) : '模型服务错误'
  await db.update(schema.aiServiceConfigs).set({
    consecutiveErrors: sql`${schema.aiServiceConfigs.consecutiveErrors} + 1`,
    suspendedAt: sql`CASE WHEN ${schema.aiServiceConfigs.consecutiveErrors} + 1 >= 3 THEN datetime('now') ELSE ${schema.aiServiceConfigs.suspendedAt} END`,
    suspendedReason: sql`CASE WHEN ${schema.aiServiceConfigs.consecutiveErrors} + 1 >= 3 THEN ${reason} ELSE ${schema.aiServiceConfigs.suspendedReason} END`,
  }).where(eq(schema.aiServiceConfigs.id, configId))
  const rows = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId))
  if (rows[0]?.suspendedAt) slots.rejectQueued(configId)
}

export async function resumeTextConfig(configId: number): Promise<void> {
  await db.update(schema.aiServiceConfigs).set({ consecutiveErrors: 0, suspendedAt: null, suspendedReason: null }).where(eq(schema.aiServiceConfigs.id, configId))
}
