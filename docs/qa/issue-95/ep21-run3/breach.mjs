// When does the generated video first leave the junction frame? (read-only diagnostic)
// Extract frames every 0.25 s for the first 2 s and report MAE vs the junction PNG.
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const ROOT = '/home/joysort/projects/huobao-drama'
const sharp = (await import(ROOT + '/backend/node_modules/sharp/lib/index.js')).default
const FFMPEG = ROOT + '/backend/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg'
const db = new Database(ROOT + '/data/huobao.sqlite3', { readonly: true })
const ids = [575, 579, 580, 581, 584, 585, 591]
const outDir = 'run3/breach'
fs.mkdirSync(outDir, { recursive: true })
const W = 136, H = 240
const gray = async f => sharp(f).removeAlpha().resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer()
const rows = db.query(`SELECT s.id, s.storyboard_number n, s.video_url v, l.junction_path j FROM storyboards s JOIN storyboard_layer_segments l ON l.storyboard_id=s.id WHERE s.id IN (${ids.join(',')}) ORDER BY s.storyboard_number`).all()
const report = []
for (const r of rows) {
  const jg = await gray(path.join(ROOT, 'data', r.j))
  const times = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
  const series = []
  let breach = null
  for (const t of times) {
    const f = path.join(outDir, 'sb' + r.id + '-t' + t + '.png')
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', path.join(ROOT, 'data', r.v), '-frames:v', '1', f])
    const vg = await gray(f)
    let d = 0
    for (let i = 0; i < jg.length; i++) d += Math.abs(jg[i] - vg[i])
    const mae = Math.round((d / jg.length) * 10) / 10
    series.push({ t, mae })
    if (breach === null && mae > 25) breach = t
  }
  report.push({ id: r.id, n: r.n, series, firstBreach: breach })
}
fs.writeFileSync('run3/breach.json', JSON.stringify(report, null, 2))
for (const r of report) console.log(`#${r.n} ${r.id} breach@${r.firstBreach}  ` + r.series.map(s => `${s.t}s:${s.mae}`).join(' '))
