/**
 * 部署前缀工具（Caddy 子路径托管：164.joyai.dev/huobao）。
 *
 * 前缀在 nuxt.config 里定（默认 '/huobao/'），通过 runtimeConfig.public.basePath
 * 暴露给运行时。不要用 import.meta.env.BASE_URL：SPA 构建里它是相对值 './'，
 * 在深链页面（如 /huobao/drama/2）上拼出的 fetch 会解析到 /huobao/drama/api/...。
 * 只在组件/事件回调里调用（客户端单应用，useRuntimeConfig 随处可用）。
 */

/** 站点根前缀，带尾斜杠，例如 '/' 或 '/huobao/'（apiBase/mediaUrl 都建立在它之上） */
export function appBase(): string {
  const base = useRuntimeConfig().public.basePath || '/'
  return base.endsWith('/') ? base : base + '/'
}

/** 后端 API 前缀，无尾斜杠，例如 '/api/v1' 或 '/huobao/api/v1' */
export function apiBase(): string {
  return appBase().replace(/\/+$/, '') + '/api/v1'
}

/**
 * 媒体地址前缀：后端返回 '/static/...' 或 'static/...'（相对站点根），
 * 子路径部署时要变成 '/huobao/static/...'。外部 URL / data: / blob: 原样返回。
 */
export function mediaUrl(url: string | null | undefined): string {
  const value = String(url || '')
  if (!value) return ''
  if (/^(https?:|data:|blob:)/i.test(value)) return value
  return appBase().replace(/\/+$/, '') + (value.startsWith('/') ? value : '/' + value)
}
