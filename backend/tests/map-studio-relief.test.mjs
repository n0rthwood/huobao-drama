/**
 * 底图换管线（Issue #107 阶段 1）的行为测试：雪线、陆海掩码、水库剔除、整河显隐、
 * 细节帧参数、确定性、缺瓦片报错、画中画钩子、以及与完整数据目录逐字节一致的输出。
 *
 * 无网络：高程瓦片用合成的 terrarium PNG 通过 ensureDemTiles 的 fetchTile 注入；
 * 渲染阶段仍然只读本地缓存（缺瓦片直接报错，不静默联网）。
 * 渲染要 sharp + TS 源码，放在 tsx 子进程里跑（口径同 tests/map-studio-base-render.test.mjs）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'map-studio-relief-'))
const scratchDir = mkdtempSync(path.join(tmpdir(), 'map-studio-relief-offline-'))
/**
 * 只有底图渲染真正用到的 NE 文件（故意不放 admin1/countries/cities）：
 * 用这个目录渲染必须与完整目录逐字节一致——省界和城市点已经从底图管线里彻底移除。
 */
const minimalGeoDir = mkdtempSync(path.join(tmpdir(), 'map-studio-relief-geo-'))
for (const file of ['ne_50m_land.geojson', 'ne_10m_land.geojson', 'ne_10m_lakes.geojson', 'ne_10m_rivers_lake_centerlines.geojson', 'ne_50m_geography_regions_polys.geojson']) {
  symlinkSync(path.join(backendRoot, 'assets', 'geo', file), path.join(minimalGeoDir, file))
}

const script = `
  import crypto from 'crypto'
  import fs from 'fs'
  import path from 'path'
  import sharp from 'sharp'
  import { normalizeMapSpec, mapProjectionFor } from './src/modules/map-studio/geo/base-render.ts'
  import { renderReliefBase, RELIEF_PALETTE } from './src/modules/map-studio/geo/relief-render.ts'
  import { loadNamedRiver, namedRiverNames } from './src/modules/map-studio/geo/named-rivers.ts'
  import { chooseDemZoom, ensureDemTiles } from './src/modules/map-studio/geo/terrain-cache.ts'

  const dataDir = process.env.HUOBAO_DATA_DIR
  const geoDir = './assets/geo'
  const size = { width: 1280, height: 720 }

  /** 合成 terrarium 瓦片：elevation(lon,lat) 返回整数米（整数保证 decode 无损） */
  const tileFetcher = elevation => async (zoom, x, y) => {
    const tile = 256, world = tile * 2 ** zoom
    const buffer = Buffer.alloc(tile * tile * 3)
    for (let row = 0; row < tile; row++) {
      const gy = y * tile + row + 0.5
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / world))) * 180 / Math.PI
      for (let col = 0; col < tile; col++) {
        const gx = x * tile + col + 0.5
        const lon = gx / world * 360 - 180
        const value = Math.max(0, Math.min(65535, Math.round(elevation(lon, lat) + 32768)))
        const offset = (row * tile + col) * 3
        buffer[offset] = Math.floor(value / 256)
        buffer[offset + 1] = value % 256
        buffer[offset + 2] = 0
      }
    }
    return sharp(buffer, { raw: { width: tile, height: tile, channels: 3 } }).png().toBuffer()
  }

  async function prep(spec, elevation, scenario, role = 'overview') {
    const cacheDir = path.join(dataDir, 'scenarios', scenario)
    const zoom = chooseDemZoom(spec.bbox, size, role)
    await ensureDemTiles({
      projection: mapProjectionFor(spec, size), width: size.width, height: size.height, zoom, cacheDir,
      fetchTile: tileFetcher(elevation),
    })
    return { cacheDir, zoom }
  }

  async function readPixels(buffer) {
    const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const width = info.width, height = info.height
    return {
      width, height,
      at: (x, y) => {
        const offset = (Math.round(y) * width + Math.round(x)) * 3
        return [data[offset], data[offset + 1], data[offset + 2]]
      },
    }
  }
  const near = (color, target, tolerance) => Math.abs(color[0] - target[0]) <= tolerance
    && Math.abs(color[1] - target[1]) <= tolerance && Math.abs(color[2] - target[2]) <= tolerance
  /** 雪线的「白」：亮且几乎无色偏；高原面的米黄底 (238,232,212) 差 26 个通道，不算白 */
  const whiteish = color => Math.min(...color) >= 230 && Math.max(...color) - Math.min(...color) <= 12
  const project = spec => (lon, lat) => mapProjectionFor(spec, size)([lon, lat])

  async function render(spec, prepared, options = {}) {
    const result = await renderReliefBase(spec, size, { demZoom: prepared.zoom, demCacheDir: prepared.cacheDir, ...options })
    return {
      result,
      pixels: await readPixels(result.buffer),
      sha: crypto.createHash('sha256').update(result.buffer).digest('hex'),
    }
  }

  const out = {}

  // 1) 雪线双条件：绝对 4000 m 的高原面不着白；窄山脊高出周围 30 km 均值才着白
  {
    const flatSpec = normalizeMapSpec({ bbox: [74, 29, 78, 33], layers: { land: true, coastline: false, rivers: false, lakes: false, countries: false } })
    const flatPrep = await prep(flatSpec, () => 4000, 'plateau')
    const flat = await render(flatSpec, flatPrep, { params: { glyphs: false, waves: false } })
    const point = project(flatSpec)(76, 31)
    const plateauPixel = flat.pixels.at(point[0], point[1])
    out.plateau = { pixel: plateauPixel, whiteish: whiteish(plateauPixel) }

    const ridgeSpec = normalizeMapSpec({ bbox: [74, 29, 78, 33], layers: { land: true, coastline: false, rivers: false, lakes: false, countries: false } })
    const ridgePrep = await prep(ridgeSpec, (lon, lat) => (lon > 75.5 && lon < 75.86 && lat > 30.5 && lat < 31.5 ? 4800 : 3000), 'ridge')
    const ridge = await render(ridgeSpec, ridgePrep, { params: { glyphs: false, waves: false } })
    const ridgePoint = project(ridgeSpec)(75.68, 31)
    const flatPoint = project(ridgeSpec)(76.6, 31)
    out.ridge = {
      ridge: ridge.pixels.at(ridgePoint[0], ridgePoint[1]),
      surroundings: ridge.pixels.at(flatPoint[0], flatPoint[1]),
      ridgeWhite: whiteish(ridge.pixels.at(ridgePoint[0], ridgePoint[1])),
      surroundingsWhite: whiteish(ridge.pixels.at(flatPoint[0], flatPoint[1])),
    }
  }

  // 2) 陆海掩码：海里不出现陆地色；低于海平面的内陆（里海北岸/洼地）仍然是陆
  {
    const oceanSpec = normalizeMapSpec({ bbox: [170, 10, 178, 18] })
    const ocean = await render(oceanSpec, await prep(oceanSpec, () => -2000, 'ocean'))
    let sea = 0, landLike = 0, sampled = 0
    for (let y = 20; y < 700; y += 20) {
      for (let x = 20; x < 1260; x += 20) {
        sampled++
        const color = ocean.pixels.at(x, y)
        if (near(color, RELIEF_PALETTE.sea, 6)) sea++
        // 陆地设色与描边都是暖色（R > B）；海与海波都是冷色（B > R）
        if (color[0] > color[2] + 5) landLike++
      }
    }
    out.ocean = { sampled, sea, landLike, waves: ocean.result.summary.waves }
    const inlandSpec = normalizeMapSpec({ bbox: [60, 50, 70, 56] })
    const inland = await render(inlandSpec, await prep(inlandSpec, () => -200, 'inland'))
    let inlandSea = 0, inlandSampled = 0
    for (let y = 20; y < 700; y += 20) {
      for (let x = 20; x < 1260; x += 20) {
        inlandSampled++
        if (near(inland.pixels.at(x, y), RELIEF_PALETTE.sea, 6)) inlandSea++
      }
    }
    out.inland = { sampled: inlandSampled, seaPixels: inlandSea }
  }

  // 3) 水库剔除（featurecla=Reservoir）；同帧的真湖泊仍然画成湖色
  {
    const lakes = JSON.parse(fs.readFileSync(path.join(geoDir, 'ne_10m_lakes.geojson'), 'utf8')).features
    const outerRing = feature => {
      const geometry = feature.geometry
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : []
      return polygons.map(polygon => polygon[0]).sort((a, b) => b.length - a.length)[0]
    }
    const centroidOf = ring => ring.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map(value => value / ring.length)

    const reservoir = lakes.find(feature => feature.properties.featurecla === 'Reservoir' && feature.properties.name === 'Mingevir Reservoir')
    const reservoirCentroid = centroidOf(outerRing(reservoir))
    const reservoirSpec = normalizeMapSpec({
      bbox: [reservoirCentroid[0] - 0.6, reservoirCentroid[1] - 0.4, reservoirCentroid[0] + 0.6, reservoirCentroid[1] + 0.4],
      layers: { land: true, coastline: true, rivers: false, lakes: true, countries: false },
    })
    const reservoirRender = await render(reservoirSpec, await prep(reservoirSpec, () => 200, 'reservoir'), { params: { glyphs: false, waves: false } })
    const reservoirPoint = project(reservoirSpec)(reservoirCentroid[0], reservoirCentroid[1])

    const baikal = lakes.find(feature => /baikal|baykal/i.test(feature.properties.name || ''))
    const baikalCentroid = centroidOf(outerRing(baikal))
    const baikalSpec = normalizeMapSpec({
      bbox: [baikalCentroid[0] - 1.5, baikalCentroid[1] - 1.5, baikalCentroid[0] + 1.5, baikalCentroid[1] + 1.5],
      layers: { land: true, coastline: true, rivers: false, lakes: true, countries: false },
    })
    const baikalRender = await render(baikalSpec, await prep(baikalSpec, () => 500, 'baikal'), { params: { glyphs: false, waves: false } })
    const baikalPoint = project(baikalSpec)(baikalCentroid[0], baikalCentroid[1])

    out.lakes = {
      reservoirName: reservoir.properties.name,
      reservoirPixel: reservoirRender.pixels.at(reservoirPoint[0], reservoirPoint[1]),
      reservoirIsLake: near(reservoirRender.pixels.at(reservoirPoint[0], reservoirPoint[1]), RELIEF_PALETTE.lake, 8),
      reservoirsDropped: reservoirRender.result.summary.reservoirs_dropped,
      baikalPixel: baikalRender.pixels.at(baikalPoint[0], baikalPoint[1]),
      baikalIsLake: near(baikalRender.pixels.at(baikalPoint[0], baikalPoint[1]), RELIEF_PALETTE.lake, 8),
      baikalDrawn: baikalRender.result.summary.lakes_drawn,
    }
  }

  // 4) 整条河按名显隐：rank 超默认档位的河默认不画，进叙事豁免后整条画出
  {
    const features = JSON.parse(fs.readFileSync(path.join(geoDir, 'ne_10m_rivers_lake_centerlines.geojson'), 'utf8')).features
    const groups = new Map()
    for (const feature of features) {
      const name = feature.properties.name
      if (!name || !feature.geometry) continue
      const group = groups.get(name) ?? { rank: 99, features: [] }
      group.rank = Math.min(group.rank, feature.properties.scalerank ?? 99)
      group.features.push(feature)
      groups.set(name, group)
    }
    let chosen = null
    for (const [name, group] of [...groups.entries()].sort((a, b) => b[1].rank - a[1].rank)) {
      if (group.rank < 9) continue
      const geometry = group.features[0].geometry
      const line = geometry.type === 'MultiLineString' ? geometry.coordinates[0] : geometry.coordinates
      const middle = line[Math.floor(line.length / 2)]
      // 画面里不能有别的 <=8 档河道穿过这个点，否则「默认不画」的断言会被邻近河道污染
      const crowded = features.some(feature => {
        if ((feature.properties.scalerank ?? 99) > 8 || !feature.geometry) return false
        const flat = JSON.stringify(feature.geometry.coordinates).match(/-?\\d+\\.?\\d*/g)?.map(Number) ?? []
        for (let i = 0; i + 1 < flat.length; i += 2) {
          if (Math.hypot(flat[i] - middle[0], flat[i + 1] - middle[1]) < 2) return true
        }
        return false
      })
      if (!crowded) { chosen = { name, rank: group.rank, middle }; break }
    }
    const spec = normalizeMapSpec({
      bbox: [chosen.middle[0] - 1.6, chosen.middle[1] - 1.6, chosen.middle[0] + 1.6, chosen.middle[1] + 1.6],
      layers: { land: true, coastline: false, rivers: true, lakes: false, countries: false },
    })
    const prepared = await prep(spec, () => 120, 'river')
    const plain = await render(spec, prepared, { lineScale: 3, params: { glyphs: false, waves: false } })
    const exempt = await render(spec, prepared, { lineScale: 3, exemptRivers: [chosen.name], params: { glyphs: false, waves: false } })
    const again = await render(spec, prepared, { lineScale: 3, exemptRivers: [chosen.name], params: { glyphs: false, waves: false } })
    const point = project(spec)(chosen.middle[0], chosen.middle[1])
    out.rivers = {
      chosen,
      plainPixel: plain.pixels.at(point[0], point[1]),
      exemptPixel: exempt.pixels.at(point[0], point[1]),
      plainRiverish: near(plain.pixels.at(point[0], point[1]), RELIEF_PALETTE.river, 40),
      exemptRiverish: near(exempt.pixels.at(point[0], point[1]), RELIEF_PALETTE.river, 40),
      plainHidden: plain.result.summary.rivers_hidden,
      exemptDrawn: exempt.result.summary.exempt_drawn,
      deterministic: plain.sha === (await render(spec, prepared, { lineScale: 3, params: { glyphs: false, waves: false } })).sha,
      exemptDeterministic: exempt.sha === again.sha,
    }
  }

  // 5) 细节帧参数 + 画中画钩子 + 「没有一个字」 + 缺瓦片报错 + 目录无关性
  {
    const spec = normalizeMapSpec({ bbox: [40, 46, 55, 56] })
    const elevation = (lon, lat) => 120 + Math.round(400 * Math.sin(lon) * Math.cos(lat))
    const prepared = await prep(spec, elevation, 'hooks')
    const hooks = await render(spec, prepared, {
      underSvg: '<rect x="0" y="0" width="60" height="60" fill="#ff00ff"/>',
      overSvg: '<rect x="100" y="100" width="20" height="20" fill="#00ff00"/>',
    })
    out.hooks = {
      text: hooks.result.overlaySvg.includes('<text'),
      underPixel: hooks.pixels.at(10, 10),
      overPixel: hooks.pixels.at(105, 105),
      svgLength: hooks.result.overlaySvg.length,
      sha: hooks.sha,
    }
    const detailSpec = normalizeMapSpec({ bbox: [40, 46, 55, 56], detail_level: 'regional' })
    const detail = await render(detailSpec, prepared, { params: { glyphs: false, waves: false } })
    out.detail = { role: detail.result.summary.role, cap: detail.result.summary.params.cap, sigmaKm: detail.result.summary.params.sigmaKm, valley: detail.result.summary.params.valley }
    try {
      await renderReliefBase(spec, size, { demZoom: prepared.zoom, demCacheDir: path.join(dataDir, 'scenarios', 'empty') })
      out.missing = null
    } catch (err) {
      out.missing = { name: err.constructor.name, message: err.message }
    }
  }

  // 6) 命名河流包（OSM 预取）：运行时只读本地包，缺包时如实警告
  {
    const namedNames = namedRiverNames()
    const ugra = loadNamedRiver('Ugra')
    const spec = normalizeMapSpec({ bbox: [34.4, 53.6, 37.4, 55.8], layers: { land: true, coastline: false, rivers: false, lakes: false, countries: false } })
    const prepared = await prep(spec, () => 120, 'named')
    const withUgra = await render(spec, prepared, { lineScale: 3, namedRivers: ['Ugra'], params: { glyphs: false, waves: false } })
    const longest = ugra.lines.reduce((best, line) => (line.length > best.length ? line : best), ugra.lines[0])
    const middle = longest[Math.floor(longest.length / 2)]
    const point = project(spec)(middle[0], middle[1])
    const missingRiver = await render(spec, prepared, { lineScale: 3, namedRivers: ['NotARiver'], params: { glyphs: false, waves: false } })
    out.named = {
      names: namedNames,
      ugra: { ways: ugra.ways, lines: ugra.lines.length, license: ugra.license, nameZh: ugra.name_zh },
      pixel: withUgra.pixels.at(point[0], point[1]),
      riverish: near(withUgra.pixels.at(point[0], point[1]), RELIEF_PALETTE.river, 40),
      used: withUgra.result.summary.named_rivers_used,
      missingWarnings: missingRiver.result.warnings.filter(warning => warning.includes('NotARiver')),
      missingUsed: missingRiver.result.summary.named_rivers_used,
    }
  }

  out.palette = { RELIEF_PALETTE }

  console.log('@@' + JSON.stringify(out))
`

/** 第二个进程只放渲染用得到的 NE 文件：输出必须逐字节等于完整目录下的那张图 */
const minimalScript = `
  import crypto from 'crypto'
  import sharp from 'sharp'
  import { normalizeMapSpec, mapProjectionFor } from './src/modules/map-studio/geo/base-render.ts'
  import { renderReliefBase } from './src/modules/map-studio/geo/relief-render.ts'
  import { chooseDemZoom, ensureDemTiles } from './src/modules/map-studio/geo/terrain-cache.ts'

  const size = { width: 1280, height: 720 }
  const spec = normalizeMapSpec({ bbox: [40, 46, 55, 56] })
  const elevation = (lon, lat) => 120 + Math.round(400 * Math.sin(lon) * Math.cos(lat))
  const tileFetcher = async (zoom, x, y) => {
    const tile = 256, world = tile * 2 ** zoom
    const buffer = Buffer.alloc(tile * tile * 3)
    for (let row = 0; row < tile; row++) {
      const gy = y * tile + row + 0.5
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * gy / world))) * 180 / Math.PI
      for (let col = 0; col < tile; col++) {
        const gx = x * tile + col + 0.5
        const lon = gx / world * 360 - 180
        const value = Math.max(0, Math.min(65535, Math.round(elevation(lon, lat) + 32768)))
        const offset = (row * tile + col) * 3
        buffer[offset] = Math.floor(value / 256)
        buffer[offset + 1] = value % 256
        buffer[offset + 2] = 0
      }
    }
    return sharp(buffer, { raw: { width: tile, height: tile, channels: 3 } }).png().toBuffer()
  }
  const cacheDir = process.env.RELIEF_DEM_CACHE
  const zoom = chooseDemZoom(spec.bbox, size, 'overview')
  await ensureDemTiles({ projection: mapProjectionFor(spec, size), width: size.width, height: size.height, zoom, cacheDir, fetchTile: tileFetcher })
  const result = await renderReliefBase(spec, size, {
    demZoom: zoom, demCacheDir: cacheDir,
    underSvg: '<rect x="0" y="0" width="60" height="60" fill="#ff00ff"/>',
    overSvg: '<rect x="100" y="100" width="20" height="20" fill="#00ff00"/>',
  })
  console.log('@@' + JSON.stringify({ sha: crypto.createHash('sha256').update(result.buffer).digest('hex') }))
`

function runInline(source, env) {
  const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: backendRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  })
  return JSON.parse(output.slice(output.lastIndexOf('@@') + 2))
}

const dataEnv = {
  HUOBAO_DATA_DIR: dataDir,
  SQLITE_PATH: path.join(dataDir, 'test.sqlite3'),
  STORAGE_PATH: path.join(dataDir, 'static'),
}
const result = runInline(script, dataEnv)
mkdirSync(path.join(scratchDir, 'static'), { recursive: true })
const minimal = runInline(minimalScript, {
  HUOBAO_DATA_DIR: scratchDir,
  HUOBAO_GEO_DIR: minimalGeoDir,
  SQLITE_PATH: path.join(scratchDir, 'test.sqlite3'),
  STORAGE_PATH: path.join(scratchDir, 'static'),
  RELIEF_DEM_CACHE: path.join(dataDir, 'scenarios', 'hooks'),
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(scratchDir, { recursive: true, force: true })
  rmSync(minimalGeoDir, { recursive: true, force: true })
})

test('雪线：绝对高程 4000 m 的高原面不着白，只有高出周围 30 km 均值的山脊才着白', () => {
  assert.equal(result.plateau.whiteish, false, `高原面被刷白了：像素 ${JSON.stringify(result.plateau.pixel)}`)
  assert.equal(result.ridge.ridgeWhite, true, `山脊顶应该着白：像素 ${JSON.stringify(result.ridge.ridge)}`)
  assert.equal(result.ridge.surroundingsWhite, false, `脊旁的台地不应着白：像素 ${JSON.stringify(result.ridge.surroundings)}`)
})

test('陆海掩码来自陆地多边形：海里没有陆地设色；低于海平面的内陆仍是陆', () => {
  assert.equal(result.ocean.landLike, 0, `海洋帧里出现了陆地色（${result.ocean.landLike}/${result.ocean.sampled}）`)
  assert.ok(result.ocean.sea > result.ocean.sampled * 0.9, `海洋帧应几乎全是海色，实际 ${result.ocean.sea}/${result.ocean.sampled}`)
  assert.ok(result.ocean.waves > 0, '海洋帧应画出海波符号')
  assert.equal(result.inland.seaPixels, 0, `海拔 -200 m 的内陆被画成了海（${result.inland.seaPixels}/${result.inland.sampled}）`)
})

test('湖泊：featurecla=Reservoir 的现代水库被剔除，同帧真湖泊仍画成湖色', () => {
  assert.ok(result.lakes.reservoirsDropped > 0, `应剔除画框内的水库（${result.lakes.reservoirName}）`)
  assert.equal(result.lakes.reservoirIsLake, false, `水库被画成了湖色：${JSON.stringify(result.lakes.reservoirPixel)}`)
  assert.equal(result.lakes.baikalIsLake, true, `真湖泊应画成湖色：${JSON.stringify(result.lakes.baikalPixel)}`)
  assert.ok(result.lakes.baikalDrawn > 0)
})

test('整条河按名显隐：超出默认档位的河默认不画，叙事豁免后整条画出（且两次渲染逐字节相同）', () => {
  assert.equal(result.rivers.plainRiverish, false, `rank ${result.rivers.chosen.rank} 的「${result.rivers.chosen.name}」不该默认画出：${JSON.stringify(result.rivers.plainPixel)}`)
  assert.ok(result.rivers.plainHidden > 0, '应有被隐掉的河组')
  assert.equal(result.rivers.exemptRiverish, true, `豁免后的「${result.rivers.chosen.name}」应画出：${JSON.stringify(result.rivers.exemptPixel)}`)
  assert.deepEqual(result.rivers.exemptDrawn, [result.rivers.chosen.name])
  assert.equal(result.rivers.deterministic, true, '同一 spec 两次渲染应逐字节相同')
  assert.equal(result.rivers.exemptDeterministic, true, '豁免渲染也应可重复')
})

test('细节帧用本帧拉伸的细节参数（cap 120 / sigma 14 km / 河谷强调 1.5）', () => {
  assert.equal(result.detail.role, 'detail')
  assert.equal(result.detail.cap, 120)
  assert.equal(result.detail.sigmaKm, 14)
  assert.equal(result.detail.valley, 1.5)
})

test('画中画钩子按像素坐标合成；底图叠加层里一个 <text 都没有', () => {
  assert.equal(result.hooks.text, false, '底图不得渲染文字')
  assert.deepEqual(result.hooks.underPixel, [255, 0, 255], 'underSvg 应合成在底图上')
  assert.deepEqual(result.hooks.overPixel, [0, 255, 0], 'overSvg 应合成在最上层')
  assert.ok(result.hooks.svgLength > 1000, '叠加层应含真实矢量路径')
})

test('缺高程瓦片时报可读错误：点名瓦片 + 给出预取命令，绝不静默联网', () => {
  assert.equal(result.missing?.name, 'DemCacheError')
  assert.match(result.missing.message, /高程瓦片缺失/)
  assert.match(result.missing.message, /\d+\/\d+\/\d+/, '错误必须点名具体瓦片 z/x/y')
  assert.match(result.missing.message, /prefetch-map-data\.ts --bbox/)
})

test('底图只用渲染所需的数据文件：缺 admin1/countries/cities 时输出逐字节相同', () => {
  assert.match(minimal.sha, /^[0-9a-f]{64}$/)
  assert.equal(minimal.sha, result.hooks.sha, '精简地理目录与完整目录的输出必须一致（说明省界/城市点已彻底移出底图管线）')
})

test('命名河流包（OSM 预取）：运行时只读本地包画出乌格拉河，缺包河名如实警告', () => {
  const named = result.named
  assert.ok(named.names.includes('Ugra'), `预取包应含乌格拉河：${named.names.join(',')}`)
  assert.equal(named.ugra.ways, 26, '乌格拉河应有 26 条 way（与预取记录一致）')
  assert.ok(named.ugra.lines >= 26)
  assert.equal(named.ugra.license, 'ODbL-1.0')
  assert.equal(named.riverish, true, `乌格拉河应画出（像素 ${JSON.stringify(named.pixel)}）`)
  assert.deepEqual(named.used, ['Ugra'])
  assert.equal(named.missingWarnings.length, 1, '缺包河名必须给出一条可照做的警告')
  assert.match(named.missingWarnings[0], /osm-rivers/)
  assert.deepEqual(named.missingUsed, [], '缺包河名不能假装画出来了')
})

// ---------------------------------------------------------------- 色板对比度闸（Issue #107 验收 1）

const srgbToLab = (r, g, b) => {
  const f = value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const R = f(r), G = f(g), B = f(b)
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
  const t = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))]
}

function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2, r = Math.PI / 180
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2, Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2)
  let hp1 = Math.atan2(b1, ap1) / r; if (hp1 < 0) hp1 += 360
  let hp2 = Math.atan2(b2, ap2) / r; if (hp2 < 0) hp2 += 360
  const dL = L2 - L1, dC = Cp2 - Cp1
  let dh = hp2 - hp1
  if (Cp1 * Cp2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dh * r / 2), Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2
  let hb = hp1 + hp2
  if (Cp1 * Cp2 !== 0) { if (Math.abs(hp1 - hp2) <= 180) hb /= 2; else hb = (hb < 360 ? hb + 360 : hb - 360) / 2 }
  const T = 1 - 0.17 * Math.cos((hb - 30) * r) + 0.24 * Math.cos(2 * hb * r) + 0.32 * Math.cos((3 * hb + 6) * r) - 0.2 * Math.cos((4 * hb - 63) * r)
  const dth = 30 * Math.exp(-(((hb - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(Cpb ** 7 / (Cpb ** 7 + 25 ** 7))
  const Sl = 1 + 0.015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2), Sc = 1 + 0.045 * Cpb, Sh = 1 + 0.015 * Cpb * T
  const Rt = -Math.sin(2 * dth * r) * Rc
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh))
}

/**
 * 对比度闸只看色板本身：地形明暗系数 k 在 0.42..1 之间走动，陆地设色是
 * hypso 四档 × 这个系数；河道与海必须对**整个范围**都够远，否则换个经度带就又糊了。
 */
test('色板对比度闸：河线 vs 陆地 ΔE2000 ≥ 25、海 vs 陆地 ≥ 12（地形明暗全区间）', () => {
  const { RELIEF_PALETTE } = result.palette
  const landTints = []
  for (const stop of RELIEF_PALETTE.hypso) {
    for (let k = 0.42; k <= 1.0001; k += 0.01) {
      landTints.push(stop.map((value, channel) => Math.round(value * k + RELIEF_PALETTE.shadeDark[channel] * (1 - k) * 0.35)))
    }
  }
  const riverLab = srgbToLab(...RELIEF_PALETTE.river)
  const seaLab = srgbToLab(...RELIEF_PALETTE.sea)
  const riverGap = Math.min(...landTints.map(tint => deltaE2000(riverLab, srgbToLab(...tint))))
  const seaGap = Math.min(...landTints.map(tint => deltaE2000(seaLab, srgbToLab(...tint))))
  assert.ok(riverGap >= 25, `河道与陆地色板的最小 ΔE2000 是 ${riverGap.toFixed(2)}，必须 ≥ 25`)
  assert.ok(seaGap >= 12, `海与陆地色板的最小 ΔE2000 是 ${seaGap.toFixed(2)}，必须 ≥ 12`)
})
