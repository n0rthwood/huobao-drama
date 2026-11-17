import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'

test('legacy v1 river pack remains readable and NE search does not require a v2 pack', () => {
  const backend = fileURLToPath(new URL('..', import.meta.url))
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-rivers-'))
  try {
    for (const file of ['ne_50m_land.geojson', 'ne_10m_rivers_lake_centerlines.geojson', 'ne_50m_rivers_lake_centerlines.geojson'])
      symlinkSync(path.join(backend, 'assets/geo', file), path.join(dir, file))
    const pack = path.join(dir, 'osm-rivers')
    mkdirSync(pack)
    const body = JSON.stringify({ name: 'Ugra', name_zh: '乌格拉河', ways: 1, lines: [[[35, 54], [36, 55]]] })
    writeFileSync(path.join(pack, 'ugra.json'), body)
    writeFileSync(path.join(pack, 'manifest.json'), JSON.stringify({ version: 1, license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', rivers: [{ name: 'Ugra', name_zh: '乌格拉河', file: 'ugra.json', sha256: crypto.createHash('sha256').update(body).digest('hex') }] }))
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
import assert from 'node:assert/strict'
import { readNamedRiverManifest, loadNamedRiver } from './src/modules/map-studio/geo/named-rivers.ts'
import { searchDataset } from './src/modules/map-studio/geo/datasets.ts'
assert.equal(readNamedRiverManifest().version, 1)
assert.ok(loadNamedRiver('Ugra').lines.length)
assert.ok(searchDataset('river','Volga').some(hit=>hit.ref.startsWith('ne:')||hit.ref.startsWith('ne-group:')))
`], { cwd: backend, env: { ...process.env, HUOBAO_GEO_DIR: dir, HUOBAO_DATA_DIR: dir }, stdio: 'pipe' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
