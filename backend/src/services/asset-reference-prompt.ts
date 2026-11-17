/**
 * 资产参考图 ↔ 最终提示词的引用约定（Issue #107 追加范围）
 *
 * 用户在角色/场景/道具资产上上传的参考图（`reference_images`）在生图时按存储顺序作为
 * 「图片1…图片N」一起发给模型。提示词必须逐张引用并说明各自贡献，否则模型只在开头看到
 * 一串泛化前缀（旧实现 `以 <image1>、<image2> 为参考：`），参考图等于没被真正用上，
 * 还会把参考图的构图整体搬进成片图。
 *
 * 写法故意保持厂商无关：提示词里写 `@参考图1`，与关键帧的 `@名字` 是同一套机制
 * （`services/prompt-refs.ts` 的 `resolvePromptRefs`）；提交时按 provider 渲染成
 * qwen-jobs 的 `<image1>` 或其余厂商的 `图片1`（与 `services/task-label.ts` 的
 * `renderRefPrompt` 同口径）。库里因此不存厂商专属标签，换厂商重试可以重新渲染。
 *
 * 本文件只放纯函数（无 DB）：读工具、保存工具的校验、提示词模板、提交与重试都调用同一份规则。
 */
import { resolvePromptRefs } from './prompt-refs.js'
import { referenceLabel } from './task-label.js'

/** 提示词里指代第 N 张参考图的中性写法（1 起，顺序即发送顺序） */
export function referenceToken(index: number): string {
  return `@${referenceLabel(index)}`
}

/**
 * 中性写法 → 序号。形状与关键帧的 `nameToIndex` 一致，
 * 既能交给 `resolvePromptRefs` 渲染，也能作为 `refNameIndex` 落库供换厂商重试复用。
 */
export function referenceNameIndex(refCount: number): Record<string, number> {
  const index: Record<string, number> = {}
  for (let n = 1; n <= refCount; n++) index[referenceLabel(n)] = n
  return index
}

/** 提示词里可识别的四种写法：中性（@参考图N）、qwen-jobs（<imageN>）、H3-Image（<Picture N>）、其余厂商（图片N） */
function citationForms(index: number): string[] {
  return [referenceToken(index), `<image${index}>`, `<Picture ${index}>`, `图片${index}`]
}

/** 「图片1」不能命中「图片10」：数字后紧跟数字是另一张参考图 */
function citationPattern(form: string, flags = ''): RegExp {
  return new RegExp(form.endsWith('>') ? form : `${form}(?!\\d)`, flags)
}

/** 没有被引用的参考图序号（1 起）；`refCount` = 本次生图真正会发送的张数 */
export function uncitedReferences(prompt: string, refCount: number): number[] {
  const text = prompt || ''
  const missing: number[] = []
  for (let n = 1; n <= refCount; n++) {
    if (!citationForms(n).some(form => citationPattern(form).test(text))) missing.push(n)
  }
  return missing
}

/** 提示词里出现的参考图序号（三种写法都算），用于发现「引用了本次根本不发送的第 N 张」 */
export function citedReferenceIndices(prompt: string): number[] {
  const found = new Set<number>()
  for (const match of (prompt || '').matchAll(/@参考图(\d+)|<image(\d+)>|图片(\d+)/gi)) {
    found.add(Number(match[1] ?? match[2] ?? match[3]))
  }
  return [...found].sort((a, b) => a - b)
}

/** 引用了不存在的序号：本次只发 refCount 张，提示词却写了第 N 张（N > refCount 或 N < 1） */
export function outOfRangeReferences(prompt: string, refCount: number): number[] {
  return citedReferenceIndices(prompt).filter(n => n < 1 || n > refCount)
}

/** 每张参考图都被显式引用、且没有引用不存在的序号（refCount 为 0 时提示词里不得有任何标记） */
export function promptCitesReferences(prompt: string, refCount: number): boolean {
  return uncitedReferences(prompt, refCount).length === 0 && outOfRangeReferences(prompt, refCount).length === 0
}

/** 提示词里是否已出现任一参考图引用写法（不校验张数）：提交侧据此决定要不要补泛化前缀 */
export function promptMentionsReferences(prompt: string): boolean {
  return /@参考图\d+|<image\d+>|<Picture \d+>|图片\d+/i.test(prompt || '')
}

/**
 * 保存工具的拒绝原因：有参考图却漏引用、或引用了本次不发送的序号时返回说明，否则 null。
 * 与 `sceneFinalPromptCoversTime` 同一语义——退回给模型改写，不静默兜底。
 */
export function referenceCitationIssue(prompt: string, refCount: number): string | null {
  const missing = uncitedReferences(prompt, refCount)
  if (missing.length) {
    return `该资产有 ${refCount} 张参考图，最终提示词必须逐张引用并写明各自贡献，缺少 ${missing.map(referenceToken).join('、')}`
  }
  const stray = outOfRangeReferences(prompt, refCount)
  if (stray.length) {
    return `该资产本次只发送 ${refCount} 张参考图，提示词却引用了不存在的 ${stray.map(referenceToken).join('、')}`
  }
  return null
}

/** qwen-jobs（Qwen Image 2.1）认 `<imageN>`；其余厂商没有占位语法，退化成 `图片N`（与关键帧同口径） */
export function usesImageTags(provider: string | null | undefined): boolean {
  return (provider || '').toLowerCase() === 'qwen-jobs'
}

/**
 * 把提示词里的参考图引用渲染成该厂商的写法：
 * `@参考图N`（中性）、`<imageN>`、`<Picture N>`、`图片N` 四种写法统一换成目标厂商的写法。
 * 没有参考图时原样返回——资产无参考图的既有行为不变。
 * `picture`：目标是 MiniMax-H3-Image（按 model 判定，provider 仍是 qwen-jobs）。
 */
export function renderReferencePrompt(
  prompt: string,
  refCount: number,
  provider: string | null | undefined,
  picture = false,
): string {
  if (!prompt || refCount <= 0) return prompt
  const tokenOf = picture
    ? (index: number) => `<Picture ${index}>`
    : usesImageTags(provider)
      ? (index: number) => `<image${index}>`
      : (index: number) => `图片${index}`
  let out = resolvePromptRefs(prompt, referenceNameIndex(refCount), tokenOf)
  // 序号从大到小：先换 图片10，再换 图片1，否则后者会把前者的尾巴吃掉
  for (let n = refCount; n >= 1; n--) {
    const target = tokenOf(n)
    for (const form of citationForms(n)) {
      if (form === target) continue
      out = out.replace(citationPattern(form, 'gi'), target)
    }
  }
  return out
}

/**
 * `ensure*FinalPrompt` 用户消息里的「参考图」段落：说清张数、发送顺序与逐张引用的要求。
 * 没有参考图时必须明说，否则模型会照着旧稿虚构引用标记。
 */
export function referenceInstruction(kindLabel: string, refCount: number): string {
  if (refCount <= 0) {
    return `该${kindLabel}没有参考图（0 张）：提示词里不得出现任何参考图引用标记（不要写 ${referenceToken(1)} 之类的占位），也不得虚构参考图的形制。`
  }
  const tokens = Array.from({ length: refCount }, (_, i) => referenceToken(i + 1)).join('、')
  return `该${kindLabel}有 ${refCount} 张参考图，生图时按顺序作为 图片1…图片${refCount} 一起传给模型。最终提示词必须逐张引用它们（写法：${tokens}），并逐张说明它提供的是什么（年代、形制、材质、布局、穿戴细节）；只取参考图里的这些要素，不得整体复制参考图的构图、画框或背景。`
}
