/**
 * 素材管理器（图片浏览器）— 按 项目 → 剧集 → 资产/分镜 → 版本/关键帧/参考图 浏览历史图片
 *
 * 设计要点：
 * - 图片来源三类：完成的图片任务（sys_task）、资产当前图里没有对应任务的 legacy 图、
 *   各资产已上传的参考图（#14 的 `[{path, uploaded_at}]` 条目）。
 * - 一次扫描建立「可见图片全集」，树的计数、分页列表、复制接口的白名单校验共用同一份结果，
 *   避免三处各写一套归属规则而漂移（现场量级：图片任务约 64 张，全表扫描足够）。
 * - 已删除的内容（软删的项目/剧集/资产、已删除的版本行）不出现在素材库中。
 * - 只列磁盘上确实存在的文件。
 */
import fs from 'fs'
import path from 'path'
import { randomUUID as uuid } from 'crypto'
import { db, schema } from '../db/index.js'
import { getAbsolutePath, generateImageThumb, thumbPathFor } from '../utils/storage.js'
import {
  ASSET_LABELS,
  loadReferences,
  parseReferenceImages,
  persistReferences,
  REFERENCE_IMAGE_MAX_COUNT,
  referenceSubDir,
  type AssetKind,
  type ReferenceImageEntry,
} from './reference-images.js'

export type LibraryOwnerKind = AssetKind | 'storyboard'
export type KeyframeSlot = 'first_frame' | 'mid_frame' | 'last_frame'

const SLOT_LABELS: Record<KeyframeSlot, string> = {
  first_frame: '首帧',
  mid_frame: '中间帧',
  last_frame: '尾帧',
}
const SLOT_ORDER: KeyframeSlot[] = ['first_frame', 'mid_frame', 'last_frame']

export interface LibraryImage {
  /** 库内相对路径（static/...），同时是复制接口的白名单键 */
  path: string
  url: string
  thumb_url: string
  drama_id: number
  drama_title: string
  /** 资产可同时属于多集（多对多）；分镜关键帧只属于一集 */
  episode_ids: number[]
  kind: LibraryOwnerKind
  owner_id: number
  owner_name: string
  slot: KeyframeSlot | null
  /** version=正式版本 · legacy=无任务行的当前图 · reference=已上传参考图 */
  source: 'version' | 'legacy' | 'reference'
  version_index: number | null
  generated_at: number | null
  provider: string | null
  model: string | null
  source_label: string
}

export class MediaLibraryError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** 与上传校验一致：扩展名白名单（复制的是库内文件，仍按格式兜底） */
const IMAGE_EXT: Record<string, true> = { '.jpg': true, '.jpeg': true, '.png': true, '.webp': true }

/** 入参归一化：允许前端传 `/static/...` 或完整 URL 的 path 部分 */
export function normalizeLibraryPath(raw: unknown): string {
  let value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname
    } catch {
      return ''
    }
  }
  if (value.startsWith('/')) value = value.slice(1)
  return value
}

function fileExists(relPath: string): boolean {
  try {
    return fs.existsSync(getAbsolutePath(relPath))
  } catch {
    return false
  }
}

function parseParams(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}



/**
 * 扫描全部可见图片。按 created_at 升序给同一归属的版本编号（第 1 版 = 最早）。
 */
export async function collectLibraryImages(): Promise<LibraryImage[]> {
  const [dramas, episodes, characters, scenes, props, storyboards, tasks, epChars, epScenes, epProps] = await Promise.all([
    db.select().from(schema.dramas),
    db.select().from(schema.episodes),
    db.select().from(schema.characters),
    db.select().from(schema.scenes),
    db.select().from(schema.props),
    db.select().from(schema.storyboards),
    db.select().from(schema.sysTask),
    db.select().from(schema.episodeCharacters),
    db.select().from(schema.episodeScenes),
    db.select().from(schema.episodeProps),
  ])

  const liveDramas = new Map(dramas.filter(d => !d.deletedAt).map(d => [d.id, d]))
  const liveEpisodes = new Map(episodes.filter(e => !e.deletedAt && liveDramas.has(e.dramaId)).map(e => [e.id, e]))

  type AssetRow = { id: number; dramaId: number; name: string; imageUrl: string | null; referenceImages: unknown }
  const assetsByKind: Record<AssetKind, Map<number, AssetRow>> = {
    character: new Map(),
    scene: new Map(),
    prop: new Map(),
  }
  for (const row of characters) {
    if (row.deletedAt || !liveDramas.has(row.dramaId)) continue
    assetsByKind.character.set(row.id, { id: row.id, dramaId: row.dramaId, name: row.name, imageUrl: row.imageUrl, referenceImages: row.referenceImages })
  }
  for (const row of scenes) {
    if (row.deletedAt || !liveDramas.has(row.dramaId)) continue
    assetsByKind.scene.set(row.id, { id: row.id, dramaId: row.dramaId, name: row.location, imageUrl: row.imageUrl, referenceImages: row.referenceImages })
  }
  for (const row of props) {
    if (row.deletedAt || !liveDramas.has(row.dramaId)) continue
    assetsByKind.prop.set(row.id, { id: row.id, dramaId: row.dramaId, name: row.name, imageUrl: row.imageUrl, referenceImages: row.referenceImages })
  }

  // 资产 → 所属剧集（多对多关联表；sys_task.episode_id 存量为空，不能作为归属依据）
  const episodeLinks: Record<AssetKind, Map<number, number[]>> = { character: new Map(), scene: new Map(), prop: new Map() }
  const addLink = (kind: AssetKind, assetId: number, episodeId: number) => {
    if (!liveEpisodes.has(episodeId) || !assetsByKind[kind].has(assetId)) return
    const list = episodeLinks[kind].get(assetId) ?? []
    if (!list.includes(episodeId)) list.push(episodeId)
    episodeLinks[kind].set(assetId, list)
  }
  for (const link of epChars) addLink('character', link.characterId, link.episodeId)
  for (const link of epScenes) addLink('scene', link.sceneId, link.episodeId)
  for (const link of epProps) addLink('prop', link.propId, link.episodeId)

  const liveStoryboards = new Map(
    storyboards.filter(sb => liveEpisodes.has(sb.episodeId)).map(sb => [sb.id, sb]),
  )

  const images: LibraryImage[] = []
  const seen = new Set<string>()

  const push = (image: LibraryImage) => {
    if (seen.has(image.path)) return
    seen.add(image.path)
    images.push(image)
  }

  const labelOf = (dramaTitle: string, episodeIds: number[], tail: string) => {
    const number = (episodeIds.length ? liveEpisodes.get(episodeIds[0]!) : null)?.episodeNumber ?? null
    return `《${dramaTitle}》${number == null ? '未关联剧集' : `E${String(number).padStart(2, '0')}`} · ${tail}`
  }

  // 1) 正式版本（完成的图片任务）
  const imageTasks = tasks
    .filter(task => task.type === 'image' && task.status === 'completed')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id - b.id)
  const versionCounters = new Map<string, number>()

  for (const task of imageTasks) {
    const stored = normalizeLibraryPath(task.localPath || task.resultUrl)
    if (!stored.startsWith('static/') || !fileExists(stored)) continue
    const params = parseParams(task.params)
    const frameType = String(params.frameType ?? '')
    const slot = (SLOT_ORDER as string[]).includes(frameType) ? frameType as KeyframeSlot : null

    if (task.storyboardId && slot) {
      const sb = liveStoryboards.get(task.storyboardId)
      if (!sb) continue
      const episode = liveEpisodes.get(sb.episodeId)!
      const drama = liveDramas.get(episode.dramaId)
      if (!drama) continue
      const counterKey = `storyboard:${sb.id}:${slot}`
      const index = (versionCounters.get(counterKey) ?? 0) + 1
      versionCounters.set(counterKey, index)
      push({
        path: stored,
        url: `/${stored}`,
        thumb_url: `/${thumbPathFor(stored)}`,
        drama_id: drama.id,
        drama_title: drama.title,
        episode_ids: [episode.id],
        kind: 'storyboard',
        owner_id: sb.id,
        owner_name: `分镜 ${sb.storyboardNumber}`,
        slot,
        source: 'version',
        version_index: index,
        generated_at: task.generatedAt ?? null,
        provider: task.provider,
        model: task.model,
        source_label: labelOf(drama.title, [episode.id], `分镜 ${sb.storyboardNumber} · ${SLOT_LABELS[slot]} · 第 ${index} 版`),
      })
      continue
    }

    const kind: AssetKind | null = task.characterId ? 'character' : task.sceneId ? 'scene' : task.propId ? 'prop' : null
    if (!kind) continue
    const ownerId = (task.characterId ?? task.sceneId ?? task.propId)!
    const asset = assetsByKind[kind].get(ownerId)
    if (!asset) continue
    const drama = liveDramas.get(asset.dramaId)
    if (!drama) continue
    const counterKey = `${kind}:${ownerId}`
    const index = (versionCounters.get(counterKey) ?? 0) + 1
    versionCounters.set(counterKey, index)
    const episodeIds = episodeLinks[kind].get(ownerId) ?? []
    push({
      path: stored,
      url: `/${stored}`,
      thumb_url: `/${thumbPathFor(stored)}`,
      drama_id: drama.id,
      drama_title: drama.title,
      episode_ids: episodeIds,
      kind,
      owner_id: ownerId,
      owner_name: asset.name,
      slot: null,
      source: 'version',
      version_index: index,
      generated_at: task.generatedAt ?? null,
      provider: task.provider,
      model: task.model,
      source_label: labelOf(drama.title, episodeIds, `${ASSET_LABELS[kind]} ${asset.name} · 第 ${index} 版`),
    })
  }

  // 2) legacy 当前图（版本行已删除）+ 3) 已上传参考图
  for (const kind of ['character', 'scene', 'prop'] as AssetKind[]) {
    for (const asset of assetsByKind[kind].values()) {
      const drama = liveDramas.get(asset.dramaId)!
      const episodeIds = episodeLinks[kind].get(asset.id) ?? []
      const current = normalizeLibraryPath(asset.imageUrl)
      if (current.startsWith('static/') && !seen.has(current) && fileExists(current)) {
        push({
          path: current,
          url: `/${current}`,
          thumb_url: `/${thumbPathFor(current)}`,
          drama_id: drama.id,
          drama_title: drama.title,
          episode_ids: episodeIds,
          kind,
          owner_id: asset.id,
          owner_name: asset.name,
          slot: null,
          source: 'legacy',
          version_index: null,
          generated_at: null,
          provider: 'legacy',
          model: null,
          source_label: labelOf(drama.title, episodeIds, `${ASSET_LABELS[kind]} ${asset.name} · 历史当前图`),
        })
      }
      for (const entry of parseReferenceImages(asset.referenceImages)) {
        const refPath = normalizeLibraryPath(entry.path)
        if (!refPath.startsWith('static/') || seen.has(refPath) || !fileExists(refPath)) continue
        push({
          path: refPath,
          url: `/${refPath}`,
          thumb_url: `/${thumbPathFor(refPath)}`,
          drama_id: drama.id,
          drama_title: drama.title,
          episode_ids: episodeIds,
          kind,
          owner_id: asset.id,
          owner_name: asset.name,
          slot: null,
          source: 'reference',
          version_index: null,
          generated_at: entry.uploaded_at ?? null,
          provider: 'upload',
          model: null,
          source_label: labelOf(drama.title, episodeIds, `${ASSET_LABELS[kind]} ${asset.name} · 参考图`),
        })
      }
    }
  }

  return images
}

export interface LibraryFilter {
  dramaId?: number
  episodeId?: number
  /** 'unassigned' = 项目下未关联任何剧集的资产 */
  episodeScope?: 'unassigned'
  kind?: LibraryOwnerKind
  ownerId?: number
  slot?: KeyframeSlot
}

export function filterLibraryImages(images: LibraryImage[], filter: LibraryFilter): LibraryImage[] {
  return images.filter((image) => {
    if (filter.dramaId && image.drama_id !== filter.dramaId) return false
    if (filter.episodeScope === 'unassigned' && image.episode_ids.length) return false
    if (filter.episodeId && !image.episode_ids.includes(filter.episodeId)) return false
    if (filter.kind && image.kind !== filter.kind) return false
    if (filter.ownerId && image.owner_id !== filter.ownerId) return false
    if (filter.slot && image.slot !== filter.slot) return false
    return true
  })
}

/** 列表排序：新图在前（无时间的 legacy 图排在最后，按路径稳定排序） */
export function sortLibraryImages(images: LibraryImage[]): LibraryImage[] {
  return [...images].sort((a, b) => {
    const at = a.generated_at ?? 0
    const bt = b.generated_at ?? 0
    if (at !== bt) return bt - at
    return a.path.localeCompare(b.path)
  })
}

export interface LibraryTreeNode {
  id: number
  name: string
  kind: LibraryOwnerKind
  count: number
  slots?: Array<{ slot: KeyframeSlot; label: string; count: number }>
}

export interface LibraryTree {
  drama: { id: number; title: string; count: number }
  episodes: Array<{
    id: number
    episode_number: number
    title: string
    count: number
    characters: LibraryTreeNode[]
    scenes: LibraryTreeNode[]
    props: LibraryTreeNode[]
    storyboards: LibraryTreeNode[]
  }>
  unassigned: { count: number; characters: LibraryTreeNode[]; scenes: LibraryTreeNode[]; props: LibraryTreeNode[] }
}

function groupAssets(images: LibraryImage[], kind: AssetKind): LibraryTreeNode[] {
  const map = new Map<number, LibraryTreeNode>()
  for (const image of images) {
    if (image.kind !== kind) continue
    const node = map.get(image.owner_id) ?? { id: image.owner_id, name: image.owner_name, kind, count: 0 }
    node.count += 1
    map.set(image.owner_id, node)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

function groupStoryboards(images: LibraryImage[]): LibraryTreeNode[] {
  const map = new Map<number, LibraryTreeNode>()
  for (const image of images) {
    if (image.kind !== 'storyboard' || !image.slot) continue
    const node = map.get(image.owner_id)
      ?? { id: image.owner_id, name: image.owner_name, kind: 'storyboard' as const, count: 0, slots: SLOT_ORDER.map(slot => ({ slot, label: SLOT_LABELS[slot], count: 0 })) }
    node.count += 1
    const slotNode = node.slots!.find(s => s.slot === image.slot)!
    slotNode.count += 1
    map.set(image.owner_id, node)
  }
  return [...map.values()]
    .map(node => ({ ...node, slots: node.slots!.filter(s => s.count > 0) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }))
}

/** 单个项目的浏览树（懒加载：项目列表与树分两个接口） */
export async function buildLibraryTree(dramaId: number): Promise<LibraryTree> {
  const [drama] = (await db.select().from(schema.dramas)).filter(row => row.id === dramaId && !row.deletedAt)
  const all = await collectLibraryImages()
  const dramaImages = all.filter(image => image.drama_id === dramaId)
  const title = drama?.title ?? dramaImages[0]?.drama_title ?? ''

  const episodeRows = (await db.select().from(schema.episodes))
    .filter(e => e.dramaId === dramaId && !e.deletedAt)
    .sort((a, b) => a.episodeNumber - b.episodeNumber)

  const episodes = episodeRows.map((episode) => {
    const scoped = dramaImages.filter(image => image.episode_ids.includes(episode.id))
    return {
      id: episode.id,
      episode_number: episode.episodeNumber,
      title: episode.title,
      count: scoped.length,
      characters: groupAssets(scoped, 'character'),
      scenes: groupAssets(scoped, 'scene'),
      props: groupAssets(scoped, 'prop'),
      storyboards: groupStoryboards(scoped),
    }
  })

  const orphan = dramaImages.filter(image => !image.episode_ids.length)
  return {
    drama: { id: dramaId, title, count: dramaImages.length },
    episodes,
    unassigned: {
      count: orphan.length,
      characters: groupAssets(orphan, 'character'),
      scenes: groupAssets(orphan, 'scene'),
      props: groupAssets(orphan, 'prop'),
    },
  }
}

/** 项目列表（含图片计数），用于树的第一层 */
export async function listLibraryDramas(): Promise<Array<{ id: number; title: string; count: number }>> {
  const images = await collectLibraryImages()
  const counts = new Map<number, { id: number; title: string; count: number }>()
  for (const image of images) {
    const row = counts.get(image.drama_id) ?? { id: image.drama_id, title: image.drama_title, count: 0 }
    row.count += 1
    counts.set(image.drama_id, row)
  }
  const dramas = (await db.select().from(schema.dramas)).filter(d => !d.deletedAt)
  return dramas
    .map(d => counts.get(d.id) ?? { id: d.id, title: d.title, count: 0 })
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh'))
}

/**
 * 白名单校验：只有素材库里能看到的图片才允许复制。
 * 阻断任意服务器路径（含目录穿越、库外 static 文件）被插入为参考图或资产图。
 */
export async function assertLibraryImage(rawPath: unknown): Promise<LibraryImage> {
  const normalized = normalizeLibraryPath(rawPath)
  if (!normalized) throw new MediaLibraryError('url 必填')
  const images = await collectLibraryImages()
  const hit = images.find(image => image.path === normalized)
  if (!hit) throw new MediaLibraryError('该图片不在素材库中，无法选用', 403)
  return hit
}

/** 复制库内图片到目标目录，返回新的相对路径（含缩略图） */
export async function copyLibraryImage(source: LibraryImage, subDir: string): Promise<string> {
  const ext = path.extname(source.path).toLowerCase()
  if (!IMAGE_EXT[ext]) throw new MediaLibraryError('素材库仅支持 jpg/png/webp 图片')
  const dir = path.join(getAbsolutePath(`static/${subDir}`))
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${uuid()}${ext}`
  fs.copyFileSync(getAbsolutePath(source.path), path.join(dir, filename))
  const stored = `static/${subDir}/${filename}`
  await generateImageThumb(stored)
  return stored
}

/**
 * 从素材库选图加入某资产的参考图：校验白名单 → 去重 → 上限检查 → 复制 → 落库。
 * 与上传共用数量上限；同一源图已选入过（`copied_from` 命中）则跳过，不再复制第二份。
 * 任何一张超限都整批拒绝，避免「复制了一半」的半成品。
 */
export async function addReferenceImagesFromLibrary(
  kind: AssetKind,
  assetId: number,
  rawUrls: unknown,
): Promise<{ entries: ReferenceImageEntry[]; added: number; skipped: number }> {
  if (!Array.isArray(rawUrls) || !rawUrls.length) throw new MediaLibraryError('urls 必填')
  const urls = rawUrls.map((raw) => {
    const normalized = normalizeLibraryPath(raw)
    // 空串只会来自非法入参（空值 / 畸形 URL），静默跳过会让用户以为选中了
    if (!normalized) throw new MediaLibraryError('存在无效的图片地址')
    return normalized
  })

  const current = await loadReferences(kind, assetId)
  const library = await collectLibraryImages()

  const picked: LibraryImage[] = []
  const alreadyCopied = new Set(current.map(entry => entry.copied_from).filter(Boolean) as string[])
  let skipped = 0
  for (const url of urls) {
    if (alreadyCopied.has(url) || picked.some(image => image.path === url)) {
      skipped += 1
      continue
    }
    const hit = library.find(image => image.path === url)
    if (!hit) throw new MediaLibraryError('该图片不在素材库中，无法选用', 403)
    if (!IMAGE_EXT[path.extname(hit.path).toLowerCase()]) {
      throw new MediaLibraryError('素材库仅支持 jpg/png/webp 图片')
    }
    picked.push(hit)
  }

  if (current.length + picked.length > REFERENCE_IMAGE_MAX_COUNT) {
    throw new MediaLibraryError(`参考图最多 ${REFERENCE_IMAGE_MAX_COUNT} 张，请先删除部分参考图`)
  }

  const uploadedAt = Math.floor(Date.now() / 1000)
  const next = [...current]
  for (const image of picked) {
    const stored = await copyLibraryImage(image, referenceSubDir(kind, assetId))
    next.push({ path: stored, uploaded_at: uploadedAt, copied_from: image.path })
  }
  const entries = await persistReferences(kind, assetId, next)
  return { entries, added: picked.length, skipped }
}
