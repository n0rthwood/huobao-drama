/**
 * narration-first（Issue #45）— 纪录片项目「剧本正文 = 旁白稿」的校验口径
 *
 * 纪录片项目里旁白不是被写出来的，是被**切**出来的：
 * - 拆分分镜（save_storyboards 的纪录片变体）把剧本正文逐段原样分配给每一镜的 narration_text；
 * - 旁白写作（save_narrations 的纪录片变体）只允许加发音标记（#38 的 [[原文|读音]]），
 *   去掉标记后的文本必须与原文逐字一致，不等即拒存。
 *
 * 比对一律在「去空白」后进行：剧本的换行/缩进与分镜文本的空白差异不算改写，
 * 其余任何字符差异（含标点、数字、专名）都算改写。
 */
import { spokenText } from './narration-markup.js'

/** 剧本里的叙事节拍标记（【开场】【远征】…）：只是分段锚点，不进旁白 */
const BEAT_MARKER = /【[^】\n]*】/g

/** 去空白（含全角空格）后的比对文本 */
export function narrationMatchKey(text: string | null | undefined): string {
  return (text || '').replace(/[\s\u3000]+/g, '')
}

/** 剧本正文的比对文本：去掉节拍标记后再去空白 */
export function scriptMatchKey(script: string | null | undefined): string {
  return narrationMatchKey((script || '').replace(BEAT_MARKER, ''))
}

export interface NarrationSegmentCheck {
  /** 去空白后的旁白文本在剧本中的起始下标；未找到为 -1 */
  index: number
  /** 去空白后的字数 */
  chars: number
}

/**
 * 某一镜的旁白是否逐字来自剧本正文。
 * `fromIndex` 用于顺序校验：上一镜匹配结束的位置，保证各镜按剧本顺序取用。
 * 先从 `fromIndex` 起找；找不到时退回全局查找（模型可能先写后面的镜头），
 * 调用方据 `index` 自行判断顺序是否倒置。
 */
export function locateNarrationInScript(scriptKey: string, narration: string, fromIndex = 0): NarrationSegmentCheck {
  const key = narrationMatchKey(narration)
  if (!key) return { index: -1, chars: 0 }
  const forward = scriptKey.indexOf(key, fromIndex)
  return { index: forward >= 0 ? forward : scriptKey.indexOf(key), chars: key.length }
}

export interface NarrationGap {
  /** 去空白剧本里的起止下标 */
  start: number
  end: number
  chars: number
  /** 缺口开头的原文片段（给模型/人定位），最多 60 字 */
  excerpt: string
}

/** 小于这个字数的缝隙视为标点/空白差异，不报缺口 */
const MIN_GAP_CHARS = 8

/**
 * 整集覆盖率：各镜旁白按镜号顺序拼接后，覆盖了剧本正文的多少字。
 * `in_order` 为 false 说明某一镜的旁白在剧本里出现在前一镜之前（顺序被打乱）。
 * `gaps` 是**没有被任何一镜取用的剧本片段**（Issue #49）——narration-first 不只要求
 * 「写下来的话出自剧本」，还要求「剧本里的每一句都被某一镜领走」。只看末尾游标会漏掉
 * 中间整段被跳过的情况（实测 93 镜漏掉 746 字，其中就有「彼得一世亲自筹建近卫团」那句，
 * 于是 S13 的镜头根本不存在）。
 */
export function narrationCoverage(script: string | null | undefined, narrations: (string | null | undefined)[]) {
  const scriptKey = scriptMatchKey(script)
  let cursor = 0
  let covered = 0
  let inOrder = true
  const missing: string[] = []
  const spans: Array<[number, number]> = []
  for (const text of narrations) {
    // 旁白写作之后文本里可能带发音标记（#38），比对前先还原成朗读文字
    const key = narrationMatchKey(spokenText(text || ''))
    if (!key) continue
    const found = locateNarrationInScript(scriptKey, key, cursor)
    if (found.index < 0) {
      missing.push(key)
      continue
    }
    if (found.index < cursor) inOrder = false
    covered += key.length
    spans.push([found.index, found.index + key.length])
    cursor = Math.max(cursor, found.index + key.length)
  }
  // 合并已取用区间后取补集 = 缺口
  spans.sort((a, b) => a[0] - b[0])
  const gaps: NarrationGap[] = []
  let at = 0
  const pushGap = (start: number, end: number) => {
    if (end - start < MIN_GAP_CHARS) return
    gaps.push({ start, end, chars: end - start, excerpt: scriptKey.slice(start, Math.min(end, start + 60)) })
  }
  for (const [start, end] of spans) {
    if (start > at) pushGap(at, start)
    at = Math.max(at, end)
  }
  pushGap(at, scriptKey.length)
  return {
    script_chars: scriptKey.length,
    covered_chars: covered,
    /** 已被取用的剧本正文末尾下标（下一镜应当从这里继续切） */
    cursor,
    in_order: inOrder,
    not_in_script: missing,
    /** 还没有被任何一镜取用的剧本尾部开头 60 字（给模型继续拆镜的锚点） */
    next_uncovered_excerpt: scriptKey.slice(cursor, cursor + 60),
    /** 被跳过、还没有任何一镜领走的剧本片段，按出现顺序 */
    gaps,
    uncovered_chars: gaps.reduce((sum, gap) => sum + gap.chars, 0),
  }
}

/** 覆盖缺口的中文说明（任务失败消息与工具返回值共用同一口径） */
export function describeNarrationGaps(gaps: NarrationGap[], limit = 5): string {
  const head = gaps.slice(0, limit)
    .map(gap => `第 ${gap.start}–${gap.end} 字（${gap.chars} 字）「${gap.excerpt}${gap.chars > 60 ? '…' : ''}」`)
    .join('；')
  return gaps.length > limit ? `${head}；另有 ${gaps.length - limit} 处` : head
}

/**
 * 旁白写作是否只加了发音标记：去标记后的文本与原文逐字相同（含空白，只忽略首尾空白）。
 * 原文为空（该镜是刻意留白的纯画面镜头）时只接受同样为空的文本——不许凭空写旁白。
 */
export function isMarkupOnlyEdit(original: string | null | undefined, next: string | null | undefined): boolean {
  return spokenText(next).trim() === spokenText(original).trim()
}
