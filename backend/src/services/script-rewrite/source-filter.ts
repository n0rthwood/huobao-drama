/**
 * 公共输入准备（Issue #70 §0）— 自动剥离「不是用来念的」材料，产出旁白正文 + 逐条过滤报告。
 *
 * 这是进入任何 AI 阶段之前的**必经**处理，不可跳过：跳过 AI 加工也不会让来源、许可、
 * 永久链接、贡献者、使用说明进入旁白、分镜、TTS 或字幕。
 *
 * 判定全部是确定性规则，不调用模型：
 * - 行首「键：值」形式的行政字段（来源 / 许可 / 贡献者 / 检索日期 …）；
 * - 整行只有一个 URL，或正文里夹带的裸 URL、Markdown 链接的 URL 部分；
 * - 明说「不作为旁白朗读稿」之类的非朗读说明；
 * - 标题行命中行政关键词时，连同其后到下一个标题之间的内容一起剥离（参考资料 / 外部链接段）。
 *
 * **不碰事实归属**：「据《异域录》记载」「图理琛在回程途中写下」没有「键：值」结构，
 * 也不是链接，规则不会命中；过滤只能删「谁给的材料」，不能删「材料里讲了什么」。
 *
 * 纯正文输入**一个字都不改**（逐字节相同）：只有真的删掉了东西，才会在删除点把
 * 多余空行收敛到至多一个空行，别处的空白一律原样保留。
 */

export type FilterCategory =
  | 'source_link'
  | 'license'
  | 'contributor'
  | 'usage_note'
  | 'non_narration_note'
  | 'metadata_field'

export interface RemovedSpan {
  /** 在原始资料里的起止下标（end 不含） */
  start: number
  end: number
  text: string
  category: FilterCategory
  /** 具体理由，不是笼统的「已清洗」 */
  reason: string
}

export interface SourceFilterReport {
  removed: RemovedSpan[]
  /** 明确保留下来的、看起来像出处但属于正文事实归属的片段（展示用，可为空） */
  kept_notes: string[]
  raw_chars: number
  prepared_chars: number
}

export interface SourceFilterResult {
  prepared: string
  report: SourceFilterReport
}

const CATEGORY_REASON: Record<FilterCategory, string> = {
  source_link: '来源/永久链接字段：保留供溯源与授权核对，不属于向观众讲述的内容',
  license: '授权元信息：保留供合规溯源，不进入解说词',
  contributor: '贡献者/版权归属字段：属于编辑信息，不是旁白事实',
  usage_note: '资料使用说明：面向编辑者的操作说明，不向观众朗读',
  non_narration_note: '材料自己声明的非朗读内容：不进入旁白、字幕与时长预算',
  metadata_field: '资料头部的著录字段：属于条目元信息，不是解说正文',
}

/**
 * 行首「键：值」形式的行政字段。键必须整词命中，后面紧跟中英文冒号。
 *
 * 这里**刻意只收行政专用词**。像「作者」「译者」「语言」「版本」「标题」这类词在史料正文里
 * 同样是事实（「作者：司马迁。该书成书于……」「语言：满文与汉文。这份条约……」），
 * 靠关键词区分不了行政著录与历史事实，所以一律不收——Issue 明确禁止借过滤删历史事实。
 * 明确来源引用后混入正文时，只去掉引用；来源标签下的历史叙述保留。
 */
const FIELD_RULES: Array<{ keys: string[]; category: FilterCategory }> = [
  {
    category: 'source_link',
    keys: [
      '来源', '來源', '资料来源', '資料來源', '原始来源', '原始來源', '引用来源', '引用來源',
      '原文链接', '原文鏈接', '链接', '鏈接', '永久链接', '永久鏈接', '固定链接', '固定鏈接',
      '网址', '網址', '参考资料', '參考資料', '参考文献', '參考文獻', '延伸阅读', '延伸閱讀',
      'source', 'sources', 'url', 'urls', 'permalink', 'permanent link',
      'references', 'retrieved from', 'see also',
    ],
  },
  {
    category: 'license',
    keys: [
      '许可', '許可', '许可证', '許可證', '许可协议', '許可協議', '授权', '授權', '授权协议', '授權協議',
      '版权', '版權', '著作权', '著作權', '版权声明', '版權聲明',
      'license', 'licence', 'licensing', 'copyright',
    ],
  },
  {
    category: 'contributor',
    keys: [
      '贡献者', '貢獻者', '贡献历史', '貢獻歷史', '编辑者', '編輯者', '维护者', '維護者',
      '上传者', '上傳者', '整理者',
      // 「原作者」是条目导出时的署名字段（原作者：该条目贡献者）；史料叙述写的是「作者」「著者」，
      // 泛用的「作者」仍然不收（会删掉历史事实）。繁体同形，不另列。
      '原作者',
      'contributor', 'contributors', 'credits', 'uploader',
    ],
  },
  {
    category: 'usage_note',
    keys: [
      '使用说明', '使用說明', '使用须知', '使用須知', '引用方式', '引用格式',
      '免责声明', '免責聲明',
      // 「编者注/编者按」是整理者写给编辑看的旁批（编者注：本节待补充地图。），不是旁白；
      // 与「作者」不同，这两个整词不会作为史料叙述的行首著录键出现。
      '编者注', '編者注', '編者註', '编者按', '編者按',
      'how to cite', 'citation', 'disclaimer',
    ],
  },
  {
    category: 'metadata_field',
    keys: [
      '条目', '條目', '词条', '詞條', '原始材料', '原始资料', '原始資料', '素材来源', '素材來源',
      '检索日期', '檢索日期', '访问日期', '訪問日期', '抓取时间', '抓取時間',
      '最后编辑', '最後編輯', '最后修改', '最後修改', '采集时间', '採集時間',
      'retrieved', 'accessed', 'last edited', 'last modified',
    ],
  },
]

/** 标题行命中这些词时，整节（到下一个标题为止）都是行政内容 */
const SECTION_HEADINGS: Array<{ keys: string[]; category: FilterCategory }> = [
  {
    category: 'source_link',
    keys: ['参考资料', '參考資料', '参考文献', '參考文獻', '外部链接', '外部鏈接', '来源', '來源', '出处', '出處',
      '延伸阅读', '延伸閱讀', 'references', 'external links', 'sources', 'further reading', 'see also', 'bibliography'],
  },
  {
    category: 'license',
    keys: ['许可', '許可', '许可证', '許可證', '授权', '授權', '版权', '版權', 'license', 'licence', 'copyright'],
  },
  {
    category: 'contributor',
    keys: ['贡献者', '貢獻者', '贡献历史', '貢獻歷史', '作者', '编者', '編者', 'authors', 'contributors', 'credits'],
  },
  {
    category: 'usage_note',
    keys: ['使用说明', '使用說明', '免责声明', '免責聲明', '引用方式', 'disclaimer', 'how to cite', 'usage'],
  },
]

/** 明说「这段不是旁白」的句子 */
const NON_NARRATION_PATTERNS: RegExp[] = [
  /不作为(旁白|解说|解說|朗读|朗讀|配音)/,
  /不用于(朗读|朗讀|配音|旁白)/,
  /非(朗读|朗讀)(稿|内容|內容|正文)/,
  /不(进入|進入|计入|計入)(旁白|解说|解說|字幕)/,
  /仅供(溯源|存档|存檔|参考|參考|编辑|編輯)(使用)?/,
  /not\s+(part\s+of\s+)?(the\s+)?narration/i,
  /do\s+not\s+read\s+aloud/i,
]

function noticeCategory(text: string): FilterCategory | null {
  if (/^\s*(?:本(?:页面|頁面|作品|条目|條目|文件|文内容|文內容|文文字)|本站内容).{0,30}(?:采用|採用|遵循|依照|根据|根據|许可|許可).{0,35}(?:知识共享|知識共享|Creative Commons|CC[- ]BY|CC0)/i.test(text)
    || /^\s*(?:this (?:text|page|article|work|file)|text|content).{0,35}(?:available|licensed|released).{0,30}(?:Creative Commons|CC[- ]BY|CC0|public domain)/i.test(text)) return 'license'
  return NON_NARRATION_PATTERNS.some(re => re.test(text)) ? 'non_narration_note' : null
}

const URL_RE = /https?:\/\/[^\s)）」】>，,；;]+|www\.[^\s)）」】>，,；;]+/g
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\((?:https?:\/\/|www\.)[^)\s]*\)/g
/** Markdown / wiki 标题行 */
const HEADING_RE = /^\s*(?:#{1,6}\s+(.*)|={2,}\s*(.*?)\s*={2,})\s*$/

interface Line {
  start: number
  end: number
  text: string
}

function splitLines(raw: string): Line[] {
  const lines: Line[] = []
  let at = 0
  while (at <= raw.length) {
    const nl = raw.indexOf('\n', at)
    if (nl < 0) {
      lines.push({ start: at, end: raw.length, text: raw.slice(at) })
      break
    }
    lines.push({ start: at, end: nl, text: raw.slice(at, nl) })
    at = nl + 1
  }
  return lines
}



function matchKey(keys: string[], candidate: string): string | null {
  const lower = candidate.toLowerCase()
  for (const key of keys) {
    if (lower === key.toLowerCase()) return key
  }
  return null
}

/** 行内按句末标点切出的句子及其在原文里的位置（整句级删除用） */
function sentenceSpans(line: Line): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = []
  let at = 0
  const push = (from: number, to: number) => {
    const text = line.text.slice(from, to)
    if (text.trim()) spans.push({ start: line.start + from, end: line.start + to, text })
  }
  for (const m of line.text.matchAll(/[。！？!?]+|\.(?=\s|$)/g)) {
    const end = (m.index ?? 0) + m[0].length
    push(at, end)
    at = end
  }
  push(at, line.text.length)
  return spans
}

/**
 * 行首「键：值」判定：键必须是整词，冒号后可以为空（空字段同样是著录行）。
 * `valueStart` 是值在该行里的下标，调用方据此在「值其实是叙述」时只剥掉著录前缀。
 */
function fieldCategory(text: string): { category: FilterCategory; key: string; value: string; valueStart: number } | null {
  const m = text.match(/^(\s*[*\-–—•·]?\s*(?:\*\*)?\s*([^：:\n]{1,24}?)\s*(?:\*\*)?\s*[：:]\s*)(.*)$/)
  if (!m) return null
  const key = m[2]!.trim().replace(/[\s*_]+$/g, '')
  if (!key) return null
  for (const rule of FIELD_RULES) {
    const hit = matchKey(rule.keys, key)
    if (hit) return { category: rule.category, key, value: m[3] ?? '', valueStart: m[1]!.length }
  }
  return null
}

function headingCategory(title: string): FilterCategory | null {
  const normalized = title.replace(/[\s:：]+$/g, '').trim()
  for (const rule of SECTION_HEADINGS) {
    if (matchKey(rule.keys, normalized)) return rule.category
  }
  return null
}



function isBareUrlLine(text: string): boolean {
  const trimmed = text.trim().replace(/^[*\-–—•·]\s*/, '')
  if (!trimmed) return false
  return /^(?:<)?(?:https?:\/\/|www\.)[^\s]+(?:>)?[.,;，。；]?$/.test(trimmed)
}

/** 正文行里夹带的链接：只删链接本身，句子其余部分保留 */
function inlineLinkSpans(line: Line): RemovedSpan[] {
  const spans: RemovedSpan[] = []
  const text = line.text
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    const at = m.index ?? 0
    // 只删 `](url)` 部分，保留显示文字
    const labelEnd = at + 1 + m[1].length
    spans.push({
      start: line.start + labelEnd,
      end: line.start + at + m[0].length,
      text: text.slice(labelEnd, at + m[0].length),
      category: 'source_link',
      reason: CATEGORY_REASON.source_link,
    })
  }
  const covered = (index: number) => spans.some(s => index >= s.start - line.start && index < s.end - line.start)
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0
    if (covered(at)) continue
    spans.push({
      start: line.start + at,
      end: line.start + at + m[0].length,
      text: m[0],
      category: 'source_link',
      reason: CATEGORY_REASON.source_link,
    })
  }
  return spans
}

/** 删除整行（含其后的换行），junction 记在行首，供删除点空行收敛 */
function lineSpan(line: Line, category: FilterCategory, reason?: string): RemovedSpan {
  return {
    start: line.start,
    end: line.end,
    text: line.text,
    category,
    reason: reason ?? CATEGORY_REASON[category],
  }
}

/**
 * 原始资料 → 旁白正文 + 过滤报告。
 * 删除的 span 以原始资料下标表示，UI 直接按 start/end 高亮原文。
 */
export function filterNonNarration(raw: string): SourceFilterResult {
  const source = raw ?? ''
  const lines = splitLines(source)
  const removed: RemovedSpan[] = []
  const keptNotes: string[] = []

  let sectionCategory: FilterCategory | null = null
  for (const line of lines) {
    const trimmed = line.text.trim()
    const headingMatch = line.text.match(HEADING_RE)
    if (headingMatch) {
      const title = (headingMatch[1] ?? headingMatch[2] ?? '').trim()
      const category = headingCategory(title)
      sectionCategory = category
      if (category) removed.push(lineSpan(line, category, `${CATEGORY_REASON[category]}（整节「${title}」）`))
      continue
    }
    if (sectionCategory && trimmed) {
      removed.push(lineSpan(line, sectionCategory))
      continue
    }
    if (!trimmed) continue
    // 行政性授权声明或非朗读说明只删命中的那一句，同段叙述保留。
    if (noticeCategory(trimmed)) {
      const hits = sentenceSpans(line).map(span => ({ span, category: noticeCategory(span.text) }))
        .filter(hit => hit.category !== null)
      for (const { span, category } of hits) {
        removed.push({ ...span, category: category!, reason: CATEGORY_REASON[category!] })
      }
      continue
    }
    if (isBareUrlLine(trimmed)) {
      removed.push(lineSpan(line, 'source_link'))
      continue
    }
    const field = fieldCategory(line.text)
    if (field) {
      const proseValue = field.value.replace(URL_RE, url => ' '.repeat(url.length - (url.endsWith('.') ? 1 : 0)) + (url.endsWith('.') ? '.' : ''))
      const firstEnd = proseValue.search(/[。！？!?]|\.(?=\s|$)/)
      // 来源字段也可能误套在完整史料叙述前：只删除明确的来源引用，不删除第一句事实。
      if (field.category === 'source_link' && firstEnd >= 0) {
        const first = field.value.slice(0, firstEnd).trim()
        const reference = /^《[^》]+》(?:卷.{1,12})?$/.test(first)
          || /^(?:中文)?(?:维基百科|維基百科|Wikipedia)/i.test(first)
          || /https?:\/\/|www\./.test(first)
        const cut = field.valueStart + (reference ? firstEnd + 1 : 0)
        removed.push({
          start: line.start,
          end: line.start + cut,
          text: line.text.slice(0, cut),
          category: field.category,
          reason: `「${field.key}」${CATEGORY_REASON[field.category]}（同段其余叙述已保留）`,
        })
      } else {
        removed.push(lineSpan(line, field.category, `「${field.key}」${CATEGORY_REASON[field.category]}`))
      }
      continue
    }
    const inline = inlineLinkSpans(line)
    if (inline.length) removed.push(...inline)
    // 事实归属留在正文里：记一条展示用说明，让人看见「它是被刻意保留的」
    if (/据[《“"].{1,40}[》”"]|记载|記載|写道|寫道|奏(折|報|报)|在.{0,12}中(写|寫)/.test(trimmed)) {
      if (keptNotes.length < 20) keptNotes.push(trimmed.slice(0, 60))
    }
  }

  removed.sort((a, b) => a.start - b.start || a.end - b.end)
  const prepared = applyRemovals(source, removed)
  return {
    prepared,
    report: {
      removed,
      kept_notes: keptNotes,
      raw_chars: source.length,
      prepared_chars: prepared.length,
    },
  }
}

/**
 * 按 span 切掉内容；只在**删除点**收敛空行（最多留一个空行），其余空白逐字节保留。
 * 没有任何删除时返回原串本身。
 */
function applyRemovals(source: string, removed: RemovedSpan[]): string {
  if (!removed.length) return source
  let out = ''
  let at = 0
  for (const span of removed) {
    if (span.start < at) continue
    out += source.slice(at, span.start)
    at = span.end
    // 整行删除时把行尾换行一起吃掉，避免留下孤立空行
    const lineStart = source.lastIndexOf('\n', Math.max(0, span.start - 1)) + 1
    const wholeLine = lineStart === span.start && (source[span.end] === '\n' || span.end === source.length)
    if (wholeLine && source[at] === '\n') at += 1
    // 删除点左侧的连续换行收敛到至多两个（= 一个空行）
    const extraBlank = out.match(/\n{3,}$/)
    if (extraBlank) out = out.slice(0, out.length - extraBlank[0].length) + '\n\n'
  }
  out += source.slice(at)
  // 只收「删除真的碰到的那一头」：开头被删过才去掉残留的前导空白，
  // 结尾被删过才收尾部空白。没被碰过的边缘空白逐字节保留。
  if (removed[0]!.start === 0) out = out.replace(/^[\s\u3000]+/, '')
  if (removed[removed.length - 1]!.end >= source.length) out = out.replace(/[\s\u3000]+$/, '')
  return out
}

/** 过滤后没有任何可朗读正文：必须明确失败，不能把元信息当旁白，也不能伪造正文 */
export class PreparedSourceEmptyError extends Error {
  constructor(public readonly report: SourceFilterReport) {
    super('原始资料里没有可用的旁白正文：全部内容都是来源/许可/贡献者等非朗读材料，请补充正文后重试')
    this.name = 'PreparedSourceEmptyError'
  }
}

/** 过滤并要求正文非空；空正文抛 PreparedSourceEmptyError */
export function prepareSourceOrThrow(raw: string): SourceFilterResult {
  const result = filterNonNarration(raw)
  if (!result.prepared.trim()) throw new PreparedSourceEmptyError(result.report)
  return result
}

/**
 * 二次防漏（验收 17）：AI 阶段的产出同样过一遍同一把尺子。
 * 模型能看见冻结的原始资料，万一把许可/链接抄回正文，这里直接剥掉并记进阶段报告，
 * 不靠「下游自然忽略」。返回的 removed 为空表示模型没有带回行政内容。
 */
export function guardStageOutput(text: string): { text: string; removed: RemovedSpan[] } {
  const result = filterNonNarration(text)
  return { text: result.prepared, removed: result.report.removed }
}
