import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('preview focus rectangles match the rendering projection at multiple aspect ratios', () => {
  const source = `
    import assert from 'node:assert/strict'
    import { frameRectOn } from './src/modules/map-studio/pip/frames.ts'
    import { frameRectOn as previewFrameRectOn } from '../frontend/app/map-studio/utils/mapPip.ts'
    const overview = [30, 42, 75, 62]
    const focus = [46, 49, 52, 56]
    for (const type of ['mercator', 'equirectangular']) {
      for (const size of [{width: 3840, height: 2160}, {width: 720, height: 1280}, {width: 1000, height: 1000}]) {
        const backend = frameRectOn({ bbox: overview, projection: { type } }, size, focus)
        const frontend = previewFrameRectOn({ bbox: overview, projection: { type } }, size, focus)
        assert.deepEqual(frontend, backend)
      }
    }
    assert.equal(previewFrameRectOn({ bbox: null, projection: { type: 'mercator' } }, { width: 100, height: 100 }, focus), null)
    assert.equal(previewFrameRectOn({ bbox: overview, projection: { type: 'mercator' } }, { width: 0, height: 100 }, focus), null)
  `
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: root, stdio: 'pipe' })
})
