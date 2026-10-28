/**
 * 剪贴板写入（Issue #19）：优先 navigator.clipboard（需安全上下文），
 * 非安全上下文（http 内网访问）降级为隐藏 textarea + execCommand。
 * 返回是否成功，由调用方负责 toast。
 */
export async function copyToClipboard(text) {
  if (!text) return false
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 走降级 */ }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
