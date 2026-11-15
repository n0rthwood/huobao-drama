/**
 * 存量文件回填脚本 — 为历史生成的图片/视频补生成缩略图和海报帧
 *
 * 用法：cd backend && npx tsx scripts/backfill-artwork.ts [--dry-run]
 *
 * 扫描数据目录（HUOBAO_DATA_DIR / STORAGE_PATH 决定，与线上一致）下的 static：
 *   图片目录（images/、overlays/、map-drawings/、map-bases/、uploads/archival_images/、
 *   asset-sources/candidates/、layer-frames/，含子目录）→ 为缺少 *_thumb.webp 的图片生成缩略图（宽 400 WebP）
 *   视频目录（videos/、merged/、composed/、layer-segments/）→ 为缺少 *_poster.jpg 的视频抽取海报帧
 * 只新增同目录的旁文件，不改原文件、不写数据库；已存在的跳过，可重复执行。
 * --dry-run 只报告将要生成哪些旁文件，不写盘。
 */
import fs from 'fs'
import path from 'path'
import { generateImageThumb, thumbPathFor, getAbsolutePath } from '../src/utils/storage.js'
import { extractVideoPoster, posterPathFor } from '../src/utils/video-poster.js'
import { STORAGE_ROOT } from '../src/utils/paths.js'

const IMAGE_EXTS: Record<string, true> = { '.png': true, '.jpg': true, '.jpeg': true, '.webp': true, '.gif': true }
const VIDEO_EXTS: Record<string, true> = { '.mp4': true, '.webm': true, '.mov': true }

const IMAGE_DIRS = ['images', 'overlays', 'map-drawings', 'map-bases', 'uploads/archival_images', 'asset-sources/candidates', 'layer-frames']
const VIDEO_DIRS = ['videos', 'merged', 'composed', 'layer-segments']

const DRY_RUN = process.argv.includes('--dry-run')

/** 递归列出 subDir 下所有文件，返回统一用 `/` 分隔的 `subDir/.../file`（跳过子目录里的软链） */
function listFiles(subDir: string): string[] {
  const dir = path.join(STORAGE_ROOT, subDir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = `${subDir}/${entry.name}`
    if (entry.isDirectory()) return listFiles(rel)
    return entry.isFile() ? [rel] : []
  })
}

async function backfillImages(subDir: string) {
  let done = 0, skipped = 0, failed = 0
  for (const file of listFiles(subDir)) {
    const ext = path.extname(file).toLowerCase()
    if (!IMAGE_EXTS[ext] || file.endsWith('_thumb.webp')) continue
    const rel = `static/${file}`
    if (fs.existsSync(getAbsolutePath(thumbPathFor(rel)))) { skipped++; continue }
    if (DRY_RUN) {
      done++
      console.log(`  thumb … ${rel}（dry-run，未写入）`)
      continue
    }
    const ok = await generateImageThumb(rel)
    ok ? done++ : failed++
    if (ok) console.log(`  thumb ✓ ${rel}`)
    else console.warn(`  thumb ✗ ${rel}`)
  }
  console.log(`[${subDir}] 缩略图：${DRY_RUN ? '待生成' : '新生成'} ${done}，已存在 ${skipped}，失败 ${failed}`)
}

async function backfillVideos(subDir: string) {
  let done = 0, skipped = 0, failed = 0
  for (const file of listFiles(subDir)) {
    const ext = path.extname(file).toLowerCase()
    if (!VIDEO_EXTS[ext]) continue
    const rel = `static/${file}`
    if (fs.existsSync(getAbsolutePath(posterPathFor(rel)))) { skipped++; continue }
    if (DRY_RUN) {
      done++
      console.log(`  poster … ${rel}（dry-run，未写入）`)
      continue
    }
    const ok = await extractVideoPoster(rel)
    ok ? done++ : failed++
    if (ok) console.log(`  poster ✓ ${rel}`)
    else console.warn(`  poster ✗ ${rel}`)
  }
  console.log(`[${subDir}] 海报帧：${DRY_RUN ? '待生成' : '新生成'} ${done}，已存在 ${skipped}，失败 ${failed}`)
}

console.log(`回填目录：${STORAGE_ROOT}${DRY_RUN ? '（dry-run，只报告不写盘）' : ''}`)
for (const subDir of IMAGE_DIRS) await backfillImages(subDir)
for (const subDir of VIDEO_DIRS) await backfillVideos(subDir)
console.log('回填完成')
