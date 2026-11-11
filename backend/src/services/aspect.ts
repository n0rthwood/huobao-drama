/**
 * 项目画幅与构图方向（Issue #92）。
 *
 * 关键帧/视频提示词由模型撰写，技能文本曾写死「16:9 横构图」，9:16 竖屏项目的提示词
 * 与实际出图尺寸相矛盾。现在画幅经 `read_storyboard_context` 交给模型，保存时再按本模块
 * 校验：写错方向的那一镜退回让模型改正，不静默重写。
 */

export type Orientation = 'landscape' | 'portrait' | 'square'

/** 允许出现在提示词里的画幅写法；白名单之外的 `数字:数字`（时刻、比分）一律不当画幅 */
export const ASPECT_WHITELIST = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const

export const DEFAULT_ASPECT = '16:9'

function parseAspect(aspect: string | null | undefined): [number, number] | null {
  const match = /^(\d+)\s*:\s*(\d+)$/.exec(String(aspect || '').trim())
  if (!match) return null
  const w = Number(match[1])
  const h = Number(match[2])
  if (!w || !h) return null
  return [w, h]
}

/** 项目画幅 → 画面方向；无法解析时按默认 16:9 处理 */
export function orientationOf(aspect: string | null | undefined): Orientation {
  const parsed = parseAspect(aspect) || parseAspect(DEFAULT_ASPECT)!
  const [w, h] = parsed
  if (w > h) return 'landscape'
  if (h > w) return 'portrait'
  return 'square'
}

/** 项目画幅 → 中文构图词（技能文本里的 `{composition}`） */
export function compositionOf(aspect: string | null | undefined): string {
  const orientation = orientationOf(aspect)
  return orientation === 'portrait' ? '竖构图' : orientation === 'square' ? '方构图' : '横构图'
}

/** 规范化画幅文本；空值回落到默认 16:9（与出图尺寸表同口径） */
export function normalizeAspect(aspect: string | null | undefined): string {
  const trimmed = String(aspect || '').trim()
  return parseAspect(trimmed) ? trimmed.replace(/\s*:\s*/, ':') : DEFAULT_ASPECT
}

/**
 * 明确的方向短语。单独的 `portrait`（纪录片技能里指「肖像」）不算画幅词，
 * 只有后面跟 composition/orientation/frame 这类词时才是构图方向。
 */
const ORIENTATION_PATTERNS: Array<{ re: RegExp; orientation: Orientation }> = [
  { re: /[横橫](?:向)?构图/g, orientation: 'landscape' },
  { re: /[竖豎竪](?:向)?构图/g, orientation: 'portrait' },
  { re: /方构图/g, orientation: 'square' },
  { re: /横構図/g, orientation: 'landscape' },
  { re: /[縦竪]構図/g, orientation: 'portrait' },
  { re: /正方形構図/g, orientation: 'square' },
  { re: /가로\s*구도/g, orientation: 'landscape' },
  { re: /세로\s*구도/g, orientation: 'portrait' },
  { re: /정사각형?\s*구도/g, orientation: 'square' },
  { re: /\b(?:landscape|horizontal)[\s-]+(?:composition|orientation|frame|framing|format)\b/gi, orientation: 'landscape' },
  { re: /\b(?:portrait|vertical)[\s-]+(?:composition|orientation|frame|framing|format)\b/gi, orientation: 'portrait' },
  { re: /\bsquare[\s-]+(?:composition|orientation|frame|framing|format)\b/gi, orientation: 'square' },
]

/** 白名单比例：前后不能紧挨数字，`10:30`、`14:30` 这类时刻不会命中 */
const RATIO_RE = new RegExp(`(?<![\\d:])(${ASPECT_WHITELIST.join('|')})(?![\\d:])`, 'g')

/**
 * 找出提示词里与项目画幅冲突的写法。返回命中的原文片段（去重，保持出现顺序）；
 * 没有冲突（包括完全不写画幅）时返回空数组。
 */
export function findAspectConflicts(text: string | null | undefined, aspect: string | null | undefined): string[] {
  const source = String(text || '')
  if (!source.trim()) return []
  const projectAspect = normalizeAspect(aspect)
  const projectOrientation = orientationOf(projectAspect)
  const hits: string[] = []
  const push = (value: string) => { if (!hits.includes(value)) hits.push(value) }

  for (const match of source.matchAll(RATIO_RE)) {
    if (match[1] !== projectAspect) push(match[1]!)
  }
  for (const { re, orientation } of ORIENTATION_PATTERNS) {
    if (orientation === projectOrientation) continue
    for (const match of source.matchAll(re)) push(match[0])
  }
  return hits
}

/** 退回给模型的说明：说清项目画幅、冲突片段和应该怎么写 */
export function aspectConflictMessage(field: string, conflicts: string[], aspect: string | null | undefined): string {
  const projectAspect = normalizeAspect(aspect)
  return `${field} 与项目画幅不符：本项目是 ${projectAspect} ${compositionOf(projectAspect)}，提示词里却写了「${conflicts.join('」「')}」。请按 ${projectAspect} ${compositionOf(projectAspect)} 重写这条提示词后再保存。`
}

/** 技能文本里要求逐字写出的画幅短语，如 `9:16 竖构图` */
export function aspectPhrase(aspect: string | null | undefined): string {
  const projectAspect = normalizeAspect(aspect)
  return `${projectAspect} ${compositionOf(projectAspect)}`
}

/**
 * 场景最终提示词的画幅校验（Issue #94）。场景图现在按项目画幅出图，提示词里的取景
 * 必须跟着画幅走，否则模型按横版取景、竖版画布只能截掉主体（ep 21 城楼被截即此）。
 *
 * 两条判据：
 * 1. 任何与项目画幅冲突的写法一律退回（与关键帧提示词同口径）；
 * 2. **非 16:9 项目**还必须逐字写出画幅短语。16:9 是历史默认值，老提示词不写画幅
 *    出图结果也对，强制改写只会把所有存量项目的提示词作废。
 *
 * 返回退回说明；放行时返回 null。
 */
export function sceneAspectIssue(prompt: string | null | undefined, aspect: string | null | undefined): string | null {
  const projectAspect = normalizeAspect(aspect)
  const conflicts = findAspectConflicts(prompt, projectAspect)
  if (conflicts.length) return aspectConflictMessage('场景最终提示词', conflicts, projectAspect)
  if (projectAspect === DEFAULT_ASPECT) return null
  const phrase = aspectPhrase(projectAspect)
  if (String(prompt || '').includes(phrase)) return null
  return `场景最终提示词缺少画幅：本项目是 ${phrase}，提示词必须逐字写出「${phrase}」，`
    + `并按该画幅组织建立镜头（主体完整入画，竖构图时沿高度方向分层）。请补齐后再保存。`
}
