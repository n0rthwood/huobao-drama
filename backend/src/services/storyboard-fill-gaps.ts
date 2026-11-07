import { runWithTextTask } from './text-task-context.js'

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
import { parseDesignCard } from './design-card.js'
import { slotOwnImage } from './keyframes.js'
import { resolveStageModel } from './ai-stages.js'
import { buildEvidenceImages, evidenceMessageParts } from './evidence-images.js'
import { consumeStoryboardStopReason } from '../agents/tools/storyboard-tools.js'
import {
  createTextTask,
  findActiveTextTask,
  finishTextTask,
  patchTextTaskParams,
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

/**
 * 人工重排（Issue #57，契约 §8 行 2）：`ids` 必须是本集存活分镜的**全集**，
 * 按数组顺序重写 `storyboard_number`。写法与 `renumberStoryboardsByScript` 完全一致
 * （同一同步事务 + 两阶段负号 + 「上一镜变了就撤销关键帧确认」级联）。
 * `ids` 不是全集时抛错，由路由转 400。
 */
export async function reorderStoryboards(episodeId: number, ids: number[]): Promise<RenumberResult> {
  const { entries, reconfirm } = db.transaction(() => {
    const rows = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter(sb => !sb.deletedAt)
    const alive = new Set(rows.map(sb => sb.id))
    const unique = new Set(ids)
    if (unique.size !== ids.length) throw new Error('ids 里有重复的分镜')
    if (ids.length !== alive.size || ids.some(id => !alive.has(id))) {
      throw new Error(`ids 必须是本集全部 ${alive.size} 个存活分镜（收到 ${ids.length} 个）`)
    }

    const byId = new Map(rows.map(sb => [sb.id, sb]))
    const order: RenumberEntry[] = ids.map((id, index) => ({ id, from: byId.get(id)!.storyboardNumber, to: index + 1 }))
    const changedEntries = order.filter(entry => entry.from !== entry.to)
    if (!changedEntries.length) return { entries: order, reconfirm: [] as number[] }

    const before = previousMap([...rows].sort((a, b) => a.storyboardNumber - b.storyboardNumber))
    const after = previousMap(order)
    const ts = now()
    // 第一阶段：要改号的行先写唯一负号，避开与尚未改号的行撞号
    for (const entry of changedEntries) {
      db.update(schema.storyboards).set({ storyboardNumber: -entry.to, updatedAt: ts })
        .where(eq(schema.storyboards.id, entry.id)).run()
    }
    for (const entry of changedEntries) {
      db.update(schema.storyboards).set({ storyboardNumber: entry.to, updatedAt: ts })
        .where(eq(schema.storyboards.id, entry.id)).run()
    }

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
  if (changed) logTaskSuccess('Storyboard', 'reorder', { episodeId, changed, reconfirm: reconfirm.length })
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

/** 缺口两侧相邻镜的承接上下文：旁白尾/首句 + 设计卡的信息点 */
function neighbourBrief(row: typeof schema.storyboards.$inferSelect | undefined, side: 'before' | 'after'): string {
  if (!row) return side === 'before' ? '（缺口在全集开头，没有上一镜）' : '（缺口在全集结尾，没有下一镜）'
  const card = parseDesignCard(row.designCard)
  const narration = (row.narrationText || '').trim()
  const excerpt = side === 'before' ? narration.slice(-40) : narration.slice(0, 40)
  const design = card
    ? `信息点「${card.info_points.map(point => point.text).join('；')}」/ 建议组合 ${card.suggested_combo || '未定'}`
    : '（还没有设计卡）'
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
  // 补镜就是「纪录片拆分分镜」的续跑：同一个视觉环节、同一套证据图（#51）
  const resolved = await resolveStageModel('storyboard_breaker_documentary', opts)
  const taskId = await createTextTask({
    kind: 'storyboard_fill_gaps',
    episodeId,
    dramaId,
    prompt: message,
    stageModel: resolved,
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'storyboard_fill_gaps', args: { episodeId, opts } },
  })
  const evidence = await buildEvidenceImages(episodeId)
  if (evidence.length) {
    await patchTextTaskParams(taskId, {
      evidence_images: evidence.map(image => ({ prop_id: image.propId, name: image.name, kind: image.kind, marks: image.legend.length })),
    })
  }
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId,
    textTaskId: taskId,
    storyboardFillGaps: true,
    modelOverride: resolved.model,
    textConfigId: resolved.configId ?? undefined,
  })
  const sink = createReasoningSink(taskId)
  const knownIds = new Set(rows.map(sb => sb.id))
  logTaskStart('FillGaps', 'run', { episodeId, dramaId, gaps: gaps.length, taskId })

  void runWithTextTask(taskId, () => runAgent(agent, [{ role: 'user', content: evidenceMessageParts(message, evidence) }], { maxSteps: 20, requestContext }, sink))
    .then(async result => {
      // 先按剧本位置归位编号，再按覆盖结果判定成败
      const renumber = await renumberStoryboardsByScript(episodeId)
      const after = await episodeNarrationCoverage(episodeId)
      const fresh = (await db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)))
        .filter(sb => !sb.deletedAt && !knownIds.has(sb.id))
      // 补镜只补**旁白骨架**（#70）：新镜的设计卡要等批量配音出实测时长之后再填，
      // 这里绝不自动起设计卡任务，否则又会得到一版按估算编出来的卡。
      const summary = `补镜完成：新增 ${fresh.length} 镜，重编号 ${renumber.changed} 镜。\n${result.text || ''}`
      // 镜头数硬上限的止损（#57）：连续两批整批被拒就不再让模型重试，直接给出合并建议
      const stop = consumeStoryboardStopReason(episodeId)
      if (stop) {
        await finishTextTask(taskId, 'failed', { errorMsg: stop, outputText: summary })
        logTaskError('FillGaps', 'run', { episodeId, taskId, error: stop })
        return
      }
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
