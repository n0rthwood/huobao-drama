import { GateBlockedError } from '../services/workflow-gates.js'
import { TtsRequiredError } from '../services/narration-tts-gate.js'
import { SkeletonNotConfirmedError } from '../services/narration-skeleton.js'
import type { MiddlewareHandler } from 'hono'

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

function statusColor(status: number): string {
  if (status >= 500) return colors.red
  if (status >= 400) return colors.yellow
  if (status >= 300) return colors.cyan
  return colors.green
}

function formatTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 全局日志中间件 — 打印请求方法/路径/状态/耗时/请求体
 */
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const method = c.req.method
  const path = c.req.path
  const start = performance.now()

  // 打印请求
  const time = formatTime()
  let bodyInfo = ''
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    try {
      const clone = c.req.raw.clone()
      const text = await clone.text()
      if (text) {
        // 密钥字段一律打码：设置页提交的 api_key（AI 服务、资料检索 #78）不能落进 pm2 日志
        const redacted = text.replace(/("(?:api_key|apiKey|wskey|password|token|secret)"\s*:\s*)"[^"]*"/g, '$1"***"')
        const truncated = redacted.length > 500 ? redacted.slice(0, 500) + '...' : redacted
        bodyInfo = `\n  ${colors.dim}body: ${truncated}${colors.reset}`
      }
    } catch {}
  }

  console.log(`${colors.dim}${time}${colors.reset} ${colors.cyan}${method}${colors.reset} ${path}${bodyInfo}`)

  await next()

  const ms = (performance.now() - start).toFixed(0)
  const status = c.res.status
  const sc = statusColor(status)
  console.log(`${colors.dim}${time}${colors.reset} ${colors.cyan}${method}${colors.reset} ${path} ${sc}${status}${colors.reset} ${colors.dim}${ms}ms${colors.reset}`)
}

/**
 * 全局错误处理 — 捕获未处理异常，打印完整堆栈。
 * 门禁拦截（#54）不是异常情况：原样抛给 `src/index.ts` 的 app.onError 统一转 400 {error, gate, reason}。
 */
export const errorHandler: MiddlewareHandler = async (c, next) => {
  try {
    await next()
  } catch (err: any) {
    if (err instanceof GateBlockedError || err instanceof TtsRequiredError || err instanceof SkeletonNotConfirmedError) throw err
    const status = err.status || 500
    console.error(`${colors.red}[ERROR]${colors.reset} ${c.req.method} ${c.req.path}`)
    console.error(err.stack || err.message || err)
    return c.json({ code: status, message: err.message || 'Internal Server Error' }, status)
  }
}
