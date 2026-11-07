/**
 * 需要 API key 的权威资料源注册表（Issue #78）
 *
 * key 由用户在设置页「资料检索」填写，存 `app_settings.research_api_keys`（与 AI 服务密钥一样只在业务库，
 * 不进仓库）。这里只描述「是什么、去哪申请、怎么用一次最小查询验证 key」；新增来源只加一条注册。
 * 说明文案在前端 locale（`settings.research.sources.<id>`），后端不返回自然语言描述。
 */

export const RESEARCH_SOURCE_IDS = ['europeana', 'smithsonian'] as const
export type ResearchSourceId = typeof RESEARCH_SOURCE_IDS[number]

export interface ResearchSourceDef {
  id: ResearchSourceId
  name: string
  /** 申请 key 的页面 */
  applyUrl: string
  /** 连接测试用的最小查询 */
  testUrl: (key: string) => string
  /** 从测试响应里读出结果条数；返回 null 表示响应形状不符合预期 */
  readCount: (json: unknown) => number | null
  /** 从失败响应里读出服务方给的错误说明 */
  readError: (json: unknown) => string | null
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
}

export const RESEARCH_SOURCES: Record<ResearchSourceId, ResearchSourceDef> = {
  europeana: {
    id: 'europeana',
    name: 'Europeana',
    applyUrl: 'https://pro.europeana.eu/pages/get-api',
    testUrl: key => `https://api.europeana.eu/record/v2/search.json?wskey=${encodeURIComponent(key)}&query=map&rows=1&profile=minimal`,
    readCount: (json) => {
      const body = record(json)
      if (body?.success !== true) return null
      const total = Number(body.totalResults)
      return Number.isFinite(total) ? total : null
    },
    readError: json => {
      const body = record(json)
      return typeof body?.error === 'string' ? body.error : null
    },
  },
  smithsonian: {
    id: 'smithsonian',
    name: 'Smithsonian Open Access',
    applyUrl: 'https://api.data.gov/signup/',
    testUrl: key => `https://api.si.edu/openaccess/api/v1.0/search?q=bronze&rows=1&api_key=${encodeURIComponent(key)}`,
    readCount: (json) => {
      const response = record(record(json)?.response)
      const count = Number(response?.rowCount)
      return Number.isFinite(count) ? count : null
    },
    readError: json => {
      const error = record(record(json)?.error)
      if (!error) return null
      return [error.code, error.message].filter(v => typeof v === 'string' && v).join(': ') || null
    },
  },
}

export function isResearchSourceId(value: unknown): value is ResearchSourceId {
  return typeof value === 'string' && (RESEARCH_SOURCE_IDS as readonly string[]).includes(value)
}

const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{4,256}$/

/**
 * 规范化用户填写的 key：trim 后为空 → null（= 清除）；含空白、引号等非 key 字符或长度不在 4–256 → 抛错。
 * 不做任何截断或「帮你修正」：key 写错就该当场报出来。
 */
export function normalizeResearchKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('api_key 必须是字符串')
  const value = raw.trim()
  if (!value) return null
  if (!KEY_PATTERN.test(value)) throw new Error('api_key 只能是 4–256 位字母、数字或 ._~+/=- 字符')
  return value
}

/** 对外展示用：只给末 4 位；短于 12 位的 key（如 Europeana 的 8 位词形 key）不给任何字符，避免提示泄露半个 key */
export function researchKeyHint(key: string | null | undefined): string | null {
  if (!key) return null
  return key.length >= 12 ? key.slice(-4) : ''
}
