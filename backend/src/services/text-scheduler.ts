import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { effectiveConcurrency, isOfficialProvider, listActiveTextConfigs } from './ai.js'
import {
  AI_STAGES,
  StagePinUnavailableError,
  StageTextUnavailableError,
  StageVisionUnavailableError,
  type AiStage,
  type StageCandidate,
  type StageModel,
  type StagePinFacts,
} from './ai-stages.js'
import { currentTextTaskId } from './text-task-context.js'
import { isModelError } from './text-model-errors.js'
import { markTextTaskStarted, parseTextTaskParams } from './text-task.js'

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
  consecutiveErrors: number
}

type Waiter = { interactive: boolean; resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort?: () => void }
type Lane = { active: number; queue: Waiter[] }

/** In-process admission; persistence of endpoint health belongs to the registry. */
export class TextSlotQueue {
  private lanes = new Map<number, Lane>()
  /** Assignments made before the first request runs: keeps 70 queued tasks from all picking one endpoint. */
  private assigned = new Map<number, number>()
  constructor(private endpoints: () => Promise<TextEndpoint[]>, private onStart: () => Promise<void> = async () => {}) {}

  load(endpoint: TextEndpoint): number {
    const lane = this.lanes.get(endpoint.configId)
    return ((lane?.active ?? 0) + (lane?.queue.length ?? 0)) / endpoint.concurrency
  }

  /** Balance new task assignments by concurrency, independent of whether their first call has started. */
  assignmentScore(endpoint: TextEndpoint): number {
    const assigned = this.assigned.get(endpoint.configId) ?? 0
    return assigned / endpoint.concurrency + endpoint.consecutiveErrors
  }

  noteAssigned(configId: number): void {
    this.assigned.set(configId, (this.assigned.get(configId) ?? 0) + 1)
  }

  async eligible(opts: { vision: boolean; configId?: number }): Promise<TextEndpoint[]> {
    return (await this.endpoints()).filter(e => !e.suspended && (!opts.vision || e.vision) && (opts.configId == null || e.configId === opts.configId))
  }

  async run<T>(args: { configId: number; interactive?: boolean; signal?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
    const endpoint = (await this.eligible({ vision: false, configId: args.configId }))[0]
    if (!endpoint) {
      const raw = (await this.endpoints()).find(candidate => candidate.configId === args.configId)
      // 暂停是模型侧故障（可换端点重试），不是「没有可用配置」
      if (raw?.suspended) throw Object.assign(new Error('文本模型已暂停'), { status: 503, configId: args.configId })
      throw new Error('文本模型不可用、已停用或已暂停')
    }
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
    consecutiveErrors: c.consecutiveErrors ?? 0,
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

/** 本环节当前真正能用的配置（显式指定不可用时回给界面当候选） */
async function stageCandidates(vision: boolean, excluded: Set<number>): Promise<StageCandidate[]> {
  return (await listEligibleTextEndpoints({ vision }))
    .filter(endpoint => !excluded.has(endpoint.configId))
    .map(endpoint => ({
      config_id: endpoint.configId,
      name: endpoint.name || `配置 ${endpoint.configId}`,
      provider: endpoint.provider,
      model: endpoint.model,
      vision: endpoint.vision,
    }))
}

/** 某条配置登记的全部模型名（`ai_service_configs.model` 存的是 JSON 数组） */
async function configModelNames(configId: number): Promise<string[]> {
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId))
  if (!row?.model) return []
  try {
    const parsed: unknown = JSON.parse(row.model)
    const names = Array.isArray(parsed) ? parsed : [parsed]
    return names.map(name => String(name || '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 显式指定的那条配置**为什么**不能用于本环节。按「改了也没用」优先：不存在 / 停用 / 厂商不支持 /
 * 没有模型名 / 不是视觉模型，都比「暂停」更根本；暂停是可恢复的模型侧故障，单列。
 */
async function pinnedConfigFacts(configId: number, visionRequired: boolean): Promise<StagePinFacts> {
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId))
  const name = row?.name || `配置 ${configId}`
  if (!row || row.serviceType !== 'text') return { configId, name, reason: 'missing' }
  if (!row.isActive) return { configId, name, reason: 'inactive' }
  if (!isOfficialProvider('text', row.provider)) {
    return { configId, name, reason: 'unsupported_provider', detail: row.provider || null }
  }
  if (!(await configModelNames(configId)).length) return { configId, name, reason: 'no_model' }
  if (visionRequired && row.vision !== true) return { configId, name, reason: 'not_vision' }
  if (row.suspendedAt) return { configId, name, reason: 'suspended', detail: row.suspendedReason || null }
  // 配置本身没问题，是本次请求把它排除了（重试避让 / 调用方显式 exclude）
  return { configId, name, reason: 'missing', detail: '本次请求已排除这条配置' }
}

export async function assignTextEndpoint(
  stage: AiStage,
  opts: { configId?: number; model?: string; excludeConfigIds?: number[]; retryOf?: number } = {},
): Promise<StageModel> {
  const spec = AI_STAGES[stage]
  if (!spec) throw new Error(`未登记的 AI 环节：${stage}`)
  const pinned = opts.configId != null
  const excluded = new Set(opts.excludeConfigIds ?? [])
  if (opts.retryOf && !pinned) {
    // 自动/手动重试：避开原任务实际失败的那条配置，除非请求硬指定了配置
    const [parent] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, opts.retryOf))
    const failedConfigId = parent ? (parseTextTaskParams(parent.params)?.model_used as { config_id?: number | null } | undefined)?.config_id : null
    if (failedConfigId != null) excluded.add(failedConfigId)
  }
  const endpoints = (await listEligibleTextEndpoints({ vision: spec.vision, configId: opts.configId }))
    .filter(endpoint => !excluded.has(endpoint.configId))
  // Balance by concurrency, then by error count; stable sort keeps priority order for ties.
  endpoints.sort((a, b) => slots.assignmentScore(a) - slots.assignmentScore(b))
  const endpoint = endpoints[0]
  if (!endpoint) {
    // 显式指定的配置用不了：指名原因 + 列出可用候选，**绝不**静默换到另一条计费服务，
    // 更不能谎称「全局没有视觉配置」（Issue #87 的 500 误报根因）。
    if (pinned) {
      throw new StagePinUnavailableError(
        stage, spec.label, spec.vision,
        await pinnedConfigFacts(opts.configId!, spec.vision),
        await stageCandidates(spec.vision, excluded),
      )
    }
    if (spec.vision) throw new StageVisionUnavailableError(stage, spec.label)
    throw new StageTextUnavailableError(stage, spec.label)
  }
  // 模型名只有在**最终用的就是请求指定的那条配置**时才生效（StageModelOptions 的既有口径）：
  // 自动模式下顶栏残留的模型字符串绝不能套到另一条端点上，否则真正的调用会用错模型名。
  if (pinned && opts.model && opts.model !== endpoint.model) {
    const allowed = await configModelNames(endpoint.configId)
    if (!allowed.includes(opts.model)) {
      throw new StagePinUnavailableError(
        stage, spec.label, spec.vision,
        {
          configId: endpoint.configId,
          name: endpoint.name || `配置 ${endpoint.configId}`,
          reason: 'model_mismatch',
          detail: allowed.length ? `这条配置可用的模型：${allowed.join('、')}` : null,
        },
        await stageCandidates(spec.vision, excluded),
      )
    }
  }
  slots.noteAssigned(endpoint.configId)
  return { ...endpoint, stage, label: spec.label, vision: spec.vision,
    model: pinned && opts.model ? opts.model : endpoint.model, pinned }
}

export async function withTextSlot<T>(args: { configId: number; interactive?: boolean; signal?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
  return slots.run(args, fn)
}

export { isModelError } from './text-model-errors.js'

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
