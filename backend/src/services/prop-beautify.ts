/**
 * 证据素材的「可选美化 + 保真核验」（Issue #47，父 Issue Q1 的可选路径）
 *
 * 用户的原意是「扩散模型先美化，再在上面标注」；实测反证是美化会**丢地理要素**
 * （资产 39 的 gpt-image-2 版丢了额尔齐斯河与斋桑湖，关键帧提示词却还在写这条河）。
 * 用户确认的结论是分两步：先在原图上做精准的语义标注，美化作为独立可选动作，
 * 且必须通过保真核验才允许当底图。
 *
 * 所以这里做三件事：
 * 1. 以**原图为第 1 张参考图**走 image_edit，产出一张**派生版本**（原图与标注都不动）；
 * 2. 派生图落地后自动核验：语义标注里的 labels 是否全部仍可读（视觉模型复查）+
 *    lines 的色域像素覆盖率是否 ≥80%（CV 复查）；
 * 3. 结论写回该版本行的 `params.fidelity`（`verified` / `failed`）与 `fidelity_reason`，
 *    界面据此允许或禁止把它选为底图。
 *
 * 核验是**事后**做的：生图走的是既有 sys_task 链路（队列/追踪器/重试都复用），
 * 这里只盯住那一行任务，完成后再跑核验，失败不影响图本身的保存。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { resolveStageModel } from './ai-stages.js'
import { callTextChat, imageContentPart } from './vision-chat.js'
import { extractFirstJson } from '../agents/tools/vision-tools.js'
import { parseSemantics, type AssetSemantics } from './asset-semantics.js'
import { GEOMETRY_MAX_SIDE, lineColorCoverage, loadRaster, parseHexColor } from './semantics-geometry.js'

/** 线条色域覆盖率门槛（Issue 正文写死 80%） */
export const FIDELITY_LINE_COVERAGE = 0.8
/** 核验轮询：5 秒一次，最多等 30 分钟（够慢队列跑完一张图） */
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 30 * 60_000
const VERIFY_TIMEOUT_MS = 180_000
const VERIFY_TEMPERATURE = 0.1
const VERIFY_MAX_TOKENS = 1500

export type FidelityVerdict = 'verified' | 'failed'

export interface FidelityResult {
  fidelity: FidelityVerdict
  reason: string
}

/**
 * 美化提示词。注意**不拼项目风格预设**：`documentary-archival` 的前缀是
 * `no lettering, no watermark`，拼上去等于命令模型把地名全抹掉——正是事故成因之一。
 */
export function beautifyPrompt(name: string, description: string | null | undefined): string {
  return [
    `restore and enhance this historical map/engraving of ${name}`,
    description ? description.replace(/\s+/g, ' ').trim() : '',
    'keep every existing place name, label, river, coastline, boundary and symbol exactly where it is',
    'do not add, remove, translate or re-letter any text',
    'do not redraw the geography; only clean the paper, even the tone and sharpen the existing ink',
    'aged paper texture, archival scan quality, high detail',
  ].filter(Boolean).join(', ')
}

/** 原图画幅 → 生图尺寸桶（派生图必须与原图同画幅，否则语义坐标换算会错位） */
export function sizeBucketFor(width: number, height: number): string {
  const ratio = width / Math.max(height, 1)
  const buckets: Array<{ size: string; ratio: number }> = [
    { size: '1344x768', ratio: 16 / 9 },
    { size: '1152x864', ratio: 4 / 3 },
    { size: '1024x1024', ratio: 1 },
    { size: '864x1152', ratio: 3 / 4 },
    { size: '768x1344', ratio: 9 / 16 },
  ]
  let best = buckets[0]!
  for (const bucket of buckets) {
    if (Math.abs(Math.log(bucket.ratio / ratio)) < Math.abs(Math.log(best.ratio / ratio))) best = bucket
  }
  return best.size
}

// ─── 核验 ────────────────────────────────────────────────────

/**
 * 语义标注 + 派生图 → 核验结论（纯逻辑，便于单测：两个检查的结果进来，结论出去）。
 * 任一项不达标即 `failed`，理由要能让人一眼看懂哪些要素丢了。
 */
export function judgeFidelity(input: {
  missingLabels: string[]
  lowCoverageLines: Array<{ name: string; coverage: number }>
  skipped: string[]
}): FidelityResult {
  const problems: string[] = []
  if (input.missingLabels.length) {
    problems.push(`以下标注在美化版里读不到：${input.missingLabels.join('、')}`)
  }
  for (const line of input.lowCoverageLines) {
    problems.push(`线条「${line.name}」的色域覆盖率只有 ${Math.round(line.coverage * 100)}%（要求 ≥${Math.round(FIDELITY_LINE_COVERAGE * 100)}%）`)
  }
  if (problems.length) return { fidelity: 'failed', reason: problems.join('；') }
  const note = input.skipped.length ? `（未能核验：${input.skipped.join('；')}）` : ''
  return { fidelity: 'verified', reason: `标注文字全部可读，线条色域覆盖率达标${note}` }
}

/** 视觉模型复查：这些文字在新图上还读得到吗 */
async function checkLabelsReadable(relativePath: string, labels: string[]): Promise<{ missing: string[]; skipped: string | null }> {
  if (!labels.length) return { missing: [], skipped: '语义标注里没有 labels' }
  // 视觉环节（#51）：没有视觉配置时直接抛错，核验结论宁可缺失也不能是纯文本模型猜的
  const config = await resolveStageModel('prop_beautify')
  const prepared = await imageContentPart(relativePath, { maxSide: GEOMETRY_MAX_SIDE, quality: 85 })
  const question = [
    `这是一张 ${prepared.width}×${prepared.height} 像素的图片。`,
    `请逐一判断下面这些文字在图上是否**仍然印着且能读出来**：${labels.map(t => `「${t}」`).join('、')}。`,
    '只按你真正看到的字回答，拼写不同、被改写、被糊掉、完全消失都算读不到。',
    '只输出 JSON：{"readable":["..."],"missing":["..."]}',
  ].join('\n')
  const { text } = await callTextChat(
    config,
    [{ type: 'text', text: question }, prepared.part],
    { temperature: VERIFY_TEMPERATURE, maxTokens: VERIFY_MAX_TOKENS, timeoutMs: VERIFY_TIMEOUT_MS },
  )
  const parsed = extractFirstJson(text)
  if ('error' in parsed) return { missing: [], skipped: `复查结果无法解析（${parsed.error}）` }
  const record = parsed.json as Record<string, unknown>
  const readable = Array.isArray(record.readable) ? record.readable.map(String) : []
  const reported = Array.isArray(record.missing) ? record.missing.map(String) : []
  // 以「没出现在 readable 里」为准：模型偶尔只填一边
  const missing = labels.filter(label => !readable.includes(label) || reported.includes(label))
  return { missing, skipped: null }
}

/** CV 复查：标注里的每条带颜色的线，在新图上还剩多少同色像素 */
async function checkLineCoverage(
  absPath: string,
  semantics: AssetSemantics,
): Promise<{ low: Array<{ name: string; coverage: number }>; skipped: string[] }> {
  const low: Array<{ name: string; coverage: number }> = []
  const skipped: string[] = []
  const colored = semantics.lines.filter(line => line.color)
  if (!colored.length) {
    return { low, skipped: ['语义标注里没有带颜色的 lines'] }
  }
  const { raster, scale } = await loadRaster(absPath, GEOMETRY_MAX_SIDE)
  for (const line of colored) {
    const color = parseHexColor(line.color)
    if (!color) {
      skipped.push(`线条「${line.name}」的颜色不合法`)
      continue
    }
    // 标注坐标是原图像素；派生图与原图同画幅，按新图的分析缩放比换算即可
    const points = line.points.map(([x, y]): [number, number] => [x * scale, y * scale])
    const coverage = lineColorCoverage(raster, points, color)
    if (coverage < FIDELITY_LINE_COVERAGE) low.push({ name: line.name, coverage })
  }
  return { low, skipped }
}

/** 核验一张已经落地的派生图，结论写回该版本行 */
export async function verifyBeautifiedVersion(taskId: number): Promise<FidelityResult | null> {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!task || !task.propId) return null
  const relative = task.localPath || task.resultUrl
  if (!relative || !relative.startsWith('static/')) {
    return await writeFidelity(taskId, { fidelity: 'failed', reason: '美化版没有本地图片文件，无法核验' })
  }
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, task.propId))
  const semantics = parseSemantics(prop?.semantics)
  if (!semantics) {
    return await writeFidelity(taskId, {
      fidelity: 'failed',
      reason: '该素材还没有语义标注，无法核验美化是否保真；请先做语义标注再美化',
    })
  }

  const absPath = getAbsolutePath(relative)
  const labelCheck = await checkLabelsReadable(relative, semantics.labels.map(label => label.text))
  const lineCheck = await checkLineCoverage(absPath, semantics)
  const skipped = [...(labelCheck.skipped ? [labelCheck.skipped] : []), ...lineCheck.skipped]
  const verdict = judgeFidelity({
    missingLabels: labelCheck.missing,
    lowCoverageLines: lineCheck.low,
    skipped,
  })
  return await writeFidelity(taskId, verdict)
}

async function writeFidelity(taskId: number, verdict: FidelityResult): Promise<FidelityResult> {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  if (!task) return verdict
  let params: Record<string, unknown> = {}
  try {
    const parsed: unknown = task.params ? JSON.parse(task.params) : {}
    if (parsed && typeof parsed === 'object') params = parsed as Record<string, unknown>
  } catch { /* 坏 JSON 直接重写 */ }
  params.fidelity = verdict.fidelity
  params.fidelity_reason = verdict.reason
  await db.update(schema.sysTask)
    .set({ params: JSON.stringify(params), updatedAt: now() })
    .where(eq(schema.sysTask.id, taskId))
  if (verdict.fidelity === 'verified') logTaskSuccess('Beautify', 'fidelity', { taskId, reason: verdict.reason })
  else logTaskError('Beautify', 'fidelity', { taskId, reason: verdict.reason })
  return verdict
}

/**
 * 盯住美化生图任务，落地后自动核验。
 * 任务失败/取消时不写 fidelity（没有图可核验）；超时也只记日志，不污染版本行。
 */
export async function watchBeautifyTask(taskId: number): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    // 本仓库的 tsconfig lib 还没到 es2024，Promise.withResolvers 不可用；
    // 与 keyframe-batch/video-batch 的轮询等待写法保持一致
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task) return
    if (task.status === 'completed') {
      logTaskProgress('Beautify', 'verify-start', { taskId, propId: task.propId })
      try {
        await verifyBeautifiedVersion(taskId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await writeFidelity(taskId, { fidelity: 'failed', reason: `保真核验过程出错：${message}` })
      }
      return
    }
    if (task.status === 'failed' || task.status === 'cancelled') return
  }
  logTaskError('Beautify', 'verify-timeout', { taskId })
}

/** 版本行 params → 核验结论（版本列表透出用） */
export function fidelityOf(params: string | null | undefined): { fidelity: FidelityVerdict | null; reason: string | null } {
  if (!params) return { fidelity: null, reason: null }
  try {
    const parsed: unknown = JSON.parse(params)
    if (!parsed || typeof parsed !== 'object') return { fidelity: null, reason: null }
    const record = parsed as Record<string, unknown>
    const fidelity = record.fidelity === 'verified' || record.fidelity === 'failed' ? record.fidelity : null
    return { fidelity, reason: typeof record.fidelity_reason === 'string' ? record.fidelity_reason : null }
  } catch {
    return { fidelity: null, reason: null }
  }
}
