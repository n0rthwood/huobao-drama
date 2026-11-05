import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))
test('C last encoded frame and D first frame use exact text-free junction state, with text fading inside the segment', () => {
  const root = mkdtempSync(join(tmpdir(), 'huobao-junction-encoded-'))
  try {
    const script = `
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import { execFileSync } from 'node:child_process'
import { renderLayerSegment, renderSegmentFrame, junctionVideoSample } from './src/services/layer-segment-render.ts'
import { normalizeLayerDoc } from './src/services/layer-doc.ts'
import { normalizeTimeline } from './src/services/segment-timeline.ts'
const root=process.env.HUOBAO_DATA_DIR
fs.mkdirSync(path.join(root,'static'),{recursive:true})
await sharp({create:{width:160,height:90,channels:3,background:'#536b83'}}).png().toFile(path.join(root,'static/base.png'))
const segment={id:1,layer_doc:normalizeLayerDoc({version:1,base:{path:'static/base.png',width:160,height:90},theme:'clean',layers:[{id:'m',type:'marker',at:[.4,.5],text:'TEST',style:{size:.13}}]}),timeline:normalizeTimeline({fps:25,fade_ms:160,keyframes:[{t:0,viewport:{x:0,y:0,w:1,h:1},visible:['m']},{t:1,viewport:{x:.1,y:.1,w:.8,h:.8},visible:['m']}]}),duration:1}
const results=[]
for(const combo of ['C','D']){
 const output=await renderLayerSegment(segment,{width:160,height:90,fps:25,source:'default'},combo)
 const index=combo==='C'?24:0
 const png=execFileSync(ffmpeg,['-v','error','-i',path.join(root,output.render_path),'-vf','select=eq(n\\\\,'+index+')','-vsync','0','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'])
 const a=await sharp(png).removeAlpha().greyscale().raw().toBuffer()
 const b=await sharp(path.join(root,output.junction.path)).removeAlpha().greyscale().raw().toBuffer()
 const withText = await sharp(await renderSegmentFrame(segment,{width:160,height:90,fps:25},combo==='C'?1:.5)).removeAlpha().greyscale().raw().toBuffer()
 let total=0,textTotal=0;for(let i=0;i<a.length;i++){total+=Math.abs(a[i]-b[i]);textTotal+=Math.abs(a[i]-withText[i])}
 results.push({combo,mae:total/a.length,textMae:textTotal/a.length,boundary:junctionVideoSample(combo,index,25,25,1,160),inner:junctionVideoSample(combo,combo==='C'?22:2,25,25,1,160)})
}
console.log('@@'+JSON.stringify(results))
`
    const stdout=execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:backend,encoding:'utf8',env:{...process.env,SQLITE_PATH:join(root,'db.sqlite3'),HUOBAO_DATA_DIR:root,STORAGE_PATH:join(root,'static')}})
    const results=JSON.parse(stdout.slice(stdout.lastIndexOf('@@')+2))
    for(const row of results){
      assert.ok(row.mae < 12 && row.mae < row.textMae, `${row.combo} encoded endpoint must match the clean guide rather than the text-bearing frame: ${JSON.stringify(row)}`)
      assert.equal(row.boundary.textAlpha,0)
      assert.ok(row.inner.textAlpha>0 && row.inner.textAlpha<1)
    }
    assert.equal(results[0].boundary.t,1)
    assert.equal(results[1].boundary.t,0)
  } finally { rmSync(root,{recursive:true,force:true}) }
})
