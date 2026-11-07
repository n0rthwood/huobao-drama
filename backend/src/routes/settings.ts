/**
 * 应用设置路由 — 全局配置的读写入口（AI 内容语言、引导漫游、资料检索 API key）
 */
import { Hono } from 'hono'
import {
  getContentLanguage, setContentLanguage, getToursSeen, setToursSeen, getResearchApiKey, setResearchApiKey,
  CONTENT_LANGUAGES, type ContentLanguage,
} from '../services/app-settings.js'
import {
  RESEARCH_SOURCE_IDS, RESEARCH_SOURCES, isResearchSourceId, normalizeResearchKey, researchKeyHint,
  type ResearchSourceId,
} from '../config/research-sources.js'
import { success, badRequest } from '../utils/response.js'

const RESEARCH_TEST_TIMEOUT_MS = 15_000

function researchSourceView(id: ResearchSourceId) {
  const def = RESEARCH_SOURCES[id]
  const key = getResearchApiKey(id)
  // 完整 key 永不出现在响应里：只给是否已配置 + 末 4 位
  return { id, name: def.name, apply_url: def.applyUrl, configured: !!key, key_hint: researchKeyHint(key) }
}

const app = new Hono()

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 设置 AI 内容语言（body: { language: 'zh'|'en'|'ja'|'ko' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

// GET /research-sources — 需要 API key 的资料源及配置状态（Issue #78）；永不返回完整 key
app.get('/research-sources', (c) => success(c, { sources: RESEARCH_SOURCE_IDS.map(researchSourceView) }))

// PUT /research-sources/:id — 保存（body: { api_key }）或清除（api_key 为 null/空串）
app.put('/research-sources/:id', async (c) => {
  const id = c.req.param('id')
  if (!isResearchSourceId(id)) return badRequest(c, `未知资料源：${id}`)
  const body = await c.req.json().catch(() => null)
  let key: string | null
  try {
    key = normalizeResearchKey(body?.api_key)
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : 'api_key 不合法')
  }
  setResearchApiKey(id, key)
  return success(c, researchSourceView(id))
})

// POST /research-sources/:id/test — 用一次最小查询验证 key（body.api_key 可选：测试尚未保存的 key，不落库）
app.post('/research-sources/:id/test', async (c) => {
  const id = c.req.param('id')
  if (!isResearchSourceId(id)) return badRequest(c, `未知资料源：${id}`)
  const body = await c.req.json().catch(() => null)
  let key: string | null
  try {
    key = normalizeResearchKey(body?.api_key) ?? getResearchApiKey(id)
  } catch (err) {
    return badRequest(c, err instanceof Error ? err.message : 'api_key 不合法')
  }
  if (!key) return success(c, { ok: false, status: null, count: null, message: '尚未配置 API key' })

  const def = RESEARCH_SOURCES[id]
  // key 只在 URL query 里：任何返回给前端的文字都先把它抹掉
  const scrub = (text: string) => text.split(key).join('***')
  try {
    const resp = await fetch(def.testUrl(key), { signal: AbortSignal.timeout(RESEARCH_TEST_TIMEOUT_MS) })
    const json: unknown = await resp.json().catch(() => null)
    const count = resp.ok ? def.readCount(json) : null
    if (count !== null) return success(c, { ok: true, status: resp.status, count, message: null })
    const reason = def.readError(json) ?? `HTTP ${resp.status}，响应不是预期的检索结果`
    return success(c, { ok: false, status: resp.status, count: null, message: scrub(reason) })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const reason = timedOut
      ? `连接超时（${RESEARCH_TEST_TIMEOUT_MS / 1000} 秒）`
      : `网络错误：${err instanceof Error ? err.message : String(err)}`
    return success(c, { ok: false, status: null, count: null, message: scrub(reason) })
  }
})

export default app
