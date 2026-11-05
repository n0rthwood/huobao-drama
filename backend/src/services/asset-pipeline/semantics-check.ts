/**
 * 闸门的 `semantics_preserved` 规则（Issue #56）
 *
 * 只对**已有语义标注**的资产生效：美化轮不能把标注过的要素改掉或抹掉。
 * 两项检查：
 * - 标注文字还读不读得到（由 QC 那次视觉调用顺带回答，这里只汇总，不再多打一次模型）；
 * - 每条带颜色的线在新图上还剩多少同色像素（纯 CV，用改后的可抽色判据，Issue #56 建议 6）。
 *
 * 几何是纯函数在跑，但要读库（取标注）与读盘（取像素），所以放在 gate.ts 之外。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { loadPropSemantics } from '../asset-semantics.js'
import {
  GEOMETRY_MAX_SIDE,
  isExtractableLineColor,
  lineColorCoverage,
  loadRaster,
  parseHexColor,
} from '../semantics-geometry.js'
import { FIDELITY_LINE_COVERAGE, type SemanticsPreserved } from './gate.js'
import type { AssetKind } from './store.js'

export async function checkSemanticsPreserved(input: {
  assetKind: AssetKind
  assetId: number
  /** 本轮产出图的绝对路径 */
  absPath: string
  /** QC 那次视觉调用顺带回答的「这些标注文字还读得到吗」 */
  labelsReadable?: Array<{ text: string; readable: boolean }>
}): Promise<SemanticsPreserved> {
  if (input.assetKind !== 'prop') {
    return { status: 'not_applicable', detail: '只有道具（证据素材）有语义标注' }
  }
  const semantics = await loadPropSemantics(input.assetId)
  if (!semantics || (!semantics.lines.length && !semantics.labels.length)) {
    return { status: 'not_applicable', detail: '该资产没有语义标注，不做保形核验' }
  }

  const problems: string[] = []
  const skipped: string[] = []

  // 标注可读性是 QC 那次视觉调用顺带回答的：模型没答 / 答漏了，不能当「全都还在」
  const answered = new Map((input.labelsReadable ?? []).map(item => [item.text, item.readable]))
  const expectedLabels = [...semantics.labels.map(item => item.text), ...semantics.points.map(item => item.name)]
    .filter(Boolean)
  const missing = expectedLabels.filter(text => answered.get(text) === false)
  const unanswered = expectedLabels.filter(text => !answered.has(text))
  if (missing.length) problems.push(`以下标注文字在新图上读不到：${missing.join('、')}`)
  if (unanswered.length) skipped.push(`模型没有回答这些标注是否仍可读：${unanswered.join('、')}`)

  const colored = semantics.lines.filter(line => line.color)
  if (colored.length) {
    // 放宽判据只用于**上传截图**路径（主进程裁决）：标注坐标所针对的那张图是
    // `provider='upload'` 的版本行时才允许；程序渲染的底图与扫描印刷图一律走严格判据
    const screenshot = await isUploadedScreenshot(semantics.image.source_task_id)
    const { raster } = await loadRaster(input.absPath, GEOMETRY_MAX_SIDE)
    // 标注坐标是**原图像素**；新图可能是另一个尺寸桶，按原图宽度换算到分析光栅
    const scale = raster.width / Math.max(semantics.image.width, 1)
    for (const line of colored) {
      const color = parseHexColor(line.color)
      if (!color || !isExtractableLineColor(color)) {
        skipped.push(`「${line.name}」的颜色 ${line.color} 无法按色域核验`)
        continue
      }
      const points = line.points.map(([x, y]): [number, number] => [x * scale, y * scale])
      const strict = lineColorCoverage(raster, points, color)
      const coverage = strict >= FIDELITY_LINE_COVERAGE || !screenshot
        ? strict
        : Math.max(strict, lineColorCoverage(raster, points, color, { hueOnly: true }))
      if (coverage < FIDELITY_LINE_COVERAGE) {
        problems.push(`线条「${line.name}」的色域覆盖率只有 ${Math.round(coverage * 100)}%（要求 ≥${Math.round(FIDELITY_LINE_COVERAGE * 100)}%）`)
      }
    }
  }

  if (problems.length) return { status: 'fail', detail: problems.join('；') }
  const note = skipped.length ? `（未能核验：${skipped.join('；')}）` : ''
  return { status: 'pass', detail: `标注文字可读、线条色域覆盖率达标${note}` }
}

/** 标注坐标所针对的那张图是不是人工上传的截图 */
async function isUploadedScreenshot(sourceTaskId: number | null): Promise<boolean> {
  if (!sourceTaskId) return false
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, sourceTaskId))
  return task?.provider === 'upload'
}

/** QC 提示词里要问的标注文字（全部问，按 12 条一批——一次问太多实测定位质量会塌） */
export async function semanticsLabelsToCheck(assetKind: AssetKind, assetId: number): Promise<string[]> {
  if (assetKind !== 'prop') return []
  const semantics = await loadPropSemantics(assetId)
  if (!semantics) return []
  return [...semantics.labels.map(item => item.text), ...semantics.points.map(item => item.name)]
    .filter(Boolean)
}
