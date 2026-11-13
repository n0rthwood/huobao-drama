/**
 * 前端画布配准（Issue #84）：frontend/app/map-studio/utils/mapRegistration.ts 必须和后端出图时用的投影
 * 逐像素一致，否则人在图上拖出来的点会被存成另一个地方的经纬度。
 *
 * 这里不读源码、不数调用次数：直接拿后端权威投影（d3 fitExtent / Earth 相机 / 标定仿射）与前端换算
 * 在真实坐标上对数，并检查反向换算、退化标定与坏配准的拒绝行为。
 * 跑在 tsx 子进程里（口径同 tests/map-studio-geometry.test.mjs），不需要 sharp 渲染与浏览器。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-studio-registration-'))
after(() => rmSync(dataDir, { recursive: true, force: true }))

// 豫北：安阳 / 殷墟（与几何用例同一组真实坐标）
const BBOX = [113.0, 35.2, 115.6, 36.8]
const ANYANG = [114.3931, 36.0975]
const YINXU = [114.3148, 36.1256]
// 非正方画幅：宽屏、竖幅、正方、极扁，letterbox 方向各不相同
const SIZES = [[1280, 720], [900, 1600], [640, 640], [1024, 300]]

const script = `
  import { normalizeMapSpec, mapProjectionFor } from './src/modules/map-studio/geo/base-render.ts'
  import { planEarthShot } from './src/modules/map-studio/geo/earth.ts'
  import { fitAffine, CalibrationError } from './src/modules/map-studio/geo/image-calibration.ts'
  import { geoToPixel as serverGeoToPixel, pixelToGeo as serverPixelToGeo } from './src/modules/map-studio/geo/geometry.ts'
  import {
    geoToPixel, pixelToGeo, geoToNormalized, normalizedToGeo,
    parseRegistration, registrationFrom, fitControlPoints, registrationFromControlPoints,
  } from '../frontend/app/map-studio/utils/mapRegistration.ts'

  const bbox = ${JSON.stringify(BBOX)}
  const sizes = ${JSON.stringify(SIZES)}
  const anyang = ${JSON.stringify(ANYANG)}
  const yinxu = ${JSON.stringify(YINXU)}
  const out = {}
  const maxOf = (values) => values.reduce((a, b) => Math.max(a, b), 0)

  const programReg = (projection, box, width, height) => {
    const fitted = mapProjectionFor({ projection: { type: projection }, bbox: box }, { width, height })
    return {
      mode: 'program', width, height, bbox: box,
      program: { projection, bbox: box, fit: 'd3.fitExtent', extent: [[0, 0], [width, height]], scale: fitted.scale(), translate: fitted.translate() },
    }
  }

  // ---------- 1. 程序投影：两种投影 × 四种画幅 × 区域/大范围 bbox ----------
  const wideBbox = [70, 5, 140, 55]
  const samples = (box) => {
    const [w, s, e, n] = box
    const list = [anyang, yinxu, [w, s], [e, n], [w, n], [e, s], [(w + e) / 2, (s + n) / 2]]
    // 框外的点也要一致：编辑器必须能把拖到框外的点再拖回来
    list.push([w - (e - w) * 0.2, s - (n - s) * 0.2], [e + (e - w) * 0.1, n + (n - s) * 0.1])
    return list
  }
  const programCases = []
  for (const projection of ['mercator', 'equirectangular']) {
    for (const box of [bbox, wideBbox]) {
      for (const [width, height] of sizes) {
        const reg = programReg(projection, box, width, height)
        const parsed = parseRegistration(JSON.parse(JSON.stringify(reg)))
        const forwardErrors = []
        const roundtripErrors = []
        for (const point of samples(box)) {
          const mine = geoToPixel(parsed, point[0], point[1])
          const theirs = serverGeoToPixel(reg, point)
          forwardErrors.push(Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]))
          const back = pixelToGeo(parsed, mine[0], mine[1])
          roundtripErrors.push(Math.hypot(back[0] - point[0], back[1] - point[1]))
        }
        // 画布四角与 letterbox 边缘：这些像素也要和服务端反算出同一个经纬度
        const inverseErrors = []
        for (const px of [[0, 0], [width, 0], [0, height], [width, height], [width / 2, height / 2], [width * 0.03, height * 0.97]]) {
          const mine = pixelToGeo(parsed, px[0], px[1])
          const theirs = serverPixelToGeo(reg, px)
          inverseErrors.push(Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]))
        }
        programCases.push({
          projection, box, width, height,
          forward_px: maxOf(forwardErrors),
          inverse_deg: maxOf(inverseErrors),
          roundtrip_deg: maxOf(roundtripErrors),
          normalized_roundtrip: (() => {
            const geo = normalizedToGeo(parsed, 0.25, 0.75)
            const back = geoToNormalized(parsed, geo[0], geo[1])
            return Math.hypot(back[0] - 0.25, back[1] - 0.75)
          })(),
        })
      }
    }
  }
  out.program = programCases

  // ---------- 2. Earth 相机：真实取景参数，地平线之后必须是 null ----------
  const earthSpec = normalizeMapSpec({
    bbox,
    places: [{ id: 'anyang', name: '安阳', lon: anyang[0], lat: anyang[1] },
             { id: 'yinxu', name: '殷墟', lon: yinxu[0], lat: yinxu[1] }],
    routes: [{ id: 'r', name: '路线', points: [anyang, yinxu] }],
  })
  const plan = planEarthShot(earthSpec, 1600)
  const earthReg = {
    mode: 'earth', width: plan.crop.width, height: plan.crop.height,
    bbox,
    earth: { camera: plan.camera, window: plan.window, crop: plan.crop, radius_m: 6371008.8, imagery_note: 'Imagery (C) Google' },
  }
  const earthParsed = parseRegistration(JSON.parse(JSON.stringify(earthReg)))
  const earthForward = []
  const earthRoundtrip = []
  for (const point of [anyang, yinxu, [plan.camera.lon, plan.camera.lat], [bbox[0], bbox[1]], [bbox[2], bbox[3]]]) {
    const mine = geoToPixel(earthParsed, point[0], point[1])
    const theirs = serverGeoToPixel(earthReg, point)
    earthForward.push(mine && theirs ? Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]) : Number.POSITIVE_INFINITY)
    const back = pixelToGeo(earthParsed, mine[0], mine[1])
    earthRoundtrip.push(Math.hypot(back[0] - point[0], back[1] - point[1]))
  }
  const antipode = [plan.camera.lon > 0 ? plan.camera.lon - 180 : plan.camera.lon + 180, -plan.camera.lat]
  const earthInverse = []
  for (const px of [[0, 0], [plan.crop.width, plan.crop.height], [plan.crop.width / 2, plan.crop.height / 2]]) {
    const mine = pixelToGeo(earthParsed, px[0], px[1])
    const theirs = serverPixelToGeo(earthReg, px)
    earthInverse.push(mine && theirs ? Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]) : (mine === theirs ? 0 : Number.POSITIVE_INFINITY))
  }
  // 低空近景时即使在画面外数倍仍可能看见地面，不能把「离画面远」当成天空。
  // 球的视锥切线满足 tan(theta_h)=R/sqrt((R+h)^2-R^2)；取其两倍，保证射线不穿过球体。
  const R = 6371008.8
  const cameraR = R + plan.camera.distance_m
  const focal = plan.window.width / (2 * Math.tan(plan.camera.fov_deg * Math.PI / 360))
  const horizonSlope = R / Math.sqrt(cameraR * cameraR - R * R)
  const skyPixel = [plan.window.width / 2 + focal * horizonSlope * 2 - plan.crop.x, plan.window.height / 2 - plan.crop.y]
  out.earth = {
    camera_distance: plan.camera.distance_m,
    crop: plan.crop,
    forward_px: maxOf(earthForward),
    inverse_deg: maxOf(earthInverse),
    roundtrip_deg: maxOf(earthRoundtrip),
    antipode_mine: geoToPixel(earthParsed, antipode[0], antipode[1]),
    antipode_server: serverGeoToPixel(earthReg, antipode),
    sky_mine: pixelToGeo(earthParsed, skyPixel[0], skyPixel[1]),
    sky_server: serverPixelToGeo(earthReg, skyPixel),
  }

  // ---------- 3. 网格兜底：删掉相机参数后只剩采样网格，null 节点不能变成 (0,0) ----------
  const gridNodes = 33
  const gridPoints = []
  for (let row = 0; row < gridNodes; row++) {
    const lat = bbox[3] - ((bbox[3] - bbox[1]) * row) / (gridNodes - 1)
    for (let col = 0; col < gridNodes; col++) {
      const lon = bbox[0] + ((bbox[2] - bbox[0]) * col) / (gridNodes - 1)
      const px = serverGeoToPixel(earthReg, [lon, lat])
      gridPoints.push(px ? [px[0] / earthReg.width, px[1] / earthReg.height] : null)
    }
  }
  const gridReg = parseRegistration({
    mode: 'earth', width: earthReg.width, height: earthReg.height, bbox,
    grid: { lon_min: bbox[0], lat_min: bbox[1], lon_max: bbox[2], lat_max: bbox[3], cols: gridNodes, rows: gridNodes, points: gridPoints },
  })
  const gridErrors = []
  for (const point of [anyang, yinxu, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]]) {
    const mine = geoToPixel(gridReg, point[0], point[1])
    const theirs = serverGeoToPixel(earthReg, point)
    gridErrors.push(mine && theirs ? Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]) : Number.POSITIVE_INFINITY)
  }
  // 整格置空：有 null 角点的单元必须拒绝插值，而不是把 null 当 0 插出画面左上角
  const holed = gridPoints.slice()
  const holeIndex = Math.floor(gridNodes / 2) * gridNodes + Math.floor(gridNodes / 2)
  holed[holeIndex] = null
  const holedReg = parseRegistration({
    mode: 'earth', width: earthReg.width, height: earthReg.height, bbox,
    grid: { lon_min: bbox[0], lat_min: bbox[1], lon_max: bbox[2], lat_max: bbox[3], cols: gridNodes, rows: gridNodes, points: holed },
  })
  const holeLon = bbox[0] + ((bbox[2] - bbox[0]) * Math.floor(gridNodes / 2)) / (gridNodes - 1)
  const holeLat = bbox[3] - ((bbox[3] - bbox[1]) * Math.floor(gridNodes / 2)) / (gridNodes - 1)
  out.grid = {
    nulls_preserved: holedReg.grid.points.filter(p => p === null).length,
    length: holedReg.grid.points.length,
    forward_px: maxOf(gridErrors),
    hole_result: geoToPixel(holedReg, holeLon + 1e-4, holeLat - 1e-4),
    grid_roundtrip_deg: (() => {
      const px = geoToPixel(gridReg, anyang[0], anyang[1])
      const back = pixelToGeo(gridReg, px[0], px[1])
      return Math.hypot(back[0] - anyang[0], back[1] - anyang[1])
    })(),
  }

  // 实测 Earth 网格优先于名义相机：给定一个轻微扭曲四边形，检查独立计算的像素和经纬度。
  // u=.25,v=.6 时双线性结果应为 nx=.33, ny=.575；不能回到仍留在出处里的相机去投影。
  const calibratedGrid = {
    lon_min: 113, lat_min: 35, lon_max: 115, lat_max: 37, cols: 2, rows: 2,
    points: [[.1, .1], [.9, .2], [.2, .9], [.8, .8]],
  }
  const calibrated = parseRegistration({
    ...earthReg, width: 1000, height: 600, bbox: [113, 35, 115, 37],
    earth: { ...earthReg.earth, calibrated: true }, grid: calibratedGrid,
  })
  const calibratedHole = parseRegistration({
    ...earthReg, width: 1000, height: 600, bbox: [113, 35, 115, 37],
    earth: { ...earthReg.earth, calibrated: true },
    grid: { ...calibratedGrid, points: [[.1, .1], [.9, .2], null, [.8, .8]] },
  })
  out.calibrated = {
    forward: geoToPixel(calibrated, 113.5, 35.8),
    inverse: pixelToGeo(calibrated, 330, 345),
    outside_geo: geoToPixel(calibrated, 116, 35.8),
    outside_pixel: pixelToGeo(calibrated, 990, 590),
    hole_forward: geoToPixel(calibratedHole, 113.5, 35.8),
    hole_inverse: pixelToGeo(calibratedHole, 330, 345),
    missing_grid: parseRegistration({ ...earthReg, earth: { ...earthReg.earth, calibrated: true } }),
  }

  // ---------- 4. 外部图标定：与后端最小二乘一致，退化控制点一律拒绝 ----------
  const image = { width: 1600, height: 900 }
  const controls = [
    { x: 180, y: 720, lon: 113.2, lat: 35.4 },
    { x: 1420, y: 700, lon: 115.4, lat: 35.5 },
    { x: 820, y: 140, lon: 114.3, lat: 36.7 },
    { x: 900, y: 430, lon: 114.5, lat: 36.0 },
  ]
  const serverFit = fitAffine(controls, image)
  const mineFit = fitControlPoints(controls, image)
  const imageReg = {
    mode: 'image', width: image.width, height: image.height, bbox: [113.2, 35.4, 115.4, 36.7],
    image: { forward: serverFit.forward, inverse: serverFit.inverse, residual_px: serverFit.residual_px, control_points: controls, source_url: 'https://example.org/map', license: 'CC BY-SA 4.0' },
  }
  const imageParsed = parseRegistration(JSON.parse(JSON.stringify(imageReg)))
  const imageErrors = []
  const imageRoundtrip = []
  for (const point of [[113.2, 35.4], [115.4, 36.7], anyang, yinxu, [114.0, 36.2]]) {
    const mine = geoToPixel(imageParsed, point[0], point[1])
    const theirs = serverGeoToPixel(imageReg, point)
    imageErrors.push(Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]))
    const back = pixelToGeo(imageParsed, mine[0], mine[1])
    imageRoundtrip.push(Math.hypot(back[0] - point[0], back[1] - point[1]))
  }
  const ownReg = registrationFromControlPoints(image.width, image.height, controls, { source_url: 'https://example.org/map', license: 'CC BY-SA 4.0' })
  const ownErrors = []
  for (const point of [anyang, yinxu, [114.0, 36.2]]) {
    const mine = geoToPixel(ownReg, point[0], point[1])
    const theirs = serverGeoToPixel(imageReg, point)
    ownErrors.push(Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1]))
  }
  const collinear = [
    { x: 100, y: 100, lon: 113.0, lat: 35.0 },
    { x: 300, y: 300, lon: 113.5, lat: 35.5 },
    { x: 700, y: 700, lon: 114.5, lat: 36.5 },
  ]
  let serverDegenerate = null
  const invalidControls = {
    pixel_outside: controls.map((p, i) => i === 0 ? { ...p, x: image.width + 1 } : p),
    geo_outside: controls.map((p, i) => i === 0 ? { ...p, lat: 95 } : p),
    almost_collinear_geo: [
      { x: 100, y: 100, lon: 113, lat: 35 },
      { x: 1400, y: 100, lon: 114, lat: 36 },
      { x: 700, y: 800, lon: 115, lat: 37.00001 },
    ],
    almost_collinear_pixels: [
      { x: 100, y: 100, lon: 113, lat: 35 },
      { x: 500, y: 500, lon: 115, lat: 35 },
      { x: 800, y: 800.001, lon: 114, lat: 37 },
    ],
    high_residual: [
      { x: 100, y: 100, lon: 113, lat: 35 },
      { x: 1500, y: 100, lon: 115, lat: 35 },
      { x: 1500, y: 800, lon: 115, lat: 37 },
      { x: 100, y: 800, lon: 113, lat: 37 },
      { x: 1550, y: 850, lon: 114, lat: 36 },
    ],
  }
  out.invalid_controls = Object.fromEntries(Object.entries(invalidControls).map(([name, list]) => {
    let serverRejected = false
    try { fitAffine(list, image) } catch (err) { serverRejected = err instanceof CalibrationError }
    return [name, {
      serverRejected,
      frontendRejected: fitControlPoints(list, image) === null,
      registrationRejected: registrationFromControlPoints(image.width, image.height, list) === null,
    }]
  }))
  try { fitAffine(collinear, image) } catch (err) { serverDegenerate = err instanceof CalibrationError ? err.message : 'WRONG_TYPE:' + err.message }
  out.image = {
    forward_px: maxOf(imageErrors),
    roundtrip_deg: maxOf(imageRoundtrip),
    own_registration_px: maxOf(ownErrors),
    coef_delta: maxOf(serverFit.forward.map((value, i) => Math.abs(value - mineFit.forward[i]))),
    residual_delta: Math.abs(serverFit.residual_px.rms - mineFit.residual_px.rms),
    residual_rms: mineFit.residual_px.rms,
    server_degenerate: serverDegenerate,
    mine_degenerate: fitControlPoints(collinear, image),
    mine_too_few: fitControlPoints(controls.slice(0, 2), image),
    own_degenerate: registrationFromControlPoints(image.width, image.height, collinear),
  }

  // ---------- 5. 坏配准必须被整体拒绝，而不是悄悄变成一份「看着能用」的假投影 ----------
  const good = programReg('mercator', bbox, 1280, 720)
  const broken = {
    not_an_object: parseRegistration('not json'),
    unknown_mode: parseRegistration({ ...good, mode: 'satellite' }),
    nan_width: parseRegistration({ ...good, width: 'abc' }),
    zero_height: parseRegistration({ ...good, height: 0 }),
    bbox_nan: parseRegistration({ ...good, bbox: [113, NaN, 115, 36] }),
    bbox_inverted: parseRegistration({ ...good, bbox: [115.6, 36.8, 113.0, 35.2] }),
    program_bbox_broken: parseRegistration({ ...good, program: { ...good.program, bbox: [1, 2, 3] } }),
    affine_nan: parseRegistration({ ...imageReg, image: { ...imageReg.image, forward: [1, 0, 0, 0, null, 0] } }),
    affine_singular: parseRegistration({ ...imageReg, image: { ...imageReg.image, forward: [0, 0, 0, 0, 0, 0] } }),
    camera_zero_distance: parseRegistration({ ...earthReg, earth: { ...earthReg.earth, camera: { ...earthReg.earth.camera, distance_m: 0 } } }),
    camera_bad_fov: parseRegistration({ ...earthReg, earth: { ...earthReg.earth, camera: { ...earthReg.earth.camera, fov_deg: 400 } } }),
    grid_short: parseRegistration({ mode: 'earth', width: 100, height: 100, bbox, grid: { lon_min: bbox[0], lat_min: bbox[1], lon_max: bbox[2], lat_max: bbox[3], cols: 3, rows: 3, points: [[0, 0], [1, 1]] } }),
    grid_nan_node: parseRegistration({ mode: 'earth', width: 100, height: 100, bbox, grid: { lon_min: bbox[0], lat_min: bbox[1], lon_max: bbox[2], lat_max: bbox[3], cols: 2, rows: 2, points: [[0, 0], [1, 0], [0, 'x'], [1, 1]] } }),
    no_math_at_all: parseRegistration({ mode: 'program', width: 100, height: 100, bbox }),
  }
  out.rejected = Object.fromEntries(Object.entries(broken).map(([key, value]) => [key, value === null]))
  out.accepted = {
    good: parseRegistration(JSON.stringify(good))?.mode ?? null,
    nested: registrationFrom({ registration: good })?.mode ?? null,
    grid_only: parseRegistration({
      mode: 'earth', width: 100, height: 100, bbox,
      grid: { lon_min: bbox[0], lat_min: bbox[1], lon_max: bbox[2], lat_max: bbox[3], cols: 2, rows: 2, points: [[0, 0], [1, 0], null, [1, 1]] },
    })?.mode ?? null,
  }

  console.log('@@' + JSON.stringify(out))
`

const stdout = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backendRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, HUOBAO_EARTH_PYTHON: '', SQLITE_PATH: path.join(dataDir, 'test.sqlite3'), HUOBAO_DATA_DIR: dataDir, STORAGE_PATH: path.join(dataDir, 'static') },
})
const result = JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2))

test('程序底图：两种投影 × 四种非正方画幅，前端换算与 d3 fitExtent 逐像素一致', () => {
  for (const item of result.program) {
    const label = `${item.projection} ${item.width}x${item.height} bbox=${item.box.join(',')}`
    assert.ok(item.forward_px < 1e-6, `${label} 经纬度→像素误差过大：${item.forward_px}px`)
    assert.ok(item.inverse_deg < 1e-9, `${label} 像素→经纬度误差过大：${item.inverse_deg}°`)
    assert.ok(item.roundtrip_deg < 1e-9, `${label} 往返误差过大：${item.roundtrip_deg}°`)
    assert.ok(item.normalized_roundtrip < 1e-9, `${label} 归一化往返误差过大：${item.normalized_roundtrip}`)
  }
})

test('Earth 底图：相机透视一致，地球背面与天空一律返回 null', () => {
  assert.ok(result.earth.camera_distance > 0, 'Earth 取景必须算出相机高度')
  assert.ok(result.earth.forward_px < 1e-6, `Earth 经纬度→像素误差过大：${result.earth.forward_px}px`)
  assert.ok(result.earth.inverse_deg < 1e-6, `Earth 像素→经纬度误差过大：${result.earth.inverse_deg}°`)
  assert.ok(result.earth.roundtrip_deg < 1e-6, `Earth 往返误差过大：${result.earth.roundtrip_deg}°`)
  assert.equal(result.earth.antipode_mine, null, '地球背面的点前端必须给 null')
  assert.equal(result.earth.antipode_server, null, '地球背面的点服务端也给 null（口径一致）')
  assert.equal(result.earth.sky_mine, null, '打不到地球的像素前端必须给 null，不能外推')
  assert.equal(result.earth.sky_server, null, '打不到地球的像素服务端也给 null')
})

test('采样网格兜底：null 节点原样保留，缺口单元拒绝插值', () => {
  assert.equal(result.grid.length, 33 * 33, '网格长度必须与 cols×rows 一致（不能过滤掉 null，否则整行错位）')
  assert.ok(result.grid.nulls_preserved >= 1, 'null 节点必须被保留为 null')
  assert.ok(result.grid.forward_px < 2, `网格兜底与相机数学的偏差应在像素级：${result.grid.forward_px}px`)
  assert.equal(result.grid.hole_result, null, '角点缺失的单元必须返回 null，不能把 null 当 0 插值')
  assert.ok(result.grid.grid_roundtrip_deg < 1e-3, `网格往返误差过大：${result.grid.grid_roundtrip_deg}°`)
})

test('外部图标定：与后端最小二乘同一结果，退化/不足的控制点一律拒绝', () => {
  assert.ok(result.image.forward_px < 1e-6, `标定仿射换算误差过大：${result.image.forward_px}px`)
  assert.ok(result.image.roundtrip_deg < 1e-9, `标定往返误差过大：${result.image.roundtrip_deg}°`)
  assert.ok(result.image.own_registration_px < 1e-6, '前端自拟合的配准必须与后端一致')
  assert.ok(result.image.coef_delta < 1e-9, `仿射系数与后端不一致：${result.image.coef_delta}`)
  assert.ok(result.image.residual_delta < 1e-9, '残差必须与后端一致')
  assert.ok(result.image.residual_rms > 0, '这组控制点是过约束的，残差应为正数（不能假装完美）')
  assert.ok(result.image.server_degenerate, '后端必须拒绝共线控制点')
  assert.equal(result.image.mine_degenerate, null, '前端必须拒绝共线控制点')
  assert.equal(result.image.mine_too_few, null, '少于 3 个控制点必须拒绝')
  assert.equal(result.image.own_degenerate, null, '共线控制点不能拼出可用配准')
})

test('坏配准整体拒绝：绝不把 NaN/非法相机/错长度网格变成一份能用的假投影', () => {
  for (const [key, rejected] of Object.entries(result.rejected)) {
    assert.equal(rejected, true, `${key} 必须被拒绝（返回 null）`)
  }
  assert.equal(result.accepted.good, 'program', '合法配准（含 JSON 字符串形式）必须解析成功')
  assert.equal(result.accepted.nested, 'program', 'provenance.registration 这一层嵌套必须能被找到')
  assert.equal(result.accepted.grid_only, 'earth', '只有采样网格时仍可用于编辑（带 null 节点也行）')
})

test('标定拒绝规则与服务端一致：图外点、非法经纬度、两个空间近共线、高残差都不能显示为可用', () => {
  for (const [name, outcome] of Object.entries(result.invalid_controls)) {
    assert.equal(outcome.serverRejected, true, name + ' 必须被后端拒绝')
    assert.equal(outcome.frontendRejected, true, name + ' 必须被前端即时拟合拒绝')
    assert.equal(outcome.registrationRejected, true, name + ' 不得生成可编辑配准')
  }
})

test('实测 Earth 配准以网格为唯一像素真值，不能退回名义相机或在空洞之外外推', () => {
  const measured = result.calibrated
  assert.ok(Math.hypot(measured.forward[0] - 330, measured.forward[1] - 345) < 1e-6)
  assert.ok(Math.hypot(measured.inverse[0] - 113.5, measured.inverse[1] - 35.8) < 1e-9)
  assert.equal(measured.outside_geo, null)
  assert.equal(measured.outside_pixel, null)
  assert.equal(measured.hole_forward, null)
  assert.equal(measured.hole_inverse, null)
  assert.equal(measured.missing_grid, null)
})
