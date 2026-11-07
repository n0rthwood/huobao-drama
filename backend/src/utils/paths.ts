/**
 * 数据目录统一解析 — 全项目唯一的路径锚点
 *
 * dev：锚定仓库根 data/（__dirname 相对推断，src 与 tsc 产物深度一致）。
 * Electron 桌面版：主进程注入 HUOBAO_DATA_DIR 指向 userData 可写目录
 * （打包后 asar 内的 __dirname 相对推断不可用，写路径必须落在包外）。
 *
 * STORAGE_PATH 语义保持不变：仅覆盖 static 存储根；未注入 HUOBAO_DATA_DIR
 * 时以其父目录为数据根，保证 getAbsolutePath('static/...') 的既有行为。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/utils → 上三级为仓库根
const repoRoot = path.resolve(__dirname, '../../..')

export const DATA_ROOT = process.env.HUOBAO_DATA_DIR
  ?? (process.env.STORAGE_PATH
    ? path.dirname(path.resolve(process.env.STORAGE_PATH))
    : path.join(repoRoot, 'data'))

export const STORAGE_ROOT = process.env.STORAGE_PATH ?? path.join(DATA_ROOT, 'static')

/**
 * 媒体相对路径 → 绝对路径（全项目唯一实现）。
 * `static/...` 锚在数据根，其余锚在存储根；解析结果（含软链指向）必须留在本项目数据目录内。
 */
export function toAbsPath(relativePath: string): string {
  const resolved = path.resolve(path.isAbsolute(relativePath) ? relativePath : relativePath.startsWith('static/') ? path.join(DATA_ROOT, relativePath) : path.join(STORAGE_ROOT, relativePath))
  const roots = [path.resolve(DATA_ROOT), path.resolve(STORAGE_ROOT)]
  if (!roots.some(root => resolved.startsWith(root + path.sep))) throw new Error('媒体路径必须位于本项目数据目录内')
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved)
    if (!roots.some(root => fs.existsSync(root) && real.startsWith(fs.realpathSync(root) + path.sep))) throw new Error('媒体路径不能指向项目数据目录之外')
  }
  return resolved
}
