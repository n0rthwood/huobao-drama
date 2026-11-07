/**
 * 资产资料检索的来源适配器（Issue #79）
 *
 * 每个来源一个适配器，统一返回 `ResearchHit`。来源分级：A = 博物馆/档案馆/图书馆/政府/高校/学术；
 * B = 维基系（线索与公有领域图源，事实需交叉核对）；自媒体/营销网文命中拒绝名单直接丢弃。
 *
 * 实验结论（huobao-asset-lab/lab2）固化在这里：
 * - Commons 关键词搜索必须带 `filetype:bitmap`，否则大量命中书籍 PDF 封面；
 * - Commons 分类浏览比关键词准；中文器物名检索能命中国内机构上传的实物与印迹；
 * - 单来源失败不影响整次检索。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { getResearchApiKey } from '../app-settings.js'

export const RESEARCH_ADAPTERS = [
  'wikipedia-zh', 'wikipedia-en', 'wikisource-zh', 'commons', 'commons-category',
  'europeana', 'smithsonian', 'met', 'cleveland', 'loc', 'internet-archive', 'uk-national-archives', 'openalex',
] as const
export type ResearchAdapter = typeof RESEARCH_ADAPTERS[number]

export interface ResearchHit {
  adapter: ResearchAdapter
  title: string
  /** 来源落地页（出处） */
  url: string | null
  /** 可下载的图像地址（文字类来源为 null） */
  image: string | null
  license: string
  institution: string
  date: string
  snippet: string
  tier: 'A' | 'B'
}

const UA = 'huobao-drama-asset-research/1.0 (documentary asset research)'
const TIMEOUT_MS = 20_000

const REJECT_HOSTS = [
  'zhihu.com', 'baijiahao.baidu.com', 'baike.baidu.com', 'sohu.com', 'toutiao.com', '163.com', 'qq.com',
  'bilibili.com', 'douyin.com', 'kuaishou.com', 'csdn.net', 'jianshu.com', '360doc.com', 'doc88.com', 'docin.com',
  'sina.com.cn', 'ifeng.com', 'xiaohongshu.com', 'pinterest.com', 'quora.com', 'reddit.com', 'medium.com',
  'facebook.com', 'twitter.com', 'x.com', 'youtube.com',
]

function hostOf(url: string | null | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : '' } catch { return '' }
}

export function isRejectedHost(url: string | null | undefined): boolean {
  const host = hostOf(url)
  return !!host && REJECT_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
}

async function getJson(url: string, init: { headers?: Record<string, string> } = {}): Promise<unknown> {
  let last = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.status === 429) {
        last = 'HTTP 429 限流'
        await sleep((Number(res.headers.get('retry-after')) || 4 * (attempt + 1)) * 1000)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
      // 国际出口偶发连接重置：退避重试
      await sleep(1500 * (attempt + 1))
    }
  }
  throw new Error(`${hostOf(url)} 请求失败：${last}`)
}

function q(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
  return url.toString()
}

const strip = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&#8203;|\u200b/g, '').trim()
type Json = Record<string, any> // 外部 API 的松散 JSON；字段按需取，取不到给空值

// ── 维基系（B）──────────────────────────────────────────────────────
async function wikipedia(lang: 'zh' | 'en', query: string): Promise<ResearchHit[]> {
  const data = await getJson(q(`https://${lang}.wikipedia.org/w/api.php`, { action: 'query', list: 'search', srsearch: query, srlimit: 5, format: 'json' })) as Json
  return (data.query?.search ?? []).map((hit: Json): ResearchHit => ({
    adapter: lang === 'zh' ? 'wikipedia-zh' : 'wikipedia-en', title: hit.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`, image: null,
    license: 'CC BY-SA 4.0（正文）', institution: 'Wikipedia', date: '', snippet: strip(hit.snippet), tier: 'B',
  }))
}

async function wikisource(query: string): Promise<ResearchHit[]> {
  const data = await getJson(q('https://zh.wikisource.org/w/api.php', { action: 'query', list: 'search', srsearch: query, srlimit: 5, format: 'json' })) as Json
  return (data.query?.search ?? []).map((hit: Json): ResearchHit => ({
    adapter: 'wikisource-zh', title: hit.title, url: `https://zh.wikisource.org/wiki/${encodeURIComponent(hit.title)}`, image: null,
    license: '公有领域原文（维基文库）', institution: 'Wikisource', date: '', snippet: strip(hit.snippet), tier: 'B',
  }))
}

async function commonsImages(params: Record<string, string | number>, adapter: ResearchAdapter): Promise<ResearchHit[]> {
  const data = await getJson(q('https://commons.wikimedia.org/w/api.php', {
    action: 'query', ...params, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: 1600, format: 'json',
  })) as Json
  const pages: Json[] = Object.values(data.query?.pages ?? {})
  return pages.flatMap((page): ResearchHit[] => {
    const info: Json = page.imageinfo?.[0] ?? {}
    if (!String(info.mime ?? '').startsWith('image/')) return []
    const meta: Json = info.extmetadata ?? {}
    const val = (k: string) => strip(meta[k]?.value)
    return [{
      adapter, title: page.title, url: info.descriptionurl ?? null, image: info.thumburl || info.url || null,
      license: val('LicenseShortName') || val('UsageTerms'), institution: (val('Credit') || val('Artist')).slice(0, 200),
      date: val('DateTimeOriginal').split(/date QS:/)[0].trim(), snippet: val('ImageDescription').slice(0, 400), tier: 'B',
    }]
  })
}

/** 正文摘录：维基百科 / 维基文库；供事实表引用 */
export async function fetchText(hit: ResearchHit, maxChars = 6000): Promise<string> {
  if (hit.adapter === 'wikipedia-zh' || hit.adapter === 'wikipedia-en') {
    const lang = hit.adapter.endsWith('zh') ? 'zh' : 'en'
    const data = await getJson(q(`https://${lang}.wikipedia.org/w/api.php`, {
      action: 'query', prop: 'extracts', explaintext: 1, titles: hit.title, redirects: 1, format: 'json',
      variant: lang === 'zh' ? 'zh-hans' : undefined,
    })) as Json
    const page: Json = Object.values(data.query?.pages ?? {})[0] ?? {}
    return String(page.extract ?? '').slice(0, maxChars)
  }
  if (hit.adapter === 'wikisource-zh') {
    const data = await getJson(q('https://zh.wikisource.org/w/api.php', { action: 'parse', page: hit.title, prop: 'text', redirects: 1, format: 'json' })) as Json
    const html = String(data.parse?.text?.['*'] ?? '').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
    return strip(html).replace(/\n{3,}/g, '\n\n').slice(0, maxChars)
  }
  return ''
}

// ── 博物馆 / 档案馆 / 图书馆 / 学术（A）──────────────────────────────
async function europeana(query: string): Promise<ResearchHit[]> {
  const key = getResearchApiKey('europeana')
  if (!key) throw new Error('未配置 Europeana API key（设置 → 资料检索）')
  const data = await getJson(q('https://api.europeana.eu/record/v2/search.json', { wskey: key, query, rows: 8, media: 'true', qf: 'TYPE:IMAGE', profile: 'rich' })) as Json
  return (data.items ?? []).map((it: Json): ResearchHit => ({
    adapter: 'europeana', title: it.title?.[0] ?? '', url: it.guid ?? null, image: it.edmIsShownBy?.[0] ?? it.edmPreview?.[0] ?? null,
    license: it.rights?.[0] ?? '', institution: it.dataProvider?.[0] ?? '', date: String(it.year?.[0] ?? ''),
    snippet: String(it.dcDescription?.[0] ?? '').slice(0, 400), tier: 'A',
  }))
}

async function smithsonian(query: string): Promise<ResearchHit[]> {
  const key = getResearchApiKey('smithsonian')
  if (!key) throw new Error('未配置 Smithsonian API key（设置 → 资料检索）')
  const data = await getJson(q('https://api.si.edu/openaccess/api/v1.0/search', { q: `${query} AND online_media_type:Images`, rows: 8, api_key: key })) as Json
  return (data.response?.rows ?? []).map((row: Json): ResearchHit => {
    const dnr: Json = row.content?.descriptiveNonRepeating ?? {}
    const media: Json = dnr.online_media?.media?.[0] ?? {}
    return {
      adapter: 'smithsonian', title: row.title ?? '', url: dnr.record_link ?? null, image: media.content ?? null,
      license: media.usage?.access ?? '', institution: dnr.data_source ?? 'Smithsonian', date: String(row.content?.indexedStructured?.date?.[0] ?? ''),
      snippet: JSON.stringify(row.content?.freetext?.physicalDescription ?? '').slice(0, 300), tier: 'A',
    }
  })
}

async function met(query: string): Promise<ResearchHit[]> {
  const search = await getJson(q('https://collectionapi.metmuseum.org/public/collection/v1/search', { q: query, hasImages: 'true' })) as Json
  const ids: number[] = (search.objectIDs ?? []).slice(0, 6)
  const out: ResearchHit[] = []
  for (const id of ids) {
    const o = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`) as Json
    out.push({
      adapter: 'met', title: o.title ?? '', url: o.objectURL ?? null, image: o.primaryImageSmall || o.primaryImage || null,
      license: o.isPublicDomain ? 'CC0（Met Open Access）' : '版权受限', institution: 'The Metropolitan Museum of Art',
      date: o.objectDate ?? '', snippet: [o.culture, o.period, o.medium, o.dimensions].filter(Boolean).join(' / ').slice(0, 400), tier: 'A',
    })
  }
  return out
}

async function cleveland(query: string): Promise<ResearchHit[]> {
  const data = await getJson(q('https://openaccess-api.clevelandart.org/api/artworks/', { q: query, has_image: 1, limit: 8 })) as Json
  return (data.data ?? []).map((a: Json): ResearchHit => ({
    adapter: 'cleveland', title: a.title ?? '', url: a.url ?? null, image: a.images?.web?.url ?? null,
    license: a.share_license_status ?? '', institution: 'Cleveland Museum of Art', date: a.creation_date ?? '',
    snippet: [a.culture?.[0], a.technique, a.measurements].filter(Boolean).join(' / ').slice(0, 400), tier: 'A',
  }))
}

async function loc(query: string): Promise<ResearchHit[]> {
  const data = await getJson(q('https://www.loc.gov/search/', { q: query, fo: 'json', c: 8 })) as Json
  return (data.results ?? []).slice(0, 8).map((r: Json): ResearchHit => ({
    adapter: 'loc', title: r.title ?? '', url: r.id ?? r.url ?? null, image: (r.image_url ?? []).slice(-1)[0] ?? null,
    license: Array.isArray(r.rights) ? r.rights.join('; ') : String(r.rights ?? ''), institution: 'Library of Congress',
    date: r.date ?? '', snippet: (r.description ?? []).join(' ').slice(0, 300), tier: 'A',
  }))
}

async function internetArchive(query: string): Promise<ResearchHit[]> {
  const url = new URL('https://archive.org/advancedsearch.php')
  url.searchParams.set('q', query)
  for (const f of ['identifier', 'title', 'date', 'licenseurl', 'mediatype']) url.searchParams.append('fl[]', f)
  url.searchParams.set('rows', '8')
  url.searchParams.set('output', 'json')
  const data = await getJson(url.toString()) as Json
  return (data.response?.docs ?? []).map((d: Json): ResearchHit => ({
    adapter: 'internet-archive', title: d.title ?? d.identifier, url: `https://archive.org/details/${d.identifier}`, image: null,
    license: d.licenseurl ?? '未标注（多为公有领域扫描）', institution: 'Internet Archive', date: String(d.date ?? ''),
    snippet: d.mediatype ?? '', tier: 'A',
  }))
}

async function ukNationalArchives(query: string): Promise<ResearchHit[]> {
  const data = await getJson(q('https://discovery.nationalarchives.gov.uk/API/search/records', { 'sps.searchQuery': query, 'sps.resultsPageSize': 8 })) as Json
  return (data.records ?? []).slice(0, 8).map((r: Json): ResearchHit => ({
    adapter: 'uk-national-archives', title: r.title || strip(r.description).slice(0, 80),
    url: `https://discovery.nationalarchives.gov.uk/details/r/${r.id}`, image: null,
    license: '档案著录（图像需另行申请）', institution: `The National Archives ${r.reference ?? ''}`.trim(),
    date: r.coveringDates ?? '', snippet: strip(r.description).slice(0, 400), tier: 'A',
  }))
}

async function openalex(query: string): Promise<ResearchHit[]> {
  const data = await getJson(q('https://api.openalex.org/works', { search: query, 'per-page': 6 })) as Json
  return (data.results ?? []).map((w: Json): ResearchHit => ({
    adapter: 'openalex', title: w.title ?? '', url: w.doi ?? w.id ?? null, image: null,
    license: w.open_access?.oa_status ?? '', institution: w.primary_location?.source?.display_name ?? '',
    date: String(w.publication_year ?? ''), snippet: '', tier: 'A',
  }))
}

const ADAPTER_FNS: Record<ResearchAdapter, (query: string) => Promise<ResearchHit[]>> = {
  'wikipedia-zh': query => wikipedia('zh', query),
  'wikipedia-en': query => wikipedia('en', query),
  'wikisource-zh': wikisource,
  // filetype:bitmap 排除 PDF/DjVu（实测不加时命中的全是书籍扫描封面）
  commons: query => commonsImages({ generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: 6, gsrlimit: 10 }, 'commons'),
  'commons-category': name => commonsImages({ generator: 'categorymembers', gcmtitle: name.startsWith('Category:') ? name : `Category:${name}`, gcmtype: 'file', gcmlimit: 30 }, 'commons-category'),
  europeana, smithsonian, met, cleveland, loc,
  'internet-archive': internetArchive,
  'uk-national-archives': ukNationalArchives,
  openalex,
}

export async function searchAdapter(adapter: ResearchAdapter, query: string): Promise<ResearchHit[]> {
  const hits = await ADAPTER_FNS[adapter](query)
  return hits.filter(hit => !isRejectedHost(hit.url) && !isRejectedHost(hit.image))
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|0\.)/

/** 下载候选图（只接受公网 https/http 图片，≤20 MB）；失败返回 null */
export async function downloadImage(url: string): Promise<{ bytes: Buffer; mime: string } | null> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (!/^https?:$/.test(parsed.protocol) || PRIVATE_HOST.test(parsed.hostname)) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(parsed, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) })
      if (res.status === 429) { await sleep(5000); continue }
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim()
      if (!res.ok || !mime.startsWith('image/')) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      return bytes.byteLength > 20 * 1024 * 1024 ? null : { bytes, mime }
    } catch {
      await sleep(1500)
    }
  }
  return null
}
