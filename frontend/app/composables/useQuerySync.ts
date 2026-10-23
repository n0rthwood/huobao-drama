/**
 * 视图子状态 ↔ URL query 同步（deeplink 支持）
 * - 读取：queryEnum / queryTypedId 做白名单校验，非法/缺失返回 null，由调用方回退默认值
 * - 写入：replaceQuery 以 router.replace 全量覆盖当前 query——子状态（面板/页签/弹窗）
 *   是瞬时视图状态，push 会在历史栈里堆积导致返回键困在视图内部，replace 保证
 *   返回键始终 = 退出当前视图回到上一页；代价是 Back/Forward 不逐态回放（有意为之）
 * - URL 显式携带子状态时优先于 localStorage 记忆（由各视图在初始化时处理）
 */

/** query 单值：数组取首个，trim 后空串视为缺失 */
export function querySingle(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v
  const str = typeof s === 'string' ? s.trim() : ''
  return str || null
}

/** query 枚举值：不在白名单内返回 null（调用方静默回退默认值） */
export function queryEnum(v: unknown, allowed: readonly string[]): string | null {
  const s = querySingle(v)
  return s && allowed.includes(s) ? s : null
}

/** query 形如 character-3 的「类型-id」（资产详情弹窗）；格式非法返回 null */
export function queryTypedId(v: unknown, allowedTypes: readonly string[]): { type: string, id: number } | null {
  const s = querySingle(v)
  if (!s) return null
  const m = new RegExp(`^(${allowedTypes.join('|')})-(\\d+)$`).exec(s)
  return m ? { type: m[1], id: Number(m[2]) } : null
}

/** 子状态同步到 URL 的统一入口（须在 setup 期间调用取得实例） */
export function useQuerySync() {
  const route = useRoute()
  const router = useRouter()

  /** 以 replace 全量覆盖 query：传入对象即目标全集（省略的键会被移除）；无变化时跳过 */
  function replaceQuery(query: Record<string, string>) {
    const cur = route.query
    const keys = Object.keys(query)
    if (keys.length === Object.keys(cur).length && keys.every(k => cur[k] === query[k])) return
    router.replace({ query })
  }

  return { route, router, replaceQuery }
}
