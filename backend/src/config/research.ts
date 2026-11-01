/**
 * 联网检索配置（Issue #32）— 随版本库发布的常量，不含任何密钥。
 *
 * 白名单只有维基系两类域名：维基百科各语言站与 Wikimedia Commons。
 * 部署环境需能访问这两类域名；不可达时检索工具按降级规则工作
 * （返回 degraded 标记 + 记一条「未检索」的 research_citations，提取不失败）。
 *
 * Wikimedia 调用纪律：必须带可识别的自定义 User-Agent（无标识 UA 有被封禁策略），
 * 串行调用 + 最小间隔，失败指数退避；退避耗尽即降级。
 */

/** 允许访问的主机白名单：精确域名 + 维基百科的语言子域后缀 */
export const WIKI_HOST_SUFFIXES = ['.wikipedia.org'] as const
export const WIKI_HOSTS_EXACT = ['commons.wikimedia.org', 'wikipedia.org'] as const

/** Wikimedia 要求可识别的 UA（项目名 + 联系方式） */
export const RESEARCH_USER_AGENT =
  'huobao-drama/1.0 (https://github.com/n0rthwood/huobao-drama; documentary asset research)'

/** 单次 HTTP 请求超时（毫秒） */
export const RESEARCH_REQUEST_TIMEOUT_MS = 12_000
/** 串行调用的最小间隔（毫秒）— 全进程共享一条队列 */
export const RESEARCH_MIN_INTERVAL_MS = 1_100
/** 单次请求的重试次数（指数退避：1s / 2s）；耗尽即降级 */
export const RESEARCH_MAX_RETRIES = 2
export const RESEARCH_RETRY_BASE_MS = 1_000
/**
 * 单次 Agent 运行内允许的检索调用次数上限。
 * 第 2 轮实测（docs/qa/issue-32/round-2-notes.md）：一集 14 个角色用掉 21 次调用、
 * 整次运行 17 万 tokens / 6.4 分钟，其中大量是「同一人物先 search 再 summary」。
 * 规则改为「每个关键人物最多 search 1 次 + summary 1 次」（写在工具描述里），
 * 14 次足够覆盖一集的关键历史人物，用尽即降级为「只用剧本原文」。
 */
export const RESEARCH_MAX_CALLS_PER_RUN = 14
/** 检索结果条数上限（返回给 Agent 的候选条目；越多模型越容易反复比较） */
export const RESEARCH_MAX_RESULTS = 5
/** 摘要/正文截断长度（字符）— 防止把整篇条目灌进上下文 */
export const RESEARCH_MAX_TEXT_CHARS = 2_500

/** 维基百科语言子域白名单（内容语言 + 俄/德/法等史料常用语种） */
export const WIKI_LANGS = ['zh', 'en', 'ja', 'ko', 'ru', 'de', 'fr'] as const
export type WikiLang = typeof WIKI_LANGS[number]
export const WIKI_DEFAULT_LANG: WikiLang = 'zh'

/** 主机是否在白名单内（禁止任意 URL，防 SSRF） */
export function isAllowedResearchHost(host: string): boolean {
  const h = host.toLowerCase()
  if ((WIKI_HOSTS_EXACT as readonly string[]).includes(h)) return true
  return WIKI_HOST_SUFFIXES.some(suffix => h.endsWith(suffix))
}
