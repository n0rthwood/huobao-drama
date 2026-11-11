// SSIM diagnostic (read-only): ffmpeg ssim between junction PNG and the extracted video frame.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const ROOT = '/home/joysort/projects/huobao-drama'
const FFMPEG = `${ROOT}/backend/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg`
const QADIR = '/home/joysort/projects/huobao-drama-issue-95/docs/qa/issue-95'
const res = JSON.parse(fs.readFileSync('all/junction-mae.json', 'utf8'))
const out = []
for (const r of res) {
  const frame = fs.existsSync(r.frame) ? r.frame : `${QADIR}/${r.frame}`
  const cmd = `${FFMPEG} -hide_banner -i ${ROOT}/data/${r.junction} -i ${frame} -lavfi '[0:v][1:v]ssim' -f null - 2>&1`
  let txt = ''
  try { txt = execFileSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 22 }) }
  catch (e) { txt = String(e.stdout || '') + String(e.stderr || '') }
  const m = txt.match(/All:([0-9.]+)/)
  out.push({ n: r.n, id: r.id, combo: r.combo, mae: r.mae, pass: r.pass, ssim: m ? Number(m[1]) : null })
}
fs.writeFileSync('all/junction-ssim.json', JSON.stringify(out, null, 2))
console.log(out.map(o => `${o.n}\t${o.id}\t${o.combo}\tmae=${o.mae}\tssim=${o.ssim}\t${o.pass ? 'PASS' : 'FAIL'}`).join('\n'))
