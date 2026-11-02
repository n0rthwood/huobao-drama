/**
 * 历史画像（史料参考，Issue #32）— 与 reference_images 严格分离
 *
 * 为什么必须分开：角色只要带了 reference_images 就走 image_edit，输出跟随第 1 张参考图的
 * 构图（services/generation.ts 的 isKeyframe 判定），把维基油画半身像塞进去会把
 * 「三视图设定图」直接变成「对那张油画做图生图」。所以画像只落 characters.archival_images，
 * **生图链路任何环节都不读它**；对定妆图的影响只通过「把画像特征文本化写进 appearance/styling」实现。
 *
 * 入库口只有 Commons 文件标题（服务端按白名单拉取），不接受任意外部 URL（防 SSRF）。
 */
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { saveImageBuffer } from '../utils/storage.js'
import { commonsFileInfo, fetchCommonsBytes } from './wiki-research.js'

/** 史料画像条目：图片本体 + 完整溯源元数据（来源页/作者/年代/许可证/取用时间） */
export interface ArchivalImageEntry {
  path: string
  file_title: string
  source_page_url: string
  file_url: string
  artist: string
  work_date: string
  license: string
  license_url: string
  retrieved_at: string
}

export const ARCHIVAL_IMAGE_MAX_COUNT = 10
/** Commons 原图可以很大，落库前限 25MB */
export const ARCHIVAL_IMAGE_MAX_BYTES = 25 * 1024 * 1024
const ARCHIVAL_MIME: Record<string, true> = { 'image/jpeg': true, 'image/png': true, 'image/webp': true }

export class ArchivalImageError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ArchivalImageError'
    this.status = status
  }
}

function archivalSubDir(characterId: number) {
  return `uploads/archival_images/character/${characterId}`
}

function toEntry(item: unknown): ArchivalImageEntry | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  if (typeof row.path !== 'string' || !row.path) return null
  return {
    path: row.path,
    file_title: typeof row.file_title === 'string' ? row.file_title : '',
    source_page_url: typeof row.source_page_url === 'string' ? row.source_page_url : '',
    file_url: typeof row.file_url === 'string' ? row.file_url : '',
    artist: typeof row.artist === 'string' ? row.artist : '',
    work_date: typeof row.work_date === 'string' ? row.work_date : '',
    license: typeof row.license === 'string' ? row.license : '',
    license_url: typeof row.license_url === 'string' ? row.license_url : '',
    retrieved_at: typeof row.retrieved_at === 'string' ? row.retrieved_at : '',
  }
}

export function parseArchivalImages(raw: unknown): ArchivalImageEntry[] {
  if (!raw || typeof raw !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(toEntry).filter((e): e is ArchivalImageEntry => !!e)
  } catch {
    return []
  }
}

async function loadCharacter(characterId: number) {
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  if (!row) throw new ArchivalImageError('角色不存在', 404)
  return row
}

export async function listArchivalImages(characterId: number): Promise<ArchivalImageEntry[]> {
  return parseArchivalImages((await loadCharacter(characterId)).archivalImages)
}

async function persist(characterId: number, entries: ArchivalImageEntry[]): Promise<ArchivalImageEntry[]> {
  await db.update(schema.characters)
    .set({ archivalImages: entries.length ? JSON.stringify(entries) : null, updatedAt: now() })
    .where(eq(schema.characters.id, characterId))
  return entries
}

/** 按 Commons 文件标题入库一张史料画像（服务端拉取 + 解析 extmetadata） */
export async function addArchivalImage(characterId: number, fileTitle: string): Promise<ArchivalImageEntry[]> {
  const current = await listArchivalImages(characterId)
  if (current.length >= ARCHIVAL_IMAGE_MAX_COUNT) {
    throw new ArchivalImageError(`史料参考最多 ${ARCHIVAL_IMAGE_MAX_COUNT} 张，请先删除部分画像`)
  }
  const info = await commonsFileInfo(fileTitle)
  if (current.some(entry => entry.file_title === info.file_title)) {
    throw new ArchivalImageError('该画像已在本角色的史料参考中')
  }
  if (!ARCHIVAL_MIME[info.mime]) throw new ArchivalImageError(`不支持的图片类型：${info.mime || '未知'}`)

  const { bytes, mime } = await fetchCommonsBytes(info.file_url)
  if (bytes.byteLength > ARCHIVAL_IMAGE_MAX_BYTES) {
    throw new ArchivalImageError(`画像文件超过 ${Math.round(ARCHIVAL_IMAGE_MAX_BYTES / 1024 / 1024)}MB`)
  }
  const stored = await saveImageBuffer(bytes, ARCHIVAL_MIME[mime] ? mime : info.mime, archivalSubDir(characterId))
  const entry: ArchivalImageEntry = {
    path: stored,
    file_title: info.file_title,
    source_page_url: info.source_page_url,
    file_url: info.file_url,
    artist: info.artist,
    work_date: info.work_date,
    license: info.license,
    license_url: info.license_url,
    retrieved_at: new Date().toISOString(),
  }
  return persist(characterId, [...current, entry])
}

/** 删除一张史料画像：先落库再尽力删文件（只允许删该角色自己目录下的文件） */
export async function removeArchivalImage(characterId: number, target: string): Promise<ArchivalImageEntry[]> {
  const value = String(target || '').trim()
  if (!value) throw new ArchivalImageError('path 必填')
  const current = await listArchivalImages(characterId)
  const index = current.findIndex(entry => entry.path === value)
  if (index < 0) throw new ArchivalImageError('画像不存在', 404)
  const next = current.filter((_, i) => i !== index)
  await persist(characterId, next)

  const dir = path.resolve(STORAGE_ROOT, archivalSubDir(characterId))
  const abs = path.resolve(STORAGE_ROOT, value.replace(/^static\//, ''))
  if (abs.startsWith(dir + path.sep)) {
    try { fs.unlinkSync(abs) } catch { /* 文件残留无害，库里不留悬挂条目才重要 */ }
  }
  return next
}
