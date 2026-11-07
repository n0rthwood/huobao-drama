import { isFirstAgentFailureSafe, runWithTextTask } from './text-task-context.js'
import { requeueFirstModelFailure } from './text-task-restart.js'

/**
 * 旁白写作任务（Issue #30，#35 改为两段式）。
 *
 * 状态持久化在 sys_task(type='text', params.kind='narration_script')，与关键帧/视频提示词
 * 批量完全同构；后端重启由既有 failInterruptedTextTasks() 标失败，不自动重跑。
 *
 * #35 之前是「整集一次 Agent 调用」：模型要把全集推理完才第一次落库，74 镜实测 11 分 34 秒，
 * 期间进度恒为 0。现在拆成两段：
 *   阶段 A（主线）：一次短调用，按我们算好的镜号区间产出「整集主线 + 每段讲什么/承什么/留什么」，
 *                   落库 episodes.narration_spine，用户可改。
 *   阶段 B（分块写镜）：每块 NARRATION_CHUNK_SIZE 镜，波次并发 NARRATION_CHUNK_CONCURRENCY。
 *                   每块的上下文 = 剧本全文 + 主线 + 本块分镜 + 已落库的相邻镜旁白。
 *                   每块写完立刻回算进度 —— 进度肉眼可见地往前走。
 *
 * 并发与衔接的关系：同一波内的块彼此看不到对方的旁白，衔接靠阶段 A 的分段契约（承上/启下）；
 * 跨波的边界则能读到上一波已落库的旁白。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgent } from '../agents/run.js'
import { createReasoningSink } from '../agents/reasoning-sink.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import {
  buildChunkMessage,
  buildChunks,
  buildShotMessage,
  buildSpineMessage,
  NARRATION_CHUNK_SIZE,
  type ShotBrief,
} from './narration-prompt.js'
import {
  createTextTask,
  findActiveTextTask,
  findLatestTextTask,
  finishTextTask,
  promptBatchStatusFrom,
  updateTextTaskProgress,
  type PromptBatchStatus,
  type TextTaskProgress,
} from './text-task.js'
import { resolveStageModel } from './ai-stages.js'

export type NarrationScriptStatus = PromptBatchStatus

export { NARRATION_CHUNK_SIZE }
/**
 * 波次并发：同一波的块同时跑，波与波顺序推进。
 * 实测（74 镜 / 13 块 / glm-5.3）：单块耗时 2–5 分钟，几乎与块内镜头数无关 —— 时间都花在一次推理上。
 * 所以并发是唯一有效的提速杠杆：并发 3 要跑 5 波（整集 27 分钟），并发 10 时 13 块只需 2 波。
 */
export const NARRATION_CHUNK_CONCURRENCY = 10
/** 单镜写作的硬超时（毫秒）：慢模型卡死时给界面一个明确失败，而不是一直转圈 */
export const SHOT_NARRATION_TIMEOUT_MS = 180_000

export function toShotBrief(sb: typeof schema.storyboards.$inferSelect): ShotBrief {
  return {
    shotNumber: sb.storyboardNumber,
    description: sb.description || '',
    atmosphere: sb.atmosphere || '',
    duration: Number(sb.duration || 0),
    continuityBoundary: sb.continuityBoundary || '',
    narrationText: (sb.narrationText || '').trim(),
    narrationEnabled: sb.narrationEnabled !== false,
  }
}

async function loadEpisodeContext(episodeId: number) {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) throw new Error('剧集不存在')
  const script = (ep.scriptContent || ep.content || '').trim()
  if (!script) throw new Error('本集还没有剧本，无法写旁白')
  return { ep, script }
}

async function loadShots(episodeId: number): Promise<ShotBrief[]> {
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
  return rows.filter(sb => !sb.deletedAt).map(toShotBrief)
}

function narrationWriter() {
  const agent = mastra.getAgent('narration_writer')
  if (!agent) throw new Error('旁白写作 Agent 不可用')
  return agent
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动旁白写作（立即返回）。
 * 运行中返回 started:false,total:-1；本集没有分镜返回 started:false,total:0。
 * 传入 storyboardIds 时只重写这些镜头（并复用已存主线），否则整集重写（重新规划主线）。
 */
export async function startNarrationScript(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number; retryOf?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  if (await findActiveTextTask(episodeId, 'narration_script')) return { started: false, total: -1 }

  const rows = (await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber))
    .filter(sb => !sb.deletedAt)
  const partial = Boolean(storyboardIds?.length)
  const targets = partial ? rows.filter(sb => storyboardIds!.includes(sb.id)) : rows
  if (!targets.length) return { started: false, total: 0 }

  const resolved = await resolveStageModel('narration_writer', opts)
  const progress: TextTaskProgress = { completed: 0, failed: 0, total: targets.length, phase: 'spine' }
  const taskId = await createTextTask({
    kind: 'narration_script',
    episodeId,
    dramaId,
    prompt: `为本集 ${targets.length} 个分镜撰写旁白`,
    stageModel: resolved,
    progress,
    storyboardIds: targets.map(sb => sb.id),
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'narration_script', args: { episodeId, dramaId, opts, storyboardIds } },
  })

  logTaskStart('Narration', 'script-batch', { episodeId, dramaId, total: targets.length })

  void runWithTextTask(taskId, async () => {
    const agent = narrationWriter()
    // 每次调用一份请求上下文：分块/单镜运行把允许落库的镜号带进去，save_narrations 据此拒绝越界写入
    const contextFor = (shotNumbers?: number[]) => buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: resolved.model,
      textConfigId: resolved.configId ?? undefined,
      narrationEnabled: true,
      narrationShotNumbers: shotNumbers,
    })
    const sink = createReasoningSink(taskId)
    // 进度写入的串行链（波次内多个块同时写 sys_task.params）
    let writeProgress: Promise<void> = Promise.resolve()
    const { ep, script } = await loadEpisodeContext(episodeId)
    const targetNumbers = new Set(targets.map(sb => sb.storyboardNumber))
    const all = rows.map(toShotBrief)
    const chunks = buildChunks(all.filter(s => targetNumbers.has(s.shotNumber)))

    // ── 阶段 A：主线 ─────────────────────────────────────────────
    let spine = (ep.narrationSpine || '').trim()
    if (!partial || !spine) {
      await runAgent(agent, [{ role: 'user', content: buildSpineMessage({ script, shots: all, chunks }) }],
        { maxSteps: 4, requestContext: contextFor([]) }, sink)
      const [fresh] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
      spine = (fresh?.narrationSpine || '').trim()
      logTaskProgress('Narration', 'spine-done', { episodeId, chars: spine.length })
    }
    progress.phase = 'shots'
    await updateTextTaskProgress(taskId, progress)

    // ── 阶段 B：分块写镜（波次并发）───────────────────────────────
    const runChunk = async (chunk: ShotBrief[], index: number) => {
      const current = await loadShots(episodeId)
      const byNumber = new Map(current.map(s => [s.shotNumber, s]))
      const first = chunk[0]!.shotNumber
      const last = chunk[chunk.length - 1]!.shotNumber
      const message = buildChunkMessage({
        script,
        spine,
        chunk: chunk.map(s => byNumber.get(s.shotNumber) || s),
        prev: byNumber.get(first - 1) || null,
        next: byNumber.get(last + 1) || null,
        chunkIndex: index,
        chunkTotal: chunks.length,
      })
      await runAgent(agent, [{ role: 'user', content: message }],
        { maxSteps: 6, requestContext: contextFor(chunk.map(s => s.shotNumber)) }, sink)
    }

    for (let wave = 0; wave < chunks.length; wave += NARRATION_CHUNK_CONCURRENCY) {
      const slice = chunks.slice(wave, wave + NARRATION_CHUNK_CONCURRENCY)
      await Promise.all(slice.map(async (chunk, offset) => {
        const index = wave + offset
        try {
          await runChunk(chunk, index)
        } catch (err) {
          if (!progress.completed && isFirstAgentFailureSafe(err)) throw err
          logTaskError('Narration', 'chunk-retry', { episodeId, chunk: index + 1, error: err instanceof Error ? err.message : String(err) })
          try {
            await runChunk(chunk, index)
          } catch (err2) {
            logTaskError('Narration', 'chunk-failed', { episodeId, chunk: index + 1, error: err2 instanceof Error ? err2.message : String(err2) })
          }
        }
        // 以实际落库为准回算这一块的进度：每块写完界面就能看到前进
        const after = await loadShots(episodeId)
        const byNumber = new Map(after.map(s => [s.shotNumber, s]))
        for (const shot of chunk) {
          const fresh = byNumber.get(shot.shotNumber)
          const written = fresh ? (!fresh.narrationEnabled || fresh.narrationText.length > 0) : false
          if (written) progress.completed++
          else progress.failed++
        }
        // 进度写入串行化：并发的块各自 read-modify-write params JSON，会互相覆盖
        writeProgress = writeProgress.then(() => updateTextTaskProgress(taskId, { ...progress }))
        await writeProgress
        logTaskProgress('Narration', 'chunk-done', {
          episodeId, chunk: index + 1, of: chunks.length, completed: progress.completed, failed: progress.failed,
        })
      }))
    }
    await sink.flush().catch(() => { /* 落盘失败不影响任务结果 */ })
    return spine
  })
    .then(async (spine) => {
      await finishTextTask(taskId, progress.failed && !progress.completed ? 'failed' : 'completed', {
        progress,
        outputText: spine,
        errorMsg: progress.failed ? `${progress.failed} 个镜头没有写出旁白` : null,
      })
      logTaskSuccess('Narration', 'script-batch', { episodeId, completed: progress.completed, failed: progress.failed })
    })
    .catch(async (err: unknown) => {
      logTaskError('Narration', 'script-batch', { episodeId, error: err instanceof Error ? err.message : String(err) })
      await finishTextTask(taskId, 'failed', {
        progress,
        errorMsg: err instanceof Error ? err.message : String(err),
      })
      await requeueFirstModelFailure(taskId, err, isFirstAgentFailureSafe(err))
    })

  return { started: true, total: targets.length }
}

export async function getNarrationScriptStatus(episodeId: number): Promise<NarrationScriptStatus | null> {
  return promptBatchStatusFrom(await findLatestTextTask(episodeId, 'narration_script'))
}

/**
 * 单镜旁白写作/重写（#35）：同步返回，只写这一镜。
 * 本集批量在跑时拒绝 —— 两边同时写同一镜会互相覆盖。
 */
export async function writeShotNarration(
  storyboardId: number,
  opts: { model?: string; configId?: number } = {},
): Promise<{ narration_text: string; narration_enabled: boolean; duration: number }> {
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb || sb.deletedAt) throw new Error('分镜不存在')
  const episodeId = sb.episodeId
  if (await findActiveTextTask(episodeId, 'narration_script')) {
    throw new Error('本集的批量旁白正在运行，请等它跑完再单独重写这一镜')
  }
  const { ep, script } = await loadEpisodeContext(episodeId)
  if (ep.narrationEnabled !== true) throw new Error('本集未开启旁白，请先在「音频旁白设置」里开启')

  const shots = await loadShots(episodeId)
  const byNumber = new Map(shots.map(s => [s.shotNumber, s]))
  const shot = byNumber.get(sb.storyboardNumber)
  if (!shot) throw new Error('分镜不存在')

  const agent = narrationWriter()
  const shotModel = await resolveStageModel('narration_writer', opts)
  const requestContext = buildAgentRequestContext({
    episodeId,
    dramaId: ep.dramaId,
    modelOverride: shotModel.model,
    textConfigId: shotModel.configId ?? undefined,
    narrationEnabled: true,
    narrationShotNumbers: [sb.storyboardNumber],
  })
  logTaskStart('Narration', 'shot-write', { episodeId, storyboardId, shot: sb.storyboardNumber })
  await withTimeout(
    runAgent(agent, [{
      role: 'user',
      content: buildShotMessage({
        script,
        spine: (ep.narrationSpine || '').trim(),
        shot,
        prev: byNumber.get(shot.shotNumber - 1) || null,
        next: byNumber.get(shot.shotNumber + 1) || null,
      }),
    }], { maxSteps: 4, requestContext }),
    SHOT_NARRATION_TIMEOUT_MS,
    '单镜旁白写作超时（180 秒），请重试或换一个文本模型',
  )

  const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const text = (fresh?.narrationText || '').trim()
  if (!text && fresh?.narrationEnabled !== false) throw new Error('模型没有写出本镜旁白，请重试')
  logTaskSuccess('Narration', 'shot-write', { episodeId, storyboardId, chars: text.length })
  return {
    narration_text: text,
    narration_enabled: fresh?.narrationEnabled !== false,
    duration: Number(fresh?.duration || 0),
  }
}
