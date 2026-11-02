/**
 * 旁白写作的提示词拼装（#35）—— 纯函数，不碰数据库、不发网络请求，便于单测。
 *
 * 每一次调用（主线 / 分块 / 单镜）都内联剧本全文：旁白必须忠实剧本，
 * 摘要会让模型在细节上自由发挥，这是纪录片口径里最贵的错误。
 */
import { MAX_NARRATION_CHARS } from './narration.js'

/** 一块多少镜：块越大越连贯、进度越粗；6 镜是进度可见与衔接之间的折中（#35 Q1） */
export const NARRATION_CHUNK_SIZE = 6

/** 写作所需的一镜信息（纯数据，便于单测） */
export interface ShotBrief {
  shotNumber: number
  description: string
  atmosphere: string
  duration: number
  continuityBoundary: string
  narrationText: string
  narrationEnabled: boolean
}

/** 把镜头按顺序切块（最后一块可能不足 size） */
export function buildChunks<T>(items: T[], size = NARRATION_CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function shotLine(s: ShotBrief): string {
  const parts = [`#${s.shotNumber}`, `${s.duration || 0}秒`]
  if (s.continuityBoundary) parts.push(`衔接:${s.continuityBoundary}`)
  return `${parts.join(' · ')}\n画面：${s.description}${s.atmosphere ? `\n氛围：${s.atmosphere}` : ''}`
}

function shotOutline(s: ShotBrief): string {
  const head = s.description.replace(/\s+/g, ' ').slice(0, 100)
  return `#${s.shotNumber}（${s.duration || 0}秒${s.continuityBoundary ? `，${s.continuityBoundary}` : ''}）${head}`
}

const WRITING_RULES = `写作口径：整集旁白连起来是一篇能独立读通的解说稿；每一镜写的是「这个故事进行到这一镜」的那一段，不是对这一镜画面的说明。
不得复述观众已经看见的东西（不要写「画面中」「镜头」「此刻」），要补上看不见的：时间、地点、动机、代价、后果、尺度。
忠实剧本：不新增人物、数字、年代、因果、评价；剧本里属于推测/传说/存疑的内容必须保留归属。
每镜不超过 ${MAX_NARRATION_CHARS} 个字符，字数落在该镜 duration × 3.8 ~ duration × 5.1。
年份、日期、人数、条款序号一律写阿拉伯数字（1720年5月8日、8月1日、189人、第3条、1689年到1727年）；禁止用中文数字写年份/日期，尤其禁止「〇」（实测「一七二〇年」会被念成「一七两年」）。「三十八年」「三方」「两路大军」这类约定俗成的说法保持中文。`

/** 阶段 A：主线。输入里带剧本全文，输出一次 save_narration_spine。 */
export function buildSpineMessage(input: {
  script: string
  shots: ShotBrief[]
  chunks: ShotBrief[][]
}): string {
  const ranges = input.chunks
    .map((c, i) => `第 ${i + 1} 段：镜 #${c[0]!.shotNumber}–#${c[c.length - 1]!.shotNumber}`)
    .join('\n')
  return `请为本集规划旁白主线。只调用一次 save_narration_spine，不要调用其它工具，不要输出正文。

== 剧本全文 ==
${input.script}

== 全集分镜清单（${input.shots.length} 镜）==
${input.shots.map(shotOutline).join('\n')}

== 需要规划的分段（写镜时会按这个分段并行展开）==
${ranges}

主线请包含两部分：
1）整集主线 3–6 句：这一集从哪里开始、经过哪几个转折、落在什么结论上。
2）逐段一行，格式「第 N 段（镜 #a–#b）：讲什么｜承上：…｜启下：…」。因为各段会被分别展开，承上/启下必须写得足够具体，让两段接起来像一句话说下去。

${WRITING_RULES}`
}

/** 阶段 B：一块镜头。上下文含剧本全文 + 主线 + 相邻镜已落库的旁白。 */
export function buildChunkMessage(input: {
  script: string
  spine: string
  chunk: ShotBrief[]
  prev: ShotBrief | null
  next: ShotBrief | null
  chunkIndex: number
  chunkTotal: number
}): string {
  const { chunk, prev, next } = input
  const neighbour = (s: ShotBrief | null, label: string) => {
    if (!s) return `${label}：无（本集边界）`
    const text = s.narrationEnabled
      ? (s.narrationText || '（尚未写，按主线的承上启下接住）')
      : '（该镜是纯画面，无旁白）'
    return `${label}：镜 #${s.shotNumber}\n  画面：${s.description.replace(/\s+/g, ' ').slice(0, 120)}\n  旁白：${text}`
  }
  return `请为本集第 ${input.chunkIndex + 1}/${input.chunkTotal} 段（镜 #${chunk[0]!.shotNumber}–#${chunk[chunk.length - 1]!.shotNumber}）写旁白。
不要调用 read_storyboard_context —— 需要的上下文已经全部给在下面。写完这一段的全部 ${chunk.length} 镜，一次 save_narrations 保存，不要碰本段以外的镜头。

== 剧本全文 ==
${input.script}

== 整集旁白主线 ==
${input.spine}

== 相邻镜（用来接住上下文，不要改它们）==
${neighbour(prev, '上一镜')}
${neighbour(next, '下一镜')}

== 本段要写的镜头 ==
${chunk.map(shotLine).join('\n\n')}

纯画面镜头传 narration_enabled: false 且 narration 为空字符串；本段这样的镜头不要超过一半。
${WRITING_RULES}`
}

/** 单镜写作/重写：上下文与分块一致，只是范围收到一镜。 */
export function buildShotMessage(input: {
  script: string
  spine: string
  shot: ShotBrief
  prev: ShotBrief | null
  next: ShotBrief | null
}): string {
  return buildChunkMessage({
    script: input.script,
    spine: input.spine || '（本集还没有保存主线：先通读剧本，自己判断这一镜在整集故事里的位置）',
    chunk: [input.shot],
    prev: input.prev,
    next: input.next,
    chunkIndex: 0,
    chunkTotal: 1,
  })
}
