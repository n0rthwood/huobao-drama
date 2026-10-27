/**
 * 资产导入的改名规则（Issue #9）——与后端 `services/asset-library.ts` 的
 * `suggestUniqueName` 完全一致：`名字` 已被占用就依次试 `名字-2`、`名字-3`…
 *
 * 占用集合 = 目标项目内该类资产已有的名字 + 同一批次里其他导入项已选的名字。
 * 纯函数，无副作用，便于在对话框里实时校验（提交前前后端各校验一次）。
 */

/** `taken` 可以是数组 / Set / 任意可迭代；空白名字忽略 */
export function suggestUniqueName(base, taken) {
  const used = new Set()
  for (const item of taken || []) {
    const value = String(item ?? '').trim()
    if (value) used.add(value)
  }
  const name = String(base ?? '').trim()
  if (!used.has(name)) return name
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** 名字是否与目标项目已有资产或同批次其他项重名 */
export function isNameTaken(name, taken) {
  const value = String(name ?? '').trim()
  if (!value) return false
  for (const item of taken || []) {
    if (String(item ?? '').trim() === value) return true
  }
  return false
}
