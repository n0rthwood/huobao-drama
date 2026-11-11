// tonal/structural split for the 7 regenerated shots (read-only diagnostic, not the gate)
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
const ROOT = '/home/joysort/projects/huobao-drama'
const sharp = (await import(`${ROOT}/backend/node_modules/sharp/lib/index.js`)).default
const QADIR = '/home/joysort/projects/huobao-drama-issue-95/docs/qa/issue-95'
const res = JSON.parse(fs.readFileSync('all/junction-mae.json', 'utf8'))
const W = 136, H = 240
const gray = async f => ({ buf: await sharp(f).removeAlpha().resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer() })
const out = []
for (const r of res) {
  const frame = fs.existsSync(r.frame) ? r.frame : `${QADIR}/${r.frame}`
  const a = (await gray(`${ROOT}/data/${r.junction}`)).buf
  const b = (await gray(frame)).buf
  let d = 0, sa = 0, sb = 0
  for (let i = 0; i < a.length; i++) { d += Math.abs(a[i] - b[i]); sa += a[i]; sb += b[i] }
  const n = a.length
  const mae = d / n
  const meanA = sa / n, meanB = sb / n
  let dN = 0
  for (let i = 0; i < a.length; i++) { dN += Math.abs((a[i] - meanA) - (b[i] - meanB)) }
  out.push({ n: r.n, id: r.id, mae: Math.round(mae * 10) / 10, junctionMean: Math.round(meanA * 10) / 10, frameMean: Math.round(meanB * 10) / 10, meanShift: Math.round((meanB - meanA) * 10) / 10, maeAfterMeanShift: Math.round((dN / n) * 10) / 10 })
}
fs.writeFileSync('all/junction-tone.json', JSON.stringify(out, null, 2))
console.log(out.map(o => `${o.n}\t${o.id}\tmae=${o.mae}\tmeanJ=${o.junctionMean}\tmeanV=${o.frameMean}\tshift=${o.meanShift}\tmaeShifted=${o.maeAfterMeanShift}`).join('\n'))
