/**
 * 纪录片提取的「选角名册」（Issue #32）
 *
 * 为什么要有它：同一份剧本连跑三次，提取出的角色数是 15 / 15 / 13——模型每次重新决定
 * 谁该建卡，名单从没被固定下来，于是每次漏的人都不一样。名册把「谁该建卡」变成**一份人复核过、
 * 跟着集走的契约**：
 * 1. 首轮提取由 Agent 生成草稿（status='draft'，每条带入选依据与理由）；
 * 2. 人在集页面「选角名册」里增删复核并保存（status='approved'）；
 * 3. 之后每次提取**只能照名册执行**：不得改名、不得私自增删，名册之外的人不建卡；
 * 4. 剧本改动（指纹变化）即判定名册过期，必须重新生成草稿并由人复核。
 *
 * 只作用于纪录片规则集：非纪录片项目的提取链路完全不走这里（调用方按 genreRuleset 判定）。
 * 本模块只依赖 services 同层（text-task / asset-name）与 db，不得 import agents/*。
 */
import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { normalizeAssetName, normalizeNearName } from './asset-name.js'
import { findActiveTextTask, patchTextTaskParams } from './text-task.js'

/** 名册成员的来源：'agent' = 提取 Agent 首轮草稿，'human' = 人在界面上增补/改写 */
export type RosterSource = 'agent' | 'human'
export type RosterStatus = 'draft' | 'approved'

/** 外部（工具参数 / 接口入参 / 历史数据）传进来的一条名册项 */
export interface RosterEntryInput {
  name: string
  basis?: string
  reason?: string
  source?: string
}

export interface RosterEntry {
  name: string
  basis: string
  reason: string
  source: RosterSource
}

export interface RosterNormalizeResult {
  /** 规范化 + 去重后的名册（保留首次出现的顺序与写法） */
  cast: RosterEntry[]
  /** 被并入前一条的近名/别名写法，形如「沃尔孔斯基（总督） → 沃尔孔斯基」 */
  merged: string[]
  /** 规范化后为空、无法作为资产名的条目（原样回报） */
  skipped: string[]
}

export interface RosterDiff {
  /** 名册里有、但还没有角色卡的人（要补建） */
  missing_from_roster: string[]
  /** 已保存、但名册从未登记过的名字（要么由人补进名册，要么本来就不该建卡） */
  not_in_roster: string[]
}

export interface EpisodeRosterRecord {
  episodeId: number
  /** 从未生成过名册时为 null（与「名册为空」区分开） */
  cast: RosterEntry[] | null
  status: RosterStatus | null
  /** 名册复核时所依据的剧本指纹 */
  script_hash: string | null
  /** 本集剧本当前的指纹（剧本为空时为空串） */
  current_hash: string
  /** 有名册但剧本已改动：名册过期，必须重新生成草稿并由人复核 */
  stale: boolean
  updated_at: string | null
}

/** 名册成员的比较口径：先按资产名规则规范化（Issue #34），再做近名归一化 */
export function rosterKey(name: string): string {
  return normalizeNearName(normalizeAssetName(name))
}

/** 剧本指纹：名册复核的对象是这份正文，正文一变名册即过期 */
export function scriptFingerprint(script: string | null | undefined): string {
  const text = (script || '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 规范化名册：名字按资产名规则写死（它就是角色卡的名字），同一个人的不同译名/别名/
 * 带头衔写法按 rosterKey 合并成一条，保留先出现的那条（basis/reason 以先出现的为准，
 * 先出现的缺字段时用后来的补上）。
 */
export function normalizeRoster(
  entries: RosterEntryInput[] | null | undefined,
  defaultSource: RosterSource = 'agent',
): RosterNormalizeResult {
  const cast: RosterEntry[] = []
  const merged: string[] = []
  const skipped: string[] = []
  const indexByKey = new Map<string, number>()

  for (const raw of entries || []) {
    const original = String(raw?.name ?? '').trim()
    const name = normalizeAssetName(original)
    if (!name) {
      if (original) skipped.push(original)
      continue
    }
    const key = normalizeNearName(name)
    const hitIndex = key ? indexByKey.get(key) : undefined
    const basis = String(raw?.basis ?? '').trim()
    const reason = String(raw?.reason ?? '').trim()
    const source: RosterSource = raw?.source === 'human' ? 'human' : defaultSource
    if (hitIndex !== undefined) {
      const hit = cast[hitIndex]
      if (!hit.basis && basis) hit.basis = basis
      if (!hit.reason && reason) hit.reason = reason
      if (name !== hit.name) merged.push(`${name} → ${hit.name}`)
      continue
    }
    if (key) indexByKey.set(key, cast.length)
    cast.push({ name, basis, reason, source })
  }

  return { cast, merged, skipped }
}

/**
 * 名册与已保存角色对账（纯函数）：两侧都按 rosterKey 比较，返回的是原始写法。
 * 调用方用两次：savedNames 传本集已关联的角色名 → 取 missing_from_roster；
 * savedNames 传本次保存的角色名 → 取 not_in_roster。
 */
export function diffRosterAgainstSaved(rosterNames: string[], savedNames: string[]): RosterDiff {
  const savedKeys = new Set(savedNames.map(rosterKey).filter(Boolean))
  const rosterKeys = new Set(rosterNames.map(rosterKey).filter(Boolean))
  const missing: string[] = []
  const seenMissing = new Set<string>()
  for (const name of rosterNames) {
    const key = rosterKey(name)
    if (!key || savedKeys.has(key) || seenMissing.has(key)) continue
    seenMissing.add(key)
    missing.push(name)
  }
  const extra: string[] = []
  const seenExtra = new Set<string>()
  for (const name of savedNames) {
    const key = rosterKey(name)
    if (!key || rosterKeys.has(key) || seenExtra.has(key)) continue
    seenExtra.add(key)
    extra.push(name)
  }
  return { missing_from_roster: missing, not_in_roster: extra }
}

/**
 * 把一个写法归位到名册上的正式名字（纯函数）。
 * 提取 Agent 每次运行都可能写出不同的译名/带头衔写法；名册是契约，名字不许漂移——
 * 近名命中就改写成名册上的名字，命中不了返回 null（= 名册之外的人，不建卡）。
 */
export function canonicalizeToRoster(name: string, cast: RosterEntry[]): string | null {
  const key = rosterKey(name)
  if (!key) return null
  return cast.find(entry => rosterKey(entry.name) === key)?.name ?? null
}

/** 提案与名册的差异（纯函数）：人复核时要看见 Agent 想加谁、想去掉谁，系统不自动采纳 */
export function rosterProposalDiff(cast: RosterEntry[], proposed: RosterEntry[]) {
  const diff = diffRosterAgainstSaved(cast.map(e => e.name), proposed.map(e => e.name))
  return {
    // 提案里有、名册里没有的人（要人在界面上决定是否补进名册）
    proposed_additions: diff.not_in_roster,
    // 名册里有、提案里没有的人（名册不会因此删人）
    proposed_removals: diff.missing_from_roster,
  }
}

/** 读取本集名册（含剧本指纹与过期判定）；剧集不存在返回 null */
export async function loadEpisodeRosterRecord(episodeId: number): Promise<EpisodeRosterRecord | null> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return null
  const currentHash = scriptFingerprint(ep.scriptContent || ep.content)
  let cast: RosterEntry[] | null = null
  if (ep.characterRoster) {
    try {
      const parsed = JSON.parse(ep.characterRoster)
      if (Array.isArray(parsed)) cast = normalizeRoster(parsed as RosterEntryInput[]).cast
    } catch {
      cast = null
    }
  }
  return {
    episodeId,
    cast,
    status: ep.characterRosterStatus === 'approved' ? 'approved' : (cast ? 'draft' : null),
    script_hash: ep.characterRosterHash || null,
    current_hash: currentHash,
    // 剧本或名册任一侧没有指纹时不判过期（老数据按可用处理，人仍可随时复核）
    stale: !!cast && !!ep.characterRosterHash && !!currentHash && ep.characterRosterHash !== currentHash,
    updated_at: ep.characterRosterUpdatedAt || null,
  }
}

/**
 * 写名册：status='draft' 是 Agent 首轮草稿，'approved' 是人复核后保存。
 * 指纹一律按**当前剧本**重新计算：名册复核的对象就是这一版正文。
 */
export async function saveEpisodeRosterRecord(
  episodeId: number,
  entries: RosterEntryInput[],
  status: RosterStatus,
  defaultSource: RosterSource = 'agent',
): Promise<EpisodeRosterRecord | null> {
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!ep) return null
  const normalized = normalizeRoster(entries, defaultSource)
  const ts = now()
  await db.update(schema.episodes).set({
    characterRoster: JSON.stringify(normalized.cast),
    characterRosterHash: scriptFingerprint(ep.scriptContent || ep.content),
    characterRosterStatus: status,
    characterRosterUpdatedAt: ts,
    updatedAt: ts,
  }).where(eq(schema.episodes.id, episodeId))
  return loadEpisodeRosterRecord(episodeId)
}

/**
 * 把本次运行实际使用的名册记在提取任务的 params 上（只作溯源与任务日志，不是契约本体）。
 * 没有在跑的「提取角色」任务时静默跳过：名册本体在 episodes 上，不依赖任务行。
 */
export async function recordRunRoster(episodeId: number, cast: RosterEntry[]): Promise<boolean> {
  const task = await findActiveTextTask(episodeId, 'extract_characters')
  if (!task) return false
  await patchTextTaskParams(task.id, { roster: cast })
  return true
}

/** 名册还没生成时给 Agent 的可执行指令（纪录片提取的硬门槛） */
export const ROSTER_REQUIRED_MESSAGE =
  '本集还没有选角名册：请先调用 save_character_roster，按剧本顺序把所有符合「谁该建卡」的人物一次登记齐（每人写 name / basis / reason），再调用 save_dedup_characters 保存角色。'

/** 剧本改动后名册过期的指令 */
export const ROSTER_STALE_MESSAGE =
  '本集的选角名册是针对旧版剧本复核的，剧本已改动：请重新调用 save_character_roster，按当前剧本重建名册草稿（会覆盖旧草稿并标记为待复核），再调用 save_dedup_characters。'
