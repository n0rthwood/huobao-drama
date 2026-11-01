/**
 * 纪录片提取的「选角名单」（Issue #32）
 *
 * 为什么要有这一步：同一份剧本连跑三次，提取出的角色数是 14 / 11 / 8 —— 模型是在
 * 写保存参数的同时**顺带**决定谁该建卡的，名单从来没被写下来过，于是每次漏的人都不一样。
 * 这里把「谁该建卡」变成一个显式、可检查的步骤：Agent 先按剧本顺序登记名单（save_character_roster），
 * 名单落在本次提取任务的 params.roster 上（人在任务日志/任务详情里看得见），
 * 保存角色时由代码把名单与本集已建的角色卡对账，缺谁直接回报给模型补建。
 *
 * 只作用于纪录片规则集：非纪录片项目的提取链路完全不走这里（调用方按 genreRuleset 判定）。
 * 本模块只依赖 services 同层（text-task / asset-name），不得 import agents/*。
 */
import { normalizeAssetName, normalizeNearName } from './asset-name.js'
import { findActiveTextTask, parseTextTaskParams, patchTextTaskParams } from './text-task.js'

/** Agent 登记的一条名单项 */
export interface RosterEntryInput {
  name: string
  basis?: string
  reason?: string
}

export interface RosterEntry {
  name: string
  basis: string
  reason: string
}

export interface RosterNormalizeResult {
  /** 规范化 + 去重后的名单（保留首次出现的顺序与写法） */
  cast: RosterEntry[]
  /** 被并入前一条的近名/别名写法，形如「沃尔康斯基 → 沃尔孔斯基」 */
  merged: string[]
  /** 规范化后为空、无法作为资产名的条目（原样回报） */
  skipped: string[]
}

export interface RosterDiff {
  /** 名单里有、但还没有角色卡的人（要补建） */
  missing_from_roster: string[]
  /** 已保存、但名单从未登记过的名字（要么补登记，要么本来就不该建卡） */
  not_in_roster: string[]
}

export interface EpisodeRoster {
  taskId: number
  /** 本次运行还没登记过名单时为 null（与「登记了一个空名单」区分开） */
  cast: RosterEntry[] | null
}

/** 名单成员的比较口径：先按资产名规则规范化（Issue #34），再做近名归一化 */
export function rosterKey(name: string): string {
  return normalizeNearName(normalizeAssetName(name))
}

/**
 * 规范化名单：名字按资产名规则写死（它就是角色卡的名字），同一个人的不同译名/别名/
 * 带头衔写法按 rosterKey 合并成一条，保留先出现的那条（basis/reason 以先出现的为准，
 * 先出现的缺字段时用后来的补上）。
 */
export function normalizeRoster(entries: RosterEntryInput[] | null | undefined): RosterNormalizeResult {
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
    if (hitIndex !== undefined) {
      const hit = cast[hitIndex]
      if (!hit.basis && basis) hit.basis = basis
      if (!hit.reason && reason) hit.reason = reason
      if (name !== hit.name) merged.push(`${name} → ${hit.name}`)
      continue
    }
    if (key) indexByKey.set(key, cast.length)
    cast.push({ name, basis, reason })
  }

  return { cast, merged, skipped }
}

/**
 * 名单与已保存角色对账（纯函数）：两侧都按 rosterKey 比较，返回的是原始写法。
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
 * 读取本集正在运行的提取任务上的名单。
 * 返回 null = 当前没有「提取角色」任务在跑（名单是一次运行的契约，没有运行就没有名单）。
 */
export async function loadEpisodeRoster(episodeId: number): Promise<EpisodeRoster | null> {
  const task = await findActiveTextTask(episodeId, 'extract_characters')
  if (!task) return null
  const roster = parseTextTaskParams(task.params)?.roster
  if (!Array.isArray(roster)) return { taskId: task.id, cast: null }
  return { taskId: task.id, cast: normalizeRoster(roster as RosterEntryInput[]).cast }
}

export interface RosterSaveResult {
  taskId: number
  cast: RosterEntry[]
  merged: string[]
  skipped: string[]
  /** 本次调用新增的成员（第二次登记补人时只回报增量） */
  added: string[]
}

/**
 * 把名单写进本集提取任务的 params.roster（合并式：第二次登记是**补人**，不会删掉先登记的人；
 * 名单一旦登记就是本次运行的契约，漏登记的人只能补，不能靠覆盖悄悄去掉）。
 * 返回 null = 当前没有「提取角色」任务在跑。
 */
export async function saveEpisodeRoster(
  episodeId: number,
  entries: RosterEntryInput[],
): Promise<RosterSaveResult | null> {
  const existing = await loadEpisodeRoster(episodeId)
  if (!existing) return null
  const before = existing.cast || []
  const beforeKeys = new Set(before.map(e => rosterKey(e.name)))
  const normalized = normalizeRoster([...before, ...entries])
  await patchTextTaskParams(existing.taskId, { roster: normalized.cast })
  return {
    taskId: existing.taskId,
    cast: normalized.cast,
    merged: normalized.merged,
    skipped: normalized.skipped,
    added: normalized.cast.filter(e => !beforeKeys.has(rosterKey(e.name))).map(e => e.name),
  }
}

/** 没有名单时给 Agent 的可执行指令（纪录片提取的硬门槛） */
export const ROSTER_REQUIRED_MESSAGE =
  '纪录片提取未登记选角名单：请先调用 save_character_roster，按剧本顺序把本集所有符合「谁该建卡」的人物一次登记齐（每人写 name / basis / reason），再调用 save_dedup_characters 保存。'

/** 没有在跑的提取任务时的说明（名单只能挂在一次提取运行上） */
export const ROSTER_NO_TASK_MESSAGE =
  '本集没有正在运行的「提取角色」任务，选角名单无处登记：请从「提取角色」入口发起一次提取运行，再在该运行里调用 save_character_roster 与 save_dedup_characters。'
