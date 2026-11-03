/**
 * 表达设计的解析上下文（Issue #49）— 把本集资产与 #47 的语义标注摘要装配成
 * `shot-intent.ts` 需要的 `IntentContext`，并提供「读库 → 规范化 → 问题列表」的统一入口。
 *
 * 语义标注这里**只取名称与稳定 id**，不带坐标：表达设计是导演层的决定（要让观众看到哪一项），
 * 几何交给 #48 的图层与 #50 的片段渲染；把上千个坐标塞进 Agent 上下文只会挤掉旁白。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { parseSemantics } from './asset-semantics.js'
import {
  normalizeShotIntent,
  parseShotIntent,
  type IntentAssetEntry,
  type IntentContext,
  type IntentIssue,
  type IntentSemanticEntry,
  type ShotIntent,
} from './shot-intent.js'

/** 某张证据素材的语义条目摘要（名称 + 稳定 id + 组别） */
export function semanticEntries(semanticsJson: string | null | undefined): IntentSemanticEntry[] {
  const doc = parseSemantics(semanticsJson)
  if (!doc) return []
  return [
    ...doc.labels.map(item => ({ id: item.id, name: item.text, group: 'label' as const })),
    ...doc.points.map(item => ({ id: item.id, name: item.name, group: 'point' as const })),
    ...doc.regions.map(item => ({ id: item.id, name: item.name, group: 'region' as const })),
    ...doc.lines.map(item => ({ id: item.id, name: item.name, group: 'line' as const })),
  ]
}

/**
 * 本集可被表达设计引用的全部资产（角色 / 场景 / 道具）+ 道具的语义条目。
 * **同步**实现：一致性检查会在 `syncStoryboardBindingsFromPrompts` 的同步事务里调用，
 * 中途 await 会让并发的提示词保存丢更新（#43 的教训）。
 */
export function loadIntentContext(episodeId: number): IntentContext {
  const charIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(link => link.characterId)
  const sceneIds = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(link => link.sceneId)
  const propIds = db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId)).all().map(link => link.propId)

  const assets: IntentAssetEntry[] = []
  for (const row of db.select().from(schema.characters).all()) {
    if (row.deletedAt || !charIds.includes(row.id)) continue
    assets.push({ kind: 'character', id: row.id, name: row.name, exposition: Number(row.exposition) === 1 })
  }
  for (const row of db.select().from(schema.scenes).all()) {
    if (row.deletedAt || !sceneIds.includes(row.id)) continue
    assets.push({ kind: 'scene', id: row.id, name: row.location, exposition: Number(row.exposition) === 1 })
  }
  for (const row of db.select().from(schema.props).all()) {
    if (row.deletedAt || !propIds.includes(row.id)) continue
    assets.push({
      kind: 'prop',
      id: row.id,
      name: row.name,
      exposition: Number(row.exposition) === 1,
      faithful: Number(row.faithful) === 1,
      semantics: semanticEntries(row.semantics),
    })
  }
  return { assets }
}

/**
 * 库里的 intent 按**当前**上下文重新解析：语义标注被改过之后，原来可解析的条目
 * 可能已经失效，所以 `unresolved` 永远是读时重算的结论，不吃库里的旧值。
 */
export function resolveStoryboardIntent(
  raw: string | null | undefined,
  ctx: IntentContext,
): { intent: ShotIntent | null; issues: IntentIssue[] } {
  const stored = parseShotIntent(raw)
  if (!stored) return { intent: null, issues: [] }
  return normalizeShotIntent(stored, ctx)
}

/** 一镜的表达设计摘要（供提示词批量的 message 用；没有 intent 返回空串） */
function describeIntent(intent: ShotIntent | null, ctx: IntentContext): string {
  if (!intent) return ''
  const nameOf = (assetId?: number) => ctx.assets.find(a => a.id === assetId)?.name || `资产${assetId}`
  const mustShow = intent.must_show.map((item) => {
    if (item.kind === 'route') return `路线 ${item.from || '?'}→${item.to || '?'}（${nameOf(item.asset_id)}）`
    if (item.kind === 'portrait') return `@${nameOf(item.asset_id)} 肖像`
    if (item.kind === 'exposition') return `背景信息载体 @${nameOf(item.asset_id)}`
    return `${nameOf(item.asset_id)} 上的「${item.semantic_name || item.semantic || '?'}」`
  })
  return [
    `手段=${intent.device}`,
    `信息点=${intent.info_point}`,
    mustShow.length ? `必须可见=${mustShow.join('；')}` : '',
    intent.overlay_plan.length ? `叠加层=${intent.overlay_plan.map(l => l.layer).join('/')}` : '',
    intent.rationale ? `理由=${intent.rationale}` : '',
  ].filter(Boolean).join('，')
}

export interface IntentBrief {
  /** 本镜 + 前后镜表达设计的中文摘要段（已含结尾换行）；没有任何 intent 时为空串 */
  text: string
  intent: ShotIntent | null
}

/**
 * 逐镜装配「本镜表达设计 + 前后镜 intent/description」的提示词片段（Issue #49）。
 * 关键帧/视频提示词批量把它插进 message，模型才知道这一镜必须让观众看到什么、
 * 以及上一镜已经讲到哪儿了（S06「船队的目的地」要接着前镜的船队写）。
 */
export function buildIntentBriefs(
  rows: Array<{ id: number; storyboardNumber: number; description: string | null; intent: string | null }>,
  ctx: IntentContext,
): Map<number, IntentBrief> {
  const ordered = [...rows].sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const intents = ordered.map(row => resolveStoryboardIntent(row.intent, ctx).intent)
  const briefs = new Map<number, IntentBrief>()
  ordered.forEach((row, index) => {
    const own = intents[index] ?? null
    const lines: string[] = []
    if (own) lines.push(`本镜表达设计（必须全部落到提示词里）：${describeIntent(own, ctx)}`)
    const prev = ordered[index - 1]
    const next = ordered[index + 1]
    if (prev) {
      const prevIntent = describeIntent(intents[index - 1] ?? null, ctx)
      lines.push(`上一镜 #${prev.storyboardNumber}：${prevIntent || '（无表达设计）'}｜画面：${(prev.description || '').slice(0, 120)}`)
    }
    if (next) {
      const nextIntent = describeIntent(intents[index + 1] ?? null, ctx)
      lines.push(`下一镜 #${next.storyboardNumber}：${nextIntent || '（无表达设计）'}｜画面：${(next.description || '').slice(0, 120)}`)
    }
    briefs.set(row.id, { text: lines.length ? `${lines.join('\n')}\n` : '', intent: own })
  })
  return briefs
}
