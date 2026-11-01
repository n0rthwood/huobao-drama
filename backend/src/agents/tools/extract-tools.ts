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
import { getDramaId, getEpisodeId, getGenreRuleset } from '../context.js'
import { parseStylingVersion, saveStylingVersion } from '../../services/styling-version.js'
import { normalizeAssetName, normalizeNearName } from '../../services/asset-name.js'
import { linkCitationsToAsset } from '../../services/research-citations.js'
import {
  ROSTER_NO_TASK_MESSAGE,
  ROSTER_REQUIRED_MESSAGE,
  diffRosterAgainstSaved,
  loadEpisodeRoster,
  saveEpisodeRoster,
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

// 4. 登记选角名单（仅纪录片规则集）
// 为什么单独一步：同一份剧本连跑三次得到 14 / 11 / 8 个角色——模型在写保存参数时
// 「顺带」决定了谁该建卡，名单从没被写下来，于是每次漏的人都不一样。先登记、后保存，
// 名单落在本次提取任务的 params 上，人在任务详情里看得见，代码也能对账。
const saveCharacterRoster = createTool({
  id: 'save_character_roster',
  description: 'Documentary extraction only, and it must run BEFORE save_dedup_characters. Walk the script from the first line to the last and register every person who qualifies under the "who gets a card" rule of the documentary-extraction skill, in script order. The roster is the contract for this run: every member must end up as a character card and nobody outside it may be saved. Calling it again ADDS the people you missed (it never drops anyone already registered), so register the full cast in one call and only re-call to append.',
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
    // 非纪录片项目不走名单流程：这里只拒绝，不改变 save_dedup_characters 的任何行为
    if (getGenreRuleset(context?.requestContext) !== 'documentary') {
      return { error: '选角名单只用于纪录片题材的提取；当前项目不是纪录片规则集，请直接调用 save_dedup_characters。' }
    }
    const saved = await saveEpisodeRoster(episodeId, cast)
    if (!saved) return { error: ROSTER_NO_TASK_MESSAGE }
    logTaskSuccess('ExtractTool', 'save-character-roster', {
      episodeId,
      dramaId,
      count: saved.cast.length,
      added: saved.added.join(',') || undefined,
      merged_aliases: saved.merged.join(',') || undefined,
      // 名单一行一行进成功日志：人在任务日志里就能看清谁按哪条规则入选
      cast: saved.cast.map(entry => `${entry.name}（${entry.reason || '未写入选理由'}）`).join('，'),
    })
    // 名单全文进任务日志：人要能看见「谁、凭哪句话、按哪条规则」入选
    logTaskPayload('ExtractTool', 'character-roster', saved.cast)
    return {
      message: `选角名单已登记：共 ${saved.cast.length} 人（本次新增 ${saved.added.length}）。接下来 save_dedup_characters 必须把名单上的每一个人都建卡，名单之外的人不要建卡。`,
      count: saved.cast.length,
      cast: saved.cast,
      added: saved.added,
      // 按近名/别名并入前一条的写法（同一个人不会出两张卡）
      merged_aliases: saved.merged,
      // 规范化后为空、无法作为角色卡名字的条目
      skipped_names: saved.skipped,
    }
  },
})

// 名单对账（纪录片）：本集已有的角色卡 vs 名单 → 缺谁；本次保存的名字 vs 名单 → 多了谁。
// 结果进工具返回值，模型据此补调一次 save_dedup_characters；这不是异常，提取任务不会因此失败。
async function rosterReport(episodeId: number, cast: RosterEntry[], savedNames: string[]) {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const linkedIds = new Set(links.map(link => link.characterId))
  const inEpisode = (await db.select().from(schema.characters))
    .filter(c => !c.deletedAt && linkedIds.has(c.id))
    .map(c => c.name || '')
  const rosterNames = cast.map(entry => entry.name)
  const { missing_from_roster } = diffRosterAgainstSaved(rosterNames, inEpisode)
  const { not_in_roster } = diffRosterAgainstSaved(rosterNames, savedNames)
  const parts = missing_from_roster.length
    ? [`名单上还有 ${missing_from_roster.length} 人没有角色卡：${missing_from_roster.join('、')}。请立刻再次调用 save_dedup_characters，只传这些人，把他们补齐。`]
    : [`名单上的 ${rosterNames.length} 人已全部建卡。`]
  if (not_in_roster.length) {
    parts.push(`本次保存的「${not_in_roster.join('、')}」不在名单上：确实符合「谁该建卡」就先调用 save_character_roster 补登记，否则不应建卡。`)
  }
  return {
    roster_total: rosterNames.length,
    missing_from_roster,
    not_in_roster,
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
    })),
  }),
  execute: async ({ characters }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    // 纪录片规则集：建卡名单是本次运行的契约，没登记名单就不许写库（Issue #32）。
    // 这里返回的是**工具结果**不是异常：模型读到后补调 save_character_roster 即可自行纠正，整个提取任务不失败。
    // 非纪录片项目 roster 恒为 null，下面的所有名单逻辑都不执行，行为与改造前逐字一致。
    const documentary = getGenreRuleset(context?.requestContext) === 'documentary'
    const roster = documentary ? await loadEpisodeRoster(episodeId) : null
    if (documentary && (!roster || !roster.cast)) {
      const error = roster ? ROSTER_REQUIRED_MESSAGE : ROSTER_NO_TASK_MESSAGE
      logTaskWarn('ExtractTool', 'save-characters-roster-missing', { episodeId, dramaId, hasTask: !!roster })
      return { error, saved: 0 }
    }
    const ts = now()
    const results = { created: 0, merged: 0, styling_versions: 0 }
    // 合并时被忽略的改写：基础形象一旦有值就不再被单集提取覆盖，这里如实回报给 Agent
    const ignored: string[] = []
    const stylingVersions: string[] = []
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
        await db.update(schema.characters).set({
          role: existing.role || char.role || '',
          description: existing.description || char.description || '',
          appearance: existing.appearance || char.appearance || '',
          styling: existing.styling || char.styling || char.description || '',
          updatedAt: ts,
        }).where(eq(schema.characters.id, existing.id))
        await linkCharToEpisode(episodeId, existing.id)
        charId = existing.id
        results.merged++
      } else {
        // 新增角色
        const res = await db.insert(schema.characters).values({
          name: char.name,
          role: char.role || '',
          description: char.description || '',
          appearance: char.appearance || '',
          styling: char.styling || char.description || '',
          dramaId,
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
      ...(roster?.cast ? await rosterReport(episodeId, roster.cast, characters.map(char => char.name)) : {}),
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
        await db.update(schema.props).set({
          type: prop.type || existing.type,
          description: prop.description || existing.description,
          finalPrompt: prop.description ? null : existing.finalPrompt,
          updatedAt: ts,
        }).where(eq(schema.props.id, existing.id))
        await linkPropToEpisode(episodeId, existing.id)
        await linkCitationsToAsset(episodeId, 'prop', prop.name, existing.id)
        results.merged++
      } else {
        const res = await db.insert(schema.props).values({
          name: prop.name,
          type: prop.type || '',
          description: prop.description || '',
          dramaId,
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
  saveCharacterRoster,
  saveDedupCharacters,
  saveDedupScenes,
  saveDedupProps,
}
