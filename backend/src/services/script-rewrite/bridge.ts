/**
 * 桥句阶段的结构契约（Issue #70 §4）—— 纯函数，不碰数据库也不调模型。
 *
 * 关键设计：**最终全文由服务端在前驱正文上按偏移插入已申报的桥句**，模型只回报告。
 * 前驱的每一个字节（含缩进、空行、段落顺序）原样保留，只有桥句字节是新增的，
 * 所以「报告说加了、正文没加」「正文被偷偷改写/删段/重排」在结构上就不可能发生。
 *
 * 计数口径（固定，不随模型输出漂移）：
 * - 「朗读字符」= 去掉空白与标点/结构标记后的字符数（25 为可见提示，不是失败）；
 * - 硬上限落在**句子**上（#109）：自然段不限长度，一个自然段就是一个逻辑组；
 *   桥句本身必须是 ≤80 字的单句，并进宿主段落后也不能把宿主的那一句撑到 80 字以上；
 * - 桥句只能并入相邻两段之一（段尾或段首），**不能独立成段**——独立成段就是凭空多出一个逻辑组。
 */
import { MAX_NARRATION_CHARS, narrationCharCount } from '../narration.js'
import { splitSentences } from '../subtitle.js'
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
  text: string
}

export interface BridgeBoundary {
  boundary_id: string
  left_paragraph: string
  right_paragraph: string
}

export type BridgeDecisionKind = 'no_bridge' | 'inserted' | 'needed_but_unsafe'
/** 桥句只能并进左段段尾或右段段首：独立成段会凭空多出一个逻辑组 */
export type BridgePlacement = 'end_of_left' | 'start_of_right'
export type BridgeAttribution = 'previous_tail' | 'next_head'

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
}

export interface BridgeReport {
  decisions: BridgeDecision[]
  boundary_count: number
  inserted_count: number
  needed_but_unsafe_count: number
  warnings: string[]
}

/** 单句硬上限：与语音合成单段上限同一口径（一镜一句，通过这里的句子一定能成为一镜） */
export const SENTENCE_CHAR_LIMIT = MAX_NARRATION_CHARS
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
      text: body,
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
 * 超过单句上限、独立成段（`standalone`）、把行政元信息写回正文——
 * 都不产生有效版本（阶段失败，可回喂模型重试或跳过）。
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
    // 归属只剩两种：桥句并进左段就归上一镜尾，并进右段就归下一镜头部；独立桥镜不存在了
    if (attributionRaw && !['previous_tail', 'next_head'].includes(attributionRaw)) {
      throw new BridgeContractError(`边界 ${id} 的 shot_attribution 非法：${attributionRaw}（只允许 previous_tail | next_head）`)
    }
    const attribution: BridgeAttribution | null = attributionRaw ? attributionRaw as BridgeAttribution : null

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
    // 计数（单句 80 字上限）仍按去空白的朗读字符口径。
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
    if (compact.length > SENTENCE_CHAR_LIMIT) {
      throw new BridgeContractError(`边界 ${id} 的桥句 ${compact.length} 字，超过单句 ${SENTENCE_CHAR_LIMIT} 字上限`)
    }
    const spoken = text.replace(PUNCTUATION, '').length
    if (spoken > BRIDGE_SPOKEN_HINT) warnings.push(`${id} 桥句 ${spoken} 个朗读字符，超过 ${BRIDGE_SPOKEN_HINT} 字提示阈值`)

    // 桥句只能并进相邻两段之一：总结/收束 → 左段段尾（属于左组），引出下一知识点 → 右段段首（属于右组）。
    // 独立成段是契约违例：那等于凭空多出一个逻辑组（#109），必须回喂模型修正，不能替它改。
    const placementRaw = str(entry.placement, 24)
    if (!['end_of_left', 'start_of_right'].includes(placementRaw)) {
      throw new BridgeContractError(`边界 ${id} 的 placement 非法：${placementRaw || '(空)'}（只允许 end_of_left | start_of_right；桥句并入左段段尾或右段段首，不能独立成段）`)
    }
    const placement = placementRaw as BridgePlacement
    const host = byId.get(placement === 'end_of_left' ? expected.left_paragraph : expected.right_paragraph)!

    // 桥句不豁免单句 80 字：它自己必须是短句；不带句末标点时，接上宿主那一句也不能把那一句撑过上限。
    // （带句末标点的桥句本身就是一句，宿主句子原样不动，所以长段落照样可以并入。）
    if (!endsAtTail) {
      const hostSentences = splitSentences(host.text)
      const edge = placement === 'end_of_left' ? hostSentences[hostSentences.length - 1] ?? '' : hostSentences[0] ?? ''
      const mergedChars = narrationCharCount(edge) + narrationCharCount(text)
      if (mergedChars > SENTENCE_CHAR_LIMIT) {
        throw new BridgeContractError(`边界 ${id} 的桥句接到 ${host.id} 的${placement === 'end_of_left' ? '段尾' : '段首'}后会变成一句 ${mergedChars} 字，超过单句 ${SENTENCE_CHAR_LIMIT} 字上限：请改放到${placement === 'end_of_left' ? '右段段首' : '左段段尾'}，或把桥句写短`)
      }
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
      shot_attribution: attribution ?? (placement === 'end_of_left' ? 'previous_tail' : 'next_head'),
      spoken_chars: spoken,
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
 * 桥句只并入左段段尾或右段段首，段落数不变（逻辑组不变）。
 */
export function composeBridged(text: string, paragraphs: BridgeParagraph[], decisions: BridgeDecision[]): string {
  const byId = new Map(paragraphs.map(p => [p.id, p]))
  const inserts: Array<{ at: number; text: string }> = []
  for (const decision of decisions) {
    if (decision.decision !== 'inserted' || !decision.bridge_text) continue
    if (decision.placement === 'end_of_left') {
      const left = byId.get(decision.left_paragraph)
      if (left) inserts.push({ at: left.bodyEnd, text: joined(text[left.bodyEnd - 1], decision.bridge_text, 'before') })
    } else {
      const right = byId.get(decision.right_paragraph)
      if (right) inserts.push({ at: right.bodyStart, text: joined(text[right.bodyStart], decision.bridge_text, 'after') })
    }
  }
  inserts.sort((a, b) => a.at - b.at)
  let out = ''
  let at = 0
  for (const insert of inserts) {
    out += text.slice(at, insert.at) + insert.text
    at = insert.at
  }
  return out + text.slice(at)
}
