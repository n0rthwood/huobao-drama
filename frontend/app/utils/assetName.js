/**
 * 资产名规则——与后端完全一致：
 * - `normalizeAssetName` ≡ `services/asset-name.ts`（Issue #34）：连续的空白/`\ / : * ? " < > | @`/控制字符
 *   合并为一个 `_`，去首尾 `_`、`.`；服务端在所有写入口执行同一规则，这里用于导入前预览实际落库的名字。
 * - `suggestUniqueName` ≡ `services/asset-library.ts`（Issue #9）：`名字` 已被占用就依次试 `名字-2`、`名字-3`…
 *
 * 占用集合 = 目标项目内该类资产已有的名字 + 同一批次里其他导入项已选的名字。
 * 纯函数，无副作用，便于在对话框里实时校验（提交前前后端各校验一次）。
 */

const ILLEGAL_RUN = /[\s\\/:*?"<>|@\u0000-\u001f\u007f]+/g

export function normalizeAssetName(raw) {
  return String(raw ?? '').trim().replace(ILLEGAL_RUN, '_').replace(/^[_.]+|[_.]+$/g, '')
}

/** `taken` 可以是数组 / Set / 任意可迭代；空白名字忽略 */
export function suggestUniqueName(base, taken) {
  const used = new Set()
  for (const item of taken || []) {
    const value = String(item ?? '').trim()
    if (value) used.add(value)
  }
  const name = normalizeAssetName(base)
  if (!used.has(name)) return name
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** 名字（按落库后的规范化结果）是否与目标项目已有资产或同批次其他项重名 */
export function isNameTaken(name, taken) {
  const value = normalizeAssetName(name)
  if (!value) return false
  for (const item of taken || []) {
    if (String(item ?? '').trim() === value) return true
  }
  return false
}
