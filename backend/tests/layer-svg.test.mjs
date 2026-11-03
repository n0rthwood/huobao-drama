/**
 * 图层 SVG（Issue #48）：前后端同源实现逐例对照 + 文字排版策略锁定。
 * 后端规则在 TS 里，用 tsx 子进程跑并以 JSON 回传；前端同源实现直接 import。
 * 两边用同一个 resolveImage（图片 href 是两端唯一允许不同的地方）。
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as front from '../../frontend/app/utils/layerSvg.js'

const backendRoot = fileURLToPath(new URL('..', import.meta.url))
const resolveImage = path => `RES:${path}`

function backend(payload) {
  const script = `
    import { normalizeLayerDoc } from './src/services/layer-doc.ts'
    import { layerDocToSvg, baseFilterLayers, wrapTextEm, measureTextEm, unsupportedChars, layerBounds } from './src/services/layer-svg.ts'
    const input = JSON.parse(process.env.SVG_INPUT)
    const resolveImage = path => 'RES:' + path
    process.stdout.write('@@' + JSON.stringify({
      cases: input.cases.map(item => {
        const doc = normalizeLayerDoc(item.doc)
        return {
          doc,
          svg: layerDocToSvg(doc, item.size, { resolveImage, visibleIds: item.visible_ids }),
          filters: baseFilterLayers(doc.base.filter, item.size),
          bounds: doc.layers.map(layer => layerBounds(layer, doc.theme, item.size.width / item.size.height)),
        }
      }),
      wraps: input.wraps.map(([text, limit]) => wrapTextEm(text, limit)),
      widths: input.widths.map(measureTextEm),
      unsupported: input.unsupported.map(unsupportedChars),
    }))
  `
  const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: { ...process.env, SVG_INPUT: JSON.stringify(payload) },
  })
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2))
}

const MAP_DOC = {
  base: { path: 'static/uploads/map.png', width: 1344, height: 768 },
  theme: 'archival',
  layers: [
    {
      id: 'dzungar', type: 'polygon', name: '准噶尔游牧区', z: 1,
      points: [[0.18, 0.2], [0.44, 0.16], [0.52, 0.38], [0.3, 0.46]],
      anchor: { asset_id: 39, semantic_id: 'region-dzungar' },
    },
    {
      id: 'irtysh', type: 'polyline', name: '额尔齐斯河', z: 2,
      points: [[0.22, 0.52], [0.3, 0.4], [0.41, 0.3], [0.52, 0.22]],
      style: { arrow_end: true, dash: 'dash' },
    },
    { id: 'zaysan', type: 'marker', name: '斋桑湖', z: 3, at: [0.47, 0.33], text: '斋桑湖' },
    {
      id: 'label-1', type: 'label', name: '区域标签', z: 4,
      box: { x: 0.06, y: 0.66, w: 0.34, h: 0.18 }, text: '准噶尔游牧区，1720 年',
      style: { bg_opacity: 0.55, align: 'left' },
    },
    {
      id: 'card-1', type: 'card', name: '姓名条', z: 5, template: 'name',
      box: { x: 0.58, y: 0.74, w: 0.36, h: 0.14 },
      fields: { title: '利哈列夫', sub: '俄国少将', meta: '1720' },
    },
    {
      id: 'portrait', type: 'image', name: '肖像', z: 6, rotation: -4, opacity: 0.9,
      box: { x: 0.74, y: 0.08, w: 0.18, h: 0.3 }, src: { path: 'static/uploads/portrait.png' }, fit: 'cover',
    },
  ],
}

const CASES = [
  { name: '六种图层 · archival · 1344x768', doc: MAP_DOC, size: { width: 1344, height: 768 } },
  { name: '同一文档换输出尺寸 1920x1080', doc: MAP_DOC, size: { width: 1920, height: 1080 } },
  {
    name: 'clean 主题 + 只渲染部分图层',
    doc: { ...MAP_DOC, theme: 'clean' },
    size: { width: 1280, height: 720 },
    visible_ids: ['irtysh', 'zaysan'],
  },
  {
    name: 'ink 主题 + 换行/对齐/转义/双向箭头/点线',
    doc: {
      base: { path: 'static/uploads/map.png', width: 960, height: 544, filter: { paper: 0.3, tint: 'sepia', tint_strength: 0.4, vignette: 0.25 } },
      theme: 'ink',
      layers: [
        {
          id: 'route', type: 'polyline', points: [[0.1, 0.9], [0.4, 0.6], [0.8, 0.5]],
          style: { dash: 'dot', arrow_start: true, arrow_end: true, width: 0.009 },
        },
        {
          id: 'wrapped', type: 'label', box: { x: 0.08, y: 0.1, w: 0.4, h: 0.3 },
          text: '1720 年初，准噶尔汗国、清朝与俄国三方\n在额尔齐斯河一线对峙。',
          style: { align: 'center', bg_opacity: 0.8, size: 0.05 },
        },
        { id: 'esc', type: 'label', box: { x: 0.5, y: 0.1, w: 0.4, h: 0.1 }, text: 'A & B <tag> "quote"', style: { align: 'right' } },
        { id: 'left', type: 'marker', at: [0.9, 0.3], text: '西宁', style: { label_offset: [-0.02, 0.01] } },
        { id: 'year', type: 'card', template: 'year', box: { x: 0.35, y: 0.6, w: 0.3, h: 0.2 }, fields: { title: '1720', sub: '康熙五十九年' } },
        { id: 'chapter', type: 'card', template: 'chapter', box: { x: 0.05, y: 0.45, w: 0.4, h: 0.16 }, fields: { title: '第一章', sub: '两路远征' } },
      ],
    },
    size: { width: 960, height: 544 },
  },
  {
    name: '隐藏与锁定图层不出现在 SVG 里',
    doc: {
      base: { path: 'static/uploads/map.png', width: 800, height: 450 },
      layers: [
        { id: 'hidden', type: 'marker', at: [0.2, 0.2], text: '隐藏', visible: false },
        { id: 'shown', type: 'marker', at: [0.6, 0.6], text: '可见', locked: true },
      ],
    },
    size: { width: 800, height: 450 },
  },
]

const WRAPS = [
  ['准噶尔汗国与清朝的边界', 6],
  ['利哈列夫，远征', 4],
  ['Semipalatinsk 1718 fort', 10],
  ['AAAAAAAAAAAAAAAAAAAA', 5],
  ['第一行\n第二行', 10],
  ['', 10],
]

const WIDTHS = ['斋桑湖', 'Irtysh', '1720 年', '']
const UNSUPPORTED = ['额尔齐斯河 Irtysh 1720', '𠀋 rare', '\uE000盒']

const result = backend({ cases: CASES.map(({ doc, size, visible_ids }) => ({ doc, size, visible_ids })), wraps: WRAPS, widths: WIDTHS, unsupported: UNSUPPORTED })

CASES.forEach((item, index) => {
  test(`layerDocToSvg 前后端逐例一致：${item.name}`, () => {
    const { doc, svg, filters, bounds } = result.cases[index]
    const frontSvg = front.layerDocToSvg(doc, item.size, { resolveImage, visibleIds: item.visible_ids })
    assert.equal(frontSvg, svg)
    assert.deepEqual(front.baseFilterLayers(doc.base.filter, item.size), filters)
    const aspect = item.size.width / item.size.height
    assert.deepEqual(doc.layers.map(layer => front.layerBounds(layer, doc.theme, aspect)), bounds)
  })
})

test('SVG 结构：根节点尺寸、图层分组、defs 只在需要时出现', () => {
  const svg = result.cases[0].svg
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1344" height="768" viewBox="0 0 1344 768">/)
  assert.ok(svg.includes('<defs>'), 'image 图层要带 clipPath/阴影 defs')
  for (const id of ['dzungar', 'irtysh', 'zaysan', 'label-1', 'card-1', 'portrait']) {
    assert.ok(svg.includes(`data-layer="${id}"`), `缺少图层 ${id}`)
  }
  assert.ok(svg.includes('transform="rotate(-4'), '旋转写在图层分组上')
  assert.ok(svg.includes('opacity="0.9"'), '透明度写在图层分组上')
  assert.ok(svg.includes('href="RES:static/uploads/portrait.png"'), '图片 href 走 resolveImage')
  assert.ok(!result.cases[4].svg.includes('隐藏'), '不可见图层不渲染')
  assert.ok(result.cases[4].svg.includes('可见'), '锁定图层照常渲染')
  assert.ok(!result.cases[4].svg.includes('<defs>'), '没有图片/阴影时不输出空 defs')
})

test('SVG 结构：只渲染 visibleIds 指定的图层', () => {
  const svg = result.cases[2].svg
  assert.ok(svg.includes('data-layer="irtysh"') && svg.includes('data-layer="zaysan"'))
  assert.ok(!svg.includes('data-layer="dzungar"') && !svg.includes('data-layer="card-1"'))
})

test('SVG 结构：文字转义与打包字体字族', () => {
  const svg = result.cases[3].svg
  assert.ok(svg.includes('A &amp; B &lt;tag&gt; &quot;quote&quot;'), '文字必须转义')
  assert.ok(svg.includes("font-family=\"'Noto Serif SC', serif\""), 'ink 主题用衬线打包字体')
})

test('底图风格化分解为 tint/paper/vignette 三层纯 alpha 覆盖层（不用混合模式）', () => {
  const filters = result.cases[3].filters
  assert.deepEqual(filters.map(f => [f.id, f.opacity]), [['tint', 0.4], ['paper', 0.3], ['vignette', 0.25]])
  assert.ok(filters.every(f => !('blend' in f)), '混合模式在 libvips 与浏览器里不一致，这里不能出现')
  assert.ok(filters[0].svg.includes('fill="#d9c49b" fill-opacity="0.4"'))
  assert.ok(filters[1].svg.includes('feTurbulence') && filters[1].svg.includes('<g opacity="0.3">'))
  assert.ok(filters[2].svg.includes('radialGradient') && filters[2].svg.includes('stop-opacity="0.25"'))
  assert.deepEqual(result.cases[0].filters, [], '没有 filter 就没有风格化层')
})

test('文字排版策略：全角逐字断、拉丁整词断、超长词硬切、行首禁则', () => {
  const expected = [
    ['准噶尔汗国与', '清朝的边界'],
    ['利哈列夫，', '远征'],
    ['Semipalatinsk 1718', 'fort'],
    ['AAAAAAAAA', 'AAAAAAAAA', 'AA'],
    ['第一行', '第二行'],
    [''],
  ]
  WRAPS.forEach(([text, limit], index) => {
    assert.deepEqual(result.wraps[index], expected[index], `backend: ${JSON.stringify(text)}`)
    assert.deepEqual(front.wrapTextEm(text, limit), expected[index], `frontend: ${JSON.stringify(text)}`)
  })
})

test('字符宽度模型：全角 1.0 / 空格 0.33 / 其它 0.55', () => {
  const expected = [3, 3.3, 3.53, 0]
  WIDTHS.forEach((text, index) => {
    assert.equal(Math.round(result.widths[index] * 100) / 100, expected[index])
    assert.equal(Math.round(front.measureTextEm(text) * 100) / 100, expected[index])
  })
})

test('打包字体未覆盖的字符会被标出（渲染前阻断的依据）', () => {
  const expected = [[], ['𠀋'], ['\uE000']]
  UNSUPPORTED.forEach((text, index) => {
    assert.deepEqual(result.unsupported[index], expected[index])
    assert.deepEqual(front.unsupportedChars(text), expected[index])
  })
})
