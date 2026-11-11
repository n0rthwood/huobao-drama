#!/usr/bin/env bun
// Issue #95 验收量具（只读）：衔接帧 vs 视频第 0 帧（C）/末帧（D）灰度 MAE（136×240），并出拼版。
// 用法：bun junction-mae.mjs <episodeId> <outDir> [storyboardId ...]
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
const rows = db.query(`SELECT s.id, s.storyboard_number n, s.combo, s.video_url v, l.junction_path j
  FROM storyboards s JOIN storyboard_layer_segments l ON l.storyboard_id = s.id
  WHERE s.episode_id = ? AND s.deleted_at IS NULL AND s.combo IN ('C','D') ORDER BY s.storyboard_number`).all(Number(episodeId))
  .filter(r => !ids.length || ids.includes(String(r.id)))
const W = 136, H = 240
const gray = f => sharp(f).removeAlpha().resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer()
const results = []
const tiles = []
for (const r of rows) {
  if (!r.v || !r.j) { results.push({ id: r.id, n: r.n, combo: r.combo, error: 'missing video or junction' }); continue }
  const frame = path.join(outDir, `shot-${r.n}-${r.combo === 'C' ? 'first' : 'last'}.png`)
  const args = r.combo === 'C'
    ? ['-y', '-v', 'error', '-i', `${ROOT}/data/${r.v}`, '-frames:v', '1', frame]
    : ['-y', '-v', 'error', '-sseof', '-0.2', '-i', `${ROOT}/data/${r.v}`, '-update', '1', frame]
  execFileSync(FFMPEG, args)
  const [a, b] = await Promise.all([gray(`${ROOT}/data/${r.j}`), gray(frame)])
  let d = 0
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i])
  const mae = Math.round((d / a.length) * 10) / 10
  results.push({ id: r.id, n: r.n, combo: r.combo, video: r.v, junction: r.j, frame, mae, pass: mae <= 10 })
  tiles.push(await sharp(`${ROOT}/data/${r.j}`).resize(W, H, { fit: 'fill' }).png().toBuffer(), await sharp(frame).resize(W, H, { fit: 'fill' }).png().toBuffer())
}
if (tiles.length) {
  const per = 8, pairW = 2 * W + 14
  const count = tiles.length / 2
  const comps = []
  for (let i = 0; i < count; i++) {
    const x = (i % per) * pairW, y = Math.floor(i / per) * (H + 8)
    comps.push({ input: tiles[2 * i], left: x, top: y }, { input: tiles[2 * i + 1], left: x + W + 2, top: y })
  }
  await sharp({ create: { width: Math.min(count, per) * pairW, height: Math.ceil(count / per) * (H + 8), channels: 3, background: '#c00' } })
    .composite(comps).png().toFile(path.join(outDir, 'junction-vs-video.png'))
}
fs.writeFileSync(path.join(outDir, 'junction-mae.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results.map(r => ({ n: r.n, combo: r.combo, mae: r.mae, pass: r.pass, error: r.error }))))
