/**
 * 图层段底图的视觉验证（Issue #94，修改思路 2）
 *
 * 为什么存在：底图比例与成片不符时渲染走 contain 留白（任何情况下不拉伸），裁切后的取景位置
 * 是否合理、主体有没有被截掉，程序判断不了——必须让视觉模型看一眼渲染出来的无字取景画面。
 *
 * 口径：
 * - 需要验证 = 底图有裁切 或 取景模式为 `contain`（`baseFrameOf`）。原生比例一致且无裁切时不需要。
 * - 验证签名 = 底图文件 sha + 归一化裁切 + 取景框 + 成片尺寸 + 衔接帧 hash。**与文字图层无关**：
 *   改个标签文案不该让底图重新验一遍。
 * - 通过 = 不需要验证，或签名一致且状态 ∈ {passed, overridden}。
 * - **不并入** `layerSegmentIsFresh`：验证不通过不代表成品要重渲，否则批量渲染会反复重渲同一段。
 *
 * 任务壳与 `asset-semantics-auto.ts` 同范式：`sys_task(type='text', kind='layer_base_check')`，
 * 进任务中心、对话可回看。没有视觉配置时状态记 `error`（绝不放行），可人工放行。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { resolveStageModel, type StageModel } from './ai-stages.js'
import { callTextChat, imageContentPart } from './vision-chat.js'
import { extractFirstJson } from '../agents/tools/vision-tools.js'
import { createTextTask, finishTextTask, patchTextTaskParams } from './text-task.js'
import { runWithTextTask } from './text-task-context.js'
import { baseFrameOf, normalizeCrop } from './layer-quality.js'
import { renderBaseFramePng } from './layer-segment-render.js'
import { fileSha256, getLayerSegment, resolveEpisodeSegmentSpec, type SegmentSpec } from './layer-segment.js'
import { parseDesignCard } from './design-card.js'
import type { LayerDoc } from './layer-doc.js'

export const LAYER_BASE_CHECK_STATUSES = ['pending', 'passed', 'failed', 'error', 'overridden'] as const
export type LayerBaseCheckStatus = typeof LAYER_BASE_CHECK_STATUSES[number]

/** 图层段 `base_check` 列的 JSON 形状 */
export interface LayerBaseCheck {
  required: boolean
  /** 本次结论对应的底图验证签名；与当前输入对不上即作废 */
  signature: string
  status: LayerBaseCheckStatus
  problems: string[]
  notes: string | null
  task_id: number | null
  config_id: number | null
  model: string | null
  checked_at: string | null
  override_reason: string | null
  /** 没有视觉配置 / 模型调用失败时的原因 */
  error: string | null
}

/** 验证只认这些段字段：底图文档、衔接帧 hash、已存结论 */
export interface BaseCheckSegmentFacts {
  layer_doc: LayerDoc
  junction_hash: string | null
  base_check: LayerBaseCheck | null
}

type CheckSpec = Pick<SegmentSpec, 'width' | 'height'>

/** 底图有裁切，或取景按 contain 留白 → 必须人眼/模型看过 */
export function baseCheckRequired(doc: LayerDoc, spec: CheckSpec): boolean {
  if (doc.base.crop) return true
  return baseFrameOf(doc.base, spec).mode === 'contain'
}

/**
 * 底图验证签名：只取「画面构成」相关的输入，文字图层改动不影响。
 * 衔接帧 hash 进签名是因为 C/D 组合把这张图当生成段的引导帧，它变了就该重新看。
 */
export function layerBaseCheckSignatureOf(segment: BaseCheckSegmentFacts, spec: CheckSpec): string {
  const { frame, mode } = baseFrameOf(segment.layer_doc.base, spec)
  const crop = normalizeCrop(segment.layer_doc.base.crop)
  return crypto.createHash('sha256').update([
    'base-check-v1',
    // 只取内容 sha：同一张图换个路径不该让已通过的验证作废
    fileSha256(segment.layer_doc.base.path),
    JSON.stringify(crop),
    `${mode}:${JSON.stringify(frame)}`,
    `${spec.width}x${spec.height}`,
    segment.junction_hash || '',
  ].join('\u0000'), 'utf8').digest('hex')
}

/** 不需要验证，或签名一致且 passed/overridden */
export function baseCheckSatisfied(segment: BaseCheckSegmentFacts, spec: CheckSpec): boolean {
  if (!baseCheckRequired(segment.layer_doc, spec)) return true
  const check = segment.base_check
  if (!check) return false
  if (check.status !== 'passed' && check.status !== 'overridden') return false
  return check.signature === layerBaseCheckSignatureOf(segment, spec)
}

/** 闸门文案：通过时 null，否则「图层底图视觉验证未通过：…」/「图层底图待视觉验证」 */
export function baseCheckBlockReason(segment: BaseCheckSegmentFacts, spec: CheckSpec): string | null {
  if (baseCheckSatisfied(segment, spec)) return null
  const check = segment.base_check
  const stale = check ? check.signature !== layerBaseCheckSignatureOf(segment, spec) : false
  if (!check || stale || check.status === 'pending') return '图层底图待视觉验证'
  if (check.status === 'error') return `图层底图视觉验证未通过：${check.error || '验证任务出错'}`
  const problems = check.problems.length ? check.problems.join('；') : '底图取景不合格'
  return `图层底图视觉验证未通过：${problems}`
}

// ─── 落库 ────────────────────────────────────────────────────

export async function writeLayerBaseCheck(segmentId: number, check: LayerBaseCheck): Promise<void> {
  await db.update(schema.storyboardLayerSegments)
    .set({ baseCheck: JSON.stringify(check), updatedAt: now() })
    .where(eq(schema.storyboardLayerSegments.id, segmentId))
}

function blankCheck(signature: string, patch: Partial<LayerBaseCheck> = {}): LayerBaseCheck {
  return {
    required: true,
    signature,
    status: 'pending',
    problems: [],
    notes: null,
    task_id: null,
    config_id: null,
    model: null,
    checked_at: null,
    override_reason: null,
    error: null,
    ...patch,
  }
}

/** 人工放行（必填理由）：记下理由与时间，签名锁在当时的输入上 */
export async function overrideLayerBaseCheck(storyboardId: number, reason: string): Promise<LayerBaseCheck> {
  const trimmed = reason.trim()
  if (!trimmed) throw new Error('人工放行必须写明理由')
  const segment = await getLayerSegment(storyboardId)
  if (!segment) throw new Error('本镜还没有图层段')
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
  const check = blankCheck(layerBaseCheckSignatureOf(segment, spec), {
    required: baseCheckRequired(segment.layer_doc, spec),
    status: 'overridden',
    problems: segment.base_check?.problems ?? [],
    notes: segment.base_check?.notes ?? null,
    task_id: segment.base_check?.task_id ?? null,
    config_id: segment.base_check?.config_id ?? null,
    model: segment.base_check?.model ?? null,
    checked_at: now(),
    override_reason: trimmed,
  })
  await writeLayerBaseCheck(segment.id, check)
  return check
}

// ─── 视觉任务 ────────────────────────────────────────────────

const CHECK_MAX_SIDE = 1280
const CHECK_QUALITY = 85
const CHECK_TEMPERATURE = 0.1
const CHECK_MAX_TOKENS = 900
const CHECK_TIMEOUT_MS = 180_000

const SYSTEM_PROMPT = '你是影视后期的画面质检员。只依据看到的画面回答，不臆测画面外的内容，输出严格 JSON。'

export interface StartLayerBaseCheckResult {
  started: boolean
  taskId: number | null
  reason?: string
}

/** 渲染出来的无字取景画面落到 static/ 下（imageContentPart 只收 static/ 相对路径） */
async function writeFramePng(doc: LayerDoc, spec: CheckSpec, signature: string): Promise<string> {
  const png = await renderBaseFramePng(doc, spec)
  const relative = `static/layer-checks/${signature.slice(0, 32)}.png`
  const abs = getAbsolutePath(relative)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, png)
  return relative
}

/** 场景没有 name 列，显示名是「地点 · 时间」 */
async function assetNameOf(kind: 'character' | 'scene' | 'prop', id: number): Promise<string> {
  if (kind === 'scene') {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
    return scene ? [scene.location, scene.time].filter(Boolean).join(' · ') : `scene #${id}`
  }
  const table = kind === 'character' ? schema.characters : schema.props
  const [row] = await db.select().from(table).where(eq(table.id, id))
  return row?.name || `${kind} #${id}`
}

/**
 * 启动底图视觉验证。没有视觉配置时**仍然把段标成 error**（绝不放行），
 * 并把原因写进 `base_check.error`，界面据此提示「配置视觉模型或人工放行」。
 */
export async function startLayerBaseCheck(
  storyboardId: number,
  opts: { configId?: number; retryOf?: number; excludeConfigIds?: number[] } = {},
): Promise<StartLayerBaseCheckResult> {
  const segment = await getLayerSegment(storyboardId)
  if (!segment) throw new Error('本镜还没有图层段')
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!sb) throw new Error('分镜不存在')
  const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
  const signature = layerBaseCheckSignatureOf(segment, spec)
  if (!baseCheckRequired(segment.layer_doc, spec)) {
    await writeLayerBaseCheck(segment.id, blankCheck(signature, { required: false, status: 'passed', checked_at: now(), notes: '底图比例与成片一致且无裁切，无需视觉验证' }))
    return { started: false, taskId: null, reason: '本段底图无需视觉验证' }
  }

  let config: StageModel
  try {
    config = await resolveStageModel('layer_base_check', { configId: opts.configId, excludeConfigIds: opts.excludeConfigIds })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeLayerBaseCheck(segment.id, blankCheck(signature, { status: 'error', error: `没有可用的视觉配置：${message}` }))
    return { started: false, taskId: null, reason: message }
  }

  const taskId = await createTextTask({
    kind: 'layer_base_check',
    episodeId: sb.episodeId,
    dramaId: (await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)))[0]?.dramaId ?? null,
    storyboardId,
    prompt: `分镜 #${sb.storyboardNumber} 图层底图视觉验证`,
    stageModel: config,
    retryOf: opts.retryOf,
    queued: true,
    restart: { kind: 'layer_base_check', args: { storyboardId } },
  })
  await patchTextTaskParams(taskId, { storyboard_id: storyboardId, layer_segment_id: segment.id })
  await writeLayerBaseCheck(segment.id, blankCheck(signature, {
    status: 'pending',
    task_id: taskId,
    config_id: config.configId ?? null,
    model: config.model ?? null,
  }))
  logTaskStart('LayerBaseCheck', 'start', { taskId, storyboardId, model: config.model })
  void runWithTextTask(taskId, () => runCheckTask(taskId, storyboardId, signature, config))
  return { started: true, taskId }
}

async function runCheckTask(taskId: number, storyboardId: number, signature: string, config: StageModel): Promise<void> {
  const segment = await getLayerSegment(storyboardId)
  if (!segment) throw new Error('图层段已不存在')
  const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  const spec = await resolveEpisodeSegmentSpec(sb!.episodeId)
  try {
    const { frame, mode } = baseFrameOf(segment.layer_doc.base, spec)
    const framePath = await writeFramePng(segment.layer_doc, spec, signature)
    const parts: Record<string, unknown>[] = []
    const base = await imageContentPart(segment.layer_doc.base.path, { maxSide: CHECK_MAX_SIDE, quality: CHECK_QUALITY })
    parts.push(base.part)
    const framed = await imageContentPart(framePath, { maxSide: CHECK_MAX_SIDE, quality: CHECK_QUALITY })
    parts.push(framed.part)
    let junctionNote = ''
    if (segment.junction_path && fs.existsSync(getAbsolutePath(segment.junction_path))) {
      const junction = await imageContentPart(segment.junction_path, { maxSide: CHECK_MAX_SIDE, quality: CHECK_QUALITY })
      parts.push(junction.part)
      junctionNote = '\n第三张是衔接帧（本镜生成段的引导帧，同样不含文字），它会成为模型视频的第一帧或最后一帧。'
    }

    const card = parseDesignCard(sb!.designCard)
    const baseRef = segment.base_ref
    const assetName = baseRef?.kind === 'asset'
      ? await assetNameOf(baseRef.asset_kind, baseRef.asset_id)
      : '（底图来自上一镜尾帧）'
    const assetKind = baseRef?.kind === 'asset' ? baseRef.asset_kind : 'inherit_prev'
    const intent = [
      card?.layer_plan?.base && 'name' in card.layer_plan.base ? `设计卡底图意图：${card.layer_plan.base.name}` : '',
      (card?.info_points || []).length ? `本镜信息点：${card!.info_points.map(point => point.text).join('；')}` : '',
      sb!.narrationText ? `本镜旁白：${sb!.narrationText}` : '',
    ].filter(Boolean).join('\n')

    const question = [
      `底图资产：「${assetName}」（类型 ${assetKind}）`,
      intent,
      `成片画幅：${spec.width}×${spec.height}`,
      `取景模式：${mode === 'contain' ? 'contain 留白（底图等比完整居中，上下或左右用同图放大模糊垫底）' : 'crop 裁切（按裁切框取景，不留白）'}`,
      `取景框（归一化到整张原图）：x=${frame.x.toFixed(4)} y=${frame.y.toFixed(4)} w=${frame.w.toFixed(4)} h=${frame.h.toFixed(4)}`,
      '',
      '第一张是底图原件（整张）。第二张是本段实际渲染出的无字取景画面（成片画幅）。' + junctionNote,
      '',
      '请逐条判断第二张画面：',
      '1. 关键主体是否完整——城楼顶、屋脊、人物头部/四肢、地图要素等有没有被画面边缘切掉；',
      '2. 取景位置是否合理——主体是否在画面内的合适位置，不偏到角落、不被留白挤走；',
      '3. 有没有变形/拉伸——与第一张对照，人、建筑、圆形物体的长宽比是否一致；',
      '4. 留白填充是否自然——如果上下/左右有模糊垫底带，是否与主体衔接自然、没有明显撕裂或重影。',
      '',
      '只输出 JSON：{"pass": true/false, "problems": ["具体问题，指明在画面哪里"], "notes": "一句话结论"}。',
      '任何一条不合格就 pass=false，并在 problems 里写清楚；全部合格时 problems 为空数组。',
    ].filter(part => part !== undefined).join('\n')

    const { text } = await callTextChat(
      config,
      [{ type: 'text', text: question }, ...parts],
      { systemPrompt: SYSTEM_PROMPT, temperature: CHECK_TEMPERATURE, maxTokens: CHECK_MAX_TOKENS, timeoutMs: CHECK_TIMEOUT_MS },
    )
    const parsed = extractFirstJson(text)
    if ('error' in parsed) throw new Error(`模型返回无法解析为 JSON：${parsed.error}`)
    const json = parsed.json as Record<string, unknown>
    const problems = Array.isArray(json.problems)
      ? json.problems.filter((item): item is string => typeof item === 'string')
      : []
    const pass = json.pass === true && problems.length === 0
    const check = blankCheck(signature, {
      status: pass ? 'passed' : 'failed',
      problems,
      notes: typeof json.notes === 'string' ? json.notes : null,
      task_id: taskId,
      config_id: config.configId ?? null,
      model: config.model ?? null,
      checked_at: now(),
    })
    await writeLayerBaseCheck(segment.id, check)
    await finishTextTask(taskId, 'completed', { outputText: JSON.stringify({ pass, problems, notes: check.notes }) })
    logTaskSuccess('LayerBaseCheck', 'done', { taskId, storyboardId, pass: String(pass), problems: String(problems.length) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeLayerBaseCheck(segment.id, blankCheck(signature, {
      status: 'error',
      task_id: taskId,
      config_id: config.configId ?? null,
      model: config.model ?? null,
      checked_at: now(),
      error: message,
    }))
    await finishTextTask(taskId, 'failed', { errorMsg: `底图视觉验证失败：${message}`, error: err })
    logTaskError('LayerBaseCheck', 'done', { taskId, storyboardId, error: message })
  }
}

/**
 * 渲染成功后的自动触发：需要验证且签名与已存结论不同才起任务。
 * 不阻塞渲染响应——调用方 `void` 掉即可，失败只记日志。
 */
export async function ensureLayerBaseCheck(storyboardId: number): Promise<void> {
  try {
    const segment = await getLayerSegment(storyboardId)
    if (!segment) return
    const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
    if (!sb) return
    const spec = await resolveEpisodeSegmentSpec(sb.episodeId)
    if (!baseCheckRequired(segment.layer_doc, spec)) {
      // 已经不需要验证了：留着旧结论会让界面显示一条过时的「未通过」
      if (segment.base_check) await writeLayerBaseCheck(segment.id, blankCheck(layerBaseCheckSignatureOf(segment, spec), {
        required: false, status: 'passed', checked_at: now(), notes: '底图比例与成片一致且无裁切，无需视觉验证',
      }))
      return
    }
    // 签名没变就不重跑（含 error：失败的结论继续阻断，重跑走「重新验证」接口，
    // 否则每次重渲都会再烧一次注定失败的任务）
    if (segment.base_check?.signature === layerBaseCheckSignatureOf(segment, spec)) return
    await startLayerBaseCheck(storyboardId)
  } catch (err) {
    logTaskError('LayerBaseCheck', 'auto', { storyboardId, error: err instanceof Error ? err.message : String(err) })
  }
}
