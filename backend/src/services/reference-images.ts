/**
 * 资产参考图服务 — 角色 / 场景 / 道具共用一套持久化参考图
 *
 * 语义边界（与成片图严格分离）：
 * - `reference_images`：用户上传的「输入」参考图，JSON 对象数组 `[{ path, uploaded_at }]`
 *   （`path` 为相对路径 static/...，`uploaded_at` 为 unix 秒，文件缺失的存量数据为 null），
 *   只由本服务写；
 * - `image_url` / `local_path`：生图或用户直传的「输出」成片图，本服务绝不触碰。
 *
 * 旧版存的是裸路径字符串数组，启动时由 `migrateReferenceImages()` 一次性转成对象数组
 * （`uploaded_at` 取文件 mtime，文件不存在则 null），**不保留字符串兼容分支**。
 *
 * 落盘位置 static/uploads/reference_images/{kind}/{assetId}/{uuid}.{ext}，与成片图共用
 * /static 静态托管与缩略图链路（thumbOf → *_thumb.webp），前端零配置可预览。
 */
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { generateImageThumb, getAbsolutePath, saveUploadedFile, thumbPathFor } from '../utils/storage.js'
import { logTaskWarn } from '../utils/task-logger.js'

export type AssetKind = 'character' | 'scene' | 'prop'

/**
 * 持久化的参考图条目（上传时间为 unix 秒；存量数据文件缺失时为 null，前端不显示时间）。
 * `copied_from` 只由「从素材库选择」写入，记源图相对路径，用于同一资产的重复选入去重。
 */
export interface ReferenceImageEntry {
  path: string
  uploaded_at: number | null
  copied_from?: string
}

/**
 * 三张资产表在本服务只用到 id / reference_images / updated_at，列定义完全一致；
 * 统一按 characters 的静态类型使用，避免 drizzle 三表联合类型在 select/update 处爆炸。
 */
const ASSET_TABLES = {
  character: schema.characters,
  scene: schema.scenes,
  prop: schema.props,
} as unknown as Record<AssetKind, typeof schema.characters>

export const ASSET_LABELS: Record<AssetKind, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
}

/** 应用级上限（非厂商能力）：厂商张数限制由各 adapter 报错，不在此静默截断 */
export const REFERENCE_IMAGE_MAX_COUNT = 10
export const REFERENCE_IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 10MB
/** 与 routes/upload.ts 的媒体校验保持一致：MIME 可伪造，扩展名兜底 */
const IMAGE_EXT: Record<string, true> = { '.jpg': true, '.jpeg': true, '.png': true, '.webp': true }
const IMAGE_MIME: Record<string, true> = { 'image/jpeg': true, 'image/jpg': true, 'image/png': true, 'image/webp': true }

export class ReferenceImageError extends Error {
  status: 400 | 404
  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.status = status
  }
}

/** 存储子目录（相对 STORAGE_ROOT），saveUploadedFile 返回 `static/<subDir>/<uuid><ext>`；
 *  资产导入复制参考图时也用它定位新资产自己的目录（services/asset-library.ts） */
export function referenceSubDir(kind: AssetKind, assetId: number) {
  return `uploads/reference_images/${kind}/${assetId}`
}

function toEntry(item: unknown): ReferenceImageEntry | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const value = String(record.path ?? '').trim()
  if (!value) return null
  const uploadedAt = Number(record.uploaded_at)
  const copiedFrom = String(record.copied_from ?? '').trim()
  const entry: ReferenceImageEntry = {
    path: value,
    uploaded_at: Number.isFinite(uploadedAt) && uploadedAt > 0 ? Math.floor(uploadedAt) : null,
  }
  if (copiedFrom) entry.copied_from = copiedFrom
  return entry
}

/**
 * 读取持久化值 → 条目数组。NULL / 空串 / 非法 JSON / 非数组 → []。
 * 只认对象形态；旧的字符串条目由启动迁移负责转换（见 migrateReferenceImages）。
 */
export function parseReferenceImages(raw: unknown): ReferenceImageEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : (() => {
      if (typeof raw !== 'string') return []
      const text = raw.trim()
      if (!text.startsWith('[')) return []
      try {
        const parsed: unknown = JSON.parse(text)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })()
  return list.map(toEntry).filter((entry): entry is ReferenceImageEntry => !!entry)
}

/** 条目数组 → 路径数组（生图组装只关心路径） */
export function referenceImagePaths(entries: ReferenceImageEntry[]): string[] {
  return entries.map(entry => entry.path)
}

/**
 * 生成时的有效参考图路径：
 * 请求未带 reference_images → 用资产保存的参考图；带了（含空数组）→ 以请求为准。
 * 请求侧允许裸路径数组（生图入参本来就只是路径）或条目数组。
 */
export function resolveReferenceImages(saved: unknown, override?: unknown): string[] {
  if (override !== undefined && override !== null) {
    if (!Array.isArray(override)) return []
    return override
      .map(item => (typeof item === 'string' ? item.trim() : toEntry(item)?.path ?? ''))
      .filter(Boolean)
  }
  return referenceImagePaths(parseReferenceImages(saved))
}

/**
 * 分离磁盘上已不存在的本地参考图（远程 URL / data URL 原样保留）。
 * 只读：不改库、不自动清理，缺失项由用户在前端删除。
 */
export function partitionMissingReferences(refs: string[]): { present: string[]; missing: string[] } {
  const present: string[] = []
  const missing: string[] = []
  for (const ref of refs) {
    if (!(ref.startsWith('static/') || ref.startsWith('/static/'))) {
      present.push(ref)
      continue
    }
    if (fs.existsSync(getAbsolutePath(ref.startsWith('/') ? ref.slice(1) : ref))) present.push(ref)
    else missing.push(ref)
  }
  return { present, missing }
}

/** 读取某资产的参考图条目（资产不存在报 404）；素材库选图也经此读当前状态 */
export async function loadReferences(kind: AssetKind, assetId: number): Promise<ReferenceImageEntry[]> {
  const table = ASSET_TABLES[kind]
  const [row] = await db.select().from(table).where(eq(table.id, assetId))
  if (!row) throw new ReferenceImageError(`${ASSET_LABELS[kind]}不存在`, 404)
  return parseReferenceImages(row.referenceImages)
}

/** 参考图列唯一写入点（素材库选图经 persistReferences 走同一入口） */
export async function persistReferences(kind: AssetKind, assetId: number, refs: ReferenceImageEntry[]): Promise<ReferenceImageEntry[]> {
  const table = ASSET_TABLES[kind]
  await db.update(table)
    .set({ referenceImages: refs.length ? JSON.stringify(refs) : null, updatedAt: now() })
    .where(eq(table.id, assetId))
  return refs
}

/** 追加一张参考图：校验 → 落盘 → 入库（成片图 image_url/local_path 不受影响） */
export async function addReferenceImage(kind: AssetKind, assetId: number, file: File): Promise<ReferenceImageEntry[]> {
  const current = await loadReferences(kind, assetId)
  if (current.length >= REFERENCE_IMAGE_MAX_COUNT) {
    throw new ReferenceImageError(`参考图最多 ${REFERENCE_IMAGE_MAX_COUNT} 张，请先删除部分参考图`)
  }
  const ext = path.extname(file.name || '').toLowerCase()
  // MIME 可伪造，扩展名兜底；空 / octet-stream 视为未知类型，仅按扩展名校验
  const mimeKnown = file.type && file.type !== 'application/octet-stream'
  if (!IMAGE_EXT[ext] || (mimeKnown && !IMAGE_MIME[file.type.toLowerCase()])) {
    throw new ReferenceImageError('参考图仅支持 jpg/png/webp 格式')
  }
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > REFERENCE_IMAGE_MAX_BYTES) {
    throw new ReferenceImageError(`参考图大小不能超过 ${Math.round(REFERENCE_IMAGE_MAX_BYTES / 1024 / 1024)}MB`)
  }
  const stored = await saveUploadedFile(buffer, referenceSubDir(kind, assetId), file.name)
  // 与上传/生图一致：同步生成列表缩略图，失败不阻断
  await generateImageThumb(stored)
  const uploadedAt = Math.floor(Date.now() / 1000)
  const next = current.some(entry => entry.path === stored)
    ? current
    : [...current, { path: stored, uploaded_at: uploadedAt }]
  return persistReferences(kind, assetId, next)
}

/**
 * 删除一张参考图：先落库（去掉条目），再尽力删文件。
 * 文件残留无害，库里留悬挂条目有害，故顺序不可反。
 * 只允许删除该资产自己目录下的文件（精确匹配 + 前缀 + 绝对路径双重校验）。
 */
export async function removeReferenceImage(kind: AssetKind, assetId: number, target: string): Promise<ReferenceImageEntry[]> {
  const value = String(target || '').trim()
  if (!value) throw new ReferenceImageError('url 必填')
  const current = await loadReferences(kind, assetId)
  const index = current.findIndex(entry => entry.path === value)
  if (index < 0) throw new ReferenceImageError('参考图不存在', 404)

  const next = current.filter((_, i) => i !== index)
  await persistReferences(kind, assetId, next)

  const abs = ownedAbsolutePath(kind, assetId, value)
  if (abs) {
    unlinkQuietly(abs)
    unlinkQuietly(ownedAbsolutePath(kind, assetId, thumbPathFor(value)))
  }
  return next
}

/**
 * 启动迁移：旧的字符串路径数组 → `[{ path, uploaded_at }]`。
 * `uploaded_at` 取文件 mtime（参考图上传后不再改写，可近似上传时间），文件不存在则 null。
 * 幂等：已是对象形态的行不写库。
 */
export async function migrateReferenceImages(): Promise<number> {
  let migrated = 0
  for (const kind of Object.keys(ASSET_TABLES) as AssetKind[]) {
    const table = ASSET_TABLES[kind]
    const rows = await db.select().from(table)
    for (const row of rows) {
      const raw = row.referenceImages
      if (!raw) continue
      let list: unknown[]
      try {
        const parsed: unknown = JSON.parse(String(raw))
        if (!Array.isArray(parsed)) continue
        list = parsed
      } catch {
        continue
      }
      if (!list.some(item => typeof item === 'string')) continue
      const entries = list
        .map((item) => {
          if (typeof item !== 'string') return toEntry(item)
          const value = item.trim()
          if (!value) return null
          return { path: value, uploaded_at: fileMtimeSeconds(value) }
        })
        .filter((entry): entry is ReferenceImageEntry => !!entry)
      await db.update(table)
        .set({ referenceImages: entries.length ? JSON.stringify(entries) : null })
        .where(eq(table.id, row.id))
      migrated += 1
    }
  }
  if (migrated > 0) console.log(`🖼️  已迁移 ${migrated} 行参考图存储结构（[{path, uploaded_at}]）`)
  return migrated
}

/** 本地参考图文件的 mtime（unix 秒）；远程 URL / 文件缺失 → null */
function fileMtimeSeconds(stored: string): number | null {
  if (!(stored.startsWith('static/') || stored.startsWith('/static/'))) return null
  try {
    const stat = fs.statSync(getAbsolutePath(stored.startsWith('/') ? stored.slice(1) : stored))
    return Math.floor(stat.mtimeMs / 1000)
  } catch {
    return null
  }
}

/**
 * 资产被删除时清掉它自己的参考图目录（best-effort）。
 * 目录名只由 kind + 数字 id 推导，不含任何用户输入；失败只告警不影响删除。
 */
export function deleteAllReferenceImages(kind: AssetKind, assetId: number) {
  if (!Number.isInteger(assetId) || assetId <= 0) return
  const dir = path.resolve(getAbsolutePath(`static/${referenceSubDir(kind, assetId)}`))
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    logTaskWarn('ReferenceImage', 'cleanup-failed', { path: dir, error: (err as Error).message })
  }
}

/** 仅当路径确实落在该资产自己的参考图目录内才返回绝对路径，否则 null（防目录穿越/误删） */
function ownedAbsolutePath(kind: AssetKind, assetId: number, stored: string): string | null {
  const raw = String(stored || '')
  const rel = raw.startsWith('/') ? raw.slice(1) : raw
  if (!rel.startsWith(`static/${referenceSubDir(kind, assetId)}/`) || rel.includes('..')) return null
  const dir = path.resolve(getAbsolutePath(`static/${referenceSubDir(kind, assetId)}`))
  const abs = path.resolve(getAbsolutePath(rel))
  return abs.startsWith(dir + path.sep) ? abs : null
}

function unlinkQuietly(abs: string | null) {
  if (!abs) return
  try {
    fs.rmSync(abs, { force: true })
  } catch (err) {
    logTaskWarn('ReferenceImage', 'unlink-failed', { path: abs, error: (err as Error).message })
  }
}
