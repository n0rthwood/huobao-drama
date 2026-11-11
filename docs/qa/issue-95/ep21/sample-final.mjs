#!/usr/bin/env bun
// Issue #95 ep21 最终成片核对（只读）：读元数据 + 在每个「图层段→生成段」边界两侧抽帧并出拼版。
// 用法：bun sample-final.mjs <mp4 相对 data 的路径> <outDir> <planJson>
// planJson: [{n, boundary, label?}]，boundary 单位秒
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/home/joysort/projects/huobao-drama'
const sharp = (await import(`${ROOT}/backend/node_modules/sharp/lib/index.js`)).default
const FFMPEG = `${ROOT}/backend/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg`
const [rel, outDir, planFile] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })
const file = path.isAbsolute(rel) ? rel : `${ROOT}/data/${rel}`
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))

const meta = execFileSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 })
  .toString()
console.log(meta.split('\n').filter(l => /Duration|Stream|Video|Audio/.test(l)).join('\n'))

const W = 160, H = 282
const offsets = [-0.4, 0, 0.4]
const comps = []
const rowsOut = []
for (let ri = 0; ri < plan.length; ri++) {
  const p = plan[ri]
  const tiles = []
  for (let ci = 0; ci < offsets.length; ci++) {
    const t = Math.max(0, p.boundary + offsets[ci])
    const out = path.join(outDir, `boundary-shot${p.n}-${offsets[ci] >= 0 ? '+' : ''}${offsets[ci]}.png`)
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(t.toFixed(3)), '-i', file, '-frames:v', '1', out])
    tiles.push(out)
    comps.push({ input: await sharp(out).resize(W, H, { fit: 'fill' }).png().toBuffer(), left: ci * (W + 4), top: ri * (H + 6) })
  }
  rowsOut.push({ n: p.n, boundary: p.boundary, tiles })
}
const sheet = path.join(outDir, 'final-boundaries.png')
await sharp({ create: { width: offsets.length * (W + 4), height: plan.length * (H + 6), channels: 3, background: '#222' } })
  .composite(comps).png().toFile(sheet)
fs.writeFileSync(path.join(outDir, 'final-boundaries.json'), JSON.stringify(rowsOut, null, 2))
console.log(sheet)
