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

test('explicit image source kind and version override legacy anchor inference without requiring an anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-source-ref-'))
  try {
    const script = `
      import { imageSourceReference } from './src/services/segment-source-refresh.ts'
      const src={path:'static/image.png',asset_kind:'scene',asset_id:7,version_task_id:31}
      const pinned=imageSourceReference({type:'image',src,anchor:{asset_id:7,detached:true}},null,{kind:'asset',asset_kind:'prop',asset_id:7,version_task_id:null})
      const current=imageSourceReference({type:'image',src:{...src,version_task_id:null}},null,null)
      console.log('@@'+JSON.stringify({pinned,current}))
    `
    const stdout=execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:backendRoot,encoding:'utf8',env:{...process.env,SQLITE_PATH:join(root,'db.sqlite3'),HUOBAO_DATA_DIR:root}})
    const result=JSON.parse(stdout.slice(stdout.lastIndexOf('@@')+2))
    assert.deepEqual(result.pinned,{asset_kind:'scene',asset_id:7,version_task_id:31})
    assert.deepEqual(result.current,{asset_kind:'scene',asset_id:7,version_task_id:null})
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('episode list layer summaries match native detail for every shot without selection or read mutations', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-layer-summary-'))
  try {
    const script = `
      import fs from 'node:fs'
      import path from 'node:path'
      import crypto from 'node:crypto'
      import { execFileSync } from 'node:child_process'
      import ffmpegPath from 'ffmpeg-static'
      import sharp from 'sharp'
      import { sql } from 'drizzle-orm'
      import { db, schema } from './src/db/index.ts'
      import { normalizeLayerDoc } from './src/services/layer-doc.ts'
      import { normalizeTimeline } from './src/services/segment-timeline.ts'
      import { layerSegmentSignatureOf, resolveEpisodeSegmentSpec, markSegmentRendered } from './src/services/layer-segment.ts'
      import episodeApp from './src/routes/episodes.ts'
      import segmentApp from './src/routes/layer-segments.ts'

      const storage = process.env.STORAGE_PATH
      fs.mkdirSync(storage, { recursive: true })
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#345678' } }).png().toFile(path.join(storage, 'base.png'))
      execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=25:d=0.08', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(storage, 'render.mp4')], { stdio: 'ignore' })
      const at = '2026-01-01T00:00:00.000Z'
      await db.insert(schema.dramas).values([
        { id: 1, title: 'documentary', projectType: 'documentary', aspectRatio: '16:9', createdAt: at, updatedAt: at },
        { id: 2, title: 'drama', projectType: 'drama', createdAt: at, updatedAt: at },
      ])
      await db.insert(schema.episodes).values([
        { id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', createdAt: at, updatedAt: at },
        { id: 2, dramaId: 2, episodeNumber: 1, title: 'E1', createdAt: at, updatedAt: at },
      ])
      for (const [id, combo] of [[1, 'C'], [2, 'D'], [3, 'A'], [4, 'A'], [5, 'A'], [6, 'B'], [7, null], [8, 'A']]) {
        await db.insert(schema.storyboards).values({
          id, episodeId: id === 8 ? 2 : 1, storyboardNumber: id, combo,
          continuityBoundary: 'cut', designCardStatus: 'confirmed', createdAt: at, updatedAt: at,
        })
      }
      const spec = await resolveEpisodeSegmentSpec(1)
      const layer_doc = normalizeLayerDoc({ base: { path: 'static/base.png', width: 1920, height: 1080, source_width: 64, source_height: 64 }, layers: [] })
      const timeline = normalizeTimeline({ fps: 25, keyframes: [{ t: 0, viewport: { x: 0, y: 0, w: 1, h: 1 }, visible: [] }] })
      for (const [id, combo] of [[1, 'C'], [2, 'D'], [3, 'A'], [5, 'A'], [6, 'B'], [8, 'A']]) {
        await db.insert(schema.storyboardLayerSegments).values({
          id, storyboardId: id, layerDoc: JSON.stringify(layer_doc), timeline: JSON.stringify(timeline), duration: 2,
          renderPath: 'static/render.mp4',
          renderSignature: id === 5 ? 'older-input-signature' : layerSegmentSignatureOf({ layer_doc, timeline, duration: 2 }, spec, combo),
          status: id === 3 ? 'failed' : 'ready',
          staleReasons: JSON.stringify(id === 2 ? ['asset_version_changed'] : []), createdAt: at, updatedAt: at,
        })
      }
      const snapshot = () => JSON.stringify({
        shots: db.all(sql\`SELECT * FROM storyboards ORDER BY id\`),
        segments: db.all(sql\`SELECT * FROM storyboard_layer_segments ORDER BY id\`),
      })
      const mediaHash = () => crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(storage, 'base.png')))
        .update(fs.readFileSync(path.join(storage, 'render.mp4'))).digest('hex')
      const before = snapshot()
      const hashBefore = mediaHash()
      const list = async episodeId => {
        const response = await episodeApp.request('/' + episodeId + '/storyboards')
        if (response.status !== 200) throw new Error('List failed: ' + await response.text())
        return (await response.json()).data.map(row => ({ id: row.id, layer_segment: row.layer_segment }))
      }
      const first = await list(1)
      const details = []
      for (const id of [1, 4, 2, 3, 5, 1]) {
        const response = await segmentApp.request('/storyboards/' + id)
        if (response.status !== 200) throw new Error('Detail failed: ' + await response.text())
        const segment = (await response.json()).data.segment
        details.push({ id, segment: segment && {
          exists: true, status: segment.status, fresh: segment.fresh,
          render_path: segment.render_path, stale_reasons: segment.stale_reasons,
        } })
      }
      const repeated = await list(1)
      const drama = await list(2)
      const unchanged = before === snapshot() && hashBefore === mediaHash()
      // A completed backend task is reflected by the existing list refresh, without a detail fetch.
      await markSegmentRendered(5, {
        render_path: 'static/render.mp4',
        render_signature: layerSegmentSignatureOf({ layer_doc, timeline, duration: 2 }, spec, 'A'),
        status: 'ready',
        junction_path: null, junction_hash: null,
      })
      const refreshed = await list(1)
      // A failed read is not serialized as a known absent/draft segment.
      await db.run(sql\`DROP TABLE storyboard_layer_segments\`)
      const broken = await episodeApp.request('/1/storyboards')
      console.log('@@' + JSON.stringify({ first, repeated, details, drama, unchanged, refreshed, brokenStatus: broken.status }))
    `
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: backendRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, SQLITE_PATH: join(root, 'db.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: join(root, 'static') },
    })
    const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))
    const byId = Object.fromEntries(result.first.map(row => [row.id, row.layer_segment]))
    for (const detail of result.details) {
      if (detail.segment) assert.deepEqual(byId[detail.id], detail.segment)
      else assert.deepEqual(byId[detail.id], { exists: false, status: 'draft', fresh: false, render_path: null, stale_reasons: [] })
    }
    assert.deepEqual([byId[1].status, byId[1].fresh], ['ready', true])
    assert.deepEqual([byId[2].status, byId[2].fresh, byId[2].stale_reasons], ['ready', false, ['asset_version_changed']])
    assert.deepEqual([byId[3].status, byId[3].fresh], ['failed', true], 'retained fresh bytes must not overwrite a failed render status')
    assert.deepEqual([byId[5].status, byId[5].fresh], ['ready', false], 'signature mismatch must remain stale')
    assert.equal(byId[6], null, 'B does not expose a retained inactive layer segment')
    assert.equal(byId[7], null, 'an unchosen combo is not an implicit layer draft')
    assert.equal(result.drama[0].layer_segment, null, 'non-documentary projects do not adopt documentary status')
    assert.deepEqual(result.first, result.repeated, 'viewing different details cannot change row summaries')
    assert.equal(result.unchanged, true, 'list/detail reads preserve stored documents, paths and media bytes')
    assert.equal(result.refreshed.find(row => row.id === 5).layer_segment.fresh, true, 'list refresh sees completed renders without selecting the row')
    assert.equal(result.brokenStatus, 500, 'failed reads cannot masquerade as known drafts')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
