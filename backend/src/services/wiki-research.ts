/**
 * 维基系检索客户端（Issue #32）— 火宝自己的联网能力
 *
 * 只访问 config/research.ts 白名单内的维基百科 / Wikimedia Commons，
 * 全进程串行 + 最小间隔 + 指数退避（Wikimedia 调用纪律），
 * 失败抛 ResearchUnavailableError，由调用方降级为「只用剧本原文」。
 *
 * 返回体一律带 source_url 与 retrieved_at：UI 的「资料来源」列表与
 * research_citations 都依赖这两个字段，Agent 不得把它们写进任何资产字段。
 */
import { z } from 'zod'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  RESEARCH_MAX_RESULTS,
  RESEARCH_MAX_RETRIES,
  RESEARCH_MAX_TEXT_CHARS,
  RESEARCH_MIN_INTERVAL_MS,
  RESEARCH_REQUEST_TIMEOUT_MS,
  RESEARCH_RETRY_BASE_MS,
  RESEARCH_USER_AGENT,
  WIKI_DEFAULT_LANG,
  WIKI_LANGS,
  isAllowedResearchHost,
  type WikiLang,
} from '../config/research.js'
import { logTaskWarn } from '../utils/task-logger.js'

export class ResearchUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResearchUnavailableError'
  }
}

export function normalizeWikiLang(lang: string | null | undefined): WikiLang {
  const v = (lang || '').toLowerCase()
  return (WIKI_LANGS as readonly string[]).includes(v) ? (v as WikiLang) : WIKI_DEFAULT_LANG
}

/** 全进程串行队列：Wikimedia 对高频并发调用有封禁策略，这里保证「一次一个 + 最小间隔」 */
let queueTail: Promise<unknown> = Promise.resolve()
let lastCallAt = 0

async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = RESEARCH_MIN_INTERVAL_MS - (Date.now() - lastCallAt)
    if (wait > 0) await sleep(wait)
    try {
      return await fn()
    } finally {
      lastCallAt = Date.now()
    }
  })
  // 队列尾只用于排队，不传播失败
  queueTail = run.catch(() => undefined)
  return run
}

/** 白名单校验 + UA + 超时的单次 GET（JSON）；失败按指数退避重试，耗尽抛 ResearchUnavailableError */
async function fetchJson<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
  if (url.protocol !== 'https:' || !isAllowedResearchHost(url.hostname)) {
    throw new ResearchUnavailableError(`检索域名不在白名单内：${url.hostname}`)
  }
  let lastError = ''
  for (let attempt = 0; attempt <= RESEARCH_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RESEARCH_RETRY_BASE_MS * 2 ** (attempt - 1))
    try {
      const json = await enqueue(async () => {
        const res = await fetch(url, {
          headers: { 'User-Agent': RESEARCH_USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(RESEARCH_REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as unknown
      })
      const parsed = schema.safeParse(json)
      if (!parsed.success) throw new Error('响应结构无法解析')
      return parsed.data
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      logTaskWarn('Research', 'fetch-retry', { host: url.hostname, attempt, error: lastError })
    }
  }
  throw new ResearchUnavailableError(`维基系检索不可用（${lastError}）`)
}

export interface WikiSearchHit {
  title: string
  snippet: string
  source_url: string
}

export interface WikiArticle {
  title: string
  text: string
  source_url: string
  lang: WikiLang
  retrieved_at: string
}

/** HTML 片段 → 纯文本（搜索结果的 snippet 带 <span class="searchmatch">） */
function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function articleUrl(lang: WikiLang, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

const searchSchema = z.object({
  query: z.object({
    search: z.array(z.object({ title: z.string(), snippet: z.string().optional() })).default([]),
  }).optional(),
})

/** 条目检索：返回候选标题 + 片段 + 条目链接 */
export async function wikiSearch(query: string, lang: WikiLang, limit = RESEARCH_MAX_RESULTS): Promise<WikiSearchHit[]> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
  url.search = new URLSearchParams({
    action: 'query', list: 'search', srsearch: query, srlimit: String(Math.min(limit, RESEARCH_MAX_RESULTS)),
    format: 'json', formatversion: '2', utf8: '1',
  }).toString()
  const data = await fetchJson(url, searchSchema)
  return (data.query?.search || []).map(hit => ({
    title: hit.title,
    snippet: stripHtml(hit.snippet || ''),
    source_url: articleUrl(lang, hit.title),
  }))
}

const summarySchema = z.object({
  title: z.string().optional(),
  extract: z.string().optional(),
  content_urls: z.object({ desktop: z.object({ page: z.string().optional() }).optional() }).optional(),
})

/** 条目摘要（REST summary，首段） */
export async function wikiSummary(title: string, lang: WikiLang): Promise<WikiArticle> {
  const url = new URL(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`)
  const data = await fetchJson(url, summarySchema)
  const text = data.extract || ''
  if (!text) throw new ResearchUnavailableError(`条目「${title}」没有可用摘要`)
  return {
    title: data.title || title,
    text: text.slice(0, RESEARCH_MAX_TEXT_CHARS),
    source_url: data.content_urls?.desktop?.page || articleUrl(lang, title),
    lang,
    retrieved_at: new Date().toISOString(),
  }
}

/** 从纯文本正文里截取某个小节（标题行形如 `== 生平 ==`）；找不到返回全文 */
function sliceSection(plain: string, section: string): string {
  const lines = plain.split('\n')
  const needle = section.trim().toLowerCase()
  const start = lines.findIndex(line => /^=+\s*.+?\s*=+$/.test(line)
    && line.replace(/=/g, '').trim().toLowerCase().includes(needle))
  if (start < 0) return plain
  const level = (lines[start].match(/^=+/) || ['=='])[0].length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => {
    const match = line.match(/^(=+)\s*.+?\s*=+$/)
    return !!match && match[1].length <= level
  })
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n')
}

const extractSchema = z.object({
  query: z.object({
    pages: z.array(z.object({ title: z.string().optional(), extract: z.string().optional() })).default([]),
  }).optional(),
})

/** 条目正文（纯文本）；传 section 时只返回该小节 */
export async function wikiExtract(title: string, lang: WikiLang, section?: string): Promise<WikiArticle> {
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`)
  url.search = new URLSearchParams({
    action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki',
    titles: title, redirects: '1', format: 'json', formatversion: '2',
  }).toString()
  const data = await fetchJson(url, extractSchema)
  const page = data.query?.pages?.[0]
  const plain = page?.extract || ''
  if (!plain) throw new ResearchUnavailableError(`条目「${title}」没有可用正文`)
  const body = section ? sliceSection(plain, section) : plain
  return {
    title: page?.title || title,
    text: body.slice(0, RESEARCH_MAX_TEXT_CHARS),
    source_url: articleUrl(lang, page?.title || title),
    lang,
    retrieved_at: new Date().toISOString(),
  }
}

export interface CommonsFile {
  file_title: string
  thumb_url: string
  file_url: string
  source_page_url: string
  artist: string
  work_date: string
  license: string
  license_url: string
  mime: string
  width: number
  height: number
}

const metaValue = z.object({ value: z.union([z.string(), z.number()]).optional() })
const imageInfoSchema = z.object({
  url: z.string().optional(),
  thumburl: z.string().optional(),
  descriptionurl: z.string().optional(),
  mime: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  extmetadata: z.record(z.string(), metaValue).optional(),
})
const commonsPageSchema = z.object({
  title: z.string().optional(),
  imageinfo: z.array(imageInfoSchema).optional(),
})
const commonsQuerySchema = z.object({
  query: z.object({ pages: z.array(commonsPageSchema).default([]) }).optional(),
})

type ImageInfo = z.infer<typeof imageInfoSchema>
type CommonsPage = z.infer<typeof commonsPageSchema>

/** extmetadata 的值是 { value: '<html>' } 形态 */
function metaText(meta: ImageInfo['extmetadata'], key: string): string {
  return stripHtml(String(meta?.[key]?.value ?? ''))
}

function metaRawUrl(meta: ImageInfo['extmetadata'], key: string): string {
  const raw = String(meta?.[key]?.value ?? '')
  const href = raw.match(/href="([^"]+)"/)
  return href ? href[1] : stripHtml(raw)
}

function toCommonsFile(page: CommonsPage | undefined): CommonsFile | null {
  const info = page?.imageinfo?.[0]
  if (!info) return null
  const meta = info.extmetadata
  return {
    file_title: page?.title || '',
    thumb_url: info.thumburl || info.url || '',
    file_url: info.url || '',
    source_page_url: info.descriptionurl || '',
    artist: metaText(meta, 'Artist'),
    // Commons 的日期字段常带 Wikidata 限定符（`1690sdate QS:P,+1690-00-00T00:00:00Z/8`），只留人读的部分
    work_date: (metaText(meta, 'DateTimeOriginal') || metaText(meta, 'DateTime')).split(/date QS:/)[0].trim(),
    license: metaText(meta, 'LicenseShortName') || metaText(meta, 'License'),
    license_url: metaRawUrl(meta, 'LicenseUrl'),
    mime: info.mime || '',
    width: info.width || 0,
    height: info.height || 0,
  }
}

/** Commons 文件检索（namespace 6），返回缩略图与许可证元数据 */
export async function commonsSearch(query: string, limit = RESEARCH_MAX_RESULTS): Promise<CommonsFile[]> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.search = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6',
    gsrlimit: String(Math.min(limit, RESEARCH_MAX_RESULTS)),
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '480',
    format: 'json', formatversion: '2',
  }).toString()
  const data = await fetchJson(url, commonsQuerySchema)
  return (data.query?.pages || [])
    .map(toCommonsFile)
    .filter((f): f is CommonsFile => !!f && f.mime.startsWith('image/'))
}

/** 按文件标题取 Commons 单文件的原图地址与许可证元数据（只接受 File: 标题，不接受任意 URL） */
export async function commonsFileInfo(fileTitle: string): Promise<CommonsFile> {
  const title = fileTitle.trim()
  if (!/^(file|image):/i.test(title)) throw new ResearchUnavailableError('只接受 Commons 的 File: 文件标题')
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.search = new URLSearchParams({
    action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '960',
    format: 'json', formatversion: '2',
  }).toString()
  const data = await fetchJson(url, commonsQuerySchema)
  const file = toCommonsFile(data.query?.pages?.[0])
  if (!file?.file_url) throw new ResearchUnavailableError(`Commons 文件不存在：${title}`)
  return file
}

/** Commons 原图托管域（与 api.php 不同域，单独白名单） */
const COMMONS_UPLOAD_HOST = 'upload.wikimedia.org'

/** 下载 Commons 原图（白名单 + UA + 超时）；返回字节与 content-type */
export async function fetchCommonsBytes(fileUrl: string): Promise<{ bytes: Buffer; mime: string }> {
  const url = new URL(fileUrl)
  const allowed = url.protocol === 'https:'
    && (url.hostname === COMMONS_UPLOAD_HOST || isAllowedResearchHost(url.hostname))
  if (!allowed) throw new ResearchUnavailableError(`图片域名不在白名单内：${url.hostname}`)
  return enqueue(async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': RESEARCH_USER_AGENT },
      signal: AbortSignal.timeout(RESEARCH_REQUEST_TIMEOUT_MS * 3),
    })
    if (!res.ok) throw new ResearchUnavailableError(`图片下载失败：HTTP ${res.status}`)
    const mime = res.headers.get('content-type') || 'image/jpeg'
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: mime.split(';')[0].trim() }
  })
}
