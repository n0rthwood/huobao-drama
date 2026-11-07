/**
 * 桥句阶段的结构契约（Issue #70 §4）—— 纯函数，不碰数据库也不调模型。
 *
 * 关键设计：**最终全文由服务端在前驱正文上按偏移插入已申报的桥句**，模型只回报告。
 * 前驱的每一个字节（含缩进、空行、段落顺序）原样保留，只有桥句字节是新增的，
 * 所以「报告说加了、正文没加」「正文被偷偷改写/删段/重排」在结构上就不可能发生。
 *
 * 计数口径（固定，不随模型输出漂移）：
 * - 「朗读字符」= 去掉空白与标点/结构标记后的字符数（25 为可见提示，不是失败）；
 * - 每段 ≤80 字沿用纪录片保真契约（超限是硬失败，桥句不豁免）；
 * - 每个边界最多一句是硬限制：句末标点只允许出现在结尾。
 */
import { guardStageOutput } from './source-filter.js'

/** 剧本正文的叙事节拍标记（【开场】…）：只是锚点，不构成正文段落 */
const BEAT_LINE = /^【[^】\n]*】$/

/** 空行分隔出的块在前驱全文里的位置；`bodyStart` 跳过块首的节拍标记行 */
export interface ScriptBlock {
  start: number
  end: number
  bodyStart: number
}

export interface BridgeParagraph {
  id: string
  /** 正文（不含块首节拍标记）在前驱全文里的起止偏移 */
  bodyStart: number
  bodyEnd: number
  /** 所在块的结束偏移：独立桥段插在它后面 */
  blockEnd: number
  text: string
  chars: number
}

export interface BridgeBoundary {
  boundary_id: string
  left_paragraph: string
  right_paragraph: string
}

export type BridgeDecisionKind = 'no_bridge' | 'inserted' | 'needed_but_unsafe'
export type BridgePlacement = 'end_of_left' | 'start_of_right' | 'standalone'
export type BridgeAttribution = 'previous_tail' | 'next_head' | 'standalone'

export interface BridgeDecision {
  boundary_id: string
  left_paragraph: string
  right_paragraph: string
  relation: string
  decision: BridgeDecisionKind
  reason: string
  bridge_text: string | null
  placement: BridgePlacement | null
  shot_attribution: BridgeAttribution | null
  spoken_chars: number | null
  /** 并入相邻段会超过 80 字时自动改为独立段，报告里显式说明 */
  placement_adjusted?: boolean
}

export interface BridgeReport {
  decisions: BridgeDecision[]
  boundary_count: number
  inserted_count: number
  needed_but_unsafe_count: number
  warnings: string[]
}

/** 单段硬上限（语音合成单段上限，与纪录片改写契约同口径） */
export const PARAGRAPH_CHAR_LIMIT = 80
/** 桥句朗读字符的可见提示阈值（超过只提示，不判失败） */
export const BRIDGE_SPOKEN_HINT = 25

const PUNCTUATION = /[\s\u3000，,。.！!？?、；;：:“”"'‘’（）()《》〈〉【】…—－\-~·]/g

/**
 * 文本 → 块偏移表。块按「空行」切分；块首连续的节拍标记行不算正文，
 * 因此 `bodyStart` 指向第一行真正的解说文字（整块都是节拍标记时等于块尾）。
 */
export function parseBlocks(text: string): ScriptBlock[] {
  const source = text || ''
  const blocks: ScriptBlock[] = []
  const separator = /\n[ \t\u3000]*\n[\s\u3000]*/g
  let at = 0
  const pushBlock = (start: number, end: number) => {
    // 块内首尾空白不进块，保证插入点紧贴正文
    let s = start
    let e = end
    while (s < e && /\s/.test(source[s]!)) s++
    while (e > s && /\s/.test(source[e - 1]!)) e--
    if (s >= e) return
    let bodyStart = s
    for (;;) {
      const lineEnd = source.indexOf('\n', bodyStart)
      const line = source.slice(bodyStart, lineEnd < 0 || lineEnd > e ? e : lineEnd).trim()
      if (!BEAT_LINE.test(line) || lineEnd < 0 || lineEnd >= e) break
      bodyStart = lineEnd + 1
      while (bodyStart < e && /[ \t\u3000]/.test(source[bodyStart]!)) bodyStart++
    }
    blocks.push({ start: s, end: e, bodyStart })
  }
  for (const match of source.matchAll(separator)) {
    const index = match.index ?? 0
    pushBlock(at, index)
    at = index + match[0].length
  }
  pushBlock(at, source.length)
  return blocks
}

/** 正文段落与 N−1 个相邻边界（节拍标记不参与编号） */
export function paragraphsAndBoundaries(text: string, blocks: ScriptBlock[]): {
  paragraphs: BridgeParagraph[]
  boundaries: BridgeBoundary[]
} {
  const paragraphs: BridgeParagraph[] = []
  for (const block of blocks) {
    const body = text.slice(block.bodyStart, block.end)
    if (!body.trim()) continue
    paragraphs.push({
      id: `P${String(paragraphs.length + 1).padStart(2, '0')}`,
      bodyStart: block.bodyStart,
      bodyEnd: block.end,
      blockEnd: block.end,
      text: body,
      chars: body.replace(/[\s\u3000]/g, '').length,
    })
  }
  const boundaries: BridgeBoundary[] = []
  for (let i = 0; i + 1 < paragraphs.length; i++) {
    boundaries.push({
      boundary_id: `B${String(i + 1).padStart(2, '0')}`,
      left_paragraph: paragraphs[i]!.id,
      right_paragraph: paragraphs[i + 1]!.id,
    })
  }
  return { paragraphs, boundaries }
}

export class BridgeContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeContractError'
  }
}

/**
 * 模型返回的逐边界决策 → 校验过的决策表。
 * 任何结构违规都抛 `BridgeContractError`：缺失、重复、错位、非法决策、多句桥句、
 * 超过单段上限、把行政元信息写回正文——都不产生有效版本（阶段失败，可重试或跳过）。
 */
export function validateBridgeDecisions(
  paragraphs: BridgeParagraph[],
  boundaries: BridgeBoundary[],
  raw: unknown,
): BridgeReport {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).boundaries : null)
  if (!Array.isArray(list)) throw new BridgeContractError('桥句阶段没有返回 boundaries 数组')
  if (list.length !== boundaries.length) {
    throw new BridgeContractError(`桥句阶段必须逐一判断 ${boundaries.length} 个相邻边界，实际返回 ${list.length} 条`)
  }

  const warnings: string[] = []
  const decisions: BridgeDecision[] = []
  const seen = new Set<string>()
  const byId = new Map(paragraphs.map(p => [p.id, p]))
  const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max).trim() : '')

  for (let index = 0; index < boundaries.length; index++) {
    const expected = boundaries[index]!
    const entry = list[index] as Record<string, unknown>
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BridgeContractError(`边界 ${expected.boundary_id} 的决策不是对象`)
    }
    const id = str(entry.boundary_id, 16)
    if (!id) throw new BridgeContractError(`第 ${index + 1} 条决策缺少 boundary_id（应为 ${expected.boundary_id}）`)
    if (id !== expected.boundary_id) {
      throw new BridgeContractError(`边界顺序错位：第 ${index + 1} 条应为 ${expected.boundary_id}，实际 ${id}`)
    }
    if (seen.has(id)) throw new BridgeContractError(`边界 ${id} 重复出现`)
    seen.add(id)
    // 端点必须显式写全并与期望完全一致：缺一个就说明这条决策没真的对准那个边界，
    // 逐边界审计就不成立，不能靠服务端替它补上
    const left = str(entry.left_paragraph, 16)
    const right = str(entry.right_paragraph, 16)
    if (left !== expected.left_paragraph || right !== expected.right_paragraph) {
      throw new BridgeContractError(`边界 ${id} 的段落对不正确：应为 ${expected.left_paragraph}→${expected.right_paragraph}，实际 ${left || '(缺)'}→${right || '(缺)'}`)
    }

    const kind = str(entry.decision, 32) as BridgeDecisionKind
    if (!['no_bridge', 'inserted', 'needed_but_unsafe'].includes(kind)) {
      throw new BridgeContractError(`边界 ${id} 的 decision 非法：${kind || '(空)'}`)
    }
    const reason = str(entry.reason, 400)
    if (!reason) throw new BridgeContractError(`边界 ${id} 缺少可核对的编辑理由`)
    if (!str(entry.relation, 120)) throw new BridgeContractError(`边界 ${id} 缺少关系分类`)

    const attributionRaw = str(entry.shot_attribution, 24)
    const attribution: BridgeAttribution | null = ['previous_tail', 'next_head', 'standalone'].includes(attributionRaw)
      ? attributionRaw as BridgeAttribution
      : null

    if (kind !== 'inserted') {
      decisions.push({
        boundary_id: id,
        left_paragraph: expected.left_paragraph,
        right_paragraph: expected.right_paragraph,
        relation: str(entry.relation, 120),
        decision: kind,
        reason,
        bridge_text: null,
        placement: null,
        shot_attribution: kind === 'needed_but_unsafe' ? attribution : null,
        spoken_chars: null,
      })
      continue
    }

    // 只归一化空白、不删空白：内容语言可以是 en/ja/ko（app-settings CONTENT_LANGUAGES），
    // 删掉空格会把 "That night, the expedition pressed on." 粘成一个词。
    // 计数（80 字上限、并入判断）仍按去空白的口径，与段落 `chars` 同尺。
    const text = str(entry.bridge_text, 400).replace(/\s+/g, ' ').trim()
    const compact = text.replace(/\s+/g, '')
    if (!compact) throw new BridgeContractError(`边界 ${id} 标为已补写，却没有桥句正文`)
    const leaked = guardStageOutput(text)
    if (leaked.removed.length) {
      throw new BridgeContractError(`边界 ${id} 的桥句里带回了来源/许可/链接等非旁白内容：「${leaked.removed[0]!.text.slice(0, 40)}」`)
    }
    const sentenceEnds = text.match(/[。！？!?]|\.(?=\s|$|[”"』」])/g) || []
    const endsAtTail = /[。！？!?.][”"』」]?$/.test(text)
    if (sentenceEnds.length > 1 || (sentenceEnds.length === 1 && !endsAtTail)) {
      throw new BridgeContractError(`边界 ${id} 的桥句超过一句（每个边界最多一句是硬限制）：「${text.slice(0, 40)}」`)
    }
    if (compact.length > PARAGRAPH_CHAR_LIMIT) {
      throw new BridgeContractError(`边界 ${id} 的桥句 ${compact.length} 字，超过单段 ${PARAGRAPH_CHAR_LIMIT} 字上限`)
    }
    const spoken = text.replace(PUNCTUATION, '').length
    if (spoken > BRIDGE_SPOKEN_HINT) warnings.push(`${id} 桥句 ${spoken} 个朗读字符，超过 ${BRIDGE_SPOKEN_HINT} 字提示阈值`)

    const placementRaw = str(entry.placement, 24)
    // 默认归属已确认：引出下一知识点 → 下一镜开头；总结/限制 → 上一镜尾
    let placement: BridgePlacement = ['end_of_left', 'start_of_right', 'standalone'].includes(placementRaw)
      ? placementRaw as BridgePlacement
      : attribution === 'previous_tail' ? 'end_of_left' : attribution === 'standalone' ? 'standalone' : 'start_of_right'

    // 桥句不豁免每段 80 字：并入会超限时改为独立段，并在报告里显式说明
    let adjusted = false
    const host = placement === 'end_of_left'
      ? byId.get(expected.left_paragraph)
      : placement === 'start_of_right' ? byId.get(expected.right_paragraph) : undefined
    if (host && host.chars + compact.length > PARAGRAPH_CHAR_LIMIT) {
      placement = 'standalone'
      adjusted = true
      warnings.push(`${id} 桥句并入 ${host.id} 会超过 ${PARAGRAPH_CHAR_LIMIT} 字，已改为独立段落`)
    }

    decisions.push({
      boundary_id: id,
      left_paragraph: expected.left_paragraph,
      right_paragraph: expected.right_paragraph,
      relation: str(entry.relation, 120),
      decision: 'inserted',
      reason,
      bridge_text: text,
      placement,
      shot_attribution: attribution
        ?? (placement === 'end_of_left' ? 'previous_tail' : placement === 'standalone' ? 'standalone' : 'next_head'),
      spoken_chars: spoken,
      ...(adjusted ? { placement_adjusted: true } : {}),
    })
  }

  return {
    decisions,
    boundary_count: boundaries.length,
    inserted_count: decisions.filter(d => d.decision === 'inserted').length,
    needed_but_unsafe_count: decisions.filter(d => d.decision === 'needed_but_unsafe').length,
    warnings,
  }
}

/** 中日文表意文字/假名与全角标点：不分词的语境，拼接处不补空格（韩文、拉丁文分词，要补） */
const CJK_CHAR = /[\u2e80-\u303f\u3040-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

/** 把桥句接到相邻字符上：全角语境原样相接，拉丁/谚文语境补一个空格 */
function joined(neighbour: string | undefined, bridge: string, side: 'before' | 'after'): string {
  const edge = side === 'before' ? bridge[0] : bridge[bridge.length - 1]
  if (!neighbour || !edge) return bridge
  if (/\s/.test(neighbour) || CJK_CHAR.test(neighbour) || CJK_CHAR.test(edge)) return bridge
  return side === 'before' ? ` ${bridge}` : `${bridge} `
}

/**
 * 前驱全文 + 已申报桥句 → 桥句版全文。
 * 只在计算好的偏移处插入桥句字节：前驱的空白、缩进、段落顺序逐字节保留。
 */
export function composeBridged(text: string, paragraphs: BridgeParagraph[], decisions: BridgeDecision[]): string {
  const byId = new Map(paragraphs.map(p => [p.id, p]))
  const inserts: Array<{ at: number; text: string; order: number }> = []
  for (const decision of decisions) {
    if (decision.decision !== 'inserted' || !decision.bridge_text) continue
    const left = byId.get(decision.left_paragraph)
    const right = byId.get(decision.right_paragraph)
    if (decision.placement === 'end_of_left' && left) {
      inserts.push({ at: left.bodyEnd, text: joined(text[left.bodyEnd - 1], decision.bridge_text, 'before'), order: 1 })
    } else if (decision.placement === 'start_of_right' && right) {
      inserts.push({ at: right.bodyStart, text: joined(text[right.bodyStart], decision.bridge_text, 'after'), order: 0 })
    } else if (left) {
      inserts.push({ at: left.blockEnd, text: `\n\n${decision.bridge_text}`, order: 2 })
    }
  }
  inserts.sort((a, b) => a.at - b.at || a.order - b.order)
  let out = ''
  let at = 0
  for (const insert of inserts) {
    out += text.slice(at, insert.at) + insert.text
    at = insert.at
  }
  return out + text.slice(at)
}
