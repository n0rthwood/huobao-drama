/**
 * 题材规则集（Issue #32）— 把 dramas.genre 归一化成 Agent 能读的规则标识
 *
 * 判定两段式（Q4：两者都有，开关优先）：
 * 1. `dramas.documentary_rules` 显式开关：'on' → documentary，'off' → null；
 * 2. 未设置（'auto' / NULL）时按 genre 关键字归一。
 *
 * 关键字刻意**不**匹配孤立的「历史」：古装历史短剧不是纪录片，误命中会让短剧
 * 吃到纪录片 addendum（史实忠实 + 禁虚构），属于回归。
 *
 * 层次约束：本模块只依赖 db（与 app-settings.ts 同层），严禁 import agents/*；
 * agents/context.ts 会同步调用 resolveDramaGenreRuleset。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export type GenreRuleset = 'documentary'

/** 显式开关取值；'auto' 与 NULL 等价（按关键字判定） */
export const DOCUMENTARY_RULE_MODES = ['auto', 'on', 'off'] as const
export type DocumentaryRuleMode = typeof DOCUMENTARY_RULE_MODES[number]

export function isDocumentaryRuleMode(v: unknown): v is DocumentaryRuleMode {
  return typeof v === 'string' && (DOCUMENTARY_RULE_MODES as readonly string[]).includes(v)
}

/** 纪录片题材关键字：中文「纪录/紀錄」与英文 documentary（大小写不敏感） */
const DOCUMENTARY_KEYWORDS = /纪录|紀錄|documentary/i

/** 纯函数：按题材字符串归一化规则集；未命中返回 null */
export function resolveGenreRuleset(genre: string | null | undefined): GenreRuleset | null {
  const value = (genre || '').trim()
  if (!value) return null
  return DOCUMENTARY_KEYWORDS.test(value) ? 'documentary' : null
}

/** 纯函数：显式开关 + 题材关键字 → 最终规则集（开关优先） */
export function resolveRulesetWithMode(genre: string | null | undefined, mode: string | null | undefined): GenreRuleset | null {
  if (mode === 'on') return 'documentary'
  if (mode === 'off') return null
  return resolveGenreRuleset(genre)
}

/**
 * 同步读取项目的规则集（better-sqlite3 的 .get()）。
 * 供 buildAgentRequestContext 在构建上下文时一次性解析：所有 Agent 链路
 * （提取 / 图片提示词 / 关键帧 / 视频提示词 / chat / 重试）都经过那一个入口，
 * 不需要逐个调用方注入。
 */
export function resolveDramaGenreRuleset(dramaId: number | null | undefined): GenreRuleset | null {
  if (!dramaId) return null
  const row = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (!row) return null
  return resolveRulesetWithMode(row.genre, row.documentaryRules)
}
