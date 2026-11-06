const MAX_DIAGNOSTIC_CHARS = 8192

function sanitize(raw) {
  return String(raw ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

/** Present provider facts, never invent a moderation category or a blocked passage. */
export function taskErrorPresentation(raw, t) {
  const rawText = String(raw instanceof Error ? raw.message : raw ?? '')
  const text = sanitize(rawText)
  const diagnostic = text.length > MAX_DIAGNOSTIC_CHARS
    ? text.slice(0, MAX_DIAGNOSTIC_CHARS - 1) + '…'
    : text
  const status = /(?:文本服务|HTTP)\s*(\d{3})\s*[:：]/i.exec(text)?.[1]
  const start = rawText.indexOf('{')
  let payload = null
  if (start >= 0 && rawText.length <= MAX_DIAGNOSTIC_CHARS) {
    try { payload = JSON.parse(rawText.slice(start)) } catch { /* Keep an unparseable body in bounded diagnostics. */ }
  }
  const providerError = payload?.error
  const code = providerError && typeof providerError === 'object' ? String(providerError.code ?? '') : ''
  const filter = Array.isArray(payload?.contentFilter) ? payload.contentFilter : []
  let message
  if (code === '1301') {
    const roles = new Set(filter.map(item => item?.role).filter(Boolean))
    const key = roles.size === 1 && roles.has('assistant') ? 'outputBlocked'
      : roles.size === 1 && roles.has('user') ? 'inputBlocked' : 'contentBlocked'
    const facts = [status ? `HTTP ${status}` : '', `1301`, ...filter.map(item =>
      [typeof item?.role === 'string' ? item.role : '', Number.isFinite(item?.level) ? `level ${item.level}` : ''].filter(Boolean).join(' / '),
    )].filter(Boolean).join(' · ')
    message = `${t(`taskCenter.errorPresentation.${key}`)}\n${facts}\n${t('taskCenter.errorPresentation.noPassage')}`
  } else if (providerError && typeof providerError.message === 'string') {
    message = [status ? `HTTP ${status}` : '', code, sanitize(providerError.message)].filter(Boolean).join(' · ')
  } else if (start >= 0 || /<\s*(?:!doctype|html|body)\b/i.test(text)) {
    message = t('taskCenter.errorPresentation.serviceError', { status: status ? `HTTP ${status}` : '' })
  } else {
    message = diagnostic
  }
  message = sanitize(message)
  // Bound provider messages as well as the expandable/copyable diagnostics.
  if (message.length > MAX_DIAGNOSTIC_CHARS) message = message.slice(0, MAX_DIAGNOSTIC_CHARS - 1) + '…'
  return { message, diagnostic, hasDetails: message !== diagnostic }
}
