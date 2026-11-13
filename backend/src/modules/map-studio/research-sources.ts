/**
 * 地图工作室的资料检索适配器（Issue #99：从 `services/asset-research/sources.ts` 复制，
 * 只保留地图检索真正使用的四个来源：维基中/英、Europeana、Smithsonian）
 *
 * 与火宝资产流水线的区别只有一处：API key 来自**模块自己的设置区**（`map_studio_setting`），
 * 不再读 `app_settings.research_api_keys`——模块边界不允许反向读宿主设置。
 * 火宝侧在模块设置为空时只做**一次性种子**（见 `settings.ts` 的 `seedLegacyResearchKeys`）。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { getResearchKey } from './settings.js'

export const RESEARCH_ADAPTERS = ['wikipedia-zh', 'wikipedia-en', 'europeana', 'smithsonian'] as const
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

const UA = 'huobao-drama-map-studio/1.0 (historical map research)'
const TIMEOUT_MS = 20_000

// Same source policy as the pre-extraction adapters.
const REJECT_HOSTS = [
  'zhihu.com', 'baijiahao.baidu.com', 'baike.baidu.com', 'sohu.com', 'toutiao.com', '163.com', 'qq.com',
  'bilibili.com', 'douyin.com', 'kuaishou.com', 'csdn.net', 'jianshu.com', '360doc.com', 'doc88.com', 'docin.com',
  'sina.com.cn', 'ifeng.com', 'xiaohongshu.com', 'pinterest.com', 'quora.com', 'reddit.com', 'medium.com',
  'facebook.com', 'twitter.com', 'x.com', 'youtube.com',
]
export function isRejectedHost(url: string | null | undefined): boolean {
  let hostname: string
  try { hostname = url ? new URL(url).hostname.toLowerCase() : '' } catch { return false }
  return !!hostname && REJECT_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`))
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
  throw new Error(`请求失败：${last}`)
}

function q(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
  return url.toString()
}

const strip = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&#8203;|\u200b/g, '').trim()
// 外部 API 的松散 JSON；字段按需取，取不到给空值
type Json = Record<string, any>

async function wikipedia(lang: 'zh' | 'en', query: string): Promise<ResearchHit[]> {
  const data = await getJson(q(`https://${lang}.wikipedia.org/w/api.php`, { action: 'query', list: 'search', srsearch: query, srlimit: 5, format: 'json' })) as Json
  return (data.query?.search ?? []).map((hit: Json): ResearchHit => ({
    adapter: lang === 'zh' ? 'wikipedia-zh' : 'wikipedia-en', title: hit.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`, image: null,
    license: 'CC BY-SA 4.0（正文）', institution: 'Wikipedia', date: '', snippet: strip(hit.snippet), tier: 'B',
  }))
}

/** 正文摘录：维基百科条目正文（Europeana/Smithsonian 只有著录摘要，无正文） */
export async function fetchText(hit: ResearchHit, maxChars = 6000): Promise<string> {
  if (hit.adapter !== 'wikipedia-zh' && hit.adapter !== 'wikipedia-en') return ''
  const lang = hit.adapter === 'wikipedia-zh' ? 'zh' : 'en'
  const data = await getJson(q(`https://${lang}.wikipedia.org/w/api.php`, {
    action: 'query', prop: 'extracts', explaintext: 1, titles: hit.title, redirects: 1, format: 'json',
    variant: lang === 'zh' ? 'zh-hans' : undefined,
  })) as Json
  const page: Json = Object.values(data.query?.pages ?? {})[0] ?? {}
  return String(page.extract ?? '').slice(0, maxChars)
}

async function europeana(query: string): Promise<ResearchHit[]> {
  const key = getResearchKey('europeana')
  if (!key) throw new Error('地图工作室未配置 Europeana API key（模块设置 → 资料检索）')
  const data = await getJson(q('https://api.europeana.eu/record/v2/search.json', { wskey: key, query, rows: 8, media: 'true', qf: 'TYPE:IMAGE', profile: 'rich' })) as Json
  return (data.items ?? []).map((it: Json): ResearchHit => ({
    adapter: 'europeana', title: it.title?.[0] ?? '', url: it.guid ?? null, image: it.edmIsShownBy?.[0] ?? it.edmPreview?.[0] ?? null,
    license: it.rights?.[0] ?? '', institution: it.dataProvider?.[0] ?? '', date: String(it.year?.[0] ?? ''),
    snippet: String(it.dcDescription?.[0] ?? '').slice(0, 400), tier: 'A',
  }))
}

async function smithsonian(query: string): Promise<ResearchHit[]> {
  const key = getResearchKey('smithsonian')
  if (!key) throw new Error('地图工作室未配置 Smithsonian API key（模块设置 → 资料检索）')
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

const ADAPTER_FNS: Record<ResearchAdapter, (query: string) => Promise<ResearchHit[]>> = {
  'wikipedia-zh': query => wikipedia('zh', query),
  'wikipedia-en': query => wikipedia('en', query),
  europeana,
  smithsonian,
}

/** 检索一个来源；来源自身的失败原样抛出，由检索阶段的模型工具转成可读错误回给模型 */
export async function searchAdapter(adapter: ResearchAdapter, query: string): Promise<ResearchHit[]> {
  const hits = await ADAPTER_FNS[adapter](query)
  return hits.filter(hit => !isRejectedHost(hit.url) && !isRejectedHost(hit.image))
}
