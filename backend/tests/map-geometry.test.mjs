/**
 * 地图几何（Issue #84）：面要素、三条底图路线的地理↔像素登记件、KMZ 确定性、
 * 外部图仿射配准与残差、可编辑图层草稿。
 *
 * 渲染要 sharp + TS 源码，放在 tsx 子进程里跑（口径同 tests/map-base-render.test.mjs），
 * HUOBAO_DATA_DIR 指向临时目录，绝不写进仓库 data/。
 * Earth 那条路线的**浏览器**部分不在单测里跑（需要外部 Python/Playwright 运行时与公网），
 * 这里只断言它的相机数学、取景与「依赖缺失必须给出可照做的错误」。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-geometry-'))
const configDir = mkdtempSync(path.join(tmpdir(), 'map-geometry-config-'))

// 豫北：安阳 / 殷墟 所在范围
const BBOX = [113.0, 35.2, 115.6, 36.8]
const ANYANG = [114.3931, 36.0975]
const YINXU = [114.3148, 36.1256]

const script = `
  import fs from 'fs'
  import path from 'path'
  import zlib from 'zlib'
  import sharp from 'sharp'
  import {
    normalizeMapSpec, parseMapSpec, mapBaseSignature, buildMapSvg, projectLonLat,
    MapSpecValidationError, MAP_REGION_COLOR,
    mapProjectionFor,
  } from './src/services/map-base-render.ts'
  import { buildMapKmz, buildMapKml, kmlColor, specCoordinates } from './src/services/map-kmz.ts'
  import { fitAffine, applyAffine, CalibrationError } from './src/services/map-image-calibration.ts'
  import {
    earthProject, earthUnproject, planEarthShot, resolveEarthRuntime, labelWidthPx,
    EarthDependencyError,
  } from './src/services/map-earth.ts'
  import {
    createMapBaseArtifact, prepareMapBackground, geoToPixel, pixelToGeo,
    geoToNormalized, normalizedToGeo, rescaleRegistration, parseRegistration,
    MapGeometryError,
  } from './src/services/map-geometry.ts'

  const bbox = ${JSON.stringify(BBOX)}
  const anyang = ${JSON.stringify(ANYANG)}
  const yinxu = ${JSON.stringify(YINXU)}
  const out = {}

  const ring = [[114.2, 36.0], [114.6, 36.0], [114.6, 36.3], [114.2, 36.3]]
  const fullSpec = normalizeMapSpec({
    bbox,
    places: [{ id: 'anyang', name: '安阳', lon: anyang[0], lat: anyang[1] },
             { id: 'yinxu', name: '殷墟', lon: yinxu[0], lat: yinxu[1] }],
    routes: [{ id: 'march', name: '行军路线', points: [anyang, yinxu, [115.0, 35.6]] }],
    regions: [{ id: 'shang', name: '商王畿', points: ring }],
  })

  // 1. 面要素的校验与规范化
  const fails = {}
  const expectFail = (key, raw) => {
    try { normalizeMapSpec(raw); fails[key] = null }
    catch (err) { fails[key] = err instanceof MapSpecValidationError ? err.message : 'WRONG_TYPE:' + err.message }
  }
  expectFail('too_few', { bbox, regions: [{ id: 'r', name: 'r', points: [[114, 36], [114.5, 36]] }] })
  expectFail('degenerate', { bbox, regions: [{ id: 'r', name: 'r', points: [[114, 36], [114, 36], [114, 36], [114, 36]] }] })
  expectFail('out_of_range', { bbox, regions: [{ id: 'r', name: 'r', points: [[114, 36], [999, 36], [114.5, 36.5]] }] })
  expectFail('too_many', { bbox, regions: Array.from({ length: 31 }, (_, i) => ({ id: 'r' + i, name: 'r', points: ring })) })
  // 三个互不相同但严格共线的点：围不出面积，只数「不同点」是查不出来的
  expectFail('collinear', { bbox, regions: [{ id: 'r', name: 'r', points: [[113.0, 35.2], [114.3, 36.0], [115.6, 36.8]] }] })
  out.region_validation = {
    fails,
    closed: fullSpec.regions[0].points,
    legacy_regions: normalizeMapSpec({ bbox }).regions,
    parse_roundtrip: parseMapSpec(JSON.stringify(fullSpec)).regions.length,
    proposed_kept: normalizeMapSpec({ bbox, regions: [{ id: 'r', name: 'r', points: ring, proposed: true }] }).regions[0].proposed,
    thin_corridor: normalizeMapSpec({ bbox, regions: [{
      id: 'canal', name: '狭长运河带',
      points: [[114, 36], [115, 36], [115, 36.000001], [114, 36.000001]],
    }] }).regions[0].points.length,
  }

  // 2. 签名兼容：没有面的 spec 签名不变；加了面才变
  const noRegions = normalizeMapSpec({ bbox, places: fullSpec.places, routes: fullSpec.routes })
  const emptyRegions = normalizeMapSpec({ bbox, places: fullSpec.places, routes: fullSpec.routes, regions: [] })
  const size = { width: 1280, height: 720 }
  out.signature = {
    legacy_stable: mapBaseSignature(noRegions, size) === mapBaseSignature(emptyRegions, size),
    region_changes: mapBaseSignature(noRegions, size) !== mapBaseSignature(fullSpec, size),
    deterministic: mapBaseSignature(fullSpec, size) === mapBaseSignature(parseMapSpec(JSON.stringify(fullSpec)), size),
  }

  // 3. 底图 SVG：画出面、仍然一个字都没有
  const svg = buildMapSvg(fullSpec, size)
  const polygon = svg.match(/<polygon points="([^"]+)"[^>]*data-region="shang"/)
  const expectedRing = fullSpec.regions[0].points.map(p => projectLonLat(fullSpec, size, p))
  const drawn = polygon ? polygon[1].split(' ').map(pair => pair.split(',').map(Number)) : []
  out.svg = {
    has_text: svg.includes('<text'),
    has_region: Boolean(polygon),
    region_color: svg.includes(MAP_REGION_COLOR),
    ring_matches: drawn.length === expectedRing.length && drawn.every((p, i) =>
      Math.hypot(p[0] - expectedRing[i][0], p[1] - expectedRing[i][1]) < 0.02),
    region_before_route: svg.indexOf('data-region=') < svg.indexOf('data-route='),
  }

  // 4. KMZ：确定性字节 + 真的是一个能解开的 zip + 三类几何都在
  const kmzA = buildMapKmz(fullSpec)
  const kmzB = buildMapKmz(fullSpec)
  const kml = buildMapKml(fullSpec)
  // 解开单成员 zip：本地头 30 字节 + 文件名，之后是 deflate raw 数据
  const nameLength = kmzA.buffer.readUInt16LE(26)
  const compressedSize = kmzA.buffer.readUInt32LE(18)
  const member = kmzA.buffer.subarray(30 + nameLength, 30 + nameLength + compressedSize)
  const inflated = zlib.inflateRawSync(member).toString('utf8')
  out.kmz = {
    deterministic: kmzA.sha256 === kmzB.sha256,
    signature: kmzA.buffer.readUInt32LE(0) === 0x04034b50,
    member_name: kmzA.buffer.subarray(30, 30 + nameLength).toString('utf8'),
    inflated_equals_kml: inflated === kml,
    document: inflated,
    counts: kmzA.counts,
    has_point: inflated.includes('<Point>'),
    has_line: inflated.includes('<LineString>'),
    has_polygon: inflated.includes('<Polygon>'),
    ring_closed: /<LinearRing><coordinates>([^<]+)</.exec(inflated)[1].split(' ').at(0)
      === /<LinearRing><coordinates>([^<]+)</.exec(inflated)[1].split(' ').at(-1),
    color: kmlColor('#1f6fd0', 1),
    colour_alpha: kmlColor('#1f6fd0', 0.28),
    coordinates: specCoordinates(fullSpec).length,
    empty_rejected: (() => {
      try { buildMapKmz(normalizeMapSpec({ bbox })); return null }
      catch (err) { return err.message }
    })(),
  }

  // 5. 外部图仿射配准
  const image = { width: 800, height: 600 }
  const exact = [
    { x: 100, y: 500, lon: 113.0, lat: 35.2 },
    { x: 700, y: 500, lon: 115.6, lat: 35.2 },
    { x: 100, y: 100, lon: 113.0, lat: 36.8 },
  ]
  const calibrated = fitAffine(exact, image)
  const noisy = fitAffine([...exact, { x: 706, y: 104, lon: 115.6, lat: 36.8 }], image)
  const degenerate = (points) => {
    try { fitAffine(points, image); return null }
    catch (err) { return err instanceof CalibrationError ? err.message : 'WRONG_TYPE' }
  }
  out.affine = {
    exact_residual: calibrated.residual_px,
    roundtrip: exact.map(p => {
      const px = applyAffine(calibrated.forward, [p.lon, p.lat])
      const geo = applyAffine(calibrated.inverse, px)
      return { px_err: Math.hypot(px[0] - p.x, px[1] - p.y), lon_err: Math.abs(geo[0] - p.lon), lat_err: Math.abs(geo[1] - p.lat) }
    }),
    noisy_residual: noisy.residual_px,
    too_few: degenerate(exact.slice(0, 2)),
    collinear_geo: degenerate([
      { x: 100, y: 500, lon: 113.0, lat: 35.2 },
      { x: 400, y: 300, lon: 114.3, lat: 36.0 },
      { x: 700, y: 100, lon: 115.6, lat: 36.8 },
    ]),
    collinear_pixel: degenerate([
      { x: 100, y: 100, lon: 113.0, lat: 35.2 },
      { x: 400, y: 100, lon: 114.3, lat: 36.4 },
      { x: 700, y: 100, lon: 115.6, lat: 35.9 },
    ]),
    out_of_image: degenerate([...exact.slice(0, 2), { x: 9000, y: 100, lon: 113.0, lat: 36.8 }]),
    far_off: degenerate([...exact, { x: 150, y: 120, lon: 115.6, lat: 36.8 }]),
  }

  // 6. Earth 相机数学（不开浏览器）
  const camera = { lat: 36.0, lon: 114.4, distance_m: 300000, fov_deg: 30 }
  const win = { width: 2220, height: 1600 }
  const centre = earthProject([camera.lon, camera.lat], camera, win)
  const probe = earthProject([114.6, 36.2], camera, win)
  const back = earthUnproject([probe.x, probe.y], camera, win)
  const far = earthProject([114.4 + 180, 36], camera, win)
  const planned = planEarthShot(fullSpec, 1200)
  out.earth = {
    centre: [centre.x, centre.y],
    roundtrip_err: [Math.abs(back[0] - 114.6), Math.abs(back[1] - 36.2)],
    north_is_up: earthProject([114.4, 36.5], camera, win).y < centre.y,
    east_is_right: earthProject([114.9, 36.0], camera, win).x > centre.x,
    behind_horizon: far.visible,
    scale_doubles: (() => {
      const wide = { width: 4440, height: 3200 }
      const a = earthProject([114.6, 36.2], camera, win)
      const b = earthProject([114.6, 36.2], camera, wide)
      return Math.abs((b.x - wide.width / 2) / (a.x - win.width / 2) - 2)
    })(),
    label_px: [labelWidthPx('安阳'), labelWidthPx('ab')],
    plan: {
      crop: planned.crop,
      frame: planned.frame,
      camera: planned.camera,
      square_window: planned.window.width === planned.window.height,
      covers_geometry: specCoordinates(fullSpec).every(point => {
        const px = earthProject(point, planned.camera, planned.window)
        return px.visible && px.x >= planned.crop.x && px.x <= planned.crop.x + planned.crop.width
          && px.y >= planned.crop.y && px.y <= planned.crop.y + planned.crop.height
      }),
    },
    runtime_error: (() => {
      const savedPython = process.env.HUOBAO_EARTH_PYTHON
      delete process.env.HUOBAO_EARTH_PYTHON
      process.env.HUOBAO_LOCAL_CONFIG_DIR = ${JSON.stringify(configDir)}
      try { resolveEarthRuntime(); return null }
      catch (err) { return { type: err instanceof EarthDependencyError ? 'dependency' : 'other', message: err.message } }
      finally { if (savedPython) process.env.HUOBAO_EARTH_PYTHON = savedPython }
    })(),
  }

  // 7. program 底图 + 登记件
  const artifact = await createMapBaseArtifact(fullSpec, { mode: 'program', width: 1280 })
  const reg = artifact.registration
  const probes = [anyang, yinxu, [bbox[0] + 0.1, bbox[1] + 0.1], ring[2]]
  out.program = {
    path: artifact.path,
    size: [artifact.width, artifact.height],
    mode: reg.mode,
    has_program: Boolean(reg.program),
    exact_projection: (() => {
      const projection = mapProjectionFor(fullSpec, { width: reg.width, height: reg.height })
      const scaled = rescaleRegistration(reg, reg.width * 2)
      return {
        actual: { scale: reg.program.scale, translate: reg.program.translate },
        expected: { scale: projection.scale(), translate: projection.translate() },
        scaled: { scale: scaled.program.scale, translate: scaled.program.translate },
      }
    })(),
    grid: { cols: reg.grid.cols, rows: reg.grid.rows, points: reg.grid.points.length },
    sources: artifact.provenance.sources.map(s => s.kind + ':' + s.license),
    // 新流水线的底图只画自然地理：用户要素由可编辑图层承担，烧进底图会留鬼影
    featureless_path: artifact.path === 'static/map-bases/'
      + mapBaseSignature(normalizeMapSpec({ bbox }), { width: 1280, height: 720 }) + '.png',
    attribution: artifact.provenance.attribution,
    matches_render: probes.map(p => {
      const px = geoToPixel(reg, p)
      const expected = projectLonLat(fullSpec, { width: artifact.width, height: artifact.height }, p)
      return Math.hypot(px[0] - expected[0], px[1] - expected[1])
    }),
    roundtrip: probes.map(p => {
      const back = pixelToGeo(reg, geoToPixel(reg, p))
      return Math.hypot(back[0] - p[0], back[1] - p[1])
    }),
    normalized: probes.map(p => {
      const n = geoToNormalized(reg, p)
      const back = normalizedToGeo(reg, n)
      return { in_unit: n[0] >= 0 && n[0] <= 1 && n[1] >= 0 && n[1] <= 1, err: Math.hypot(back[0] - p[0], back[1] - p[1]) }
    }),
    rescale: (() => {
      const scaled = rescaleRegistration(reg, 2560)
      return probes.map(p => {
        const a = geoToPixel(reg, p)
        const b = geoToPixel(scaled, p)
        return Math.hypot(b[0] - a[0] * 2, b[1] - a[1] * 2)
      })
    })(),
    serialized: Boolean(parseRegistration(JSON.stringify(reg))),
    parse_rejects: [parseRegistration('{oops'), parseRegistration({ mode: 'earth', width: 10, height: 10, bbox: [0, 0, 1, 1] })],
  }

  // 8. 外部底图：真的落盘、登记件可逆、残差公开
  const sourceDir = path.join(process.env.HUOBAO_DATA_DIR, 'static', 'uploads')
  fs.mkdirSync(sourceDir, { recursive: true })
  const sourceRel = 'static/uploads/map-scan.png'
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#d8c9a8' } })
    .png().toFile(path.join(process.env.HUOBAO_DATA_DIR, sourceRel))
  const imageArtifact = await createMapBaseArtifact(fullSpec, {
    mode: 'image',
    width: 1600,
    referenceImage: {
      path: sourceRel,
      source_url: 'https://www.europeana.eu/item/example',
      license: 'CC BY-SA 4.0',
      control_points: exact,
    },
  })
  const imageReg = imageArtifact.registration
  out.image = {
    path: imageArtifact.path,
    size: [imageArtifact.width, imageArtifact.height],
    exists: fs.existsSync(path.join(process.env.HUOBAO_DATA_DIR, imageArtifact.path)),
    residual: imageArtifact.provenance.image.residual_px,
    license: imageArtifact.provenance.image.license,
    source_url: imageArtifact.provenance.image.source_url,
    attribution: imageArtifact.provenance.attribution,
    scaled_control: imageReg.image.control_points[0],
    roundtrip: exact.map(p => {
      const px = geoToPixel(imageReg, [p.lon, p.lat])
      const back = pixelToGeo(imageReg, px)
      return { px_err: Math.hypot(px[0] - p.x * 2, px[1] - p.y * 2), geo_err: Math.hypot(back[0] - p.lon, back[1] - p.lat) }
    }),
    bbox: imageReg.bbox,
    rejects: await (async () => {
      // 数据目录里的软链指向目录之外：词法检查看不出来，必须按 realpath 拦下
      const linkRel = 'static/uploads/outside.png'
      fs.symlinkSync('/etc/hostname', path.join(process.env.HUOBAO_DATA_DIR, linkRel))
      const results = {}
      for (const [key, reference] of Object.entries({
        missing: undefined,
        no_license: { path: sourceRel, source_url: 'https://x', license: '', control_points: exact },
        no_source: { path: sourceRel, source_url: '', license: 'CC0', control_points: exact },
        escape: { path: '../../etc/passwd', source_url: 'https://x', license: 'CC0', control_points: exact },
        remote: { path: 'https://example.com/a.png', source_url: 'https://x', license: 'CC0', control_points: exact },
        symlink: { path: linkRel, source_url: 'https://x', license: 'CC0', control_points: exact },
        directory: { path: 'static/uploads', source_url: 'https://x', license: 'CC0', control_points: exact },
      })) {
        try {
          await createMapBaseArtifact(fullSpec, { mode: 'image', referenceImage: reference })
          results[key] = null
        } catch (err) {
          results[key] = { type: err instanceof MapGeometryError ? 'input' : 'other', message: err.message }
        }
      }
      return results
    })(),
  }

  // 9. 作图背景（#90）：底图 + 底纹确定性合成一次，几何全部交给模型的 LayerDoc
  const texRel = 'static/uploads/texture.png'
  await sharp({ create: { width: 640, height: 360, channels: 3, background: '#402010' } })
    .png().toFile(path.join(process.env.HUOBAO_DATA_DIR, texRel))
  const plain = await prepareMapBackground({ basePath: artifact.path, width: 1280, registration: reg })
  const textured = await prepareMapBackground({ basePath: artifact.path, width: 1280, registration: reg, texturePath: texRel })
  const bgPlain = fs.readFileSync(path.join(process.env.HUOBAO_DATA_DIR, plain.path))
  const bgTextured = fs.readFileSync(path.join(process.env.HUOBAO_DATA_DIR, textured.path))
  const rejectMessage = async (options) => {
    try { await prepareMapBackground(options); return null } catch (err) { return err.message }
  }
  out.background = {
    in_drawings: plain.path.startsWith('static/map-drawings/'),
    size: [plain.width, plain.height],
    same_path: (await prepareMapBackground({ basePath: artifact.path, width: 1280, registration: reg })).path === plain.path,
    texture_differs: textured.path !== plain.path && !bgPlain.equals(bgTextured),
    texture_warning: textured.warnings.some(w => w.includes('纹理')),
    registration_scaled: plain.registration.width === 1280 && Math.abs(plain.registration.height - 720) <= 1,
    point_matches: (() => {
      const a = geoToPixel(plain.registration, anyang)
      const b = geoToNormalized(reg, anyang)
      return Math.hypot(a[0] / 1280 - b[0], a[1] / plain.height - b[1]) < 1e-9
    })(),
    needs_registration: await rejectMessage({ basePath: imageArtifact.path }),
    bad_registration: await rejectMessage({ basePath: artifact.path, registration: { mode: 'nope' } }),
  }

  // Deliberately unrelated nominal camera: measured pixels, not analytic self-consistency,
  // must determine both directions once calibrated=true.
  const measuredReg = {
    mode: 'earth', width: 1000, height: 600, bbox: [113, 35, 115, 37],
    earth: { calibrated: true, camera, window: win, crop: { x: 0, y: 0, width: 1000, height: 600 },
             radius_m: 6371008.8, imagery_note: 'synthetic control fixture' },
    grid: { lon_min: 113, lat_min: 35, lon_max: 115, lat_max: 37, cols: 2, rows: 2,
            points: [[.1,.1],[.9,.15],[.2,.9],[1,.95]] },
  }
  const measuredPoint = geoToPixel(measuredReg, [113.5, 35.8])
  out.measured_grid = {
    pixel: measuredPoint,
    back: pixelToGeo(measuredReg, measuredPoint),
    outside: geoToPixel(measuredReg, [112, 36]),
    hole: geoToPixel({ ...measuredReg, grid: { ...measuredReg.grid, points: [null, [.9,.15],[.2,.9],[1,.95]] } }, [113.5, 35.8]),
  }
  console.log('@@' + JSON.stringify(out))
`

const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backendRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, HUOBAO_DATA_DIR: dataDir, HUOBAO_LOCAL_CONFIG_DIR: configDir, HUOBAO_EARTH_PYTHON: '' },
})
const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

test('面要素：校验点名字段、环自动闭合、老 spec 无 regions 也能解析', () => {
  const { fails, closed, legacy_regions, parse_roundtrip, proposed_kept } = result.region_validation
  for (const [key, message] of Object.entries(fails)) {
    assert.ok(message, `regions 的 ${key} 情况必须被拒绝`)
    assert.ok(message.includes('regions'), `${key} 的错误消息要点名 regions 字段：${message}`)
  }
  assert.deepEqual(closed.at(0), closed.at(-1), '外环首尾必须闭合')
  assert.equal(closed.length, 5, '4 点环闭合后应是 5 个点')
  assert.deepEqual(legacy_regions, [], '老 map_spec 没有 regions 时规范化为空数组')
  assert.equal(parse_roundtrip, 1, 'JSON 往返后面要素还在')
  assert.equal(proposed_kept, true, 'proposed 候选标记必须保留')
  assert.equal(result.region_validation.thin_corridor, 5,
    '宽长比 1:1000000 但面积非零的运河带必须保留，不能按形状阈值当成共线')
  assert.ok(fails.collinear.includes('共线'), '严格共线仍须明确拒绝')
})

test('渲染签名：没有面的旧 spec 签名不变，加了面才变（不整批作废已渲染底图）', () => {
  assert.ok(result.signature.legacy_stable, '无 regions 与显式空 regions 必须同签名')
  assert.ok(result.signature.region_changes, '加了面之后签名必须变化')
  assert.ok(result.signature.deterministic, '同一个 spec 必须得到同一个签名')
})

test('底图 SVG：面按投影逐点画出、压在线之下，并且仍然一个字都没有', () => {
  assert.equal(result.svg.has_text, false, '底图绝不能渲染文字')
  assert.ok(result.svg.has_region, '面必须出现在 SVG 里')
  assert.ok(result.svg.region_color, '面要用独立的区域色，便于与路线区分')
  assert.ok(result.svg.ring_matches, '面的每个顶点必须等于投影结果（几何不经任何模型）')
  assert.ok(result.svg.region_before_route, '面必须画在路线之前（压在下面）')
})

test('KMZ：字节确定、是合法单成员 zip、点/线/面齐全且环闭合', () => {
  const kmz = result.kmz
  assert.ok(kmz.deterministic, '同一个 spec 必须产出逐字节相同的 KMZ')
  assert.ok(kmz.signature, 'KMZ 必须是 PK 开头的 zip')
  assert.equal(kmz.member_name, 'doc.kml')
  assert.ok(kmz.inflated_equals_kml, 'zip 里解出来的必须就是 buildMapKml 的输出')
  // Parse the actual decompressed doc.kml, not TS source text: KML 2.2 uses ordered
  // sequences for both inherited ColorStyle fields and Style substyles.
  const styles = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.read())
ns = {'k': 'http://www.opengis.net/kml/2.2'}
local = lambda node: node.tag.rsplit('}', 1)[-1]
print(json.dumps({
    style.attrib['id']: {
        'children': [local(child) for child in style],
        'fields': {local(child): [local(field) for field in child] for child in style}
    } for style in root.findall('.//k:Style', ns)
}))
`], { input: kmz.document, encoding: 'utf8' }))
  assert.deepEqual(styles.style1.children, ['IconStyle', 'LabelStyle'])
  assert.deepEqual(styles.style1.fields.IconStyle, ['color', 'scale', 'Icon', 'hotSpot'])
  assert.deepEqual(styles.style1.fields.LabelStyle, ['color', 'scale'])
  assert.deepEqual(styles.style2.children, ['LabelStyle', 'LineStyle'])
  assert.deepEqual(styles.style3.children, ['LabelStyle', 'LineStyle', 'PolyStyle'])
  assert.deepEqual(styles.style3.fields.LineStyle, ['color', 'width'])
  assert.deepEqual(styles.style3.fields.PolyStyle, ['color', 'fill', 'outline'])
  assert.ok(kmz.has_point && kmz.has_line && kmz.has_polygon, '点/线/面三类几何都要写进 KML')
  assert.ok(kmz.ring_closed, 'LinearRing 首尾坐标必须一致')
  assert.equal(kmz.color, 'ffd06f1f', 'KML 颜色是 aabbggrr')
  assert.equal(kmz.colour_alpha.slice(0, 2), '47', '不透明度 0.28 → alpha 0x47')
  assert.deepEqual(kmz.counts, { places: 2, routes: 1, regions: 1, coordinates: 2 + 3 + 5 })
  assert.ok(kmz.empty_rejected?.includes('KMZ'), '没有任何几何时必须拒绝生成 KMZ')
})

test('外部图配准：3 点精确、残差公开、退化控制点一律拒绝', () => {
  const affine = result.affine
  assert.ok(affine.exact_residual.max < 1e-6, `3 个控制点应精确拟合，残差 ${affine.exact_residual.max}`)
  for (const probe of affine.roundtrip) {
    assert.ok(probe.px_err < 1e-6, '控制点必须回到自己的像素位置')
    assert.ok(probe.lon_err < 1e-9 && probe.lat_err < 1e-9, '仿射逆变换必须是真逆')
  }
  assert.ok(affine.noisy_residual.max > 0, '有噪声的第 4 点必须产生非零残差')
  assert.ok(affine.noisy_residual.rms <= affine.noisy_residual.max, 'RMS 不会大于最大残差')
  assert.ok(affine.too_few?.includes('3 个控制点'), '少于 3 点必须给出可照做的提示')
  assert.ok(affine.collinear_geo?.includes('共线'), '经纬度共线必须被拒绝')
  assert.ok(affine.collinear_pixel?.includes('共线'), '像素共线必须被拒绝')
  assert.ok(affine.out_of_image?.includes('之外'), '控制点落在图像外必须被拒绝')
  assert.ok(affine.far_off?.includes('残差'), '控制点与模型严重不符时必须拒绝并说明残差')
})

test('Earth 相机：针孔投影自洽、地平线之后不可见、取景框覆盖全部几何', () => {
  const earth = result.earth
  assert.ok(Math.abs(earth.centre[0] - 1110) < 0.01 && Math.abs(earth.centre[1] - 800) < 0.01,
    '相机正下方的点必须落在窗口中心')
  assert.ok(earth.roundtrip_err[0] < 1e-6 && earth.roundtrip_err[1] < 1e-6, '投影/反投影必须互逆')
  assert.ok(earth.north_is_up, '北在上')
  assert.ok(earth.east_is_right, '东在右')
  assert.equal(earth.behind_horizon, false, '地球另一侧的点必须判定为不可见')
  assert.ok(earth.scale_doubles < 1e-6, '焦距正比于窗口宽：窗口翻倍，偏移量也翻倍')
  assert.ok(Math.abs(earth.label_px[0] - 59) < 0.01, '全角字按 29.5px 计')
  assert.ok(Math.abs(earth.label_px[1] - 29.5) < 0.01, '半角字按 14.75px 计')
  assert.ok(earth.plan.covers_geometry, '取景框必须装下 KMZ 的全部坐标')
  assert.ok(earth.plan.crop.width > 0 && earth.plan.crop.height > 0)
})

test('Earth 依赖缺失：给出可照做的错误，绝不退回程序底图', () => {
  const runtime = result.earth.runtime_error
  assert.ok(runtime, '没有配置运行时时必须抛错')
  assert.equal(runtime.type, 'dependency', '必须是依赖类错误')
  assert.ok(runtime.message.includes('HUOBAO_EARTH_PYTHON'), '错误里要写明环境变量')
  assert.ok(runtime.message.includes('earth-runtime.json'), '错误里要写明配置文件路径')
  assert.ok(runtime.message.includes('playwright'), '错误里要写明缺的依赖')
})

test('program 登记件：与渲染同一口径、往返可逆、换尺寸严格线性', () => {
  const program = result.program
  assert.equal(program.mode, 'program')
  assert.ok(program.has_program)
  assert.deepEqual(program.exact_projection.actual, program.exact_projection.expected,
    '登记件必须持久化 fitExtent 的真实 scale/translate，不能从 bbox 四角重猜')
  assert.equal(program.exact_projection.scaled.scale, program.exact_projection.actual.scale * 2)
  assert.deepEqual(program.exact_projection.scaled.translate,
    program.exact_projection.actual.translate.map(value => value * 2))
  assert.deepEqual(program.size, [1280, 720])
  assert.equal(program.grid.points, program.grid.cols * program.grid.rows, '网格节点数必须等于 cols×rows')
  for (const err of program.matches_render) assert.ok(err < 1e-9, `登记件必须与渲染投影逐像素一致（误差 ${err}）`)
  for (const err of program.roundtrip) assert.ok(err < 1e-9, `像素→经纬度往返误差 ${err} 过大`)
  for (const probe of program.normalized) {
    assert.ok(probe.in_unit, '范围内的地理点归一化后应落在 0–1')
    assert.ok(probe.err < 1e-9, '归一化往返必须可逆')
  }
  for (const err of program.rescale) assert.ok(err < 1e-6, `换画幅后像素必须严格等比（误差 ${err}）`)
  assert.ok(program.serialized, '登记件必须能 JSON 往返')
  assert.deepEqual(program.parse_rejects, [null, null], '坏登记件必须解析为 null 而不是抛错')
  assert.ok(program.sources.some(s => s.startsWith('vector:')), '必须登记矢量数据来源与许可')
  assert.ok(program.featureless_path, '新流水线的程序底图只渲染自然地理背景（要素不许烧进底图）')
  assert.ok(program.attribution.includes('Natural Earth'))
})

test('外部底图：落盘、残差与许可入档、像素↔经纬度可逆、不安全路径被拒', () => {
  const image = result.image
  assert.ok(image.exists, '外部底图必须真的落盘')
  assert.deepEqual(image.size, [1600, 1200], '按目标宽度等比缩放')
  assert.ok(image.residual.max < 1e-6, '3 个控制点精确拟合')
  assert.equal(image.license, 'CC BY-SA 4.0')
  assert.ok(image.source_url.includes('europeana'), '来源链接必须留档')
  assert.ok(image.attribution.includes('CC BY-SA 4.0'), '出处水印文案要含许可')
  assert.ok(Math.abs(image.scaled_control.x - 200) < 1e-6, '控制点像素要随缩放一起换算')
  for (const probe of image.roundtrip) {
    assert.ok(probe.px_err < 1e-6, '控制点必须落回自己的（缩放后）像素')
    assert.ok(probe.geo_err < 1e-9, '仿射逆变换必须是真逆')
  }
  assert.ok(image.bbox[0] < image.bbox[2] && image.bbox[1] < image.bbox[3], 'bbox 由四角反算得到')
  const rejects = image.rejects
  assert.ok(rejects.missing?.message.includes('reference_image'), '缺少参考图必须报错')
  assert.ok(rejects.no_license?.message.includes('许可'), '缺少许可必须报错')
  assert.ok(rejects.no_source?.message.includes('来源'), '缺少来源必须报错')
  assert.equal(rejects.escape?.type, 'input', '越界路径必须按输入错误拒绝')
  assert.ok(rejects.remote?.message.includes('static/'), '远程 URL 必须被拒绝')
  assert.equal(rejects.symlink?.type, 'input', '软链越界必须按输入错误拒绝')
  assert.ok(rejects.symlink?.message.includes('软链越界'), '数据目录内指向外部的软链必须被拒绝（realpath 复核）')
  assert.equal(rejects.directory?.type, 'input', '目录必须按输入错误拒绝')
  assert.ok(rejects.directory?.message.includes('普通文件'), '目录不能当外部底图解码')
})

test('作图背景：底图 + 底纹确定性合成，登记件随尺寸缩放，缺登记件明确报错', () => {
  const bg = result.background
  assert.ok(bg.in_drawings, '背景图落在 static/map-drawings/')
  assert.deepEqual(bg.size, [1280, 720])
  assert.ok(bg.same_path, '同样输入必须命中同一个文件')
  assert.ok(bg.texture_differs, '加了纹理必须是另一张、像素真的不同的背景')
  assert.ok(bg.texture_warning, '纹理的合成方式必须在 warnings 里说清楚')
  assert.ok(bg.registration_scaled, '登记件必须缩放到背景尺寸')
  assert.ok(bg.point_matches, '背景上的经纬度换算必须与原登记件一致')
  assert.ok(bg.needs_registration?.includes('registration'), '缺登记件必须报错，不许瞎猜 bbox')
  assert.ok(bg.bad_registration?.includes('registration'), '非法登记件必须报错')
})

test('calibrated Earth uses observed control grid instead of nominal camera', () => {
  assert.ok(result.earth.plan.square_window, 'Earth browser viewport is square to remove FOV-axis ambiguity')
  assert.ok(Math.abs(result.measured_grid.pixel[0] - 360) < 1e-8)
  assert.ok(Math.abs(result.measured_grid.pixel[1] - 355.5) < 1e-8)
  assert.ok(Math.abs(result.measured_grid.back[0] - 113.5) < 1e-8)
  assert.ok(Math.abs(result.measured_grid.back[1] - 35.8) < 1e-8)
  assert.equal(result.measured_grid.outside, null, 'Measured grid must never extrapolate beyond controls')
  assert.equal(result.measured_grid.hole, null, 'Missing measured controls must never fall back to nominal camera')
})
