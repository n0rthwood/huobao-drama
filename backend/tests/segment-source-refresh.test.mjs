import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
test('matching render bytes/signature cannot bypass upstream staleness; quality warnings and migration history remain nonblocking', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-source-freshness-'))
  try {
    const script = `
      import fs from 'node:fs'
      import path from 'node:path'
      import { execFileSync } from 'node:child_process'
      import ffmpegPath from 'ffmpeg-static'
      import sharp from 'sharp'
      import { layerSegmentSignatureOf, layerSegmentIsFresh } from './src/services/layer-segment.ts'
      import { normalizeLayerDoc } from './src/services/layer-doc.ts'
      import { normalizeTimeline } from './src/services/segment-timeline.ts'
      const storage = process.env.STORAGE_PATH
      fs.mkdirSync(storage, { recursive: true })
      await sharp({create:{width:64,height:64,channels:3,background:'#345678'}}).png().toFile(path.join(storage, 'base.png'))
      execFileSync(ffmpegPath, ['-y','-loop','1','-i',path.join(storage,'base.png'),'-t','0.2','-r','25','-c:v','libx264','-pix_fmt','yuv420p',path.join(storage,'render.mp4')], {stdio:'ignore'})
      const spec = {width:64,height:64,fps:25}
      const segment = {id:1,storyboard_id:1,layer_doc:normalizeLayerDoc({version:1,base:{path:'static/base.png',width:64,height:64},theme:'clean',layers:[]}),timeline:normalizeTimeline({fps:25,keyframes:[{t:0,viewport:{x:0,y:0,w:1,h:1},visible:[]}]}),duration:0.2,render_path:'static/render.mp4',render_signature:null,stale_reasons:[],quality_warnings:[]}
      segment.render_signature = layerSegmentSignatureOf(segment,spec)
      const before = layerSegmentIsFresh(segment,spec)
      const sourceReasons = ['base_version_changed','asset_version_changed','semantic_changed','source_unresolved']
      const stale = sourceReasons.map(reason => layerSegmentIsFresh({...segment,stale_reasons:[reason]},spec))
      const warning = layerSegmentIsFresh({...segment,quality_warnings:[{frame_index:0,t:0,effective_width:32,effective_height:32}],stale_reasons:[]},spec)
      const migrationHistory = layerSegmentIsFresh({...segment,stale_reasons:['migrated_multi_clip']},spec)
      console.log('@@'+JSON.stringify({before,stale,warning,migrationHistory}))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static') } })
    const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    assert.equal(result.before, true)
    assert.deepEqual(result.stale, [false, false, false, false])
    assert.equal(result.warning, true)
    assert.equal(result.migrationHistory, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
