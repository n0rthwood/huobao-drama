/**
 * 外部素材的本地许可证缓存（Issue #56）
 *
 * 为什么必须落盘：Wikimedia 对本机返回 429/403（资产实验 §6.5），「用时再抓」在 QC
 * 复核时会拿不到当初那张图，事实表就失去可审计性。所以素材一律**先入库再使用**，
 * 文件按内容寻址 `static/asset-sources/<sha256>.<ext>`，同 sha256 不重复落盘。
 *
 * research 步**不自动抓取**：它只产出候选 URL + 许可提示，人工点「入库」才下载
 * （主进程裁决「必须改 1」）。抓取失败降级为人工提供，不阻塞 run。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { getAbsolutePath } from '../../utils/storage.js'
import { logTaskWarn } from '../../utils/task-logger.js'
import { toSourceRow, type AssetKind, type AssetSourceRow, type SourceRole } from './store.js'

const SOURCE_DIR = 'asset-sources'
/** 单个素材上限 32 MB：历史图版扫描件常在 5–20 MB，超过基本是误传视频 */
const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/tiff': '.tif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
}

export class AssetSourceError extends Error {}

function extFor(contentType: string | null, url: string | null): string {
  const mime = (contentType || '').split(';')[0]!.trim().toLowerCase()
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]!
  if (url) {
    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase()
      if (ext && ext.length <= 5) return ext
    } catch {
      // URL 解析失败走默认扩展名
    }
  }
  return '.bin'
}

/** 把字节按 sha256 落盘；同内容已存在就直接复用 */
function storeBytes(bytes: Buffer, ext: string): { sha256: string; relativePath: string } {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const dir = path.join(STORAGE_ROOT, SOURCE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${sha256}${ext}`
  const absolute = path.join(dir, filename)
  if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, bytes)
  return { sha256, relativePath: `static/${SOURCE_DIR}/${filename}` }
}

export interface AddSourceInput {
  assetKind: AssetKind
  assetId: number
  /** 远端地址（服务端下载）、直接上传的文件、本地 static 路径，三选一 */
  url?: string | null
  file?: { bytes: Buffer; filename: string } | null
  localPath?: string | null
  /** 与 localPath 同用：只记录出处页，不重新下载（资料检索的候选图已缓存在本地，#79） */
  sourceUrl?: string | null
  title?: string | null
  artist?: string | null
  license: string
  role: SourceRole
  era?: string | null
  whyExcluded?: string | null
}

/**
 * 入库一条素材。URL 由服务端下载并算 sha256；本地路径（上传后）直接按内容寻址重新落盘，
 * 保证同一张图不论来自上传还是抓取都只有一份文件、一个 sha256。
 */
export async function addAssetSource(input: AddSourceInput): Promise<AssetSourceRow> {
  if (!input.license.trim()) throw new AssetSourceError('必须填写许可信息（license）')
  if (input.role === 'rejected' && !input.whyExcluded?.trim()) {
    throw new AssetSourceError('标记为不可用（rejected）的素材必须写明排除理由')
  }

  let bytes: Buffer
  let ext: string
  let fetchedAt: string | null = null
  if (input.url) {
    let resp: Response
    try {
      resp = await fetch(input.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // 维基系对默认 UA 直接 403；带一个可识别的 UA 是它们文档要求的做法
        headers: { 'User-Agent': 'huobao-drama-asset-pipeline/1.0 (+local research tool)' },
      })
    } catch (err) {
      throw new AssetSourceError(`下载失败：${err instanceof Error ? err.message : String(err)}；可改为本地上传后再入库`)
    }
    if (!resp.ok) throw new AssetSourceError(`下载失败：HTTP ${resp.status}；可改为本地上传后再入库`)
    const raw = Buffer.from(await resp.arrayBuffer())
    if (raw.byteLength > MAX_SOURCE_BYTES) throw new AssetSourceError(`素材超过 ${MAX_SOURCE_BYTES / 1024 / 1024} MB 上限`)
    bytes = raw
    ext = extFor(resp.headers.get('content-type'), input.url)
    fetchedAt = now()
  } else if (input.file) {
    if (input.file.bytes.byteLength > MAX_SOURCE_BYTES) throw new AssetSourceError(`素材超过 ${MAX_SOURCE_BYTES / 1024 / 1024} MB 上限`)
    bytes = input.file.bytes
    ext = path.extname(input.file.filename).toLowerCase() || '.bin'
  } else if (input.localPath) {
    if (!input.localPath.startsWith('static/')) throw new AssetSourceError('local_path 必须是 static/ 下的路径')
    // 前缀检查挡不住 `static/../../etc/passwd`：解析成真实路径后必须仍在 static 根下
    const absolute = path.resolve(getAbsolutePath(input.localPath))
    const staticRoot = path.resolve(path.join(STORAGE_ROOT, '..', 'static'))
    if (absolute !== staticRoot && !absolute.startsWith(staticRoot + path.sep)) {
      throw new AssetSourceError('local_path 越出了 static 目录')
    }
    if (!fs.existsSync(absolute)) throw new AssetSourceError('local_path 指向的文件不存在')
    bytes = fs.readFileSync(absolute)
    ext = path.extname(absolute).toLowerCase() || '.bin'
  } else {
    throw new AssetSourceError('必须提供 url、上传文件或 local_path')
  }

  const { sha256, relativePath } = storeBytes(bytes, ext)
  const [existing] = await db.select().from(schema.assetSource).where(and(
    eq(schema.assetSource.assetKind, input.assetKind),
    eq(schema.assetSource.assetId, input.assetId),
    eq(schema.assetSource.sha256, sha256),
  ))
  if (existing) {
    // 同一张图重复入库：只更新可变的登记信息，不重复落盘也不新建行
    await db.update(schema.assetSource).set({
      url: input.url ?? input.sourceUrl ?? existing.url,
      title: input.title ?? existing.title,
      artist: input.artist ?? existing.artist,
      license: input.license,
      role: input.role,
      whyExcluded: input.whyExcluded ?? null,
      era: input.era ?? existing.era,
    }).where(eq(schema.assetSource.id, existing.id))
    const [updated] = await db.select().from(schema.assetSource).where(eq(schema.assetSource.id, existing.id))
    return toSourceRow(updated!)
  }

  const res = await db.insert(schema.assetSource).values({
    assetKind: input.assetKind,
    assetId: input.assetId,
    url: input.url ?? input.sourceUrl ?? null,
    title: input.title ?? null,
    artist: input.artist ?? null,
    license: input.license,
    sha256,
    localPath: relativePath,
    role: input.role,
    whyExcluded: input.whyExcluded ?? null,
    era: input.era ?? null,
    fetchedAt,
    createdAt: now(),
  })
  const [row] = await db.select().from(schema.assetSource).where(eq(schema.assetSource.id, getInsertId(res)))
  return toSourceRow(row!)
}

export async function deleteAssetSource(id: number): Promise<boolean> {
  const [row] = await db.select().from(schema.assetSource).where(eq(schema.assetSource.id, id))
  if (!row) return false
  await db.delete(schema.assetSource).where(eq(schema.assetSource.id, id))
  // 文件按内容寻址，可能被同一 sha256 的其它登记行共用：没人引用了才删
  const others = await db.select().from(schema.assetSource).where(eq(schema.assetSource.sha256, row.sha256))
  if (!others.length) {
    try {
      fs.rmSync(getAbsolutePath(row.localPath), { force: true })
    } catch (err) {
      logTaskWarn('AssetSource', 'unlink-failed', { id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return true
}
