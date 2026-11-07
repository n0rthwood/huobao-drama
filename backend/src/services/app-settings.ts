/**
 * 应用级全局设置（app_settings key-value 表）
 * AI 内容语言：所有 Agent 产出（剧本/提取/分镜/提示词）统一使用的目标语言
 * 层次约束：本模块只依赖 db，严禁反向 import agents/*（agents/context.ts 会引用本模块）
 *
 * 注意：刻意做成同步 API（better-sqlite3 驱动的 .get()/.run()），
 * 供 agents/context.ts 的同步 buildAgentRequestContext 内部直接调用
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { isResearchSourceId, type ResearchSourceId } from '../config/research-sources.js'

export const CONTENT_LANGUAGES = ['zh', 'en', 'ja', 'ko'] as const
export type ContentLanguage = typeof CONTENT_LANGUAGES[number]

const CONTENT_LANGUAGE_KEY = 'content_language'

function isContentLanguage(v: unknown): v is ContentLanguage {
  return typeof v === 'string' && (CONTENT_LANGUAGES as readonly string[]).includes(v)
}

/** 读取全局内容语言；未设置或值非法时回退 'zh'（保持历史默认行为） */
export function getContentLanguage(): ContentLanguage {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, CONTENT_LANGUAGE_KEY))
    .get()
  return isContentLanguage(row?.value) ? row.value : 'zh'
}

/** 写入全局内容语言（upsert） */
export function setContentLanguage(lang: ContentLanguage): ContentLanguage {
  if (!isContentLanguage(lang)) throw new Error(`Invalid content language: ${lang}`)
  db.insert(schema.appSettings)
    .values({ key: CONTENT_LANGUAGE_KEY, value: lang, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: lang, updatedAt: now() },
    })
    .run()
  return lang
}

const TOURS_SEEN_KEY = 'tours_seen'
const MAX_TOURS_SEEN = 64

function sanitizeTourIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter(v => typeof v === 'string' && v.length > 0 && v.length <= 100))].slice(0, MAX_TOURS_SEEN)
}

/** 已看过的引导漫游 id 列表（JSON 数组存储）；桌面端端口随启动变化，localStorage 不可靠，故落库 */
export function getToursSeen(): string[] {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, TOURS_SEEN_KEY))
    .get()
  try { return sanitizeTourIds(JSON.parse(row?.value || '[]')) } catch { return [] }
}

/** 写入已看过的引导漫游 id 列表（upsert） */
export function setToursSeen(ids: unknown): string[] {
  const clean = sanitizeTourIds(ids)
  const value = JSON.stringify(clean)
  db.insert(schema.appSettings)
    .values({ key: TOURS_SEEN_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return clean
}

// ===== 资料检索 API key（Issue #78）=====
// 与 AI 服务密钥同口径：只存业务库，不进仓库；对外接口只给末 4 位提示，完整值只供服务端检索调用读取。
const RESEARCH_API_KEYS_KEY = 'research_api_keys'

function readResearchApiKeys(): Partial<Record<ResearchSourceId, string>> {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, RESEARCH_API_KEYS_KEY))
    .get()
  try {
    const parsed: unknown = JSON.parse(row?.value || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<Record<ResearchSourceId, string>> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (isResearchSourceId(id) && typeof value === 'string' && value) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 某个资料源当前保存的 key；未配置返回 null */
export function getResearchApiKey(id: ResearchSourceId): string | null {
  return readResearchApiKeys()[id] ?? null
}

/** 写入或清除（key=null）某个资料源的 key；key 已由 normalizeResearchKey 校验 */
export function setResearchApiKey(id: ResearchSourceId, key: string | null): void {
  const keys = readResearchApiKeys()
  if (key) keys[id] = key
  else delete keys[id]
  const value = JSON.stringify(keys)
  db.insert(schema.appSettings)
    .values({ key: RESEARCH_API_KEYS_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
}
