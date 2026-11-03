/**
 * 旁白覆盖缺口的「补全剩余」（Issue #52）。
 *
 * 纪录片拆分分镜跑到一半停下时（覆盖闸门把任务标失败），已经拆好的分镜连同表达设计、
 * 选版、关键帧都还在；整集重拆会把它们全部重做。这里提供的是续拆：
 * 1. `episodeNarrationCoverage` —— 整集覆盖状态（前端进度条、闸门、重试判定共用同一口径）；
 * 2. `startFillGapsTask` —— 只把**缺口片段**喂给纪录片 `storyboard_breaker`，工具走「补镜模式」
 *    （纯插入、服务端临时编号、旁白必须落在缺口内）；
 * 3. `renumberStoryboardsByScript` —— 跑完按每镜旁白在剧本中的起始位置整集重编号（id 不变）。
 *
 * 编号归位是两阶段写：先把要改号的行写成唯一负号，再写最终号，即便将来给
 * (episode_id, storyboard_number) 加唯一索引也不会中途撞号。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveDramaProjectType } from './project-type.js'
import { spokenText } from './narration-markup.js'
import { MAX_NARRATION_CHARS } from './narration.js'
import {
  describeNarrationGaps,
  narrationCoverage,
  narrationMatchKey,
  scriptMatchKey,
  type NarrationGap,
} from './narration-first.js'
import { parseShotIntent } from './shot-intent.js'
import { slotOwnImage } from './keyframes.js'
import { startShotIntentBatch } from './shot-intent-batch.js'
import {
  createTextTask,
  findActiveTextTask,
  finishTextTask,
  resolveTextModel,
} from './text-task.js'

export interface StoryboardNarrationRow {
  id: number
  storyboardNumber: number
  narrationText: string | null
}

export interface RenumberEntry {
  id: number
  from: number
  to: number
}

/**
 * 整集重编号方案（纯函数，便于单测）：按每镜旁白在剧本中的起始位置排序。
 * 定位不到（旁白被人改过、或是刻意留白的纯画面镜头）时沿用「上一镜的位置」，
 * 位置相同的按旧编号稳定排序 —— 任何情况下都不会把无法定位的镜头甩到末尾。
 */
export function planRenumber(scriptKey: string, rows: StoryboardNarrationRow[]): RenumberEntry[] {
  const sorted = [...rows].sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  let carry = -1
  const keyed = sorted.map((row, seq) => {
    const key = narrationMatchKey(spokenText(row.narrationText || ''))
    const at = key ? scriptKey.indexOf(key) : -1
    if (at >= 0) carry = at
    return { row, at: at >= 0 ? at : carry, seq }
  })
  keyed.sort((a, b) => a.at - b.at || a.seq - b.seq)
  return keyed.map((entry, index) => ({ id: entry.row.id, from: entry.row.storyboardNumber, to: index + 1 }))
}

/** id → 排序后「上一镜 id」（第一镜为 null） */
function previousMap(order: Array<{ id: number }>): Map<number, number | null> {
  const map = new Map<number, number | null>()
  order.forEach((entry, index) => map.set(entry.id, index > 0 ? order[index - 1]!.id : null))
  return map
}

export interface RenumberResult {
  changed: number
  entries: RenumberEntry[]
  /** 因为「上一镜」变了而被取消关键帧确认的分镜 id */
  reconfirm: number[]
}

/**
 * 按剧本位置整集重编号。只改 `storyboard_number`，id / 表达设计 / 选版 / 子数据一律不动。
 * 编号没有变化时一行都不写（幂等）。
 */
export async function renumberStoryboardsByScript(episodeId: number): Promise<RenumberResult> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) return { changed: 0, entries: [], reconfirm: [] }
  const scriptKey = scriptMatchKey(episode.scriptContent || episode.content)

  // 读 → 算 → 写全部在同一个同步事务里：并发的保存/删除不会插在中间造成编号错位
  const { entries, reconfirm } = db.transaction(() => {
    const rows = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter(sb => !sb.deletedAt)
    const order = planRenumber(scriptKey, rows)
    const changedEntries = order.filter(entry => entry.from !== entry.to)
    if (!changedEntries.length) return { entries: order, reconfirm: [] as number[] }

    const before = previousMap([...rows].sort((a, b) => a.storyboardNumber - b.storyboardNumber))
    const after = previousMap(order)
    const ts = now()
    // 第一阶段：要改号的行先写唯一负号，避开与尚未改号的行撞号（唯一约束 / 排序中间态）
    for (const entry of changedEntries) {
      db.update(schema.storyboards).set({ storyboardNumber: -entry.to, updatedAt: ts })
        .where(eq(schema.storyboards.id, entry.id)).run()
    }
    for (const entry of changedEntries) {
      db.update(schema.storyboards).set({ storyboardNumber: entry.to, updatedAt: ts })
        .where(eq(schema.storyboards.id, entry.id)).run()
    }

    // 「上一镜」变了的继承镜（#keyframes 规则）：首帧来源换人，人工确认必须重来
    const byId = new Map(rows.map(sb => [sb.id, sb]))
    const needReconfirm: number[] = []
    for (const entry of order) {
      if (before.get(entry.id) === after.get(entry.id)) continue
      const row = byId.get(entry.id)!
      if (!row.keyframesConfirmed) continue
      if (slotOwnImage(row, 'first') || row.continuityBoundary !== 'continue') continue
      db.update(schema.storyboards).set({ keyframesConfirmed: false, updatedAt: ts })
        .where(eq(schema.storyboards.id, entry.id)).run()
      needReconfirm.push(entry.id)
    }
    return { entries: order, reconfirm: needReconfirm }
  })

  const changed = entries.filter(entry => entry.from !== entry.to).length
  if (changed) {
    logTaskSuccess('FillGaps', 'renumber', { episodeId, changed, reconfirm: reconfirm.length })
  }
  return { changed, entries, reconfirm }
}

export interface EpisodeCoverage {
  episode_id: number
  project_type: 'drama' | 'documentary'
  script_chars: number
  covered_chars: number
  uncovered_chars: number
  gaps: NarrationGap[]
  gap_count: number
  shots: number
  /** 本集是否有拆分/补镜文本任务在跑（有就不能再发起补镜） */
  running: boolean
}

/** 整集旁白覆盖状态。非纪录片项目恒为「无缺口」，前端据此隐藏入口 */
export async function episodeNarrationCoverage(episodeId: number): Promise<EpisodeCoverage | null> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) return null
  const projectType = resolveDramaProjectType(episode.dramaId)
  const rows = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const running = !!(await findActiveTextTask(episodeId, 'storyboard_fill_gaps'))
    || !!(await findActiveTextTask(episodeId, 'storyboard_breaker'))
  if (projectType !== 'documentary') {
    return {
      episode_id: episodeId,
      project_type: projectType,
      script_chars: 0,
      covered_chars: 0,
      uncovered_chars: 0,
      gaps: [],
      gap_count: 0,
      shots: rows.length,
      running,
    }
  }
  const coverage = narrationCoverage(episode.scriptContent || episode.content, rows.map(sb => sb.narrationText))
  return {
    episode_id: episodeId,
    project_type: projectType,
    script_chars: coverage.script_chars,
    covered_chars: coverage.covered_chars,
    uncovered_chars: coverage.uncovered_chars,
    gaps: coverage.gaps,
    gap_count: coverage.gaps.length,
    shots: rows.length,
    running,
  }
}

/** 缺口两侧相邻镜的承接上下文：旁白尾/首句 + 表达设计的信息点与手段 */
function neighbourBrief(row: typeof schema.storyboards.$inferSelect | undefined, side: 'before' | 'after'): string {
  if (!row) return side === 'before' ? '（缺口在全集开头，没有上一镜）' : '（缺口在全集结尾，没有下一镜）'
  const intent = parseShotIntent(row.intent)
  const narration = (row.narrationText || '').trim()
  const excerpt = side === 'before' ? narration.slice(-40) : narration.slice(0, 40)
  const design = intent ? `信息点「${intent.info_point || ''}」/ 手段 ${intent.device || ''}` : '（还没有表达设计）'
  return `分镜 #${row.storyboardNumber}（ID:${row.id}）：旁白…${excerpt} ｜ ${design}`
}

/** 补镜消息：只给缺口原文 + 前后相邻镜的承接信息，不重复整集剧本 */
function buildFillMessage(gaps: NarrationGap[], scriptKey: string, rows: Array<typeof schema.storyboards.$inferSelect>): string {
  const covered = rows.map(sb => ({ row: sb, key: narrationMatchKey(spokenText(sb.narrationText || '')) }))
    .map(item => ({ row: item.row, at: item.key ? scriptKey.indexOf(item.key) : -1, len: item.key.length }))
  const blocks = gaps.map((gap, index) => {
    const before = covered.filter(item => item.at >= 0 && item.at + item.len <= gap.start)
      .sort((a, b) => (a.at + a.len) - (b.at + b.len)).at(-1)?.row
    const after = covered.filter(item => item.at >= gap.end).sort((a, b) => a.at - b.at)[0]?.row
    return `【缺口 ${index + 1}／${gaps.length}】剧本第 ${gap.start}–${gap.end} 字，共 ${gap.chars} 字
上一镜：${neighbourBrief(before, 'before')}
下一镜：${neighbourBrief(after, 'after')}
缺口原文（逐字照抄，不要改写、合并或增删任何字）：
${scriptKey.slice(gap.start, gap.end)}`
  }).join('\n\n')
  return `本集已经拆好的分镜全部保留，现在只补上还没有被任何一镜领走的剧本片段（补镜模式）。

${blocks}

补镜规则（save_storyboards 会逐条校验，违反就拒存）：
- 只为上面列出的缺口写新镜头，每一镜的 narration_text 必须逐字取自对应缺口原文，按缺口内顺序依次切分，首尾相接不留空、不重叠，整段切完为止；每镜不超过 ${MAX_NARRATION_CHARS} 字，只在句界处切。
- 不要传 replace_existing，也不要管 shot_number：服务端会自己安排临时编号，跑完按旁白在剧本中的位置整集重排。既有分镜一条都不会被覆盖。
- 每一镜照 documentary-storyboard 技能写全画面字段与 intent（表达设计），并与上面给出的上一镜/下一镜承接：continuity 默认 "cut"。
- 一批最多 8 镜，分批调用直到工具返回的 script_coverage.gaps 为空。`
}

export interface FillGapsStart {
  started: boolean
  gaps: number
  taskId?: number
  /** 没有启动的原因：running = 已有拆分/补镜任务；covered = 无缺口；not_documentary */
  reason?: 'running' | 'covered' | 'not_documentary'
}

/**
 * 发起「补全剩余」。无缺口不建任务（幂等），本集已有拆分/补镜任务在跑时拒绝。
 */
export async function startFillGapsTask(
  episodeId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
): Promise<FillGapsStart> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) throw new Error('剧集不存在')
  const dramaId = episode.dramaId
  if (resolveDramaProjectType(dramaId) !== 'documentary') {
    return { started: false, gaps: 0, reason: 'not_documentary' }
  }
  if (await findActiveTextTask(episodeId, 'storyboard_fill_gaps')
    || await findActiveTextTask(episodeId, 'storyboard_breaker')) {
    return { started: false, gaps: 0, reason: 'running' }
  }

  const scriptKey = scriptMatchKey(episode.scriptContent || episode.content)
  const rows = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)))
    .filter(sb => !sb.deletedAt)
    .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const gaps = narrationCoverage(scriptKey, rows.map(sb => sb.narrationText)).gaps
  if (!gaps.length) return { started: false, gaps: 0, reason: 'covered' }

  const agent = mastra.getAgent('storyboard_breaker')
  if (!agent) throw new Error('分镜 Agent 不可用')
  const message = buildFillMessage(gaps, scriptKey, rows)
  const resolved = await resolveTextModel(opts)
  const taskId = await createTextTask({
    kind: 'storyboard_fill_gaps',
    episodeId,
    dramaId,
    prompt: message,
    provider: resolved.provider,
    model: resolved.model,
    configId: opts.configId ?? resolved.configId ?? undefined,
    retryOf: opts.retryOf,
  })
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId,
    textTaskId: taskId,
    storyboardFillGaps: true,
    modelOverride: opts.model || undefined,
    textConfigId: opts.configId || undefined,
  })
  const sink = createReasoningSink(taskId)
  const knownIds = new Set(rows.map(sb => sb.id))
  logTaskStart('FillGaps', 'run', { episodeId, dramaId, gaps: gaps.length, taskId })

  runAgent(agent, [{ role: 'user', content: message }], { maxSteps: 20, requestContext }, sink)
    .then(async result => {
      // 先按剧本位置归位编号，再按覆盖结果判定成败
      const renumber = await renumberStoryboardsByScript(episodeId)
      const after = await episodeNarrationCoverage(episodeId)
      const fresh = (await db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)))
        .filter(sb => !sb.deletedAt && !knownIds.has(sb.id))
      // 新镜的表达设计（#49）：补齐缺失的那几镜，不动既有镜
      if (fresh.length) {
        await startShotIntentBatch(episodeId, dramaId, { model: opts.model, configId: opts.configId },
          fresh.filter(sb => !(sb.intent || '').trim()).map(sb => sb.id))
      }
      const summary = `补镜完成：新增 ${fresh.length} 镜，重编号 ${renumber.changed} 镜。\n${result.text || ''}`
      if (after && after.gap_count) {
        const detail = `旁白覆盖缺口：剧本仍有 ${after.gap_count} 段未被任何分镜领走（${describeNarrationGaps(after.gaps)}）。可以再次「补全剩余」。`
        await finishTextTask(taskId, 'failed', { errorMsg: detail, outputText: summary })
        logTaskError('FillGaps', 'run', { episodeId, taskId, error: detail })
        return
      }
      await finishTextTask(taskId, 'completed', { outputText: summary })
      logTaskSuccess('FillGaps', 'run', { episodeId, taskId, added: fresh.length, renumbered: renumber.changed })
    })
    .catch(async (err: unknown) => {
      const message2 = err instanceof Error ? err.message : '补全剩余失败'
      await finishTextTask(taskId, 'failed', { errorMsg: message2 })
      logTaskError('FillGaps', 'run', { episodeId, taskId, error: message2 })
    })

  return { started: true, gaps: gaps.length, taskId }
}

/** 失败的纪录片拆分任务是不是「覆盖缺口」失败（任务中心重试据此改走补镜） */
export function isCoverageGapFailure(errorMsg: string | null | undefined): boolean {
  return (errorMsg || '').includes('旁白覆盖缺口')
}
