import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
    const body = JSON.stringify({ rivers: [river(id, 60), river(id2, 63), retired] })
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
assert.ok(searchDataset('river','Tobol').every(x=>!x.ref.startsWith('osm:')))
`, { HUOBAO_DATA_DIR: dir })
    writeFileSync(path.join(data, 'rivers.json'), 'corrupt')
    assert.throws(() => run(`import {loadRegionRiverPack} from './src/modules/map-studio/geo/river-region-store.ts'; loadRegionRiverPack()`, { HUOBAO_DATA_DIR: dir }), /sha256/)
    rmSync(path.join(data, 'rivers.json'))
    assert.throws(() => run(`import {loadRegionRiverPack} from './src/modules/map-studio/geo/river-region-store.ts'; loadRegionRiverPack()`, { HUOBAO_DATA_DIR: dir }), /prefetch-river-region/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
