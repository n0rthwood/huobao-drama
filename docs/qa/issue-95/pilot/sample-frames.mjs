#!/usr/bin/env bun
// Issue #95 试点补充量具（只读）：按秒抽帧看 C 首段 / D 末段有没有可见跳切，并出拼版。
// 用法：bun sample-frames.mjs <episodeId> <outDir> [storyboardId ...]
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/home/joysort/projects/huobao-drama'
const sharp = (await import(`${ROOT}/backend/node_modules/sharp/lib/index.js`)).default
const FFMPEG = `${ROOT}/backend/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg`
const [episodeId, outDir, ...ids] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const db = new Database(`${ROOT}/data/huobao.sqlite3`, { readonly: true })
const rows = db.query(`SELECT s.id, s.storyboard_number n, s.combo, s.video_url v FROM storyboards s
  WHERE s.episode_id = ? AND s.deleted_at IS NULL AND s.combo IN ('C','D') ORDER BY s.storyboard_number`).all(Number(episodeId))
  .filter(r => !ids.length || ids.includes(String(r.id)))
const probe = (file, args) => execFileSync(FFMPEG, ['-v', 'error', '-i', `${ROOT}/data/${file}`, ...args], { encoding: 'utf8' })

const W = 136, H = 240
const rowsTiles = []
for (const r of rows) {
  if (!r.v) { console.log(`shot ${r.n} ${r.combo}: no video`); continue }
  const file = `${ROOT}/data/${r.v}`
  const dur = Number(probe(r.v, ['-f', 'null', '-']).length ? 0 : 0)
  // 时长：ffmpeg 不直接给，用 -sseof 抽末帧即可；抽帧时刻用固定秒数（C 0/0.5/1/2s；D 末 0.4/0.2/0.05s）
  const times = r.combo === 'C' ? [0, 0.5, 1, 2] : null
  const tiles = []
  if (times) {
    for (const t of times) {
      const out = path.join(outDir, `shot-${r.n}-C-t${t}.png`)
      execFileSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', out])
      tiles.push({ t, path: out })
    }
  } else {
    for (const sseof of ['-0.6', '-0.3', '-0.05']) {
      const out = path.join(outDir, `shot-${r.n}-D-sseof${sseof}.png`)
      execFileSync(FFMPEG, ['-y', '-v', 'error', '-sseof', sseof, '-i', file, '-update', '1', '-frames:v', '1', out])
      tiles.push({ t: Number(sseof), path: out })
    }
  }
  rowsTiles.push({ id: r.id, n: r.n, combo: r.combo, video: r.v, tiles })
}
// 拼版：每行一镜，每列一个时刻
const maxCols = Math.max(...rowsTiles.map(row => row.tiles.length))
const comps = []
rowsTiles.forEach((row, ri) => {
  row.tiles.forEach((tile, ci) => {
    comps.push({ input: path.join(outDir, path.basename(tile.path)), left: ci * (W + 4), top: ri * (H + 6) })
  })
})
const sheet = path.join(outDir, 'timeline-samples.png')
await sharp({ create: { width: maxCols * (W + 4), height: rowsTiles.length * (H + 6), channels: 3, background: '#222' } })
  .composite(await Promise.all(comps.map(async c => ({ input: await sharp(c.input).resize(W, H, { fit: 'fill' }).png().toBuffer(), left: c.left, top: c.top }))))
  .png().toFile(sheet)
fs.writeFileSync(path.join(outDir, 'timeline-samples.json'), JSON.stringify({ rows: rowsTiles, sheet, columns: maxCols }, null, 2))
console.log(JSON.stringify(rowsTiles.map(row => ({ n: row.n, combo: row.combo, times: row.tiles.map(t => t.path) }))))
console.log(sheet)
