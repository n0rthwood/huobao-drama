import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const helper = fileURLToPath(new URL('../scripts/earth_calibration.py', import.meta.url))
const configPath = path.join(process.env.HUOBAO_LOCAL_CONFIG_DIR || path.join(homedir(), '.config/huobao-drama-local'), 'earth-runtime.json')
const runtime = process.env.HUOBAO_EARTH_PYTHON || (existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).python : null) || 'python3'

test('Earth calibration measures screenshot pixels and rejects missing or inaccurate controls', () => {
  const result = JSON.parse(execFileSync(runtime, ['-c', `
import json, math, runpy, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw
helper = runpy.run_path(sys.argv[1])
controls = helper['build_controls']([113, 35, 115, 37])

def project(points, camera, window):
    return [(40+(lon-113)*1600, 40+(37-lat)*1600, True) for lon, lat in points]

def fixture(output, mode):
    image = Image.new('RGB', (3300, 3300), (80, 95, 50))
    draw = ImageDraw.Draw(image)
    for index, control in enumerate(controls):
        if mode == 'missing' and index == 0: continue
        x, y, _ = project([(control['lon'], control['lat'])], None, None)[0]
        if mode == 'offset':
            x += 35
            y += 35
        if mode == 'terrain':
            x += 5 * math.sin((control['lon']-113)/2*16*math.pi) * math.cos((37-control['lat'])/2*12*math.pi)
        if mode == 'bad' and control['kind'] == 'validation' and control['row'] == 3 and control['col'] == 3:
            x += 6
        x, y = round(x), round(y)
        bounds = [x-16, y-16, x+15, y+15] if mode == 'large' else [x-4, y-4, x+4, y+4]
        anchor = control['kind'] == 'grid' and control['row'] % helper['ANCHOR_STRIDE'] == 0 and control['col'] % helper['ANCHOR_STRIDE'] == 0
        draw.rectangle(bounds, fill=(0, 255, 255) if anchor else (255, 0, 255))
    image.save(output)

with tempfile.TemporaryDirectory() as directory:
    screenshot = Path(directory) / 'controls.png'
    fixture(screenshot, 'good')
    measured = helper['measure_controls'](controls, screenshot, None, None, project)
    fixture(screenshot, 'large')
    large = helper['measure_controls'](controls, screenshot, None, None, project)
    fixture(screenshot, 'terrain')
    terrain = helper['measure_controls'](controls, screenshot, None, None, project)
    fixture(screenshot, 'offset')
    offset = helper['measure_controls'](controls, screenshot, None, None, project)
    failures = {}
    for mode in ('bad', 'missing'):
        fixture(screenshot, mode)
        try:
            helper['measure_controls'](controls, screenshot, None, None, project)
            failures[mode] = None
        except RuntimeError as error:
            failures[mode] = str(error)
    print(json.dumps({'residual': measured['residual_px'], 'offset_residual': offset['residual_px'], 'terrain_residual': terrain['residual_px'], 'validation_count': measured['validation_count'],
                      'grid_count': len(measured['pixels']), 'first_pixel': measured['pixels'][0],
                      'large_count': len(large['pixels']), 'large_first_pixel': large['pixels'][0], 'failures': failures}))
`, helper], { encoding: 'utf8' }))
  const rows = Math.sqrt(result.grid_count)
  assert.equal(rows, Math.trunc(rows), 'Registration is a complete rectangular grid')
  assert.equal(result.validation_count, (rows - 1) ** 2, 'Every grid cell has an independent withheld control')
  assert.ok(result.terrain_residual.max <= 3, 'Local terrain curvature must remain within the unchanged accuracy guard')
  assert.ok(result.offset_residual.max <= 1, 'Measured anchors must locate dense controls despite camera/terrain offset')
  assert.deepEqual(result.first_pixel, [40, 40], 'Measured icon centers use full-window pixel origin')
  assert.ok(result.residual.max <= 1, 'Pixel quantization is independently measured, not fabricated zero')
  assert.equal(result.large_count, result.grid_count, 'Screen-size icons must preserve the same complete geographic coverage')
  assert.deepEqual(result.large_first_pixel, [39.5, 39.5])
  assert.match(result.failures.bad, /validation failed/)
  assert.match(result.failures.missing, /could not uniquely find/)
})
