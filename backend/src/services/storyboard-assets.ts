/**
 * 参考素材绑定与装配 — 关键帧生成与视频生成共用的唯一实现（Issue #18）
 *
 * 绑定以「生成目标」为主体：首帧 / 中间帧 / 尾帧 / 视频各自一份（storyboard_target_assets），
 * = 该目标提示词里 @ 到的本集场景/角色/道具，提示词写入后自动重算，不提供手动增删。
 * 每个目标上的资产可单独选版（selected_image），未选时 = 本集造型图（角色）> 资产当前图。
 *
 * 分镜级绑定（storyboards.scene_id + storyboard_characters/props）保留为「本镜资产池」：
 * 5 个提示词 @ 的并集，供 @ 候选、拆分分镜初始绑定与提示词/转场生成上下文使用，不参与发图。
 *
 * 装配顺序：场景 → 角色（本集角色、排除旁白、按角色列表顺序）→ 道具；按图片去重后最多 9 张，
 * 提示词里的 @名字 按同一顺序替换为各模型的图片引用写法。
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { parseStylingVersion } from './styling-version.js'

/** 参考图上限（与前端面板、Seedance 多模态上限一致） */
const REF_IMAGE_LIMIT = 9

/** 旁白角色识别：提取产物中的旁白角色不参与画面生成（与前端 isNarratorCharacter 同口径） */
const NARRATOR_KEYWORDS = ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설']

export type AssetKind = 'scene' | 'character' | 'prop'

const KIND_ORDER: Record<AssetKind, number> = { scene: 0, character: 1, prop: 2 }
const KIND_LABEL: Record<AssetKind, string> = { scene: '场景', character: '角色', prop: '道具' }

export interface AssetRef {
  name: string
  url: string
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

// ─── 提示词字段与生成目标 ────────────────────────────────────────────

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

/** 生成目标：三张关键帧 + 视频 */
export type BindingTarget = 'first' | 'mid' | 'last' | 'video'

export const BINDING_TARGETS: BindingTarget[] = ['first', 'mid', 'last', 'video']

/** 目标 → 决定其绑定的提示词字段；转场段拼在视频提示词前一起提交，所以归视频 */
export const TARGET_PROMPT_FIELDS: Record<BindingTarget, PromptField[]> = {
  first: ['first_frame_prompt'],
  mid: ['mid_frame_prompt'],
  last: ['last_frame_prompt'],
  video: ['video_prompt', 'transition_prompt'],
}

const FIELD_TARGET: Record<PromptField, BindingTarget> = {
  first_frame_prompt: 'first',
  mid_frame_prompt: 'mid',
  last_frame_prompt: 'last',
  video_prompt: 'video',
  transition_prompt: 'video',
}

const TARGET_LABEL: Record<BindingTarget, string> = { first: '首帧', mid: '中间帧', last: '尾帧', video: '视频' }

export function isBindingTarget(value: unknown): value is BindingTarget {
  return typeof value === 'string' && (BINDING_TARGETS as string[]).includes(value)
}

/** 写入了哪些提示词字段 → 需要重算哪些目标 */
export function targetsOfFields(fields: readonly string[]): BindingTarget[] {
  const targets: BindingTarget[] = []
  for (const field of fields) {
    const target = FIELD_TARGET[field as PromptField]
    if (target && !targets.includes(target)) targets.push(target)
  }
  return targets
}

export type RefIssueCode =
  | 'missing_image' | 'unbound_mention' | 'unknown_mention'
  | 'unmentioned_binding' | 'over_capacity'
  // Issue #15：视频提示词为空（阻断生成）与肢体风险（仅警告，不阻断）
  | 'empty_video_prompt' | 'limb_risk'

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

// ─── 本集资产 ────────────────────────────────────────────────────────

/** 本集资产（角色/道具/场景）的名字与默认参考图，用于解析 @引用 */
export interface EpisodeAssetEntry {
  kind: AssetKind
  id: number
  name: string
  /** 未选版时使用的图片：角色 = 本集造型图 > 当前成片图；场景/道具 = 当前成片图（空串 = 没有可用图） */
  defaultImage: string
}

/** 本集全部可被 @ 的资产（场景 → 角色 → 道具，顺序即参考图装配顺序） */
export async function loadEpisodeAssets(episodeId: number): Promise<EpisodeAssetEntry[]> {
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = sceneLinks.map(link => link.sceneId)
  const scenes = (await db.select().from(schema.scenes))
    .filter(row => episodeSceneIds.includes(row.id) && !row.deletedAt)

  const episodeCharLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharIds = episodeCharLinks.map(link => link.characterId)
  // 本集造型版本（Issue #15）：没有人工选版时默认用造型图
  const costumeImages = new Map<number, string>()
  for (const link of episodeCharLinks) {
    const image = parseStylingVersion(link.stylingVersion)?.image_path
    if (image) costumeImages.set(link.characterId, image)
  }
  const characters = (await db.select().from(schema.characters))
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)
    .filter(ch => !NARRATOR_KEYWORDS.some(keyword => `${ch.name || ''} ${ch.role || ''}`.toLowerCase().includes(keyword)))

  const episodePropIds = (await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))).map(link => link.propId)
  const props = (await db.select().from(schema.props))
    .filter(p => episodePropIds.includes(p.id) && !p.deletedAt)

  const entries: EpisodeAssetEntry[] = []
  for (const scene of scenes) {
    entries.push({ kind: 'scene', id: scene.id, name: (scene.location || '').trim(), defaultImage: scene.imageUrl || '' })
  }
  for (const ch of characters) {
    entries.push({ kind: 'character', id: ch.id, name: (ch.name || '').trim(), defaultImage: costumeImages.get(ch.id) || ch.imageUrl || '' })
  }
  for (const prop of props) {
    entries.push({ kind: 'prop', id: prop.id, name: (prop.name || '').trim(), defaultImage: prop.imageUrl || '' })
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

const assetKey = (kind: string, id: number) => `${kind}:${id}`

// ─── 生成目标级绑定 ──────────────────────────────────────────────────

export interface TargetBinding {
  kind: AssetKind
  assetId: number
  /** 人工选版；null = 默认图 */
  selectedImage: string | null
}

export type TargetBindings = Record<BindingTarget, TargetBinding[]>

/** 已绑定资产在本集资产里的条目（按装配顺序）；已删除/已解除本集关联/旁白的绑定不参与 */
function boundEntries(assets: EpisodeAssetEntry[], bindings: TargetBinding[]): Array<{ asset: EpisodeAssetEntry; image: string; binding: TargetBinding }> {
  const order = new Map(assets.map((asset, index) => [assetKey(asset.kind, asset.id), index]))
  const byKey = new Map(assets.map(asset => [assetKey(asset.kind, asset.id), asset]))
  return bindings
    .filter(binding => byKey.has(assetKey(binding.kind, binding.assetId)))
    .sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      || (order.get(assetKey(a.kind, a.assetId))! - order.get(assetKey(b.kind, b.assetId))!))
    .map(binding => {
      const asset = byKey.get(assetKey(binding.kind, binding.assetId))!
      return { asset, binding, image: binding.selectedImage || asset.defaultImage }
    })
}

/** 某个目标的参考素材（场景 → 角色 → 道具，不含关键帧），调用方可在前面插入关键帧后再 indexRefs */
export function targetAssetRefs(assets: EpisodeAssetEntry[], bindings: TargetBinding[]): AssetRef[] {
  return boundEntries(assets, bindings)
    .filter(entry => !!entry.image)
    .map(entry => ({ name: entry.asset.name, url: entry.image }))
}

export interface TargetAssetJson {
  kind: AssetKind
  asset_id: number
  name: string
  /** 实际发送的图片（空串 = 没有可用图） */
  image: string
  selected_image: string | null
  default_image: string
  /** 在实际发送的参考图里的编号（1 起；视频的 1 号是首帧关键帧）；null = 无图 / 去重 / 超上限 */
  ref_no: number | null
}

/** 前端展示用：各目标的绑定，顺序 = 发送顺序 */
export function targetAssetsJson(assets: EpisodeAssetEntry[], bindings: TargetBindings): Record<BindingTarget, TargetAssetJson[]> {
  const result = {} as Record<BindingTarget, TargetAssetJson[]>
  for (const target of BINDING_TARGETS) {
    const entries = boundEntries(assets, bindings[target] || [])
    // 视频参考图第 1 张固定是首帧关键帧（视频生成要求首帧已就绪）
    const lead: AssetRef[] = target === 'video' ? [{ name: '', url: '\u0000first-keyframe' }] : []
    const { urls } = indexRefs([...lead, ...entries.map(entry => ({ name: entry.asset.name, url: entry.image }))])
    result[target] = entries.map(entry => {
      const position = entry.image ? urls.indexOf(entry.image) : -1
      return {
        kind: entry.asset.kind,
        asset_id: entry.asset.id,
        name: entry.asset.name,
        image: entry.image,
        selected_image: entry.binding.selectedImage,
        default_image: entry.asset.defaultImage,
        ref_no: position >= 0 ? position + 1 : null,
      }
    })
  }
  return result
}

export async function loadTargetBindings(storyboardId: number): Promise<TargetBindings> {
  const rows = await db.select().from(schema.storyboardTargetAssets)
    .where(eq(schema.storyboardTargetAssets.storyboardId, storyboardId))
  const result: TargetBindings = { first: [], mid: [], last: [], video: [] }
  for (const row of rows) {
    if (!isBindingTarget(row.target)) continue
    result[row.target].push({ kind: row.kind as AssetKind, assetId: row.assetId, selectedImage: row.selectedImage || null })
  }
  return result
}

/** 目标的期望绑定 = 该目标各字段 @ 到的本集资产（按装配顺序） */
function wantedForTarget(
  target: BindingTarget,
  mentions: Record<PromptField, { matched: EpisodeAssetEntry[] }>,
): EpisodeAssetEntry[] {
  const wanted = new Map<string, EpisodeAssetEntry>()
  for (const field of TARGET_PROMPT_FIELDS[target]) {
    for (const asset of mentions[field].matched) wanted.set(assetKey(asset.kind, asset.id), asset)
  }
  return [...wanted.values()]
}

export interface TargetSyncPlan {
  target: BindingTarget
  add: Array<{ kind: AssetKind; id: number; name: string }>
  remove: Array<{ kind: AssetKind; id: number; name: string }>
}

/**
 * 目标级绑定重算（纯函数）：绑定 = 该目标提示词 @ 到的资产；仍被 @ 的保留原选版，
 * 不再 @ 的解绑，提示词为空则清空。只算传入的目标，其他目标不动。
 */
export function computeTargetSync(
  prompts: Record<PromptField, string>,
  assets: EpisodeAssetEntry[],
  bindings: TargetBindings,
  targets: BindingTarget[],
): TargetSyncPlan[] {
  const mentions = mentionsByField(prompts, assets)
  const byKey = new Map(assets.map(asset => [assetKey(asset.kind, asset.id), asset]))
  return targets.map(target => {
    const wanted = wantedForTarget(target, mentions)
    const current = bindings[target] || []
    const currentKeys = new Set(current.map(binding => assetKey(binding.kind, binding.assetId)))
    const wantedKeys = new Set(wanted.map(asset => assetKey(asset.kind, asset.id)))
    return {
      target,
      add: wanted.filter(asset => !currentKeys.has(assetKey(asset.kind, asset.id)))
        .map(asset => ({ kind: asset.kind, id: asset.id, name: asset.name })),
      remove: current.filter(binding => !wantedKeys.has(assetKey(binding.kind, binding.assetId)))
        .map(binding => ({
          kind: binding.kind,
          id: binding.assetId,
          name: byKey.get(assetKey(binding.kind, binding.assetId))?.name || `#${binding.assetId}`,
        })),
    }
  })
}

// ─── 本镜资产池（分镜级） ────────────────────────────────────────────

export interface PoolSyncInput {
  prompts: Record<PromptField, string>
  assets: EpisodeAssetEntry[]
  characterIds: number[]
  propIds: number[]
}

export interface BindingSyncResult {
  characterIds: number[]
  propIds: number[]
  bound: Array<{ kind: AssetKind; id: number; name: string }>
  unbound: Array<{ kind: AssetKind; id: number; name: string }>
  /** 5 个提示词全空时不动资产池 */
  changed: boolean
}

/**
 * 资产池 = 5 个提示词里 @ 到的本集角色/道具的并集（场景不自动修改）。
 * 提示词全空时保留现有资产池（拆分分镜产生的初始绑定供提示词生成参考）。
 */
export function computeBindingSync(input: PoolSyncInput): BindingSyncResult {
  const unchanged: BindingSyncResult = {
    characterIds: [...input.characterIds], propIds: [...input.propIds], bound: [], unbound: [], changed: false,
  }
  if (!PROMPT_FIELDS.some(field => (input.prompts[field] || '').trim())) return unchanged

  const mentions = mentionsByField(input.prompts, input.assets)
  const mentioned = new Map<string, EpisodeAssetEntry>()
  for (const field of PROMPT_FIELDS) {
    for (const asset of mentions[field].matched) mentioned.set(assetKey(asset.kind, asset.id), asset)
  }
  const wantedChars = [...mentioned.values()].filter(a => a.kind === 'character')
  const wantedProps = [...mentioned.values()].filter(a => a.kind === 'prop')

  const bound: BindingSyncResult['bound'] = []
  const unbound: BindingSyncResult['unbound'] = []
  for (const asset of [...wantedChars, ...wantedProps]) {
    const current = asset.kind === 'character' ? input.characterIds : input.propIds
    if (!current.includes(asset.id)) bound.push({ kind: asset.kind, id: asset.id, name: asset.name })
  }
  const byId = new Map(input.assets.map(asset => [assetKey(asset.kind, asset.id), asset]))
  for (const id of input.characterIds) {
    if (!wantedChars.some(asset => asset.id === id)) {
      unbound.push({ kind: 'character', id, name: byId.get(assetKey('character', id))?.name || `#${id}` })
    }
  }
  for (const id of input.propIds) {
    if (!wantedProps.some(asset => asset.id === id)) {
      unbound.push({ kind: 'prop', id, name: byId.get(assetKey('prop', id))?.name || `#${id}` })
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

// ─── 一致性问题 ──────────────────────────────────────────────────────

/**
 * 肢体风险 lint（Issue #15，**仅警告，永不阻断生成**）
 *
 * 线上实证：猴宝宝 3 条腿、鼠妈妈 3 只手，对应的提示词里要么没写四肢去向，
 * 要么写了「不要搞成 3 条腿」这类负向指令（生成模型不认负向）。
 * 这里按 video-prompt / keyframe-prompt 技能里的写法规则做机械检查，提醒改写。
 */
/** 负向肢体指令：模型不认，必须改成正向完整枚举 */
const NEGATIVE_LIMB_PATTERN = /(不要|不能|避免|别|禁止|no\s|avoid\s)[^，。；\n]{0,12}(腿|手|爪|肢|臂|脚)/
/** 高风险姿态/构图（Fabel 阶段 A 清单）：易出多肢、融肢、角色复制，必须逐肢写明终态 */
const RISKY_POSE_WORDS = [
  '盘腿', '盘坐', '盘起', '蹲', '抠', '转身', '二郎腿', '翘腿', '单腿', '递', '接', '抱',
  '镜子', '镜面', '倒影', '反打', '镜中', '穿衣镜', '背对', '抱膝',
]
/** 四肢状态词：出现任一即视为写明了四肢去向 */
const LIMB_STATE_WORDS = [
  '双手', '左手', '右手', '双臂', '左臂', '右臂', '双腿', '左腿', '右腿',
  '双脚', '脚掌', '双爪', '前爪', '后腿', '手中', '手里', '手上',
]

export function limbRiskIssues(prompts: Record<PromptField, string>): RefIssue[] {
  const issues: RefIssue[] = []
  for (const field of PROMPT_FIELDS) {
    const text = (prompts[field] || '').trim()
    if (!text) continue
    if (NEGATIVE_LIMB_PATTERN.test(text)) {
      issues.push({
        code: 'limb_risk', severity: 'warn', fields: [field],
        message: `${field} 里有「不要/避免 + 肢体」的负向写法，生成模型不认；请改成正向完整枚举（例如「双腿向身前收拢盘起，双脚收于身下，双手抱膝」）`,
      })
    }
    const risky = RISKY_POSE_WORDS.filter(word => text.includes(word))
    if (!risky.length) continue
    // 视频提示词逐段检查，关键帧提示词整体检查
    const segments = field === 'video_prompt'
      ? text.split('\n').map(line => line.trim()).filter(Boolean)
      : [text]
    const bad = segments.filter(seg => RISKY_POSE_WORDS.some(word => seg.includes(word))
      && !LIMB_STATE_WORDS.some(word => seg.includes(word)))
    if (!bad.length) continue
    issues.push({
      code: 'limb_risk', severity: 'warn', fields: [field],
      message: `${field} 出现高风险姿态（${risky.join('、')}）但${field === 'video_prompt' ? `有 ${bad.length} 段` : ''}没有写明四肢状态，容易画出多肢/缺肢；请逐段写明双手（含持物在哪只手）与双腿的姿态`,
    })
  }
  return issues
}

export interface RefCheckInput {
  prompts: Record<PromptField, string>
  assets: EpisodeAssetEntry[]
  bindings: TargetBindings
}

/**
 * 一致性问题（纯函数，按生成目标判定）：
 * 阻断 = unknown_mention / unbound_mention / missing_image / empty_video_prompt；
 * 警告 = unmentioned_binding / over_capacity / limb_risk。
 */
export function computeRefIssues(input: RefCheckInput): RefIssue[] {
  const mentions = mentionsByField(input.prompts, input.assets)
  const byKey = new Map(input.assets.map(asset => [assetKey(asset.kind, asset.id), asset]))

  /** 同一问题在多个字段出现时合并，fields 累加 */
  const issues = new Map<string, RefIssue>()
  const add = (key: string, issue: RefIssue) => {
    const existing = issues.get(key)
    if (!existing) { issues.set(key, issue); return }
    for (const field of issue.fields) if (!existing.fields.includes(field)) existing.fields.push(field)
  }

  for (const target of BINDING_TARGETS) {
    const bindings = input.bindings[target] || []
    const bindingOf = new Map(bindings.map(binding => [assetKey(binding.kind, binding.assetId), binding]))
    const label = TARGET_LABEL[target]

    for (const field of TARGET_PROMPT_FIELDS[target]) {
      for (const raw of mentions[field].unknown) {
        add(`unknown_mention:${raw}`, {
          code: 'unknown_mention', severity: 'block', fields: [field], name: raw,
          message: `“@${raw}” 不是本集的角色/场景/道具，请改成本集资产或去掉 @`,
        })
      }
      for (const asset of mentions[field].matched) {
        const key = assetKey(asset.kind, asset.id)
        const binding = bindingOf.get(key)
        if (!binding) {
          add(`unbound_mention:${target}:${key}`, {
            code: 'unbound_mention', severity: 'block', fields: [field], kind: asset.kind, asset_id: asset.id, name: asset.name,
            message: `@${asset.name} 还没有绑定到${label}，生成时不会带上它的参考图；重新保存${label}提示词即可按 @ 自动绑定`,
          })
        } else if (!(binding.selectedImage || asset.defaultImage)) {
          add(`missing_image:${key}`, {
            code: 'missing_image', severity: 'block', fields: [field], kind: asset.kind, asset_id: asset.id, name: asset.name,
            message: `@${asset.name} 还没有可用的${KIND_LABEL[asset.kind]}图，请先生成${KIND_LABEL[asset.kind]}图`,
          })
        }
      }
    }

    // 绑定了但该目标提示词没有 @ 它（存量继承的分镜绑定）：仍会被发送，下次保存该目标提示词时解绑
    const fields = TARGET_PROMPT_FIELDS[target]
    const hasPrompt = fields.some(field => (input.prompts[field] || '').trim())
    if (hasPrompt) {
      const mentioned = new Set(wantedForTarget(target, mentions).map(asset => assetKey(asset.kind, asset.id)))
      for (const binding of bindings) {
        const key = assetKey(binding.kind, binding.assetId)
        const asset = byKey.get(key)
        if (!asset || mentioned.has(key)) continue
        add(`unmentioned_binding:${target}:${key}`, {
          code: 'unmentioned_binding', severity: 'warn', fields: [fields[0]!], kind: asset.kind, asset_id: asset.id, name: asset.name,
          message: `${label}绑定了${KIND_LABEL[asset.kind]}「${asset.name}」但${label}提示词没有 @ 它，生成时仍会发送它的参考图；保存一次${label}提示词即按 @ 自动解绑`,
        })
      }
    }

    // 装配上限：按图片去重后最多 9 张（视频侧首帧关键帧先占 1 张）
    const limit = target === 'video' ? REF_IMAGE_LIMIT - 1 : REF_IMAGE_LIMIT
    const seen: string[] = []
    for (const entry of boundEntries(input.assets, bindings)) {
      if (!entry.image) continue
      if (!seen.includes(entry.image)) seen.push(entry.image)
      if (seen.indexOf(entry.image) + 1 <= limit) continue
      const key = assetKey(entry.asset.kind, entry.asset.id)
      const overflowed = fields.filter(field => mentions[field].matched.some(asset => assetKey(asset.kind, asset.id) === key))
      if (!overflowed.length) continue
      add(`over_capacity:${target}:${key}`, {
        code: 'over_capacity', severity: 'warn', fields: overflowed, kind: entry.asset.kind, asset_id: entry.asset.id, name: entry.asset.name,
        message: `${label}参考图最多 ${REF_IMAGE_LIMIT} 张${target === 'video' ? '（首帧占 1 张）' : ''}，@${entry.asset.name} 被截断，本次生成不会带上它的参考图`,
      })
    }
  }

  // 分镜完整性（Issue #15）：video_prompt 为空直接阻断视频生成——线上 E3#5 就是空提示词
  // 却仍可提交，结果画面完全由参考图随机决定。
  if (!(input.prompts.video_prompt || '').trim()) {
    add('empty_video_prompt', {
      code: 'empty_video_prompt', severity: 'block', fields: ['video_prompt'],
      message: '视频提示词为空，请先生成或填写 video_prompt 再生成视频',
    })
  }

  // 肢体风险：只警告，不进 blockingIssuesFor
  for (const issue of limbRiskIssues(input.prompts)) {
    add(`${issue.code}:${issue.fields.join(',')}:${issue.message}`, issue)
  }

  return [...issues.values()]
}

/** 分镜当前的一致性问题（读库版本） */
export async function checkStoryboardRefs(
  storyboard: typeof schema.storyboards.$inferSelect,
  assets?: EpisodeAssetEntry[],
): Promise<RefIssue[]> {
  return computeRefIssues({
    prompts: promptFieldsOf(storyboard),
    assets: assets ?? await loadEpisodeAssets(storyboard.episodeId),
    bindings: await loadTargetBindings(storyboard.id),
  })
}

/** 分镜各目标的绑定（读库版本，API 输出用） */
export async function loadStoryboardTargetAssets(
  storyboard: typeof schema.storyboards.$inferSelect,
  assets?: EpisodeAssetEntry[],
): Promise<Record<BindingTarget, TargetAssetJson[]>> {
  return targetAssetsJson(assets ?? await loadEpisodeAssets(storyboard.episodeId), await loadTargetBindings(storyboard.id))
}

/** 某个目标的参考素材（读库版本，关键帧/视频组装用） */
export async function collectTargetAssetRefs(
  storyboardId: number,
  target: BindingTarget,
  assets: EpisodeAssetEntry[],
): Promise<AssetRef[]> {
  return targetAssetRefs(assets, (await loadTargetBindings(storyboardId))[target])
}

// ─── 写库 ────────────────────────────────────────────────────────────

async function loadPool(storyboardId: number): Promise<{ characterIds: number[]; propIds: number[] }> {
  const charLinks = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  const propLinks = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return { characterIds: charLinks.map(l => l.characterId), propIds: propLinks.map(l => l.propId) }
}

/**
 * 提示词写入后的同步（写库）：资产池跟随 5 个提示词的 @ 并集；
 * `fields` 对应的生成目标按各自提示词的 @ 重算绑定（其他目标不动）。
 * 调用方必须在提示词已落库之后调用，并传入本次写入的提示词字段。
 */
export async function syncStoryboardBindingsFromPrompts(
  storyboardId: number,
  fields: readonly string[],
): Promise<{
  sync: BindingSyncResult
  targetSync: TargetSyncPlan[]
  issues: RefIssue[]
  characterIds: number[]
  propIds: number[]
  targetAssets: Record<BindingTarget, TargetAssetJson[]>
}> {
  const [storyboard] = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard) throw new Error('镜头不存在')
  const assets = await loadEpisodeAssets(storyboard.episodeId)
  const prompts = promptFieldsOf(storyboard)

  const pool = await loadPool(storyboardId)
  const sync = computeBindingSync({ prompts, assets, ...pool })
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

  const targetSync = computeTargetSync(prompts, assets, await loadTargetBindings(storyboardId), targetsOfFields(fields))
  const ts = new Date().toISOString()
  for (const plan of targetSync) {
    for (const item of plan.add) {
      await db.insert(schema.storyboardTargetAssets).values({
        storyboardId, target: plan.target, kind: item.kind, assetId: item.id, selectedImage: null, createdAt: ts,
      }).onConflictDoNothing()
    }
    for (const item of plan.remove) {
      await db.delete(schema.storyboardTargetAssets).where(and(
        eq(schema.storyboardTargetAssets.storyboardId, storyboardId),
        eq(schema.storyboardTargetAssets.target, plan.target),
        eq(schema.storyboardTargetAssets.kind, item.kind),
        eq(schema.storyboardTargetAssets.assetId, item.id),
      ))
    }
  }

  const bindings = await loadTargetBindings(storyboardId)
  return {
    sync,
    targetSync,
    issues: computeRefIssues({ prompts, assets, bindings }),
    characterIds: sync.characterIds,
    propIds: sync.propIds,
    targetAssets: targetAssetsJson(assets, bindings),
  }
}

/** 给某个目标上已绑定的资产选版（image=null 恢复默认）；未绑定时抛错 */
export async function setTargetAssetImage(
  storyboardId: number,
  target: BindingTarget,
  kind: AssetKind,
  assetId: number,
  image: string | null,
): Promise<void> {
  const where = and(
    eq(schema.storyboardTargetAssets.storyboardId, storyboardId),
    eq(schema.storyboardTargetAssets.target, target),
    eq(schema.storyboardTargetAssets.kind, kind),
    eq(schema.storyboardTargetAssets.assetId, assetId),
  )
  const [row] = await db.select().from(schema.storyboardTargetAssets).where(where)
  if (!row) throw new Error(`该${KIND_LABEL[kind]}没有绑定到${TARGET_LABEL[target]}（绑定由${TARGET_LABEL[target]}提示词的 @ 决定）`)
  await db.update(schema.storyboardTargetAssets).set({ selectedImage: image }).where(where)
}

/** 删除分镜 / 资产时清理目标级绑定 */
export async function deleteTargetBindings(filter: { storyboardId: number } | { kind: AssetKind; assetIds: number[] }): Promise<void> {
  if ('storyboardId' in filter) {
    await db.delete(schema.storyboardTargetAssets).where(eq(schema.storyboardTargetAssets.storyboardId, filter.storyboardId))
    return
  }
  if (!filter.assetIds.length) return
  await db.delete(schema.storyboardTargetAssets).where(and(
    eq(schema.storyboardTargetAssets.kind, filter.kind),
    inArray(schema.storyboardTargetAssets.assetId, filter.assetIds),
  ))
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
