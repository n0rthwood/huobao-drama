/**
 * 视频提示词的时间分段（纯函数）：衔接帧校验（#95，`junction-caption.ts`）与生成段时间轴校验（#110）共用。
 *
 * 时间分段行：`0-3秒：`、`0-2.5秒:`、`0-3s:`、`0–3 s：`、`0-3초:` 都算。行首的时间范围就是分段边界，
 * 模型按技能要求一行一段；找不到任何分段行说明格式不合规（校验无从下手）。
 */
const SEGMENT_LINE = /^\s*[【\[]?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|~)\s*(\d+(?:\.\d+)?)\s*(?:秒|초|s|sec|seconds)?\s*[】\]]?\s*[:：]/

export interface PromptSegment {
  index: number
  /** 该段的起始秒数（时间范围左边） */
  start: number
  /** 该段的结束秒数（时间范围右边） */
  end: number
  /** 行首时间范围的原文（去掉冒号），退回信息里原样引用 */
  time: string
  /** 去掉时间前缀后的正文，含该段后续被折行的续行（遇到下一个分段行或空行结束） */
  body: string
}

export function promptSegments(text: string): PromptSegment[] {
  const lines = text.split(/\r?\n/)
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) if (SEGMENT_LINE.test(lines[i])) starts.push(i)
  const startSet = new Set(starts)
  return starts.map((start, index) => {
    const matched = SEGMENT_LINE.exec(lines[start])!
    const body: string[] = [lines[start].replace(SEGMENT_LINE, '')]
    for (let i = start + 1; i < lines.length; i++) {
      if (startSet.has(i) || !lines[i].trim()) break
      body.push(lines[i])
    }
    return {
      index,
      start: Number(matched[1]),
      end: Number(matched[2]),
      time: matched[0].replace(/\s*[:：]\s*$/, '').trim(),
      body: body.join('\n'),
    }
  })
}

/** 时间轴终点与生成段时长允许的偏差（秒）：模型常按 0.5 秒取整 */
export const TIMELINE_END_TOLERANCE = 0.5

/**
 * 纪录片视频提示词的时间轴必须覆盖**生成段**（#110）：从 0 秒起、终点等于生成段时长（±0.5 秒）。
 * 生成段之外的秒数视频模型不会画（提交时长 = 生成段），写成 10 秒的提示词交给 5 秒的生成段，
 * 后半段动作整段丢失或被压缩（ep 30 #01：生成段 5 s，提示词写到 10 s）。
 * 返回问题短句；空数组 = 合规。找不到分段行时不在这里报（由衔接帧校验 / 技能格式负责）。
 */
export function videoTimelineProblems(text: string, segmentSeconds: number): string[] {
  const segments = promptSegments(text || '')
  if (!segments.length || !(segmentSeconds > 0)) return []
  const first = segments[0]
  const last = segments[segments.length - 1]
  const problems: string[] = []
  if (first.start !== 0) problems.push(`第一段「${first.time}」没有从 0 秒开始`)
  if (Math.abs(last.end - segmentSeconds) > TIMELINE_END_TOLERANCE) {
    problems.push(`最后一段「${last.time}」结束在 ${last.end} 秒，而本镜生成段只有 ${segmentSeconds} 秒`)
  }
  return problems
}
