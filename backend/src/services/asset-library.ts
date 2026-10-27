/**
 * 资产管理器（Issue #9）——浏览全部项目的资产、把本项目资产关联到某一集、跨项目全量复制导入。
 *
 * 两种语义（用户确认 2026-10-27）：
 * - **本项目内复用 = 关联同一资产**：只写 `episode_*` 关联表，资产行仍是同一行，
 *   改一处处处生效（与剧本提取时的按名复用同一模型）。
 * - **跨项目导入 = 全量复制**：文本字段 + 当前图 + 全部历史版本（`sys_task`）+ 参考图
 *   都复制成新行/新文件，源与副本此后互不影响（源删除/改名/删版本都不波及副本）。
 *
 * 版本模型沿用现状：历史版本 = `sys_task` 中 `type='image' AND status='completed'` 且
 * owner 指向该资产的行，按 `created_at` 倒序展示。复制出的版本行 `provider='import'`
 * （仿照手动上传的 `provider='upload'`），原 provider/model/task id 记在
 * `params.imported_from`，并**保留原 `created_at` / `completed_at` / `generated_at`**
 * （全量复制，历史时间不变），因此版本顺序与源一致；这些行按 provider 排除出全局任务中心。
 *
 * 失败处理：文件复制是 IO，无法放进 SQLite 事务，改用补偿回滚——记录本次插入的行与复制出的
 * 文件，任一步抛错就删行删文件，保证「目标项目无残留资产行、sys_task 行和复制出的文件」。
 * 源文件缺失不算失败：跳过该版本并在结果里计数（见 Issue「实施细节补充」）。
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath, thumbPathFor } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { logTaskWarn } from '../utils/task-logger.js'
import {
  ASSET_LABELS,
  parseReferenceImages,
  referenceSubDir,
  type AssetKind,
  type ReferenceImageEntry,
} from './reference-images.js'

export const ASSET_KINDS: AssetKind[] = ['character', 'scene', 'prop']

/** 跨项目导入复制出的版本行的 provider（仿照手动上传的 'upload'）：按它排除出全局任务中心 */
export const IMPORTED_TASK_PROVIDER = 'import'

export function isAssetKind(value: unknown): value is AssetKind {
  return value === 'character' || value === 'scene' || value === 'prop'
}

export class AssetLibraryError extends Error {
  status: 400 | 404
  /** 同名冲突时带上建议的新名字，前端直接填进改名输入框 */
  suggestion?: string
  constructor(message: string, status: 400 | 404 = 400, suggestion?: string) {
    super(message)
    this.status = status
    this.suggestion = suggestion
  }
}

/**
 * 三张资产表的公共列（id / drama_id / image_url / local_path / reference_images /
 * deleted_at）定义一致，统一按 characters 的静态类型做 select/update；各表独有的列
 * （场景的 location/time、道具的 type 等）由 `AssetRow` 的可选字段读取。
 */
const ASSET_TABLES = {
  character: schema.characters,
  scene: schema.scenes,
  prop: schema.props,
} as unknown as Record<AssetKind, typeof schema.characters>

/** 三表行的并集视图：公共列必有，各表独有列可选（drizzle 无法为联合表给出单一静态类型） */
interface AssetRow {
  id: number
  dramaId: number
  imageUrl: string | null
  localPath: string | null
  referenceImages: string | null
  deletedAt: string | null
  name?: string | null
  location?: string | null
  role?: string | null
  time?: string | null
  type?: string | null
  description?: string | null
  appearance?: string | null
  styling?: string | null
  personality?: string | null
  prompt?: string | null
  lighting?: string | null
  finalPrompt?: string | null
  seedValue?: string | null
  sortOrder?: number | null
}

/** 关联表行的并集视图（episode_characters / episode_scenes / episode_props） */
interface LinkRow {
  episodeId: number
  characterId?: number
  sceneId?: number
  propId?: number
}

async function selectAssets(kind: AssetKind, onlyAlive = true): Promise<AssetRow[]> {
  const table = ASSET_TABLES[kind]
  const rows = onlyAlive
    ? await db.select().from(table).where(isNull(table.deletedAt))
    : await db.select().from(table)
  return rows as unknown as AssetRow[]
}

async function selectLinks(kind: AssetKind, episodeId?: number): Promise<LinkRow[]> {
  if (kind === 'character') {
    const rows = episodeId == null
      ? await db.select().from(schema.episodeCharacters)
      : await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
    return rows
  }
  if (kind === 'scene') {
    const rows = episodeId == null
      ? await db.select().from(schema.episodeScenes)
      : await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
    return rows
  }
  const rows = episodeId == null
    ? await db.select().from(schema.episodeProps)
    : await db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId))
  return rows
}

function linkedAssetId(kind: AssetKind, link: LinkRow): number {
  return Number((kind === 'character' ? link.characterId : kind === 'scene' ? link.sceneId : link.propId) ?? 0)
}

async function insertLink(kind: AssetKind, episodeId: number, assetId: number, ts: string): Promise<void> {
  if (kind === 'character') {
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId: assetId, createdAt: ts })
  } else if (kind === 'scene') {
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId: assetId, createdAt: ts })
  } else {
    await db.insert(schema.episodeProps).values({ episodeId, propId: assetId, createdAt: ts })
  }
}

async function deleteLinks(kind: AssetKind, assetId: number, episodeId?: number): Promise<void> {
  if (kind === 'character') {
    const where = episodeId == null
      ? eq(schema.episodeCharacters.characterId, assetId)
      : and(eq(schema.episodeCharacters.characterId, assetId), eq(schema.episodeCharacters.episodeId, episodeId))
    await db.delete(schema.episodeCharacters).where(where)
  } else if (kind === 'scene') {
    const where = episodeId == null
      ? eq(schema.episodeScenes.sceneId, assetId)
      : and(eq(schema.episodeScenes.sceneId, assetId), eq(schema.episodeScenes.episodeId, episodeId))
    await db.delete(schema.episodeScenes).where(where)
  } else {
    const where = episodeId == null
      ? eq(schema.episodeProps.propId, assetId)
      : and(eq(schema.episodeProps.propId, assetId), eq(schema.episodeProps.episodeId, episodeId))
    await db.delete(schema.episodeProps).where(where)
  }
}

/** sys_task 上的 owner 列 */
function taskOwnerColumn(kind: AssetKind) {
  if (kind === 'character') return schema.sysTask.characterId
  if (kind === 'scene') return schema.sysTask.sceneId
  return schema.sysTask.propId
}

function taskOwnerId(kind: AssetKind, task: typeof schema.sysTask.$inferSelect): number | null {
  if (kind === 'character') return task.characterId
  if (kind === 'scene') return task.sceneId
  return task.propId
}

/** 名字口径与 `@` 提及解析一致：角色/道具取 name，场景取 location */
export function assetDisplayName(kind: AssetKind, row: AssetRow): string {
  return String((kind === 'scene' ? row.location : row.name) ?? '').trim()
}

// ─── 版本（sys_task）───────────────────────────────────────────

export interface ImageVersion {
  id: number | null
  url: string | null
  provider: string | null
  model: string | null
  prompt: string | null
  created_at: string | null
  generated_at: number | null
  is_current: boolean
}

/** 复制出的版本卡片要显示源模型：取 params.imported_from.model */
function importedOriginModel(params: string | null): string | null {
  if (!params) return null
  try {
    const parsed: unknown = JSON.parse(params)
    if (!parsed || typeof parsed !== 'object' || !('imported_from' in parsed)) return null
    const from = parsed.imported_from
    if (!from || typeof from !== 'object' || !('model' in from)) return null
    const model = from.model
    return typeof model === 'string' && model ? model : null
  } catch {
    return null
  }
}

/**
 * 批量取资产的历史版本（owner id → 版本列表，按 created_at 倒序）。
 * 当前图在 sys_task 里找不到对应行时补一条 `provider='legacy'` 占位（无时间来源）。
 */
export async function loadImageVersions(
  kind: AssetKind,
  rows: Array<{ id: number; imageUrl: string | null }>,
): Promise<Map<number, ImageVersion[]>> {
  const result = new Map<number, ImageVersion[]>()
  if (!rows.length) return result
  const tasks = (await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.type, 'image'),
    eq(schema.sysTask.status, 'completed'),
    inArray(taskOwnerColumn(kind), rows.map(row => row.id)),
  ))).filter(task => taskOwnerId(kind, task) != null)

  for (const row of rows) {
    const versions: ImageVersion[] = tasks
      .filter(task => taskOwnerId(kind, task) === row.id)
      .map((task) => {
        const url = task.localPath || task.resultUrl
        return {
          id: task.id,
          url,
          provider: task.provider,
          model: task.provider === IMPORTED_TASK_PROVIDER ? (importedOriginModel(task.params) ?? task.model) : task.model,
          prompt: task.prompt,
          created_at: task.createdAt,
          generated_at: task.generatedAt ?? null,
          is_current: Boolean(url && url === row.imageUrl),
        }
      })
      .filter(version => Boolean(version.url))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    if (row.imageUrl && !versions.some(version => version.url === row.imageUrl)) {
      versions.unshift({
        id: null,
        url: row.imageUrl,
        provider: 'legacy',
        model: null,
        prompt: null,
        created_at: null,
        generated_at: null,
        is_current: true,
      })
    }
    result.set(row.id, versions)
  }
  return result
}

// ─── 浏览 ─────────────────────────────────────────────────────

export interface LibraryAsset {
  kind: AssetKind
  id: number
  drama_id: number
  drama_title: string
  name: string
  subtitle: string
  image_url: string | null
  version_count: number
  reference_count: number
  episodes: Array<{ id: number; episode_number: number; title: string }>
}

/**
 * 资产库列表：未删除项目下的未删除资产，带所属剧集、当前图、版本数。
 * `dramaId` 省略 = 全部项目（对话框左栏按项目分组）。
 */
export async function listAssetLibrary(filters: {
  dramaId?: number
  kind?: AssetKind
  keyword?: string
}): Promise<{ dramas: Array<{ id: number; title: string; asset_count: number }>; items: LibraryAsset[] }> {
  const dramas = await db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))
  const dramaTitles = new Map(dramas.map(drama => [drama.id, drama.title]))
  const episodes = (await db.select().from(schema.episodes).where(isNull(schema.episodes.deletedAt)))
    .filter(ep => dramaTitles.has(ep.dramaId))
  const episodeById = new Map(episodes.map(ep => [ep.id, ep]))

  const keyword = (filters.keyword || '').trim().toLowerCase()
  const kinds = filters.kind ? [filters.kind] : ASSET_KINDS
  const items: LibraryAsset[] = []

  for (const kind of kinds) {
    const rows = (await selectAssets(kind))
      .filter(row => dramaTitles.has(row.dramaId))
      .filter(row => filters.dramaId == null || row.dramaId === filters.dramaId)
    if (!rows.length) continue

    const linkedEpisodes = new Map<number, Array<{ id: number; episode_number: number; title: string }>>()
    for (const link of await selectLinks(kind)) {
      const ep = episodeById.get(Number(link.episodeId))
      if (!ep) continue
      const assetId = linkedAssetId(kind, link)
      const list = linkedEpisodes.get(assetId) ?? []
      if (!list.some(item => item.id === ep.id)) list.push({ id: ep.id, episode_number: ep.episodeNumber, title: ep.title })
      linkedEpisodes.set(assetId, list)
    }

    const versions = await loadImageVersions(kind, rows)
    for (const row of rows) {
      const name = assetDisplayName(kind, row)
      const subtitle = String((kind === 'character' ? row.role : kind === 'scene' ? row.time : row.type) ?? '').trim()
      if (keyword && !name.toLowerCase().includes(keyword) && !subtitle.toLowerCase().includes(keyword)) continue
      items.push({
        kind,
        id: row.id,
        drama_id: row.dramaId,
        drama_title: dramaTitles.get(row.dramaId) ?? '',
        name,
        subtitle,
        image_url: row.imageUrl ?? null,
        version_count: (versions.get(row.id) ?? []).length,
        reference_count: parseReferenceImages(row.referenceImages).length,
        episodes: (linkedEpisodes.get(row.id) ?? []).sort((a, b) => a.episode_number - b.episode_number),
      })
    }
  }

  items.sort((a, b) => a.drama_id - b.drama_id || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  const counts = new Map<number, number>()
  for (const item of items) counts.set(item.drama_id, (counts.get(item.drama_id) ?? 0) + 1)
  return {
    dramas: dramas.map(drama => ({ id: drama.id, title: drama.title, asset_count: counts.get(drama.id) ?? 0 })),
    items,
  }
}

/** 单个资产详情（文本字段 + 全部历史版本 + 参考图 + 所属剧集），供浏览器预览 */
export async function getLibraryAsset(kind: AssetKind, id: number) {
  const [row] = (await selectAssets(kind, false)).filter(item => item.id === id)
  if (!row || row.deletedAt) throw new AssetLibraryError(`${ASSET_LABELS[kind]}不存在`, 404)
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, row.dramaId))
  const versions = (await loadImageVersions(kind, [row])).get(row.id) ?? []
  const episodeIds = (await selectLinks(kind))
    .filter(link => linkedAssetId(kind, link) === id)
    .map(link => link.episodeId)
  const episodes = episodeIds.length
    ? (await db.select().from(schema.episodes).where(inArray(schema.episodes.id, episodeIds)))
      .filter(ep => !ep.deletedAt)
      .map(ep => ({ id: ep.id, episode_number: ep.episodeNumber, title: ep.title }))
      .sort((a, b) => a.episode_number - b.episode_number)
    : []
  return {
    kind,
    id: row.id,
    drama_id: row.dramaId,
    drama_title: drama?.title ?? '',
    name: assetDisplayName(kind, row),
    fields: textFieldsOf(kind, row),
    image_url: row.imageUrl ?? null,
    image_versions: versions,
    reference_images: parseReferenceImages(row.referenceImages),
    episodes,
  }
}

/** 预览用的文本字段（逐 kind 显式列出，不把内部列泄露给对话框） */
function textFieldsOf(kind: AssetKind, row: AssetRow): Record<string, string> {
  if (kind === 'character') {
    return {
      role: row.role ?? '', description: row.description ?? '', appearance: row.appearance ?? '',
      styling: row.styling ?? '', personality: row.personality ?? '', final_prompt: row.finalPrompt ?? '',
    }
  }
  if (kind === 'scene') {
    return {
      time: row.time ?? '', prompt: row.prompt ?? '', lighting: row.lighting ?? '',
      final_prompt: row.finalPrompt ?? '',
    }
  }
  return {
    type: row.type ?? '', description: row.description ?? '', prompt: row.prompt ?? '',
    final_prompt: row.finalPrompt ?? '',
  }
}

// ─── 同名与改名 ───────────────────────────────────────────────

/**
 * 在已占用名字集合里给 `base` 找唯一名：`名字` → `名字-2` → `名字-3` …
 * 纯函数（前后端同一规则；批量导入时把同批次已选名字一起传进来）。
 */
export function suggestUniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const item of taken) {
    const value = String(item ?? '').trim()
    if (value) used.add(value)
  }
  const name = String(base ?? '').trim()
  if (!used.has(name)) return name
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${name}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/** 目标项目内该类资产已占用的名字（未删除） */
export async function takenAssetNames(kind: AssetKind, dramaId: number): Promise<string[]> {
  return (await selectAssets(kind))
    .filter(row => row.dramaId === dramaId)
    .map(row => assetDisplayName(kind, row))
    .filter(Boolean)
}

// ─── 关联（本项目内复用）──────────────────────────────────────

export interface LinkResult { linked: boolean; kind: AssetKind; asset_id: number; episode_id: number }

/**
 * 把本项目的资产关联到某一集（幂等）。
 * 拒绝跨项目关联（资产属于项目），拒绝与本集已有同名资产冲突——同名会让 `@提及`
 * 先到先得地只解析到其中一个；关联处不提供改名，因为改名会影响该资产所在的其他剧集。
 */
export async function linkAssetToEpisode(episodeId: number, kind: AssetKind, assetId: number): Promise<LinkResult> {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new AssetLibraryError('剧集不存在', 404)
  const [asset] = (await selectAssets(kind, false)).filter(row => row.id === assetId)
  if (!asset || asset.deletedAt) throw new AssetLibraryError(`${ASSET_LABELS[kind]}不存在`, 404)
  if (asset.dramaId !== episode.dramaId) {
    throw new AssetLibraryError('该资产属于其他项目，请使用「导入」复制一份')
  }

  const linked = await loadLinkedAssets(kind, episodeId)
  if (linked.some(row => row.id === assetId)) {
    return { linked: false, kind, asset_id: assetId, episode_id: episodeId }
  }
  const name = assetDisplayName(kind, asset)
  const conflict = linked.find(row => assetDisplayName(kind, row) === name)
  if (conflict) {
    throw new AssetLibraryError(`本集已有同名${ASSET_LABELS[kind]}「${name}」(#${conflict.id})，无法重复关联`)
  }

  await insertLink(kind, episodeId, assetId, now())
  return { linked: true, kind, asset_id: assetId, episode_id: episodeId }
}

/** 取消关联（不删资产，幂等） */
export async function unlinkAssetFromEpisode(episodeId: number, kind: AssetKind, assetId: number): Promise<LinkResult> {
  await deleteLinks(kind, assetId, episodeId)
  return { linked: false, kind, asset_id: assetId, episode_id: episodeId }
}

async function loadLinkedAssets(kind: AssetKind, episodeId: number): Promise<AssetRow[]> {
  const ids = (await selectLinks(kind, episodeId)).map(link => linkedAssetId(kind, link))
  if (!ids.length) return []
  return (await selectAssets(kind)).filter(row => ids.includes(row.id))
}

// ─── 跨项目全量复制导入 ───────────────────────────────────────

export interface ImportResult {
  kind: AssetKind
  id: number
  name: string
  version_count: number
  skipped_versions: number
  skipped_reference_images: number
  has_image: boolean
  linked_episode_id: number | null
}

const IMAGE_SUBDIR = 'images'

/** 只复制 static/ 下的本地文件；外部 http 地址原样保留 URL 字符串 */
function isLocalStatic(value: string | null | undefined): boolean {
  const raw = String(value ?? '')
  return raw.startsWith('static/') && !raw.includes('..')
}

/** 复制一份本地文件到 subDir 下的新 uuid 文件（含缩略图）；源文件不存在 → null */
function copyLocalFile(source: string, subDir: string, copied: string[]): string | null {
  const absSource = getAbsolutePath(source)
  if (!fs.existsSync(absSource)) return null
  fs.mkdirSync(path.join(STORAGE_ROOT, subDir), { recursive: true })
  const target = `static/${subDir}/${randomUUID()}${path.extname(source) || '.png'}`
  const absTarget = getAbsolutePath(target)
  fs.copyFileSync(absSource, absTarget)
  copied.push(absTarget)

  const sourceThumb = thumbPathFor(source)
  if (sourceThumb !== source && fs.existsSync(getAbsolutePath(sourceThumb))) {
    const absTargetThumb = getAbsolutePath(thumbPathFor(target))
    fs.copyFileSync(getAbsolutePath(sourceThumb), absTargetThumb)
    copied.push(absTargetThumb)
  }
  return target
}

/**
 * 跨项目全量复制一个资产到目标项目（同项目也允许，前端只在跨项目场景暴露）。
 * 失败时补偿回滚：删掉本次插入的 sys_task / 关联 / 资产行，并删掉复制出的文件。
 */
export async function importAsset(input: {
  targetDramaId: number
  kind: AssetKind
  sourceId: number
  name?: string
  episodeId?: number | null
}): Promise<ImportResult> {
  const { targetDramaId, kind, sourceId } = input
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, targetDramaId))
  if (!drama || drama.deletedAt) throw new AssetLibraryError('目标项目不存在', 404)
  const [source] = (await selectAssets(kind, false)).filter(row => row.id === sourceId)
  if (!source || source.deletedAt) throw new AssetLibraryError(`${ASSET_LABELS[kind]}不存在`, 404)

  let episode: typeof schema.episodes.$inferSelect | undefined
  if (input.episodeId) {
    const [row] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, input.episodeId))
    if (!row || row.deletedAt) throw new AssetLibraryError('剧集不存在', 404)
    if (row.dramaId !== targetDramaId) throw new AssetLibraryError('剧集不属于目标项目')
    episode = row
  }

  const name = String(input.name ?? '').trim() || assetDisplayName(kind, source)
  if (!name) throw new AssetLibraryError('名称必填')
  const taken = await takenAssetNames(kind, targetDramaId)
  if (taken.includes(name)) {
    throw new AssetLibraryError(
      `目标项目已有同名${ASSET_LABELS[kind]}「${name}」，请改名后导入`,
      400,
      suggestUniqueName(name, taken),
    )
  }

  const copiedFiles: string[] = []
  const insertedTaskIds: number[] = []
  let newId = 0
  const ts = now()

  try {
    // 1. 资产行（文本字段全量复制；派生字段重置）
    newId = await insertAssetRow(kind, targetDramaId, name, source, ts)

    // 2. 历史版本：当前图与版本共享同一份复制（源库里当前图就是某个版本的文件）
    const copyCache = new Map<string, string | null>()
    const copyOnce = (rel: string): string | null => {
      const cached = copyCache.get(rel)
      if (cached !== undefined) return cached
      const target = copyLocalFile(rel, IMAGE_SUBDIR, copiedFiles)
      copyCache.set(rel, target)
      return target
    }

    const versionTasks = (await db.select().from(schema.sysTask).where(and(
      eq(schema.sysTask.type, 'image'),
      eq(schema.sysTask.status, 'completed'),
      eq(taskOwnerColumn(kind), sourceId),
    ))).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))

    let skippedVersions = 0
    let versionCount = 0
    for (const task of versionTasks) {
      let newLocal: string | null = null
      let newResult: string | null = null
      if (isLocalStatic(task.localPath)) {
        newLocal = copyOnce(task.localPath as string)
        if (!newLocal) { skippedVersions += 1; continue } // 源文件已不在磁盘上：跳过，不算失败
        newResult = newLocal
      } else if (isLocalStatic(task.resultUrl)) {
        newResult = copyOnce(task.resultUrl as string)
        if (!newResult) { skippedVersions += 1; continue }
        newLocal = newResult
      } else if (task.resultUrl) {
        newResult = task.resultUrl // 外部地址：原样保留
      } else {
        skippedVersions += 1
        continue
      }
      insertedTaskIds.push(await insertVersionTask({
        kind, ownerId: newId, dramaId: targetDramaId, episodeId: episode?.id ?? null,
        source: task, localPath: newLocal, resultUrl: newResult, ts,
      }))
      versionCount += 1
    }

    // 3. 当前图：命中版本复制缓存则复用同一份文件；legacy（无版本行）单独复制
    let imageUrl: string | null = null
    let localPath: string | null = null
    if (source.imageUrl && isLocalStatic(source.imageUrl)) {
      imageUrl = copyOnce(source.imageUrl)
      localPath = imageUrl
    } else if (source.imageUrl) {
      imageUrl = source.imageUrl
    }

    // 4. 参考图：复制进新资产自己的目录，保留原 uploaded_at（全量复制，历史时间不变）
    const refs: ReferenceImageEntry[] = []
    let skippedRefs = 0
    for (const entry of parseReferenceImages(source.referenceImages)) {
      if (!isLocalStatic(entry.path)) { refs.push({ ...entry }); continue }
      const target = copyLocalFile(entry.path, referenceSubDir(kind, newId), copiedFiles)
      if (!target) { skippedRefs += 1; continue }
      refs.push({ path: target, uploaded_at: entry.uploaded_at })
    }

    const table = ASSET_TABLES[kind]
    await db.update(table).set({
      imageUrl,
      localPath,
      referenceImages: refs.length ? JSON.stringify(refs) : null,
      ...(kind === 'scene' ? { status: imageUrl ? 'completed' : 'pending' } : {}),
      updatedAt: now(),
    }).where(eq(table.id, newId))

    // 5. 可选：同时关联到目标集（剧集资产页导入）
    if (episode) await insertLink(kind, episode.id, newId, ts)

    return {
      kind,
      id: newId,
      name,
      version_count: versionCount,
      skipped_versions: skippedVersions,
      skipped_reference_images: skippedRefs,
      has_image: Boolean(imageUrl),
      linked_episode_id: episode?.id ?? null,
    }
  } catch (err) {
    await rollbackImport(kind, newId, insertedTaskIds, copiedFiles)
    throw err
  }
}

/** 补偿回滚：复制出的文件 + 本次插入的行一并清掉（硬删——这些行从未被用户看到） */
async function rollbackImport(kind: AssetKind, assetId: number, taskIds: number[], copiedFiles: string[]) {
  for (const abs of copiedFiles) {
    try {
      fs.rmSync(abs, { force: true })
    } catch (err) {
      logTaskWarn('AssetImport', 'rollback-unlink-failed', { path: abs, error: (err as Error).message })
    }
  }
  try {
    if (taskIds.length) await db.delete(schema.sysTask).where(inArray(schema.sysTask.id, taskIds))
    if (assetId) {
      await deleteLinks(kind, assetId)
      const table = ASSET_TABLES[kind]
      await db.delete(table).where(eq(table.id, assetId))
      try {
        fs.rmSync(path.join(STORAGE_ROOT, referenceSubDir(kind, assetId)), { recursive: true, force: true })
      } catch { /* 目录可能根本没建出来，忽略 */ }
    }
  } catch (err) {
    logTaskWarn('AssetImport', 'rollback-rows-failed', { assetId, error: (err as Error).message })
  }
}

/** 新资产行：文本字段全量复制；storyboard_count / status / sort_order 等派生字段重置 */
async function insertAssetRow(
  kind: AssetKind,
  dramaId: number,
  name: string,
  source: AssetRow,
  ts: string,
): Promise<number> {
  if (kind === 'character') {
    const existing = await db.select().from(schema.characters)
      .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
    return getInsertId(await db.insert(schema.characters).values({
      dramaId,
      name,
      role: source.role ?? null,
      description: source.description ?? null,
      appearance: source.appearance ?? null,
      styling: source.styling ?? null,
      finalPrompt: source.finalPrompt ?? null,
      personality: source.personality ?? null,
      seedValue: source.seedValue ?? null,
      // 派生字段：在目标项目内重新排到末尾
      sortOrder: existing.reduce((max, row) => Math.max(max, row.sortOrder ?? 0), 0) + 1,
      createdAt: ts,
      updatedAt: ts,
    }))
  }
  if (kind === 'scene') {
    return getInsertId(await db.insert(schema.scenes).values({
      dramaId,
      episodeId: null, // 遗留列，解析路径不用它
      location: name,
      time: source.time ?? '',
      prompt: source.prompt ?? '',
      lighting: source.lighting ?? null,
      finalPrompt: source.finalPrompt ?? null,
      storyboardCount: 0, // 派生字段：源项目的分镜引用数与目标项目无关
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    }))
  }
  return getInsertId(await db.insert(schema.props).values({
    dramaId,
    name,
    type: source.type ?? null,
    description: source.description ?? null,
    prompt: source.prompt ?? null,
    finalPrompt: source.finalPrompt ?? null,
    createdAt: ts,
    updatedAt: ts,
  }))
}

/** 复制一条版本任务：provider='import'，原 provider/model/task id 记进 params.imported_from */
async function insertVersionTask(input: {
  kind: AssetKind
  ownerId: number
  dramaId: number
  episodeId: number | null
  source: typeof schema.sysTask.$inferSelect
  localPath: string | null
  resultUrl: string | null
  ts: string
}): Promise<number> {
  const { kind, ownerId, source } = input
  let params: Record<string, unknown> = {}
  if (source.params) {
    try {
      const parsed: unknown = JSON.parse(source.params)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
    } catch { /* 非法 JSON：只保留来源信息 */ }
  }
  params.imported_from = {
    task_id: source.id,
    provider: source.provider,
    model: source.model,
    drama_id: source.dramaId,
    asset_kind: kind,
  }
  return getInsertId(await db.insert(schema.sysTask).values({
    type: 'image',
    characterId: kind === 'character' ? ownerId : null,
    sceneId: kind === 'scene' ? ownerId : null,
    propId: kind === 'prop' ? ownerId : null,
    dramaId: input.dramaId,
    episodeId: input.episodeId,
    provider: IMPORTED_TASK_PROVIDER,
    model: source.model,
    prompt: source.prompt,
    params: JSON.stringify(params),
    resultUrl: input.resultUrl,
    localPath: input.localPath,
    status: 'completed',
    // 全量复制：历史时间不变（版本列表按 created_at 排序，顺序与源一致）
    createdAt: source.createdAt,
    updatedAt: input.ts,
    completedAt: source.completedAt ?? source.createdAt,
    generatedAt: source.generatedAt ?? null,
  }))
}
