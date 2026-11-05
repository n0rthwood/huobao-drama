/**
 * 设计卡 ↔ 图层段的一致性检查（Issue #58，契约 §3.1 + Fabel §4.4）。
 *
 * **警告级，不拦截**：保存/渲染/确认都照常放行，镜列表挂 ⚠、编辑器顶黄条；
 * 合成前由 R7 汇总再提醒。检查项（读时现算，不落库）：
 * - `must_mark_not_marked`：设计卡 `layer_plan.must_mark` 的语义条目，没有任何图层「锚定」它；
 * - `reference_not_mentioned`：`gen_plan.reference_assets` 没有被任何槽位提示词 `@`；
 * - `card_subtitle_overlap`：卡片图层底边进入字幕安全区（> 0.88）；
 * - `budget_mismatch`：实际段长与设计卡 `budget.layer_s` 偏差 > 0.5 s；
 * - `missing_base`：A/C/D 的设计卡没有合法底图（草稿也就没法落行）。
 *
 * 与 `storyboard-assets.ts` 的 @ 解析同源：名字归一（空白→下划线、大小写无关），
 * 只认**写了内容**的提示词字段。
 */
import { BUDGET_TIGHT_SECONDS, hasLayerSegment, type Combo, type DesignCard } from './design-card.js'
import { SUBTITLE_SAFE_BOTTOM } from './layer-segment-draft.js'
import type { LayerSegment } from './layer-segment.js'

export const SEGMENT_ISSUE_CODES = [
  'missing_base',
  'must_mark_not_marked',
  'reference_not_mentioned',
  'card_subtitle_overlap',
  'budget_mismatch',
] as const
export type SegmentIssueCode = typeof SEGMENT_ISSUE_CODES[number]

export interface SegmentIssue {
  code: SegmentIssueCode
  severity: 'warn'
  message: string
  /** 「一键创建标记并锚定」需要的语义定位（`must_mark_not_marked` 才有） */
  asset_id?: number
  asset_kind?: string
  semantic_id?: string
  name?: string
  /** `reference_not_mentioned`：未被 @ 的素材名；`budget_mismatch`：实际/预算秒数 */
  reference?: string
  actual?: number
  budget?: number
}

export interface SegmentIssueInput {
  card: DesignCard | null
  combo: Combo | null
  segment: LayerSegment | null
  storyboardPrompts: { first: string; mid: string; last: string; video: string }
}

/** 提示词里 @ 到的名字集合：与 `@` 解析同口径（去掉 `@`、空白→下划线、小写） */
function mentionedNames(prompts: Record<string, string>): Set<string> {
  const out = new Set<string>()
  const pattern = /@([\p{L}\p{N}_·\-]+)/gu
  for (const text of Object.values(prompts)) {
    if (!text) continue
    for (const match of text.matchAll(pattern)) {
      out.add(match[1].replace(/\s+/g, '_').toLowerCase())
    }
  }
  return out
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, '_').toLowerCase()
}

/** 图层锚定的语义条目集合（`asset_id:semantic_id`） */
function anchoredKeyframes(segment: LayerSegment | null): Set<string> {
  const out = new Set<string>()
  if (!segment) return out
  for (const layer of segment.layer_doc.layers) {
    const anchor = layer.anchor
    if (!anchor || anchor.detached || !anchor.semantic_id) continue
    out.add(`${anchor.asset_id}:${anchor.semantic_id}`)
  }
  return out
}

export function segmentIssuesOf(input: SegmentIssueInput): SegmentIssue[] {
  const issues: SegmentIssue[] = []
  const { card, combo, segment } = input
  if (!hasLayerSegment(combo)) return issues
  if (!card) return issues
  const plan = card.layer_plan
  if (!plan?.base) {
    issues.push({
      code: 'missing_base',
      severity: 'warn',
      message: '设计卡还没有指定图层段底图，无法生成图层段草稿',
    })
    return issues
  }

  const anchored = anchoredKeyframes(segment)
  for (const ref of plan.must_mark || []) {
    if (anchored.has(`${ref.asset_id}:${ref.semantic_id}`)) continue
    issues.push({
      code: 'must_mark_not_marked',
      severity: 'warn',
      message: `设计卡要求标注「${ref.name || ref.semantic_id}」，图层段里还没有锚定它的图层`,
      asset_id: ref.asset_id,
      semantic_id: ref.semantic_id,
      name: ref.name,
    })
  }

  const mentioned = mentionedNames(input.storyboardPrompts)
  for (const ref of card.gen_plan?.reference_assets || []) {
    if (mentioned.has(normalizedName(ref.name))) continue
    issues.push({
      code: 'reference_not_mentioned',
      severity: 'warn',
      message: `设计卡参考素材「${ref.name}」没有被任何槽位提示词 @ 引用，生成时不会带上它的参考图`,
      reference: ref.name,
    })
  }

  if (segment) {
    for (const layer of segment.layer_doc.layers) {
      if (layer.type !== 'card') continue
      const bottom = layer.box.y + layer.box.h
      if (bottom <= SUBTITLE_SAFE_BOTTOM + 1e-6) continue
      issues.push({
        code: 'card_subtitle_overlap',
        severity: 'warn',
        message: `卡片「${layer.fields.title || layer.fields.years || layer.id}」底边 ${bottom.toFixed(2)} 压进字幕安全区（>${SUBTITLE_SAFE_BOTTOM}），成片会与字幕重叠`,
      })
    }
    const budget = card.budget.layer_s
    if (budget && budget > 0 && Math.abs(segment.duration - budget) > BUDGET_TIGHT_SECONDS) {
      issues.push({
        code: 'budget_mismatch',
        severity: 'warn',
        message: `实际段长 ${segment.duration.toFixed(1)}s 与设计卡预算 ${budget.toFixed(1)}s 偏差超过 ${BUDGET_TIGHT_SECONDS}s`,
        actual: segment.duration,
        budget,
      })
    }
  }
  return issues
}
