import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))
const folder = mkdtempSync(join(tmpdir(), 'huobao-saved-guide-'))
const entry = join(folder, 'entry.mts')
writeFileSync(entry, `
import fs from 'node:fs'
import path from 'node:path'
import sharp from '${backend}node_modules/sharp/lib/index.js'
import { createHash } from 'node:crypto'
import { videoTaskJunction } from '${backend}src/services/video-guide-snapshot.ts'
const root = path.join(process.env.HUOBAO_DATA_DIR!, 'static', 'layer-frames')
fs.mkdirSync(root, { recursive: true })
const bytes = await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer()
fs.writeFileSync(path.join(root, 'guide.png'), bytes)
fs.writeFileSync(path.join(root, 'corrupt.png'), 'not an image')
fs.mkdirSync(path.join(root, 'directory.png'))
fs.symlinkSync('/etc/passwd', path.join(root, 'outside.png'))
const results = []
for (const file of ['guide.png','missing.png','corrupt.png','directory.png','outside.png']) {
 results.push(await videoTaskJunction({lastFrameUrl:'static/layer-frames/'+file}))
}
results.push(await videoTaskJunction({firstFrameUrl:'static/layer-frames/guide.png',lastFrameUrl:'static/layer-frames/guide.png'}))
results.push(await videoTaskJunction({junction_hash:'bad',junction_slot:'last',lastFrameUrl:'static/layer-frames/guide.png'}))
console.log('@@'+JSON.stringify({results,hash:createHash('sha256').update(bytes).digest('hex')}))
`)
test('saved guide bytes are hashed only after decoding; missing, corrupt, unsafe and ambiguous snapshots stay unknown', () => {
  const output = execFileSync('npx', ['tsx', entry], { cwd: backend, encoding: 'utf8', env: { ...process.env, HUOBAO_DATA_DIR: join(folder, 'data') } })
  const { results, hash } = JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
  assert.deepEqual(results[0], { slot: 'last', hash })
  assert.deepEqual(results.slice(1), Array(6).fill(null))
})
