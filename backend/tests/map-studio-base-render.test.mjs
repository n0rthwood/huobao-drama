/**
 * 地图确定性底图（Issue #56 / R3）：投影往返、签名稳定性、spec 校验、真实落盘渲染、
 * 以及「SVG 里一个 <text 都没有」——地图文字只能由叠加图层系统承担。
 * 渲染要 sharp + TS 源码，放在 tsx 子进程里跑（口径同 tests/layer-render.test.mjs:222），
 * HUOBAO_DATA_DIR 指向临时目录，绝不写进仓库 data/。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-base-render-'))

// 豫北：安阳 / 殷墟 所在范围
const BBOX = [113.0, 35.2, 115.6, 36.8]
const ANYANG = [114.3931, 36.0975]
const YINXU = [114.3148, 36.1256]

const script = `
  import fs from 'fs'
  import path from 'path'
  import sharp from 'sharp'
  import {
    MAP_BASE_WIDTH, MAP_BASE_HEIGHT, MAP_ROUTE_COLOR, MapSpecValidationError,
    normalizeMapSpec, parseMapSpec, mapBaseSignature, projectLonLat, unprojectPixel,
    buildMapSvg, renderMapBase,
  } from './src/modules/map-studio/geo/base-render.ts'

  const bbox = ${JSON.stringify(BBOX)}
  const anyang = ${JSON.stringify(ANYANG)}
  const yinxu = ${JSON.stringify(YINXU)}
  const probes = [anyang, yinxu, [bbox[0] + 0.05, bbox[1] + 0.05], [bbox[2] - 0.05, bbox[3] - 0.05]]
  const out = { consts: { MAP_BASE_WIDTH, MAP_BASE_HEIGHT, MAP_ROUTE_COLOR } }

  const baseSpec = (over = {}) => normalizeMapSpec({ bbox, ...over })

  // 1. 投影往返：默认 3840x2160
  out.roundtrip = {}
  for (const type of ['mercator', 'equirectangular']) {
    const spec = baseSpec({ projection: { type } })
    const size = { width: MAP_BASE_WIDTH, height: MAP_BASE_HEIGHT }
    out.roundtrip[type] = probes.map(p => {
      const px = projectLonLat(spec, size, p)
      const back = unprojectPixel(spec, size, px)
      const again = projectLonLat(spec, size, back)
      return { lon_err: Math.abs(back[0] - p[0]), lat_err: Math.abs(back[1] - p[1]),
        px_err: Math.hypot(again[0] - px[0], again[1] - px[1]),
        inside: px[0] >= 0 && px[0] <= MAP_BASE_WIDTH && px[1] >= 0 && px[1] <= MAP_BASE_HEIGHT }
    })
  }

  // 1b. bbox 必须真的铺满画布：防止 fitExtent 因环绕序错误去拟合全球（见 bboxPolygon 注释）
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

  // 2. 签名稳定与敏感
  const size4k = { width: MAP_BASE_WIDTH, height: MAP_BASE_HEIGHT }
  const spec = baseSpec()
  out.signature = {
    stable: mapBaseSignature(spec, size4k) === mapBaseSignature(baseSpec(), size4k),
    base: mapBaseSignature(spec, size4k),
    size: mapBaseSignature(spec, { width: 1280, height: 720 }),
    projection: mapBaseSignature(baseSpec({ projection: { type: 'equirectangular' } }), size4k),
    bbox: mapBaseSignature(baseSpec({ bbox: [113.0, 35.2, 115.7, 36.8] }), size4k),
    layers: mapBaseSignature(baseSpec({ layers: { rivers: false } }), size4k),
    theme: mapBaseSignature(baseSpec({ style: { theme: 'ink' } }), size4k),
    places: mapBaseSignature(baseSpec({ places: [{ id: 'p1', name: '安阳', lon: anyang[0], lat: anyang[1] }] }), size4k),
    routes: mapBaseSignature(baseSpec({ routes: [{ id: 'r1', name: '路线', points: [anyang, yinxu] }] }), size4k),
  }

  // 3. 校验
  const reject = (raw) => {
    try { normalizeMapSpec(raw); return null }
    catch (e) { return { name: e.constructor.name, message: e.message } }
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

  // 4. 真实渲染 1280x720
  const renderSpec = normalizeMapSpec({
    bbox,
    places: [{ id: 'anyang', name: '安阳', lon: anyang[0], lat: anyang[1] },
             { id: 'yinxu', name: '殷墟', lon: yinxu[0], lat: yinxu[1], proposed: true }],
    routes: [{ id: 'march', name: '行军路线', points: [anyang, yinxu, [115.0, 35.6]] }],
  })
  const first = await renderMapBase(renderSpec, { width: 1280 })
  const second = await renderMapBase(renderSpec, { width: 1280 })
  const absolute = path.join(process.env.HUOBAO_DATA_DIR, first.path)
  const meta = await sharp(absolute).metadata()
  out.render = {
    first, second,
    exists: fs.existsSync(absolute),
    meta: { width: meta.width, height: meta.height, format: meta.format },
    expected_points: renderSpec.places.map(p => projectLonLat(renderSpec, { width: 1280, height: 720 }, [p.lon, p.lat])),
    signature_in_path: first.path === 'static/map-bases/' + mapBaseSignature(renderSpec, { width: 1280, height: 720 }) + '.png',
  }

  // 5. SVG 无文字
  const svg = buildMapSvg(renderSpec, { width: 1280, height: 720 })
  out.svg = { has_text: svg.includes('<text'), length: svg.length, has_route_color: svg.includes(MAP_ROUTE_COLOR) }

  // 6. 真实现代参照层：逐层移除后比较栅格像素，防止仅登记数据却没有画出来。
  out.context = {}
  for (const [name, bounds] of Object.entries({
    close: [114.2, 36, 114.5, 36.2],
    empty: [114.30, 36.11, 114.32, 36.13],
    national: [73, 18, 135, 54],
  })) {
    const current = normalizeMapSpec({ bbox: bounds })
    const canvas = { width: 1280, height: 720 }
    const rendered = await renderMapBase(current, canvas)
    const svg = buildMapSvg(current, canvas)
    const pixels = await sharp(Buffer.from(svg)).raw().toBuffer()
    const changes = {}
    const groups = {}
    for (const layer of ['admin1', 'cities']) {
      const expression = new RegExp('<g data-context="' + layer + '"[^>]*>[\\\\s\\\\S]*?</g>')
      const group = svg.match(expression)?.[0] ?? ''
      groups[layer] = group
      const without = await sharp(Buffer.from(svg.replace(expression, ''))).raw().toBuffer()
      changes[layer] = pixels.reduce((sum, value, index) => sum + (value !== without[index] ? 1 : 0), 0)
    }
    const sw = projectLonLat(current, canvas, [bounds[0], bounds[1]])
    const ne = projectLonLat(current, canvas, [bounds[2], bounds[3]])
    const coordinates = [...groups.admin1.matchAll(/ d="([^"]+)"/g)]
      .flatMap(match => [...match[1].matchAll(/-?\\d+(?:\\.\\d+)?/g)].map(value => Number(value[0])))
    out.context[name] = {
      coverage: rendered.context, changes,
      boundary_clipped: coordinates.every((v, i) => i % 2 === 0
        ? v >= sw[0] - 0.01 && v <= ne[0] + 0.01
        : v >= ne[1] - 0.01 && v <= sw[1] + 0.01),
      semantic_points: rendered.points.length,
      semantic_routes: rendered.routes.length,
      has_text: svg.includes('<text'),
      city_projection_matches: (() => {
        const data = JSON.parse(fs.readFileSync('./assets/geo/ne_50m_populated_places.geojson', 'utf8'))
        const expected = data.features
          .filter(f => f.geometry.coordinates[0] >= bounds[0] && f.geometry.coordinates[0] <= bounds[2]
            && f.geometry.coordinates[1] >= bounds[1] && f.geometry.coordinates[1] <= bounds[3])
          .map(f => projectLonLat(current, canvas, f.geometry.coordinates))
        const actual = [...groups.cities.matchAll(/cx="([^"]+)" cy="([^"]+)"/g)]
        return expected.length === actual.length && expected.every((p, i) =>
          Math.hypot(p[0] - Number(actual[i][1]), p[1] - Number(actual[i][2])) < 0.008)
      })(),
    }
  }

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
    const e = result.extent[type]
    // 豫北 bbox 宽高比 ≈ 2.6:1.6，16:9 画布下以高度受限，纵向应几乎铺满 2160
    assert.ok(e.span_y > 2160 * 0.95, `${type} bbox 纵向跨度 ${e.span_y} 应接近画布高度`)
    assert.ok(e.span_x > 2160, `${type} bbox 横向跨度 ${e.span_x} 过小`)
    // 纬度中点在 mercator 下不是像素中点（纬向非线性），放宽到画布高度 2%
    assert.ok(e.center_dx < 1 && e.center_dy < 2160 * 0.02, `${type} bbox 中心应落在画布中心附近`)
    assert.ok(e.y_down && e.x_right, `${type} 北在上、东在右`)
  }
})

test('mapBaseSignature：同 spec 稳定，任一字段或尺寸变化即变', () => {
  assert.equal(result.signature.stable, true)
  const base = result.signature.base
  for (const key of ['size', 'projection', 'bbox', 'layers', 'theme', 'places', 'routes']) {
    assert.notEqual(result.signature[key], base, `${key} 变化应改变签名`)
  }
})

test('normalizeMapSpec：非法投影/反向 bbox/NaN 经度全部抛 MapSpecValidationError 且点名字段', () => {
  const r = result.reject
  assert.match(r.projection.message, /projection/)
  assert.equal(r.projection.name, 'MapSpecValidationError')
  assert.match(r.inverted.message, /west < east/)
  assert.match(r.inverted_lat.message, /south < north/)
  assert.match(r.nan_lon.message, /lon/)
  assert.match(r.out_of_range_lat.message, /bbox\.north/)
  assert.match(r.too_many_places.message, /places/)
  assert.match(r.too_many_routes.message, /routes/)
  assert.match(r.too_many_points.message, /points/)
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

test('renderMapBase：落盘 16:9 PNG，二次渲染复用同一文件且 sha256 一致', () => {
  const { first, second, meta } = result.render
  assert.equal(result.render.exists, true)
  assert.equal(result.render.signature_in_path, true)
  assert.equal(first.width, 1280)
  assert.equal(first.height, 720)
  assert.equal(first.width / first.height, 16 / 9)
  assert.equal(meta.format, 'png')
  assert.equal(meta.width, 1280)
  assert.equal(meta.height, 720)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(first.sha256, second.sha256)
  assert.match(first.sha256, /^[0-9a-f]{64}$/)
})

test('renderMapBase 回传的像素坐标与 projectLonLat 完全一致（标注不会错位）', () => {
  const { first, expected_points } = result.render
  assert.equal(first.points.length, 2)
  first.points.forEach((point, index) => {
    assert.deepEqual(point.at, expected_points[index])
  })
  assert.equal(first.routes.length, 1)
  assert.equal(first.routes[0].points.length, 3)
  assert.equal(first.routes[0].color, result.consts.MAP_ROUTE_COLOR)
})

test('底图 SVG 里没有任何 <text（地图文字一律交给叠加图层）', () => {
  assert.equal(result.svg.has_text, false)
  assert.ok(result.svg.length > 1000, '底图 SVG 应包含真实矢量路径')
  assert.equal(result.svg.has_route_color, true)
})

test('现代参照背景真正渲染：全国省界和城市点均改变栅格像素，且不污染语义目标', () => {
  const national = result.context.national
  assert.ok(national.coverage.boundary_features > 0)
  assert.ok(national.coverage.city_points > 0)
  assert.ok(national.changes.admin1 > 100)
  assert.ok(national.changes.cities > 100)
  assert.match(national.coverage.disclaimer, /现代.*不表示古代/)
  for (const current of Object.values(result.context)) {
    assert.equal(current.semantic_points, 0)
    assert.equal(current.semantic_routes, 0)
    assert.equal(current.has_text, false)
    assert.equal(current.boundary_clipped, true)
    assert.equal(current.city_projection_matches, true)
  }
})

test('安阳近景仅有真实省界、无城市点时如实警告；两层均空仍明确覆盖不足', () => {
  const close = result.context.close
  assert.equal(close.coverage.boundary_features, 1)
  assert.equal(close.coverage.city_points, 0)
  assert.ok(close.changes.admin1 > 0)
  assert.equal(close.changes.cities, 0)
  assert.equal(close.coverage.warnings.length, 1)
  assert.match(close.coverage.warnings[0], /城市点/)
  const empty = result.context.empty
  assert.equal(empty.coverage.boundary_features, 0)
  assert.equal(empty.coverage.city_points, 0)
  assert.equal(empty.coverage.warnings.length, 2)
  assert.deepEqual(empty.changes, { admin1: 0, cities: 0 })
})
