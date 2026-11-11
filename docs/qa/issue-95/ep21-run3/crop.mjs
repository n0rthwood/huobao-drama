// Corner crops (read-only): junction vs video frame 0, native resolution, bottom-right and center.
import fs from 'node:fs'
import path from 'node:path'
const ROOT = '/home/joysort/projects/huobao-drama'
const sharp = (await import(ROOT + '/backend/node_modules/sharp/lib/index.js')).default
const QADIR = '/home/joysort/projects/huobao-drama-issue-95/docs/qa/issue-95'
const res = JSON.parse(fs.readFileSync('all/junction-mae.json', 'utf8'))
const outDir = 'run3/crops'
fs.mkdirSync(outDir, { recursive: true })
const boxes = [
  ['br', { left: 300, top: 700, width: 244, height: 260 }],
  ['center', { left: 140, top: 330, width: 264, height: 300 }],
]
for (const r of res.filter(x => [575, 579, 581, 584, 585, 591].includes(x.id))) {
  const frame = fs.existsSync(r.frame) ? r.frame : path.join(QADIR, r.frame)
  for (const [label, box] of boxes) {
    const jc = await sharp(path.join(ROOT, 'data', r.junction)).extract(box).png().toBuffer()
    const vc = await sharp(frame).extract(box).png().toBuffer()
    const sheet = path.join(outDir, 'sb' + r.id + '-' + label + '.png')
    await sharp({ create: { width: box.width * 2 + 6, height: box.height, channels: 3, background: '#111' } })
      .composite([{ input: jc, left: 0, top: 0 }, { input: vc, left: box.width + 6, top: 0 }])
      .png().toFile(sheet)
  }
}
console.log('ok')
