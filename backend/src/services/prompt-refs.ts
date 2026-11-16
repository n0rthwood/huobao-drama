/**
 * 参考图编号与 @引用渲染 — 纯函数（不碰数据库，供关键帧/视频/资产参考图与提交侧重试共用）。
 *
 * 这套规则是仓库里唯一的「提示词怎么指代第 N 张参考图」实现：
 * - 编号 = 发送顺序（1 起），去重后截断到上限；
 * - 提示词写 `@名字`，渲染时按名字最长优先换成各厂商的写法；
 * - 资产参考图没有资产名，序号别名 `参考图N` 就是它的「名字」（见 services/task-label.ts）。
 *
 * 从 services/storyboard-assets.ts 拆出来：qwen-jobs 客户端与提示词校验都要用这套规则，
 * 而 storyboard-assets 会加载 db（顶层 await），纯模块不能反向依赖它。
 */

/** 参考图上限（与前端面板、Seedance 多模态上限一致） */
export const REF_IMAGE_LIMIT = 9

export interface AssetRef {
  name: string
  url: string
}

/** 去重并截断到上限，同时给有名字的参考图编号（1 起，顺序即发送顺序） */
export function indexRefs(refs: AssetRef[]): { urls: string[]; nameToIndex: Record<string, number> } {
  const ordered: AssetRef[] = []
  for (const ref of refs) {
    if (!ref.url || ordered.length >= REF_IMAGE_LIMIT || ordered.some(item => item.url === ref.url)) continue
    ordered.push(ref)
  }
  const nameToIndex: Record<string, number> = {}
  ordered.forEach((ref, index) => {
    if (ref.name && !(ref.name in nameToIndex)) nameToIndex[ref.name] = index + 1
  })
  return { urls: ordered.map(ref => ref.url), nameToIndex }
}

/**
 * 把提示词里的 @名字 换成模型可识别的图片引用。
 * 名字按长度倒序匹配，避免“小明”抢在“小明妈妈”前面命中。
 */
export function resolvePromptRefs(
  prompt: string,
  nameToIndex: Record<string, number>,
  format: (index: number, name: string) => string,
): string {
  const names = Object.keys(nameToIndex).sort((a, b) => b.length - a.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@]+)/g, (match, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) return `${format(nameToIndex[name]!, name)}${raw.slice(name.length)}`
    }
    return match
  })
}
