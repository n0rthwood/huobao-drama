import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'

/**
 * 历史任务的衔接帧解码结果按「真实路径 + size + mtime」缓存（Issue #118 C）：
 * 批量预览每 15s 重算整集历史版本签名，同一张 layer-frame PNG 不必每次重新 sharp 解码。
 * 文件内容变化（size/mtime 变）即失效；哈希仍对实际字节计算，不拿文件名冒充证据。
 */
const junctionDecodeCache = new Map<string, { slot: 'first' | 'last'; hash: string } | null>()

async function decodedJunctionOf(file: string, slot: 'first' | 'last'): Promise<{ slot: 'first' | 'last'; hash: string } | null> {
  const stat = fs.statSync(file)
  if (!stat.isFile()) return null
  const real = fs.realpathSync(file)
  const key = `${real}:${stat.size}:${stat.mtimeMs}`
  if (junctionDecodeCache.has(key)) return junctionDecodeCache.get(key) ?? null
  let result: { slot: 'first' | 'last'; hash: string } | null = null
  const bytes = fs.readFileSync(real)
  // Historical guides are PNGs emitted by the layer renderer. Decode the saved
  // bytes before trusting their hash; a filename alone is not evidence.
  const metadata = await sharp(bytes).metadata()
  if (metadata.format === 'png') {
    await sharp(bytes).raw().toBuffer()
    result = { slot, hash: createHash('sha256').update(bytes).digest('hex') }
  }
  if (junctionDecodeCache.size > 500) junctionDecodeCache.clear()
  junctionDecodeCache.set(key, result)
  return result
}

/** New tasks persist the lock. Historical tasks are comparable only when one saved guide is an actual local layer-frame file. Never rewrite the historical task. */
export async function videoTaskJunction(params: Record<string, unknown>): Promise<{ slot: 'first' | 'last'; hash: string } | null> {
  if (typeof params.junction_hash === 'string' && /^[a-f0-9]{64}$/.test(params.junction_hash) && (params.junction_slot === 'first' || params.junction_slot === 'last')) {
    return { slot: params.junction_slot, hash: params.junction_hash }
  }
  // Partial/corrupt explicit snapshots are not historical missing-field records.
  if (params.junction_hash !== undefined || params.junction_slot !== undefined) return null
  const candidates: Array<{ slot: 'first' | 'last'; hash: string }> = []
  const root = path.resolve(STORAGE_ROOT, 'layer-frames')
  for (const slot of ['first', 'last'] as const) {
    const source = params[slot === 'first' ? 'firstFrameUrl' : 'lastFrameUrl']
    if (typeof source !== 'string') continue
    try {
      const file = path.resolve(source.startsWith('static/') ? DATA_ROOT : STORAGE_ROOT, source)
      if (!file.startsWith(root + path.sep)) continue
      const real = fs.realpathSync(file)
      if (!real.startsWith(fs.realpathSync(root) + path.sep)) continue
      const decoded = await decodedJunctionOf(file, slot)
      if (decoded) candidates.push(decoded)
    } catch {
      // Missing/corrupt files, permissions, broken links and concurrent deletes
      // make this historical snapshot unknown, not a request failure.
    }
  }
  // Two layer-frame guides have ambiguous ownership without an explicit slot; classify safely as unknown.
  return candidates.length === 1 ? candidates[0] : null
}
