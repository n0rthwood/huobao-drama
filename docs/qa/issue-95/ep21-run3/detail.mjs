// per-shot detail sheet: junction | frame@0 | frame@0.5 | frame@1.2  (read-only)
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const ROOT = '/home/joysort/projects/huobao-drama'
const sharp = (await import(`${ROOT}/backend/node_modules/sharp/lib/index.js`)).default
const FFMPEG = `${ROOT}/backend/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg`
const outDir = 'run3/detail'
fs.mkdirSync(outDir, { recursive: true })
const db = new Database(`${ROOT}/data/huobao.sqlite3`, { readonly: true })
const ids = [575,579,580,581,584,585,591]
const rows = db.query(`SELECT s.id, s.storyboard_number n, s.combo, s.video_url v, l.junction_path j FROM storyboards s JOIN storyboard_layer_segments l ON l.storyboard_id=s.id WHERE s.id IN (${ids.join(',')}) ORDER BY s.storyboard_number`).all()
const W = 300, H = 528
for (const r of rows) {
  const tiles = []
  tiles.push({ label: 'junction', buf: await sharp(`${ROOT}/data/${r.j}`).resize(W, H, { fit: 'fill' }).png().toBuffer() })
  for (const t of [0, 0.5, 1.2, 2.5]) {
    const f = path.join(outDir, `sb${r.id}-t${t}.png`)
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t), '-i', `${ROOT}/data/${r.v}`, '-frames:v', '1', f])
    tiles.push({ label: `t=${t}`, buf: await sharp(f).resize(W, H, { fit: 'fill' }).png().toBuffer() })
  }
  const comps = tiles.map((t, i) => ({ input: t.buf, left: i * (W + 4), top: 0 }))
  const sheet = path.join(outDir, `sb${r.id}-n${r.n}.png`)
  await sharp({ create: { width: tiles.length * (W + 4), height: H, channels: 3, background: '#111' } }).composite(comps).png().toFile(sheet)
  console.log(sheet, r.n, r.v)
}
