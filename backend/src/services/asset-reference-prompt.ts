/**
 * 资产参考图 ↔ 最终提示词的引用约定（Issue #107 追加范围；Issue #121 改为「按引用发送」）
 *
 * 两套编号（#121 核心契约）：
 * - **资产编号** = 参考图列表序（1..N，稳定身份）。描述字段与 final_prompt 里的
 *   `@参考图N` 都用它；删除/重排参考图时由 reference-images.ts 同步重写编号。
 * - **请求编号** = 实际发送子集内的连续序（1..M）。发送集合只按 final_prompt 最终文本
 *   引用的参考图（去重、按资产编号升序）；零引用 = 一张不发。提交时构造
 *   资产编号→请求编号映射，把四种写法统一重写成目标厂商的连续标签。
 *
 * 写法保持厂商无关：库里存 `@参考图N`（也识别裸 `参考图N`、`<imageN>`、`<Picture N>`、
 * `图片N`），提交时按 provider 渲染成 qwen-jobs 的 `<image1>` / H3-Image 的 `<Picture 1>` /
 * 其余厂商的 `图片1`。换厂商重试用原任务落盘的 sourcePrompt + refNameIndex（请求编号映射）。
 *
 * 校验口径（#121 统一替换旧「逐张引用」）：引用编号必须存在且不越界；描述字段引用的
 * 每张必须出现在 final_prompt；**未引用的普通参考图不是错误**（允许只引部分、零引用）。
 *
 * 本文件只放纯函数（无 DB）：读工具、保存闸门、核验工具、提交与重试都调用同一份规则。
 */
import { resolvePromptRefs } from './prompt-refs.js'
import { referenceLabel } from './task-label.js'

/** 提示词里指代第 N 张参考图的中性写法（1 起，资产编号） */
export function referenceToken(index: number): string {
  return `@${referenceLabel(index)}`
}

/**
 * 中性写法 → 序号。`indices` 缺省 = 1..refCount（全量旧口径）；
 * 传入资产编号子集时得到「资产编号 → 请求编号」映射（#121 发送集合）。
 */
export function referenceNameIndex(refCount: number, indices?: number[]): Record<string, number> {
  const list = indices ?? Array.from({ length: refCount }, (_, i) => i + 1)
  const index: Record<string, number> = {}
  list.forEach((assetNo, i) => { index[referenceLabel(assetNo)] = i + 1 })
  return index
}

/** 提示词里可识别的五种写法：中性（@参考图N）、裸（参考图N）、qwen-jobs（<imageN>）、H3-Image（<Picture N>）、其余厂商（图片N） */
function citationForms(index: number): string[] {
  return [referenceToken(index), referenceLabel(index), `<image${index}>`, `<Picture ${index}>`, `图片${index}`]
}

/** 「图片1」不能命中「图片10」：数字后紧跟数字是另一张参考图 */
function citationPattern(form: string, flags = ''): RegExp {
  return new RegExp(form.endsWith('>') ? form : `${form}(?!\\d)`, flags)
}

/** 统一识别正则（五种写法；裸 参考图N 的 @ 前缀由第一个分支先吃掉） */
const CITATION_RE = /@参考图(\d+)|参考图(\d+)|<image(\d+)>|<Picture (\d+)>|图片(\d+)/gi

/** 提示词里出现的参考图资产编号（五种写法都算，去重升序） */
export function citedReferenceIndices(prompt: string): number[] {
  const found = new Set<number>()
  for (const match of (prompt || '').matchAll(CITATION_RE)) {
    found.add(Number(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]))
  }
  return [...found].sort((a, b) => a - b)
}

/** 引用了不存在的序号：资产只有 refCount 张参考图，提示词却写了第 N 张 */
export function outOfRangeReferences(prompt: string, refCount: number): number[] {
  return citedReferenceIndices(prompt).filter(n => n < 1 || n > refCount)
}

/** 提示词里是否已出现任一参考图引用写法（不校验张数） */
export function promptMentionsReferences(prompt: string): boolean {
  return /@?参考图\d+|<image\d+>|<Picture \d+>|图片\d+/i.test(prompt || '')
}

/**
 * 发送集合（#121）：final_prompt 引用的参考图资产编号（去重升序，已滤掉越界）。
 * 零引用 → 空数组 = 一张不发。`refCount` = 资产当前在盘参考图张数。
 */
export function sendingReferenceIndices(prompt: string, refCount: number): number[] {
  return citedReferenceIndices(prompt).filter(n => n >= 1 && n <= refCount)
}

export interface CitationCheckInput {
  /** 资产在盘参考图张数（编号 1..refCount） */
  refCount: number
  /** 描述字段里用户引用的资产编号（去重后传入） */
  descriptionCitations?: number[]
}

export interface CitationCheckResult {
  /** 实际会发送的资产编号（升序） */
  willSend: number[]
  /** 引用了不存在的编号 */
  outOfRange: number[]
  /** 描述里引用了、final_prompt 却没落地的编号 */
  descriptionMissing: number[]
}

/**
 * 统一核验（#121）：自查工具、save 闸门、手动 PUT、提交前都用它。
 * 未引用的普通参考图不是错误；描述引用必须落地；越界引用是错误。
 */
export function checkReferenceCitations(prompt: string, input: CitationCheckInput): CitationCheckResult {
  const cited = citedReferenceIndices(prompt)
  const outOfRange = cited.filter(n => n < 1 || n > input.refCount)
  const willSend = cited.filter(n => n >= 1 && n <= input.refCount)
  const sent = new Set(willSend)
  const descriptionMissing = [...new Set(input.descriptionCitations ?? [])]
    .filter(n => n >= 1 && n <= input.refCount && !sent.has(n))
    .sort((a, b) => a - b)
  return { willSend, outOfRange, descriptionMissing }
}

/** 核验结果 → 中文拒绝原因（null = 通过）。退回给模型/用户改写，不静默兜底。 */
export function citationIssueMessage(result: CitationCheckResult, refCount: number): string | null {
  if (result.outOfRange.length) {
    return `该资产只有 ${refCount} 张参考图，提示词却引用了不存在的 ${result.outOfRange.map(referenceToken).join('、')}`
  }
  if (result.descriptionMissing.length) {
    return `资产描述里引用了 ${result.descriptionMissing.map(referenceToken).join('、')}，最终提示词必须保留这些引用并写明各自贡献，缺少 ${result.descriptionMissing.map(referenceToken).join('、')}`
  }
  return null
}

/**
 * 保存闸门 / 手动 PUT 的拒绝原因（#121 口径：不再要求逐张引用全部参考图）。
 * 与 `sceneFinalPromptCoversTime` 同一语义——退回改写，不静默兜底。
 */
export function referenceCitationIssue(prompt: string, refCount: number, descriptionCitations?: number[]): string | null {
  return citationIssueMessage(checkReferenceCitations(prompt, { refCount, descriptionCitations }), refCount)
}

/** qwen-jobs（Qwen Image 2.1）认 `<imageN>`；其余厂商没有占位语法，退化成 `图片N`（与关键帧同口径） */
export function usesImageTags(provider: string | null | undefined): boolean {
  return (provider || '').toLowerCase() === 'qwen-jobs'
}

/**
 * 把提示词里的参考图引用渲染成该厂商的写法（请求编号连续 1..M）。
 * `indices` = 实际发送的资产编号（升序）；缺省 = 1..refCount（全量旧口径，
 * 供无引用过滤的场景如 FLUX 单图降级渲染）。五种写法统一重写，含裸 `参考图N`。
 * 没有参考图时原样返回。`picture`：目标是 MiniMax-H3-Image。
 */
export function renderReferencePrompt(
  prompt: string,
  refCount: number,
  provider: string | null | undefined,
  picture = false,
  indices?: number[],
): string {
  if (!prompt || refCount <= 0) return prompt
  const list = indices ?? Array.from({ length: refCount }, (_, i) => i + 1)
  if (!list.length) return prompt
  const tokenOf = picture
    ? (index: number) => `<Picture ${index}>`
    : usesImageTags(provider)
      ? (index: number) => `<image${index}>`
      : (index: number) => `图片${index}`
  const nameIndex = referenceNameIndex(refCount, list)
  let out = resolvePromptRefs(prompt, nameIndex, tokenOf)
  // 资产编号从大到小：先换 参考图10，再换 参考图1，否则后者会把前者的尾巴吃掉
  for (const assetNo of [...list].sort((a, b) => b - a)) {
    const target = tokenOf(nameIndex[referenceLabel(assetNo)]!)
    for (const form of citationForms(assetNo)) {
      if (form === target) continue
      out = out.replace(citationPattern(form, 'gi'), target)
    }
  }
  return out
}

/**
 * `ensure*FinalPrompt` 用户消息里的「参考图」段落（#121 口径）：
 * 编号 = 资产列表序；按需引用（不强制全部），描述里用户引用的必须保留；
 * 没有参考图时明说，否则模型会虚构引用标记。
 */
export function referenceInstruction(kindLabel: string, refCount: number, descriptionCitations?: number[]): string {
  if (refCount <= 0) {
    return `该${kindLabel}没有参考图（0 张）：提示词里不得出现任何参考图引用标记（不要写 ${referenceToken(1)} 之类的占位），也不得虚构参考图的形制。`
  }
  const tokens = Array.from({ length: refCount }, (_, i) => referenceToken(i + 1)).join('、')
  const must = descriptionCitations?.length
    ? `资产描述里用户已引用 ${descriptionCitations.map(referenceToken).join('、')}：这些引用必须原样保留在最终提示词里并写明各自贡献，不得丢弃或改编号。`
    : ''
  return `该${kindLabel}有 ${refCount} 张参考图，编号按列表顺序（写法：${tokens}）。生图时**只发送最终提示词实际引用的那几张**（零引用则一张不发），所以按需引用：用到哪张就写哪张，并说明它提供的是什么（年代、形制、材质、布局、穿戴细节）；不用的参考图不必提及，也不得虚构未引用图的内容。只取参考图里的这些要素，不得整体复制参考图的构图、画框或背景。${must}`
}