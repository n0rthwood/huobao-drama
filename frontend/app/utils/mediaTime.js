/**
 * 媒体时间显示规则（Issue #14 用户决策 #4）——纯函数，组件与单测共用。
 *
 * 输入统一是 unix 秒（后端所有媒体时间都按 unix 秒返回），一律按浏览器本地时区换算：
 *   < 1 分钟   → { kind: 'seconds', n }
 *   < 1 小时   → { kind: 'minutes', n }
 *   < 1 天     → { kind: 'hoursMinutes', h, m }（m 为 0 时 kind 为 'hours'）
 *   < 1 个日历月 → { kind: 'days', n }
 *   < 12 个日历月 → { kind: 'months', n }
 *   ≥ 12 个日历月 → { kind: 'absolute', text: 'YYYY-MM-DD HH:mm' }
 *
 * 「月」按日历月差计算（非 30 天近似），「年」= 满 12 个日历月。
 */

/** 满月数：日历月差，若当月日期/时刻还没走到就减 1（2/1 → 2/28 仍是 0 个月） */
export function calendarMonthsBetween(then, now) {
  let months = (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth())
  if (months <= 0) return months < 0 ? months : 0
  const anniversary = new Date(then)
  anniversary.setMonth(then.getMonth() + months)
  if (anniversary.getTime() > now.getTime()) months -= 1
  return months
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 绝对时间（浏览器本地时区）：YYYY-MM-DD HH:mm */
export function formatAbsoluteTime(seconds) {
  const d = new Date(Number(seconds) * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 完整本地时间（hover 提示用），含秒与时区偏好格式 */
export function formatFullTime(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString()
}

/**
 * unix 秒 + 当前时刻（毫秒）→ 显示分档。
 * 无效/空时间返回 null（调用方不渲染）；未来时间按「刚刚」处理（0 秒前）。
 */
export function mediaTimeParts(seconds, nowMs = Date.now()) {
  const at = Number(seconds)
  if (!Number.isFinite(at) || at <= 0) return null

  const then = new Date(at * 1000)
  const now = new Date(nowMs)
  const diff = Math.max(0, Math.floor(nowMs / 1000 - at))

  if (diff < 60) return { kind: 'seconds', n: diff }
  if (diff < 3600) return { kind: 'minutes', n: Math.floor(diff / 60) }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    return m === 0 ? { kind: 'hours', n: h } : { kind: 'hoursMinutes', h, m }
  }

  const months = calendarMonthsBetween(then, now)
  if (months >= 12) return { kind: 'absolute', text: formatAbsoluteTime(at) }
  if (months >= 1) return { kind: 'months', n: months }
  return { kind: 'days', n: Math.floor(diff / 86400) }
}

/**
 * 分档 → 可显示文本（i18n）。组件与纯文本场景（<option> 等不能放组件的地方）共用，
 * 保证「同一套规则」只有一份实现。
 */
export function mediaTimeLabel(seconds, t, nowMs = Date.now()) {
  const parts = mediaTimeParts(seconds, nowMs)
  if (!parts) return ''
  if (parts.kind === 'absolute') return parts.text
  if (parts.kind === 'hoursMinutes') return t('mediaTime.hoursMinutes', { h: parts.h, m: parts.m })
  return t(`mediaTime.${parts.kind}`, { n: parts.n })
}

/**
 * 分镜「当前媒体」（关键帧 / 视频）的生成时间：后端按路径反查 sys_task 后随分镜一起返回，
 * 反查不到的路径不在表里 → null（不显示时间）。
 */
export function mediaTimeOfPath(row, path) {
  if (!row || !path) return null
  const map = row.media_generated_at || row.mediaGeneratedAt
  return map?.[path] ?? null
}
