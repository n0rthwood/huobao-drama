/**
 * 资产名规则（Issue #34，唯一实现）：角色 name / 道具 name / 场景 location。
 *
 * 资产名会出现在提示词的 `@名字` 里，`@` 引用按「@ 后取到空白为止」解析，
 * 所以名字里不能有空白；同时按文件名安全的口径禁止 `\ / : * ? " < > | @` 与控制字符。
 * 连续的（空白 ∪ 非法字符）合并成**一个** `_`（`A / B` → `A_B`，不是 `A___B`），首尾的 `_`、`.` 去掉。
 * 规范化后为空 = 非法名字，由调用方拒绝（HTTP 400）或跳过。
 */
const ILLEGAL_RUN = /[\s\\/:*?"<>|@\u0000-\u001f\u007f]+/g

export function normalizeAssetName(raw: unknown): string {
  return String(raw ?? '').trim().replace(ILLEGAL_RUN, '_').replace(/^[_.]+|[_.]+$/g, '')
}

/** 规范化后为空时 HTTP 入口返回的 400 文案 */
export const EMPTY_ASSET_NAME_MESSAGE = '名称不能为空（空白与 \\ / : * ? " < > | @ 会自动替换为 _）'

export interface AssetRename {
  from: string
  to: string
}

/**
 * 把提示词里指向旧名的 `@引用` 改成新名（存量迁移用）。
 * 旧名的两种写法都改：原样（含空白）与去掉空白（模型常把「斋桑湖 北岸」写成「@斋桑湖北岸」）。
 * 每个 `@` 处按最长优先匹配；项目内现有合法名也参与匹配并原样保留，避免去空白写法吞掉更长的合法名。
 */
export function rewriteAssetMentions(text: string, renames: AssetRename[], legalNames: string[]): string {
  if (!text || !renames.length) return text
  const replacement = new Map<string, string>()
  for (const name of legalNames) if (name) replacement.set(name, name)
  for (const { from, to } of renames) {
    for (const key of [from.trim(), from.replace(/\s+/g, '')]) {
      if (key && !replacement.has(key)) replacement.set(key, to)
    }
  }
  const keys = [...replacement.keys()].sort((a, b) => b.length - a.length)
  let out = ''
  for (let i = 0; i < text.length;) {
    if (text[i] === '@') {
      const rest = text.slice(i + 1)
      const hit = keys.find(key => rest.startsWith(key))
      if (hit) {
        out += `@${replacement.get(hit)}`
        i += 1 + hit.length
        continue
      }
    }
    out += text[i]
    i++
  }
  return out
}
