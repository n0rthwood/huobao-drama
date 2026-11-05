/**
 * 语义标注的 CV 几何测试（Issue #47 验收 6）。
 *
 * 用一张**合成图**代替真实地图，把三条算法分别逼到有确定答案的场景：
 * - 一条蓝色折线（模拟额尔齐斯河）→ 色域抽线应当沿着它走；
 * - 一个黑色**虚线**方框（模拟虚线国界）→ 膨胀闭合后从框内种子泛洪应当只填满框内；
 * - 框外种子 / 画在线上的种子 → 必须如实失败，不能伪造几何。
 * 另外测 Douglas–Peucker 与标签吸附（把 VLM 偏上一个字高的框拉回墨迹上）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))

const script = `
  import {
    colorMask, dilateMask, floodRegion, lineColorCoverage, maskToPolyline,
    parseHexColor, simplifyPolyline, snapBoxToInk,
  } from './src/services/semantics-geometry.ts'

  const W = 400, H = 300
  const data = new Uint8Array(W * H * 3).fill(255)
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const p = (y * W + x) * 3
    data[p] = r; data[p + 1] = g; data[p + 2] = b
  }
  // 蓝色折线：x = 60 + y/3，线宽 3（模拟河道）
  for (let y = 20; y < 280; y++) {
    const x = Math.round(60 + y / 3)
    for (let d = -1; d <= 1; d++) put(x + d, y, 40, 90, 200)
  }
  // 黑色虚线方框 (200,60)–(360,240)：每 12px 画 7px，留 5px 空隙
  const dashed = (x0, y0, x1, y1, horizontal) => {
    const from = horizontal ? x0 : y0
    const to = horizontal ? x1 : y1
    for (let t = from; t <= to; t++) {
      if (t % 12 >= 7) continue
      for (let d = 0; d < 2; d++) {
        if (horizontal) { put(t, y0 + d, 10, 10, 10); put(t, y1 + d, 10, 10, 10) }
        else { put(x0 + d, t, 10, 10, 10); put(x1 + d, t, 10, 10, 10) }
      }
    }
  }
  dashed(200, 60, 360, 240, true)
  dashed(200, 60, 360, 240, false)
  // 框内一行「文字」墨迹（模拟地名）：(250,140)–(300,152)
  for (let y = 140; y <= 152; y++) for (let x = 250; x <= 300; x++) put(x, y, 20, 20, 20)

  const raster = { width: W, height: H, data }
  const blue = parseHexColor('#285ac8')

  const mask = colorMask(raster, blue)
  const polyline = simplifyPolyline(maskToPolyline(mask, W), 2)

  // 框内空白处的种子（避开文字与边框）
  const inside = floodRegion(raster, [230, 90])
  // 框外的种子：泛洪会铺满整张纸 → 必须报泄漏
  const outside = floodRegion(raster, [20, 290])
  // 落在边框线上的种子 → 必须报「种子点落在边界线或文字上」
  const onWall = floodRegion(raster, [200, 61])

  // 标签吸附：VLM 给的框整体偏上 14px（实测里小字号就是这个量级）
  const snapped = snapBoxToInk(raster, [250, 126, 300, 138])
  // 搜索范围里完全没有墨迹 → null，调用方保留 VLM 框
  const snapMiss = snapBoxToInk(raster, [20, 20, 40, 32], { search: 10 })

  const coverage = lineColorCoverage(raster, polyline, blue)
  // 换一个画面上根本不存在的颜色 → 覆盖率应当接近 0（保真核验据此判 failed）
  const coverageWrong = lineColorCoverage(raster, polyline, parseHexColor('#ff00ff'))

  const dilated = dilateMask(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]), 3, 3, 3)

  process.stdout.write(JSON.stringify({
    maskPixels: mask.reduce((sum, v) => sum + v, 0),
    polyline,
    inside: { points: inside.polygon ? inside.polygon.length : 0, bbox: bboxOf(inside.polygon), reason: inside.reason ?? null, ratio: inside.ratio },
    outside: { polygon: outside.polygon, reason: outside.reason ?? null },
    onWall: { polygon: onWall.polygon, reason: onWall.reason ?? null },
    snapped,
    snapMiss,
    coverage,
    coverageWrong,
    dilated: Array.from(dilated),
    simplify: simplifyPolyline(
      [[0, 0], [10, 0], [20, 0], [30, 0], [40, 40], [50, 80]], 2),
    hexBad: parseHexColor('蓝色'),
    hexOk: parseHexColor('#3A6FB0'),
  }))

  function bboxOf(points) {
    if (!points || !points.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of points) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1]
  }
`

const out = execFileSync('npx', ['tsx', '--eval', script], { cwd: backendRoot, encoding: 'utf8' })
const r = JSON.parse(out)

test('色域抽线：蓝线被完整掩膜，折线沿着 x = 60 + y/3 走', () => {
  assert.ok(r.maskPixels > 500, `蓝色像素太少：${r.maskPixels}`)
  assert.ok(r.polyline.length >= 2, `折线点太少：${r.polyline.length}`)
  for (const [x, y] of r.polyline) {
    const expected = 60 + y / 3
    assert.ok(Math.abs(x - expected) <= 3, `点 (${x},${y}) 偏离河道中线 ${Math.abs(x - expected)}px`)
  }
  // 折线应当覆盖河道的大部分纵向跨度
  const ys = r.polyline.map(([, y]) => y)
  assert.ok(Math.max(...ys) - Math.min(...ys) > 200, '折线纵向跨度不足')
})

test('虚线区域：膨胀闭合后从框内种子泛洪，只填满框内', () => {
  assert.equal(r.inside.reason, null)
  assert.ok(r.inside.points >= 3, `轮廓点太少：${r.inside.points}`)
  const [x0, y0, x1, y1] = r.inside.bbox
  // 墙被膨胀过，填充区域比画出来的框略小，但必须落在框内且占住主体
  assert.ok(x0 >= 200 && y0 >= 60 && x1 <= 362 && y1 <= 242, `轮廓越界：${r.inside.bbox}`)
  assert.ok(x1 - x0 > 120 && y1 - y0 > 140, `轮廓没填满框内：${r.inside.bbox}`)
})

test('泛洪泄漏与种子落在墙上都如实报错，不伪造几何', () => {
  assert.equal(r.outside.polygon, null)
  assert.match(r.outside.reason, /泄漏/)
  assert.equal(r.onWall.polygon, null)
  assert.match(r.onWall.reason, /边界线或文字/)
})

test('标签吸附：偏上一个字高的 VLM 框被拉回墨迹上', () => {
  assert.ok(r.snapped, '应当吸附到文字墨迹')
  const [x0, y0, x1, y1] = r.snapped
  assert.ok(y0 <= 140 && y1 >= 152 && y1 <= 160, `纵向没吸附到 140–152：${r.snapped}`)
  assert.ok(x0 <= 250 && x1 >= 300, `横向没覆盖整行文字：${r.snapped}`)
})

test('搜索范围内没有墨迹时返回 null（调用方保留 VLM 框并记 source=vlm）', () => {
  assert.equal(r.snapMiss, null)
})

test('色域覆盖率：原色接近 1，换一个画面上没有的颜色接近 0', () => {
  assert.ok(r.coverage > 0.9, `覆盖率偏低：${r.coverage}`)
  assert.ok(r.coverageWrong < 0.2, `错误颜色不该有覆盖率：${r.coverageWrong}`)
})

test('膨胀：3x3 最大值滤波把单点铺满整个 3x3 窗口', () => {
  assert.deepEqual(r.dilated, [1, 1, 1, 1, 1, 1, 1, 1, 1])
})

test('Douglas–Peucker：共线点被删掉，转折点保留', () => {
  assert.deepEqual(r.simplify, [[0, 0], [30, 0], [50, 80]])
})

test('颜色解析：非 #rrggbb 一律 null（不猜颜色，由调用方记 warning）', () => {
  assert.equal(r.hexBad, null)
  assert.deepEqual(r.hexOk, { r: 0x3a, g: 0x6f, b: 0xb0 })
})

/**
 * 上传截图的可抽色判据放宽（Issue #56 验收 10）。
 *
 * 实测依据：`~/projects/huobao-e2e-yinxu/maps/yinxu-region.png`（Google Earth 截图）上
 * 同一条水体沿程从 rgb(80,144,224) 压到 rgb(16,48,96)——亮度 53 贴着原判据的 50 下限，
 * 再深一点整条洹河一个像素都抽不出来；而欧氏距离 172、偏色幅度 48 又同时被
 * `colorMask` 的两条判据判掉，所以命中率是 0。
 *
 * 放宽只针对这种**屏幕截图**：`isExtractableLineColor` 对强蓝跳过亮度下限，
 * `colorMask({hueOnly:true})` 改按通道序 + 最小彩度判。扫描印刷图走原判据，不受影响。
 */
const relaxScript = `
  import { colorMask, isExtractableLineColor, lineColorCoverage, HUE_ONLY_MIN_CHROMA } from './src/services/semantics-geometry.ts'

  const W = 200, H = 200
  const data = new Uint8Array(W * H * 3).fill(230)
  const put = (x, y, r, g, b) => {
    const p = (y * W + x) * 3
    data[p] = r; data[p + 1] = g; data[p + 2] = b
  }
  // 一条竖直水体：y 从 0 到 199，颜色从亮蓝线性压到深蓝（截图里的水深/地形阴影梯度）
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1)
    const r = Math.round(80 - 64 * t)
    const g = Math.round(144 - 96 * t)
    const b = Math.round(224 - 128 * t)
    for (let d = -1; d <= 1; d++) put(100 + d, y, r, g, b)
  }
  // 一片灰色陆地阴影（彩度不足，hueOnly 不许命中）
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) put(x, y, 120, 124, 128)
  // 一片暖色（通道序 r>g>b，与蓝相反，hueOnly 不许命中）
  for (let y = 160; y < 200; y++) for (let x = 0; x < 40; x++) put(x, y, 200, 150, 90)

  const raster = { width: W, height: H, data }
  const target = { r: 80, g: 144, b: 224 }
  const line = []
  for (let y = 0; y < H; y += 4) line.push([100, y])

  const strictMask = colorMask(raster, target)
  const hueMask = colorMask(raster, target, 90, { hueOnly: true })

  process.stdout.write(JSON.stringify({
    minChroma: HUE_ONLY_MIN_CHROMA,
    extractable: {
      black: isExtractableLineColor({ r: 0, g: 0, b: 0 }),
      white: isExtractableLineColor({ r: 255, g: 255, b: 255 }),
      gray: isExtractableLineColor({ r: 40, g: 45, b: 50 }),
      darkBlue: isExtractableLineColor({ r: 16, g: 48, b: 96 }),
      midBlue: isExtractableLineColor({ r: 80, g: 144, b: 224 }),
      darkRed: isExtractableLineColor({ r: 96, g: 20, b: 16 }),
    },
    strictPixels: strictMask.reduce((s, v) => s + v, 0),
    huePixels: hueMask.reduce((s, v) => s + v, 0),
    grayHit: hueMask[10 * W + 10],
    warmHit: hueMask[180 * W + 10],
    strictCoverage: lineColorCoverage(raster, line, target),
    hueCoverage: lineColorCoverage(raster, line, target, { hueOnly: true }),
  }))
`

const relaxed = JSON.parse(execFileSync('npx', ['tsx', '--eval', relaxScript], { cwd: backendRoot, encoding: 'utf8' }))

test('可抽色判据：纯黑/纯白/灰仍然 false，深蓝水体放行', () => {
  assert.equal(relaxed.extractable.black, false)
  assert.equal(relaxed.extractable.white, false)
  assert.equal(relaxed.extractable.gray, false)
  assert.equal(relaxed.extractable.darkBlue, true, 'b-r=80>60 且 b-g=48>20 的深蓝必须可抽')
  assert.equal(relaxed.extractable.midBlue, true)
  // 同样暗、但不是蓝：原判据的亮度下限仍然生效
  assert.equal(relaxed.extractable.darkRed, false)
})

test('hueOnly 掩膜：覆盖整条明暗渐变水体，不吃灰色与暖色', () => {
  assert.ok(relaxed.huePixels > relaxed.strictPixels * 1.5,
    `放宽后命中应显著增加：strict=${relaxed.strictPixels} hue=${relaxed.huePixels}`)
  assert.equal(relaxed.grayHit, 0, '灰色阴影彩度不足，不该命中')
  assert.equal(relaxed.warmHit, 0, '暖色通道序相反，不该命中')
})

test('截图水体覆盖率：严格判据不达标，放宽后达标', () => {
  assert.ok(relaxed.strictCoverage < 0.8, `严格判据本就该不达标：${relaxed.strictCoverage}`)
  assert.ok(relaxed.hueCoverage > 0.95, `放宽后应当几乎全覆盖：${relaxed.hueCoverage}`)
})
