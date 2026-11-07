/**
 * 文本模型「服务侧错误」的分类（Issue #77）。
 *
 * 只有这类错误才计入端点健康、触发暂停与换模型重试；
 * JSON 解析、schema 校验、业务校验、内容审核拒绝都不算（换模型也救不回来）。
 * 单独成文件是为了避免 `text-task.ts` 与 `text-scheduler.ts` 互相 import 形成环。
 */
export function isModelError(err: unknown): boolean {
  // 历史调用点只把错误文本写进 finishTextTask，保留字符串兜底分类
  if (typeof err === 'string') {
    if (/content[_ -]?(filter|policy|moderation)|safety[_ -]?(filter|policy)|内容审核|内容安全/i.test(err)) return false
    if (/文本服务\s*(401|403|429|5\d\d)|HTTP\s*(401|403|429|5\d\d)/i.test(err)) return true
    return /\b(fetch failed|network error|socket hang up|timed?\s*out|timeout)\b/i.test(err)
  }
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string; status?: number; statusCode?: number; code?: string; cause?: unknown }
  if (/content[_ -]?(filter|policy|moderation)|safety[_ -]?(filter|policy)|内容审核|内容安全/i.test(`${e.code ?? ''} ${e.message ?? ''}`)) return false
  const status = e.status ?? e.statusCode
  if (typeof status === 'number') return status === 401 || status === 403 || status === 429 || status >= 500 && status <= 599
  if (e.name === 'TimeoutError') return true
  if (e.name === 'AbortError' || e.name === 'SyntaxError') return false
  if (e.code && /^(ECONN|ENET|EHOST|ETIMEDOUT|EPIPE|UND_ERR_)/.test(e.code)) return true
  if (/\b(fetch failed|network error|socket hang up|timed?\s*out|timeout)\b/i.test(e.message || '')) return true
  return e.cause != null && e.cause !== err ? isModelError(e.cause) : false
}
