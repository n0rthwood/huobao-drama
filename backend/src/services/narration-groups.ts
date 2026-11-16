/**
 * 逻辑组（Issue #109）—— 纪录片旁白稿的「一个意思」单元。
 *
 * 口径：**逻辑组 = 最终旁白稿的一个自然段**（`scriptParagraphs()`：去掉 `【节拍】` 后按空行切段），
 * 不另存标签或映射表。朗读单元（单镜 ≤80 字）⊂ 逻辑组 ⊂ 叙事弧。
 *
 * - 骨架：一镜旁白不得跨段（新生成 / 保存 / 确认三个写入口拒绝，见 `crossGroupProblems`）。
 * - 设计：先按组做视觉规划，再按规划逐镜填卡（`design-group-plan.ts`）。
 * - 镜 → 组不入库，读时按旁白在剧本里的位置现算（`narrationGroupsOf`）。
 *
 * 坐标系与骨架一致：`scriptMatchKey`（去空白、去节拍标记）。本文件是纯函数，不读库。
 */
import { spokenText } from './narration-markup.js'
import { narrationMatchKey, scriptMatchKey, scriptParagraphs } from './narration-first.js'

export interface ParagraphSpan {
  /** 1 起的段号 = 组号 */
  group_no: number
  /** 段落原文（trim 后，保留段内换行） */
  text: string
  /** 在 `scriptMatchKey` 坐标系里的起止下标 */
  start: number
  end: number
}

/** 段落在去空白坐标系里的区间。段落之间没有缝隙：上一段的 end = 下一段的 start。 */
export function paragraphSpans(script: string | null | undefined): ParagraphSpan[] {
  const key = scriptMatchKey(script)
  const spans: ParagraphSpan[] = []
  let cursor = 0
  scriptParagraphs(script).forEach((text, index) => {
    const paragraphKey = narrationMatchKey(text)
    if (!paragraphKey) return
    const found = key.indexOf(paragraphKey, cursor)
    const start = found >= 0 ? found : cursor
    spans.push({ group_no: index + 1, text, start, end: start + paragraphKey.length })
    cursor = start + paragraphKey.length
  })
  return spans
}

/** 去空白坐标 → 所在段（落在最后一段之后的归最后一段；没有段返回 null） */
export function groupAt(spans: ParagraphSpan[], index: number): ParagraphSpan | null {
  if (!spans.length || index < 0) return null
  for (const span of spans) if (index < span.end) return span
  return spans[spans.length - 1]!
}

export type GroupWarningCode = 'shot_cross_group' | 'shot_group_unlocated'

export interface GroupWarning {
  code: GroupWarningCode
  storyboard_id: number
  message: string
}

export interface NarrationGroup {
  group_no: number
  paragraph_text: string
  paragraph_chars: number
  shot_ids: number[]
  warnings: GroupWarning[]
}

export interface GroupShotInput {
  id: number
  storyboard_number?: number | null
  narration_text: string | null | undefined
}

const shotLabel = (shot: GroupShotInput) =>
  shot.storyboard_number != null ? `#${String(shot.storyboard_number).padStart(2, '0')}` : `分镜 ${shot.id}`

/**
 * 按旁白在剧本里的位置把镜头归到段（组）。`shots` 须按镜号排好序。
 * - 跨段镜（存量骨架，#109 之前允许）：归**起始段**，警告 `shot_cross_group`；
 * - 定位不到的镜（旁白被人改过或为空）：沿用上一镜的组，警告 `shot_group_unlocated`；
 *   第一镜就定位不到时归第 1 组。
 * 只返回至少有一镜的组，按组号排序。
 */
export function narrationGroupsOf(script: string | null | undefined, shots: GroupShotInput[]): NarrationGroup[] {
  const spans = paragraphSpans(script)
  if (!spans.length) return []
  const key = scriptMatchKey(script)
  const groups = new Map<number, NarrationGroup>()
  const ensure = (span: ParagraphSpan) => {
    let group = groups.get(span.group_no)
    if (!group) {
      group = {
        group_no: span.group_no,
        paragraph_text: span.text,
        paragraph_chars: span.end - span.start,
        shot_ids: [],
        warnings: [],
      }
      groups.set(span.group_no, group)
    }
    return group
  }
  let cursor = 0
  let previous: ParagraphSpan | null = null
  for (const shot of shots) {
    const shotKey = narrationMatchKey(spokenText(shot.narration_text || ''))
    let found = shotKey ? key.indexOf(shotKey, cursor) : -1
    if (found < 0 && shotKey) found = key.indexOf(shotKey)
    if (found < 0) {
      const span = previous ?? spans[0]!
      const group = ensure(span)
      group.shot_ids.push(shot.id)
      group.warnings.push({
        code: 'shot_group_unlocated',
        storyboard_id: shot.id,
        message: `${shotLabel(shot)} 的旁白在旁白稿里找不到，暂归入第 ${span.group_no} 段`,
      })
      continue
    }
    const first = groupAt(spans, found)!
    const last = groupAt(spans, found + shotKey.length - 1)!
    const group = ensure(first)
    group.shot_ids.push(shot.id)
    if (last.group_no !== first.group_no) {
      group.warnings.push({
        code: 'shot_cross_group',
        storyboard_id: shot.id,
        message: `${shotLabel(shot)} 的旁白跨了第 ${first.group_no}–${last.group_no} 段，按起始段归组；请在旁白骨架里于段落边界处拆开`,
      })
    }
    previous = first
    cursor = Math.max(cursor, found + shotKey.length)
  }
  return [...groups.values()].sort((a, b) => a.group_no - b.group_no)
}

/** storyboard_id → 组号（`narrationGroupsOf` 的反查） */
export function groupNoByShot(groups: NarrationGroup[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const group of groups) for (const id of group.shot_ids) map.set(id, group.group_no)
  return map
}

export interface CrossGroupSpan {
  /** 调用方的镜序号（0 起） */
  index: number
  start: number
  end: number
}

export interface CrossGroupProblem {
  index: number
  code: 'cross_group'
  message: string
}

/**
 * 骨架写入口的「一镜不得跨段」校验：输入是已经按严格分配算出的去空白区间。
 * 只用于**新生成验收 / 保存 / 校验草稿 / 确认**，不进入「当前已确认」的判定——
 * 否则 #109 之前确认的存量骨架（含跨段镜）会整体失效，设计卡填写被挡住。
 */
export function crossGroupProblems(script: string | null | undefined, spans: CrossGroupSpan[]): CrossGroupProblem[] {
  const paragraphs = paragraphSpans(script)
  if (paragraphs.length < 2) return []
  const key = scriptMatchKey(script)
  const problems: CrossGroupProblem[] = []
  for (const span of spans) {
    if (span.end <= span.start) continue
    const first = groupAt(paragraphs, span.start)!
    const last = groupAt(paragraphs, span.end - 1)!
    if (first.group_no === last.group_no) continue
    const boundary = first.end
    problems.push({
      index: span.index,
      code: 'cross_group',
      message: `第 ${span.index + 1} 镜的旁白跨了第 ${first.group_no}–${last.group_no} 段（一个自然段是一个逻辑组，一镜只能属于一段）：`
        + `请在段落边界「…${key.slice(Math.max(span.start, boundary - 12), boundary)}｜${key.slice(boundary, Math.min(span.end, boundary + 12))}…」处拆成两镜`,
    })
  }
  return problems
}
