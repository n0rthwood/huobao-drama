import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))
const run = (code, env = {}) => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: backend, env: { ...process.env, ...env }, encoding: 'utf8' })

test('named ways join only by connected endpoints; simplification retains endpoints and stable ids', () => {
  run(`
import assert from 'node:assert/strict'
import { assembleRegionRivers, simplifyRiver, foldRiverName } from './src/modules/map-studio/geo/river-region.ts'
const way=(id,name,points)=>({id,tags:{name},geometry:points.map(([lon,lat])=>({lon,lat}))})
const ways=[way(1,'река Тагил',[[60,57],[60.5,57],[61,57]]),way(2,'Тагил',[[61,57],[62,58]]),way(3,'Тагил',[[70,60],[71,61]])]
const rivers=assembleRegionRivers(ways,.0001)
assert.equal(rivers.length,2)
assert.deepEqual(rivers.map(r=>r.way_ids.length).sort(),[1,2])
assert.deepEqual(assembleRegionRivers(ways.reverse(),.0001).map(r=>r.id),rivers.map(r=>r.id))
assert.deepEqual(simplifyRiver([[0,0],[1,.00001],[2,0]],.0001),[[0,0],[2,0]])
assert.equal(foldRiverName('Река ТАВДА'),foldRiverName('Тавда'))
`)
})

test('OSM refs search and extract by multilingual names, and missing or corrupt cache is actionable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'river-region-'))
  try {
    const data = path.join(dir, 'map-data', 'osm-rivers')
    mkdirSync(data, { recursive: true })
    const id = 'a'.repeat(24), id2 = 'b'.repeat(24)
    const river = (id, x) => ({ id, names: ['Tagil', 'река Тагил'], way_ids: [x], bbox: [x, 57, x + 1, 58], lines: [[[x, 57], [x + 1, 58]]] })
    const retired = { ...river('c'.repeat(24), 65), retired: true }
    const sample = JSON.parse(readFileSync(path.join(backend, 'tests/fixtures/osm-river-sample.json'), 'utf8')).rivers
    const tobol = { ...river('d'.repeat(24), 66), names: ['Tobol', 'Тобол'] }
    // Word-prefix queries hit "… River" names; an OSM chain whose bbox NE fully contains with
    // comparable length is the same watercourse (no duplicate); a separate same-name river stays.
    const wordRiver = { id: 'e'.repeat(24), names: ['Wordy River'], way_ids: [70], bbox: [70, 57, 71, 58], lines: [[[70, 57], [71, 58]]] }
    const sameRiver = { id: 'f'.repeat(24), names: ['Tobol River', 'Тобол'], way_ids: [71], bbox: [61, 52, 67, 58], lines: [[[61, 52], [63, 54], [65, 56], [67, 58]]] }
    const otherTobol = { id: '1'.repeat(24), names: ['Tobol'], way_ids: [80], bbox: [80, 57, 81, 58], lines: [[[80, 57], [81, 58]]] }
    const repeated = Array.from({ length: 15 }, (_, i) => ({ ...river((i + 20).toString(16).padStart(24, '0'), 20 + i), names: ['fixture repeated'] }))
    const body = JSON.stringify({ rivers: [river(id, 60), river(id2, 63), retired, tobol, wordRiver, sameRiver, otherTobol, ...repeated, ...sample] })
    writeFileSync(path.join(data, 'rivers.json'), body)
    writeFileSync(path.join(data, 'manifest.json'), JSON.stringify({ version: 2, file: 'rivers.json', sha256: crypto.createHash('sha256').update(body).digest('hex'), license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors' }))
    run(`
import assert from 'node:assert/strict'
import {searchDataset,extractDatasetGeometry} from './src/modules/map-studio/geo/datasets.ts'
const hits=searchDataset('river','Река Тагил')
assert.equal(hits.filter(x=>x.ref.startsWith('osm:')).length,2)
const feature=extractDatasetGeometry('osm:${id}')
assert.equal(feature.source.license,'ODbL-1.0')
assert.deepEqual(feature.bbox,[60,57,61,58])
assert.deepEqual(extractDatasetGeometry('osm:${'c'.repeat(24)}').bbox,[65,57,66,58])
assert.ok(searchDataset('river','Багаряк').some(hit=>hit.ref==='osm:4fdbb33b01418f93f09a6599'))
assert.equal(searchDataset('river','fixture repeated').length,10)
assert.ok(searchDataset('river','Тобол').every(x=>!x.ref.startsWith('osm:')))
assert.ok(searchDataset('river','Wordy').some(x=>x.ref==='osm:${'e'.repeat(24)}'))
assert.ok(searchDataset('river','Tobol').every(x=>!x.ref.startsWith('osm:')||x.ref==='osm:${'1'.repeat(24)}'))
import sharp from 'sharp'
import {normalizeMapSpec} from './src/modules/map-studio/geo/base-render.ts'
import {createMapBaseArtifact,forwardFor} from './src/modules/map-studio/geo/geometry.ts'
import {normalizeLayerDoc} from './src/services/layer-doc.ts'
import {drawingProblems,specFeatures} from './src/modules/map-studio/validate.ts'
const spec=normalizeMapSpec({bbox:[59,56,62,59],routes:[{id:'river1',name:'Tagil',points:feature.parts[0],dataset_ref:{ref:'osm:${id}'}}]})
const tile=await sharp({create:{width:256,height:256,channels:3,background:{r:128,g:0,b:0}}}).png().toBuffer()
const base=await createMapBaseArtifact(spec,{mode:'program',width:1280,height:720,dem:{cacheDir:process.env.HUOBAO_DATA_DIR+'/dem',fetchTile:async()=>tile}})
assert.ok(base.provenance.relief.named_rivers_used.length)
assert.match(base.provenance.attribution,/OpenStreetMap/)
assert.ok(base.provenance.sources.some(source=>source.license==='ODbL 1.0'))
const forward=forwardFor(base.registration)
const points=feature.parts[0].map(point=>{const xy=forward(point);return [xy[0]/base.width,xy[1]/base.height]})
const doc=normalizeLayerDoc({version:1,base:{path:base.path,width:base.width,height:base.height},theme:'archival',layers:[{id:'river',name:'river',visible:true,locked:false,z:0,opacity:1,rotation:0,type:'polyline',anchor:{semantic_id:'river1',semantic_name:'Tagil'},points,style:{stroke:'#1f5f8b',width:.008}}]})
const problems=drawingProblems({doc,features:specFeatures(spec),registration:base.registration,omitted:[]}).problems
assert.ok(!problems.some(problem=>/偏离|离开|没有锚定/.test(problem)),problems.join('\\n'))
`, { HUOBAO_DATA_DIR: dir })
    writeFileSync(path.join(data, 'rivers.json'), 'corrupt')
    assert.throws(() => run(`import {loadRegionRiverPack} from './src/modules/map-studio/geo/river-region-store.ts'; loadRegionRiverPack()`, { HUOBAO_DATA_DIR: dir }), /sha256/)
    rmSync(path.join(data, 'rivers.json'))
    assert.throws(() => run(`import {loadRegionRiverPack} from './src/modules/map-studio/geo/river-region-store.ts'; loadRegionRiverPack()`, { HUOBAO_DATA_DIR: dir }), /prefetch-river-region/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
