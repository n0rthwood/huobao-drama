/**
 * 角色/场景提取 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 *
 * 单 Agent 一步流程：
 * 1. 读取剧本内容
 * 2. 读取项目中已存在的角色/场景（用于去重）
 * 3. 纪录片规则集下先登记选角名单（save_character_roster），谁该建卡变成显式、可对账的一步
 * 4. 提取角色/场景并智能去重后直接保存；纪录片下由代码把保存结果与名单对账
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { eq, and } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskPayload, logTaskProgress, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId, getGenreRuleset, getSingleAssetName } from '../context.js'
import { parseStylingVersion, saveStylingVersion } from '../../services/styling-version.js'
import { normalizeAssetName, normalizeNearName } from '../../services/asset-name.js'
import { linkCitationsToAsset } from '../../services/research-citations.js'
import { markExposition } from '../../services/exposition.js'
import {
  ROSTER_REQUIRED_MESSAGE,
  ROSTER_STALE_MESSAGE,
  canonicalizeToRoster,
  diffRosterAgainstSaved,
  loadEpisodeRosterRecord,
  normalizeRoster,
  recordRunRoster,
  rosterKey,
  rosterProposalDiff,
  saveEpisodeRosterRecord,
} from '../../services/character-roster.js'
import type { RosterEntry } from '../../services/character-roster.js'

// ─── 关联辅助 ────────────────────────────────────────────────
async function linkCharToEpisode(episodeId: number, characterId: number) {
  const ts = now()
  const existing = await db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, characterId)))

  if (!existing.length) {
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts })
  }
}

async function linkSceneToEpisode(episodeId: number, sceneId: number) {
  const ts = now()
  const existing = await db.select().from(schema.episodeScenes)
    .where(and(eq(schema.episodeScenes.episodeId, episodeId), eq(schema.episodeScenes.sceneId, sceneId)))

  if (!existing.length) {
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts })
  }
}

async function linkPropToEpisode(episodeId: number, propId: number) {
  const ts = now()
  const existing = await db.select().from(schema.episodeProps)
    .where(and(eq(schema.episodeProps.episodeId, episodeId), eq(schema.episodeProps.propId, propId)))

  if (!existing.length) {
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts })
  }
}

// ─── 名字归一化（近名去重） ───────────────────────────────────
// 实现在 services/asset-name.ts（与资产名规则同源，选角名单与提取去重共用同一口径）。

// 场景地点只做空白（含 _）归一化（不删括号：如「火车站（候车厅）」与「火车站（站台）」是不同场景）
function normalizeLocation(loc: string): string {
  return (loc || '').replace(/[\s　_]+/g, '').toLowerCase().trim()
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

// 1. 读取剧本内容
const readScriptForExtraction = createTool({
  id: 'read_script_for_extraction',
  description: 'Read the formatted screenplay for character/scene extraction.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const content = ep.scriptContent || ep.content
    if (!content) return { error: 'Episode has no script content' }
    logTaskSuccess('ExtractTool', 'read-script', { episodeId, dramaId, scriptLength: content.length })
    return { script: content }
  },
})

// 2. 读取项目中已存在的角色（用于去重判断）
const readExistingCharacters = createTool({
  id: 'read_existing_characters',
  description: 'Read all characters already existing in this drama project (for deduplication).',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const links = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const linkedIds = new Set(links.map(link => link.characterId))
    // 本集造型版本（Issue #15）：让提取 Agent 知道本集已有哪套造型，避免重复写进基础 styling
    const versionByCharId = new Map<number, unknown>()
    for (const link of links) {
      const parsed = parseStylingVersion(link.stylingVersion)
      if (parsed) versionByCharId.set(link.characterId, parsed)
    }
    const chars = (await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId)))
      .filter(c => !c.deletedAt)
    const visibleChars = chars.map(c => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      // 身份/势力/年代/叙事作用写在 description（Issue #32）：合并判断要看得到它
      description: c.description || '',
      appearance: c.appearance || '',
      styling: c.styling || '',
      episode_styling_version: versionByCharId.get(c.id) ?? null,
      normalized_name: normalizeNearName(c.name), // 用于判断近名复用：括号定位/别名视为同名
    }))
    const payload = {
      count: visibleChars.length,
      characters: visibleChars,
      current_episode_characters: visibleChars.filter(c => linkedIds.has(c.id)),
    }
    logTaskSuccess('ExtractTool', 'read-characters', {
      episodeId,
      dramaId,
      projectCharacters: payload.count,
      episodeCharacters: payload.current_episode_characters.length,
    })
    return payload
  },
})

// 3. 读取项目中已存在的场景（用于去重判断）
const readExistingScenes = createTool({
  id: 'read_existing_scenes',
  description: 'Read all scenes already existing in this drama project (for deduplication).',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const links = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const linkedIds = new Set(links.map(link => link.sceneId))
    const scenes = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)))
      .filter(s => !s.deletedAt)
    const visibleScenes = scenes.map(s => ({
      id: s.id,
      location: s.location,
      time: s.time || '',
      prompt: s.prompt || '',
      lighting: s.lighting || '',
      normalized_location: normalizeLocation(s.location), // 用于判断近名复用（仅空白/大小写）
    }))
    const payload = {
      count: visibleScenes.length,
      scenes: visibleScenes,
      current_episode_scenes: visibleScenes.filter(s => linkedIds.has(s.id)),
    }
    logTaskSuccess('ExtractTool', 'read-scenes', {
      episodeId,
      dramaId,
      projectScenes: payload.count,
      episodeScenes: payload.current_episode_scenes.length,
    })
    return payload
  },
})

// 4. 选角名册（仅纪录片规则集）
// 为什么单独一步：同一份剧本连跑三次得到 15 / 15 / 13 个角色——模型每次重新决定谁该建卡。
// 名册是**跟着集走、人复核过**的契约：首轮由 Agent 生成草稿，人在集页面增删保存，
// 之后每次提取只能照名册执行（不改名、不私自增删），剧本改动则名册过期需重新复核。
const readCharacterRoster = createTool({
  id: 'read_character_roster',
  description: 'Documentary extraction only. Read this episode\'s reviewed cast roster BEFORE doing anything else with characters. If it returns usable=true, that roster is the contract: extract exactly those people, keep their names verbatim, add nobody. If it returns usable=false, build a draft with save_character_roster first.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    if (getGenreRuleset(context?.requestContext) !== 'documentary') {
      return { error: '选角名册只用于纪录片题材的提取；当前项目不是纪录片规则集，请直接调用 save_dedup_characters。' }
    }
    const record = await loadEpisodeRosterRecord(episodeId)
    if (!record) return { error: 'Episode not found' }
    const usable = !!record.cast && !record.stale
    logTaskSuccess('ExtractTool', 'read-character-roster', {
      episodeId,
      dramaId,
      count: record.cast?.length ?? 0,
      status: record.status ?? 'none',
      stale: record.stale,
    })
    return {
      // 可用 = 有名册且未过期。**草稿也算可用**：否则每次运行都重新决定一次人选，
      // 覆盖率又会在 15/15/13 之间漂。是否已经过人复核单独看 approved。
      usable,
      approved: record.status === 'approved',
      status: record.status,
      stale: record.stale,
      count: record.cast?.length ?? 0,
      cast: record.cast ?? [],
      updated_at: record.updated_at,
      instruction: usable
        ? `照名册执行：名册上的每一个人都要建卡，名字原样使用，名册之外的人一律不建卡。${record.status === 'approved' ? '' : '该名册还是待复核的 AI 草稿——'}发现名册有遗漏或多余，写在你的结束语里交给人到集页面「选角名册」复核，不要自行改名册。`
        : (record.stale ? ROSTER_STALE_MESSAGE : ROSTER_REQUIRED_MESSAGE),
    }
  },
})

const saveCharacterRoster = createTool({
  id: 'save_character_roster',
  description: 'Documentary extraction only. Build the FIRST DRAFT of this episode\'s cast roster: walk the script from its first line to its last and register every person who qualifies under the "who gets a card" rule, in script order. The draft is saved for human review and reused by every later extraction of this episode, so register the whole cast in one call. If a usable roster already exists this call does NOT change it — it returns the saved roster plus the differences your proposal would have made, and you must then follow the saved roster and report the differences in your final answer for the human to review.',
  inputSchema: z.object({
    cast: z.array(z.object({
      name: z.string().describe('该人物的角色卡名字，与剧本原文一致；同一个人的不同译名、别名、头衔只登记一条'),
      basis: z.string().describe('剧本里点到此人的那句（或那段）原文，证明他出现在本集'),
      reason: z.string().describe('按「谁该建卡」的哪一条入选：决策 / 行动 / 亲历，并写明是哪一个动作'),
    })).describe('本集的全部人选，按剧本出现顺序排列；本集确无人选时传空数组（表示本集不建任何角色卡）'),
  }),
  execute: async ({ cast }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    // 非纪录片项目不走名册流程：这里只拒绝，不改变 save_dedup_characters 的任何行为
    if (getGenreRuleset(context?.requestContext) !== 'documentary') {
      return { error: '选角名册只用于纪录片题材的提取；当前项目不是纪录片规则集，请直接调用 save_dedup_characters。' }
    }
    const existing = await loadEpisodeRosterRecord(episodeId)
    if (!existing) return { error: 'Episode not found' }

    // 已有可用名册：Agent 不得改写它（名字漂移与私自增删正是 15/15/13 的病根）。
    // 差异如实回报，由人在集页面「选角名册」里决定要不要采纳——系统绝不自动采纳。
    if (existing.cast && !existing.stale) {
      const proposal = normalizeRoster(cast)
      const diff = rosterProposalDiff(existing.cast, proposal.cast)
      await recordRunRoster(episodeId, existing.cast)
      logTaskWarn('ExtractTool', 'character-roster-locked', {
        episodeId,
        dramaId,
        status: existing.status ?? 'draft',
        proposed_additions: diff.proposed_additions.join(',') || undefined,
        proposed_removals: diff.proposed_removals.join(',') || undefined,
      })
      return {
        applied: false,
        message: `本集已有${existing.status === 'approved' ? '人已复核的' : '待复核的'}选角名册（${existing.cast.length} 人），不会被本次提案改写。请照名册建卡。`,
        status: existing.status,
        count: existing.cast.length,
        cast: existing.cast,
        ...diff,
        instruction: (diff.proposed_additions.length || diff.proposed_removals.length)
          ? '把上面的 proposed_additions / proposed_removals 写进你的结束语，交给人在集页面「选角名册」里复核；本次提取仍然严格按已有名册执行。'
          : '提案与名册一致，按名册建卡即可。',
      }
    }

    // 没有名册，或剧本改动后名册过期：生成（重建）草稿，等人复核
    const saved = await saveEpisodeRosterRecord(episodeId, cast, 'draft', 'agent')
    if (!saved?.cast) return { error: 'Episode not found' }
    await recordRunRoster(episodeId, saved.cast)
    const proposal = normalizeRoster(cast)
    logTaskSuccess('ExtractTool', 'save-character-roster', {
      episodeId,
      dramaId,
      count: saved.cast.length,
      rebuilt_from_stale: existing.stale,
      merged_aliases: proposal.merged.join(',') || undefined,
      // 名册一行一行进成功日志：人在任务日志里就能看清谁按哪条规则入选
      cast: saved.cast.map(entry => `${entry.name}（${entry.reason || '未写入选理由'}）`).join('，'),
    })
    // 名册全文进任务日志：人要能看见「谁、凭哪句话、按哪条规则」入选
    logTaskPayload('ExtractTool', 'character-roster', saved.cast)
    return {
      applied: true,
      message: `选角名册草稿已保存：共 ${saved.cast.length} 人，状态「待复核」。接下来 save_dedup_characters 必须把名册上的每一个人都建卡，名册之外的人不要建卡；请在结束语里提示人到集页面「选角名册」复核。`,
      status: saved.status,
      count: saved.cast.length,
      cast: saved.cast,
      // 按近名/别名并入前一条的写法（同一个人不会出两张卡）
      merged_aliases: proposal.merged,
      // 规范化后为空、无法作为角色卡名字的条目
      skipped_names: proposal.skipped,
    }
  },
})

// 名册对账（纪录片）：本集已有的角色卡 vs 名册 → 缺谁；被挡在名册外、没写库的名字 → 交给人复核。
// 结果进工具返回值，模型据此补调一次 save_dedup_characters；这不是异常，提取任务不会因此失败。
async function rosterReport(
  episodeId: number,
  cast: RosterEntry[],
  outsideRoster: string[],
  renamedToRoster: string[],
  focusName: string | null,
) {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const linkedIds = new Set(links.map(link => link.characterId))
  const inEpisode = (await db.select().from(schema.characters))
    .filter(c => !c.deletedAt && linkedIds.has(c.id))
    .map(c => c.name || '')
  // 单资产重提取只对那一个人要求完整性：不能因为名册里还有别人就把重提取变成整集重跑。
  // 目标本身不在名册上时（人点了某张已有卡的「重新提取」），它仍然照常保存——
  // 字段在发起时已被清空，这里再拒就是把那张卡清成空白，属于数据损坏。
  const focusInRoster = focusName ? cast.some(entry => rosterKey(entry.name) === rosterKey(focusName)) : false
  const scoped = focusName
    ? cast.filter(entry => rosterKey(entry.name) === rosterKey(focusName))
    : cast
  const rosterNames = scoped.map(entry => entry.name)
  const { missing_from_roster } = diffRosterAgainstSaved(rosterNames, inEpisode)
  const focusSaved = focusName
    ? inEpisode.some(name => rosterKey(name) === rosterKey(focusName))
    : false
  let headline: string
  if (missing_from_roster.length) {
    headline = `名册上还有 ${missing_from_roster.length} 人没有角色卡：${missing_from_roster.join('、')}。请立刻再次调用 save_dedup_characters，只传这些人，把他们补齐。`
  } else if (focusName && !focusInRoster) {
    headline = focusSaved
      ? `「${focusName}」不在名册上：本次是单资产重提取，已按请求保存。请把它写进结束语，由人到集页面「选角名册」里复核是否补入名册。`
      : `「${focusName}」不在名册上，且本次没有保存成功：请用与原卡完全相同的名字再调用一次 save_dedup_characters，否则该角色卡的字段会一直是空的。`
  } else if (focusName) {
    headline = focusSaved
      ? `「${focusName}」已建卡（本次是单资产重提取，名册其余成员不在本次范围内）。`
      : `「${focusName}」还没有角色卡：请立刻再次调用 save_dedup_characters，只传这一个人。`
  } else {
    headline = `名册上的 ${rosterNames.length} 人已全部建卡。`
  }
  const parts = [headline]
  if (outsideRoster.length) {
    parts.push(`「${outsideRoster.join('、')}」不在名册上，已被拒绝建卡：请把他们写进结束语，由人到集页面「选角名册」里复核是否补入，系统不会自动采纳。`)
  }
  if (renamedToRoster.length) {
    parts.push(`以下写法已按名册归位：${renamedToRoster.join('、')}。`)
  }
  return {
    roster_total: rosterNames.length,
    missing_from_roster,
    not_in_roster: outsideRoster,
    renamed_to_roster: renamedToRoster,
    roster_check: parts.join(''),
  }
}

// 5. 智能保存角色（按名字去重，与现有数据合并）
const saveDedupCharacters = createTool({
  id: 'save_dedup_characters',
  description: 'Save extracted characters with deduplication. Existing characters (same name) are merged/updated; new ones are created. All are linked to the current episode.',
  inputSchema: z.object({
    characters: z.array(z.object({
      name: z.string().describe('角色名，与剧本原文一致'),
      role: z.string().optional().describe('短身份标签（如「沙皇 · 谕令签发者」），不写长句、不写生平'),
      description: z.string().optional().describe('身份、地位、所属势力、年代、在本集中的叙事作用；只有提示词 Agent 读得到'),
      appearance: z.string().optional().describe('静态可见的外貌特征（脸型、发型、髭形、身材、年龄感）；全链路都会读，进生图提示词。不写情绪、动作、环境、背景'),
      styling: z.string().optional().describe('常规服装/配饰/可持有的身份符号（冠冕、绶带、胸甲、朝服、仪仗、持物），逐项写死款式与颜色；全链路都会读，进生图提示词。不写环境与背景。以上任何字段都不得出现 URL、域名、「据维基百科」「资料来源」等来源标注'),
      // 本集成套造型（Issue #15 Q1=B）：写进集关联，绝不覆盖基础形象的 styling
      styling_version: z.object({
        name: z.string(),
        description: z.string().optional(),
      }).optional(),
      // 背景信息载体（Issue #47）：旁白提到但本集不出场的人物（如远在彼得堡的彼得一世）
      exposition: z.boolean().optional()
        .describe('true = 背景信息载体：旁白提到、本集不出场、只需要一个视觉载体（肖像/版画/再现镜头）的人物或组织。会标在 role 前缀上，不占选角名册'),
    })),
  }),
  execute: async ({ characters }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    // 纪录片规则集：选角名册是契约（Issue #32）。没有名册、或剧本改动后名册过期，都不许写库；
    // 返回的是**工具结果**不是异常：模型补调 save_character_roster 即可自行纠正，整个提取任务不失败。
    // 非纪录片项目 roster 恒为 null，下面所有名册逻辑都不执行，行为与改造前逐字一致。
    const documentary = getGenreRuleset(context?.requestContext) === 'documentary'
    // 单资产重提取：人点了某张已有卡的「重新提取」，发起时已清空该卡的提取字段。
    // 这一个人无论在不在名册上都必须能写回去——在这里拒绝就是把那张卡留成空白。
    const focusName = getSingleAssetName(context?.requestContext)
    const record = documentary ? await loadEpisodeRosterRecord(episodeId) : null
    const roster = record?.cast && !record.stale ? record.cast : null
    if (documentary && !roster && !focusName) {
      const error = record?.stale ? ROSTER_STALE_MESSAGE : ROSTER_REQUIRED_MESSAGE
      logTaskWarn('ExtractTool', 'save-characters-roster-missing', { episodeId, dramaId, stale: !!record?.stale })
      return { error, saved: 0 }
    }
    const ts = now()
    const results = { created: 0, merged: 0, styling_versions: 0 }
    // 合并时被忽略的改写：基础形象一旦有值就不再被单集提取覆盖，这里如实回报给 Agent
    const ignored: string[] = []
    const stylingVersions: string[] = []
    // 名册契约（纪录片）：被挡在名册外、没写库的名字；以及按名册归位的写法
    const outsideRoster: string[] = []
    const renamedToRoster: string[] = []
    logTaskProgress('ExtractTool', 'save-characters-begin', {
      episodeId,
      dramaId,
      names: characters.map(char => char.name).join(','),
    })

    for (const char of characters) {
      // 资产名规则（Issue #34）：先规范化再查重与写库；规范化后为空的条目跳过
      char.name = normalizeAssetName(char.name)
      if (!char.name) {
        logTaskWarn('ExtractTool', 'save-characters-skip-empty-name', { episodeId, dramaId })
        continue
      }
      // 名册契约：名字一律归位到名册上的写法（禁止译名/头衔漂移），
      // 名册之外的人**不写库**——要不要补进名册由人在集页面复核，系统不自动采纳。
      // 例外：单资产重提取点名的那一个人（字段已被清空，必须能写回）。
      const isFocus = !!focusName && rosterKey(char.name) === rosterKey(focusName)
      // 背景信息载体不占选角名册（Issue #47）：名册回答的是「谁该建**出场**角色卡」，
      // 而近卫团、不在场的彼得一世这类实体本来就不在名册的判定程序里（组织不是人、
      // 不在场的人没有决策/行动/亲历），卡在名册门口等于让它们永远建不出来。
      if (roster && !isFocus && !char.exposition) {
        const canonical = canonicalizeToRoster(char.name, roster)
        if (!canonical) {
          outsideRoster.push(char.name)
          logTaskWarn('ExtractTool', 'save-characters-outside-roster', { episodeId, dramaId, name: char.name })
          continue
        }
        if (canonical !== char.name) {
          renamedToRoster.push(`${char.name} → ${canonical}`)
          char.name = canonical
        }
      }
      const charsInProject = (await db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)))
        .filter(c => !c.deletedAt)
      const exact = charsInProject.find(c => c.name === char.name)
      const normName = normalizeNearName(char.name)
      const existing = exact || (normName ? charsInProject.find(c => c.name && normalizeNearName(c.name) === normName) : undefined)
      const matchedViaNorm = !!existing && existing !== exact
      let charId: number

      if (existing) {
        // 归一化命中：括号定位/别名等近名视作同一角色复用，避免重复创建
        if (matchedViaNorm) logTaskProgress('ExtractTool', 'save-characters-reuse', { episodeId, dramaId, extracted: char.name, reused: existing.name })
        // 合并策略（Issue #15）：基础形象以**已有非空值**为准，新文本只补空白字段。
        // 旧实现用本集文本直接覆盖 styling/appearance，导致 E3 的度假造型污染了全剧的基础形象。
        if (char.styling && existing.styling && char.styling !== existing.styling) ignored.push(`${existing.name}.styling`)
        if (char.appearance && existing.appearance && char.appearance !== existing.appearance) ignored.push(`${existing.name}.appearance`)
        // 背景信息载体标记只会被「加上」不会被抹掉：已有的出场角色（彼得一世已在项目里）
        // 再次被当作背景信息载体提到时不重复建卡，但也不该因此降级成非载体
        const expositionNow = char.exposition === true || Number(existing.exposition) === 1
        await db.update(schema.characters).set({
          role: expositionNow ? markExposition(existing.role || char.role || '') : (existing.role || char.role || ''),
          description: existing.description || char.description || '',
          appearance: existing.appearance || char.appearance || '',
          styling: existing.styling || char.styling || char.description || '',
          exposition: expositionNow ? 1 : 0,
          updatedAt: ts,
        }).where(eq(schema.characters.id, existing.id))
        await linkCharToEpisode(episodeId, existing.id)
        charId = existing.id
        results.merged++
      } else {
        // 新增角色
        const res = await db.insert(schema.characters).values({
          name: char.name,
          role: char.exposition ? markExposition(char.role) : (char.role || ''),
          description: char.description || '',
          appearance: char.appearance || '',
          styling: char.styling || char.description || '',
          dramaId,
          exposition: char.exposition ? 1 : 0,
          createdAt: ts,
          updatedAt: ts,
        })
        charId = getInsertId(res)
        await linkCharToEpisode(episodeId, charId)
        results.created++
      }

      // 本次提取期间以该角色名落的检索记录归属到这一行（Issue #32，资产详情「资料来源」按 asset_id 读）
      await linkCitationsToAsset(episodeId, 'character', char.name, charId)

      if (char.styling_version?.name?.trim()) {
        const saved = await saveStylingVersion(episodeId, charId, {
          name: char.styling_version.name.trim(),
          description: char.styling_version.description || '',
        })
        if (saved) {
          results.styling_versions++
          stylingVersions.push(`${char.name}：${saved.name}`)
        }
      }
    }

    const payload = {
      message: `角色保存完成：新增 ${results.created}，合并更新 ${results.merged}，本集造型版本 ${results.styling_versions}`,
      ...results,
      // 基础形象被保护、未采纳的改写（不是错误：单集造型请用 styling_version）
      ignored_overwrites: ignored,
      saved_styling_versions: stylingVersions,
      ...(roster ? await rosterReport(episodeId, roster, outsideRoster, renamedToRoster, focusName) : {}),
    }
    logTaskSuccess('ExtractTool', 'save-characters-complete', { episodeId, ...results, ignored: ignored.length })
    return payload
  },
})

// 6. 智能保存场景（按地点+时间段去重，与现有数据合并）
const saveDedupScenes = createTool({
  id: 'save_dedup_scenes',
  description: 'Save extracted scenes with deduplication. Existing scenes (same location+time) are reused; new ones are created. All are linked to the current episode.',
  inputSchema: z.object({
    scenes: z.array(z.object({
      location: z.string(),
      // 场景时间是正式字段（Issue #21）：必填，时段只能写在这里，不能用 lighting 代替
      time: z.string().trim().min(1, 'time 必填：写具体时段（清晨/上午/正午/午后/黄昏/夜晚/深夜或剧本明确的时段），不能留空、不能只写进 lighting')
        .describe('Required time of day, e.g. 清晨/上午/正午/午后/黄昏/夜晚/深夜. Never empty; lighting must match it.'),
      prompt: z.string().optional(),
      description: z.string().optional(),
      lighting: z.string().optional(),
      // 背景信息载体（Issue #47）：旁白提到的异地事件/战场（如波尔塔瓦），本集不在那里拍
      exposition: z.boolean().optional()
        .describe('true = 背景信息载体：旁白提到但本集不在此处发生的地点/事件现场（如波尔塔瓦战场），只用来承载背景信息'),
    })),
  }),
  execute: async ({ scenes }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    const results = { created: 0, reused: 0 }
    logTaskProgress('ExtractTool', 'save-scenes-begin', {
      episodeId,
      dramaId,
      scenes: scenes.map(scene => `${scene.location}@${scene.time || ''}`).join(','),
    })

    for (const scene of scenes) {
      scene.location = normalizeAssetName(scene.location)
      if (!scene.location) {
        logTaskWarn('ExtractTool', 'save-scenes-skip-empty-location', { episodeId, dramaId })
        continue
      }
      // 按地点+时间段精确匹配；地点仅做空白/大小写归一化（不删括号，避免误合并）
      const scenesInProject = (await db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)))
        .filter(s => !s.deletedAt)
      const normLocation = normalizeLocation(scene.location)
      const existing = scenesInProject.find(s => s.location === scene.location && s.time === (scene.time || ''))
        || (normLocation ? scenesInProject.find(s => normalizeLocation(s.location) === normLocation && s.time === (scene.time || '')) : undefined)
      if (existing) {
        // 已存在完全匹配的场景：关联并补齐描述/光影
        await db.update(schema.scenes).set({
          prompt: scene.prompt || scene.description || existing.prompt,
          lighting: scene.lighting || existing.lighting,
          // 标记只加不减：已是背景信息载体的场景不会因为再次被普通提取碰到就降级
          exposition: scene.exposition === true || Number(existing.exposition) === 1 ? 1 : 0,
          updatedAt: ts,
        }).where(eq(schema.scenes.id, existing.id))
        await linkSceneToEpisode(episodeId, existing.id)
        await linkCitationsToAsset(episodeId, 'scene', scene.location, existing.id)
        results.reused++
      } else {
        const res = await db.insert(schema.scenes).values({
          dramaId,
          location: scene.location,
          time: scene.time || '',
          prompt: scene.prompt || scene.description || scene.location,
          lighting: scene.lighting || '',
          exposition: scene.exposition ? 1 : 0,
          createdAt: ts,
          updatedAt: ts,
        })
        const sceneId = getInsertId(res)
        await linkSceneToEpisode(episodeId, sceneId)
        await linkCitationsToAsset(episodeId, 'scene', scene.location, sceneId)
        results.created++
      }
    }

    // 近地点提示（Issue #15）：同一物理空间被按时段/机位拆成多个场景资产时，每个资产各自出图，
    // 画面就会每次不同。这里只**提示**互为前缀/包含关系的候选，不做任何自动合并。
    const finalScenes = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)))
      .filter(s => !s.deletedAt)
    const nearby: string[] = []
    for (const a of finalScenes) {
      for (const b of finalScenes) {
        if (a.id >= b.id) continue
        const na = normalizeLocation(a.location)
        const nb = normalizeLocation(b.location)
        if (!na || !nb || na === nb) continue
        if (!na.includes(nb) && !nb.includes(na)) continue
        nearby.push(`「${a.location}${a.time ? `·${a.time}` : ''}」与「${b.location}${b.time ? `·${b.time}` : ''}」可能是同一物理空间`)
      }
    }
    const payload = {
      message: `场景保存完成：新增 ${results.created}，复用已有 ${results.reused}`,
      ...results,
      near_location_hints: nearby,
      hint: nearby.length
        ? '以上地点疑似同一物理空间的不同子区域/时段。一个物理空间只建一个场景资产，子区域与时段靠分镜提示词表达；如确属不同空间可忽略本提示。'
        : '',
    }
    logTaskSuccess('ExtractTool', 'save-scenes-complete', { episodeId, ...results })
    return payload
  },
})

// 7. 读取项目中已存在的道具（用于去重判断）
const readExistingProps = createTool({
  id: 'read_existing_props',
  description: 'Read all props already existing in this drama project (for deduplication).',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const links = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))
    const linkedIds = new Set(links.map(link => link.propId))
    const props = (await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId)))
      .filter(p => !p.deletedAt)
    const visibleProps = props.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type || '',
      description: p.description || '',
      normalized_name: normalizeNearName(p.name), // 用于判断近名复用：括号定位/别名视为同名
    }))
    const payload = {
      count: visibleProps.length,
      props: visibleProps,
      current_episode_props: visibleProps.filter(p => linkedIds.has(p.id)),
    }
    logTaskSuccess('ExtractTool', 'read-props', {
      episodeId,
      dramaId,
      projectProps: payload.count,
      episodeProps: payload.current_episode_props.length,
    })
    return payload
  },
})

// 8. 智能保存道具（按名字去重，与现有数据合并）
const saveDedupProps = createTool({
  id: 'save_dedup_props',
  description: 'Save extracted props with deduplication. Existing props (same name) are merged/updated; new ones are created. All are linked to the current episode.',
  inputSchema: z.object({
    props: z.array(z.object({
      name: z.string(),
      type: z.string().optional(),
      description: z.string().optional(),
      // 背景信息载体（Issue #47）：旁白提到的组织/事件的视觉载体（近卫团旗、勋章、版画、文书）
      exposition: z.boolean().optional()
        .describe('true = 背景信息载体：旁白提到但本集不出场的组织/事件，用一件可画的器物或版画承载（会标在 type 上）'),
    })),
  }),
  execute: async ({ props }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    const results = { created: 0, merged: 0 }
    logTaskProgress('ExtractTool', 'save-props-begin', {
      episodeId,
      dramaId,
      names: props.map(prop => prop.name).join(','),
    })

    for (const prop of props) {
      prop.name = normalizeAssetName(prop.name)
      if (!prop.name) {
        logTaskWarn('ExtractTool', 'save-props-skip-empty-name', { episodeId, dramaId })
        continue
      }
      const propsInProject = (await db.select().from(schema.props)
        .where(eq(schema.props.dramaId, dramaId)))
        .filter(p => !p.deletedAt)
      const exact = propsInProject.find(p => p.name === prop.name)
      const normName = normalizeNearName(prop.name)
      const existing = exact || (normName ? propsInProject.find(p => p.name && normalizeNearName(p.name) === normName) : undefined)
      const matchedViaNorm = !!existing && existing !== exact

      if (existing) {
        // 归一化命中：括号定位/别名等近名视作同一道具复用
        if (matchedViaNorm) logTaskProgress('ExtractTool', 'save-props-reuse', { episodeId, dramaId, extracted: prop.name, reused: existing.name })
        // 已存在：合并信息，保留 ID；物品外貌变更后旧的最终提示词失效
        const expositionNow = prop.exposition === true || Number(existing.exposition) === 1
        await db.update(schema.props).set({
          type: expositionNow ? markExposition(prop.type || existing.type) : (prop.type || existing.type),
          description: prop.description || existing.description,
          finalPrompt: prop.description ? null : existing.finalPrompt,
          // 标记只加不减
          exposition: expositionNow ? 1 : 0,
          updatedAt: ts,
        }).where(eq(schema.props.id, existing.id))
        await linkPropToEpisode(episodeId, existing.id)
        await linkCitationsToAsset(episodeId, 'prop', prop.name, existing.id)
        results.merged++
      } else {
        const res = await db.insert(schema.props).values({
          name: prop.name,
          type: prop.exposition ? markExposition(prop.type) : (prop.type || ''),
          description: prop.description || '',
          dramaId,
          exposition: prop.exposition ? 1 : 0,
          createdAt: ts,
          updatedAt: ts,
        })
        const propId = getInsertId(res)
        await linkPropToEpisode(episodeId, propId)
        await linkCitationsToAsset(episodeId, 'prop', prop.name, propId)
        results.created++
      }
    }

    const payload = {
      message: `道具保存完成：新增 ${results.created}，合并更新 ${results.merged}`,
      ...results,
    }
    logTaskSuccess('ExtractTool', 'save-props-complete', { episodeId, ...results })
    return payload
  },
})

export const extractTools = {
  readScriptForExtraction,
  readExistingCharacters,
  readExistingScenes,
  readExistingProps,
  readCharacterRoster,
  saveCharacterRoster,
  saveDedupCharacters,
  saveDedupScenes,
  saveDedupProps,
}
