import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('preview focus rectangles match the rendering projection at multiple aspect ratios', () => {
  const source = `
    import assert from 'node:assert/strict'
    import { frameRectOn } from './src/modules/map-studio/pip/frames.ts'
    import { pipFrameRect } from '../frontend/app/map-studio/utils/mapPip.ts'
    const overview = [30, 42, 75, 62]
    const focus = [46, 49, 52, 56]
    for (const type of ['mercator', 'equirectangular']) {
      for (const size of [{width: 3840, height: 2160}, {width: 720, height: 1280}, {width: 1000, height: 1000}]) {
        const backend = frameRectOn({ bbox: overview, projection: { type } }, size, focus)
        const frontend = pipFrameRect(overview, focus, size.width, size.height, type)
        assert.ok(frontend)
        for (let i = 0; i < 4; i++) assert.ok(Math.abs(frontend[i] - backend[i]) < 1e-8)
      }
    }
    assert.equal(pipFrameRect(null, focus, 100, 100), null)
    assert.equal(pipFrameRect(overview, focus, 0, 100), null)
  `
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: root, stdio: 'pipe' })
})
