/**
 * 资产参考图服务 — 角色 / 场景 / 道具共用一套持久化参考图
 *
 * 语义边界（与成片图严格分离）：
 * - `reference_images`：用户上传的「输入」参考图，JSON 字符串数组（相对路径 static/...），只由本服务写
 * - `image_url` / `local_path`：生图或用户直传的「输出」成片图，本服务绝不触碰
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

/** 存储子目录（相对 STORAGE_ROOT），saveUploadedFile 返回 `static/<subDir>/<uuid><ext>` */
function referenceSubDir(kind: AssetKind, assetId: number) {
  return `uploads/reference_images/${kind}/${assetId}`
}

/**
 * 宽容读取历史值：NULL / 空串 / 非法 JSON / 非数组 → []
 * 合法 JSON 数组按字符串过滤；旧数据若是裸路径/URL 则视为单张。
 */
export function parseReferenceImages(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(item => String(item ?? '').trim()).filter(Boolean)
  }
  if (typeof raw !== 'string') return []
  const text = raw.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed.map(item => String(item ?? '').trim()).filter(Boolean)
    } catch {}
    return []
  }
  return /^(https?:\/\/|\/?static\/)/.test(text) ? [text] : []
}

/**
 * 生成时的有效参考图：
 * 请求未带 reference_images → 用资产保存的参考图；带了（含空数组）→ 以请求为准。
 */
export function resolveReferenceImages(saved: unknown, override?: unknown): string[] {
  if (override !== undefined && override !== null) return parseReferenceImages(override)
  return parseReferenceImages(saved)
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

async function loadReferences(kind: AssetKind, assetId: number): Promise<string[]> {
  const table = ASSET_TABLES[kind]
  const [row] = await db.select().from(table).where(eq(table.id, assetId))
  if (!row) throw new ReferenceImageError(`${ASSET_LABELS[kind]}不存在`, 404)
  return parseReferenceImages(row.referenceImages)
}

async function persist(kind: AssetKind, assetId: number, refs: string[]): Promise<string[]> {
  const table = ASSET_TABLES[kind]
  await db.update(table)
    .set({ referenceImages: refs.length ? JSON.stringify(refs) : null, updatedAt: now() })
    .where(eq(table.id, assetId))
  return refs
}

/** 追加一张参考图：校验 → 落盘 → 入库（成片图 image_url/local_path 不受影响） */
export async function addReferenceImage(kind: AssetKind, assetId: number, file: File): Promise<string[]> {
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
  const next = current.includes(stored) ? current : [...current, stored]
  return persist(kind, assetId, next)
}

/**
 * 删除一张参考图：先落库（去掉条目），再尽力删文件。
 * 文件残留无害，库里留悬挂条目有害，故顺序不可反。
 * 只允许删除该资产自己目录下的文件（精确匹配 + 前缀 + 绝对路径双重校验）。
 */
export async function removeReferenceImage(kind: AssetKind, assetId: number, target: string): Promise<string[]> {
  const value = String(target || '').trim()
  if (!value) throw new ReferenceImageError('url 必填')
  const current = await loadReferences(kind, assetId)
  const index = current.indexOf(value)
  if (index < 0) throw new ReferenceImageError('参考图不存在', 404)

  const next = current.filter((_, i) => i !== index)
  await persist(kind, assetId, next)

  const abs = ownedAbsolutePath(kind, assetId, value)
  if (abs) {
    unlinkQuietly(abs)
    unlinkQuietly(ownedAbsolutePath(kind, assetId, thumbPathFor(value)))
  }
  return next
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
