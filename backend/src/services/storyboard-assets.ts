/**
 * 分镜参考素材装配 — 关键帧生成与视频生成共用的唯一实现
 *
 * 顺序与前端预览一致：场景 → 角色（本集角色、排除旁白、按角色列表顺序）→ 道具；
 * 优先用分镜选定的素材版本（asset_version_selection），否则用素材当前成片图；去重后最多 9 张。
 * 提示词里的 @名字 按同一顺序替换为各模型的图片引用写法。
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/** 参考图上限（与前端面板、Seedance 多模态上限一致） */
const REF_IMAGE_LIMIT = 9

/** 旁白角色识别：提取产物中的旁白角色不参与画面生成（与前端 isNarratorCharacter 同口径） */
const NARRATOR_KEYWORDS = ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설']

type AssetKind = 'scene' | 'character' | 'prop'

export interface AssetRef {
  name: string
  url: string
}

function parseAssetVersionSelection(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function selectedAssetImage(
  selection: Record<string, string>,
  kind: AssetKind,
  item: { id: number; imageUrl: string | null } | null,
): string {
  if (!item) return ''
  return selection[`${kind}:${item.id}`] || item.imageUrl || ''
}

/**
 * 分镜绑定素材的参考图（场景 → 角色 → 道具），不含任何关键帧。
 * 调用方可在前面插入关键帧，再按最终顺序生成 @名字 的编号映射。
 */
export async function collectStoryboardAssetRefs(
  storyboard: typeof schema.storyboards.$inferSelect,
  episodeId: number,
): Promise<AssetRef[]> {
  const selection = parseAssetVersionSelection(storyboard.assetVersionSelection)

  // 与前端一致：场景取自本集已关联且未删除的场景列表，软删/解绑的场景不参与参考图与编号
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = sceneLinks.map(link => link.sceneId)
  const scene = storyboard.sceneId && episodeSceneIds.includes(storyboard.sceneId)
    ? (await db.select().from(schema.scenes).where(eq(schema.scenes.id, storyboard.sceneId)))
      .filter(row => !row.deletedAt)[0] ?? null
    : null

  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboard.id))
  const boundCharIds = charLinks.map(link => link.characterId)
  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  const characters = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)
    .filter(ch => !NARRATOR_KEYWORDS.some(keyword => `${ch.name || ''} ${ch.role || ''}`.toLowerCase().includes(keyword)))
    .filter(ch => boundCharIds.includes(ch.id))

  const propLinks = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboard.id))
  const boundPropIds = propLinks.map(link => link.propId)
  const episodePropLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = episodePropLinks.map(link => link.propId)
  const props = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)
    .filter(p => boundPropIds.includes(p.id))

  const refs: AssetRef[] = []
  refs.push({ name: scene?.location || '', url: selectedAssetImage(selection, 'scene', scene) })
  for (const char of characters) refs.push({ name: char.name || '', url: selectedAssetImage(selection, 'character', char) })
  for (const prop of props) refs.push({ name: prop.name || '', url: selectedAssetImage(selection, 'prop', prop) })
  return refs.filter(ref => !!ref.url)
}

/** 去重并截断到上限，同时给有名字的参考图编号（1 起，顺序即发送顺序） */
export function indexRefs(refs: AssetRef[]): { urls: string[]; nameToIndex: Record<string, number> } {
  const ordered: AssetRef[] = []
  for (const ref of refs) {
    if (!ref.url || ordered.length >= REF_IMAGE_LIMIT || ordered.some(item => item.url === ref.url)) continue
    ordered.push(ref)
  }
  const nameToIndex: Record<string, number> = {}
  ordered.forEach((ref, index) => {
    if (ref.name && !(ref.name in nameToIndex)) nameToIndex[ref.name] = index + 1
  })
  return { urls: ordered.map(ref => ref.url), nameToIndex }
}

/**
 * 把提示词里的 @名字 换成模型可识别的图片引用。
 * 名字按长度倒序匹配，避免“小明”抢在“小明妈妈”前面命中。
 */
export function resolvePromptRefs(
  prompt: string,
  nameToIndex: Record<string, number>,
  format: (index: number, name: string) => string,
): string {
  const names = Object.keys(nameToIndex).sort((a, b) => b.length - a.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@]+)/g, (match, raw: string) => {
    for (const name of names) {
      if (raw.startsWith(name)) return `${format(nameToIndex[name]!, name)}${raw.slice(name.length)}`
    }
    return match
  })
}

// ─── 提示词 @引用 ↔ 分镜绑定一致性（Issue #7）────────────────────────────

/** 参与一致性检查的提示词字段（关键帧三槽位 + 视频 + 承接镜头的开场转场） */
export type PromptField = 'first_frame_prompt' | 'mid_frame_prompt' | 'last_frame_prompt' | 'video_prompt'
  | 'transition_prompt'

export const PROMPT_FIELDS: PromptField[] = [
  'first_frame_prompt', 'mid_frame_prompt', 'last_frame_prompt', 'video_prompt', 'transition_prompt',
]

/** 关键帧槽位 → 对应提示词字段（槽位级问题过滤用） */
export const SLOT_PROMPT_FIELD: Record<'first' | 'mid' | 'last', PromptField> = {
  first: 'first_frame_prompt',
  mid: 'mid_frame_prompt',
  last: 'last_frame_prompt',
}

export type RefIssueCode =
  | 'missing_image' | 'unbound_mention' | 'scene_conflict' | 'unknown_mention'
  | 'unmentioned_binding' | 'over_capacity'

export interface RefIssue {
  code: RefIssueCode
  severity: 'block' | 'warn'
  /** 出现该问题的提示词字段；绑定级问题为空数组 */
  fields: PromptField[]
  kind?: AssetKind
  asset_id?: number
  name?: string
  /** 可直接展示的中文说明 */
  message: string
}

/** 本集资产（角色/道具/场景）的名字与可用图，用于解析 @引用 */
export interface EpisodeAssetEntry {
  kind: AssetKind
  id: number
  name: string
  /** 该分镜选定版本下的图片地址（空串 = 没有可用参考图） */
  imageUrl: string
}

const KIND_LABEL: Record<AssetKind, string> = { scene: '场景', character: '角色', prop: '道具' }

/**
 * 本集全部可被 @ 的资产（场景 → 角色 → 道具，顺序与参考图装配一致）。
 * `imageUrl` 按分镜的版本选择解析，因此需要分镜行。
 */
export async function loadEpisodeAssets(
  storyboard: typeof schema.storyboards.$inferSelect,
  episodeId: number,
): Promise<EpisodeAssetEntry[]> {
  const selection = parseAssetVersionSelection(storyboard.assetVersionSelection)

  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = sceneLinks.map(link => link.sceneId)
  const scenes = (await db.select().from(schema.scenes))
    .filter(row => episodeSceneIds.includes(row.id) && !row.deletedAt)

  const episodeCharIds = (await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))).map(link => link.characterId)
  const characters = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)
    .filter(ch => !NARRATOR_KEYWORDS.some(keyword => `${ch.name || ''} ${ch.role || ''}`.toLowerCase().includes(keyword)))

  const episodePropIds = (await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))).map(link => link.propId)
  const props = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)

  const entries: EpisodeAssetEntry[] = []
  for (const scene of scenes) {
    entries.push({ kind: 'scene', id: scene.id, name: (scene.location || '').trim(), imageUrl: selectedAssetImage(selection, 'scene', scene) })
  }
  for (const ch of characters) {
    entries.push({ kind: 'character', id: ch.id, name: (ch.name || '').trim(), imageUrl: selectedAssetImage(selection, 'character', ch) })
  }
  for (const prop of props) {
    entries.push({ kind: 'prop', id: prop.id, name: (prop.name || '').trim(), imageUrl: selectedAssetImage(selection, 'prop', prop) })
  }
  return entries.filter(entry => !!entry.name)
}

/** 分镜的 5 个提示词字段（已 trim） */
export function promptFieldsOf(storyboard: typeof schema.storyboards.$inferSelect): Record<PromptField, string> {
  return {
    first_frame_prompt: (storyboard.firstFramePrompt || '').trim(),
    mid_frame_prompt: (storyboard.midFramePrompt || '').trim(),
    last_frame_prompt: (storyboard.lastFramePrompt || '').trim(),
    video_prompt: (storyboard.videoPrompt || '').trim(),
    transition_prompt: (storyboard.transitionPrompt || '').trim(),
  }
}

/**
 * 解析一段提示词里的 @引用：按资产名**最长优先**匹配，匹配不上的记为未知引用。
 * 与 resolvePromptRefs 同口径（@ 后取到空白/下一个 @ 为止，再按名字前缀命中）。
 */
export function parseMentions(text: string, names: string[]): { matched: string[]; unknown: string[] } {
  const ordered = [...names].filter(Boolean).sort((a, b) => b.length - a.length)
  const matched: string[] = []
  const unknown: string[] = []
  for (const found of (text || '').matchAll(/@([^\s@]+)/g)) {
    const raw = found[1] || ''
    const hit = ordered.find(name => raw.startsWith(name))
    if (hit) {
      if (!matched.includes(hit)) matched.push(hit)
    } else if (raw && !unknown.includes(raw)) {
      unknown.push(raw)
    }
  }
  return { matched, unknown }
}

export interface RefCheckInput {
  prompts: Record<PromptField, string>
  assets: EpisodeAssetEntry[]
  sceneId: number | null
  characterIds: number[]
  propIds: number[]
}

export interface BindingSyncResult {
  characterIds: number[]
  propIds: number[]
  bound: Array<{ kind: AssetKind; id: number; name: string }>
  unbound: Array<{ kind: AssetKind; id: number; name: string }>
  /** 4 个提示词全空时不动绑定 */
  changed: boolean
}

/** 同名资产以第一个（场景 → 角色 → 道具）为准，与参考图编号同口径 */
function assetByName(assets: EpisodeAssetEntry[]): Map<string, EpisodeAssetEntry> {
  const map = new Map<string, EpisodeAssetEntry>()
  for (const asset of assets) if (!map.has(asset.name)) map.set(asset.name, asset)
  return map
}

/** 每个字段里 @ 到的本集资产 + 未知引用 */
function mentionsByField(
  prompts: Record<PromptField, string>,
  assets: EpisodeAssetEntry[],
): Record<PromptField, { matched: EpisodeAssetEntry[]; unknown: string[] }> {
  const byName = assetByName(assets)
  const names = [...byName.keys()]
  const result = {} as Record<PromptField, { matched: EpisodeAssetEntry[]; unknown: string[] }>
  for (const field of PROMPT_FIELDS) {
    const parsed = parseMentions(prompts[field] || '', names)
    result[field] = {
      matched: parsed.matched.map(name => byName.get(name)!),
      unknown: parsed.unknown,
    }
  }
  return result
}

/**
 * 绑定 = 4 个提示词里 @ 到的本集角色/道具的并集（场景不自动修改）。
 * 4 个提示词全空时保留现有绑定（拆分分镜产生的初始绑定供提示词生成参考）。
 */
export function computeBindingSync(input: RefCheckInput): BindingSyncResult {
  const unchanged: BindingSyncResult = {
    characterIds: [...input.characterIds], propIds: [...input.propIds], bound: [], unbound: [], changed: false,
  }
  if (!PROMPT_FIELDS.some(field => (input.prompts[field] || '').trim())) return unchanged

  const mentions = mentionsByField(input.prompts, input.assets)
  const mentioned = new Map<string, EpisodeAssetEntry>()
  for (const field of PROMPT_FIELDS) {
    for (const asset of mentions[field].matched) mentioned.set(`${asset.kind}:${asset.id}`, asset)
  }
  const wantedChars = [...mentioned.values()].filter(a => a.kind === 'character')
  const wantedProps = [...mentioned.values()].filter(a => a.kind === 'prop')

  const bound: BindingSyncResult['bound'] = []
  const unbound: BindingSyncResult['unbound'] = []
  for (const asset of [...wantedChars, ...wantedProps]) {
    const current = asset.kind === 'character' ? input.characterIds : input.propIds
    if (!current.includes(asset.id)) bound.push({ kind: asset.kind, id: asset.id, name: asset.name })
  }
  const byId = new Map(input.assets.map(asset => [`${asset.kind}:${asset.id}`, asset]))
  for (const id of input.characterIds) {
    if (!wantedChars.some(asset => asset.id === id)) {
      unbound.push({ kind: 'character', id, name: byId.get(`character:${id}`)?.name || `#${id}` })
    }
  }
  for (const id of input.propIds) {
    if (!wantedProps.some(asset => asset.id === id)) {
      unbound.push({ kind: 'prop', id, name: byId.get(`prop:${id}`)?.name || `#${id}` })
    }
  }
  return {
    characterIds: wantedChars.map(asset => asset.id),
    propIds: wantedProps.map(asset => asset.id),
    bound,
    unbound,
    changed: bound.length > 0 || unbound.length > 0,
  }
}

/** 一致性问题（纯函数，便于测试）：阻断 = missing_image / unbound_mention / scene_conflict / unknown_mention */
export function computeRefIssues(input: RefCheckInput): RefIssue[] {
  const mentions = mentionsByField(input.prompts, input.assets)
  const byId = new Map(input.assets.map(asset => [`${asset.kind}:${asset.id}`, asset]))
  const boundScene = input.sceneId != null ? byId.get(`scene:${input.sceneId}`) ?? null : null

  /** 同一问题在多个字段出现时合并，fields 累加 */
  const issues = new Map<string, RefIssue>()
  const add = (key: string, issue: RefIssue) => {
    const existing = issues.get(key)
    if (!existing) { issues.set(key, issue); return }
    for (const field of issue.fields) if (!existing.fields.includes(field)) existing.fields.push(field)
  }

  for (const field of PROMPT_FIELDS) {
    for (const raw of mentions[field].unknown) {
      add(`unknown_mention:${raw}`, {
        code: 'unknown_mention', severity: 'block', fields: [field], name: raw,
        message: `“@${raw}” 不是本集的角色/场景/道具，请改成本集资产或去掉 @`,
      })
    }
    for (const asset of mentions[field].matched) {
      const key = `${asset.kind}:${asset.id}`
      if (asset.kind === 'scene') {
        if (input.sceneId !== asset.id) {
          add(`scene_conflict:${key}`, {
            code: 'scene_conflict', severity: 'block', fields: [field], kind: 'scene', asset_id: asset.id, name: asset.name,
            message: boundScene
              ? `提示词 @了场景「${asset.name}」，但本镜绑定的场景是「${boundScene.name}」，请改提示词或改绑场景`
              : `提示词 @了场景「${asset.name}」，但本镜没有绑定场景，请先绑定该场景`,
          })
          continue
        }
        if (!asset.imageUrl) {
          add(`missing_image:${key}`, {
            code: 'missing_image', severity: 'block', fields: [field], kind: 'scene', asset_id: asset.id, name: asset.name,
            message: `@${asset.name} 还没有可用的场景图，请先生成场景图`,
          })
        }
        continue
      }
      const bound = asset.kind === 'character' ? input.characterIds.includes(asset.id) : input.propIds.includes(asset.id)
      if (!bound) {
        add(`unbound_mention:${key}`, {
          code: 'unbound_mention', severity: 'block', fields: [field], kind: asset.kind, asset_id: asset.id, name: asset.name,
          message: `@${asset.name} 没有绑定到本镜，生成时不会带上它的参考图，请重新绑定或去掉 @`,
        })
      } else if (!asset.imageUrl) {
        add(`missing_image:${key}`, {
          code: 'missing_image', severity: 'block', fields: [field], kind: asset.kind, asset_id: asset.id, name: asset.name,
          message: `@${asset.name} 还没有可用的${KIND_LABEL[asset.kind]}图，请先生成${KIND_LABEL[asset.kind]}图`,
        })
      }
    }
  }

  const anyPrompt = PROMPT_FIELDS.some(field => (input.prompts[field] || '').trim())
  const mentionedIds = new Set<string>()
  const mentionFields = new Map<string, PromptField[]>()
  for (const field of PROMPT_FIELDS) {
    for (const asset of mentions[field].matched) {
      const key = `${asset.kind}:${asset.id}`
      mentionedIds.add(key)
      mentionFields.set(key, [...(mentionFields.get(key) || []), field])
    }
  }

  // 已绑定但没有任何提示词 @ 它：下次保存提示词会被同步解绑
  if (anyPrompt) {
    for (const [kind, ids] of [['character', input.characterIds], ['prop', input.propIds]] as const) {
      for (const id of ids) {
        if (mentionedIds.has(`${kind}:${id}`)) continue
        const name = byId.get(`${kind}:${id}`)?.name || `#${id}`
        add(`unmentioned_binding:${kind}:${id}`, {
          code: 'unmentioned_binding', severity: 'warn', fields: [], kind, asset_id: id, name,
          message: `已绑定${KIND_LABEL[kind]}「${name}」但提示词里没有 @ 它，下次保存提示词会自动解绑`,
        })
      }
    }
  }

  // 装配上限：场景 → 角色 → 道具、按图片去重后最多 9 张（视频侧首帧关键帧先占 1 张）
  const orderedBound = input.assets.filter(asset => asset.kind === 'scene'
    ? asset.id === input.sceneId
    : (asset.kind === 'character' ? input.characterIds : input.propIds).includes(asset.id))
    .filter(asset => !!asset.imageUrl)
  const seen: string[] = []
  for (const asset of orderedBound) {
    if (!seen.includes(asset.imageUrl)) seen.push(asset.imageUrl)
    const position = seen.indexOf(asset.imageUrl) + 1
    const key = `${asset.kind}:${asset.id}`
    const fields = mentionFields.get(key) || []
    if (!fields.length) continue
    const overflowed: PromptField[] = []
    for (const field of fields) {
      // 视频侧（含转场段）首帧关键帧先占 1 张
      const limit = field === 'video_prompt' || field === 'transition_prompt' ? REF_IMAGE_LIMIT - 1 : REF_IMAGE_LIMIT
      if (position > limit) overflowed.push(field)
    }
    if (!overflowed.length) continue
    add(`over_capacity:${key}`, {
      code: 'over_capacity', severity: 'warn', fields: overflowed, kind: asset.kind, asset_id: asset.id, name: asset.name,
      message: `参考图最多 ${REF_IMAGE_LIMIT} 张，@${asset.name} 被截断，本次生成不会带上它的参考图`,
    })
  }

  return [...issues.values()]
}

/** 当前分镜绑定（角色/道具 id） */
async function loadBindings(storyboardId: number): Promise<{ characterIds: number[]; propIds: number[] }> {
  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const propLinks = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return { characterIds: charLinks.map(l => l.characterId), propIds: propLinks.map(l => l.propId) }
}

/** 分镜当前的一致性问题（读库版本） */
export async function checkStoryboardRefs(
  storyboard: typeof schema.storyboards.$inferSelect,
  assets?: EpisodeAssetEntry[],
): Promise<RefIssue[]> {
  const list = assets ?? await loadEpisodeAssets(storyboard, storyboard.episodeId)
  const bindings = await loadBindings(storyboard.id)
  return computeRefIssues({
    prompts: promptFieldsOf(storyboard),
    assets: list,
    sceneId: storyboard.sceneId ?? null,
    characterIds: bindings.characterIds,
    propIds: bindings.propIds,
  })
}

/**
 * 提示词写入后把角色/道具绑定同步成 @引用 的并集（写库），返回同步结果与最新问题列表。
 * 调用方必须在提示词已落库之后调用。
 */
export async function syncStoryboardBindingsFromPrompts(
  storyboardId: number,
): Promise<{ sync: BindingSyncResult; issues: RefIssue[]; characterIds: number[]; propIds: number[] }> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard) throw new Error('镜头不存在')
  const assets = await loadEpisodeAssets(storyboard, storyboard.episodeId)
  const bindings = await loadBindings(storyboardId)
  const input: RefCheckInput = {
    prompts: promptFieldsOf(storyboard),
    assets,
    sceneId: storyboard.sceneId ?? null,
    characterIds: bindings.characterIds,
    propIds: bindings.propIds,
  }
  const sync = computeBindingSync(input)
  if (sync.changed) {
    for (const item of sync.bound) {
      if (item.kind === 'character') {
        await db.insert(schema.storyboardCharacters).values({ storyboardId, characterId: item.id })
      } else {
        await db.insert(schema.storyboardProps).values({ storyboardId, propId: item.id })
      }
    }
    for (const item of sync.unbound) {
      if (item.kind === 'character') {
        await db.delete(schema.storyboardCharacters)
          .where(and(eq(schema.storyboardCharacters.storyboardId, storyboardId), eq(schema.storyboardCharacters.characterId, item.id)))
      } else {
        await db.delete(schema.storyboardProps)
          .where(and(eq(schema.storyboardProps.storyboardId, storyboardId), eq(schema.storyboardProps.propId, item.id)))
      }
    }
  }
  const issues = computeRefIssues({ ...input, characterIds: sync.characterIds, propIds: sync.propIds })
  return { sync, issues, characterIds: sync.characterIds, propIds: sync.propIds }
}

/** 某个提示词字段相关的阻断问题（字段级 + 绑定级） */
export function blockingIssuesFor(issues: RefIssue[], field: PromptField): RefIssue[] {
  return issues.filter(issue => issue.severity === 'block'
    && (issue.fields.length === 0 || issue.fields.includes(field)))
}

/** 拼成可直接返回给用户的一句话（400 文案） */
export function describeIssues(issues: RefIssue[]): string {
  return issues.map(issue => issue.message).join('；')
}
