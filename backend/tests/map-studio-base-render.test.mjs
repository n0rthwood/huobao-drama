/**
 * 地图确定性底图（Issue #56 / R3；Issue #107 阶段 1）：投影往返、签名稳定性、spec 校验、
 * 画幅归一化（16:9 / 9:16 / 4:3 / 3:4 / 1:1）、真实落盘渲染与复用。
 *
 * 渲染要 sharp + TS 源码，放在 tsx 子进程里跑（口径同 tests/layer-render.test.mjs:222），
 * HUOBAO_DATA_DIR 指向临时目录，绝不写进仓库 data/。高程瓦片用合成的 terrarium PNG 注入，
 * 测试不联网。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-studio-base-render-'))

// 豫北：安阳 / 殷墟 所在范围
const BBOX = [113.0, 35.2, 115.6, 36.8]
const ANYANG = [114.3931, 36.0975]
const YINXU = [114.3148, 36.1256]

const script = `
  import fs from 'fs'
  import path from 'path'
  import sharp from 'sharp'
  import {
    MAP_BASE_WIDTH, MAP_BASE_HEIGHT, MAP_ROUTE_COLOR, MAP_REGION_COLOR, MapSpecValidationError,
    normalizeMapSpec, parseMapSpec, mapBaseSignature, projectLonLat, unprojectPixel,
    normalizeMapCanvas, canvasForAspect, renderMapBase,
  } from './src/modules/map-studio/geo/base-render.ts'

  const bbox = ${JSON.stringify(BBOX)}
  const anyang = ${JSON.stringify(ANYANG)}
  const yinxu = ${JSON.stringify(YINXU)}
  const probes = [anyang, yinxu, [bbox[0] + 0.05, bbox[1] + 0.05], [bbox[2] - 0.05, bbox[3] - 0.05]]
  const out = { consts: { MAP_BASE_WIDTH, MAP_BASE_HEIGHT, MAP_ROUTE_COLOR, MAP_REGION_COLOR } }

  /** 合成 terrarium 瓦片：起伏随经纬度变化，既保证有真实明暗，又不依赖网络 */
  const tileFetcher = async (zoom, x, y) => {
    const tile = 256, world = tile * 2 ** zoom
    const buffer = Buffer.alloc(tile * tile * 3)
    for (let row = 0; row < tile; row++) {
      const gy = y * tile + row + 0.5
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / world))) * 180 / Math.PI
      for (let col = 0; col < tile; col++) {
        const gx = x * tile + col + 0.5
        const lon = gx / world * 360 - 180
        const value = Math.max(0, Math.min(65535, Math.round(200 + 900 * Math.abs(Math.sin(lon * 0.5) * Math.cos(lat * 0.5)) + 32768)))
        const offset = (row * tile + col) * 3
        buffer[offset] = Math.floor(value / 256)
        buffer[offset + 1] = value % 256
        buffer[offset + 2] = 0
      }
    }
    return sharp(buffer, { raw: { width: tile, height: tile, channels: 3 } }).png().toBuffer()
  }
  const dem = { cacheDir: path.join(process.env.HUOBAO_DATA_DIR, 'dem'), fetchTile: tileFetcher }

  const baseSpec = (over = {}) => normalizeMapSpec({ bbox, ...over })

  // 1. 投影往返：经纬度 → 像素 → 经纬度 → 像素
  out.roundtrip = {}
  for (const type of ['mercator', 'equirectangular']) {
    const spec = baseSpec({ projection: { type } })
    const size = { width: MAP_BASE_WIDTH, height: MAP_BASE_HEIGHT }
    out.roundtrip[type] = probes.map(point => {
      const px = projectLonLat(spec, size, point)
      const back = unprojectPixel(spec, size, px)
      const again = projectLonLat(spec, size, back)
      return { lon_err: Math.abs(back[0] - point[0]), lat_err: Math.abs(back[1] - point[1]),
        px_err: Math.hypot(again[0] - px[0], again[1] - px[1]),
        inside: px[0] >= 0 && px[0] <= MAP_BASE_WIDTH && px[1] >= 0 && px[1] <= MAP_BASE_HEIGHT }
    })
  }

  // 2. bbox 必须真的铺满画布：防止 fitExtent 因环绕序错误去拟合全球（见 bboxPolygon 注释）
  out.extent = {}
  for (const type of ['mercator', 'equirectangular']) {
    const spec = baseSpec({ projection: { type } })
    const size = { width: MAP_BASE_WIDTH, height: MAP_BASE_HEIGHT }
    const sw = projectLonLat(spec, size, [bbox[0], bbox[1]])
    const ne = projectLonLat(spec, size, [bbox[2], bbox[3]])
    const center = projectLonLat(spec, size, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2])
    out.extent[type] = {
      span_x: Math.abs(ne[0] - sw[0]), span_y: Math.abs(sw[1] - ne[1]),
      center_dx: Math.abs(center[0] - MAP_BASE_WIDTH / 2), center_dy: Math.abs(center[1] - MAP_BASE_HEIGHT / 2),
      y_down: ne[1] < sw[1], x_right: ne[0] > sw[0],
    }
  }

  // 3. 签名稳定与敏感
  const size4k = { width: MAP_BASE_WIDTH, height: MAP_BASE_HEIGHT }
  const spec = baseSpec()
  out.signature = {
    stable: mapBaseSignature(spec, size4k) === mapBaseSignature(baseSpec(), size4k),
    base: mapBaseSignature(spec, size4k),
    size: mapBaseSignature(spec, { width: 1280, height: 720 }),
    portrait: mapBaseSignature(spec, { width: 2160, height: 3840 }),
    projection: mapBaseSignature(baseSpec({ projection: { type: 'equirectangular' } }), size4k),
    bbox: mapBaseSignature(baseSpec({ bbox: [113.0, 35.2, 115.7, 36.8] }), size4k),
    layers: mapBaseSignature(baseSpec({ layers: { rivers: false } }), size4k),
    // Issue #126 主题简化：底图色板固定，主题/家族记录不参与像素，也不制造伪失效
    theme: mapBaseSignature(baseSpec({ style: { theme: 'ink' } }), size4k),
    family: mapBaseSignature(baseSpec({ style: { map_style: 'ink-chinese' } }), size4k),
    places: mapBaseSignature(baseSpec({ places: [{ id: 'p1', name: '安阳', lon: anyang[0], lat: anyang[1] }] }), size4k),
    routes: mapBaseSignature(baseSpec({ routes: [{ id: 'r1', name: '路线', points: [anyang, yinxu] }] }), size4k),
    // 豁免河/命名河流会改像素，必须改签名，否则会把不带乌格拉河的图当缓存复用回来
    relief_exempt: mapBaseSignature(spec, size4k, '50m', { exemptRivers: ['Volga'] }),
    relief_named: mapBaseSignature(spec, size4k, '50m', { namedRivers: ['ugra'] }),
    relief_named_case: mapBaseSignature(spec, size4k, '50m', { namedRivers: ['Ugra'] }),
    relief_hook: mapBaseSignature(spec, size4k, '50m', { overSvg: '<rect width="1" height="1"/>' }),
  }

  // 4. 校验
  const reject = raw => {
    try { normalizeMapSpec(raw); return null }
    catch (err) { return { name: err.constructor.name, message: err.message } }
  }
  out.reject = {
    projection: reject({ bbox, projection: { type: 'robinson' } }),
    inverted: reject({ bbox: [115.6, 35.2, 113.0, 36.8] }),
    inverted_lat: reject({ bbox: [113.0, 36.8, 115.6, 35.2] }),
    nan_lon: reject({ bbox, places: [{ id: 'p', name: '坏点', lon: Number.NaN, lat: 36 }] }),
    out_of_range_lat: reject({ bbox: [113, 35.2, 115.6, 88] }),
    too_many_places: reject({ bbox, places: Array.from({ length: 201 }, (_, i) => ({ id: 'p' + i, name: 'x', lon: 114, lat: 36 })) }),
    too_many_routes: reject({ bbox, routes: Array.from({ length: 51 }, (_, i) => ({ id: 'r' + i, name: 'x', points: [anyang, yinxu] })) }),
    too_many_points: reject({ bbox, routes: [{ id: 'r', name: 'x', points: Array.from({ length: 5001 }, () => anyang) }] }),
  }
  out.minimal = normalizeMapSpec({ bbox })
  out.parse = { bad: parseMapSpec('{oops'), empty: parseMapSpec(null), ok: parseMapSpec(JSON.stringify({ bbox })) !== null }

  // 5. 画幅：只给宽 → 16:9；宽高都给且比例合法 → 保留；越界 → 退回 16:9
  const aspectOf = size => size.width / size.height
  out.canvas = {
    sixteen: canvasForAspect('16:9'),
    portrait: canvasForAspect('9:16'),
    four3: canvasForAspect('4:3'),
    three4: canvasForAspect('3:4'),
    square: canvasForAspect('1:1'),
    clamped: canvasForAspect('16:9', 1000),
    kept_portrait: normalizeMapCanvas({ width: 2160, height: 3840 }),
    kept_square: normalizeMapCanvas({ width: 2560, height: 2560 }),
    width_only: normalizeMapCanvas({ width: 3840 }),
    absurd: normalizeMapCanvas({ width: 3840, height: 200 }),
    bad_aspect: (() => { try { canvasForAspect('21:9'); return null } catch (err) { return err.message } })(),
    aspect_of: { sixteen: aspectOf(canvasForAspect('16:9')), portrait: aspectOf(canvasForAspect('9:16')), square: aspectOf(canvasForAspect('1:1')) },
  }

  // 6. 真实渲染 1280x720（高程瓦片注入）
  const renderSpec = normalizeMapSpec({
    bbox,
    places: [{ id: 'anyang', name: '安阳', lon: anyang[0], lat: anyang[1] },
             { id: 'yinxu', name: '殷墟', lon: yinxu[0], lat: yinxu[1], proposed: true }],
    routes: [{ id: 'march', name: '行军路线', points: [anyang, yinxu, [115.0, 35.6]] }],
    regions: [{ id: 'shang', name: '商王畿', points: [[114.2, 36.0], [114.6, 36.0], [114.6, 36.3], [114.2, 36.3]] }],
  })
  const first = await renderMapBase(renderSpec, { width: 1280, dem })
  const second = await renderMapBase(renderSpec, { width: 1280, dem })
  const absolute = path.join(process.env.HUOBAO_DATA_DIR, first.path)
  const meta = await sharp(absolute).metadata()
  const { data } = await sharp(absolute).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const uniqueColors = new Set()
  for (let i = 0; i < data.length; i += 3 * 7) uniqueColors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
  const routeRgb = [31, 111, 208]
  let routePixels = 0
  for (let i = 0; i < data.length; i += 3) {
    if (Math.abs(data[i] - routeRgb[0]) <= 12 && Math.abs(data[i + 1] - routeRgb[1]) <= 12 && Math.abs(data[i + 2] - routeRgb[2]) <= 12) routePixels++
  }
  out.render = {
    first, second,
    exists: fs.existsSync(absolute),
    meta: { width: meta.width, height: meta.height, format: meta.format },
    expected_points: renderSpec.places.map(place => projectLonLat(renderSpec, { width: 1280, height: 720 }, [place.lon, place.lat])),
    signature_in_path: first.path === 'static/map-bases/'
      + mapBaseSignature(renderSpec, { width: 1280, height: 720 }, '50m', { role: 'overview', anchors: null }) + '.png',
    unique_colors: uniqueColors.size,
    route_pixels: routePixels,
    feature_projection: first.points.length === 2 && first.routes.length === 1 && first.regions.length === 1,
  }

  // 7. 竖版画幅真的会渲染成 9:16（不是把 16:9 拉伸）
  const portrait = await renderMapBase(baseSpec(), { width: 1280, height: 2276, dem })
  const portraitMeta = await sharp(path.join(process.env.HUOBAO_DATA_DIR, portrait.path)).metadata()
  out.portrait = { path: portrait.path, size: [portraitMeta.width, portraitMeta.height] }

  console.log('@@' + JSON.stringify(out))
`

const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backendRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, HUOBAO_DATA_DIR: dataDir, SQLITE_PATH: path.join(dataDir, 'test.sqlite3'), STORAGE_PATH: path.join(dataDir, 'static') },
})
const result = JSON.parse(out.slice(out.lastIndexOf('@@') + 2))

after(() => rmSync(dataDir, { recursive: true, force: true }))

test('投影往返：经纬度 → 像素 → 经纬度 → 像素，误差 < 2px（两种投影）', () => {
  for (const type of ['mercator', 'equirectangular']) {
    for (const probe of result.roundtrip[type]) {
      assert.ok(probe.inside, `${type} 采样点应落在画布内`)
      assert.ok(probe.px_err < 2, `${type} 往返像素误差 ${probe.px_err} 应 < 2`)
      assert.ok(probe.lon_err < 1e-6 && probe.lat_err < 1e-6, `${type} 往返经纬度误差过大`)
    }
  }
})

test('fitExtent 真的拟合 bbox：豫北范围铺满画布且居中（环绕序写反会塌成几像素）', () => {
  for (const type of ['mercator', 'equirectangular']) {
    const extent = result.extent[type]
    assert.ok(extent.span_y > 2160 * 0.95, `${type} bbox 纵向跨度 ${extent.span_y} 应接近画布高度`)
    assert.ok(extent.span_x > 2160, `${type} bbox 横向跨度 ${extent.span_x} 过小`)
    assert.ok(extent.center_dx < 1 && extent.center_dy < 2160 * 0.02, `${type} bbox 中心应落在画布中心附近`)
    assert.ok(extent.y_down && extent.x_right, `${type} 北在上、东在右`)
  }
})

test('mapBaseSignature：同 spec 稳定，任一字段/尺寸/画幅/渲染口径变化即变', () => {
  assert.equal(result.signature.stable, true)
  const base = result.signature.base
  for (const key of ['size', 'portrait', 'projection', 'bbox', 'layers', 'places', 'routes', 'relief_exempt', 'relief_named', 'relief_hook']) {
    assert.notEqual(result.signature[key], base, `${key} 变化应改变签名`)
  }
  assert.equal(result.signature.theme, base, '主题记录不改变底图签名')
  assert.equal(result.signature.family, base, '主题家族记录不改变底图签名')
  assert.equal(result.signature.relief_named, result.signature.relief_named_case, '河名大小写不该产生第二份缓存')
})

test('normalizeMapSpec：非法投影/反向 bbox/NaN 经度全部抛 MapSpecValidationError 且点名字段', () => {
  const reject = result.reject
  assert.match(reject.projection.message, /projection/)
  assert.equal(reject.projection.name, 'MapSpecValidationError')
  assert.match(reject.inverted.message, /west < east/)
  assert.match(reject.inverted_lat.message, /south < north/)
  assert.match(reject.nan_lon.message, /lon/)
  assert.match(reject.out_of_range_lat.message, /bbox\.north/)
  assert.match(reject.too_many_places.message, /places/)
  assert.match(reject.too_many_routes.message, /routes/)
  assert.match(reject.too_many_points.message, /points/)
})

test('normalizeMapSpec：最小 spec 填入默认值；parseMapSpec 读路径不抛', () => {
  assert.deepEqual(result.minimal, {
    version: 1,
    projection: { type: 'mercator' },
    bbox: BBOX,
    layers: { land: true, coastline: true, rivers: true, lakes: true, countries: true },
    places: [],
    routes: [],
    regions: [],
    style: { theme: 'archival' },
  })
  assert.equal(result.parse.bad, null)
  assert.equal(result.parse.empty, null)
  assert.equal(result.parse.ok, true)
})

test('画幅：16:9 / 9:16 / 4:3 / 3:4 / 1:1 都合法，越界比例退回 16:9', () => {
  const canvas = result.canvas
  assert.deepEqual(canvas.sixteen, { width: 3840, height: 2160 })
  assert.deepEqual(canvas.portrait, { width: 2160, height: 3840 })
  assert.deepEqual(canvas.four3, { width: 3840, height: 2880 })
  assert.deepEqual(canvas.three4, { width: 2880, height: 3840 })
  assert.deepEqual(canvas.square, { width: 3840, height: 3840 })
  assert.deepEqual(canvas.clamped, { width: 1280, height: 720 })
  assert.ok(Math.abs(canvas.aspect_of.sixteen - 16 / 9) < 1e-3)
  assert.ok(Math.abs(canvas.aspect_of.portrait - 9 / 16) < 1e-3)
  assert.equal(canvas.aspect_of.square, 1)
  assert.deepEqual(canvas.kept_portrait, { width: 2160, height: 3840 })
  assert.deepEqual(canvas.kept_square, { width: 2560, height: 2560 })
  assert.deepEqual(canvas.width_only, { width: 3840, height: 2160 })
  assert.deepEqual(canvas.absurd, { width: 3840, height: 2160 })
  assert.match(canvas.bad_aspect, /21:9/)
})

test('renderMapBase：落盘 PNG、二次渲染复用同一文件且 sha256 一致', () => {
  const { first, second, meta } = result.render
  assert.equal(result.render.exists, true)
  assert.equal(result.render.signature_in_path, true)
  assert.equal(first.width, 1280)
  assert.equal(first.height, 720)
  assert.equal(meta.format, 'png')
  assert.equal(meta.width, 1280)
  assert.equal(meta.height, 720)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(first.sha256, second.sha256)
  assert.match(first.sha256, /^[0-9a-f]{64}$/)
})

test('底图是真实的地形晕渲而不是平涂色块（多色阶 + 高程/水系统计）', () => {
  assert.ok(result.render.unique_colors > 200, `地形晕渲应有大量色阶，实际只有 ${result.render.unique_colors} 种`)
  const relief = result.render.first.relief
  assert.equal(relief.role, 'overview')
  assert.ok(relief.dem_zoom > 0 && relief.dem_tiles > 0, '应记录高程档位与瓦片数')
  assert.ok(relief.rivers_visible > 0, '豫北范围内应有可见河道')
  assert.match(result.render.first.dem.manifest_sha256, /^[0-9a-f]{64}$/)
})

test('底图 warnings 必须写明「地形为夸张表现」', () => {
  assert.ok(result.render.first.warnings.some(w => w.includes('地形为夸张表现')), JSON.stringify(result.render.first.warnings))
})

test('renderMapBase 回传的像素坐标与 projectLonLat 完全一致（标注不会错位），用户要素不烧进底图', () => {
  const { first, expected_points } = result.render
  assert.equal(first.points.length, 2)
  first.points.forEach((point, index) => {
    assert.deepEqual(point.at, expected_points[index])
  })
  assert.equal(first.routes.length, 1)
  assert.equal(first.routes[0].color, result.consts.MAP_ROUTE_COLOR)
  assert.equal(first.regions.length, 1)
  assert.equal(first.regions[0].color, result.consts.MAP_REGION_COLOR)
  assert.equal(result.render.feature_projection, true)
  assert.equal(result.render.route_pixels, 0, '路线由可编辑图层绘制，底图里不能有路线色像素')
})

test('竖版画幅真的按 height 渲染成 9:16（不是把 16:9 拉伸）', () => {
  assert.deepEqual(result.portrait.size, [1280, 2276])
  assert.match(result.portrait.path, /\.png$/)
})
