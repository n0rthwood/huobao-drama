import type { Context } from 'hono'

export function success(c: Context, data: any = null) {
  return c.json({ code: 200, data, message: 'success' })
}

export function created(c: Context, data: any = null) {
  return c.json({ code: 201, data, message: 'created' }, 201)
}

/**
 * 400 响应。`extra` 用于带上机器可读的错误码（如 #58 的 `code:'slot_locked'`、
 * `code:'missing_base'`、组合切换的 `same_combo`），前端据此分支而不是匹配中文。
 */
export function badRequest(c: Context, message = '请求参数错误', extra: Record<string, unknown> = {}) {
  return c.json({ code: 400, message, ...extra }, 400)
}

export function notFound(c: Context, message = '资源不存在') {
  return c.json({ code: 404, message }, 404)
}

export function serverError(c: Context, message = '服务器内部错误') {
  return c.json({ code: 500, message }, 500)
}

export function now() {
  return new Date().toISOString()
}
