/** Real offline files and public behavior, not source-code shape assertions. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backend = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'map-studio-datasets-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const script = `
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { searchDataset, extractDatasetGeometry, datasetSourceInfo, datasetRefLayer, foldDatasetName } from './src/modules/map-studio/geo/datasets.ts'
import { normalizeMapSpec, riverSourceScale, resolveRiverSource, buildMapSvg, mapBaseSignature } from './src/modules/map-studio/geo/base-render.ts'
import { createMapBaseArtifact } from './src/modules/map-studio/geo/geometry.ts'
const original = id => JSON.parse(fs.readFileSync('./assets/geo/ne_' + id + '.geojson', 'utf8')).features
const rivers = original('10m_rivers_lake_centerlines')
const geometry = (ref) => {
  const [, file, index] = ref.split(':')
  return original(file)[Number(index)].geometry
}
const positions = raw => typeof raw[0] === 'number' ? [raw] : raw.flatMap(positions)
const out = {}

out.rivers = Object.fromEntries(['Dnipro','Dnieper','Volga','Don','Kama','Tura'].map(name => [name,searchDataset('river',name)]))
for (const [name,hits] of Object.entries(out.rivers)) {
  assert.ok(hits.length > 0, name)
  assert.ok(hits[0].ref.startsWith('ne:10m_rivers_lake_centerlines:'), name)
  assert.equal(hits[0].class, 'River', name)
  const extracted = extractDatasetGeometry(hits[0].ref)
  assert.equal(extracted.layer, 'river')
  assert.equal(extracted.kind, 'route')
  const raw = positions(geometry(hits[0].ref).coordinates)
  const allowed = new Set(raw.map(point => JSON.stringify(point)))
  assert.equal(extracted.vertices, raw.length)
  assert.equal(extracted.parts.flat().length, raw.length)
  assert.ok(extracted.parts.flat().every(point => allowed.has(JSON.stringify(point))))
  assert.ok(extracted.length_km > 0)
}
assert.equal(out.rivers.Dnipro[0].ref,out.rivers.Dnieper[0].ref)
assert.deepEqual(searchDataset('river','Dnieper',[0,0,1,1]),[])
assert.ok(searchDataset('river','Don').length <= 10)
assert.ok(searchDataset('river','dNiEpEr')[0].names.includes('Dnieper'))
const coasts=searchDataset('coast','coastline',[-10,35,10,60])
assert.ok(coasts.length>0)
assert.equal(extractDatasetGeometry(coasts[0].ref).kind,'route')
assert.equal(extractDatasetGeometry(coasts[0].ref).layer,'coast')
// Shared endpoints join, but no non-source segment may bridge disconnected chains.
const joined=extractDatasetGeometry('ne:10m_rivers_lake_centerlines:998')
const volgaRaw=geometry(joined.ref).coordinates
assert.ok(joined.parts.length<volgaRaw.length)
const segmentKey=(a,b)=>[JSON.stringify(a),JSON.stringify(b)].sort().join('|')
const sourceSegments=new Set(volgaRaw.flatMap(part=>part.slice(1).map((point,i)=>segmentKey(part[i],point))))
for(const part of joined.parts) for(let i=1;i<part.length;i++) {
  assert.ok(JSON.stringify(part[i-1])===JSON.stringify(part[i])||sourceSegments.has(segmentKey(part[i-1],part[i])))
}
assert.equal(extractDatasetGeometry(out.rivers.Dnipro[0].ref).parts.length,geometry(out.rivers.Dnipro[0].ref).coordinates.length)

const oldRivers=original('50m_rivers_lake_centerlines')
const tenNames=new Set(rivers.flatMap(f=>Object.entries(f.properties).filter(([key,value])=>/^name(?:_?[a-z]+)?$/i.test(key)&&typeof value==='string').map(([,value])=>foldDatasetName(value))))
const fallback=oldRivers.find(f=>f.properties.name&&!tenNames.has(foldDatasetName(f.properties.name)))
assert.ok(fallback,'50m fallback fixture exists in original files')
assert.ok(searchDataset('river',fallback.properties.name).some(hit=>hit.ref.startsWith('ne:50m_rivers_lake_centerlines:')))
out.fallback=fallback.properties.name

const ural=searchDataset('mountain','Ural-Mountains')[0]
assert.ok(ural.names.includes('乌拉尔山脉'))
assert.equal(searchDataset('mountain','乌拉尔山脉')[0].ref,ural.ref)
const mountain=extractDatasetGeometry(ural.ref)
assert.equal(mountain.layer,'mountain')
assert.equal(mountain.kind,'region')
assert.deepEqual(mountain.parts[0],geometry(ural.ref).coordinates[0])
assert.ok(ural.area_km2>0)
assert.equal(datasetRefLayer(ural.ref),'mountain')
out.mountain=ural

const place=searchDataset('place','Tobolsk')[0]
const settlement=extractDatasetGeometry(place.ref)
assert.equal(settlement.kind,'place')
assert.equal(settlement.layer,'place')
assert.deepEqual([settlement.lon,settlement.lat],[68.264815,58.199793])
assert.deepEqual(settlement.parts,[[[settlement.lon,settlement.lat]]])
assert.equal(settlement.source.scale,'10m')
out.place=place
const lake=searchDataset('lake','Ozero Tenis')[0]
assert.equal(extractDatasetGeometry(lake.ref).kind,'region')
assert.ok(lake.area_km2>0)
assert.equal(searchDataset('lake','Ozero Chernoye')[0].names.some(name=>name.includes('Chërnoye')),true)

const tobol=searchDataset('river','Tobol')[0]
const full=extractDatasetGeometry(tobol.ref)
const rawPoints=positions(geometry(tobol.ref).coordinates)
const allowed=new Set(rawPoints.map(point=>JSON.stringify(point)))
// A consecutive original segment provides a deterministic inclusive-boundary clip.
let pair
for(let i=1;i<full.parts[0].length;i++) {
  const a=full.parts[0][i-1],b=full.parts[0][i]
  if(a[0]!==b[0]&&a[1]!==b[1]) {pair=[a,b];break}
}
assert.ok(pair)
const box=[Math.min(pair[0][0],pair[1][0]),Math.min(pair[0][1],pair[1][1]),Math.max(pair[0][0],pair[1][0]),Math.max(pair[0][1],pair[1][1])]
const clipped=extractDatasetGeometry(tobol.ref,box)
assert.equal(clipped.clip_mode,'vertex-run')
assert.ok(clipped.parts.length>0)
assert.ok(clipped.parts.flat().every(point=>allowed.has(JSON.stringify(point))))
assert.ok(clipped.parts.flat().every(([x,y])=>x>=box[0]&&x<=box[2]&&y>=box[1]&&y<=box[3]))
assert.ok(clipped.parts.flat().some(point=>JSON.stringify(point)===JSON.stringify(pair[0])))
assert.ok(clipped.parts.flat().some(point=>JSON.stringify(point)===JSON.stringify(pair[1])))
assert.throws(()=>extractDatasetGeometry(tobol.ref,[0,0,1,1]),/裁剪后为空/)
assert.throws(()=>extractDatasetGeometry('bogus'),/格式必须为 ne:/)
assert.throws(()=>extractDatasetGeometry('ne:missing:0'),/未知数据集/)
assert.throws(()=>extractDatasetGeometry('ne:10m_rivers_lake_centerlines:999999'),/序号范围/)
assert.throws(()=>searchDataset('river','Tobol',[70,60,60,50]),/bbox 非法/)
assert.throws(()=>searchDataset('river','  '),/不能为空/)
assert.throws(()=>extractDatasetGeometry(place.ref,[0,0,1,1]),/裁剪后为空/)
const holeLake=searchDataset('lake','Lake Baikal')[0]
assert.throws(()=>extractDatasetGeometry(holeLake.ref),/内环.*MapSpec/)
// Callers cannot mutate the cached source geometry or names.
const originalPoint=full.parts[0][0].slice()
full.parts[0][0][0]=0
full.names.push('mutated')
assert.deepEqual(extractDatasetGeometry(tobol.ref).parts[0][0],originalPoint)
assert.ok(!extractDatasetGeometry(tobol.ref).names.includes('mutated'))
out.source=datasetSourceInfo(tobol.ref)

const metadata={category:'river',origin:'dataset',verification:{status:'verified',reasons:['original data']},dataset_ref:{ref:tobol.ref,clip_bbox:[60,50,80,65]},relations:[{id:'r1',computed:{consistent:true}}]}
const raw={bbox:[60,50,80,65],routes:[{id:'river',name:'Tobol',points:extractDatasetGeometry(tobol.ref).parts[0],...metadata}]}
const spec=normalizeMapSpec(raw)
for(const key of Object.keys(metadata)) assert.deepEqual(spec.routes[0][key],metadata[key])
const legacy=normalizeMapSpec({bbox:raw.bbox})
const overview=normalizeMapSpec({bbox:raw.bbox,detail_level:'overview'})
const regional=normalizeMapSpec({bbox:raw.bbox,detail_level:'regional'})
const site=normalizeMapSpec({bbox:raw.bbox,detail_level:'site'})
assert.equal(legacy.detail_level,undefined)
assert.equal(riverSourceScale(legacy),'50m')
assert.equal(riverSourceScale(overview),'50m')
assert.equal(riverSourceScale(regional),'10m')
assert.equal(riverSourceScale(site),'10m')
assert.equal(riverSourceScale({...spec,detail_level:'overview'}),'10m')
const canvas={width:1280,height:720}
assert.equal(mapBaseSignature(legacy,canvas),mapBaseSignature(overview,canvas))
assert.notEqual(mapBaseSignature(overview,canvas),mapBaseSignature(regional,canvas))
assert.notEqual(buildMapSvg(overview,canvas),buildMapSvg(regional,canvas))
const adoptedOverview={...spec,detail_level:'overview'}
const base=await createMapBaseArtifact(adoptedOverview,{mode:'program',width:1280})
assert.equal(base.provenance.river_source.scale,'10m')
assert.equal(base.provenance.river_source.reason,'dataset_ref')
assert.equal(base.provenance.river_source.sha256,out.source.sha256)
assert.equal(base.provenance.river_source.filename,'ne_10m_rivers_lake_centerlines.geojson')
assert.match(base.provenance.renderer,/10m/)
assert.match(base.provenance.sources[0].name,/10m rivers/)
assert.deepEqual(resolveRiverSource(adoptedOverview),base.provenance.river_source)
const fallbackHit=searchDataset('river',fallback.properties.name).find(hit=>hit.ref.startsWith('ne:50m_rivers_lake_centerlines:'))
const fallbackSpec=normalizeMapSpec({bbox:raw.bbox,detail_level:'regional',routes:[{id:'fallback',name:fallback.properties.name,points:[[61,55],[62,56]],dataset_ref:{ref:fallbackHit.ref}}]})
assert.throws(()=>resolveRiverSource(fallbackSpec),/底图河道来源不一致/)
await assert.rejects(()=>createMapBaseArtifact(fallbackSpec,{mode:'program',width:1280}),/底图河道来源不一致/)
assert.equal(riverSourceScale({...fallbackSpec,detail_level:'overview'}),'50m')
assert.throws(()=>riverSourceScale({...adoptedOverview,routes:adoptedOverview.routes.concat(fallbackSpec.routes)}),/底图河道来源不一致/)
out.base=base.provenance.river_source
console.log(JSON.stringify(out))
`
const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backend, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, HUOBAO_DATA_DIR: dir, STORAGE_PATH: path.join(dir, 'static') },
})
const result = JSON.parse(stdout.trim().split('\n').at(-1))

test('10m-first multilingual fuzzy lookup finds required rivers and 50m fallback', () => {
  assert.equal(Object.keys(result.rivers).length, 6)
  assert.ok(result.fallback)
})
test('Ural Mountains, Tobolsk and named lakes retain dataset geometry', () => {
  assert.ok(result.mountain.area_km2 > 0)
  assert.ok(result.place.names.includes('Tobolsk'))
})
test('vertex-only clipping, inclusive endpoints, source ownership and actionable errors', () => {
  assert.match(result.source.sha256, /^[a-f0-9]{64}$/)
})
test('metadata and river-source selection survive normalization and base geometry stripping', () => {
  assert.equal(result.base.scale, '10m')
  assert.equal(result.base.reason, 'dataset_ref')
})
