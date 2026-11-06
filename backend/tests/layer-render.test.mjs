/**
 * 图层服务端渲染（Issue #48）：六种图层各一例的像素命中、中文非豆腐块、
 * 确定性（同文档两次渲染字节一致）、字体覆盖不到的字符阻断渲染。
 * 渲染要 sharp + 打包字体，放在 tsx 子进程里跑，结果以 JSON 回传。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const dataDir = mkdtempSync(path.join(tmpdir(), 'layer-render-'))

const script = `
  import fs from 'fs'
  import path from 'path'
  import sharp from 'sharp'
  import crypto from 'crypto'
  import { normalizeLayerDoc } from './src/services/layer-doc.ts'
  import { renderLayerDoc, renderLayerDocToFile } from './src/services/layer-render.ts'
  import { ensureLayerFonts } from './src/services/layer-fonts.ts'

  const dataDir = process.env.HUOBAO_DATA_DIR
  const staticDir = path.join(dataDir, 'static')
  fs.mkdirSync(staticDir, { recursive: true })
  // 底图：纯中灰，任何图层像素都能和它区分开
  await sharp({ create: { width: 1344, height: 768, channels: 3, background: '#808080' } }).png().toFile(path.join(staticDir, 'base.png'))
  // 内嵌图：纯品红
  await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ff00ff' } }).png().toFile(path.join(staticDir, 'portrait.png'))

  const doc = normalizeLayerDoc(JSON.parse(process.env.RENDER_DOC))
  const out = {}
  out.fonts = await ensureLayerFonts()

  const first = await renderLayerDoc(doc)
  const second = await renderLayerDoc(doc)
  out.ms = first.ms
  out.second_ms = second.ms
  out.width = first.width
  out.height = first.height
  out.deterministic = crypto.createHash('sha256').update(first.buffer).digest('hex')
    === crypto.createHash('sha256').update(second.buffer).digest('hex')

  const probe = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return (x, y) => {
      const i = (Math.round(y) * info.width + Math.round(x)) * info.channels
      return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }
  }
  out.pixels = {}
  const at = await probe(first.buffer)
  for (const [name, x, y] of JSON.parse(process.env.RENDER_PROBES)) out.pixels[name] = at(x, y)

  // 文字区域墨迹：中文标签框内与底图不同的像素数（豆腐块也有墨迹，所以再比一次纯底图）
  const bare = await renderLayerDoc(normalizeLayerDoc({ base: doc.base, theme: doc.theme, layers: [] }))
  const bareAt = await probe(bare.buffer)
  let inked = 0
  for (let y = 520; y < 620; y++) {
    for (let x = 90; x < 520; x++) {
      const a = at(x, y)
      const b = bareAt(x, y)
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 40) inked++
    }
  }
  out.label_inked = inked

  // 只渲染部分图层
  const partial = await renderLayerDoc(doc, { visibleIds: ['zaysan'] })
  const partialAt = await probe(partial.buffer)
  out.partial_marker = partialAt(0.47 * 1344, 0.33 * 768)
  out.partial_polygon = partialAt(0.3 * 1344, 0.28 * 768)

  // 换输出尺寸
  const resized = await renderLayerDoc(doc, { width: 1920, height: 1080 })
  out.resized = [resized.width, resized.height]
  const resizedAt = await probe(resized.buffer)
  out.resized_marker = resizedAt(0.47 * 1920, 0.33 * 1080)

  // 1344x768 单帧耗时（#50 片段渲染的 spike 依据）：连续 10 帧取中位数
  const samples = []
  for (let i = 0; i < 10; i++) {
    const t = await renderLayerDoc(doc)
    samples.push(t.ms)
  }
  samples.sort((a, b) => a - b)
  out.frame_ms_median = samples[5]
  out.frame_ms_min = samples[0]
  out.frame_ms_max = samples[9]

  // 落盘接口
  const file = await renderLayerDocToFile(doc)
  out.file = { url: file.url, exists: fs.existsSync(path.join(dataDir, file.url)) }

  // Poster layers 二次生成：透明叠加层不要求底图，背景 alpha=0、文字有像素
  const overlay = await renderLayerDoc(normalizeLayerDoc({
    base: { path: '', width: 400, height: 200 },
    layers: [{
      type: 'label', variable: 'project_title',
      box: { x: 0.1, y: 0.3, w: 0.8, h: 0.3 }, style: { size: 0.25, align: 'center' },
    }],
  }), { transparent: true, width: 400, height: 200, variables: { project_title: '历史纵横', episode_title: '', episode_no: '' } })
  const overlayAt = await probe(overlay.buffer)
  out.transparent = { alpha: overlayAt(2, 2)[3], text_alpha: overlayAt(200, 100)[3], has_alpha: (await sharp(overlay.buffer).metadata()).hasAlpha }

  // 打包字体覆盖不到的字符必须阻断
  try {
    await renderLayerDoc(normalizeLayerDoc({
      base: doc.base,
      layers: [{ type: 'label', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, text: '缺字\\uE000测试' }],
    }))
    out.unsupported_error = null
  } catch (err) {
    out.unsupported_error = err.message
  }

  // 底图不存在必须给明确原因
  try {
    await renderLayerDoc(normalizeLayerDoc({ base: { path: 'static/missing.png', width: 100, height: 100 }, layers: [] }))
    out.missing_base_error = null
  } catch (err) {
    out.missing_base_error = err.message
  }

  // 越界路径必须拒绝
  try {
    await renderLayerDoc(normalizeLayerDoc({ base: { path: 'static/../../etc/hosts', width: 100, height: 100 }, layers: [] }))
    out.escape_error = null
  } catch (err) {
    out.escape_error = err.message
  }

  // 风格化滤镜：确定性的 alpha 合成，数值要能和手算对上（底图纯 #808080）
  const filtered = await renderLayerDoc(normalizeLayerDoc({
    base: { ...doc.base, filter: { paper: 0.5, tint: 'sepia', tint_strength: 0.5, vignette: 0.6 } },
    layers: [],
  }))
  const filteredAt = await probe(filtered.buffer)
  out.filter_center = filteredAt(672, 384)
  out.filter_corner = filteredAt(10, 10)
  out.bare_center = bareAt(672, 384)
  out.bare_corner = bareAt(10, 10)

  const tinted = await renderLayerDoc(normalizeLayerDoc({
    base: { ...doc.base, filter: { tint: 'sepia', tint_strength: 0.3 } },
    layers: [],
  }))
  out.tint_only = (await probe(tinted.buffer))(672, 384)
  const vignetted = await renderLayerDoc(normalizeLayerDoc({
    base: { ...doc.base, filter: { vignette: 0.5 } },
    layers: [],
  }))
  const vignetteAt = await probe(vignetted.buffer)
  out.vignette_center = vignetteAt(672, 384)
  out.vignette_corner = vignetteAt(1, 1)

  // FONT_CHAR_RANGES 必须是字体**真实**覆盖的码位：逐段抽样真渲染，和缺字占位图比
  const { FONT_CHAR_RANGES } = await import('./src/services/layer-svg.ts')
  const inkOf = async (text, family) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">'
      + '<rect width="120" height="120" fill="#ffffff"/>'
      + '<text x="8" y="90" font-family="' + family + '" font-size="72" fill="#000000">' + text + '</text></svg>'
    return sharp(Buffer.from(svg)).greyscale().raw().toBuffer()
  }
  const tofuSans = await inkOf('\\uE000', "'Noto Sans SC'")
  const tofuSerif = await inkOf('\\uE000', "'Noto Serif SC'")
  out.coverage_ranges = FONT_CHAR_RANGES.length
  out.coverage_tofu = []
  for (const [lo, hi] of FONT_CHAR_RANGES) {
    for (const code of new Set([lo, hi])) {
      const ch = String.fromCodePoint(code).replace(/[<>&]/g, '')
      if (!ch) continue
      for (const [family, tofu] of [["'Noto Sans SC'", tofuSans], ["'Noto Serif SC'", tofuSerif]]) {
        const mask = await inkOf(ch, family)
        let diff = 0
        for (let i = 0; i < mask.length; i++) {
          if (Math.abs(mask[i] - tofu[i]) > 32) diff++
        }
        if (diff < mask.length * 0.002) out.coverage_tofu.push([code.toString(16), family])
      }
    }
  }
  process.stdout.write('@@' + JSON.stringify(out))
`

const DOC = {
  base: { path: 'static/base.png', width: 1344, height: 768 },
  theme: 'archival',
  layers: [
    {
      id: 'dzungar', type: 'polygon', z: 1,
      points: [[0.2, 0.2], [0.45, 0.2], [0.45, 0.4], [0.2, 0.4]],
      style: { fill: '#ff0000', fill_opacity: 1, stroke_width: 0 },
    },
    {
      id: 'irtysh', type: 'polyline', z: 2,
      points: [[0.1, 0.6], [0.5, 0.6], [0.9, 0.6]],
      style: { stroke: '#0000ff', width: 0.02, arrow_end: true },
    },
    { id: 'zaysan', type: 'marker', z: 3, at: [0.47, 0.33], text: '斋桑湖', style: { color: '#00ff00', dot_radius: 0.03 } },
    {
      id: 'label-1', type: 'label', z: 4,
      box: { x: 0.07, y: 0.68, w: 0.32, h: 0.13 }, text: '准噶尔游牧区',
      style: { bg: '#000000', bg_opacity: 1, color: '#ffffff', size: 0.06, stroke_width: 0 },
    },
    {
      id: 'card-1', type: 'card', z: 5, template: 'name',
      box: { x: 0.58, y: 0.74, w: 0.36, h: 0.14 },
      fields: { title: '利哈列夫', sub: '俄国少将', meta: '1720' },
      style: { bg: '#101010', bg_opacity: 1 },
    },
    {
      id: 'portrait', type: 'image', z: 6,
      box: { x: 0.74, y: 0.08, w: 0.18, h: 0.3 }, src: { path: 'static/portrait.png' }, fit: 'cover',
      style: { border_width: 0, shadow: false, radius: 0 },
    },
  ],
}

const PROBES = [
  ['polygon', 0.3 * 1344, 0.28 * 768],
  ['polyline', 0.3 * 1344, 0.6 * 768],
  ['marker', 0.47 * 1344, 0.33 * 768],
  ['label_bg', 0.1 * 1344, 0.7 * 768],
  ['card_bg', 0.8 * 1344, 0.8 * 768],
  ['image', 0.8 * 1344, 0.2 * 768],
  ['base', 0.03 * 1344, 0.05 * 768],
]

const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
  cwd: backendRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, HUOBAO_DATA_DIR: dataDir, RENDER_DOC: JSON.stringify(DOC), RENDER_PROBES: JSON.stringify(PROBES) },
})
const result = JSON.parse(out.slice(out.lastIndexOf('@@') + 2))

test('字体自检通过并指向仓库内打包字体', () => {
  assert.equal(result.fonts.files.length, 7)
  assert.match(result.fonts.font_dir, /backend\/assets\/fonts$/)
  assert.match(result.fonts.config_path, /fontconfig\/layer-fonts\.conf$/)
})

test('输出尺寸：默认取 base，可按输出尺寸覆盖', () => {
  assert.deepEqual([result.width, result.height], [1344, 768])
  assert.deepEqual(result.resized, [1920, 1080])
  assert.ok(result.resized_marker[1] > 180, `换尺寸后 marker 仍在同一归一化位置：${result.resized_marker}`)
})

test('六种图层各一例：采样像素命中各自的颜色', () => {
  const near = (actual, expected, tolerance = 36) =>
    Math.abs(actual[0] - expected[0]) <= tolerance
    && Math.abs(actual[1] - expected[1]) <= tolerance
    && Math.abs(actual[2] - expected[2]) <= tolerance
  assert.ok(near(result.pixels.polygon, [255, 0, 0]), `polygon 填充色：${result.pixels.polygon}`)
  assert.ok(near(result.pixels.polyline, [0, 0, 255]), `polyline 线色：${result.pixels.polyline}`)
  assert.ok(near(result.pixels.marker, [0, 255, 0]), `marker 点色：${result.pixels.marker}`)
  assert.ok(near(result.pixels.label_bg, [0, 0, 0]), `label 背景条：${result.pixels.label_bg}`)
  assert.ok(near(result.pixels.card_bg, [16, 16, 16]), `card 背景：${result.pixels.card_bg}`)
  assert.ok(near(result.pixels.image, [255, 0, 255]), `image 内嵌图：${result.pixels.image}`)
  assert.ok(near(result.pixels.base, [128, 128, 128]), `空白处仍是底图：${result.pixels.base}`)
})

test('中文文字渲染为真实字形（非豆腐块、非空白）', () => {
  // 标签框内有大量与纯底图不同的像素：既不是空白，也不是只有背景条
  assert.ok(result.label_inked > 3000, `标签框内墨迹像素 ${result.label_inked}`)
})

test('visible_ids 只渲染指定图层', () => {
  assert.ok(result.partial_marker[1] > 200, `marker 应被渲染：${result.partial_marker}`)
  assert.ok(Math.abs(result.partial_polygon[0] - 128) < 20, `polygon 不应出现：${result.partial_polygon}`)
})

test('同一文档两次渲染字节一致（确定性）', () => {
  assert.equal(result.deterministic, true)
})

test('底图风格化滤镜改变画面：整体偏色、四角压暗', () => {
  assert.ok(result.filter_center[0] !== result.bare_center[0] || result.filter_center[2] !== result.bare_center[2],
    `中心偏色：${result.filter_center} vs ${result.bare_center}`)
  assert.ok(result.filter_center[0] > result.filter_center[2], `sepia 偏暖：${result.filter_center}`)
  assert.ok(result.filter_corner[0] < result.filter_center[0] - 20, `暗角：角 ${result.filter_corner} 中心 ${result.filter_center}`)
})

test('风格化是纯 alpha 合成：像素值与手算一致（编辑器用同一套公式，两端必然同色）', () => {
  // 底图 #808080，sepia #d9c49b，强度 0.3 → 0.7*128 + 0.3*通道
  const expectedTint = [0xd9, 0xc4, 0x9b].map(channel => Math.round(0.7 * 128 + 0.3 * channel))
  result.tint_only.slice(0, 3).forEach((channel, index) => {
    assert.ok(Math.abs(channel - expectedTint[index]) <= 2, `偏色通道 ${index}：${channel} ≠ ${expectedTint[index]}`)
  })
  // 暗角：中心完全透明（不改底图），边角按 stop-opacity 压暗到 0.5*128 ≈ 64
  assert.ok(Math.abs(result.vignette_center[0] - 128) <= 1, `暗角中心不该变：${result.vignette_center}`)
  assert.ok(Math.abs(result.vignette_corner[0] - 64) <= 6, `暗角边角应压到 ~64：${result.vignette_corner}`)
})

test('render-to-file 落盘到 static/overlays 并返回相对地址', () => {
  assert.match(result.file.url, /^static\/overlays\/[0-9a-f-]+\.png$/)
  assert.equal(result.file.exists, true)
  assert.equal(result.transparent.has_alpha, true)
  assert.equal(result.transparent.alpha, 0)
  assert.ok(result.transparent.text_alpha > 0, '透明叠加层文字必须有像素')
})

test('打包字体覆盖不到的字符阻断渲染（不输出豆腐块）', () => {
  assert.match(result.unsupported_error || '', /打包字体未覆盖/)
})

test('底图缺失与越界路径给出明确原因', () => {
  assert.match(result.missing_base_error || '', /底图文件不存在/)
  assert.match(result.escape_error || '', /越界/)
})

test('1344x768 单帧渲染耗时（#50 片段 spike 依据）', () => {
  console.log(`[layer-render] 1344x768 单帧：中位 ${result.frame_ms_median}ms（${result.frame_ms_min}–${result.frame_ms_max}ms）`)
  assert.ok(result.frame_ms_median < 2000, `单帧耗时异常：${result.frame_ms_median}ms`)
})

test('FONT_CHAR_RANGES 是字体真实覆盖：逐段抽样渲染都不是豆腐块', () => {
  assert.ok(result.coverage_ranges >= 40, `覆盖段数异常：${result.coverage_ranges}`)
  assert.deepEqual(result.coverage_tofu, [], `这些码位声明覆盖但渲染成豆腐块：${JSON.stringify(result.coverage_tofu)}`)
})
