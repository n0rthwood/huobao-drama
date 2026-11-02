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

/**
 * 近名归一化（提取去重用）：同一角色/道具在剧本里可能写成「林小雨」「林小雨（主角）」
 * 「林小雨(女主)」「林小雨 」。去掉括号内的定位/别名、去掉空白与 `_` 后做精确比较，
 * 命中即视为同一个人，不重复建卡。
 * 空白与 `_` 一并去掉：资产名里的空白会被规范化成 `_`（上面的 normalizeAssetName），
 * 「斋桑湖北岸」仍要命中「斋桑湖_北岸」。
 */
export function normalizeNearName(name: string): string {
  return (name || '')
    .replace(/[（(][^（()）]*[）)]/g, '') // 去掉成对的中/英文括号内容（角色定位/别名）
    .replace(/[（(].*$/, '')              // 兜底：未闭合括号从首个括号截断
    .replace(/[\s　_]+/g, '')             // 去空白、全角空格与 _
    .toLowerCase()
    .trim()
}

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
